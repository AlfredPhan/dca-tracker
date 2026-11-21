// Báo khi giá chạm mức Pivot (Classic, giống hệt tab Pivot trên web) các khung ngày, tuần, tháng, năm.
// Mức được tính từ nến ngày Binance: nến tuần/tháng/năm = gộp các nến ngày trong kỳ (cùng H/L/C với nến Binance).
// Vàng (XAU): hợp đồng XAUUSDT (Bybit), bỏ nến thứ Bảy/Chủ nhật cho khớp giờ Exness; khung năm dùng PAXG nếu XAUUSDT chưa đủ lịch sử.

const DAY = 864e5;
// Binance Futures chặn máy chủ của bot (đặt ở Nhật), nên giá vàng của bot lấy từ hợp đồng XAUUSDT của Bybit.
// Đã đối chiếu: mức Pivot vàng tính từ Bybit lệch mức trên web (Binance XAUUSDT) dưới 1 USD.
const BYBIT = 'https://api.bybit.com/v5/market';
// Bybit trả nến mới nhất trước, dạng chuỗi: đổi về dạng nến Binance [openTime, O, H, L, C], cũ trước mới sau.
const bybitK = (d) => {
  if (d.retCode !== 0) throw new Error('Bybit ' + d.retMsg);
  return d.result.list.map((k) => [+k[0], k[1], k[2], k[3], k[4]]).reverse();
};
export const FRAME_NAME = { d: 'Ngày', w: 'Tuần', m: 'Tháng', y: 'Năm' };
const COOLDOWN = 6 * 3600e3; // cùng một mức không báo lại trong 6 giờ

export function pivotLevels(H, L, C) {
  const P = (H + L + C) / 3;
  return { R3: H + 2 * (P - L), R2: P + (H - L), R1: 2 * P - L, P, S1: 2 * P - H, S2: P - (H - L), S3: L - 2 * (H - P) };
}

// Mốc bắt đầu kỳ hiện tại (giờ UTC như nến Binance) và mốc bắt đầu kỳ trước.
export function prevPeriod(key, now) {
  const d = new Date(now);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  const today = Date.UTC(y, m, d.getUTCDate());
  if (key === 'd') return [today - DAY, today];
  if (key === 'w') { const s = today - ((d.getUTCDay() + 6) % 7) * DAY; return [s - 7 * DAY, s]; }
  if (key === 'm') return [Date.UTC(y, m - 1, 1), Date.UTC(y, m, 1)];
  return [Date.UTC(y - 1, 0, 1), Date.UTC(y, 0, 1)];
}

const isWeekday = (k) => { const w = new Date(k[0]).getUTCDay(); return w >= 1 && w <= 5; };

function aggregate(days, from, to) {
  const ks = days.filter((k) => k[0] >= from && k[0] < to);
  if (!ks.length) return null;
  return { H: Math.max(...ks.map((k) => +k[2])), L: Math.min(...ks.map((k) => +k[3])), C: +ks[ks.length - 1][4] };
}

// days: nến ngày [openTime, O, H, L, C, ...]. gold = true thì bỏ cuối tuần (khung ngày lấy phiên giao dịch gần nhất).
export function computeLevels(days, now, { gold = false, yearDays = null } = {}) {
  const ds = gold ? days.filter(isWeekday) : days;
  const out = {};
  for (const key of ['d', 'w', 'm', 'y']) {
    const [from, to] = prevPeriod(key, now);
    let base;
    if (key === 'd' && gold) {
      const done = ds.filter((k) => k[0] < to);
      const k = done[done.length - 1];
      base = k && { H: +k[2], L: +k[3], C: +k[4] };
    } else if (key === 'y' && yearDays) {
      base = aggregate(gold ? yearDays.filter(isWeekday) : yearDays, from, to);
    } else {
      // Kỳ phải được phủ đủ (coin mới niêm yết giữa kỳ thì bỏ khung đó).
      base = ds.length && ds[0][0] <= from + (gold ? 3 : 0) * DAY ? aggregate(ds, from, to) : null;
    }
    if (base) out[key] = pivotLevels(base.H, base.L, base.C);
  }
  return out;
}

// Mức nào bị chạm trong phút vừa qua: giá đi qua mức từ giá cũ (prev) tới vùng cao/thấp của phút này.
export function touches(levels, prev, low, high, frames, names) {
  const lo = Math.min(prev, low), hi = Math.max(prev, high);
  const hits = [];
  for (const f of frames) {
    for (const n of names) {
      const v = levels[f]?.[n];
      if (!(v > 0) || v < lo || v > hi || v === prev) continue;
      hits.push({ frame: f, name: n, value: v, dir: prev > v ? 'down' : 'up' });
    }
  }
  return hits;
}

const fmt = (v) => v.toLocaleString('en-US', { maximumFractionDigits: v >= 100 ? 2 : v >= 1 ? 4 : 6 });

// Lấy nến ngày (đủ cho khung năm) và tính mức cho một coin.
async function fetchLevels(getJson, host, coin, now) {
  const start = Date.UTC(new Date(now).getUTCFullYear() - 1, 0, 1);
  if (coin === 'XAU') {
    const xau = bybitK(await getJson(`${BYBIT}/kline?category=linear&symbol=XAUUSDT&interval=D&start=${start - 7 * DAY}&limit=1000`));
    const covered = xau.length && xau[0][0] <= start + 7 * DAY;
    const paxg = covered ? null : await getJson(`${host}/api/v3/klines?symbol=PAXGUSDT&interval=1d&startTime=${start - 7 * DAY}&limit=1000`);
    return computeLevels(xau, now, { gold: true, yearDays: paxg });
  }
  const days = await getJson(`${host}/api/v3/klines?symbol=${coin}USDT&interval=1d&startTime=${start}&limit=1000`);
  return computeLevels(days, now);
}

// Gọi mỗi phút. Trả về nội dung tin nhắn (hoặc '' nếu không có mức nào bị chạm).
export async function pivotCheck({ storage, getJson, host, coins, end, frames, names, site, refreshLimit = 4 }) {
  if (!host) return '';
  const today = new Date(end).toISOString().slice(0, 10);
  const lv = (await storage.get('pivot:levels')) || {};
  const st = (await storage.get('pivot:state2')) || { last: {}, sent: {} };

  // 1) Cập nhật mức khi sang ngày mới (tối đa refreshLimit coin mỗi phút để không vượt giới hạn request).
  const stale = coins.filter((c) => lv[c]?.day !== today);
  for (const c of stale.slice(0, refreshLimit)) {
    try { lv[c] = { day: today, levels: await fetchLevels(getJson, host, c, end) }; } catch (e) { console.log('pivot levels', c, e.message); }
  }
  if (stale.length) await storage.put('pivot:levels', lv);

  // 2) Giá cao/thấp/hiện tại trong ~1 phút gần nhất.
  const ranges = {};
  const spot = coins.filter((c) => c !== 'XAU');
  if (spot.length) try {
    const list = await getJson(`${host}/api/v3/ticker?windowSize=1m&type=MINI&symbols=${encodeURIComponent(JSON.stringify(spot.map((c) => c + 'USDT')))}`);
    // Phút không có lệnh khớp nào thì Binance trả giá = 0: bỏ qua coin đó (coi như giá đứng yên).
    for (const t of list) {
      if (+t.lowPrice > 0 && +t.highPrice > 0 && +t.lastPrice > 0) ranges[t.symbol.slice(0, -4)] = { low: +t.lowPrice, high: +t.highPrice, last: +t.lastPrice };
    }
  } catch (e) { console.log('pivot ticker', e.message); }
  const wd = new Date(end).getUTCDay();
  if (coins.includes('XAU') && wd >= 1 && wd <= 5) { // vàng nghỉ cuối tuần
    try {
      const k = bybitK(await getJson(`${BYBIT}/kline?category=linear&symbol=XAUUSDT&interval=1&limit=2`));
      ranges.XAU = { low: Math.min(+k[0][3], +k[1][3]), high: Math.max(+k[0][2], +k[1][2]), last: +k[1][4] };
    } catch (e) { console.log('pivot xau', e.message); }
  }

  // 3) So với giá phút trước để tìm mức bị chạm.
  const lines = [];
  for (const c of coins) {
    const r = ranges[c], prev = st.last[c] > 0 ? st.last[c] : null;
    if (!r || !(r.low > 0 && r.last > 0)) continue;
    // Chặn dữ liệu bất thường: giá trong 1 phút lệch quá 15% so với phút trước thì bỏ qua lần này.
    if (prev && (r.low < prev * 0.85 || r.high > prev * 1.15)) { console.log('pivot bỏ qua dữ liệu lạ', c, prev, r.low, r.high); st.last[c] = r.last; continue; }
    st.last[c] = r.last;
    if (prev == null || lv[c]?.day !== today) continue;
    for (const h of touches(lv[c].levels, prev, r.low, r.high, frames, names)) {
      const key = `${c}:${h.frame}:${h.name}`;
      if (end - (st.sent[key] || 0) < COOLDOWN) continue;
      st.sent[key] = end;
      const name = c === 'XAU' ? '🥇 Vàng' : c;
      lines.push({
        order: 'ymwd'.indexOf(h.frame),
        text: `${h.dir === 'down' ? '🔻' : '🔺'} <b>${name}</b> ${h.dir === 'down' ? 'giảm' : 'tăng'} chạm <b>${h.name} ${FRAME_NAME[h.frame]}</b> ${fmt(h.value)} · giá ${fmt(r.last)}`,
      });
    }
  }
  for (const [k, t] of Object.entries(st.sent)) if (end - t > 2 * DAY) delete st.sent[k];
  await storage.put('pivot:state2', st);

  if (!lines.length) return '';
  lines.sort((a, b) => a.order - b.order);
  const hasGold = lines.some((l) => l.text.includes('Vàng'));
  return `📐 <b>Chạm mức Pivot</b>\n${lines.map((l) => l.text).join('\n')}` +
    (hasGold ? '\n<i>Vàng theo giá XAUUSDT (Bybit), có thể lệch vài USD so với Exness.</i>' : '') +
    `\n<a href="${site}">xem Pivot</a>`;
}
