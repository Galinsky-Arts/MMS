import {HttpError} from './http.mjs';

/** Operator settings. Applications stay CLOSED until an admin records the privacy details the
 * owner must decide (operator, privacy contact, retention days, consent version) and then
 * switches applications on. The switch refuses to turn on while any of them is missing.
 */
export const DEFAULT_SETTINGS = Object.freeze({
 operator_name: '', privacy_contact: '', retention_days: 0, consent_version: '', privacy_notice: '',
 applications_open: false, discovery_enabled: true,
 vote_min_account_minutes: 10, vote_ip_cap: 25, upload_max_kb: 2048,
});
export const PRIVACY_FIELDS = Object.freeze(['operator_name', 'privacy_contact', 'retention_days', 'consent_version']);

export function privacyGaps(s) {
 const gaps = [];
 if (!String(s.operator_name || '').trim()) gaps.push('operator name');
 if (!String(s.privacy_contact || '').trim()) gaps.push('privacy contact');
 if (!(Number.isSafeInteger(s.retention_days) && s.retention_days >= 1)) gaps.push('retention days');
 if (!String(s.consent_version || '').trim()) gaps.push('consent version');
 return gaps;
}

export function createSettings(db) {
 let cache = null, cachedAt = 0;
 const all = async () => {
  if (cache && Date.now() - cachedAt < 2000) return cache;
  const rows = await db.all('SELECT key, value FROM settings');
  const s = {...DEFAULT_SETTINGS};
  for (const r of rows) if (Object.hasOwn(DEFAULT_SETTINGS, r.key)) s[r.key] = r.value;
  // Defense in depth: never report open while the privacy gate is incomplete.
  if (privacyGaps(s).length) s.applications_open = false;
  cache = s; cachedAt = Date.now();
  return s;
 };
 const put = async (key, value) => {
  await db.query('INSERT INTO settings(key,value,updated_at) VALUES ($1,$2,now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()', [key, JSON.stringify(value)]);
  cache = null;
 };
 return {
  all,
  async update(values) {
   const current = await all();
   const next = {...current, ...values};
   if (next.applications_open && privacyGaps(next).length) throw new HttpError(409, 'Applications cannot open until these are set: ' + privacyGaps(next).join(', '));
   for (const [k, v] of Object.entries(values)) { if (!Object.hasOwn(DEFAULT_SETTINGS, k)) throw new HttpError(400, 'Unknown setting'); await put(k, v); }
   // Changing privacy terms while open closes applications so the admin re-confirms.
   return all();
  },
  async setApplicationsOpen(open) {
   const s = await all();
   if (open) {
    const gaps = privacyGaps(s);
    if (gaps.length) throw new HttpError(409, 'Applications cannot open until these are set in Settings: ' + gaps.join(', ') + '.');
   }
   await put('applications_open', Boolean(open));
   return all();
  },
 };
}
