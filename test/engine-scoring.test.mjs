import test from 'node:test';
import assert from 'node:assert/strict';
import {computeHeatResults, timerState} from '../app/engine/scoring.mjs';
import {mediaLink, embedUrl, validateUpload, sniff} from '../app/media.mjs';
import {privacyGaps} from '../app/settings.mjs';
import {assertEngine, createExternalEngine, ENGINE_METHODS} from '../app/engine/adapter.mjs';
import {createBuiltinEngine} from '../app/engine/builtin.mjs';
import {parseMultipart} from '../app/http.mjs';

const criteria = [{id: 1, name: 'Delivery', weight_bps: 6000, max_score: 10, position: 0}, {id: 2, name: 'Presence', weight_bps: 4000, max_score: 10, position: 1}];
const entries = [{id: 11, entrant_id: 1, status: 'done'}, {id: 12, entrant_id: 2, status: 'done'}, {id: 13, entrant_id: 3, status: 'no_show'}];
const s = (he, judge, c, v) => ({heat_entry_id: he, judge_user_id: judge, criterion_id: c, value: v});

test('weighted rubric averages across judges and ranks no-shows last', () => {
 const {rows, unresolvedTie} = computeHeatResults({entries, criteria, scores: [s(11, 'a', 1, 10), s(11, 'a', 2, 5), s(11, 'b', 1, 8), s(11, 'b', 2, 8), s(12, 'a', 1, 6), s(12, 'a', 2, 6)]});
 assert.equal(unresolvedTie, false);
 assert.deepEqual(rows.map(r => [r.entrantId, r.rank, r.judgeScore]), [[1, 1, 80], [2, 2, 60], [3, 3, 0]]);
 assert.equal(rows[2].note, 'Did not perform');
});

test('audience vote weight blends vote share into the combined score', () => {
 const votes = [{heat_entry_id: 12}, {heat_entry_id: 12}, {heat_entry_id: 12}, {heat_entry_id: 11}];
 const {rows} = computeHeatResults({entries, criteria, scores: [s(11, 'a', 1, 10), s(11, 'a', 2, 10), s(12, 'a', 1, 8), s(12, 'a', 2, 8)], votes, votingEnabled: true, voteWeightBps: 5000});
 // 100*.5 + 25*.5 = 62.5 vs 80*.5 + 75*.5 = 77.5
 assert.deepEqual(rows.slice(0, 2).map(r => [r.entrantId, r.combined]), [[2, 77.5], [1, 62.5]]);
 const off = computeHeatResults({entries, criteria, scores: [s(11, 'a', 1, 10), s(11, 'a', 2, 10), s(12, 'a', 1, 8), s(12, 'a', 2, 8)], votes, votingEnabled: false, voteWeightBps: 5000});
 assert.equal(off.rows[0].entrantId, 1);
});

test('tie rules: manual review flags, manual order resolves, shared keeps rank, chained rules break', () => {
 const tied = [s(11, 'a', 1, 10), s(11, 'a', 2, 5), s(12, 'a', 1, 5), s(12, 'a', 2, 12.5)];
 const two = entries.slice(0, 2);
 // 60+20 = 80 vs 30+50 = 80
 let out = computeHeatResults({entries: two, criteria, scores: tied});
 assert.equal(out.unresolvedTie, true);
 assert.deepEqual(out.rows.map(r => r.rank), [1, 1]);
 out = computeHeatResults({entries: two, criteria, scores: tied, manualOrder: [2, 1]});
 assert.equal(out.unresolvedTie, false);
 assert.deepEqual(out.rows.map(r => r.entrantId), [2, 1]);
 out = computeHeatResults({entries: two, criteria, scores: tied, tieRule: 'shared'});
 assert.equal(out.unresolvedTie, false);
 assert.deepEqual(out.rows.map(r => [r.rank, r.note]), [[1, 'Shared rank'], [1, 'Shared rank']]);
 out = computeHeatResults({entries: two, criteria, scores: tied, tieRule: 'top-criterion'});
 assert.deepEqual(out.rows.map(r => [r.entrantId, r.rank]), [[1, 1], [2, 2]]);
 out = computeHeatResults({entries: two, criteria, scores: tied, tieRule: 'votes-then-judges', votes: [{heat_entry_id: 12}], votingEnabled: false});
 assert.deepEqual(out.rows.map(r => r.entrantId), [2, 1]);
 assert.throws(() => computeHeatResults({entries: two, criteria, scores: tied, tieRule: 'coin-flip'}), /Unknown tie rule/);
});

test('timer state accounts for running and paused time', () => {
 const now = Date.parse('2026-01-01T00:01:00Z');
 assert.deepEqual(timerState({timer_running: true, timer_started_at: '2026-01-01T00:00:00Z', timer_elapsed_ms: 5000}, 60, now), {elapsedMs: 65000, remainingMs: -5000, running: true, overtime: true});
 assert.equal(timerState({timer_running: false, timer_elapsed_ms: 20000}, 60, now).remainingMs, 40000);
});

test('media links accept only YouTube, Vimeo and SoundCloud over https and produce safe embeds', () => {
 assert.equal(mediaLink(''), null);
 assert.throws(() => mediaLink('', {required: true}), /required/);
 assert.throws(() => mediaLink('http://youtube.com/watch?v=abcdefghijk'), /https/);
 assert.throws(() => mediaLink('https://example.com/video'), /YouTube, Vimeo or SoundCloud/);
 assert.throws(() => mediaLink('javascript:alert(1)'), /https/);
 assert.equal(embedUrl('https://youtu.be/abcdefghijk'), 'https://www.youtube-nocookie.com/embed/abcdefghijk');
 assert.equal(embedUrl('https://www.youtube.com/watch?v=abcdefghijk'), 'https://www.youtube-nocookie.com/embed/abcdefghijk');
 assert.equal(embedUrl('https://vimeo.com/123456789'), 'https://player.vimeo.com/video/123456789');
 assert.match(embedUrl('https://soundcloud.com/artist/track'), /^https:\/\/w\.soundcloud\.com\/player\/\?url=https%3A/);
});

test('uploads are sniffed by content and capped by size', () => {
 const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(10)]);
 assert.equal(sniff(png), 'image/png');
 assert.equal(validateUpload({data: png}, 'headshot', 1024).mime, 'image/png');
 assert.throws(() => validateUpload({data: png}, 'resume', 1024), /PDF/);
 assert.throws(() => validateUpload({data: Buffer.from('<svg/>')}, 'headshot', 1024), /JPEG, PNG or WebP/);
 assert.throws(() => validateUpload({data: png}, 'headshot', 8), /upload limit/);
 assert.equal(validateUpload(undefined, 'headshot', 10), null);
});

test('privacy gate lists every owner decision that is missing', () => {
 assert.deepEqual(privacyGaps({}), ['operator name', 'privacy contact', 'retention days', 'consent version']);
 assert.deepEqual(privacyGaps({operator_name: 'X', privacy_contact: 'p@x', retention_days: 30, consent_version: 'v1'}), []);
 assert.deepEqual(privacyGaps({operator_name: 'X', privacy_contact: 'p@x', retention_days: 0, consent_version: 'v1'}), ['retention days']);
});

test('engine adapters implement the full contract; external adapter fails closed', async () => {
 assert.ok(assertEngine(createBuiltinEngine({})));
 const ext = createExternalEngine('https://engine.example', {fetchImpl: async () => ({ok: false})});
 assert.ok(assertEngine(ext));
 assert.deepEqual(await ext.health(), {connected: false, kind: 'external'});
 await assert.rejects(ext.createEvent({}), /not implemented/);
 assert.throws(() => assertEngine({}), /missing/);
 assert.ok(ENGINE_METHODS.includes('castVote'));
});

test('multipart parser extracts fields and files', () => {
 const b = '----x';
 const body = Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="a"\r\n\r\nhello\r\n--${b}\r\nContent-Disposition: form-data; name="f"; filename="x.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1\r\n--${b}--\r\n`);
 const out = parseMultipart(body, 'multipart/form-data; boundary=' + b);
 assert.equal(out.fields.a, 'hello');
 assert.equal(out.files.f.data.toString(), '%PDF-1');
});
