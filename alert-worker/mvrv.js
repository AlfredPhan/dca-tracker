// Cảnh báo MVRV của BTC (giá hiện tại ÷ giá vốn trung bình của mọi người đang giữ BTC).
// Cấu hình trong wrangler.toml: MVRV_ALERT = "mức_gom,...:mức_chốt_lời,..." (VD "1,0.9:1.8,2,2.3"). Đặt "0" để tắt.
//   Giá giảm tới MVRV mức gom  -> vùng tay to gom trong lịch sử (đáy 2015: 0.56, 2018: 0.69, 2022: 0.75).
//   Giá tăng tới MVRV mức chốt -> vùng tay to chốt lời (đỉnh 11/2021: 2.85, 3/2024: 2.75, 10/2025: 2.29).
//   Phân kỳ: giá đóng cửa ngày cao nhất 365 ngày nhưng MVRV thấp hơn đỉnh MVRV trước đó -> tay to có thể đang xả dần.
// Giá vốn trung bình (Realized Price) lấy từ Coin Metrics Community API, mỗi ngày 1 lần lúc 11:00 sáng giờ VN.

const KEY = 'mvrv:btc';
const DAY = 86400e3;
const CM = 'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics';
const HEAD = '📏 <b>MVRV BTC</b>';
const fmt = (p) => '$' + Math.round(p).toLocaleString('en-US');
// Lời khuyên theo từng mốc chốt lời (đỉnh MVRV thấp dần qua mỗi chu kỳ, chu kỳ này dự kiến 2.0–2.3).
const sellNote = (L) => L < 2
  ? 'Vùng <b>chốt altcoin</b>: altcoin thường đạt đỉnh trước BTC, nên chốt dần alt (30–50%), BTC vẫn giữ.'
  : L < 2.3 ? 'Vùng tay to <b>bắt đầu chốt lời BTC</b> (dự kiến đỉnh chu kỳ này 2.0–2.3). Chốt BTC từng phần, chốt phần lớn altcoin còn lại.'
  : L < 2.5 ? 'Vùng <b>chốt lời mạnh</b>: đỉnh 10/2025 có MVRV 2.29–2.41. Chốt mạnh BTC, altcoin nên chốt xong.'
  : '<b>Mức tối đa của kế hoạch</b>: đã vượt đỉnh MVRV chu kỳ 2025 (2.41). Chốt nốt, phần còn lại là lộc.';

export function parseMvrv(s) {
  const [a, b] = String(s || '').split(':');
  const nums = (x) => (x || '').split(',').map(Number).filter((v) => v > 0);
  const buy = nums(a).sort((x, y) => y - x), sell = nums(b).sort((x, y) => x - y);
  return buy.length || sell.length ? { buy, sell } : null;
}

// 400 ngày gần nhất: giá vốn hôm qua + dữ liệu để kiểm tra phân kỳ.
async function loadCm(end) {
  const start = new Date(end - 400 * DAY).toISOString().slice(0, 10);
  const res = await fetch(`${CM}?assets=btc&metrics=CapMVRVCur,PriceUSD&frequency=1d&start_time=${start}&page_size=1000`);
  if (!res.ok) throw new Error('Coin Metrics HTTP ' + res.status);
  const rows = ((await res.json()).data || []).map((r) => ({ d: r.time.slice(0, 10), p: +r.PriceUSD, m: +r.CapMVRVCur })).filter((r) => r.p > 0 && r.m > 0);
  if (!rows.length) throw new Error('Coin Metrics: không có dữ liệu');
  return rows;
}

// Phân kỳ: ngày cuối là giá đóng cửa cao nhất 365 ngày, MVRV từ 2 trở lên (giai đoạn cuối thị trường tăng) nhưng thấp hơn đỉnh MVRV trước ít nhất 5%.
export function divergence(rows) {
  const last = rows[rows.length - 1];
  const prev = rows.slice(-366, -1);
  if (prev.length < 200 || last.m < 2) return null;
  const maxP = Math.max(...prev.map((r) => r.p));
  const top = prev.reduce((a, b) => (b.m > a.m ? b : a));
  if (last.p > maxP && last.m < top.m * 0.95) return { last, top };
  return null;
}

// Kế hoạch theo MVRV (rút ra từ các thị trường giảm 2011–2023), tính theo giá đóng cửa ngày:
//   1 = đỡ giá giai đoạn đầu (MVRV ≥ 1): 2014, 2018 đỡ nhiều lần ở 1.1–1.3 rồi vẫn thủng.
//   2 = thủng giá vốn (MVRV < 1): bắt đầu vùng tạo đáy.
//   3 = vùng đáy lịch sử (MVRV < 0.9): đáy thật 2015/2018/2022 ở 0.56–0.75, giá nằm vùng 0.8–1 khoảng 100–230 ngày.
//   4 = xác nhận đáy: sau ít nhất 30 ngày dưới 1, MVRV quay lại và giữ trên 1 suốt 30 ngày (giống 5/2019, 2/2023).
//       Kiểm tra lịch sử: giữ 7 hay 14 ngày từng báo sai (7/2015, 8/2022); giữ 30 ngày thì sau khi báo giá chỉ giảm thêm 2–7% (trừ 2012).
export function mvrvPhase(rows) {
  const iTop = rows.reduce((b, r, i) => (r.p > rows[b].p ? i : b), 0);
  const cyc = rows.slice(iTop);
  const below = cyc.filter((r) => r.m < 1).length;
  const last = rows[rows.length - 1], prev = rows[rows.length - 2] || last;
  const held = rows.slice(-30).every((r) => r.m >= 1);
  const stage = below >= 30 && held ? 4 : last.m < 0.9 ? 3 : last.m < 1 ? 2 : 1;
  return {
    stage, below, last, prev,
    broke: last.m < 1 && prev.m >= 1,
    deep: last.m < 0.9 && prev.m >= 0.9,
    back: below >= 30 && last.m >= 1 && prev.m < 1,
    confirm: below >= 30 && held && (rows[rows.length - 31]?.m ?? 1) < 1,
  };
}

function phaseLines(ph, real) {
  const L = [];
  const zone = `${fmt(real * 0.75)}–${fmt(real * 0.9)}`;
  if (ph.confirm) L.push(`✅ <b>Giai đoạn 4: xác nhận đáy</b>. MVRV giữ trên 1 suốt 30 ngày sau ${ph.below} ngày dưới giá vốn chung, giống 5/2019 và 2/2023 khi thị trường tăng mới bắt đầu. Mua nốt phần BTC còn lại, không chờ giá về thấp nữa.`);
  else if (ph.back) L.push(`🟢 MVRV đóng cửa ngày <b>quay lại trên 1</b> (${ph.last.m.toFixed(2)}) sau ${ph.below} ngày dưới giá vốn chung. Chờ giữ được 30 ngày liên tục để xác nhận đáy (lịch sử từng có lần quay lại trên 1 rồi rơi tiếp: 7/2015, 8/2022).`);
  if (ph.deep) L.push(`🟢 <b>Giai đoạn 3: vùng đáy lịch sử</b>. Nến ngày đóng ở MVRV ${ph.last.m.toFixed(2)} (dưới 0.9). Đáy thật 2015, 2018, 2022 nằm ở MVRV 0.56–0.75, giá thường dao động vùng 0.75–0.9 (≈ ${zone}) nhiều tháng. Mua BTC phần 3, 4 từng chút, kiên nhẫn.`);
  else if (ph.broke) L.push(`📉 <b>Giai đoạn 2: thủng giá vốn chung</b>. Nến ngày đóng ở MVRV ${ph.last.m.toFixed(2)} (BTC ${fmt(ph.last.p)}, giá vốn ${fmt(real)}). Vùng 1.1 đỡ giá nhiều lần đã thủng, giống 11/2018 và 6/2022.\n` +
    `Lịch sử: đáy thật thường ở MVRV 0.75–0.9 (≈ ${zone}), giá nằm vùng 0.8–1 khoảng 100–230 ngày. Mua BTC từng phần theo kế hoạch, không dồn hết một lần.`);
  return L;
}

export async function mvrvCheck({ storage, getJson, host, end, cfgStr }) {
  const cfg = parseMvrv(cfgStr);
  if (!cfg || !host) return [];
  const out = [];
  let st = await storage.get(KEY);
  const fresh = !st || st.sig !== cfgStr;
  if (fresh) st = { sig: cfgStr, sent: {}, real: 0, realAt: 0 };

  // Cập nhật giá vốn mỗi ngày lúc 04:00 UTC (Coin Metrics có số ngày hôm qua khoảng 02:00–03:30 UTC), hoặc khi chưa có.
  if (!st.real || end % DAY === 4 * 3600e3 || end - st.realAt > 2 * DAY) {
    try {
      const rows = await loadCm(end);
      const last = rows[rows.length - 1];
      const isNew = last.d !== st.realDay;
      st.real = last.p / last.m; st.realAt = end; st.realDay = last.d;
      // Giai đoạn kế hoạch MVRV theo nến ngày vừa có số.
      const ph = mvrvPhase(rows);
      st.stage = ph.stage; st.below = ph.below;
      if (isNew && !fresh) {
        // MVRV hay cắt qua lại mức 1 nhiều lần trong vài ngày (VD 2022): mỗi loại tin tối đa 1 lần mỗi 30 ngày.
        st.evAt ||= {};
        for (const ev of ['broke', 'deep', 'back', 'confirm']) {
          if (!ph[ev]) continue;
          if (end - (st.evAt[ev] || 0) < 30 * DAY) ph[ev] = false; else st.evAt[ev] = end;
        }
        const pl = phaseLines(ph, st.real);
        if (pl.length) out.push(`${HEAD}\n${pl.join('\n\n')}`);
      }
      const dv = isNew && !fresh ? divergence(rows) : null;
      if (dv && end - (st.divAt || 0) > 30 * DAY) {
        st.divAt = end;
        out.push(`${HEAD}\n⚠️ <b>Giá lập đỉnh mới nhưng MVRV thấp hơn</b>: BTC đóng cửa ${fmt(dv.last.p)} (cao nhất 365 ngày), MVRV ${dv.last.m.toFixed(2)} thấp hơn mức ${dv.top.m.toFixed(2)} ngày ${dv.top.d.slice(8, 10)}/${dv.top.d.slice(5, 7)}.\n` +
          `Tay to có thể đang <b>chốt lời dần</b>. Kiểm tra lịch sử 2016–2025: tín hiệu xuất hiện trước đỉnh 4/2021, 11/2021 và 10/2025, nhưng có lần báo <b>sớm vài tháng</b> (giá còn tăng tiếp). Nên chốt lời <b>từng phần</b>, không bán hết một lần.`);
      }
    } catch (e) { console.log('mvrv cm', e.message); if (!st.real) { await storage.put(KEY, st); return out; } }
  }

  const t = await getJson(`${host}/api/v3/ticker?windowSize=1m&type=MINI&symbol=BTCUSDT`);
  const low = +t.lowPrice, high = +t.highPrice, last = +t.lastPrice;
  if (!(low > 0 && high > 0 && last > 0)) { await storage.put(KEY, st); return out; }
  const m = last / st.real;

  if (fresh) {
    // Mức đã vượt qua sẵn lúc bắt đầu thì không báo.
    for (const L of cfg.buy) if (m <= L) st.sent['b' + L] = 1;
    for (const L of cfg.sell) if (m >= L) st.sent['s' + L] = 1;
    out.push(`${HEAD} · bắt đầu theo dõi\nGiá vốn trung bình của mọi người giữ BTC: <b>${fmt(st.real)}</b>. MVRV hiện tại <b>${m.toFixed(2)}</b> (BTC ${fmt(last)}).\n` +
      (cfg.buy.length ? `🟢 Vùng gom: ${cfg.buy.map((L) => `MVRV ${L} ≈ ${fmt(st.real * L)}`).join(' · ')}\n` : '') +
      (cfg.sell.length ? `🔴 Vùng chốt lời: ${cfg.sell.map((L) => `MVRV ${L} ≈ ${fmt(st.real * L)}`).join(' · ')}\n` : '') +
      `⚠️ Báo thêm khi giá lập đỉnh mới nhưng MVRV thấp hơn (tay to xả dần).\n\n` +
      `<b>Kế hoạch theo MVRV</b> (nến ngày), hiện ở <b>giai đoạn ${st.stage || 1}</b>:\n` +
      `1️⃣ Trên 1: đỡ giá giai đoạn đầu (2014, 2018 đỡ ở 1.1–1.3 nhiều lần rồi vẫn thủng)\n` +
      `2️⃣ Đóng cửa dưới 1: thủng giá vốn, bắt đầu vùng tạo đáy\n` +
      `3️⃣ Dưới 0.9: vùng đáy lịch sử (0.75–0.9 ≈ ${fmt(st.real * 0.75)}–${fmt(st.real * 0.9)})\n` +
      `4️⃣ Quay lại và giữ trên 1 suốt 30 ngày: xác nhận đáy\n` +
      `<i>Giá vốn cập nhật mỗi ngày nên các mức giá dịch chuyển chậm theo.</i>`);
    await storage.put(KEY, st);
    return out;
  }

  const lines = [];
  for (const L of cfg.buy) {
    const k = 'b' + L, p = st.real * L;
    if (st.sent[k]) { if (last / st.real > L + 0.15) delete st.sent[k]; continue; }
    if (low <= p) {
      st.sent[k] = 1;
      lines.push(`🟢 BTC về <b>MVRV ${L}</b> ≈ ${fmt(p)}: ${L <= 1 ? 'giá bằng hoặc dưới giá vốn trung bình, đa số người giữ đang lỗ' : 'giá gần giá vốn trung bình'}.\n` +
        `Lịch sử đây là <b>vùng tay to gom</b> (đáy 2015: 0.56 · 2018: 0.69 · 2020: 0.88 · 2022: 0.75). Hợp để mua BTC từng phần, không dồn hết vốn.`);
    }
  }
  for (const L of cfg.sell) {
    const k = 's' + L, p = st.real * L;
    if (st.sent[k]) { if (last / st.real < L - 0.2) delete st.sent[k]; continue; }
    if (high >= p) {
      st.sent[k] = 1;
      lines.push(`🔴 BTC lên <b>MVRV ${L}</b> ≈ ${fmt(p)}: giá gấp ${L} lần giá vốn trung bình, người giữ đang lãi lớn.\n${sellNote(L)}\n` +
        `<i>Đỉnh MVRV thấp dần: 3.96 (2021) → 2.75 (2024) → 2.41 (2025).</i>`);
    }
  }
  if (lines.length) out.push(`${HEAD}\n${lines.join('\n\n')}\n<i>Giá vốn trung bình ${fmt(st.real)} (Coin Metrics)</i>`);
  await storage.put(KEY, st);
  return out;
}
