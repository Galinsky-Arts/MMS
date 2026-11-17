import {HttpError} from '../http.mjs';
import {computeHeatResults, timerState, TIE_RULES} from './scoring.mjs';

/** Built-in competition engine on Postgres: events, rounds, heats, entrants, judges with
 * rubric scoring, timers, audience voting with anti-abuse limits, tie rules, results and archive.
 * It implements the CompetitionEngine adapter contract in ./adapter.mjs.
 */
const conflict = m => new HttpError(409, m);
const notFound = () => new HttpError(404, 'Not found');
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function createBuiltinEngine(db) {
 const event = async id => { const e = await db.one('SELECT * FROM events WHERE id=$1', [id]); if (!e) throw notFound(); return e; };
 const heatCtx = async (heatId, q = db) => {
  const h = await q.one(`SELECT h.*, r.time_limit_seconds, r.event_id, r.advance_count, r.position AS round_position, r.id AS round_id, r.name AS round_name
   FROM heats h JOIN rounds r ON r.id=h.round_id WHERE h.id=$1`, [heatId]);
  if (!h) throw notFound();
  return h;
 };
 const entriesOf = (heatId, q = db) => q.all(`SELECT he.*, en.display_name, en.user_id, en.publish_consent, en.status AS entrant_status
   FROM heat_entries he JOIN entrants en ON en.id=he.entrant_id WHERE he.heat_id=$1 ORDER BY he.position, he.id`, [heatId]);

 const api = {
  kind: 'builtin',
  async health() { await db.query('SELECT 1'); return {connected: true, kind: 'builtin'}; },

  // ----- events -----
  async listEvents({publishedOnly = false, statuses = null} = {}) {
   const cond = [], p = [];
   if (publishedOnly) cond.push('published');
   if (statuses) { p.push(statuses); cond.push(`status = ANY($${p.length})`); }
   return db.all(`SELECT * FROM events ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY COALESCE(starts_at, created_at) DESC, id DESC`, p);
  },
  event,
  async eventBySlug(slug) { return db.one('SELECT * FROM events WHERE slug=$1', [slug]); },
  async createEvent(d) {
   if (!SLUG.test(d.slug)) throw new HttpError(400, 'Slug must be lowercase letters, digits and hyphens');
   if (!Object.hasOwn(TIE_RULES, d.tie_rule || 'manual-review')) throw new HttpError(400, 'Unknown tie rule');
   try {
    return await db.tx(async q => {
     const e = await q.one(`INSERT INTO events(slug,title,description,venue,starts_at,tie_rule) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [d.slug, d.title, d.description || '', d.venue || '', d.starts_at || null, d.tie_rule || 'manual-review']);
     for (const [i, c] of (d.criteria || []).entries()) await q.query('INSERT INTO criteria(event_id,name,weight_bps,max_score,position) VALUES ($1,$2,$3,$4,$5)', [e.id, c.name, c.weight_bps, c.max_score || 10, i]);
     for (const [i, r] of (d.rounds || []).entries()) {
      const rd = await q.one('INSERT INTO rounds(event_id,position,name,kind,time_limit_seconds,advance_count) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [e.id, i + 1, r.name, r.kind, r.time_limit_seconds, r.advance_count ?? 1]);
      await q.query('INSERT INTO heats(round_id,position,name) VALUES ($1,1,$2)', [rd.id, r.name + ' heat 1']);
     }
     return e;
    });
   } catch (e) { if (e.code === '23505') throw conflict('That slug is already used'); throw e; }
  },
  async updateEvent(id, d) {
   const e = await event(id);
   if (d.tie_rule && !Object.hasOwn(TIE_RULES, d.tie_rule)) throw new HttpError(400, 'Unknown tie rule');
   if (d.status && !['draft', 'scheduled', 'live', 'completed', 'archived'].includes(d.status)) throw new HttpError(400, 'Invalid status');
   if (d.status === 'completed' && !e.finalized_at) throw conflict('Finalize results to complete an event');
   const f = {...e, ...d};
   return db.one(`UPDATE events SET title=$2, description=$3, venue=$4, starts_at=$5, status=$6, published=$7, voting_enabled=$8, votes_per_fan=$9,
     vote_weight_bps=$10, tie_rule=$11, stream_url=$12 WHERE id=$1 RETURNING *`,
    [id, f.title, f.description, f.venue, f.starts_at, f.status, f.published, f.voting_enabled, f.votes_per_fan, f.voting_enabled ? f.vote_weight_bps : 0, f.tie_rule, f.stream_url]);
  },
  async criteria(eventId) { return db.all('SELECT * FROM criteria WHERE event_id=$1 ORDER BY position, id', [eventId]); },
  async addCriterion(eventId, {name, weight_bps, max_score}) {
   await event(eventId);
   return db.one('INSERT INTO criteria(event_id,name,weight_bps,max_score,position) VALUES ($1,$2,$3,$4,(SELECT COALESCE(max(position),0)+1 FROM criteria WHERE event_id=$1)) RETURNING *', [eventId, name, weight_bps, max_score]);
  },
  async removeCriterion(eventId, criterionId) {
   const used = await db.one('SELECT 1 FROM scores WHERE criterion_id=$1 LIMIT 1', [criterionId]);
   if (used) throw conflict('Criterion already has scores');
   await db.query('DELETE FROM criteria WHERE id=$1 AND event_id=$2', [criterionId, eventId]);
  },
  async rounds(eventId) { return db.all('SELECT * FROM rounds WHERE event_id=$1 ORDER BY position', [eventId]); },
  async addRound(eventId, {name, kind, time_limit_seconds, advance_count}) {
   await event(eventId);
   const rd = await db.one(`INSERT INTO rounds(event_id,position,name,kind,time_limit_seconds,advance_count) VALUES ($1,(SELECT COALESCE(max(position),0)+1 FROM rounds WHERE event_id=$1),$2,$3,$4,$5) RETURNING *`,
    [eventId, name, kind, time_limit_seconds, advance_count]);
   await api.addHeat(rd.id, name + ' heat 1');
   return rd;
  },
  async heats(roundId) { return db.all('SELECT * FROM heats WHERE round_id=$1 ORDER BY position', [roundId]); },
  async addHeat(roundId, name) {
   return db.one(`INSERT INTO heats(round_id,position,name) VALUES ($1,(SELECT COALESCE(max(position),0)+1 FROM heats WHERE round_id=$1),$2) RETURNING *`, [roundId, name]);
  },
  async entrants(eventId) { return db.all('SELECT * FROM entrants WHERE event_id=$1 ORDER BY seed NULLS LAST, id', [eventId]); },
  async addEntrant(eventId, {display_name, user_id = null, application_id = null, publish_consent = false, seed = null}) {
   await event(eventId);
   try {
    return await db.one('INSERT INTO entrants(event_id,display_name,user_id,application_id,publish_consent,seed) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [eventId, display_name, user_id, application_id, publish_consent, seed]);
   } catch (e) { if (e.code === '23505') throw conflict('That account is already an entrant in this event'); throw e; }
  },
  async setEntrantStatus(entrantId, status) {
   if (!['active', 'withdrawn', 'disqualified'].includes(status)) throw new HttpError(400, 'Invalid status');
   await db.query('UPDATE entrants SET status=$2 WHERE id=$1', [entrantId, status]);
  },
  async placeEntrant(heatId, entrantId) {
   const h = await heatCtx(heatId);
   if (h.status === 'finalized') throw conflict('Heat is finalized');
   const en = await db.one('SELECT * FROM entrants WHERE id=$1 AND event_id=$2', [entrantId, h.event_id]);
   if (!en) throw new HttpError(400, 'Entrant is not in this event');
   const clash = await db.one('SELECT 1 FROM heat_entries he JOIN heats x ON x.id=he.heat_id WHERE x.round_id=$1 AND he.entrant_id=$2', [h.round_id, entrantId]);
   if (clash) throw conflict('Entrant is already placed in this round');
   return db.one(`INSERT INTO heat_entries(heat_id,entrant_id,position) VALUES ($1,$2,(SELECT COALESCE(max(position),0)+1 FROM heat_entries WHERE heat_id=$1)) RETURNING *`, [heatId, entrantId]);
  },
  async removeHeatEntry(heatEntryId) {
   const used = await db.one('SELECT 1 FROM scores WHERE heat_entry_id=$1 UNION SELECT 1 FROM votes WHERE heat_entry_id=$1 LIMIT 1', [heatEntryId]);
   if (used) throw conflict('Entry already has scores or votes; mark it no-show instead');
   await db.query('DELETE FROM heat_entries WHERE id=$1', [heatEntryId]);
  },
  async judges(eventId) { return db.all('SELECT u.id, u.display_name, u.email FROM judges j JOIN users u ON u.id=j.user_id WHERE j.event_id=$1 ORDER BY u.display_name', [eventId]); },
  async assignJudge(eventId, userId) {
   const ok = await db.one(`SELECT 1 FROM user_roles WHERE user_id=$1 AND role='judge'`, [userId]);
   if (!ok) throw new HttpError(400, 'That account does not have the judge role');
   await db.query('INSERT INTO judges(event_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [eventId, userId]);
  },
  async removeJudge(eventId, userId) { await db.query('DELETE FROM judges WHERE event_id=$1 AND user_id=$2', [eventId, userId]); },
  async isJudge(eventId, userId) { return Boolean(await db.one('SELECT 1 FROM judges WHERE event_id=$1 AND user_id=$2', [eventId, userId])); },
  async judgeEvents(userId) { return db.all('SELECT e.* FROM events e JOIN judges j ON j.event_id=e.id WHERE j.user_id=$1 ORDER BY e.id DESC', [userId]); },

  // ----- heats, timers -----
  heat: heatCtx,
  entries: entriesOf,
  async setHeatStatus(heatId, status) {
   const h = await heatCtx(heatId);
   if (h.status === 'finalized') throw conflict('Heat is finalized');
   if (!['pending', 'live'].includes(status)) throw new HttpError(400, 'Invalid status');
   await db.query('UPDATE heats SET status=$2 WHERE id=$1', [heatId, status]);
   if (status === 'live') {
    await db.query(`UPDATE rounds SET status='live' WHERE id=$1 AND status='pending'`, [h.round_id]);
    await db.query(`UPDATE events SET status='live' WHERE id=$1 AND status IN ('draft','scheduled')`, [h.event_id]);
   }
  },
  async timer(heatId, action, entryId = null) {
   return db.tx(async q => {
    const h = await q.one('SELECT h.*, r.time_limit_seconds FROM heats h JOIN rounds r ON r.id=h.round_id WHERE h.id=$1 FOR UPDATE OF h', [heatId]);
    if (!h) throw notFound();
    if (h.status !== 'live') throw conflict('Set the heat live before running the timer');
    const now = Date.now();
    const st = timerState(h, h.time_limit_seconds, now);
    if (action === 'start') {
     const e = await q.one('SELECT * FROM heat_entries WHERE id=$1 AND heat_id=$2', [entryId, heatId]);
     if (!e) throw new HttpError(400, 'Entry not in heat');
     if (h.timer_entry_id && h.timer_running) throw conflict('Stop the current performance first');
     if (!['pending', 'performing'].includes(e.status)) throw conflict('This entry has already performed');
     await q.query(`UPDATE heats SET timer_entry_id=$2, timer_started_at=now(), timer_elapsed_ms=0, timer_running=true WHERE id=$1`, [heatId, entryId]);
     await q.query(`UPDATE heat_entries SET status='performing' WHERE id=$1`, [entryId]);
    } else if (action === 'pause') {
     if (!h.timer_running) throw conflict('Timer is not running');
     await q.query('UPDATE heats SET timer_elapsed_ms=$2, timer_running=false, timer_started_at=NULL WHERE id=$1', [heatId, st.elapsedMs]);
    } else if (action === 'resume') {
     if (h.timer_running || !h.timer_entry_id) throw conflict('Nothing to resume');
     await q.query('UPDATE heats SET timer_running=true, timer_started_at=now() WHERE id=$1', [heatId]);
    } else if (action === 'stop') {
     if (!h.timer_entry_id) throw conflict('No performance in progress');
     await q.query(`UPDATE heat_entries SET status='done', performed_ms=$2, overtime=$3 WHERE id=$1`, [h.timer_entry_id, st.elapsedMs, st.overtime]);
     await q.query('UPDATE heats SET timer_entry_id=NULL, timer_running=false, timer_started_at=NULL, timer_elapsed_ms=0 WHERE id=$1', [heatId]);
    } else throw new HttpError(400, 'Unknown timer action');
    return st;
   });
  },
  async markEntry(heatEntryId, status) {
   if (!['pending', 'no_show', 'forfeit', 'done'].includes(status)) throw new HttpError(400, 'Invalid entry status');
   await db.query('UPDATE heat_entries SET status=$2 WHERE id=$1', [heatEntryId, status]);
  },
  async setRecording(heatEntryId, {recording_url, captions, captions_corrected}) {
   await db.query('UPDATE heat_entries SET recording_url=$2, captions=$3, captions_corrected=$4 WHERE id=$1', [heatEntryId, recording_url, captions, captions_corrected]);
  },

  // ----- judging -----
  async scoresFor(heatId, judgeId) {
   return db.all('SELECT s.* FROM scores s JOIN heat_entries he ON he.id=s.heat_entry_id WHERE he.heat_id=$1 AND s.judge_user_id=$2', [heatId, judgeId]);
  },
  async submitScores(judgeId, heatEntryId, values) {
   const he = await db.one('SELECT he.*, h.status AS heat_status, r.event_id FROM heat_entries he JOIN heats h ON h.id=he.heat_id JOIN rounds r ON r.id=h.round_id WHERE he.id=$1', [heatEntryId]);
   if (!he) throw notFound();
   if (!(await api.isJudge(he.event_id, judgeId))) throw new HttpError(403, 'You are not a judge for this event');
   if (he.heat_status !== 'live') throw conflict('Scores can only be entered while the heat is live');
   const crit = await api.criteria(he.event_id);
   await db.tx(async q => {
    for (const c of crit) {
     const v = values[c.id];
     if (v === undefined || v === '') continue;
     const n = Number(v);
     if (!Number.isFinite(n) || n < 0 || n > c.max_score) throw new HttpError(400, `${c.name} must be between 0 and ${c.max_score}`);
     await q.query(`INSERT INTO scores(heat_entry_id,judge_user_id,criterion_id,value) VALUES ($1,$2,$3,$4)
      ON CONFLICT (heat_entry_id,judge_user_id,criterion_id) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [heatEntryId, judgeId, c.id, n]);
    }
   });
  },

  // ----- audience voting -----
  async setVoting(heatId, open) {
   const h = await heatCtx(heatId);
   const e = await event(h.event_id);
   if (open && !e.voting_enabled) throw conflict('Audience voting is disabled for this event');
   if (open && h.status !== 'live') throw conflict('Voting opens only while the heat is live');
   await db.query('UPDATE heats SET voting_open=$2 WHERE id=$1', [heatId, open]);
  },
  async openVotes() {
   return db.all(`SELECT h.*, r.name AS round_name, e.title AS event_title, e.slug, e.votes_per_fan FROM heats h JOIN rounds r ON r.id=h.round_id JOIN events e ON e.id=r.event_id
    WHERE h.voting_open AND e.voting_enabled AND e.published ORDER BY h.id`);
  },
  /** Anti-abuse: signed-in fan, account age, per-account limit, one vote per entry, per-IP cap, no self/judge votes. */
  async castVote({user, heatId, heatEntryId, ipHash, minAccountMinutes = 0, ipCap = 25}) {
   return db.tx(async q => {
    const h = await q.one(`SELECT h.*, r.event_id, e.votes_per_fan, e.voting_enabled, e.published FROM heats h JOIN rounds r ON r.id=h.round_id JOIN events e ON e.id=r.event_id WHERE h.id=$1 FOR UPDATE OF h`, [heatId]);
    if (!h || !h.voting_open || !h.voting_enabled || !h.published) throw conflict('Voting is not open for this heat');
    const he = await q.one('SELECT he.*, en.user_id FROM heat_entries he JOIN entrants en ON en.id=he.entrant_id WHERE he.id=$1 AND he.heat_id=$2', [heatEntryId, heatId]);
    if (!he || ['no_show', 'forfeit'].includes(he.status)) throw new HttpError(400, 'Not a votable entry');
    if (Date.now() - new Date(user.createdAt).getTime() < minAccountMinutes * 60000) throw new HttpError(403, `Accounts must be at least ${minAccountMinutes} minutes old to vote`);
    const own = await q.one('SELECT 1 FROM heat_entries he JOIN entrants en ON en.id=he.entrant_id WHERE he.heat_id=$1 AND en.user_id=$2', [heatId, user.id]);
    if (own) throw new HttpError(403, 'Entrants cannot vote in their own heat');
    if (await q.one('SELECT 1 FROM judges WHERE event_id=$1 AND user_id=$2', [h.event_id, user.id])) throw new HttpError(403, 'Judges cannot cast audience votes');
    const mine = Number((await q.one('SELECT count(*) AS n FROM votes WHERE heat_id=$1 AND user_id=$2', [heatId, user.id])).n);
    if (mine >= h.votes_per_fan) throw new HttpError(429, `You have used all ${h.votes_per_fan} vote(s) for this heat`);
    const fromIp = Number((await q.one('SELECT count(*) AS n FROM votes WHERE heat_id=$1 AND ip_hash=$2', [heatId, ipHash])).n);
    if (fromIp >= ipCap) throw new HttpError(429, 'Too many votes from this network for this heat');
    try {
     await q.query('INSERT INTO votes(heat_id,heat_entry_id,user_id,ip_hash) VALUES ($1,$2,$3,$4)', [heatId, heatEntryId, user.id, ipHash]);
    } catch (e) { if (e.code === '23505') throw conflict('You already voted for this performer'); throw e; }
    return {remaining: h.votes_per_fan - mine - 1};
   });
  },
  async voteCounts(heatId) { return db.all('SELECT heat_entry_id, count(*)::int AS n FROM votes WHERE heat_id=$1 GROUP BY heat_entry_id', [heatId]); },

  // ----- results -----
  async computeResults(heatId, manualOrder = []) {
   const h = await heatCtx(heatId);
   if (h.status === 'finalized') throw conflict('Heat is finalized');
   const e = await event(h.event_id);
   const entries = await entriesOf(heatId);
   if (!entries.length) throw conflict('Heat has no entrants');
   if (h.timer_running) throw conflict('Stop the timer before computing results');
   const criteria = await api.criteria(h.event_id);
   if (!criteria.length) throw conflict('Add rubric criteria first');
   const scores = await db.all('SELECT s.* FROM scores s JOIN heat_entries he ON he.id=s.heat_entry_id WHERE he.heat_id=$1', [heatId]);
   const votes = await db.all('SELECT heat_entry_id FROM votes WHERE heat_id=$1', [heatId]);
   const out = computeHeatResults({entries, criteria, scores, votes, votingEnabled: e.voting_enabled, voteWeightBps: e.vote_weight_bps, tieRule: e.tie_rule, manualOrder});
   await db.tx(async q => {
    await q.query('DELETE FROM results WHERE heat_id=$1', [heatId]);
    for (const r of out.rows) {
     await q.query('INSERT INTO results(heat_id,entrant_id,rank,judge_score,vote_count,combined,tied,note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [heatId, r.entrantId, r.rank, r.judgeScore, r.voteCount, Math.max(r.combined, 0), r.tied, r.note]);
    }
    await q.query(`UPDATE heats SET status='closed', voting_open=false WHERE id=$1`, [heatId]);
   });
   return out;
  },
  async results(heatId) {
   return db.all('SELECT r.*, en.display_name, en.publish_consent FROM results r JOIN entrants en ON en.id=r.entrant_id WHERE r.heat_id=$1 ORDER BY r.rank, en.display_name', [heatId]);
  },
  async finalizeHeat(heatId) {
   const h = await heatCtx(heatId);
   if (h.status !== 'closed') throw conflict('Compute results before finalizing');
   const e = await event(h.event_id);
   const rows = await api.results(heatId);
   if (e.tie_rule !== 'shared' && rows.some(r => r.tied)) throw conflict('Resolve the tie (manual order) before finalizing');
   await db.tx(async q => {
    await q.query('UPDATE results SET advanced = (rank <= $2 AND combined > 0) WHERE heat_id=$1', [heatId, h.advance_count]);
    await q.query(`UPDATE heats SET status='finalized' WHERE id=$1`, [heatId]);
   });
  },
  async advanceRound(roundId) {
   const r = await db.one('SELECT * FROM rounds WHERE id=$1', [roundId]);
   if (!r) throw notFound();
   const hs = await api.heats(roundId);
   if (!hs.length || hs.some(h => h.status !== 'finalized')) throw conflict('Finalize every heat in this round first');
   const next = await db.one('SELECT * FROM rounds WHERE event_id=$1 AND position=$2', [r.event_id, r.position + 1]);
   if (!next) throw conflict('There is no later round; finalize the event instead');
   const adv = await db.all('SELECT res.entrant_id FROM results res JOIN heats h ON h.id=res.heat_id WHERE h.round_id=$1 AND res.advanced ORDER BY res.rank, res.combined DESC', [roundId]);
   let heat = (await api.heats(next.id))[0];
   if (!heat) heat = await api.addHeat(next.id, next.name + ' heat 1');
   for (const a of adv) { try { await api.placeEntrant(heat.id, a.entrant_id); } catch (e) { if (e.status !== 409) throw e; } }
   await db.query(`UPDATE rounds SET status='closed' WHERE id=$1`, [roundId]);
   return {heatId: Number(heat.id), advanced: adv.length};
  },
  async finalizeEvent(eventId) {
   const e = await event(eventId);
   const last = await db.one('SELECT * FROM rounds WHERE event_id=$1 ORDER BY position DESC LIMIT 1', [eventId]);
   if (!last) throw conflict('Event has no rounds');
   const hs = await api.heats(last.id);
   if (hs.length !== 1 || hs[0].status !== 'finalized') throw conflict('The last round must have exactly one finalized heat');
   const top = await db.all('SELECT * FROM results WHERE heat_id=$1 AND rank=1', [hs[0].id]);
   const champion = top.length === 1 ? top[0].entrant_id : null;
   await db.query(`UPDATE rounds SET status='closed' WHERE id=$1`, [last.id]);
   return db.one(`UPDATE events SET champion_entrant_id=$2, finalized_at=now(), status='completed' WHERE id=$1 RETURNING *`, [e.id, champion]);
  },

  // ----- public projections -----
  async champions() {
   return db.all(`SELECT e.slug, e.title, e.finalized_at, en.display_name FROM events e JOIN entrants en ON en.id=e.champion_entrant_id
    WHERE e.published AND e.finalized_at IS NOT NULL ORDER BY e.finalized_at DESC`);
  },
  /** Full structure for the public event page; results only for finalized heats, recordings only with publication consent. */
  async publicEvent(slug) {
   const e = await db.one('SELECT * FROM events WHERE slug=$1 AND published', [slug]);
   if (!e) return null;
   const rounds = await api.rounds(e.id);
   for (const r of rounds) {
    r.heats = await api.heats(r.id);
    for (const h of r.heats) {
     h.entries = (await entriesOf(h.id)).map(x => ({...x, recording_url: x.publish_consent ? x.recording_url : null, captions: x.publish_consent ? x.captions : null}));
     h.results = h.status === 'finalized' ? await api.results(h.id) : [];
     h.timer = timerState(h, r.time_limit_seconds);
    }
   }
   const champion = e.champion_entrant_id ? await db.one('SELECT display_name FROM entrants WHERE id=$1', [e.champion_entrant_id]) : null;
   return {...e, rounds, champion: champion?.display_name || null};
  },
  async entrantHistory(userId) {
   return db.all(`SELECT e.title, e.slug, r.name AS round_name, res.rank, res.combined, res.advanced FROM results res
    JOIN entrants en ON en.id=res.entrant_id JOIN heats h ON h.id=res.heat_id JOIN rounds r ON r.id=h.round_id JOIN events e ON e.id=r.event_id
    WHERE en.user_id=$1 AND h.status='finalized' ORDER BY e.id DESC, r.position`, [userId]);
  },
 };
 return api;
}
