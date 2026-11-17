import {HttpError, int, text} from '../http.mjs';
import {html, field, select, csrfField, postButton, table} from '../views/layout.mjs';
import {embed} from '../views/event.mjs';
import {REPRESENTATION, UNION} from './applications.mjs';
import {audit, notify} from '../db.mjs';

/** Discoverable profile: latest non-closed application per performer that opted in. Never exposes email, legal data or notes. */
const DISCOVERABLE = `a.consent_discovery AND a.status NOT IN ('withdrawn','declined') AND a.id = (SELECT max(id) FROM applications x WHERE x.user_id=a.user_id AND x.consent_discovery AND x.status NOT IN ('withdrawn','declined'))`;
const PUBLIC_COLS = 'a.id, a.stage_name, a.pronouns, a.city, a.bio, a.representation, a.union_status, a.reel_url, a.consent_contact, a.consent_generation';

/** MMS-06 industry discovery: verification requests, search of opted-in profiles, saved performers, contact permissions. */
export function industryRoutes(r, app) {
 const {db, settings} = app;
 const requireIndustry = async ctx => {
  ctx.require('industry');
  const s = await settings.all();
  if (!s.discovery_enabled) throw new HttpError(409, 'Industry discovery is switched off by the organizers');
 };

 r.get('/industry', async ctx => {
  ctx.require();
  const profile = await db.one('SELECT * FROM industry_profiles WHERE user_id=$1', [ctx.user.id]);
  if (!ctx.user.roles.has('industry')) {
   return ctx.page('Industry', html`<section class="mms-hero"><p class="mms-eyebrow">Industry</p><h1>Discover consented performer profiles</h1><p>Casting directors, agents and producers can request verification. Verified members only see performers who opted in.</p></section>
    ${profile ? html`<section class="mms-card"><h2>Verification ${profile.status}</h2><p>${profile.status === 'pending' ? 'An organizer will review your request.' : 'Your request was not approved. Contact the organizers if you think this is wrong.'}</p></section>`
     : html`<form method="post" action="/industry/verify" class="mms-card">${csrfField(ctx.csrf)}<h2>Request verification</h2>${field('Company', 'company', {required: true, attrs: 'maxlength="120"'})}${field('Your title', 'title', {required: true, attrs: 'maxlength="120"'})}${field('Company website (https)', 'website', {type: 'url'})}<button type="submit">Request verification</button></form>`}`);
  }
  await requireIndustry(ctx);
  const q = text(ctx.query.get('q'), {max: 80}), union = ctx.query.get('union') || '', rep = ctx.query.get('rep') || '', city = text(ctx.query.get('city'), {max: 80});
  const cond = [DISCOVERABLE], p = [];
  if (q) { p.push('%' + q.replace(/[%_\\]/g, m => '\\' + m) + '%'); cond.push(`(a.stage_name ILIKE $${p.length} OR a.bio ILIKE $${p.length})`); }
  if (UNION.some(u => u[0] === union)) { p.push(union); cond.push(`a.union_status=$${p.length}`); }
  if (REPRESENTATION.some(u => u[0] === rep)) { p.push(rep); cond.push(`a.representation=$${p.length}`); }
  if (city) { p.push('%' + city.replace(/[%_\\]/g, m => '\\' + m) + '%'); cond.push(`a.city ILIKE $${p.length}`); }
  p.push(ctx.user.id);
  const rows = await db.all(`SELECT ${PUBLIC_COLS}, (s.application_id IS NOT NULL) AS saved FROM applications a LEFT JOIN saved_actors s ON s.application_id=a.id AND s.industry_user_id=$${p.length} WHERE ${cond.join(' AND ')} ORDER BY a.stage_name LIMIT 100`, p);
  ctx.page('Industry discovery', html`<section class="mms-hero"><p class="mms-eyebrow">Industry</p><h1>Performer discovery</h1><p>Only performers who opted in appear here. Email addresses are shared only when a performer approves your contact request.</p><p><a href="/industry/saved">Saved performers</a></p></section>
   <form method="get" action="/industry" class="mms-card mms-row">${field('Search', 'q', {value: q})}${field('City', 'city', {value: city})}${select('Union', 'union', [['', 'Any'], ...UNION], union)}${select('Representation', 'rep', [['', 'Any'], ...REPRESENTATION], rep)}<button type="submit">Search</button></form>
   ${table(['Performer', 'City', 'Union', 'Representation', ''], rows.map(a => [html`<a href="/industry/performers/${a.id}">${a.stage_name}</a>`, a.city, a.union_status, a.representation,
    a.saved ? 'Saved' : postButton('/industry/performers/' + a.id + '/save', 'Save', ctx.csrf)]), {empty: 'No consented profiles match.'})}`);
 });

 r.post('/industry/verify', async ctx => {
  ctx.require();
  const website = text(ctx.form.website, {max: 200});
  if (website && !/^https:\/\/[^\s<>"]+$/.test(website)) throw new HttpError(400, 'Website must be an https link');
  await db.query(`INSERT INTO industry_profiles(user_id,company,title,website) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id) DO UPDATE SET company=EXCLUDED.company, title=EXCLUDED.title, website=EXCLUDED.website, status='pending'`,
   [ctx.user.id, text(ctx.form.company, {min: 2, max: 120, name: 'Company'}), text(ctx.form.title, {min: 2, max: 120, name: 'Title'}), website]);
  await audit(db, ctx.user.id, 'industry.requested', {});
  ctx.redirect('/industry', 'Verification requested.');
 });

 const profile = async (ctx) => {
  await requireIndustry(ctx);
  const a = await db.one(`SELECT ${PUBLIC_COLS}, a.user_id FROM applications a WHERE a.id=$1 AND ${DISCOVERABLE}`, [int(ctx.params.id, {min: 1})]);
  if (!a) throw new HttpError(404, 'Profile not available');
  return a;
 };
 r.get('/industry/performers/:id', async ctx => {
  const a = await profile(ctx);
  const media = await db.all('SELECT id, kind FROM media WHERE application_id=$1', [a.id]);
  const saved = await db.one('SELECT 1 FROM saved_actors WHERE industry_user_id=$1 AND application_id=$2', [ctx.user.id, a.id]);
  const req = await db.one('SELECT * FROM contact_requests WHERE industry_user_id=$1 AND application_id=$2 AND generation=$3', [ctx.user.id, a.id, a.consent_generation]);
  const email = req?.status === 'approved' && a.consent_contact ? (await db.one('SELECT email FROM users WHERE id=$1', [a.user_id]))?.email : null;
  const headshot = media.find(m => m.kind === 'headshot'), resume = media.find(m => m.kind === 'resume');
  ctx.page(a.stage_name, html`<section class="mms-hero"><p class="mms-eyebrow">Performer</p><h1>${a.stage_name}</h1><p>${a.pronouns} · ${a.city} · ${a.union_status} · ${a.representation}</p></section>
   <section class="mms-card mms-stack">${headshot ? html`<img src="/media/${headshot.id}" alt="Headshot of ${a.stage_name}" width="240">` : ''}<p>${a.bio}</p>${embed(a.reel_url, 'Reel of ' + a.stage_name)}${resume ? html`<p><a href="/media/${resume.id}">Résumé (PDF)</a></p>` : ''}
    <p>${saved ? postButton('/industry/performers/' + a.id + '/unsave', 'Remove from saved', ctx.csrf, {cls: 'secondary'}) : postButton('/industry/performers/' + a.id + '/save', 'Save performer', ctx.csrf)}</p></section>
   <section class="mms-card"><h2>Contact</h2>${email ? html`<p>Approved. Email: <a href="mailto:${email}">${email}</a></p>` : req ? html`<p>Your request is ${req.status}.</p>`
    : a.consent_contact ? html`<form method="post" action="/industry/performers/${a.id}/contact">${csrfField(ctx.csrf)}<label class="mms-field"><span>Message *</span><textarea name="message" required maxlength="600"></textarea></label><button type="submit">Request contact</button></form>`
    : html`<p class="mms-muted">This performer does not accept contact requests.</p>`}</section>`);
 });
 r.post('/industry/performers/:id/save', async ctx => {
  const a = await profile(ctx);
  await db.query('INSERT INTO saved_actors(industry_user_id,application_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [ctx.user.id, a.id]);
  ctx.redirect('/industry/performers/' + a.id, 'Saved.');
 });
 r.post('/industry/performers/:id/unsave', async ctx => {
  ctx.require('industry');
  await db.query('DELETE FROM saved_actors WHERE industry_user_id=$1 AND application_id=$2', [ctx.user.id, int(ctx.params.id, {min: 1})]);
  ctx.redirect('/industry/saved', 'Removed.');
 });
 r.post('/industry/performers/:id/contact', async ctx => {
  const a = await profile(ctx);
  if (!a.consent_contact) throw new HttpError(409, 'This performer does not accept contact requests');
  if (!app.limiter('contact:' + ctx.user.id, 20, 24 * 3600000)) throw new HttpError(429, 'Daily contact request limit reached');
  try {
   await db.query('INSERT INTO contact_requests(industry_user_id,application_id,generation,message) VALUES ($1,$2,$3,$4)', [ctx.user.id, a.id, a.consent_generation, text(ctx.form.message, {min: 5, max: 600, name: 'Message'})]);
  } catch (e) { if (e.code === '23505') throw new HttpError(409, 'You already sent a request'); throw e; }
  await notify(db, a.user_id, 'An industry member sent you a contact request. Review it in your account.');
  await audit(db, ctx.user.id, 'contact.requested', {applicationId: Number(a.id)});
  ctx.redirect('/industry/performers/' + a.id, 'Request sent. The performer decides whether to share their email.');
 });
 r.get('/industry/saved', async ctx => {
  await requireIndustry(ctx);
  const rows = await db.all(`SELECT ${PUBLIC_COLS} FROM saved_actors s JOIN applications a ON a.id=s.application_id WHERE s.industry_user_id=$1 AND ${DISCOVERABLE} ORDER BY a.stage_name`, [ctx.user.id]);
  ctx.page('Saved performers', html`<section class="mms-hero"><h1>Saved performers</h1><p>Performers who withdraw consent disappear from this list automatically.</p></section>
   ${table(['Performer', 'City', ''], rows.map(a => [html`<a href="/industry/performers/${a.id}">${a.stage_name}</a>`, a.city, postButton('/industry/performers/' + a.id + '/unsave', 'Remove', ctx.csrf, {cls: 'secondary'})]), {empty: 'No saved performers.'})}`);
 });
}
