import {readFileSync} from 'node:fs';
import {HttpError, createRouter, parseCookies, cookie, readBody, parseUrlencoded, parseMultipart} from './http.mjs';
import {createSessions, createRateLimiter, clientIp, safeEqual, keyring, token} from './security.mjs';
import {createSettings} from './settings.mjs';
import {layout} from './views/layout.mjs';
import {FRAME_SOURCES} from './media.mjs';
import {syntheticArchiveResponse} from '../demo/synthetic-archive.mjs';
import {publicRoutes} from './routes/public.mjs';
import {accountRoutes} from './routes/account.mjs';
import {applicationRoutes} from './routes/applications.mjs';
import {industryRoutes} from './routes/industry.mjs';
import {judgeRoutes} from './routes/judge.mjs';
import {adminRoutes} from './routes/admin.mjs';

const CSS = readFileSync(new URL('../design/mms.css', import.meta.url), 'utf8');
const JS = readFileSync(new URL('../design/app.js', import.meta.url), 'utf8');
const BASE_HEADERS = {
 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY',
 'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};
const CSP = `default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; frame-src ${FRAME_SOURCES}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

/** Builds the MMS request listener around a Postgres-backed db, an engine adapter and config. */
export function createWebApp({db, engine, config}) {
 const settings = createSettings(db);
 const sessions = createSessions(db.pool);
 const keys = keyring(config.secret);
 const limiter = createRateLimiter();
 const secure = Boolean(config.origin && config.origin.startsWith('https://'));
 const SID = secure ? '__Host-mms_sid' : 'mms_sid', ANON = secure ? '__Host-mms_anon' : 'mms_anon', FLASH = 'mms_flash';
 const router = createRouter();
 const app = {db, engine, settings, sessions, keys, limiter, config, secure, SID};
 for (const mount of [publicRoutes, accountRoutes, applicationRoutes, industryRoutes, judgeRoutes, adminRoutes]) mount(router, app);

 return async function listener(req, res) {
  const setCookies = [];
  const headers = {...BASE_HEADERS};
  if (secure) headers['strict-transport-security'] = 'max-age=31536000';
  const send = (status, type, body, extra = {}) => {
   if (res.headersSent) return;
   res.writeHead(status, {...headers, 'content-type': type, 'cache-control': 'no-store', ...(setCookies.length ? {'set-cookie': setCookies} : {}), ...extra});
   res.end(req.method === 'HEAD' ? '' : body);
  };
  let url;
  try { url = new URL(req.url || '/', 'http://localhost'); } catch { return send(400, 'text/plain; charset=utf-8', 'Bad request'); }
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/$/, '') : url.pathname;
  if ((req.url || '').startsWith('//')) return send(400, 'text/plain; charset=utf-8', 'Bad request');

  // Static assets and synthetic demo (MMS-07 preview)
  if (path === '/mms.css') return send(200, 'text/css; charset=utf-8', CSS, {'cache-control': 'public, max-age=300'});
  if (path === '/app.js') return send(200, 'text/javascript; charset=utf-8', JS, {'cache-control': 'public, max-age=300'});
  const demo = syntheticArchiveResponse(path);
  if (demo) {
   if (!['GET', 'HEAD'].includes(req.method)) return send(405, 'text/plain; charset=utf-8', 'Method not allowed');
   return send(demo.status, demo.type, demo.body, {'content-security-policy': "default-src 'none'; style-src 'self'; frame-ancestors 'none'"});
  }
  if (path.startsWith('/api/') && config.api) return config.api(req, res);
  if (path === '/health') {
   if (!['GET', 'HEAD'].includes(req.method)) return send(405, 'text/plain; charset=utf-8', 'Method not allowed');
   let database = 'ok', s = {applications_open: false}, eng = {connected: false, kind: engine.kind};
   try { await db.query('SELECT 1'); s = await settings.all(); eng = await engine.health(); } catch { database = 'unavailable'; }
   return send(200, 'application/json', JSON.stringify({status: 'ok', service: 'mms', persistence: 'postgres', database, applicationsOpen: Boolean(s.applications_open), engine: eng.kind, engineConnected: Boolean(eng.connected), accounts: 'email-password', productionReady: false}));
  }

  const cookies = parseCookies(req.headers.cookie);
  const ctx = {req, res, url, path, query: url.searchParams, form: {}, files: {}, app, cookies};
  ctx.ip = clientIp(req, config.trustProxy);
  ctx.ipHash = keys.ipHash(ctx.ip);
  try {
   const s = cookies[SID] ? await sessions.load(cookies[SID]) : null;
   ctx.session = s; ctx.user = s?.user || null;
  } catch { return send(503, 'text/plain; charset=utf-8', 'Service unavailable'); }
  let anon = cookies[ANON];
  if (!ctx.session && !(typeof anon === 'string' && /^[\w-]{20,64}$/.test(anon))) { anon = token(18); setCookies.push(cookie(ANON, anon, {secure, maxAge: 60 * 60 * 24 * 30})); }
  ctx.csrf = keys.csrfFor(ctx.session ? ctx.session.csrf : anon);
  if (cookies[FLASH]) { try { ctx.flash = JSON.parse(cookies[FLASH]); } catch { /* ignore */ } setCookies.push(cookie(FLASH, '', {secure, maxAge: 0})); }

  ctx.setCookie = c => setCookies.push(c);
  ctx.html = (status, title, body, opts = {}) => send(status, 'text/html; charset=utf-8', layout({title, body, user: ctx.user, csrf: ctx.csrf, flash: opts.flash ?? ctx.flash, path, notice: opts.notice}), {'content-security-policy': CSP});
  ctx.page = (title, body, opts) => ctx.html(200, title, body, opts);
  ctx.redirect = (location, flash) => {
   if (flash) setCookies.push(cookie(FLASH, JSON.stringify(typeof flash === 'string' ? {text: flash} : flash), {secure, maxAge: 60}));
   send(303, 'text/plain; charset=utf-8', 'See ' + location, {location});
  };
  ctx.send = send;
  ctx.require = (...roles) => {
   if (!ctx.user) throw new HttpError(401, 'Sign in required');
   if (roles.length && !roles.some(r => ctx.user.roles.has(r))) throw new HttpError(403, 'You do not have access to this page');
  };

  try {
   const m = router.match(req.method, path);
   if (!m) throw new HttpError(404, 'Page not found');
   if (m.methodNotAllowed) throw new HttpError(405, 'Method not allowed');
   ctx.params = m.params;
   if (req.method === 'POST') {
    if (!limiter('post:' + ctx.ip, 240, 60000)) throw new HttpError(429, 'Too many requests; wait a minute');
    const origin = req.headers.origin;
    if (origin && config.origin && origin !== config.origin) throw Object.assign(new HttpError(403, 'Cross-site request rejected'), {hard: true});
    const type = String(req.headers['content-type'] || '');
    if (m.route.opts.multipart && type.startsWith('multipart/form-data')) {
     const s = await settings.all();
     const body = await readBody(req, (s.upload_max_kb * 2 + 256) * 1024);
     const parsed = parseMultipart(body, type);
     ctx.form = parsed.fields; ctx.files = parsed.files;
    } else if (type.startsWith('application/x-www-form-urlencoded')) {
     ctx.form = parseUrlencoded(await readBody(req, 64 * 1024));
    } else throw new HttpError(415, 'Unsupported form encoding');
    if (typeof ctx.form._csrf !== 'string' || !safeEqual(ctx.form._csrf, ctx.csrf)) throw Object.assign(new HttpError(403, 'Your form expired; reload the page and try again'), {hard: true});
   }
   await m.route.handler(ctx);
   if (!res.headersSent) send(204, 'text/plain', '');
  } catch (e) {
   if (res.headersSent) return;
   const status = e instanceof HttpError ? e.status : 500;
   if (status === 500) console.error(JSON.stringify({msg: 'request failed', path, error: String(e?.stack || e)}));
   if (status === 401 && req.method === 'GET') return ctx.redirect('/login?next=' + encodeURIComponent(path + url.search));
   const back = req.method === 'POST' && status < 500 && !e.hard ? safeBack(req, config.origin) : null;
   if (back) return ctx.redirect(back, {kind: 'error', text: e.message});
   const title = {400: 'Check your input', 401: 'Sign in required', 403: 'Not allowed', 404: 'Not found', 405: 'Method not allowed', 409: 'Not possible right now', 413: 'Too large', 415: 'Unsupported', 429: 'Slow down'}[status] || 'Something went wrong';
   const msg = status === 500 ? 'An unexpected error occurred. Please try again.' : e.message;
   ctx.html(status, title, {__html: `<h1>${title}</h1><p>${msg.replace(/[&<>"']/g, '')}</p><p><a href="/">Return home</a></p>`}, {flash: null});
  }
 };
}

/** Redirect target for POST errors: same-origin referer path only. */
function safeBack(req, origin) {
 const ref = req.headers.referer;
 if (!ref) return null;
 try {
  const u = new URL(ref);
  if (origin && u.origin !== origin) return null;
  if (!origin && u.host !== req.headers.host) return null;
  return u.pathname + u.search;
 } catch { return null; }
}
