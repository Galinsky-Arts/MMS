import {html, fmtDate, fmtMs, table, postButton} from './layout.mjs';
import {embedUrl} from '../media.mjs';

export const STATUS_LABEL = {draft: 'Draft', scheduled: 'Scheduled', live: 'Live now', completed: 'Results final', archived: 'Archived'};

export function eventCard(e) {
 return html`<article class="mms-card"><p><span class="mms-pill">${STATUS_LABEL[e.status] || e.status}</span></p><h3><a href="/events/${e.slug}">${e.title}</a></h3>
 <p class="mms-muted">${e.starts_at ? fmtDate(e.starts_at) : 'Date to be announced'}${e.venue ? ' · ' + e.venue : ''}</p></article>`;
}

export function embed(link, title) {
 const src = embedUrl(link);
 if (!src) return link ? html`<p><a href="${link}" rel="noopener noreferrer">Open recording</a></p>` : '';
 return html`<iframe class="mms-embed" src="${src}" title="${title}" loading="lazy" allow="fullscreen; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation"></iframe>`;
}

export function timerBlock(h, limitSeconds, current) {
 const t = h.timer;
 return html`<section class="mms-card" aria-live="polite"><h3>${current ? 'Now performing: ' + current.display_name : 'Between performances'}</h3>
 <p class="mms-timer${t.remainingMs < 0 ? ' over' : ''}" data-remaining-ms="${Math.round(t.remainingMs)}" data-running="${t.running ? 1 : 0}">${fmtMs(t.remainingMs)}</p>
 <p class="mms-muted">Time limit ${fmtMs(limitSeconds * 1000)}${t.running ? '' : ' · timer paused'}</p></section>`;
}

export function renderEventPage(e, {user, csrf, voteHeats = new Set()} = {}) {
 const live = e.status === 'live';
 return html`<section class="mms-hero"${live ? html` data-refresh="15"` : ''}><p class="mms-eyebrow">${STATUS_LABEL[e.status] || e.status}</p><h1>${e.title}</h1>
 <p>${e.starts_at ? fmtDate(e.starts_at) : ''}${e.venue ? ' · ' + e.venue : ''}</p>${e.description ? html`<p>${e.description}</p>` : ''}
 ${e.champion ? html`<p class="mms-card"><strong>Champion:</strong> ${e.champion}</p>` : ''}</section>
 ${e.stream_url && live ? html`<section><h2>Live stream</h2>${embed(e.stream_url, 'Live stream of ' + e.title)}</section>` : ''}
 ${e.rounds.map(r => html`<section class="mms-stack"><h2>${r.name} <span class="mms-pill">${r.kind}</span></h2><p class="mms-muted">${fmtMs(r.time_limit_seconds * 1000)} per monologue</p>
  ${r.heats.map(h => {
   const current = h.entries.find(x => Number(x.id) === Number(h.timer_entry_id));
   return html`<article class="mms-card mms-stack"><h3>${h.name} <span class="mms-pill">${h.status}</span></h3>
   ${h.status === 'live' ? timerBlock(h, r.time_limit_seconds, current) : ''}
   ${h.voting_open && voteHeats.has(Number(h.id)) ? html`<p><a class="mms-button" href="/vote#heat-${h.id}">Vote in this heat</a></p>` : ''}
   ${h.results.length ? table(['Rank', 'Performer', 'Judges', 'Votes', 'Score', ''], h.results.map(x => [String(x.rank), x.display_name, Number(x.judge_score).toFixed(1), String(x.vote_count), Number(x.combined).toFixed(1), x.advanced ? 'Advanced' : (x.note || '')]))
    : html`<ol>${h.entries.map(x => html`<li>${x.display_name}${x.status === 'done' && x.performed_ms ? html` <span class="mms-muted">(${fmtMs(x.performed_ms)}${x.overtime ? ', overtime' : ''})</span>` : ''}${['no_show', 'forfeit'].includes(x.status) ? html` <span class="mms-muted">(${x.status.replace('_', '-')})</span>` : ''}</li>`)}</ol>`}
   ${h.status === 'finalized' ? h.entries.filter(x => x.recording_url).map(x => html`<div class="mms-stack"><h4>${x.display_name} — recording</h4>${embed(x.recording_url, 'Recording of ' + x.display_name)}
     ${x.captions ? (x.captions_corrected ? html`<details><summary>Captions transcript</summary><p>${x.captions}</p></details>` : html`<p class="mms-muted">Captions are being corrected.</p>`) : ''}</div>`) : ''}
   </article>`;
  })}</section>`)}`;
}

export function voteForm(h, entries, csrf, counts) {
 return html`<article class="mms-card mms-stack" id="heat-${h.id}"><h2>${h.event_title}: ${h.round_name} — ${h.name}</h2><p class="mms-muted">Up to ${h.votes_per_fan} vote(s) per account, one per performer.</p>
 <ul>${entries.filter(x => !['no_show', 'forfeit'].includes(x.status)).map(x => html`<li class="mms-row">${x.display_name} ${counts ? html`<span class="mms-muted">${counts.get(Number(x.id)) || 0} votes</span>` : ''} ${postButton('/vote/' + h.id, 'Vote for ' + x.display_name, csrf, {fields: {entry: x.id}})}</li>`)}</ul></article>`;
}
