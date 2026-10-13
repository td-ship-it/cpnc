/**
 * Cấp phát nước cất — Trường Dược, Đại học Y Dược TP.HCM
 * Backend Google Apps Script. Dữ liệu lưu trong Google Sheet chứa script này.
 *
 * Quy trình (3 chữ ký đồng ý như phiếu giấy):
 *   1. Cán bộ bộ môn lập giấy đề nghị            → email Trưởng bộ môn
 *      (Trưởng bộ môn tự lập thì bước 2 tự ký     → email Trưởng phòng QTTH)
 *   2. Trưởng bộ môn đồng ý                       → email Trưởng phòng QTTH
 *   3. Trưởng phòng Quản trị Tổng hợp đồng ý      → email Phó hiệu trưởng phụ trách
 *   4. Phó hiệu trưởng phụ trách đồng ý           → email Người phụ trách phát nước,
 *                                                   Trưởng bộ môn và Người đề nghị
 *   5. Người phụ trách phát nước cấp nước, trừ kho → email Người đề nghị, Trưởng bộ môn
 *   Từ chối ở bước nào cũng email Người đề nghị và Trưởng bộ môn.
 *   Kho xuống dưới ngưỡng → email cảnh báo Người phụ trách phát nước và Trưởng phòng QTTH.
 *
 * Cài đặt: xem HUONG-DAN / README.md.
 */

const SCHEMA = {
  Users: ['id', 'username', 'fullName', 'title', 'role', 'deptId', 'status', 'isAdmin',
          'passHash', 'salt', 'createdAt', 'approvedBy', 'note', 'reason', 'lastLogin', 'email'],
  Departments: ['id', 'name'],
  Requests: ['id', 'code', 'kind', 'deptId', 'deptName', 'qty', 'qtyApproved', 'qtyIssued',
             'needBy', 'receiver', 'purpose', 'note', 'requesterId', 'createdAt', 'status', 'steps', 'updatedAt'],
  Stock: ['id', 'at', 'type', 'qty', 'actual', 'by', 'ref', 'code', 'source', 'lot', 'note'],
  Config: ['key', 'value'],
  Log: ['at', 'userId', 'action', 'detail']
};
const NUMERIC = { Requests: ['qty', 'qtyApproved', 'qtyIssued'], Stock: ['qty', 'actual'] };
const ROLES = ['user', 'tbm', 'qtth', 'bgh', 'kho'];
const ROLE_NAME = { user: 'Cán bộ đề nghị', tbm: 'Trưởng bộ môn', qtth: 'Trưởng phòng Quản trị Tổng hợp',
                    bgh: 'Phó hiệu trưởng phụ trách', kho: 'Phụ trách phát nước cất' };
const STEP_OF = { cho_tbm: 'tbm', cho_qtth: 'qtth', cho_bgh: 'bgh', cho_cap: 'cap' };
const STEP_ROLE = { tbm: 'tbm', qtth: 'qtth', bgh: 'bgh', cap: 'kho' };
const NEXT = { tbm: 'cho_qtth', qtth: 'cho_bgh', bgh: 'cho_cap' };
const OPEN = ['cho_tbm', 'cho_qtth', 'cho_bgh'];
const FLOW = [['lap', 'Lập phiếu'], ['tbm', 'Trưởng bộ môn đồng ý'], ['qtth', 'Trưởng phòng QTTH đồng ý'], ['bgh', 'Phó hiệu trưởng đồng ý'], ['cap', 'Phát nước cất']];
const SESSION_TTL = 6 * 60 * 60;   // giây; tối đa của CacheService
const HASH_ROUNDS = 300;
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const DEFAULT_APP_URL = 'https://cpnc.truongduoc.workers.dev';   // địa chỉ trang, dùng cho nút "Mở phiếu" trong email

/* =========================== HTTP =========================== */

function doGet() {
  return json_({ ok: true, data: publicStatus_() });
}

function doPost(e) {
  let out;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    out = { ok: true, data: route_(String(req.action || ''), req.payload || {}, req.token) };
  } catch (err) {
    out = { ok: false, error: err.message || String(err), code: err.code || 'error' };
    if (!err.code) console.error(err);
  }
  return json_(out);
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

const PUBLIC_ACTIONS = {
  publicStatus: function () { return publicStatus_(); },
  login: login_,
  register: register_
};
const USER_ACTIONS = {
  me: function (p, me) { return pubUser_(me); },
  logout: logout_,
  changePassword: changePassword_,
  updateProfile: updateProfile_,
  bootstrap: bootstrap_,
  createRequest: createRequest_,
  decide: decide_,
  issue: issue_,
  cancelRequest: cancelRequest_,
  stockIn: stockIn_,
  stockCount: stockCount_
};
const ADMIN_ACTIONS = {
  approveUser: approveUser_,
  rejectUser: rejectUser_,
  updateUser: updateUser_,
  resetPassword: resetPassword_,
  addUser: addUser_,
  saveConfig: saveConfig_,
  addDept: addDept_,
  renameDept: renameDept_,
  deleteDept: deleteDept_,
  getLog: getLog_,
  mailStatus: mailStatus_,
  sendTestMail: sendTestMail_
};

function route_(action, p, token) {
  if (PUBLIC_ACTIONS[action]) return PUBLIC_ACTIONS[action](p);
  const me = auth_(token);
  me._token = token;
  if (USER_ACTIONS[action]) return USER_ACTIONS[action](p, me);
  if (ADMIN_ACTIONS[action]) {
    if (me.isAdmin !== '1') fail_('Chức năng chỉ dành cho Quản trị hệ thống.', 'forbidden');
    return ADMIN_ACTIONS[action](p, me);
  }
  fail_('Thao tác không hợp lệ: ' + action, 'bad_request');
}

/* =========================== Tiện ích =========================== */

function fail_(msg, code) { const e = new Error(msg); e.code = code || 'bad_request'; throw e; }
function now_() { return new Date().toISOString(); }
function uid_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 12); }
function str_(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 500); }
function num_(v) { const n = Number(v); return isFinite(n) ? Math.round(n * 10) / 10 : NaN; }
function clean_(o) { const c = Object.assign({}, o); delete c._row; return c; }
function esc_(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function email_(v) {
  const e = str_(v, 120).toLowerCase();
  if (e && !EMAIL_RE.test(e)) fail_('Địa chỉ email không hợp lệ.');
  return e;
}

let _ss = null;
function ss_() {
  if (_ss) return _ss;
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  _ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!_ss) fail_('Chưa gắn Google Sheet. Đặt thuộc tính SHEET_ID trong Cài đặt dự án.', 'config');
  return _ss;
}
function sh_(name) {
  const s = ss_().getSheetByName(name);
  if (!s) fail_('Thiếu trang tính "' + name + '". Hãy chạy hàm setup().', 'config');
  return s;
}
function rows_(name) {
  const s = sh_(name), h = SCHEMA[name], n = s.getLastRow();
  if (n < 2) return [];
  const vals = s.getRange(2, 1, n - 1, h.length).getValues();
  const nums = NUMERIC[name] || [];
  const out = [];
  vals.forEach(function (v, i) {
    if (v.every(function (x) { return x === '' || x === null; })) return;
    const o = { _row: i + 2 };
    h.forEach(function (k, j) {
      const x = v[j];
      o[k] = x instanceof Date ? x.toISOString() : (x === null || x === undefined ? '' : String(x));
    });
    nums.forEach(function (k) { o[k] = o[k] === '' ? null : Number(o[k]); });
    out.push(o);
  });
  return out;
}
function write_(name, obj, row) {
  const s = sh_(name), h = SCHEMA[name];
  const vals = h.map(function (k) {
    const x = obj[k];
    if (x === undefined || x === null || x === false) return '';
    if (x === true) return '1';
    if (typeof x === 'object') return JSON.stringify(x);
    return String(x);
  });
  const r = row || s.getLastRow() + 1;
  const rng = s.getRange(r, 1, 1, h.length);
  rng.setNumberFormat('@');
  rng.setValues([vals]);
  obj._row = r;
  return obj;
}
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) fail_('Hệ thống đang bận, vui lòng thử lại sau giây lát.', 'busy');
  try { return fn(); } finally { lock.releaseLock(); }
}
function log_(userId, action, detail) {
  try { write_('Log', { at: now_(), userId: userId || '', action: action, detail: str_(detail, 1000) }); } catch (e) { console.error(e); }
}

/* =========================== Mật khẩu & phiên =========================== */

function hash_(pw, salt) {
  let h = salt + '|' + pw, bytes = null;
  for (let i = 0; i < HASH_ROUNDS; i++) {
    bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h, Utilities.Charset.UTF_8);
    h = Utilities.base64Encode(bytes) + '|' + salt;
  }
  return Utilities.base64Encode(bytes);
}
function randomPw_() {
  const a = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const hex = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  let s = '';
  for (let i = 0; i < 12; i++) s += a[parseInt(hex.substr(i * 2, 2), 16) % a.length];
  return s;
}
function checkPw_(pw) { if (String(pw || '').length < 8) fail_('Mật khẩu tối thiểu 8 ký tự.'); }

function auth_(token) {
  if (!token) fail_('Vui lòng đăng nhập.', 'auth');
  const c = CacheService.getScriptCache();
  const id = c.get('s_' + token);
  if (!id) fail_('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.', 'auth');
  const u = rows_('Users').find(function (x) { return x.id === id; });
  if (!u || u.status !== 'active') { c.remove('s_' + token); fail_('Tài khoản không còn hoạt động.', 'auth'); }
  c.put('s_' + token, id, SESSION_TTL);
  return u;
}

function pubUser_(u) {
  return { id: u.id, username: u.username, fullName: u.fullName, title: u.title, role: u.role, email: u.email,
           deptId: u.deptId, status: u.status, isAdmin: u.isAdmin === '1' };
}
function adminUser_(u) {
  const o = pubUser_(u);
  o.note = u.note; o.reason = u.reason; o.createdAt = u.createdAt; o.lastLogin = u.lastLogin; o.approvedBy = u.approvedBy;
  return o;
}

/* =========================== Cấu hình & tính toán =========================== */

function departments_() { return rows_('Departments').map(function (d) { return { id: d.id, name: d.name }; }); }
function validDept_(id) {
  if (!id) return '';
  return departments_().some(function (d) { return d.id === id; }) ? id : '';
}

function cfg_() {
  const o = { threshold: 100, capacity: 500, appUrl: '', mailEnabled: true };
  rows_('Config').forEach(function (r) {
    if (r.key === 'threshold' || r.key === 'capacity') { const n = Number(r.value); if (isFinite(n)) o[r.key] = n; }
    if (r.key === 'appUrl') o.appUrl = r.value;
    if (r.key === 'mailEnabled') o.mailEnabled = r.value !== '0';
  });
  return o;
}
function setCfg_(k, v) {
  const r = rows_('Config').find(function (x) { return x.key === k; });
  write_('Config', { key: k, value: v }, r && r._row);
}

function requests_() {
  return rows_('Requests').map(function (r) {
    try { r.steps = r.steps ? JSON.parse(r.steps) : {}; } catch (e) { r.steps = {}; }
    return r;
  });
}
function qtyOf_(r) { return r.qtyApproved != null ? r.qtyApproved : r.qty; }
function calc_(reqs, stock, cfg) {
  let bal = 0;
  stock.forEach(function (m) { bal += m.type === 'xuat' ? -m.qty : m.qty; });
  const reserved = reqs.filter(function (r) { return r.status === 'cho_cap'; }).reduce(function (a, r) { return a + qtyOf_(r); }, 0);
  const since = Date.now() - 30 * 864e5;
  const used30 = stock.filter(function (m) { return m.type === 'xuat' && Date.parse(m.at) >= since; })
                      .reduce(function (a, m) { return a + m.qty; }, 0);
  const avail = bal - reserved;
  const level = avail <= 0 ? 'bad' : avail <= cfg.threshold ? 'warn' : 'ok';
  const r1 = function (n) { return Math.round(n * 10) / 10; };
  return { bal: r1(bal), reserved: r1(reserved), avail: r1(avail), used30: r1(used30), level: level };
}

/* =========================== Email thông báo =========================== */

function activeByRole_(users, role, deptId) {
  return users.filter(function (u) { return u.status === 'active' && u.role === role && (!deptId || u.deptId === deptId); });
}
function uniqUsers_(list) {
  const seen = {};
  return list.filter(function (u) { if (!u || seen[u.id]) return false; seen[u.id] = 1; return true; });
}

/** Gửi một email tới danh sách người dùng. Không bao giờ ném lỗi; trả về kết quả để lưu vào phiếu. */
function notify_(recipients, subject, html, actorId) {
  const cfg = cfg_();
  const list = uniqUsers_(recipients);
  const withMail = list.filter(function (u) { return EMAIL_RE.test(u.email || ''); });
  const res = { to: withMail.map(function (u) { return u.id; }), missing: list.filter(function (u) { return withMail.indexOf(u) < 0; }).map(function (u) { return u.id; }) };
  if (!cfg.mailEnabled) { res.status = 'off'; return res; }
  if (!withMail.length) { res.status = 'none'; return res; }
  try {
    MailApp.sendEmail({
      to: withMail.map(function (u) { return u.email; }).join(','),
      subject: subject,
      htmlBody: html,
      name: 'Cấp phát nước cất · Trường Dược'
    });
    res.status = 'sent';
    log_(actorId, 'mail', subject + ' → ' + withMail.map(function (u) { return u.email; }).join(', '));
  } catch (e) {
    res.status = 'error';
    res.error = str_(e && e.message || e, 200);
    log_(actorId, 'mailError', subject + ' · ' + res.error);
  }
  return res;
}

function link_(cfg, r) {
  const base = String(cfg.appUrl || '').replace(/\/+$/, '');
  return base ? base + '/#phieu-' + r.id : '';
}

function mailHtml_(r, users, opts) {
  const cfg = cfg_();
  const name = function (id) { const u = users.find(function (x) { return x.id === id; }); return u ? u.fullName : ''; };
  const cur = STEP_OF[r.status];
  const flow = FLOW.map(function (f) {
    const s = f[0] === 'lap' ? { ok: true } : r.steps[f[0]];
    let mark = '○', color = '#8a9aa5', weight = '400';
    if (s) { mark = s.ok ? '✓' : '✕'; color = s.ok ? '#2c7a4d' : '#ae2a20'; }
    else if (cur === f[0]) { mark = '●'; color = '#0a6a86'; weight = '700'; }
    return '<span style="color:' + color + ';font-weight:' + weight + ';white-space:nowrap">' + mark + ' ' + esc_(f[1]) + '</span>';
  }).join(' <span style="color:#b8c6cf">→</span> ');
  const row = function (k, v) { return v ? '<tr><td style="padding:6px 12px 6px 0;color:#566c7b;vertical-align:top;white-space:nowrap">' + k + '</td><td style="padding:6px 0;color:#0e2431">' + v + '</td></tr>' : ''; };
  const qty = r.qtyApproved != null && r.qtyApproved !== r.qty ? esc_(r.qty) + ' L (duyệt ' + esc_(r.qtyApproved) + ' L)' : esc_(qtyOf_(r)) + ' L';
  const url = link_(cfg, r);
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#0e2431;max-width:620px">' +
    '<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#566c7b;font-weight:700">Trường Dược · Cấp phát nước cất</div>' +
    '<h2 style="margin:6px 0 10px;font-size:20px">' + esc_(opts.heading) + '</h2>' +
    '<p style="margin:0 0 14px">' + opts.intro + '</p>' +
    '<div style="padding:10px 12px;background:#eef3f6;border-radius:8px;font-size:13px;margin-bottom:14px">' + flow + '</div>' +
    '<table style="border-collapse:collapse;font-size:14px;margin-bottom:16px">' +
      row('Mã phiếu', '<b>' + esc_(r.code) + '</b>') +
      row('Bộ môn', esc_(r.deptName)) +
      row('Người đề nghị', esc_(name(r.requesterId))) +
      row('Số lượng', '<b>' + qty + '</b>') +
      row('Mục đích', esc_(r.purpose)) +
      row('Ngày cần nhận', esc_(r.needBy ? r.needBy.split('-').reverse().join('/') : '')) +
      row('Người nhận nước', esc_(r.receiver)) +
      row('Ghi chú', esc_(r.note)) +
      (opts.extra || '') +
    '</table>' +
    (url ? '<p style="margin:0 0 18px"><a href="' + esc_(url) + '" style="display:inline-block;background:#0a6a86;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:700">' + esc_(opts.button || 'Mở phiếu') + '</a></p>' : '') +
    '<p style="margin:0;font-size:12px;color:#8a9aa5">Email tự động từ hệ thống Cấp phát nước cất. Vui lòng không trả lời email này.</p></div>';
}

function subject_(r, tail) { return '[Nước cất] ' + r.code + ' · ' + r.deptName + ' · ' + qtyOf_(r) + ' L · ' + tail; }

/** Gửi email theo sự kiện của phiếu, trả về kết quả gửi. */
function notifyEvent_(event, r, users, actor) {
  const requester = users.find(function (u) { return u.id === r.requesterId; });
  const heads = r.deptId ? activeByRole_(users, 'tbm', r.deptId) : [];
  const stepKey = event === 'rejected' ? r._rejectStep : STEP_OF_EVENT_[event];
  const s = actor && stepKey ? r.steps[stepKey] : null;
  const who = actor ? esc_(actor.fullName) : '';
  const noteRow = s && s.note ? '<tr><td style="padding:6px 12px 6px 0;color:#566c7b;vertical-align:top">Ý kiến</td><td style="padding:6px 0">' + esc_(s.note) + '</td></tr>' : '';
  switch (event) {
    case 'created':
      return notify_(heads, subject_(r, 'Chờ Trưởng bộ môn đồng ý'),
        mailHtml_(r, users, { heading: 'Giấy đề nghị mới chờ Trưởng bộ môn đồng ý', button: 'Mở phiếu để đồng ý',
          intro: '<b>' + esc_(requester ? requester.fullName : '') + '</b> (' + esc_(r.deptName) + ') đề nghị cấp <b>' + esc_(r.qty) + ' lít</b> nước cất. Kính đề nghị Trưởng bộ môn xem xét và đồng ý.' }),
        r.requesterId);
    case 'tbm_ok':
      return notify_(activeByRole_(users, 'qtth'), subject_(r, 'Chờ Trưởng phòng QTTH đồng ý'),
        mailHtml_(r, users, { heading: 'Giấy đề nghị chờ Trưởng phòng QTTH đồng ý', button: 'Mở phiếu để đồng ý', extra: noteRow,
          intro: (s && s.auto ? 'Trưởng bộ môn <b>' + who + '</b> lập và ký giấy đề nghị' : 'Trưởng bộ môn <b>' + who + '</b> đã đồng ý') + ' cấp <b>' + esc_(r.qty) + ' lít</b> nước cất cho ' + esc_(r.deptName) + '. Kính đề nghị Trưởng phòng Quản trị Tổng hợp xem xét.' }),
        actor.id);
    case 'qtth_ok':
      return notify_(activeByRole_(users, 'bgh'), subject_(r, 'Chờ Phó hiệu trưởng đồng ý'),
        mailHtml_(r, users, { heading: 'Giấy đề nghị chờ Phó hiệu trưởng phê duyệt', button: 'Mở phiếu để phê duyệt', extra: noteRow,
          intro: 'Trưởng phòng Quản trị Tổng hợp <b>' + who + '</b> đã đồng ý <b>' + esc_(qtyOf_(r)) + ' lít</b>. Kính đề nghị Phó hiệu trưởng phụ trách phê duyệt.' }),
        actor.id);
    case 'bgh_ok':
      return notify_(activeByRole_(users, 'kho').concat(heads, [requester]), subject_(r, 'Đã duyệt · Chờ phát nước'),
        mailHtml_(r, users, { heading: 'Giấy đề nghị đã được phê duyệt', button: 'Xem phiếu', extra: noteRow,
          intro: 'Phó hiệu trưởng phụ trách <b>' + who + '</b> đã phê duyệt cấp <b>' + esc_(qtyOf_(r)) + ' lít</b> nước cất.<br>' +
                 '• <b>Người phụ trách phát nước cất</b>: vui lòng chuẩn bị và cấp nước cho bộ môn.<br>' +
                 '• <b>Bộ môn</b>: liên hệ nhận nước' + (r.needBy ? ' vào ngày ' + esc_(r.needBy.split('-').reverse().join('/')) : '') + '.' }),
        actor.id);
    case 'rejected':
      return notify_(heads.concat([requester]), subject_(r, 'Không được duyệt'),
        mailHtml_(r, users, { heading: 'Giấy đề nghị không được duyệt', button: 'Xem phiếu', extra: noteRow,
          intro: '<b>' + who + '</b> (' + esc_(ROLE_NAME[STEP_ROLE[r._rejectStep]] || '') + ') đã từ chối giấy đề nghị này.' }),
        actor.id);
    case 'issued':
      return notify_(heads.concat([requester]), subject_(r, 'Đã phát ' + r.qtyIssued + ' L'),
        mailHtml_(r, users, { heading: 'Đã phát nước cất', button: 'Xem phiếu', extra: noteRow,
          intro: '<b>' + who + '</b> đã phát <b>' + esc_(r.qtyIssued) + ' lít</b> nước cất cho bộ môn. Giấy đề nghị đã hoàn tất.' }),
        actor.id);
  }
  return null;
}
const STEP_OF_EVENT_ = { tbm_ok: 'tbm', qtth_ok: 'qtth', bgh_ok: 'bgh', issued: 'cap' };

/** Cảnh báo một lần khi lượng khả dụng xuống dưới ngưỡng; tự đặt lại khi kho được bổ sung trên ngưỡng. */
function checkLowStock_(actorId, users) {
  try {
    const cfg = cfg_();
    const k = calc_(requests_(), rows_('Stock'), cfg);
    const flag = rows_('Config').some(function (x) { return x.key === 'lowAlert' && x.value === '1'; });
    if (k.avail > cfg.threshold) { if (flag) setCfg_('lowAlert', '0'); return; }
    if (flag) return;
    users = users || rows_('Users');
    const url = String(cfg.appUrl || '').replace(/\/+$/, '');
    const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#0e2431;max-width:620px">' +
      '<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#566c7b;font-weight:700">Trường Dược · Cấp phát nước cất</div>' +
      '<h2 style="margin:6px 0 10px;font-size:20px;color:#9a5a00">Nước cất trong kho dưới ngưỡng</h2>' +
      '<p>Lượng nước cất khả dụng còn <b>' + k.avail + ' lít</b> (tồn thực tế ' + k.bal + ' L, đã duyệt chờ phát ' + k.reserved + ' L), dưới ngưỡng đặt hàng <b>' + cfg.threshold + ' L</b>.</p>' +
      '<p>Đề xuất bổ sung khoảng <b>' + Math.max(0, Math.ceil((cfg.capacity - k.avail) / 10) * 10) + ' lít</b> để đầy kho (dung tích ' + cfg.capacity + ' L). Sau khi nhận nước, vào <b>Sổ kho → Nhập kho</b> để cập nhật.</p>' +
      (url ? '<p><a href="' + esc_(url) + '/#stock" style="display:inline-block;background:#0a6a86;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:700">Mở sổ kho</a></p>' : '') + '</div>';
    const res = notify_(activeByRole_(users, 'kho').concat(activeByRole_(users, 'qtth')), '[Nước cất] Cảnh báo: kho còn ' + k.avail + ' L, dưới ngưỡng ' + cfg.threshold + ' L', html, actorId);
    if (res.status === 'sent' || res.status === 'none' || res.status === 'off') setCfg_('lowAlert', '1');
  } catch (e) { console.error(e); }
}

/* =========================== Công khai =========================== */

function publicStatus_() {
  const c = CacheService.getScriptCache();
  const hit = c.get('pub');
  if (hit) return JSON.parse(hit);
  const cfg = cfg_();
  const k = calc_(requests_(), rows_('Stock'), cfg);
  const out = { avail: k.avail, level: k.level, used30: k.used30, threshold: cfg.threshold, capacity: cfg.capacity,
                updatedAt: now_(), departments: departments_() };
  c.put('pub', JSON.stringify(out), 60);
  return out;
}
function dropPub_() { CacheService.getScriptCache().remove('pub'); }

function login_(p) {
  const un = str_(p.username, 64).toLowerCase(), pw = String(p.password || '');
  if (!un || !pw) fail_('Nhập tên đăng nhập và mật khẩu.');
  const c = CacheService.getScriptCache(), fk = 'f_' + un, fails = Number(c.get(fk) || 0);
  if (fails >= 5) fail_('Đăng nhập sai quá 5 lần. Vui lòng thử lại sau 15 phút.', 'throttled');
  const u = rows_('Users').find(function (x) { return x.username === un; });
  if (!u || hash_(pw, u.salt) !== u.passHash) {
    c.put(fk, String(fails + 1), 900);
    fail_('Sai tên đăng nhập hoặc mật khẩu.', 'bad_login');
  }
  c.remove(fk);
  if (u.status === 'pending') fail_('Tài khoản đang chờ Quản trị hệ thống duyệt.', 'pending');
  if (u.status === 'rejected') fail_('Đăng ký bị từ chối' + (u.reason ? ': ' + u.reason : '.') + ' Bạn có thể đăng ký lại với cùng tên đăng nhập.', 'rejected');
  if (u.status === 'locked') fail_('Tài khoản đã bị khóa. Liên hệ Quản trị hệ thống.', 'locked');
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  c.put('s_' + token, u.id, SESSION_TTL);
  withLock_(function () {
    const f = rows_('Users').find(function (x) { return x.id === u.id; });
    if (f) { f.lastLogin = now_(); write_('Users', f, f._row); }
  });
  return { token: token, user: pubUser_(u) };
}

function register_(p) {
  const un = str_(p.username, 64).toLowerCase(), pw = String(p.password || ''), name = str_(p.fullName, 100);
  if (!/^[a-z0-9._-]{3,32}$/.test(un)) fail_('Tên đăng nhập dài 3–32 ký tự, gồm chữ thường không dấu, số, dấu chấm, gạch dưới hoặc gạch ngang.');
  checkPw_(pw);
  if (!name) fail_('Nhập họ và tên.');
  const email = email_(p.email);
  if (!email) fail_('Nhập email để nhận thông báo.');
  const c = CacheService.getScriptCache(), n = Number(c.get('reg_n') || 0);
  if (n >= 20) fail_('Có quá nhiều đăng ký mới trong ít phút qua, vui lòng thử lại sau.', 'throttled');
  c.put('reg_n', String(n + 1), 600);
  return withLock_(function () {
    const ex = rows_('Users').find(function (x) { return x.username === un; });
    if (ex && ex.status !== 'rejected') fail_('Tên đăng nhập đã có người dùng, hãy chọn tên khác.', 'exists');
    const salt = Utilities.getUuid();
    const u = {
      id: ex ? ex.id : 'u' + uid_(), username: un, fullName: name, title: str_(p.title, 100),
      role: ROLES.indexOf(p.role) >= 0 ? p.role : 'user', deptId: validDept_(p.deptId), status: 'pending', isAdmin: '',
      passHash: hash_(pw, salt), salt: salt, createdAt: now_(), approvedBy: '', note: str_(p.note, 300), reason: '', lastLogin: '',
      email: email
    };
    write_('Users', u, ex && ex._row);
    log_(u.id, 'register', un + ' · ' + name + ' · ' + email);
    return { status: 'pending' };
  });
}

/* =========================== Người dùng đã đăng nhập =========================== */

function logout_(p, me) {
  CacheService.getScriptCache().remove('s_' + me._token);
  return { ok: true };
}

function changePassword_(p, me) {
  if (hash_(String(p.oldPassword || ''), me.salt) !== me.passHash) fail_('Mật khẩu hiện tại không đúng.');
  checkPw_(p.newPassword);
  return withLock_(function () {
    const u = rows_('Users').find(function (x) { return x.id === me.id; });
    u.salt = Utilities.getUuid(); u.passHash = hash_(String(p.newPassword), u.salt);
    write_('Users', u, u._row);
    log_(me.id, 'changePassword', '');
    return { ok: true };
  });
}

function updateProfile_(p, me) {
  const name = str_(p.fullName, 100);
  if (!name) fail_('Họ tên không được trống.');
  const email = email_(p.email);
  if (!email) fail_('Nhập email để nhận thông báo.');
  return withLock_(function () {
    const u = rows_('Users').find(function (x) { return x.id === me.id; });
    u.fullName = name; u.title = str_(p.title, 100); u.email = email;
    write_('Users', u, u._row);
    log_(me.id, 'updateProfile', email);
    return pubUser_(u);
  });
}

function bootstrap_(p, me) {
  const users = rows_('Users');
  const out = {
    me: pubUser_(me),
    cfg: cfg_(),
    departments: departments_(),
    users: users.filter(function (u) { return u.status === 'active' || u.status === 'locked'; }).map(function (u) {
      return { id: u.id, fullName: u.fullName, title: u.title, role: u.role, deptId: u.deptId, status: u.status,
               isAdmin: u.isAdmin === '1', hasEmail: EMAIL_RE.test(u.email || '') };
    }),
    requests: requests_().map(clean_),
    stock: rows_('Stock').map(clean_),
    serverTime: now_()
  };
  if (me.isAdmin === '1') out.adminUsers = users.map(adminUser_);
  return out;
}

function canAct_(me, step, r) {
  if (me.isAdmin === '1') return true;
  if (me.role !== STEP_ROLE[step]) return false;
  return step !== 'tbm' || (!!me.deptId && !!r && me.deptId === r.deptId);
}
function canStock_(me) { return me.isAdmin === '1' || me.role === 'kho' || me.role === 'qtth'; }

function newCode_() {
  const d = new Date();
  const p2 = function (n) { return (n < 10 ? '0' : '') + n; };
  return 'NC' + String(d.getFullYear()).slice(2) + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + uid_().slice(0, 4).toUpperCase();
}

function createRequest_(p, me) {
  const qty = num_(p.qty);
  if (!(qty > 0) || qty > 100000) fail_('Số lượng không hợp lệ.');
  const purpose = str_(p.purpose, 300);
  if (!purpose) fail_('Nhập mục đích sử dụng.');
  let deptId = validDept_(p.deptId), deptName = '';
  if (deptId) deptName = departments_().find(function (d) { return d.id === deptId; }).name;
  else { deptName = str_(p.deptName, 100); if (!deptName) fail_('Chọn hoặc nhập bộ môn.'); }
  const t = now_();
  const r = {
    id: 'r' + uid_(), code: newCode_(), kind: p.kind === 'ca-nhan' ? 'ca-nhan' : 'bo-mon', deptId: deptId, deptName: deptName,
    qty: qty, qtyApproved: null, qtyIssued: null, needBy: /^\d{4}-\d{2}-\d{2}$/.test(p.needBy || '') ? p.needBy : '',
    receiver: str_(p.receiver, 100), purpose: purpose, note: str_(p.note, 500), requesterId: me.id,
    createdAt: t, status: 'cho_tbm', steps: { lap: { by: me.id, at: t, ok: true } }, updatedAt: t
  };
  return withLock_(function () {
    const users = rows_('Users');
    if (deptId && me.role === 'tbm' && me.deptId === deptId) {
      // Trưởng bộ môn tự lập phiếu: chữ ký Trưởng bộ môn được ký luôn, chuyển thẳng Trưởng phòng QTTH.
      r.steps.tbm = { by: me.id, at: t, ok: true, auto: true, note: 'Trưởng bộ môn lập phiếu, tự ký đồng ý.' };
      r.status = 'cho_qtth';
      r.steps.tbm.mail = notifyEvent_('tbm_ok', r, users, me);
    } else {
      r.steps.lap.mail = notifyEvent_('created', r, users, null);
    }
    write_('Requests', r);
    log_(me.id, 'createRequest', r.code + ' · ' + deptName + ' · ' + qty + ' L');
    dropPub_();
    return clean_(r);
  });
}

function findReq_(id) {
  const r = requests_().find(function (x) { return x.id === id; });
  if (!r) fail_('Không tìm thấy phiếu.', 'not_found');
  return r;
}

function decide_(p, me) {
  return withLock_(function () {
    const r = findReq_(p.id);
    const step = STEP_OF[r.status];
    if (!step || step === 'cap') fail_('Phiếu không còn ở bước duyệt.', 'conflict');
    if (!canAct_(me, step, r)) fail_(step === 'tbm' ? 'Chỉ Trưởng bộ môn của bộ môn này được đồng ý.' : 'Bạn không phụ trách bước này của phiếu.', 'forbidden');
    const ok = p.ok === true, note = str_(p.note, 500);
    if (!ok && !note) fail_('Nhập lý do từ chối.');
    const s = { by: me.id, at: now_(), ok: ok, note: note };
    if (step === 'qtth' && ok) {
      const q = num_(p.qtyApproved != null ? p.qtyApproved : r.qty);
      if (!(q > 0)) fail_('Số lượng duyệt phải lớn hơn 0.');
      s.qty = q; r.qtyApproved = q;
    }
    r.steps[step] = s;
    r.status = ok ? NEXT[step] : 'tu_choi';
    r.updatedAt = s.at;
    const users = rows_('Users');
    if (ok) s.mail = notifyEvent_(step + '_ok', r, users, me);
    else { r._rejectStep = step; s.mail = notifyEvent_('rejected', r, users, me); delete r._rejectStep; }
    write_('Requests', r, r._row);
    log_(me.id, ok ? 'approve' : 'reject', r.code + ' · bước ' + step + (note ? ' · ' + note : ''));
    dropPub_();
    if (ok && step === 'bgh') checkLowStock_(me.id, users);
    return clean_(r);
  });
}

function issue_(p, me) {
  return withLock_(function () {
    const r = findReq_(p.id);
    if (r.status !== 'cho_cap') fail_('Phiếu không còn ở trạng thái chờ phát nước.', 'conflict');
    if (!canAct_(me, 'cap', r)) fail_('Chỉ Người phụ trách phát nước cất được cấp phát.', 'forbidden');
    const q = num_(p.qty);
    if (!(q > 0)) fail_('Nhập số lít đã phát.');
    const stock = rows_('Stock');
    const bal = calc_([], stock, cfg_()).bal;
    if (q > bal) fail_('Tồn kho chỉ còn ' + bal + ' L. Hãy nhập kho hoặc kiểm kê trước.', 'insufficient');
    const at = now_(), note = str_(p.note, 300);
    write_('Stock', { id: 'x-' + r.id, at: at, type: 'xuat', qty: q, actual: null, by: me.id, ref: r.id, code: r.code,
                      source: '', lot: '', note: (r.deptName || '') + (note ? ' · ' + note : '') });
    r.status = 'da_cap'; r.qtyIssued = q; r.updatedAt = at;
    r.steps.cap = { by: me.id, at: at, ok: true, qty: q, note: note };
    r.steps.cap.mail = notifyEvent_('issued', r, rows_('Users'), me);
    write_('Requests', r, r._row);
    log_(me.id, 'issue', r.code + ' · ' + q + ' L');
    dropPub_();
    checkLowStock_(me.id);
    return clean_(r);
  });
}

function cancelRequest_(p, me) {
  return withLock_(function () {
    const r = findReq_(p.id);
    if (r.requesterId !== me.id && me.isAdmin !== '1') fail_('Chỉ người lập phiếu được hủy.', 'forbidden');
    if (OPEN.indexOf(r.status) < 0) fail_('Phiếu đã được phê duyệt hoặc đã kết thúc, không hủy được.', 'conflict');
    r.status = 'da_huy'; r.updatedAt = now_();
    r.steps.huy = { by: me.id, at: r.updatedAt, ok: false };
    write_('Requests', r, r._row);
    log_(me.id, 'cancel', r.code);
    dropPub_();
    return clean_(r);
  });
}

function stockIn_(p, me) {
  if (!canStock_(me)) fail_('Chỉ Người phụ trách phát nước hoặc Trưởng phòng QTTH cập nhật sổ kho.', 'forbidden');
  const q = num_(p.qty);
  if (!(q > 0)) fail_('Số lít nhập phải lớn hơn 0.');
  let at = now_();
  if (/^\d{4}-\d{2}-\d{2}$/.test(p.date || '') && p.date !== at.slice(0, 10)) at = new Date(p.date + 'T12:00:00+07:00').toISOString();
  return withLock_(function () {
    const m = { id: 'n' + uid_(), at: at, type: 'nhap', qty: q, actual: null, by: me.id, ref: '', code: '',
                source: str_(p.source, 150), lot: str_(p.lot, 80), note: str_(p.note, 300) };
    write_('Stock', m);
    log_(me.id, 'stockIn', q + ' L' + (m.source ? ' · ' + m.source : ''));
    dropPub_();
    checkLowStock_(me.id);
    return clean_(m);
  });
}

function stockCount_(p, me) {
  if (!canStock_(me)) fail_('Chỉ Người phụ trách phát nước hoặc Trưởng phòng QTTH cập nhật sổ kho.', 'forbidden');
  const a = num_(p.actual);
  if (!(a >= 0)) fail_('Nhập số lít đo được.');
  return withLock_(function () {
    const bal = calc_([], rows_('Stock'), cfg_()).bal;
    const diff = Math.round((a - bal) * 10) / 10;
    if (diff === 0) return { unchanged: true };
    const m = { id: 'k' + uid_(), at: now_(), type: 'kiemke', qty: diff, actual: a, by: me.id, ref: '', code: '',
                source: '', lot: '', note: str_(p.note, 300) || 'Kiểm kê' };
    write_('Stock', m);
    log_(me.id, 'stockCount', 'Đo ' + a + ' L, chênh ' + diff + ' L');
    dropPub_();
    checkLowStock_(me.id);
    return clean_(m);
  });
}

/* =========================== Quản trị hệ thống =========================== */

function findUser_(users, id) {
  const u = users.find(function (x) { return x.id === id; });
  if (!u) fail_('Không tìm thấy người dùng.', 'not_found');
  return u;
}
function adminCount_(users) { return users.filter(function (u) { return u.isAdmin === '1' && u.status === 'active'; }).length; }

function approveUser_(p, me) {
  return withLock_(function () {
    const u = findUser_(rows_('Users'), p.id);
    if (u.status !== 'pending') fail_('Yêu cầu này đã được xử lý.', 'conflict');
    u.role = ROLES.indexOf(p.role) >= 0 ? p.role : 'user';
    u.deptId = validDept_(p.deptId);
    if (u.role === 'tbm' && !u.deptId) fail_('Chọn bộ môn cho Trưởng bộ môn.');
    u.isAdmin = p.isAdmin ? '1' : '';
    u.status = 'active'; u.approvedBy = me.id; u.reason = '';
    write_('Users', u, u._row);
    log_(me.id, 'approveUser', u.username + ' · ' + u.role);
    notify_([u], '[Nước cất] Tài khoản của bạn đã được duyệt',
      '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5"><p>Chào ' + esc_(u.fullName) + ',</p>' +
      '<p>Tài khoản <b>' + esc_(u.username) + '</b> trên hệ thống Cấp phát nước cất đã được duyệt với vai trò <b>' + esc_(ROLE_NAME[u.role]) + '</b>.</p>' +
      (cfg_().appUrl ? '<p><a href="' + esc_(cfg_().appUrl) + '">Đăng nhập tại đây</a></p>' : '') + '</div>', me.id);
    return adminUser_(u);
  });
}

function rejectUser_(p, me) {
  const reason = str_(p.reason, 300);
  if (!reason) fail_('Nhập lý do từ chối.');
  return withLock_(function () {
    const u = findUser_(rows_('Users'), p.id);
    if (u.status !== 'pending') fail_('Yêu cầu này đã được xử lý.', 'conflict');
    u.status = 'rejected'; u.reason = reason; u.approvedBy = me.id;
    write_('Users', u, u._row);
    log_(me.id, 'rejectUser', u.username + ' · ' + reason);
    return adminUser_(u);
  });
}

function updateUser_(p, me) {
  return withLock_(function () {
    const users = rows_('Users');
    const u = findUser_(users, p.id);
    if (p.role !== undefined) { if (ROLES.indexOf(p.role) < 0) fail_('Vai trò không hợp lệ.'); u.role = p.role; }
    if (p.deptId !== undefined) u.deptId = validDept_(p.deptId);
    if (p.fullName !== undefined) { const n = str_(p.fullName, 100); if (!n) fail_('Họ tên không được trống.'); u.fullName = n; }
    if (p.title !== undefined) u.title = str_(p.title, 100);
    if (p.email !== undefined) u.email = email_(p.email);
    if (p.status !== undefined) {
      if (['active', 'locked'].indexOf(p.status) < 0) fail_('Trạng thái không hợp lệ.');
      if (u.id === me.id && p.status !== 'active') fail_('Bạn không thể tự khóa tài khoản của mình.');
      u.status = p.status;
    }
    if (p.isAdmin !== undefined) {
      if (u.id === me.id && !p.isAdmin) fail_('Bạn không thể tự gỡ quyền quản trị của mình.');
      u.isAdmin = p.isAdmin ? '1' : '';
    }
    if (u.isAdmin !== '1' || u.status !== 'active') {
      const others = users.filter(function (x) { return x.id !== u.id; });
      if (adminCount_(others) === 0) fail_('Hệ thống cần ít nhất một Quản trị hệ thống đang hoạt động.');
    }
    write_('Users', u, u._row);
    log_(me.id, 'updateUser', u.username + ' · ' + JSON.stringify(clean_(p)));
    return adminUser_(u);
  });
}

function resetPassword_(p, me) {
  return withLock_(function () {
    const u = findUser_(rows_('Users'), p.id);
    const pw = randomPw_();
    u.salt = Utilities.getUuid(); u.passHash = hash_(pw, u.salt);
    write_('Users', u, u._row);
    log_(me.id, 'resetPassword', u.username);
    return { username: u.username, password: pw };
  });
}

function addUser_(p, me) {
  const un = str_(p.username, 64).toLowerCase(), name = str_(p.fullName, 100);
  if (!/^[a-z0-9._-]{3,32}$/.test(un)) fail_('Tên đăng nhập dài 3–32 ký tự, gồm chữ thường không dấu, số, dấu chấm, gạch dưới hoặc gạch ngang.');
  if (!name) fail_('Nhập họ và tên.');
  const email = email_(p.email);
  const role = ROLES.indexOf(p.role) >= 0 ? p.role : 'user';
  return withLock_(function () {
    const ex = rows_('Users').find(function (x) { return x.username === un; });
    if (ex) fail_('Tên đăng nhập đã tồn tại.', 'exists');
    const deptId = validDept_(p.deptId);
    if (role === 'tbm' && !deptId) fail_('Chọn bộ môn cho Trưởng bộ môn.');
    const pw = randomPw_(), salt = Utilities.getUuid();
    const u = { id: 'u' + uid_(), username: un, fullName: name, title: str_(p.title, 100), role: role, deptId: deptId,
                status: 'active', isAdmin: p.isAdmin ? '1' : '', passHash: hash_(pw, salt), salt: salt, createdAt: now_(),
                approvedBy: me.id, note: '', reason: '', lastLogin: '', email: email };
    write_('Users', u);
    log_(me.id, 'addUser', un + ' · ' + role);
    return { user: adminUser_(u), password: pw };
  });
}

function saveConfig_(p, me) {
  return withLock_(function () {
    const parts = [];
    if (p.threshold !== undefined || p.capacity !== undefined) {
      const th = num_(p.threshold), cap = num_(p.capacity);
      if (!(th >= 0) || !(cap > 0)) fail_('Ngưỡng và dung tích không hợp lệ.');
      setCfg_('threshold', th); setCfg_('capacity', cap);
      parts.push('Ngưỡng ' + th + ' L · Dung tích ' + cap + ' L');
    }
    if (p.appUrl !== undefined) {
      const u = str_(p.appUrl, 200).replace(/\/+$/, '');
      if (u && !/^https?:\/\/[^\s"'<>]+$/.test(u)) fail_('Địa chỉ trang không hợp lệ (phải bắt đầu bằng https://).');
      setCfg_('appUrl', u); parts.push('Địa chỉ trang ' + u);
    }
    if (p.mailEnabled !== undefined) { setCfg_('mailEnabled', p.mailEnabled ? '1' : '0'); parts.push('Email ' + (p.mailEnabled ? 'bật' : 'tắt')); }
    log_(me.id, 'saveConfig', parts.join(' · '));
    dropPub_();
    return cfg_();
  });
}

function mailStatus_() {
  let quota = null;
  try { quota = MailApp.getRemainingDailyQuota(); } catch (e) { quota = null; }
  const users = rows_('Users').filter(function (u) { return u.status === 'active'; });
  const missing = users.filter(function (u) { return u.role !== 'user' && !EMAIL_RE.test(u.email || ''); })
                       .map(function (u) { return { id: u.id, fullName: u.fullName, role: u.role }; });
  return { quota: quota, missing: missing, cfg: cfg_() };
}

function sendTestMail_(p, me) {
  if (!EMAIL_RE.test(me.email || '')) fail_('Tài khoản của bạn chưa có email. Vào "Tài khoản" để thêm email.');
  const cfg = cfg_();
  MailApp.sendEmail({ to: me.email, subject: '[Nước cất] Email thử', name: 'Cấp phát nước cất · Trường Dược',
    htmlBody: '<div style="font-family:Arial,sans-serif;font-size:14px"><p>Email thử từ hệ thống Cấp phát nước cất đã gửi thành công.</p>' +
              (cfg.appUrl ? '<p>Địa chỉ trang: <a href="' + esc_(cfg.appUrl) + '">' + esc_(cfg.appUrl) + '</a></p>' : '<p><b>Chưa đặt địa chỉ trang</b>, email sẽ không có nút mở phiếu.</p>') + '</div>' });
  log_(me.id, 'mail', 'Email thử → ' + me.email);
  return { to: me.email };
}

function addDept_(p, me) {
  const name = str_(p.name, 100);
  if (!name) fail_('Nhập tên bộ môn.');
  return withLock_(function () {
    if (rows_('Departments').some(function (d) { return d.name.toLowerCase() === name.toLowerCase(); })) fail_('Bộ môn này đã có.', 'exists');
    const d = { id: 'd' + uid_(), name: name };
    write_('Departments', d);
    log_(me.id, 'addDept', name);
    dropPub_();
    return clean_(d);
  });
}

function renameDept_(p, me) {
  const name = str_(p.name, 100);
  if (!name) fail_('Nhập tên bộ môn.');
  return withLock_(function () {
    const d = rows_('Departments').find(function (x) { return x.id === p.id; });
    if (!d) fail_('Không tìm thấy bộ môn.', 'not_found');
    d.name = name;
    write_('Departments', d, d._row);
    log_(me.id, 'renameDept', name);
    dropPub_();
    return clean_(d);
  });
}

function deleteDept_(p, me) {
  return withLock_(function () {
    const d = rows_('Departments').find(function (x) { return x.id === p.id; });
    if (!d) fail_('Không tìm thấy bộ môn.', 'not_found');
    if (rows_('Users').some(function (u) { return u.deptId === d.id && u.status === 'active'; }))
      fail_('Còn người dùng thuộc bộ môn này. Chuyển họ sang bộ môn khác trước khi xóa.', 'conflict');
    sh_('Departments').deleteRow(d._row);
    log_(me.id, 'deleteDept', d.name);
    dropPub_();
    return { ok: true };
  });
}

function getLog_(p) {
  const all = rows_('Log');
  const n = Math.min(Math.max(Number(p.limit) || 200, 1), 1000);
  return all.slice(-n).reverse().map(clean_);
}

/* =========================== Cài đặt (chạy từ trình soạn thảo) =========================== */

/** Bước 1: tạo các trang tính và tài khoản admin. Chạy lại an toàn khi cập nhật phiên bản. */
function setup() {
  const ss = ss_();
  Object.keys(SCHEMA).forEach(function (name) {
    let s = ss.getSheetByName(name);
    if (!s) s = ss.insertSheet(name);
    const h = SCHEMA[name];
    if (s.getMaxColumns() < h.length) s.insertColumnsAfter(s.getMaxColumns(), h.length - s.getMaxColumns());
    s.getRange(1, 1, s.getMaxRows(), h.length).setNumberFormat('@');
    s.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold').setBackground('#dff0f6');
    s.setFrozenRows(1);
  });
  const cfg = rows_('Config');
  if (!cfg.some(function (r) { return r.key === 'threshold'; })) setCfg_('threshold', 100);
  if (!cfg.some(function (r) { return r.key === 'capacity'; })) setCfg_('capacity', 500);
  if (!cfg.some(function (r) { return r.key === 'mailEnabled'; })) setCfg_('mailEnabled', '1');
  if (!cfg.some(function (r) { return r.key === 'appUrl' && r.value; })) setCfg_('appUrl', DEFAULT_APP_URL);

  let ownerEmail = '';
  try { ownerEmail = Session.getEffectiveUser().getEmail() || ''; } catch (e) {}

  const users = rows_('Users');
  if (adminCount_(users) === 0) {
    const pw = randomPw_(), salt = Utilities.getUuid();
    const ex = users.find(function (u) { return u.username === 'admin'; });
    write_('Users', { id: ex ? ex.id : 'u' + uid_(), username: 'admin', fullName: 'Quản trị hệ thống', title: '', role: 'user',
                      deptId: '', status: 'active', isAdmin: '1', passHash: hash_(pw, salt), salt: salt, createdAt: now_(),
                      approvedBy: '', note: '', reason: '', lastLogin: '', email: ownerEmail }, ex && ex._row);
    log_('', 'setup', 'Tạo tài khoản admin');
    console.log('ĐÃ TẠO TÀI KHOẢN QUẢN TRỊ → tên đăng nhập: admin · mật khẩu: ' + pw + '  (đổi ngay sau khi đăng nhập)');
    return { username: 'admin', password: pw };
  }
  console.log('Cấu trúc trang tính đã sẵn sàng. Tài khoản quản trị đã tồn tại.');
  return { ok: true };
}

/** Bước 2: cấp quyền gửi email và kiểm tra hạn mức. Gửi một email thử tới chủ sở hữu script. */
function testMail() {
  const to = Session.getEffectiveUser().getEmail();
  MailApp.sendEmail({ to: to, subject: '[Nước cất] Kiểm tra gửi email', name: 'Cấp phát nước cất · Trường Dược',
                      htmlBody: '<p>Apps Script đã được cấp quyền gửi email.</p>' });
  console.log('Đã gửi email thử tới ' + to + '. Hạn mức còn lại hôm nay: ' + MailApp.getRemainingDailyQuota() + ' người nhận.');
}

/** Dùng khi quên mật khẩu admin: chạy từ trình soạn thảo, đọc mật khẩu mới trong nhật ký. */
function resetAdminPassword() {
  return withLock_(function () {
    const u = rows_('Users').find(function (x) { return x.username === 'admin'; });
    if (!u) return setup();
    const pw = randomPw_();
    u.salt = Utilities.getUuid(); u.passHash = hash_(pw, u.salt); u.status = 'active'; u.isAdmin = '1';
    write_('Users', u, u._row);
    log_('', 'resetAdminPassword', 'admin');
    console.log('Mật khẩu mới của admin: ' + pw);
    return { username: 'admin', password: pw };
  });
}
