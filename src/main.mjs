import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {createOperatorAuthenticator} from './auth.mjs';
import {createDraftSettingsListener} from '../http/draft-settings-server.mjs';
import {createDraftSettingsService} from '../domain/draft-settings.mjs';
import {migrate} from '../app/schema.mjs';
import {withDb} from '../app/db.mjs';
import {selectEngine} from '../app/engine/adapter.mjs';
import {createWebApp} from '../app/server.mjs';
import {hashPassword, verifyPassword, createSessions} from '../app/security.mjs';
import {parseCookies} from '../app/http.mjs';
import {createSettings} from '../app/settings.mjs';
import {purgeExpired} from '../app/retention.mjs';
import {renderDraftSettingsEditor} from '../views/draft-settings.mjs';

/** MMS composition: Postgres + built-in competition engine (behind the adapter) + accounts.
 * The legacy operator bearer token (MMS_ADMIN_TOKEN) keeps working for the draft-settings API and
 * doubles as the bootstrap admin password (sign in with email "admin").
 */
export function canonicalOrigin(value) {
 if (!value) return null;
 try { const u = new URL(value); return (u.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(u.hostname)) && !u.username && !u.password && u.origin === value.replace(/\/$/, '') ? u.origin : null; } catch { return null; }
}

/** Creates/updates the bootstrap admin from the env token; disables it when the token is absent. */
export async function ensureBootstrapAdmin(db, adminToken) {
 const existing = await db.one(`SELECT * FROM users WHERE email='admin'`);
 if (typeof adminToken !== 'string' || adminToken.length < 32) {
  if (existing) await db.query('UPDATE users SET disabled=true WHERE id=$1', [existing.id]);
  return null;
 }
 let id = existing?.id;
 if (!existing) id = (await db.one(`INSERT INTO users(email,password_hash,display_name,bootstrap) VALUES ('admin',$1,'Bootstrap admin',true) RETURNING id`, [await hashPassword(adminToken)])).id;
 else if (!(await verifyPassword(existing.password_hash, adminToken)) || existing.disabled) await db.query('UPDATE users SET password_hash=$2, disabled=false, bootstrap=true WHERE id=$1', [id, await hashPassword(adminToken)]);
 for (const role of ['admin', 'producer']) await db.query('INSERT INTO user_roles(user_id,role) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, role]);
 return Number(id);
}

export async function createMmsApp({pool, adminToken, tenantId = 'mms', origin = null, secret, trustProxy = false, engineKind = 'builtin', engineOrigin = null, eventId = 'pilot-event'}) {
 await migrate(pool);
 const db = withDb(pool);
 await ensureBootstrapAdmin(db, adminToken);
 const engine = selectEngine({kind: engineKind, db, origin: engineOrigin});
 const {createPgDraftStore} = await import('../storage/pg-draft-store.mjs');
 const draftService = createDraftSettingsService(await createPgDraftStore(pool));
 const bearer = createOperatorAuthenticator({token: adminToken, tenantId});
 const sessions = createSessions(pool);
 const sessionPrincipal = async raw => {
  const s = raw ? await sessions.load(raw) : null;
  if (!s || !['admin', 'producer'].some(r => s.user.roles.has(r))) return null;
  return {verified: true, subject: 'user-' + s.user.id, tenantId, roles: new Set(['producer', 'member'])};
 };
 const sid = origin && origin.startsWith('https://') ? '__Host-mms_sid' : 'mms_sid';
 const authenticate = async req => {
  const p = await bearer(req);
  if (p) return p;
  const header = typeof req?.headers?.get === 'function' ? req.headers.get('cookie') : req?.headers?.cookie;
  return sessionPrincipal(parseCookies(header)[sid]);
 };
 const api = origin && origin.startsWith('https://') ? createDraftSettingsListener({origin, service: draftService, authenticate}) : null;
 const config = {origin, secret, trustProxy, tenantId, api, eventId, draftService, sessionPrincipal, renderDraftSettingsEditor};
 const listener = createWebApp({db, engine, config});
 const settings = createSettings(db);
 return {listener, db, engine, settings, purge: () => purgeExpired(db, settings)};
}

export async function createFromEnvironment(env = process.env) {
 const tenantId = env.MMS_TENANT_ID || 'mms';
 const origin = canonicalOrigin(env.MMS_PUBLIC_ORIGIN || env.RENDER_EXTERNAL_URL || '');
 if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
 const {default: pg} = await import('pg');
 const pool = new pg.Pool({connectionString: env.DATABASE_URL, max: 8, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000});
 pool.on('error', () => {});
 const secret = env.MMS_SECRET_KEY || env.MMS_ADMIN_TOKEN;
 const out = await createMmsApp({pool, adminToken: env.MMS_ADMIN_TOKEN, tenantId, origin, secret, trustProxy: Boolean(env.RENDER) || env.MMS_TRUST_PROXY === '1',
  engineKind: env.MMS_ENGINE || 'builtin', engineOrigin: env.MMS_ENGINE_ORIGIN || null});
 return {...out, close: () => pool.end(), origin, persistence: 'postgres', secretConfigured: Boolean(env.MMS_SECRET_KEY)};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 const app = await createFromEnvironment();
 const server = createServer((req, res) => { Promise.resolve(app.listener(req, res)).catch(() => { if (!res.headersSent) { res.writeHead(503, {'content-type': 'text/plain'}); res.end('Service unavailable'); } else res.destroy(); }); });
 server.headersTimeout = 10000; server.requestTimeout = 30000;
 const port = Number(process.env.PORT || 3000);
 const purge = () => app.purge().catch(e => console.error(JSON.stringify({msg: 'retention purge failed', error: String(e)})));
 purge(); setInterval(purge, 3600000).unref();
 server.listen(port, () => console.log(JSON.stringify({msg: 'mms listening', port, persistence: app.persistence, engine: app.engine.kind, apiEnabled: Boolean(app.origin), secretConfigured: app.secretConfigured})));
}
