'use strict';
// ---------- Đồng bộ danh mục giữa các thiết bị qua GitHub Gist ----------
// Mỗi máy nhập cùng 1 token GitHub (chỉ quyền "gist"). Dữ liệu lệnh được lưu trong 1 Gist bí mật trên tài khoản của bạn.
// Gộp thay đổi kiểu 3 bên: so máy này và Gist với bản đã đồng bộ lần trước, nên sửa/xóa ở 2 máy khác nhau đều giữ được.
// Token chỉ lưu trong trình duyệt của máy đó (localStorage), chỉ gửi tới api.github.com.

const SYNC_KEY = 'dca-sync';       // { token, login, gistId, at }
const SYNC_BASE = 'dca-sync-base'; // danh sách lệnh lúc đồng bộ thành công gần nhất
const GIST_FILE = 'dca-tracker.json';
const GH_API = 'https://api.github.com';
const SYNC_EVERY = 60e3;

const readJson = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const writeJson = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} };

const sy = { cfg: readJson(SYNC_KEY) || {}, busy: false, again: false, timer: 0, err: '' };

async function gh(path, opts = {}, token = sy.cfg.token) {
  const res = await fetch(GH_API + path, {
    ...opts, cache: 'no-store',
    headers: { accept: 'application/vnd.github+json', authorization: 'Bearer ' + token, ...(opts.body ? { 'content-type': 'application/json' } : {}) },
  });
  if (res.status === 401) throw Object.assign(new Error('Token sai, đã hết hạn hoặc đã bị xóa.'), { auth: true });
  if (res.status === 404 && path.startsWith('/gists/')) throw Object.assign(new Error('Không tìm thấy Gist (có thể đã bị xóa).'), { gone: true });
  if (res.status === 403 || res.status === 404) throw new Error('Token không có quyền "gist". Tạo token mới và tích ô gist.');
  if (!res.ok) throw new Error('GitHub lỗi ' + res.status);
  return res.json();
}

const packTxs = (list) => JSON.stringify({ version: 1, updated: new Date().toISOString(), txs: list }, null, 1);
const byId = (list) => [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const sameTxs = (a, b) => JSON.stringify(byId(a)) === JSON.stringify(byId(b));

// Gộp 3 bên theo id lệnh: bên nào thay đổi so với bản gốc thì lấy bên đó; cả hai cùng sửa thì ưu tiên máy này.
function merge3(base, local, remote) {
  const map = (a) => new Map((a || []).map((t) => [t.id, t]));
  const B = map(base), L = map(local), R = map(remote);
  const eq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const out = [];
  for (const id of new Set([...B.keys(), ...L.keys(), ...R.keys()])) {
    const b = B.get(id), l = L.get(id), r = R.get(id);
    const pick = eq(l, r) ? l : eq(l, b) ? r : eq(r, b) ? l : (l ?? r);
    if (pick) out.push(pick);
  }
  return out;
}

// Tìm Gist cũ của web này trên tài khoản (máy thứ 2 kết nối), không có thì tạo mới từ dữ liệu máy này.
async function ensureGist() {
  if (sy.cfg.gistId) return false;
  for (let page = 1; page <= 10; page++) {
    const list = await gh(`/gists?per_page=100&page=${page}`);
    const g = list.find((x) => x.files && x.files[GIST_FILE]);
    if (g) { sy.cfg.gistId = g.id; writeJson(SYNC_KEY, sy.cfg); return false; }
    if (list.length < 100) break;
  }
  const g = await gh('/gists', { method: 'POST', body: JSON.stringify({
    description: 'Altcoin DCA Tracker: dữ liệu danh mục (web tự đồng bộ, đừng sửa tay)',
    public: false, files: { [GIST_FILE]: { content: packTxs(txs) } },
  }) });
  sy.cfg.gistId = g.id; writeJson(SYNC_KEY, sy.cfg);
  writeJson(SYNC_BASE, txs);
  return true;
}

async function readRemote() {
  const g = await gh(`/gists/${sy.cfg.gistId}`);
  const f = g.files?.[GIST_FILE];
  if (!f) return [];
  const text = f.truncated ? await (await fetch(f.raw_url, { cache: 'no-store' })).text() : f.content;
  const d = JSON.parse(text);
  const list = Array.isArray(d) ? d : d.txs;
  if (!Array.isArray(list)) throw new Error('Dữ liệu trong Gist không hợp lệ.');
  return list;
}

async function syncNow() {
  if (!sy.cfg.token) return;
  if (sy.busy) { sy.again = true; return; }
  sy.busy = true; renderSync();
  try {
    if (await ensureGist()) { sy.cfg.at = Date.now(); sy.err = ''; return; } // vừa tạo Gist từ dữ liệu máy này
    const remote = await readRemote();
    const base = readJson(SYNC_BASE);
    let merged;
    if (base) merged = merge3(base, txs, remote);
    else if (!txs.length || !remote.length || sameTxs(txs, remote)) merged = merge3([], txs, remote);
    else {
      // Lần đầu máy này nối vào Gist đã có dữ liệu (từ máy khác) và hai bên khác nhau: hỏi.
      merged = confirm(`Trên GitHub đã có ${remote.length} lệnh (từ thiết bị khác), máy này có ${txs.length} lệnh.\n\n` +
        `OK = dùng dữ liệu trên GitHub (thay dữ liệu máy này)\nHủy = gộp cả hai`) ? remote : merge3([], txs, remote);
    }
    if (!sameTxs(merged, txs)) { txs = merged; syncSaveLocal(); render(); }
    if (!sameTxs(merged, remote)) {
      await gh(`/gists/${sy.cfg.gistId}`, { method: 'PATCH', body: JSON.stringify({ files: { [GIST_FILE]: { content: packTxs(merged) } } }) });
    }
    writeJson(SYNC_BASE, merged);
    sy.cfg.at = Date.now(); sy.err = '';
  } catch (e) {
    sy.err = e.message;
    if (e.gone) { sy.cfg.gistId = null; writeJson(SYNC_BASE, null); } // Gist bị xóa: lần sau tạo lại từ dữ liệu máy này
  } finally {
    writeJson(SYNC_KEY, sy.cfg);
    sy.busy = false; renderSync();
    if (sy.again) { sy.again = false; syncNow(); }
  }
}

// Mỗi lần app lưu (thêm/sửa/xóa/nhập file) thì đẩy lên sau 1.5 giây.
const syncSaveLocal = save;
save = function () { syncSaveLocal(); if (sy.cfg.token) { clearTimeout(sy.timer); sy.timer = setTimeout(syncNow, 1500); } };

// ---------- Giao diện ----------
const vnTime = (ms) => new Date(ms).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });

function renderSync() {
  const on = !!sy.cfg.token, btn = $('#syncBtn');
  btn.classList.toggle('sync-on', on && !sy.err);
  btn.classList.toggle('sync-err', on && !!sy.err);
  btn.title = !on ? 'Đồng bộ giữa các thiết bị (chưa bật)' : sy.err ? 'Lỗi đồng bộ: ' + sy.err : sy.cfg.at ? 'Đã đồng bộ lúc ' + vnTime(sy.cfg.at) : 'Đang đồng bộ';
  $('#syncSetup').hidden = on;
  $('#syncLinked').hidden = !on;
  if (on) {
    $('#syncInfo').innerHTML = `Đã kết nối GitHub <b>${esc(sy.cfg.login || '')}</b>. ` +
      (sy.busy ? 'Đang đồng bộ…' : sy.cfg.at ? `Đồng bộ lần cuối: <b>${vnTime(sy.cfg.at)}</b>.` : '') +
      (sy.cfg.gistId ? ` <a href="https://gist.github.com/${encodeURIComponent(sy.cfg.login || '')}/${encodeURIComponent(sy.cfg.gistId)}" target="_blank" rel="noopener">Xem Gist</a>` : '');
  }
  $('#syncMsg').textContent = sy.err ? '⚠️ ' + sy.err : '';
}

$('#syncBtn').addEventListener('click', () => { renderSync(); $('#syncDlg').showModal(); });
$('#syncClose').addEventListener('click', () => $('#syncDlg').close());
$('#syncDlg').addEventListener('click', (e) => { if (e.target === $('#syncDlg')) $('#syncDlg').close(); });

$('#syncConnect').addEventListener('click', async () => {
  const token = $('#syncToken').value.trim();
  if (!token) { $('#syncMsg').textContent = 'Dán token vào ô trên trước.'; return; }
  $('#syncMsg').textContent = 'Đang kiểm tra token…';
  try {
    const user = await gh('/user', {}, token);
    sy.cfg = { token, login: user.login, gistId: null, at: 0 };
    writeJson(SYNC_KEY, sy.cfg); writeJson(SYNC_BASE, null);
    $('#syncToken').value = '';
    sy.err = '';
    await syncNow();
  } catch (e) {
    $('#syncMsg').textContent = '⚠️ ' + e.message;
  }
});
$('#syncNowBtn').addEventListener('click', syncNow);
$('#syncLogout').addEventListener('click', () => {
  if (!confirm('Ngắt đồng bộ trên máy này? Dữ liệu trên máy và trên GitHub vẫn giữ nguyên.')) return;
  sy.cfg = {}; sy.err = '';
  writeJson(SYNC_KEY, null); writeJson(SYNC_BASE, null);
  renderSync();
});

// Mở web, quay lại tab, và mỗi phút khi đang xem: lấy thay đổi từ máy khác.
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncNow(); });
setInterval(() => { if (!document.hidden) syncNow(); }, SYNC_EVERY);
renderSync();
syncNow();
