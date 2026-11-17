import {createHash, createHmac, randomBytes, timingSafeEqual, hkdfSync, createCipheriv, createDecipheriv} from 'node:crypto';
import {hash as argonHash, verify as argonVerify} from '@node-rs/argon2';

export const ROLES = Object.freeze(['admin', 'producer', 'judge', 'entrant', 'fan', 'industry']);
const SESSION_DAYS = 14;

export const sha256 = v => createHash('sha256').update(v).digest('hex');
export const token = (n = 32) => randomBytes(n).toString('base64url');
export const safeEqual = (a, b) => {
 const x = Buffer.from(String(a)), y = Buffer.from(String(b));
 return x.length === y.length && timingSafeEqual(x, y);
};

export async function hashPassword(pw) { return argonHash(pw, {memoryCost: 19456, timeCost: 2, parallelism: 1}); }
export async function verifyPassword(hash, pw) { try { return await argonVerify(hash, pw); } catch { return false; } }
export function passwordProblem(pw) {
 if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters.';
 if (pw.length > 256) return 'Password is too long.';
 return null;
}
export const normEmail = e => String(e || '').trim().toLowerCase();
export const validEmail = e => /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[a-z]{2,}$/i.test(e) || e === 'admin';

/** Derives purpose-specific keys from one root secret (generated, stored only in the host env). */
export function keyring(rootSecret) {
 const root = rootSecret && rootSecret.length >= 32 ? rootSecret : token(48);
 const derive = info => Buffer.from(hkdfSync('sha256', Buffer.from(root), Buffer.alloc(0), Buffer.from(info), 32));
 const csrfKey = derive('mms-csrf'), ipKey = derive('mms-ip'), mediaKey = derive('mms-media-v1');
 return {
  ephemeral: !(rootSecret && rootSecret.length >= 32),
  csrfFor: seed => createHmac('sha256', csrfKey).update(String(seed)).digest('base64url'),
  ipHash: ip => createHmac('sha256', ipKey).update(String(ip || 'unknown')).digest('hex').slice(0, 32),
  encrypt(bytes, aad) {
   const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', mediaKey, iv);
   c.setAAD(Buffer.from(aad));
   const ciphertext = Buffer.concat([c.update(bytes), c.final()]);
   return {iv, tag: c.getAuthTag(), ciphertext};
  },
  decrypt({iv, tag, ciphertext}, aad) {
   const d = createDecipheriv('aes-256-gcm', mediaKey, iv);
   d.setAAD(Buffer.from(aad)); d.setAuthTag(tag);
   return Buffer.concat([d.update(ciphertext), d.final()]);
  },
 };
}

export function createSessions(pool) {
 return {
  async create(userId) {
   const raw = token(32), csrf = token(24);
   await pool.query(`INSERT INTO sessions(id,user_id,csrf,expires_at) VALUES ($1,$2,$3, now() + interval '${SESSION_DAYS} days')`, [sha256(raw), userId, csrf]);
   await pool.query('DELETE FROM sessions WHERE expires_at < now()');
   return raw;
  },
  async load(raw) {
   if (typeof raw !== 'string' || raw.length < 20 || raw.length > 100) return null;
   const {rows} = await pool.query(`SELECT s.id, s.csrf, u.id AS user_id, u.email, u.display_name, u.created_at, u.bootstrap,
      COALESCE(array_agg(r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles
     FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN user_roles r ON r.user_id = u.id
     WHERE s.id = $1 AND s.expires_at > now() AND NOT u.disabled GROUP BY s.id, u.id`, [sha256(raw)]);
   if (!rows[0]) return null;
   const r = rows[0];
   return {sessionId: r.id, csrf: r.csrf, user: {id: Number(r.user_id), email: r.email, name: r.display_name, createdAt: r.created_at, bootstrap: r.bootstrap, roles: new Set(r.roles)}};
  },
  async destroy(raw) { if (raw) await pool.query('DELETE FROM sessions WHERE id=$1', [sha256(raw)]); },
  async destroyAllFor(userId) { await pool.query('DELETE FROM sessions WHERE user_id=$1', [userId]); },
 };
}

/** Fixed-window in-memory limiter (single instance). Returns true when the call is allowed. */
export function createRateLimiter() {
 const hits = new Map();
 let sweep = Date.now();
 return function allow(key, limit, windowMs) {
  const now = Date.now();
  if (now - sweep > 60000) { for (const [k, v] of hits) if (v.reset < now) hits.delete(k); sweep = now; }
  const cur = hits.get(key);
  if (!cur || cur.reset < now) { hits.set(key, {count: 1, reset: now + windowMs}); return true; }
  cur.count += 1;
  return cur.count <= limit;
 };
}

export function clientIp(req, trustProxy) {
 if (trustProxy) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (xff) return xff;
 }
 return req.socket?.remoteAddress || 'unknown';
}
