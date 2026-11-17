import {HttpError, int, text, checkbox, oneOf} from '../http.mjs';
import {html, field, textarea, select, check, csrfField, postButton, fmtDate, isStaff} from '../views/layout.mjs';
import {mediaLink, validateUpload, storeUpload, loadUpload} from '../media.mjs';
import {privacyGaps} from '../settings.mjs';
import {audit, notify} from '../db.mjs';
import {embed} from '../views/event.mjs';

export const REPRESENTATION = [['none', 'Not represented'], ['agency', 'Agency'], ['manager', 'Manager'], ['self-represented', 'Self-represented']];
export const UNION = [['prefer-not-to-say', 'Prefer not to say'], ['union', 'Union member'], ['non-union', 'Non-union']];
export const APP_STATUS = ['submitted', 'under_review', 'shortlisted', 'accepted', 'declined', 'withdrawn'];

function consentText(s) {
 return html`<section class="mms-card mms-stack"><h2>Consent (version ${s.consent_version})</h2>
 <p>${s.operator_name} processes your application to run MMS auditions. Privacy contact: ${s.privacy_contact}. Declined or withdrawn applications and their uploads are deleted ${s.retention_days} days after the decision. Read the <a href="/privacy">privacy page</a>.</p>
 ${s.privacy_notice ? html`<details><summary>Full privacy notice</summary>${s.privacy_notice.split(/\n{2,}/).map(p => html`<p>${p}</p>`)}</details>` : ''}</section>`;
}

/** MMS-05 actor applications with media links/uploads, explicit consent capture and private review. */
export function applicationRoutes(r, app) {
 const {db, settings, keys, engine} = app;

 r.get('/apply', async ctx => {
  const s = await settings.all();
  const hero = html`<section class="mms-hero"><p class="mms-eyebrow">Apply</p><h1>Let your performance speak.</h1><p>Submit a timed monologue for an upcoming audition event. Your application is private to the producers reviewing it.</p></section>`;
  if (!s.applications_open) {
   const gaps = privacyGaps(s);
   return ctx.page('Apply', html`${hero}<section class="mms-card"><h2>Applications are not open</h2><p>Do not send headshots, résumés, reels or personal information by other means. Check back when the organizers open applications.</p>
    ${isStaff(ctx.user) ? html`<p class="mms-banner">Admin: applications are closed. ${gaps.length ? `Set ${gaps.join(', ')} in ` : 'Switch them on in '}<a href="/admin/settings">Settings</a>.</p>` : ''}</section>`);
  }
  if (!ctx.user) return ctx.page('Apply', html`${hero}<section class="mms-card"><h2>Applications are open</h2><p><a href="/login?next=/apply">Sign in</a> or <a href="/register">create an account</a> to apply.</p></section>`);
  const events = await engine.listEvents({statuses: ['draft', 'scheduled']});
  const kb = s.upload_max_kb;
  ctx.page('Apply', html`${hero}<form method="post" action="/apply" enctype="multipart/form-data" class="mms-stack">${csrfField(ctx.csrf)}
   <section class="mms-card"><h2>Performer</h2>${select('Audition event', 'event_id', [['', 'Any upcoming event'], ...events.map(e => [e.id, e.title])], '')}
   ${field('Stage name', 'stage_name', {required: true, value: ctx.user.name, attrs: 'maxlength="80"'})}${field('Pronouns', 'pronouns', {attrs: 'maxlength="40"'})}${field('City / region', 'city', {attrs: 'maxlength="80"'})}
   ${textarea('Short bio', 'bio', {hint: 'Up to 1,000 characters.'})}
   ${select('Representation', 'representation', REPRESENTATION, 'none')}${field('Agency or manager name', 'agency_name', {attrs: 'maxlength="120"'})}${select('Union status', 'union_status', UNION, 'prefer-not-to-say')}</section>
   <section class="mms-card"><h2>Monologue</h2>${field('Title', 'monologue_title', {required: true, attrs: 'maxlength="120"'})}${field('Source / playwright', 'monologue_source', {attrs: 'maxlength="160"'})}
   ${field('Running time (seconds)', 'monologue_seconds', {type: 'number', required: true, value: '90', attrs: 'min="10" max="600"'})}</section>
   <section class="mms-card"><h2>Media</h2>${field('Reel link', 'reel_url', {type: 'url', required: true, hint: 'YouTube, Vimeo or SoundCloud link (unlisted links work).'})}
   ${field('Headshot (optional upload)', 'headshot', {type: 'file', hint: `JPEG, PNG or WebP up to ${kb} KB. Stored encrypted and visible only to producers${s.discovery_enabled ? ' and, if you opt in below, verified industry members' : ''}.`, attrs: 'accept="image/jpeg,image/png,image/webp"'})}
   ${field('Résumé (optional upload)', 'resume', {type: 'file', hint: `PDF up to ${kb} KB.`, attrs: 'accept="application/pdf"'})}</section>
   ${consentText(s)}
   <section class="mms-card"><h2>Your choices</h2>
   ${check('I consent to producers processing this application for MMS auditions (required).', 'consent_review', false, {required: true})}
   ${s.discovery_enabled ? check('List my profile (stage name, city, union status, representation type, bio, headshot, résumé and reel) for verified industry members.', 'consent_discovery', false, {hint: 'Optional. You can withdraw this at any time.'}) : ''}
   ${s.discovery_enabled ? check('Allow verified industry members to send me contact requests. My email is shared only if I approve a request.', 'consent_contact', false, {hint: 'Optional.'}) : ''}
   ${check('If I perform, MMS may publish my recording, captions and results on the public archive.', 'consent_publication', false, {hint: 'Optional. Without this, results show your stage name only.'})}
   </section><button type="submit">Submit application</button></form>`);
 }, {multipart: true});

 r.post('/apply', async ctx => {
  ctx.require();
  const s = await settings.all();
  if (!s.applications_open) throw new HttpError(409, 'Applications are not open');
  if (!app.limiter('apply:' + ctx.user.id, 10, 60 * 60000)) throw new HttpError(429, 'Too many submissions; try later');
  const f = ctx.form;
  if (!checkbox(f.consent_review)) throw new HttpError(400, 'The review consent is required to apply');
  let eventId = null;
  if (f.event_id) { eventId = int(f.event_id, {min: 1}); const e = await engine.event(eventId); if (!['draft', 'scheduled'].includes(e.status)) throw new HttpError(400, 'That event is not accepting applications'); }
  const max = s.upload_max_kb * 1024;
  const uploads = [validateUpload(ctx.files.headshot, 'headshot', max), validateUpload(ctx.files.resume, 'resume', max)].filter(Boolean);
  const d = {
   stage_name: text(f.stage_name, {min: 1, max: 80, name: 'Stage name'}), pronouns: text(f.pronouns, {max: 40}), city: text(f.city, {max: 80}), bio: text(f.bio, {max: 1000, name: 'Bio'}),
   representation: oneOf(f.representation, REPRESENTATION.map(x => x[0]), 'representation'), agency_name: text(f.agency_name, {max: 120}),
   union_status: oneOf(f.union_status, UNION.map(x => x[0]), 'union status'),
   monologue_title: text(f.monologue_title, {min: 1, max: 120, name: 'Monologue title'}), monologue_source: text(f.monologue_source, {max: 160}),
   monologue_seconds: int(f.monologue_seconds, {min: 10, max: 600}), reel_url: mediaLink(f.reel_url, {required: true, name: 'Reel link'}),
  };
  const disc = s.discovery_enabled && checkbox(f.consent_discovery), contact = s.discovery_enabled && checkbox(f.consent_contact);
  const a = await db.tx(async q => {
   const row = await q.one(`INSERT INTO applications(user_id,event_id,stage_name,pronouns,city,bio,representation,agency_name,union_status,monologue_title,monologue_source,monologue_seconds,reel_url,
     consent_version,consent_review,consent_discovery,consent_contact,consent_publication,consent_ip_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true,$15,$16,$17,$18) RETURNING id`,
    [ctx.user.id, eventId, d.stage_name, d.pronouns, d.city, d.bio, d.representation, d.agency_name, d.union_status, d.monologue_title, d.monologue_source, d.monologue_seconds, d.reel_url,
     s.consent_version, disc, contact, checkbox(f.consent_publication), ctx.ipHash]);
   return row;
  });
  for (const u of uploads) await storeUpload(db, keys, {ownerId: ctx.user.id, applicationId: a.id, upload: u});
  await audit(db, ctx.user.id, 'application.submitted', {applicationId: Number(a.id), consentVersion: s.consent_version});
  await notify(db, ctx.user.id, `We received your application "${d.monologue_title}". You will be notified when its status changes.`);
  const staff = await db.all(`SELECT DISTINCT user_id FROM user_roles WHERE role IN ('admin','producer')`);
  for (const st of staff) await notify(db, st.user_id, `New application from ${d.stage_name}.`);
  ctx.redirect('/account/applications/' + a.id, 'Application submitted.');
 }, {multipart: true});

 const ownApp = async ctx => {
  ctx.require();
  const a = await db.one('SELECT a.*, e.title AS event_title FROM applications a LEFT JOIN events e ON e.id=a.event_id WHERE a.id=$1 AND a.user_id=$2', [int(ctx.params.id, {min: 1}), ctx.user.id]);
  if (!a) throw new HttpError(404, 'Application not found');
  return a;
 };
 r.get('/account/applications/:id', async ctx => {
  const a = await ownApp(ctx);
  const media = await db.all('SELECT id, kind, size FROM media WHERE application_id=$1', [a.id]);
  const s = await settings.all();
  const closed = ['withdrawn', 'declined'].includes(a.status);
  ctx.page('Your application', html`<section class="mms-hero"><p class="mms-eyebrow">Application #${a.id}</p><h1>${a.monologue_title}</h1><p>Status: <span class="mms-pill">${a.status.replace('_', ' ')}</span> · ${a.event_title || 'Any upcoming event'} · submitted ${fmtDate(a.created_at)}</p></section>
   <section class="mms-card mms-stack"><h2>Details</h2><p><strong>${a.stage_name}</strong> ${a.pronouns ? `(${a.pronouns})` : ''} · ${a.city}</p><p>${a.bio}</p>
    <p>Representation: ${a.representation}${a.agency_name ? ' — ' + a.agency_name : ''} · Union: ${a.union_status}</p><p>Monologue: ${a.monologue_title}${a.monologue_source ? ' — ' + a.monologue_source : ''} (${a.monologue_seconds}s)</p>
    ${embed(a.reel_url, 'Reel')}${media.map(m => html`<p><a href="/media/${m.id}">${m.kind === 'headshot' ? 'Headshot' : 'Résumé'}</a> (${Math.ceil(m.size / 1024)} KB)</p>`)}
    <p class="mms-muted">Consent version ${a.consent_version} recorded ${fmtDate(a.consent_at)}.</p></section>
   ${closed ? '' : html`<section class="mms-card"><h2>Privacy choices</h2><form method="post" action="/account/applications/${a.id}/consent">${csrfField(ctx.csrf)}
    ${s.discovery_enabled ? check('Visible to verified industry members', 'consent_discovery', a.consent_discovery) : ''}${s.discovery_enabled ? check('Accept industry contact requests', 'consent_contact', a.consent_contact) : ''}
    ${check('Publish my recording, captions and results', 'consent_publication', a.consent_publication)}<button type="submit">Save choices</button></form>
    <p class="mms-muted">Turning off discovery or contact immediately removes you from industry search and cancels pending and approved contact permissions.</p></section>
    <section class="mms-card">${postButton('/account/applications/' + a.id + '/withdraw', 'Withdraw application', ctx.csrf, {cls: 'secondary', confirm: 'Withdraw this application?'})}</section>`}
   <section class="mms-card"><h2>Delete now</h2><p>Deletes this application and its uploads immediately.</p>${postButton('/account/applications/' + a.id + '/delete', 'Delete application', ctx.csrf, {cls: 'danger', confirm: 'Delete permanently?'})}</section>`);
 });
 r.post('/account/applications/:id/consent', async ctx => {
  const a = await ownApp(ctx);
  if (['withdrawn', 'declined'].includes(a.status)) throw new HttpError(409, 'This application is closed');
  const s = await settings.all();
  const disc = s.discovery_enabled && checkbox(ctx.form.consent_discovery), contact = s.discovery_enabled && checkbox(ctx.form.consent_contact), pub = checkbox(ctx.form.consent_publication);
  const revoked = (a.consent_discovery && !disc) || (a.consent_contact && !contact);
  await db.tx(async q => {
   await q.query(`UPDATE applications SET consent_discovery=$2, consent_contact=$3, consent_publication=$4, consent_generation=consent_generation+$5, updated_at=now() WHERE id=$1`, [a.id, disc, contact, pub, revoked ? 1 : 0]);
   if (!disc) await q.query('DELETE FROM saved_actors WHERE application_id=$1', [a.id]);
   await q.query('UPDATE entrants SET publish_consent=$2 WHERE application_id=$1', [a.id, pub]);
  });
  await audit(db, ctx.user.id, 'application.consent', {applicationId: Number(a.id), discovery: disc, contact, publication: pub});
  ctx.redirect('/account/applications/' + a.id, 'Privacy choices saved.');
 });
 r.post('/account/applications/:id/withdraw', async ctx => {
  const a = await ownApp(ctx);
  await db.tx(async q => {
   await q.query(`UPDATE applications SET status='withdrawn', consent_discovery=false, consent_contact=false, consent_generation=consent_generation+1, decided_at=now(), updated_at=now() WHERE id=$1`, [a.id]);
   await q.query('DELETE FROM saved_actors WHERE application_id=$1', [a.id]);
  });
  await audit(db, ctx.user.id, 'application.withdrawn', {applicationId: Number(a.id)});
  ctx.redirect('/account/applications/' + a.id, 'Application withdrawn. It will be deleted after the retention period.');
 });
 r.post('/account/applications/:id/delete', async ctx => {
  const a = await ownApp(ctx);
  await db.tx(async q => {
   await q.query(`UPDATE entrants SET application_id=NULL, display_name=CASE WHEN publish_consent THEN display_name ELSE 'Former entrant' END WHERE application_id=$1`, [a.id]);
   await q.query('DELETE FROM applications WHERE id=$1', [a.id]);
  });
  await audit(db, ctx.user.id, 'application.deleted', {applicationId: Number(a.id)});
  ctx.redirect('/account', 'Application and uploads deleted.');
 });

 r.post('/account/contact/:id', async ctx => {
  ctx.require();
  const decision = oneOf(ctx.form.decision, ['approved', 'declined'], 'decision');
  const c = await db.one(`SELECT c.*, a.user_id, a.consent_generation, a.consent_contact FROM contact_requests c JOIN applications a ON a.id=c.application_id WHERE c.id=$1`, [int(ctx.params.id, {min: 1})]);
  if (!c || Number(c.user_id) !== ctx.user.id) throw new HttpError(404, 'Request not found');
  if (c.status !== 'pending' || c.generation !== c.consent_generation || !c.consent_contact) throw new HttpError(409, 'This request is no longer pending');
  await db.query('UPDATE contact_requests SET status=$2, decided_at=now() WHERE id=$1', [c.id, decision]);
  await notify(db, c.industry_user_id, decision === 'approved' ? 'A performer approved your contact request; their email is now visible on their profile.' : 'A performer declined your contact request.');
  await audit(db, ctx.user.id, 'contact.' + decision, {requestId: Number(c.id)});
  ctx.redirect('/account', decision === 'approved' ? 'Your email is now shared with that industry member.' : 'Request declined.');
 });

 /** Private media: owner, staff, or verified industry when the applicant opted into discovery. */
 r.get('/media/:id', async ctx => {
  ctx.require();
  const id = int(ctx.params.id, {min: 1});
  const meta = await db.one('SELECT m.owner_user_id, m.application_id, a.consent_discovery, a.status FROM media m LEFT JOIN applications a ON a.id=m.application_id WHERE m.id=$1', [id]);
  if (!meta) throw new HttpError(404, 'Not found');
  const u = ctx.user;
  const s = await settings.all();
  const allowed = Number(meta.owner_user_id) === u.id || isStaff(u) ||
   (u.roles.has('industry') && s.discovery_enabled && meta.consent_discovery && !['withdrawn', 'declined'].includes(meta.status));
  if (!allowed) throw new HttpError(404, 'Not found');
  const m = await loadUpload(db, keys, id);
  if (!m) throw new HttpError(404, 'Not found');
  ctx.send(200, m.mime, m.data, {'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox", 'content-disposition': `inline; filename="${m.kind}-${m.id}.${m.mime === 'application/pdf' ? 'pdf' : m.mime.split('/')[1]}"`, 'cache-control': 'private, no-store'});
 });
}
