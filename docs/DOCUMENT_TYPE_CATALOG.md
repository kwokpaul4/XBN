# XBN — Document Type Catalog

The canonical reference for every document type XBN ships. For each type: the body schema, state machine, valid link rules, who can transition, and where the type sits in the choreography. If two docs disagree, **this file wins** — it is the contract between phases.

**Snapshot:** 16 document types across Phases 1.6, 2.1–2.8, and 3.0–3.2. Portal forms cover PO / PO_CHANGE / ORDER_CONFIRMATION; every other type is API-only pending a UI follow-up (see [`OPERATIONS.md` §19](./OPERATIONS.md)).

**How to read a row.**

- **Direction** — who issues → who receives.
- **States** — the state machine, terminal states in `bold`.
- **Auto-links** — the links the `/documents` publish endpoint creates automatically from body references. Explicit `POST /documents/:id/links` calls remain available for anything else registered in the link registry.
- **Precondition** — a guard the substrate enforces before the transition.

---

## 1. Phase 1.6 substrate types

### `GENERIC_DOCUMENT`

Vertical-slice type. Any body shape (`{ note: string, metadata?: object }`); one universal state.

- **Direction:** any → any (both sides can issue)
- **States:** `PUBLISHED` (terminal for practical purposes; `CANCELLED` reachable by admin)
- **Links:** `GENERIC_DOCUMENT → GENERIC_DOCUMENT` via `RESPONDS_TO` (many-in / one-out)
- **Attachments:** unlimited
- **Use:** developer scaffolding, ad-hoc network correspondence, PDF exchange with no typed contract

---

## 2. Phase 2 — Indirect procurement choreography

### `PO` — Purchase Order (§2.1)

The anchor of the indirect-procurement flow. One-shot; the choreography terminates at remittance.

- **Direction:** buyer → supplier
- **Body:** header (currency, payment terms, ship-to / bill-to, requested delivery date) + line items (sku, description, quantity, unit price, UoM)
- **States:** `DRAFT → ISSUED → ACKNOWLEDGED → IN_FULFILLMENT → CLOSED` · side states **`CANCELLED`** and **`CHANGED`**
- **Auto-links:** none on publish; a `PO_CHANGE` with `supersedesPoDocumentId` auto-links back
- **Preconditions:**
  - `→ CHANGED` requires an `ACCEPTED_BY_SUPPLIER` `PO_CHANGE` linked via `SUPERSEDES → this PO`. Without one, transition is rejected with `reason.kind: precondition_failed / detail.kind: no_accepted_po_change`.

### `ORDER_CONFIRMATION` — POAck (§2.3)

Supplier's typed acknowledgement of a PO. **Never** mutates the PO body — the acknowledgement lives on this document only; a PO_CHANGE is what materialises supplier-proposed changes.

- **Direction:** supplier → buyer
- **Body:** discriminated on `mode`:
  - `FULL_ACCEPT` — no line changes
  - `ACCEPT_WITH_CHANGES` — `proposedChanges: LineChange[]` (non-empty)
  - `REJECT` — with `reason`
  - always carries `poDocumentNumber` + `poDocumentId`
- **States:** `DRAFT → ISSUED → ACCEPTED_BY_BUYER | REJECTED_BY_BUYER` (terminal)
- **Auto-links on publish:** `ACKNOWLEDGES → PO`

### `PO_CHANGE` (§2.2)

Buyer-issued amendment. Body carries the full revised PO body plus the reference to the original PO.

- **Direction:** buyer → supplier
- **Body:** `{ poDocumentNumber, poDocumentId, changeReason, revisedBody: <full PO body> }`
- **States:** `DRAFT → ISSUED → ACCEPTED_BY_SUPPLIER | REJECTED_BY_SUPPLIER` (terminal)
- **Auto-links on publish:** `SUPERSEDES → PO`
- **Downstream effect:** an `ACCEPTED_BY_SUPPLIER` PO_CHANGE is the precondition that unlocks the PO's `→ CHANGED` transition.

### `ASN` — Advance Ship Notice (§2.4, extended by §3.2)

Supplier's notification of a shipment. **Polymorphic predecessor** — an ASN's body carries either `poDocumentId` (Phase 2) or `saReleaseJitDocumentId` (Phase 3.2 cross-phase substrate test); the auto-linker resolves `SHIPS_AGAINST` to whichever is present.

- **Direction:** supplier → buyer
- **Body:** shipment header (carrier, tracking number, ship-from, dates) + `lines[]` (lineRef, sku, shippedQuantity, UoM, optional lot / serials) + optional `handlingUnits[]`
- **States:** `DRAFT → ISSUED → IN_TRANSIT → DELIVERED` · side state `CANCELLED`
- **Auto-links on publish:**
  - `SHIPS_AGAINST → PO` if `poDocumentId` present
  - `SHIPS_AGAINST → SA_RELEASE_JIT` if `saReleaseJitDocumentId` present

### `GOODS_RECEIPT` (§2.5)

Buyer's visibility copy of a receipt — this is **not** a system-of-record posting; the buyer's ERP retains authority. See CLAUDE.md cross-cutting concern #6.

- **Direction:** buyer → supplier
- **Body:** `postedDate`, `receivedBy`, `lines[]` (lineRef, sku, receivedQuantity, UoM)
- **States:** initial `POSTED` (terminal for the network view)
- **Auto-links on publish:**
  - `RECEIVES → ASN`
  - `FULFILLS → PO`

### `INVOICE` (§2.6)

- **Direction:** supplier → buyer
- **Body:** discriminated on `mode`:
  - `PO_FLIP` — single PO reference + lines
  - `SUMMARY` — `sourceDocuments[]` covering many POs / GRs; only allowed when the relationship has `summaryInvoicingEnabled = true`
- **States:** `DRAFT → ISSUED → ACCEPTED_BY_BUYER | DISPUTED`
- **Auto-links on publish:**
  - `PO_FLIP`: `INVOICES → PO` plus `INVOICES → each GR` referenced in `goodsReceipts[]`
  - `SUMMARY`: `INVOICES → each source doc` (both POs and GRs)
- **Preconditions:**
  - `SUMMARY` mode + relationship flag off → `reason.detail.kind: summary_invoicing_not_enabled`
  - **No-double-billing guard**: the substrate scans for existing `INVOICES` links to the source POs and rejects with `reason.detail.kind: duplicate_link` if any prior invoice claims the same source. Kept as a post-publish scan so the audit log captures the rejected attempt.

### `CREDIT_MEMO` (§2.7)

- **Direction:** supplier → buyer
- **Body:** `{ invoiceDocumentNumber, invoiceDocumentId, amount, currency, reason, lines? }`
- **States:** `DRAFT → ISSUED → ACCEPTED_BY_BUYER`
- **Auto-links on publish:** `CREDITS → INVOICE`

### `REMITTANCE_ADVICE` (§2.8)

**Notification only.** XBN does not move money. Recording remittance is a network-level courtesy; the payment itself lives in the buyer's AP system.

- **Direction:** buyer → supplier
- **Body:** payment reference, payment date, amount, currency, `invoices[]`, optional `creditMemos[]`
- **States:** initial `ISSUED` (terminal)
- **Auto-links on publish:** `REMITS → each invoice` and `REMITS → each credit memo`

---

## 3. Phase 3 — Direct-materials SCC choreography

### `SCHEDULING_AGREEMENT` (§3 anchor)

Long-lived contract (validity in years). Anchor for forecasts and releases.

- **Direction:** buyer → supplier
- **Body:** item / target quantity / validity window / plant / ship-to / payment terms / Incoterms
- **States:** `DRAFT → ACTIVE ↔ SUSPENDED → TERMINATED` · side state `CANCELLED`
- **Auto-links on publish:** none (children reference this doc)
- **Note:** `TERMINATED` and `CANCELLED` are terminal. `SUSPENDED` is reversible.

### `CONSIGNMENT_CONTRACT` (§3 anchor)

Anchor for consignment stock. Choreography documents (`CONSIGNMENT_FILL`, `CONSIGNMENT_CONSUMPTION`) are Phase 3.4 — deferred.

- **Direction:** buyer → supplier
- **Body:** item / stock location / reorder point / settlement cadence / unit price / validity window
- **States:** same as SCHEDULING_AGREEMENT

### `SUBCONTRACTING_AGREEMENT` (§3 anchor)

Anchor for subcontract assembly. Choreography documents (`SUBCONTRACT_COMPONENT_SHIPMENT`, `SUBCONTRACT_CONSUMPTION_REPORT`) are Phase 3.3 — deferred.

- **Direction:** buyer → supplier
- **Body:** finished good + assembly fee + components BOM + validity window + ship-to
- **States:** same as SCHEDULING_AGREEMENT

### `FORECAST_PUBLISH` (§3.1)

Buyer's bucketed forecast against a scheduling agreement. Revisions supersede prior forecasts for the same window.

- **Direction:** buyer → supplier
- **Body:** SA reference / item / horizon window / `buckets[]` (each `{ periodStart, periodEnd, forecastQuantity }`) / optional `supersedesForecastDocumentId`
- **States:** `DRAFT → ISSUED` (terminal)
- **Auto-links on publish:**
  - `CALLS_OFF → SCHEDULING_AGREEMENT`
  - Optional `SUPERSEDES → prior FORECAST_PUBLISH`

### `FORECAST_COMMIT` (§3.1)

Supplier's response. Bucket `mode` is a Zod discriminated union: `COMMIT` / `COMMIT_WITH_DEVIATION` (with `deviationReason`) / `CANNOT_COMMIT` (with `reason`).

- **Direction:** supplier → buyer
- **Body:** forecast reference / item / `buckets[]` (each `{ mode, periodStart, periodEnd, ... }`)
- **States:** `DRAFT → ISSUED` (terminal)
- **Auto-links on publish:** `RESPONDS_TO → FORECAST_PUBLISH`

### `SA_RELEASE_FORECAST` (§3.2)

Planning-grade release: rolling window of upcoming demand. Revisions supersede.

- **Direction:** buyer → supplier
- **Body:** SA reference / item / window / `releaseLines[]` (`requestedDeliveryDate`, `quantity`, UoM) / optional `supersedesReleaseDocumentId`
- **States:** `DRAFT → ISSUED` (terminal)
- **Auto-links on publish:**
  - `CALLS_OFF → SCHEDULING_AGREEMENT`
  - Optional `SUPERSEDES → prior SA_RELEASE_FORECAST`

### `SA_RELEASE_JIT` (§3.2)

Firm call-off. The supplier ships an `ASN` against this document (the polymorphic-predecessor case).

- **Direction:** buyer → supplier
- **Body:** SA reference / item / window / `releaseLines[]` (`requestedDeliveryDate` + `requestedDeliveryTime`, `quantity`, UoM) / optional `supersedesReleaseDocumentId`
- **States:** `DRAFT → ISSUED` (terminal)
- **Auto-links on publish:**
  - `CALLS_OFF → SCHEDULING_AGREEMENT`
  - Optional `SUPERSEDES → prior SA_RELEASE_JIT`

---

## 4. Link registry summary

| From → To                                      | linkType        | inbound | outbound | Introduced in |
| ---------------------------------------------- | --------------- | ------- | -------- | ------------- |
| `GENERIC_DOCUMENT` → `GENERIC_DOCUMENT`        | `RESPONDS_TO`   | many    | one      | 1.6           |
| `ORDER_CONFIRMATION` → `PO`                    | `ACKNOWLEDGES`  | one     | one      | 2.3           |
| `PO_CHANGE` → `PO`                             | `SUPERSEDES`    | one     | one      | 2.2           |
| `PO` → `PO`                                    | `SUPERSEDES`    | one     | one      | 2.1           |
| `ASN` → `PO`                                   | `SHIPS_AGAINST` | many    | one      | 2.4           |
| `ASN` → `SA_RELEASE_JIT`                       | `SHIPS_AGAINST` | many    | one      | 3.2           |
| `GOODS_RECEIPT` → `ASN`                        | `RECEIVES`      | one     | one      | 2.5           |
| `GOODS_RECEIPT` → `PO`                         | `FULFILLS`      | many    | one      | 2.5           |
| `INVOICE` → `PO`                               | `INVOICES`      | many    | many     | 2.6           |
| `INVOICE` → `GOODS_RECEIPT`                    | `INVOICES`      | many    | many     | 2.6           |
| `CREDIT_MEMO` → `INVOICE`                      | `CREDITS`       | many    | one      | 2.7           |
| `REMITTANCE_ADVICE` → `INVOICE`                | `REMITS`        | many    | many     | 2.8           |
| `REMITTANCE_ADVICE` → `CREDIT_MEMO`            | `REMITS`        | many    | many     | 2.8           |
| `FORECAST_PUBLISH` → `SCHEDULING_AGREEMENT`    | `CALLS_OFF`     | many    | one      | 3.1           |
| `FORECAST_PUBLISH` → `FORECAST_PUBLISH`        | `SUPERSEDES`    | one     | one      | 3.1           |
| `FORECAST_COMMIT` → `FORECAST_PUBLISH`         | `RESPONDS_TO`   | many    | one      | 3.1           |
| `SA_RELEASE_FORECAST` → `SCHEDULING_AGREEMENT` | `CALLS_OFF`     | many    | one      | 3.2           |
| `SA_RELEASE_FORECAST` → `SA_RELEASE_FORECAST`  | `SUPERSEDES`    | one     | one      | 3.2           |
| `SA_RELEASE_JIT` → `SCHEDULING_AGREEMENT`      | `CALLS_OFF`     | many    | one      | 3.2           |
| `SA_RELEASE_JIT` → `SA_RELEASE_JIT`            | `SUPERSEDES`    | one     | one      | 3.2           |

---

## 5. Roles & state-machine permissions

Every transition on every document type declares `requiredRole` and `actor` (`issuer` | `recipient`). Summary:

- **`BUYER_USER`** — publishes PO, forecasts, releases; transitions PO through fulfilment; accepts / rejects OCs; publishes goods receipts; publishes remittance advices.
- **`BUYER_ADMIN`** — everything a `BUYER_USER` can do, plus cancels, activates/suspends/terminates SCC anchors, transitions PO to `CHANGED`.
- **`SUPPLIER_USER`** — publishes ORDER_CONFIRMATION, ASNs, INVOICEs, CREDIT_MEMOs, FORECAST_COMMITs; acknowledges POs and PO_CHANGEs; transitions ASN through `IN_TRANSIT`.
- **`SUPPLIER_ADMIN`** — same as SUPPLIER_USER; plus relationship-level config once that surface lands.
- **`NETWORK_ADMIN`** — cross-org visibility (unfiltered `/network/audit-log`, admin panel); not a party to any document choreography.

---

## 6. Adding a new document type

The substrate's promise (CLAUDE.md cross-cutting concern #1) is that new features are almost always a new document type or link type, not a new bespoke entity model. The recipe:

1. **Body schema.** Zod schema under `apps/api/src/document-types/<type>/body-schema.ts`.
2. **State machine.** Declarative config using `defineStateMachine` under `.../state-machine.ts`.
3. **Link rules.** Any outbound links this type originates under `.../link-rules.ts`.
4. **Module index.** Compose the three into a `DocumentTypeModule` under `.../index.ts`.
5. **Register.** Add the module to the `ALL_MODULES` array in `apps/api/src/document-types/registry.ts`.
6. **Auto-link (optional).** If publishing this type should create links from body references, extend the `computeAutoLinkPlans` switch in `apps/api/src/routes/documents.ts`.
7. **Doc updates.** Add a row to this catalog; add the state machine + link rules to [`API_REFERENCE.md`](./API_REFERENCE.md); update [`OPERATIONS.md`](./OPERATIONS.md) §10 and §14.
8. **Acceptance test.** Add a scenario to the appropriate phase's acceptance test in `apps/api/test/`.

---

**Last updated:** 2026-07-02 · Phases 1.1–1.6, 2.1–2.8, 3.0–3.2, 4.1–4.5 complete (M1–M4 reached).
