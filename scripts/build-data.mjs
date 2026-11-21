// Chạy trên GitHub Actions mỗi giờ (xem .github/workflows/pages.yml), tạo 2 file dữ liệu nhỏ cho website:
//   data/unlocks.json  lịch mở khóa token (nguồn: DefiLlama)
//   data/onchain.json  coin nạp lên / rút khỏi sàn trong 24h (nguồn: Blockscout, có gắn nhãn ví sàn)
// Phần nào lỗi thì giữ lại bản đang chạy trên website, để không mất dữ liệu.
import { mkdir, readFile, writeFile } from 'node:fs/promises';

// Địa chỉ website của chính repo đang chạy (GitHub Actions có sẵn biến GITHUB_REPOSITORY = "chủ/tên-repo").
const [GH_OWNER, GH_REPO] = (process.env.GITHUB_REPOSITORY || 'triphantotdigi/dca-tracker').split('/');
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

// ---------- Chạy ----------
const previous = (name) => getJson(SITE + 'data/' + name).catch(() => null);
await mkdir(OUT, { recursive: true });

async function save(name, build) {
  try {
    const data = await build();
    await writeFile(new URL(name, OUT), JSON.stringify(data));
    console.log(`${name}: OK (${Object.keys(data.coins).length} coin)`);
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
