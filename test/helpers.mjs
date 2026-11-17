import {createServer} from 'node:http';

export const DB_URL = process.env.TEST_DATABASE_URL;
export const ADMIN_TOKEN = 'bootstrap-token-'.padEnd(48, 'x');

export async function freshApp(t, extra = {}) {
 const {default: pg} = await import('pg');
 const pool = new pg.Pool({connectionString: DB_URL, max: 6});
 await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
 const {createMmsApp} = await import('../src/main.mjs');
 const app = await createMmsApp({pool, adminToken: ADMIN_TOKEN, secret: 's'.repeat(48), trustProxy: true, ...extra});
 const server = createServer(app.listener);
 await new Promise(ok => server.listen(0, '127.0.0.1', ok));
 t.after(async () => { await new Promise(ok => server.close(ok)); await pool.end(); });
 return {...app, pool, base: 'http://127.0.0.1:' + server.address().port};
}

/** Browser-like client: cookie jar, CSRF token scraping, manual redirects. */
export function client(base, ip = '127.0.0.1') {
 const jar = new Map();
 let csrf = null;
 const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
 const store = res => {
  for (const c of res.headers.getSetCookie()) {
   const [pair, ...attrs] = c.split(';');
   const i = pair.indexOf('=');
   const k = pair.slice(0, i), v = pair.slice(i + 1);
   if (attrs.some(a => /max-age=0/i.test(a.trim()))) jar.delete(k); else jar.set(k, v);
  }
 };
 const self = {
  jar,
  async get(path) {
   const res = await fetch(base + path, {headers: {cookie: cookieHeader(), 'x-forwarded-for': ip}, redirect: 'manual'});
   store(res);
   const body = await res.text();
   if (/\[object Object\]|>undefined<|NaN/.test(body)) throw new Error('Rendering defect on ' + path + ': ' + /.{0,80}(\[object Object\]|>undefined<|NaN).{0,80}/s.exec(body)[0]);
   const m = /name="_csrf" value="([^"]+)"/.exec(body);
   if (m) csrf = m[1];
   return {status: res.status, body, location: res.headers.get('location'), headers: res.headers};
  },
  async post(path, fields = {}, {multipart = false, files = {}, noCsrf = false, headers = {}} = {}) {
   if (!csrf) await self.get('/login');
   let body, type = {};
   const all = noCsrf ? fields : {_csrf: csrf, ...fields};
   if (multipart) {
    body = new FormData();
    for (const [k, v] of Object.entries(all)) body.append(k, v);
    for (const [k, f] of Object.entries(files)) body.append(k, new Blob([f.data], {type: f.type}), f.name);
   } else {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(all)) for (const x of [].concat(v)) p.append(k, x);
    body = p.toString(); type = {'content-type': 'application/x-www-form-urlencoded'};
   }
   jar.delete('mms_flash');
   const res = await fetch(base + path, {method: 'POST', body, headers: {cookie: cookieHeader(), referer: base + '/back', 'x-forwarded-for': ip, ...type, ...headers}, redirect: 'manual'});
   store(res);
   const text = await res.text();
   const flash = jar.get('mms_flash') ? JSON.parse(decodeURIComponent(jar.get('mms_flash'))) : null;
   return {status: res.status, body: text, location: res.headers.get('location'), flash};
  },
  async login(email, password) {
   await self.get('/login');
   const r = await self.post('/login', {email, password});
   await self.get('/account');
   return r;
  },
  async register(name, email, password = 'correct horse battery') {
   await self.get('/register');
   const r = await self.post('/register', {name, email, password});
   await self.get('/account');
   return r;
  },
 };
 return self;
}

export const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(64, 1)]);
export const PDF = Buffer.from('%PDF-1.4\n% test résumé\n');
