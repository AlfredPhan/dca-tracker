// Tổng kết lệnh lớn theo nến Binance (ngày, tuần, tháng, năm), gửi lúc 7:00 sáng giờ VN khi nến đóng.
// Nến Binance mở/đóng lúc 00:00 UTC = 7:00 VN: nến ngày mỗi ngày, nến tuần sáng thứ Hai,
// nến tháng sáng ngày 1, nến năm sáng 1/1.
// Mỗi phút bot cộng dồn lệnh lớn đã quét vào bộ nhớ của Durable Object (key "day:YYYY-MM-DD" = ngày của nến).
// Tuần/tháng/năm được cộng từ các bản ghi ngày, nên bản ghi ngày được giữ hơn 1 năm.

const VN = 7 * 3600e3;
const DAY = 86400e3;
const KEEP_DAYS = 400;

// Ngày của nến ngày Binance (nến mở lúc 7:00 VN = 00:00 UTC), dạng YYYY-MM-DD.
export const candleDate = (ms) => new Date(ms).toISOString().slice(0, 10);

const usd = (n) => n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `$${(n / 1000).toFixed(1)}K` : `$${Math.round(n)}`;
const dm = (ms) => { const [, m, d] = candleDate(ms).split('-'); return `${d}/${m}`; };
const dmy = (ms) => `${dm(ms)}/${new Date(ms).getUTCFullYear()}`;
const vnHm = (ms) => new Date(ms + VN).toISOString().slice(11, 16);

// tally = { BTC: { b, s, nb, ns }, ... } của 1 phút (đã gộp các sàn).
export async function recordDay(storage, start, tally) {
  const key = 'day:' + candleDate(start);
  const d = (await storage.get(key)) || { first: start, runs: 0, coins: {} };
  d.runs++;
  for (const [coin, t] of Object.entries(tally)) {
    const c = (d.coins[coin] ||= { b: 0, s: 0, nb: 0, ns: 0 });
    // Cộng mọi trường số: b/s/nb/ns = lệnh lớn (bot báo), ab/as/anb/ans/acut = mọi lệnh từ 100 USD (cho web).
    for (const [k, v] of Object.entries(t)) c[k] = (c[k] || 0) + v;
  }
  await storage.put(key, d);
}

// Các nến vừa đóng tại thời điểm end (phải đúng 00:00 UTC). Thứ tự gửi: ngày → tuần → tháng → năm.
export function periodsEndingAt(end) {
  const t = new Date(end);
  if (t.getUTCHours() || t.getUTCMinutes()) return [];
  const y = t.getUTCFullYear(), m = t.getUTCMonth();
  const list = [];
  const from = end - DAY;
  list.push({ kind: 'ngày', icon: '📊', from, to: end, interval: '1d', limit: 1,
    title: `ngày ${dm(from)}`, range: `7h ${dm(from)} → 7h ${dm(end)}` });
  if (t.getUTCDay() === 1) {
    const f = end - 7 * DAY;
    list.push({ kind: 'tuần', icon: '🗓', from: f, to: end, interval: '1w', limit: 1,
      title: `tuần ${dm(f)} – ${dm(end - DAY)}`, range: `7h thứ Hai ${dm(f)} → 7h thứ Hai ${dm(end)}` });
  }
  if (t.getUTCDate() === 1) {
    const f = Date.UTC(m ? y : y - 1, m ? m - 1 : 11, 1);
    const fm = new Date(f);
    list.push({ kind: 'tháng', icon: '📅', from: f, to: end, interval: '1M', limit: 1,
      title: `tháng ${String(fm.getUTCMonth() + 1).padStart(2, '0')}/${fm.getUTCFullYear()}`, range: `7h ${dm(f)} → 7h ${dm(end)}` });
    if (m === 0) {
      const fy = Date.UTC(y - 1, 0, 1);
      list.push({ kind: 'năm', icon: '🏆', from: fy, to: end, interval: '1M', limit: 12,
        title: `năm ${y - 1}`, range: `7h ${dmy(fy)} → 7h ${dmy(end)}` });
    }
  }
  return list;
}

// Cộng các bản ghi ngày trong [from, to).
async function aggregate(storage, from, to) {
  const days = await storage.list({ prefix: 'day:', start: 'day:' + candleDate(from), end: 'day:' + candleDate(to) });
  if (!days.size) return null;
  const agg = { first: Infinity, runs: 0, coins: {} };
  for (const d of days.values()) {
    agg.first = Math.min(agg.first, d.first);
    agg.runs += d.runs;
    for (const [coin, t] of Object.entries(d.coins)) {
      const c = (agg.coins[coin] ||= { b: 0, s: 0, nb: 0, ns: 0 });
      c.b += t.b; c.s += t.s; c.nb += t.nb; c.ns += t.ns;
    }
  }
  return agg;
}

// Xóa bản ghi ngày cũ hơn KEEP_DAYS (đủ cho tổng kết năm).
export async function cleanup(storage, end) {
  const days = await storage.list({ prefix: 'day:', end: 'day:' + candleDate(end - KEEP_DAYS * DAY) });
  if (days.size) await storage.delete([...days.keys()].slice(0, 128));
}

// priceChange(coin, period) trả về % thay đổi giá trong nến hoặc null.
export async function periodSummary(storage, coins, p, priceChange) {
  const d = await aggregate(storage, p.from, p.to);
  const changes = await Promise.all(coins.map((c) => priceChange(c.coin, p).catch(() => null)));
  return buildSummary(d, coins, p, changes);
}

export function buildSummary(d, coins, p, changes) {
  const rows = coins.map(({ coin }, i) => {
    const t = d?.coins?.[coin] || { b: 0, s: 0, nb: 0, ns: 0 };
    const total = t.b + t.s;
    const share = total ? t.b / total : 0.5;
    const kind = !total ? 3 : share >= 0.6 ? 0 : share <= 0.4 ? 2 : 1;
    return { coin, t, kind, net: t.b - t.s, chg: changes[i] };
  });
  // Thứ tự: GOM (ròng mua lớn nhất trước) → giằng co → XẢ → không có lệnh.
  rows.sort((a, b) => a.kind - b.kind || b.net - a.net);

  const LABEL = ['🟢 GOM', '⚪ giằng co', '🔴 XẢ', '➖ không có lệnh lớn'];
  const lines = rows.map(({ coin, t, kind, chg }) => {
    const [icon, ...word] = LABEL[kind].split(' ');
    const price = chg == null ? '' : ` · giá ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%`;
    if (kind === 3) return `${icon} <b>${coin}</b> ${word.join(' ')}${price}`;
    return `${icon} <b>${coin}</b> ${word.join(' ')} · mua ${usd(t.b)} / bán ${usd(t.s)}${price}`;
  });

  const count = (k) => rows.filter((r) => r.kind === k).length;
  const totals = [[0, 'gom'], [2, 'xả'], [1, 'giằng co']].filter(([k]) => count(k)).map(([k, w]) => `${count(k)} coin ${w}`).join(' · ');

  // Ngưỡng lệnh lớn, gộp các coin cùng ngưỡng: "BTC, ETH từ $500K, coin khác từ $10K".
  const groups = {};
  for (const c of coins) (groups[c.min] ||= []).push(c.coin);
  const rule = Object.entries(groups).sort((a, b) => b[0] - a[0])
    .map(([min, list]) => `${list.length > 2 ? 'coin khác' : list.join(', ')} từ $${+min >= 1e6 ? +min / 1e6 + 'M' : +min / 1000 + 'K'}`).join(', ');

  // Cảnh báo khi dữ liệu không phủ hết nến (bot mới bật, hoặc bị lỡ nhiều phút).
  const nDays = Math.round((p.to - p.from) / DAY);
  const missing = nDays * 1440 - (d?.runs || 0);
  let warn = '';
  if (!d) warn = `\n⚠️ Bot không có dữ liệu cho ${p.kind} này.`;
  else if (d.first > p.from + 10 * 60e3) warn = `\n⚠️ Bot mới bắt đầu ghi từ ${vnHm(d.first)} ${dm(d.first + VN)}, chưa đủ cả ${p.kind}.`;
  else if (missing > 30 * nDays) warn = `\n⚠️ Thiếu khoảng ${missing >= 120 ? Math.round(missing / 60) + ' giờ' : missing + ' phút'} dữ liệu.`;

  return `${p.icon} <b>Tổng kết lệnh lớn ${p.title}</b>\n<i>Nến ${p.kind}: ${p.range} giờ VN</i>\n\n${lines.join('\n')}\n\n` +
    `${totals ? `Tổng: ${totals}` : ''}${warn}\n` +
    `<i>Gom/xả = tổng lệnh lớn mua/bán chủ động trong nến ${p.kind}. Lệnh lớn: ${rule}.</i>`;
}
