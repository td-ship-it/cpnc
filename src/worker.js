/**
 * Cấp phát nước cất — Cloudflare Worker
 *  - Phục vụ giao diện tĩnh trong thư mục public/ (Workers Static Assets).
 *  - /api        : chuyển tiếp yêu cầu tới Google Apps Script (APPS_SCRIPT_URL).
 *  - /api/health : kiểm tra Worker và kết nối tới Apps Script.
 *
 * Biến môi trường:
 *  APPS_SCRIPT_URL  (bắt buộc) URL ứng dụng web Apps Script, kết thúc bằng /exec.
 *                   Nên đặt dạng Secret: npx wrangler secret put APPS_SCRIPT_URL
 */

const MAX_BODY = 64 * 1024;          // 64 KB là quá đủ cho một thao tác
const UPSTREAM_TIMEOUT = 25000;      // Apps Script có thể khởi động chậm
const PUBLIC_CACHE_SECONDS = 30;     // trang công khai: lưu đệm ngắn ở biên Cloudflare

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Cache-Control': 'no-store'
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...extra }
  });
}
const fail = (error, code, status = 200) => json({ ok: false, error, code }, status);

function upstreamUrl(env) {
  const u = (env.APPS_SCRIPT_URL || '').trim();
  if (/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(u)) return u;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u)) return u;   // chạy thử cục bộ (wrangler dev)
  return null;
}

async function callAppsScript(env, payloadText) {
  const url = upstreamUrl(env);
  if (!url) return { error: fail('Máy chủ chưa được cấu hình: thiếu hoặc sai biến APPS_SCRIPT_URL trên Cloudflare (URL phải kết thúc bằng /exec).', 'config') };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT);
  try {
    // Apps Script trả 302 sang script.googleusercontent.com; fetch tự theo chuyển hướng.
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: payloadText,
      redirect: 'follow',
      signal: ctrl.signal
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); }
    catch {
      // Thường gặp khi web app chưa đặt "Bất kỳ ai" hoặc URL là bản /dev.
      return { error: fail('Apps Script không trả về dữ liệu hợp lệ (HTTP ' + res.status + '). Kiểm tra bản triển khai: Thực thi dưới dạng "Tôi", quyền truy cập "Bất kỳ ai".', 'upstream', 502) };
    }
    return { data };
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? 'Apps Script phản hồi quá lâu, vui lòng thử lại.' : 'Không kết nối được Apps Script, vui lòng thử lại.';
    return { error: fail(msg, 'upstream', 504) };
  } finally {
    clearTimeout(timer);
  }
}

async function handleApi(request, env, ctx) {
  const url = new URL(request.url);

  if (url.pathname === '/api/health') {
    const r = await callAppsScript(env, JSON.stringify({ action: 'publicStatus' }));
    return r.error ? r.error : json({ ok: true, worker: 'ok', appsScript: r.data && r.data.ok ? 'ok' : 'error' });
  }

  if (url.pathname !== '/api') return fail('Không tìm thấy.', 'not_found', 404);
  if (request.method !== 'POST') return fail('Chỉ chấp nhận POST.', 'bad_request', 405);

  // Chặn gọi API từ trang của tên miền khác.
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return fail('Nguồn gọi không hợp lệ.', 'forbidden', 403);

  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) return fail('Dữ liệu gửi lên quá lớn.', 'bad_request', 413);
  const text = await request.text();
  if (text.length > MAX_BODY) return fail('Dữ liệu gửi lên quá lớn.', 'bad_request', 413);

  let body;
  try { body = JSON.parse(text || '{}'); } catch { return fail('Dữ liệu không đúng định dạng.', 'bad_request', 400); }
  if (!body || typeof body.action !== 'string' || !/^[A-Za-z]{1,40}$/.test(body.action)) return fail('Thao tác không hợp lệ.', 'bad_request', 400);

  // Số liệu công khai: lưu đệm ngắn để giảm số lần gọi Apps Script.
  if (body.action === 'publicStatus') {
    const cache = caches.default;
    const key = new Request(url.origin + '/api/__public-status', { method: 'GET' });
    const hit = await cache.match(key);
    if (hit) return hit;
    const r = await callAppsScript(env, JSON.stringify({ action: 'publicStatus' }));
    if (r.error) return r.error;
    const res = json(r.data, 200, { 'Cache-Control': 'public, max-age=' + PUBLIC_CACHE_SECONDS });
    if (r.data && r.data.ok) ctx.waitUntil(cache.put(key, res.clone()));
    return res;
  }

  const forward = JSON.stringify({ action: body.action, payload: body.payload || {}, token: body.token || null });
  const r = await callAppsScript(env, forward);
  return r.error ? r.error : json(r.data);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      try { return await handleApi(request, env, ctx); }
      catch (e) { console.error(e); return fail('Lỗi máy chủ, vui lòng thử lại.', 'error', 500); }
    }
    // Mọi đường dẫn khác: tệp tĩnh (index.html, assets/...).
    return env.ASSETS.fetch(request);
  }
};
