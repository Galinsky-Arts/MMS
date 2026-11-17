import {esc} from '../http.mjs';

/** Escaping template tag: interpolations are escaped unless produced by html`` or raw(). */
export function html(strings, ...vals) {
 let out = '';
 strings.forEach((s, i) => { out += s; if (i < vals.length) out += render(vals[i]); });
 return {__html: out};
}
function render(v) {
 if (v === null || v === undefined || v === false) return '';
 if (Array.isArray(v)) return v.map(render).join('');
 if (typeof v === 'object' && '__html' in v) return v.__html;
 return esc(v);
}
export const str = v => render(v);

const has = (user, ...roles) => Boolean(user && roles.some(r => user.roles.has(r)));
export const isStaff = user => has(user, 'admin', 'producer');

export function csrfField(csrf) { return html`<input type="hidden" name="_csrf" value="${csrf}">`; }
export function postButton(action, label, csrf, {fields = {}, cls = '', confirm = false} = {}) {
 return html`<form method="post" action="${action}" class="mms-inline">${csrfField(csrf)}${Object.entries(fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}<button type="submit" class="${cls}"${confirm ? html` data-confirm="${confirm}"` : ''}>${label}</button></form>`;
}
export const fmtDate = d => d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '';
export const fmtMs = ms => { const s = Math.max(0, Math.round(Number(ms || 0) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export function layout({title, user, csrf, body, flash, path = '/', notice}) {
 const nav = [['/watch', 'Watch'], ['/vote', 'Vote'], ['/archive', 'Archive'], ['/champions', 'Champions'], ['/apply', 'Apply'], ['/sponsor', 'Sponsor']];
 const roleNav = [];
 if (has(user, 'judge')) roleNav.push(['/judge', 'Judge']);
 if (has(user, 'industry')) roleNav.push(['/industry', 'Industry']);
 if (isStaff(user)) roleNav.push(['/admin', 'Admin']);
 const doc = html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} | MMS</title><link rel="stylesheet" href="/mms.css"><script src="/app.js" defer></script></head>
<body><a class="mms-skip" href="#main">Skip to content</a>
<header class="mms-shell mms-top"><a class="mms-brand" href="/" aria-label="MMS home">MMS</a>
<nav aria-label="Primary">${nav.map(([h, l]) => html`<a href="${h}"${path === h ? html` aria-current="page"` : ''}>${l}</a>`)}</nav>
<nav aria-label="Account" class="mms-account">${roleNav.map(([h, l]) => html`<a href="${h}">${l}</a>`)}${user
  ? html`<a href="/account">${user.name}</a><form method="post" action="/logout" class="mms-inline">${csrfField(csrf)}<button type="submit" class="mms-link">Sign out</button></form>`
  : html`<a href="/login">Sign in</a><a href="/register">Create account</a>`}</nav></header>
<main class="mms-shell" id="main" tabindex="-1">${notice ? html`<p class="mms-banner" role="note">${notice}</p>` : ''}${flash ? html`<p class="mms-flash ${flash.kind || ''}" role="${flash.kind === 'error' ? 'alert' : 'status'}">${flash.text}</p>` : ''}${body}</main>
<footer class="mms-shell"><p><a href="/privacy">Privacy</a> · <a href="/sponsor">Sponsors</a> · MMS timed monologue competition</p></footer></body></html>`;
 return doc.__html;
}

export function table(headers, rows, {empty = 'Nothing here yet.'} = {}) {
 if (!rows.length) return html`<p class="mms-muted">${empty}</p>`;
 return html`<div class="mms-table-wrap"><table><thead><tr>${headers.map(h => html`<th scope="col">${h}</th>`)}</tr></thead><tbody>${rows.map(r => html`<tr>${r.map(c => html`<td>${c}</td>`)}</tr>`)}</tbody></table></div>`;
}
export function field(label, name, {type = 'text', value = '', required = false, hint = '', attrs = ''} = {}) {
 return html`<label class="mms-field"><span>${label}${required ? ' *' : ''}</span><input type="${type}" name="${name}" value="${value ?? ''}"${required ? html` required` : ''}${attrs ? {__html: ' ' + attrs} : ''}>${hint ? html`<small>${hint}</small>` : ''}</label>`;
}
export function textarea(label, name, {value = '', required = false, hint = '', rows = 4} = {}) {
 return html`<label class="mms-field"><span>${label}${required ? ' *' : ''}</span><textarea name="${name}" rows="${rows}"${required ? html` required` : ''}>${value ?? ''}</textarea>${hint ? html`<small>${hint}</small>` : ''}</label>`;
}
export function select(label, name, options, current, {hint = ''} = {}) {
 return html`<label class="mms-field"><span>${label}</span><select name="${name}">${options.map(([v, l]) => html`<option value="${v}"${String(v) === String(current) ? html` selected` : ''}>${l}</option>`)}</select>${hint ? html`<small>${hint}</small>` : ''}</label>`;
}
export function check(label, name, checked, {hint = '', required = false} = {}) {
 return html`<label class="mms-check"><input type="checkbox" name="${name}"${checked ? html` checked` : ''}${required ? html` required` : ''}><span>${label}${hint ? html`<small>${hint}</small>` : ''}</span></label>`;
}
