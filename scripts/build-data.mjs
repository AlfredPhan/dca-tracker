// Chạy trên GitHub Actions mỗi giờ (xem .github/workflows/pages.yml), tạo 2 file dữ liệu nhỏ cho website:
//   data/unlocks.json  lịch mở khóa token (nguồn: DefiLlama)
//   data/onchain.json  coin nạp lên / rút khỏi sàn trong 24h (nguồn: Blockscout, có gắn nhãn ví sàn)
// Phần nào lỗi thì giữ lại bản đang chạy trên website, để không mất dữ liệu.
import { mkdir, readFile, writeFile } from 'node:fs/promises';

// Địa chỉ website của chính repo đang chạy (GitHub Actions có sẵn biến GITHUB_REPOSITORY = "chủ/tên-repo").
const [GH_OWNER, GH_REPO] = (process.env.GITHUB_REPOSITORY || 'AlfredPhan/dca-tracker').split('/');
const SITE = `https://${GH_OWNER.toLowerCase()}.github.io/${GH_REPO}/`;
const OUT = new URL('../data/', import.meta.url);
const UA = { 'user-agent': 'Mozilla/5.0 (dca-tracker data builder)', accept: 'application/json' };

// Token on-chain cần theo dõi. Chỉ Ethereum vì Blockscout Ethereum có nhãn ví sàn đầy đủ.
const ONCHAIN = {
  LDO: { chain: 'Ethereum', host: 'eth.blockscout.com', token: '0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32' },
  FET: { chain: 'Ethereum', host: 'eth.blockscout.com', token: '0xaea46A60368A7bD060eec7DF8CBa43b7EF41Ad85' },
  BICO: { chain: 'Ethereum', host: 'eth.blockscout.com', token: '0xF17e65822b568B3903685a7c9F496CF7656Cc6C2' },
};
const MAX_PAGES = 80; // 50 giao dịch/trang
const DAY = 86400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url) {
  for (let i = 0; i < 3; i++) {
    const res = await fetch(url, { headers: UA });
    if (res.ok) return res.json();
    if (res.status !== 429 && res.status < 500) throw new Error(`HTTP ${res.status} ${url}`);
    await sleep(2000 * (i + 1));
  }
  throw new Error('Hết số lần thử: ' + url);
}

// ---------- Lịch unlock ----------
async function buildUnlocks() {
  const { data } = await getJson('https://defillama-datasets.llama.fi/emissionsIndex');
  const now = Date.now() / 1000;
  const coins = {};
  for (const p of data) {
    const symbol = p.tokenPrice?.[0]?.symbol?.toUpperCase();
    const circ = +p.circSupply || 0;
    if (!symbol || !circ) continue;
    // Chỉ giữ các đợt unlock một lần (cliff) trong 180 ngày tới, từ 0.05% lượng lưu hành trở lên.
    const events = (p.unlockEvents || [])
      .filter((e) => e.timestamp > now && e.timestamp < now + 180 * DAY)
      .map((e) => {
        const byCat = {};
        for (const a of e.cliffAllocations || []) byCat[a.category] = (byCat[a.category] || 0) + a.amount;
        const tokens = Object.values(byCat).reduce((s, v) => s + v, 0);
        return { t: e.timestamp, tokens: Math.round(tokens), cats: Object.keys(byCat) };
      })
      .filter((e) => e.tokens / circ >= 0.0005)
      .slice(0, 8);
    const perDay = Math.round(+p.unlocksPerDay || 0);
    if (!events.length && !perDay) continue;
    const prev = coins[symbol];
    if (prev && prev.mcap >= (+p.mcap || 0)) continue; // trùng ký hiệu: giữ dự án vốn hóa lớn hơn
    coins[symbol] = {
      name: p.name, circ: Math.round(circ), max: Math.round(+p.maxSupply || 0),
      mcap: Math.round(+p.mcap || 0), perDay, events,
    };
  }
  return { updated: Date.now(), source: 'DefiLlama', coins };
}

// ---------- Nạp/rút sàn ----------
// Ví sàn = có nhãn "Exchange" hoặc "Hot Wallet" (Blockscout lấy nhãn từ Etherscan và các nguồn công khai).
const EX_CANON = { bybit: 'Bybit', okx: 'OKX', okex: 'OKX', 'gate.io': 'Gate', gate: 'Gate', kucoin: 'KuCoin', coinbase: 'Coinbase',
  binance: 'Binance', kraken: 'Kraken', upbit: 'Upbit', bitget: 'Bitget', mexc: 'MEXC', htx: 'HTX', huobi: 'HTX', bitstamp: 'Bitstamp' };
function exchangeName(addr) {
  const tags = addr?.metadata?.tags || [];
  const isEx = tags.some((t) => ['exchange', 'hot-wallet'].includes(t.slug) || /hot wallet|exchange/i.test(t.name));
  if (!isEx) return null;
  const tag = tags.find((t) => t.tagType === 'protocol') || tags.find((t) => t.tagType === 'name');
  const raw = (tag?.name || addr.name || 'Sàn khác').split(':')[0].replace(/\s*exchange\s*/i, ' ').replace(/[\s_-]*\d+$/, '').trim();
  return EX_CANON[raw.toLowerCase()] || raw;
}

async function scanToken(sym, cfg) {
  const since = Date.now() / 1000 - DAY;
  const base = `https://${cfg.host}/api/v2/tokens/${cfg.token}/transfers`;
  const r = { chain: cfg.chain, in24: 0, out24: 0, in4: 0, out4: 0, nIn: 0, nOut: 0, byEx: {}, top: [], hours: 0 };
  let url = base, oldest = Date.now() / 1000;
  for (let page = 0; page < MAX_PAGES && url; page++) {
    const d = await getJson(url);
    for (const it of d.items || []) {
      const t = Date.parse(it.timestamp) / 1000;
      oldest = Math.min(oldest, t);
      if (t < since) { url = null; break; }
      const fromEx = exchangeName(it.from), toEx = exchangeName(it.to);
      if (!!fromEx === !!toEx) continue; // không dính sàn, hoặc chuyển giữa các ví sàn
      const amt = +it.total.value / 10 ** +(it.total.decimals || 18);
      const dir = toEx ? 'in' : 'out';
      const ex = toEx || fromEx;
      const recent = t > Date.now() / 1000 - 4 * 3600;
      if (dir === 'in') { r.in24 += amt; r.nIn++; if (recent) r.in4 += amt; }
      else { r.out24 += amt; r.nOut++; if (recent) r.out4 += amt; }
      const e = (r.byEx[ex] ||= { in: 0, out: 0 });
      e[dir] += amt;
      r.top.push({ t: Math.round(t), amt: Math.round(amt), dir, ex, tx: it.transaction_hash });
    }
    if (url) url = d.next_page_params ? `${base}?${new URLSearchParams(d.next_page_params)}` : null;
    await sleep(300);
  }
  r.hours = Math.min(24, Math.round((Date.now() / 1000 - oldest) / 360) / 10);
  r.top = r.top.sort((a, b) => b.amt - a.amt).slice(0, 10);
  for (const k of ['in24', 'out24', 'in4', 'out4']) r[k] = Math.round(r[k]);
  for (const v of Object.values(r.byEx)) { v.in = Math.round(v.in); v.out = Math.round(v.out); }
  return r;
}

// ---------- BTC, ETH: theo dõi số dư ví sàn ----------
// Hai coin này có quá nhiều giao dịch để quét hết, nên so số dư các ví sàn lớn ở hiện tại với 4h/24h trước.
// Tổng số dư tăng = coin được nạp lên sàn, giảm = coin bị rút ra. Chuyển nội bộ giữa ví cùng sàn tự triệt tiêu.
function balanceResult(chain, explorer, rows, hours) {
  // rows: [{ ex, addr, now, h4, h24 }] (h4/h24 có thể null nếu chưa có dữ liệu cũ)
  const r = { mode: 'balance', chain, explorer, hours, in24: 0, out24: 0, in4: 0, out4: 0, nIn: 0, nOut: 0, byEx: {}, top: [], reserve: 0, wallets: rows.length };
  const ex = {};
  for (const w of rows) {
    const e = (ex[w.ex] ||= { now: 0, d4: 0, d24: 0 });
    e.now += w.now;
    if (w.h4 != null) e.d4 += w.now - w.h4;
    if (w.h24 != null) e.d24 += w.now - w.h24;
    if (w.h24 != null && Math.abs(w.now - w.h24) > 0) r.top.push({ addr: w.addr, ex: w.ex, amt: Math.round(Math.abs(w.now - w.h24)), dir: w.now > w.h24 ? 'in' : 'out' });
  }
  for (const [name, e] of Object.entries(ex)) {
    r.reserve += e.now;
    r.byEx[name] = { in: Math.round(Math.max(e.d24, 0)), out: Math.round(Math.max(-e.d24, 0)), reserve: Math.round(e.now) };
    if (e.d24 > 0) { r.in24 += e.d24; r.nIn++; } else if (e.d24 < 0) { r.out24 -= e.d24; r.nOut++; }
    if (e.d4 > 0) r.in4 += e.d4; else r.out4 -= e.d4;
  }
  for (const k of ['in24', 'out24', 'in4', 'out4', 'reserve']) r[k] = Math.round(r[k]);
  r.top = r.top.sort((a, b) => b.amt - a.amt).slice(0, 10);
  return r;
}

async function scanEth() {
  const api = 'https://eth.blockscout.com/api';
  // Ethereum tạo 1 block mỗi 12 giây, nên suy số block theo thời gian từ block mới nhất.
  const rpc = async (method, params) => (await fetch('https://eth.drpc.org', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).then((r) => r.json())).result;
  const head = parseInt(await rpc('eth_blockNumber', []), 16);
  const block = async (sec) => head - Math.round((Date.now() / 1000 - sec) / 12);
  const balanceAt = async (addr, b) => parseInt((await getJson(`${api}?module=account&action=eth_get_balance&address=${addr}&block=${b}`)).result, 16) / 1e18;
  // Lấy ví sàn từ danh sách 500 ví giàu nhất (có nhãn), bỏ ví bị khóa vĩnh viễn hoặc sàn đã đóng cửa.
  const wallets = [];
  let url = 'https://eth.blockscout.com/api/v2/addresses';
  for (let p = 0; p < 10 && url; p++) {
    const d = await getJson(url);
    for (const a of d.items) {
      const ex = exchangeName(a);
      const tagText = (a.metadata?.tags || []).map((t) => t.name).join(' ');
      if (ex && !/compromised|parity|quadriga|ico wallet/i.test(tagText)) wallets.push({ ex, addr: a.hash, now: +a.coin_balance / 1e18 });
    }
    url = d.next_page_params ? `https://eth.blockscout.com/api/v2/addresses?${new URLSearchParams(d.next_page_params)}` : null;
    await sleep(300);
  }
  const now = Date.now() / 1000;
  const [b4, b24] = [await block(now - 4 * 3600), await block(now - DAY)];
  // Số dư lịch sử: gọi gộp nhiều ví một lần qua RPC miễn phí dRPC (có dữ liệu archive);
  // lỗi thì hỏi từng ví trên Blockscout, chậm hơn để không bị giới hạn tốc độ.
  const at = async (blk, key) => {
    for (let i = 0; i < wallets.length; i += 3) { // gói miễn phí của dRPC cho tối đa 3 lệnh mỗi lần
      const chunk = wallets.slice(i, i + 3);
      try {
        const res = await fetch('https://eth.drpc.org', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(chunk.map((w, id) => ({ jsonrpc: '2.0', id, method: 'eth_getBalance', params: [w.addr, blk] }))),
        }).then((r) => r.json());
        for (const x of res) {
          if (x.result == null) throw new Error(x.error?.message || 'rpc');
          chunk[x.id][key] = parseInt(x.result, 16) / 1e18;
        }
      } catch {
        for (const w of chunk) { w[key] = await balanceAt(w.addr, parseInt(blk, 16) || blk); await sleep(1200); }
      }
      await sleep(300);
    }
  };
  const latest = '0x' + (await block(now - 60)).toString(16);
  await at(latest, 'now');
  await at('0x' + b4.toString(16), 'h4');
  await at('0x' + b24.toString(16), 'h24');
  return balanceResult('Ethereum', 'https://etherscan.io/address/', wallets, 24);
}

// BTC: danh sách ví cố định (scripts/btc-exchange-wallets.json). Mỗi giờ lưu một bản chụp số dư vào
// data/btc-snapshots.json, rồi so với bản chụp gần 4h và 24h trước nhất.
async function btcBalances(addrs) {
  const out = {};
  for (let i = 0; i < addrs.length; i += 80) {
    const chunk = addrs.slice(i, i + 80);
    try {
      const d = await getJson('https://blockchain.info/balance?active=' + chunk.join('|'));
      for (const a of chunk) out[a] = (d[a]?.final_balance ?? NaN) / 1e8;
    } catch { // dự phòng: hỏi từng ví trên mempool.space
      for (const a of chunk) {
        const s = (await getJson(`https://mempool.space/api/address/${a}`)).chain_stats;
        out[a] = (s.funded_txo_sum - s.spent_txo_sum) / 1e8;
        await sleep(200);
      }
    }
    await sleep(1500);
  }
  return out;
}

async function scanBtc(prevSnapshots) {
  const { wallets } = JSON.parse(await readFile(new URL('./btc-exchange-wallets.json', import.meta.url), 'utf8'));
  const list = Object.entries(wallets).flatMap(([ex, addrs]) => addrs.map((addr) => ({ ex, addr })));
  const bal = await btcBalances(list.map((w) => w.addr));
  const nowMs = Date.now();
  const snaps = [...(prevSnapshots?.snapshots || []).filter((s) => nowMs - s.t < 30 * 3600e3), { t: nowMs, bal }];
  // Bản chụp cũ nhất nhưng không cũ hơn mốc cần so sánh (cho phép lệch vì GitHub đôi khi chạy trễ).
  const pick = (ageH) => snaps.filter((s) => nowMs - s.t >= (ageH - 0.75) * 3600e3).sort((a, b) => b.t - a.t)[0];
  const s4 = pick(4), s24 = pick(24) || snaps[0];
  const hours = Math.round((nowMs - s24.t) / 360e3) / 10;
  const rows = list.filter((w) => isFinite(bal[w.addr])).map((w) => ({
    ...w, now: bal[w.addr],
    h4: s4 && isFinite(s4.bal[w.addr]) ? s4.bal[w.addr] : null,
    h24: isFinite(s24.bal[w.addr]) && s24 !== snaps[snaps.length - 1] ? s24.bal[w.addr] : null,
  }));
  return { result: balanceResult('Bitcoin', 'https://mempool.space/address/', rows, hours), snapshots: { snapshots: snaps } };
}

async function buildOnchain(previous) {
  const coins = {};
  try { coins.ETH = await scanEth(); console.log(`onchain ETH: in ${coins.ETH.in24} / out ${coins.ETH.out24}, ${coins.ETH.wallets} ví`); }
  catch (e) { console.error('onchain ETH lỗi: ' + e.message); if (previous?.coins?.ETH) coins.ETH = previous.coins.ETH; }
  try {
    const { result, snapshots } = await scanBtc(await getJson(SITE + 'data/btc-snapshots.json').catch(() => null));
    coins.BTC = result;
    await writeFile(new URL('btc-snapshots.json', OUT), JSON.stringify(snapshots));
    console.log(`onchain BTC: in ${result.in24} / out ${result.out24}, so với ${result.hours}h trước, ${result.wallets} ví`);
  } catch (e) { console.error('onchain BTC lỗi: ' + e.message); if (previous?.coins?.BTC) coins.BTC = previous.coins.BTC; }
  for (const [sym, cfg] of Object.entries(ONCHAIN)) {
    try {
      coins[sym] = await scanToken(sym, cfg);
      console.log(`onchain ${sym}: in ${coins[sym].in24} / out ${coins[sym].out24}, ${coins[sym].hours}h`);
    } catch (e) {
      console.error(`onchain ${sym} lỗi: ${e.message}`);
      if (previous?.coins?.[sym]) coins[sym] = previous.coins[sym];
    }
  }
  return { updated: Date.now(), source: 'Blockscout', explorer: 'https://etherscan.io/tx/', coins };
}

// ---------- Vàng: báo cáo COT (CFTC) + lợi suất thực, chỉ số USD (FRED) ----------
const GOLD_CODE = '088691'; // Gold - COMEX (hợp đồng GC, 100 ounce)
const BROWSER_UA = { 'user-agent': 'Mozilla/5.0 (dca-tracker data builder)' };

// Báo cáo COT qua API dữ liệu công khai chính thức của CFTC (bảng Disaggregated Futures Only).
async function cotWeeks() {
  const url = 'https://publicreporting.cftc.gov/resource/72hh-3qpy.json'
    + `?cftc_contract_market_code=${GOLD_CODE}&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=60`;
  const rows = await getJson(url);
  // Tìm cột theo tên (API dùng chữ thường, đôi khi có 2 dấu gạch dưới hoặc thiếu hậu tố _all).
  const pick = (r, re) => +(r[Object.keys(r).find((k) => re.test(k))] ?? NaN);
  return rows.map((r) => ({
    date: String(r.report_date_as_yyyy_mm_dd).slice(0, 10),
    oi: pick(r, /^open_interest_all$/),
    mmL: pick(r, /^m_money_positions_long(_all)?$/), mmS: pick(r, /^m_money_positions_short(_all)?$/),
    pmL: pick(r, /^prod_merc_positions_long(_all)?$/), pmS: pick(r, /^prod_merc_positions_short(_all)?$/),
    swL: pick(r, /^swap_+positions_long(_all)?$/), swS: pick(r, /^swap_+positions_short(_all)?$/),
  })).filter((w) => isFinite(w.mmL) && isFinite(w.mmS)).reverse();
}

async function fredSeries(id, keep = 260) {
  const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`, { headers: BROWSER_UA });
  if (!res.ok) throw new Error(`FRED ${id} HTTP ${res.status}`);
  return (await res.text()).trim().split(/\r?\n/).slice(1).map((l) => l.split(','))
    .filter(([, v]) => v && v !== '.').map(([d, v]) => [d, +v]).slice(-keep);
}

async function buildGold() {
  const prev = await previous('gold.json');
  const part = async (name, fn, old) => {
    try { return await fn(); } catch (e) { console.error(`gold ${name} lỗi: ${e.message}, giữ bản cũ`); return old || []; }
  };
  const cot = await part('COT', async () => {
    const w = await cotWeeks();
    if (!w.length) throw new Error('không có dòng nào');
    return w;
  }, prev?.cot);
  const realYield = await part('DFII10', () => fredSeries('DFII10'), prev?.realYield);
  const dollar = await part('DTWEXBGS', () => fredSeries('DTWEXBGS'), prev?.dollar);
  if (!cot.length && !realYield.length && !dollar.length) throw new Error('không có dữ liệu vàng nào');
  console.log(`gold: COT ${cot.length} tuần (mới nhất ${cot.at(-1)?.date}), lợi suất thực ${realYield.at(-1)}, USD ${dollar.at(-1)}`);
  return { updated: Date.now(), cot, realYield, dollar, coins: {} };
}

// ---------- Lịch tin kinh tế Mỹ (tin mạnh, ảnh hưởng tới vàng) ----------
// 1) File xuất lịch tuần công khai của ForexFactory (chỉ có tuần hiện tại): lọc USD + mức ảnh hưởng High.
// 2) Lịch họp FOMC chính thức trên trang Fed (cả năm), để luôn biết kỳ họp Fed kế tiếp.
// Tin của các tuần trước được giữ lại từ bản cũ (feed chỉ có tuần hiện tại).
const FF_WEEK = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const FED_FOMC = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';
const CAL_RULES = [ // [mẫu tên tiếng Anh, tên tiếng Việt, nhóm]
  [/^Core CPI m\/m/, 'CPI lõi (tháng)', 'cpi'], [/^CPI m\/m/, 'Lạm phát CPI (tháng)', 'cpi'], [/^CPI y\/y/, 'Lạm phát CPI (năm)', 'cpi'], [/^Core CPI y\/y/, 'CPI lõi (năm)', 'cpi'],
  [/^Core PCE Price Index/, 'Lạm phát PCE lõi (Fed theo dõi sát nhất)', 'cpi'], [/^PCE Price Index/, 'Lạm phát PCE', 'cpi'],
  [/^Core PPI/, 'Giá sản xuất PPI lõi', 'cpi'], [/^PPI/, 'Giá sản xuất PPI', 'cpi'],
  [/^Non-Farm Employment Change/, 'Bảng lương phi nông nghiệp (NFP)', 'jobs'], [/^ADP Non-Farm/, 'Việc làm ADP', 'jobs'],
  [/^Unemployment Rate/, 'Tỷ lệ thất nghiệp', 'jobs'], [/^Average Hourly Earnings/, 'Thu nhập bình quân theo giờ', 'jobs'],
  [/^Unemployment Claims/, 'Đơn xin trợ cấp thất nghiệp', 'jobs'], [/^JOLTS/, 'Số việc làm trống JOLTS', 'jobs'],
  [/^Federal Funds Rate/, 'Fed công bố lãi suất', 'fed'], [/^FOMC Statement/, 'Tuyên bố của Fed (FOMC)', 'fed'],
  [/^FOMC Press Conference/, 'Họp báo Chủ tịch Fed', 'fed'], [/^FOMC Meeting Minutes/, 'Biên bản họp Fed (FOMC)', 'fed'],
  [/^FOMC Economic Projections/, 'Dự báo kinh tế của Fed', 'fed'], [/Fed Chair.*Speaks|Chairman .* Speaks/, 'Chủ tịch Fed phát biểu', 'speech'],
  [/Testifies/, 'Chủ tịch Fed điều trần', 'speech'], [/Speaks/, 'Quan chức Fed phát biểu', 'speech'],
  [/^Advance GDP/, 'GDP quý (sơ bộ)', 'gdp'], [/^Prelim GDP/, 'GDP quý (điều chỉnh)', 'gdp'], [/^Final GDP/, 'GDP quý (cuối cùng)', 'gdp'],
  [/^Core Retail Sales/, 'Doanh số bán lẻ lõi', 'gdp'], [/^Retail Sales/, 'Doanh số bán lẻ', 'gdp'],
  [/^ISM Manufacturing PMI/, 'PMI sản xuất ISM', 'gdp'], [/^ISM Services PMI/, 'PMI dịch vụ ISM', 'gdp'],
  [/Consumer Sentiment/, 'Niềm tin tiêu dùng (UoM)', 'gdp'], [/Consumer Confidence/, 'Niềm tin tiêu dùng (CB)', 'gdp'],
];
const calName = (title) => { const r = CAL_RULES.find(([re]) => re.test(title)); return r ? [r[1], r[2]] : [title, 'other']; };

// Giờ New York (ET, có giờ mùa hè) → mốc UTC.
function etToUtc(y, mon, d, h, mi) {
  const guess = Date.UTC(y, mon, d, h, mi);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(guess).map((p) => [p.type, +p.value || p.value]));
  const asEt = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return guess + (guess - asEt);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
async function fomcMeetings() {
  const res = await fetch(FED_FOMC, { headers: { 'user-agent': 'dca-tracker data builder' } });
  if (!res.ok) throw new Error('Fed HTTP ' + res.status);
  const html = await res.text();
  const out = [];
  for (const sec of html.split(/<h4><a id="\d+">/).slice(1)) {
    const year = +(sec.match(/^(\d{4}) FOMC Meetings/) || [])[1];
    if (!year) continue;
    const re = /<strong>([A-Za-z/]+)<\/strong>[\s\S]*?fomc-meeting__date[^>]*>([^<]+)</g;
    for (const [, month, date] of sec.matchAll(re)) {
      const m = date.trim().match(/^(\d+)-(\d+)(\*)?$/); // bỏ họp bất thường / bỏ phiếu từ xa
      if (!m) continue;
      const [m1, m2] = month.split('/');
      const mon = MONTHS.indexOf(+m[2] < +m[1] && m2 ? m2 : m1);
      if (mon < 0) continue;
      // Fed công bố quyết định lúc 14:00 giờ New York ngày họp thứ hai; dấu * = kèm dự báo kinh tế (biểu đồ chấm).
      out.push({ t: etToUtc(year, mon, +m[2], 14, 0), title: 'FOMC rate decision', vi: 'Fed công bố lãi suất (họp FOMC)', kind: 'fed', sep: !!m[3], src: 'fed' });
    }
  }
  if (!out.length) throw new Error('không đọc được lịch họp FOMC');
  return out.filter((f) => f.t >= Date.now() - 30 * DAY * 1000).sort((a, b) => a.t - b.t); // bỏ các năm cũ
}

async function buildCalendar() {
  const prev = await previous('calendar.json');
  const now = Date.now();
  let week = [];
  try {
    const res = await fetch(FF_WEEK, { headers: { 'user-agent': 'dca-tracker data builder' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    week = (await res.json()).filter((e) => e.country === 'USD' && e.impact === 'High').map((e) => {
      const [vi, kind] = calName(e.title);
      return { t: Date.parse(e.date), title: e.title, vi, kind, forecast: e.forecast || '', previous: e.previous || '', src: 'ff' };
    }).filter((e) => isFinite(e.t));
  } catch (e) { console.error(`calendar tuần lỗi: ${e.message}, dùng tin cũ`); }
  let fomc = prev?.fomc || [];
  try { fomc = await fomcMeetings(); } catch (e) { console.error(`FOMC lỗi: ${e.message}, giữ bản cũ`); }

  // Giữ tin cũ (14 ngày gần nhất) không còn trong feed; tin trong feed mới thay thế tin cùng tên + giờ.
  const key = (e) => e.title + '|' + e.t;
  const fresh = new Set(week.map(key));
  const kept = (prev?.events || []).filter((e) => e.src === 'ff' && !fresh.has(key(e)) && e.t >= now - 14 * DAY * 1000);
  const events = [...kept, ...week].sort((a, b) => a.t - b.t);
  if (!events.length && !fomc.length) throw new Error('không có tin nào');
  console.log(`calendar: ${week.length} tin mạnh tuần này, giữ ${kept.length} tin cũ, ${fomc.length} kỳ họp FOMC (kế tiếp ${new Date(fomc.find((f) => f.t > now)?.t || 0).toISOString().slice(0, 10)})`);
  return { updated: now, events, fomc, coins: {} };
}

// ---------- Dòng tiền quỹ ETF Bitcoin/Ethereum spot (Mỹ) ----------
// Nguồn: bảng công khai của Farside Investors (đơn vị triệu USD, số âm ghi trong ngoặc). Chỉ lưu số theo ngày, ghi nguồn trên web.
const FARSIDE = { BTC: 'https://farside.co.uk/btc/', ETH: 'https://farside.co.uk/eth/' }; // ~15 ngày gần nhất
// Trang toàn bộ lịch sử (nặng hơn), chỉ tải khi bản đã lưu chưa đủ lịch sử.
const FARSIDE_ALL = { BTC: 'https://farside.co.uk/bitcoin-etf-flow-all-data/', ETH: 'https://farside.co.uk/ethereum-etf-flow-all-data/' };
const MON3 = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

function farsideNum(s) {
  s = s.replace(/,/g, '').trim();
  if (!s || s === '-') return s === '-' ? 0 : null;
  const neg = /^\(.*\)$/.test(s);
  const v = parseFloat(s.replace(/[()]/g, ''));
  return isFinite(v) ? (neg ? -v : v) : null;
}

async function farsideTable(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'dca-tracker data builder' } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const html = await res.text();
  const cells = (row) => [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)]
    .map((c) => c[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => cells(m[1]));
  const head = rows.find((r) => r.some((c) => /^(IBIT|ETHA)$/.test(c)));
  if (!head) throw new Error('không thấy hàng tên quỹ');
  const days = [];
  for (const r of rows) {
    const m = r[0]?.match(/^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})$/);
    if (!m) continue;
    const total = farsideNum(r[r.length - 1]);
    if (total == null) continue; // hôm nay chưa có số
    const funds = {};
    head.forEach((name, i) => { if (i > 0 && i < r.length - 1 && /^[A-Z]{3,5}$/.test(name)) { const v = farsideNum(r[i]); if (v) funds[name] = v; } });
    days.push({ d: new Date(Date.UTC(+m[3], MON3[m[2]], +m[1])).toISOString().slice(0, 10), total, funds });
  }
  if (!days.length) throw new Error('không đọc được dòng nào');
  return days.sort((a, b) => (a.d < b.d ? -1 : 1));
}

async function buildEtf() {
  const prev = await previous('etf.json');
  const out = { updated: Date.now(), source: 'Farside Investors (farside.co.uk)', coins: {} };
  for (const [coin, url] of Object.entries(FARSIDE)) {
    try {
      await sleep(3000); // nghỉ giữa các lần tải cho nhẹ phía máy chủ Farside
      let fresh;
      if ((prev?.coins?.[coin]?.length || 0) < 100) {
        // Lần đầu: thử trang toàn bộ lịch sử; nếu bị từ chối thì dùng trang 15 ngày (lịch sử sẽ tích lũy dần).
        fresh = await farsideTable(FARSIDE_ALL[coin]).catch((e) => { console.error(`etf ${coin} trang lịch sử lỗi: ${e.message}, dùng trang gần đây`); return null; });
        if (!fresh) await sleep(3000);
      }
      fresh ||= await farsideTable(url);
      // Gộp với bản cũ để giữ lịch sử dài hơn bảng trên trang (bản mới ghi đè ngày trùng).
      const map = new Map((prev?.coins?.[coin] || []).map((x) => [x.d, x]));
      for (const x of fresh) map.set(x.d, x);
      out.coins[coin] = [...map.values()].sort((a, b) => (a.d < b.d ? -1 : 1)).slice(-400);
      const last = out.coins[coin].at(-1);
      console.log(`etf ${coin}: ${fresh.length} ngày trên trang, lưu ${out.coins[coin].length} ngày, mới nhất ${last.d} = ${last.total}M`);
    } catch (e) {
      console.error(`etf ${coin} lỗi: ${e.message}, giữ bản cũ`);
      if (prev?.coins?.[coin]) out.coins[coin] = prev.coins[coin];
    }
  }
  if (!Object.keys(out.coins).length) throw new Error('không có dữ liệu ETF');
  return out;
}

// ---------- Lịch sử gom/xả lệnh lớn (từ bot Telegram) ----------
// Bot cộng dồn lệnh lớn theo nến ngày Binance; link chỉ-đọc /history nằm trong secret BOT_HISTORY_URL của repo.
let botData = null; // lấy 1 lần, dùng cho cả history.json và status.json
function loadBot() {
  const url = process.env.BOT_HISTORY_URL;
  if (!url) return Promise.reject(new Error('chưa có secret BOT_HISTORY_URL'));
  return (botData ||= getJson(url));
}

async function buildHistory() {
  const d = await loadBot();
  const days = Object.entries(d.days || {})
    .map(([k, v]) => ({ d: k.replace('day:', ''), runs: v.runs, first: v.first, coins: v.coins }))
    .sort((a, b) => (a.d < b.d ? -1 : 1));
  if (!days.length) throw new Error('bot chưa có dữ liệu ngày nào');
  console.log(`history: ${days.length} ngày (${days[0].d} → ${days.at(-1).d}), ${d.coins.length} coin`);
  return { updated: Date.now(), thresholds: d.coins, days, coins: Object.fromEntries(d.coins.map((c) => [c.coin, c.min])) };
}

// ---------- Trạng thái bot cho trang Tổng quan ----------
// Kịch bản Elliott BTC (đang ở sóng nào, các mức Fib) và kế hoạch bán/giữ từng coin (mức nào bot đã báo).
async function buildStatus() {
  const d = await loadBot();
  if (!d.status?.elliott && !d.status?.plan) throw new Error('bot chưa có trạng thái (cần deploy bản mới của bot)');
  console.log(`status: Elliott ${d.status.elliott?.phase || '—'}, kế hoạch ${d.status.plan?.length || 0} coin`);
  return { updated: d.updated, elliott: d.status.elliott || null, plan: d.status.plan || null, btcBuy: d.status.btcBuy || null };
}

// ---------- Chạy ----------
const previous = (name) => getJson(SITE + 'data/' + name).catch(() => null);
await mkdir(OUT, { recursive: true });

async function save(name, build) {
  if (process.env.ONLY && !process.env.ONLY.split(',').includes(name)) return; // VD: ONLY=calendar.json để chạy thử 1 phần
  try {
    const data = await build();
    await writeFile(new URL(name, OUT), JSON.stringify(data));
    console.log(`${name}: OK${data.coins ? ` (${Object.keys(data.coins).length} coin)` : ''}`);
  } catch (e) {
    console.error(`${name} lỗi: ${e.message}, giữ bản cũ`);
    const old = await previous(name);
    if (old) await writeFile(new URL(name, OUT), JSON.stringify(old));
  }
}

await save('unlocks.json', buildUnlocks);
const prevOnchain = await previous('onchain.json');
await save('onchain.json', () => buildOnchain(prevOnchain));
await save('gold.json', buildGold);
await save('calendar.json', buildCalendar);
await save('etf.json', buildEtf);
await save('history.json', buildHistory);
await save('status.json', buildStatus);
