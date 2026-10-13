/* Cấp phát nước cất — Trường Dược · Frontend
 * Gọi API cùng tên miền (/api); Cloudflare Worker chuyển tiếp tới Google Apps Script. */
(function () {
'use strict';

/* ---------- helpers ---------- */
const API = '/api';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => (Math.round((+n || 0) * 10) / 10).toLocaleString('vi-VN');
const pad = n => String(n).padStart(2, '0');
const dShort = iso => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear(); };
const dTime = iso => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : pad(d.getHours()) + ':' + pad(d.getMinutes()) + ' ' + dShort(iso); };
const dHM = iso => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : pad(d.getHours()) + ':' + pad(d.getMinutes()) + ' ' + pad(d.getDate()) + '/' + pad(d.getMonth() + 1); };
const todayStr = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const TOKEN_KEY = 'nuoccat.token';
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} };

const ROLES = { user: 'Cán bộ đề nghị', tbm: 'Trưởng bộ môn', qtth: 'Trưởng phòng Quản trị Tổng hợp', bgh: 'Phó hiệu trưởng phụ trách', kho: 'Phụ trách phát nước cất' };
const STATUS = {
  cho_tbm: { t: 'Chờ Trưởng bộ môn', c: 'info' }, cho_qtth: { t: 'Chờ Trưởng phòng QTTH', c: 'info' }, cho_bgh: { t: 'Chờ Phó hiệu trưởng', c: 'info' },
  cho_cap: { t: 'Chờ phát nước', c: 'warn' }, da_cap: { t: 'Đã phát nước', c: 'ok' }, tu_choi: { t: 'Không được duyệt', c: 'bad' }, da_huy: { t: 'Đã hủy', c: 'mute' }
};
const USTATUS = { active: ['ok', 'Hoạt động'], locked: ['bad', 'Đã khóa'], pending: ['info', 'Chờ duyệt'], rejected: ['mute', 'Đã từ chối'] };
/* Quy trình 5 bước, 3 chữ ký đồng ý như phiếu giấy. role = vai trò xử lý bước đó. */
const FLOW = [
  { k: 'lap',  t: 'Lập giấy đề nghị',                  s: 'Lập phiếu',       role: null },
  { k: 'tbm',  t: 'Trưởng bộ môn đồng ý',              s: 'Trưởng BM',       role: 'tbm' },
  { k: 'qtth', t: 'Trưởng phòng QTTH đồng ý',          s: 'TP QTTH',         role: 'qtth' },
  { k: 'bgh',  t: 'Phó hiệu trưởng phụ trách đồng ý',  s: 'Phó HT',          role: 'bgh' },
  { k: 'cap',  t: 'Phát nước cất',                     s: 'Phát nước',       role: 'kho' }
];
const NSTEP = FLOW.length;
const STEP_OF = { cho_tbm: 'tbm', cho_qtth: 'qtth', cho_bgh: 'bgh', cho_cap: 'cap' };
const STEP_ROLE = { tbm: 'tbm', qtth: 'qtth', bgh: 'bgh', cap: 'kho' };
const OPEN = ['cho_tbm', 'cho_qtth', 'cho_bgh'];
const TABS = ['overview', 'requests', 'stock', 'admin'];

const S = {
  token: lsGet(TOKEN_KEY), me: null, booting: true,
  cfg: { threshold: 100, capacity: 500, appUrl: '', mailEnabled: true }, departments: [], users: {}, requests: [], stock: [], adminUsers: [],
  log: null, mail: null, pub: null, pubErr: null,
  tab: 'overview', filter: 'todo', q: '', adminTab: 'pending', authTab: 'login', authMsg: null,
  open: null, openMode: null, confirm: null, pending: 0, deep: null
};
try {
  const h = location.hash.slice(1);
  if (TABS.includes(h)) S.tab = h;
  const m = h.match(/^phieu-([\w-]+)$/); if (m) S.deep = m[1];
} catch (e) {}

/* ---------- API ---------- */
async function api(action, payload) {
  S.pending++; $('#loadingBar').hidden = false;
  try {
    let res;
    try {
      res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, payload: payload || {}, token: S.token }) });
    } catch (e) { throw { code: 'network', error: 'Không kết nối được máy chủ. Kiểm tra mạng và thử lại.' }; }
    let j;
    try { j = await res.json(); } catch (e) { throw { code: 'network', error: 'Máy chủ trả về dữ liệu không hợp lệ (' + res.status + '). Vui lòng thử lại sau ít phút.' }; }
    if (!j.ok) { if (j.code === 'auth' && S.me) signOutLocal(j.error); throw j; }
    return j.data;
  } finally {
    S.pending--; if (S.pending <= 0) { S.pending = 0; $('#loadingBar').hidden = true; }
  }
}
const errText = e => (e && (e.error || e.message)) || 'Đã có lỗi xảy ra.';

/* ---------- roles & derived ---------- */
const isAdmin = () => !!(S.me && S.me.isAdmin);
const dept = id => S.departments.find(d => d.id === id);
const deptLabel = r => (dept(r.deptId)?.name) || r.deptName || '—';
const qtyOf = r => r.qtyApproved ?? r.qty;
const nm = id => { if (!id) return '—'; const u = S.users[id]; return (u && u.fullName) || (S.me && id === S.me.id ? S.me.fullName : 'Người dùng đã xóa'); };
const initials = name => String(name || '?').trim().split(/\s+/).slice(-2).map(w => w[0]).join('').toUpperCase();
function avatar(id, size) {
  const n = nm(id); let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `<span aria-hidden="true" class="av" style="width:${size}px;height:${size}px;background:hsl(${h} 45% 42%);font-size:${Math.round(size * .4)}px">${esc(initials(n))}</span>`;
}
function calc() {
  let bal = 0; for (const m of S.stock) bal += m.type === 'xuat' ? -m.qty : m.qty;
  const reserved = S.requests.filter(r => r.status === 'cho_cap').reduce((a, r) => a + qtyOf(r), 0);
  const pendList = S.requests.filter(r => OPEN.includes(r.status));
  const pending = pendList.reduce((a, r) => a + (+r.qty || 0), 0);
  const since = Date.now() - 30 * 864e5;
  const used30 = S.stock.filter(m => m.type === 'xuat' && Date.parse(m.at) >= since).reduce((a, m) => a + m.qty, 0);
  const avail = bal - reserved, daily = used30 / 30, days = daily > 0 ? avail / daily : null;
  const thr = +S.cfg.threshold || 0, cap = +S.cfg.capacity || 500;
  const level = avail <= 0 ? 'bad' : avail <= thr ? 'warn' : 'ok';
  const suggest = Math.max(0, Math.ceil((cap - avail) / 10) * 10);
  return { bal, reserved, pending, pendCount: pendList.length, used30, avail, daily, days, level, thr, cap, suggest };
}
const holders = (step, r) => Object.entries(S.users).filter(([, u]) => u.status === 'active' && u.role === STEP_ROLE[step] && (step !== 'tbm' || (r && u.deptId && u.deptId === r.deptId))).map(([id]) => id);
const ownRole = (step, r) => !!S.me && S.me.role === STEP_ROLE[step] && (step !== 'tbm' || (!!r && !!S.me.deptId && S.me.deptId === r.deptId));
const canAct = (step, r) => !!S.me && (isAdmin() || ownRole(step, r));
const canStock = () => !!S.me && (isAdmin() || S.me.role === 'kho' || S.me.role === 'qtth');
const todo = () => S.requests.filter(r => { const st = STEP_OF[r.status]; return st && (ownRole(st, r) || (isAdmin() && !holders(st, r).length)); });

/* Tiến trình của một phiếu: mỗi bước có state done | current | rejected | skipped | todo */
function progress(r) {
  const cur = STEP_OF[r.status], steps = r.steps || {};
  const ended = r.status === 'tu_choi' || r.status === 'da_huy';
  return FLOW.map(f => {
    if (f.k === 'lap') { const s = steps.lap || {}; return { ...f, state: 'done', by: r.requesterId, at: r.createdAt, mail: s.mail }; }
    const s = steps[f.k];
    if (s) return { ...f, state: s.ok ? 'done' : 'rejected', by: s.by, at: s.at, note: s.note, qty: s.qty, mail: s.mail };
    if (cur === f.k) return { ...f, state: 'current' };
    return { ...f, state: ended ? 'skipped' : 'todo' };
  });
}
function stepNo(r) {
  const i = FLOW.findIndex(f => f.k === STEP_OF[r.status]);
  if (i >= 0) return i + 1;
  if (r.status === 'da_cap') return NSTEP;
  const p = progress(r); const j = p.findIndex(x => x.state === 'rejected'); return j >= 0 ? j + 1 : 1;
}

/* ---------- ui helpers ---------- */
let tt;
function toast(m, kind) { const t = $('#toast'); t.textContent = m; t.className = 'toast' + (kind ? ' ' + kind : ''); t.hidden = false; clearTimeout(tt); tt = setTimeout(() => t.hidden = true, 3800); }
async function run(btn, fn, ok) {
  if (btn) btn.setAttribute('aria-busy', 'true');
  try { const r = await fn(); if (ok) toast(typeof ok === 'function' ? ok(r) : ok); return r ?? true; }
  catch (e) { if (e && e.code !== 'auth') toast(errText(e), 'bad'); return false; }
  finally { if (btn) btn.removeAttribute('aria-busy'); }
}
const chip = st => { const s = STATUS[st] || { t: st, c: 'mute' }; return `<span class="chip ${s.c}">${esc(s.t)}</span>`; };
const uchip = st => { const s = USTATUS[st] || ['mute', st]; return `<span class="chip ${s[0]}">${esc(s[1])}</span>`; };
const deptOptions = (sel, none) => (none ? `<option value="">— Không thuộc bộ môn —</option>` : '') + S.departments.map(d => `<option value="${esc(d.id)}" ${d.id === sel ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
const roleOptions = sel => Object.entries(ROLES).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v}</option>`).join('');
function gaugeHTML(avail, cap, thr) {
  const pct = v => Math.max(0, Math.min(100, v / (cap || 1) * 100));
  return `<div class="tank" role="img" aria-label="Mức nước ${fmt(avail)} trên ${fmt(cap)} lít">
    <div class="fill" style="height:${pct(avail)}%"></div>${[25, 50, 75].map(p => `<div class="tick" style="bottom:${p}%"></div>`).join('')}
    <div class="thr" style="bottom:${pct(thr)}%"><span>${fmt(thr)} L</span></div></div>`;
}
const typing = el => { const a = document.activeElement; return !!(a && el && el.contains(a) && a.matches('input,textarea,select')); };

/* Thanh tiến trình đầy đủ (trong phiếu) */
function flowBar(r) {
  const p = progress(r);
  return `<ol class="flow" aria-label="Tiến trình phiếu">${p.map((s, i) => {
    const mark = s.state === 'done' ? '✓' : s.state === 'rejected' ? '✕' : String(i + 1);
    let meta = '';
    if (s.state === 'done' || s.state === 'rejected') meta = `${esc(nm(s.by))}<br>${dHM(s.at)}`;
    else if (s.state === 'current') { const h = holders(s.k, r); meta = 'Đang chờ' + (h.length ? ': ' + h.map(nm).map(esc).join(', ') : ''); }
    else if (s.state === 'skipped') meta = 'Dừng';
    return `<li class="f-${s.state}" ${s.state === 'current' ? 'aria-current="step"' : ''}><span class="fdot">${mark}</span><span class="flabel">${esc(s.s)}</span><span class="fmeta">${meta}</span></li>`;
  }).join('')}</ol>`;
}
/* Thanh tiến trình gọn (trong danh sách) */
function miniFlow(r) {
  const p = progress(r), n = stepNo(r);
  const label = r.status === 'da_cap' ? 'Hoàn tất' : r.status === 'tu_choi' ? `Dừng ở bước ${n}` : r.status === 'da_huy' ? 'Đã hủy' : `Bước ${n}/${NSTEP} · ${(STATUS[r.status] || {}).t || FLOW[n - 1].t}`;
  return `<span class="mflow" title="${esc(label)}"><span class="msegs" aria-hidden="true">${p.map(s => `<i class="m-${s.state}"></i>`).join('')}</span><span class="mlabel">${esc(label)}</span></span>`;
}
function mailLine(mail) {
  if (!mail) return '';
  const names = (mail.to || []).map(nm).map(esc).join(', ');
  const miss = (mail.missing || []).length ? ` · thiếu email: ${(mail.missing || []).map(nm).map(esc).join(', ')}` : '';
  if (mail.status === 'sent') return `<div class="mailline ok">✉ Đã gửi email: ${names}${miss}</div>`;
  if (mail.status === 'error') return `<div class="mailline bad">✉ Gửi email lỗi${mail.error ? ' (' + esc(mail.error) + ')' : ''}. Người nhận dự kiến: ${names || '—'}</div>`;
  if (mail.status === 'off') return `<div class="mailline">✉ Thông báo email đang tắt</div>`;
  if (mail.status === 'none') return `<div class="mailline warn">✉ Chưa gửi email: không có người nhận phù hợp${miss}</div>`;
  return '';
}

/* ---------- data ---------- */
async function loadAll() {
  const d = await api('bootstrap');
  S.me = d.me; S.cfg = d.cfg; S.departments = d.departments;
  S.users = {}; d.users.forEach(u => S.users[u.id] = u);
  S.requests = d.requests.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  S.stock = d.stock.sort((a, b) => (a.at || '').localeCompare(b.at || ''));
  S.adminUsers = d.adminUsers || [];
}
async function refresh() { try { await loadAll(); render(); } catch (e) { if (e && e.code !== 'auth') toast(errText(e), 'bad'); } }
async function loadPublic() { try { S.pub = await api('publicStatus'); S.pubErr = null; } catch (e) { S.pub = null; S.pubErr = e; } }
function signOutLocal(msg) {
  S.token = null; S.me = null; lsSet(TOKEN_KEY, null); closeSheet();
  S.authTab = 'login'; S.authMsg = msg ? { kind: 'err', text: msg } : null;
  loadPublic().then(() => render(true)); render(true);
}
function openDeepLink() {
  if (!S.deep || !S.me) return;
  const id = S.deep; S.deep = null;
  try { history.replaceState(null, '', location.pathname); } catch (_) {}
  if (S.requests.some(r => r.id === id)) { S.tab = 'requests'; render(true); openSheet('detail', id); }
  else toast('Không tìm thấy phiếu trong liên kết.', 'bad');
}

/* ---------- render ---------- */
let deferred = false;
function render(force) {
  const logged = !!S.me;
  $('#landing').hidden = logged; $('#appwrap').hidden = !logged;
  if (!logged) {
    const L = $('#landing');
    if (!force && typing(L)) { deferred = true; return; }
    L.innerHTML = vLanding(); return;
  }
  renderChrome();
  if (S.tab === 'admin' && !isAdmin()) S.tab = 'overview';
  const view = $('#view');
  if (!force && typing(view)) deferred = true;
  else { deferred = false; view.innerHTML = ({ overview: vOverview, requests: vRequests, stock: vStock, admin: vAdmin })[S.tab](); }
  if (S.open && !typing($('#sheet'))) refreshSheet();
}

/* ---------- landing ---------- */
function processHTML() {
  return `<ol class="process">
    <li><b>Bước 1</b>Cán bộ bộ môn lập giấy đề nghị<small>✉ Báo Trưởng bộ môn</small></li>
    <li><b>Bước 2 · Ký 1</b>Trưởng bộ môn đồng ý<small>✉ Báo Trưởng phòng QTTH. Trưởng bộ môn tự lập phiếu thì tự ký.</small></li>
    <li><b>Bước 3 · Ký 2</b>Trưởng phòng Quản trị Tổng hợp đồng ý<small>✉ Báo Phó hiệu trưởng phụ trách</small></li>
    <li><b>Bước 4 · Ký 3</b>Phó hiệu trưởng phụ trách đồng ý<small>✉ Báo người phát nước, Trưởng bộ môn, người đề nghị</small></li>
    <li><b>Bước 5</b>Người phụ trách phát nước cất, trừ kho<small>✉ Báo bộ môn đã phát. Kho dưới ngưỡng: ✉ cảnh báo nhập thêm.</small></li>
  </ol>`;
}
function vLanding() {
  if (S.pubErr && S.pubErr.code === 'config') {
    return `<div class="setup-warn"><div class="panel"><h2>Chưa cấu hình máy chủ</h2><p class="muted">${esc(S.pubErr.error)}</p></div></div>`;
  }
  const p = S.pub;
  const lv = p ? ({ ok: ['ok', 'Đủ dùng'], warn: ['warn', 'Dưới ngưỡng · đang đặt thêm'], bad: ['bad', 'Tạm hết'] }[p.level] || ['mute', '—']) : null;
  const pub = p ? `<section class="panel"><div class="panel-head"><h2>Nước cất hiện có tại kho</h2><span class="chip ${lv[0]}">${lv[1]}</span></div>
      <div class="pubgauge">${gaugeHTML(p.avail, p.capacity || 500, p.threshold || 0)}
        <div><div class="big">${fmt(p.avail)}<small>lít</small></div><div class="muted" style="font-size:12.5px;margin-top:6px">khả dụng · cập nhật ${dTime(p.updatedAt)}</div>
        <dl class="kv" style="margin-top:12px;max-width:260px"><dt>Đã phát 30 ngày</dt><dd>${fmt(p.used30)} L</dd><dt>Dung tích kho</dt><dd>${fmt(p.capacity)} L</dd></dl></div></div></section>`
    : (S.booting ? `<section class="panel"><p class="muted" style="margin:0">Đang tải số liệu kho…</p></section>` : '');
  return `<div class="land">
    <div class="org">Đại học Y Dược TP.HCM · Trường Dược</div>
    <div class="land-grid">
      <div class="stack">
        <div class="hero"><h1>Cấp phát nước cất</h1>
          <p>Lập giấy đề nghị cấp nước cất cho bộ môn hoặc cá nhân, theo dõi phiếu đang ở bước nào và lượng nước còn trong kho. Phiếu cần 3 chữ ký đồng ý: Trưởng bộ môn, Trưởng phòng Quản trị Tổng hợp, Phó hiệu trưởng phụ trách. Mỗi bước có email báo người cần xử lý.</p></div>
        ${pub}
        <section class="panel"><div class="panel-head"><h2>Quy trình cấp phát</h2></div>${processHTML()}</section>
      </div>
      <aside class="login">${authCard()}</aside>
    </div></div>`;
}
function authCard() {
  if (S.booting && S.token) return `<div class="panel"><h2>Đăng nhập</h2><p class="muted">Đang kiểm tra phiên đăng nhập…</p></div>`;
  const m = S.authMsg ? `<div class="${S.authMsg.kind === 'ok' ? 'fok' : 'ferr'}" role="alert">${esc(S.authMsg.text)}</div>` : '';
  const seg = `<div class="authseg"><button type="button" data-auth="login" aria-pressed="${S.authTab === 'login'}">Đăng nhập</button><button type="button" data-auth="register" aria-pressed="${S.authTab === 'register'}">Đăng ký</button></div>`;
  const deep = S.deep ? `<div class="fok" style="background:var(--info-bg);color:var(--info)">Đăng nhập để mở phiếu từ email.</div>` : '';
  if (S.authTab === 'login') return `<div class="panel">${seg}
    <form id="fLogin" class="fstack" autocomplete="on">${deep}
      <label class="f">Tên đăng nhập<input id="lgUser" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
      <label class="f">Mật khẩu<input id="lgPass" name="password" type="password" autocomplete="current-password" required></label>
      ${m}
      <button class="btn primary" type="submit" style="justify-content:center">Đăng nhập</button>
      <p class="muted" style="margin:0;font-size:12.5px">Quên mật khẩu? Liên hệ Quản trị hệ thống để được cấp mật khẩu tạm.</p>
    </form></div>`;
  const ds = (S.pub && S.pub.departments) || [];
  return `<div class="panel">${seg}
    <p class="muted" style="margin:0 0 12px;font-size:13px">Tạo tài khoản rồi chờ Quản trị hệ thống duyệt và phân vai trò. Email dùng để nhận thông báo phiếu.</p>
    <form id="fRegister" class="fstack" autocomplete="on">
      <label class="f">Họ và tên<input id="rgName" type="text" autocomplete="name" required placeholder="Như sẽ ghi trên giấy đề nghị"></label>
      <label class="f">Email<input id="rgEmail" type="email" autocomplete="email" required placeholder="ten@ump.edu.vn"></label>
      <div class="frow">
        <label class="f">Chức danh<input id="rgTitle" type="text" placeholder="Giảng viên, KTV…"></label>
        <label class="f">Bộ môn / đơn vị<select id="rgDept"><option value="">— Chọn —</option>${ds.map(d => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}</select></label>
      </div>
      <label class="f">Vai trò đề nghị<select id="rgRole">${roleOptions('user')}</select></label>
      <label class="f">Tên đăng nhập <span class="h">3–32 ký tự: chữ thường không dấu, số, . _ -</span><input id="rgUser" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required pattern="[a-z0-9._\\-]{3,32}"></label>
      <div class="frow">
        <label class="f">Mật khẩu<input id="rgPass" type="password" autocomplete="new-password" minlength="8" required></label>
        <label class="f">Nhập lại mật khẩu<input id="rgPass2" type="password" autocomplete="new-password" minlength="8" required></label>
      </div>
      <label class="f">Ghi chú cho quản trị<input id="rgNote" type="text"></label>
      ${m}
      <button class="btn primary" type="submit" style="justify-content:center">Gửi đăng ký</button>
    </form></div>`;
}

/* ---------- app chrome ---------- */
function renderChrome() {
  document.querySelectorAll('.tab').forEach(b => {
    b.setAttribute('aria-selected', b.dataset.tab === S.tab);
    if (b.dataset.tab === 'requests') { const n = todo().length; b.innerHTML = 'Giấy đề nghị' + (n ? `<span class="count">${n}</span>` : ''); }
    if (b.dataset.tab === 'admin') { b.hidden = !isAdmin(); const n = S.adminUsers.filter(u => u.status === 'pending').length; b.innerHTML = 'Quản trị hệ thống' + (n ? `<span class="count">${n}</span>` : ''); }
  });
  const u = S.me;
  const role = (isAdmin() ? 'Quản trị hệ thống · ' : '') + (ROLES[u.role] || '');
  $('#userbar').innerHTML = `${avatar(u.id, 34)}<div><div style="font-weight:600;font-size:13.5px">${esc(u.fullName)}</div><div class="rolebadge">${esc(role)}${u.deptId && dept(u.deptId) ? ' · ' + esc(dept(u.deptId).name) : ''}</div></div>`;
}

/* ---------- views ---------- */
function pipelineHTML() {
  const since = Date.now() - 30 * 864e5;
  const st = [
    { k: 'cho_tbm', t: 'Chờ Trưởng bộ môn', step: 2 },
    { k: 'cho_qtth', t: 'Chờ Trưởng phòng QTTH', step: 3 },
    { k: 'cho_bgh', t: 'Chờ Phó hiệu trưởng', step: 4 },
    { k: 'cho_cap', t: 'Chờ phát nước', step: 5 },
    { k: 'da_cap', t: 'Đã phát (30 ngày)', step: '✓' }
  ].map(s => {
    const list = S.requests.filter(r => r.status === s.k && (s.k !== 'da_cap' || Date.parse(r.updatedAt || r.createdAt) >= since));
    return { ...s, n: list.length, l: list.reduce((a, r) => a + (s.k === 'da_cap' ? (r.qtyIssued || 0) : qtyOf(r)), 0) };
  });
  return `<section class="panel"><div class="panel-head"><h2>Phiếu đang ở bước nào</h2><span class="muted" style="font-size:12.5px">Bấm vào một bước để xem danh sách</span></div>
    <div class="pipeline">${st.map(s => `<button type="button" class="pstage ${s.n && s.k !== 'da_cap' ? 'has' : ''}" data-pipe="${s.k}">
      <span class="pstep">${s.step === '✓' ? '✓' : 'Bước ' + s.step}</span><span class="pname">${s.t}</span>
      <span class="pnum">${s.n}<small> phiếu</small></span><span class="pl">${fmt(s.l)} L</span></button>`).join('')}</div></section>`;
}
function vOverview() {
  const c = calc();
  const lvl = { ok: ['ok', 'Đủ dùng'], warn: ['warn', 'Dưới ngưỡng · cần đặt thêm'], bad: ['bad', 'Hết nước khả dụng'] }[c.level];
  const mine = todo().slice(0, 6);
  const myDept = S.me.role === 'tbm' && S.me.deptId;
  const followList = S.requests.filter(r => r.requesterId === S.me.id || (myDept && r.deptId === S.me.deptId)).slice(0, 6);
  const setupHint = isAdmin() && !S.departments.length ? `<div class="banner info">Bắt đầu: vào <b>Quản trị hệ thống</b> để thêm bộ môn, người dùng (kèm email) và đặt địa chỉ trang cho email thông báo.</div>` : '';
  const noMail = !S.me.email ? `<div class="banner warn">Tài khoản của bạn chưa có email nên sẽ không nhận được thông báo. Bấm <b>Tài khoản</b> ở đầu trang để thêm.</div>` : '';
  return `${setupHint}${noMail}${pipelineHTML()}<div class="grid-ov" style="margin-top:16px">
    <section class="panel" aria-label="Tồn kho">
      <div class="panel-head"><h2>Nước cất khả dụng</h2><span class="chip ${lvl[0]}">${lvl[1]}</span></div>
      <div class="gauge">${gaugeHTML(c.avail, c.cap, c.thr)}
        <div class="gauge-read">
          <div><div class="big">${fmt(c.avail)}<small>lít</small></div><div class="muted" style="font-size:12.5px;margin-top:6px">trên dung tích kho ${fmt(c.cap)} L</div></div>
          <dl class="kv"><dt>Tồn thực tế</dt><dd>${fmt(c.bal)} L</dd><dt>Đã duyệt, chờ phát</dt><dd>−${fmt(c.reserved)} L</dd><dt>Ngưỡng đặt hàng</dt><dd>${fmt(c.thr)} L</dd></dl>
        </div></div>
      ${c.level !== 'ok' ? `<div class="order-hint">Đề xuất đặt thêm khoảng <b>${fmt(c.suggest)} L</b> để đầy kho${c.pending ? `; còn ${fmt(c.pending)} L đang chờ duyệt.` : '.'}</div>` : ''}
      ${!S.stock.length ? `<div class="order-hint" style="background:var(--info-bg);color:var(--info)">Chưa có số liệu kho. ${canStock() ? 'Vào <b>Sổ kho</b> → Kiểm kê để nhập số lít hiện có.' : 'Người phụ trách phát nước sẽ nhập số tồn đầu kỳ.'}</div>` : ''}
      <dl class="kv" style="margin-top:14px"><dt>Đã phát 30 ngày</dt><dd>${fmt(c.used30)} L</dd><dt>Trung bình/ngày</dt><dd>${fmt(c.daily)} L</dd><dt>Đủ dùng khoảng</dt><dd>${c.days == null ? '—' : fmt(Math.max(0, Math.floor(c.days))) + ' ngày'}</dd></dl>
    </section>
    <div class="stack">
      <section class="panel"><div class="panel-head"><h2>Cần bạn xử lý</h2>${todo().length > 6 ? `<button class="btn ghost sm" data-go="todo" type="button">Xem tất cả ${todo().length}</button>` : ''}</div>
        ${mine.length ? `<div class="queue">${mine.map(qrow).join('')}</div>` : `<div class="empty"><b>Không có phiếu nào đang chờ bạn</b>${S.me.role === 'user' ? 'Phiếu của bạn lần lượt qua Trưởng bộ môn, Trưởng phòng QTTH, Phó hiệu trưởng rồi tới người phát nước. Theo dõi tiến trình ở bên dưới.' : 'Phiếu đến lượt bạn đồng ý hoặc phát nước sẽ hiện ở đây, kèm email thông báo.'}</div>`}</section>
      <section class="panel"><div class="panel-head"><h2>${myDept ? 'Phiếu của bộ môn' : 'Phiếu bạn đã lập'}</h2>${followList.length ? `<button class="btn ghost sm" data-go="${myDept ? 'dept' : 'mine'}" type="button">Xem tất cả</button>` : ''}</div>
        ${followList.length ? `<div class="queue">${followList.map(qrow).join('')}</div>` : `<div class="empty"><b>Chưa có phiếu nào</b>Bấm "Lập giấy đề nghị" để xin cấp nước cất. Phiếu sẽ hiện ở đây kèm bước đang xử lý.</div>`}</section>
    </div></div>`;
}
function qrow(r) {
  return `<button class="qrow" type="button" data-open="${esc(r.id)}">
    <span class="t">${esc(deptLabel(r))}${r.kind === 'ca-nhan' ? ' · ' + esc(nm(r.requesterId)) : ''} <span class="code">${esc(r.code)}</span></span><span class="q">${fmt(qtyOf(r))} L</span>
    <span class="s">${miniFlow(r)}</span><span>${chip(r.status)}</span></button>`;
}
function vRequests() {
  const F = [['todo', 'Cần tôi xử lý'], ['mine', 'Của tôi']];
  if (S.me.deptId) F.push(['dept', 'Bộ môn của tôi']);
  F.push(['cho_tbm', 'Chờ Trưởng BM'], ['cho_qtth', 'Chờ TP QTTH'], ['cho_bgh', 'Chờ Phó HT'], ['cho_cap', 'Chờ phát nước'], ['da_cap', 'Đã phát'], ['all', 'Tất cả']);
  let list = S.requests;
  if (S.filter === 'todo') list = todo();
  else if (S.filter === 'mine') list = list.filter(r => r.requesterId === S.me.id);
  else if (S.filter === 'dept') list = list.filter(r => r.deptId && r.deptId === S.me.deptId);
  else if (S.filter !== 'all') list = list.filter(r => r.status === S.filter);
  const q = S.q.trim().toLowerCase();
  if (q) list = list.filter(r => (deptLabel(r) + ' ' + r.code + ' ' + (r.purpose || '') + ' ' + nm(r.requesterId)).toLowerCase().includes(q));
  const rows = list.map(r => `<tr class="click" data-open="${esc(r.id)}" tabindex="0">
      <td><span class="code">${esc(r.code)}</span><div class="muted num" style="font-size:12px">${dShort(r.createdAt)}</div></td>
      <td><div style="font-weight:600">${esc(deptLabel(r))}</div><div class="muted" style="font-size:12.5px">${r.kind === 'ca-nhan' ? 'Cá nhân · ' : ''}${esc(nm(r.requesterId))}</div></td>
      <td class="r num">${fmt(qtyOf(r))}${r.qtyApproved != null && r.qtyApproved !== r.qty ? `<div class="muted" style="font-size:11.5px">xin ${fmt(r.qty)}</div>` : ''}</td>
      <td>${miniFlow(r)}</td><td>${chip(r.status)}</td></tr>`).join('');
  return `<div class="toolbar">${F.map(([k, t]) => `<button class="fchip" type="button" data-filter="${k}" aria-pressed="${S.filter === k}">${t}</button>`).join('')}
    <input class="search" id="q" type="search" placeholder="Tìm bộ môn, mã phiếu…" value="${esc(S.q)}" aria-label="Tìm kiếm"></div>
    ${list.length ? `<div class="tablewrap"><table style="min-width:760px"><thead><tr><th>Mã phiếu</th><th>Bộ môn / Người đề nghị</th><th class="r">Số lượng (L)</th><th>Tiến trình</th><th>Trạng thái</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<div class="panel empty"><b>Không có phiếu phù hợp</b>${S.filter === 'todo' ? 'Khi có phiếu đến lượt bạn xử lý, phiếu sẽ hiện ở đây.' : 'Thử bộ lọc khác hoặc lập giấy đề nghị mới.'}</div>`}`;
}
function vStock() {
  const c = calc(); let run = 0;
  const rows = S.stock.map(m => { const d = m.type === 'xuat' ? -m.qty : m.qty; run += d; return { m, d, run }; }).reverse();
  const T = { nhap: 'Nhập kho', xuat: 'Phát nước', kiemke: 'Kiểm kê điều chỉnh' };
  const st = canStock();
  return `<div class="stats" style="margin-bottom:16px">
      <div class="stat"><div class="lbl">Tồn thực tế</div><div class="val">${fmt(c.bal)}<small>L</small></div></div>
      <div class="stat"><div class="lbl">Chờ phát</div><div class="val">${fmt(c.reserved)}<small>L</small></div></div>
      <div class="stat"><div class="lbl">Khả dụng</div><div class="val">${fmt(c.avail)}<small>L</small></div></div>
      <div class="stat"><div class="lbl">Ngưỡng đặt</div><div class="val">${fmt(c.thr)}<small>L</small></div></div></div>
    <div class="panel-head"><h2 style="font-size:15px">Sổ nhập – xuất</h2>
      ${st ? `<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" type="button" data-act="stockin">＋ Nhập kho</button><button class="btn" type="button" data-act="count">Kiểm kê</button></div>` : '<span class="muted" style="font-size:12.5px">Người phụ trách phát nước và Trưởng phòng QTTH cập nhật sổ kho</span>'}</div>
    ${rows.length ? `<div class="tablewrap"><table><thead><tr><th>Thời gian</th><th>Nghiệp vụ</th><th class="r">Thay đổi (L)</th><th class="r">Tồn sau (L)</th><th>Người thực hiện</th><th>Diễn giải</th></tr></thead><tbody>
      ${rows.map(({ m, d, run }) => `<tr ${m.ref ? `class="click" data-open="${esc(m.ref)}"` : ''}><td class="num">${dTime(m.at)}</td><td>${T[m.type] || esc(m.type)}</td>
      <td class="r num ${d >= 0 ? 'plus' : 'minus'}">${d >= 0 ? '+' : '−'}${fmt(Math.abs(d))}</td><td class="r num">${fmt(run)}</td><td>${esc(nm(m.by))}</td>
      <td>${m.code ? `<span class="code">${esc(m.code)}</span> ` : ''}${esc(m.note || '')}${m.source ? ` · ${esc(m.source)}` : ''}${m.lot ? ` · Lô ${esc(m.lot)}` : ''}${m.type === 'kiemke' ? ` · Đo thực tế ${fmt(m.actual)} L` : ''}</td></tr>`).join('')}
      </tbody></table></div>`
      : `<div class="panel empty"><b>Sổ kho chưa có bản ghi</b>${st ? 'Bấm "Kiểm kê" để ghi số lít hiện có làm tồn đầu kỳ.' : 'Người phụ trách phát nước sẽ ghi tồn đầu kỳ và các lần nhập.'}</div>`}`;
}

/* ---------- admin ---------- */
function vAdmin() {
  const pend = S.adminUsers.filter(u => u.status === 'pending');
  const T = [['pending', `Yêu cầu đăng ký${pend.length ? ` (${pend.length})` : ''}`], ['users', 'Người dùng'], ['depts', 'Bộ môn'], ['settings', 'Thiết lập & email'], ['log', 'Nhật ký']];
  const sub = { pending: aPending, users: aUsers, depts: aDepts, settings: aSettings, log: aLog }[S.adminTab]();
  return `<div class="subtabs">${T.map(([k, t]) => `<button class="fchip" type="button" data-atab="${k}" aria-pressed="${S.adminTab === k}">${t}</button>`).join('')}</div>${sub}`;
}
function aPending() {
  const pend = S.adminUsers.filter(u => u.status === 'pending');
  if (!pend.length) return `<div class="panel empty"><b>Không có yêu cầu nào đang chờ</b>Người dùng tự đăng ký ở trang đăng nhập. Yêu cầu sẽ hiện ở đây để bạn duyệt và phân vai trò.</div>`;
  return `<section class="panel">${pend.map(u => `<div class="req-card">
    <div class="ucell">${avatar(u.id, 30)}<div style="min-width:0"><div class="n">${esc(u.fullName)} <span class="uname">@${esc(u.username)}</span></div>
      <div class="s">${esc(u.email || 'chưa có email')} · ${esc(u.title || '')}${u.title ? ' · ' : ''}${esc(dept(u.deptId)?.name || 'Chưa chọn bộ môn')} · gửi ${dTime(u.createdAt)} · đề nghị: ${esc(ROLES[u.role] || '')}</div>
      ${u.note ? `<div class="s">Ghi chú: ${esc(u.note)}</div>` : ''}</div></div>
    <div class="req-ctrl" data-su="${esc(u.id)}">
      <select data-f="role" aria-label="Vai trò">${roleOptions(u.role)}</select>
      <select data-f="dept" aria-label="Bộ môn">${deptOptions(u.deptId, true)}</select>
      <label class="checkline"><input type="checkbox" data-f="admin"> Quản trị</label>
      <input data-f="reason" type="text" placeholder="Lý do (khi từ chối)" aria-label="Lý do từ chối">
      <button class="btn danger sm" type="button" data-surej="${esc(u.id)}">Từ chối</button>
      <button class="btn primary sm" type="button" data-suok="${esc(u.id)}">Duyệt</button></div></div>`).join('')}</section>`;
}
function aUsers() {
  const list = S.adminUsers.filter(u => u.status === 'active' || u.status === 'locked').sort((a, b) => a.fullName.localeCompare(b.fullName, 'vi'));
  const rej = S.adminUsers.filter(u => u.status === 'rejected').length;
  const need = r => list.filter(u => u.status === 'active' && u.role === r).length;
  const gaps = ['qtth', 'bgh', 'kho'].filter(r => !need(r)).map(r => ROLES[r]);
  const noHead = S.departments.filter(d => !list.some(u => u.status === 'active' && u.role === 'tbm' && u.deptId === d.id)).map(d => d.name);
  if (noHead.length) gaps.push('Trưởng bộ môn của ' + noHead.join(', '));
  const rows = list.map(u => `<tr data-uid="${esc(u.id)}">
    <td><div class="ucell">${avatar(u.id, 30)}<div style="min-width:0"><div class="n">${esc(u.fullName)}${u.id === S.me.id ? ' <span class="muted" style="font-weight:400">(bạn)</span>' : ''}</div><div class="s"><span class="uname">@${esc(u.username)}</span>${u.title ? ' · ' + esc(u.title) : ''}</div></div></div></td>
    <td><input type="email" data-uf="email" value="${esc(u.email || '')}" placeholder="chưa có email" aria-label="Email" class="${u.email ? '' : 'missing'}"></td>
    <td><select data-uf="role" aria-label="Vai trò">${roleOptions(u.role)}</select></td>
    <td><select data-uf="deptId" aria-label="Bộ môn">${deptOptions(u.deptId, true)}</select></td>
    <td><label class="checkline"><input type="checkbox" data-uf="isAdmin" ${u.isAdmin ? 'checked' : ''} ${u.id === S.me.id ? 'disabled' : ''}> Quản trị</label></td>
    <td>${uchip(u.status)}<div class="muted" style="font-size:11.5px;margin-top:3px">${u.lastLogin ? 'Đăng nhập ' + dTime(u.lastLogin) : 'Chưa đăng nhập'}</div></td>
    <td class="r" style="white-space:nowrap"><button class="btn sm" type="button" data-resetpw="${esc(u.id)}">Đặt lại mật khẩu</button>
      ${u.id === S.me.id ? '' : `<button class="btn sm ${u.status === 'active' ? 'danger' : ''}" type="button" data-lock="${esc(u.id)}">${u.status === 'active' ? 'Khóa' : 'Mở khóa'}</button>`}</td></tr>`).join('');
  return `${gaps.length ? `<div class="banner warn">Chưa có người giữ vai trò: <b>${gaps.join(', ')}</b>. Phiếu đến bước đó sẽ không có ai nhận email; Quản trị hệ thống phải duyệt thay.</div>` : ''}
    <div class="panel-head"><h2 style="font-size:15px">${list.length} người dùng${rej ? ` <span class="muted" style="font-weight:400">· ${rej} đăng ký đã từ chối</span>` : ''}</h2><button class="btn" type="button" data-act="addUser">＋ Thêm người dùng</button></div>
    <div class="tablewrap utable"><table style="min-width:1060px"><thead><tr><th>Người dùng</th><th>Email nhận thông báo</th><th>Vai trò</th><th>Bộ môn</th><th>Quyền</th><th>Trạng thái</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="muted" style="font-size:12.5px;margin-top:12px">Email được gửi tới mọi người dùng đang hoạt động có vai trò tương ứng. Trưởng bộ môn nhận email cho phiếu của bộ môn mình. Sửa email xong, bấm ra ngoài ô để lưu.</p>`;
}
function aDepts() {
  const act = Object.values(S.users).filter(u => u.status === 'active');
  const count = id => act.filter(u => u.deptId === id).length;
  const heads = id => act.filter(u => u.deptId === id && u.role === 'tbm').map(u => u.fullName);
  return `<section class="panel"><div class="panel-head"><h2>Bộ môn</h2></div>
    <form id="addDept" style="display:flex;gap:8px;margin-bottom:8px"><input id="deptName" type="text" placeholder="Tên bộ môn, ví dụ: Hóa phân tích" aria-label="Tên bộ môn" required><button class="btn" type="submit">Thêm</button></form>
    ${S.departments.length ? `<div class="tablewrap" style="margin-top:12px"><table style="min-width:560px"><thead><tr><th>Bộ môn</th><th>Trưởng bộ môn</th><th class="r">Người dùng</th><th></th></tr></thead><tbody>
      ${S.departments.map(d => `<tr><td style="font-weight:600">${esc(d.name)}</td><td>${heads(d.id).map(esc).join(', ') || '<span class="muted">Chưa phân công</span>'}</td><td class="r num">${count(d.id)}</td>
      <td class="r" style="white-space:nowrap"><button class="btn ghost sm" type="button" data-renamedept="${esc(d.id)}">Đổi tên</button><button class="btn ghost sm" type="button" data-deldept="${esc(d.id)}">Xóa</button></td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty"><b>Chưa có bộ môn</b>Thêm các bộ môn của Trường Dược. Trưởng bộ môn được chọn ở mục Người dùng (vai trò Trưởng bộ môn + bộ môn).</div>'}</section>`;
}
function aSettings() {
  const c = S.cfg, m = S.mail;
  if (!m) loadMailStatus();
  const suggested = c.appUrl || location.origin;
  return `<div class="setgrid">
    <section class="panel"><div class="panel-head"><h2>Thông báo email</h2>${m && m.quota != null ? `<span class="chip ${m.quota > 20 ? 'ok' : 'warn'}">Còn ${m.quota} lượt hôm nay</span>` : ''}</div>
      <div class="fstack">
        <label class="checkline"><input type="checkbox" id="mEnabled" ${c.mailEnabled ? 'checked' : ''}> Gửi email tự động ở mỗi bước</label>
        <label class="f">Địa chỉ trang (để gắn nút "Mở phiếu" trong email)<input id="mUrl" type="url" value="${esc(suggested)}" placeholder="https://cpnc.truongduoc.workers.dev"><span class="h">${c.appUrl ? 'Đã lưu.' : 'Chưa lưu. Đề xuất lấy theo địa chỉ bạn đang mở; bấm Lưu để dùng.'}</span></label>
        <div class="actions"><button class="btn" type="button" data-act="testMail">Gửi email thử tới tôi</button><button class="btn primary" type="button" data-act="saveMail">Lưu</button></div>
        <div class="muted" style="font-size:12.5px">Khi lượng khả dụng xuống dưới ngưỡng, hệ thống gửi một email cảnh báo tới Người phụ trách phát nước và Trưởng phòng QTTH; cảnh báo tự đặt lại sau khi nhập kho trên ngưỡng.</div>
        <div class="muted" style="font-size:12.5px">Email gửi từ tài khoản Google đã triển khai Apps Script. Tài khoản Gmail thường gửi tối đa khoảng 100 người nhận/ngày; Google Workspace khoảng 1.500.</div>
        ${m && m.missing && m.missing.length ? `<div class="banner warn" style="margin:0">Người dùng sau chưa có email nên không nhận được thông báo: ${m.missing.map(u => `<b>${esc(u.fullName)}</b> (${esc(ROLES[u.role] || u.role)})`).join(', ')}.</div>` : ''}
        <div><div class="muted" style="font-size:12px;font-weight:600;margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em">Ai nhận email khi nào</div>${processHTML()}</div>
      </div></section>
    <section class="panel"><div class="panel-head"><h2>Kho nước cất</h2></div>
      <div class="frow">
        <label class="f">Ngưỡng cần đặt thêm<div class="unit"><input id="sThr" type="number" min="0" step="1" value="${esc(c.threshold)}"></div><span class="h">Cảnh báo khi lượng khả dụng ≤ mức này</span></label>
        <label class="f">Dung tích kho<div class="unit"><input id="sCap" type="number" min="1" step="1" value="${esc(c.capacity)}"></div><span class="h">Dùng để vẽ mức nước và đề xuất số lượng đặt</span></label>
      </div><div class="actions" style="margin-top:12px"><button class="btn primary" type="button" data-act="saveStock">Lưu</button></div></section>
  </div>`;
}
async function loadMailStatus() { S.mail = {}; try { S.mail = await api('mailStatus'); } catch (e) { S.mail = { error: errText(e) }; } if (S.tab === 'admin' && S.adminTab === 'settings') render(); }
const LOGNAME = { register: 'Đăng ký', approveUser: 'Duyệt tài khoản', rejectUser: 'Từ chối tài khoản', updateUser: 'Sửa người dùng', resetPassword: 'Đặt lại mật khẩu',
  addUser: 'Thêm người dùng', changePassword: 'Đổi mật khẩu', updateProfile: 'Sửa thông tin cá nhân', createRequest: 'Lập phiếu', approve: 'Duyệt phiếu', reject: 'Từ chối phiếu', issue: 'Phát nước',
  cancel: 'Hủy phiếu', stockIn: 'Nhập kho', stockCount: 'Kiểm kê', saveConfig: 'Thiết lập', addDept: 'Thêm bộ môn', renameDept: 'Đổi tên bộ môn',
  deleteDept: 'Xóa bộ môn', setup: 'Cài đặt', resetAdminPassword: 'Đặt lại mật khẩu admin', mail: '✉ Gửi email', mailError: '✉ Lỗi gửi email' };
function aLog() {
  if (!S.log) { loadLog(); return '<div class="panel empty"><b>Đang tải nhật ký…</b></div>'; }
  if (!S.log.length) return '<div class="panel empty"><b>Chưa có hoạt động</b></div>';
  const who = id => S.users[id]?.fullName || S.adminUsers.find(u => u.id === id)?.fullName || (id ? id : 'Hệ thống');
  return `<div class="panel-head"><h2 style="font-size:15px">200 hoạt động gần nhất</h2><button class="btn sm" type="button" data-act="reloadLog">Tải lại</button></div>
    <div class="tablewrap logt"><table><thead><tr><th>Thời gian</th><th>Người thực hiện</th><th>Hoạt động</th><th>Chi tiết</th></tr></thead><tbody>
    ${S.log.map(l => `<tr class="${l.action === 'mailError' ? 'logbad' : ''}"><td class="num" style="white-space:nowrap">${dTime(l.at)}</td><td>${esc(who(l.userId))}</td><td>${esc(LOGNAME[l.action] || l.action)}</td><td style="overflow-wrap:anywhere">${esc(l.detail)}</td></tr>`).join('')}
    </tbody></table></div>`;
}
async function loadLog() { try { S.log = await api('getLog', { limit: 200 }); } catch (e) { S.log = []; toast(errText(e), 'bad'); } if (S.tab === 'admin' && S.adminTab === 'log') render(true); }

/* ---------- sheets ---------- */
function openSheet(mode, id, data) { S.openMode = mode; S.open = id || mode; S.sheetData = data; S.confirm = null; $('#overlay').hidden = false; refreshSheet(true); }
function closeSheet() { S.open = null; S.openMode = null; S.sheetData = null; $('#overlay').hidden = true; $('#sheet').innerHTML = ''; }
function refreshSheet(first) {
  const sh = $('#sheet'); sh.className = 'sheet'; const m = S.openMode;
  const statics = { new: sNew, stockin: sStockIn, count: sCount, account: sAccount, addUser: sAddUser, tempPw: sTempPw, renameDept: sRenameDept };
  if (statics[m]) { if (first) sh.innerHTML = statics[m](); }
  else if (m === 'detail') { const r = S.requests.find(x => x.id === S.open); sh.className = 'sheet wide'; sh.innerHTML = r ? sDetail(r) : head('Không tìm thấy phiếu') + '<p class="muted">Phiếu có thể đã bị xóa khỏi bảng tính.</p>'; }
  else if (m === 'paper') { const r = S.requests.find(x => x.id === S.open); sh.className = 'sheet wide'; sh.innerHTML = r ? sPaper(r) : ''; }
  if (first) { const f = sh.querySelector('input:not([type=radio]):not([type=checkbox]):not([hidden]),select,textarea'); if (f && m !== 'detail' && m !== 'tempPw' && m !== 'paper') setTimeout(() => f.focus(), 30); }
}
const head = (t, sub) => `<div class="sheet-head"><div><h2>${t}</h2>${sub ? `<div class="muted" style="font-size:13px;margin-top:3px">${sub}</div>` : ''}</div><button class="x" type="button" data-close aria-label="Đóng">×</button></div>`;

function sNew() {
  const ds = S.departments; const myDept = S.me.deptId;
  const isHead = S.me.role === 'tbm';
  return head('Giấy đề nghị cấp nước cất', 'Kính gửi Ban giám hiệu Trường Dược và Phòng Quản trị Tổng hợp') +
  `<form id="fNew" class="fstack">
    <div class="seg" role="radiogroup" aria-label="Hình thức">
      <label><input type="radio" name="kind" value="bo-mon" checked>Bộ môn đề nghị</label><label><input type="radio" name="kind" value="ca-nhan">Cá nhân đề nghị</label></div>
    <div class="frow">
      <label class="f">Bộ môn
        ${ds.length ? `<select id="nDept" required>${ds.map(d => `<option value="${esc(d.id)}" ${myDept === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}<option value="_other">Khác…</option></select>` : ''}
        <input id="nDeptOther" type="text" placeholder="Tên bộ môn" ${ds.length ? 'hidden' : 'required'}></label>
      <label class="f">Số lượng<div class="unit"><input id="nQty" type="number" min="1" step="1" required inputmode="numeric" placeholder="120"></div></label></div>
    <div class="frow">
      <label class="f">Ngày cần nhận<input id="nNeed" type="date" value="${todayStr()}"></label>
      <label class="f">Người nhận nước<input id="nRecv" type="text" placeholder="Họ tên người đến nhận"></label></div>
    <label class="f">Mục đích sử dụng<input id="nPurpose" type="text" placeholder="Ví dụ: Pha dung dịch thực hành Hóa phân tích, lớp D22" required></label>
    <label class="f">Ghi chú <span class="h">Sẽ in vào cột Ghi chú của phiếu</span><textarea id="nNote" rows="2"></textarea></label>
    <div class="nextstep">${isHead ? 'Bạn là Trưởng bộ môn: nếu lập cho bộ môn của mình, chữ ký Trưởng bộ môn được ký luôn và phiếu chuyển thẳng tới <b>Trưởng phòng Quản trị Tổng hợp</b>.' : 'Sau khi gửi, hệ thống email <b>Trưởng bộ môn</b> để đồng ý, rồi lần lượt tới Trưởng phòng QTTH và Phó hiệu trưởng phụ trách.'} Bạn nhận email khi phiếu được phê duyệt xong và khi đã phát nước.</div>
    <div class="actions"><button class="btn" type="button" data-close>Hủy</button><button class="btn primary" type="submit">Gửi đề nghị</button></div></form>`;
}
function sStockIn() {
  return head('Nhập kho nước cất', 'Ghi nhận lượng nước cất mới nhận về kho') +
  `<form id="fIn" class="fstack"><div class="frow">
    <label class="f">Số lượng nhập<div class="unit"><input id="iQty" type="number" min="0.5" step="0.5" required></div></label>
    <label class="f">Ngày nhập<input id="iDate" type="date" value="${todayStr()}" required></label></div>
    <div class="frow"><label class="f">Nguồn / đơn vị cung cấp<input id="iSrc" type="text" placeholder="Máy cất nước, nhà cung cấp…"></label>
    <label class="f">Số lô / số chứng từ<input id="iLot" type="text"></label></div>
    <label class="f">Ghi chú<input id="iNote" type="text"></label>
    <div class="actions"><button class="btn" type="button" data-close>Hủy</button><button class="btn primary" type="submit">Nhập kho</button></div></form>`;
}
function sCount() {
  const c = calc();
  return head('Kiểm kê kho', 'Ghi số lít đo được thực tế; chênh lệch được ghi thành một dòng điều chỉnh') +
  `<form id="fCount" class="fstack"><dl class="kv" style="max-width:280px"><dt>Tồn trên sổ</dt><dd>${fmt(c.bal)} L</dd></dl>
    <label class="f">Số lít đo thực tế<div class="unit"><input id="cAct" type="number" min="0" step="0.5" required></div></label>
    <label class="f">Ghi chú<input id="cNote" type="text" placeholder="Ví dụ: Kiểm kê cuối tháng 10"></label>
    <div class="actions"><button class="btn" type="button" data-close>Hủy</button><button class="btn primary" type="submit">Ghi kiểm kê</button></div></form>`;
}
function sAccount() {
  const u = S.me;
  return head('Tài khoản', '@' + esc(u.username) + ' · ' + esc(ROLES[u.role] || '')) +
  `<form id="fProfile" class="fstack">
    <div class="frow"><label class="f">Họ và tên<input id="pfName" type="text" value="${esc(u.fullName)}" required></label><label class="f">Chức danh<input id="pfTitle" type="text" value="${esc(u.title || '')}"></label></div>
    <label class="f">Email nhận thông báo<input id="pfEmail" type="email" value="${esc(u.email || '')}" required></label>
    <div class="actions"><button class="btn primary" type="submit">Lưu thông tin</button></div></form>
  <hr class="sep">
  <form id="fPw" class="fstack"><h3 style="font-size:14px;margin:0">Đổi mật khẩu</h3>
    <input type="text" autocomplete="username" value="${esc(u.username)}" hidden>
    <label class="f">Mật khẩu hiện tại<input id="pwOld" type="password" autocomplete="current-password" required></label>
    <div class="frow"><label class="f">Mật khẩu mới <span class="h">Tối thiểu 8 ký tự</span><input id="pwNew" type="password" autocomplete="new-password" minlength="8" required></label>
    <label class="f">Nhập lại mật khẩu mới<input id="pwNew2" type="password" autocomplete="new-password" minlength="8" required></label></div>
    <div class="actions"><button class="btn" type="button" data-close>Đóng</button><button class="btn primary" type="submit">Đổi mật khẩu</button></div></form>`;
}
function sAddUser() {
  return head('Thêm người dùng', 'Tài khoản được kích hoạt ngay; hệ thống tạo mật khẩu tạm để bạn gửi cho người dùng') +
  `<form id="fAddUser" class="fstack">
    <div class="frow"><label class="f">Họ và tên<input id="auName" type="text" required></label><label class="f">Chức danh<input id="auTitle" type="text"></label></div>
    <div class="frow"><label class="f">Email<input id="auEmail" type="email" required></label><label class="f">Tên đăng nhập<input id="auUser" type="text" autocapitalize="none" spellcheck="false" required pattern="[a-z0-9._\\-]{3,32}"></label></div>
    <div class="frow"><label class="f">Vai trò<select id="auRole">${roleOptions('user')}</select></label><label class="f">Bộ môn<select id="auDept">${deptOptions('', true)}</select></label></div>
    <label class="checkline"><input type="checkbox" id="auAdmin"> Quản trị hệ thống</label>
    <div class="actions"><button class="btn" type="button" data-close>Hủy</button><button class="btn primary" type="submit">Tạo tài khoản</button></div></form>`;
}
function sTempPw() {
  const d = S.sheetData || {};
  return head('Mật khẩu tạm', 'Gửi cho người dùng qua kênh riêng. Mật khẩu chỉ hiện một lần.') +
  `<div class="fstack"><dl class="kv" style="max-width:320px"><dt>Tên đăng nhập</dt><dd>${esc(d.username)}</dd></dl>
    <div class="pwbox" id="tmpPw">${esc(d.password)}</div>
    <p class="muted" style="margin:0;font-size:12.5px">Người dùng nên đổi mật khẩu ngay sau lần đăng nhập đầu tiên (nút "Tài khoản" ở đầu trang).</p>
    <div class="actions"><button class="btn" type="button" data-act="copyPw">Sao chép</button><button class="btn primary" type="button" data-close>Xong</button></div></div>`;
}
function sRenameDept() {
  const d = dept(S.open) || {};
  return head('Đổi tên bộ môn') + `<form id="fRename" class="fstack"><label class="f">Tên bộ môn<input id="rnName" type="text" value="${esc(d.name)}" required></label>
    <div class="actions"><button class="btn" type="button" data-close>Hủy</button><button class="btn primary" type="submit">Lưu</button></div></form>`;
}
function sDetail(r) {
  const c = calc(); const step = STEP_OF[r.status];
  const p = progress(r);
  const items = p.map((s, i) => {
    const cls = { done: 'd', rejected: 'x', current: 'c' }[s.state] || '';
    const mark = s.state === 'done' ? '✓' : s.state === 'rejected' ? '×' : i + 1;
    let sub;
    if (s.state === 'done' || s.state === 'rejected') sub = `${s.k === 'lap' ? 'Lập bởi' : s.state === 'done' ? (s.k === 'cap' ? 'Đã phát' : (r.steps.tbm && r.steps.tbm.auto && s.k === 'tbm' ? 'Tự ký' : 'Đồng ý')) : 'Từ chối'} · ${esc(nm(s.by))} · ${dTime(s.at)}${s.qty != null ? ` · ${fmt(s.qty)} L` : ''}`;
    else if (s.state === 'current') { const h = holders(s.k, r); sub = 'Đang chờ: ' + (h.length ? h.map(nm).map(esc).join(', ') : 'chưa có ' + ROLES[s.role] + (s.k === 'tbm' ? ' của bộ môn' : '') + ' (Quản trị hệ thống duyệt thay)'); }
    else if (s.state === 'skipped') sub = r.status === 'da_huy' ? 'Phiếu đã hủy' : 'Không thực hiện';
    else sub = 'Chưa đến lượt · ' + esc(ROLES[s.role] || '');
    return `<li><span class="dot ${cls}">${mark}</span><div><div class="tt">${s.t}</div><div class="ts">${sub}</div>${s.note ? `<div class="tn">${esc(s.note)}</div>` : ''}${mailLine(s.mail)}</div></li>`;
  }).join('');
  let act = '';
  if (step && canAct(step, r)) {
    const asAdmin = isAdmin() && !ownRole(step, r) ? ' <span class="muted" style="font-weight:400;font-size:12.5px">(duyệt thay với quyền quản trị)</span>' : '';
    if (step === 'cap') {
      act = `<div class="decide"><h3>Phát nước cất${asAdmin}</h3><div class="fstack">
        <div class="frow"><label class="f">Số lượng phát thực tế<div class="unit"><input id="dQty" type="number" min="0.5" step="0.5" value="${qtyOf(r)}"></div><span class="h">Tồn thực tế hiện có: ${fmt(c.bal)} L</span></label>
        <label class="f">Ghi chú<input id="dNote" type="text" placeholder="Người nhận, can số…"></label></div>
        <div class="nextstep">Xác nhận xong, hệ thống trừ kho và gửi email báo Trưởng bộ môn và người đề nghị.</div>
        <div class="actions"><button class="btn primary" type="button" data-issue="${esc(r.id)}">Xác nhận đã phát</button></div></div></div>`;
    } else {
      const nextTxt = { tbm: 'Đồng ý: phiếu chuyển tới <b>Trưởng phòng Quản trị Tổng hợp</b> và gửi email.', qtth: 'Đồng ý: phiếu chuyển tới <b>Phó hiệu trưởng phụ trách</b> và gửi email.', bgh: 'Đồng ý: gửi email tới <b>Người phụ trách phát nước</b>, <b>Trưởng bộ môn</b> và <b>người đề nghị</b>.' }[step];
      act = `<div class="decide"><h3>${{ tbm: 'Ý kiến Trưởng bộ môn', qtth: 'Ý kiến Trưởng phòng Quản trị Tổng hợp', bgh: 'Phê duyệt của Phó hiệu trưởng phụ trách' }[step]}${asAdmin}</h3><div class="fstack">
        ${step === 'qtth' ? `<label class="f">Số lượng duyệt<div class="unit"><input id="dQty" type="number" min="0.5" step="0.5" value="${r.qty}"></div><span class="h">Khả dụng hiện tại: ${fmt(c.avail)} L</span></label>` : ''}
        <label class="f">Ý kiến <span class="h">Bắt buộc khi từ chối</span><textarea id="dNote" rows="2"></textarea></label>
        <div class="nextstep">${nextTxt} Từ chối: email báo người đề nghị và Trưởng bộ môn.</div>
        <div class="actions"><button class="btn danger" type="button" data-decide="no" data-id="${esc(r.id)}">Từ chối</button><button class="btn primary" type="button" data-decide="ok" data-id="${esc(r.id)}">Đồng ý</button></div></div></div>`;
    }
  }
  const canCancel = (r.requesterId === S.me.id || isAdmin()) && OPEN.includes(r.status);
  return head(esc(deptLabel(r)) + ' · ' + fmt(qtyOf(r)) + ' L', `<span class="code">${esc(r.code)}</span> · Lập ${dTime(r.createdAt)} bởi ${esc(nm(r.requesterId))}`) +
  `<div class="dstatus">${chip(r.status)}</div>` + flowBar(r) +
  `<div class="detail-grid"><div>
    <dl class="info">
      <div><dt>Hình thức</dt><dd>${r.kind === 'ca-nhan' ? 'Cá nhân đề nghị' : 'Bộ môn đề nghị'}</dd></div>
      <div><dt>Số lượng</dt><dd class="num">${fmt(r.qty)} L${r.qtyApproved != null && r.qtyApproved !== r.qty ? ` → duyệt ${fmt(r.qtyApproved)} L` : ''}${r.qtyIssued != null ? ` · đã phát ${fmt(r.qtyIssued)} L` : ''}</dd></div>
      <div><dt>Mục đích sử dụng</dt><dd>${esc(r.purpose || '—')}</dd></div>
      <div><dt>Ngày cần nhận</dt><dd>${r.needBy ? dShort(r.needBy + 'T00:00:00') : '—'}</dd></div>
      <div><dt>Người nhận</dt><dd>${esc(r.receiver || '—')}</dd></div>
      <div><dt>Ghi chú</dt><dd>${esc(r.note || '—')}</dd></div></dl>
    ${act}
  </div><div><h3 class="tl-h">Diễn biến &amp; email thông báo</h3><ol class="timeline">${items}</ol></div></div>
  <div class="actions" style="margin-top:14px">${canCancel ? `<button class="btn danger" type="button" data-cancel="${esc(r.id)}">${S.confirm === 'cancel:' + r.id ? 'Bấm lần nữa để hủy phiếu' : 'Hủy phiếu'}</button>` : ''}<button class="btn" type="button" data-paper="${esc(r.id)}">Xem giấy đề nghị</button></div>`;
}
function paperHTML(r) {
  const d = new Date(r.createdAt || Date.now());
  const stamp = (s, label) => {
    if (!s) return '<div class="blank"></div><div class="signame">&nbsp;</div>';
    const t = S.users[s.by] && S.users[s.by].title;
    return `<div class="stamp ${s.ok ? '' : 'no'}">${label || (s.ok ? 'Đồng ý' : 'Không đồng ý')}</div><div class="signame">${esc(nm(s.by))}</div>${t ? `<div class="sigtime">${esc(t)}</div>` : ''}<div class="sigtime">${dTime(s.at)} · ký điện tử</div>`;
  };
  const qty = r.qtyApproved != null && r.qtyApproved !== r.qty ? `${fmt(r.qty)} (duyệt ${fmt(r.qtyApproved)})` : fmt(r.qty);
  const notes = [r.purpose, r.note].filter(Boolean).join('. ');
  return `<div class="paper">
    <div class="hd"><div>ĐẠI HỌC Y DƯỢC<br>THÀNH PHỐ HỒ CHÍ MINH<br><span class="u">TRƯỜNG DƯỢC</span></div>
      <div><b>CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</b><span class="u" style="font-weight:400">Độc lập – Tự do – Hạnh phúc</span></div></div>
    <div class="ttl">GIẤY ĐỀ NGHỊ CẤP NƯỚC CẤT</div>
    <div class="to">Kính gửi:<ul><li>Ban giám hiệu Trường Dược</li><li>Phòng Quản trị Tổng hợp</li></ul></div>
    <div class="meta">Bộ môn: <span class="hand">${esc(deptLabel(r))}</span>${r.kind === 'ca-nhan' ? ` &nbsp;·&nbsp; Cá nhân đề nghị: <span class="hand">${esc(nm(r.requesterId))}</span>` : ''}</div>
    <div>Kính đề nghị Phòng Quản trị Tổng hợp cho bộ môn số lượng nước cất như sau:</div>
    <table><tr><td style="width:44px">STT</td><td>Tên vật tư</td><td style="width:110px">Đơn vị tính</td><td style="width:130px">Số lượng</td><td>Ghi chú</td></tr>
      <tr><td>1</td><td>Nước cất</td><td>Lít</td><td class="hand">${qty}</td><td style="font-size:13px">${esc(notes)}</td></tr></table>
    <div class="date">Tp. Hồ Chí Minh, ngày ${pad(d.getDate())} tháng ${pad(d.getMonth() + 1)} năm ${d.getFullYear()}</div>
    <div class="sig"><div><div class="role">Ban giám hiệu</div>${stamp(r.steps && r.steps.bgh)}</div><div><div class="role">Phòng Quản trị Tổng hợp</div>${stamp(r.steps && r.steps.qtth)}</div><div><div class="role">Trưởng bộ môn</div>${stamp(r.steps && r.steps.tbm, r.steps && r.steps.tbm && r.steps.tbm.ok ? 'Đồng ý' : null)}</div></div>
    <div style="margin-top:14px;font-size:13px">Người lập phiếu: ${esc(nm(r.requesterId))} · ${dTime(r.createdAt)}</div>
    <div style="margin-top:26px;font-size:11.5px;color:#555;font-family:var(--f-ui)">Mã phiếu ${esc(r.code)}${r.qtyIssued != null && r.steps && r.steps.cap ? ` · Đã phát ${fmt(r.qtyIssued)} lít lúc ${dTime(r.steps.cap.at)} bởi ${esc(nm(r.steps.cap.by))}` : ''}</div></div>`;
}
function sPaper(r) {
  return head('Giấy đề nghị cấp nước cất', `<span class="code">${esc(r.code)}</span> · ${esc((STATUS[r.status] || {}).t || '')}`) +
  `<div class="paperwrap">${paperHTML(r)}</div>
  <div class="actions" style="margin-top:14px"><button class="btn" type="button" data-open="${esc(r.id)}">Quay lại phiếu</button><button class="btn primary" type="button" data-act="print">In phiếu</button></div>`;
}

/* ---------- actions ---------- */
const val = id => ($(id)?.value ?? '').trim();
async function afterWrite(keepSheet) { await refresh(); if (!keepSheet && S.openMode !== 'detail') closeSheet(); }

async function doLogin(btn) {
  const username = val('#lgUser').toLowerCase(), password = $('#lgPass').value;
  S.authMsg = null;
  const r = await run(btn, () => api('login', { username, password }));
  if (!r) return;
  S.token = r.token; lsSet(TOKEN_KEY, r.token); S.me = r.user;
  try { await loadAll(); } catch (e) { toast(errText(e), 'bad'); }
  render(true); openDeepLink();
}
async function doRegister(btn) {
  const pw = $('#rgPass').value, pw2 = $('#rgPass2').value;
  if (pw !== pw2) { toast('Hai mật khẩu không khớp', 'bad'); return; }
  const payload = { fullName: val('#rgName'), email: val('#rgEmail'), title: val('#rgTitle'), deptId: val('#rgDept'), role: val('#rgRole'), username: val('#rgUser').toLowerCase(), password: pw, note: val('#rgNote') };
  const r = await run(btn, () => api('register', payload));
  if (!r) return;
  S.authTab = 'login'; S.authMsg = { kind: 'ok', text: 'Đã gửi đăng ký "' + payload.username + '". Bạn sẽ nhận email khi Quản trị hệ thống duyệt.' };
  render(true);
  const u = $('#lgUser'); if (u) u.value = payload.username;
}
async function submitNew(btn) {
  const kind = document.querySelector('input[name=kind]:checked').value;
  const sel = $('#nDept'); let deptId = sel ? sel.value : '_other', deptName = '';
  if (deptId === '_other') { deptId = ''; deptName = val('#nDeptOther'); if (!deptName) return toast('Nhập tên bộ môn', 'bad'); }
  const qty = +$('#nQty').value; if (!(qty > 0)) return toast('Nhập số lít cần cấp', 'bad');
  const r = await run(btn, () => api('createRequest', { kind, deptId, deptName, qty, needBy: val('#nNeed'), receiver: val('#nRecv'), purpose: val('#nPurpose'), note: val('#nNote') }),
    x => 'Đã gửi phiếu ' + x.code + ((x.steps?.tbm?.mail || x.steps?.lap?.mail)?.status === 'sent' ? (x.status === 'cho_qtth' ? ' · đã email Trưởng phòng QTTH' : ' · đã email Trưởng bộ môn') : ''));
  if (!r) return;
  await refresh(); openSheet('detail', r.id);
}
async function decide(btn, id, ok) {
  const note = val('#dNote'); if (!ok && !note) return toast('Nhập lý do từ chối', 'bad');
  const payload = { id, ok, note }; if ($('#dQty')) payload.qtyApproved = +$('#dQty').value;
  if (await run(btn, () => api('decide', payload), ok ? 'Đã đồng ý và gửi email bước tiếp theo' : 'Đã từ chối phiếu')) await afterWrite(true);
}
async function issue(btn, id) {
  const q = +$('#dQty').value; if (!(q > 0)) return toast('Nhập số lít đã phát', 'bad');
  if (await run(btn, () => api('issue', { id, qty: q, note: val('#dNote') }), 'Đã phát ' + fmt(q) + ' L')) await afterWrite(true);
}
async function cancelReq(btn, id) {
  if (S.confirm !== 'cancel:' + id) { S.confirm = 'cancel:' + id; refreshSheet(); return; }
  S.confirm = null;
  if (await run(btn, () => api('cancelRequest', { id }), 'Đã hủy phiếu')) await afterWrite(true);
}

/* ---------- events ---------- */
document.addEventListener('click', async e => {
  const t = e.target.closest('button,[data-open],tr'); if (!t) return; const d = t.dataset;
  if (t.classList.contains('tab')) { S.tab = d.tab; try { history.replaceState(null, '', '#' + d.tab); } catch (_) {} render(true); return; }
  if (d.auth) { S.authTab = d.auth; S.authMsg = null; render(true); return; }
  if (d.go) { S.tab = 'requests'; S.filter = d.go; render(true); return; }
  if (d.pipe) { S.tab = 'requests'; S.filter = d.pipe; render(true); return; }
  if (d.filter) { S.filter = d.filter; render(true); return; }
  if (d.atab) { S.adminTab = d.atab; if (d.atab === 'log') S.log = null; if (d.atab === 'settings') S.mail = null; render(true); return; }
  if ('close' in d) { closeSheet(); return; }
  if (d.open) { openSheet('detail', d.open); return; }
  if (d.paper) { openSheet('paper', d.paper); return; }
  if (d.decide) { decide(t, d.id, d.decide === 'ok'); return; }
  if (d.issue) { issue(t, d.issue); return; }
  if (d.cancel) { cancelReq(t, d.cancel); return; }
  if (d.suok) {
    const box = t.closest('[data-su]');
    const p = { id: d.suok, role: box.querySelector('[data-f=role]').value, deptId: box.querySelector('[data-f=dept]').value, isAdmin: box.querySelector('[data-f=admin]').checked };
    if (p.role === 'tbm' && !p.deptId) return toast('Chọn bộ môn cho Trưởng bộ môn', 'bad');
    if (await run(t, () => api('approveUser', p), 'Đã duyệt tài khoản và gửi email báo người dùng')) refresh(); return;
  }
  if (d.surej) {
    const reason = t.closest('[data-su]').querySelector('[data-f=reason]').value.trim();
    if (!reason) return toast('Nhập lý do từ chối', 'bad');
    if (await run(t, () => api('rejectUser', { id: d.surej, reason }), 'Đã từ chối yêu cầu')) refresh(); return;
  }
  if (d.lock) {
    const u = S.adminUsers.find(x => x.id === d.lock); if (!u) return;
    const next = u.status === 'active' ? 'locked' : 'active';
    if (await run(t, () => api('updateUser', { id: u.id, status: next }), next === 'locked' ? 'Đã khóa ' + u.fullName : 'Đã mở khóa ' + u.fullName)) refresh(); return;
  }
  if (d.resetpw) {
    if (t.dataset.armed !== '1') { t.dataset.armed = '1'; t.textContent = 'Bấm lần nữa để đặt lại'; t.classList.add('danger'); return; }
    const r = await run(t, () => api('resetPassword', { id: d.resetpw }));
    if (r) { openSheet('tempPw', null, r); refresh(); } return;
  }
  if (d.renamedept) { openSheet('renameDept', d.renamedept); return; }
  if (d.deldept) {
    if (t.dataset.armed !== '1') { t.dataset.armed = '1'; t.textContent = 'Bấm lần nữa để xóa'; t.classList.add('danger'); return; }
    if (await run(t, () => api('deleteDept', { id: d.deldept }), 'Đã xóa bộ môn')) refresh(); return;
  }
  switch (d.act) {
    case 'logout': run(t, () => api('logout')).finally(() => signOutLocal()); return;
    case 'account': openSheet('account'); return;
    case 'addUser': openSheet('addUser'); return;
    case 'stockin': case 'count': openSheet(d.act); return;
    case 'print': window.print(); return;
    case 'reloadLog': S.log = null; render(true); return;
    case 'copyPw': {
      const txt = $('#tmpPw').textContent;
      try { await navigator.clipboard.writeText(txt); toast('Đã sao chép mật khẩu'); }
      catch (_) { const r = document.createRange(); r.selectNodeContents($('#tmpPw')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('Đã chọn mật khẩu, nhấn Ctrl+C để sao chép'); }
      return;
    }
    case 'saveStock': {
      const th = +$('#sThr').value, cp = +$('#sCap').value;
      if (!(cp > 0) || th < 0) return toast('Giá trị chưa hợp lệ', 'bad');
      if (await run(t, () => api('saveConfig', { threshold: th, capacity: cp }), 'Đã lưu thiết lập kho')) refresh(); return;
    }
    case 'saveMail': {
      if (await run(t, () => api('saveConfig', { appUrl: val('#mUrl'), mailEnabled: $('#mEnabled').checked }), 'Đã lưu thiết lập email')) { S.mail = null; refresh(); } return;
    }
    case 'testMail': {
      const r = await run(t, () => api('sendTestMail'), x => 'Đã gửi email thử tới ' + x.to);
      if (r) { S.mail = null; render(true); } return;
    }
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && S.open) closeSheet();
  if (e.key === 'Enter' && e.target.matches('tr[data-open]')) openSheet('detail', e.target.dataset.open);
});
$('#overlay').addEventListener('click', e => { if (e.target.id === 'overlay') closeSheet(); });
$('#btnNew').addEventListener('click', () => openSheet('new'));
document.addEventListener('change', async e => {
  const el = e.target;
  if (el.id === 'nDept') { const o = $('#nDeptOther'); o.hidden = el.value !== '_other'; o.required = !o.hidden; }
  if (el.dataset.uf) {
    const id = el.closest('tr').dataset.uid; const u = S.adminUsers.find(x => x.id === id);
    const v = el.type === 'checkbox' ? el.checked : el.value.trim();
    if (el.dataset.uf === 'email' && v === (u.email || '')) return;
    const role = el.dataset.uf === 'role' ? v : u.role, dp = el.dataset.uf === 'deptId' ? v : u.deptId;
    if (role === 'tbm' && !dp) toast('Nhớ chọn bộ môn cho Trưởng bộ môn', 'bad');
    el.disabled = true;
    const ok = await run(null, () => api('updateUser', { id, [el.dataset.uf]: v }), 'Đã cập nhật ' + u.fullName);
    el.disabled = false;
    await refresh(); if (!ok) render(true);
  }
});
document.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, id = f.id, btn = f.querySelector('button[type=submit]');
  if (id === 'fLogin') return doLogin(btn);
  if (id === 'fRegister') return doRegister(btn);
  if (id === 'fNew') return submitNew(btn);
  if (id === 'fIn') {
    const q = +$('#iQty').value; if (!(q > 0)) return toast('Nhập số lít', 'bad');
    if (await run(btn, () => api('stockIn', { qty: q, date: val('#iDate'), source: val('#iSrc'), lot: val('#iLot'), note: val('#iNote') }), 'Đã nhập kho ' + fmt(q) + ' L')) afterWrite();
    return;
  }
  if (id === 'fCount') {
    if ($('#cAct').value === '') return toast('Nhập số lít đo được', 'bad');
    const r = await run(btn, () => api('stockCount', { actual: +$('#cAct').value, note: val('#cNote') }), x => x.unchanged ? 'Số đo khớp với sổ, không cần điều chỉnh' : 'Đã ghi kiểm kê (' + (x.qty > 0 ? '+' : '−') + fmt(Math.abs(x.qty)) + ' L)');
    if (r) afterWrite(); return;
  }
  if (id === 'fProfile') {
    const r = await run(btn, () => api('updateProfile', { fullName: val('#pfName'), title: val('#pfTitle'), email: val('#pfEmail') }), 'Đã lưu thông tin tài khoản');
    if (r) { S.me = r; refresh(); } return;
  }
  if (id === 'fPw') {
    if ($('#pwNew').value !== $('#pwNew2').value) return toast('Hai mật khẩu mới không khớp', 'bad');
    if (await run(btn, () => api('changePassword', { oldPassword: $('#pwOld').value, newPassword: $('#pwNew').value }), 'Đã đổi mật khẩu')) closeSheet();
    return;
  }
  if (id === 'fAddUser') {
    const p = { fullName: val('#auName'), title: val('#auTitle'), email: val('#auEmail'), username: val('#auUser').toLowerCase(), role: val('#auRole'), deptId: val('#auDept'), isAdmin: $('#auAdmin').checked };
    if (p.role === 'tbm' && !p.deptId) return toast('Chọn bộ môn cho Trưởng bộ môn', 'bad');
    const r = await run(btn, () => api('addUser', p), 'Đã tạo tài khoản');
    if (r) { openSheet('tempPw', null, { username: r.user.username, password: r.password }); refresh(); }
    return;
  }
  if (id === 'fRename') {
    if (await run(btn, () => api('renameDept', { id: S.open, name: val('#rnName') }), 'Đã đổi tên bộ môn')) afterWrite();
    return;
  }
  if (id === 'addDept') {
    const n = val('#deptName'); if (!n) return;
    if (await run(btn, () => api('addDept', { name: n }), 'Đã thêm bộ môn ' + n)) { $('#deptName').value = ''; refresh(); }
  }
});
document.addEventListener('input', e => {
  if (e.target.id === 'q') { S.q = e.target.value; const pos = e.target.selectionStart; render(true); const q = $('#q'); if (q) { q.focus(); try { q.setSelectionRange(pos, pos); } catch (_) {} } }
});
document.addEventListener('focusout', () => setTimeout(() => {
  if (deferred && !typing($('#view')) && !typing($('#landing'))) render();
}, 150));
window.addEventListener('hashchange', () => {
  const m = location.hash.match(/^#phieu-([\w-]+)$/);
  if (m) { S.deep = m[1]; if (S.me) openDeepLink(); else render(true); }
});

/* ---------- polling ---------- */
setInterval(() => {
  if (document.hidden || S.pending) return;
  if (S.me) refresh(); else loadPublic().then(() => render());
}, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.me && !S.pending) refresh(); });

/* ---------- boot ---------- */
(async function boot() {
  render(true);
  const jobs = [loadPublic()];
  if (S.token) jobs.push(loadAll().catch(e => { S.token = null; lsSet(TOKEN_KEY, null); S.me = null; if (e && e.code !== 'auth') S.authMsg = { kind: 'err', text: errText(e) }; }));
  await Promise.all(jobs);
  S.booting = false;
  render(true);
  openDeepLink();
})();
})();
