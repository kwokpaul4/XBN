# XBN Platform — Phases & Tasks

XBN is a **buyer-supplier document-exchange network** modelled on **SAP Ariba Network / Ariba Supply Chain Collaboration (SCC)**. It is a transaction hub: buyer and supplier organisations exchange business documents through XBN, and both sides get a shared, versioned, audited record. The buyer's ERP remains the system of record for approvals, payment, and planning — XBN does not run buyer-internal workflows.

The platform supports two document worlds that coexist on the same substrate:

- **Indirect procurement** — one-shot PO anchors a finite choreography ending at remittance.
- **Direct-materials SCC** — a long-lived contract (Scheduling Agreement, Consignment Contract, Subcontracting Agreement) anchors recurring releases, shipments, consumption, and settlement.

**MVP is web-portal only.** Programmatic ingress (cXML, EDI, PEPPOL, REST API for ERPs) is explicitly Phase 6 / future.

**Stack** (Node.js): NestJS modular monolith · pnpm workspaces · PostgreSQL + Prisma · pg-boss (no RabbitMQ at MVP) · Lucia or Auth.js + JWT (no Keycloak at MVP) · MinIO/S3 for attachments · React + Vite single app with role-based routes · Vitest + Playwright.

---

## Phase 1: Network Foundation

This is the substrate. Everything in Phases 2–4 reuses what ships here. Cutting corners in Phase 1 forces every later phase to reinvent things.

### 1.1 Monorepo & dev stack
- pnpm workspaces. Layout: `apps/api` (NestJS), `apps/web` (React + Vite), `packages/document-core` (the reusable substrate), `packages/db` (Prisma schema + client), `packages/shared-types`.
- `docker-compose.yml`: Postgres, MinIO, MailHog. No RabbitMQ. No Keycloak.
- TypeScript strict, ESLint, Prettier, Vitest, Playwright.

### 1.2 Identity & authentication
- Lucia (or Auth.js) + JWT. Email/password, password reset, email verification, session management.
- Roles: `BUYER_USER`, `BUYER_ADMIN`, `SUPPLIER_USER`, `SUPPLIER_ADMIN`, `NETWORK_ADMIN`.
- Multi-org user support from day one (retrofitting is painful; network admins and consultants need it).
- No Keycloak/SSO/SAML at MVP — reintroduce only when an enterprise pilot requires it.

### 1.3 Org & trading-partner model — the spine of the product
This is the conceptual heart of a network product.

- `Org` with `org_type ∈ {BUYER, SUPPLIER, BOTH}`, tax IDs, addresses, contacts.
- `OrgIdentifier` — DUNS, GLN, tax IDs, **buyer-internal supplier IDs**. Both sides' IDs for the same supplier are stored on the relationship, not the supplier alone.
- `TradingRelationship(buyer_org_id, supplier_org_id, status, established_at, terminated_at)` plus per-relationship config: which document types are enabled, the supplier's ID in the buyer's namespace, payment-terms reference, default currency, default Incoterms, document-number-source (`network` vs future `external`), `summary_invoicing_enabled` (gates `INVOICE.invoice_mode = SUMMARY`, see §2.6).
- `RelationshipInvitation` with token, expiry, `accepted | declined | expired`.

**Authorization rule that pervades the system:** every document operation must verify an active `TradingRelationship` between the named parties, with the document's type enabled on that relationship. Centralised in `document-core`; never re-implemented per document type.

### 1.4 Web portal shell
- One React + Vite app, role-based routes: `/buyer/*`, `/supplier/*`, `/admin/*`.
- Shared layout, nav, notification bell, org switcher.
- Defer splitting into separately deployed apps until Phase 2 / later, when buyer and supplier portals diverge enough to warrant it.

### 1.5 Generic document infrastructure (`packages/document-core`)
The reusable substrate. Every typed document in Phases 2 and 3 is a thin specialisation on top.

**Tables:**
- `documents` — `id`, `document_type` (enum, growing per phase), `document_number`, `issuer_org_id`, `recipient_org_id`, `trading_relationship_id`, `current_version_id`, `status`, `created_at`, indexed scalars (`reference_number`, `total_amount`, `currency`, `issue_date`).
- `document_versions` — **immutable**. `body` JSONB canonical body, `version_number`, `created_by`, `created_at`, `change_reason`. Every mutation inserts a new row; `documents.current_version_id` advances. **No in-place updates, ever.**
- `document_links` — DAG modelling lineage. `from_document_id`, `to_document_id`, `link_type` enum (`FULFILLS`, `ACKNOWLEDGES`, `SHIPS_AGAINST`, `RECEIVES`, `INVOICES`, `CREDITS`, `REMITS`, `CALLS_OFF`, `CONSUMES`, `RESPONDS_TO`, `SUPERSEDES`, `CANCELS`, …). One PO ↔ many ASNs ↔ many GRs ↔ one or many invoices.
- `document_audit_log` — append-only. `actor_user_id`, `actor_org_id`, `action`, `payload` JSONB, `occurred_at`. Versions = *what the doc said*. Audit = *what was done and by whom*.
- `attachments` — `storage_key` (S3/MinIO), `filename`, `mime_type`, `size_bytes`, `sha256`, optional `version_id` for version-scoped attachments.

**Reusable patterns shipped in `document-core`:**
- **State-machine factory** — declarative `{type → {state → [{to, requiredRole, guard?}]}}`; one dispatcher validates, executes, audits. No bespoke transition code per document type.
- **Five universal operations**: `publish`, `acknowledge`, `supersede`, `cancel`, `link` — each emits the version + audit-log + notification properly.
- **Document numbering**: per-issuer per-type sequential with prefix; pluggable for the future `external` (ERP-issued) numbering source.
- **Link-type registry**: which link types are valid between which document-type pairs and in which direction.
- **Trading-relationship guard**: NestJS guard/middleware on every document mutation.
- **Body-schema (Zod) registry**: one schema per document type, registered once.
- **Notification emitter**: single `emit(event, document, recipients)` API; consumed by the Phase 4 worker.
- **Attachment storage abstraction**: `put / get / presign` over S3-compatible storage; SHA-256 per attachment.

**Async**: pg-boss with one queue (`notifications`), wired in but mostly idle until Phase 4.

### 1.6 Vertical slice (Phase 1 acceptance)
Ship a `GENERIC_DOCUMENT` type (PDF + metadata + counterparty) **and** the `PO ↔ ORDER_CONFIRMATION` typed pair. The typed pair proves the substrate against real choreography (lineage, state machines, audit) before Phase 2 fans out.

### Phase 1 explicitly excludes
Other typed business documents · RFQ/sourcing · catalog browsing · approval workflows · payment · scorecards.

---

## Phase 2: Indirect-Procurement Document Choreography

Each document is a `document_type` value with a Zod body schema, a state machine, allowed link types in/out, an issuer-side portal form, and a recipient-side portal view.

### 2.1 Purchase Order — `PO` (buyer → supplier)
- States: `DRAFT → ISSUED → ACKNOWLEDGED → IN_FULFILLMENT → CLOSED`. Side states: `CANCELLED`, `CHANGED`.
- Anchor of the indirect choreography. Buyer issues, changes, cancels. Supplier responds via separate documents.

### 2.2 PO Change — `PO_CHANGE` (buyer → supplier)
- `SUPERSEDES` → original PO. Supplier re-acknowledges via a new `ORDER_CONFIRMATION`.

### 2.3 Order Confirmation / POAck — `ORDER_CONFIRMATION` (supplier → buyer)
- `ACKNOWLEDGES` → PO (or PO_CHANGE).
- States: `DRAFT → ISSUED → ACCEPTED_BY_BUYER | REJECTED_BY_BUYER`.
- Modes: full-accept · accept-with-changes (proposed dates/quantities) · reject.

### 2.4 Advance Ship Notice — `ASN` (supplier → buyer)
- `SHIPS_AGAINST` → PO. One PO can have many ASNs (split shipments).
- States: `DRAFT → ISSUED → IN_TRANSIT → DELIVERED → CANCELLED`.
- Body: shipment header (carrier, tracking, expected delivery), packing structure (handling units, lines, serial/lot if applicable).

### 2.5 Goods Receipt — `GOODS_RECEIPT` (buyer → supplier, **visibility copy**)
- At MVP the buyer types it into the portal manually (no ERP integration yet). Ergonomic hit acknowledged.
- `RECEIVES` → ASN; `FULFILLS` → PO line(s).
- States: `DRAFT → POSTED`. Posted is terminal; corrections issue a new GR with `SUPERSEDES` link.

### 2.6 Invoice — `INVOICE` (supplier → buyer)
- States: `DRAFT → SUBMITTED → ACKNOWLEDGED_BY_BUYER → DISPUTED → ACCEPTED → REJECTED`.
- Body header includes `invoice_mode ∈ {PO_FLIP, SUMMARY}`, `billing_period_start`, `billing_period_end` (latter two required for `SUMMARY`, optional otherwise).
- **`PO_FLIP` mode** — single-PO invoice. `INVOICES` → exactly one PO (and optionally → GRs for 3-way visibility). Portal flow: supplier opens the PO and the system pre-fills an invoice from it; supplier edits and submits.
- **`SUMMARY` mode** — consolidated/periodic invoice covering multiple preceding documents over a billing period. `INVOICES` → **many** of any combination of: POs, GRs, `SA_RELEASE_JIT`s, `CONSIGNMENT_CONSUMPTION`s, `SUBCONTRACT_CONSUMPTION_REPORT`s. Portal flow: supplier picks the trading relationship and a billing period; the system surfaces all not-yet-invoiced fulfilled documents in that window; supplier selects a subset, the system pre-fills consolidated lines (grouped by source document, configurable per relationship), supplier edits and submits. A document is "not-yet-invoiced" iff no `INVOICES` link points to it; the substrate's link-uniqueness check enforces no double-billing.
- **Match-status field** (`MATCH_OK`, `MATCH_QTY_MISMATCH`, `MATCH_PRICE_MISMATCH`, `NO_GR`, …) is a **visibility aid** for the buyer's AP team computed from linked documents. **Not an approval gate.** XBN does not decide whether the invoice is paid. For `SUMMARY` invoices, match-status is computed per-line against its source document; the header status is the worst across lines.
- Per-relationship config flag `summary_invoicing_enabled` gates whether `SUMMARY` mode is available on that trading relationship (see §1.3).

### 2.7 Credit Memo — `CREDIT_MEMO` (supplier → buyer)
- `CREDITS` → Invoice. States: `DRAFT → SUBMITTED → ACCEPTED → REJECTED`.

### 2.8 Remittance Advice — `REMITTANCE_ADVICE` (buyer → supplier)
- `REMITS` → one or more Invoices/Credit Memos. States: `DRAFT → ISSUED` (terminal).
- **Notification document only** — "we paid X against these invoices on this date via this method". XBN does not move money. The supplier reconciles their AR against this.

### Phase 2 explicitly excludes
RFQ/quoting · catalog · buyer-internal approval workflow on POs/invoices · automated payment · dispute-resolution workflow beyond the `DISPUTED` status.

---

## Phase 3: Direct-Materials SCC Collaboration

The other half of the network. Anchor entities here are **long-lived contracts**, lifetime measured in years.

### Anchor entities (introduced in this phase)
- `SCHEDULING_AGREEMENT` (buyer → supplier) — umbrella with item, target quantity, validity period, plant, ship-to, pricing. Anchors forecasts, releases, JIT call-offs.
- `CONSIGNMENT_CONTRACT` (buyer → supplier) — anchors consignment movements and periodic consumption settlements.
- `SUBCONTRACTING_AGREEMENT` (buyer → supplier) — anchors component shipments and subcontract receipts.

All reuse the Phase 1 substrate verbatim — they are document types like any other, just with longer lifecycles.

### 3.1 Forecast Collaboration
- `FORECAST_PUBLISH` (buyer → supplier) — periodic, time-bucketed (typically weekly across e.g. a 26-week horizon). Each publish is immutable; supersession via `SUPERSEDES` → prior forecast for the same window.
- `FORECAST_COMMIT` (supplier → buyer) — bucketed `commit | commit-with-deviation | cannot-commit`. `RESPONDS_TO` → `FORECAST_PUBLISH`.

### 3.2 Scheduling Agreement Releases
- `SA_RELEASE_FORECAST` (buyer → supplier) — planning-grade release against an SA. `CALLS_OFF` → SA.
- `SA_RELEASE_JIT` (buyer → supplier) — firm call-off with delivery dates/times. `CALLS_OFF` → SA.
- Each release supersedes the prior release for the same window. The current truth is always the latest.
- **JIT releases produce `ASN`s** — the Phase 2 ASN type, with a polymorphic predecessor (PO *or* SA release). This is the cross-phase test that the substrate is general enough.

### 3.3 Subcontracting
- `SUBCONTRACT_COMPONENT_SHIPMENT` (buyer → supplier) — buyer ships components for the supplier to assemble. `CALLS_OFF` → `SUBCONTRACTING_AGREEMENT`.
- `SUBCONTRACT_CONSUMPTION_REPORT` (supplier → buyer) — reports component consumption against a finished-goods shipment; links to both the component shipment and the finished-goods ASN.

### 3.4 Consignment movements
- `CONSIGNMENT_FILL` (supplier → buyer) — stock placed at buyer's location, still owned by supplier. Reuses ASN-shaped body.
- `CONSIGNMENT_CONSUMPTION` (buyer → supplier) — periodic report of withdrawals. Triggers a settlement Invoice (an `INVOICE` in `SUMMARY` mode with `INVOICES` → one or more consumption reports, see §2.6).

### 3.5 Quality Notifications
- `QUALITY_NOTIFICATION` (buyer → supplier, typically). Predecessor: `GOODS_RECEIPT`, `ASN`, or PO line.
- States: `OPENED → IN_REVIEW → RESPONDED → CLOSED`.
- `QUALITY_RESPONSE` (supplier → buyer) — `RESPONDS_TO` → notification.

### Phase 3 sizing
Default: **ship 3.1 + 3.2 only** in Phase 3, then split 3.3, 3.4, 3.5 into mini-phases after Phase 4. The full SCC scope is large; this default keeps Phase 3 shippable. Reconsider only if a customer requires the full set.

### Phase 3 explicitly excludes
MRP · ATP/CTP · supplier capacity planning · anything that runs planning algorithms.

---

## Phase 4: Network-Wide Features

### 4.1 Inbox / Outbox / cross-type document search
- Per-user inbox (documents addressed to the user's org) and outbox (documents issued by the user's org), filterable by type, status, counterparty, date.
- Cross-type search over indexed scalars + full-text on `document_number` and reference fields. Postgres `tsvector` only — no Elasticsearch at MVP.

### 4.2 Supplier directory & trading-partner management UI
- Buyer-side: list of supplier relationships, statuses, last-activity timestamps, doc-type capabilities.
- Supplier-side: list of buyer customers (the same).
- Network admin: cross-org search, audit, relationship lifecycle.

### 4.3 Status dashboards
Queries on `documents` ⨝ `document_links` — no aggregation service needed.
- Buyer: open POs awaiting acknowledgement, ASNs in transit, GRs pending entry, invoices pending review, releases unconfirmed.
- Supplier: POs to acknowledge, releases to commit, ASNs to ship, invoices submitted, payments received.

### 4.4 Network-relevant supplier scorecards
Only metrics observable from the document corpus itself:
- **Document-response SLA** — time-to-acknowledge PO, time-to-commit forecast, time-to-respond to quality notification.
- **ASN accuracy** — ASN line quantities vs subsequent GR line quantities.
- **Invoice match rate** — percentage of invoices reaching `ACCEPTED` without `DISPUTED`.
- **On-time delivery** — GR posted-date vs PO requested-delivery-date.

Implementation: nightly aggregator into `supplier_scorecard_snapshots(buyer_org_id, supplier_org_id, period)`. No live joins.

**Excludes** subjective ratings, internal financial accuracy, and anything that requires buyer-internal approval-workflow data.

### 4.5 Notifications
- In-app notification centre populated by the Phase 1 emitter.
- Email via SMTP (MailHog locally).
- Per-user preferences: digest vs immediate, per event type.

### Phase 4 explicitly excludes
Configurable approval workflows · workflow engine. Approval is buyer-internal-ERP territory. XBN merely shows whether the buyer has acknowledged/accepted a document.

---

## Phase 5: Production Readiness

### 5.1 Observability
- Pino structured logs with `request_id`, `document_id`, `trading_relationship_id` correlation on every relevant entry.
- Health/readiness endpoints.
- OpenTelemetry traces.
- Audit-log explorer in the admin UI.

### 5.2 Testing breadth
- Unit on every state-machine and link-validity rule.
- Integration: choreography E2Es (see Verification below) against a Postgres test container.
- Property-based tests on the state-machine factory (no invalid transition reachable).
- Playwright on critical buyer/supplier portal paths.

### 5.3 CI/CD & release
- GitHub Actions: lint · typecheck · Vitest · Prisma migration check · Playwright smoke against ephemeral Postgres.
- Per-app Dockerfiles.
- Migration discipline — every schema change ships with a migration; no `db push` in CI.
- `.env.example` and per-environment config.

### 5.4 Documentation
- **Document-type catalog** — the canonical reference: per type, the body schema, state machine, valid predecessor and successor link types, who can transition, expected attachments. This document is the contract between phases.
- Trading-partner onboarding runbook.

---

## Phase 6 / Future (explicitly deferred)

Programmatic ingress beyond the portal:
- **REST integration API** for ERPs.
- **cXML inbound/outbound** — natural next step; most networks speak it.
- **EDI** (X12 850/855/856/810/820) — large effort, defer unless a customer requires it.
- **PEPPOL** — only if EU customers demand it.

Other deferred-with-marker decisions:
- SSO / SAML for buyer orgs (Keycloak comes back here).
- RabbitMQ / event bus if pg-boss outgrows itself.
- Elasticsearch if Postgres FTS outgrows itself.
- Turborepo if pnpm-only build times balloon.
- Microservice split-out from the modular monolith.

---

## Verification — choreography acceptance per phase

Each phase is verified by running an end-to-end document choreography (integration test harness + a Playwright run on the portal).

**Phase 1.** Network admin onboards Buyer Org A and Supplier Org B and establishes a `TradingRelationship`. A buyer user from A publishes a `GENERIC_DOCUMENT` with a PDF attachment to B. A supplier user from B sees it in their inbox, downloads the attachment, replies with a `GENERIC_DOCUMENT` linked via `RESPONDS_TO`. A second version of the buyer's document is published; both versions are visible; audit log shows publish · attachment-add · version-bump · link-create · read. Cross-org publish without a relationship is rejected. Then the typed `PO ↔ ORDER_CONFIRMATION` pair runs end-to-end with state transitions audited.

**Phase 2 (canonical PO choreography).** Buyer publishes PO → supplier `ORDER_CONFIRMATION` (full accept) → buyer `PO_CHANGE` → supplier re-acknowledges → supplier ships first `ASN` → buyer enters partial `GOODS_RECEIPT` → supplier ships second `ASN` → buyer enters second `GOODS_RECEIPT` (PO closes) → supplier publishes `INVOICE` in `PO_FLIP` mode referencing both GRs, match-status `MATCH_OK` → buyer accepts → buyer publishes `REMITTANCE_ADVICE`. Across all of this: `document_links` forms the expected DAG · every transition is in `document_audit_log` · every body change is a new row in `document_versions` · no row is mutated in place · the lineage graph in the portal renders correctly from both buyer and supplier sides. Negative tests: invoice without a `INVOICES` link rejected; direct `ISSUED → CLOSED` rejected; cross-relationship publish rejected; price mismatch surfaces `MATCH_PRICE_MISMATCH` without blocking publish.

**Phase 2 (summary invoicing).** Over a calendar month the buyer issues five POs to the same supplier on a relationship with `summary_invoicing_enabled = true`. Each PO is acknowledged, shipped via ASN, and received via GR. At month end the supplier opens the summary-invoice flow, picks the relationship and the month as the billing period, sees all five fulfilled-but-uninvoiced PO/GR pairs, selects all of them, and publishes one `INVOICE` in `SUMMARY` mode with `INVOICES` → all five POs and all five GRs. Header match-status reflects the worst per-line status. A second attempt to issue another summary invoice covering any of the same source documents is rejected by the link-uniqueness check (no double-billing). Buyer accepts; remittance follows.

**Phase 3 (SA + releases + forecast).** Buyer establishes a `SCHEDULING_AGREEMENT`. Buyer publishes weekly `FORECAST_PUBLISH` over a 26-week horizon. Supplier issues `FORECAST_COMMIT` with deviations on weeks 14–18. Buyer publishes `SA_RELEASE_FORECAST`, then later supersedes it with a fresher one — lineage shows the chain, latest is the truth. Buyer publishes `SA_RELEASE_JIT` for next-week delivery. Supplier ships an `ASN` against the JIT release (the **polymorphic-predecessor** test — the Phase 2 ASN type works against an SA release as well as a PO). Buyer enters GR; consumption settles. All link types correct.

**Phase 4.** Inbox/outbox returns the right documents per role with correct counts. Cross-type search by `document_number`, counterparty, status returns expected rows. The nightly scorecard job populates `supplier_scorecard_snapshots` and surfaces the four metrics with values matching hand-computed expectations from Phase 2/3 fixtures. Notifications fire on publish events; preferences suppress them as configured.

**Phase 5.** CI green on lint · typecheck · Vitest · Prisma migration check · Playwright smoke against ephemeral Postgres. Pino logs include `request_id`, `document_id`, `trading_relationship_id`. OpenTelemetry traces show a publish operation spanning controller → service → repo → notification-emit. `docker-compose up` from a clean clone produces a working local stack within a documented time; `pnpm seed` populates a buyer org, supplier org, relationship, and a small document fixture.
