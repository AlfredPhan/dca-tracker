// Tổng kết lệnh lớn theo nến ngày Binance: từ 7:00 sáng hôm qua đến 7:00 sáng hôm nay (giờ VN), gửi lúc 7:00.
// Mỗi phút bot cộng dồn lệnh lớn đã quét vào bộ nhớ của Durable Object (key "day:YYYY-MM-DD" = ngày của nến).

const VN = 7 * 3600e3;
const DAY = 86400e3;

// Ngày của nến ngày Binance (nến mở lúc 7:00 VN = 00:00 UTC), dạng YYYY-MM-DD.
export const vnDate = (ms) => new Date(ms).toISOString().slice(0, 10);

const usd = (n) => n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `$${(n / 1000).toFixed(1)}K` : `$${Math.round(n)}`;
const hhmm = (ms) => new Date(ms + VN).toISOString().slice(11, 16);

// tally = { BTC: { b, s, nb, ns }, ... } của 1 phút (đã gộp các sàn).
export async function recordDay(storage, start, tally) {
  const key = 'day:' + vnDate(start);
  const d = (await storage.get(key)) || { first: start, runs: 0, coins: {} };
  d.runs++;
  for (const [coin, t] of Object.entries(tally)) {
    const c = (d.coins[coin] ||= { b: 0, s: 0, nb: 0, ns: 0 });
    c.b += t.b; c.s += t.s; c.nb += t.nb; c.ns += t.ns;
  }
  await storage.put(key, d);
}

// end = thời điểm chạy lúc 7:00 VN (00:00 UTC), cũng là lúc nến ngày đóng. Tổng kết nến vừa đóng.
// priceChange(coin, start, end) trả về % thay đổi giá trong nến hoặc null.
export async function dailySummary(storage, coins, end, priceChange) {
  const dayEnd = end;                 // 7:00 hôm nay giờ VN
  const dayStart = dayEnd - DAY;      // 7:00 hôm qua giờ VN
  const key = 'day:' + vnDate(dayStart);
  const d = await storage.get(key);

  // Dọn dữ liệu cũ hơn 7 ngày.
  const old = await storage.list({ prefix: 'day:' });
  for (const k of old.keys()) if (k < 'day:' + vnDate(dayStart - 7 * DAY)) await storage.delete(k);

  const changes = await Promise.all(coins.map((c) => priceChange(c.coin, dayStart, dayEnd).catch(() => null)));
  return buildSummary(d, coins, dayStart, changes);
}

export function buildSummary(d, coins, dayStart, changes) {
  const [, m, day] = vnDate(dayStart).split('-');
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

  // Ngưỡng lệnh lớn, gộp các coin cùng ngưỡng: "BTC, ETH từ $500.0K · ARB, APT… từ $10.0K".
  const groups = {};
  for (const c of coins) (groups[c.min] ||= []).push(c.coin);
  const rule = Object.entries(groups).sort((a, b) => b[0] - a[0])
    .map(([min, list]) => `${list.length > 2 ? 'coin khác' : list.join(', ')} từ $${+min >= 1e6 ? +min / 1e6 + 'M' : +min / 1000 + 'K'}`).join(', ');

  let warn = '';
  const missing = 1440 - (d?.runs || 0);
  if (!d) warn = '\n⚠️ Bot không ghi được dữ liệu ngày này.';
  else if (d.first > dayStart + 10 * 60e3) warn = `\n⚠️ Bot mới bắt đầu ghi từ ${hhmm(d.first)}, chưa đủ cả ngày.`;
  else if (missing > 30) warn = `\n⚠️ Thiếu khoảng ${missing} phút dữ liệu.`;

  const [, m2, day2] = vnDate(dayStart + DAY).split('-');
  return `📊 <b>Tổng kết lệnh lớn ngày ${day}/${m}</b>\n<i>Nến ngày: 7h ${day}/${m} → 7h ${day2}/${m2} giờ VN</i>\n\n${lines.join('\n')}\n\n` +
    `${totals ? `Tổng: ${totals}` : ''}${warn}\n` +
    `<i>Gom/xả = tổng lệnh lớn mua/bán chủ động trong nến ngày. Lệnh lớn: ${rule}.</i>`;
}
