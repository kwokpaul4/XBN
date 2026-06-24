# XBN — Documentation

This directory holds operations and reference material for the XBN buyer-supplier document-exchange network. For architecture and the long-term plan, see [`PHASES.md`](../PHASES.md) and [`CLAUDE.md`](../CLAUDE.md) at the repo root.

## What's here

- **[`OPERATIONS.md`](./OPERATIONS.md)** — User operations manual. Step-by-step instructions for everything you can do with XBN today: starting the stack, registering accounts, creating orgs, establishing trading relationships, exchanging documents, attaching files, etc. Both web-portal and API (curl) flows are covered.
- **[`API_REFERENCE.md`](./API_REFERENCE.md)** — Endpoint-by-endpoint reference for the HTTP API.
- **[`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)** — Common problems and how to recover.

## User acceptance tests

Runnable UATs that gate each phase milestone:

- **[`UAT_PHASE_2.md`](./UAT_PHASE_2.md)** — Phase 2 (M2) acceptance manual: three scenarios covering the full indirect-procurement choreography, summary invoicing, and the relationship-level summary-invoicing gate.
- **[`uat-phase-2.sh`](./uat-phase-2.sh)** — Executable companion script. Drives the API end-to-end and asserts each step (~30 s to run). Exit 0 = Phase 2 signed off.

## Quick links

- Repo root: [`README.md`](../README.md) · [`PHASES.md`](../PHASES.md) · [`CLAUDE.md`](../CLAUDE.md) · [`TASKS.md`](../TASKS.md)
- GitHub: <https://github.com/kwokpaul4/XBN>
