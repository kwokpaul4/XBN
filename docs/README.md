# XBN — Documentation

This directory holds operations and reference material for the XBN buyer-supplier document-exchange network. For architecture and the long-term plan, see [`PHASES.md`](../PHASES.md) and [`CLAUDE.md`](../CLAUDE.md) at the repo root.

## What's here

- **[`OPERATIONS.md`](./OPERATIONS.md)** — User operations manual. Step-by-step instructions for everything you can do with XBN today: starting the stack, registering accounts, creating orgs, establishing trading relationships, exchanging documents (indirect procurement + direct-materials SCC), attaching files, etc. Both web-portal and API (curl) flows are covered.
- **[`API_REFERENCE.md`](./API_REFERENCE.md)** — Endpoint-by-endpoint reference for the HTTP API. Includes the state machine and link registry reference for every document type (Phases 1–3).
- **[`DOCUMENT_TYPE_CATALOG.md`](./DOCUMENT_TYPE_CATALOG.md)** — The canonical reference for every document type XBN ships: body schema, state machine, valid link rules, per-role permissions. The contract between phases; when two docs disagree, this file wins.
- **[`ONBOARDING_RUNBOOK.md`](./ONBOARDING_RUNBOOK.md)** — Ordered checklist for bringing a new supplier (or buyer) onto XBN. Two paths: direct (Path A) or invitation-driven (Path B). Includes a post-onboarding checklist and typed troubleshooting table for the first-document scenario.
- **[`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)** — Common problems and how to recover.

## User acceptance tests

Runnable UATs that gate each phase milestone:

- **[`UAT_PHASE_2.md`](./UAT_PHASE_2.md)** — Phase 2 (M2) acceptance manual: nine scenarios, 53 assertions covering the full indirect-procurement choreography (PO → POAck → PO_CHANGE → ASN → GR → Invoice → Credit Memo → Remittance).
- **[`uat-phase-2.sh`](./uat-phase-2.sh)** — Executable companion. Drives the API end-to-end and asserts each step (~30 s).
- **[`UAT_PHASE_3.md`](./UAT_PHASE_3.md)** — Phase 3 (M3) acceptance manual: five scenarios, 27 assertions covering the direct-materials SCC choreography (Scheduling Agreement / Consignment Contract / Subcontracting Agreement anchors, Forecast Collaboration, SA Releases, **and the polymorphic-predecessor cross-phase test — Phase 2 ASN ships against a JIT release**).
- **[`uat-phase-3.sh`](./uat-phase-3.sh)** — Executable companion (~15 s).
- **[`UAT_PHASE_4.md`](./UAT_PHASE_4.md)** — Phase 4 (M4) acceptance manual: five scenarios, 36 assertions covering cross-type search + filters, counterparties directory, buyer + supplier dashboards, live-computed scorecards with honest `null` sentinels, and the notification outbox bidirectional flow.
- **[`uat-phase-4.sh`](./uat-phase-4.sh)** — Executable companion (~15 s).
- **[`UAT_PHASE_5.md`](./UAT_PHASE_5.md)** — Phase 5 (M5) acceptance manual: five scenarios, 28 assertions covering `/health` + `/ready` probes, `x-request-id` correlation, `/network/audit-log` scoping, CI/CD + Docker artifacts, and the Phase 5.4 doc surface.
- **[`uat-phase-5.sh`](./uat-phase-5.sh)** — Executable companion (~10 s).

## Quick links

- Repo root: [`README.md`](../README.md) · [`PHASES.md`](../PHASES.md) · [`CLAUDE.md`](../CLAUDE.md) · [`TASKS.md`](../TASKS.md)
- GitHub: <https://github.com/kwokpaul4/XBN>
