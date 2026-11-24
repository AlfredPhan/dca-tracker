'use strict';
// Tab "Pivot": Pivot Point kiểu Classic (TradingView gọi là "Traditional") cho các khung ngày, tuần, tháng, năm.
// Nguồn: nến spot Binance. Mốc chốt nến theo giờ UTC của Binance: ngày mới lúc 7:00 sáng giờ VN,
// tuần mới thứ Hai 7:00, tháng mới ngày 1 lúc 7:00, năm mới 1/1 lúc 7:00.

const PIV_API = 'https://data-api.binance.vision/api/v3';
const PIV_COINS = ['BTC', 'ETH', 'XAU', 'ARB', 'APT', 'FET', 'OP', 'TIA', 'LDO']; // XAU = vàng
const PIV_FRAMES = [
  { key: 'd', name: 'Ngày', icon: '📅' },
  { key: 'w', name: 'Tuần', icon: '🗓' },
  { key: 'm', name: 'Tháng', icon: '📆' },
  { key: 'y', name: 'Năm', icon: '🏁' },
];
const PIV_PRICE_MS = 10000; // giá cập nhật mỗi 10 giây
const PIV_RELOAD_MS = 30 * 60000; // tải lại nến định kỳ 30 phút (dự phòng)
const DAY_MS = 864e5;
const PIV_FAPI = 'https://fapi.binance.com/fapi/v1';
const XAU_OFF_KEY = 'piv-xau-offset';

// ---------- Phần tính toán (không đụng tới giao diện) ----------
// Công thức Classic / Traditional, từ giá cao (H), thấp (L), đóng cửa (C) của kỳ trước.
function pivotLevels(H, L, C) {
  const P = (H + L + C) / 3;
  return {
    R5: P * 4 + (H - 4 * L), R4: P * 3 + (H - 3 * L), R3: H + 2 * (P - L), R2: P + (H - L), R1: 2 * P - L,
    P,
    S1: 2 * P - H, S2: P - (H - L), S3: L - 2 * (H - P), S4: P * 3 - (3 * H - L), S5: P * 4 - (4 * H - L),
  };
}

// Mốc bắt đầu kỳ hiện tại và kỳ kế tiếp (theo giờ UTC như nến Binance).
function periodBounds(key, now) {
  const d = new Date(now);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  if (key === 'd') { const s = Date.UTC(y, m, d.getUTCDate()); return [s, s + DAY_MS]; }
  if (key === 'w') { // tuần bắt đầu thứ Hai
    const s = Date.UTC(y, m, d.getUTCDate()) - ((d.getUTCDay() + 6) % 7) * DAY_MS;
    return [s, s + 7 * DAY_MS];
  }
  if (key === 'm') return [Date.UTC(y, m, 1), Date.UTC(y, m + 1, 1)];
  return [Date.UTC(y, 0, 1), Date.UTC(y + 1, 0, 1)];
}

// Nến kỳ trước = nến đã đóng gần nhất trước khi kỳ hiện tại bắt đầu. kl: mảng nến Binance [openTime, O, H, L, C, ...].
function prevFromCandles(kl, start) {
  const done = kl.filter((k) => k[0] < start);
  const k = done[done.length - 1];
  return k && { open: k[0], H: +k[2], L: +k[3], C: +k[4] };
}

// Năm trước: gộp 12 nến tháng của năm đó.
function prevYearFromMonths(months, now) {
  const year = new Date(now).getUTCFullYear() - 1;
  const ms = months.filter((k) => new Date(k[0]).getUTCFullYear() === year);
  if (!ms.length) return null;
  return {
    open: ms[0][0], H: Math.max(...ms.map((k) => +k[2])), L: Math.min(...ms.map((k) => +k[3])),
    C: +ms[ms.length - 1][4], months: ms.length,
  };
}

// Tính đủ 4 khung cho một coin từ nến ngày, tuần, tháng.
function computeFrames(dayK, weekK, monthK, now) {
  const out = {};
  for (const f of PIV_FRAMES) {
    const [start, next] = periodBounds(f.key, now);
    const base = f.key === 'd' ? prevFromCandles(dayK, start)
      : f.key === 'w' ? prevFromCandles(weekK, start)
      : f.key === 'm' ? prevFromCandles(monthK, start)
      : prevYearFromMonths(monthK, now);
    if (base) out[f.key] = { base, levels: pivotLevels(base.H, base.L, base.C), start, next };
  }
  return out;
}

// ---------- Vàng (XAU) ----------
// Exness và thị trường vàng nghỉ thứ Bảy, Chủ nhật; Binance vẫn giao dịch nên bỏ nến cuối tuần cho khớp.
const isWeekday = (k) => { const d = new Date(k[0]).getUTCDay(); return d >= 1 && d <= 5; };

// Gộp các nến ngày trong khoảng [from, to) thành một nến H/L/C.
function aggregate(days, from, to) {
  const ks = days.filter((k) => k[0] >= from && k[0] < to);
  if (!ks.length) return null;
  return { open: ks[0][0], H: Math.max(...ks.map((k) => +k[2])), L: Math.min(...ks.map((k) => +k[3])), C: +ks[ks.length - 1][4], n: ks.length };
}

// xau: nến ngày XAUUSDT (futures), paxg: nến ngày PAXGUSDT (dự phòng cho năm khi XAUUSDT chưa đủ lịch sử).
function computeGoldFrames(xau, paxg, now) {
  const days = xau.filter(isWeekday), pDays = paxg.filter(isWeekday);
  const out = {};
  for (const f of PIV_FRAMES) {
    const [start, next] = periodBounds(f.key, now);
    let base = null, source = 'XAUUSDT';
    if (f.key === 'd') {
      const done = days.filter((k) => k[0] < start);
      const k = done[done.length - 1];
      base = k && { open: k[0], H: +k[2], L: +k[3], C: +k[4] };
    } else {
      const from = f.key === 'w' ? start - 7 * DAY_MS
        : f.key === 'm' ? Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth() - 1, 1)
        : Date.UTC(new Date(start).getUTCFullYear() - 1, 0, 1);
      // Năm: chỉ dùng XAUUSDT khi có dữ liệu từ đầu năm (tuần đầu tháng 1), nếu không thì dùng PAXG.
      const covered = days.length && days[0][0] <= from + 7 * DAY_MS;
      if (f.key === 'y' && !covered) { base = aggregate(pDays, from, start); source = 'PAXG'; }
      else base = aggregate(days, from, start);
    }
    if (base) out[f.key] = { base, levels: pivotLevels(base.H, base.L, base.C), start, next, source };
  }
  return out;
}

const MAIN_LEVELS = ['R3', 'R2', 'R1', 'P', 'S1', 'S2', 'S3'];

// Giá đang nằm giữa hai mức nào. Trả về { code: 'S1–P', above: true/false, lower, upper }.
// Mức nhỏ hơn hoặc bằng 0 (xảy ra khi biên độ kỳ trước quá lớn so với giá) không có ý nghĩa nên bỏ qua.
function pricePosition(levels, price) {
  if (price >= levels.R3) return { code: 'Trên R3', above: true, lower: 'R3', upper: null };
  if (price < levels.S3) return { code: 'Dưới S3', above: false, lower: null, upper: 'S3' };
  for (let i = 0; i < MAIN_LEVELS.length - 1; i++) {
    const up = MAIN_LEVELS[i], lo = MAIN_LEVELS[i + 1];
    if (price < levels[up] && price >= levels[lo]) {
      if (levels[lo] <= 0) return { code: `Dưới ${up}`, above: price >= levels.P, lower: null, upper: up };
      return { code: `${lo}–${up}`, above: price >= levels.P, lower: lo, upper: up };
    }
  }
  return { code: '—', above: price >= levels.P };
}

// Vùng hội tụ: các mức của nhiều khung nằm sát nhau (cách nhau không quá tol, mặc định 0.6%).
function confluences(frames, price, tol = 0.006, range = 0.15) {
  const pts = [];
  for (const f of PIV_FRAMES) {
    const fr = frames[f.key];
    if (!fr) continue;
    for (const name of MAIN_LEVELS) {
      const v = fr.levels[name];
      if (Math.abs(v - price) / price <= range) pts.push({ v, label: `${name} ${f.name}`, frame: f.key });
    }
  }
  pts.sort((a, b) => a.v - b.v);
  const groups = [];
  for (const p of pts) {
    const g = groups[groups.length - 1];
    if (g && (p.v - g.lo) / g.lo <= tol) { g.items.push(p); g.hi = p.v; } else groups.push({ lo: p.v, hi: p.v, items: [p] });
  }
  return groups.filter((g) => new Set(g.items.map((i) => i.frame)).size >= 2)
    .map((g) => ({ ...g, mid: (g.lo + g.hi) / 2, frames: new Set(g.items.map((i) => i.frame)).size }));
}

// Độ mạnh của một vùng: khung lớn nặng ký hơn; cộng 1 điểm nếu vùng chứa số tròn (VD BTC 60,000, ETH 2,000, ARB 0.1).
const ZONE_WEIGHT = { d: 1, w: 2, m: 3, y: 4 };
function roundIn(lo, hi, price) {
  const step = Math.pow(10, Math.floor(Math.log10(price))) / 2;
  const r = Math.round(((lo + hi) / 2) / step) * step;
  return r > 0 && r >= lo * 0.997 && r <= hi * 1.003 ? r : 0;
}
function zoneScore(items, lo, hi, price) {
  const round = roundIn(lo, hi, price);
  const pts = items.reduce((s, i) => s + (ZONE_WEIGHT[i.frame] || 1), 0) + (round ? 1 : 0);
  return { pts, round, stars: pts >= 7 ? 3 : pts >= 4 ? 2 : 1 };
}

// ---------- Giao diện ----------
const pv = { started: false, coin: 'BTC', data: {}, price: {}, priceAt: 0, timer: null, loading: {}, xauOff: loadXauOff() };

// Độ lệch giữa giá Exness và Binance do người dùng tự căn (lưu trên trình duyệt này).
function loadXauOff() {
  try { return JSON.parse(localStorage.getItem(XAU_OFF_KEY)) || null; } catch { return null; }
}
function saveXauOff(v) {
  pv.xauOff = v;
  try { v ? localStorage.setItem(XAU_OFF_KEY, JSON.stringify(v)) : localStorage.removeItem(XAU_OFF_KEY); } catch {}
}
const offOf = (c) => (c === 'XAU' && pv.xauOff ? pv.xauOff.off : 0);
const pivName = (c) => (c === 'XAU' ? '🥇 Vàng' : c);

// Dịch toàn bộ mức và giá đi một khoảng (căn theo Exness). Vị trí giá so với các mức không đổi.
function shiftFrames(frames, off) {
  if (!off) return frames;
  const out = {};
  for (const [k, fr] of Object.entries(frames)) {
    const levels = {};
    for (const [n, v] of Object.entries(fr.levels)) levels[n] = v + off;
    out[k] = { ...fr, levels, base: { ...fr.base, H: fr.base.H + off, L: fr.base.L + off, C: fr.base.C + off } };
  }
  return out;
}

function pivCoins() {
  const extra = typeof holdingCoins === 'function' ? holdingCoins().filter((c) => !PIV_COINS.includes(c) && c !== 'USDT') : [];
  return [...PIV_COINS, ...extra];
}

async function pivJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function loadPivotCoin(coin) {
  if (pv.loading[coin]) return;
  pv.loading[coin] = true;
  try {
    const now = Date.now();
    if (coin === 'XAU') {
      // Vàng: hợp đồng XAUUSDT (bám giá vàng quốc tế); PAXG dự phòng cho khung năm.
      const [xau, paxg] = await Promise.all([
        pivJson(`${PIV_FAPI}/klines?symbol=XAUUSDT&interval=1d&limit=420`),
        pivJson(`${PIV_API}/klines?symbol=PAXGUSDT&interval=1d&limit=760`),
      ]);
      pv.data[coin] = { frames: computeGoldFrames(xau, paxg, now), at: now };
    } else {
      const s = `${PIV_API}/klines?symbol=${coin}USDT`;
      const [d, w, m] = await Promise.all([pivJson(`${s}&interval=1d&limit=3`), pivJson(`${s}&interval=1w&limit=3`), pivJson(`${s}&interval=1M&limit=26`)]);
      pv.data[coin] = { frames: computeFrames(d, w, m, now), at: now };
    }
  } catch {
    pv.data[coin] = pv.data[coin] || { error: true, at: Date.now() };
  } finally {
    pv.loading[coin] = false;
  }
}

async function loadPivotPrices() {
  const coins = pivCoins().filter((c) => c !== 'XAU');
  await Promise.all([
    pivJson(`${PIV_API}/ticker/price?symbols=${encodeURIComponent(JSON.stringify(coins.map((c) => c + 'USDT')))}`)
      .then((list) => { for (const { symbol, price } of list) pv.price[symbol.slice(0, -4)] = +price; pv.priceAt = Date.now(); })
      .catch(() => { for (const c of coins) if (prices[c]) pv.price[c] = prices[c]; }), // dự phòng: giá chung của web
    pivJson(`${PIV_FAPI}/ticker/price?symbol=XAUUSDT`).then((t) => { pv.price.XAU = +t.price; }).catch(() => {}),
  ]);
}

function startPivot() {
  if (!pv.started) {
    pv.started = true;
    renderPivotChips();
    $('#pvPick').addEventListener('click', (e) => {
      const tr = e.target.closest('[data-coin]');
      if (tr) selectPivotCoin(tr.dataset.coin);
    });
    $('#pvXauSet').addEventListener('click', () => {
      const ex = +$('#pvXauInput').value, bn = pv.price.XAU;
      if (!ex || !bn) return;
      if (Math.abs(ex - bn) / bn > 0.03) { alert('Giá nhập lệch quá 3% so với giá vàng hiện tại, bạn kiểm tra lại nhé.'); return; }
      saveXauOff({ off: ex - bn, at: Date.now() });
      $('#pvXauInput').value = '';
      renderPivot();
    });
    $('#pvXauReset').addEventListener('click', () => { saveXauOff(null); renderPivot(); });
  }
  refreshPivot(true);
  clearInterval(pv.timer);
  pv.timer = setInterval(() => { if (!document.hidden && !$('#tab-pivot').hidden) refreshPivot(false); }, PIV_PRICE_MS);
}

function selectPivotCoin(coin) {
  pv.coin = coin;
  renderPivotChips();
  renderPivot();
  $('#pvDetail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function refreshPivot(force) {
  const now = Date.now();
  // Tải lại nến khi qua kỳ mới (chờ thêm 15 giây cho Binance chốt nến) hoặc định kỳ 30 phút.
  const stale = pivCoins().filter((c) => {
    const d = pv.data[c];
    if (force || !d || d.error) return true;
    if (now - d.at > PIV_RELOAD_MS) return true;
    return Object.values(d.frames).some((f) => now >= f.next + 15000);
  });
  await Promise.all([loadPivotPrices(), ...stale.map(loadPivotCoin)]);
  renderPivot();
}

function renderPivotChips() {
  $('#pvChips').innerHTML = pivCoins().map((c) =>
    `<button data-coin="${esc(c)}" class="${c === pv.coin ? 'active' : ''}">${pivName(c)}</button>`).join('');
}

const pivFmt = (n) => fmtPrice(n);
const pivDist = (v, price) => { const p = (v - price) / price * 100; return `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`; };
const fmtDur = (ms) => {
  const m = Math.max(0, Math.floor(ms / 60000)), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return d ? `${d} ngày ${h} giờ` : h ? `${h} giờ ${m % 60} phút` : `${m % 60} phút`;
};
const vnDate = (ms, opt) => new Date(ms).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', ...opt });

// Mô tả kỳ đang áp dụng và kỳ dữ liệu gốc, ví dụ "Tháng 11/2026 · tính từ tháng 10/2026".
function frameTitle(key, fr) {
  const b = fr.base.open;
  const two = (n) => String(n).padStart(2, '0');
  const dm = (ms) => { const d = new Date(ms); return `${two(d.getUTCDate())}/${two(d.getUTCMonth() + 1)}`; };
  const my = (ms) => { const d = new Date(ms); return `${two(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`; };
  if (key === 'd') return [`Ngày ${dm(fr.start)}`, `tính từ phiên ${dm(b)}`];
  if (key === 'w') return [`Tuần ${dm(fr.start)} – ${dm(fr.next - DAY_MS)}`, `tính từ tuần ${dm(b)} – ${dm(b + 6 * DAY_MS)}`];
  if (key === 'm') return [`Tháng ${my(fr.start)}`, `tính từ tháng ${my(b)}`];
  return [`Năm ${new Date(fr.start).getUTCFullYear()}`, `tính từ năm ${new Date(b).getUTCFullYear()}${fr.base.months < 12 ? ` (${fr.base.months} tháng có dữ liệu)` : ''}`];
}

function renderPivot() {
  renderPivotOverview();
  renderPivotDetail();
  $('#pvTime').textContent = pv.priceAt ? `Giá lúc ${new Date(pv.priceAt).toLocaleTimeString('vi-VN')} · tự cập nhật mỗi 10 giây` : '';
}

function renderPivotOverview() {
  const rows = pivCoins().map((c) => {
    const d = pv.data[c], price = pv.price[c] && pv.price[c] + offOf(c);
    const cells = PIV_FRAMES.map((f) => {
      const fr = d?.frames?.[f.key];
      if (!fr || !price) return `<td class="muted">${d?.error ? 'lỗi' : '…'}</td>`;
      const pos = pricePosition(fr.levels, price - offOf(c));
      return `<td><span class="pvbadge ${pos.above ? 'up' : 'down'}">${pos.code}</span></td>`;
    }).join('');
    return `<tr data-coin="${esc(c)}" class="${c === pv.coin ? 'sel' : ''}"><td><b>${pivName(c)}</b></td><td>${price ? pivFmt(price) : '…'}</td>${cells}</tr>`;
  }).join('');
  $('#pvOverview').innerHTML = `<div class="tablewrap"><table class="pvtable">
    <thead><tr><th>Coin</th><th>Giá</th>${PIV_FRAMES.map((f) => `<th>${f.name}</th>`).join('')}</tr></thead>
    <tbody>${rows}</tbody></table></div>
    <p class="hint"><span class="pvbadge up">xanh</span> giá <b>trên P</b>: phe mua chiếm ưu thế ·
      <span class="pvbadge down">đỏ</span> giá <b>dưới P</b>: phe bán chiếm ưu thế. Chữ trong ô cho biết giá đang nằm giữa 2 mức nào.
      Bấm vào một dòng để xem chi tiết.</p>`;
}

function renderPivotDetail() {
  const coin = pv.coin, raw = pv.data[coin], off = offOf(coin);
  renderXauBox();
  if (!raw || !pv.price[coin]) { $('#pvDetail').innerHTML = '<span class="muted small">Đang tải…</span>'; return; }
  if (raw.error) { $('#pvDetail').innerHTML = `<span class="down small">Không tải được dữ liệu ${esc(coin)}. Sẽ thử lại sau ít giây.</span>`; return; }
  const price = pv.price[coin] + off;
  const d = { ...raw, frames: shiftFrames(raw.frames, off) };

  // Câu tóm tắt cho từng khung.
  const lines = PIV_FRAMES.map((f) => {
    const fr = d.frames[f.key];
    if (!fr) return '';
    const L = fr.levels, pos = pricePosition(L, price);
    const sup = pos.lower ? `${pos.lower} ${pivFmt(L[pos.lower])} (${pivDist(L[pos.lower], price)})`
      : price < L.S3 && L.S4 > 0 ? `S4 ${pivFmt(L.S4)} (${pivDist(L.S4, price)})` : 'không còn mức Pivot bên dưới';
    const res = pos.upper ? `${pos.upper} ${pivFmt(L[pos.upper])} (${pivDist(L[pos.upper], price)})` : `R4 ${pivFmt(L.R4)} (${pivDist(L.R4, price)})`;
    return `<div class="light"><span class="dot">${pos.above ? '🟢' : '🔴'}</span>
      <span class="what">${f.icon} ${f.name}</span>
      <span class="state ${pos.above ? 'up' : 'down'}">${pos.above ? 'TRÊN P' : 'DƯỚI P'}</span>
      <span class="why">Hỗ trợ gần nhất <b class="up">${sup}</b> · kháng cự gần nhất <b class="down">${res}</b></span></div>`;
  }).join('');

  const ladders = PIV_FRAMES.map((f) => {
    const fr = d.frames[f.key];
    if (!fr) return `<div class="card"><h3>${f.icon} ${f.name}</h3><p class="muted small">Chưa đủ dữ liệu.</p></div>`;
    const L = fr.levels, pos = pricePosition(L, price);
    const all = [...(price >= L.R3 ? ['R5', 'R4'] : []), ...MAIN_LEVELS, ...(price < L.S3 ? ['S4', 'S5'] : [])];
    const names = all.filter((n) => L[n] > 0);
    const hidden = all.length - names.length;
    const rows = [];
    let placed = false;
    for (const n of names) {
      if (!placed && price >= L[n]) { rows.push(priceRow(price)); placed = true; }
      const tag = n === pos.upper ? 'kháng cự gần nhất' : n === pos.lower ? 'hỗ trợ gần nhất' : '';
      const kind = n === 'P' ? 'p' : n[0] === 'R' ? 'r' : 's';
      const near = n === pos.upper ? ' near res' : n === pos.lower ? ' near sup' : '';
      rows.push(`<div class="pvrow ${kind}${near}"><span class="lv">${n}</span><span class="val">${pivFmt(L[n])}</span>
        <span class="dist">${pivDist(L[n], price)}</span><span class="tag">${tag}</span></div>`);
    }
    if (!placed) rows.push(priceRow(price));
    const [title, sub0] = frameTitle(f.key, fr);
    const sub = coin !== 'XAU' ? sub0 : `${sub0} · nguồn ${fr.source}${fr.base.n ? `, ${fr.base.n} ngày giao dịch` : ''}`;
    return `<div class="card pvladder">
      <h3>${f.icon} ${title}</h3>
      <p class="muted small">${sub} · H ${pivFmt(fr.base.H)} · L ${pivFmt(fr.base.L)} · C ${pivFmt(fr.base.C)}<br>
        Tính lại sau <b>${fmtDur(fr.next - Date.now())}</b> (7:00 ngày ${vnDate(fr.next, { day: '2-digit', month: '2-digit', year: 'numeric' })})</p>
      ${rows.join('')}
      ${hidden ? `<p class="muted small">Ẩn ${hidden} mức ra số âm: kỳ trước giá biến động quá mạnh nên công thức không còn ý nghĩa ở phía dưới.</p>` : ''}
    </div>`;
  }).join('');

  // Luôn hiện cả hai phía: 2 vùng kháng cự gần nhất phía trên, 2 vùng hỗ trợ gần nhất phía dưới.
  // Ưu tiên vùng hội tụ (≥2 khung); phía nào không có thì lấy mức đơn của khung tuần/tháng/năm gần nhất.
  const conf = confluences(d.frames, price).map((g) => ({ ...g, score: zoneScore(g.items, g.lo, g.hi, price) }));
  const singles = [];
  for (const f of PIV_FRAMES.filter((x) => x.key !== 'd')) {
    const fr = d.frames[f.key];
    if (!fr) continue;
    for (const name of MAIN_LEVELS) {
      const v = fr.levels[name];
      if (v > 0 && Math.abs(v - price) / price <= 0.15) singles.push({ lo: v, hi: v, mid: v, items: [{ v, label: `${name} ${f.name}`, frame: f.key }] });
    }
  }
  const pick = (list, isSup) => list.filter((g) => (isSup ? g.hi < price : g.lo > price))
    .sort((a, b) => (isSup ? b.mid - a.mid : a.mid - b.mid));
  const side = (isSup) => {
    const c = pick(conf, isSup).slice(0, 2);
    if (c.length >= 2) return c;
    const used = new Set(c.flatMap((g) => g.items.map((i) => i.label)));
    const extra = pick(singles, isSup).filter((g) => !used.has(g.items[0].label))
      .map((g) => ({ ...g, single: true, score: zoneScore(g.items, g.lo, g.hi, price) }));
    return [...c, ...extra].sort((a, b) => (isSup ? b.mid - a.mid : a.mid - b.mid)).slice(0, 2);
  };
  const below = side(true), above = side(false);
  const confRow = (g, isSup) => `<div class="light"><span class="dot">${g.single ? '📍' : '🎯'}</span>
    <span class="what">${pivFmt(g.lo)}${g.hi !== g.lo ? ` – ${pivFmt(g.hi)}` : ''} <small class="muted">(${pivDist(g.mid, price)})</small>
      <span class="stars">${'★'.repeat(g.score.stars)}${'☆'.repeat(3 - g.score.stars)}</span></span>
    <span class="state ${isSup ? 'up' : 'down'}">${isSup ? 'HỖ TRỢ' : 'KHÁNG CỰ'}</span>
    <span class="why">${g.items.map((i) => i.label).join(' + ')}${g.score.round ? ` + số tròn ${pivFmt(g.score.round)}` : ''}${g.single ? ' (mức đơn)' : ''}</span></div>`;
  const confHtml = below.length || above.length
    ? [...above.slice().reverse().map((g) => confRow(g, false)),
      `<div class="pvnow">▶ Giá hiện tại ${pivFmt(price)}</div>`,
      ...below.map((g) => confRow(g, true))].join('')
    : '<p class="hint">Không có mức Pivot nào trong khoảng ±15% quanh giá.</p>';

  $('#pvDetail').innerHTML = `
    <div class="card">
      <div class="row between"><h2>${pivName(coin)} <span class="pvprice">${pivFmt(price)}</span></h2></div>
      ${coin === 'XAU' && [0, 6].includes(new Date().getUTCDay()) ? '<p class="hint">Cuối tuần thị trường vàng nghỉ. Mức khung Ngày đang lấy phiên thứ Sáu và áp dụng cho thứ Hai.</p>' : ''}
      <div class="lights">${lines}</div>
    </div>
    <div class="card">
      <h2>🎯 Vùng hội tụ <span class="muted small">(nhiều khung trùng nhau, thường mạnh hơn)</span></h2>
      <div class="lights">${confHtml}</div>
      <p class="muted small">🎯 = vùng hội tụ: mức của 2 khung trở lên cách nhau không quá 0.6%. 📍 = mức đơn của khung tuần/tháng/năm (khi phía đó không có vùng hội tụ).
        ★ càng nhiều càng mạnh: khung lớn nặng ký hơn (ngày 1, tuần 2, tháng 3, năm 4 điểm), cộng thêm nếu vùng chứa số tròn như 60,000 hay 2,000 (nơi nhiều người đặt lệnh).</p>
    </div>
    <div class="pvgrid">${ladders}</div>`;
}

// Khung căn giá Exness (chỉ hiện khi xem vàng). Nằm ngoài #pvDetail để ô nhập không bị vẽ lại mỗi 10 giây.
function renderXauBox() {
  const box = $('#pvXau');
  box.hidden = pv.coin !== 'XAU';
  if (box.hidden) return;
  const bn = pv.price.XAU, o = pv.xauOff;
  $('#pvXauStatus').innerHTML = !bn ? 'Đang tải giá…'
    : o ? `Đang căn theo Exness: lệch <b class="${cls(o.off)}">${o.off >= 0 ? '+' : ''}${o.off.toFixed(2)} USD</b> (căn lúc ${new Date(o.at).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}).
        Giá gốc Binance ${pivFmt(bn)}, sau khi căn ${pivFmt(bn + o.off)}.`
    : `Chưa căn. Đang dùng giá gốc Binance <b>${pivFmt(bn)}</b>.`;
  $('#pvXauReset').hidden = !o;
}

function priceRow(price) {
  return `<div class="pvrow now"><span class="lv">▶</span><span class="val">${pivFmt(price)}</span><span class="dist">giá hiện tại</span><span class="tag"></span></div>`;
}

// Mở thẳng tab Pivot bằng link .../#pivot hoặc .../#pivot=ETH
const pivHash = location.hash.match(/^#pivot(?:=(\w+))?$/);
if (pivHash) {
  if (pivHash[1]) pv.coin = pivHash[1].toUpperCase();
  document.querySelector('.tab[data-tab="pivot"]').click();
}
