# Phase 2 — User Acceptance Test

This is the comprehensive UAT for Phase 2 (indirect-procurement choreography). It covers everything PHASES.md §2 ships, plus the substrate features Phase 2 depends on:

- §2.1 PO full lifecycle (`DRAFT → ISSUED → ACKNOWLEDGED → IN_FULFILLMENT → CLOSED`) + `CANCELLED` / `CHANGED` side states
- §2.2 PO_CHANGE choreography (with the `→ CHANGED` precondition guard and `SUPERSEDES` auto-link)
- §2.3 ORDER_CONFIRMATION three modes (`FULL_ACCEPT` / `ACCEPT_WITH_CHANGES` with proposed line revisions / `REJECT`) + buyer-response transitions
- §2.4 ASN multi-shipment flow (split shipments against one PO)
- §2.5 GOODS_RECEIPT with auto-linked `FULFILLS` + `RECEIVES`
- §2.6 INVOICE in both `PO_FLIP` and `SUMMARY` modes + the **no-double-billing guard**
- §2.7 CREDIT_MEMO
- §2.8 REMITTANCE_ADVICE (with the "XBN does not move money" scope guard)
- Substrate: document versioning (immutability), attachment round-trip with SHA-256 verification, inbox/outbox listing
- Negative paths: cross-relationship rejection, doc-type-not-enabled, wrong actor side, wrong role, invalid state transition, body-schema validation, status mismatch, unknown document type

**Sign-off bar:** 53 assertions, all green.

> **Honest scope note.** Phase 2.4–2.8 (ASN, GR, Invoice, Credit Memo, Remittance Advice) do **not** yet have portal forms — those were deferred so the M2 milestone could ship via API + acceptance tests. The phases of the choreography that _do_ have portal UI today are PO, PO_CHANGE, and ORDER_CONFIRMATION. The UAT therefore exercises everything through the API directly so the assertions don't depend on UI scaffolding that's still pending.

---

## Three ways to run the UAT

| Approach                                                | Time        | What it gives you                                                                |
| ------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------- |
| **A. Run the automated script** `./docs/uat-phase-2.sh` | ~30 seconds | All 9 scenarios, with green ✓ / red ✗ per assertion                              |
| **B. Run the Vitest acceptance suite**                  | ~10 seconds | The 3 M2 milestone-gate tests framed as Vitest cases                             |
| **C. Walk through the portal manually**                 | ~20 minutes | Real user feel for PO / PO_CHANGE / OC; falls back to script for ASN+ downstream |

Pick **A** for sign-off. **B** is what gates the M2 milestone in CI. **C** is for stakeholder demos.

---

## Approach A — `./docs/uat-phase-2.sh`

```bash
# 0. Prereqs (one-time per machine)
docker compose up -d                                # Postgres + MinIO + MailHog
pnpm --filter @xbn/api dev                          # in one terminal, leave running
# Wait for: "XBN API listening on :3000"

# 1. Run the UAT
./docs/uat-phase-2.sh
```

Expected: 53 green assertions across 9 scenarios in ~30 seconds. Any failure stops the script at the first ✗ and prints the offending response body.

### What each scenario verifies

| Scenario                                       | Assertions | What it proves                                                                                                                                                                                                     |
| ---------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Setup**                                      | 1          | API reachable, register/verify/login, org creation, trading relationship with `summaryInvoicingEnabled`                                                                                                            |
| **1 — Canonical PO → REMITTANCE**              | 14         | Every doc type, every state transition, every auto-link in the full P2P happy path. Verifies the final PO has all 4 inbound link types and the invoice has 2 outbound INVOICES. Audit log integrity asserted.      |
| **2 — SUMMARY invoicing (§2.6)**               | 3          | Consolidates 3 POs + 3 GRs into one invoice; re-issuing a SUMMARY that overlaps any source surfaces `duplicate_link` (the no-double-billing guard)                                                                 |
| **3 — Relationship-level SUMMARY gate**        | 2          | `summaryInvoicingEnabled: false` → SUMMARY rejected with `summary_invoicing_not_enabled`                                                                                                                           |
| **4 — PO_CHANGE choreography (§2.2)**          | 6          | Full change flow: publish + auto-link + supplier accept + buyer transitions PO to CHANGED. **Two negative paths**: PO→CHANGED rejected with no PO_CHANGE, rejected with PO_CHANGE still ISSUED                     |
| **5 — OC ACCEPT_WITH_CHANGES + REJECT (§2.3)** | 6          | ACCEPT_WITH_CHANGES with proposed line revisions, buyer ACCEPTED_BY_BUYER, **PO body NOT mutated by OC** (only PO versions mutate the PO), empty proposedChanges → Zod refine rejects, REJECT walks to terminal    |
| **6 — CREDIT_MEMO (§2.7)**                     | 3          | Publish + auto-link CREDITS → INVOICE + buyer accept + outbound CREDITS link verified                                                                                                                              |
| **7 — Negative paths**                         | 7          | Cross-relationship publish, doc type not enabled, wrong actor side, invalid transition, body schema validation, status mismatch (optimistic-concurrency), unknown document type                                    |
| **8 — Substrate features**                     | 7          | GENERIC_DOCUMENT publish, supersede (creates v2), prior version NOT mutated, attachment upload with SHA-256, attachment byte-for-byte download (SHA verified), GET /documents inbox/outbox listing both directions |
| **9 — Multi-shipment ASN + 3-way invoice**     | 3          | Two ASNs (qty 4 + 6) shipped against one PO, two separate GRs; PO has 2 SHIPS_AGAINST + 2 FULFILLS inbound; PO_FLIP invoice covering both GRs has 3 outbound INVOICES (full 3-way visibility)                      |

---

## Approach B — Vitest

Same logic as Scenarios 1–3, framed as test cases. This is the suite CI runs to gate M2.

```bash
pnpm --filter @xbn/api exec vitest run test/phase-2-acceptance.test.ts
```

Expect:

```
✓ Phase 2 acceptance: canonical PO → REMITTANCE choreography
✓ Phase 2 acceptance: SUMMARY invoicing (PHASES.md §2.6)
  > consolidates 3 POs into one invoice; auto-links to all source POs + GRs
✓ Phase 2 acceptance: SUMMARY invoicing (PHASES.md §2.6)
  > rejects SUMMARY invoice when summaryInvoicingEnabled is false
Test Files  1 passed (1)
Tests       3 passed (3)
```

The script (Approach A) goes substantially further than the Vitest gate — covering scenarios 4-9 that aren't yet promoted into the Vitest suite. Both are useful: the Vitest suite is the CI gate; the script is the broader UAT.

---

## Approach C — Hybrid portal + curl

If you want UAT to _feel_ like a real user click-through, use the portal for the parts that have UI today:

1. **`/register`** as buyer and supplier (two browsers)
2. **`/admin`** to create both orgs
3. Use DevTools console in the buyer's tab to establish the trading relationship (see [`OPERATIONS.md` §8](./OPERATIONS.md)).
4. **`/buyer/po/new`** — create a PO; transition through `ISSUED`.
5. **`/supplier/po/:id/acknowledge`** — try each of the three modes.
6. **`/buyer/order-confirmation/:id`** — accept the supplier's response; from `ACCEPT_WITH_CHANGES` click "+ Issue PO change to materialise".
7. **`/buyer/po/:id/change`** — fill the change form, submit. SUPERSEDES → PO is auto-linked by the API.
8. **`/supplier/po-change/:id`** — accept the change; the original PO's "Apply accepted change" button now works.
9. Run `./docs/uat-phase-2.sh` to verify the downstream (ASN/GR/Invoice/Remittance) parts that don't have portal UI yet.

---

## Sign-off criteria

You can mark Phase 2 UAT as **passed** when:

| #   | Criterion                                                                        | How to verify                          |
| --- | -------------------------------------------------------------------------------- | -------------------------------------- |
| 1   | Canonical PO → Remittance choreography runs without errors                       | Approach A scenario 1 ✓                |
| 2   | Every document type publishes through the API and auto-links to its predecessors | Approach A — auto-link checks per step |
| 3   | The final PO has all four expected inbound link types                            | Approach A `[verify]` step             |
| 4   | SUMMARY invoicing consolidates multiple POs in one invoice                       | Approach A scenario 2 ✓                |
| 5   | The no-double-billing guard fires on a duplicate-source SUMMARY invoice          | Approach A scenario 2.3 ✓              |
| 6   | SUMMARY mode is rejected when the relationship hasn't opted in                   | Approach A scenario 3 ✓                |
| 7   | PO_CHANGE flow + precondition guard (no PO→CHANGED without accepted change)      | Approach A scenario 4 ✓                |
| 8   | OC ACCEPT_WITH_CHANGES carries proposed revisions; PO body NOT mutated by OC     | Approach A scenario 5 ✓                |
| 9   | CREDIT_MEMO publish + accept + auto-link                                         | Approach A scenario 6 ✓                |
| 10  | All major negative paths return their typed errors                               | Approach A scenario 7 ✓                |
| 11  | Substrate immutability + attachments + listing                                   | Approach A scenario 8 ✓                |
| 12  | Multi-shipment / 3-way visibility                                                | Approach A scenario 9 ✓                |
| 13  | Portal walks the full PO → OC → PO_CHANGE flow without errors                    | Approach C steps 1–8                   |

Phase 2 is signed off when criteria 1–12 are ✓ (run the script — it's the single gate). Criterion 13 is the portal walkthrough — optional but useful for demos.

---

## What's deliberately NOT covered

These belong to later phases — flagging here so reviewers don't list them as Phase 2 gaps:

- **Match-status visualisation** (Phase 4.3) — `MatchStatus` is exported from `document-core` but no dashboard surfaces it yet.
- **Email delivery** for verification / reset / publish notifications (Phase 4.5).
- **Cross-type search and inbox UI** (Phase 4.1) — the API surface (`GET /documents` with filters) exists; the inbox UI doesn't.
- **ASN/GR/Invoice/CreditMemo/Remittance portal forms** — API-only today; portal forms shipped as a focused follow-up after M2.
- **Approval workflows / payment execution / MRP** — explicitly **out of scope forever** (CLAUDE.md cross-cutting concern #6). XBN is a transaction hub, not an ERP.
- **PO_CHANGE supplier-side flow in the portal** — supplier can accept/reject through `/supplier/po-change/:id` UI but the explicit Accept button assumes single-page state. Multi-tab use may need refresh.

---

**Last updated:** 2026-06-25 · gates milestone M2 (Phase 2 indirect procurement). 53 assertions.
