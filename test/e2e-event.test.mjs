import test from 'node:test';
import assert from 'node:assert/strict';
import {DB_URL, ADMIN_TOKEN, freshApp, client, PNG, PDF} from './helpers.mjs';

const skip = !DB_URL && 'TEST_DATABASE_URL not set';
const id = (loc, re) => Number(re.exec(loc)[1]);

/** MMS-08 scripted realistic event through the real HTTP surface on Postgres. */
test('MMS-08 scripted event: apply, review, judge, vote, results, archive, industry discovery, privacy controls', {skip}, async t => {
 const app = await freshApp(t);
 const admin = client(app.base, '10.0.0.1');
 assert.equal((await admin.login('admin', ADMIN_TOKEN)).location, '/account');
 assert.match((await admin.get('/account')).body, /admin, producer/);

 // Applications are closed and the switch refuses until privacy details exist.
 assert.match((await admin.get('/apply')).body, /Applications are not open/);
 let r = await admin.post('/admin/settings/applications', {open: '1'});
 assert.equal(r.flash.kind, 'error');
 assert.match(r.flash.text, /operator name, privacy contact, retention days, consent version/);
 assert.equal((await (await fetch(app.base + '/health')).json()).applicationsOpen, false);
 await admin.get('/admin/settings');
 const settings = {operator_name: 'Synthetic Test Operator', privacy_contact: 'privacy@example.test', retention_days: '30', consent_version: 'test-v1', privacy_notice: 'Test notice.', discovery_enabled: 'on', vote_min_account_minutes: '0', vote_ip_cap: '25', upload_max_kb: '64'};
 r = await admin.post('/admin/settings', {...settings, retention_days: ''});
 r = await admin.post('/admin/settings/applications', {open: '1'});
 assert.match(r.flash.text, /retention days/);
 await admin.post('/admin/settings', settings);
 r = await admin.post('/admin/settings/applications', {open: '1'});
 assert.equal(r.flash.text, 'Applications are open.');
 assert.equal((await (await fetch(app.base + '/health')).json()).applicationsOpen, true);

 // Event with MMS defaults; audience voting at 20%.
 await admin.get('/admin/events');
 r = await admin.post('/admin/events', {title: 'Autumn Monologue Night', slug: 'autumn-night', starts_at: '2026-12-01T19:00', venue: 'Studio A', description: 'Test event', preset: 'on'});
 const eventId = id(r.location, /\/admin\/events\/(\d+)/);
 r = await admin.post(`/admin/events/${eventId}`, {title: 'Autumn Monologue Night', starts_at: '2026-12-01T19:00', venue: 'Studio A', description: 'Test event', status: 'scheduled', published: 'on', stream_url: 'https://www.youtube.com/watch?v=abcdefghijk', tie_rule: 'judges-then-votes', voting_enabled: 'on', votes_per_fan: '1', vote_weight: '20'});
 assert.equal(r.flash.text, 'Event saved.');

 // Accounts
 const ana = client(app.base, '10.0.0.2'), ben = client(app.base, '10.0.0.3'), judge = client(app.base, '10.0.0.4'), fan = client(app.base, '10.0.0.5'), scout = client(app.base, '10.0.0.6');
 await ana.register('Ana Stage', 'ana@example.test');
 await ben.register('Ben Stage', 'ben@example.test');
 await judge.register('Judge Jo', 'judge@example.test');
 await fan.register('Fan Fi', 'fan@example.test');
 await scout.register('Scout Sam', 'scout@example.test');
 assert.equal((await fan.register('Dup', 'fan@example.test')).status, 303);

 // Applicant submits with uploads and consent; invalid uploads are refused.
 await ana.get('/apply');
 const appFields = {event_id: String(eventId), stage_name: 'Ana Stage', pronouns: 'she/her', city: 'Springfield', bio: 'Classical and contemporary.', representation: 'agency', agency_name: 'Example Agency', union_status: 'union',
  monologue_title: 'Portia', monologue_source: 'Shakespeare', monologue_seconds: '90', reel_url: 'https://vimeo.com/123456789', consent_review: 'on', consent_discovery: 'on', consent_contact: 'on', consent_publication: 'on'};
 r = await ana.post('/apply', appFields, {multipart: true, files: {headshot: {data: Buffer.from('not an image'), type: 'image/png', name: 'h.png'}}});
 assert.match(r.flash.text, /JPEG, PNG or WebP/);
 r = await ana.post('/apply', {...appFields, reel_url: 'https://evil.example/reel'}, {multipart: true});
 assert.match(r.flash.text, /YouTube, Vimeo or SoundCloud/);
 r = await ana.post('/apply', {...appFields, consent_review: ''}, {multipart: true});
 assert.match(r.flash.text, /review consent is required/);
 r = await ana.post('/apply', appFields, {multipart: true, files: {headshot: {data: Buffer.alloc(70 * 1024, 0), type: 'image/png', name: 'big.png'}}});
 assert.match(r.flash.text, /upload limit/);
 r = await ana.post('/apply', appFields, {multipart: true, files: {headshot: {data: PNG, type: 'image/png', name: 'h.png'}, resume: {data: PDF, type: 'application/pdf', name: 'cv.pdf'}}});
 assert.equal(r.flash.text, 'Application submitted.');
 const anaApp = id(r.location, /applications\/(\d+)/);
 const anaPage = await ana.get('/account/applications/' + anaApp);
 assert.match(anaPage.body, /Consent version test-v1/);
 const mediaIds = [...anaPage.body.matchAll(/href="\/media\/(\d+)"/g)].map(m => m[1]);
 assert.equal(mediaIds.length, 2);
 const own = await ana.get('/media/' + mediaIds[0]);
 assert.equal(own.status, 200);
 assert.equal(own.headers.get('content-type'), 'image/png');
 r = await ben.post('/apply', {...appFields, stage_name: 'Ben Stage', monologue_title: 'Hamlet', reel_url: 'https://youtu.be/abcdefghijk', consent_discovery: '', consent_contact: '', consent_publication: ''}, {multipart: true});
 const benApp = id(r.location, /applications\/(\d+)/);

 // Private media is not visible to other users or anonymous visitors.
 assert.equal((await fan.get('/media/' + mediaIds[0])).status, 404);
 assert.equal((await client(app.base, '10.0.0.9').get('/media/' + mediaIds[0])).status, 303);

 // Producer review accepts both into the event.
 assert.match((await admin.get('/admin/applications/' + anaApp)).body, /Example Agency/);
 assert.equal((await fan.get('/admin/applications/' + anaApp)).status, 403);
 for (const a of [anaApp, benApp]) {
  r = await admin.post('/admin/applications/' + a, {status: 'accepted', event_id: String(eventId), notes: 'Strong', notify: 'on'});
  assert.equal(r.flash.text, 'Decision saved.');
 }
 assert.match((await ana.get('/account')).body, /now: accepted/);

 // Judge role + assignment
 await admin.get('/admin/users');
 const judgeRow = (await app.pool.query(`SELECT id FROM users WHERE email='judge@example.test'`)).rows[0].id;
 await admin.post(`/admin/users/${judgeRow}/roles`, {role: ['judge', 'fan']});
 r = await admin.post(`/admin/events/${eventId}/judges`, {email: 'judge@example.test'});
 assert.equal(r.flash.text, 'Judge assigned.');

 // Build qualifier heat with both entrants
 const ev = await admin.get('/admin/events/' + eventId);
 const roundIds = [...ev.body.matchAll(/action="\/admin\/rounds\/(\d+)\/heats"/g)].map(m => Number(m[1]));
 assert.equal(roundIds.length, 2);
 const ev2 = await admin.get('/admin/events/' + eventId);
 const qHeat = Number(/action="\/admin\/heats\/(\d+)\/place"/.exec(ev2.body)[1]);
 const entrants = (await app.pool.query('SELECT id, display_name FROM entrants WHERE event_id=$1 ORDER BY id', [eventId])).rows;
 for (const en of entrants) assert.equal((await admin.post(`/admin/heats/${qHeat}/place`, {entrant_id: String(en.id)})).flash.text, 'Entrant placed.');
 assert.match((await admin.post(`/admin/heats/${qHeat}/place`, {entrant_id: String(entrants[0].id)})).flash.text, /already placed/);

 // Run the live heat: timer per performer
 r = await admin.post(`/admin/heats/${qHeat}/timer`, {action: 'start', entry: '1'});
 assert.match(r.flash.text, /Set the heat live/);
 await admin.post(`/admin/heats/${qHeat}/status`, {status: 'live'});
 const entries = (await app.pool.query('SELECT id, entrant_id FROM heat_entries WHERE heat_id=$1 ORDER BY id', [qHeat])).rows;
 for (const he of entries) {
  assert.equal((await admin.post(`/admin/heats/${qHeat}/timer`, {action: 'start', entry: String(he.id)})).flash.text, 'Timer updated.');
  await admin.post(`/admin/heats/${qHeat}/timer`, {action: 'pause'});
  await admin.post(`/admin/heats/${qHeat}/timer`, {action: 'resume'});
  await admin.post(`/admin/heats/${qHeat}/timer`, {action: 'stop'});
 }
 assert.ok((await app.pool.query(`SELECT count(*)::int n FROM heat_entries WHERE heat_id=$1 AND status='done' AND performed_ms >= 0`, [qHeat])).rows[0].n === 2);
 const live = await fan.get('/events/autumn-night');
 assert.match(live.body, /Live now/);
 assert.match(live.body, /youtube-nocookie\.com\/embed\/abcdefghijk/);

 // Judge scoring (rubric bounds enforced); fan cannot score.
 const crit = (await app.pool.query('SELECT id FROM criteria WHERE event_id=$1 ORDER BY position', [eventId])).rows.map(c => c.id);
 assert.equal(crit.length, 3);
 await judge.get('/judge/heats/' + qHeat);
 r = await judge.post('/judge/entries/' + entries[0].id, {['c' + crit[0]]: '11'});
 assert.match(r.flash.text, /between 0 and 10/);
 await judge.post('/judge/entries/' + entries[0].id, {['c' + crit[0]]: '9', ['c' + crit[1]]: '8', ['c' + crit[2]]: '9'});
 await judge.post('/judge/entries/' + entries[1].id, {['c' + crit[0]]: '7', ['c' + crit[1]]: '7', ['c' + crit[2]]: '6'});
 assert.match((await fan.post('/judge/entries/' + entries[0].id, {['c' + crit[0]]: '1'})).flash.text, /do not have access/);

 // Audience voting with anti-abuse limits
 await admin.post(`/admin/heats/${qHeat}/voting`, {open: '1'});
 assert.match((await fan.get('/vote')).body, /Vote for Ben Stage/);
 r = await fan.post(`/vote/${qHeat}`, {entry: String(entries[1].id)});
 assert.match(r.flash.text, /Vote recorded/);
 r = await fan.post(`/vote/${qHeat}`, {entry: String(entries[0].id)});
 assert.match(r.flash.text, /used all 1 vote/);
 r = await ana.post(`/vote/${qHeat}`, {entry: String(entries[0].id)});
 assert.match(r.flash.text, /own heat/);
 r = await judge.post(`/vote/${qHeat}`, {entry: String(entries[0].id)});
 assert.match(r.flash.text, /Judges cannot/);
 r = await scout.post(`/vote/${qHeat}`, {entry: String(entries[1].id)}, {noCsrf: true});
 assert.equal(r.status, 403);
 r = await client(app.base, '10.0.0.10').post(`/vote/${qHeat}`, {entry: String(entries[1].id)});
 assert.equal(r.location, '/login?next=/vote');

 // Results: judges 80%, votes 20%; Ana leads on judges, Ben has the only vote.
 r = await admin.post(`/admin/heats/${qHeat}/results`);
 assert.equal(r.flash.text, 'Results computed.');
 const res = (await app.pool.query('SELECT entrant_id, rank, vote_count, combined::float FROM results WHERE heat_id=$1 ORDER BY rank', [qHeat])).rows;
 // Ana judges 86.5 → 69.2 combined; Ben judges 67.5 and the only vote → 54 + 20 = 74: Ben ranks first.
 assert.deepEqual(res.map(x => [Number(x.entrant_id), x.rank, x.vote_count, x.combined]), [[Number(entrants[1].id), 1, 1, 74], [Number(entrants[0].id), 2, 0, 69.2]]);
 await admin.post(`/admin/heats/${qHeat}/finalize`);
 assert.equal((await admin.post(`/admin/heats/${qHeat}/timer`, {action: 'start', entry: String(entries[0].id)})).flash.text, 'Set the heat live before running the timer');
 r = await admin.post(`/admin/rounds/${roundIds[0]}/advance`);
 assert.match(r.flash.text, /2 entrant\(s\) advanced/);

 // Final round
 const fHeat = (await app.pool.query('SELECT id FROM heats WHERE round_id=$1', [roundIds[1]])).rows[0].id;
 await admin.post(`/admin/heats/${fHeat}/status`, {status: 'live'});
 const fEntries = (await app.pool.query('SELECT id, entrant_id FROM heat_entries WHERE heat_id=$1 ORDER BY id', [fHeat])).rows;
 await admin.post(`/admin/heats/${fHeat}/timer`, {action: 'start', entry: String(fEntries[0].id)});
 await admin.post(`/admin/heats/${fHeat}/timer`, {action: 'stop'});
 await admin.post(`/admin/entries/${fEntries[1].id}/mark`, {status: 'no_show'});
 for (const c of crit) await judge.post('/judge/entries/' + fEntries[0].id, {['c' + c]: '8'});
 await admin.post(`/admin/heats/${fHeat}/results`);
 await admin.post(`/admin/heats/${fHeat}/finalize`);
 const champ = fEntries[0].entrant_id;
 for (const he of fEntries) await admin.post(`/admin/entries/${he.id}/recording`, {recording_url: 'https://www.youtube.com/watch?v=zyxwvutsrqp', captions: 'Corrected transcript text.', captions_corrected: 'on'});
 r = await admin.post(`/admin/events/${eventId}/finalize`);
 assert.match(r.flash.text, /champion recorded/);
 const champName = (await app.pool.query('SELECT display_name FROM entrants WHERE id=$1', [champ])).rows[0].display_name;
 assert.match((await fan.get('/champions')).body, new RegExp(champName));
 const archive = await fan.get('/archive');
 assert.match(archive.body, /Autumn Monologue Night/);
 const page = await fan.get('/events/autumn-night');
 assert.match(page.body, /Champion:<\/strong> /);
 // Only the performer with publication consent (Ana) has a public recording.
 const recordings = [...page.body.matchAll(/<h4>([^<]+) — recording<\/h4>/g)].map(m => m[1]);
 assert.deepEqual([...new Set(recordings)], ['Ana Stage']);
 assert.doesNotMatch(page.body, /Example Agency|ana@example\.test|Strong/);

 // Industry discovery: verification, consented search only, save, contact permission
 assert.equal((await scout.get('/industry/performers/' + anaApp)).status, 403);
 await scout.get('/industry');
 await scout.post('/industry/verify', {company: 'Casting Co', title: 'Casting Director', website: 'https://casting.example'});
 const scoutId = (await app.pool.query(`SELECT id FROM users WHERE email='scout@example.test'`)).rows[0].id;
 await admin.get('/admin/users');
 assert.equal((await admin.post('/admin/industry/' + scoutId, {decision: 'verified'})).flash.text, 'Industry request verified.');
 await scout.get('/account');
 const search = await scout.get('/industry?q=Stage');
 assert.match(search.body, /Ana Stage/);
 assert.doesNotMatch(search.body, /Ben Stage/);
 assert.equal((await scout.get('/industry/performers/' + benApp)).status, 404);
 const prof = await scout.get('/industry/performers/' + anaApp);
 assert.doesNotMatch(prof.body, /ana@example\.test|Strong/);
 assert.equal((await scout.get('/media/' + mediaIds[0])).status, 200);
 await scout.post(`/industry/performers/${anaApp}/save`);
 assert.match((await scout.get('/industry/saved')).body, /Ana Stage/);
 r = await scout.post(`/industry/performers/${anaApp}/contact`, {message: 'We would like to discuss a role.'});
 assert.match(r.flash.text, /Request sent/);
 const acct = await ana.get('/account');
 const reqId = Number(/action="\/account\/contact\/(\d+)"/.exec(acct.body)[1]);
 assert.equal((await fan.post('/account/contact/' + reqId, {decision: 'approved'})).status, 303);
 await ana.post('/account/contact/' + reqId, {decision: 'approved'});
 assert.match((await scout.get('/industry/performers/' + anaApp)).body, /ana@example\.test/);

 // Opt-out removes discovery, saved entries and contact visibility immediately.
 await ana.get('/account/applications/' + anaApp);
 await ana.post(`/account/applications/${anaApp}/consent`, {consent_publication: 'on'});
 assert.equal((await scout.get('/industry/performers/' + anaApp)).status, 404);
 assert.doesNotMatch((await scout.get('/industry/saved')).body, /Ana Stage/);
 assert.equal((await scout.get('/media/' + mediaIds[0])).status, 404);

 // Cross-role negatives
 for (const p of ['/admin', '/admin/settings', '/admin/events', '/judge']) assert.equal((await fan.get(p)).status, 403, p);
 assert.equal((await ben.get('/account/applications/' + anaApp)).status, 404);
 assert.match((await scout.post('/admin/settings/applications', {open: '0'})).flash.text, /do not have access/);

 // Account deletion removes applications and uploads
 await ben.get('/account');
 r = await ben.post('/account/delete', {confirm: 'DELETE'});
 assert.equal(r.location, '/');
 assert.equal((await app.pool.query(`SELECT count(*)::int n FROM applications WHERE id=$1`, [benApp])).rows[0].n, 0);
 assert.equal((await app.pool.query(`SELECT display_name FROM entrants WHERE event_id=$1 AND application_id IS NULL AND user_id IS NULL`, [eventId])).rows[0].display_name, 'Former entrant');

 // Changing privacy terms closes applications until re-confirmed.
 r = await admin.post('/admin/settings', {...settings, consent_version: 'test-v2'});
 assert.match(r.flash.text, /applications were closed/);
 assert.equal((await (await fetch(app.base + '/health')).json()).applicationsOpen, false);
 assert.match((await admin.get('/admin/audit')).body, /event\.finalized/);
});

test('bootstrap admin follows the env token and legacy bearer API still works', {skip}, async t => {
 const app = await freshApp(t, {origin: null});
 const c = client(app.base);
 assert.equal((await c.login('admin', 'wrong-password-123')).location, '/login');
 assert.equal((await c.login('admin', ADMIN_TOKEN)).location, '/account');
 const {ensureBootstrapAdmin} = await import('../src/main.mjs');
 const {withDb} = await import('../app/db.mjs');
 await ensureBootstrapAdmin(withDb(app.pool), undefined);
 assert.equal((await app.pool.query(`SELECT disabled FROM users WHERE email='admin'`)).rows[0].disabled, true);
 assert.equal((await c.get('/admin')).status, 303);
});

test('login is rate limited and CSRF/cross-origin posts are rejected', {skip}, async t => {
 const app = await freshApp(t, {origin: 'https://mms.test'});
 const c = client(app.base, '10.1.1.1');
 await c.get('/login');
 let last;
 for (let i = 0; i < 11; i++) last = await c.post('/login', {email: 'nobody@example.test', password: 'x'.repeat(12)}, {headers: {origin: 'https://mms.test'}});
 assert.equal(last.status, 429);
 const evil = await c.post('/register', {name: 'X', email: 'x@example.test', password: 'y'.repeat(12)}, {headers: {origin: 'https://evil.example'}});
 assert.equal(evil.status, 403);
});

test('every console and public page renders without defects', {skip}, async t => {
 const app = await freshApp(t);
 const admin = client(app.base, '10.2.0.1');
 await admin.login('admin', ADMIN_TOKEN);
 await admin.post('/admin/events', {title: 'Render Check', slug: 'render-check', preset: 'on'});
 await admin.post('/admin/sponsors', {name: 'Example Sponsor', url: 'https://sponsor.example', blurb: 'Supports the stage.'});
 for (const p of ['/', '/watch', '/vote', '/archive', '/champions', '/sponsor', '/privacy', '/apply', '/account', '/admin', '/admin/settings', '/admin/events', '/admin/events/1', '/admin/heats/1', '/admin/applications', '/admin/users', '/admin/sponsors', '/admin/audit', '/t/mms/organizer', '/industry', '/t/demo/archive']) {
  const r = await admin.get(p);
  assert.ok([200].includes(r.status), p + ' ' + r.status);
  assert.doesNotMatch(r.body, /M[a-z]+ M[a-z]+ S[a-z]+/, p);
 }
 assert.equal((await admin.get('/admin/heats/999')).status, 404);
});
