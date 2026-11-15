# MMS deployable slice (MMS-01..04 + synthetic MMS-07 preview)

This is the first deployable MVP. It composes the reviewed MMS-01 shell, MMS-02
visual identity, MMS-03 terminology and MMS-04 competition defaults into one Node
web service (`npm start` → `src/main.mjs`), with producer draft settings stored in
Postgres (Neon). Live-Competition-Engine is **not** connected: the upstream
repository is not accessible to this deployment, so the prototype uses clearly
labelled stubs, as the development plan permits for prototypes.

## What is live

| Route | Behaviour |
| --- | --- |
| `GET /health` | Liveness + database ping. Always reports `applicationsOpen:false`, `engine:"stub-not-connected"`, `productionReady:false`. Used as the Render health check. |
| `/`, `/watch`, `/apply`, `/vote`, `/archive`, `/sponsor`, `/experience/*` | MMS-02 static public pages. Apply states that applications are not open; no forms. |
| `/t/demo/*` | MMS-07 public site renderer fed **only** synthetic, fictional fixtures (`demo/synthetic-archive.mjs`), each page bannered "Synthetic demonstration data". Unpublished fixtures are withheld by the MMS-07 projection. |
| `GET /t/{MMS_TENANT_ID}/organizer` | Producer draft-settings editor (read-only form; CSP forbids scripts). Requires the operator bearer token. |
| `GET/PUT /api/t/{MMS_TENANT_ID}/events/{eventId}/draft-settings` | MMS-04 draft settings API with optimistic versions, same-origin PUT, strict JSON, capability gate (battles/ensemble/improv/prompts/votes/payments cannot be enabled without a verified capability — none are verified). |
| `/organizer`, `/industry`, `/account`, `/t/*/…` | MMS-01 deny-by-default shell; 404 without an authorized session. |

## Stub identity (prototype only)

`src/auth.mjs` accepts one operator bearer secret (`MMS_ADMIN_TOKEN`) as a
verified *producer/member* principal for exactly one tenant (`MMS_TENANT_ID`,
default `mms`). It never grants the *industry* role, so no discovery access exists.
Replace it with the upstream session contract before any production claim.

## Owner-gated features (remain disabled)

* MMS-05 applications, uploads and applicant data: blocked on owner approval of
  `docs/MMS-05_PRIVACY_CONSENT_REVIEW_DRAFT.md` (operator identity, privacy
  contact, retention periods, consent version). No submission route exists.
* MMS-06 discovery/contact opt-ins: depend on MMS-05 consent records.
* MMS-07 real publication: requires an upstream publication verifier, media
  rights and corrected captions. Only synthetic content is rendered.
* Payments/sponsorship: none implemented; no paywall.

## Configuration

| Variable | Source | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Neon connection string (Render env) | Draft settings persistence; required when `NODE_ENV=production`. |
| `MMS_ADMIN_TOKEN` | Generated secret (Render env) | Prototype operator bearer token. Missing/short → private routes fail closed. |
| `MMS_PUBLIC_ORIGIN` | Optional; defaults to Render's `RENDER_EXTERNAL_URL` | Canonical HTTPS origin for the same-origin API check. Without one the API is disabled. |
| `MMS_TENANT_ID` | Optional, default `mms` | Operator tenant. |
| `MMS_ENGINE_ORIGIN` | Owner-supplied when upstream exists | Engine health probe for `/ready` (returns 503 until connected). |
| `NODE_ENV` | `production` on Render | Enforces `DATABASE_URL`. |

Example operator call (token from the Render dashboard, never committed):

```sh
curl -H "Authorization: Bearer $MMS_ADMIN_TOKEN" "$ORIGIN/api/t/mms/events/pilot-event/draft-settings"
```

## Verification

`npm test` (Node ≥ 22.13) runs unit, real-HTTP and — when `TEST_DATABASE_URL` is
set — Postgres integration tests (round-trip, tenant isolation, concurrent
version conflict, corrupt-row rejection). GitHub Actions `Application CI` runs
them against a Postgres 17 service and boots the production entrypoint.
These tests are AI-authored/AI-reviewed; no independent human audit is claimed.
