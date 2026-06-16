# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository status

This repository is **pre-implementation**. As of this writing the only tracked files are `CLAUDE.md` and `PHASES.md` — there is no source code, no package manifest, no build tooling, and no tests yet. `PHASES.md` is the authoritative product/architecture spec; treat it as the source of truth when scaffolding work, and update it when scope changes.

Because nothing has been built, there are no real build/lint/test commands to document yet. Add them here as the foundation in Phase 1 lands. Do not invent commands that don't exist.

## What XBN is

XBN is a planned **B2B document-exchange network** modelled on **SAP Ariba Network / Ariba Supply Chain Collaboration (SCC)**. It moves business documents between buyer and supplier organisations and gives both sides a shared, audited, versioned record of every document they exchange.

XBN is **not** a system of record for either party's procurement, AP, or planning workflows — those stay in the buyer's ERP. XBN is a transaction hub.

It supports two document worlds on the same substrate:

- **Indirect procurement choreography** — `PO → PO_CHANGE → ORDER_CONFIRMATION → ASN → GOODS_RECEIPT → INVOICE → CREDIT_MEMO → REMITTANCE_ADVICE`. Anchored on a one-shot PO; choreography terminates at remittance.
- **Direct-materials SCC choreography** — long-lived `SCHEDULING_AGREEMENT` / `CONSIGNMENT_CONTRACT` / `SUBCONTRACTING_AGREEMENT` anchors recurring `FORECAST_PUBLISH`, `FORECAST_COMMIT`, `SA_RELEASE_FORECAST`, `SA_RELEASE_JIT`, subcontracting and consignment movements, and `QUALITY_NOTIFICATION`s.

**MVP is web-portal only.** Programmatic ingress (cXML, EDI, PEPPOL, REST API for ERPs) is explicitly Phase 6 / future.

Roles: `BUYER_USER`, `BUYER_ADMIN`, `SUPPLIER_USER`, `SUPPLIER_ADMIN`, `NETWORK_ADMIN` (see PHASES.md §1.2). Multi-org membership is supported from day one.

## Intended architecture (per PHASES.md)

Node.js stack, single modular monolith — not microservices at MVP:

- `apps/api` — NestJS, modularised internally by document type (not split into services).
- `apps/web` — React + Vite, **one** app with role-based routes `/buyer/*`, `/supplier/*`, `/admin/*`. Defer per-portal app split until divergence warrants it.
- `packages/document-core` — the reusable substrate (versioning, lineage, audit, state-machine factory, link-type registry, trading-relationship guard, body-schema registry, notification emitter, attachment storage, document numbering). Every later phase imports from here.
- `packages/db` — Prisma schema and client.
- `packages/shared-types` — types shared between web and api.

Persistence: **PostgreSQL + Prisma**. Documents stored as JSONB canonical body in immutable `document_versions` rows plus indexed scalars on `documents`; lineage in `document_links`; auditing in `document_audit_log`; attachments in S3 (MinIO locally).

Async: **pg-boss** on Postgres. No RabbitMQ at MVP.

Auth: **Lucia** (or Auth.js) + JWT. No Keycloak at MVP.

Tooling: pnpm workspaces (no Nx/Turborepo at MVP) · TypeScript strict · ESLint · Prettier · Vitest · Playwright. Local dev stack: Postgres + MinIO + MailHog via `docker-compose.yml`.

### Cross-cutting concerns that span the whole platform

These are the parts a future Claude instance won't grasp from any single file. Keep them coherent as the codebase grows.

- **The document is the domain object.** Identity (id + number) · version (immutable in `document_versions`) · lineage (`document_links`) · status (per-type state machine) · parties (issuer org, recipient org) · attachments. New features are virtually always a new document type, a new link type, or a new state transition — not a new bespoke entity model. If you find yourself adding a sibling table to `documents`, stop and check whether it should be a document type instead.

- **The versioning + lineage + audit-log triad.** Every mutation must (a) produce a new immutable row in `document_versions`, (b) update `document_links` if lineage changed, (c) emit an entry in `document_audit_log`. **No service may mutate `documents.body` in place. No service may rewrite prior `document_versions`. The audit log is append-only.** This triad is what makes XBN trustworthy as a shared record between two organisations; violating it breaks the product.

- **Trading-partner relationship is a precondition for every document.** A document can only flow from `issuer_org` to `recipient_org` if there is an active `TradingRelationship` between them and the document's type is enabled on that relationship. This check lives in `document-core` and must not be re-implemented per document type. A relationship's per-document-type capability flags are how a buyer says "I'll accept invoices from this supplier on the network but not yet ASNs."

- **Per-document state machines are a reusable pattern, not bespoke code.** State machines are declarative configs in `document-core` (states, allowed transitions, required role per transition). Adding a document type means adding a config — not writing transition code. Don't reach for XState or a workflow engine; the substrate is intentionally small.

- **Two coexisting choreography patterns: PO-anchored vs SA-anchored.** Indirect-procurement documents hang off a one-shot PO and the choreography terminates at remittance. Direct-materials documents hang off a long-lived Scheduling Agreement / Consignment Contract / Subcontracting Agreement, with releases and movements that recur for the contract's life. Same `documents` table, same link-type vocabulary, different anchors and lifecycles. Don't unify them into one shape; don't fork the substrate.

- **XBN is not a system of record for buyer-internal processes.** Specifically out of scope at MVP and **forever-unless-explicitly-revisited**: buyer-internal approval workflows, payment execution, GL/financial posting, MRP, ATP, planning. Invoice match-status (`MATCH_OK`, `MATCH_QTY_MISMATCH`, …) is a **visibility flag**, not an approval gate. Goods Receipts in XBN are **copies** of the buyer's ERP record. Remittance Advice is a **notification**, not money movement. If a feature requires XBN to make an authoritative buyer-internal decision, that's a signal it belongs in the buyer's ERP, not here.

- **Portal-only at MVP — by scope, not by architecture.** Design `document-core` so a future cXML / REST / EDI ingress is "just another producer of documents" — same publish operation, same trading-relationship guard, same versioning and audit triad. The portal is one ingress; later integrations are more.

### Phasing discipline

PHASES.md numbers everything (1.1, 1.2, …). Don't build typed document types before `document-core` is solid in Phase 1. If Phase 3 needs a substrate change, that's a Phase 1 change, not a Phase 3 fork. If a task seems to require something from a later phase or from the future (cXML, payment posting, internal approval routing), stop and re-scope.

## Updating this file

When the foundation is scaffolded, replace this section with the real commands:
- pnpm task invocations (build, lint, test, dev) at the workspace root and per package
- how to run a single test (Vitest filter) and the full Playwright suite
- how to bring up the docker-compose dev stack (`docker compose up`)
- Prisma migration commands (`pnpm db:migrate`, `pnpm db:seed`)
- how to run just `apps/api` or just `apps/web` against the local stack

Until then, keep this file honest about what does and doesn't exist.
