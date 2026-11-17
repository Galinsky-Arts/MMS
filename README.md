# MMS

A performer- and industry-centered timed monologue competition application on Live-Competition-Engine. Brand and navigation use MMS only; do not expand the acronym. This repository must own its UI, policy and defaults; generic judging/events/streaming/payment capabilities are supplied upstream.

**Complete development plan:** [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md).

Designed for [Live Competition Engine](https://github.com/neophilism/Live-Competition-Engine); ships with a built-in engine behind the same adapter boundary while that repository is inaccessible.

## End-to-End Everywhere progress

The canonical [security/e2eesa-status.json](security/e2eesa-status.json) records standard implementation, complete testing and independent expert review separately. Engine Room reads it automatically from GitHub. All initial stages are pending; existing profile locks and approved decisions remain authoritative. Read [adoption and independent-account instructions](docs/E2EESA_ADOPTION.md), and run `python3 scripts/validate_e2eesa_status.py`. Record validation does not establish product security or certification.

## Application status (2026-11-17)

MMS runs as one Node service on Postgres with a built-in competition engine behind an adapter (so an external Live-Competition-Engine can be plugged in later), real email+password accounts with roles, CSRF protection and rate limits, the actor application flow, industry discovery with opt-ins, and the public site/archive with real data. `npm ci && npm start`; tests with `npm test`. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

**Applications are built but closed by default.** The admin switch refuses to open them until the operator name, privacy contact, retention days and consent version are entered in Admin → Settings (owner sign-off on [the consent draft](docs/MMS-05_PRIVACY_CONSENT_REVIEW_DRAFT.md) is pending). Live-Competition-Engine itself remains unconnected; the built-in engine is used.
