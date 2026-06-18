# XBN — User Operations Manual

This is the practical reference for actually using XBN. It covers everything that works today (Phase 1 / milestone M1).

> **Scope note.** XBN is currently a buyer-supplier **document-exchange network** with the substrate complete and a minimal portal. Phase 2 (typed PO/ASN/GR/Invoice/Credit Memo/Remittance flows) and beyond are not yet built. See [`../PHASES.md`](../PHASES.md) for the full roadmap.

---

## Contents

1. [Prerequisites & one-time setup](#1-prerequisites--one-time-setup)
2. [Starting and stopping the stack](#2-starting-and-stopping-the-stack)
3. [Registering an account](#3-registering-an-account)
4. [Logging in and signing out](#4-logging-in-and-signing-out)
5. [Resetting a forgotten password](#5-resetting-a-forgotten-password)
6. [Creating an organisation](#6-creating-an-organisation)
7. [Belonging to multiple orgs (org switcher)](#7-belonging-to-multiple-orgs-org-switcher)
8. [Establishing a trading relationship](#8-establishing-a-trading-relationship)
9. [Inviting a supplier (token flow)](#9-inviting-a-supplier-token-flow)
10. [Publishing a document](#10-publishing-a-document)
11. [Reading a document](#11-reading-a-document)
12. [Superseding a document (new version)](#12-superseding-a-document-new-version)
13. [Transitioning document status](#13-transitioning-document-status)
14. [Linking documents](#14-linking-documents)
15. [Attaching files](#15-attaching-files)
16. [Downloading attachments](#16-downloading-attachments)
17. [End-to-end: Phase 1 happy path](#17-end-to-end-phase-1-happy-path)
18. [Roles & permissions reference](#18-roles--permissions-reference)
19. [What is NOT yet available](#19-what-is-not-yet-available)

Two parallel paths are documented for most operations:

- **Portal** — through the web UI at `http://localhost:5173`. Easier when you want to click around. Some flows (creating relationships, publishing typed documents) don't have UI forms yet — the portal currently shows what exists rather than driving every operation.
- **API** — direct HTTP calls with `curl`. Always works; covers the full surface.

---

## 1. Prerequisites & one-time setup

You need **Node 22 LTS**, **pnpm 11**, and **Docker** (Colima recommended on macOS).

```bash
# Verify versions
node --version       # v22.x.x
pnpm --version       # 11.x.x
docker --version     # 29.x or compatible
```

If any are missing, see [`README.md`](../README.md) at the repo root.

**One-time install of project dependencies:**

```bash
cd /Users/i354664/Projects/XBN
pnpm install
```

**One-time database migration** (creates the 13 tables and 7 enums in Postgres). The Phase 1 schema is checked into `packages/db/prisma/migrations/`; running this applies it:

```bash
DATABASE_URL="postgresql://xbn:xbn_dev@localhost:5432/xbn" \
  pnpm --filter @xbn/db exec prisma migrate deploy
```

(If the DB containers aren't running yet, start them first — see §2 — then run the migration.)

---

## 2. Starting and stopping the stack

XBN consists of three runtime layers:

1. **Infrastructure** — Postgres, MinIO (S3-compatible storage), MailHog — all in Docker.
2. **API** — Express server on `:3000`.
3. **Portal** — Vite dev server on `:5173`, proxies to the API.

### Start everything

```bash
cd /Users/i354664/Projects/XBN

# 1. Bring up Postgres + MinIO + MailHog
docker compose up -d

# Verify they're healthy
docker compose ps
# Expect xbn-postgres + xbn-minio "healthy", xbn-mailhog "Up"

# 2. In one terminal: API
pnpm --filter @xbn/api dev
# → "XBN API listening on :3000"

# 3. In a second terminal: portal
pnpm --filter @xbn/web dev
# → "Local: http://localhost:5173"
```

### Stop everything

```bash
# Stop the dev servers with Ctrl-C in each terminal, then:
docker compose stop          # leaves data on disk
# OR
docker compose down          # also removes containers (volumes survive)
```

### Useful endpoints when running

| URL                            | Purpose                                            |
| ------------------------------ | -------------------------------------------------- |
| `http://localhost:5173`        | Web portal                                         |
| `http://localhost:3000/health` | API health probe (`{ "ok": true }`)                |
| `http://localhost:9001`        | MinIO web console (login: `xbn` / `xbn_dev_minio`) |
| `http://localhost:8025`        | MailHog web inbox (will be used in Phase 4.5)      |

---

## 3. Registering an account

### Portal

1. Open `http://localhost:5173`.
2. Click **Register**.
3. Enter email + password (≥ 8 characters).
4. Submit. You'll see a **verification token** displayed on the page.
   > _Why on the page?_ In production an email would be sent. The notifier is Phase 4.5; for now the token is returned in the response so you can verify locally.
5. Copy the token into the verification field, click **Verify and sign in**. You're now logged in.

### API

```bash
# 1. Register
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "alice@example.com",
    "password": "correcthorse",
    "displayName": "Alice"
  }'
# Response:
# {
#   "userId": "cuid_...",
#   "verificationToken": "abc123…"   ← single-use, 24-hour TTL
# }

# 2. Verify the email with the token
curl -X POST http://localhost:3000/auth/verify-email \
  -H "Content-Type: application/json" \
  -d '{"token":"PASTE_VERIFICATION_TOKEN"}'
# → { "userId": "..." }
```

**Constraints**

- Email must be syntactically valid; stored lower-cased and trimmed.
- Password ≥ 8 chars (Argon2id hashed; OWASP 2024 baseline params).
- A user cannot log in until `verifyEmail` has been called with the token.
- `displayName` is optional.

**Errors**

- `400 { "error": "email_taken" }`
- `400 { "error": "password_too_short" }`
- `400 { "error": "invalid" | "expired" | "consumed" }` on `/auth/verify-email`

---

## 4. Logging in and signing out

### Portal

- **Login**: `http://localhost:5173/` — enter email + password.
- **Sign out**: header dropdown → **Sign out** button.

### API

```bash
# Login. -c stores cookies to a file we'll reuse for subsequent requests.
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -c cookies.txt \
  -d '{"email":"alice@example.com","password":"correcthorse"}'
# → { "userId": "..." }
# A `xbn_session` cookie is set (httpOnly, sameSite=lax, 30-day sliding expiry).

# Use that cookie in subsequent requests:
curl http://localhost:3000/me -b cookies.txt

# Logout
curl -X POST http://localhost:3000/auth/logout -b cookies.txt
```

**Errors**

- `401 { "error": "invalid_credentials" }` — wrong email or wrong password (uniform — does **not** disclose whether the email exists).
- `401 { "error": "email_not_verified" }` — registered but never verified.

### Sliding session expiry

Sessions live 30 days. Each successful `validateSession` call (any authenticated request) refreshes expiry to 30 days from now if you're inside the last 15 days.

---

## 5. Resetting a forgotten password

Token-based, single-use, 1-hour TTL. Resets **invalidate all your existing sessions** (force re-login everywhere).

```bash
# 1. Request a reset. Always returns 200 with token (or null) — does not
#    disclose whether the email is on file. In production the token is
#    emailed; here it's in the response for testing.
curl -X POST http://localhost:3000/auth/request-password-reset \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com"}'
# → { "ok": true, "token": "..." }   if email is on file
# → { "ok": true, "token": null }    otherwise

# 2. Complete the reset
curl -X POST http://localhost:3000/auth/complete-password-reset \
  -H "Content-Type: application/json" \
  -d '{
    "token": "PASTE_RESET_TOKEN",
    "newPassword": "newpassword123"
  }'
# → { "userId": "..." }

# All previous sessions are now dead — log in again with the new password.
```

---

## 6. Creating an organisation

Anyone authenticated can create an org and binds themself as a chosen role inside it. Typically:

- Buyer-side users create their org with `bindAsRole: "BUYER_ADMIN"`
- Supplier-side users create their org with `bindAsRole: "SUPPLIER_ADMIN"`

### Portal

1. Sign in.
2. Go to `/admin`.
3. Type **Legal name**, pick **Buyer** or **Supplier**, click **Create org**.
4. The new org appears in the org switcher in the header. You're now its admin.

### API

```bash
curl -X POST http://localhost:3000/network/orgs \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{
    "legalName":   "Acme Corp",
    "displayName": "Acme",
    "orgType":     "BUYER",
    "bindAsRole":  "BUYER_ADMIN"
  }'
# → { "org": { "id": "cuid_...", "legalName": "Acme Corp", ... } }
```

**Body fields**

| Field         | Required | Type                            | Notes                                                        |
| ------------- | -------- | ------------------------------- | ------------------------------------------------------------ |
| `legalName`   | ✅       | string ≥ 1 char                 | The official entity name                                     |
| `displayName` | ✅       | string ≥ 1 char                 | Shown in the UI                                              |
| `orgType`     | ✅       | `BUYER` \| `SUPPLIER` \| `BOTH` | `BOTH` allows the org to act on either side                  |
| `bindAsRole`  | ✅       | OrgRole                         | Role you receive in the new org. Pick one matching `orgType` |

### List orgs

```bash
curl http://localhost:3000/network/orgs -b cookies.txt | python3 -m json.tool
# → { "orgs": [ {...}, {...} ] }
```

> **Note.** There's no API gate restricting who can create orgs at MVP — anyone authenticated can. This is intentional for the Phase 1 scope. Tighter governance lands when the network admin role gets a UI.

---

## 7. Belonging to multiple orgs (org switcher)

A single user can be a member of any number of orgs, with a different role per (user, org). For example, the same person can be `BUYER_ADMIN` at one org and `SUPPLIER_USER` at another.

### Portal

The header has an **active-org dropdown** showing the role you have in each org. Picking one persists `xbn:activeOrgId` in `localStorage` and reloads the page. Every API request thereafter sends `x-active-org: <orgId>`.

### API

```bash
# Tell the server which org you're acting as via the header:
curl http://localhost:3000/network/relationships \
  -H "x-active-org: cuid_my_buyer_org_id" \
  -b cookies.txt
```

If you omit `x-active-org`, the server defaults to your first membership.

### Inspect what you can do as

```bash
curl http://localhost:3000/me -b cookies.txt | python3 -m json.tool
# → {
#     "user": { "id": "...", "email": "alice@...", ... },
#     "memberships": [ { "orgId": "...", "role": "BUYER_ADMIN" }, ... ],
#     "activeMembership": { ... }
#   }
```

---

## 8. Establishing a trading relationship

A `TradingRelationship` is the central authorization object — a document can only flow on an active relationship with the document type enabled. Two paths exist:

### Path A — Direct create (recommended for local dev)

The buyer (or any authenticated user, currently) creates an `ACTIVE` relationship in one shot. The supplier doesn't need to do anything.

```bash
curl -X POST http://localhost:3000/network/relationships \
  -H "Content-Type: application/json" \
  -H "x-active-org: $BUYER_ORG_ID" \
  -b cookies.txt \
  -d '{
    "buyerOrgId":              "'"$BUYER_ORG_ID"'",
    "supplierOrgId":           "'"$SUPPLIER_ORG_ID"'",
    "status":                  "ACTIVE",
    "enabledDocumentTypes":    ["GENERIC_DOCUMENT", "PO", "ORDER_CONFIRMATION"],
    "defaultCurrency":         "USD",
    "summaryInvoicingEnabled": false
  }'
# → { "relationship": { "id": "...", "status": "ACTIVE", ... } }
```

**Body fields**

| Field                     | Required | Type                             | Notes                                                           |
| ------------------------- | -------- | -------------------------------- | --------------------------------------------------------------- |
| `buyerOrgId`              | ✅       | cuid                             | Org with `orgType` BUYER or BOTH                                |
| `supplierOrgId`           | ✅       | cuid                             | Org with `orgType` SUPPLIER or BOTH                             |
| `status`                  | optional | `PENDING_INVITATION` \| `ACTIVE` | Default `ACTIVE`                                                |
| `enabledDocumentTypes`    | optional | `string[]`                       | Doc types allowed to flow. **Empty = nothing can be published** |
| `defaultCurrency`         | optional | ISO-4217 (3 chars)               | e.g. `"USD"`                                                    |
| `summaryInvoicingEnabled` | optional | boolean                          | Phase 2.6 SUMMARY-invoice gate. Default `false`                 |

`enabledDocumentTypes` is the toggle for what can flow. Currently registered document types are `GENERIC_DOCUMENT`, `PO`, `ORDER_CONFIRMATION` — you must list each before they can be published.

**Errors**

- `409 { "error": "already_exists" }` — there's already a relationship with this (buyer, supplier) pair (one per pair, by DB unique).
- `400 { "error": "validation", "issues": [...] }` — bad body shape.

### List relationships you're part of

```bash
curl http://localhost:3000/network/relationships \
  -H "x-active-org: $BUYER_ORG_ID" \
  -b cookies.txt
```

Returns relationships where the active org is on either side (buyer **or** supplier).

### Lifecycle transitions

```bash
# Activate from PENDING_INVITATION
curl -X POST http://localhost:3000/network/relationships/$REL_ID/activate \
  -b cookies.txt
```

There are no HTTP endpoints exposed for `suspend` or `terminate` yet (the service-layer functions exist; they'll be wired up when the relationship-management UI lands in Phase 4.2).

---

## 9. Inviting a supplier (token flow)

The buyer-side onboarding flow when the supplier doesn't yet have a relationship with you. **Caveat:** at present, accepting an invitation marks the invitation `ACCEPTED` but does **not** auto-create the `TradingRelationship`. You still call Path A above to materialise it. Wiring "accept → auto-create" is a small follow-up.

### Step 1 — buyer issues an invitation

```bash
curl -X POST http://localhost:3000/network/invitations \
  -H "Content-Type: application/json" \
  -H "x-active-org: $BUYER_ORG_ID" \
  -b buyer-cookies.txt \
  -d '{
    "buyerOrgId":     "'"$BUYER_ORG_ID"'",
    "invitedEmail":   "supplier@example.com",
    "invitedOrgName": "Supplier Co"
  }'
# → { "invitation": { "id": "...", "status": "PENDING", "expiresAt": "..." }, "token": "..." }
```

**Save the `token`** — single-use, 14-day TTL. In production the email contains a link with this token. Right now you copy/paste it.

### Step 2 — supplier accepts

The supplier (with their own session) submits the token:

```bash
curl -X POST http://localhost:3000/network/invitations/accept \
  -H "Content-Type: application/json" \
  -b supplier-cookies.txt \
  -d '{"token":"PASTE_INVITATION_TOKEN"}'
# → { "ok": true, "invitationId": "...", "invitedEmail": "..." }
```

**Errors**

- `400 { "error": "invalid" }` — unknown token.
- `400 { "error": "expired" }` — past TTL.
- `400 { "error": "already_resolved" }` — already accepted, declined, or expired.

### Step 3 — buyer creates the actual relationship

Use Path A from §8.

---

## 10. Publishing a document

A document publish goes through:

1. **Trading-relationship guard** — the relationship must exist and be ACTIVE, and the doc type must be in `enabledDocumentTypes`.
2. **Body validation** — Zod schema for the doc type (rejects malformed body).
3. **Number reservation** — atomic per (issuer, type, prefix).
4. **Repository write** — inserts the document, version 1, and the audit-log entry in one transaction.

### Currently registered document types

| Type                 | Body schema                                                                                                                                                                                                   | Initial state |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `GENERIC_DOCUMENT`   | `{ note: string, metadata?: object }`                                                                                                                                                                         | `PUBLISHED`   |
| `PO`                 | See §2.1 / [API_REFERENCE.md](./API_REFERENCE.md#post-documents) — header (currency, payment terms, ship-to/bill-to addresses, requested delivery date) + lines (sku, description, quantity, unit price, UoM) | `DRAFT`       |
| `ORDER_CONFIRMATION` | Discriminated union on `mode`: `FULL_ACCEPT` / `ACCEPT_WITH_CHANGES` (with `proposedChanges`) / `REJECT`. Always carries `poDocumentNumber` + `poDocumentId`. Auto-links `ACKNOWLEDGES → PO` on publish.      | `DRAFT`       |
| `PO_CHANGE`          | `{ poDocumentNumber, poDocumentId, changeReason, revisedBody: <full PO body> }` — buyer-issued amendment                                                                                                      | `DRAFT`       |

### API

```bash
# A buyer publishing a PO to a supplier
curl -X POST http://localhost:3000/documents \
  -H "Content-Type: application/json" \
  -H "x-active-org: $BUYER_ORG_ID" \
  -b cookies.txt \
  -d '{
    "documentType":   "PO",
    "recipientOrgId": "'"$SUPPLIER_ORG_ID"'",
    "body": {
      "currency": "USD",
      "paymentTermsRef": "NET-30",
      "requestedDeliveryDate": "2026-07-15",
      "shipTo": {
        "name": "Buyer Receiving",
        "line1": "1 Buyer Way",
        "city": "Buyerville",
        "countryCode": "US"
      },
      "billTo": {
        "name": "Buyer AP",
        "line1": "1 Buyer Way",
        "city": "Buyerville",
        "countryCode": "US"
      },
      "lines": [
        {
          "sku": "WIDGET-1",
          "description": "Widget Mk I",
          "quantity": 5,
          "unitPrice": 10.00,
          "unitOfMeasure": "EA"
        }
      ]
    }
  }'
# → {
#     "documentId":     "cuid_...",
#     "versionId":      "cuid_...",
#     "documentNumber": "PO-000001"     ← sequential per (issuerOrg, type)
#   }
```

```bash
# A supplier publishing a generic note back to the buyer
curl -X POST http://localhost:3000/documents \
  -H "Content-Type: application/json" \
  -H "x-active-org: $SUPPLIER_ORG_ID" \
  -b supplier-cookies.txt \
  -d '{
    "documentType":   "GENERIC_DOCUMENT",
    "recipientOrgId": "'"$BUYER_ORG_ID"'",
    "body": { "note": "Got the PO — confirming." }
  }'
```

**Common rejection reasons**

| Status | `error`                 | `reason.kind` | Cause                                                             |
| ------ | ----------------------- | ------------- | ----------------------------------------------------------------- |
| 400    | `publish_rejected`      | `guard`       | No relationship, relationship not ACTIVE, or doc type not enabled |
| 400    | `publish_rejected`      | `body_schema` | Body fails the Zod schema                                         |
| 400    | `unknown_document_type` | —             | Type not registered                                               |

### Portal

Phase 2.1 ships buyer-side **My POs** (`/buyer/po`), **Create PO** (`/buyer/po/new`), and PO detail (`/buyer/po/:id`) with role-aware action buttons (Issue / Mark in fulfilment / Close / Cancel). Supplier sees **Incoming POs** at `/supplier/po`. Phase 2.2 adds **Issue PO change** (`/buyer/po/:id/change`) and a PO_CHANGE detail page where the supplier accepts or rejects. Phase 2.3 replaces the supplier's blunt Acknowledge button with a **3-mode acknowledgement form** at `/supplier/po/:id/acknowledge` (FULL_ACCEPT / ACCEPT_WITH_CHANGES with proposed line revisions / REJECT) plus a shared **OrderConfirmation detail** page at `/<role>/order-confirmation/:id` where the buyer accepts or rejects the supplier's response (and can deep-link to issue a PO_CHANGE).

---

## 11. Reading a document

```bash
curl http://localhost:3000/documents/$DOC_ID \
  -H "x-active-org: $MY_ORG_ID" \
  -b cookies.txt | python3 -m json.tool
```

Response includes:

```json
{
  "id":                    "cuid_...",
  "documentType":          "PO",
  "documentNumber":        "PO-000001",
  "issuerOrgId":           "...",
  "recipientOrgId":        "...",
  "tradingRelationshipId": "...",
  "currentVersionId":      "...",
  "status":                "ISSUED",
  "createdAt":             "2026-06-18T10:00:00.000Z",
  "updatedAt":             "...",
  "versions": [
    { "id": "...", "versionNumber": 1, "body": { ... }, "createdAt": "...", "createdById": "...", "changeReason": "created" },
    { "id": "...", "versionNumber": 2, "body": { ... }, "createdAt": "...", "createdById": "...", "changeReason": "..." }
  ],
  "outgoingLinks": [{ "fromDocumentId": "...", "toDocumentId": "...", "linkType": "ACKNOWLEDGES", ... }],
  "incomingLinks": [...],
  "auditLog": [
    { "action": "CREATED",         "actorUserId": "...", "actorOrgId": "...", "occurredAt": "...", "payload": {...} },
    { "action": "ATTACHMENT_ADDED", ... },
    { "action": "STATUS_CHANGED",  ... },
    { "action": "SUPERSEDED",      ... }
  ],
  "attachments": [ { "id": "...", "filename": "hello.pdf", "mimeType": "application/pdf", "sizeBytes": 1234, "sha256": "..." } ]
}
```

> **Listing.** Phase 2 adds `GET /documents` with `box=inbox|outbox|both` plus optional `documentType=`, `status=`, `counterpartyOrgId=`, `limit=`, `offset=` filters. The portal's "My POs" page is built on it. Cross-type search and richer filters land in Phase 4.1.

---

## 12. Superseding a document (new version)

Append a new immutable version to an existing document. The previous body stays intact in `versions[]`; `currentVersionId` advances; an audit-log entry with action `SUPERSEDED` is written.

```bash
curl -X POST http://localhost:3000/documents/$DOC_ID/supersede \
  -H "Content-Type: application/json" \
  -H "x-active-org: $MY_ORG_ID" \
  -b cookies.txt \
  -d '{
    "body": {
      "currency": "USD",
      "lines": [{ "sku": "WIDGET-1", "quantity": 7, "unitPrice": 10.00 }]
    },
    "changeReason": "buyer increased quantity from 5 to 7"
  }'
# → { "versionId": "cuid_...", "versionNumber": 2 }
```

The new body is validated against the document type's Zod schema again, exactly like publish.

---

## 13. Transitioning document status

Each document type has its own state machine. Transitions check:

- The `(fromStatus → toStatus)` edge is declared
- The actor's role matches `requiredRole`
- The actor's side (`issuer` or `recipient`) matches `actor`
- An optional guard predicate

### PO state machine (PHASES.md §2.1)

```
DRAFT ─── (BUYER_*, issuer) ──────────► ISSUED
DRAFT ─── (BUYER_ADMIN, issuer) ──────► CANCELLED
DRAFT ─── (BUYER_ADMIN, issuer) ──────► CHANGED              [via accepted PO_CHANGE]
ISSUED ── (SUPPLIER_*, recipient) ────► ACKNOWLEDGED
ISSUED ── (BUYER_ADMIN, issuer) ──────► CANCELLED
ISSUED ── (BUYER_ADMIN, issuer) ──────► CHANGED              [via accepted PO_CHANGE]
ACKNOWLEDGED ─ (BUYER_*, issuer) ─────► IN_FULFILLMENT
ACKNOWLEDGED ─ (BUYER_ADMIN, issuer) ─► CANCELLED
ACKNOWLEDGED ─ (BUYER_ADMIN, issuer) ─► CHANGED              [via accepted PO_CHANGE]
IN_FULFILLMENT (BUYER_*, issuer) ─────► CLOSED
IN_FULFILLMENT (BUYER_ADMIN, issuer) ─► CANCELLED
IN_FULFILLMENT (BUYER_ADMIN, issuer) ─► CHANGED              [via accepted PO_CHANGE]
CLOSED, CANCELLED, CHANGED → terminal
```

**`CHANGED` precondition.** The transition target `CHANGED` requires an **accepted PO_CHANGE** linked via `SUPERSEDES → this PO`. Without one, the transition is rejected with `reason.kind: "precondition_failed"` / `detail.kind: "no_accepted_po_change"`. See §10 PO_CHANGE flow and PHASES.md §2.2.

### PO_CHANGE state machine (PHASES.md §2.2)

```
DRAFT ── (BUYER_*, issuer) ──────────► ISSUED
ISSUED ─ (SUPPLIER_*, recipient) ────► ACCEPTED_BY_SUPPLIER
ISSUED ─ (SUPPLIER_*, recipient) ────► REJECTED_BY_SUPPLIER
ACCEPTED_BY_SUPPLIER, REJECTED_BY_SUPPLIER → terminal
```

### ORDER_CONFIRMATION state machine (PHASES.md §2.3)

```
DRAFT ── (SUPPLIER_*, issuer) ───────► ISSUED
ISSUED ─ (BUYER_*, recipient) ───────► ACCEPTED_BY_BUYER   [terminal]
ISSUED ─ (BUYER_*, recipient) ───────► REJECTED_BY_BUYER   [terminal]
```

Buyer responses are most meaningful for `ACCEPT_WITH_CHANGES` — accepting the response means the buyer intends to issue a `PO_CHANGE` to materialise the supplier's proposed amendments. (The OC body itself never mutates the PO; only PO versions do.)

### API

```bash
# Buyer issues a draft PO
curl -X POST http://localhost:3000/documents/$PO_ID/transition \
  -H "Content-Type: application/json" \
  -H "x-active-org: $BUYER_ORG_ID" \
  -b buyer-cookies.txt \
  -d '{ "fromStatus": "DRAFT", "toStatus": "ISSUED" }'
# → { "nextStatus": "ISSUED" }

# Supplier acknowledges the issued PO
curl -X POST http://localhost:3000/documents/$PO_ID/transition \
  -H "Content-Type: application/json" \
  -H "x-active-org: $SUPPLIER_ORG_ID" \
  -b supplier-cookies.txt \
  -d '{ "fromStatus": "ISSUED", "toStatus": "ACKNOWLEDGED" }'
# → { "nextStatus": "ACKNOWLEDGED" }
```

**Rejection reasons** (status 400, `error: "transition_rejected"`)

| `reason.kind`                                                     | Cause                                                                                              |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `state_machine` with `kind: "no_such_transition"`                 | The edge isn't declared                                                                            |
| `state_machine` with `kind: "wrong_role"`                         | Caller's role isn't authorised for the edge                                                        |
| `state_machine` with `kind: "wrong_actor_side"`                   | Caller is on the wrong side of the relationship                                                    |
| `repository` with `kind: "status_mismatch"`                       | Optimistic-concurrency: the row's current status isn't `fromStatus` (someone else transitioned it) |
| `precondition_failed` with `detail.kind: "no_accepted_po_change"` | Trying to move a PO to `CHANGED` without an accepted PO_CHANGE pointing at it                      |

---

## 14. Linking documents

Documents form a DAG via typed links. The link registry says which `(fromType, toType, linkType)` triples are allowed.

### Currently registered link rules

| From → To                               | linkType       | Cardinality       | Notes                                    |
| --------------------------------------- | -------------- | ----------------- | ---------------------------------------- |
| `GENERIC_DOCUMENT` → `GENERIC_DOCUMENT` | `RESPONDS_TO`  | many in / one out |                                          |
| `ORDER_CONFIRMATION` → `PO`             | `ACKNOWLEDGES` | one in / one out  |                                          |
| `PO_CHANGE` → `PO`                      | `SUPERSEDES`   | one in / one out  | Required precondition for PO `→ CHANGED` |
| `PO` → `PO`                             | `SUPERSEDES`   | one in / one out  | Reserved for cross-PO supersession       |

### API

```bash
# Supplier publishes an ORDER_CONFIRMATION, then links it to the PO
curl -X POST http://localhost:3000/documents/$ACK_ID/links \
  -H "Content-Type: application/json" \
  -H "x-active-org: $SUPPLIER_ORG_ID" \
  -b supplier-cookies.txt \
  -d '{
    "toDocumentId":   "'"$PO_ID"'",
    "toDocumentType": "PO",
    "linkType":       "ACKNOWLEDGES"
  }'
# → { "linkId": "cuid_..." }
```

**Rejection reasons**

| Status | `error`         | `reason.kind`                                                                                                                                                                                                           |
| ------ | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `link_rejected` | `unknown_link_rule` — `(from, to, linkType)` not registered                                                                                                                                                             |
| 400    | `link_rejected` | `repository` with `kind: "duplicate_link"` — the same `(from, to, linkType)` triple already exists. **This is the no-double-billing guard from PHASES.md §2.6** — important when SUMMARY invoicing arrives in Phase 2.6 |

---

## 15. Attaching files

Attachments go to MinIO (S3-compatible). XBN computes SHA-256 at upload and verifies it on every download.

```bash
# Encode a file to base64 and POST it as JSON.
BASE64=$(base64 -i path/to/myfile.pdf)
curl -X POST http://localhost:3000/documents/$DOC_ID/attachments \
  -H "Content-Type: application/json" \
  -H "x-active-org: $MY_ORG_ID" \
  -b cookies.txt \
  -d '{
    "filename":    "myfile.pdf",
    "mimeType":    "application/pdf",
    "bytesBase64": "'"$BASE64"'"
  }'
# → {
#     "id":         "cuid_...",
#     "storageKey": "docs/<documentId>/<sha256>-myfile.pdf",
#     "filename":   "myfile.pdf",
#     "mimeType":   "application/pdf",
#     "sizeBytes":  12345,
#     "sha256":     "5b0c…"
#   }
```

A `documentAuditLog` row with action `ATTACHMENT_ADDED` is also written.

> **Body size limit.** The Express JSON body limit is 20 MB; that's also the practical attachment cap right now. Large-file streaming is a Phase 5 concern.

---

## 16. Downloading attachments

```bash
curl http://localhost:3000/attachments/$ATTACHMENT_ID \
  -H "x-active-org: $MY_ORG_ID" \
  -b cookies.txt \
  -o downloaded.pdf
```

The response carries the original `Content-Type` and `Content-Disposition` headers. SHA-256 is verified server-side before the bytes leave the server; if the stored bytes don't match the recorded hash you get `404 { "error": "sha256_mismatch" }`.

---

## 17. End-to-end: Phase 1 happy path

This is the same flow the M1 acceptance test runs. Copy/paste the whole block in one terminal — it stands up two users, two orgs, an active relationship, exchanges a generic document with an attachment, supersedes a version, and verifies the audit log.

```bash
cd /Users/i354664/Projects/XBN
docker compose up -d           # if not already up
# In another terminal: pnpm --filter @xbn/api dev

API=http://localhost:3000

# --- Register + verify + login: BUYER ---
BUYER_REG=$(curl -s -X POST $API/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"buyer@example.com","password":"correcthorse"}')
BUYER_VTOKEN=$(echo "$BUYER_REG" | python3 -c "import sys,json;print(json.load(sys.stdin)['verificationToken'])")
curl -s -X POST $API/auth/verify-email -H "Content-Type: application/json" \
  -d "{\"token\":\"$BUYER_VTOKEN\"}" > /dev/null
curl -s -X POST $API/auth/login -H "Content-Type: application/json" -c buyer.cookies \
  -d '{"email":"buyer@example.com","password":"correcthorse"}' > /dev/null

# --- Register + verify + login: SUPPLIER ---
SUP_REG=$(curl -s -X POST $API/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"supplier@example.com","password":"correcthorse"}')
SUP_VTOKEN=$(echo "$SUP_REG" | python3 -c "import sys,json;print(json.load(sys.stdin)['verificationToken'])")
curl -s -X POST $API/auth/verify-email -H "Content-Type: application/json" \
  -d "{\"token\":\"$SUP_VTOKEN\"}" > /dev/null
curl -s -X POST $API/auth/login -H "Content-Type: application/json" -c supplier.cookies \
  -d '{"email":"supplier@example.com","password":"correcthorse"}' > /dev/null

# --- Each side creates their org ---
BUYER_ORG=$(curl -s -X POST $API/network/orgs -H "Content-Type: application/json" -b buyer.cookies \
  -d '{"legalName":"Buyer Co","displayName":"Buyer Co","orgType":"BUYER","bindAsRole":"BUYER_ADMIN"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['org']['id'])")
SUP_ORG=$(curl -s -X POST $API/network/orgs -H "Content-Type: application/json" -b supplier.cookies \
  -d '{"legalName":"Supplier Co","displayName":"Supplier Co","orgType":"SUPPLIER","bindAsRole":"SUPPLIER_ADMIN"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['org']['id'])")

echo "Buyer org:    $BUYER_ORG"
echo "Supplier org: $SUP_ORG"

# --- Trading relationship (ACTIVE), with all current doc types enabled ---
curl -s -X POST $API/network/relationships \
  -H "Content-Type: application/json" -H "x-active-org: $BUYER_ORG" -b buyer.cookies \
  -d "{
    \"buyerOrgId\":\"$BUYER_ORG\",
    \"supplierOrgId\":\"$SUP_ORG\",
    \"status\":\"ACTIVE\",
    \"enabledDocumentTypes\":[\"GENERIC_DOCUMENT\",\"PO\",\"ORDER_CONFIRMATION\"],
    \"defaultCurrency\":\"USD\"
  }" > /dev/null

# --- Buyer publishes a GENERIC_DOCUMENT ---
DOC=$(curl -s -X POST $API/documents \
  -H "Content-Type: application/json" -H "x-active-org: $BUYER_ORG" -b buyer.cookies \
  -d "{
    \"documentType\":\"GENERIC_DOCUMENT\",
    \"recipientOrgId\":\"$SUP_ORG\",
    \"body\":{\"note\":\"hello supplier\"}
  }")
DOC_ID=$(echo "$DOC" | python3 -c "import sys,json;print(json.load(sys.stdin)['documentId'])")

# --- Buyer attaches a small text file ---
B64=$(printf '%s' "Hello, XBN attachments." | base64)
curl -s -X POST $API/documents/$DOC_ID/attachments \
  -H "Content-Type: application/json" -H "x-active-org: $BUYER_ORG" -b buyer.cookies \
  -d "{\"filename\":\"hello.txt\",\"mimeType\":\"text/plain\",\"bytesBase64\":\"$B64\"}" > /dev/null

# --- Buyer supersedes (a tweaked body) ---
curl -s -X POST $API/documents/$DOC_ID/supersede \
  -H "Content-Type: application/json" -H "x-active-org: $BUYER_ORG" -b buyer.cookies \
  -d '{"body":{"note":"hello supplier (revised)"},"changeReason":"typo fix"}' > /dev/null

# --- Supplier reads the document and audit log ---
curl -s $API/documents/$DOC_ID \
  -H "x-active-org: $SUP_ORG" -b supplier.cookies | python3 -m json.tool
```

You should see two version rows, one attachment, and audit-log entries for `CREATED`, `ATTACHMENT_ADDED`, and `SUPERSEDED`.

---

## 18. Roles & permissions reference

### Org roles

| Role             | Typical use                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `BUYER_USER`     | Buyer-side user: views relationships, may eventually create docs (Phase 2 specifics).                             |
| `BUYER_ADMIN`    | Buyer-side admin: configures relationships, issues invitations, transitions `DRAFT → ISSUED` on POs, cancels POs. |
| `SUPPLIER_USER`  | Supplier-side user: acknowledges incoming POs (`ISSUED → ACKNOWLEDGED`), publishes `ORDER_CONFIRMATION`.          |
| `SUPPLIER_ADMIN` | Supplier-side admin: same as `SUPPLIER_USER` plus relationship-level config when wired.                           |
| `NETWORK_ADMIN`  | Network operator: cross-org visibility, audit, eventual moderation.                                               |

A user holds memberships per org; the **active** membership for a request is decided by the `x-active-org` header (or first membership if absent).

### Where roles are enforced

- **HTTP middleware** uses `mustAuth(res)` and `mustRole(res, allowedRoles)` (see `apps/api/src/auth-middleware.ts`).
- **State machines** (per document type) declare `requiredRole` per transition.
- **Trading-relationship guard** runs on every publish — relationship must be ACTIVE and doc type enabled.

---

## 19. What is NOT yet available

Honest limits of the current build, so you don't go looking for these:

- **Cross-type search** — Postgres FTS is wired to land in Phase 4.1 (basic listing exists via `GET /documents` but full-text and dashboards don't).
- **Typed business documents beyond GENERIC_DOCUMENT, PO, ORDER_CONFIRMATION, PO_CHANGE** — ASN, GR, Invoice, Credit Memo, Remittance, Forecast, SA Releases, Subcontracting, Consignment, Quality — all coming in Phase 2/3.
- **Email delivery** — verification + reset tokens come back in API responses (and are shown on the register page) instead of being emailed. Phase 4.5 wires MailHog and SMTP.
- **Approval workflows / payment posting / MRP** — explicitly **out of scope**. XBN is a transaction hub; these belong in the buyer's ERP. (See [`PHASES.md`](../PHASES.md) and [`CLAUDE.md`](../CLAUDE.md) cross-cutting concern #6.)
- **SSO / SAML** — deferred. Plain email + password only at MVP.
- **Suspend / terminate relationship UI/API** — service-layer functions exist; HTTP routes will be added when the relationship-management UI lands in Phase 4.2.

---

**Last updated:** 2026-06-19 · Phase 2.1 (PO), 2.2 (PO_CHANGE), and 2.3 (ORDER_CONFIRMATION) complete.

For architecture see [`../PHASES.md`](../PHASES.md). For task progress see [`../TASKS.md`](../TASKS.md).
