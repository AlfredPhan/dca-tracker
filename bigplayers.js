'use strict';
// ---------- Tab Tay to: cá voi, quỹ ETF, sàn đang mua hay bán BTC ----------
// data/whales.json (GitHub Actions): giá vốn các nhóm và BTC trong ví cá voi (BGeometrics, mỗi ngày),
//   MVRV và tổng BTC/ETH nạp/rút mọi sàn (Coin Metrics, theo ngày).
// data/onchain.json: dự trữ từng sàn (ví sàn đã công khai, mỗi giờ). data/etf.json: từng quỹ ETF (Farside).
// data/history.json: lệnh lớn trên Binance do bot ghi.

const bp = { started: false, data: {} };
const BP_FMT = (p) => p == null || !isFinite(p) ? '—' : '$' + Math.round(p).toLocaleString('en-US');
const bpPct = (n, d = 1) => (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(d) + '%';
const bpBtc = (n) => (n >= 0 ? '+' : '−') + fmtBig(Math.abs(n)) + ' BTC';
const bpLast = (s) => s?.length ? s[s.length - 1] : null;
const bpAgo = (s, days) => { // giá trị cách đây N ngày (theo ngày ghi trong chuỗi)
  const last = bpLast(s);
  if (!last) return null;
  const t = Date.parse(last[0]) - days * 864e5;
  for (let i = s.length - 1; i >= 0; i--) if (Date.parse(s[i][0]) <= t) return s[i];
  return null;
};
const bpDate = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

async function startBig() {
  if (!bp.started) {
    bp.started = true;
    $('#tab-big').addEventListener('click', (e) => { const go = e.target.closest('[data-go]'); if (go) goTab(go.dataset.go); });
  }
  const get = (n) => loadData(n).catch(() => null);
  const [whales, onchain, etf, history] = await Promise.all([get('whales.json'), get('onchain.json'), get('etf.json'), get('history.json')]);
  bp.data = { whales, onchain, etf, history };
  renderBig();
}

function renderBig() {
  if (!bp.started) return;
  const { whales, onchain, etf, history } = bp.data;
  const btc = prices.BTC;
  const sig = [];
  $('#bigCost').innerHTML = bigCost(whales, btc, sig);
  $('#bigWallets').innerHTML = bigWallets(whales, sig);
  $('#bigFlows').innerHTML = bigFlows(whales, onchain, sig);
  $('#bigEtf').innerHTML = bigEtf(etf, sig);
  $('#bigOrders').innerHTML = bigOrders(history, sig);
  $('#bigVerdict').innerHTML = bigVerdict(sig, whales);
}

// ---------- 1. Kết luận ----------
function bigVerdict(sig, whales) {
  if (!sig.length) return `<h2>🦈 Tay to đang làm gì?</h2><p class="hint">${whales === undefined ? 'Đang tải…' : 'Chưa có dữ liệu (đang được tạo, thử lại sau ít phút).'}</p>`;
  const score = sig.reduce((s, x) => s + x.score, 0);
  const [cl, text] = score >= 2 ? ['up', '🟢 Tay to nghiêng về GOM'] : score <= -2 ? ['down', '🔴 Tay to nghiêng về XẢ'] : ['', '⚪ Tay to chưa nghiêng rõ'];
  return `<h2>🦈 Tay to đang làm gì?</h2>
    <div class="scorehead"><span class="scorenum ${cl}">${score > 0 ? '+' : ''}${score}<small>/${sig.length}</small></span><span class="verdict ${cl}">${text}</span></div>
    ${sig.map((s) => `<div class="sig"><span>${s.score > 0 ? '🟢' : s.score < 0 ? '🔴' : '⚪'}</span><b>${s.name}</b><span class="muted">${s.text}</span><span>${s.score > 0 ? '+1' : s.score < 0 ? '−1' : '0'}</span></div>`).join('')}
    <p class="muted small">Mỗi nguồn +1 (ủng hộ gom), −1 (ủng hộ xả) hoặc 0. Đây là suy luận từ dữ liệu công khai, không ai biết chắc ý định của tay to. Số liệu on-chain theo ngày nên phản ánh xu hướng vài ngày đến vài tuần, không phải từng giờ.</p>`;
}

// ---------- 2. Giá vốn các nhóm ----------
function bigCost(w, btc, sig) {
  const s = w?.bg?.series || {}, cm = w?.cm?.btc || [];
  const lastCm = cm.filter((x) => x.mvrv && x.p).at(-1);
  // Giá vốn toàn thị trường: lấy từ MVRV của Coin Metrics (mới tới hôm qua), không có thì dùng BGeometrics (trễ 7 ngày).
  const real = lastCm ? lastCm.p / lastCm.mvrv : bpLast(s.real)?.[1];
  const mvrv = btc && real ? btc / real : lastCm?.mvrv;
  const rows = [];
  const add = (p, name, tip, kind, date) => { if (p) rows.push({ p, name, tip, kind, date }); };
  if (real) {
    add(real * 2.8, 'Vùng chốt lời mạnh (MVRV ~2.8)', 'Đỉnh 11/2021 (67.5K) có MVRV 2.85, đỉnh 3/2024 (73K) có MVRV 2.75', 'top');
    add(real * 2.3, 'Vùng tay to bắt đầu chốt lời (MVRV ~2.3)', 'Đỉnh 10/2025 (124.8K) có MVRV 2.3: mỗi chu kỳ, MVRV ở đỉnh thấp dần', 'top');
  }
  add(bpLast(s.tmm)?.[1], 'Giá vốn nhà đầu tư đang hoạt động (True Market Mean)', 'Ranh giới thị trường tăng / giảm: giá trên mức này là thị trường tăng', 'mid', bpLast(s.tmm)?.[0]);
  add(bpLast(s.sth)?.[1], 'Giá vốn tay mới (giữ dưới 155 ngày)', 'Giá hồi lên đây thì tay mới hết lỗ, hay bán hòa vốn: kháng cự mạnh trong xu hướng giảm', 'res', bpLast(s.sth)?.[0]);
  add(real, 'Giá vốn toàn thị trường (Realized Price)', 'Giá về gần mức này thường là vùng đáy chu kỳ (2015, 2018, 2022), tay to hay gom', 'sup', lastCm?.d || bpLast(s.real)?.[0]);
  add(bpLast(s.lth)?.[1], 'Giá vốn tay lâu năm (giữ trên 155 ngày)', 'Hỗ trợ cuối cùng, rất hiếm khi thủng lâu', 'sup', bpLast(s.lth)?.[0]);
  if (!rows.length) return `<h2>💰 Giá vốn các nhóm</h2><p class="hint">Chưa có dữ liệu.</p>`;
  rows.sort((a, b) => b.p - a.p);
  let html = '', placed = false;
  const nowRow = btc ? `<div class="ewrow now"><span>▶ ${BP_FMT(btc)}</span><span>Giá BTC hiện tại</span><span></span></div>` : '';
  for (const r of rows) {
    if (!placed && btc > r.p) { html += nowRow; placed = true; }
    html += `<div class="ewrow ${r.kind === 'top' ? 'inv' : r.kind === 'sup' ? 'tgt' : 'alt'}"><span>${BP_FMT(r.p)}</span>
      <span><b>${r.name}</b><br><small class="muted">${r.tip}${r.date ? ` · số ngày ${bpDate(r.date)}` : ''}</small></span>
      <span class="muted">${btc ? bpPct((r.p / btc - 1) * 100) : ''}</span></div>`;
  }
  if (!placed) html += nowRow;
  let zone = '';
  if (mvrv) {
    const [txt, sc] = mvrv < 1 ? ['dưới giá vốn chung: vùng tay to gom mạnh trong lịch sử', 1] : mvrv < 1.5 ? ['gần giá vốn chung: vùng tích lũy, rủi ro thấp so với lịch sử', 1]
      : mvrv < 2.3 ? ['vùng giữa, chưa rẻ cũng chưa đắt', 0] : ['vùng tay to hay chốt lời', -1];
    zone = `<p class="verdictline">MVRV hiện tại <b>${mvrv.toFixed(2)}</b>: ${txt}.</p>`;
    sig.push({ name: 'Giá so với giá vốn (MVRV)', score: sc, text: `MVRV ${mvrv.toFixed(2)}: ${txt}.` });
  }
  const sth = bpLast(s.sth)?.[1];
  if (sth && btc) sig.push({ name: 'Tay mới', score: 0, text: btc < sth ? `Đang lỗ trung bình ${bpPct((btc / sth - 1) * 100, 0)}: giá hồi lên ${BP_FMT(sth)} dễ gặp lực bán hòa vốn.` : `Đang lãi: giá vốn tay mới ${BP_FMT(sth)} thành hỗ trợ.` });
  const plan = typeof ov !== 'undefined' ? ov.status?.btcBuy : null;
  const planTxt = plan ? `<p class="hint">Vùng mua BTC của bạn: ${plan.levels.map(BP_FMT).join(' · ')}. So với giá vốn toàn thị trường ${BP_FMT(real)} và tay lâu năm ${BP_FMT(bpLast(s.lth)?.[1])}: các vùng mua nằm quanh nơi tay to hay gom.</p>` : '';
  return `<h2>💰 Giá vốn các nhóm <span class="muted small">(vùng chốt lời, kháng cự, hỗ trợ của tay to)</span></h2>
    ${zone}<div class="ewlist">${html}</div>${planTxt}
    <p class="muted small">Giá vốn = giá BTC lúc mỗi đồng coin được chuyển lần cuối trên blockchain, tính trung bình theo nhóm. Tay mới, tay lâu năm, True Market Mean: BGeometrics (gói miễn phí, trễ khoảng 7 ngày). Giá vốn toàn thị trường và MVRV: Coin Metrics, mới tới hôm qua.</p>`;
}

// ---------- 3. Ví cá voi ----------
function bigWallets(w, sig) {
  const s = w?.bg?.series || {};
  const groups = [
    ['w10k', 'Ví trên 10,000 BTC', 'Phần lớn là ví sàn, quỹ ETF, công ty lưu ký'],
    ['w1k', 'Ví 1,000–10,000 BTC', 'Cá voi: quỹ, tổ chức, cá nhân rất giàu'],
    ['w100', 'Ví 100–1,000 BTC', 'Cá mập: nhà đầu tư lớn'],
  ].filter(([k]) => s[k]?.length > 30);
  if (!groups.length) return `<h2>🐋 Ví cá voi đang giữ bao nhiêu BTC</h2><p class="hint">Chưa có dữ liệu.</p>`;
  const rows = groups.map(([k, name, tip]) => {
    const ser = s[k], last = bpLast(ser), d7 = bpAgo(ser, 7), d30 = bpAgo(ser, 30);
    const c7 = d7 ? last[1] - d7[1] : null, c30 = d30 ? last[1] - d30[1] : null;
    if (k === 'w1k' && c30 != null) {
      const p = c30 / d30[1] * 100;
      sig.push({ name: 'Ví cá voi 1K–10K BTC', score: p > 0.3 ? 1 : p < -0.3 ? -1 : 0, text: `30 ngày ${c30 >= 0 ? 'tăng' : 'giảm'} ${fmtBig(Math.abs(c30))} BTC (${bpPct(p, 2)}). ${p > 0.3 ? 'Cá voi đang gom thêm.' : p < -0.3 ? 'Cá voi đang bớt BTC (bán hoặc chia nhỏ ví).' : 'Gần như không đổi.'}` });
    }
    return `<div class="bigwal">
      <div><b>${name}</b><br><small class="muted">${tip}</small></div>
      <div class="bignum"><b>${fmtBig(last[1])} BTC</b><br>
        ${c7 != null ? `<small class="${cls(c7)}">7 ngày ${bpBtc(c7)}</small>` : ''} ${c30 != null ? `<small class="${cls(c30)}">· 30 ngày ${bpBtc(c30)}</small>` : ''}</div>
      <div>${sparkline(ser.slice(-180).map((x) => x[1]))}</div></div>`;
  }).join('');
  const date = bpLast(s[groups[0][0]])?.[0];
  return `<h2>🐋 Ví cá voi đang giữ bao nhiêu BTC</h2>${rows}
    <p class="muted small">Tổng BTC nằm trong các ví theo cỡ, 180 ngày gần nhất, số ngày ${date ? bpDate(date) : ''}. Nguồn BGeometrics. Một tổ chức có thể có nhiều ví, và sàn hay gộp/tách ví, nên chỉ nên xem xu hướng tăng hay giảm, không xem từng ngày.</p>`;
}

// ---------- 4. Nạp/rút sàn ----------
function bigBars(vals, labels) {
  const max = Math.max(...vals.map(Math.abs), 1), n = vals.length, bw = 100 / n;
  const bars = vals.map((v, i) => {
    const h = Math.abs(v) / max * 28;
    return `<rect x="${(i * bw + bw * 0.15).toFixed(2)}" y="${(v >= 0 ? 30 - h : 30).toFixed(2)}" width="${(bw * 0.7).toFixed(2)}" height="${Math.max(h, 0.4).toFixed(2)}" fill="var(--${v >= 0 ? 'up' : 'down'})"><title>${labels[i]}: ${v >= 0 ? 'rút ra' : 'nạp vào'} ${fmtBig(Math.abs(v))}</title></rect>`;
  }).join('');
  return `<svg class="bigbars" viewBox="0 0 100 60" preserveAspectRatio="none">${bars}<line x1="0" y1="30" x2="100" y2="30" stroke="var(--border)" stroke-width=".3"/></svg>
    <div class="bigaxis"><span>${labels[0]}</span><span>${labels[labels.length - 1]}</span></div>`;
}

function bigFlows(w, onchain, sig) {
  let html = '<h2>🏦 Nạp / rút sàn</h2>';
  for (const [coin, list] of [['BTC', w?.cm?.btc], ['ETH', w?.cm?.eth]]) {
    if (!list?.length) continue;
    const last30 = list.slice(-30), net = (a) => a.reduce((s, x) => s + x.out - x.in, 0);
    const n7 = net(list.slice(-7)), n30 = net(last30);
    if (coin === 'BTC') sig.push({ name: 'Nạp/rút mọi sàn (7 ngày)', score: n7 > 0 ? 1 : n7 < 0 ? -1 : 0,
      text: `${n7 >= 0 ? 'Rút ra' : 'Nạp vào'} ròng ${fmtBig(Math.abs(n7))} BTC. ${n7 >= 0 ? 'Coin rời sàn về ví riêng: thường là gom giữ lâu.' : 'Coin đổ lên sàn: thường là chuẩn bị bán.'}` });
    html += `<h3 class="small">${coin} · tổng mọi sàn theo ngày</h3>
      <p class="hint">7 ngày: <b class="${cls(n7)}">${n7 >= 0 ? 'rút ra' : 'nạp vào'} ${fmtBig(Math.abs(n7))} ${coin}</b> · 30 ngày: <b class="${cls(n30)}">${n30 >= 0 ? 'rút ra' : 'nạp vào'} ${fmtBig(Math.abs(n30))} ${coin}</b></p>
      ${bigBars(last30.map((x) => x.out - x.in), last30.map((x) => bpDate(x.d)))}`;
  }
  const o = onchain?.coins?.BTC;
  if (o?.byEx && o.hours >= 1) {
    const rows = Object.entries(o.byEx).map(([ex, v]) => ({ ex, ...v, d: v.out - v.in })).sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 8);
    html += `<h3 class="small">BTC · từng sàn, ${Math.round(o.hours)} giờ qua</h3><div class="tablewrap"><table>
      <thead><tr><th>Sàn</th><th>Đang giữ</th><th>Thay đổi</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${esc(r.ex)}</td><td>${fmtBig(r.reserve)}</td><td class="${cls(r.d)}">${r.d ? `${r.d > 0 ? 'rút ' : 'nạp '}${fmtBig(Math.abs(r.d))}` : '<span class="muted">0</span>'}</td></tr>`).join('')}
      </tbody></table></div>`;
  }
  return html + `<p class="hint"><span class="up">■ Rút khỏi sàn</span> (thường là gom về ví) · <span class="down">■ Nạp lên sàn</span> (thường để bán). Chạm cột để xem số.</p>
    <p class="muted small">Tổng mọi sàn: Coin Metrics Community (CC BY-NC 4.0), số ngày hôm qua là số tạm tính. Từng sàn: số dư các ví sàn đã công khai, website tự chụp mỗi giờ (chuyển giữa ví sàn chưa theo dõi cũng bị tính là nạp/rút).</p>`;
}

// ---------- 5. Quỹ ETF ----------
function bigEtf(etf, sig) {
  let html = '<h2>🏛 Quỹ ETF đang mua hay bán</h2>';
  let any = false;
  for (const coin of ['BTC', 'ETH']) {
    const list = (etf?.coins?.[coin] || []).filter((x) => x.total || Object.values(x.funds || {}).some((v) => v)); // bỏ phiên chưa có số
    if (!list.length) continue;
    any = true;
    const last = list[list.length - 1], last5 = list.slice(-5), s5 = last5.reduce((s, x) => s + x.total, 0);
    if (coin === 'BTC') sig.push({ name: 'Quỹ ETF BTC (5 phiên)', score: s5 > 0 ? 1 : s5 < 0 ? -1 : 0, text: `${etfM(s5)}. ${s5 > 0 ? 'Tiền mới đang vào quỹ: quỹ phải mua BTC.' : 'Nhà đầu tư rút tiền: quỹ phải bán BTC.'}` });
    const funds = {};
    for (const x of last5) for (const [f, v] of Object.entries(x.funds || {})) funds[f] = (funds[f] || 0) + v;
    const rows = Object.entries(funds).filter(([, v]) => v).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 6);
    html += `<h3 class="small">${coin} · phiên ${bpDate(last.d)}: <span class="${cls(last.total)}">${etfM(last.total)}</span> · 5 phiên: <span class="${cls(s5)}">${etfM(s5)}</span></h3>
      <div class="tablewrap"><table><thead><tr><th>Quỹ</th><th>Phiên ${bpDate(last.d)}</th><th>5 phiên</th></tr></thead><tbody>
      ${rows.map(([f, v]) => `<tr><td><b>${esc(f)}</b> <small class="muted">${ETF_NAMES[f] || ''}</small></td><td class="${cls(last.funds?.[f] || 0)}">${last.funds?.[f] ? etfM(last.funds[f]) : '<span class="muted">0</span>'}</td><td class="${cls(v)}">${etfM(v)}</td></tr>`).join('')}
      </tbody></table></div>`;
  }
  return any ? html + `<p class="muted small">Triệu USD tiền vào (+) hoặc rút ra (−) mỗi phiên Mỹ. Nguồn Farside Investors, có số sau phiên Mỹ đóng cửa (sáng hôm sau giờ Việt Nam).</p>`
    : html + '<p class="hint">Chưa có dữ liệu.</p>';
}

// ---------- 6. Lệnh lớn trên Binance (bot ghi) ----------
function bigOrders(history, sig) {
  const days = (history?.days || []).filter((d) => d.coins?.BTC).slice(-14);
  const min = history?.coins?.BTC;
  if (!days.length || !min) return `<h2>🐳 Lệnh lớn BTC trên Binance</h2><p class="hint">Chưa có dữ liệu từ bot.</p>`;
  const vals = days.map((d) => (d.coins.BTC.b || 0) - (d.coins.BTC.s || 0));
  const last7 = days.slice(-7), b7 = last7.reduce((s, d) => s + (d.coins.BTC.b || 0), 0), s7 = last7.reduce((s, d) => s + (d.coins.BTC.s || 0), 0);
  const today = days[days.length - 1].coins.BTC;
  sig.push({ name: `Lệnh lớn Binance (${last7.length} ngày)`, score: b7 > s7 * 1.1 ? 1 : s7 > b7 * 1.1 ? -1 : 0,
    text: `Mua ${fmtUsdShort(b7)} · bán ${fmtUsdShort(s7)} (lệnh từ ${fmtUsdShort(min)}).` });
  return `<div class="row between"><h2>🐳 Lệnh lớn BTC trên Binance</h2><button class="ghost small" data-go="whale">Cá voi →</button></div>
    <p class="hint">Hôm nay (từ 7:00): mua <b class="up">${fmtUsdShort(today.b || 0)}</b> (${today.nb || 0} lệnh) · bán <b class="down">${fmtUsdShort(today.s || 0)}</b> (${today.ns || 0} lệnh)</p>
    <p class="hint">${last7.length} ngày: mua <b class="up">${fmtUsdShort(b7)}</b> · bán <b class="down">${fmtUsdShort(s7)}</b> → <b class="${cls(b7 - s7)}">${b7 >= s7 ? 'gom' : 'xả'} ${fmtUsdShort(Math.abs(b7 - s7))}</b></p>
    ${days.length > 1 ? bigBars(vals, days.map((d) => bpDate(d.d))) : ''}
    <p class="muted small">Mỗi lệnh khớp từ ${fmtUsdShort(min)} trở lên trên Binance spot (đúng như bot báo Telegram), cộng theo ngày. Chỉ một sàn, và bot chỉ ghi từ lúc bắt đầu chạy.</p>`;
}

document.querySelector('.tab[data-tab="big"]').addEventListener('click', startBig);
setInterval(() => { if (!document.hidden && !$('#tab-big').hidden) startBig(); }, 5 * 60000);
if (location.hash === '#big') goTab('big');
