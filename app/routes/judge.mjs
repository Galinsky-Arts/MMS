import {HttpError, int} from '../http.mjs';
import {html, csrfField, table, fmtMs} from '../views/layout.mjs';
import {timerState} from '../engine/scoring.mjs';
import {timerBlock} from '../views/event.mjs';

/** Industry judges score live heats against the event rubric. */
export function judgeRoutes(r, app) {
 const {engine} = app;
 r.get('/judge', async ctx => {
  ctx.require('judge');
  const events = await engine.judgeEvents(ctx.user.id);
  const blocks = [];
  for (const e of events) {
   const rounds = await engine.rounds(e.id);
   const heats = [];
   for (const rd of rounds) for (const h of await engine.heats(rd.id)) heats.push([rd, h]);
   blocks.push(html`<section class="mms-card"><h2>${e.title} <span class="mms-pill">${e.status}</span></h2>
    ${table(['Round', 'Heat', 'Status', ''], heats.map(([rd, h]) => [rd.name, h.name, h.status, h.status === 'live' ? html`<a href="/judge/heats/${h.id}">Score</a>` : '']), {empty: 'No heats yet.'})}</section>`);
  }
  ctx.page('Judge', html`<section class="mms-hero"><p class="mms-eyebrow">Industry judge</p><h1>Your events</h1><p>Scoring opens while a heat is live.</p></section>${blocks.length ? blocks : html`<p class="mms-muted">You are not assigned to any event yet.</p>`}`);
 });

 r.get('/judge/heats/:id', async ctx => {
  ctx.require('judge');
  const h = await engine.heat(int(ctx.params.id, {min: 1}));
  if (!(await engine.isJudge(h.event_id, ctx.user.id))) throw new HttpError(403, 'You are not a judge for this event');
  const e = await engine.event(h.event_id);
  const criteria = await engine.criteria(e.id), entries = await engine.entries(h.id), mine = await engine.scoresFor(h.id, ctx.user.id);
  const val = (he, c) => mine.find(s => Number(s.heat_entry_id) === Number(he.id) && Number(s.criterion_id) === Number(c.id))?.value ?? '';
  h.timer = timerState(h, h.time_limit_seconds);
  const current = entries.find(x => Number(x.id) === Number(h.timer_entry_id));
  ctx.page('Score ' + h.name, html`<section class="mms-hero"><p class="mms-eyebrow">${e.title} · ${h.round_name}</p><h1>${h.name}</h1><p>Status: ${h.status}. ${h.status !== 'live' ? 'Scores are read-only until the heat is live.' : ''}</p></section>
   ${h.status === 'live' ? timerBlock(h, h.time_limit_seconds, current) : ''}
   ${entries.map(he => html`<form method="post" action="/judge/entries/${he.id}" class="mms-card">${csrfField(ctx.csrf)}<h2>${he.display_name}</h2>
    <p class="mms-muted">${he.status.replace('_', '-')}${he.performed_ms ? ' · ' + fmtMs(he.performed_ms) : ''}${he.overtime ? ' · overtime' : ''}</p>
    <div class="mms-row">${criteria.map(c => html`<label class="mms-field"><span>${c.name} (0–${c.max_score}, weight ${c.weight_bps / 100}%)</span><input type="number" name="c${c.id}" min="0" max="${c.max_score}" step="0.5" value="${val(he, c)}"${h.status !== 'live' ? html` disabled` : ''}></label>`)}</div>
    ${h.status === 'live' && !['no_show', 'forfeit'].includes(he.status) ? html`<button type="submit">Save scores</button>` : ''}</form>`)}`);
 });

 r.post('/judge/entries/:id', async ctx => {
  ctx.require('judge');
  const values = {};
  for (const [k, v] of Object.entries(ctx.form)) { const m = /^c(\d{1,12})$/.exec(k); if (m) values[m[1]] = v; }
  const heId = int(ctx.params.id, {min: 1});
  await engine.submitScores(ctx.user.id, heId, values);
  const he = await app.db.one('SELECT heat_id FROM heat_entries WHERE id=$1', [heId]);
  ctx.redirect('/judge/heats/' + he.heat_id, 'Scores saved.');
 });
}
