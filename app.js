'use strict';

const STORE_KEY = 'dca-tracker-v1';
const PRICE_API = 'https://data-api.binance.vision/api/v3/ticker/price';
const REFRESH_MS = 30000;
const COLORS = ['#f0b90b', '#0ecb81', '#3b82f6', '#a855f7', '#f6465d', '#14b8a6', '#f97316', '#ec4899', '#84cc16', '#64748b'];

let txs = load();
let prices = {};      // { SOL: 123.4 }
let allSymbols = [];  // các coin có cặp USDT trên Binance
let editingId = null;
let historyCoin = null;

const $ = (s) => document.querySelector(s);

// ---------- Lưu trữ ----------
function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch { return []; }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(txs)); } catch {}
}

// ---------- Định dạng số ----------
function fmtPrice(n) {
  if (n == null || !isFinite(n)) return '—';
  const a = Math.abs(n);
  const d = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 6 : 8;
  return n.toLocaleString('en-US', { maximumFractionDigits: d });
}
const fmtUsd = (n) => (n == null || !isFinite(n)) ? '—' : (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtQty = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 8 });
const fmtPct = (n) => (n == null || !isFinite(n)) ? '—' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
const cls = (n) => n > 0 ? 'up' : n < 0 ? 'down' : '';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Tính DCA (phương pháp giá vốn bình quân) ----------
// Mua: cộng vốn và số lượng. Bán: giảm số lượng, giảm vốn theo giá DCA hiện tại,
// lãi đã chốt = tiền bán - số lượng bán * giá DCA. Giá DCA không đổi khi bán.
function sorted(list) {
  return [...list].sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.created - b.created);
}
function computeHoldings() {
  const map = {};
  for (const t of sorted(txs)) {
    const h = map[t.coin] ||= { coin: t.coin, qty: 0, cost: 0, realized: 0, invested: 0 };
    if (t.side === 'buy') {
      h.qty += t.qty;
      h.cost += t.qty * t.price;
      h.invested += t.qty * t.price;
    } else {
      const avg = h.qty > 0 ? h.cost / h.qty : 0;
      const q = Math.min(t.qty, h.qty);
      h.realized += q * (t.price - avg);
      h.cost -= q * avg;
      h.qty -= q;
    }
    if (h.qty < 1e-12) { h.qty = 0; h.cost = 0; }
  }
  return Object.values(map).map((h) => {
    const price = prices[h.coin];
    const avg = h.qty > 0 ? h.cost / h.qty : null;
    const value = price != null ? h.qty * price : null;
    const pnl = value != null ? value - h.cost : null;
    return { ...h, avg, price, value, pnl, pnlPct: pnl != null && h.cost > 0 ? pnl / h.cost * 100 : null };
  }).sort((a, b) => (b.value ?? b.cost) - (a.value ?? a.cost));
}

// ---------- Giá ----------
async function fetchPrices() {
  $('#priceStatus').textContent = 'Đang cập nhật…';
  try {
    const res = await fetch(PRICE_API);
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    const next = {};
    for (const { symbol, price } of data) {
      if (symbol.endsWith('USDT')) next[symbol.slice(0, -4)] = +price;
    }
    next.USDT = 1;
    prices = next;
    if (!allSymbols.length) {
      allSymbols = Object.keys(next).sort();
      $('#coinList').innerHTML = allSymbols.map((s) => `<option value="${s}">`).join('');
    }
    $('#priceStatus').textContent = 'Giá lúc ' + new Date().toLocaleTimeString('vi-VN');
  } catch {
    $('#priceStatus').textContent = '⚠ Không tải được giá';
  }
  render();
}

// ---------- Render ----------
function render() {
  const hs = computeHoldings();
  renderSummary(hs);
  renderPortfolio(hs);
  renderHistory();
  renderPie(hs);
  renderSimOptions(hs);
  renderSim();
  if (typeof renderDcaZones === 'function') renderDcaZones(hs); // market.js
  if (typeof renderOverview === 'function') { renderOverview(); ovLoad24h(); } // overview.js
  if (typeof renderBig === 'function') renderBig(); // bigplayers.js
}

function renderSummary(hs) {
  const cost = hs.reduce((s, h) => s + h.cost, 0);
  const value = hs.reduce((s, h) => s + (h.value ?? h.cost), 0);
  const realized = hs.reduce((s, h) => s + h.realized, 0);
  const pnl = value - cost;
  const items = [
    ['Vốn đang nắm giữ', fmtUsd(cost), ''],
    ['Giá trị hiện tại', fmtUsd(value), ''],
    ['Lãi/lỗ chưa chốt', `${fmtUsd(pnl)} <small>${fmtPct(cost ? pnl / cost * 100 : 0)}</small>`, cls(pnl)],
    ['Lãi/lỗ đã chốt', fmtUsd(realized), cls(realized)],
  ];
  $('#summary').innerHTML = items.map(([l, v, c]) =>
    `<div class="stat"><div class="label">${l}</div><div class="value ${c}">${v}</div></div>`).join('');
}

function renderPortfolio(hs) {
  const tb = $('#portfolio tbody');
  if (!hs.length) {
    tb.innerHTML = `<tr><td colspan="8" class="muted" style="text-align:center">Chưa có lệnh nào. Thêm lệnh mua đầu tiên ở trên nhé!</td></tr>`;
    return;
  }
  tb.innerHTML = hs.map((h) => `
    <tr data-coin="${esc(h.coin)}">
      <td><b>${esc(h.coin)}</b></td>
      <td>${fmtQty(h.qty)}</td>
      <td>${fmtUsd(h.cost)}</td>
      <td><b>${fmtPrice(h.avg)}</b></td>
      <td>${fmtPrice(h.price)}</td>
      <td>${fmtUsd(h.value)}</td>
      <td class="${cls(h.pnl)}">${fmtUsd(h.pnl)}<br><small>${fmtPct(h.pnlPct)}</small></td>
      <td class="${cls(h.realized)}">${h.realized ? fmtUsd(h.realized) : '—'}</td>
    </tr>`).join('');
}

function renderHistory() {
  const list = sorted(txs).reverse().filter((t) => !historyCoin || t.coin === historyCoin);
  $('#histFilter').textContent = historyCoin ? `· ${historyCoin}` : '';
  $('#clearFilter').hidden = !historyCoin;
  $('#history tbody').innerHTML = list.length ? list.map((t) => `
    <tr>
      <td>${esc(t.date || '')}</td>
      <td><b>${esc(t.coin)}</b></td>
      <td><span class="tag ${t.side}">${t.side === 'buy' ? 'MUA' : 'BÁN'}</span></td>
      <td>${fmtPrice(t.price)}</td>
      <td>${fmtQty(t.qty)}</td>
      <td>${fmtUsd(t.qty * t.price)}</td>
      <td style="text-align:left">${esc(t.note || '')}</td>
      <td><button class="icon" data-edit="${t.id}" title="Sửa">✎</button><button class="icon" data-del="${t.id}" title="Xóa">✕</button></td>
    </tr>`).join('') : `<tr><td colspan="8" class="muted" style="text-align:center">Trống</td></tr>`;
}

function renderPie(hs) {
  const parts = hs.filter((h) => h.qty > 0).map((h) => ({ coin: h.coin, v: h.value ?? h.cost }));
  const total = parts.reduce((s, p) => s + p.v, 0);
  if (!total) { $('#pie').innerHTML = '<span class="muted small">Chưa có dữ liệu</span>'; return; }
  let acc = 0;
  const stops = parts.map((p, i) => {
    const from = acc / total * 360; acc += p.v;
    return `${COLORS[i % COLORS.length]} ${from}deg ${acc / total * 360}deg`;
  });
  $('#pie').innerHTML = `
    <div style="width:130px;height:130px;border-radius:50%;background:conic-gradient(${stops.join(',')});
      -webkit-mask:radial-gradient(circle,transparent 38px,#000 39px);mask:radial-gradient(circle,transparent 38px,#000 39px)"></div>
    <div class="legend">${parts.map((p, i) =>
      `<div><i style="background:${COLORS[i % COLORS.length]}"></i><b>${esc(p.coin)}</b> ${(p.v / total * 100).toFixed(1)}%</div>`).join('')}</div>`;
}

function renderSimOptions(hs) {
  const sel = $('#sCoin');
  const cur = sel.value;
  const coins = hs.filter((h) => h.qty > 0).map((h) => h.coin);
  const html = coins.map((c) => `<option>${esc(c)}</option>`).join('') || '<option value="">(chưa có coin)</option>';
  if (sel.innerHTML !== html) { sel.innerHTML = html; if (coins.includes(cur)) sel.value = cur; }
}

function renderSim() {
  const h = computeHoldings().find((x) => x.coin === $('#sCoin').value);
  const amt = +$('#sAmount').value, price = +$('#sPrice').value || h?.price;
  if (!h) { $('#simResult').innerHTML = ''; return; }
  if (!$('#sPrice').value && h.price) $('#sPrice').placeholder = fmtPrice(h.price);
  if (!amt || !price) {
    $('#simResult').innerHTML = `DCA hiện tại: <b>${fmtPrice(h.avg)}</b>. Nhập số vốn để xem giá DCA mới.`;
    return;
  }
  const qty = h.qty + amt / price, cost = h.cost + amt, avg = cost / qty;
  const diff = (avg - h.avg) / h.avg * 100;
  $('#simResult').innerHTML = `
    Giá DCA: <b>${fmtPrice(h.avg)}</b> → <b class="${cls(-diff)}">${fmtPrice(avg)}</b> (${fmtPct(diff)})<br>
    Số lượng: ${fmtQty(h.qty)} → <b>${fmtQty(qty)}</b> · Tổng vốn: <b>${fmtUsd(cost)}</b>`;
}

// ---------- Form ----------
const side = () => document.querySelector('input[name=side]:checked').value;

function updateFormLabels() {
  const label = $('#amountLabel');
  label.firstChild.textContent = side() === 'buy' ? 'Số vốn (USDT) ' : 'Số lượng bán ';
  $('#submitBtn').textContent = editingId ? 'Lưu thay đổi' : side() === 'buy' ? 'Thêm lệnh mua' : 'Thêm lệnh bán';
  updatePreview();
}

function updatePreview() {
  const coin = $('#fCoin').value.trim().toUpperCase();
  const price = +$('#fPrice').value, amount = +$('#fAmount').value;
  const h = computeHoldings().find((x) => x.coin === coin);
  let msg = '';
  if (coin && !price && prices[coin]) msg = `Giá hiện tại ${coin}: <b>${fmtPrice(prices[coin])}</b>`;
  if (price && amount) {
    if (side() === 'buy') {
      const qty = amount / price;
      msg = `Nhận ≈ <b>${fmtQty(qty)} ${esc(coin)}</b>`;
      if (h && h.qty > 0 && !editingId) msg += ` · DCA mới: <b>${fmtPrice((h.cost + amount) / (h.qty + qty))}</b> (hiện ${fmtPrice(h.avg)})`;
    } else {
      msg = `Thu về <b>${fmtUsd(amount * price)}</b>`;
      if (h?.avg) msg += ` · Lãi/lỗ chốt ≈ <b class="${cls(price - h.avg)}">${fmtUsd(amount * (price - h.avg))}</b>`;
      if (h && amount > h.qty + 1e-12 && !editingId) msg += ` <span class="down">· Vượt số lượng đang có (${fmtQty(h.qty)})</span>`;
    }
  }
  $('#fPreview').innerHTML = msg;
}

function resetForm() {
  editingId = null;
  $('#txForm').reset();
  $('#fDate').value = new Date().toISOString().slice(0, 10);
  $('#formTitle').textContent = 'Thêm lệnh';
  $('#cancelEdit').hidden = true;
  updateFormLabels();
}

$('#txForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const coin = $('#fCoin').value.trim().toUpperCase();
  const price = +$('#fPrice').value, amount = +$('#fAmount').value;
  if (!coin || !(price > 0) || !(amount > 0)) return;
  const s = side();
  const tx = {
    id: editingId || crypto.randomUUID?.() || String(Date.now() + Math.random()),
    coin, side: s, price,
    qty: s === 'buy' ? amount / price : amount,
    date: $('#fDate').value,
    note: $('#fNote').value.trim(),
    created: editingId ? txs.find((t) => t.id === editingId).created : Date.now(),
  };
  if (editingId) txs = txs.map((t) => t.id === editingId ? tx : t);
  else txs.push(tx);
  save();
  resetForm();
  render();
});

function startEdit(id) {
  const t = txs.find((x) => x.id === id);
  if (!t) return;
  editingId = id;
  $(t.side === 'buy' ? '#sideBuy' : '#sideSell').checked = true;
  $('#fCoin').value = t.coin;
  $('#fPrice').value = t.price;
  $('#fAmount').value = t.side === 'buy' ? +(t.qty * t.price).toFixed(8) : t.qty;
  $('#fDate').value = t.date || '';
  $('#fNote').value = t.note || '';
  $('#formTitle').textContent = 'Sửa lệnh';
  $('#cancelEdit').hidden = false;
  updateFormLabels();
  $('#txForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ---------- Sự kiện ----------
document.querySelectorAll('input[name=side]').forEach((r) => r.addEventListener('change', updateFormLabels));
['#fCoin', '#fPrice', '#fAmount'].forEach((s) => $(s).addEventListener('input', updatePreview));
$('#cancelEdit').addEventListener('click', resetForm);
['#sCoin', '#sAmount', '#sPrice'].forEach((s) => $(s).addEventListener('input', renderSim));
$('#sCoin').addEventListener('change', () => { $('#sPrice').value = ''; renderSim(); });

$('#portfolio').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-coin]');
  if (!tr) return;
  historyCoin = tr.dataset.coin;
  $('#fCoin').value = historyCoin;
  $('#sCoin').value = historyCoin;
  renderHistory(); renderSim(); updatePreview();
  $('#history').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('#clearFilter').addEventListener('click', () => { historyCoin = null; renderHistory(); });

$('#history').addEventListener('click', (e) => {
  const edit = e.target.dataset.edit, del = e.target.dataset.del;
  if (edit) startEdit(edit);
  if (del && confirm('Xóa lệnh này?')) {
    txs = txs.filter((t) => t.id !== del);
    if (editingId === del) resetForm();
    save(); render();
  }
});

$('#refreshBtn').addEventListener('click', fetchPrices);

$('#exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ version: 1, exported: new Date().toISOString(), txs }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `dca-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data) ? data : data.txs;
    if (!Array.isArray(list) || list.some((t) => !t.coin || !t.price || !t.qty || !['buy', 'sell'].includes(t.side))) throw 0;
    if (!confirm(`Nhập ${list.length} lệnh? Dữ liệu hiện tại sẽ bị thay thế.`)) return;
    txs = list.map((t, i) => ({ ...t, id: t.id || String(Date.now() + i), created: t.created || Date.now() + i }));
    save(); render();
  } catch {
    alert('File không hợp lệ.');
  }
});

// Giao diện sáng/tối
const THEME_KEY = 'dca-theme';
try { const th = localStorage.getItem(THEME_KEY); if (th) document.documentElement.dataset.theme = th; } catch {}
$('#themeBtn').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, root.dataset.theme); } catch {}
});

// ---------- Khởi động ----------
resetForm();
render();
fetchPrices();
setInterval(() => { if (!document.hidden) fetchPrices(); }, REFRESH_MS);
