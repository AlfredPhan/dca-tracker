// Kế hoạch cho từng coin trong danh mục: coin GIỮ (vùng mua DCA + mức cắt lỗ) và coin BÁN (vùng hồi để bán chuyển sang BTC).
// Cấu hình trong wrangler.toml: PLAN = "COIN:keep|sell:mức1,mức2,...:mức_cắt;..." (giá Binance, USDT).
//   sell: báo khi giá HỒI LÊN chạm từng vùng bán (vùng 1 bán một phần, vùng cuối bán nốt).
//         Cắt lỗ: nến NGÀY đóng dưới mức cắt (thủng đáy) -> không chờ hồi nữa.
//   keep: báo khi giá GIẢM chạm từng vùng DCA. Cắt lỗ: nến TUẦN đóng dưới mức cắt (tránh bị râu nến quét).
// Đã báo một mức thì chỉ báo lại khi giá đi xa mức đó 8% rồi quay lại. Đổi PLAN là bot báo lại kế hoạch mới.
// Khi bot Elliott chuyển BTC từ sóng 4 sang sóng 5 (hết nhịp hồi), nhắc bán các coin chưa tới vùng bán cuối.

const KEY = 'plan:v1';
const REARM = 0.08;
const HEAD = '🧭 <b>Kế hoạch danh mục</b>';

const px = (p) => (p >= 1 ? p.toFixed(3) : p >= 0.1 ? p.toFixed(4) : p >= 0.01 ? p.toFixed(5) : p.toFixed(6)).replace(/0+$/, '').replace(/\.$/, '');
const pct = (a, b) => `${a >= b ? '+' : ''}${((a / b - 1) * 100).toFixed(0)}%`;

export function parsePlan(s) {
  const out = [];
  for (const part of String(s || '').split(';').map((x) => x.trim()).filter(Boolean)) {
    const [coin, mode, lv, stop] = part.split(':');
    const levels = (lv || '').split(',').map(Number).filter((x) => x > 0);
    if (!coin || !['keep', 'sell'].includes(mode) || !levels.length || !(+stop > 0)) continue;
    levels.sort((a, b) => (mode === 'sell' ? a - b : b - a)); // sell: thấp -> cao; keep: cao -> thấp
    out.push({ coin: coin.toUpperCase(), mode, levels, stop: +stop });
  }
  return out;
}

function sellShare(i, n, coin) { return i === n - 1 ? `bán nốt số ${coin} còn lại` : n === 2 ? `bán khoảng một nửa số ${coin}` : `bán khoảng 1/${n} số ${coin}`; }

function planText(plan, prices) {
  const sell = plan.filter((c) => c.mode === 'sell'), keep = plan.filter((c) => c.mode === 'keep');
  const now = (c) => prices[c.coin] ? ` (giá ${px(prices[c.coin])})` : '';
  const far = (c, p) => prices[c.coin] ? ` ${pct(p, prices[c.coin])}` : '';
  let t = '';
  if (sell.length) t += `<b>Bán khi hồi, chuyển sang BTC:</b>\n` + sell.map((c) =>
    `💸 <b>${c.coin}</b>${now(c)}: ${c.levels.map((p, i) => `vùng ${i + 1} ${px(p)}${far(c, p)}`).join(' · ')} · không chờ nữa nếu nến ngày đóng dưới ${px(c.stop)}`).join('\n') + '\n';
  if (keep.length) t += `<b>Giữ, mua DCA từng phần nhỏ:</b>\n` + keep.map((c) =>
    `🛒 <b>${c.coin}</b>${now(c)}: ${c.levels.map((p, i) => `DCA ${i + 1} ${px(p)}${far(c, p)}`).join(' · ')} · cắt nếu nến tuần đóng dưới ${px(c.stop)}`).join('\n');
  return t.trim();
}

// Mỗi phút: ranges = { COIN: { low, high, last } }. Trả về các dòng cần báo.
export function planStep(st, plan, ranges, btc) {
  const lines = [];
  const btcTxt = btc ? ` (BTC ${Math.round(btc).toLocaleString('en-US')})` : '';
  for (const c of plan) {
    const r = ranges[c.coin];
    if (!r) continue;
    c.levels.forEach((p, i) => {
      const key = `${c.coin}:${c.mode}:${p}`;
      if (st.sent[key]) {
        // Đi xa mức đã báo 8% thì cho phép báo lại lần sau.
        if (c.mode === 'sell' ? r.high < p * (1 - REARM) : r.low > p * (1 + REARM)) delete st.sent[key];
        return;
      }
      if (c.mode === 'sell' && r.high >= p) {
        st.sent[key] = 1;
        lines.push(`💸 <b>${c.coin}</b> hồi lên <b>${px(p)}</b> (vùng bán ${i + 1}/${c.levels.length}): cân nhắc <b>${sellShare(i, c.levels.length, c.coin)}</b> để chuyển sang BTC${btcTxt}.`);
      }
      if (c.mode === 'keep' && r.low <= p) {
        st.sent[key] = 1;
        lines.push(`🛒 <b>${c.coin}</b> giảm về <b>${px(p)}</b> (vùng DCA ${i + 1}/${c.levels.length}): có thể mua thêm một phần <b>nhỏ</b>. Ưu tiên tiền mới cho BTC.`);
      }
    });
  }
  return lines;
}

// 7:01 sáng: kiểm tra đóng nến ngày (coin bán) và đóng nến tuần vào thứ Hai (coin giữ).
async function closeChecks(st, plan, getJson, host, end) {
  const lines = [];
  const monday = new Date(end).getUTCDay() === 1;
  await Promise.all(plan.map(async (c) => {
    if (c.mode === 'keep' && !monday) return;
    const k = await getJson(`${host}/api/v3/klines?symbol=${c.coin}USDT&interval=${c.mode === 'sell' ? '1d' : '1w'}&endTime=${end - 61e3}&limit=1`);
    const close = +k[0][4], key = `${c.coin}:stop`;
    if (close >= c.stop * (1 + REARM)) delete st.sent[key];
    if (close >= c.stop || st.sent[key]) return;
    st.sent[key] = 1;
    lines.push(c.mode === 'sell'
      ? `⚠️ <b>${c.coin}</b> đóng nến ngày ${px(close)}, <b>dưới ${px(c.stop)}</b> (thủng đáy): không nên chờ hồi nữa, cân nhắc bán phần còn lại chuyển sang BTC.`
      : `🛑 <b>${c.coin}</b> đóng nến tuần ${px(close)}, <b>dưới ${px(c.stop)}</b>: lý do giữ coin này không còn đúng, cân nhắc cắt lỗ chuyển sang BTC.`);
  }));
  return lines;
}

export async function planCheck({ storage, getJson, host, end, planStr }) {
  const plan = parsePlan(planStr);
  if (!plan.length || !host) return [];
  const out = [];
  let st = await storage.get(KEY);

  // Giá 1 phút của tất cả coin trong kế hoạch + BTC, 1 request.
  const syms = [...new Set([...plan.map((c) => c.coin), 'BTC'])].map((c) => c + 'USDT');
  const list = await getJson(`${host}/api/v3/ticker?windowSize=1m&type=MINI&symbols=${encodeURIComponent(JSON.stringify(syms))}`);
  const ranges = {}, prices = {};
  for (const t of list) {
    const coin = t.symbol.replace(/USDT$/, '');
    if (+t.lowPrice > 0 && +t.highPrice > 0 && +t.lastPrice > 0) {
      ranges[coin] = { low: +t.lowPrice, high: +t.highPrice, last: +t.lastPrice };
      prices[coin] = +t.lastPrice;
    }
  }
  // Bỏ qua giá giật bất thường quá 15% so với phút trước.
  for (const [coin, r] of Object.entries(ranges)) {
    const prev = st?.last?.[coin];
    if (prev && (r.low < prev * 0.85 || r.high > prev * 1.15)) delete ranges[coin];
  }

  if (!st || st.sig !== planStr) {
    st = { sig: planStr, sent: {}, last: {} };
    // Phút vắng lệnh thì ticker 1 phút trả giá 0: lấy giá gần nhất cho các coin còn thiếu.
    const miss = syms.filter((x) => !prices[x.replace(/USDT$/, '')]);
    if (miss.length) {
      for (const t of await getJson(`${host}/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(miss))}`)) {
        if (+t.price > 0) prices[t.symbol.replace(/USDT$/, '')] = +t.price;
      }
    }
    // Mức đã vượt qua sẵn lúc bắt đầu thì không báo (chỉ báo khi giá đi tới mức mới).
    for (const c of plan) for (const p of c.levels) {
      const now = prices[c.coin];
      if (now && (c.mode === 'sell' ? now >= p : now <= p)) st.sent[`${c.coin}:${c.mode}:${p}`] = 1;
    }
    out.push(`${HEAD} · bắt đầu theo dõi\n${planText(plan, prices)}\n\n` +
      `<i>Bot báo khi giá chạm từng vùng, và lúc 7:01 sáng nếu nến đóng dưới mức cắt. Bán xong coin nào thì nhắn để bỏ coin đó khỏi danh sách.</i>`);
  } else {
    const lines = planStep(st, plan, ranges, prices.BTC);
    if (lines.length) out.push(`${HEAD}\n${lines.join('\n')}`);
  }
  for (const [coin, r] of Object.entries(ranges)) st.last[coin] = r.last;

  // BTC hết nhịp hồi (bot Elliott chuyển sóng 4 -> sóng 5): nhắc các coin bán chưa tới vùng cuối.
  const el = await storage.get('elliott:btc');
  if (el?.phase) {
    if (st.elPhase === 'w4' && el.phase === 'w5') {
      const left = plan.filter((c) => c.mode === 'sell' && !st.sent[`${c.coin}:sell:${c.levels[c.levels.length - 1]}`]);
      if (left.length) out.push(`${HEAD}\n🔻 BTC có thể đã hết nhịp hồi (sóng 4 xong). Altcoin thường giảm theo, mạnh hơn BTC.\n` +
        `Nếu chưa bán: ${left.map((c) => `<b>${c.coin}</b> ${px(prices[c.coin] || 0)}`).join(' · ')}, cân nhắc bán ở giá hiện tại thay vì chờ vùng bán.`);
    }
    st.elPhase = el.phase;
  }

  if (end % 86400e3 === 60e3) {
    try {
      const lines = await closeChecks(st, plan, getJson, host, end);
      if (lines.length) out.push(`${HEAD} · đóng nến\n${lines.join('\n')}`);
    } catch (e) { console.log('plan close', e.message); }
  }
  await storage.put(KEY, st);
  return out;
}
