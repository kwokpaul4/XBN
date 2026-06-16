# XBN

**XBN is a planned B2B document-exchange network** for buyer-supplier trading partners, modelled on **SAP Ariba Network / Ariba Supply Chain Collaboration (SCC)**. It is a transaction hub: two organisations exchange business documents through XBN and both sides get a shared, versioned, audited record.

XBN is **not** a system of record for either party's procurement, AP, or planning workflows — those stay in the buyer's ERP.

## Status

> ⚠️ **Pre-implementation.** This repository currently contains specifications only — no code, no build tooling, no tests. The plan and tasks are tracked in the docs below.

## Scope

XBN supports two coexisting document worlds on the same substrate:

- **Indirect procurement** — `PO → PO_CHANGE → ORDER_CONFIRMATION → ASN → GOODS_RECEIPT → INVOICE → CREDIT_MEMO → REMITTANCE_ADVICE`. Anchored on a one-shot PO; choreography terminates at remittance. Includes both **PO-flip** invoicing and **summary (consolidated/periodic) invoicing**.
- **Direct-materials SCC** — long-lived `SCHEDULING_AGREEMENT` / `CONSIGNMENT_CONTRACT` / `SUBCONTRACTING_AGREEMENT` anchors recurring releases, shipments, consumption, and settlement (forecast collaboration, JIT call-offs, subcontracting, consignment, quality notifications).

**MVP is web-portal only.** Programmatic ingress (cXML, EDI, PEPPOL, REST API for ERPs) is explicitly Phase 6 / future.

## Documents

| Document | Purpose |
|---|---|
| [PHASES.md](./PHASES.md) | The product/architecture spec — five phases, document-type catalogue, verification choreographies. **Source of truth.** |
| [TASKS.md](./TASKS.md) | Living development task list with milestones (M1–M6) and dependencies. |
| [CLAUDE.md](./CLAUDE.md) | Guidance for Claude Code (claude.ai/code) when working in this repo. |

## Stack (intended)

Node.js · NestJS modular monolith · pnpm workspaces · PostgreSQL + Prisma · pg-boss · Lucia/Auth.js + JWT · MinIO/S3 for attachments · React + Vite · Vitest + Playwright. Local dev stack via `docker-compose.yml` (Postgres, MinIO, MailHog).

See [PHASES.md §1.1](./PHASES.md) for the monorepo layout.

## License

TBD.
