// Kế hoạch mua BTC từng phần (bằng USDT thu được khi bán altcoin).
// Cấu hình trong wrangler.toml: BTC_BUY = "vùng1,vùng2,vùng3:mức_xác_nhận" (giá Binance BTCUSDT).
//   Giá giảm chạm vùng i -> nhắc mua phần i (chia đều số USDT dành cho BTC).
//   Giá vượt mức xác nhận trong tuần -> báo trước, chờ đóng nến tuần.
//   Nến TUẦN đóng trên mức xác nhận (sáng thứ Hai 7:01) -> dấu hiệu sóng C đã xong: mua nốt phần còn lại, ngừng chờ vùng thấp.
// Mỗi vùng chỉ báo 1 lần (mỗi phần chỉ mua 1 lần). Đổi BTC_BUY là bot báo lại kế hoạch mới và theo dõi lại từ đầu.

const KEY = 'btcbuy:v1';
const HEAD = '🟠 <b>Kế hoạch mua BTC</b>';
const fmt = (p) => '$' + Math.round(p).toLocaleString('en-US');
const pct = (a, b) => `${a >= b ? '+' : ''}${((a / b - 1) * 100).toFixed(1)}%`;

export function parseBtcBuy(s) {
  const [lv, chase] = String(s || '').split(':');
  const levels = (lv || '').split(',').map(Number).filter((x) => x > 0).sort((a, b) => b - a);
  if (!levels.length) return null;
  return { levels, chase: +chase > levels[0] ? +chase : null };
}

const part = (i, n) => i === n - 1 ? `phần cuối (${i + 1}/${n})` : `phần ${i + 1}/${n} (khoảng 1/${n} số USDT dành cho BTC)`;

// Mỗi phút: { low, high, last } của BTC. Trả về các dòng cần báo.
export function btcBuyStep(st, cfg, { low, high }) {
  const lines = [];
  const n = cfg.levels.length;
  cfg.levels.forEach((p, i) => {
    const key = 'b' + p;
    if (st.sent[key]) return;
    if (low <= p) {
      st.sent[key] = 1;
      lines.push(`🟠 BTC giảm về <b>${fmt(p)}</b>: mua <b>${part(i, n)}</b>.` +
        (i < n - 1 ? ` Vùng kế tiếp ${fmt(cfg.levels[i + 1])}.` : ' Đã tới vùng mua sâu nhất, nếu giá còn rơi mạnh nữa thì dừng và chờ đánh giá lại.'));
    }
  });
  if (cfg.chase) {
    if (st.sent.touch && high < cfg.chase * 0.95) delete st.sent.touch;
    if (!st.sent.touch && high >= cfg.chase) {
      st.sent.touch = 1;
      lines.push(`👀 BTC vượt <b>${fmt(cfg.chase)}</b>: dấu hiệu sớm sóng C đã xong. <b>Chờ nến tuần</b> (đóng lúc 7:00 sáng thứ Hai) đóng trên mức này rồi mới mua phần còn lại, tránh bẫy tăng giá.`);
    }
  }
  return lines;
}

function planText(cfg, price) {
  const far = (p) => price ? ` (${pct(p, price)})` : '';
  return cfg.levels.map((p, i) => `• Phần ${i + 1}: <b>${fmt(p)}</b>${far(p)}`).join('\n') +
    (cfg.chase ? `\n• Nến tuần đóng trên <b>${fmt(cfg.chase)}</b>: mua nốt phần còn lại, không chờ vùng thấp nữa.` : '');
}

export async function btcBuyCheck({ storage, getJson, host, end, cfgStr }) {
  const cfg = parseBtcBuy(cfgStr);
  if (!cfg || !host) return [];
  const out = [];
  let st = await storage.get(KEY);
  const t = await getJson(`${host}/api/v3/ticker?windowSize=1m&type=MINI&symbol=BTCUSDT`);
  let low = +t.lowPrice, high = +t.highPrice, last = +t.lastPrice;
  const ok = low > 0 && high > 0 && last > 0 && !(st?.last && (low < st.last * 0.85 || high > st.last * 1.15));

  if (!st || st.sig !== cfgStr) {
    if (!(last > 0)) last = +(await getJson(`${host}/api/v3/ticker/price?symbol=BTCUSDT`)).price;
    st = { sig: cfgStr, sent: {}, last };
    // Vùng giá đã nằm dưới sẵn lúc bắt đầu thì không báo (chỉ báo khi giá đi tới vùng mới).
    for (const p of cfg.levels) if (last <= p) st.sent['b' + p] = 1;
    if (cfg.chase && last >= cfg.chase) st.sent.touch = 1;
    out.push(`${HEAD} · bắt đầu theo dõi\nBán altcoin xong thì giữ USDT, mua BTC từng phần (BTC hiện ${fmt(last)}):\n${planText(cfg, last)}\n\n` +
      `<i>Bot nhắc khi giá chạm từng vùng, và sáng thứ Hai lúc 7:01 kiểm tra nến tuần.</i>`);
  } else if (!ok && last > 0) {
    st.last = last; // giá lệch xa phút trước: bỏ qua phút này, phút sau vẫn ở mức đó thì chấp nhận
  } else if (!st.done && ok) {
    st.last = last;
    const lines = btcBuyStep(st, cfg, { low, high, last });
    if (lines.length) out.push(`${HEAD}\n${lines.join('\n')}`);
  }

  // Sáng thứ Hai 7:01: nến tuần vừa đóng.
  if (!st.done && cfg.chase && end % 86400e3 === 60e3 && new Date(end).getUTCDay() === 1) {
    try {
      const k = await getJson(`${host}/api/v3/klines?symbol=BTCUSDT&interval=1w&endTime=${end - 61e3}&limit=1`);
      const close = +k[0][4];
      if (close >= cfg.chase) {
        st.done = true;
        const left = cfg.levels.map((p, i) => [p, i]).filter(([p]) => !st.sent['b' + p]).map(([, i]) => i + 1);
        out.push(`${HEAD}\n✅ Nến tuần đóng <b>${fmt(close)}</b>, trên ${fmt(cfg.chase)}: dấu hiệu rõ sóng C đã kết thúc.\n` +
          (left.length ? `Mua nốt <b>phần ${left.join(', ')}</b> chưa mua, không chờ giá về vùng thấp nữa.` : 'Các vùng mua đều đã chạm, kế hoạch mua BTC đã xong.') +
          `\nXác nhận mạnh hơn khi vượt 70K, chắc chắn khi vượt 75.7K. Sau đó thường có 1 nhịp điều chỉnh (sóng 2) là cơ hội mua thêm.\nBot ngừng nhắc các vùng mua thấp.`);
      }
    } catch (e) { console.log('btcbuy weekly', e.message); }
  }
  await storage.put(KEY, st);
  return out;
}

// Cho trang Tổng quan trên web.
export function btcBuyStatus(cfgStr, st) {
  const cfg = parseBtcBuy(cfgStr);
  if (!cfg) return null;
  const sent = st?.sig === cfgStr ? st.sent : {};
  return { ...cfg, hit: cfg.levels.map((p) => !!sent['b' + p]), touch: !!sent.touch, done: !!(st?.sig === cfgStr && st.done) };
}
