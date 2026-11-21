'use strict';
// Các tính năng bổ sung cho tab Cá voi (dùng biến/hàm chung từ app.js và whale.js: $, w, getJson, SPOT_API, fmt*, cls, esc).
// Được whale.js gọi qua startMarket(coin) khi đổi coin và refreshMarket(coin) mỗi 30 giây.

const MK_FAPI = 'https://fapi.binance.com/fapi/v1';
const mk = { coin: null, cvdFrame: '1d', cvdMarket: 'spot' };

function startMarket(coin) {
  mk.coin = coin;
  $('#wCvd').innerHTML = '<span class="muted small">Đang tải…</span>';
  startLiq(coin);
}

function refreshMarket(coin) {
  if (mk.coin !== coin) startMarket(coin);
  loadCvd(coin);
}

// ---------- CVD: dòng tiền chủ động cộng dồn ----------
// Mỗi nến: CVD tăng thêm (mua chủ động − bán chủ động) = 2 × taker buy quote volume − quote volume.
const CVD_FRAMES = {
  '1d': { interval: '15m', limit: 96, label: '24 giờ', flat: 0.5 },
  '7d': { interval: '1h', limit: 168, label: '7 ngày', flat: 1.5 },
  '30d': { interval: '4h', limit: 180, label: '30 ngày', flat: 3 },
};

$('#wCvdOpts').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.frame) mk.cvdFrame = b.dataset.frame;
  if (b.dataset.market) mk.cvdMarket = b.dataset.market;
  $('#wCvdOpts').querySelectorAll('button').forEach((x) => x.classList.toggle('active',
    x.dataset.frame ? x.dataset.frame === mk.cvdFrame : x.dataset.market === mk.cvdMarket));
  if (mk.coin) loadCvd(mk.coin);
});

async function loadCvd(coin) {
  const f = CVD_FRAMES[mk.cvdFrame], market = mk.cvdMarket;
  const base = market === 'futures' ? MK_FAPI : SPOT_API;
  try {
    const k = await getJson(`${base}/klines?symbol=${coin}USDT&interval=${f.interval}&limit=${f.limit}`);
    if (mk.coin !== coin || mk.cvdMarket !== market || CVD_FRAMES[mk.cvdFrame] !== f) return;
    let cvd = 0, vol = 0;
    const pts = [{ t: k[0][0], price: +k[0][1], cvd: 0 }];
    for (const c of k) {
      cvd += 2 * +c[10] - +c[7];
      vol += +c[7];
      pts.push({ t: Math.min(c[6] + 1, Date.now()), price: +c[4], cvd });
    }
    renderCvd(pts, vol, f, market);
  } catch {
    $('#wCvd').innerHTML = market === 'futures'
      ? `<span class="muted small">${esc(coin)} chưa có hợp đồng futures USDT trên Binance. Chọn Spot.</span>`
      : '<span class="down small">Không tải được dữ liệu.</span>';
  }
}

// Đọc ý nghĩa: so hướng đi của giá với hướng đi của CVD.
function cvdVerdict(chg, net, vol, flat) {
  const netPct = net / (vol || 1) * 100;
  const p = chg >= flat ? 1 : chg <= -flat ? -1 : 0;
  const c = netPct >= 1 ? 1 : netPct <= -1 ? -1 : 0;
  if (p > 0 && c > 0) return ['up', '✅ Giá tăng nhờ lực mua chủ động. Xu hướng tăng khỏe.'];
  if (p < 0 && c < 0) return ['down', '⚠️ Giá giảm do bán chủ động áp đảo. Xu hướng giảm thật, chưa có dấu hiệu tạo đáy.'];
  if (p < 0 && c >= 0) return ['down', '🧱 Mua chủ động nhiều nhưng giá vẫn giảm: bên bán lớn đang xả bằng lệnh chờ, hấp thụ hết lực mua. Thường là dấu hiệu yếu, nên chờ CVD và giá cùng quay lên.'];
  if (p > 0 && c <= 0) return ['up', '🛡 Bán chủ động nhiều nhưng giá vẫn tăng: có người gom bằng lệnh chờ, đỡ hết lực bán. Thường là dấu hiệu tốt.'];
  if (c > 0) return ['up', '🟡 Giá đi ngang trong khi mua chủ động nhiều hơn: có thể đang được gom, nhưng cũng có người bán chặn phía trên.'];
  if (c < 0) return ['down', '🟡 Giá đi ngang trong khi bán chủ động nhiều hơn: có người đỡ giá bên dưới, cần xem phe nào bỏ cuộc trước.'];
  return ['muted', 'Giá và dòng tiền đều đi ngang, chưa có tín hiệu rõ.'];
}

function renderCvd(pts, vol, f, market) {
  const W = 600, H = 200, PAD = 6;
  const n = pts.length, x = (i) => (i / (n - 1) * W).toFixed(1);
  const cs = pts.map((p) => p.cvd), ps = pts.map((p) => p.price);
  const cMin = Math.min(0, ...cs), cMax = Math.max(0, ...cs), cSpan = cMax - cMin || 1;
  const pMin = Math.min(...ps), pMax = Math.max(...ps), pSpan = pMax - pMin || 1;
  const yc = (v) => (PAD + (cMax - v) / cSpan * (H - 2 * PAD)).toFixed(1);
  const yp = (v) => (PAD + (pMax - v) / pSpan * (H - 2 * PAD)).toFixed(1);
  const zero = yc(0);
  const cvdLine = pts.map((p, i) => `${x(i)},${yc(p.cvd)}`).join(' ');
  const priceLine = pts.map((p, i) => `${x(i)},${yp(p.price)}`).join(' ');
  const area = `0,${zero} ${cvdLine} ${W},${zero}`;

  const first = pts[0], last = pts[n - 1];
  const chg = (last.price - first.price) / first.price * 100;
  const [vcls, vtext] = cvdVerdict(chg, last.cvd, vol, f.flat);
  const tfmt = (t) => new Date(t).toLocaleString('vi-VN', f.interval === '15m'
    ? { hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const sUsd = (v) => (v >= 0 ? '+' : '') + fmtUsdShort(v);

  $('#wCvd').innerHTML = `
    <div class="cvdbox">
      <svg class="cvd" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <defs>
          <clipPath id="cvdUp"><rect x="0" y="0" width="${W}" height="${zero}"/></clipPath>
          <clipPath id="cvdDn"><rect x="0" y="${zero}" width="${W}" height="${H - zero}"/></clipPath>
        </defs>
        <polygon points="${area}" fill="var(--up)" opacity=".22" clip-path="url(#cvdUp)"/>
        <polygon points="${area}" fill="var(--down)" opacity=".22" clip-path="url(#cvdDn)"/>
        <line x1="0" x2="${W}" y1="${zero}" y2="${zero}" stroke="var(--muted)" stroke-dasharray="3 4" vector-effect="non-scaling-stroke"/>
        <polyline points="${cvdLine}" fill="none" stroke="${last.cvd >= 0 ? 'var(--up)' : 'var(--down)'}" stroke-width="2" vector-effect="non-scaling-stroke"/>
        <polyline points="${priceLine}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/>
        <line class="cvdcross" x1="0" x2="0" y1="0" y2="${H}" stroke="var(--muted)" vector-effect="non-scaling-stroke" style="display:none"/>
      </svg>
      <div class="cvdtip" hidden></div>
    </div>
    <div class="row between small muted"><span>${tfmt(first.t)}</span><span>${tfmt(last.t)}</span></div>
    <div class="legend cvdlegend">
      <span><i style="background:var(--accent)"></i>Giá ${fmtPrice(last.price)} <b class="${cls(chg)}">${fmtPct(chg)}</b> trong ${f.label}</span>
      <span><i style="background:${last.cvd >= 0 ? 'var(--up)' : 'var(--down)'}"></i>CVD <b class="${cls(last.cvd)}">${sUsd(last.cvd)}</b>
        ${last.cvd >= 0 ? '(mua chủ động nhiều hơn)' : '(bán chủ động nhiều hơn)'} · ${market === 'futures' ? 'Futures' : 'Spot'} Binance</span>
    </div>
    <p class="verdictline ${vcls}">${vtext}</p>
    <p class="hint">CVD đi lên = người mua chủ động (khớp lệnh ngay) nhiều hơn người bán chủ động. Đặt cạnh đường giá để biết phe nào thật sự thắng:
      cùng chiều là xu hướng thật, ngược chiều là có người lớn đứng phía bên kia bằng lệnh chờ.</p>`;

  // Chạm/rê chuột để xem giá trị từng thời điểm.
  const box = $('#wCvd .cvdbox'), svg = box.querySelector('svg'), cross = box.querySelector('.cvdcross'), tip = box.querySelector('.cvdtip');
  const show = (clientX) => {
    const r = svg.getBoundingClientRect();
    const i = Math.max(0, Math.min(n - 1, Math.round((clientX - r.left) / r.width * (n - 1))));
    const p = pts[i];
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.style.display = '';
    tip.hidden = false;
    tip.innerHTML = `${tfmt(p.t)}<br>Giá <b>${fmtPrice(p.price)}</b><br>CVD <b class="${cls(p.cvd)}">${sUsd(p.cvd)}</b>`;
    const left = (i / (n - 1)) * r.width;
    tip.style.left = Math.min(Math.max(left - tip.offsetWidth / 2, 0), r.width - tip.offsetWidth) + 'px';
  };
  const hide = () => { cross.style.display = 'none'; tip.hidden = true; };
  svg.addEventListener('pointermove', (e) => show(e.clientX));
  svg.addEventListener('pointerdown', (e) => show(e.clientX));
  svg.addEventListener('pointerleave', hide);
}

// ---------- Thanh lý (liquidation) realtime ----------
// Luồng !forceOrder@arr của Binance Futures: lệnh bị sàn đóng cưỡng bức vì hết ký quỹ.
// S = SELL nghĩa là sàn bán ra để đóng vị thế LONG (Long bị thanh lý); S = BUY là Short bị thanh lý.
// Lưu ý: Binance chỉ gửi tối đa 1 lệnh thanh lý mỗi giây cho mỗi cặp, nên con số là mẫu, thường thấp hơn thực tế.
const LIQ_WS = 'wss://fstream.binance.com/market/ws/!forceOrder@arr';
const LIQ_FEED_MAX = 60;
const LIQ_MARKET_MIN = 50000; // danh sách toàn thị trường chỉ hiện lệnh từ 50K USD
const liq = {
  ws: null, since: null, coin: null,
  coinSum: { long: 0, short: 0, nLong: 0, nShort: 0 }, all: { long: 0, short: 0, nLong: 0, nShort: 0 },
  coinFeed: [], allFeed: [], timer: null,
};

function startLiq(coin) {
  liq.coin = coin;
  liq.coinSum = { long: 0, short: 0, nLong: 0, nShort: 0 };
  liq.coinFeed = [];
  liq.coinSince = Date.now();
  if (!liq.ws) connectLiq();
  renderLiq();
}

function connectLiq() {
  const ws = new WebSocket(LIQ_WS);
  liq.ws = ws;
  liq.since ||= Date.now();
  ws.onopen = () => renderLiq();
  ws.onmessage = (e) => {
    const o = JSON.parse(e.data).o;
    if (!o || !o.s.endsWith('USDT')) return;
    const value = +o.ap * +o.z, isLong = o.S === 'SELL', coin = o.s.slice(0, -4);
    const item = { coin, value, isLong, price: +o.ap, time: o.T };
    const add = (sum) => { if (isLong) { sum.long += value; sum.nLong++; } else { sum.short += value; sum.nShort++; } };
    add(liq.all);
    if (value >= LIQ_MARKET_MIN) { liq.allFeed.unshift(item); liq.allFeed.length = Math.min(liq.allFeed.length, LIQ_FEED_MAX); }
    if (coin === liq.coin) { add(liq.coinSum); liq.coinFeed.unshift(item); liq.coinFeed.length = Math.min(liq.coinFeed.length, LIQ_FEED_MAX); }
    // Gộp các lần vẽ lại (thanh lý hàng loạt có thể tới nhiều tin mỗi giây).
    liq.timer ||= setTimeout(() => { liq.timer = null; renderLiq(); }, 500);
  };
  ws.onclose = () => {
    if (liq.ws !== ws) return;
    liq.ws = null;
    renderLiq('Mất kết nối, đang thử lại…');
    setTimeout(() => { if (!liq.ws) connectLiq(); }, 3000);
  };
}

function liqRow(label, s) {
  const total = s.long + s.short, pct = total ? s.long / total * 100 : 50;
  return `<div class="flow liqflow"><span>${label}</span>
    <div class="bar liqbar${total ? '' : ' empty'}" title="Long ${pct.toFixed(0)}% / Short ${(100 - pct).toFixed(0)}%"><span style="width:${pct}%"></span></div>
    <span class="verdict small"><b class="down">${fmtUsdShort(s.long)}</b> / <b class="up">${fmtUsdShort(s.short)}</b></span></div>`;
}

function liqVerdict(s, name) {
  const total = s.long + s.short;
  if (total < 1000) return `Chưa có thanh lý đáng kể của ${name}.`;
  const pct = s.long / total * 100;
  if (pct >= 65) return `💥 Phe <b class="down">LONG bị quét</b> là chính (${pct.toFixed(0)}%): giá đang bị đạp xuống, người dùng đòn bẩy mua lên bị cháy tài khoản. Sau đợt quét lớn, giá hay hồi lại vì lực bán cưỡng bức đã hết.`;
  if (pct <= 35) return `💥 Phe <b class="up">SHORT bị quét</b> là chính (${(100 - pct).toFixed(0)}%): giá bị đẩy lên, người bán khống bị buộc mua lại (short squeeze), giá có thể tăng vọt ngắn hạn.`;
  return 'Long và Short bị thanh lý khá cân bằng: giá giật hai chiều.';
}

function liqFeed(list, showCoin) {
  if (!list.length) return '<p class="muted small">Chưa có lệnh nào.</p>';
  return `<table class="liqtable"><tbody>${list.map((x) => `<tr>
    <td>${new Date(x.time).toLocaleTimeString('vi-VN')}</td>
    ${showCoin ? `<td><b>${esc(x.coin)}</b></td>` : ''}
    <td class="${x.isLong ? 'down' : 'up'}">${x.isLong ? 'Long cháy' : 'Short cháy'}</td>
    <td>${fmtPrice(x.price)}</td>
    <td class="${x.isLong ? 'down' : 'up'}"><b>${fmtUsdShort(x.value)}</b></td></tr>`).join('')}</tbody></table>`;
}

function renderLiq(status) {
  const el = $('#wLiq');
  if (!el || !liq.coin) return;
  const t = (ms) => new Date(ms).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  $('#wLiqLive').innerHTML = status ? `<span class="down">● ${status}</span>`
    : liq.ws?.readyState === 1 ? '<span class="up">● Live</span>' : 'Đang kết nối…';
  const c = liq.coinSum;
  el.innerHTML = `
    ${liqRow(esc(liq.coin), c)}
    ${liqRow('Toàn thị trường', liq.all)}
    <p class="hint"><b class="down">Đỏ = Long bị thanh lý</b> · <b class="up">Xanh = Short bị thanh lý</b>.
      ${esc(liq.coin)} từ ${t(liq.coinSince)} (${c.nLong + c.nShort} lệnh), toàn thị trường từ ${t(liq.since)} (${liq.all.nLong + liq.all.nShort} lệnh).</p>
    <p class="verdictline">${liqVerdict(c.long + c.short >= 1000 ? c : liq.all, c.long + c.short >= 1000 ? esc(liq.coin) : 'toàn thị trường')}</p>
    <div class="grid2 liqgrid">
      <div><h3 class="small">${esc(liq.coin)}</h3><div class="tablewrap feed">${liqFeed(liq.coinFeed, false)}</div></div>
      <div><h3 class="small">Toàn thị trường <span class="muted">(từ ${fmtUsdShort(LIQ_MARKET_MIN)})</span></h3><div class="tablewrap feed">${liqFeed(liq.allFeed, true)}</div></div>
    </div>
    <p class="hint">Chỉ tính từ lúc mở trang. Binance chỉ gửi tối đa 1 lệnh thanh lý mỗi giây cho mỗi cặp, nên con số thực tế thường lớn hơn.
      Coin không có futures trên Binance sẽ không có thanh lý.</p>`;
}

// Nếu tab Cá voi đã khởi động trước khi file này tải xong (VD: mở link #whale=BTC), bắt kịp ngay.
if (w.started && w.coin) refreshMarket(w.coin);
