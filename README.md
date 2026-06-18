# XBN

**XBN is a B2B document-exchange network** for buyer-supplier trading partners, modelled on **SAP Ariba Network / Ariba Supply Chain Collaboration (SCC)**. It is a transaction hub: two organisations exchange business documents through XBN and both sides get a shared, versioned, audited record.

XBN is **not** a system of record for either party's procurement, AP, or planning workflows — those stay in the buyer's ERP.

## Status

✅ **Phase 1 (Milestone M1) complete.** The substrate works end-to-end: identity, multi-org membership, trading-partner relationships, document publishing with versioning + lineage + audit, attachments, and a minimal portal — all proven by 89 passing tests including a full M1 acceptance choreography against real Postgres + MinIO.

Phase 2 (typed PO / ASN / GR / Invoice / Credit Memo / Remittance flows) and beyond are not yet built. See [`PHASES.md`](./PHASES.md) for the full roadmap and [`TASKS.md`](./TASKS.md) for current task state.

## Scope

XBN supports two coexisting document worlds on the same substrate:

- **Indirect procurement** — `PO → PO_CHANGE → ORDER_CONFIRMATION → ASN → GOODS_RECEIPT → INVOICE → CREDIT_MEMO → REMITTANCE_ADVICE`. Anchored on a one-shot PO; choreography terminates at remittance. Includes both **PO-flip** invoicing and **summary (consolidated/periodic) invoicing**.
- **Direct-materials SCC** — long-lived `SCHEDULING_AGREEMENT` / `CONSIGNMENT_CONTRACT` / `SUBCONTRACTING_AGREEMENT` anchors recurring releases, shipments, consumption, and settlement (forecast collaboration, JIT call-offs, subcontracting, consignment, quality notifications).

**MVP is web-portal only.** Programmatic ingress (cXML, EDI, PEPPOL, REST API for ERPs) is explicitly Phase 6 / future.

## Quickstart

```bash
# 1. One-time install
pnpm install

# 2. Start Postgres + MinIO + MailHog
docker compose up -d

# 3. Apply the Phase 1 schema (one-time)
DATABASE_URL="postgresql://xbn:xbn_dev@localhost:5432/xbn" \
  pnpm --filter @xbn/db exec prisma migrate deploy

# 4. Run the API (terminal 1) and the portal (terminal 2)
pnpm --filter @xbn/api dev      # → :3000
pnpm --filter @xbn/web dev      # → :5173
```

Then open <http://localhost:5173> and follow [`docs/OPERATIONS.md`](./docs/OPERATIONS.md).

## Documentation

### Operations (start here if you want to use XBN)

| Document | Purpose |
|---|---|
| [docs/OPERATIONS.md](./docs/OPERATIONS.md) | **User operations manual.** Step-by-step instructions for every operation that works today, both web-portal and API (curl) flows. |
| [docs/API_REFERENCE.md](./docs/API_REFERENCE.md) | Endpoint-by-endpoint HTTP API reference. |
| [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md) | Common failure modes and how to recover. |

### Architecture & roadmap

| Document | Purpose |
|---|---|
| [PHASES.md](./PHASES.md) | Product/architecture spec — five phases, document-type catalogue, verification choreographies. **Source of truth.** |
| [TASKS.md](./TASKS.md) | Living development task list with milestones (M1–M6) and dependencies. |
| [CLAUDE.md](./CLAUDE.md) | Guidance for Claude Code (claude.ai/code) when working in this repo. |

## Stack (current)

Node 22 · pnpm 11 workspaces · TypeScript strict · PostgreSQL 17 + Prisma 7 · Express 5 · React 19 + Vite 6 · MinIO (S3-compatible) · Vitest 3 · Argon2id (`@node-rs/argon2`) · Oslo crypto primitives. Local dev stack via [`docker-compose.yml`](./docker-compose.yml).

See [PHASES.md §1.1](./PHASES.md) for the monorepo layout.

## License

TBD.
