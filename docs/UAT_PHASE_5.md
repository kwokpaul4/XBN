# Phase 5 — User Acceptance Test

This is the comprehensive UAT for Phase 5 (production readiness). It covers everything PHASES.md §5.1–§5.4 ships and gates milestone M5:

- **§5.1 Observability** — `/health` (liveness), `/ready` (Postgres reachable) probes, per-request `x-request-id` header (generated if absent, echoed if provided), and the read-only `/network/audit-log` endpoint that scopes rows to documents the active org is a party to.
- **§5.2 Testing breadth** — property-based tests on the state-machine factory and link registry exist in the substrate.
- **§5.3 CI/CD & release** — GitHub Actions workflow, per-app Dockerfiles, refreshed `.env.example` all present.
- **§5.4 Documentation** — canonical document-type catalog and trading-partner onboarding runbook exist alongside the existing operations manual.

**Sign-off bar:** 28 assertions + 6 Vitest acceptance tests, all green.

> **What Phase 5 is and isn't.** M5 is the "operable in production" milestone — the substrate + Phase 2–4 features carry the product functionality; Phase 5 is about being able to _run_ them in an environment where correlation, container images, CI gates, and the reference docs matter. Two things stay honestly out of scope: OpenTelemetry traces (pino correlation covers what a small production audit needs at MVP) and Playwright over the portal (the API acceptance suites are the M4/M5 gates). Both are called out in [`TASKS.md`](../TASKS.md) and [`OPERATIONS.md` §19](./OPERATIONS.md).

---

## Two ways to run the UAT

| Approach                                                | Time        | What it gives you                                    |
| ------------------------------------------------------- | ----------- | ---------------------------------------------------- |
| **A. Run the automated script** `./docs/uat-phase-5.sh` | ~10 seconds | All 5 scenarios, with green ✓ / red ✗ per assertion  |
| **B. Run the Vitest acceptance suite**                  | ~5 seconds  | The 6 M5 milestone-gate tests framed as Vitest cases |

Pick **A** for sign-off. **B** is what gates the M5 milestone in CI.

---

## Approach A — `./docs/uat-phase-5.sh`

```bash
# 0. Prereqs
docker compose up -d                                # Postgres + MinIO + MailHog
pnpm --filter @xbn/api dev                          # in one terminal, leave running
# Wait for: "XBN API listening on :3000"

# 1. Run the UAT
./docs/uat-phase-5.sh
```

Expected: 28 green assertions across 5 scenarios in ~10 seconds. Any failure stops the script at the first ✗ and prints the offending response body or file path.

### What each scenario verifies

| Scenario                                    | Assertions | What it proves                                                                                                                                                                                                                         |
| ------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1 — §5.1 health + readiness (#28)**       | 4          | `GET /health` returns `{ok:true, service:"xbn-api"}`; `GET /ready` returns HTTP 200 with `db:"up"` when Postgres is reachable                                                                                                          |
| **2 — §5.1 x-request-id correlation (#28)** | 2          | Response carries a UUID-shaped `x-request-id` when the caller doesn't provide one; a caller-provided id is echoed verbatim                                                                                                             |
| **3 — §5.1 audit-log explorer (#28)**       | 5          | Buyer (issuer party) sees ≥ 1 audit entry for a freshly published PO; supplier (recipient party) sees the same rows; an outsider org sees 0 rows for the same PO — the scoping guard works; action + since filters return typed bodies |
| **4 — §5.3 CI/CD + Docker artifacts (#30)** | 7          | `.github/workflows/ci.yml`, `apps/api/Dockerfile`, `apps/web/Dockerfile`, `apps/web/nginx.conf`, `.env.example` all exist; CI workflow references `prisma migrate` + `typecheck`                                                       |
| **5 — §5.4 documentation surface (#31)**    | 10         | DOCUMENT_TYPE_CATALOG.md, ONBOARDING_RUNBOOK.md, OPERATIONS.md, API_REFERENCE.md, UAT_PHASE_2.md, UAT_PHASE_3.md, uat-phase-2.sh, uat-phase-3.sh, docs/README.md, and the property-based test file all exist                           |

---

## Approach B — Vitest

Same logic as Scenarios 1, 2, 3, and 5 framed as test cases (Scenario 4 file-existence is folded into the Vitest run). This is the suite CI runs to gate M5.

```bash
pnpm --filter @xbn/api exec vitest run test/phase-5-acceptance.test.ts
```

Expect:

```
✓ Phase 5 acceptance — §5.1 observability
  > GET /health returns { ok: true }
✓ Phase 5 acceptance — §5.1 observability
  > GET /ready returns { ok: true, db: "up" } when Postgres is reachable
✓ Phase 5 acceptance — §5.1 observability
  > every response echoes x-request-id — generated if absent, preserved if provided
✓ Phase 5 acceptance — §5.1 audit-log explorer
  > scopes rows to the active org and filters by documentId
✓ Phase 5 acceptance — §5.1 audit-log explorer
  > accepts action and since filters without crashing
✓ Phase 5 acceptance — §5.4 documentation surface
  > the promised doc files exist on disk

Test Files  1 passed (1)
Tests       6 passed (6)
```

---

## Sign-off criteria

You can mark Phase 5 UAT as **passed** when:

| #   | Criterion                                                                     | How to verify           |
| --- | ----------------------------------------------------------------------------- | ----------------------- |
| 1   | `GET /health` returns `{ok:true, service:"xbn-api"}`                          | Approach A scenario 1 ✓ |
| 2   | `GET /ready` returns HTTP 200 with `db:"up"` when Postgres is reachable       | Approach A scenario 1 ✓ |
| 3   | Every response carries an `x-request-id` header                               | Approach A scenario 2 ✓ |
| 4   | Caller-provided `x-request-id` is echoed verbatim (correlation contract)      | Approach A scenario 2 ✓ |
| 5   | Audit-log is scoped to parties of the document; outsiders see 0 rows          | Approach A scenario 3 ✓ |
| 6   | Audit-log accepts action + since filters without crashing                     | Approach A scenario 3 ✓ |
| 7   | GitHub Actions CI workflow exists and references migrate + typecheck          | Approach A scenario 4 ✓ |
| 8   | Per-app Dockerfiles and nginx.conf exist                                      | Approach A scenario 4 ✓ |
| 9   | `.env.example` env reference exists                                           | Approach A scenario 4 ✓ |
| 10  | Both new Phase 5.4 docs exist (DOCUMENT_TYPE_CATALOG + ONBOARDING_RUNBOOK)    | Approach A scenario 5 ✓ |
| 11  | Property-based test file for the state-machine factory + link registry exists | Approach A scenario 5 ✓ |
| 12  | Vitest acceptance suite passes 6/6 (CI milestone gate)                        | Approach B ✓            |

Phase 5 is signed off when criteria 1–12 are ✓.

---

## What's deliberately NOT covered

- **OpenTelemetry traces** — PHASES.md §5.1 lists OTel; MVP ships pino correlation instead. OTel is a heavy dependency chain; wrapping `logger.child` in a span-attach helper is the promotion path when the traces are needed.
- **Playwright suite over the portal** — PHASES.md §5.2 lists it; the API acceptance suites cover the choreographies. Playwright over portal happy paths is a follow-up.
- **pg-boss + SMTP consumer for notifications** — Phase 4.5 writes to `notification_outbox`; the dispatch worker that turns rows into emails is Phase 5 follow-up. Portal bell consumes the outbox directly today.
- **Docker `docker build` smoke** — the Dockerfiles are present and shaped correctly; this UAT verifies their on-disk existence rather than shelling out to `docker build`, which requires the Docker daemon and adds ~2 minutes per run. Do a manual `docker build` if you want to verify the images build.

---

**Last updated:** 2026-07-02 · gates milestone M5 (Phase 5 production readiness). 28 assertions + 6 Vitest tests. **MVP complete.**
