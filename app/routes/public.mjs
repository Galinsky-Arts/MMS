import {HttpError, int} from '../http.mjs';
import {html, fmtDate, table} from '../views/layout.mjs';
import {eventCard, renderEventPage, voteForm} from '../views/event.mjs';
import {privacyGaps} from '../settings.mjs';

/** MMS-07 public site: home, watch, event pages, vote, archive, champions, sponsor, privacy. */
export function publicRoutes(r, app) {
 const {engine, settings, db} = app;

 r.get('/', async ctx => {
  const events = await engine.listEvents({publishedOnly: true});
  const live = events.filter(e => e.status === 'live'), upcoming = events.filter(e => e.status === 'scheduled');
  const champs = (await engine.champions()).slice(0, 3);
  const s = await settings.all();
  ctx.page('Home', html`<section class="mms-hero"><p class="mms-eyebrow">Timed monologue competition</p><h1>Make your moment count.</h1>
   <p>Watch live timed monologues, vote when audience voting is open, and follow every champion.</p>
   <p class="mms-row"><a class="mms-button" href="/watch">Watch</a> <a href="/apply">${s.applications_open ? 'Applications are open — apply' : 'Application information'}</a></p></section>
   ${live.length ? html`<section><h2>Live now</h2><div class="mms-grid">${live.map(eventCard)}</div></section>` : ''}
   <section><h2>Upcoming</h2>${upcoming.length ? html`<div class="mms-grid">${upcoming.map(eventCard)}</div>` : html`<p class="mms-muted">No upcoming events are published yet.</p>`}</section>
   <section><h2>Recent champions</h2>${champs.length ? html`<ul>${champs.map(c => html`<li><a href="/events/${c.slug}">${c.title}</a>: ${c.display_name}</li>`)}</ul>` : html`<p class="mms-muted">No champions have been crowned yet.</p>`}</section>`);
 });

 r.get('/watch', async ctx => {
  const events = await engine.listEvents({publishedOnly: true, statuses: ['live', 'scheduled']});
  const live = events.filter(e => e.status === 'live');
  ctx.page('Watch', html`<section class="mms-hero"${live.length ? html` data-refresh="20"` : ''}><p class="mms-eyebrow">Watch</p><h1>A stage for every moment.</h1>
   <p>Live event status, the current performer and the monologue timer update on each event page.</p></section>
   <section><h2>Live now</h2>${live.length ? html`<div class="mms-grid">${live.map(eventCard)}</div>` : html`<p class="mms-muted">No event is live right now.</p>`}</section>
   <section><h2>Scheduled</h2>${events.filter(e => e.status === 'scheduled').map(eventCard)}</section>
   <p><a href="/archive">Browse past events and recordings</a></p>`);
 });

 r.get('/events/:slug', async ctx => {
  const e = await engine.publicEvent(ctx.params.slug);
  if (!e) throw new HttpError(404, 'Event not found');
  const open = new Set((await engine.openVotes()).map(h => Number(h.id)));
  ctx.page(e.title, renderEventPage(e, {user: ctx.user, csrf: ctx.csrf, voteHeats: open}));
 });
 r.get('/archive/:slug', ctx => ctx.redirect('/events/' + ctx.params.slug));

 r.get('/vote', async ctx => {
  const heats = await engine.openVotes();
  const blocks = [];
  for (const h of heats) blocks.push(voteForm(h, await engine.entries(h.id), ctx.csrf, null));
  ctx.page('Vote', html`<section class="mms-hero"><p class="mms-eyebrow">Audience vote</p><h1>Be part of the audience.</h1>
   <p>Audience voting is optional for each event. Voting needs a signed-in account; limits per account and per network keep the count fair.</p></section>
   ${!ctx.user && heats.length ? html`<p class="mms-banner"><a href="/login?next=/vote">Sign in</a> or <a href="/register">create a free account</a> to vote.</p>` : ''}
   ${blocks.length ? blocks : html`<section class="mms-card"><h2>No voting round is open</h2><p>Votes open during live heats when an event enables audience voting.</p></section>`}`);
 });

 r.post('/vote/:heatId', async ctx => {
  if (!ctx.user) return ctx.redirect('/login?next=/vote', {kind: 'error', text: 'Sign in to vote.'});
  if (!app.limiter('vote:' + ctx.ipHash, 30, 60000)) throw new HttpError(429, 'Too many votes from this network; wait a minute');
  const s = await settings.all();
  const out = await engine.castVote({user: ctx.user, heatId: int(ctx.params.heatId, {min: 1}), heatEntryId: int(ctx.form.entry, {min: 1}), ipHash: ctx.ipHash, minAccountMinutes: s.vote_min_account_minutes, ipCap: s.vote_ip_cap});
  ctx.redirect('/vote', `Vote recorded. ${out.remaining} vote(s) left in this heat.`);
 });

 r.get('/archive', async ctx => {
  const events = await engine.listEvents({publishedOnly: true, statuses: ['completed', 'archived']});
  ctx.page('Archive', html`<section class="mms-hero"><p class="mms-eyebrow">Archive</p><h1>Remember the performances.</h1><p>Confirmed results, champions and recordings cleared for publication by each performer.</p></section>
   ${events.length ? html`<div class="mms-grid">${events.map(eventCard)}</div>` : html`<section class="mms-card"><h2>No results have been published</h2><p>A clearly labelled <a href="/t/demo/archive">synthetic demonstration archive</a> previews the layout with fictional data.</p></section>`}
   <p><a href="/champions">Champion history</a></p>`);
 });

 r.get('/champions', async ctx => {
  const champs = await engine.champions();
  ctx.page('Champions', html`<section class="mms-hero"><p class="mms-eyebrow">Champion history</p><h1>Every champion.</h1></section>
   ${table(['Event', 'Champion', 'Finalized'], champs.map(c => [html`<a href="/events/${c.slug}">${c.title}</a>`, c.display_name, fmtDate(c.finalized_at)]), {empty: 'No champions yet.'})}`);
 });

 r.get('/sponsor', async ctx => {
  const sponsors = await db.all('SELECT * FROM sponsors WHERE active ORDER BY name');
  const s = await settings.all();
  ctx.page('Sponsor', html`<section class="mms-hero"><p class="mms-eyebrow">Sponsor</p><h1>Support the stage.</h1><p>MMS has no paywall. Sponsors support events; watching and voting stay free.</p></section>
   <section><h2>Our sponsors</h2>${sponsors.length ? html`<div class="mms-grid">${sponsors.map(sp => html`<article class="mms-card"><h3>${sp.url ? html`<a href="${sp.url}" rel="noopener noreferrer sponsored">${sp.name}</a>` : sp.name}</h3><p>${sp.blurb}</p></article>`)}</div>` : html`<p class="mms-muted">No sponsors are listed yet.</p>`}</section>
   <section class="mms-card"><h2>Become a sponsor</h2><p>${s.privacy_contact ? html`Contact ${s.operator_name || 'the organizers'} at ${s.privacy_contact}.` : 'Sponsorship contact details will be published by the organizers.'} No payment can be made on this site.</p></section>`);
 });

 r.get('/privacy', async ctx => {
  const s = await settings.all();
  const gaps = privacyGaps(s);
  ctx.page('Privacy', html`<section class="mms-hero"><p class="mms-eyebrow">Privacy</p><h1>How MMS handles your data</h1></section>
   ${gaps.length ? html`<section class="mms-card"><h2>Privacy details are not yet published</h2><p>The operator has not yet published privacy details, so applications are closed and no applicant data is collected.</p></section>`
    : html`<section class="mms-card mms-stack"><dl><dt>Operator</dt><dd>${s.operator_name}</dd><dt>Privacy contact</dt><dd>${s.privacy_contact}</dd><dt>Retention</dt><dd>Declined and withdrawn applications, with their uploads, are deleted ${s.retention_days} days after the decision.</dd><dt>Consent version</dt><dd>${s.consent_version}</dd></dl>
     ${s.privacy_notice ? html`<div>${s.privacy_notice.split(/\n{2,}/).map(p => html`<p>${p}</p>`)}</div>` : ''}</section>`}
   <section class="mms-card"><h2>Your controls</h2><ul><li>Industry discovery, contact requests and publication of recordings are separate opt-ins you can withdraw at any time from your account.</li><li>You can withdraw an application or delete your account and its uploads from <a href="/account">your account</a>.</li><li>Votes store a keyed hash of your network address only to enforce fair-voting limits.</li></ul></section>`);
 });
}
