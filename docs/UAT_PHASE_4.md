# Phase 4 — User Acceptance Test

This is the comprehensive UAT for Phase 4 (network-wide features). It covers everything PHASES.md §4.1–§4.5 ships and gates milestone M4:

- **§4.1 Inbox / Outbox / cross-type document search** — the new `q`, `fromDate`, `toDate` filters on `GET /documents` plus the existing `documentType`, `status`, and `counterpartyOrgId` filters, and the inbox / outbox / both scoping.
- **§4.2 Counterparties / supplier directory** — `GET /network/counterparties` returns every active trading partner with `ourRole` polarity, enabled doc types, and last-activity timestamp.
- **§4.3 Status dashboards** — buyer + supplier tile counts derived from documents scoped to the active org.
- **§4.4 Supplier scorecards** — live-computed metrics (PO-ack SLA, ASN accuracy, invoice match rate, on-time delivery) with honest `null` sentinels when there's no data yet.
- **§4.5 Notification outbox** — document publish and status transitions emit rows for every user in the recipient org; the portal bell / API surfaces list, mark-read, and mark-all-read.

**Sign-off bar:** 36 assertions + 5 Vitest acceptance tests, all green.

> **Honest scope note.** Phase 4 portal ships **Inbox / Outbox**, **Trading Partners**, **Buyer Dashboard**, **Supplier Dashboard**, **Scorecards**, and the header **notification bell** — but there's no dedicated E2E script for the browser flow yet. This UAT drives the API directly and verifies the same contract the portal calls; the portal is a thin renderer over these endpoints.

---

## Two ways to run the UAT

| Approach                                                | Time        | What it gives you                                    |
| ------------------------------------------------------- | ----------- | ---------------------------------------------------- |
| **A. Run the automated script** `./docs/uat-phase-4.sh` | ~15 seconds | All 5 scenarios, with green ✓ / red ✗ per assertion  |
| **B. Run the Vitest acceptance suite**                  | ~10 seconds | The 5 M4 milestone-gate tests framed as Vitest cases |

Pick **A** for sign-off. **B** is what gates the M4 milestone in CI.

---

## Approach A — `./docs/uat-phase-4.sh`

```bash
# 0. Prereqs (one-time per machine)
docker compose up -d                                # Postgres + MinIO + MailHog
pnpm --filter @xbn/api dev                          # in one terminal, leave running
# Wait for: "XBN API listening on :3000"

# 1. Run the UAT
./docs/uat-phase-4.sh
```

Expected: 36 green assertions across 5 scenarios in ~15 seconds. Any failure stops the script at the first ✗ and prints the offending response body.

### What each scenario verifies

| Scenario                                         | Assertions | What it proves                                                                                                                                                                                                                                                             |
| ------------------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Setup**                                        | 1          | API reachable, register + verify + login, org creation, trading relationship ACTIVE with the doc types the UAT exercises                                                                                                                                                   |
| **1 — §4.1 search + inbox/outbox filters (#23)** | 9          | 2 POs published; buyer outbox sees both; supplier inbox sees both; `q=<PO#>` narrows to 1 hit; `q=NONEXISTENT` returns 0; `fromDate=2099` excludes everything; `documentType=PO` still 2; `counterpartyOrgId` filter still 2                                               |
| **2 — §4.2 counterparties (#24)**                | 7          | Buyer sees 1 counterparty with `ourRole=BUYER`; `enabledDocumentTypes` includes PO; `lastActivityAt` is non-null after publishing; supplier's view of the same relationship has `ourRole=SUPPLIER`                                                                         |
| **3 — §4.3 status dashboards (#25)**             | 4          | PO1 → ISSUED; SA published + activated; buyer tiles: 1 PO awaiting acknowledgement + 1 active SA; supplier tile: 1 PO to acknowledge                                                                                                                                       |
| **4 — §4.4 supplier scorecards (#26)**           | 8          | ORDER_CONFIRMATION publish → `poAckSampleSize=1` and `avgPoAckHours` populated; no invoices → `invoiceMatchRate` is `null` with `invoiceSampleSize=0`; no GR data → `asnAccuracy` and `onTimeDelivery` both `null` (not `0`), `asnSampleSize=0` — the honest-null contract |
| **5 — §4.5 notifications (#27)**                 | 6          | Supplier has ≥ 3 unread after 2 PO publishes + 1 transition; latest event is a `DOCUMENT_*` type; mark-one-read decrements `unreadCount`; mark-all-read zeroes it; the OC publish fires a reciprocal notification back to the buyer                                        |

---

## Approach B — Vitest

Same logic as Scenarios 1–5, framed as test cases. This is the suite CI runs to gate M4.

```bash
pnpm --filter @xbn/api exec vitest run test/phase-4-acceptance.test.ts
```

Expect:

```
✓ Phase 4 acceptance — Scenario 1: §4.1 cross-type search + filters
  > q matches documentNumber substring, scopes correctly per inbox/outbox, fromDate filters
✓ Phase 4 acceptance — Scenario 2: §4.2 counterparties / supplier directory
  > returns each ACTIVE counterparty with ourRole + enabledDocumentTypes + lastActivityAt
✓ Phase 4 acceptance — Scenario 3: §4.3 status dashboards
  > buyer + supplier tiles surface correct counts from both directions
✓ Phase 4 acceptance — Scenario 4: §4.4 supplier scorecards
  > captures PO-ack SLA + invoice match rate; reports null for metrics with no data
✓ Phase 4 acceptance — Scenario 5: §4.5 notification outbox
  > publish writes a row per recipient-org user; list + read + unreadCount work

Test Files  1 passed (1)
Tests       5 passed (5)
```

The shell UAT (Approach A) goes further than the Vitest gate — it exercises more filter combinations (empty results, date-range, per-type, per-counterparty) and the bidirectional notification path. Both are useful: Vitest is the CI gate; the script is the sign-off tool.

---

## Sign-off criteria

You can mark Phase 4 UAT as **passed** when:

| #   | Criterion                                                                                   | How to verify           |
| --- | ------------------------------------------------------------------------------------------- | ----------------------- |
| 1   | `GET /documents?q=` matches documentNumber and referenceNumber (case-insensitive substring) | Approach A scenario 1 ✓ |
| 2   | Inbox / outbox / both scoping is correct from both sides of a relationship                  | Approach A scenario 1 ✓ |
| 3   | `fromDate` and `toDate` filters are ISO-date-shaped and correctly bound `issueDate`         | Approach A scenario 1 ✓ |
| 4   | `GET /network/counterparties` returns each active partner with correct `ourRole` polarity   | Approach A scenario 2 ✓ |
| 5   | `lastActivityAt` becomes non-null after the first document is exchanged                     | Approach A scenario 2 ✓ |
| 6   | Buyer dashboard tiles reflect real counts (POs awaiting ack, active SAs, etc.)              | Approach A scenario 3 ✓ |
| 7   | Supplier dashboard tiles reflect real counts (POs to ack, forecasts to commit, etc.)        | Approach A scenario 3 ✓ |
| 8   | Scorecards compute the four §4.4 metrics live                                               | Approach A scenario 4 ✓ |
| 9   | Scorecards report `null` (not `0`) for metrics with no data — the honest-null contract      | Approach A scenario 4 ✓ |
| 10  | Publishing a document writes a row per recipient-org user to `notification_outbox`          | Approach A scenario 5 ✓ |
| 11  | Mark-read decrements `unreadCount`; mark-all-read zeroes it                                 | Approach A scenario 5 ✓ |
| 12  | Vitest acceptance suite passes 5/5 (CI milestone gate)                                      | Approach B ✓            |

Phase 4 is signed off when criteria 1–12 are ✓.

---

## What's deliberately NOT covered

Flagging so reviewers don't list them as Phase 4 gaps:

- **Portal E2E (Playwright) over the new pages** — Inbox / Outbox / Trading Partners / Buyer Dashboard / Supplier Dashboard / Scorecards / Notification bell all ship and are reachable in the browser; a Playwright suite over them is Phase 5.2 follow-up.
- **SMTP delivery** — Phase 4.5 writes to `notification_outbox`; the pg-boss + SMTP consumer that dispatches emails is Phase 5.4 wire-up. The portal bell polls the outbox directly and shows unread state today.
- **Nightly scorecard snapshot** — PHASES.md §4.4 spec calls for a `supplier_scorecard_snapshots` table; MVP computes live. Promotion is a Phase 5 op if scan cost grows.
- **Relationship suspend / terminate HTTP routes** — service-layer functions exist; routes are pending Phase 4.2 backend work (documented in [`OPERATIONS.md` §19](./OPERATIONS.md)).

---

**Last updated:** 2026-07-02 · gates milestone M4 (Phase 4 network-wide features). 36 assertions + 5 Vitest tests.
