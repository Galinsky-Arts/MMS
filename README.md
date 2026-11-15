# MMS

A performer- and industry-centered timed monologue competition application on Live-Competition-Engine. Brand and navigation use MMS only; do not expand the acronym. This repository must own its UI, policy and defaults; generic judging/events/streaming/payment capabilities are supplied upstream.

**Complete development plan:** [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md).

Requires [Live Competition Engine](https://github.com/neophilism/Live-Competition-Engine).

## End-to-End Everywhere progress

The canonical [security/e2eesa-status.json](security/e2eesa-status.json) records standard implementation, complete testing and independent expert review separately. Engine Room reads it automatically from GitHub. All initial stages are pending; existing profile locks and approved decisions remain authoritative. Read [adoption and independent-account instructions](docs/E2EESA_ADOPTION.md), and run `python3 scripts/validate_e2eesa_status.py`. Record validation does not establish product security or certification.

## Deployable slice

The current MVP (MMS-01..04 plus a synthetic-only MMS-07 public archive preview) runs as one Node service: `npm ci && npm start`, tests with `npm test`. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for routes, configuration and the features that stay disabled pending owner decisions (applications, discovery, real publication, payments). Live-Competition-Engine is not yet connected; the prototype uses labelled stubs.
