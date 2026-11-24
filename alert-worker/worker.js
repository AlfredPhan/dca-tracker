// Cloudflare Worker: mỗi phút quét lệnh lớn và báo về Telegram.
// Việc quét chạy trong Durable Object ghim ở châu Á (Tokyo) nên Binance không chặn; OKX chỉ còn là dự phòng.
// Một số coin quét thêm sàn phụ nơi coin đó giao dịch mạnh (EXTRA, VD: TIA trên Bybit).
// Cấu hình trong wrangler.toml (COINS, EXTRA). Secrets: TELEGRAM_TOKEN, CHAT_ID.

import { DurableObject } from 'cloudflare:workers';
import { recordDay, periodsEndingAt, periodSummary, cleanup } from './summary.js';
import { pivotCheck } from './pivot.js';
import { calendarReminder, calendarToday } from './calendar.js';
import { elliottCheck, elliottStatus } from './elliott.js';
import { planCheck, planStatus } from './plan.js';
import { btcBuyCheck, btcBuyStatus } from './btcbuy.js';
import { mvrvCheck } from './mvrv.js';

// Binance chặn một số vùng của Cloudflare, nên thử lần lượt các host.
const BINANCE_HOSTS = ['https://api-gcp.binance.com', 'https://api.binance.com', 'https://data-api.binance.vision'];
const OKX = 'https://www.okx.com/api/v5/market';
const BYBIT = 'https://api.bybit.com/v5/market';
const COINBASE = 'https://api.exchange.coinbase.com/products';
const SITE = 'https://alfredphan.github.io/dca-tracker/#whale';
const MAX_PAGES = 5;

// Cron của Cloudflare chạy ở máy chủ ngẫu nhiên (hay ở Mỹ/châu Âu, nơi Binance và Bybit chặn).
// Vì vậy cron chỉ gọi sang Durable Object "Scanner" được ghim ở châu Á, việc quét chạy ở đó.
export class Scanner extends DurableObject {
  async fetch(request) {
    // Chỉ đọc: số tổng gom/xả theo ngày (cho biểu đồ lịch sử trên web). Không chạy hay thay đổi gì.
    if (new URL(request.url).pathname === '/history') {
      const days = Object.fromEntries(await this.ctx.storage.list({ prefix: 'day:' }));
      const coins = parseCoins(this.env.COINS || '').map(({ coin, min }) => ({ coin, min }));
      // Trạng thái kịch bản Elliott BTC và kế hoạch danh mục (cho trang Tổng quan).
      const status = {};
      try { status.elliott = elliottStatus(this.env.ELLIOTT_BTC, await this.ctx.storage.get('elliott:btc')); } catch {}
      try { status.plan = planStatus(this.env.PLAN, await this.ctx.storage.get('plan:v1')); } catch {}
      try { status.btcBuy = btcBuyStatus(this.env.BTC_BUY, await this.ctx.storage.get('btcbuy:v1')); } catch {}
      return Response.json({ updated: Date.now(), coins, days, status });
    }
    const { scheduledTime } = await request.json();
    await check(this.env, scheduledTime, this.ctx.storage);
    return new Response('ok');
  }
}

const scanner = (env) => env.SCANNER.get(env.SCANNER.idFromName('main'), { locationHint: 'apac' });

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scanner(env).fetch('https://scanner/run', {
      method: 'POST', body: JSON.stringify({ scheduledTime: event.scheduledTime }),
    }));
  },
  // Link công khai duy nhất: GET /history (chỉ đọc). GitHub Actions lấy mỗi giờ để ghi ra data/history.json.
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.pathname !== '/history') return new Response('Not found', { status: 404 });
    const res = await scanner(env).fetch('https://scanner/history');
    return new Response(res.body, { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=300' } });
  },
};

function parseCoins(str) {
  return str.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    // "ARB:10000" = từ 10K trở lên; "BTC:500000-1000000" = chỉ lệnh trong khoảng 500K–1M.
    const [coin, range = ''] = s.split(':');
    const [min, max] = range.split('-');
    return { coin: coin.toUpperCase(), min: +min || 10000, max: +max || Infinity };
  });
}

// "TIA:bybit,FET:coinbase" -> [{ coin: 'TIA', ex: 'bybit' }, ...]
function parseExtra(str) {
  return str.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [coin, ex = ''] = s.split(':');
    return { coin: coin.toUpperCase(), ex: ex.toLowerCase() };
  });
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'whale-alert' } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function findBinanceHost() {
  for (const host of BINANCE_HOSTS) {
    try {
      if ((await fetch(`${host}/api/v3/ping`)).ok) return host;
    } catch {}
  }
  return null;
}

// Các hàm lấy lệnh khớp trả về dạng chung: { price, value, sell } với sell = bên bán chủ động.
async function binanceTrades(host, coin, start, end) {
  const base = `${host}/api/v3/aggTrades?symbol=${coin}USDT`;
  let url = `${base}&startTime=${start}&endTime=${end - 1}&limit=1000`;
  const all = [];
  let cut = true; // true nếu phút quá sôi động, đã hết MAX_PAGES trang mà chưa lấy đủ
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await getJson(url);
    all.push(...page);
    if (page.length < 1000 || page[page.length - 1].T >= end - 1) { cut = false; break; }
    url = `${base}&fromId=${page[page.length - 1].a + 1}&limit=1000`;
  }
  const out = all.filter((t) => t.T >= start && t.T < end)
    .map((t) => ({ price: +t.p, value: +t.p * +t.q, sell: t.m, time: t.T }));
  out.cut = cut;
  return out;
}

// Tổng mua/bán chủ động của mọi lệnh từ 100 USD trở lên (chỉ để vẽ biểu đồ trên web, không gửi tin nhắn).
const ALL_MIN = 100;
const BIG_WEB = 100000; // ngưỡng lệnh tay to cho tab Tay to trên web

async function okxTrades(coin, start, end) {
  const inst = `${coin}-USDT`;
  const first = await getJson(`${OKX}/trades?instId=${inst}&limit=500`);
  if (first.code !== '0') throw new Error('OKX ' + first.msg);
  const all = [...first.data];
  // Nếu 500 lệnh gần nhất chưa phủ hết 1 phút thì lấy thêm lệnh cũ hơn.
  for (let i = 0; i < MAX_PAGES && all.length && +all[all.length - 1].ts >= start; i++) {
    const page = await getJson(`${OKX}/history-trades?instId=${inst}&after=${all[all.length - 1].tradeId}&limit=100`);
    if (!page.data?.length) break;
    all.push(...page.data);
  }
  return all.filter((t) => +t.ts >= start && +t.ts < end)
    .map((t) => ({ price: +t.px, value: +t.px * +t.sz, sell: t.side === 'sell', time: +t.ts }))
    .sort((a, b) => a.time - b.time);
}

// Bybit spot chỉ trả tối đa 60 lệnh gần nhất (không có phân trang), đủ cho 1 phút với đa số coin.
async function bybitTrades(coin, start, end) {
  const d = await getJson(`${BYBIT}/recent-trade?category=spot&symbol=${coin}USDT&limit=60`);
  if (d.retCode !== 0) throw new Error('Bybit ' + d.retMsg);
  return d.result.list.filter((t) => +t.time >= start && +t.time < end)
    .map((t) => ({ price: +t.price, value: +t.price * +t.size, sell: t.side === 'Sell', time: +t.time }))
    .sort((a, b) => a.time - b.time);
}

// Coinbase dùng cặp USD. Trường side là phía lệnh chờ (maker), nên side 'buy' = bên bán chủ động.
async function coinbaseTrades(coin, start, end) {
  const base = `${COINBASE}/${coin}-USD/trades?limit=1000`;
  const all = [];
  let url = base;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await getJson(url);
    if (!page.length) break;
    all.push(...page);
    if (Date.parse(page[page.length - 1].time) < start) break;
    url = `${base}&after=${page[page.length - 1].trade_id}`;
  }
  return all.map((t) => ({ price: +t.price, value: +t.price * +t.size, sell: t.side === 'buy', time: Date.parse(t.time) }))
    .filter((t) => t.time >= start && t.time < end)
    .sort((a, b) => a.time - b.time);
}

const EXCHANGES = {
  bybit: { name: 'Bybit', trades: bybitTrades },
  coinbase: { name: 'Coinbase', trades: coinbaseTrades },
  okx: { name: 'OKX', trades: okxTrades },
};

const usdK = (n) => n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `$${(n / 1000).toFixed(1)}K` : `$${Math.round(n)}`;
const vnTime = (ms) => new Date(ms).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' });

async function check(env, scheduledTime, storage) {
  // Mỗi lần chạy xét đúng 1 phút vừa qua, nên các lần chạy không trùng nhau.
  const end = Math.floor(scheduledTime / 60000) * 60000;
  const start = end - 60000;
  const coins = parseCoins(env.COINS || '');
  const host = await findBinanceHost();
  const source = host ? 'Binance' : 'OKX';
  const blocks = [];
  const errors = [];
  const tally = {}; // cộng dồn lệnh lớn của phút này theo coin (gộp các sàn) cho bản tổng kết ngày

  // Mỗi việc quét = 1 coin trên 1 sàn. Sàn phụ được ghi tên ở cuối dòng.
  const jobs = coins.map(({ coin, min, max }) => ({
    coin, min, max, label: '',
    get: () => host ? binanceTrades(host, coin, start, end) : okxTrades(coin, start, end),
  }));
  for (const { coin, ex } of parseExtra(env.EXTRA || '')) {
    const cfg = coins.find((c) => c.coin === coin);
    const exchange = EXCHANGES[ex];
    if (!cfg || !exchange || exchange.name === source) continue;
    jobs.push({ ...cfg, label: ` · <b>${exchange.name}</b>`, get: () => exchange.trades(coin, start, end) });
  }

  await Promise.all(jobs.map(async ({ coin, min, max, label, get }) => {
    try {
      const trades = await get();
      let buy = 0, sell = 0, nBuy = 0, nSell = 0, maxV = 0, lastPrice = 0;
      for (const t of trades) {
        lastPrice = t.price;
        if (t.value < min || t.value > max) continue;
        if (t.sell) { sell += t.value; nSell++; } else { buy += t.value; nBuy++; }
        maxV = Math.max(maxV, t.value);
      }
      if (nBuy || nSell) {
        const c = (tally[coin] ||= { b: 0, s: 0, nb: 0, ns: 0 });
        c.b += buy; c.s += sell; c.nb += nBuy; c.ns += nSell;
      }
      // Sàn chính Binance: cộng thêm tổng mọi lệnh từ 100 USD (ab/as = mua/bán, anb/ans = số lệnh, acut = số phút bị thiếu).
      if (!label && host) {
        const c = (tally[coin] ||= { b: 0, s: 0, nb: 0, ns: 0 });
        c.ab ||= 0; c.as ||= 0; c.anb ||= 0; c.ans ||= 0; c.acut ||= 0;
        c.amin = (c.amin || 0) + 1; // số phút đã ghi (để biết ngày nào đủ 24 giờ)
        c.hb ||= 0; c.hs ||= 0; c.hnb ||= 0; c.hns ||= 0; c.hmin = (c.hmin || 0) + 1;
        for (const t of trades) {
          if (t.value < ALL_MIN) continue;
          if (t.sell) { c.as += t.value; c.ans++; } else { c.ab += t.value; c.anb++; }
          // Lệnh từ 100K USD (tab Tay to trên web): hb/hs = mua/bán, hnb/hns = số lệnh, hmin = số phút đã ghi.
          if (t.value >= BIG_WEB) { if (t.sell) { c.hs += t.value; c.hns++; } else { c.hb += t.value; c.hnb++; } }
        }
        if (trades.cut) c.acut++;
      }
      if (!nBuy && !nSell) return;
      const icon = maxV >= min * 5 ? '🐋' : '🦈';
      const lean = buy > sell * 2 ? 'GOM' : sell > buy * 2 ? 'XẢ' : 'giằng co';
      const side = (emoji, v, n) => v ? ` · ${emoji} ${usdK(v)}${n > 1 ? ` (${n})` : ''}` : '';
      blocks.push({
        total: buy + sell,
        text: `${icon} <b>${coin}</b> ${lean}${side('🟢', buy, nBuy)}${side('🔴', sell, nSell)} · giá ${lastPrice}${label}`,
      });
    } catch (e) {
      errors.push(`${coin}${label.replace(/<\/?b>/g, '')}: ${e.message}`);
    }
  }));

  const colo = await fetch('https://www.cloudflare.com/cdn-cgi/trace').then((r) => r.text())
    .then((t) => (t.match(/colo=(\w+)/) || [])[1]).catch(() => '?');
  console.log(`[${colo}] source ${source}, checked ${jobs.length} coin/exchange pairs, alerts: ${blocks.length}, errors: ${errors.join('; ') || 'none'}`);

  if (blocks.length) {
    blocks.sort((a, b) => b.total - a.total);
    await sendTelegram(env, blocks.map((b) => b.text).join('\n') +
      `\n<i>${vnTime(start)} · ${source}</i> · <a href="${SITE}">web</a>`);
  }

  try { await recordDay(storage, start, tally); } catch (e) { console.log('recordDay error:', e.message); }

  // Báo giá chạm mức Pivot. Lúc 7:00 (đóng nến) không cập nhật mức để dành request cho bản tổng kết; phút sau mới cập nhật.
  try {
    const sod = end % 86400e3 === 0;
    const msg = await pivotCheck({
      storage, getJson, host, end, site: SITE.replace('#whale', '#pivot'),
      coins: [...coins.map((c) => c.coin), ...(env.PIVOT_GOLD === '0' ? [] : ['XAU'])],
      frames: (env.PIVOT_FRAMES || 'd,w,m,y').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean),
      names: (env.PIVOT_LEVELS || 'R3,R2,R1,P,S1,S2,S3').toUpperCase().split(',').map((s) => s.trim()).filter(Boolean),
      refreshLimit: sod ? 0 : 4,
    });
    if (msg) await sendTelegram(env, msg);
  } catch (e) { console.log('pivot error:', e.message); }

  // Theo dõi kịch bản sóng Elliott của BTC (điểm sóng trong ELLIOTT_BTC, để trống hoặc "0" để tắt).
  if (env.ELLIOTT_BTC && env.ELLIOTT_BTC !== '0') {
    try {
      for (const m of await elliottCheck({ storage, getJson, host, end, cfgStr: env.ELLIOTT_BTC })) await sendTelegram(env, m);
    } catch (e) { console.log('elliott error:', e.message); }
  }

  // Kế hoạch danh mục: vùng DCA/cắt lỗ cho coin giữ, vùng hồi để bán chuyển BTC cho coin yếu (chạy sau Elliott).
  if (env.PLAN && env.PLAN !== '0') {
    try {
      for (const m of await planCheck({ storage, getJson, host, end, planStr: env.PLAN })) await sendTelegram(env, m);
    } catch (e) { console.log('plan error:', e.message); }
  }

  // Kế hoạch mua BTC từng phần bằng USDT bán altcoin (BTC_BUY, để trống hoặc "0" để tắt).
  if (env.BTC_BUY && env.BTC_BUY !== '0') {
    try {
      for (const m of await btcBuyCheck({ storage, getJson, host, end, cfgStr: env.BTC_BUY })) await sendTelegram(env, m);
    } catch (e) { console.log('btcbuy error:', e.message); }
  }

  // Cảnh báo MVRV: vùng gom, vùng chốt lời, phân kỳ giá/MVRV (MVRV_ALERT, để trống hoặc "0" để tắt).
  if (env.MVRV_ALERT && env.MVRV_ALERT !== '0') {
    try {
      for (const m of await mvrvCheck({ storage, getJson, host, end, cfgStr: env.MVRV_ALERT })) await sendTelegram(env, m);
    } catch (e) { console.log('mvrv error:', e.message); }
  }

  // Nhắc trước 30 phút khi sắp có tin kinh tế mạnh của Mỹ (CPI, việc làm, Fed...).
  if (env.NEWS_REMIND !== '0') {
    try {
      const msg = await calendarReminder({ storage, getJson, url: DATA_URL + 'calendar.json', end });
      if (msg) await sendTelegram(env, msg + `\n<a href="${SITE.replace('#whale', '#gold')}">xem lịch</a>`);
    } catch (e) { console.log('calendar error:', e.message); }
  }

  // 7:00 sáng giờ VN: nến Binance đóng. Tổng kết nến ngày (mỗi ngày), tuần (thứ Hai), tháng (ngày 1), năm (1/1).
  // % giá trong nến: lấy nến ngày 1 lần cho mỗi coin (đủ cho kỳ dài nhất), rồi tính giá mở/đóng của từng kỳ.
  const periods = periodsEndingAt(end);
  const dailyK = {};
  const priceChange = async (coin, p) => {
    if (!host) return null;
    const from = Math.min(...periods.map((x) => x.from));
    dailyK[coin] ||= getJson(`${host}/api/v3/klines?symbol=${coin}USDT&interval=1d&startTime=${from}&endTime=${end - 1}&limit=1000`);
    const k = (await dailyK[coin]).filter((c) => c[0] >= p.from && c[0] < p.to);
    return k.length ? (+k[k.length - 1][4] / +k[0][1] - 1) * 100 : null;
  };
  for (const p of periods) {
    try {
      const etf = p.kind === 'ngày' ? (await fngLine().catch(() => '')) + (await etfLine().catch(() => '')) : '';
      await sendTelegram(env, (await periodSummary(storage, coins, p, priceChange)) + etf + ` · <a href="${SITE}">web</a>`);
    } catch (e) {
      await sendTelegram(env, `⚠️ Không tạo được bản tổng kết ${p.kind}: ${e.message}`);
    }
  }
  if (periodsEndingAt(end).length) await cleanup(storage, end).catch((e) => console.log('cleanup error:', e.message));

  // Báo lỗi tối đa 1 lần/giờ để không spam.
  const d = new Date(end);
  if (errors.length && d.getUTCMinutes() === 0) {
    await sendTelegram(env, `⚠️ Bot gặp lỗi khi lấy dữ liệu (${source}):\n${errors.join('\n')}`);
  }
  // 8:00 sáng giờ VN (hoặc mỗi phút khi bật SEND_TEST): báo bot vẫn đang chạy.
  if (env.SEND_TEST === '1' || (d.getUTCHours() === 1 && d.getUTCMinutes() === 0)) {
    const unlocks = await unlockReminder(coins.map((c) => c.coin)).catch((e) => `⚠️ Không lấy được lịch unlock: ${e.message}`);
    const news = await calendarToday({ storage, getJson, url: DATA_URL + 'calendar.json', end }).catch((e) => `⚠️ Không lấy được lịch tin: ${e.message}`);
    await sendTelegram(env, `☀️ Bot cá voi vẫn đang chạy. Theo dõi: ${env.COINS}${env.EXTRA ? `\nSàn phụ: ${env.EXTRA}` : ''}` +
      (news ? `\n\n${news}` : '') + (unlocks ? `\n\n${unlocks}` : ''));
  }
}

// Lịch unlock do GitHub Actions tạo mỗi giờ (data/unlocks.json trên website). Báo các đợt trong 3 ngày tới.
const DATA_URL = 'https://alfredphan.github.io/dca-tracker/data/';
const CAT_VI = {
  insiders: 'Đội ngũ & cố vấn', privateSale: 'Nhà đầu tư quỹ', publicSale: 'Bán công khai', airdrop: 'Airdrop',
  farming: 'Phần thưởng', noncirculating: 'Quỹ dự trữ', ecosystem: 'Hệ sinh thái', liquidity: 'Thanh khoản',
};
const fmtBig = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n));

// Chỉ số Sợ hãi & Tham lam (Alternative.me), gắn vào bản tổng kết ngày.
async function fngLine() {
  const d = (await getJson('https://api.alternative.me/fng/?limit=2')).data;
  const v = +d[0].value, prev = d[1] ? +d[1].value : null;
  const [emoji, name] = v <= 24 ? ['😱', 'Sợ hãi tột độ'] : v <= 44 ? ['😟', 'Sợ hãi'] : v <= 55 ? ['😐', 'Trung lập'] : v <= 75 ? ['🙂', 'Tham lam'] : ['🤑', 'Tham lam tột độ'];
  return `\n${emoji} <b>Sợ hãi & Tham lam</b>: ${v} (${name})${prev != null ? `, hôm qua ${prev}` : ''}`;
}

// Dòng tiền quỹ ETF phiên Mỹ gần nhất (data/etf.json, nguồn Farside), gắn vào bản tổng kết ngày.
async function etfLine() {
  const data = await getJson(DATA_URL + 'etf.json');
  const m = (v) => `${v >= 0 ? '+' : '−'}$${Math.abs(v) >= 1000 ? (Math.abs(v) / 1000).toFixed(2) + 'B' : Math.abs(v).toFixed(1) + 'M'}`;
  const parts = ['BTC', 'ETH'].map((c) => {
    const d = data.coins?.[c];
    if (!d?.length) return '';
    const last = d[d.length - 1], s5 = d.slice(-5).reduce((s, x) => s + x.total, 0);
    return `${c} ${m(last.total)} (5 phiên ${m(s5)}) · phiên ${last.d.slice(8, 10)}/${last.d.slice(5, 7)}`;
  }).filter(Boolean);
  return parts.length ? `\n🏦 <b>Quỹ ETF</b>: ${parts.join(' | ')}` : '';
}

async function unlockReminder(symbols) {
  const data = await getJson(DATA_URL + 'unlocks.json');
  const now = Date.now() / 1000;
  const lines = [];
  for (const sym of symbols) {
    const u = data.coins[sym];
    for (const e of u?.events || []) {
      if (e.t - now > 3 * 86400) break;
      const pct = e.tokens / u.circ * 100;
      if (pct < 0.1) continue;
      const days = Math.max(0, Math.ceil((e.t - now) / 86400));
      const vn = new Date((e.t + 7 * 3600) * 1000); // giờ Việt Nam (UTC+7)
      const date = `${String(vn.getUTCDate()).padStart(2, '0')}/${String(vn.getUTCMonth() + 1).padStart(2, '0')}`;
      lines.push(`${pct >= 1 ? '🔥' : '🔓'} <b>${sym}</b> ${date} (${days ? `còn ${days} ngày` : 'hôm nay'}) · ${fmtBig(e.tokens)} ${sym} ` +
        `(${pct.toFixed(2)}% lưu hành) · ${e.cats.map((c) => CAT_VI[c] || c).join(', ')}`);
    }
  }
  return lines.length ? `🔓 <b>Sắp mở khóa token</b> (3 ngày tới):\n${lines.join('\n')}` : '';
}

async function sendTelegram(env, text) {
  if (!env.TELEGRAM_TOKEN || !env.CHAT_ID) return 'Thiếu TELEGRAM_TOKEN hoặc CHAT_ID';
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN.trim()}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: env.CHAT_ID.replace(/[^\d-]/g, ''), text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  const result = res.ok ? 'OK' : `Lỗi ${res.status}: ${await res.text()}`;
  console.log('telegram:', result);
  return result;
}
