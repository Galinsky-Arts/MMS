/** Minimal HTTP toolkit: escaping, cookies, body parsing (urlencoded + multipart), router. */
export class HttpError extends Error {
 constructor(status, message) { super(message); this.status = status; }
}
export const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const raw = s => ({__html: String(s)});

export function parseCookies(header) {
 const out = {};
 for (const part of String(header || '').split(';')) {
  const i = part.indexOf('=');
  if (i < 1) continue;
  const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
  if (!(k in out)) { try { out[k] = decodeURIComponent(v); } catch { /* ignore malformed */ } }
 }
 return out;
}
export function cookie(name, value, {secure, maxAge, httpOnly = true} = {}) {
 return `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax${httpOnly ? '; HttpOnly' : ''}${secure ? '; Secure' : ''}${maxAge !== undefined ? '; Max-Age=' + maxAge : ''}`;
}

export async function readBody(req, limit) {
 const declared = Number(req.headers['content-length'] || 0);
 if (declared > limit) throw new HttpError(413, 'Request too large');
 const chunks = []; let size = 0;
 for await (const chunk of req) {
  size += chunk.length;
  if (size > limit) throw new HttpError(413, 'Request too large');
  chunks.push(chunk);
 }
 return Buffer.concat(chunks);
}

export function parseUrlencoded(buf) {
 const params = new URLSearchParams(buf.toString('utf8'));
 const out = {};
 for (const [k, v] of params) { if (k in out) out[k] = [].concat(out[k], v); else out[k] = v; }
 return out;
}

/** Parses multipart/form-data into {fields, files}. Files: {name, filename, type, data}. */
export function parseMultipart(buf, contentType) {
 const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
 if (!m) throw new HttpError(400, 'Bad multipart body');
 const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
 const fields = {}, files = {};
 let pos = buf.indexOf(boundary);
 if (pos < 0) throw new HttpError(400, 'Bad multipart body');
 let parts = 0;
 while (true) {
  pos += boundary.length;
  if (buf.slice(pos, pos + 2).toString() === '--') break;
  pos += 2; // CRLF
  const headerEnd = buf.indexOf('\r\n\r\n', pos);
  if (headerEnd < 0) throw new HttpError(400, 'Bad multipart body');
  const headers = buf.slice(pos, headerEnd).toString('utf8');
  const next = buf.indexOf(boundary, headerEnd + 4);
  if (next < 0) throw new HttpError(400, 'Bad multipart body');
  const data = buf.slice(headerEnd + 4, next - 2);
  if (++parts > 50) throw new HttpError(400, 'Too many parts');
  const disp = /content-disposition:\s*form-data;([^\r\n]*)/i.exec(headers);
  if (!disp) throw new HttpError(400, 'Bad multipart part');
  const name = /\bname="([^"]*)"/.exec(disp[1])?.[1];
  const filename = /\bfilename="([^"]*)"/.exec(disp[1])?.[1];
  const type = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim() || 'application/octet-stream';
  if (name !== undefined) {
   if (filename !== undefined) { if (data.length) files[name] = {name, filename, type, data}; }
   else fields[name] = data.toString('utf8');
  }
  pos = next;
 }
 return {fields, files};
}

export function createRouter() {
 const routes = [];
 const add = (method, pattern, handler, opts = {}) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([A-Za-z0-9_-]{1,128})'; }) + '$');
  routes.push({method, re, keys, handler, opts});
 };
 return {
  get: (p, h, o) => add('GET', p, h, o),
  post: (p, h, o) => add('POST', p, h, o),
  match(method, path) {
   let allowed = false;
   for (const r of routes) {
    const m = r.re.exec(path);
    if (!m) continue;
    if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) { allowed = true; continue; }
    const params = {}; r.keys.forEach((k, i) => { params[k] = m[i + 1]; });
    return {route: r, params};
   }
   return allowed ? {methodNotAllowed: true} : null;
  },
 };
}

export const int = (v, {min = -Infinity, max = Infinity, def} = {}) => {
 const n = Number.parseInt(String(v ?? ''), 10);
 if (!Number.isSafeInteger(n) || n < min || n > max) { if (def !== undefined) return def; throw new HttpError(400, 'Invalid number'); }
 return n;
};
export const text = (v, {max = 200, min = 0, name = 'field'} = {}) => {
 const s = String(v ?? '').replace(/\r\n/g, '\n').trim();
 if (s.length < min) throw new HttpError(400, `${name} is required`);
 if (s.length > max) throw new HttpError(400, `${name} is too long`);
 if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)) throw new HttpError(400, `${name} has invalid characters`);
 return s;
};
export const checkbox = v => v === 'on' || v === '1' || v === 'true' || v === 'yes';
export const oneOf = (v, list, name = 'value') => { if (!list.includes(v)) throw new HttpError(400, `Invalid ${name}`); return v; };
