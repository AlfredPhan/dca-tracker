'use strict';
// Tab "Cá voi": dùng các hàm/biến chung từ app.js ($, fmt*, cls, esc, computeHoldings, prices).

const SPOT_API = 'https://data-api.binance.vision/api/v3';
const FUT_API = 'https://fapi.binance.com/futures/data';
const WS_URL = 'wss://data-stream.binance.vision/ws/';
const W_REFRESH_MS = 30000;
const FEED_MAX = 100;

const w = {
  coin: null, min: 50000, ws: null, timer: null, started: false,
  big: { buy: 0, sell: 0, nBuy: 0, nSell: 0, since: null },
  sig: {}, // điểm từng tiêu chí: { score: -1|0|1, text } hoặc { pending: true, text }
};
const BIG_MIN_MINUTES = 15; // lệnh lớn cần thu thập tối thiểu bấy nhiêu phút mới chấm điểm

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(res.status);
  return res.json();
}

// ---------- Chuyển tab ----------
document.querySelectorAll('.tab').forEach((btn) => btn.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
  document.querySelectorAll('main[id^="tab-"]').forEach((m) => { m.hidden = m.id !== 'tab-' + btn.dataset.tab; });
  if (btn.dataset.tab === 'whale') {
    renderQuickCoins();
    if (!w.started) startWhale(defaultCoin());
  }
  if (btn.dataset.tab === 'gold' && typeof startGold === 'function') startGold();
  if (btn.dataset.tab === 'pivot' && typeof startPivot === 'function') startPivot();
}));

function holdingCoins() {
  return computeHoldings().filter((h) => h.qty > 0 && h.coin !== 'USDT').map((h) => h.coin);
}
function defaultCoin() {
  return holdingCoins()[0] || 'BTC';
}
function renderQuickCoins() {
  const coins = [...new Set([...holdingCoins(), 'BTC', 'ETH', 'SOL'])];
  $('#wQuick').innerHTML = coins.map((c) => `<button data-coin="${esc(c)}">${esc(c)}</button>`).join('');
}

$('#wQuick').addEventListener('click', (e) => {
  if (e.target.dataset.coin) startWhale(e.target.dataset.coin);
});
$('#wGo').addEventListener('click', () => startWhale($('#wCoin').value));
$('#wCoin').addEventListener('keydown', (e) => { if (e.key === 'Enter') startWhale($('#wCoin').value); });

// ---------- Khởi động theo dõi 1 coin ----------
async function startWhale(coin) {
  coin = (coin || '').trim().toUpperCase();
  if (!coin) return;
  if (Object.keys(prices).length > 1 && prices[coin] == null) {
    alert(`Không tìm thấy cặp ${coin}/USDT trên Binance.`);
    return;
  }
  w.started = true;
  w.coin = coin;
  w.min = Math.max(1000, +$('#wMin').value || 50000);
  $('#wMin').value = w.min;
  $('#wCoin').value = coin;
  w.big = { buy: 0, sell: 0, nBuy: 0, nSell: 0, since: null, started: Date.now() };
  w.sig = {};
  $('#wFeedBuy tbody').innerHTML = '';
  $('#wFeedSell tbody').innerHTML = '';
  ['#wScore', '#wFlow', '#wFunding', '#wUnlock', '#wOnchain', '#wBigStats', '#wLs', '#wWalls'].forEach((s) => { $(s).innerHTML = '<span class="muted small">Đang tải…</span>'; });

  if (typeof startMarket === 'function') startMarket(coin); // tính năng bổ sung trong market.js
  clearInterval(w.timer);
  loadSuggest(coin);
  connectStream();
  backfillBigTrades();
  refreshWhale();
  w.timer = setInterval(() => { if (!document.hidden && !$('#tab-whale').hidden) refreshWhale(); }, W_REFRESH_MS);
}

// ---------- Gợi ý ngưỡng lệnh lớn theo khối lượng giao dịch 24h ----------
const THRESHOLD_TIERS = [ // [khối lượng 24h tối thiểu, ngưỡng gợi ý]
  [500e6, 50000], [100e6, 20000], [30e6, 10000], [10e6, 5000], [2e6, 2000], [0, 1000],
];

async function loadSuggest(coin) {
  const box = $('#wSuggest');
  box.innerHTML = '';
  try {
    const t = await getJson(`${SPOT_API}/ticker/24hr?symbol=${coin}USDT`);
    if (w.coin !== coin) return;
    const vol = +t.quoteVolume;
    const suggest = THRESHOLD_TIERS.find(([v]) => vol >= v)[1];
    const volText = vol >= 1e9 ? (vol / 1e9).toFixed(2) + ' tỷ' : (vol / 1e6).toFixed(1) + ' triệu';
    box.innerHTML = `💡 Gợi ý cho ${esc(coin)}: <b>${fmtUsd(suggest).replace('.00', '')}</b>
      <small>(khối lượng 24h $${volText})</small>
      ${suggest !== w.min ? `<button data-apply="${suggest}">Áp dụng</button>` : '<span class="up">✓ đang dùng</span>'}`;
  } catch {}
}

$('#wSuggest').addEventListener('click', (e) => {
  if (!e.target.dataset.apply) return;
  $('#wMin').value = e.target.dataset.apply;
  startWhale(w.coin);
});

function refreshWhale() {
  const coin = w.coin;
  loadFlow(coin);
  loadWalls(coin);
  loadLongShort(coin);
  loadFunding(coin);
  loadUnlock(coin);
  loadOnchain(coin);
  scoreBigTrades();
  if (typeof refreshMarket === 'function') refreshMarket(coin);
}

// ---------- 0. Tổng hợp tín hiệu ----------
const SIGNALS = [
  ['big', 'Lệnh lớn'], ['flow', 'Dòng tiền 1h/4h/24h'], ['ls', 'Top trader futures'],
  ['walls', 'Tường lệnh gần giá'], ['price', 'Giá so với dòng tiền'], ['funding', 'Funding & OI'],
  ['onchain', 'Nạp/rút sàn on-chain'], ['unlock', 'Unlock 7 ngày tới'],
];

function setSignal(key, score, text) {
  w.sig[key] = { score, text };
  renderScore();
}

function renderScore() {
  const done = SIGNALS.filter(([k]) => w.sig[k] && !w.sig[k].pending && !w.sig[k].na);
  const total = done.reduce((s, [k]) => s + w.sig[k].score, 0);
  const verdict = done.length < 3 ? ['Đang thu thập dữ liệu…', 'muted']
    : total >= 3 ? ['🐋 Cá voi có dấu hiệu GOM', 'up']
    : total === 2 ? ['Nghiêng về gom', 'up']
    : total <= -3 ? ['🚨 Cá voi có dấu hiệu XẢ', 'down']
    : total === -2 ? ['Nghiêng về xả', 'down']
    : ['Chưa rõ xu hướng, tín hiệu trái chiều', 'muted'];
  const icon = (sg) => !sg ? '…' : sg.na ? '➖' : sg.pending ? '⏳' : sg.score > 0 ? '🟢' : sg.score < 0 ? '🔴' : '⚪';
  const rows = SIGNALS.map(([k, name]) => {
    const sg = w.sig[k];
    const pts = sg && !sg.pending && !sg.na ? `<b class="${cls(sg.score)}">${sg.score > 0 ? '+1' : sg.score < 0 ? '−1' : '0'}</b>` : '<span></span>';
    return `<div class="sig"><span>${icon(sg)}</span><b>${name}</b><span class="muted">${sg ? sg.text : 'Đang tải…'}</span>${pts}</div>`;
  }).join('');
  $('#wScore').innerHTML = `
    <div class="scorehead">
      <span class="scorenum ${cls(total)}">${total > 0 ? '+' : ''}${total}<small class="muted">/${done.length}</small></span>
      <span class="verdict ${verdict[1]}">${verdict[0]}</span>
    </div>
    ${rows}
    <p class="hint">Mỗi tiêu chí +1 (ủng hộ gom), −1 (ủng hộ xả) hoặc 0; ➖ là không áp dụng cho coin này. Từ +3 trở lên là gom rõ, từ −3 trở xuống là xả rõ.
      Đây là suy luận từ dữ liệu sàn Binance, không biết chắc ai đặt lệnh.</p>`;
}

// Lệnh lớn: chỉ chấm khi đã theo dõi đủ lâu, tránh kết luận từ vài lệnh trong 1 phút.
function scoreBigTrades() {
  if (!w.coin) return;
  const b = w.big, n = b.nBuy + b.nSell;
  const minutes = (Date.now() - Math.min(b.started, b.since || b.started)) / 60000;
  if (minutes < BIG_MIN_MINUTES || n < 3) {
    const minText = fmtUsd(w.min).replace('.00', '');
    w.sig.big = { pending: true, text: minutes < BIG_MIN_MINUTES
      ? `Đang theo dõi ${Math.floor(minutes)}/${BIG_MIN_MINUTES} phút, ${n} lệnh ≥ ${minText}. Cần ít nhất ${BIG_MIN_MINUTES} phút và 3 lệnh.`
      : `Mới có ${n} lệnh ≥ ${minText} trong ${Math.floor(minutes)} phút qua, cần ít nhất 3 lệnh. Thử giảm ngưỡng theo gợi ý.` };
    return renderScore();
  }
  const pct = b.buy / (b.buy + b.sell) * 100;
  const text = `${Math.floor(minutes)} phút qua: mua ${pct.toFixed(0)}% / bán ${(100 - pct).toFixed(0)}% (${n} lệnh).`;
  setSignal('big', pct >= 60 ? 1 : pct <= 40 ? -1 : 0, text + (pct >= 60 ? ' Lệnh lớn mua áp đảo.' : pct <= 40 ? ' Lệnh lớn bán áp đảo.' : ' Hai bên ngang nhau.'));
}

// ---------- 1. Lệnh lớn realtime ----------
function connectStream() {
  if (w.ws) { w.ws.onclose = null; w.ws.close(); }
  const coin = w.coin;
  const ws = new WebSocket(WS_URL + coin.toLowerCase() + 'usdt@aggTrade');
  w.ws = ws;
  $('#wLive').textContent = 'Đang kết nối…';
  ws.onopen = () => { $('#wLive').innerHTML = '<span class="up">● Live</span>'; };
  ws.onmessage = (e) => {
    const t = JSON.parse(e.data);
    onTrade({ price: +t.p, qty: +t.q, time: t.T, sell: t.m }, true);
  };
  ws.onclose = () => {
    $('#wLive').innerHTML = '<span class="down">● Mất kết nối, đang thử lại…</span>';
    setTimeout(() => { if (w.coin === coin && w.ws === ws) connectStream(); }, 3000);
  };
}

async function backfillBigTrades() {
  const coin = w.coin;
  try {
    const list = await getJson(`${SPOT_API}/aggTrades?symbol=${coin}USDT&limit=1000`);
    if (w.coin !== coin) return;
    for (const t of list) onTrade({ price: +t.p, qty: +t.q, time: t.T, sell: t.m }, false);
  } catch {}
  renderBigStats();
  scoreBigTrades();
}

// m = true nghĩa là người mua là maker, tức lệnh khớp do bên BÁN chủ động.
function onTrade(t, live) {
  const value = t.price * t.qty;
  if (w.big.since == null || t.time < w.big.since) w.big.since = t.time;
  if (value < w.min) return;
  if (t.sell) { w.big.sell += value; w.big.nSell++; } else { w.big.buy += value; w.big.nBuy++; }

  const tb = $(t.sell ? '#wFeedSell tbody' : '#wFeedBuy tbody');
  const tr = document.createElement('tr');
  if (live) tr.className = 'new';
  const icon = value >= w.min * 5 ? '🐋' : '🦈';
  tr.innerHTML = `
    <td>${new Date(t.time).toLocaleTimeString('vi-VN')} ${icon}</td>
    <td>${fmtPrice(t.price)}</td>
    <td class="${t.sell ? 'down' : 'up'}"><b>${fmtUsd(value)}</b></td>`;
  tb.prepend(tr);
  while (tb.rows.length > FEED_MAX) tb.lastElementChild.remove();
  if (live) { renderBigStats(); scoreBigTrades(); }
}

function renderBigStats() {
  const b = w.big;
  const total = b.buy + b.sell;
  const since = b.since ? new Date(b.since).toLocaleTimeString('vi-VN') : '—';
  $('#wBuyTotal').innerHTML = `${fmtUsd(b.buy)} <small class="muted">· ${b.nBuy} lệnh</small>`;
  $('#wSellTotal').innerHTML = `${fmtUsd(b.sell)} <small class="muted">· ${b.nSell} lệnh</small>`;
  if (!total) {
    $('#wBigStats').innerHTML = `<p class="hint">Chưa có lệnh ≥ ${fmtUsd(w.min)} kể từ ${since}. Thử giảm ngưỡng.</p>`;
    return;
  }
  const net = b.buy - b.sell;
  $('#wBigStats').innerHTML = `
    ${bigRow('Tổng', b.buy, b.sell, (Date.now() - Math.min(b.started, b.since || b.started)) / 60000)}
    <p class="hint">Từ ${since} · tổng ${fmtUsd(total)} (${b.nBuy + b.nSell} lệnh) ·
      ròng <b class="${cls(net)}">${net >= 0 ? '+' : ''}${fmtUsd(net)}</b> ${net >= 0 ? '(mua nhiều hơn)' : '(bán nhiều hơn)'}</p>`;
}

// Thanh tổng của lệnh lớn: số lệnh ít nên dễ lệch. Chỉ ghi "mạnh" khi từ 65% trở lên và đã theo dõi đủ 30 phút.
const BIG_STRONG_MINUTES = 30;
function bigRow(label, buy, sell, minutes) {
  const total = buy + sell;
  const pct = total ? buy / total * 100 : 50;
  const verdict = minutes < BIG_STRONG_MINUTES ? [`Mới ${Math.floor(minutes)}/${BIG_STRONG_MINUTES} phút ·`, 'muted']
    : pct >= 65 ? ['Gom mạnh', 'up'] : pct >= 55 ? ['Nghiêng gom', 'up']
    : pct <= 35 ? ['Xả mạnh', 'down'] : pct <= 45 ? ['Nghiêng xả', 'down'] : ['Cân bằng', 'muted'];
  const side = pct >= 50 ? 'mua' : 'bán';
  return `<div class="flow">
    <span>${label}</span>
    <div class="bar" title="Mua ${pct.toFixed(1)}% / Bán ${(100 - pct).toFixed(1)}%"><span style="width:${pct}%"></span></div>
    <span class="verdict ${verdict[1]}">${verdict[0]} ${side} ${Math.max(pct, 100 - pct).toFixed(0)}%</span>
  </div>`;
}

// ---------- 2. Gom hay xả (taker buy/sell volume) ----------
function flowRow(label, buy, sell) {
  const total = buy + sell;
  const pct = total ? buy / total * 100 : 50;
  const verdict = pct >= 55 ? ['Gom mạnh', 'up'] : pct >= 51 ? ['Nghiêng gom', 'up']
    : pct <= 45 ? ['Xả mạnh', 'down'] : pct <= 49 ? ['Nghiêng xả', 'down'] : ['Cân bằng', 'muted'];
  return `<div class="flow">
    <span>${label}</span>
    <div class="bar" title="Mua ${pct.toFixed(1)}% / Bán ${(100 - pct).toFixed(1)}%"><span style="width:${pct}%"></span></div>
    <span class="verdict ${verdict[1]}">${verdict[0]} ${Math.max(pct, 100 - pct).toFixed(0)}%</span>
  </div>`;
}

async function loadFlow(coin) {
  try {
    // 288 nến 5 phút = 24 giờ. [7] = tổng quote volume, [10] = quote volume do bên mua chủ động.
    const k = await getJson(`${SPOT_API}/klines?symbol=${coin}USDT&interval=5m&limit=288`);
    if (w.coin !== coin) return;
    const sum = (n) => k.slice(-n).reduce((a, c) => {
      a.buy += +c[10]; a.sell += +c[7] - +c[10]; return a;
    }, { buy: 0, sell: 0 });
    const rows = [['1 giờ', 12], ['4 giờ', 48], ['24 giờ', 288]].map(([l, n]) => {
      const s = sum(n);
      return flowRow(l, s.buy, s.sell);
    });
    const d = sum(288);
    scoreFlowAndPrice(k, [12, 48, 288].map((n) => sum(n)));
    $('#wFlow').innerHTML = rows.join('') +
      `<p class="hint">24h: mua chủ động <b class="up">${fmtUsd(d.buy)}</b> · bán chủ động <b class="down">${fmtUsd(d.sell)}</b> · ròng <b class="${cls(d.buy - d.sell)}">${fmtUsd(d.buy - d.sell)}</b></p>`;
  } catch {
    $('#wFlow').innerHTML = '<span class="down small">Không tải được dữ liệu.</span>';
  }
}

function scoreFlowAndPrice(k, windows) {
  const pcts = windows.map((s) => s.buy / (s.buy + s.sell || 1) * 100);
  const vote = pcts.reduce((v, p) => v + (p > 51 ? 1 : p < 49 ? -1 : 0), 0);
  const list = pcts.map((p) => p.toFixed(0) + '%').join(' / ');
  setSignal('flow', vote >= 2 ? 1 : vote <= -2 ? -1 : 0,
    `Tỷ lệ mua chủ động ${list}. ` + (vote >= 2 ? 'Phe mua mạnh hơn ở đa số khung.' : vote <= -2 ? 'Phe bán mạnh hơn ở đa số khung.' : 'Các khung trái chiều.'));

  // So giá 24h với dòng tiền: bán ròng mà giá không giảm = có người đỡ giá bằng lệnh chờ (gom âm thầm).
  const change = (+k[k.length - 1][4] - +k[0][1]) / +k[0][1] * 100;
  const net = windows[2].buy - windows[2].sell;
  let score, text = `Giá 24h ${fmtPct(change)}, dòng tiền ròng ${net >= 0 ? '+' : ''}${fmtUsd(net)}. `;
  if (net < 0 && change > -0.5) { score = 1; text += 'Bị bán ròng mà giá không giảm: có người âm thầm đỡ giá.'; }
  else if (net > 0 && change < 0.5) { score = -1; text += 'Mua ròng mà giá không tăng: có người xả vào lệnh chờ.'; }
  else if (Math.abs(change) < 1.5) { score = 0; text += 'Giá đi ngang.'; }
  else { score = change > 0 ? 1 : -1; text += change > 0 ? 'Giá tăng cùng dòng tiền mua.' : 'Giá giảm cùng dòng tiền bán.'; }
  setSignal('price', score, text);
}

// ---------- 3. Tường lệnh ----------
async function loadWalls(coin) {
  try {
    const book = await getJson(`${SPOT_API}/depth?symbol=${coin}USDT&limit=5000`);
    if (w.coin !== coin) return;
    const mid = (+book.bids[0][0] + +book.asks[0][0]) / 2;
    // Bước gom cụm cố định cho mỗi coin (để theo dõi được một bức tường qua nhiều lần tải).
    const now = Date.now();
    if (w.wallCoin !== coin || now - (w.wallAt || 0) > 2 * 60000) { w.wallCoin = coin; w.wallSeen = new Map(); w.wallStep = mid * 0.0025; }
    w.wallAt = now;
    const step = w.wallStep; // gom các mức giá gần nhau thành cụm 0.25%
    const group = (levels, lo, hi) => {
      const m = new Map();
      for (const [p, q] of levels) {
        const price = +p;
        if (price < lo || price > hi) continue;
        const key = Math.round(price / step);
        m.set(key, (m.get(key) || 0) + price * +q);
      }
      return [...m].map(([key, value]) => ({ key, price: key * step, value }))
        .sort((a, b) => b.value - a.value).slice(0, 6);
    };
    const bids = group(book.bids, mid * 0.9, mid);
    const asks = group(book.asks, mid, mid * 1.1);
    // Theo dõi tuổi của từng bức tường: tường đứng yên ≥5 phút khó là lệnh giả hơn tường vừa xuất hiện.
    const seen = new Map();
    for (const [sideKey, list] of [['b', bids], ['a', asks]]) {
      for (const x of list) {
        const k = sideKey + x.key;
        x.age = now - (w.wallSeen.get(k) ?? now);
        seen.set(k, w.wallSeen.get(k) ?? now);
      }
    }
    w.wallSeen = seen;
    const tracked = now - Math.min(now, ...seen.values());
    const tag = (x) => x.age >= 5 * 60000 ? `<small class="walltag real" title="Đã đứng yên ${Math.floor(x.age / 60000)} phút">🧱 tường thật</small>`
      : tracked >= 2 * 60000 && x.age < 60000 ? '<small class="walltag new" title="Vừa xuất hiện, có thể bị rút">mới</small>' : '';
    const max = Math.max(...bids.map((x) => x.value), ...asks.map((x) => x.value), 1);
    const side = (list, color) => list.map((x) => `
      <span class="muted">${fmtPrice(x.price)} <small>(${fmtPct((x.price - mid) / mid * 100)})</small> ${tag(x)}</span>
      <span class="lvl"><i style="width:${x.value / max * 100}%;background:var(${color})"></i>${fmtUsd(x.value)}</span>`).join('');
    const loP = +book.bids[book.bids.length - 1][0], hiP = +book.asks[book.asks.length - 1][0];
    const cover = `Sổ lệnh Binance trả về ${book.bids.length.toLocaleString('en-US')} mức mỗi bên, phủ từ <b>${fmtPrice(loP)}</b> (${fmtPct((loP - mid) / mid * 100)})
      đến <b>${fmtPrice(hiP)}</b> (${fmtPct((hiP - mid) / mid * 100)}). Tường nằm ngoài khoảng này không thấy được.`;
    const bidSum = bids.reduce((s, x) => s + x.value, 0), askSum = asks.reduce((s, x) => s + x.value, 0);
    // Chấm điểm theo lệnh chờ trong ±2% quanh giá (gần giá thì khó đặt lệnh giả hơn).
    const near = (levels, lo, hi) => levels.reduce((s, [p, q]) => (+p >= lo && +p <= hi ? s + +p * +q : s), 0);
    const nb = near(book.bids, mid * 0.98, mid), na = near(book.asks, mid, mid * 1.02);
    const r = nb / (na || 1);
    setSignal('walls', r >= 1.3 ? 1 : r <= 1 / 1.3 ? -1 : 0,
      `Trong ±2%: chờ mua ${fmtUsd(nb)} / chờ bán ${fmtUsd(na)}. ` +
      (r >= 1.3 ? 'Phe mua đỡ giá dày hơn.' : r <= 1 / 1.3 ? 'Phe bán chặn giá dày hơn.' : 'Hai bên cân bằng.'));
    $('#wWalls').innerHTML = `
      <p class="hint">Giá hiện tại <b>${fmtPrice(mid)}</b></p>
      <div class="walls">
        <div><h3 class="up small">Tường MUA (hỗ trợ)</h3><div class="wall">${side(bids, '--up')}</div></div>
        <div><h3 class="down small">Tường BÁN (kháng cự)</h3><div class="wall">${side(asks, '--down')}</div></div>
      </div>
      <p class="hint">${bidSum > askSum * 1.2 ? 'Phe mua đặt lệnh chờ dày hơn.' : askSum > bidSum * 1.2 ? 'Phe bán đặt lệnh chờ dày hơn.' : 'Lệnh chờ hai bên khá cân bằng.'}
        Tường lệnh có thể bị rút bất cứ lúc nào.</p>
      <p class="hint">${cover} 🧱 = tường đã đứng yên từ 5 phút trở lên (khó là lệnh giả hơn); "mới" = vừa xuất hiện dưới 1 phút, dễ bị rút. Web cần mở tab này vài phút để theo dõi tuổi tường.</p>`;
    $('#wBookTime').textContent = new Date().toLocaleTimeString('vi-VN');
  } catch {
    $('#wWalls').innerHTML = '<span class="down small">Không tải được sổ lệnh.</span>';
  }
}

// ---------- 4. Long/Short top trader ----------
function sparkline(values) {
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1) * 100).toFixed(2)},${(55 - (v - min) / span * 50).toFixed(2)}`);
  return `<svg class="spark" viewBox="0 0 100 60" preserveAspectRatio="none">
    <polyline points="${pts.join(' ')}" fill="none" stroke="var(--accent)" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
}

async function loadLongShort(coin) {
  const q = `symbol=${coin}USDT&period=1h&limit=24`;
  try {
    const [top, all] = await Promise.all([
      getJson(`${FUT_API}/topLongShortPositionRatio?${q}`),
      getJson(`${FUT_API}/globalLongShortAccountRatio?${q}`).catch(() => []),
    ]);
    if (w.coin !== coin) return;
    if (!top.length) throw new Error('empty');
    const last = top[top.length - 1], first = top[0];
    const long = +last.longAccount * 100;
    const ratio = +last.longShortRatio, prev = +first.longShortRatio;
    const crowd = all.length ? +all[all.length - 1].longAccount * 100 : null;
    let note = ratio > 1.2 ? 'Top trader đang nghiêng mạnh về LONG.' : ratio < 0.8 ? 'Top trader đang nghiêng mạnh về SHORT.' : 'Top trader khá cân bằng.';
    if (crowd != null && Math.abs(long - crowd) >= 8) {
      note += long > crowd ? ' Cá voi long nhiều hơn đám đông, thường là tín hiệu tích cực.'
        : ' Đám đông long nhiều hơn cá voi, cần cẩn thận.';
    }
    // Chấm điểm: xu hướng tỷ lệ L/S top trader 24h + so với đám đông.
    const chg = (ratio - prev) / prev * 100;
    let v = chg >= 3 ? 1 : chg <= -3 ? -1 : 0;
    if (crowd != null) v += long - crowd >= 8 ? 1 : crowd - long >= 8 ? -1 : 0;
    setSignal('ls', Math.max(-1, Math.min(1, v)),
      `Top trader long ${long.toFixed(0)}%${crowd != null ? `, đám đông ${crowd.toFixed(0)}%` : ''}, tỷ lệ L/S ${fmtPct(chg)} trong 24h. ` +
      (v > 0 ? 'Cá voi đang tăng long.' : v < 0 ? 'Cá voi giảm long hoặc đám đông hưng phấn hơn.' : 'Không nghiêng rõ.'));
    $('#wLs').innerHTML = `
      <div class="flow"><span>Top</span>
        <div class="bar"><span style="width:${long}%"></span></div>
        <span class="verdict"><span class="up">${long.toFixed(1)}%</span> / <span class="down">${(100 - long).toFixed(1)}%</span></span></div>
      ${crowd != null ? `<div class="flow"><span>Tất cả</span>
        <div class="bar"><span style="width:${crowd}%"></span></div>
        <span class="verdict"><span class="up">${crowd.toFixed(1)}%</span> / <span class="down">${(100 - crowd).toFixed(1)}%</span></span></div>` : ''}
      <p class="hint">Tỷ lệ L/S top trader (theo vị thế): <b>${ratio.toFixed(2)}</b>
        <span class="${cls(ratio - prev)}">(${fmtPct((ratio - prev) / prev * 100)} so với 24h trước)</span></p>
      ${sparkline(top.map((x) => +x.longShortRatio))}
      <p class="hint">${note}</p>`;
  } catch {
    if (w.coin === coin) setSignal('ls', 0, 'Coin này không có futures trên Binance, tính 0 điểm.');
    $('#wLs').innerHTML = `<span class="muted small">${esc(coin)} chưa có hợp đồng futures USDT trên Binance.</span>`;
  }
}

// ---------- 5. Funding & Open Interest (futures) ----------
const FAPI = 'https://fapi.binance.com/fapi/v1';

async function loadFunding(coin) {
  const sym = coin + 'USDT';
  try {
    const [pi, hist, oi] = await Promise.all([
      getJson(`${FAPI}/premiumIndex?symbol=${sym}`),
      getJson(`${FAPI}/fundingRate?symbol=${sym}&limit=60`),
      getJson(`${FUT_API}/openInterestHist?symbol=${sym}&period=1h&limit=25`),
    ]);
    if (w.coin !== coin) return;
    if (!hist.length || !oi.length) throw new Error('empty');
    // Có coin trả phí mỗi 4h hoặc 1h; quy về mức tương đương 8h để so sánh.
    const interval = hist.length > 1 ? Math.round((hist[hist.length - 1].fundingTime - hist[hist.length - 2].fundingTime) / 36e5) || 8 : 8;
    const rate = +pi.lastFundingRate * 100;
    const rate8 = rate * 8 / interval;
    const week = hist.filter((h) => h.fundingTime > Date.now() - 7 * 864e5);
    const avg8 = week.reduce((a, h) => a + +h.fundingRate, 0) / (week.length || 1) * 100 * 8 / interval;
    const apr = rate * 24 / interval * 365;
    const oiNow = +oi[oi.length - 1].sumOpenInterestValue, oiPrev = +oi[0].sumOpenInterestValue;
    const oiChg = (oiNow - oiPrev) / oiPrev * 100;
    const mins = Math.max(0, Math.round((pi.nextFundingTime - Date.now()) / 60000));

    let score = 0, note;
    if (rate8 >= 0.05) { score = -1; note = 'Funding rất cao: phe long trả phí lớn, đòn bẩy long quá đà, dễ bị đạp giá để thanh lý long.'; }
    else if (rate8 <= -0.03) { score = 1; note = 'Funding âm sâu: phe short đông và phải trả phí, dễ xảy ra short squeeze (giá bật mạnh).'; }
    else if (oiChg >= 10 && rate8 > 0.02) { score = -1; note = 'Open Interest tăng nhanh cùng funding dương: đòn bẩy long đang dồn vào, rủi ro điều chỉnh.'; }
    else if (oiChg >= 10 && rate8 < 0) { score = 1; note = 'Open Interest tăng nhanh mà funding âm: short đang dồn vào, dễ bị ép ngược.'; }
    else note = 'Funding ở mức bình thường (mặc định của sàn là 0.01%/8h), chưa có dấu hiệu quá đà.';
    setSignal('funding', score, `Funding ${rate.toFixed(4)}%/${interval}h, OI ${fmtPct(oiChg)} trong 24h. ${note.split(':')[0]}.`);

    $('#wFunding').innerHTML = `
      <div class="kv">
        <span>Funding hiện tại</span><b class="${cls(rate)}">${rate.toFixed(4)}% <small class="muted">/ ${interval}h</small></b>
        <span>Quy ra năm</span><b class="${cls(apr)}">${apr.toFixed(1)}%</b>
        <span>Trung bình 7 ngày</span><b class="${cls(avg8)}">${avg8.toFixed(4)}% <small class="muted">/ 8h</small></b>
        <span>Kỳ trả phí tiếp theo</span><b>${Math.floor(mins / 60)}h ${mins % 60}m</b>
        <span>Open Interest</span><b>${fmtUsd(oiNow).replace(/\.\d+$/, '')} <small class="${cls(oiChg)}">${fmtPct(oiChg)} 24h</small></b>
      </div>
      ${sparkline(oi.map((x) => +x.sumOpenInterestValue))}
      <p class="hint">${note}</p>
      <p class="muted small">Funding dương: long trả phí cho short (đám đông nghiêng long). Funding âm: ngược lại.
        Open Interest là tổng giá trị hợp đồng đang mở.</p>`;
  } catch {
    if (w.coin !== coin) return;
    w.sig.funding = { na: true, text: 'Coin này không có futures trên Binance.' };
    renderScore();
    $('#wFunding').innerHTML = `<span class="muted small">${esc(coin)} chưa có hợp đồng futures USDT trên Binance.</span>`;
  }
}

// ---------- 6, 7. Dữ liệu do GitHub Actions tạo mỗi giờ (thư mục data/) ----------
const dataCache = {};
async function loadData(name) {
  const c = dataCache[name];
  if (c && Date.now() - c.at < 10 * 60000) return c.data;
  const data = await getJson(`data/${name}?t=${Math.floor(Date.now() / 600000)}`);
  dataCache[name] = { at: Date.now(), data };
  return data;
}
const fmtBig = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : Math.round(n).toString();
const fmtUsdShort = (n) => n == null || !isFinite(n) ? '—' : (n < 0 ? '-$' : '$') + fmtBig(Math.abs(n));
const fmtDate = (sec) => new Date(sec * 1000).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtHm = (ms) => new Date(ms).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });

// ---------- 6. Lịch mở khóa token ----------
const CAT_VI = {
  insiders: 'Đội ngũ & cố vấn', privateSale: 'Nhà đầu tư quỹ', publicSale: 'Bán công khai', airdrop: 'Airdrop',
  farming: 'Phần thưởng', noncirculating: 'Quỹ dự trữ', ecosystem: 'Hệ sinh thái', liquidity: 'Thanh khoản',
};
const BIG_UNLOCK_PCT = 1; // từ 1% lượng lưu hành trở lên là đợt lớn

async function loadUnlock(coin) {
  let data;
  try { data = await loadData('unlocks.json'); } catch {
    if (w.coin !== coin) return;
    w.sig.unlock = { na: true, text: 'Chưa tải được dữ liệu unlock.' };
    renderScore();
    $('#wUnlock').innerHTML = '<span class="muted small">Chưa có dữ liệu unlock (đang được tạo, thử lại sau ít phút).</span>';
    return;
  }
  if (w.coin !== coin) return;
  const now = Date.now() / 1000;
  const u = data.coins[coin];
  const price = prices[coin];
  const info = (e, c) => {
    const days = Math.ceil((e.t - now) / 86400);
    const pct = e.tokens / c.circ * 100;
    return { days, pct, val: price && c === u ? e.tokens * price : null };
  };

  let html;
  if (!u) {
    html = `<p class="hint">Không có lịch unlock đáng kể của ${esc(coin)} trong 180 ngày tới
      (đã mở khóa gần hết, hoặc DefiLlama chưa theo dõi coin này).</p>`;
    setSignal('unlock', 0, 'Không có lịch unlock sắp tới.');
  } else {
    const rows = u.events.map((e) => {
      const { days, pct, val } = info(e, u);
      const big = pct >= BIG_UNLOCK_PCT;
      return `<tr class="${big ? 'bigunlock' : ''}">
        <td>${fmtDate(e.t)}${big ? ' 🔥' : ''}<br><small class="muted">còn ${days} ngày</small></td>
        <td>${fmtBig(e.tokens)}<br><small class="${big ? 'down' : 'muted'}">${pct.toFixed(2)}%</small></td>
        <td>${fmtUsdShort(val)}</td>
        <td class="cats">${e.cats.map((c) => CAT_VI[c] || c).join(', ')}</td></tr>`;
    }).join('');
    const daily = u.perDay ? `<p class="hint">Ngoài ra mở khóa đều mỗi ngày khoảng <b>${fmtBig(u.perDay)} ${esc(coin)}</b>
      (${price ? '~' + fmtUsdShort(u.perDay * price) + '/ngày, ' : ''}${(u.perDay * 30 / u.circ * 100).toFixed(2)}% lưu hành mỗi tháng).</p>` : '';
    html = `
      <p class="hint">Đang lưu hành <b>${fmtBig(u.circ)}</b>${u.max ? ` / tối đa ${fmtBig(u.max)} (${(u.circ / u.max * 100).toFixed(0)}%)` : ''}</p>
      ${u.events.length ? `<div class="tablewrap"><table class="unlocks">
        <thead><tr><th>Ngày</th><th>Số lượng<br><small>% lưu hành</small></th><th>Giá trị</th><th>Nhóm nhận</th></tr></thead>
        <tbody>${rows}</tbody></table></div>` : '<p class="hint">Không có đợt mở khóa một lần nào sắp tới.</p>'}
      ${daily}`;
    const soon = u.events.find((e) => e.t - now < 7 * 86400 && info(e, u).pct >= 0.5);
    if (soon) {
      const { days, pct } = info(soon, u);
      setSignal('unlock', -1, `Còn ${days} ngày nữa mở khóa ${fmtBig(soon.tokens)} ${coin} (${pct.toFixed(2)}% lưu hành). Lượng cung mới có thể bị bán ra.`);
    } else setSignal('unlock', 0, 'Không có đợt unlock lớn trong 7 ngày tới.');
  }

  // Các coin khác đang giữ có unlock trong 30 ngày tới.
  const mine = holdingCoins().filter((c) => c !== coin && data.coins[c]).flatMap((c) =>
    data.coins[c].events.filter((e) => e.t - now < 30 * 86400).slice(0, 1).map((e) => ({ c, e, ...info(e, data.coins[c]) })));
  if (mine.length) {
    html += `<h3 class="small">Coin bạn đang giữ: unlock trong 30 ngày tới</h3>` + mine.sort((a, b) => a.e.t - b.e.t).map((m) =>
      `<div class="sig mini"><span>${m.pct >= BIG_UNLOCK_PCT ? '🔥' : '🔓'}</span><b>${esc(m.c)}</b>
        <span class="muted">${fmtDate(m.e.t)} · còn ${m.days} ngày · ${fmtBig(m.e.tokens)} (${m.pct.toFixed(2)}% lưu hành)</span><span></span></div>`).join('');
  }
  $('#wUnlock').innerHTML = html + `<p class="muted small">Nguồn DefiLlama · cập nhật ${fmtHm(data.updated)}. Nhóm "Đội ngũ" và "Nhà đầu tư quỹ" hay bán ra nhất.</p>`;
}

// ---------- 7. Nạp/rút sàn on-chain ----------
async function loadOnchain(coin) {
  let data;
  try { data = await loadData('onchain.json'); } catch {
    if (w.coin !== coin) return;
    w.sig.onchain = { na: true, text: 'Chưa tải được dữ liệu on-chain.' };
    renderScore();
    $('#wOnchain').innerHTML = '<span class="muted small">Chưa có dữ liệu on-chain (đang được tạo, thử lại sau ít phút).</span>';
    return;
  }
  if (w.coin !== coin) return;
  const list = Object.keys(data.coins).join(', ');
  const o = data.coins[coin];
  if (!o) {
    w.sig.onchain = { na: true, text: `Chưa hỗ trợ ${coin}. Hiện có: ${list}.` };
    renderScore();
    $('#wOnchain').innerHTML = `<p class="hint">Chưa hỗ trợ ${esc(coin)}. Hiện đang theo dõi: <b>${esc(list)}</b>
      (BTC, ETH theo số dư ví sàn; các token khác trên Ethereum, nơi ví sàn được gắn nhãn đầy đủ).</p>`;
    return;
  }
  const price = prices[coin];
  const val = (n) => `${fmtBig(n)} ${esc(coin)}${price ? ` <small class="muted">(${fmtUsdShort(n * price)})</small>` : ''}`;
  if (o.mode === 'balance') return renderReserve(coin, o, data, val);
  const net = o.out24 - o.in24;
  const total = o.out24 + o.in24;
  const share = total ? net / total : 0;
  setSignal('onchain', share >= 0.15 ? 1 : share <= -0.15 ? -1 : 0,
    `24h: rút ${fmtBig(o.out24)} / nạp ${fmtBig(o.in24)} ${coin}. ` +
    (share >= 0.15 ? 'Rút khỏi sàn nhiều hơn: dấu hiệu gom về ví.' : share <= -0.15 ? 'Nạp lên sàn nhiều hơn: có thể chuẩn bị bán.' : 'Nạp và rút gần cân bằng.'));

  const exRows = Object.entries(o.byEx).sort((a, b) => (b[1].in + b[1].out) - (a[1].in + a[1].out)).slice(0, 6).map(([ex, v]) =>
    `<tr><td>${esc(ex)}</td><td class="down">${fmtBig(v.in)}</td><td class="up">${fmtBig(v.out)}</td>
      <td class="${cls(v.out - v.in)}"><b>${v.out - v.in >= 0 ? '+' : '-'}${fmtBig(Math.abs(v.out - v.in))}</b></td></tr>`).join('');
  const topRows = o.top.slice(0, 8).map((t) =>
    `<tr><td>${fmtHm(t.t * 1000)}</td>
      <td class="${t.dir === 'in' ? 'down' : 'up'}">${t.dir === 'in' ? '⬆️ Nạp lên' : '⬇️ Rút khỏi'} ${esc(t.ex)}</td>
      <td><a href="${data.explorer}${t.tx}" target="_blank" rel="noopener">${val(t.amt)}</a></td></tr>`).join('');
  $('#wOnchain').innerHTML = `
    ${flowRow('4 giờ', o.out4, o.in4)}
    ${flowRow('24 giờ', o.out24, o.in24)}
    <p class="hint"><span class="up">■ Rút khỏi sàn</span> (thường là gom về ví) · <span class="down">■ Nạp lên sàn</span> (thường để bán)</p>
    <p class="hint">24h: rút <b class="up">${val(o.out24)}</b> (${o.nOut} lần) · nạp <b class="down">${val(o.in24)}</b> (${o.nIn} lần) ·
      ròng <b class="${cls(net)}">${net >= 0 ? '+' : '-'}${fmtBig(Math.abs(net))} ${esc(coin)}</b> ${net >= 0 ? '(rút nhiều hơn)' : '(nạp nhiều hơn)'}</p>
    <div class="grid2">
      <div><h3 class="small">Theo sàn (24h)</h3><div class="tablewrap"><table>
        <thead><tr><th>Sàn</th><th>Nạp</th><th>Rút</th><th>Ròng</th></tr></thead><tbody>${exRows}</tbody></table></div></div>
      <div><h3 class="small">Giao dịch lớn nhất</h3><div class="tablewrap"><table>
        <thead><tr><th>Giờ</th><th>Hướng</th><th>Số lượng</th></tr></thead><tbody>${topRows}</tbody></table></div></div>
    </div>
    <p class="muted small">Nguồn Blockscout (${esc(o.chain)}) · ${o.hours < 24 ? `phủ ${o.hours} giờ gần nhất · ` : ''}cập nhật ${fmtHm(data.updated)}, mỗi giờ một lần.
      Chỉ tính chuyển khoản giữa ví sàn đã gắn nhãn và ví ngoài; bấm số lượng để xem giao dịch trên Etherscan.</p>`;
}

// Đặt cuối file để mọi hằng số phía trên đã được khai báo.
// Mở thẳng tab cá voi bằng link .../#whale hoặc .../#whale=ARB (mở luôn coin ARB)
const hashCoin = location.hash.match(/^#whale(?:=(\w+))?$/);
if (hashCoin) {
  if (hashCoin[1]) { w.started = true; startWhale(hashCoin[1]); }
  document.querySelector('.tab[data-tab="whale"]').click();
}

// BTC, ETH: dự trữ trên các ví sàn lớn (so số dư bây giờ với 4h/24h trước).
function renderReserve(coin, o, data, val) {
  const rows = Object.entries(o.byEx).sort((a, b) => b[1].reserve - a[1].reserve).slice(0, 10).map(([ex, v]) => {
    const d = v.in - v.out;
    return `<tr><td>${esc(ex)}</td><td>${fmtBig(v.reserve)}</td>
      <td class="${cls(-d)}">${d ? `<b>${d > 0 ? '+' : '-'}${fmtBig(Math.abs(d))}</b>` : '<span class="muted">0</span>'}</td></tr>`;
  }).join('');
  const note = `Nguồn: số dư ${o.wallets} ví sàn lớn đã công khai (${esc(o.chain)}) · cập nhật ${fmtHm(data.updated)}, mỗi giờ một lần.
    Chuyển giữa ví sàn được theo dõi và ví sàn khác chưa theo dõi cũng bị tính là nạp/rút.`;
  const table = `<h3 class="small">Dự trữ theo sàn</h3><div class="tablewrap"><table>
    <thead><tr><th>Sàn</th><th>Đang giữ</th><th>Thay đổi${o.hours >= 1 ? ` ${Math.round(o.hours)}h` : ''}</th></tr></thead><tbody>${rows}</tbody></table></div>`;

  if (o.hours < 1) { // BTC: mới có bản chụp đầu tiên
    w.sig.onchain = { pending: true, text: `Đang tích lũy dữ liệu số dư ${coin} mỗi giờ, cần vài giờ để so sánh.` };
    renderScore();
    $('#wOnchain').innerHTML = `<p class="hint">Tổng dự trữ trên các sàn theo dõi: <b>${val(o.reserve)}</b></p>
      <p class="hint">⏳ Website chụp lại số dư ví sàn mỗi giờ. Sau vài giờ sẽ có số nạp/rút, đủ 24h sẽ có số 24h.</p>${table}<p class="muted small">${note}</p>`;
    return;
  }
  const net = o.out24 - o.in24; // dương = rút ròng khỏi sàn
  const share = o.reserve ? net / o.reserve * 100 : 0; // % dự trữ
  setSignal('onchain', share >= 0.1 ? 1 : share <= -0.1 ? -1 : 0,
    `${Math.round(o.hours)}h: dự trữ sàn ${net >= 0 ? 'giảm' : 'tăng'} ${fmtBig(Math.abs(net))} ${coin} (${Math.abs(share).toFixed(2)}%). ` +
    (share >= 0.1 ? 'Coin rút khỏi sàn: dấu hiệu gom.' : share <= -0.1 ? 'Coin nạp lên sàn: có thể chuẩn bị bán.' : 'Thay đổi nhỏ.'));
  const topRows = o.top.slice(0, 8).map((t) =>
    `<tr><td>${esc(t.ex)}</td><td class="${t.dir === 'in' ? 'down' : 'up'}">${t.dir === 'in' ? '⬆️ Tăng' : '⬇️ Giảm'}</td>
      <td><a href="${o.explorer}${t.addr}" target="_blank" rel="noopener">${val(t.amt)}</a></td></tr>`).join('');
  $('#wOnchain').innerHTML = `
    ${o.hours >= 3.5 && o.in4 + o.out4 ? flowRow('4 giờ', o.out4, o.in4) : ''}
    ${flowRow(o.hours >= 23 ? '24 giờ' : Math.round(o.hours) + ' giờ', o.out24, o.in24)}
    <p class="hint"><span class="up">■ Rút khỏi sàn</span> (thường là gom về ví) · <span class="down">■ Nạp lên sàn</span> (thường để bán)</p>
    <p class="hint">Tổng dự trữ trên các sàn theo dõi: <b>${val(o.reserve)}</b> ·
      ${Math.round(o.hours)}h qua <b class="${cls(net)}">${net >= 0 ? 'giảm' : 'tăng'} ${fmtBig(Math.abs(net))} ${esc(coin)}</b>
      ${net >= 0 ? '(rút ra nhiều hơn)' : '(nạp vào nhiều hơn)'}</p>
    <div class="grid2">
      <div>${table}</div>
      <div><h3 class="small">Ví thay đổi số dư nhiều nhất</h3><div class="tablewrap"><table>
        <thead><tr><th>Sàn</th><th>Số dư</th><th>Lượng</th></tr></thead><tbody>${topRows}</tbody></table></div></div>
    </div>
    <p class="muted small">${note} Bấm số lượng để xem ví.</p>`;
}
