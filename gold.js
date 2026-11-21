'use strict';
// Tab "Vàng": dùng các hàm chung từ app.js (fmt*, cls, esc, $) và whale.js (getJson, flowRow, sparkline, loadData...).
// Nguồn: Binance Futures XAUUSDT (giá, funding, long/short, lệnh lớn), CFTC (báo cáo COT), FRED (lợi suất thực, chỉ số USD).

const G_SYM = 'XAUUSDT';
const G_WS = 'wss://fstream.binance.com/market/ws/xauusdt@aggTrade';
const OZ_PER_TONNE = 32150.7;
const GC_OZ = 100; // 1 hợp đồng vàng COMEX = 100 ounce

const g = {
  started: false, timer: null, ws: null, min: 100000, price: null,
  big: { buy: 0, sell: 0, nBuy: 0, nSell: 0, since: null, started: Date.now() },
  sig: {},
};

const G_SIGNALS = [
  ['cot', 'Quỹ đầu cơ (COT)'], ['yield', 'Lợi suất thực Mỹ'], ['usd', 'Chỉ số đô la Mỹ'],
  ['flow', 'Dòng tiền 1h/4h/24h'], ['oi', 'Giá & Open Interest'], ['ls', 'Top trader futures'], ['big', 'Lệnh lớn'],
];

function startGold() {
  if (g.started) return;
  g.started = true;
  g.min = Math.max(10000, +$('#gMin').value || 100000);
  ['#gSummary', '#gScore', '#gPrice', '#gCot', '#gMacro', '#gFut', '#gBigStats'].forEach((s) => { $(s).innerHTML = '<span class="muted small">Đang tải…</span>'; });
  renderGoldScore();
  connectGoldStream();
  backfillGoldTrades();
  refreshGold();
  g.timer = setInterval(() => { if (!document.hidden && !$('#tab-gold').hidden) refreshGold(); }, 30000);
}

function refreshGold() {
  loadGoldPrice();
  loadGoldFutures();
  loadGoldData();
  scoreGoldBig();
  if (typeof refreshCalendar === 'function') refreshCalendar(); // lịch tin Mỹ (market.js)
}

// ---------- Tổng hợp tín hiệu ----------
// short: câu ngắn gọn cho ô tóm tắt ở đầu tab.
function setGoldSignal(key, score, text, short) {
  g.sig[key] = { score, text, short };
  renderGoldScore();
}

function renderGoldScore() {
  const done = G_SIGNALS.filter(([k]) => g.sig[k] && !g.sig[k].pending && !g.sig[k].na);
  const total = done.reduce((s, [k]) => s + g.sig[k].score, 0);
  const verdict = done.length < 3 ? ['Đang thu thập dữ liệu…', 'muted']
    : total >= 3 ? ['📈 Vàng có lực TĂNG', 'up']
    : total === 2 ? ['Nghiêng về tăng', 'up']
    : total <= -3 ? ['📉 Vàng chịu áp lực GIẢM', 'down']
    : total === -2 ? ['Nghiêng về giảm', 'down']
    : ['Chưa rõ xu hướng, tín hiệu trái chiều', 'muted'];
  const icon = (sg) => !sg ? '…' : sg.na ? '➖' : sg.pending ? '⏳' : sg.score > 0 ? '🟢' : sg.score < 0 ? '🔴' : '⚪';
  const rows = G_SIGNALS.map(([k, name]) => {
    const sg = g.sig[k];
    const pts = sg && !sg.pending && !sg.na ? `<b class="${cls(sg.score)}">${sg.score > 0 ? '+1' : sg.score < 0 ? '−1' : '0'}</b>` : '<span></span>';
    return `<div class="sig"><span>${icon(sg)}</span><b>${name}</b><span class="muted">${sg ? sg.text : 'Đang tải…'}</span>${pts}</div>`;
  }).join('');
  $('#gScore').innerHTML = `
    <div class="scorehead">
      <span class="scorenum ${cls(total)}">${total > 0 ? '+' : ''}${total}<small class="muted">/${done.length}</small></span>
      <span class="verdict ${verdict[1]}">${verdict[0]}</span>
    </div>
    ${rows}
    <p class="hint">Mỗi tiêu chí +1 (ủng hộ tăng), −1 (ủng hộ giảm) hoặc 0. Từ +3 trở lên là tăng rõ, từ −3 trở xuống là giảm rõ.
      Tham khảo cho xu hướng vài ngày đến vài tuần, không phải tín hiệu vào lệnh.</p>`;
  renderGoldSummary();
}

// ---------- Ô tóm tắt dễ hiểu ở đầu tab ----------
function renderGoldSummary() {
  const ok = (k) => g.sig[k] && !g.sig[k].pending && !g.sig[k].na;
  const sc = (keys) => keys.filter(ok).reduce((s, k) => s + g.sig[k].score, 0);
  const why = (keys) => keys.filter((k) => ok(k) && g.sig[k].short).map((k) => g.sig[k].short).join(' · ') || 'Đang tải…';
  const mid = sc(['cot', 'yield', 'usd']);
  const now = sc(['flow', 'oi', 'big']);
  const ready = ['cot', 'yield', 'usd', 'flow', 'oi'].filter(ok).length >= 3;

  const H = (c, title, sub) => ({ c, title, sub });
  const head = !ready ? H('muted', '⏳ Đang tải dữ liệu…', 'Chờ vài giây.')
    : mid >= 1 && now >= 1 ? H('up', '📈 Xu hướng TĂNG', 'Tiền lớn lẫn lực mua hôm nay đều nghiêng về tăng.')
    : mid <= -1 && now <= -1 ? H('down', '📉 Xu hướng GIẢM', 'Tiền lớn lẫn lực bán hôm nay đều nghiêng về giảm.')
    : mid >= 1 && now <= -1 ? H('warn', '⏸ Trung hạn TĂNG, hôm nay đang bị bán', 'Tiền lớn vẫn nghiêng mua, nhưng hôm nay bên bán mạnh hơn. Thường chờ lực bán yếu đi rồi mới tính mua.')
    : mid <= -1 && now >= 1 ? H('warn', '⏸ Trung hạn GIẢM, hôm nay đang hồi', 'Hôm nay có lực mua, nhưng bức tranh lớn nghiêng giảm. Cẩn thận mua đuổi.')
    : mid >= 1 ? H('up', '↗️ Nghiêng TĂNG', 'Tiền lớn nghiêng mua, hôm nay chưa rõ bên nào thắng.')
    : mid <= -1 ? H('down', '↘️ Nghiêng GIẢM', 'Tiền lớn nghiêng bán, hôm nay chưa rõ bên nào thắng.')
    : now >= 1 ? H('up', '↗️ Hôm nay nghiêng TĂNG', 'Chỉ là lực mua ngắn hạn, bức tranh lớn chưa rõ.')
    : now <= -1 ? H('down', '↘️ Hôm nay nghiêng GIẢM', 'Chỉ là lực bán ngắn hạn, bức tranh lớn chưa rõ.')
    : H('muted', '⚖️ CHƯA RÕ xu hướng', 'Các tín hiệu trái chiều nhau. Lúc này nên quan sát thêm hoặc giảm khối lượng.');

  const state = (v, pos, neg, zero) => v > 0 ? ['🟢', pos, 'up'] : v < 0 ? ['🔴', neg, 'down'] : ['⚪', zero, 'muted'];
  const loading = ['⏳', 'ĐANG TẢI', 'muted'];
  const pend = (keys) => keys.every((k) => !ok(k));
  const row = (what, st, reason) => `<div class="light"><span class="dot">${st[0]}</span>
    <span class="what">${what}</span><span class="state ${st[2]}">${st[1]}</span><span class="why">${reason}</span></div>`;

  $('#gSummary').innerHTML = `
    <div class="gtop">
      <div><span class="muted small">Giá vàng XAU/USD</span><br>
        <span class="gprice">${g.price ? fmtPrice(g.price) : '…'}</span>
        ${g.chg != null ? `<b class="${cls(g.chg)}">${fmtPct(g.chg)} 24h</b>` : ''}</div>
    </div>
    <div class="headline ${head.c}">${head.title}<small>${head.sub}</small></div>
    <div class="lights">
      ${row(`💼 Quỹ lớn <small class="muted">(${g.cot ? `số liệu ${fmtDateIso(g.cot.date).slice(0, 5)}` : 'theo tuần'})</small>`,
        pend(['cot']) ? loading : state(sc(['cot']), 'ĐÃ MUA', 'ĐÃ BÁN', 'ĐỨNG IM'),
        why(['cot']) + (g.cot?.close && g.price ? ` · giá từ hôm đó <b class="${cls(g.price - g.cot.close)}">${fmtPct((g.price - g.cot.close) / g.cot.close * 100)}</b>` : ''))}
      ${row('🌎 Vĩ mô <small class="muted">(lãi suất, USD)</small>', pend(['yield', 'usd']) ? loading : state(sc(['yield', 'usd']), 'THUẬN LỢI', 'BẤT LỢI', 'TRUNG TÍNH'), why(['yield', 'usd']))}
      ${row('⚡ Hôm nay <small class="muted">(ngắn hạn)</small>', pend(['flow', 'oi']) ? loading : state(now, 'BÊN MUA MẠNH', 'BÊN BÁN MẠNH', 'GIẰNG CO'), why(['flow', 'oi', 'big']))}
      ${row('🦈 Cá mập Binance', pend(['ls']) ? loading : state(sc(['ls']), 'TĂNG MUA', 'GIẢM MUA', 'CHƯA RÕ'), why(['ls']))}
    </div>
    <p class="muted small">Quỹ lớn và vĩ mô cho biết xu hướng vài tuần, "Hôm nay" cho biết lực mua bán trong ngày.
      Số liệu quỹ lớn (COT) là của ngày thứ Ba, công bố tối thứ Sáu, nên luôn trễ vài ngày so với giá.</p>
    <p class="muted small">
      Tham khảo, không phải lời khuyên đầu tư. Bấm "Xem chi tiết" bên dưới để xem số liệu.</p>`;
}

// ---------- Giá ----------
async function loadGoldPrice() {
  try {
    const [t, paxg, k] = await Promise.all([
      getJson(`${FAPI}/ticker/24hr?symbol=${G_SYM}`),
      getJson(`${SPOT_API}/ticker/price?symbol=PAXGUSDT`).catch(() => null),
      getJson(`${FAPI}/klines?symbol=${G_SYM}&interval=15m&limit=96`),
    ]);
    g.price = +t.lastPrice;
    const chg = +t.priceChangePercent;
    g.chg = chg;
    renderGoldSummary();
    $('#gPrice').innerHTML = `
      <div class="goldprice">
        <div><span class="muted small">XAU/USD (Binance Futures)</span>
          <b class="big">${fmtPrice(g.price)}</b>
          <span class="${cls(chg)}">${fmtPct(chg)} <small>(${chg >= 0 ? '+' : ''}${(+t.priceChange).toFixed(2)})</small> 24h</span></div>
        <div class="kv">
          <span>Cao / thấp 24h</span><b>${fmtPrice(+t.highPrice)} / ${fmtPrice(+t.lowPrice)}</b>
          <span>Khối lượng 24h</span><b>${fmtUsdShort(+t.quoteVolume)}</b>
          ${paxg ? `<span>PAXG (vàng token, spot)</span><b>${fmtPrice(+paxg.price)}</b>` : ''}
        </div>
      </div>
      ${sparkline(k.map((c) => +c[4]))}
      <p class="muted small">Giá XAUUSD trên Exness có thể lệch vài USD so với Binance do mỗi nơi lấy giá từ nguồn khác nhau.</p>`;
  } catch {
    $('#gPrice').innerHTML = '<span class="down small">Không tải được giá vàng.</span>';
  }
}

// ---------- Futures XAUUSDT: funding, OI, long/short, dòng tiền ----------
async function loadGoldFutures() {
  const q = `symbol=${G_SYM}&period=1h&limit=24`;
  try {
    const [pi, oi, top, all, k] = await Promise.all([
      getJson(`${FAPI}/premiumIndex?symbol=${G_SYM}`),
      getJson(`${FUT_API}/openInterestHist?${q}`),
      getJson(`${FUT_API}/topLongShortPositionRatio?${q}`),
      getJson(`${FUT_API}/globalLongShortAccountRatio?${q}`).catch(() => []),
      getJson(`${FAPI}/klines?symbol=${G_SYM}&interval=5m&limit=288`),
    ]);
    // Dòng tiền chủ động: [7] tổng quote volume, [10] phần do bên mua chủ động.
    const sum = (n) => k.slice(-n).reduce((a, c) => { a.buy += +c[10]; a.sell += +c[7] - +c[10]; return a; }, { buy: 0, sell: 0 });
    const wins = [[12, '1 giờ'], [48, '4 giờ'], [288, '24 giờ']].map(([n, l]) => ({ l, ...sum(n) }));
    const pcts = wins.map((x) => x.buy / (x.buy + x.sell || 1) * 100);
    const vote = pcts.reduce((v, p) => v + (p > 51 ? 1 : p < 49 ? -1 : 0), 0);
    setGoldSignal('flow', vote >= 2 ? 1 : vote <= -2 ? -1 : 0,
      `Mua chủ động ${pcts.map((p) => p.toFixed(0) + '%').join(' / ')}. ` +
      (vote >= 2 ? 'Phe mua mạnh hơn ở đa số khung.' : vote <= -2 ? 'Phe bán mạnh hơn ở đa số khung.' : 'Các khung trái chiều.'),
      vote >= 2 ? 'Lệnh mua áp đảo' : vote <= -2 ? 'Lệnh bán áp đảo' : 'Mua bán ngang nhau');

    const rate = +pi.lastFundingRate * 100;
    const oiNow = +oi[oi.length - 1].sumOpenInterestValue, oiChg = (oiNow - +oi[0].sumOpenInterestValue) / +oi[0].sumOpenInterestValue * 100;
    const long = +top[top.length - 1].longAccount * 100;
    const ratio = +top[top.length - 1].longShortRatio, prev = +top[0].longShortRatio;
    const crowd = all.length ? +all[all.length - 1].longAccount * 100 : null;
    const chg = (ratio - prev) / prev * 100;
    let v = chg >= 3 ? 1 : chg <= -3 ? -1 : 0;
    if (crowd != null) v += long - crowd >= 8 ? 1 : crowd - long >= 8 ? -1 : 0;
    setGoldSignal('ls', Math.max(-1, Math.min(1, v)),
      `Top trader long ${long.toFixed(0)}%${crowd != null ? `, đám đông ${crowd.toFixed(0)}%` : ''}, tỷ lệ L/S ${fmtPct(chg)} trong 24h.`,
      `Tài khoản lớn ${chg >= 3 ? 'tăng' : chg <= -3 ? 'giảm' : 'giữ'} vị thế mua (${long.toFixed(0)}% đang long)`);

    // Giá và Open Interest 24h: tiền mới đang mở lệnh về phía nào.
    const pChg = (+k[k.length - 1][4] - +k[0][1]) / +k[0][1] * 100;
    const [oiScore, oiShort] = oiChg >= 2 && pChg >= 0.3 ? [1, 'Tiền mới đang mở lệnh MUA']
      : oiChg >= 2 && pChg <= -0.3 ? [-1, 'Tiền mới đang mở lệnh BÁN (short)']
      : oiChg <= -2 && pChg >= 0.3 ? [0, 'Giá tăng do phe bán đóng lệnh, dễ hụt hơi']
      : oiChg <= -2 && pChg <= -0.3 ? [0, 'Phe mua cắt lỗ, lực giảm có thể sắp hết']
      : [0, 'Ít tiền mới vào'];
    setGoldSignal('oi', oiScore, `Giá ${fmtPct(pChg)}, Open Interest ${fmtPct(oiChg)} trong 24h. ${oiShort}.`, oiShort);

    $('#gFut').innerHTML = `
      ${wins.map((x) => flowRow(x.l, x.buy, x.sell)).join('')}
      <p class="hint">24h: mua chủ động <b class="up">${fmtUsdShort(wins[2].buy)}</b> · bán chủ động <b class="down">${fmtUsdShort(wins[2].sell)}</b> ·
        ròng <b class="${cls(wins[2].buy - wins[2].sell)}">${fmtUsdShort(wins[2].buy - wins[2].sell)}</b></p>
      <div class="flow"><span>Top</span><div class="bar"><span style="width:${long}%"></span></div>
        <span class="verdict"><span class="up">${long.toFixed(1)}%</span> / <span class="down">${(100 - long).toFixed(1)}%</span></span></div>
      ${crowd != null ? `<div class="flow"><span>Tất cả</span><div class="bar"><span style="width:${crowd}%"></span></div>
        <span class="verdict"><span class="up">${crowd.toFixed(1)}%</span> / <span class="down">${(100 - crowd).toFixed(1)}%</span></span></div>` : ''}
      <div class="kv">
        <span>Funding hiện tại</span><b class="${cls(rate)}">${rate.toFixed(4)}%</b>
        <span>Open Interest</span><b>${fmtUsdShort(oiNow)} <small class="${cls(oiChg)}">${fmtPct(oiChg)} 24h</small></b>
      </div>
      <p class="muted small">Đây là thị trường hợp đồng vàng trên Binance (có khớp lệnh công khai), nhỏ hơn nhiều so với thị trường vàng thế giới
        nên chỉ phản ánh tâm lý của trader crypto.</p>`;
  } catch {
    $('#gFut').innerHTML = '<span class="down small">Không tải được dữ liệu futures vàng.</span>';
  }
}

// ---------- COT + vĩ mô (file data/gold.json do GitHub Actions tạo mỗi giờ) ----------
async function loadGoldData() {
  let d;
  try { d = await loadData('gold.json'); } catch {
    ['cot', 'yield', 'usd'].forEach((k) => { g.sig[k] = { na: true, text: 'Chưa có dữ liệu (đang được tạo).' }; });
    renderGoldScore();
    $('#gCot').innerHTML = $('#gMacro').innerHTML = '<span class="muted small">Chưa có dữ liệu (đang được tạo, thử lại sau ít phút).</span>';
    return;
  }
  renderCot(d);
  renderMacro(d);
}

function renderCot(d) {
  const weeks = d.cot || [];
  if (weeks.length < 2) {
    g.sig.cot = { na: true, text: 'Chưa lấy được báo cáo COT.' };
    renderGoldScore();
    $('#gCot').innerHTML = '<p class="hint">Chưa lấy được báo cáo COT từ CFTC. Bạn có thể xem trực tiếp trên trang CFTC (link bên dưới).</p>';
    return;
  }
  const net = (x) => x.mmL - x.mmS;
  const cur = weeks[weeks.length - 1], prev = weeks[weeks.length - 2];
  const nNow = net(cur), dNet = nNow - net(prev);
  const year = weeks.slice(-52).map(net);
  const lo = Math.min(...year), hi = Math.max(...year);
  const rank = hi > lo ? (nNow - lo) / (hi - lo) * 100 : 50; // vị trí trong 1 năm: 0% thấp nhất, 100% cao nhất
  const tonnes = (c) => (c * GC_OZ / OZ_PER_TONNE).toFixed(0);
  const pct = Math.abs(net(prev)) ? dNet / Math.abs(net(prev)) * 100 : 0;
  let text = `Tuần ${fmtDateIso(cur.date)}: net long ${fmtBig(nNow)} hợp đồng (${dNet >= 0 ? '+' : ''}${fmtBig(dNet)} so với tuần trước). `;
  let score = pct >= 5 ? 1 : pct <= -5 ? -1 : 0;
  text += score > 0 ? 'Quỹ đang mua thêm.' : score < 0 ? 'Quỹ đang bán bớt.' : 'Thay đổi nhỏ.';
  if (rank >= 90) text += ' Vị thế mua gần mức cao nhất 1 năm, dễ chốt lời.';
  if (rank <= 10) text += ' Vị thế mua gần mức thấp nhất 1 năm, dư địa mua lại lớn.';
  setGoldSignal('cot', score, text, score > 0 ? `Quỹ mua thêm ~${tonnes(Math.abs(dNet))} tấn tuần qua`
    : score < 0 ? `Quỹ bán bớt ~${tonnes(Math.abs(dNet))} tấn tuần qua` : 'Quỹ gần như giữ nguyên vị thế');
  // Báo cáo COT là số liệu của ngày thứ Ba (trễ vài ngày): lấy giá đóng cửa hôm đó để so với giá bây giờ.
  if (g.cot?.date !== cur.date) {
    g.cot = { date: cur.date, close: null };
    const t = Date.parse(cur.date + 'T00:00:00Z');
    getJson(`${FAPI}/klines?symbol=${G_SYM}&interval=1d&startTime=${t}&limit=1`)
      .then((k) => { if (k[0] && k[0][0] === t && g.cot.date === cur.date) { g.cot.close = +k[0][4]; renderGoldSummary(); } })
      .catch(() => {});
  }

  const row = (name, L, S, hint) => `<tr><td><b>${name}</b><br><small class="muted">${hint}</small></td>
    <td class="up">${fmtBig(L)}</td><td class="down">${fmtBig(S)}</td><td class="${cls(L - S)}"><b>${L - S >= 0 ? '+' : '-'}${fmtBig(Math.abs(L - S))}</b></td></tr>`;
  $('#gCot').innerHTML = `
    <p class="hint">Báo cáo ngày <b>${fmtDateIso(cur.date)}</b> (số liệu thứ Ba, CFTC công bố chiều thứ Sáu). Open Interest ${fmtBig(cur.oi)} hợp đồng.</p>
    <div class="tablewrap"><table>
      <thead><tr><th>Nhóm</th><th>Mua (long)</th><th>Bán (short)</th><th>Ròng</th></tr></thead>
      <tbody>
        ${row('Quỹ đầu cơ', cur.mmL, cur.mmS, 'Managed Money: "cá mập" của vàng')}
        ${isFinite(cur.pmL) ? row('Nhà sản xuất, thương nhân', cur.pmL, cur.pmS, 'Mỏ vàng, nhà kim hoàn: phòng hộ') : ''}
        ${isFinite(cur.swL) ? row('Ngân hàng (swap dealer)', cur.swL, cur.swS, 'Thường đứng phía ngược lại') : ''}
      </tbody></table></div>
    <p class="hint">Quỹ đầu cơ net long <b class="${cls(nNow)}">${fmtBig(nNow)}</b> hợp đồng ≈ <b>${tonnes(nNow)} tấn</b> vàng ·
      tuần này <b class="${cls(dNet)}">${dNet >= 0 ? '+' : '-'}${fmtBig(Math.abs(dNet))}</b> (≈ ${tonnes(Math.abs(dNet))} tấn) ·
      đang ở mức <b>${rank.toFixed(0)}%</b> so với dải 1 năm (0% thấp nhất, 100% cao nhất)</p>
    <h3 class="small">Net long của quỹ đầu cơ, ${year.length} tuần</h3>
    ${sparkline(year)}`;
}

function seriesChange(series, back) {
  const last = series[series.length - 1], old = series[Math.max(0, series.length - 1 - back)];
  return { date: last[0], now: last[1], old: old[1], diff: last[1] - old[1] };
}

function renderMacro(d) {
  let html = '';
  if (d.realYield?.length > 21) {
    const c = seriesChange(d.realYield, 21); // ~1 tháng giao dịch
    setGoldSignal('yield', c.diff <= -0.1 ? 1 : c.diff >= 0.1 ? -1 : 0,
      `${c.now.toFixed(2)}%, ${c.diff >= 0 ? '+' : ''}${c.diff.toFixed(2)} điểm trong 1 tháng. ` +
      (c.diff <= -0.1 ? 'Đang giảm: tốt cho vàng.' : c.diff >= 0.1 ? 'Đang tăng: bất lợi cho vàng.' : 'Đi ngang.'),
      c.diff <= -0.1 ? 'Lãi suất thực giảm' : c.diff >= 0.1 ? 'Lãi suất thực tăng' : 'Lãi suất thực đi ngang');
    html += `<div class="kv"><span>Lợi suất thực 10 năm (TIPS)</span>
      <b>${c.now.toFixed(2)}% <small class="${cls(-c.diff)}">${c.diff >= 0 ? '+' : ''}${c.diff.toFixed(2)} / 1 tháng</small></b></div>
      ${sparkline(d.realYield.slice(-130).map((x) => x[1]))}
      <p class="hint">Vàng không trả lãi. Khi lợi suất thực (lãi suất trừ lạm phát) tăng, giữ trái phiếu hấp dẫn hơn nên vàng thường giảm, và ngược lại.</p>`;
  } else { g.sig.yield = { na: true, text: 'Chưa có dữ liệu.' }; }
  if (d.dollar?.length > 21) {
    const c = seriesChange(d.dollar, 21);
    const p = c.diff / c.old * 100;
    setGoldSignal('usd', p <= -1 ? 1 : p >= 1 ? -1 : 0,
      `${c.now.toFixed(2)}, ${fmtPct(p)} trong 1 tháng. ` + (p <= -1 ? 'USD yếu đi: tốt cho vàng.' : p >= 1 ? 'USD mạnh lên: bất lợi cho vàng.' : 'Đi ngang.'),
      p <= -1 ? 'USD yếu đi' : p >= 1 ? 'USD mạnh lên' : 'USD đi ngang');
    html += `<div class="kv"><span>Chỉ số đô la Mỹ (Fed, rổ tiền tệ)</span>
      <b>${c.now.toFixed(2)} <small class="${cls(-p)}">${fmtPct(p)} / 1 tháng</small></b></div>
      ${sparkline(d.dollar.slice(-130).map((x) => x[1]))}
      <p class="hint">Vàng định giá bằng USD. USD mạnh lên thì vàng thường giảm, USD yếu đi thì vàng thường tăng.</p>`;
  } else { g.sig.usd = { na: true, text: 'Chưa có dữ liệu.' }; }
  renderGoldScore();
  $('#gMacro').innerHTML = (html || '<span class="muted small">Chưa có dữ liệu.</span>') +
    `<p class="muted small">Nguồn FRED (Cục Dự trữ Liên bang St. Louis), cập nhật mỗi ngày làm việc · biểu đồ 6 tháng.</p>`;
}

const fmtDateIso = (s) => s.split('-').reverse().join('/');

// ---------- Lệnh lớn realtime (XAUUSDT futures) ----------
function connectGoldStream() {
  if (g.ws) { g.ws.onclose = null; g.ws.close(); }
  const ws = new WebSocket(G_WS);
  g.ws = ws;
  $('#gLive').textContent = 'Đang kết nối…';
  ws.onopen = () => { $('#gLive').innerHTML = '<span class="up">● Live</span>'; };
  ws.onmessage = (e) => {
    const t = JSON.parse(e.data);
    onGoldTrade({ price: +t.p, qty: +t.q, time: t.T, sell: t.m }, true);
  };
  ws.onclose = () => {
    $('#gLive').innerHTML = '<span class="down">● Mất kết nối, đang thử lại…</span>';
    setTimeout(() => { if (g.ws === ws) connectGoldStream(); }, 3000);
  };
}

async function backfillGoldTrades() {
  try {
    const list = await getJson(`${FAPI}/aggTrades?symbol=${G_SYM}&limit=1000`);
    for (const t of list) onGoldTrade({ price: +t.p, qty: +t.q, time: t.T, sell: t.m }, false);
  } catch {}
  renderGoldBig();
}

function onGoldTrade(t, live) {
  const value = t.price * t.qty;
  if (g.big.since == null || t.time < g.big.since) g.big.since = t.time;
  if (value < g.min) return;
  if (t.sell) { g.big.sell += value; g.big.nSell++; } else { g.big.buy += value; g.big.nBuy++; }
  const tb = $(t.sell ? '#gFeedSell tbody' : '#gFeedBuy tbody');
  const tr = document.createElement('tr');
  if (live) tr.className = 'new';
  tr.innerHTML = `<td>${new Date(t.time).toLocaleTimeString('vi-VN')} ${value >= g.min * 5 ? '🐋' : '🦈'}</td>
    <td>${fmtPrice(t.price)}</td><td class="${t.sell ? 'down' : 'up'}"><b>${fmtUsd(value)}</b></td>`;
  tb.prepend(tr);
  while (tb.rows.length > FEED_MAX) tb.lastElementChild.remove();
  if (live) { renderGoldBig(); scoreGoldBig(); }
}

function renderGoldBig() {
  const b = g.big;
  $('#gBuyTotal').innerHTML = `${fmtUsd(b.buy)} <small class="muted">· ${b.nBuy} lệnh</small>`;
  $('#gSellTotal').innerHTML = `${fmtUsd(b.sell)} <small class="muted">· ${b.nSell} lệnh</small>`;
  const since = b.since ? new Date(b.since).toLocaleTimeString('vi-VN') : '—';
  $('#gBigStats').innerHTML = b.buy + b.sell ? bigRow('Tổng', b.buy, b.sell, (Date.now() - Math.min(b.started, b.since || b.started)) / 60000) +
    `<p class="hint">Từ ${since} · ròng <b class="${cls(b.buy - b.sell)}">${b.buy - b.sell >= 0 ? '+' : ''}${fmtUsd(b.buy - b.sell)}</b></p>`
    : `<p class="hint">Chưa có lệnh ≥ ${fmtUsd(g.min).replace('.00', '')} kể từ ${since}.</p>`;
}

function scoreGoldBig() {
  const b = g.big, n = b.nBuy + b.nSell;
  const minutes = (Date.now() - Math.min(b.started, b.since || b.started)) / 60000;
  if (minutes < BIG_MIN_MINUTES || n < 3) {
    g.sig.big = { pending: true, text: `Đang theo dõi ${Math.floor(Math.min(minutes, 999))} phút, ${n} lệnh ≥ ${fmtUsd(g.min).replace('.00', '')}. Cần ít nhất ${BIG_MIN_MINUTES} phút và 3 lệnh.` };
    return renderGoldScore();
  }
  const pct = b.buy / (b.buy + b.sell) * 100;
  setGoldSignal('big', pct >= 60 ? 1 : pct <= 40 ? -1 : 0, `${Math.floor(minutes)} phút qua: mua ${pct.toFixed(0)}% / bán ${(100 - pct).toFixed(0)}% (${n} lệnh).`,
    pct >= 60 ? 'Lệnh lớn nghiêng mua' : pct <= 40 ? 'Lệnh lớn nghiêng bán' : 'Lệnh lớn hai bên ngang nhau');
}

$('#gApply').addEventListener('click', () => {
  g.min = Math.max(10000, +$('#gMin').value || 100000);
  $('#gMin').value = g.min;
  g.big = { buy: 0, sell: 0, nBuy: 0, nSell: 0, since: null, started: Date.now() };
  $('#gFeedBuy tbody').innerHTML = $('#gFeedSell tbody').innerHTML = '';
  backfillGoldTrades();
  scoreGoldBig();
});

// Mở thẳng tab vàng bằng link .../#gold
if (location.hash === '#gold') document.querySelector('.tab[data-tab="gold"]').click();
