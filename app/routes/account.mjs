import {HttpError, text} from '../http.mjs';
import {html, field, fmtDate, table, postButton, csrfField} from '../views/layout.mjs';
import {hashPassword, verifyPassword, passwordProblem, normEmail, validEmail, sha256, token} from '../security.mjs';
import {cookie} from '../http.mjs';
import {audit} from '../db.mjs';

const safeNext = n => (typeof n === 'string' && /^\/(?![/\\])[\w\-/.?=&%#]*$/.test(n) ? n : '/account');

/** Accounts: email + password (argon2id), server-side sessions, role-aware account page. */
export function accountRoutes(r, app) {
 const {db, sessions, limiter, engine} = app;
 const dummyHash = hashPassword(token(16)); // equalizes timing for unknown emails
 const startSession = async (ctx, userId) => {
  const raw = await sessions.create(userId);
  ctx.setCookie(cookie(app.SID, raw, {secure: app.secure, maxAge: 60 * 60 * 24 * 14}));
 };

 r.get('/login', ctx => {
  if (ctx.user) return ctx.redirect('/account');
  ctx.page('Sign in', html`<section class="mms-hero"><h1>Sign in</h1></section>
   <form method="post" action="/login" class="mms-card">${csrfField(ctx.csrf)}<input type="hidden" name="next" value="${safeNext(ctx.query.get('next'))}">
   ${field('Email', 'email', {type: 'text', required: true, attrs: 'autocomplete="username"'})}${field('Password', 'password', {type: 'password', required: true, attrs: 'autocomplete="current-password"'})}
   <button type="submit">Sign in</button></form><p>New here? <a href="/register">Create an account</a>.</p>`);
 });
 r.post('/login', async ctx => {
  const email = normEmail(ctx.form.email), pw = String(ctx.form.password || '');
  if (!limiter('login-ip:' + ctx.ip, 20, 15 * 60000) || !limiter('login-email:' + sha256(email), 10, 15 * 60000)) throw new HttpError(429, 'Too many sign-in attempts; try again in 15 minutes');
  const u = await db.one('SELECT * FROM users WHERE email=$1 AND NOT disabled', [email]);
  const ok = u ? await verifyPassword(u.password_hash, pw) : (await verifyPassword(await dummyHash, pw), false);
  if (!ok) { await audit(db, null, 'login.failed', {email: email.slice(0, 3) + '…'}); return ctx.redirect('/login', {kind: 'error', text: 'Email or password is incorrect.'}); }
  await startSession(ctx, u.id);
  await audit(db, u.id, 'login', {});
  ctx.redirect(safeNext(ctx.form.next), 'Signed in.');
 });

 r.get('/register', ctx => {
  if (ctx.user) return ctx.redirect('/account');
  ctx.page('Create account', html`<section class="mms-hero"><h1>Create an account</h1><p>Accounts let you vote, apply when applications open, and manage your privacy choices.</p></section>
   <form method="post" action="/register" class="mms-card">${csrfField(ctx.csrf)}
   ${field('Display name', 'name', {required: true, attrs: 'maxlength="80" autocomplete="nickname"'})}${field('Email', 'email', {type: 'email', required: true, attrs: 'autocomplete="email"'})}
   ${field('Password', 'password', {type: 'password', required: true, hint: 'At least 10 characters.', attrs: 'minlength="10" autocomplete="new-password"'})}
   <button type="submit">Create account</button></form><p>See how we handle data on the <a href="/privacy">privacy page</a>.</p>`);
 });
 r.post('/register', async ctx => {
  if (!limiter('register:' + ctx.ip, 8, 60 * 60000)) throw new HttpError(429, 'Too many new accounts from this network; try later');
  const email = normEmail(ctx.form.email), name = text(ctx.form.name, {min: 2, max: 80, name: 'Display name'}), pw = String(ctx.form.password || '');
  if (!validEmail(email) || email === 'admin') throw new HttpError(400, 'Enter a valid email address');
  const problem = passwordProblem(pw);
  if (problem) throw new HttpError(400, problem);
  const hash = await hashPassword(pw);
  let u;
  try { u = await db.one('INSERT INTO users(email,password_hash,display_name) VALUES ($1,$2,$3) RETURNING id', [email, hash, name]); }
  catch (e) { if (e.code === '23505') throw new HttpError(409, 'An account with that email already exists; sign in instead'); throw e; }
  await db.query(`INSERT INTO user_roles(user_id,role) VALUES ($1,'fan')`, [u.id]);
  await audit(db, u.id, 'register', {});
  await startSession(ctx, u.id);
  ctx.redirect('/account', 'Welcome to MMS.');
 });

 r.post('/logout', async ctx => {
  await sessions.destroy(ctx.cookies[app.SID]);
  ctx.setCookie(cookie(app.SID, '', {secure: app.secure, maxAge: 0}));
  ctx.redirect('/', 'Signed out.');
 });

 r.get('/account', async ctx => {
  ctx.require();
  const u = ctx.user;
  const apps = await db.all('SELECT a.*, e.title AS event_title FROM applications a LEFT JOIN events e ON e.id=a.event_id WHERE a.user_id=$1 ORDER BY a.id DESC', [u.id]);
  const notes = await db.all('SELECT * FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 30', [u.id]);
  const requests = await db.all(`SELECT c.*, iu.display_name AS industry_name, ip.company, ip.title FROM contact_requests c JOIN applications a ON a.id=c.application_id
    JOIN users iu ON iu.id=c.industry_user_id LEFT JOIN industry_profiles ip ON ip.user_id=c.industry_user_id WHERE a.user_id=$1 AND c.generation=a.consent_generation ORDER BY c.id DESC`, [u.id]);
  const history = await engine.entrantHistory(u.id);
  await db.query('UPDATE notifications SET read=true WHERE user_id=$1 AND NOT read', [u.id]);
  ctx.page('Account', html`<section class="mms-hero"><p class="mms-eyebrow">Account</p><h1>${u.name}</h1><p>${u.email} · roles: ${[...u.roles].sort().join(', ') || 'none'}</p></section>
   <section><h2>Notifications</h2>${notes.length ? html`<ul>${notes.map(n => html`<li>${n.read ? '' : html`<strong>New:</strong> `}${n.message} <span class="mms-muted">${fmtDate(n.at)}</span></li>`)}</ul>` : html`<p class="mms-muted">No notifications.</p>`}</section>
   <section><h2>Your applications</h2>${table(['Application', 'Event', 'Status', 'Submitted', ''], apps.map(a => [a.monologue_title, a.event_title || 'General', a.status.replace('_', ' '), fmtDate(a.created_at), html`<a href="/account/applications/${a.id}">Manage</a>`]), {empty: 'No applications yet.'})}<p><a href="/apply">Apply</a></p></section>
   ${requests.length ? html`<section><h2>Industry contact requests</h2>${table(['From', 'Message', 'Status', ''], requests.map(c => [`${c.industry_name}${c.company ? ' (' + c.title + ', ' + c.company + ')' : ''}`, c.message, c.status,
     c.status === 'pending' ? html`<span class="mms-row">${postButton('/account/contact/' + c.id, 'Share my email', ctx.csrf, {fields: {decision: 'approved'}})}${postButton('/account/contact/' + c.id, 'Decline', ctx.csrf, {fields: {decision: 'declined'}, cls: 'secondary'})}</span>` : '']))}</section>` : ''}
   ${history.length ? html`<section><h2>Your competition history</h2>${table(['Event', 'Round', 'Rank', 'Score'], history.map(h => [html`<a href="/events/${h.slug}">${h.title}</a>`, h.round_name, String(h.rank), Number(h.combined).toFixed(1)]))}</section>` : ''}
   <section class="mms-card"><h2>Change password</h2><form method="post" action="/account/password">${csrfField(ctx.csrf)}${field('Current password', 'current', {type: 'password', required: true})}${field('New password', 'password', {type: 'password', required: true, attrs: 'minlength="10"'})}<button type="submit">Change password</button></form></section>
   <section class="mms-card"><h2>Delete account</h2><p>Deletes your account, applications, uploads, saved lists and contact requests. Published competition results keep your stage name only if you consented to publication.</p>
   <form method="post" action="/account/delete">${csrfField(ctx.csrf)}${field('Type DELETE to confirm', 'confirm', {required: true})}<button type="submit" class="danger">Delete my account</button></form></section>`);
 });

 r.post('/account/password', async ctx => {
  ctx.require();
  const u = await db.one('SELECT * FROM users WHERE id=$1', [ctx.user.id]);
  if (u.bootstrap) throw new HttpError(400, 'The bootstrap admin password is the MMS_ADMIN_TOKEN environment value');
  if (!(await verifyPassword(u.password_hash, String(ctx.form.current || '')))) throw new HttpError(400, 'Current password is incorrect');
  const problem = passwordProblem(ctx.form.password);
  if (problem) throw new HttpError(400, problem);
  await db.query('UPDATE users SET password_hash=$2 WHERE id=$1', [u.id, await hashPassword(ctx.form.password)]);
  await sessions.destroyAllFor(u.id);
  await startSession(ctx, u.id);
  await audit(db, u.id, 'password.changed', {});
  ctx.redirect('/account', 'Password changed; other sessions were signed out.');
 });

 r.post('/account/delete', async ctx => {
  ctx.require();
  if (ctx.form.confirm !== 'DELETE') throw new HttpError(400, 'Type DELETE to confirm');
  if (ctx.user.bootstrap) throw new HttpError(400, 'The bootstrap admin cannot be deleted');
  await db.tx(async q => {
   await q.query(`UPDATE entrants SET application_id=NULL, display_name=CASE WHEN publish_consent THEN display_name ELSE 'Former entrant' END WHERE user_id=$1`, [ctx.user.id]);
   await q.query('DELETE FROM users WHERE id=$1', [ctx.user.id]);
  });
  await audit(db, null, 'account.deleted', {userId: ctx.user.id});
  ctx.setCookie(cookie(app.SID, '', {secure: app.secure, maxAge: 0}));
  ctx.redirect('/', 'Your account and data were deleted.');
 });
}
