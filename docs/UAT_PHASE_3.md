# Phase 3 — User Acceptance Test

This is the comprehensive UAT for Phase 3 (direct-materials SCC choreography). It covers everything PHASES.md §3.0–§3.2 ships, plus the cross-phase substrate test that proves the Phase 1 substrate generalises from indirect procurement to long-lived SCC contracts:

- **§3 anchor entities** — SCHEDULING_AGREEMENT (full `DRAFT → ACTIVE ↔ SUSPENDED → TERMINATED` lifecycle), CONSIGNMENT_CONTRACT, SUBCONTRACTING_AGREEMENT
- **§3.1 Forecast Collaboration** — FORECAST_PUBLISH (bucketed forecast over a Scheduling Agreement) → FORECAST_COMMIT (supplier's response, a Zod discriminated union over `COMMIT` / `COMMIT_WITH_DEVIATION` / `CANNOT_COMMIT` per bucket) → revised FORECAST_PUBLISH via `SUPERSEDES`
- **§3.2 SA Releases** — SA_RELEASE_FORECAST (planning-grade) and SA_RELEASE_JIT (firm call-off); each auto-links `CALLS_OFF` → SA and supports `SUPERSEDES` against a prior release
- **The polymorphic-predecessor substrate test (§3.2)** — the Phase 2 ASN type now accepts `SA_RELEASE_JIT` as an alternative predecessor; the `SHIPS_AGAINST` link must resolve to the JIT release, not a PO. This is the single most consequential cross-phase test in M3.
- Negative paths: doc type not enabled on relationship, invalid state transition (skipping ACTIVE), wrong actor side, body-schema validation (empty buckets, negative quantities)

**Sign-off bar:** 27 assertions + 5 Vitest acceptance tests, all green.

> **Honest scope note.** Phase 3 ships **API-only at MVP** — there are no portal forms yet for SCC documents. The user-facing surface for SCC will land as a focused follow-up; M3 was gated on the substrate + the choreography being correct, not the UI. The UAT therefore exercises everything through the API directly. Phase 3.3 (Subcontracting), 3.4 (Consignment movements/settlements), and 3.5 (Quality Notifications) are explicitly **deferred** per PHASES.md and TASKS.md — they are not in M3 scope and are not part of this UAT.

---

## Two ways to run the UAT

| Approach                                                | Time        | What it gives you                                    |
| ------------------------------------------------------- | ----------- | ---------------------------------------------------- |
| **A. Run the automated script** `./docs/uat-phase-3.sh` | ~15 seconds | All 5 scenarios, with green ✓ / red ✗ per assertion  |
| **B. Run the Vitest acceptance suite**                  | ~7 seconds  | The 5 M3 milestone-gate tests framed as Vitest cases |

Pick **A** for sign-off. **B** is what gates the M3 milestone in CI.

---

## Approach A — `./docs/uat-phase-3.sh`

```bash
# 0. Prereqs (one-time per machine)
docker compose up -d                                # Postgres + MinIO + MailHog
pnpm --filter @xbn/api dev                          # in one terminal, leave running
# Wait for: "XBN API listening on :3000"

# 1. Run the UAT
./docs/uat-phase-3.sh
```

Expected: 27 green assertions across 5 scenarios in ~15 seconds. Any failure stops the script at the first ✗ and prints the offending response body.

### What each scenario verifies

| Scenario                                    | Assertions | What it proves                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Setup**                                   | 1          | API reachable, register/verify/login, org creation, trading relationship with the full Phase 3 doc-type set enabled (8 types: 3 anchors + 4 SCC docs + Phase 2 ASN for the polymorphic test)                                                                                                                                                                                                                          |
| **1 — SCC anchor lifecycles (Task #16)**    | 6          | All three anchor types publish with sequential numbering. SCHEDULING_AGREEMENT walks the **full lifecycle** `DRAFT → ACTIVE → SUSPENDED → ACTIVE` (and is left active to serve as the hub for Scenarios 2 & 3). CONSIGNMENT_CONTRACT and SUBCONTRACTING_AGREEMENT (with components BOM) both publish.                                                                                                                 |
| **2 — Forecast Collaboration (Task #17)**   | 6          | Buyer publishes FORECAST_PUBLISH with 3 weekly buckets → auto-link `CALLS_OFF` → SA verified on the SA's incoming links. Supplier publishes FORECAST_COMMIT with **all three bucket modes** (`COMMIT` / `COMMIT_WITH_DEVIATION` with reason / `CANNOT_COMMIT` with reason) → auto-link `RESPONDS_TO`. Buyer revises forecast via SUPERSEDES. Negative: Zod rejects negative `committedQuantity`.                      |
| **3 — SA Releases + polymorphic ASN (#18)** | 6          | SA_RELEASE_FORECAST publishes with `CALLS_OFF` → SA. A second forecast release auto-links `SUPERSEDES` → the prior one. SA_RELEASE_JIT (firm call-off with delivery time) publishes. **The cross-phase test**: supplier publishes an ASN carrying `saReleaseJitDocumentId` (NOT a PO); the polymorphic resolver creates a `SHIPS_AGAINST` link to the JIT release and the JIT release sees 1 inbound `SHIPS_AGAINST`. |
| **4 — Negative paths**                      | 4          | FORECAST_PUBLISH rejected with `document_type_not_enabled` when the relationship hasn't opted in. SA `DRAFT → SUSPENDED` rejected with `no_such_transition`. Supplier trying buyer-only `DRAFT → ACTIVE` rejected with `wrong_role` / `wrong_actor_side`. FORECAST_PUBLISH with empty `buckets[]` rejected with `body_schema`.                                                                                        |
| **5 — End-to-end SCC DAG verification**     | 3          | After scenarios 1–3 the SA hub has **5 CALLS_OFF inbound** (2 forecasts + 2 forecast releases + 1 JIT) — proving the SCC graph is one connected DAG. The JIT release has 1 SHIPS_AGAINST inbound. The original forecast has 1 RESPONDS_TO (commit) + 1 SUPERSEDES (revision).                                                                                                                                         |

---

## Approach B — Vitest

Same logic as Scenarios 1, 2, and 3, plus the two negative paths from Scenario 4, framed as test cases. This is the suite CI runs to gate M3.

```bash
pnpm --filter @xbn/api exec vitest run test/phase-3-acceptance.test.ts
```

Expect:

```
✓ Phase 3 acceptance — Scenario 1: anchor entity lifecycles (Task #16)
  > publishes all three anchor types and walks SCHEDULING_AGREEMENT through full lifecycle
✓ Phase 3 acceptance — Scenario 2: Forecast Collaboration (Task #17)
  > buyer publishes forecast → supplier commits with deviation → buyer revises via SUPERSEDES
✓ Phase 3 acceptance — Scenario 2: Forecast Collaboration (Task #17)
  > rejects FORECAST_COMMIT body with negative committedQuantity
✓ Phase 3 acceptance — Scenario 3: SA releases + polymorphic ASN (Task #18)
  > forecast release → supersede → JIT release → ASN ships against JIT (polymorphic predecessor)
✓ Phase 3 acceptance — Scenario 3: SA releases + polymorphic ASN (Task #18)
  > rejects FORECAST_PUBLISH publish when document type not enabled on relationship

Test Files  1 passed (1)
Tests       5 passed (5)
```

The script (Approach A) goes further than the Vitest gate — it includes Scenarios 4 (two more negative paths) and 5 (end-to-end DAG verification) that the Vitest suite doesn't replicate. Both are useful: the Vitest suite is the CI gate; the script is the broader UAT and surface for stakeholder demos.

---

## Sign-off criteria

You can mark Phase 3 UAT as **passed** when:

| #   | Criterion                                                                                                              | How to verify                  |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 1   | All three SCC anchor types (SCHEDULING_AGREEMENT, CONSIGNMENT_CONTRACT, SUBCONTRACTING_AGREEMENT) publish successfully | Approach A scenario 1 ✓        |
| 2   | SCHEDULING_AGREEMENT walks the full lifecycle including re-activation from SUSPENDED                                   | Approach A scenario 1 ✓        |
| 3   | FORECAST_PUBLISH auto-links `CALLS_OFF` to the SA                                                                      | Approach A scenario 2 ✓        |
| 4   | FORECAST_COMMIT accepts all three bucket modes (COMMIT / WITH_DEVIATION / CANNOT_COMMIT) and auto-links `RESPONDS_TO`  | Approach A scenario 2 ✓        |
| 5   | Revised FORECAST_PUBLISH auto-links `SUPERSEDES` → prior forecast                                                      | Approach A scenario 2 ✓        |
| 6   | SA_RELEASE_FORECAST and SA_RELEASE_JIT both publish with `CALLS_OFF` → SA                                              | Approach A scenario 3 ✓        |
| 7   | Revised SA_RELEASE_FORECAST auto-links `SUPERSEDES` → prior release                                                    | Approach A scenario 3 ✓        |
| 8   | **Polymorphic predecessor**: ASN carrying `saReleaseJitDocumentId` resolves `SHIPS_AGAINST` to the JIT release         | Approach A scenarios 3.4–3.6 ✓ |
| 9   | All major negative paths return their typed errors                                                                     | Approach A scenario 4 ✓        |
| 10  | The end-to-end SCC DAG is correctly connected (SA has 5 CALLS_OFF inbound)                                             | Approach A scenario 5 ✓        |
| 11  | Vitest acceptance suite passes 5/5 (CI milestone gate)                                                                 | Approach B ✓                   |

Phase 3 is signed off when criteria 1–11 are ✓. Approach A alone covers 1–10; Approach B is criterion 11.

---

## What's deliberately NOT covered

These belong to later phases or were explicitly deferred — flagging here so reviewers don't list them as Phase 3 gaps:

- **Portal UI for SCC documents** — Phase 3 ships API-only; portal forms for anchors, forecasts, and releases are a focused UI follow-up. Same scope decision Phase 2.4–2.8 made.
- **Phase 3.3 — Subcontracting** (`SUBCONTRACT_COMPONENT_SHIPMENT` + `SUBCONTRACT_CONSUMPTION_REPORT`) — deferred per TASKS.md #20.
- **Phase 3.4 — Consignment movements/settlements** (`CONSIGNMENT_FILL` + `CONSIGNMENT_CONSUMPTION` → triggered Invoice) — deferred per TASKS.md #21.
- **Phase 3.5 — Quality Notifications** (`QUALITY_NOTIFICATION` + `QUALITY_RESPONSE`) — deferred per TASKS.md #22.
- **MRP / ATP / planning algorithms** — explicitly **out of scope forever** (CLAUDE.md cross-cutting concern #6). XBN is a transaction hub, not a planning engine. FORECAST_PUBLISH is buyer-issued forecast data, not the output of MRP.
- **Forecast accuracy metrics** (forecast vs eventual release vs eventual GR) — Phase 4.4 scorecards.
- **Settlement of consignment movements as Invoices** — comes with Phase 3.4 when consignment ships.

---

**Last updated:** 2026-06-25 · gates milestone M3 (Phase 3 direct-materials SCC, scope 3.1 + 3.2). 27 assertions + 5 Vitest tests.
