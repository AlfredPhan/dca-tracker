// Theo dõi kịch bản sóng Elliott của BTC (sóng C của đợt điều chỉnh từ đỉnh 126K) và báo Telegram.
// Điểm sóng đặt trong wrangler.toml: ELLIOTT_BTC = "W0,W1,W2,W3[,ALT]" (giá Binance BTCUSDT):
//   W0 = đầu sóng C (đỉnh), W1 = đáy sóng 1, W2 = đỉnh sóng 2, W3 = đáy sóng 3.
// Đổi điểm sóng thì bot tự bắt đầu theo dõi lại từ đầu. Mọi mức Fib tính theo thang log (giống TradingView bật "log scale").
//
// Các giai đoạn:
//   w4   = đang hồi sóng 4: báo khi chạm Fib thoái lui 0.236/0.382/0.5/0.618 của sóng 3 (từ W2 xuống W3).
//          Giá rơi 5% từ đỉnh hồi -> coi như sóng 4 xong, tính mục tiêu sóng 5 theo đỉnh thật.
//          Tạo đáy mới trước khi kịp hồi -> sóng 3 kéo dài, tính lại các mức.
//   w5   = đang giảm sóng 5: báo khi chạm các mục tiêu (2 cách đo), thủng đáy sóng 3, chạm mức vô hiệu.
//   end  = có thể sóng 5 đã xong (bật 8% từ đáy gần đáy sóng 3). Vượt đỉnh sóng 4 -> xác nhận.
//   up / down / done = cách đếm kết thúc (sai hướng lên, sai hướng xuống, hoặc đã xác nhận đáy). Bot ngừng báo.
// 7:01 sáng mỗi ngày (sau khi nến ngày Binance đóng) gửi 1 tin tóm tắt kèm RSI ngày và kiểm tra phân kỳ.

const KEY = 'elliott:btc';
const DAY = 86400e3;
const RETR = [0.236, 0.382, 0.5, 0.618];
const EXT = [0.382, 0.5, 0.618, 0.786];
const W4_DROP = 0.05;   // rơi 5% từ đỉnh hồi -> sóng 4 có thể đã xong
const W5_BOUNCE = 0.08; // bật 8% từ đáy -> sóng 5 có thể đã xong
const HEAD = '🌊 <b>Elliott BTC</b>';

const fmt = (p) => '$' + Math.round(p).toLocaleString('en-US');
const pct = (a, b) => `${a >= b ? '+' : ''}${((a / b - 1) * 100).toFixed(1)}%`;

// Số thứ 5 (không bắt buộc) = đỉnh sóng 4 nhỏ của cách đếm phụ "sóng C đã đủ 5 sóng con, kết thúc ở W3".
// Giá vượt mức này là dấu hiệu sớm cho cách đếm phụ.
export function parseWaves(s) {
  const v = String(s || '').split(',').map(Number);
  if ((v.length !== 4 && v.length !== 5) || !v.every((x) => x > 0)) return null;
  const [w0, w1, w2, w3, alt] = v;
  if (!(w0 > w2 && w2 > w1 && w1 > w3)) return null;
  return { w0, w1, w2, w3, alt: alt > w3 && alt < w1 ? alt : null, sig: v.slice(0, 4).join(',') };
}

// Mốc đóng nến khung lớn (xấp xỉ các đường trung bình trên chart TradingView của bạn, sửa ở đây khi chúng dịch chuyển).
const WEEK_BULL = 72000;     // nến tuần đóng trên: lấy lại các đường trung bình tuần, tín hiệu đảo chiều tăng
const MONTH_LEVEL = 53400;   // đường trung bình khung tháng (đường trắng) từng đỡ đáy 2018 và 2022
const QUARTER_LEVEL = 61400; // đường trung bình khung quý (đường cam)

// top = đỉnh sóng 4 (chưa có thì giả sử hồi tới Fib 0.382 như hình bạn vẽ).
export function levels(cfg, w3, top) {
  const k = Math.log(cfg.w2 / w3);
  const retr = RETR.map((L) => ({ L, p: w3 * Math.exp(k * L) }));
  const t = top || retr[1].p;
  const rc = Math.log(w3 / cfg.w0);
  return {
    retr, top: t, assumed: !top,
    t1: t * cfg.w1 / cfg.w0,            // cách 1: sóng 5 = sóng 1 (log)
    ext: EXT.map((L) => ({ L, p: t * Math.exp(rc * L) })), // cách 2: Fib mở rộng (0)->(3) đặt từ đỉnh sóng 4
  };
}

function targetsText(lv) {
  const e = Object.fromEntries(lv.ext.map((x) => [x.L, x.p]));
  return `Mục tiêu sóng 5${lv.assumed ? ` (giả sử sóng 4 lên ${fmt(lv.top)})` : ` (từ đỉnh sóng 4 ${fmt(lv.top)})`}:\n` +
    `• Kịch bản 1 · sóng 5 = sóng 1: <b>${fmt(lv.t1)}</b>\n` +
    `• Kịch bản 2 · Fib 0.618: <b>${fmt(e[0.618])}</b> (các tầng 0.382 ${fmt(e[0.382])} · 0.5 ${fmt(e[0.5])})\n` +
    `• Sai cách đếm nếu xuống dưới ${fmt(e[0.786])} (Fib 0.786)`;
}

export function rsiSeries(closes, n = 14) {
  const out = Array(closes.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) {
      g += up; l += dn;
      if (i === n) { g /= n; l /= n; out[i] = l ? 100 - 100 / (1 + g / l) : 100; }
    } else {
      g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n;
      out[i] = l ? 100 - 100 / (1 + g / l) : 100;
    }
  }
  return out;
}

async function init(cfg, sig, getJson, host, end) {
  const st = { sig, phase: 'w4', w3: cfg.w3, hi: 0, sent: {}, start: end };
  // Tìm đáy sóng 3 thật trong 20 ngày gần nhất (nến giờ) và đỉnh hồi sau đó.
  const h = await getJson(`${host}/api/v3/klines?symbol=BTCUSDT&interval=1h&endTime=${end - 1}&limit=500`);
  let iMin = -1;
  h.forEach((c, i) => { if (+c[3] <= cfg.w3 * 1.001 && (iMin < 0 || +c[3] < +h[iMin][3])) iMin = i; });
  if (iMin >= 0) {
    st.w3 = Math.min(cfg.w3, +h[iMin][3]);
    st.hi = Math.max(st.w3, ...h.slice(iMin + 1).map((c) => +c[2]));
    st.w3Time = h[iMin][0];
    st.last = +h[h.length - 1][4];
  }
  st.hi ||= st.w3;
  // Mức đã chạm trước khi bot bắt đầu theo dõi: đánh dấu đã báo để không báo lại.
  for (const { L, p } of levels(cfg, st.w3).retr) if (st.hi >= p) st.sent['r' + L] = 1;
  // RSI ngày thấp nhất quanh đáy sóng 3 (để so phân kỳ ở đáy sóng 5).
  const d = await getJson(`${host}/api/v3/klines?symbol=BTCUSDT&interval=1d&endTime=${end - 1}&limit=200`);
  const rsi = rsiSeries(d.map((c) => +c[4]));
  const t3 = st.w3Time || end;
  const near = d.map((c, i) => [c, rsi[i]]).filter(([c, r]) => r != null && Math.abs(c[0] - t3) <= 3 * DAY);
  st.rsi3 = near.length ? Math.min(...near.map(([, r]) => r)) : Math.min(...rsi.slice(-10).filter((r) => r != null));
  return st;
}

function initMessage(cfg, st) {
  const lv = levels(cfg, st.w3);
  const r = lv.retr.map(({ L, p }) => `${L} ${fmt(p)}${st.sent['r' + L] ? ' ✓' : ''}`).join(' · ');
  return `${HEAD} · bắt đầu theo dõi\n` +
    `Sóng (0) ${fmt(cfg.w0)} → (1) ${fmt(cfg.w1)} → (2) ${fmt(cfg.w2)} → (3) ${fmt(st.w3)}\n` +
    `Đang ở <b>sóng 4 (hồi)</b>, đỉnh hồi cao nhất ${fmt(st.hi)}. RSI ngày ở đáy sóng 3: ${st.rsi3.toFixed(1)}\n\n` +
    `Vùng hồi sóng 4 (Fib thoái lui): ${r}\n${targetsText(lv)}\n` +
    `Sai cách đếm hướng lên nếu vượt ${fmt(cfg.w1)} (đáy sóng 1).\n` +
    (cfg.alt ? `Cách đếm phụ (sóng C đã xong ở ${fmt(st.w3)}): dấu hiệu sớm khi vượt ${fmt(cfg.alt)}.\n` : '') + '\n' +
    `<i>Bot báo khi: chạm từng mức Fib · sóng 4 có thể đã xong (rơi 5% từ đỉnh hồi) · chạm mục tiêu sóng 5 · thủng/giữ đáy sóng 3 · phân kỳ RSI · cách đếm sai. Tóm tắt lúc 7:01 mỗi sáng.</i>`;
}

// Xử lý giá của 1 phút. Trả về danh sách tin cần gửi (đã cập nhật st).
export function step(st, cfg, { low, high, last }) {
  const out = [];
  const once = (key, msg) => { if (!st.sent[key]) { st.sent[key] = 1; out.push(msg); } };
  const clear = (prefix) => { for (const k of Object.keys(st.sent)) if (prefix.some((p) => k.startsWith(p))) delete st.sent[k]; };

  if ((st.phase === 'w4' || st.phase === 'w5') && high >= cfg.w1) {
    st.phase = 'up';
    out.push(`🚀 BTC vượt <b>${fmt(cfg.w1)}</b> (đáy sóng 1): sóng 4 không được chồng lên sóng 1, nên <b>cách đếm này sai</b>.\n` +
      `Nhiều khả năng sóng C đã kết thúc ở ${fmt(st.w3)} và BTC đang vào xu hướng tăng. Bot ngừng theo dõi kịch bản này.`);
    return out;
  }

  if (st.phase === 'w4') {
    let lv = levels(cfg, st.w3);
    if (low < st.w3 && st.hi < lv.retr[0].p) {
      // Chưa kịp hồi tới 0.236 đã tạo đáy mới: sóng 3 đang kéo dài.
      st.w3 = low; st.hi = low; clear(['r']);
      lv = levels(cfg, st.w3);
      if (!st.lowAlert || low <= st.lowAlert * 0.99) {
        st.lowAlert = low;
        out.push(`📉 BTC tạo đáy mới <b>${fmt(low)}</b>: sóng 3 đang kéo dài (chưa vào sóng 4).\n` +
          `Vùng hồi sóng 4 tính lại: 0.382 ${fmt(lv.retr[1].p)} · 0.5 ${fmt(lv.retr[2].p)}\n${targetsText(lv)}`);
      }
    }
    st.hi = Math.max(st.hi, high);
    if (cfg.alt && st.hi > cfg.alt) once('alt', `🟢 BTC vượt <b>${fmt(cfg.alt)}</b> (đỉnh sóng 4 nhỏ của cách đếm phụ): <b>dấu hiệu sớm sóng C đã kết thúc ở ${fmt(st.w3)}</b>.\n` +
      `Cách đếm phụ: đoạn rơi về ${fmt(st.w3)} đã đủ 5 sóng con, đáy đúng Fib 0.618 của sóng A, có phân kỳ RSI 4 giờ.\n` +
      `Chưa chắc chắn: vẫn có thể là sóng 4 hồi sâu. Xác nhận mạnh hơn khi vượt ${fmt(lv.retr[3].p)}, chắc chắn khi vượt ${fmt(cfg.w1)}. Giữ trên ${fmt(st.w3)} là điều kiện bắt buộc.`);
    for (const { L, p } of lv.retr) {
      if (st.hi >= p) once('r' + L, `↗️ Sóng 4: BTC hồi chạm <b>Fib ${L}</b> ≈ ${fmt(p)} (cao nhất ${fmt(st.hi)}, ${pct(st.hi, st.w3)} từ đáy sóng 3).\n` +
        (L === 0.382 ? 'Đây là vùng sóng 4 hay dừng nhất. Chú ý nến đảo chiều giảm.' : L === 0.618 ? `Hồi sâu bất thường. Vượt ${fmt(cfg.w1)} là cách đếm sai.` :
          L === 0.5 ? 'Mức hồi tối đa thường gặp của sóng 4.' : 'Sóng 4 đã bắt đầu. Vùng kháng cự kế tiếp: Fib 0.382.'));
    }
    // Sóng 4 xong: đã hồi tới 0.382 rồi rơi 5%, hoặc chỉ hồi nông (dưới 0.382) rồi quay về sát đáy sóng 3 (trong 3%).
    const w4Done = st.hi >= lv.retr[1].p ? last <= st.hi * (1 - W4_DROP) : st.hi >= lv.retr[0].p && last <= st.w3 * 1.03;
    if (w4Done) {
      st.phase = 'w5'; st.w4 = st.hi; st.lo = last; clear(['t1', 're3', 'brk3', 'e']);
      out.push(`🔻 BTC rơi ${pct(last, st.w4)} từ đỉnh hồi ${fmt(st.w4)}: <b>có thể sóng 4 đã xong, sóng 5 bắt đầu</b>.\n` +
        `${targetsText(levels(cfg, st.w3, st.w4))}\n<i>Nếu giá vượt lại ${fmt(st.w4)} thì sóng 4 vẫn đang hồi tiếp.</i>`);
    }
    return out;
  }

  if (st.phase === 'w5') {
    if (high > st.w4 * 1.002) {
      st.phase = 'w4'; st.hi = high;
      out.push(`↗️ BTC vượt lại đỉnh ${fmt(st.w4)}: <b>sóng 4 chưa xong</b>, đang hồi tiếp. Bot sẽ tính lại khi có đỉnh mới.`);
      return out;
    }
    st.lo = Math.min(st.lo, low);
    const lv = levels(cfg, st.w3, st.w4);
    const e = Object.fromEntries(lv.ext.map((x) => [x.L, x.p]));
    if (st.lo <= lv.t1) once('t1', `🎯 Kịch bản 1: BTC chạm <b>${fmt(lv.t1)}</b> (sóng 5 = sóng 1).\n` + (lv.t1 > st.w3
      ? `Nếu giữ được trên ${fmt(st.w3)} và RSI tạo đáy cao hơn, có thể thành <b>2 đáy</b> và sóng C kết thúc tại đây.`
      : `Chờ RSI ngày tạo đáy cao hơn ${st.rsi3.toFixed(1)} để xác nhận đáy.`));
    if (st.lo <= st.w3 * 1.005) once('re3', `⚠️ BTC thử lại đáy sóng 3 (${fmt(st.w3)}). Giữ được là kịch bản 1, thủng là kịch bản 2.`);
    if (st.lo < st.w3) once('brk3', `📉 BTC <b>thủng đáy sóng 3</b> ${fmt(st.w3)}: sóng 5 đang chạy, nghiêng về <b>kịch bản 2</b>.\n` +
      `Các tầng kế tiếp: 0.382 ${fmt(e[0.382])} · 0.5 ${fmt(e[0.5])} · 0.618 <b>${fmt(e[0.618])}</b>` +
      (cfg.alt ? `\nCách đếm phụ (sóng C xong ở ${fmt(st.w3)}) bị loại.` : ''));
    for (const L of [0.382, 0.5, 0.618]) {
      if (e[L] < st.w3 && st.lo <= e[L]) once('e' + L, `🎯 BTC chạm <b>Fib ${L}</b> mở rộng ≈ ${fmt(e[L])}` +
        (L === 0.618 ? ' (mục tiêu chính của kịch bản 2, vùng mua mạnh nhất).' : '.') + ` Chờ RSI ngày tạo đáy cao hơn ${st.rsi3.toFixed(1)} để xác nhận đáy.`);
    }
    if (st.lo <= e[0.786]) {
      st.phase = 'down';
      out.push(`🛑 BTC xuống dưới <b>${fmt(e[0.786])}</b> (Fib 0.786): <b>cách đếm này sai</b>, đợt điều chỉnh lớn hơn dự kiến.\n` +
        `Mục tiêu xa hơn: sóng C bằng sóng A (thang log) khoảng 41–42K. Nên dừng mua và đánh giá lại. Bot ngừng theo dõi kịch bản này.`);
      return out;
    }
    // Đáy sóng 5: bật 8% từ đáy nằm dưới, hoặc cách đáy sóng 3 không quá 6% (sóng 5 cụt, không thủng đáy sóng 3).
    if (st.lo <= st.w3 * 1.06 && last >= st.lo * (1 + W5_BOUNCE)) {
      st.phase = 'end'; st.w5 = st.lo;
      out.push(`🟢 BTC bật ${pct(last, st.w5)} từ đáy ${fmt(st.w5)}: <b>có thể sóng 5 và cả sóng C đã kết thúc</b>` +
        (st.w5 > st.w3 ? ` (sóng 5 cụt: không thủng đáy sóng 3 ${fmt(st.w3)}, hay gặp khi lực bán đã cạn).\n` : '.\n') +
        `Xác nhận khi vượt đỉnh sóng 4 ${fmt(st.w4)}. Thủng lại ${fmt(st.w5)} thì sóng 5 chưa xong.`);
    }
    return out;
  }

  if (st.phase === 'end') {
    if (low < st.w5) {
      st.phase = 'w5'; st.lo = low;
      out.push(`🔻 BTC thủng lại đáy ${fmt(st.w5)}: sóng 5 <b>chưa xong</b>, tiếp tục theo dõi các mục tiêu.`);
    } else if (high > st.w4) {
      st.phase = 'done';
      out.push(`✅ BTC vượt đỉnh sóng 4 ${fmt(st.w4)}: <b>xác nhận sóng C đã kết thúc</b> ở ${fmt(st.w5)}.\n` +
        `Đợt điều chỉnh từ đỉnh 126K có thể đã xong. Bot ngừng theo dõi kịch bản này.`);
    }
  }
  return out;
}

const PHASE_VI = {
  w4: 'sóng 4 (hồi)', w5: 'sóng 5 (giảm cuối)', end: 'có thể đã hết sóng 5 (chờ xác nhận)',
};

// Đóng nến khung lớn: tuần (sáng thứ Hai, kèm phân kỳ RSI tuần), tháng (ngày 1), quý (1/1, 1/4, 1/7, 1/10).
export function weeklyLines(w, w3) {
  const lines = [];
  const rsi = rsiSeries(w.map((c) => +c[4]));
  const n = w.length - 1, c = +w[n][4];
  lines.push(c < w3 ? `📉 <b>Nến tuần đóng dưới ${fmt(w3)}</b> (${fmt(c)}): mất đáy sóng 3, nghiêng về kịch bản 2.`
    : `🕯 Nến tuần đóng ${fmt(c)}: giữ trên đáy ${fmt(w3)}.`);
  if (c >= WEEK_BULL) lines.push(`🚀 Nến tuần đóng trên ${fmt(WEEK_BULL)}: lấy lại các đường trung bình tuần, tín hiệu đảo chiều tăng.`);
  // Phân kỳ RSI tuần: đáy giá 3 tuần gần nhất so với đáy RSI trước đó (4 đến 40 tuần trước).
  let iP = -1;
  for (let i = Math.max(15, n - 40); i <= n - 4; i++) if (iP < 0 || rsi[i] < rsi[iP]) iP = i;
  if (iP > 0) {
    const pP = Math.min(...w.slice(iP - 2, iP + 3).map((x) => +x[3]));
    const lowNow = Math.min(...w.slice(n - 2).map((x) => +x[3]));
    const rNow = Math.min(...rsi.slice(n - 2));
    if (lowNow < pP) {
      lines.push(rNow > rsi[iP]
        ? `🟢 <b>Phân kỳ tăng RSI tuần</b>: đáy giá ${fmt(lowNow)} thấp hơn ${fmt(pP)} nhưng RSI ${rNow.toFixed(1)} cao hơn ${rsi[iP].toFixed(1)}. Lực bán khung lớn đang yếu.`
        : `⚪ Chưa có phân kỳ RSI tuần: giá thấp hơn đáy trước (${fmt(pP)}) và RSI cũng thấp hơn (${rNow.toFixed(1)} so với ${rsi[iP].toFixed(1)}).`);
    }
  }
  return lines;
}

async function bigCloses(st, getJson, host, end) {
  const lines = [];
  const t = new Date(end);
  if (t.getUTCDay() === 1) {
    const w = await getJson(`${host}/api/v3/klines?symbol=BTCUSDT&interval=1w&endTime=${end - 61e3}&limit=300`);
    lines.push(...weeklyLines(w, st.w3));
  }
  if (t.getUTCDate() === 1) {
    const m = await getJson(`${host}/api/v3/klines?symbol=BTCUSDT&interval=1M&endTime=${end - 61e3}&limit=2`);
    const c = +m[m.length - 1][4];
    lines.push(c < MONTH_LEVEL
      ? `📉 <b>Nến tháng đóng dưới ${fmt(MONTH_LEVEL)}</b> (${fmt(c)}): thủng đường trung bình khung tháng từng đỡ đáy 2018 và 2022. Rất xấu.`
      : `🕯 Nến tháng đóng ${fmt(c)}: giữ trên đường trung bình khung tháng (~${fmt(MONTH_LEVEL)}).`);
    if (t.getUTCMonth() % 3 === 0) {
      lines.push(c < QUARTER_LEVEL
        ? `📉 Nến quý đóng dưới đường trung bình khung quý (~${fmt(QUARTER_LEVEL)}): năm 2022 sau tình huống này giá rơi tiếp về đường xanh dương.`
        : `🟢 Nến quý đóng trên đường trung bình khung quý (~${fmt(QUARTER_LEVEL)}): khung lớn giữ được.`);
    }
  }
  return lines;
}

// Tóm tắt lúc 7:01 sáng (nến ngày vừa đóng): giá đóng cửa, RSI, phân kỳ, đóng nến dưới đáy sóng 3.
async function daily(st, cfg, getJson, host, end) {
  const d = await getJson(`${host}/api/v3/klines?symbol=BTCUSDT&interval=1d&endTime=${end - 61e3}&limit=200`);
  const rsi = rsiSeries(d.map((c) => +c[4]));
  const y = d[d.length - 1], r = rsi[rsi.length - 1];
  const close = +y[4], low = +y[3];
  const lines = [];
  if (st.phase === 'w5' || st.phase === 'end') {
    if (close < st.w3 && !st.closedBelow) {
      st.closedBelow = true;
      lines.push(`📉 Nến ngày <b>đóng cửa dưới đáy sóng 3</b> ${fmt(st.w3)}: kịch bản 2 được xác nhận rõ hơn.`);
    }
    if (low <= st.w3 * 1.01 && r > st.rsi3 + 1) {
      lines.push(`🟢 <b>Phân kỳ tăng RSI ngày</b>: giá thấp ${fmt(low)} (gần/dưới đáy sóng 3) nhưng RSI ${r.toFixed(1)} cao hơn đáy sóng 3 (${st.rsi3.toFixed(1)}). Lực bán đang yếu, dấu hiệu đáy.`);
    }
  }
  try { lines.push(...await bigCloses(st, getJson, host, end)); } catch (e) { console.log('elliott closes', e.message); }
  const lv = levels(cfg, st.w3, st.phase === 'w4' ? null : st.w4);
  let where;
  if (st.phase === 'w4') {
    const next = lv.retr.find((x) => x.p > st.hi);
    where = `Đỉnh hồi cao nhất ${fmt(st.hi)} (${pct(st.hi, st.w3)} từ đáy).${next ? ` Mức kế tiếp: Fib ${next.L} ${fmt(next.p)}.` : ''}` +
      (cfg.alt && st.hi <= cfg.alt ? `\nCách đếm phụ (sóng C đã xong ở ${fmt(st.w3)}): dấu hiệu sớm khi vượt ${fmt(cfg.alt)}.` : '');
  } else if (st.phase === 'w5') where = `Đỉnh sóng 4 ${fmt(st.w4)} · thấp nhất từ đó ${fmt(st.lo)}.`;
  else where = `Đáy có thể của sóng 5: ${fmt(st.w5)} · xác nhận khi vượt ${fmt(st.w4)}.`;
  return `${HEAD} · tóm tắt sáng\nĐang ở: <b>${PHASE_VI[st.phase]}</b>\nĐóng nến ngày: ${fmt(close)} · RSI ngày ${r.toFixed(1)}\n${where}\n` +
    (lines.length ? lines.join('\n') + '\n' : '') + targetsText(lv);
}

export async function elliottCheck({ storage, getJson, host, end, cfgStr }) {
  const cfg = parseWaves(cfgStr);
  if (!cfg || !host) return [];
  const out = [];
  let st = await storage.get(KEY);
  if (!st || st.sig !== cfg.sig) {
    st = await init(cfg, cfg.sig, getJson, host, end);
    st.v2 = 1;
    out.push(initMessage(cfg, st));
  }
  if (!st.v2) { // bot đang theo dõi từ trước: báo 1 lần các phần mới thêm
    st.v2 = 1;
    out.push(`${HEAD} · cập nhật\nBot báo thêm:\n` +
      (cfg.alt ? `• Vượt ${fmt(cfg.alt)}: dấu hiệu sớm sóng C đã xong ở ${fmt(st.w3)} (cách đếm 5 sóng con)\n` : '') +
      `• Sóng 5 cụt (bật 8% mà không thủng đáy sóng 3)\n` +
      `• Sáng thứ Hai: đóng nến tuần so với ${fmt(st.w3)} và ${fmt(WEEK_BULL)}, phân kỳ RSI tuần\n` +
      `• Ngày 1 hàng tháng: đóng nến tháng so với ~${fmt(MONTH_LEVEL)}; đầu quý: nến quý so với ~${fmt(QUARTER_LEVEL)}`);
  }
  if (!PHASE_VI[st.phase]) { await storage.put(KEY, st); return out; } // đã kết thúc kịch bản

  const t = await getJson(`${host}/api/v3/ticker?windowSize=1m&type=MINI&symbol=BTCUSDT`);
  const low = +t.lowPrice, high = +t.highPrice, last = +t.lastPrice;
  // Bỏ qua phút không có giao dịch (giá 0) hoặc giá giật bất thường quá 15%.
  const ok = low > 0 && high > 0 && last > 0 && !(st.last && (low < st.last * 0.85 || high > st.last * 1.15));
  if (ok) {
    st.last = last;
    const msgs = step(st, cfg, { low, high, last });
    // Nhiều mức chạm trong cùng 1 phút (giá rơi nhanh) gộp thành 1 tin.
    if (msgs.length) out.push(`${HEAD}\n${msgs.join('\n\n')}\n<i>Giá Binance BTCUSDT</i>`);
  }

  if (end % DAY === 60e3 && PHASE_VI[st.phase]) {
    try { out.push(await daily(st, cfg, getJson, host, end)); } catch (e) { console.log('elliott daily', e.message); }
  }
  await storage.put(KEY, st);
  return out;
}
