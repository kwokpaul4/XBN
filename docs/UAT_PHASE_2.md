# Phase 2 — User Acceptance Test

This is the practical UAT for Phase 2 (indirect-procurement choreography). It covers everything PHASES.md §2 ships:

- §2.1 PO full lifecycle (`DRAFT → ISSUED → ACKNOWLEDGED → IN_FULFILLMENT → CLOSED`)
- §2.2 PO_CHANGE choreography (with the `→ CHANGED` precondition guard)
- §2.3 ORDER_CONFIRMATION three modes (`FULL_ACCEPT` / `ACCEPT_WITH_CHANGES` / `REJECT`) + buyer-response transitions
- §2.4 ASN multi-shipment flow
- §2.5 GOODS_RECEIPT with auto-linked `FULFILLS` + `RECEIVES`
- §2.6 INVOICE in both `PO_FLIP` and `SUMMARY` modes + the **no-double-billing guard**
- §2.7 CREDIT_MEMO
- §2.8 REMITTANCE_ADVICE (with the "XBN does not move money" scope guard)

> **Honest scope note.** Phase 2.4–2.8 (ASN, GR, Invoice, Credit Memo, Remittance Advice) do **not** yet have portal forms — those were deferred so the M2 milestone could ship via API + acceptance tests. The phases of the choreography that *do* have portal UI today are PO, PO_CHANGE, and ORDER_CONFIRMATION. The UAT therefore exercises everything through the API directly so the assertions don't depend on UI scaffolding that's still pending.

---

## Three ways to run the UAT

| Approach | Time | What it gives you |
|---|---|---|
| **A. Run the automated script** `./uat-phase-2.sh` | ~30 seconds | All three scenarios, with green ✓ / red ✗ per assertion |
| **B. Run the Vitest acceptance suite** | ~10 seconds | Same three scenarios, but framed as unit tests rather than a sequence of curl calls |
| **C. Walk through the portal manually** | ~20 minutes | Real user feel for PO / PO_CHANGE / OC; falls back to script for ASN+ downstream |

Pick **A** for sign-off. **B** is what gates the M2 milestone in CI. **C** is for stakeholder demos.

---

## Approach A — `./uat-phase-2.sh`

The script lives at [`./uat-phase-2.sh`](./uat-phase-2.sh) in this directory. From the repo root:

```bash
# 0. Prereqs (one-time per machine)
docker compose up -d                                # Postgres + MinIO + MailHog
pnpm --filter @xbn/api dev                          # in one terminal, leave running
# Wait for: "XBN API listening on :3000"

# 1. Run the UAT
./docs/uat-phase-2.sh
```

Expected output (annotated):

```
======================================================================
 XBN Phase 2 UAT — indirect procurement choreography
======================================================================

[setup] Registering buyer + supplier and creating orgs...
  buyer registered:       <uuid>
  supplier registered:    <uuid>
  buyer org created:      <cuid>
  supplier org created:   <cuid>
  trading relationship:   ACTIVE (summary invoicing enabled)

----------------------------------------------------------------------
 Scenario 1 — Canonical PO → REMITTANCE choreography
----------------------------------------------------------------------
[1/9]  Buyer publishes PO ............................... ✓ PO-000001
[2/9]  Buyer transitions PO DRAFT → ISSUED .............. ✓
[3/9]  Supplier publishes ORDER_CONFIRMATION ............ ✓ auto-linked
[4/9]  Supplier transitions PO ISSUED → ACKNOWLEDGED .... ✓
[5/9]  Buyer transitions PO → IN_FULFILLMENT ............ ✓
[6/9]  Supplier publishes ASN ........................... ✓ auto-linked
[7/9]  Buyer publishes GOODS_RECEIPT .................... ✓ auto-linked
[8/9]  Supplier publishes INVOICE (PO_FLIP) .............. ✓ auto-linked
[9/9]  Buyer publishes REMITTANCE_ADVICE ................. ✓ auto-linked
[end]  Buyer closes PO ................................... ✓
[verify] PO has 4 inbound links (ACK + SHIPS + FULFILLS + INVOICES) ✓
[verify] Invoice has 2 outbound INVOICES links (PO + GR) ✓
[verify] PO audit log shows CREATED + 4× STATUS_CHANGED ✓

----------------------------------------------------------------------
 Scenario 2 — SUMMARY invoicing (PHASES.md §2.6)
----------------------------------------------------------------------
[2.1] Publish 3 POs and walk each to POSTED GR .......... ✓
[2.2] Supplier publishes ONE SUMMARY invoice ............. ✓ 6 INVOICES links
[2.3] Re-issue SUMMARY referencing PO A; duplicate_link
      surfaced in linkWarnings (no-double-billing guard) . ✓

----------------------------------------------------------------------
 Scenario 3 — Relationship-level summary-invoicing gate
----------------------------------------------------------------------
[3.1] Setup buyer+supplier with summaryInvoicingEnabled=false ✓
[3.2] Supplier attempts SUMMARY invoice; rejected with
      summary_invoicing_not_enabled ...................... ✓

======================================================================
 ✓ Phase 2 UAT PASSED  — 14 assertions, 0 failures
======================================================================
```

A non-zero exit code means at least one assertion failed; the script stops at the first failure and prints the offending response body.

---

## Approach B — Vitest

Same logic, same assertions, but framed as test cases. This is the suite CI runs to gate M2.

```bash
pnpm --filter @xbn/api exec vitest run test/phase-2-acceptance.test.ts
```

You're looking for:

```
✓ Phase 2 acceptance: canonical PO → REMITTANCE choreography
✓ Phase 2 acceptance: SUMMARY invoicing (PHASES.md §2.6)
  > consolidates 3 POs into one invoice; auto-links to all source POs + GRs
✓ Phase 2 acceptance: SUMMARY invoicing (PHASES.md §2.6)
  > rejects SUMMARY invoice when summaryInvoicingEnabled is false
Test Files  1 passed (1)
Tests       3 passed (3)
```

---

## Approach C — Hybrid portal + curl

If you want UAT to *feel* like a real user click-through, use the portal for the parts that have UI today:

1. **`/register`** as buyer and supplier (two browsers)
2. **`/admin`** to create both orgs
3. Use DevTools console in the buyer's tab to establish the trading relationship (see [`OPERATIONS.md` §8](./OPERATIONS.md)).
4. **`/buyer/po/new`** — create a PO; transition through `ISSUED`.
5. **`/supplier/po/:id/acknowledge`** — try each of the three modes.
6. **`/buyer/order-confirmation/:id`** — accept the supplier's response; from `ACCEPT_WITH_CHANGES` click "+ Issue PO change to materialise".
7. **`/buyer/po/:id/change`** — fill the change form, submit.
8. **`/supplier/po-change/:id`** — accept the change; the original PO's "Apply accepted change" button now works.
9. Run `./docs/uat-phase-2.sh --from-step=asn --po-id=...` to continue from ASN onwards using the curl path. (The script accepts those flags so you can plug into a portal-driven setup.)

This gives you the "real user clicking buttons" verification for PO/POAck/PO_CHANGE, plus rigorous downstream coverage for the parts without UI yet.

---

## Sign-off criteria

You can mark Phase 2 UAT as **passed** when:

| # | Criterion | How to verify |
|---|---|---|
| 1 | Canonical PO → Remittance choreography runs without errors | Approach A scenario 1 ✓ |
| 2 | Every document type publishes through the API and auto-links to its predecessors | Approach A — auto-link checks per step |
| 3 | The final PO has all four expected inbound link types | Approach A `[verify]` step |
| 4 | SUMMARY invoicing consolidates multiple POs in one invoice | Approach A scenario 2 ✓ |
| 5 | The no-double-billing guard fires on a duplicate-source SUMMARY invoice | Approach A scenario 2.3 ✓ |
| 6 | SUMMARY mode is rejected when the relationship hasn't opted in | Approach A scenario 3 ✓ |
| 7 | Portal walks the full PO → OC → PO_CHANGE flow without errors | Approach C steps 1–8 |

Phase 2 is signed off when all 7 criteria are ✓.

---

## What's deliberately NOT covered

These belong to later phases — flagging here so reviewers don't list them as Phase 2 gaps:

- **Match-status visualisation** (Phase 4.3) — `MatchStatus` is exported from `document-core` but no dashboard surfaces it yet.
- **Email delivery** for verification / reset / publish notifications (Phase 4.5).
- **Cross-type search and inbox UI** (Phase 4.1) — the API surface (`GET /documents` with filters) exists; the inbox UI doesn't.
- **ASN/GR/Invoice/CreditMemo/Remittance portal forms** — API-only today; portal forms shipped as a focused follow-up after M2.
- **Approval workflows / payment execution / MRP** — explicitly **out of scope forever** (CLAUDE.md cross-cutting concern #6). XBN is a transaction hub, not an ERP.

---

**Last updated:** 2026-06-24 · gates milestone M2 (Phase 2 indirect procurement).
