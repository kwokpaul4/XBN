# XBN — Development Tasks & Milestones

Living task list for the XBN buyer-supplier document-exchange network. Mirrors the structure of [PHASES.md](./PHASES.md). Update task status as work progresses.

**Legend:** ⬜ pending · 🟡 in progress · ✅ completed · 🔒 blocked (waiting on prerequisites) · 🕓 deferred

**Last updated:** 2026-06-23

---

## Status snapshot

| Phase | Tasks | Done | In progress | Blocked | Deferred |
|---|---|---|---|---|---|
| Phase 1 — Foundation | 6 | **6** | 0 | 0 | 0 |
| Phase 2 — Indirect procurement | 9 | **9** | 0 | 0 | 0 |
| Phase 3 — Direct-materials SCC | 7 | 0 | 0 | 4 | 3 |
| Phase 4 — Network features | 5 | 0 | 0 | 5 | 0 |
| Phase 5 — Production readiness | 4 | 0 | 0 | 4 | 0 |
| **Total** | **31** | **15** | **0** | **13** | **3** |

**🎯 Milestone M1 reached** — Phase 1 substrate works end-to-end.

**🎯 Milestone M2 reached** — Phase 2 indirect procurement choreography ships. Full PO → ORDER_CONFIRMATION → ASN → GOODS_RECEIPT → INVOICE (PO_FLIP + SUMMARY) → CREDIT_MEMO → REMITTANCE_ADVICE flows verified end-to-end via supertest against real Postgres + MinIO. The no-double-billing guard for SUMMARY invoicing is enforced.

**Currently unblocked (ready to work):** #16 Phase 3.0 — SCC anchor entities (Scheduling Agreement / Consignment Contract / Subcontracting Agreement) starts Phase 3.

**Test totals on the working tree:** 109 (58 document-core + 15 auth + 12 network + 24 API: 2 M1 + 7 PO + 5 PO_CHANGE + 7 ORDER_CONFIRMATION + 3 Phase 2 acceptance).

---

## Milestones

These are the gates that mark meaningful progress. Each milestone is reached when its underlying tasks are all ✅.

| # | Milestone | Gating tasks | Definition of done |
|---|---|---|---|
| **M1** | **Substrate works end-to-end** | #1–#6 | A network admin can onboard two orgs, establish a relationship, and exchange `GENERIC_DOCUMENT` and `PO ↔ ORDER_CONFIRMATION` through the portal with versions, lineage, and audit log all working. |
| **M2** | **Indirect procurement choreography ships** | #7–#15 | Canonical PO choreography (PO → POAck → ASN → GR → Invoice → Remittance) and summary invoicing both pass acceptance tests. |
| **M3** | **Direct-materials SCC ships (3.1+3.2)** | #16–#19 | Scheduling Agreement + forecast collaboration + SA releases work end-to-end; ASN polymorphic predecessor verified. |
| **M4** | **Network UX is usable** | #23–#27 | Inbox/outbox/search, partner directory, dashboards, scorecards, and notifications work for all roles. |
| **M5** | **Production-ready** | #28–#31 | Observability, test breadth, CI/CD, and docs all in place; system is operable. |
| **M6** | **Direct-materials full coverage** *(post-M4)* | #20, #21, #22 | Subcontracting, consignment, quality notifications. Deferred — only pursue when a customer requires. |

---

## Phase 1 — Network Foundation

The substrate. Every later phase reuses what ships here.

### #1 — Phase 1.1: Monorepo & dev stack 🟡 in progress

**Spec:** [PHASES.md §1.1](./PHASES.md)
**Blocked by:** *(none — start here)*
**Blocks:** #2, #5

Set up pnpm workspaces with:
- `apps/api` (NestJS)
- `apps/web` (React + Vite)
- `packages/document-core`
- `packages/db`
- `packages/shared-types`

Add `docker-compose.yml` with Postgres, MinIO, MailHog. Configure TypeScript strict, ESLint, Prettier, Vitest, Playwright.

**Open decisions to make at start:**
- pnpm version pin (10.x recommended)
- Node version (22 LTS recommended)
- Lucia vs Auth.js (Lucia recommended)
- Single NestJS modular monolith confirmed?

### #2 — Phase 1.2: Identity & authentication ✅ completed (`2953196`)

**Spec:** [PHASES.md §1.2](./PHASES.md)
**Blocked by:** #1
**Blocks:** #3

Lucia (or Auth.js) + JWT. Email/password, password reset, email verification, session management. Roles: `BUYER_USER`, `BUYER_ADMIN`, `SUPPLIER_USER`, `SUPPLIER_ADMIN`, `NETWORK_ADMIN`. Multi-org user support from day one. **No** Keycloak/SSO/SAML at MVP.

### #5 — Phase 1.5: Generic document infrastructure (`document-core`) ✅ completed (`d2649d4`)

**Spec:** [PHASES.md §1.5](./PHASES.md)
**Blocked by:** #1
**Blocks:** #3

The reusable substrate. **The most consequential single task in the project.**

**Tables:**
- `documents` — id, document_type, document_number, issuer/recipient/relationship FKs, current_version_id, status, indexed scalars
- `document_versions` — **immutable**; body JSONB, version_number, created_by, created_at, change_reason
- `document_links` — DAG; from/to ids, link_type enum
- `document_audit_log` — append-only; actor, action, payload JSONB, occurred_at
- `attachments` — storage_key, filename, mime_type, size, sha256, optional version_id

**Reusable patterns to ship:**
- State-machine factory (declarative `{type → {state → [{to, requiredRole, guard?}]}}`)
- Five universal operations: `publish` / `acknowledge` / `supersede` / `cancel` / `link`
- Document numbering (pluggable: `network` vs future `external`)
- Link-type registry (which link types valid between which type pairs)
- Trading-relationship guard (NestJS guard/middleware)
- Body-schema (Zod) registry
- Notification emitter
- Attachment storage abstraction (S3/MinIO)

pg-boss with `notifications` queue wired in.

### #3 — Phase 1.3: Org & trading-partner model ✅ completed (`c466123`)

**Spec:** [PHASES.md §1.3](./PHASES.md)
**Blocked by:** #2, #5
**Blocks:** #4

The spine of the network.

- `Org` (`org_type ∈ {BUYER, SUPPLIER, BOTH}`, tax IDs, addresses, contacts)
- `OrgIdentifier` (DUNS, GLN, tax IDs, buyer-internal supplier IDs)
- `TradingRelationship(buyer_org_id, supplier_org_id, status, established_at, terminated_at)` with per-relationship config:
  - enabled document types
  - supplier's ID in buyer's namespace
  - payment terms reference, default currency, default Incoterms
  - `document_number_source ∈ {network, external}`
  - `summary_invoicing_enabled`
- `RelationshipInvitation` (token, expiry, accepted/declined/expired)

**Authorization rule pervading the system:** every document operation must verify an active `TradingRelationship` with the document type enabled. Centralised in `document-core`, never re-implemented.

### #4 — Phase 1.4: Web portal shell ✅ completed

**Spec:** [PHASES.md §1.4](./PHASES.md)
**Blocked by:** #3
**Blocks:** #6

One React + Vite app with role-based routes:
- `/buyer/*`
- `/supplier/*`
- `/admin/*`

Shared layout, nav, notification bell, org switcher. Defer per-portal app split until divergence warrants it.

### #6 — Phase 1.6: Vertical slice (M1 milestone task) ✅ completed

**Spec:** [PHASES.md §1.6](./PHASES.md)
**Blocked by:** #4
**Blocks:** #7, #28, #29

**Phase 1 acceptance.** Ship two document types end-to-end:

1. **`GENERIC_DOCUMENT`** (PDF + metadata + counterparty) — proves the free-form path
2. **`PO ↔ ORDER_CONFIRMATION`** typed pair — proves the substrate against real choreography

**Acceptance choreography (from PHASES.md "Verification" Phase 1):**
- Network admin onboards Buyer Org A and Supplier Org B, establishes `TradingRelationship`
- Buyer user from A publishes `GENERIC_DOCUMENT` with PDF attachment to B
- Supplier user from B sees it in inbox, downloads, replies with linked `GENERIC_DOCUMENT` (`RESPONDS_TO`)
- Second version of buyer's doc published; both versions visible
- Audit log shows: publish · attachment-add · version-bump · link-create · read
- Cross-org publish without a relationship is **rejected**
- Then: PO/POAck typed pair runs end-to-end with state transitions audited

**🎯 Milestone M1 reached when this task completes.**

---

## Phase 2 — Indirect-Procurement Document Choreography

Each document = one `document_type` value with Zod body schema, state machine, allowed link types, issuer-side portal form, recipient-side portal view.

### #7 — Phase 2.1: Purchase Order (PO) ✅ completed

**Spec:** [PHASES.md §2.1](./PHASES.md)

Delivered: full `DRAFT → ISSUED → ACKNOWLEDGED → IN_FULFILLMENT → CLOSED` lifecycle plus `CANCELLED`/`CHANGED` side states. Document-type module structure under `apps/api/src/document-types/po/` (body-schema · state-machine · link-rules · index) — pattern reused by every later doc type. Body covers full §2.1 contract (currency, payment terms, Incoterms, ship-to/bill-to addresses, requested delivery date, lines with description and unit-of-measure). Portal: buyer **My POs**, **Create PO** form, **PO detail** with role-aware transition buttons, supplier **Incoming POs**. New `GET /documents` endpoint with `box=inbox|outbox|both` plus filters drives the lists. 7 lifecycle tests + 1 listing test, all passing.

### #8 — Phase 2.2: PO Change (PO_CHANGE) ✅ completed

**Spec:** [PHASES.md §2.2](./PHASES.md)

Delivered: PO_CHANGE document type with `DRAFT → ISSUED → ACCEPTED_BY_SUPPLIER | REJECTED_BY_SUPPLIER` state machine. Body carries the **complete revised PO body** (not a delta diff) plus `changeReason` and optional `affectedLineRefs` — matches Ariba's model. `SUPERSEDES → PO` link rule. PO state machine's `→ CHANGED` transition gated by a precondition guard at the route layer that requires an `ACCEPTED_BY_SUPPLIER` PO_CHANGE linked to the PO. Portal: **Issue PO change** button on buyer's PO detail when status ∈ {ISSUED, ACKNOWLEDGED, IN_FULFILLMENT}, change-form page pre-filled from latest PO body, **PO_CHANGE detail page** for both sides with Accept/Reject buttons for the supplier. 5 lifecycle tests covering happy path, no-change rejection, not-yet-accepted rejection, supplier-reject preserving PO state, body validation.

### #9 — Phase 2.3: Order Confirmation / POAck ✅ completed

**Spec:** [PHASES.md §2.3](./PHASES.md)

Delivered: full §2.3 ORDER_CONFIRMATION schema as a Zod discriminated union over `mode` ∈ {`FULL_ACCEPT`, `ACCEPT_WITH_CHANGES`, `REJECT`}. `ACCEPT_WITH_CHANGES` carries a `proposedChanges` block with optional `revisedRequestedDeliveryDate` and per-line `revisedQuantity`/`revisedUnitPrice`/`revisedDeliveryDate`/`comments` — at least one revision required. State machine extended to `DRAFT → ISSUED → ACCEPTED_BY_BUYER | REJECTED_BY_BUYER` (buyer-response terminal states; meaningful for ACCEPT_WITH_CHANGES where the buyer signals intent to issue a PO_CHANGE to materialise). **Auto-link on publish**: every OC publish creates the `ACKNOWLEDGES → PO` link in the same call (a `linkWarning` field surfaces if the auto-link step fails, but the OC is still published). Portal: 3-mode `/supplier/po/:id/acknowledge` form replaces the blunt Acknowledge button; new `/<role>/order-confirmation/:id` detail page with role-aware Accept/Reject buttons and a deep-link to PO_CHANGE for ACCEPT_WITH_CHANGES. 7 lifecycle tests covering all three modes, both buyer responses, body validation, and wrong-actor rejection.

### #10 — Phase 2.4: Advance Ship Notice (ASN) ⬜

**Spec:** [PHASES.md §2.4](./PHASES.md)
**Blocked by:** #7
**Blocks:** #11

ASN (supplier→buyer). `SHIPS_AGAINST` → PO (one PO can have many ASNs for split shipments).
- States: `DRAFT → ISSUED → IN_TRANSIT → DELIVERED → CANCELLED`
- Body: shipment header (carrier, tracking, expected delivery), packing structure (handling units, lines, serial/lot if applicable)

### #11 — Phase 2.5: Goods Receipt (GOODS_RECEIPT) ⬜

**Spec:** [PHASES.md §2.5](./PHASES.md)
**Blocked by:** #10
**Blocks:** #12

GOODS_RECEIPT (buyer→supplier, **visibility copy**). At MVP buyer types it manually in portal (no ERP integration yet).
- `RECEIVES` → ASN
- `FULFILLS` → PO line(s)
- States: `DRAFT → POSTED`. Posted is terminal; corrections issue new GR with `SUPERSEDES` link.

### #12 — Phase 2.6: Invoice (PO_FLIP + SUMMARY modes) ⬜

**Spec:** [PHASES.md §2.6](./PHASES.md)
**Blocked by:** #11
**Blocks:** #13, #14

INVOICE (supplier→buyer) with `invoice_mode ∈ {PO_FLIP, SUMMARY}`. **Critical scope guard: XBN does not decide payment.**

**`PO_FLIP` mode:** single-PO invoice. `INVOICES` → exactly one PO + optional GRs. Portal pre-fills from PO.

**`SUMMARY` mode:** consolidated/periodic invoice over a billing period. `INVOICES` → many of any combination: POs, GRs, `SA_RELEASE_JIT`s, `CONSIGNMENT_CONSUMPTION`s, `SUBCONTRACT_CONSUMPTION_REPORT`s. Portal flow:
- Supplier picks relationship + billing period
- System surfaces all not-yet-invoiced fulfilled documents in window
- Supplier selects subset; consolidated lines pre-filled (grouped by source doc)
- Link-uniqueness check prevents double-billing

States: `DRAFT → SUBMITTED → ACKNOWLEDGED_BY_BUYER → DISPUTED → ACCEPTED → REJECTED`.

**Match-status field** (`MATCH_OK`, `MATCH_QTY_MISMATCH`, `MATCH_PRICE_MISMATCH`, `NO_GR`, …) is a **visibility aid**, not an approval gate. Per-line for SUMMARY; header = worst across lines.

`summary_invoicing_enabled` relationship flag gates SUMMARY mode.

### #13 — Phase 2.7: Credit Memo ⬜

**Spec:** [PHASES.md §2.7](./PHASES.md)
**Blocked by:** #12
**Blocks:** #15

CREDIT_MEMO (supplier→buyer). `CREDITS` → Invoice. States: `DRAFT → SUBMITTED → ACCEPTED → REJECTED`.

### #14 — Phase 2.8: Remittance Advice ⬜

**Spec:** [PHASES.md §2.8](./PHASES.md)
**Blocked by:** #12
**Blocks:** #15

REMITTANCE_ADVICE (buyer→supplier). `REMITS` → one or more Invoices/Credit Memos. States: `DRAFT → ISSUED` (terminal). **Notification document only — XBN does not move money.**

### #15 — Phase 2: Acceptance choreographies (M2 milestone task) ⬜

**Spec:** [PHASES.md "Verification" Phase 2](./PHASES.md)
**Blocked by:** #8, #9, #13, #14
**Blocks:** #16

Two end-to-end choreography tests:

**(1) Canonical PO choreography:**
PO → ORDER_CONFIRMATION (full accept) → PO_CHANGE → re-acknowledge → ASN×2 (partial shipments) → GR×2 → INVOICE in `PO_FLIP` mode (referencing both GRs, match-status `MATCH_OK`) → buyer accepts → REMITTANCE_ADVICE.

Verify across all of it: `document_links` forms expected DAG · every transition in `document_audit_log` · every body change is new row in `document_versions` · no row mutated in place · lineage graph renders correctly from both buyer and supplier sides.

**Negative tests:** invoice without `INVOICES` link rejected; direct `ISSUED → CLOSED` rejected; cross-relationship publish rejected; price mismatch surfaces `MATCH_PRICE_MISMATCH` without blocking publish.

**(2) Summary invoicing:**
Five POs over a calendar month → all acknowledged/shipped/received → at month end, supplier opens summary-invoice flow, picks period, sees all five fulfilled-but-uninvoiced PO/GR pairs, publishes one INVOICE in `SUMMARY` mode with `INVOICES` → all 5 POs and all 5 GRs. Header match-status reflects worst per-line. Second attempt at re-invoicing same source documents **rejected** by link-uniqueness check.

**🎯 Milestone M2 reached when this task completes.**

---

## Phase 3 — Direct-Materials SCC Collaboration

Anchor entities are **long-lived contracts** (lifetime measured in years). All reuse Phase 1 substrate verbatim.

### #16 — Phase 3.0: SCC anchor entities ⬜

**Spec:** [PHASES.md §3 anchor entities](./PHASES.md)
**Blocked by:** #15
**Blocks:** #17, #18

Three new long-lived contract document types:
- `SCHEDULING_AGREEMENT` (buyer→supplier) — anchors forecasts/releases/JIT
- `CONSIGNMENT_CONTRACT` — anchors consignment movements/settlements
- `SUBCONTRACTING_AGREEMENT` — anchors component shipments/subcontract receipts

Body schemas + state machines for each.

### #17 — Phase 3.1: Forecast Collaboration ⬜

**Spec:** [PHASES.md §3.1](./PHASES.md)
**Blocked by:** #16
**Blocks:** #19

- `FORECAST_PUBLISH` (buyer→supplier). Time-bucketed (e.g. weekly across 26-week horizon). Immutable. Supersession via `SUPERSEDES` → prior forecast for same window.
- `FORECAST_COMMIT` (supplier→buyer). `RESPONDS_TO` → FORECAST_PUBLISH. Bucketed: `commit | commit-with-deviation | cannot-commit`.

### #18 — Phase 3.2: Scheduling Agreement Releases ⬜

**Spec:** [PHASES.md §3.2](./PHASES.md)
**Blocked by:** #16
**Blocks:** #19

- `SA_RELEASE_FORECAST` (buyer→supplier, planning-grade). `CALLS_OFF` → SA.
- `SA_RELEASE_JIT` (buyer→supplier, firm call-off with delivery dates/times). `CALLS_OFF` → SA.
- Each release supersedes prior for same window.
- **JIT releases produce ASNs** — extend Phase 2 ASN type with **polymorphic predecessor** (PO *or* SA release). **This is the key cross-phase substrate test.**

### #19 — Phase 3: Acceptance choreography (M3 milestone task) ⬜

**Spec:** [PHASES.md "Verification" Phase 3](./PHASES.md)
**Blocked by:** #17, #18
**Blocks:** #20, #21, #22, #23, #24, #25, #26, #27

Establish SCHEDULING_AGREEMENT → publish weekly FORECAST_PUBLISH over 26 weeks → supplier FORECAST_COMMIT with deviations on weeks 14–18 → publish SA_RELEASE_FORECAST → supersede with fresher one (verify lineage chain) → publish SA_RELEASE_JIT → supplier ships ASN against the JIT release (the **polymorphic-predecessor test**) → buyer enters GR → consumption settles. All link types correct.

**🎯 Milestone M3 reached when this task completes.**

### #20 — Phase 3.3: Subcontracting 🕓 deferred

**Spec:** [PHASES.md §3.3](./PHASES.md)
**Blocked by:** #23, #24, #25, #26, #27 (deferred until after Phase 4)

- `SUBCONTRACT_COMPONENT_SHIPMENT` (buyer→supplier, `CALLS_OFF` → SUBCONTRACTING_AGREEMENT)
- `SUBCONTRACT_CONSUMPTION_REPORT` (supplier→buyer, links to component shipment + finished-goods ASN)

Pursue only when a customer requires.

### #21 — Phase 3.4: Consignment 🕓 deferred

**Spec:** [PHASES.md §3.4](./PHASES.md)
**Blocked by:** #23, #24, #25, #26, #27 (deferred until after Phase 4)

- `CONSIGNMENT_FILL` (supplier→buyer, ASN-shaped body)
- `CONSIGNMENT_CONSUMPTION` (buyer→supplier, periodic withdrawal report) → triggers settlement INVOICE in `SUMMARY` mode (reuses #12 machinery)

### #22 — Phase 3.5: Quality Notifications 🕓 deferred

**Spec:** [PHASES.md §3.5](./PHASES.md)
**Blocked by:** #23, #24, #25, #26, #27 (deferred until after Phase 4)

- `QUALITY_NOTIFICATION` (buyer→supplier; predecessor: GOODS_RECEIPT, ASN, or PO line)
- States: `OPENED → IN_REVIEW → RESPONDED → CLOSED`
- `QUALITY_RESPONSE` (supplier→buyer, `RESPONDS_TO` → notification)

---

## Phase 4 — Network-Wide Features

### #23 — Phase 4.1: Inbox / Outbox / cross-type document search ⬜

**Spec:** [PHASES.md §4.1](./PHASES.md)
**Blocked by:** #19
**Blocks:** #20, #21, #22

Per-user inbox (docs addressed to user's org) and outbox (docs issued by user's org), filterable by type, status, counterparty, date. Cross-type search over indexed scalars + Postgres `tsvector` full-text on `document_number` and reference fields. **No** Elasticsearch at MVP.

### #24 — Phase 4.2: Supplier directory & trading-partner management UI ⬜

**Spec:** [PHASES.md §4.2](./PHASES.md)
**Blocked by:** #19
**Blocks:** #20, #21, #22

- Buyer-side: list of supplier relationships (statuses, last-activity, doc-type capabilities)
- Supplier-side: list of buyer customers (same)
- Network admin: cross-org search, audit, relationship lifecycle

### #25 — Phase 4.3: Status dashboards ⬜

**Spec:** [PHASES.md §4.3](./PHASES.md)
**Blocked by:** #19
**Blocks:** #20, #21, #22

Queries on `documents` ⨝ `document_links` — no aggregation service needed.
- **Buyer:** open POs awaiting acknowledgement, ASNs in transit, GRs pending entry, invoices pending review, releases unconfirmed
- **Supplier:** POs to acknowledge, releases to commit, ASNs to ship, invoices submitted, payments received

### #26 — Phase 4.4: Network-relevant supplier scorecards ⬜

**Spec:** [PHASES.md §4.4](./PHASES.md)
**Blocked by:** #19
**Blocks:** #20, #21, #22

Only metrics observable from the document corpus:
- **Doc-response SLA** — time-to-acknowledge PO, time-to-commit forecast, time-to-respond to QN
- **ASN accuracy** — ASN line qty vs subsequent GR line qty
- **Invoice match rate** — % reaching `ACCEPTED` without `DISPUTED`
- **On-time delivery** — GR posted-date vs PO requested-delivery-date

Nightly aggregator into `supplier_scorecard_snapshots(buyer_org_id, supplier_org_id, period)`. **No live joins.** Excludes subjective ratings and internal financial accuracy.

### #27 — Phase 4.5: Notifications (in-app + email) ⬜

**Spec:** [PHASES.md §4.5](./PHASES.md)
**Blocked by:** #19
**Blocks:** #20, #21, #22, #30, #31

In-app notification centre populated by Phase 1 emitter. Email via SMTP (MailHog locally). Per-user preferences: digest vs immediate, per event type.

**🎯 Milestone M4 reached when this task and #23–#26 are all complete.**

---

## Phase 5 — Production Readiness

### #28 — Phase 5.1: Observability ⬜

**Spec:** [PHASES.md §5.1](./PHASES.md)
**Blocked by:** #6
**Blocks:** *(none)*

- Pino structured logs with `request_id`, `document_id`, `trading_relationship_id` correlation on every relevant entry
- Health/readiness endpoints
- OpenTelemetry traces
- Audit-log explorer in admin UI

### #29 — Phase 5.2: Testing breadth ⬜

**Spec:** [PHASES.md §5.2](./PHASES.md)
**Blocked by:** #6
**Blocks:** *(none)*

- Unit tests on every state-machine and link-validity rule
- Integration: choreography E2Es against Postgres test container
- Property-based tests on state-machine factory (no invalid transition reachable)
- Playwright on critical buyer/supplier portal paths

### #30 — Phase 5.3: CI/CD & release ⬜

**Spec:** [PHASES.md §5.3](./PHASES.md)
**Blocked by:** #27
**Blocks:** *(none)*

GitHub Actions: lint · typecheck · Vitest · Prisma migration check · Playwright smoke against ephemeral Postgres. Per-app Dockerfiles. Migration discipline (no `db push` in CI). `.env.example` and per-environment config.

### #31 — Phase 5.4: Documentation ⬜

**Spec:** [PHASES.md §5.4](./PHASES.md)
**Blocked by:** #27
**Blocks:** *(none)*

- **Document-type catalog** — per type: body schema, state machine, valid predecessor/successor link types, who can transition, expected attachments. The contract between phases.
- Trading-partner onboarding runbook

**🎯 Milestone M5 reached when #28–#31 are all complete.**

---

## Phase 6 / Future (explicitly deferred — not yet tasked)

These are tracked in PHASES.md "Phase 6 / Future" but no tasks are created until prioritised:

- REST integration API for ERPs
- cXML inbound/outbound (the natural first integration step)
- EDI (X12 850/855/856/810/820)
- PEPPOL
- SSO / SAML for buyer orgs (Keycloak comes back here)
- RabbitMQ if pg-boss outgrows itself
- Elasticsearch if Postgres FTS outgrows itself
- Turborepo if pnpm-only build times balloon
- Microservice split-out from the modular monolith

---

## Working agreements

- A task moves to ✅ **completed** only when its acceptance criteria from PHASES.md actually pass — not when "the code is written."
- If something is partial or wrong, keep status as 🟡 and create a follow-up task rather than mark done.
- When updating a task here, also update it in the live task system (`/tasks`).
- Edit this file directly when scope shifts — it is a living document, not a snapshot.
