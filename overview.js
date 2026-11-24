'use strict';
// ---------- Tab Tổng quan: những gì quan trọng nhất trên 1 trang ----------
// Giá và lãi/lỗ: trực tiếp từ Binance (cùng nhịp 30 giây với tab Danh mục).
// Kịch bản Elliott BTC và kế hoạch bán/giữ 7 coin: data/status.json, GitHub Actions lấy từ bot Telegram mỗi giờ.
// Thị trường và lịch: các file data/*.json sẵn có + Fear & Greed.

const OV_NEAR = 5;          // cách vùng giá ≤ 5% thì đưa lên mục "Cần chú ý"
const OV_ELLIOTT_NEAR = 2;  // BTC cách mức Elliott ≤ 2%
const ov = { status: null, history: null, etf: null, onchain: null, calendar: null, unlocks: null, fng: null, t24: {}, at: 0, t24at: 0 };

const ovPx = (p) => p == null || !isFinite(p) ? '—' : p >= 1000 ? '$' + Math.round(p).toLocaleString('en-US') : fmtPrice(p);
const ovDist = (p, now) => (p / now - 1) * 100;
const ovPct = (n, d = 1) => (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(d) + '%';
const goTab = (tab) => document.querySelector(`.tab[data-tab="${tab}"]`)?.click();

// ---------- Tải dữ liệu ----------
async function ovLoad(force) {
  if (!force && Date.now() - ov.at < 5 * 60000) return;
  ov.at = Date.now();
  const get = (name) => loadData(name).catch(() => null);
  const [status, history, etf, onchain, calendar, unlocks, fng] = await Promise.all([
    get('status.json'), get('history.json'), get('etf.json'), get('onchain.json'), get('calendar.json'), get('unlocks.json'),
    loadFng().catch(() => null),
  ]);
  Object.assign(ov, { status, history, etf, onchain, calendar, unlocks, fng });
  renderOverview();
}

// Thay đổi 24h của BTC và các coin trong kế hoạch.
async function ovLoad24h() {
  if (!prices.BTC || Date.now() - ov.t24at < 60000) return; // chờ có danh sách cặp USDT từ tab Danh mục
  ov.t24at = Date.now();
  const coins = [...new Set(['BTC', ...ovPlan().map((c) => c.coin), ...ovHeld().map((h) => h.coin)])].filter((c) => c !== 'USDT' && prices[c]);
  try {
    const list = await getJson(`${SPOT_API}/ticker/24hr?type=MINI&symbols=${encodeURIComponent(JSON.stringify(coins.map((c) => c + 'USDT')))}`);
    for (const t of list) ov.t24[t.symbol.replace(/USDT$/, '')] = +t.openPrice ? (+t.lastPrice / +t.openPrice - 1) * 100 : null;
  } catch {
    // Một coin không có cặp USDT làm hỏng cả request: bỏ qua, lần sau thử lại.
  }
  renderOverview();
}

const ovPlan = () => ov.status?.plan || [];
const ovHeld = () => computeHoldings().filter((h) => h.qty > 0 && h.coin !== 'USDT');

// ---------- Render ----------
function renderOverview() {
  if (!$('#tab-overview')) return;
  const hs = computeHoldings();
  const btc = prices.BTC;
  const focus = [];
  renderOvSummary(hs);
  renderOvPlan(hs, focus);
  renderOvElliott(btc, focus);
  renderOvMarket(btc);
  renderOvUpcoming(hs, focus);
  renderOvFocus(focus);
}

function renderOvSummary(hs) {
  const held = hs.filter((h) => h.qty > 0);
  const cost = hs.reduce((s, h) => s + h.cost, 0);
  const value = hs.reduce((s, h) => s + (h.value ?? h.cost), 0);
  const realized = hs.reduce((s, h) => s + h.realized, 0);
  const pnl = value - cost;
  const ok = held.filter((h) => h.pnlPct != null).sort((a, b) => b.pnlPct - a.pnlPct);
  const best = ok[0], worst = ok[ok.length - 1];
  const btc = prices.BTC;
  // Hôm nay: giá trị danh mục thay đổi bao nhiêu theo % 24h của từng coin.
  let dayChg = 0, dayOk = false;
  for (const h of held) {
    const c = ov.t24[h.coin];
    if (c != null && h.value != null) { dayChg += h.value - h.value / (1 + c / 100); dayOk = true; }
  }
  const stats = [
    ['Vốn đang nắm giữ', fmtUsd(cost), '', `${held.length} coin`],
    ['Giá trị hiện tại', fmtUsd(value), '', btc ? `≈ ${(value / btc).toFixed(5)} BTC` : ''],
    ['Lãi/lỗ chưa chốt', `${fmtUsd(pnl)} <small>${fmtPct(cost ? pnl / cost * 100 : 0)}</small>`, cls(pnl),
      dayOk ? `24h: <span class="${cls(dayChg)}">${fmtUsd(dayChg)}</span>` : ''],
    ['Lãi/lỗ đã chốt', fmtUsd(realized), cls(realized), best && worst && best !== worst
      ? `Tốt nhất <b>${esc(best.coin)}</b> <span class="${cls(best.pnlPct)}">${fmtPct(best.pnlPct)}</span> · kém nhất <b>${esc(worst.coin)}</b> <span class="${cls(worst.pnlPct)}">${fmtPct(worst.pnlPct)}</span>` : ''],
  ];
  $('#ovSummary').innerHTML = held.length || realized ? stats.map(([l, v, c, sub]) =>
    `<div class="stat"><div class="label">${l}</div><div class="value ${c}">${v}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`).join('')
    : `<div class="stat"><div class="label">Danh mục</div><div class="value">Chưa có lệnh</div><div class="sub">Thêm lệnh ở tab Danh mục, hoặc bật ☁️ đồng bộ.</div></div>`;
}

// ---------- Kế hoạch 7 coin ----------
function renderOvPlan(hs, focus) {
  const el = $('#ovPlan');
  const plan = ovPlan();
  if (!plan.length) {
    el.innerHTML = `<h2>🧭 Kế hoạch từng coin</h2><p class="hint">${ov.at ? 'Chưa có dữ liệu kế hoạch từ bot (cập nhật mỗi giờ, thử lại sau).' : 'Đang tải…'}</p>`;
    return;
  }
  const byCoin = Object.fromEntries(hs.map((h) => [h.coin, h]));
  const row = (c) => {
    const now = prices[c.coin], h = byCoin[c.coin];
    const sell = c.mode === 'sell';
    const nextI = now ? c.levels.findIndex((p) => sell ? p > now : p < now) : -1;
    const chips = c.levels.map((p, i) => {
      const passed = now && (sell ? now >= p : now <= p);
      const st = passed ? 'in' : c.hit[i] ? 'hit' : i === nextI ? 'next' : '';
      const d = now ? ovDist(p, now) : null;
      return `<span class="zchip ${st}" title="${c.hit[i] ? 'Bot đã báo mức này' : ''}">
        <small>${sell ? 'Bán' : 'DCA'} ${i + 1}</small> <b>${fmtPrice(p)}</b>${passed ? ' ✓' : d != null ? ` <small>${ovPct(d)}</small>` : ''}</span>`;
    }).join('');
    const sd = now ? ovDist(c.stop, now) : null;
    const below = now && now < c.stop;
    const stop = `<span class="ovstop ${below ? 'down' : ''}">${sell ? 'Thủng đáy' : 'Cắt lỗ'} ${fmtPrice(c.stop)}${sd != null ? ` <small>(${ovPct(sd)})</small>` : ''}
      <small class="muted">${sell ? 'đóng nến ngày' : 'đóng nến tuần'}</small></span>`;
    let mine = '<span class="muted small">Bạn chưa nhập lệnh coin này</span>';
    if (h && h.qty > 0) {
      mine = `Bạn giữ <b>${fmtUsd(h.value ?? h.cost)}</b> <span class="${cls(h.pnl)}">${fmtPct(h.pnlPct)}</span>`;
      if (sell && now) {
        // Chia đều số lượng cho các vùng bán (giống tin bot: 2 vùng thì mỗi vùng một nửa).
        const left = c.levels.filter((p) => p > now);
        const sellAll = left.length ? h.qty * (c.levels.length - left.length) / c.levels.length * now + h.qty / c.levels.length * left.reduce((s, p) => s + p, 0) : h.qty * now;
        mine += ` · bán đủ các vùng ≈ <b>${fmtUsd(sellAll)}</b> <span class="${cls(sellAll - h.cost)}">${fmtPct((sellAll / h.cost - 1) * 100)}</span>`;
      }
    }
    const c24 = ov.t24[c.coin];
    // Mục "Cần chú ý".
    if (now) {
      if (sell && nextI === -1) focus.push({ pr: 1, icon: '💸', text: `<b>${c.coin}</b> đã lên vùng bán cuối (${fmtPrice(c.levels[c.levels.length - 1])}): bán nốt phần còn lại, chuyển sang BTC.` });
      else if (sell && nextI > 0 && c.levels[nextI - 1] <= now) focus.push({ pr: 1, icon: '💸', text: `<b>${c.coin}</b> đang ở vùng bán ${nextI} (${fmtPrice(c.levels[nextI - 1])}): nếu chưa bán thì bán phần này.` });
      else if (sell && nextI >= 0 && ovDist(c.levels[nextI], now) <= OV_NEAR) focus.push({ pr: 2, icon: '💸', text: `<b>${c.coin}</b> còn <b>${ovPct(ovDist(c.levels[nextI], now))}</b> tới vùng bán ${nextI + 1} (${fmtPrice(c.levels[nextI])}). Chuẩn bị bán.` });
      if (!sell && nextI === -1) focus.push({ pr: 2, icon: '🛒', text: `<b>${c.coin}</b> đang dưới mọi vùng DCA (thấp nhất ${fmtPrice(c.levels[c.levels.length - 1])}). Mua thêm rất ít, chú ý mức cắt lỗ ${fmtPrice(c.stop)}.` });
      else if (!sell && nextI > 0 && c.levels[nextI - 1] >= now) focus.push({ pr: 2, icon: '🛒', text: `<b>${c.coin}</b> đang ở vùng DCA ${nextI} (${fmtPrice(c.levels[nextI - 1])}): có thể mua thêm phần nhỏ.` });
      else if (!sell && nextI >= 0 && -ovDist(c.levels[nextI], now) <= OV_NEAR) focus.push({ pr: 3, icon: '🛒', text: `<b>${c.coin}</b> còn <b>${ovPct(ovDist(c.levels[nextI], now))}</b> tới vùng DCA ${nextI + 1} (${fmtPrice(c.levels[nextI])}).` });
      if (below) focus.push({ pr: 0, icon: sell ? '⚠️' : '🛑', text: `<b>${c.coin}</b> đang dưới ${sell ? 'mức thủng đáy' : 'mức cắt lỗ'} ${fmtPrice(c.stop)}. Nếu nến ${sell ? 'ngày' : 'tuần'} đóng dưới mức này: ${sell ? 'bán phần còn lại, không chờ hồi' : 'cân nhắc cắt lỗ chuyển sang BTC'}.` });
      else if (sd != null && sd > -OV_NEAR) focus.push({ pr: 1, icon: '⚠️', text: `<b>${c.coin}</b> chỉ còn ${ovPct(sd)} là chạm ${sell ? 'mức thủng đáy' : 'mức cắt lỗ'} ${fmtPrice(c.stop)}.` });
    }
    return { near: now && nextI >= 0 ? Math.abs(ovDist(c.levels[nextI], now)) : 999, html: `
      <div class="ovcoin" data-coin="${esc(c.coin)}">
        <div class="ovhead"><b class="ovname">${esc(c.coin)}</b> <span class="ovpx">${fmtPrice(now)}</span>
          ${c24 != null ? `<small class="${cls(c24)}">${ovPct(c24)} 24h</small>` : ''}</div>
        <div class="zchips">${chips}</div>
        <div class="ovfoot">${stop}<span class="ovmine">${mine}</span></div>
      </div>` };
  };
  const group = (mode) => plan.filter((c) => c.mode === mode).map(row).sort((a, b) => a.near - b.near).map((r) => r.html).join('');
  el.innerHTML = `
    <div class="row between wrap"><h2>🧭 Kế hoạch từng coin</h2><span class="muted small">Vùng giá cố định theo bot Telegram · bấm coin để xem Pivot</span></div>
    <h3 class="ovgroup">💸 Bán khi hồi, chuyển sang BTC</h3>${group('sell') || '<p class="hint">Không có.</p>'}
    <h3 class="ovgroup">🛒 Giữ, mua DCA từng phần nhỏ</h3>${group('keep') || '<p class="hint">Không có.</p>'}
    <p class="hint"><span class="zchip next"><small>vùng kế tiếp</small></span> <span class="zchip in">đang ở trong vùng ✓</span> <span class="zchip hit">bot đã báo</span>
      · % = giá cần đi thêm bao nhiêu để chạm vùng. Vùng bán chia đều số lượng (2 vùng: mỗi vùng một nửa).</p>`;
}

// ---------- Elliott BTC ----------
const OV_PHASE = {
  w4: ['↗️ Sóng 4: nhịp hồi', 'BTC đang hồi lên giữa đợt giảm sóng C. Hồi xong thường còn 1 nhịp giảm cuối (sóng 5).',
    'Altcoin: tận dụng nhịp hồi để bán các coin trong kế hoạch bán. Chưa nên mua mạnh.'],
  w5: ['🔻 Sóng 5: nhịp giảm cuối', 'Có thể sóng 4 đã xong, BTC đang đi xuống vùng mục tiêu của sóng 5.',
    'Altcoin thường giảm mạnh hơn BTC. Coin nào chưa bán nên cân nhắc bán. Vùng mục tiêu là nơi mua BTC dần.'],
  end: ['🟢 Có thể đã tạo đáy', 'BTC đã bật lên từ đáy, có thể sóng 5 và cả sóng C đã kết thúc. Đang chờ xác nhận.',
    'Có thể bắt đầu mua BTC từng phần. Xác nhận khi vượt đỉnh sóng 4.'],
  up: ['🚀 Cách đếm sai hướng lên', 'BTC đã vượt đáy sóng 1: nhiều khả năng sóng C đã kết thúc và đang vào xu hướng tăng.', 'Bot đã ngừng theo dõi kịch bản này.'],
  down: ['🛑 Cách đếm sai hướng xuống', 'BTC giảm sâu hơn dự kiến, đợt điều chỉnh lớn hơn.', 'Nên dừng mua và đánh giá lại. Bot đã ngừng theo dõi kịch bản này.'],
  done: ['✅ Sóng C đã kết thúc', 'Đã xác nhận đáy. Đợt điều chỉnh từ đỉnh 126K có thể đã xong.', 'Bot đã ngừng theo dõi kịch bản này.'],
};

function ovElliottLevels(e) {
  const ext = Object.fromEntries(e.ext.map((x) => [x.L, x.p]));
  const L = [];
  const add = (p, label, kind, hit) => { if (p) L.push({ p, label, kind, hit }); };
  add(e.w1, 'Đáy sóng 1 · vượt lên = cách đếm sai, có thể đã vào xu hướng tăng', 'inv');
  if (e.phase === 'w4') {
    for (const r of e.retr) add(r.p, `Fib ${r.L} hồi sóng 4` + (r.L === 0.382 ? ' · vùng sóng 4 hay dừng nhất' : r.L === 0.5 ? ' · mức hồi tối đa thường gặp' : r.L === 0.618 ? ' · hồi sâu bất thường' : ''), 'retr', r.hit);
    if (e.alt && e.alt > e.w3) add(e.alt, 'Dấu hiệu sớm: sóng C đã xong ở đáy sóng 3 (cách đếm phụ)', 'alt', e.hi > e.alt);
  }
  if (e.phase === 'w5' || e.phase === 'end') add(e.w4, e.phase === 'end' ? 'Đỉnh sóng 4 · vượt lên = xác nhận sóng C đã xong' : 'Đỉnh sóng 4 · vượt lại = sóng 4 chưa xong', 'retr');
  if (e.phase === 'end') add(e.w5, 'Đáy có thể của sóng 5 · thủng lại = sóng 5 chưa xong', 'base');
  add(e.w3, 'Đáy sóng 3 · giữ được = kịch bản 1, thủng = kịch bản 2', 'base');
  add(e.t1, `Kịch bản 1 · sóng 5 = sóng 1${e.assumed ? ' (ước tính)' : ''}`, 'tgt', e.lo != null && e.lo <= e.t1);
  if (e.phase !== 'w4') { add(ext[0.382], 'Kịch bản 2 · Fib 0.382 mở rộng', 'tgt', e.lo != null && e.lo <= ext[0.382]); add(ext[0.5], 'Kịch bản 2 · Fib 0.5 mở rộng', 'tgt', e.lo != null && e.lo <= ext[0.5]); }
  add(ext[0.618], `Kịch bản 2 · Fib 0.618 · mục tiêu chính, vùng mua mạnh nhất${e.assumed ? ' (ước tính)' : ''}`, 'tgt', e.lo != null && e.lo <= ext[0.618]);
  add(ext[0.786], 'Fib 0.786 · xuống dưới = cách đếm sai, điều chỉnh sâu hơn', 'inv');
  return L.sort((a, b) => b.p - a.p);
}

function renderOvElliott(btc, focus) {
  const el = $('#ovElliott');
  const e = ov.status?.elliott;
  const c24 = ov.t24.BTC;
  const head = `<div class="row between wrap"><h2>🌊 BTC theo sóng Elliott</h2>
    <span><b class="ovbtc">${ovPx(btc)}</b> ${c24 != null ? `<small class="${cls(c24)}">${ovPct(c24)} 24h</small>` : ''}</span></div>`;
  if (!e) { el.innerHTML = head + `<p class="hint">${ov.at ? 'Chưa có dữ liệu Elliott từ bot (cập nhật mỗi giờ, thử lại sau).' : 'Đang tải…'}</p>`; return; }
  const [title, what, todo] = OV_PHASE[e.phase] || [e.phase, '', ''];
  let rows = '';
  if (OV_PHASE[e.phase] && btc) {
    const lv = ovElliottLevels(e);
    let placed = false;
    const nowRow = `<div class="ewrow now"><span>▶ ${ovPx(btc)}</span><span>Giá hiện tại</span><span></span></div>`;
    for (const x of lv) {
      if (!placed && btc > x.p) { rows += nowRow; placed = true; }
      const d = ovDist(x.p, btc);
      rows += `<div class="ewrow ${x.kind} ${x.hit ? 'hit' : ''}"><span>${ovPx(x.p)}</span><span>${x.label}${x.hit ? ' ✓' : ''}</span><span class="${Math.abs(d) <= OV_ELLIOTT_NEAR ? 'warn' : 'muted'}">${ovPct(d)}</span></div>`;
      if (!x.hit && Math.abs(d) <= OV_ELLIOTT_NEAR && ['w4', 'w5', 'end'].includes(e.phase)) focus.push({ pr: 2, icon: '🌊', text: `BTC còn <b>${ovPct(d)}</b> tới ${ovPx(x.p)}: ${x.label.split(' · ')[0]}.` });
    }
    if (!placed) rows += nowRow;
  }
  const extra = e.phase === 'w4' ? `Đỉnh hồi cao nhất từ đáy: <b>${ovPx(e.hi)}</b> (${ovPct(ovDist(e.hi, e.w3))} từ đáy sóng 3).`
    : e.phase === 'w5' ? `Đỉnh sóng 4: <b>${ovPx(e.w4)}</b> · thấp nhất từ đó: <b>${ovPx(e.lo)}</b>.`
      : e.phase === 'end' ? `Đáy có thể của sóng 5: <b>${ovPx(e.w5)}</b>.` : '';
  // Kế hoạch mua BTC từng phần (bằng USDT bán altcoin).
  const bb = ov.status?.btcBuy;
  let buy = '';
  if (bb && btc) {
    const n = bb.levels.length;
    const nextI = bb.levels.findIndex((p) => p < btc);
    const chips = bb.levels.map((p, i) => {
      const inZone = btc <= p, d = ovDist(p, btc);
      return `<span class="zchip ${inZone ? 'in' : bb.hit[i] ? 'hit' : i === nextI ? 'next' : ''}"><small>Phần ${i + 1}</small> <b>${ovPx(p)}</b>${inZone ? ' ✓' : ` <small>${ovPct(d)}</small>`}</span>`;
    }).join('');
    const cd = bb.chase ? ovDist(bb.chase, btc) : null;
    buy = `<h3 class="ovgroup">🟠 Kế hoạch mua BTC từng phần</h3>
      ${bb.done ? '<p class="verdictline">✅ Nến tuần đã đóng trên mức xác nhận: mua nốt phần còn lại.</p>' : `<div class="zchips">${chips}</div>`}
      ${bb.chase && !bb.done ? `<p class="hint">Nến tuần đóng trên <b>${ovPx(bb.chase)}</b> (${ovPct(cd)}): mua nốt phần còn lại, không chờ vùng thấp. Bán altcoin xong thì giữ USDT, mua BTC chia ${n} phần theo các vùng này.</p>` : ''}`;
    if (!bb.done) {
      if (nextI > 0) focus.push({ pr: 1, icon: '🟠', text: `BTC đang ở vùng mua <b>phần ${nextI}</b> (${ovPx(bb.levels[nextI - 1])}): nếu chưa mua thì mua phần này.` });
      else if (nextI === -1) focus.push({ pr: 1, icon: '🟠', text: `BTC dưới mọi vùng mua (thấp nhất ${ovPx(bb.levels[n - 1])}). Nếu còn rơi mạnh thì dừng và đánh giá lại.` });
      else if (-ovDist(bb.levels[0], btc) <= 3) focus.push({ pr: 2, icon: '🟠', text: `BTC còn <b>${ovPct(ovDist(bb.levels[0], btc))}</b> tới vùng mua phần 1 (${ovPx(bb.levels[0])}).` });
      if (cd != null && cd > 0 && cd <= 3) focus.push({ pr: 2, icon: '👀', text: `BTC còn <b>${ovPct(cd)}</b> tới ${ovPx(bb.chase)}. Vượt thì chờ nến tuần đóng trên mức này để mua nốt.` });
      else if (cd != null && cd <= 0) focus.push({ pr: 1, icon: '👀', text: `BTC đang trên ${ovPx(bb.chase)}: nếu nến tuần (7:00 sáng thứ Hai) đóng trên mức này thì mua nốt phần BTC còn lại.` });
    }
  }
  el.innerHTML = head + `
    <div class="ewphase ${e.phase}"><b>${title}</b><div>${what}</div></div>
    <p class="verdictline">👉 ${todo}</p>
    ${extra ? `<p class="hint">${extra}</p>` : ''}
    ${buy}
    ${rows ? `<div class="ewlist">${rows}</div>` : ''}
    <p class="muted small">Sóng (0) ${ovPx(e.w0)} → (1) ${ovPx(e.w1)} → (2) ${ovPx(e.w2)} → (3) ${ovPx(e.w3)}. Fib thang log.
      ${e.assumed ? 'Mục tiêu sóng 5 đang ước tính theo giả định sóng 4 hồi tới Fib 0.382, sẽ tính lại khi có đỉnh thật. ' : ''}
      Trạng thái từ bot lúc ${fmtHm(ov.status.updated)} (mỗi giờ), % so với giá trực tiếp.</p>`;
}

// ---------- Thị trường ----------
function renderOvMarket(btc) {
  const lines = [];
  if (ov.fng?.length) {
    const v = ov.fng[0].v, i = fngInfo(v);
    const ago = (k, l) => ov.fng[k] ? `${l} ${ov.fng[k].v}` : '';
    lines.push(['😶', 'Tâm lý (Fear &amp; Greed)', `<b style="color:${i.color}">${v} · ${i.name}</b> <small class="muted">${[ago(1, 'hôm qua'), ago(7, '7 ngày trước')].filter(Boolean).join(' · ')}</small>`]);
  }
  const etf = (ov.etf?.coins?.BTC || []).filter((x) => x.total || Object.values(x.funds || {}).some((v) => v)); // bỏ phiên chưa có số
  if (etf?.length) {
    const last = etf[etf.length - 1], s5 = etf.slice(-5).reduce((s, x) => s + x.total, 0);
    lines.push(['🏦', 'Quỹ ETF BTC', `phiên ${last.d.slice(8, 10)}/${last.d.slice(5, 7)}: <b class="${cls(last.total)}">${etfM(last.total)}</b> · 5 phiên: <b class="${cls(s5)}">${etfM(s5)}</b>
      <small class="muted">${s5 > 0 ? 'tiền đang vào' : 'tiền đang rút'}</small>`]);
  }
  const oc = ov.onchain?.coins?.BTC;
  if (oc && oc.hours >= 1 && oc.reserve) {
    const net = oc.out24 - oc.in24;
    lines.push(['⛓️', `Ví sàn BTC ${oc.hours >= 23 ? '24h' : Math.round(oc.hours) + 'h'}`, `<b class="${cls(net)}">${net >= 0 ? 'rút ra' : 'nạp vào'} ${fmtBig(Math.abs(net))} BTC</b>
      <small class="muted">${net >= 0 ? 'thường là gom về ví' : 'thường là chuẩn bị bán'}</small>`]);
  }
  const day = ov.history?.days?.[ov.history.days.length - 1];
  if (day?.coins) {
    const b = day.coins.BTC;
    if (b && (b.b || b.s)) {
      const net = b.b - b.s;
      lines.push(['🐋', 'Lệnh lớn BTC hôm nay', `mua <b class="up">${fmtUsdShort(b.b)}</b> · bán <b class="down">${fmtUsdShort(b.s)}</b> → <b class="${cls(net)}">${net >= 0 ? 'gom' : 'xả'} ${fmtUsdShort(Math.abs(net))}</b>`]);
    }
    const mine = ovPlan().map((c) => c.coin).filter((c) => day.coins[c] && (day.coins[c].ab || day.coins[c].as));
    if (mine.length) lines.push(['💧', 'Dòng tiền coin của bạn hôm nay', `<span class="ovflows">${mine.map((c) => {
      const x = day.coins[c], net = x.ab - x.as;
      return `<span><b>${c}</b> <span class="${cls(net)}">${net >= 0 ? '+' : '−'}${fmtUsdShort(Math.abs(net))}</span></span>`;
    }).join('')}</span> <small class="muted">(mua chủ động − bán chủ động, Binance, từ 7:00)</small>`]);
  }
  $('#ovMarket').innerHTML = `<div class="row between"><h2>🌡 Thị trường</h2><button class="ghost small" data-go="whale">Cá voi →</button></div>` +
    (lines.length ? `<div class="ovkv">${lines.map(([i, l, v]) => `<span>${i}</span><span class="muted">${l}</span><span>${v}</span>`).join('')}</div>`
      : `<p class="hint">${ov.at ? 'Chưa tải được dữ liệu thị trường.' : 'Đang tải…'}</p>`);
}

// ---------- Sắp tới: tin kinh tế và unlock ----------
function renderOvUpcoming(hs, focus) {
  const now = Date.now(), items = [];
  const ev = (ov.calendar?.events || []).filter((e) => e.t > now - 3600e3 && e.t < now + 4 * 864e5).slice(0, 5);
  for (const e of ev) {
    const soon = e.t > now && e.t - now < 24 * 3600e3;
    items.push({ t: e.t, html: `<span>${CAL_ICON[e.kind] || '📌'}</span><span><b>${esc(e.vi)}</b> <small class="muted">${vnTimeOnly(e.t)} ${vnDay(e.t)}</small></span>
      <span class="calbadge ${soon ? 'hot' : ''}">${e.t > now ? countdown(e.t - now) : 'vừa ra'}</span>` });
    if (soon) focus.push({ pr: 3, icon: CAL_ICON[e.kind] || '📌', text: `Tin <b>${esc(e.vi)}</b> lúc ${vnTimeOnly(e.t)} (${countdown(e.t - now)}). Giá dễ giật mạnh hai chiều.` });
  }
  const fomc = (ov.calendar?.fomc || []).find((f) => f.t > now);
  if (fomc && fomc.t - now < 14 * 864e5) items.push({ t: fomc.t, html: `<span>🏦</span><span><b>Họp Fed (FOMC)</b> <small class="muted">${vnTimeOnly(fomc.t)} ${vnDay(fomc.t)}</small></span><span class="calbadge">${countdown(fomc.t - now)}</span>` });
  // Unlock của coin trong kế hoạch hoặc đang giữ, 30 ngày tới.
  const coins = new Set([...ovPlan().map((c) => c.coin), ...hs.filter((h) => h.qty > 0).map((h) => h.coin)]);
  for (const c of coins) {
    const u = ov.unlocks?.coins?.[c];
    const e = u?.events?.find((x) => x.t * 1000 > now && x.t * 1000 - now < 30 * 864e5);
    if (!e) continue;
    const pct = e.tokens / u.circ * 100, days = Math.ceil((e.t * 1000 - now) / 864e5);
    const big = pct >= 1;
    items.push({ t: e.t * 1000, html: `<span>${big ? '🔥' : '🔓'}</span><span><b>Unlock ${esc(c)}</b> ${fmtBig(e.tokens)} <small class="${big ? 'down' : 'muted'}">(${pct.toFixed(2)}% lưu hành)</small>
      <small class="muted">${fmtDate(e.t)}</small></span><span class="calbadge ${days <= 7 && pct >= 0.5 ? 'hot' : ''}">còn ${days} ngày</span>` });
    if (days <= 7 && pct >= 0.5) focus.push({ pr: 2, icon: '🔓', text: `<b>${esc(c)}</b> mở khóa ${pct.toFixed(2)}% lưu hành sau ${days} ngày: lượng bán mới có thể đè giá.` });
  }
  items.sort((a, b) => a.t - b.t);
  $('#ovUpcoming').innerHTML = `<h2>📅 Sắp tới</h2>` + (items.length
    ? `<div class="ovkv">${items.map((x) => x.html).join('')}</div><p class="muted small">Tin mạnh của Mỹ trong 4 ngày tới (giờ Việt Nam) và unlock 30 ngày tới của coin bạn theo dõi.</p>`
    : `<p class="hint">${ov.at ? 'Không có tin mạnh hay unlock đáng kể sắp tới.' : 'Đang tải…'}</p>`);
}

// ---------- Cần chú ý ----------
function renderOvFocus(focus) {
  const el = $('#ovFocus');
  if (!Object.keys(prices).length) { el.innerHTML = '<h2>📌 Cần chú ý</h2><p class="hint">Đang tải giá…</p>'; return; }
  const list = focus.sort((a, b) => a.pr - b.pr).slice(0, 8);
  el.classList.toggle('calm', !list.length);
  el.innerHTML = `<h2>📌 Cần chú ý</h2>` + (list.length
    ? `<div class="ovfocus">${list.map((f) => `<div><span>${f.icon}</span><span>${f.text}</span></div>`).join('')}</div>`
    : `<p class="verdictline">✅ Chưa có coin nào gần vùng bán, vùng DCA hay mức cắt lỗ. Cứ giữ kế hoạch, bot sẽ nhắn Telegram khi giá chạm.</p>`);
}

// ---------- Sự kiện ----------
$('#tab-overview').addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) { goTab(go.dataset.go); return; }
  const c = e.target.closest('.ovcoin[data-coin]');
  if (c) { pv.coin = c.dataset.coin; goTab('pivot'); window.scrollTo({ top: 0 }); }
});
document.querySelector('.tab[data-tab="overview"]').addEventListener('click', () => { ovLoad(); ovLoad24h(); });
setInterval(() => { if (!document.hidden && !$('#tab-overview').hidden) { ovLoad(); ovLoad24h(); } }, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#tab-overview').hidden) { ovLoad(); ovLoad24h(); } });

if (location.hash === '#portfolio') goTab('portfolio');
renderOverview();
ovLoad(true).then(ovLoad24h);
