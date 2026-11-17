/** Pure result computation for one heat. No I/O; fully unit-tested.
 * judge component: mean over judges of the weighted rubric percentage (0..100)
 * vote component: share of heat votes (0..100); combined = judge*(1-w) + votes*w.
 */
export const TIE_RULES = Object.freeze({
 'manual-review': 'Ties are flagged and the producer orders them manually',
 'judges-then-votes': 'Higher judge score, then more audience votes, then top rubric criterion',
 'votes-then-judges': 'More audience votes, then higher judge score',
 'top-criterion': 'Higher score on the first (heaviest) rubric criterion, then judge score',
 'shared': 'Tied entrants share the rank',
});
const EPS = 1e-6;
const round3 = n => Math.round(n * 1000) / 1000;

export function computeHeatResults({entries, criteria, scores, votes = [], votingEnabled = false, voteWeightBps = 0, tieRule = 'manual-review', manualOrder = []}) {
 if (!Object.hasOwn(TIE_RULES, tieRule)) throw new TypeError('Unknown tie rule');
 const crit = new Map(criteria.map(c => [Number(c.id), c]));
 const topCriterion = [...criteria].sort((a, b) => b.weight_bps - a.weight_bps || a.position - b.position)[0];
 const w = votingEnabled ? voteWeightBps / 10000 : 0;
 const totalVotes = votes.length;
 const rows = entries.map(e => {
  const mine = scores.filter(s => Number(s.heat_entry_id) === Number(e.id));
  const byJudge = new Map();
  let topSum = 0, topCount = new Set();
  for (const s of mine) {
   const c = crit.get(Number(s.criterion_id));
   if (!c) continue;
   const pct = (Number(s.value) / c.max_score) * (c.weight_bps / 100);
   byJudge.set(s.judge_user_id, (byJudge.get(s.judge_user_id) || 0) + pct);
   if (topCriterion && Number(c.id) === Number(topCriterion.id)) { topSum += Number(s.value); topCount.add(s.judge_user_id); }
  }
  const judge = byJudge.size ? [...byJudge.values()].reduce((a, b) => a + b, 0) / byJudge.size : 0;
  const voteCount = votes.filter(v => Number(v.heat_entry_id) === Number(e.id)).length;
  const voteShare = totalVotes ? (voteCount / totalVotes) * 100 : 0;
  const eligible = !['no_show', 'forfeit'].includes(e.status);
  const combined = eligible ? judge * (1 - w) + voteShare * w : -1;
  return {entrantId: Number(e.entrant_id), heatEntryId: Number(e.id), judgeScore: round3(judge), voteCount, combined: round3(combined), top: topCount.size ? topSum / topCount.size : 0, eligible, judgeCount: byJudge.size};
 });
 const manual = new Map(manualOrder.map((id, i) => [Number(id), i]));
 const cmpTie = (a, b) => {
  switch (tieRule) {
   case 'judges-then-votes': return (b.judgeScore - a.judgeScore) || (b.voteCount - a.voteCount) || (b.top - a.top);
   case 'votes-then-judges': return (b.voteCount - a.voteCount) || (b.judgeScore - a.judgeScore);
   case 'top-criterion': return (b.top - a.top) || (b.judgeScore - a.judgeScore);
   case 'manual-review': {
    if (manual.has(a.entrantId) && manual.has(b.entrantId)) return manual.get(a.entrantId) - manual.get(b.entrantId);
    return 0;
   }
   default: return 0;
  }
 };
 rows.sort((a, b) => (Math.abs(b.combined - a.combined) > EPS ? b.combined - a.combined : cmpTie(a, b)) || a.entrantId - b.entrantId);
 // Assign ranks: entries remain tied only when the tie-break comparator cannot separate them.
 let unresolved = false;
 rows.forEach((r, i) => {
  const prev = rows[i - 1];
  const tiedWithPrev = prev && Math.abs(prev.combined - r.combined) <= EPS && cmpTie(prev, r) === 0 && r.eligible;
  r.rank = tiedWithPrev ? prev.rank : i + 1;
  if (tiedWithPrev) { r.tied = true; prev.tied = true; if (tieRule !== 'shared') unresolved = true; }
  else r.tied = r.tied || false;
 });
 for (const r of rows) r.note = r.tied ? (tieRule === 'shared' ? 'Shared rank' : 'Tie requires producer review') : (r.eligible ? '' : 'Did not perform');
 return {rows, unresolvedTie: unresolved};
}

/** Remaining milliseconds on a heat timer at time `now`. */
export function timerState(heat, limitSeconds, now = Date.now()) {
 const elapsed = Number(heat.timer_elapsed_ms || 0) + (heat.timer_running && heat.timer_started_at ? now - new Date(heat.timer_started_at).getTime() : 0);
 return {elapsedMs: elapsed, remainingMs: limitSeconds * 1000 - elapsed, running: Boolean(heat.timer_running), overtime: elapsed > limitSeconds * 1000};
}
