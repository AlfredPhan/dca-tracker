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
  const [whales, onchain, etf, history] = await Promise.all([get('whales.json'), get('onchain.json'), get('etf.json'), get('history.json'), bpWeekly().catch(() => null)]);
  bp.data = { whales, onchain, etf, history };
  renderBig();
}

function renderBig() {
  if (!bp.started) return;
  const { whales, onchain, etf, history } = bp.data;
  const btc = prices.BTC;
  const sig = [];
  $('#bigCost').innerHTML = bigCost(whales, btc, sig);
  $('#bigMvrv').innerHTML = bigMvrv(whales, btc);
  $('#bigEthMvrv').innerHTML = bigEthMvrv(whales, prices.ETH);
  $('#bigCycle').innerHTML = bigCycle(btc);
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
    <div class="scorehead"><span class="scorenum ${cl}">${score > 0 ? '+' : score < 0 ? '−' : ''}${Math.abs(score)}<small> điểm</small></span><span class="verdict ${cl}">${text}</span>
      <span class="small"><b class="up">${sig.filter((s) => s.score > 0).length} gom</b> · <b class="down">${sig.filter((s) => s.score < 0).length} xả</b> · <b class="muted">${sig.filter((s) => !s.score).length} trung lập</b></span></div>
    ${sig.map((s) => `<div class="sig"><span>${s.score > 0 ? '🟢' : s.score < 0 ? '🔴' : '⚪'}</span><b>${s.name}</b><span class="muted">${s.text}</span><b class="${cls(s.score)}">${s.score > 0 ? '+1' : s.score < 0 ? '−1' : '0'}</b></div>`).join('')}
    <p class="muted small">Điểm = cộng các dòng: mỗi nguồn +1 (ủng hộ gom), −1 (ủng hộ xả) hoặc 0. Từ +2 trở lên là nghiêng gom, từ −2 trở xuống là nghiêng xả. Đây là suy luận từ dữ liệu công khai, không ai biết chắc ý định của tay to. Số liệu on-chain theo ngày nên phản ánh xu hướng vài ngày đến vài tuần, không phải từng giờ.</p>`;
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
    add(real * 2.5, 'Mức chốt lời tối đa của kế hoạch (MVRV 2.5)', 'Cao hơn đỉnh MVRV chu kỳ 2025 (2.41): chốt nốt', 'top');
    add(real * 2.3, 'Vùng chốt lời mạnh (MVRV 2.3)', 'Đỉnh 10/2025 (124.8K) có MVRV 2.29: mỗi chu kỳ, MVRV ở đỉnh thấp dần', 'top');
    add(real * 2, 'Tay to bắt đầu chốt lời BTC (MVRV 2.0)', 'Dự kiến đỉnh chu kỳ này rơi vào MVRV 2.0–2.3', 'top');
    add(real * 1.8, 'Bắt đầu chốt altcoin (MVRV 1.8)', 'Altcoin thường đạt đỉnh trước BTC', 'top');
  }
  const wm = wmaState(btc);
  if (wm) add(wm.wma, 'Đường trung bình 200 tuần', 'Đáy 2015, 2018, 2020 quanh đường này; 2022 thủng sâu 34%. Đóng tuần lại trên đường này là dấu hiệu thị trường hồi phục', btc < wm.wma ? 'res' : 'sup');
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
      <span><b>${r.name}</b><br><small class="muted">${r.tip}${r.date ? ` · số liệu ngày ${bpDate(r.date)}` : ''}</small></span>
      <span class="muted">${btc ? bpPct((r.p / btc - 1) * 100) : ''}</span></div>`;
  }
  if (!placed) html += nowRow;
  let zone = '';
  if (mvrv) {
    const [txt, sc] = mvrv < 1 ? ['dưới giá vốn chung: vùng tay to gom mạnh trong lịch sử', 1] : mvrv < 1.5 ? ['gần giá vốn chung: vùng tích lũy, rủi ro thấp so với lịch sử', 1]
      : mvrv < 1.8 ? ['vùng giữa, chưa rẻ cũng chưa đắt', 0] : ['vùng chốt lời của kế hoạch (1.8–2.5)', -1];
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

// ---------- MVRV qua các chu kỳ + cảnh báo ----------
// Số liệu theo giá đóng cửa ngày, Coin Metrics (đã tra lại 24/11/2026).
const MVRV_TOPS = [
  ['4/2013', 231, 5.64, 5.64], ['12/2013', 1135, 4.72, 5.88], ['12/2017', 19641, 4.43, 4.72], ['4/2021', 63446, 3.43, 3.96],
  ['11/2021', 67542, 2.85, 2.93], ['3/2024', 73082, 2.75, 2.78], ['12/2024', 106116, 2.68, 2.74], ['10/2025', 124824, 2.29, 2.41],
];
const MVRV_BOTTOMS = [['1/2015', 176, 0.56], ['12/2018', 3185, 0.69], ['3/2020', 4959, 0.88], ['11/2022', 15758, 0.75]];
const MVRV_BUY = [1, 0.9, 0.8], MVRV_SELL = [1.8, 1.9, 2, 2.1, 2.2, 2.3, 2.4, 2.5];
// Lời khuyên theo mốc chốt lời (giống bot).
const mvrvSellNote = (L) => L < 2 ? 'vùng chốt altcoin (alt thường đạt đỉnh trước BTC): chốt dần 30–50% alt, BTC vẫn giữ.'
  : L < 2.3 ? 'tay to bắt đầu chốt lời BTC (dự kiến đỉnh chu kỳ này 2.0–2.3): chốt BTC từng phần, chốt phần lớn alt.'
  : L < 2.5 ? 'vùng chốt lời mạnh (đỉnh 10/2025: 2.29–2.41): chốt mạnh BTC, alt nên chốt xong.'
  : 'mức tối đa của kế hoạch, đã vượt đỉnh MVRV 2025: chốt nốt.';

// Giá vốn chung, MVRV hiện tại và cảnh báo (dùng cho cả tab Tay to và trang Tổng quan).
function mvrvState(w, btc) {
  const rows = (w?.cm?.btc || []).filter((x) => x.mvrv && x.p);
  if (!rows.length) return null;
  const last = rows[rows.length - 1], real = last.p / last.mvrv;
  const m = btc ? btc / real : last.mvrv;
  // Phân kỳ (giống bot): giá đóng cửa hôm qua cao nhất 365 ngày, MVRV ≥ 2 nhưng thấp hơn đỉnh MVRV trước ít nhất 5%.
  let div = null;
  const prev = rows.slice(-366, -1);
  if (prev.length >= 200 && last.mvrv >= 2 && last.p > Math.max(...prev.map((r) => r.p))) {
    const top = prev.reduce((a, b) => (b.mvrv > a.mvrv ? b : a));
    if (last.mvrv < top.mvrv * 0.95) div = { last, top };
  }
  let alert = null;
  if (div) alert = { cls: 'down', icon: '⚠️', text: `Giá lập đỉnh mới (${BP_FMT(div.last.p)}) nhưng MVRV ${div.last.mvrv.toFixed(2)} thấp hơn mức ${div.top.mvrv.toFixed(2)} ngày ${bpDate(div.top.d)}: tay to có thể đang chốt lời dần. Nên chốt lời từng phần.` };
  else if (m >= MVRV_SELL[0]) { const L = MVRV_SELL.filter((x) => m >= x).at(-1); alert = { cls: 'down', icon: '🔴', text: `MVRV ${m.toFixed(2)} (đã qua mốc ${L}): ${mvrvSellNote(L)}` }; }
  else if (m <= MVRV_BUY[2]) alert = { cls: 'up', icon: '🟢', text: `MVRV ${m.toFixed(2)}: vùng đáy sâu của lịch sử (đáy 2018: 0.69, 2022: 0.75). Mua phần BTC cuối, kiên nhẫn: giá có thể nằm vùng này vài tháng.` };
  else if (m <= MVRV_BUY[1]) alert = { cls: 'up', icon: '🟢', text: `MVRV ${m.toFixed(2)}: giá thấp hơn giá vốn chung hơn 10%, vùng tay to gom mạnh (đáy 2020: 0.88, 2022: 0.75).` };
  else if (m <= MVRV_BUY[0]) alert = { cls: 'up', icon: '🟢', text: `MVRV ${m.toFixed(2)}: giá dưới giá vốn chung ${BP_FMT(real)}, đa số người giữ đang lỗ. Lịch sử là vùng tay to gom.` };
  // Giai đoạn kế hoạch MVRV (giống bot, theo giá đóng cửa ngày): 1 đỡ giá đầu · 2 thủng giá vốn · 3 vùng đáy · 4 xác nhận đáy.
  const iTop = rows.reduce((b, r, i) => (r.p > rows[b].p ? i : b), 0);
  const below = rows.slice(iTop).filter((r) => r.mvrv < 1).length;
  const held = rows.slice(-30).every((r) => r.mvrv >= 1);
  const stage = below >= 30 && held ? 4 : last.mvrv < 0.9 ? 3 : last.mvrv < 1 ? 2 : 1;
  const cycMin = rows.slice(iTop).reduce((a, b) => (b.mvrv < a.mvrv ? b : a));
  return { real, m, div, alert, day: last.d, stage, below, cycMin, lastClose: last.mvrv };
}

const MVRV_STAGES = [
  ['Đỡ giá giai đoạn đầu', 'MVRV trên 1', 'Năm 2014 và 2018, vùng 1.1–1.3 đỡ giá nhiều lần (bật 20–80%) rồi vẫn thủng. Mua phần nhỏ, giữ phần lớn USDT.'],
  ['Thủng giá vốn', 'Nến ngày đóng dưới 1', 'Bắt đầu vùng tạo đáy (11/2018, 6/2022). Mua thêm từng phần.'],
  ['Vùng đáy lịch sử', 'Dưới 0.9', 'Đáy thật 2015, 2018, 2022 ở MVRV 0.56–0.75. Giá thường nằm vùng 0.8–1 khoảng 100–230 ngày: mua phần 3, 4, kiên nhẫn.'],
  ['Xác nhận đáy', 'Quay lại và giữ trên 1 suốt 30 ngày', 'Giống 5/2019, 2/2023: thị trường tăng mới bắt đầu. Mua nốt phần còn lại.'],
];

function mvrvPlan(s, btc) {
  const steps = MVRV_STAGES.map(([name, cond, tip], i) => `<div class="mvstep ${i + 1 === s.stage ? 'on' : i + 1 < s.stage ? 'done' : ''}">
    <b>${i + 1}. ${name}</b><small>${cond}</small><span>${tip}</span></div>`).join('');
  const plan = typeof ov !== 'undefined' ? ov.status?.btcBuy : null;
  const parts = plan ? `<p class="hint">Kế hoạch mua BTC của bạn theo MVRV: ${plan.levels.map((p, i) =>
    `phần ${i + 1} <b>${BP_FMT(p)}</b> (MVRV ${(p / s.real).toFixed(2)})`).join(' · ')}${plan.chase ? ` · nến tuần trên <b>${BP_FMT(plan.chase)}</b> thì mua nốt` : ''}.</p>` : '';
  return `<h3 class="small">🧭 Kế hoạch theo MVRV · đang ở <b>giai đoạn ${s.stage}</b></h3>
    <div class="mvsteps">${steps}</div>
    <p class="hint">Chu kỳ này (từ đỉnh 10/2025): MVRV đóng cửa thấp nhất <b>${s.cycMin.mvrv.toFixed(2)}</b> ngày ${bpDate(s.cycMin.d)} ·
      số ngày đóng cửa dưới 1: <b>${s.below}</b> (các chu kỳ trước: 133–304 ngày) · hôm qua đóng cửa MVRV <b>${s.lastClose.toFixed(2)}</b>.</p>${parts}`;
}

function bigMvrv(w, btc) {
  const s = mvrvState(w, btc);
  const head = '<h2>📏 MVRV qua các chu kỳ <span class="muted small">(tay to gom ở đâu, chốt lời ở đâu)</span></h2>';
  if (!s) return head + '<p class="hint">Chưa có dữ liệu.</p>';
  const zone = (L) => { const p = s.real * L; return `<span class="zchip ${L <= 1 ? (s.m <= L ? 'in' : '') : (s.m >= L ? 'in' : '')}"><small>MVRV ${L}</small> <b>${BP_FMT(p)}</b>${btc ? ` <small>${bpPct((p / btc - 1) * 100)}</small>` : ''}</span>`; };
  const banner = s.alert
    ? `<div class="mvalert ${s.alert.cls}">${s.alert.icon} ${s.alert.text}</div>`
    : `<div class="mvalert">⚪ MVRV hiện tại <b>${s.m.toFixed(2)}</b>: chưa tới vùng cảnh báo.</div>`;
  return head + banner + mvrvPlan(s, btc) + `
    <div class="mvzones"><span>🟢 Vùng gom</span><div class="zchips">${MVRV_BUY.map(zone).join('')}</div>
      <span>🔴 Vùng chốt lời</span><div class="zchips">${MVRV_SELL.map(zone).join('')}</div></div>
    <div class="grid2">
      <div><h3 class="small">Các đỉnh: tay to chốt lời</h3><div class="tablewrap"><table>
        <thead><tr><th>Đỉnh</th><th>Giá</th><th>MVRV lúc đỉnh giá</th><th>MVRV cao nhất</th></tr></thead><tbody>
        ${MVRV_TOPS.map(([d, p, m, mx]) => `<tr><td>${d}</td><td>${BP_FMT(p)}</td><td class="down"><b>${m.toFixed(2)}</b></td><td>${mx.toFixed(2)}</td></tr>`).join('')}
        </tbody></table></div></div>
      <div><h3 class="small">Các đáy: tay to gom</h3><div class="tablewrap"><table>
        <thead><tr><th>Đáy</th><th>Giá</th><th>MVRV</th></tr></thead><tbody>
        ${MVRV_BOTTOMS.map(([d, p, m]) => `<tr><td>${d}</td><td>${BP_FMT(p)}</td><td class="up"><b>${m.toFixed(2)}</b></td></tr>`).join('')}
        <tr class="mvnow"><td>Hiện tại</td><td>${BP_FMT(btc)}</td><td><b>${s.m.toFixed(2)}</b></td></tr>
        </tbody></table></div>
        <p class="hint">Chu kỳ 2026 tới nay MVRV thấp nhất 1.10 (30/6, giá đóng cửa ngày $58,525), chưa xuống dưới 1.</p></div>
    </div>
    <p class="hint">💡 <b>MVRV ở đỉnh thấp dần</b> qua mỗi chu kỳ (5.9 → 4.7 → 3.96 → 2.85 → 2.29): đừng chờ con số của chu kỳ trước.
      <b>Tay to chốt lời trước đỉnh giá</b>: MVRV thường cao nhất trước đỉnh giá vài tuần đến vài tháng, nên giá lập đỉnh mới mà MVRV thấp hơn là dấu hiệu họ đang xả dần.</p>
    <p class="muted small">MVRV = giá BTC ÷ giá vốn trung bình của mọi người đang giữ (${BP_FMT(s.real)}, Coin Metrics ngày ${bpDate(s.day)}). Bảng tính theo giá đóng cửa ngày. Bot Telegram cũng báo khi chạm các vùng này và khi có phân kỳ.</p>`;
}

// ---------- MVRV ETH (tham khảo phụ, BTC là chính) ----------
// Số liệu giá đóng cửa ngày, Coin Metrics (tra lại 25/11/2026). Đỉnh MVRV của ETH thấp dần còn nhanh hơn BTC.
const ETH_TOPS = [['1/2018', 1380, 2.61], ['5/2021', 4156, 2.27], ['11/2021', 4811, 2.03], ['3/2024', 4073, 1.59], ['12/2024', 4013, 1.45], ['8/2025', 4831, 1.49]];
const ETH_BOTTOMS = [['12/2018', 83, 0.30], ['3/2020', 110, 0.51], ['6/2022', 993, 0.60], ['4/2025', 1471, 0.79], ['6/2026', 1565, 0.76]];
function bigEthMvrv(w, live) {
  const head = '<h2>⟠ MVRV ETH <span class="muted small">(tham khảo phụ, BTC vẫn là chính)</span></h2>';
  const rows = (w?.cm?.eth || []).filter((x) => x.mvrv && x.p);
  if (!rows.length) return head + '<p class="hint">Chưa có dữ liệu.</p>';
  const last = rows[rows.length - 1], real = last.p / last.mvrv, px = live || last.p, m = px / real;
  const [txt, cl] = m < 0.8 ? ['vùng đáy sâu của lịch sử ETH', 'up'] : m < 1 ? ['dưới giá vốn chung, đa số người giữ ETH đang lỗ: vùng tay to hay gom', 'up']
    : m < 1.45 ? ['vùng giữa', ''] : ['vùng các đỉnh gần đây của ETH (1.45–1.6): cân nhắc chốt lời', 'down'];
  // Thanh MVRV 0 → 3: xanh là vùng đáy lịch sử, đỏ là vùng đỉnh, ▼ là hiện tại.
  const pos = (v) => Math.min(100, Math.max(0, (v / 3) * 100)).toFixed(1) + '%';
  const tick = (v, t) => `<span class="mvtick" style="left:${pos(v)}">${t}</span>`;
  return head + `
    <div class="ethmv">
      <div><div class="ethnum ${cl}">${m.toFixed(2)}</div><small class="muted">ETH ${BP_FMT(px)} · giá vốn ${BP_FMT(real)}</small></div>
      <div class="mvscale">
        <div class="mvbar"><span class="mvnowmk" style="left:${pos(m)}"></span></div>
        <div class="mvticks">${tick(0.3, '0.3')}${tick(0.8, '0.8')}${tick(1, '1')}${tick(1.5, '1.5')}${tick(2, '2')}${tick(2.6, '2.6')}</div>
      </div>
    </div>
    <p class="verdictline ${cl}">${txt}.</p>
    <div class="mvzones">
      <span>🟢 Đáy</span><div class="zchips">${ETH_BOTTOMS.map(([d, p, v]) => `<span class="zchip"><small>${d}</small> <b>${v.toFixed(2)}</b></span>`).join('')}</div>
      <span>🔴 Đỉnh</span><div class="zchips">${ETH_TOPS.map(([d, p, v]) => `<span class="zchip"><small>${d}</small> <b>${v.toFixed(2)}</b></span>`).join('')}</div>
    </div>
    <p class="hint">💡 ETH yếu hơn BTC: đỉnh MVRV giảm từ 2.6 xuống chỉ còn ~1.5 ở 2 lần đỉnh gần nhất, trong khi BTC vẫn lên được 2.3–2.4.
      Dùng ETH để xem <b>altcoin đang rẻ hay đắt</b>; còn quyết định mua bán chính vẫn theo MVRV của BTC.</p>
    <p class="muted small">Coin Metrics, giá vốn ngày ${bpDate(last.d)}${live ? '' : ' · giá ETH là giá đóng cửa ngày đó'}.</p>`;
}

// ---------- Chu kỳ halving + đường trung bình 200 tuần ----------
// Nến tuần BTCUSDT của Binance (từ 2017), tải mỗi giờ. Dùng chung cho tab Tay to và trang Tổng quan.
const bpWk = { at: 0, k: null, p: null };
function bpWeekly() {
  if (bpWk.k && Date.now() - bpWk.at < 3600e3) return Promise.resolve(bpWk.k);
  if (!bpWk.p) bpWk.p = getJson('https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1w&limit=320')
    .then((k) => { bpWk.k = k.map((x) => ({ t: x[0], c: +x[4] })); bpWk.at = Date.now(); return bpWk.k; })
    .finally(() => { bpWk.p = null; });
  return bpWk.p;
}
const CYC_TOP = Date.parse('2025-10-06'), CYC_DAY = 864e5, CYC_MON = 30.44;
function wmaState(btc) {
  const k = bpWk.k;
  if (!k || k.length < 210) return null;
  const c = k.map((x) => x.c), n = c.length - 1;
  if (btc) c[n] = btc; // nến tuần hiện tại: dùng giá trực tiếp
  const w = (i) => c.slice(i - 199, i + 1).reduce((a, b) => a + b, 0) / 200;
  let below = 0; // số nến tuần đã đóng dưới đường 200 tuần kể từ đỉnh 10/2025
  for (let i = 199; i < n; i++) if (k[i].t >= CYC_TOP && c[i] < w(i)) below++;
  return { wma: w(n), price: c[n], below };
}
// Mốc của các chu kỳ (giá đóng cửa ngày, Coin Metrics; đáy 2026 là giá thấp nhất trong ngày, chưa xác nhận).
const CYCLES = [
  { n: '2012–2016', h: '2012-11-28', top: '2013-12-04', tp: 1135, bot: '2015-01-14', bp: 176, wm: -9, next: '2016-07-09' },
  { n: '2016–2020', h: '2016-07-09', top: '2017-12-16', tp: 19641, bot: '2018-12-15', bp: 3185, wm: 0, next: '2020-05-11' },
  { n: '2020–2024', h: '2020-05-11', top: '2021-11-08', tp: 67542, bot: '2022-11-21', bp: 15778, wm: -34, next: '2024-04-20' },
  { n: '2024–2028', h: '2024-04-20', top: '2025-10-06', tp: 124824, bot: '2026-11-21', bp: 55130, now: true, next: '2028-04-15' },
];
const cycMon = (a, b) => (Date.parse(b) - Date.parse(a)) / CYC_DAY / CYC_MON;
// Tóm tắt dùng cho trang Tổng quan.
function cycleState() {
  return { fromTop: (Date.now() - CYC_TOP) / CYC_DAY / CYC_MON, toHalving: (Date.parse('2028-04-15') - Date.now()) / CYC_DAY / CYC_MON };
}
function bigCycle(btc) {
  const head = '<h2>⏳ Chu kỳ halving &amp; đường 200 tuần <span class="muted small">(đang ở đâu trong chu kỳ 4 năm)</span></h2>';
  const cs = cycleState(), wm = wmaState(btc);
  // Thanh thời gian: halving 4/2024 → cuối 2029.
  const t0 = Date.parse('2024-04-20'), t1 = Date.parse('2029-12-31');
  const x = (d) => Math.min(100, Math.max(0, ((typeof d === 'number' ? d : Date.parse(d)) - t0) / (t1 - t0) * 100)).toFixed(1) + '%';
  const mk = (d, label, cl) => `<span class="cymk ${cl}" style="left:${x(d)}"><i></i><small>${label}</small></span>`;
  const years = [2025, 2026, 2027, 2028, 2029].map((y) => `<span class="cyyr" style="left:${x(`${y}-01-01`)}">${y}</span>`).join('');
  const bar = `<div class="cybar">
      <span class="cyzone up" style="left:${x('2026-10-06')};width:calc(${x('2026-12-06')} - ${x('2026-10-06')})"></span>
      <span class="cyzone down" style="left:${x('2029-04-15')};width:calc(${x('2029-10-15')} - ${x('2029-04-15')})"></span>
      ${years}
      ${mk('2024-04-20', 'Halving 4/2024', 'first')}${mk('2025-10-06', 'Đỉnh 126K', 'down')}${mk('2026-11-21', 'Đáy? 55.1K', 'up')}
      ${mk('2028-04-15', 'Halving ~4/2028', '')}${mk(Date.now(), 'Hôm nay', 'now')}
    </div>
    <p class="cylegend small"><b class="muted">●</b> Halving 4/2024 · <b class="down">●</b> Đỉnh 126K (10/2025) · <b class="up">●</b> Đáy? 55.1K (11/2026) · <b>▮</b> Hôm nay · <b class="muted">●</b> Halving ~4/2028</p>
    <p class="muted small">Xanh: khung đáy theo lịch sử (12–14 tháng sau đỉnh). Đỏ: khung đỉnh tiếp theo nếu chu kỳ 4 năm còn đúng (12–18 tháng sau halving, khoảng 4–10/2029).</p>`;
  const rows = CYCLES.map((c) => `<tr class="${c.now ? 'mvnow' : ''}"><td>${c.n}</td>
      <td>${cycMon(c.h, c.top).toFixed(0)} tháng <small class="muted">${BP_FMT(c.tp)}</small></td>
      <td>${cycMon(c.top, c.bot).toFixed(1)} tháng <small class="muted">${BP_FMT(c.bp)}${c.now ? ' (tạm)' : ''}</small></td>
      <td>${c.now ? (wm ? `<b>${bpPct((wm.price / wm.wma - 1) * 100, 0)}</b> <small class="muted">hiện tại</small>` : '—') : `${c.wm > 0 ? '+' : c.wm < 0 ? '−' : ''}${Math.abs(c.wm)}%`}</td>
      <td>${c.now ? `~${cycMon(c.bot, c.next).toFixed(0)} tháng <small class="muted">dự kiến</small>` : `${cycMon(c.bot, c.next).toFixed(0)} tháng`}</td></tr>`).join('');
  const wmLine = wm
    ? `<p class="verdictline ${wm.price < wm.wma ? 'up' : ''}">Đường 200 tuần: <b>${BP_FMT(wm.wma)}</b>. Giá ${wm.price < wm.wma ? 'đang <b>dưới</b>' : 'đang trên'} đường này ${bpPct((wm.price / wm.wma - 1) * 100)}${wm.below ? `, đã ${wm.below} nến tuần đóng dưới kể từ đỉnh` : ''}.
        ${wm.price < wm.wma ? 'Lịch sử: giá dưới đường 200 tuần là vùng gom dài hạn; đóng tuần trở lại trên đường này là dấu hiệu chu kỳ tăng mới.' : ''}</p>`
    : '<p class="hint">Đang tải nến tuần…</p>';
  return head + `
    <p class="verdictline">Hôm nay là <b>tháng thứ ${cs.fromTop.toFixed(1)}</b> sau đỉnh 10/2025. Ba chu kỳ trước đáy đến sau 12–13.5 tháng, nên đáy 55.1K (21/11/2026) <b>khớp nhịp thời gian</b>. Còn khoảng ${cs.toHalving.toFixed(0)} tháng tới halving tiếp theo.</p>
    ${wmLine}
    ${bar}
    <div class="tablewrap"><table>
      <thead><tr><th>Chu kỳ</th><th>Halving → đỉnh</th><th>Đỉnh → đáy</th><th>Đáy so với đường 200 tuần</th><th>Đáy → halving sau</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <p class="hint">💡 Nhịp thời gian rất đều, nhưng mỗi chu kỳ chỉ có 3–4 lần lặp lại nên đây là <b>xác suất, không phải chắc chắn</b>. Đáy chỉ coi là xác nhận khi có thêm: đóng tuần trên 66.1K, MVRV giữ trên 1 suốt 30 ngày, hoặc đóng tuần lại trên đường 200 tuần.</p>
    <p class="muted small">Đường 200 tuần: trung bình giá đóng cửa 200 nến tuần BTCUSDT trên Binance, nến tuần hiện tại dùng giá trực tiếp. Mốc đỉnh, đáy theo giá đóng cửa ngày (Coin Metrics), riêng đáy 2026 là giá thấp nhất trong ngày. Ngày halving 2028 là ước tính.</p>`;
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
    <p class="muted small">Tổng BTC nằm trong các ví theo cỡ, 180 ngày gần nhất, số liệu ngày ${date ? bpDate(date) : ''}. Nguồn BGeometrics. Một tổ chức có thể có nhiều ví, và sàn hay gộp/tách ví, nên chỉ nên xem xu hướng tăng hay giảm, không xem từng ngày.</p>`;
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
    <p class="muted small">Tổng mọi sàn: Coin Metrics Community (CC BY-NC 4.0), số liệu hôm qua là số tạm tính. Từng sàn: số dư các ví sàn đã công khai, website tự chụp mỗi giờ (chuyển giữa ví sàn chưa theo dõi cũng bị tính là nạp/rút).</p>`;
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
// Bot ghi riêng mọi lệnh BTC từ 100K USD (hb/hs) kể từ 24/11/2026; ngày cũ hơn chưa có số này.
function bigOrders(history, sig) {
  const days = (history?.days || []).filter((d) => d.coins?.BTC?.hmin).slice(-14);
  const head = `<div class="row between"><h2>🐳 Lệnh BTC từ $100K trên Binance</h2><button class="ghost small" data-go="whale">Cá voi →</button></div>`;
  if (!days.length) return head + `<p class="hint">Bot bắt đầu ghi lệnh từ $100K từ ngày 24/11/2026. Số liệu sẽ hiện sau lần cập nhật kế tiếp (mỗi giờ).</p>`;
  const B = (d) => d.coins.BTC;
  const vals = days.map((d) => (B(d).hb || 0) - (B(d).hs || 0));
  const last7 = days.slice(-7);
  const sum = (k) => last7.reduce((s, d) => s + (B(d)[k] || 0), 0);
  const b7 = sum('hb'), s7 = sum('hs'), nb7 = sum('hnb'), ns7 = sum('hns');
  const today = B(days[days.length - 1]);
  const partial = today.hmin < 1380 ? ` <small class="muted">(đã ghi ${Math.floor(today.hmin / 60)} giờ ${today.hmin % 60} phút)</small>` : '';
  sig.push({ name: `Lệnh BTC từ $100K (${last7.length} ngày)`, score: b7 > s7 * 1.1 ? 1 : s7 > b7 * 1.1 ? -1 : 0,
    text: `Mua ${fmtUsdShort(b7)} (${nb7} lệnh) · bán ${fmtUsdShort(s7)} (${ns7} lệnh) trên Binance.` });
  return head + `
    <p class="hint">Hôm nay (từ 7:00)${partial}: mua <b class="up">${fmtUsdShort(today.hb || 0)}</b> (${today.hnb || 0} lệnh) · bán <b class="down">${fmtUsdShort(today.hs || 0)}</b> (${today.hns || 0} lệnh)</p>
    ${last7.length > 1 ? `<p class="hint">${last7.length} ngày: mua <b class="up">${fmtUsdShort(b7)}</b> · bán <b class="down">${fmtUsdShort(s7)}</b> → <b class="${cls(b7 - s7)}">${b7 >= s7 ? 'gom' : 'xả'} ${fmtUsdShort(Math.abs(b7 - s7))}</b></p>` : ''}
    ${days.length > 1 ? bigBars(vals, days.map((d) => bpDate(d.d))) : ''}
    <p class="muted small">Mọi lệnh khớp từ $100K trở lên trên Binance spot (BTC/USDT), chia theo bên chủ động mua hoặc bán, cộng theo nến ngày (7:00 sáng). Bot ghi từ 24/11/2026 nên lịch sử dài dần theo thời gian. Chỉ một sàn: tay to giao dịch ở sàn khác hoặc OTC thì không thấy.</p>`;
}

document.querySelector('.tab[data-tab="big"]').addEventListener('click', startBig);
setInterval(() => { if (!document.hidden && !$('#tab-big').hidden) startBig(); }, 5 * 60000);
if (location.hash === '#big') goTab('big');
