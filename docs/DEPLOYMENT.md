# MMS deployment and operations

One Node service (`npm start` → `src/main.mjs`) on Postgres (Neon). Migrations run at boot
(`app/schema.mjs`, recorded in `mms_migrations`, guarded by an advisory lock). Tests: `npm test`
(set `TEST_DATABASE_URL` for the Postgres integration and scripted-event tests).

## What the app does

| Area | Routes | Notes |
| --- | --- | --- |
| Public site (MMS-07) | `/`, `/watch`, `/events/{slug}`, `/vote`, `/archive`, `/champions`, `/sponsor`, `/privacy` | Real data from the built-in engine. Live pages show the current performer and a monologue countdown, refresh automatically and embed the stream (YouTube/Vimeo/SoundCloud). Recordings appear only for performers with publication consent; captions only once marked corrected. |
| Accounts | `/register`, `/login`, `/logout`, `/account` | Email + password (argon2id), server-side sessions (14 days, `__Host-` cookie on HTTPS), CSRF tokens on every form, same-origin check, rate limits (sign-in per IP and per email, registration, votes, applications, contact requests). Roles: admin, producer, judge, entrant, fan, industry. Account deletion erases applications, uploads and requests. |
| Applications (MMS-05) | `/apply`, `/account/applications/{id}`, `/media/{id}` | Profile, representation, union status, monologue details, reel link (YouTube/Vimeo/SoundCloud) and optional headshot/résumé uploads stored AES-256-GCM-encrypted in Postgres (size cap in settings, default 2 MB, content-sniffed). Separate consents for review (required), industry discovery, contact requests and publication, stamped with the consent version. Withdraw, change consents, or delete at any time. Retention purge runs hourly. |
| Industry discovery (MMS-06) | `/industry`, `/industry/performers/{id}`, `/industry/saved` | Users request verification; a producer verifies. Verified members search only opted-in profiles, save performers and send contact requests; email is revealed only after the performer approves. Revoking consent bumps a consent generation, which hides the profile, clears saved lists and invalidates earlier requests. |
| Judging | `/judge`, `/judge/heats/{id}` | Assigned judges score each performer against the event rubric while the heat is live. |
| Producer console | `/admin/...` | Events (MMS defaults preset), rubric, rounds, heats, entrants, judges, live heat console (timer start/pause/resume/stop, no-show, voting open/close, results with tie rules, finalize, advance), recordings/captions, application review, users/roles, industry verification, sponsors, audit log, settings. |
| Competition defaults (MMS-04) | `/t/{tenant}/organizer`, `GET/PUT /api/t/{tenant}/events/{event}/draft-settings` | API accepts the legacy operator bearer token or a producer session. |
| Ops | `/health` | Liveness + DB ping, `applicationsOpen`, `engine`. Render health check. |

## Competition engine

`app/engine/builtin.mjs` is a complete engine on Postgres (events, rounds, heats, entrants, judges,
weighted rubric scores, heat timers with overtime, audience votes, results, advancement, champions,
archive). The app talks to it only through the adapter contract in `app/engine/adapter.mjs`
(`ENGINE_METHODS`). `MMS_ENGINE=external` + `MMS_ENGINE_ORIGIN` selects the external adapter, which
probes health and fails closed for every operation until a Live-Competition-Engine client implements
the same methods.

Scoring: each judge's score is the weighted rubric percentage (0–100); the judge component is the mean
across judges. With audience voting on, combined = judges × (1 − w) + vote share × w. Tie rules:
`manual-review` (default; producer orders tied performers before finalizing), `judges-then-votes`,
`votes-then-judges`, `top-criterion`, `shared`.

Voting anti-abuse: signed-in accounts only, minimum account age (default 10 minutes), per-account
vote limit per heat (event setting), one vote per performer, per-network cap per heat (keyed HMAC
of the IP, default 25), entrants cannot vote in their own heat, judges cannot vote, per-IP rate limit.

## Switched off by default

* **Applications are CLOSED.** The admin switch (Admin → Settings → Open applications) refuses to turn
  on until the operator name, privacy contact, retention days and consent version are entered. Editing
  any privacy term while open closes applications again until re-confirmed. The owner has not yet
  signed off `docs/MMS-05_PRIVACY_CONSENT_REVIEW_DRAFT.md`, so these values are intentionally empty.
* Audience voting is off per event until a producer enables it.
* No payments exist (sponsor page lists sponsors only).

## Configuration

| Variable | Source | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Neon (Render env) | Required. |
| `MMS_ADMIN_TOKEN` | Generated (Render env) | Bootstrap admin: sign in with email `admin` and this value as password. Also the legacy bearer token for the draft-settings API. Removing it disables the bootstrap account. |
| `MMS_SECRET_KEY` | Generated (Render env) | Root secret for CSRF tokens, IP hashing and upload encryption keys. Falls back to `MMS_ADMIN_TOKEN`; rotating it makes existing uploads unreadable. |
| `MMS_PUBLIC_ORIGIN` | Optional | Canonical https origin; defaults to `RENDER_EXTERNAL_URL`. Enables `__Host-` secure cookies, the origin check and the draft-settings API. |
| `MMS_TENANT_ID` | Optional (`mms`) | Tenant for the draft-settings API. |
| `MMS_ENGINE`, `MMS_ENGINE_ORIGIN` | Optional | `builtin` (default) or `external`. |

## First run

1. Sign in at `/login` as `admin` with `MMS_ADMIN_TOKEN`.
2. Create named staff accounts (they register normally), give them roles under Admin → Users.
3. Create an event (MMS defaults preset), publish it, assign judges, accept applications or add entrants.
4. When the owner approves privacy terms, enter them in Admin → Settings and open applications.

Tests are AI-authored and AI-reviewed; no independent human audit is claimed.
