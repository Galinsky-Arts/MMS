import {HttpError, int, text, checkbox, oneOf} from '../http.mjs';
import {html, field, textarea, select, check, csrfField, postButton, table, fmtDate, fmtMs} from '../views/layout.mjs';
import {TIE_RULES, timerState} from '../engine/scoring.mjs';
import {MMS_DEFAULTS} from '../../domain/defaults.mjs';
import {mediaLink} from '../media.mjs';
import {privacyGaps} from '../settings.mjs';
import {APP_STATUS} from './applications.mjs';
import {audit, notify} from '../db.mjs';
import {purgeExpired} from '../retention.mjs';
import {normEmail, ROLES} from '../security.mjs';
import {embed} from '../views/event.mjs';

const ROUND_KINDS = ['qualifier', 'semifinal', 'final', 'heat'];
const EVENT_STATUS = [['draft', 'Draft (hidden)'], ['scheduled', 'Scheduled'], ['live', 'Live'], ['completed', 'Completed'], ['archived', 'Archived']];
const tieOptions = Object.entries(TIE_RULES).map(([k, v]) => [k, `${k}: ${v}`]);
const dt = v => { const s = String(v || '').trim(); if (!s) return null; const d = new Date(s.length === 16 ? s + ':00Z' : s); if (Number.isNaN(d.getTime())) throw new HttpError(400, 'Invalid date'); return d.toISOString(); };
const dtValue = d => d ? new Date(d).toISOString().slice(0, 16) : '';

/** Producer/admin console: settings and privacy gate, events, rubric, rounds, heats, judges, live heat control, applications review, users, sponsors, audit. */
export function adminRoutes(r, app) {
 const {db, engine, settings} = app;
 const staff = ctx => ctx.require('admin', 'producer');
 const admin = ctx => ctx.require('admin');
 const eventOf = async ctx => engine.event(int(ctx.params.id, {min: 1}));
 const back = (ctx, path, msg) => ctx.redirect(path, msg);

 r.get('/admin', async ctx => {
  staff(ctx);
  const s = await settings.all();
  const c = await db.one(`SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM applications WHERE status IN ('submitted','under_review','shortlisted')) AS open_apps,
   (SELECT count(*) FROM industry_profiles WHERE status='pending') AS pending_industry, (SELECT count(*) FROM events) AS events`);
  const health = await engine.health().catch(() => ({connected: false}));
  const gaps = privacyGaps(s);
  ctx.page('Admin', html`<section class="mms-hero"><p class="mms-eyebrow">Producer console</p><h1>Admin</h1></section>
   <div class="mms-grid">
    <article class="mms-card"><h2>Applications</h2><p>${s.applications_open ? 'Open' : 'Closed'}${gaps.length ? ` — cannot open until settings has: ${gaps.join(', ')}` : ''}.</p><p>${c.open_apps} awaiting review.</p><a href="/admin/applications">Review applications</a></article>
    <article class="mms-card"><h2>Events</h2><p>${c.events} events. Engine: ${health.kind || engine.kind} (${health.connected ? 'connected' : 'unavailable'}).</p><a href="/admin/events">Manage events</a></article>
    <article class="mms-card"><h2>People</h2><p>${c.users} accounts; ${c.pending_industry} industry verification request(s).</p><a href="/admin/users">Users and roles</a></article>
    <article class="mms-card"><h2>More</h2><p><a href="/admin/settings">Settings and privacy</a><br><a href="/admin/sponsors">Sponsors</a><br><a href="/admin/audit">Audit log</a><br><a href="/t/${app.config.tenantId}/organizer">Competition draft defaults</a></p></article>
   </div>`);
 });

 // ---------- settings & privacy gate ----------
 r.get('/admin/settings', async ctx => {
  admin(ctx);
  const s = await settings.all();
  const gaps = privacyGaps(s);
  ctx.page('Settings', html`<section class="mms-hero"><h1>Settings</h1><p>Applications stay closed until the owner-approved privacy details below are entered and you switch them on.</p></section>
   <section class="mms-card"><h2>Applications are ${s.applications_open ? 'OPEN' : 'CLOSED'}</h2>${gaps.length ? html`<p class="mms-banner">Missing before applications can open: ${gaps.join(', ')}.</p>` : ''}
    ${postButton('/admin/settings/applications', s.applications_open ? 'Close applications' : 'Open applications', ctx.csrf, {fields: {open: s.applications_open ? '0' : '1'}, cls: s.applications_open ? 'danger' : ''})}</section>
   <form method="post" action="/admin/settings" class="mms-card">${csrfField(ctx.csrf)}<h2>Privacy and consent (owner decisions)</h2>
    ${field('Operator name (data controller)', 'operator_name', {value: s.operator_name, attrs: 'maxlength="160"'})}${field('Privacy contact (email or address)', 'privacy_contact', {value: s.privacy_contact, attrs: 'maxlength="200"'})}
    ${field('Retention days for declined/withdrawn applications', 'retention_days', {type: 'number', value: s.retention_days || '', attrs: 'min="1" max="3650"'})}${field('Consent version', 'consent_version', {value: s.consent_version, hint: 'Recorded with every application, e.g. 2026-11-v1.', attrs: 'maxlength="40"'})}
    ${textarea('Privacy notice shown to applicants', 'privacy_notice', {value: s.privacy_notice, rows: 8})}
    <h2>Discovery, voting and uploads</h2>${check('Industry discovery enabled', 'discovery_enabled', s.discovery_enabled)}
    ${field('Minimum account age to vote (minutes)', 'vote_min_account_minutes', {type: 'number', value: s.vote_min_account_minutes, attrs: 'min="0" max="10080"'})}
    ${field('Maximum votes per network per heat', 'vote_ip_cap', {type: 'number', value: s.vote_ip_cap, attrs: 'min="1" max="10000"'})}
    ${field('Upload size cap (KB, per file, stored in Postgres)', 'upload_max_kb', {type: 'number', value: s.upload_max_kb, attrs: 'min="64" max="4096"'})}
    <button type="submit">Save settings</button></form>
   <section class="mms-card"><h2>Retention</h2><p>Expired applications are purged hourly. ${postButton('/admin/retention/purge', 'Run purge now', ctx.csrf, {cls: 'secondary'})}</p></section>`);
 });
 r.post('/admin/settings', async ctx => {
  admin(ctx);
  const f = ctx.form;
  const before = await settings.all();
  const values = {
   operator_name: text(f.operator_name, {max: 160}), privacy_contact: text(f.privacy_contact, {max: 200}),
   retention_days: f.retention_days ? int(f.retention_days, {min: 1, max: 3650}) : 0, consent_version: text(f.consent_version, {max: 40}),
   privacy_notice: text(f.privacy_notice, {max: 20000}), discovery_enabled: checkbox(f.discovery_enabled),
   vote_min_account_minutes: int(f.vote_min_account_minutes, {min: 0, max: 10080}), vote_ip_cap: int(f.vote_ip_cap, {min: 1, max: 10000}), upload_max_kb: int(f.upload_max_kb, {min: 64, max: 4096}),
  };
  const termsChanged = ['operator_name', 'privacy_contact', 'retention_days', 'consent_version', 'privacy_notice'].some(k => before[k] !== values[k]);
  if (termsChanged && before.applications_open) values.applications_open = false;
  if (privacyGaps(values).length) values.applications_open = false;
  await settings.update(values);
  await audit(db, ctx.user.id, 'settings.updated', {termsChanged});
  back(ctx, '/admin/settings', termsChanged && before.applications_open ? 'Saved. Privacy terms changed, so applications were closed; re-open them to confirm.' : 'Settings saved.');
 });
 r.post('/admin/settings/applications', async ctx => {
  admin(ctx);
  const open = ctx.form.open === '1';
  await settings.setApplicationsOpen(open);
  await audit(db, ctx.user.id, open ? 'applications.opened' : 'applications.closed', {});
  back(ctx, '/admin/settings', open ? 'Applications are open.' : 'Applications are closed.');
 });
 r.post('/admin/retention/purge', async ctx => {
  admin(ctx);
  const n = await purgeExpired(db, settings);
  back(ctx, '/admin/settings', `Purged ${n} expired application(s).`);
 });

 // ---------- events ----------
 r.get('/admin/events', async ctx => {
  staff(ctx);
  const events = await engine.listEvents();
  ctx.page('Events', html`<section class="mms-hero"><h1>Events</h1></section>
   ${table(['Event', 'Status', 'Published', 'Starts'], events.map(e => [html`<a href="/admin/events/${e.id}">${e.title}</a>`, e.status, e.published ? 'Yes' : 'No', fmtDate(e.starts_at)]), {empty: 'No events yet.'})}
   <form method="post" action="/admin/events" class="mms-card">${csrfField(ctx.csrf)}<h2>New event</h2>
    ${field('Title', 'title', {required: true, attrs: 'maxlength="160"'})}${field('Slug', 'slug', {required: true, hint: 'Lowercase letters, digits and hyphens; used in the public URL.', attrs: 'pattern="[a-z0-9][a-z0-9-]*[a-z0-9]" maxlength="64"'})}
    ${field('Starts at (UTC)', 'starts_at', {type: 'datetime-local'})}${field('Venue', 'venue', {attrs: 'maxlength="160"'})}${textarea('Description', 'description')}
    ${check('Start from MMS defaults (rubric delivery/interpretation/stage presence; qualifier then final)', 'preset', true)}<button type="submit">Create event</button></form>`);
 });
 r.post('/admin/events', async ctx => {
  staff(ctx);
  const f = ctx.form, preset = checkbox(f.preset);
  const names = {'delivery': 'Delivery', 'interpretation': 'Interpretation', 'stage-presence': 'Stage presence'};
  const e = await engine.createEvent({
   slug: text(f.slug, {min: 2, max: 64, name: 'Slug'}), title: text(f.title, {min: 2, max: 160, name: 'Title'}), description: text(f.description, {max: 4000}), venue: text(f.venue, {max: 160}), starts_at: dt(f.starts_at),
   tie_rule: 'manual-review',
   criteria: preset ? MMS_DEFAULTS.judgeScoring.criterionIds.map((id, i) => ({name: names[id] || id, weight_bps: MMS_DEFAULTS.judgeScoring.weightsBps[i], max_score: 10})) : [],
   rounds: preset ? [{name: 'Qualifier', kind: 'qualifier', time_limit_seconds: MMS_DEFAULTS.qualifierSeconds, advance_count: 3}, {name: 'Final', kind: 'final', time_limit_seconds: MMS_DEFAULTS.finalSeconds, advance_count: 1}] : [],
  });
  await audit(db, ctx.user.id, 'event.created', {eventId: Number(e.id)});
  back(ctx, '/admin/events/' + e.id, 'Event created.');
 });

 r.get('/admin/events/:id', async ctx => {
  staff(ctx);
  const e = await eventOf(ctx);
  const [criteria, rounds, entrants, judges] = await Promise.all([engine.criteria(e.id), engine.rounds(e.id), engine.entrants(e.id), engine.judges(e.id)]);
  for (const rd of rounds) { rd.heats = await engine.heats(rd.id); for (const h of rd.heats) h.entries = await engine.entries(h.id); }
  const weightSum = criteria.reduce((a, c) => a + c.weight_bps, 0);
  const entrantOpts = entrants.filter(x => x.status === 'active').map(x => [x.id, x.display_name]);
  ctx.page(e.title, html`<section class="mms-hero"><p class="mms-eyebrow">Event · <a href="/events/${e.slug}">public page</a>${e.published ? '' : ' (unpublished)'}</p><h1>${e.title}</h1>
   <p>Status ${e.status}${e.finalized_at ? ' · finalized ' + fmtDate(e.finalized_at) : ''}</p></section>
   <form method="post" action="/admin/events/${e.id}" class="mms-card">${csrfField(ctx.csrf)}<h2>Details and rules</h2>
    ${field('Title', 'title', {value: e.title, required: true})}${field('Starts at (UTC)', 'starts_at', {type: 'datetime-local', value: dtValue(e.starts_at)})}${field('Venue', 'venue', {value: e.venue})}
    ${textarea('Description', 'description', {value: e.description})}${select('Status', 'status', EVENT_STATUS, e.status)}${check('Published on the public site', 'published', e.published)}
    ${field('Live stream link', 'stream_url', {type: 'url', value: e.stream_url || '', hint: 'YouTube, Vimeo or SoundCloud.'})}
    ${select('Tie rule', 'tie_rule', tieOptions, e.tie_rule)}
    ${check('Audience voting enabled', 'voting_enabled', e.voting_enabled)}${field('Votes per account per heat', 'votes_per_fan', {type: 'number', value: e.votes_per_fan, attrs: 'min="1" max="10"'})}
    ${field('Audience vote weight (%)', 'vote_weight', {type: 'number', value: e.vote_weight_bps / 100, attrs: 'min="0" max="100" step="0.01"'})}
    <button type="submit">Save event</button></form>
   <section class="mms-card"><h2>Judging rubric</h2>${weightSum !== 10000 && criteria.length ? html`<p class="mms-banner">Weights add up to ${weightSum / 100}%; scores are still normalized per criterion, but 100% is recommended.</p>` : ''}
    ${table(['Criterion', 'Weight', 'Max', ''], criteria.map(c => [c.name, c.weight_bps / 100 + '%', String(c.max_score), postButton(`/admin/events/${e.id}/criteria/${c.id}/delete`, 'Remove', ctx.csrf, {cls: 'secondary'})]), {empty: 'No criteria yet.'})}
    <form method="post" action="/admin/events/${e.id}/criteria" class="mms-row">${csrfField(ctx.csrf)}${field('Name', 'name', {required: true})}${field('Weight %', 'weight', {type: 'number', required: true, attrs: 'min="0.01" max="100" step="0.01"'})}${field('Max score', 'max_score', {type: 'number', value: '10', attrs: 'min="1" max="100"'})}<button type="submit">Add criterion</button></form></section>
   <section class="mms-card"><h2>Judges</h2>${table(['Judge', 'Email', ''], judges.map(j => [j.display_name, j.email, postButton(`/admin/events/${e.id}/judges/${j.id}/remove`, 'Remove', ctx.csrf, {cls: 'secondary'})]), {empty: 'No judges assigned.'})}
    <form method="post" action="/admin/events/${e.id}/judges" class="mms-row">${csrfField(ctx.csrf)}${field('Judge account email', 'email', {required: true, hint: 'The account needs the judge role (Users page).'})}<button type="submit">Assign judge</button></form></section>
   <section class="mms-card"><h2>Entrants</h2>${table(['Entrant', 'Status', 'Publication consent', ''], entrants.map(x => [x.display_name, x.status, x.publish_consent ? 'Yes' : 'No',
     html`<form method="post" action="/admin/events/${e.id}/entrants/${x.id}/status" class="mms-row">${csrfField(ctx.csrf)}<select name="status" aria-label="Status for ${x.display_name}">${['active', 'withdrawn', 'disqualified'].map(s => html`<option${s === x.status ? html` selected` : ''}>${s}</option>`)}</select><button type="submit" class="secondary">Set</button></form>`]), {empty: 'Accept applications or add entrants manually.'})}
    <form method="post" action="/admin/events/${e.id}/entrants" class="mms-row">${csrfField(ctx.csrf)}${field('Stage name', 'display_name', {required: true})}${field('Account email (optional)', 'email')}${check('Publication consent recorded', 'publish_consent', false)}<button type="submit">Add entrant</button></form></section>
   ${rounds.map(rd => html`<section class="mms-card mms-stack"><h2>Round ${rd.position}: ${rd.name} <span class="mms-pill">${rd.kind}</span> <span class="mms-pill">${rd.status}</span></h2><p>${fmtMs(rd.time_limit_seconds * 1000)} limit · top ${rd.advance_count} per heat advance</p>
     ${rd.heats.map(h => html`<div><h3><a href="/admin/heats/${h.id}">${h.name}</a> <span class="mms-pill">${h.status}</span></h3><p>${h.entries.map(x => x.display_name).join(', ') || 'No entrants placed.'}</p>
      ${h.status === 'finalized' ? '' : html`<form method="post" action="/admin/heats/${h.id}/place" class="mms-row">${csrfField(ctx.csrf)}${select('Place entrant', 'entrant_id', entrantOpts, '')}<button type="submit" class="secondary">Place</button></form>`}</div>`)}
     <div class="mms-row">${postButton(`/admin/rounds/${rd.id}/heats`, 'Add heat', ctx.csrf, {cls: 'secondary'})}${rd.status !== 'closed' ? postButton(`/admin/rounds/${rd.id}/advance`, 'Advance finalists to next round', ctx.csrf) : ''}</div></section>`)}
   <form method="post" action="/admin/events/${e.id}/rounds" class="mms-card">${csrfField(ctx.csrf)}<h2>Add round</h2><div class="mms-row">${field('Name', 'name', {required: true})}${select('Kind', 'kind', ROUND_KINDS.map(k => [k, k]), 'qualifier')}
    ${field('Time limit (seconds)', 'time_limit_seconds', {type: 'number', value: '90', attrs: 'min="10" max="3600"'})}${field('Advance per heat', 'advance_count', {type: 'number', value: '1', attrs: 'min="0" max="1000"'})}</div><button type="submit">Add round</button></form>
   <section class="mms-card"><h2>Finalize</h2><p>Finalizing records the champion from the single finalized heat of the last round and completes the event.</p>${postButton(`/admin/events/${e.id}/finalize`, 'Finalize event results', ctx.csrf, {confirm: 'Finalize this event?'})}</section>`);
 });
 r.post('/admin/events/:id', async ctx => {
  staff(ctx);
  const e = await eventOf(ctx), f = ctx.form;
  const voting = checkbox(f.voting_enabled);
  await engine.updateEvent(e.id, {title: text(f.title, {min: 2, max: 160, name: 'Title'}), starts_at: dt(f.starts_at), venue: text(f.venue, {max: 160}), description: text(f.description, {max: 4000}),
   status: oneOf(f.status, EVENT_STATUS.map(x => x[0]), 'status'), published: checkbox(f.published), stream_url: mediaLink(f.stream_url, {name: 'Stream link'}), tie_rule: oneOf(f.tie_rule, Object.keys(TIE_RULES), 'tie rule'),
   voting_enabled: voting, votes_per_fan: int(f.votes_per_fan, {min: 1, max: 10}), vote_weight_bps: Math.round(Number(f.vote_weight || 0) * 100)});
  await audit(db, ctx.user.id, 'event.updated', {eventId: Number(e.id)});
  back(ctx, '/admin/events/' + e.id, 'Event saved.');
 });
 r.post('/admin/events/:id/criteria', async ctx => {
  staff(ctx);
  const e = await eventOf(ctx);
  const w = Math.round(Number(ctx.form.weight) * 100);
  if (!(w >= 1 && w <= 10000)) throw new HttpError(400, 'Weight must be between 0.01 and 100');
  await engine.addCriterion(e.id, {name: text(ctx.form.name, {min: 1, max: 80, name: 'Name'}), weight_bps: w, max_score: int(ctx.form.max_score, {min: 1, max: 100})});
  back(ctx, '/admin/events/' + e.id, 'Criterion added.');
 });
 r.post('/admin/events/:id/criteria/:cid/delete', async ctx => {
  staff(ctx);
  const e = await eventOf(ctx);
  await engine.removeCriterion(e.id, int(ctx.params.cid, {min: 1}));
  back(ctx, '/admin/events/' + e.id, 'Criterion removed.');
 });
 r.post('/admin/events/:id/judges', async ctx => {
  staff(ctx);
  const e = await eventOf(ctx);
  const u = await db.one('SELECT id FROM users WHERE email=$1', [normEmail(ctx.form.email)]);
  if (!u) throw new HttpError(400, 'No account with that email');
  await engine.assignJudge(e.id, u.id);
  await notify(db, u.id, `You were assigned to judge ${e.title}.`);
  back(ctx, '/admin/events/' + e.id, 'Judge assigned.');
 });
 r.post('/admin/events/:id/judges/:uid/remove', async ctx => {
  staff(ctx);
  const e = await eventOf(ctx);
  await engine.removeJudge(e.id, int(ctx.params.uid, {min: 1}));
  back(ctx, '/admin/events/' + e.id, 'Judge removed.');
 });
 r.post('/admin/events/:id/entrants', async ctx => {
  staff(ctx);
  const e = await eventOf(ctx);
  let userId = null;
  if (ctx.form.email) { const u = await db.one('SELECT id FROM users WHERE email=$1', [normEmail(ctx.form.email)]); if (!u) throw new HttpError(400, 'No account with that email'); userId = u.id; }
  await engine.addEntrant(e.id, {display_name: text(ctx.form.display_name, {min: 1, max: 80, name: 'Stage name'}), user_id: userId, publish_consent: checkbox(ctx.form.publish_consent)});
  if (userId) await db.query(`INSERT INTO user_roles(user_id,role) VALUES ($1,'entrant') ON CONFLICT DO NOTHING`, [userId]);
  back(ctx, '/admin/events/' + e.id, 'Entrant added.');
 });
 r.post('/admin/events/:id/entrants/:eid/status', async ctx => {
  staff(ctx);
  const e = await eventOf(ctx);
  await engine.setEntrantStatus(int(ctx.params.eid, {min: 1}), ctx.form.status);
  back(ctx, '/admin/events/' + e.id, 'Entrant updated.');
 });
 r.post('/admin/events/:id/rounds', async ctx => {
  staff(ctx);
  const e = await eventOf(ctx);
  await engine.addRound(e.id, {name: text(ctx.form.name, {min: 1, max: 80, name: 'Name'}), kind: oneOf(ctx.form.kind, ROUND_KINDS, 'kind'), time_limit_seconds: int(ctx.form.time_limit_seconds, {min: 10, max: 3600}), advance_count: int(ctx.form.advance_count, {min: 0, max: 1000})});
  back(ctx, '/admin/events/' + e.id, 'Round added.');
 });
 r.post('/admin/events/:id/finalize', async ctx => {
  staff(ctx);
  const e = await eventOf(ctx);
  const out = await engine.finalizeEvent(e.id);
  await audit(db, ctx.user.id, 'event.finalized', {eventId: Number(e.id), champion: out.champion_entrant_id && Number(out.champion_entrant_id)});
  back(ctx, '/admin/events/' + e.id, out.champion_entrant_id ? 'Event finalized and champion recorded.' : 'Event finalized (shared first place; no single champion).');
 });
 r.post('/admin/rounds/:id/heats', async ctx => {
  staff(ctx);
  const rd = await db.one('SELECT * FROM rounds WHERE id=$1', [int(ctx.params.id, {min: 1})]);
  if (!rd) throw new HttpError(404, 'Not found');
  const n = (await engine.heats(rd.id)).length + 1;
  await engine.addHeat(rd.id, `${rd.name} heat ${n}`);
  back(ctx, '/admin/events/' + rd.event_id, 'Heat added.');
 });
 r.post('/admin/rounds/:id/advance', async ctx => {
  staff(ctx);
  const rd = await db.one('SELECT * FROM rounds WHERE id=$1', [int(ctx.params.id, {min: 1})]);
  if (!rd) throw new HttpError(404, 'Not found');
  const out = await engine.advanceRound(rd.id);
  await audit(db, ctx.user.id, 'round.advanced', {roundId: Number(rd.id), advanced: out.advanced});
  back(ctx, '/admin/events/' + rd.event_id, `${out.advanced} entrant(s) advanced.`);
 });

 // ---------- live heat console ----------
 r.post('/admin/heats/:id/place', async ctx => {
  staff(ctx);
  const h = await engine.heat(int(ctx.params.id, {min: 1}));
  await engine.placeEntrant(h.id, int(ctx.form.entrant_id, {min: 1}));
  back(ctx, '/admin/events/' + h.event_id, 'Entrant placed.');
 });
 r.get('/admin/heats/:id', async ctx => {
  staff(ctx);
  const h = await engine.heat(int(ctx.params.id, {min: 1}));
  const e = await engine.event(h.event_id);
  const [entries, criteria, judges, counts, results] = await Promise.all([engine.entries(h.id), engine.criteria(e.id), engine.judges(e.id), engine.voteCounts(h.id), engine.results(h.id)]);
  const scored = await db.all('SELECT s.heat_entry_id, s.judge_user_id, count(*)::int AS n FROM scores s JOIN heat_entries he ON he.id=s.heat_entry_id WHERE he.heat_id=$1 GROUP BY 1,2', [h.id]);
  const t = timerState(h, h.time_limit_seconds);
  const vc = new Map(counts.map(c => [Number(c.heat_entry_id), c.n]));
  const done = (he, j) => (scored.find(s => Number(s.heat_entry_id) === Number(he.id) && Number(s.judge_user_id) === Number(j.id))?.n || 0) >= criteria.length;
  const tied = results.filter(x => x.tied);
  ctx.page('Heat console', html`<section class="mms-hero"${h.status === 'live' ? html` data-refresh="20"` : ''}><p class="mms-eyebrow"><a href="/admin/events/${e.id}">${e.title}</a> · ${h.round_name}</p><h1>${h.name}</h1><p>Status <span class="mms-pill">${h.status}</span> · limit ${fmtMs(h.time_limit_seconds * 1000)}</p>
    <div class="mms-row">${h.status === 'pending' ? postButton(`/admin/heats/${h.id}/status`, 'Set heat live', ctx.csrf, {fields: {status: 'live'}}) : ''}
     ${e.voting_enabled && h.status === 'live' ? postButton(`/admin/heats/${h.id}/voting`, h.voting_open ? 'Close audience voting' : 'Open audience voting', ctx.csrf, {fields: {open: h.voting_open ? '0' : '1'}, cls: 'secondary'}) : ''}</div></section>
   ${h.status === 'live' ? html`<section class="mms-card"><h2>Timer</h2><p class="mms-timer${t.overtime ? ' over' : ''}" data-remaining-ms="${Math.round(t.remainingMs)}" data-running="${t.running ? 1 : 0}">${fmtMs(t.remainingMs)}</p>
    <div class="mms-row">${h.timer_entry_id ? [t.running ? postButton(`/admin/heats/${h.id}/timer`, 'Pause', ctx.csrf, {fields: {action: 'pause'}, cls: 'secondary'}) : postButton(`/admin/heats/${h.id}/timer`, 'Resume', ctx.csrf, {fields: {action: 'resume'}, cls: 'secondary'}),
      postButton(`/admin/heats/${h.id}/timer`, 'Stop and record time', ctx.csrf, {fields: {action: 'stop'}})] : html`<span class="mms-muted">Start a performer below.</span>`}</div></section>` : ''}
   <section class="mms-card"><h2>Running order</h2>${table(['#', 'Performer', 'Status', 'Time', 'Votes', ...judges.map(j => j.display_name), ''], entries.map((he, i) => [String(i + 1), he.display_name, he.status.replace('_', '-'),
     he.performed_ms ? fmtMs(he.performed_ms) + (he.overtime ? ' (over)' : '') : '', String(vc.get(Number(he.id)) || 0), ...judges.map(j => done(he, j) ? 'scored' : '—'),
     html`<span class="mms-row">${h.status === 'live' && he.status === 'pending' && !h.timer_entry_id ? postButton(`/admin/heats/${h.id}/timer`, 'Start', ctx.csrf, {fields: {action: 'start', entry: he.id}}) : ''}
      ${h.status !== 'finalized' && he.status === 'pending' ? postButton(`/admin/entries/${he.id}/mark`, 'No-show', ctx.csrf, {fields: {status: 'no_show'}, cls: 'secondary'}) : ''}
      ${h.status !== 'finalized' && ['no_show', 'forfeit'].includes(he.status) ? postButton(`/admin/entries/${he.id}/mark`, 'Reset', ctx.csrf, {fields: {status: 'pending'}, cls: 'secondary'}) : ''}
      ${h.status === 'pending' ? postButton(`/admin/entries/${he.id}/remove`, 'Remove', ctx.csrf, {cls: 'secondary'}) : ''}</span>`]))}</section>
   ${h.status !== 'finalized' ? html`<form method="post" action="/admin/heats/${h.id}/results" class="mms-card">${csrfField(ctx.csrf)}<h2>Results</h2><p>Computes ranks with the "${e.tie_rule}" tie rule${e.voting_enabled ? ` and a ${e.vote_weight_bps / 100}% audience weight` : ''}. Closes scoring and voting.</p>
     ${tied.length && e.tie_rule === 'manual-review' ? html`<p class="mms-banner">Tie between ${tied.map(x => x.display_name).join(', ')}. Enter the producer's order below (entrant ids, best first).</p>${field('Manual order (comma-separated entrant ids)', 'manual_order', {hint: tied.map(x => `${x.display_name} = ${x.entrant_id}`).join(', ')})}` : ''}
     <button type="submit">${results.length ? 'Recompute results' : 'Compute results'}</button></form>` : ''}
   ${results.length ? html`<section class="mms-card"><h2>${h.status === 'finalized' ? 'Final results' : 'Provisional results'}</h2>${table(['Rank', 'Performer', 'Judges', 'Votes', 'Combined', 'Note'], results.map(x => [String(x.rank), x.display_name, Number(x.judge_score).toFixed(2), String(x.vote_count), Number(x.combined).toFixed(2), (x.advanced ? 'Advanced ' : '') + x.note]))}
    ${h.status === 'closed' ? postButton(`/admin/heats/${h.id}/finalize`, 'Finalize heat', ctx.csrf, {confirm: 'Finalize these results?'}) : ''}</section>` : ''}
   <section class="mms-card mms-stack"><h2>Recordings and captions</h2><p class="mms-muted">Recordings and captions are public only for performers with publication consent, and captions only after you mark them corrected.</p>
    ${entries.map(he => html`<form method="post" action="/admin/entries/${he.id}/recording" class="mms-stack">${csrfField(ctx.csrf)}<h3>${he.display_name}${he.publish_consent ? '' : ' (no publication consent)'}</h3>${he.recording_url ? embed(he.recording_url, 'Recording') : ''}
     ${field('Recording link', 'recording_url', {type: 'url', value: he.recording_url || ''})}${textarea('Captions transcript', 'captions', {value: he.captions || ''})}${check('Captions reviewed and corrected', 'captions_corrected', he.captions_corrected)}<button type="submit" class="secondary">Save recording</button></form>`)}</section>`);
 });
 const heatAction = (path, fn, msg) => r.post('/admin/heats/:id/' + path, async ctx => {
  staff(ctx);
  const h = await engine.heat(int(ctx.params.id, {min: 1}));
  await fn(ctx, h);
  await audit(db, ctx.user.id, 'heat.' + path, {heatId: Number(h.id), ...(ctx.form.action ? {action: ctx.form.action} : {})});
  back(ctx, '/admin/heats/' + h.id, msg);
 });
 heatAction('status', (ctx, h) => engine.setHeatStatus(h.id, ctx.form.status), 'Heat updated.');
 heatAction('timer', (ctx, h) => engine.timer(h.id, ctx.form.action, ctx.form.entry ? int(ctx.form.entry, {min: 1}) : null), 'Timer updated.');
 heatAction('voting', (ctx, h) => engine.setVoting(h.id, ctx.form.open === '1'), 'Voting updated.');
 heatAction('results', (ctx, h) => engine.computeResults(h.id, String(ctx.form.manual_order || '').split(',').map(s => s.trim()).filter(Boolean).map(s => int(s, {min: 1}))), 'Results computed.');
 heatAction('finalize', (ctx, h) => engine.finalizeHeat(h.id), 'Heat finalized.');
 const entryAction = (path, fn, msg) => r.post('/admin/entries/:id/' + path, async ctx => {
  staff(ctx);
  const he = await db.one('SELECT * FROM heat_entries WHERE id=$1', [int(ctx.params.id, {min: 1})]);
  if (!he) throw new HttpError(404, 'Not found');
  await fn(ctx, he);
  back(ctx, '/admin/heats/' + he.heat_id, msg);
 });
 entryAction('mark', (ctx, he) => engine.markEntry(he.id, ctx.form.status), 'Entry updated.');
 entryAction('remove', (ctx, he) => engine.removeHeatEntry(he.id), 'Entry removed.');
 entryAction('recording', (ctx, he) => engine.setRecording(he.id, {recording_url: mediaLink(ctx.form.recording_url, {name: 'Recording link'}), captions: text(ctx.form.captions, {max: 20000}) || null, captions_corrected: checkbox(ctx.form.captions_corrected)}), 'Recording saved.');

 // ---------- applications review ----------
 r.get('/admin/applications', async ctx => {
  staff(ctx);
  const status = ctx.query.get('status');
  const rows = await db.all(`SELECT a.id, a.stage_name, a.monologue_title, a.status, a.created_at, e.title AS event_title FROM applications a LEFT JOIN events e ON e.id=a.event_id
   ${APP_STATUS.includes(status) ? 'WHERE a.status=$1' : ''} ORDER BY a.id DESC LIMIT 300`, APP_STATUS.includes(status) ? [status] : []);
  ctx.page('Applications', html`<section class="mms-hero"><h1>Applications</h1><p class="mms-row">${[['', 'All'], ...APP_STATUS.map(s => [s, s.replace('_', ' ')])].map(([s, l]) => html`<a href="/admin/applications${s ? '?status=' + s : ''}"${(status || '') === s ? html` aria-current="page"` : ''}>${l}</a>`)}</p></section>
   ${table(['#', 'Performer', 'Monologue', 'Event', 'Status', 'Submitted'], rows.map(a => [String(a.id), html`<a href="/admin/applications/${a.id}">${a.stage_name}</a>`, a.monologue_title, a.event_title || 'Any', a.status.replace('_', ' '), fmtDate(a.created_at)]), {empty: 'No applications.'})}`);
 });
 r.get('/admin/applications/:id', async ctx => {
  staff(ctx);
  const a = await db.one('SELECT a.*, u.email, e.title AS event_title FROM applications a JOIN users u ON u.id=a.user_id LEFT JOIN events e ON e.id=a.event_id WHERE a.id=$1', [int(ctx.params.id, {min: 1})]);
  if (!a) throw new HttpError(404, 'Not found');
  const media = await db.all('SELECT id, kind, size, mime FROM media WHERE application_id=$1', [a.id]);
  const events = await engine.listEvents({statuses: ['draft', 'scheduled', 'live']});
  ctx.page('Application ' + a.id, html`<section class="mms-hero"><p class="mms-eyebrow">Application #${a.id} · private</p><h1>${a.stage_name}</h1><p>${a.email} · ${a.pronouns} · ${a.city} · <span class="mms-pill">${a.status}</span></p></section>
   <section class="mms-card mms-stack"><p>${a.bio}</p><p>Representation: ${a.representation}${a.agency_name ? ' — ' + a.agency_name : ''} · Union: ${a.union_status}</p>
    <p>Monologue: <strong>${a.monologue_title}</strong>${a.monologue_source ? ' — ' + a.monologue_source : ''} (${a.monologue_seconds}s) · Event: ${a.event_title || 'any'}</p>${embed(a.reel_url, 'Reel')}
    ${media.map(m => m.kind === 'headshot' ? html`<p><img src="/media/${m.id}" alt="Headshot" width="200"></p>` : html`<p><a href="/media/${m.id}">Résumé PDF (${Math.ceil(m.size / 1024)} KB)</a></p>`)}
    <p class="mms-muted">Consent v${a.consent_version} at ${fmtDate(a.consent_at)} · discovery ${a.consent_discovery ? 'yes' : 'no'} · contact ${a.consent_contact ? 'yes' : 'no'} · publication ${a.consent_publication ? 'yes' : 'no'}</p></section>
   ${['withdrawn'].includes(a.status) ? '' : html`<form method="post" action="/admin/applications/${a.id}" class="mms-card">${csrfField(ctx.csrf)}<h2>Decision</h2>${select('Status', 'status', APP_STATUS.filter(s => s !== 'withdrawn').map(s => [s, s.replace('_', ' ')]), a.status)}
    ${select('Event for accepted entrants', 'event_id', events.map(e => [e.id, e.title]), a.event_id || '')}${textarea('Private producer notes', 'notes', {value: a.producer_notes})}
    ${check('Notify the applicant of the status change', 'notify', true)}<button type="submit">Save decision</button></form>`}`);
 });
 r.post('/admin/applications/:id', async ctx => {
  staff(ctx);
  const a = await db.one('SELECT * FROM applications WHERE id=$1', [int(ctx.params.id, {min: 1})]);
  if (!a) throw new HttpError(404, 'Not found');
  if (a.status === 'withdrawn') throw new HttpError(409, 'The applicant withdrew this application');
  const status = oneOf(ctx.form.status, APP_STATUS.filter(s => s !== 'withdrawn'), 'status');
  const notes = text(ctx.form.notes, {max: 4000});
  if (status === 'accepted') {
   const eventId = int(ctx.form.event_id, {min: 1});
   const existing = await db.one('SELECT 1 FROM entrants WHERE event_id=$1 AND user_id=$2', [eventId, a.user_id]);
   if (!existing) await engine.addEntrant(eventId, {display_name: a.stage_name, user_id: a.user_id, application_id: a.id, publish_consent: a.consent_publication});
   await db.query(`INSERT INTO user_roles(user_id,role) VALUES ($1,'entrant') ON CONFLICT DO NOTHING`, [a.user_id]);
   await db.query('UPDATE applications SET event_id=$2 WHERE id=$1', [a.id, eventId]);
  }
  await db.query(`UPDATE applications SET status=$2, producer_notes=$3, updated_at=now(), decided_at=CASE WHEN $2 IN ('accepted','declined') THEN now() ELSE decided_at END WHERE id=$1`, [a.id, status, notes]);
  if (status !== a.status && checkbox(ctx.form.notify)) await notify(db, a.user_id, `Your application "${a.monologue_title}" is now: ${status.replace('_', ' ')}.`);
  await audit(db, ctx.user.id, 'application.decision', {applicationId: Number(a.id), status});
  back(ctx, '/admin/applications/' + a.id, 'Decision saved.');
 });

 // ---------- users, roles, industry verification ----------
 r.get('/admin/users', async ctx => {
  staff(ctx);
  const q = text(ctx.query.get('q'), {max: 120});
  const rows = await db.all(`SELECT u.id, u.email, u.display_name, u.created_at, u.disabled, u.bootstrap, COALESCE(array_agg(r.role ORDER BY r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles,
    ip.company, ip.title, ip.website, ip.status AS industry_status FROM users u LEFT JOIN user_roles r ON r.user_id=u.id LEFT JOIN industry_profiles ip ON ip.user_id=u.id
    ${q ? 'WHERE u.email ILIKE $1 OR u.display_name ILIKE $1' : ''} GROUP BY u.id, ip.user_id ORDER BY (ip.status='pending') DESC NULLS LAST, u.id DESC LIMIT 200`, q ? ['%' + q.replace(/[%_\\]/g, m => '\\' + m) + '%'] : []);
  const isAdmin = ctx.user.roles.has('admin');
  ctx.page('Users', html`<section class="mms-hero"><h1>Users and roles</h1><form method="get" class="mms-row">${field('Search', 'q', {value: q})}<button type="submit">Search</button></form></section>
   ${table(['Account', 'Roles', 'Industry', ''], rows.map(u => [html`${u.display_name}<br><span class="mms-muted">${u.email}${u.bootstrap ? ' (bootstrap)' : ''}</span>`, u.roles.join(', '),
    u.industry_status ? html`${u.company} — ${u.title} ${u.website ? html`<a href="${u.website}" rel="noopener noreferrer">site</a>` : ''} <span class="mms-pill">${u.industry_status}</span>
     ${u.industry_status === 'pending' ? html`<span class="mms-row">${postButton(`/admin/industry/${u.id}`, 'Verify', ctx.csrf, {fields: {decision: 'verified'}})}${postButton(`/admin/industry/${u.id}`, 'Reject', ctx.csrf, {fields: {decision: 'rejected'}, cls: 'secondary'})}</span>` : ''}` : '',
    isAdmin && !u.bootstrap ? html`<form method="post" action="/admin/users/${u.id}/roles" class="mms-row">${csrfField(ctx.csrf)}${ROLES.map(role => html`<label class="mms-check"><input type="checkbox" name="role" value="${role}"${u.roles.includes(role) ? html` checked` : ''}><span>${role}</span></label>`)}<button type="submit" class="secondary">Save roles</button></form>` : '']))}`);
 });
 r.post('/admin/users/:id/roles', async ctx => {
  admin(ctx);
  const id = int(ctx.params.id, {min: 1});
  const u = await db.one('SELECT * FROM users WHERE id=$1', [id]);
  if (!u || u.bootstrap) throw new HttpError(400, 'Roles of this account cannot be changed here');
  const roles = [].concat(ctx.form.role || []).filter(x => ROLES.includes(x));
  if (id === ctx.user.id && !roles.includes('admin')) throw new HttpError(400, 'You cannot remove your own admin role');
  await db.tx(async q => {
   await q.query('DELETE FROM user_roles WHERE user_id=$1', [id]);
   for (const role of roles) await q.query('INSERT INTO user_roles(user_id,role) VALUES ($1,$2)', [id, role]);
  });
  await audit(db, ctx.user.id, 'roles.set', {userId: id, roles});
  back(ctx, '/admin/users', 'Roles saved.');
 });
 r.post('/admin/industry/:id', async ctx => {
  staff(ctx);
  const id = int(ctx.params.id, {min: 1});
  const decision = oneOf(ctx.form.decision, ['verified', 'rejected'], 'decision');
  const p = await db.one('UPDATE industry_profiles SET status=$2, decided_at=now() WHERE user_id=$1 RETURNING *', [id, decision]);
  if (!p) throw new HttpError(404, 'Not found');
  if (decision === 'verified') await db.query(`INSERT INTO user_roles(user_id,role) VALUES ($1,'industry') ON CONFLICT DO NOTHING`, [id]);
  else await db.query(`DELETE FROM user_roles WHERE user_id=$1 AND role='industry'`, [id]);
  await notify(db, id, decision === 'verified' ? 'Your industry account is verified.' : 'Your industry verification request was not approved.');
  await audit(db, ctx.user.id, 'industry.' + decision, {userId: id});
  back(ctx, '/admin/users', 'Industry request ' + decision + '.');
 });

 // ---------- sponsors ----------
 r.get('/admin/sponsors', async ctx => {
  staff(ctx);
  const rows = await db.all('SELECT * FROM sponsors ORDER BY id DESC');
  ctx.page('Sponsors', html`<section class="mms-hero"><h1>Sponsors</h1><p>Listed on the public sponsor page. No payments are taken.</p></section>
   ${table(['Sponsor', 'Active', ''], rows.map(s => [s.name, s.active ? 'Yes' : 'No', postButton(`/admin/sponsors/${s.id}/toggle`, s.active ? 'Hide' : 'Show', ctx.csrf, {cls: 'secondary'})]), {empty: 'No sponsors.'})}
   <form method="post" action="/admin/sponsors" class="mms-card">${csrfField(ctx.csrf)}${field('Name', 'name', {required: true})}${field('Website (https)', 'url', {type: 'url'})}${textarea('Blurb', 'blurb')}<button type="submit">Add sponsor</button></form>`);
 });
 r.post('/admin/sponsors', async ctx => {
  staff(ctx);
  const url = text(ctx.form.url, {max: 300});
  if (url && !/^https:\/\/[^\s<>"]+$/.test(url)) throw new HttpError(400, 'Website must be an https link');
  await db.query('INSERT INTO sponsors(name,url,blurb) VALUES ($1,$2,$3)', [text(ctx.form.name, {min: 1, max: 120, name: 'Name'}), url, text(ctx.form.blurb, {max: 600})]);
  back(ctx, '/admin/sponsors', 'Sponsor added.');
 });
 r.post('/admin/sponsors/:id/toggle', async ctx => {
  staff(ctx);
  await db.query('UPDATE sponsors SET active = NOT active WHERE id=$1', [int(ctx.params.id, {min: 1})]);
  back(ctx, '/admin/sponsors', 'Sponsor updated.');
 });

 r.get('/t/:tenant/organizer', async ctx => {
  staff(ctx);
  const {tenantId, eventId, draftService, renderDraftSettingsEditor} = app.config;
  if (ctx.params.tenant !== tenantId || !draftService) throw new HttpError(404, 'Not found');
  const principal = {verified: true, subject: 'user-' + ctx.user.id, tenantId, roles: new Set(['producer', 'member'])};
  const draft = await draftService.read({principal, tenantId, eventId});
  ctx.page('Competition defaults', html`<section class="mms-hero"><p class="mms-eyebrow">MMS-04 defaults</p><h1>Competition draft defaults</h1><p>Template values for new events. Edit through <code>PUT /api/t/${tenantId}/events/${eventId}/draft-settings</code> (operator token or a producer session).</p></section>${{__html: renderDraftSettingsEditor(draft)}}`);
 });

 r.get('/admin/audit', async ctx => {
  admin(ctx);
  const rows = await db.all('SELECT a.*, u.email FROM audit_log a LEFT JOIN users u ON u.id=a.actor_user_id ORDER BY a.id DESC LIMIT 200');
  ctx.page('Audit log', html`<section class="mms-hero"><h1>Audit log</h1></section>${table(['When', 'Who', 'Action', 'Detail'], rows.map(a => [fmtDate(a.at), a.email || 'system', a.action, JSON.stringify(a.detail)]))}`);
 });
}
