# XBN — API Reference

Endpoint-by-endpoint reference for the XBN HTTP API. Companion to [`OPERATIONS.md`](./OPERATIONS.md), which has narrative usage flows.

**Base URL:** `http://localhost:3000` in dev. The Vite portal at `:5173` proxies to it transparently.

**Auth:** session cookie `xbn_session` (httpOnly, sameSite=lax, 30-day sliding expiry). Set by `POST /auth/login`, cleared by `POST /auth/logout`.

**Active org header:** `x-active-org: <orgId>` selects which membership the request runs as. Required for any operation scoped to an org. If omitted on a route that needs it, the server falls back to the user's first membership.

**Content type:** all bodies are `application/json` unless noted.

**Error envelope:**

```json
{ "error": "<code>", "reason": { ... }, "issues": [ ... ] }
```

- `error` is always a string code.
- `reason` (optional, object) carries structured detail when the rejection comes from a deeper layer (state machine, repository, guard).
- `issues` (optional, array) is Zod's validation issue list.

---

## Health

### `GET /health`

Liveness probe. Doesn't touch the DB.

**Response 200**

```json
{ "ok": true }
```

---

## Auth

### `POST /auth/register`

Create a new account. Returns the email-verification token (in production this would be emailed).

**Body**
| Field | Type | Required |
|---|---|---|
| `email` | string (email) | ✅ |
| `password` | string ≥ 8 | ✅ |
| `displayName` | string | optional |

**201**

```json
{ "userId": "cuid_...", "verificationToken": "..." }
```

**400** errors: `email_taken`, `password_too_short`, `validation`.

---

### `POST /auth/verify-email`

Consume a verification token (single-use, 24-hour TTL).

**Body**

```json
{ "token": "..." }
```

**200**

```json
{ "userId": "..." }
```

**400** errors: `invalid`, `expired`, `consumed`.

---

### `POST /auth/login`

Authenticate and receive the session cookie.

**Body**

```json
{ "email": "alice@example.com", "password": "..." }
```

**200** — also sets `xbn_session` cookie.

```json
{ "userId": "..." }
```

**401** errors: `invalid_credentials`, `email_not_verified`. Both are returned uniformly without disclosing whether the email exists.

---

### `POST /auth/logout`

Invalidate the current session and clear the cookie.

**200**

```json
{ "ok": true }
```

---

### `POST /auth/request-password-reset`

Always returns `200`. Token included only when the email is on file (avoids enumeration).

**Body**

```json
{ "email": "alice@example.com" }
```

**200**

```json
{ "ok": true, "token": "..." | null }
```

---

### `POST /auth/complete-password-reset`

Consume the reset token, set the new password, **invalidate all of the user's sessions**.

**Body**

```json
{ "token": "...", "newPassword": "..." }
```

**200**

```json
{ "userId": "..." }
```

**400** errors: `invalid`, `expired`, `consumed`, `password_too_short`.

---

## Me

### `GET /me`

Current user, all memberships, active membership.

**200**

```json
{
  "user": { "id": "...", "email": "...", "displayName": "...", "emailVerifiedAt": "..." },
  "memberships": [
    { "id": "...", "userId": "...", "orgId": "...", "role": "BUYER_ADMIN" }
  ],
  "activeMembership": { ... }
}
```

**401** when no session cookie.

---

## Network — Orgs

### `POST /network/orgs`

Create a new org and bind the caller as the chosen role inside it.

**Body**
| Field | Type | Required |
|---|---|---|
| `legalName` | string ≥ 1 | ✅ |
| `displayName` | string ≥ 1 | ✅ |
| `orgType` | `BUYER` \| `SUPPLIER` \| `BOTH` | ✅ |
| `bindAsRole` | `BUYER_USER` \| `BUYER_ADMIN` \| `SUPPLIER_USER` \| `SUPPLIER_ADMIN` \| `NETWORK_ADMIN` | ✅ |

**201**

```json
{ "org": { "id": "...", "legalName": "...", "displayName": "...", "orgType": "BUYER" } }
```

**400** errors: `validation`.

---

### `GET /network/orgs`

List all orgs visible on the network.

**200**

```json
{ "orgs": [{ "id": "...", "legalName": "...", "displayName": "...", "orgType": "BUYER" }] }
```

---

## Network — Relationships

### `POST /network/relationships`

Create a trading relationship between a buyer org and a supplier org. One per (buyerOrgId, supplierOrgId) pair (DB unique).

**Body**
| Field | Type | Required | Default |
|---|---|---|---|
| `buyerOrgId` | cuid | ✅ | — |
| `supplierOrgId` | cuid | ✅ | — |
| `status` | `PENDING_INVITATION` \| `ACTIVE` | optional | `ACTIVE` |
| `enabledDocumentTypes` | string[] | optional | `[]` |
| `defaultCurrency` | string (ISO-4217, 3 chars) | optional | — |
| `summaryInvoicingEnabled` | boolean | optional | `false` |

**201**

```json
{
  "relationship": {
    "id": "...",
    "buyerOrgId": "...",
    "supplierOrgId": "...",
    "status": "ACTIVE",
    "enabledDocumentTypes": ["PO", "ORDER_CONFIRMATION"],
    "summaryInvoicingEnabled": false,
    "defaultCurrency": "USD",
    "defaultIncoterms": null,
    "documentNumberSource": "NETWORK"
  }
}
```

**409** errors: `already_exists` (a relationship with this pair already exists).
**400** errors: `validation`.

---

### `GET /network/relationships`

List relationships where the active org is on either side (buyer or supplier).

**Headers:** `x-active-org` required.

**200**

```json
{ "relationships": [ { ... }, { ... } ] }
```

**403** errors: `no_active_membership`.

---

### `POST /network/relationships/:id/activate`

Move a `PENDING_INVITATION` relationship to `ACTIVE`. No-op for any other source state.

**200**

```json
{ "ok": true | false }
```

---

## Network — Invitations

### `POST /network/invitations`

Issue a one-time invitation to bring a supplier onto the network. 14-day TTL.

**Body**
| Field | Type | Required |
|---|---|---|
| `buyerOrgId` | cuid | ✅ |
| `invitedEmail` | string (email) | ✅ |
| `invitedOrgName` | string | ✅ |

**201**

```json
{
  "token": "...",
  "invitation": {
    "id": "...",
    "invitedByUserId": "...",
    "invitedEmail": "supplier@example.com",
    "invitedOrgName": "Supplier Co",
    "status": "PENDING",
    "expiresAt": "..."
  }
}
```

> **Note.** Currently the invitation flow does NOT auto-create the `TradingRelationship`. After accept, call `POST /network/relationships` to materialise it.

---

### `POST /network/invitations/accept`

Mark an invitation `ACCEPTED` (single-use).

**Body**

```json
{ "token": "..." }
```

**200**

```json
{ "ok": true, "invitationId": "...", "invitedEmail": "...", "invitedByUserId": "..." }
```

**400** errors: `invalid`, `expired`, `already_resolved`.

---

## Documents

All document routes require auth and `x-active-org`.

### `GET /documents`

List documents scoped to the active org. Supports inbox/outbox filtering, plus optional document-type, status, and counterparty filters.

**Query params**
| Param | Type | Default | Notes |
|---|---|---|---|
| `box` | `inbox` \| `outbox` \| `both` | `both` | `inbox` = active org is recipient; `outbox` = active org is issuer |
| `documentType` | string | — | e.g. `PO`, `ORDER_CONFIRMATION` |
| `status` | string | — | e.g. `DRAFT`, `ISSUED` |
| `counterpartyOrgId` | cuid | — | Restrict to docs flowing to/from this counterparty |
| `limit` | int 1–200 | 50 | |
| `offset` | int ≥ 0 | 0 | Simple offset pagination |

**200**

```json
{
  "documents": [
    {
      "id": "cuid_...",
      "documentType": "PO",
      "documentNumber": "PO-000001",
      "issuerOrgId": "...",
      "recipientOrgId": "...",
      "status": "ISSUED",
      "createdAt": "...",
      "updatedAt": "...",
      "currency": "USD",
      "totalAmount": null,
      "issueDate": null
    }
  ],
  "total": 12,
  "limit": 50,
  "offset": 0
}
```

`totalAmount` is serialised as a string when non-null (Postgres `decimal` precision preservation).

---

### `POST /documents`

Publish a document. Goes through the trading-relationship guard, body-schema validation, atomic numbering, and the repository's versioning + audit triad — all in one Postgres transaction.

**Body**
| Field | Type | Required |
|---|---|---|
| `documentType` | string | ✅ — must be a registered type |
| `recipientOrgId` | cuid | ✅ |
| `body` | object | ✅ — shape depends on `documentType` |
| `invoiceMode` | `PO_FLIP` \| `SUMMARY` | optional — only relevant when `documentType === "INVOICE"` (Phase 2.6) |

**Currently registered types and body shapes:**

| Type                 | Body                                                                |
| -------------------- | ------------------------------------------------------------------- |
| `GENERIC_DOCUMENT`   | `{ note: string, metadata?: object }`                               |
| `PO`                 | See "PO body" below                                                 |
| `ORDER_CONFIRMATION` | Discriminated union on `mode` — see "ORDER_CONFIRMATION body" below |
| `PO_CHANGE`          | See "PO_CHANGE body" below                                          |

**PO body** (PHASES.md §2.1)

```ts
{
  currency: string,                  // ISO-4217, exactly 3 chars
  paymentTermsRef?: string,
  incoterms?: string,                // FOB, CIF, EXW, ...
  buyerReference?: string,
  costCentre?: string,
  requestedDeliveryDate: string,     // ISO YYYY-MM-DD
  shipTo: Address,
  billTo: Address,
  lines: Array<{
    sku: string,
    description: string,
    quantity: number,                // > 0
    unitPrice: number,               // ≥ 0
    unitOfMeasure: string,           // EA, KG, M, ...
    lineRef?: string                 // optional buyer-internal ref
  }>                                 // ≥ 1 element
}

type Address = {
  name: string,
  line1: string,
  line2?: string,
  city: string,
  region?: string,
  postalCode?: string,
  countryCode: string                // ISO-3166 alpha-2 (US, GB, ...)
}
```

**PO_CHANGE body** (PHASES.md §2.2)

```ts
{
  poDocumentNumber: string,          // human-facing PO number being amended
  poDocumentId: string,              // cuid of the PO being amended
  changeReason: string,              // free-form, surfaced in audit + supplier UI
  affectedLineRefs?: string[],       // optional convenience for diff highlighting
  revisedBody: PoBody                // complete revised PO body, same shape as PO
}
```

Carries the **complete revised PO body**, not a diff. The supplier UI computes the diff against the prior PO version. After the supplier accepts (transitions `ACCEPTED_BY_SUPPLIER`), the buyer can transition the original PO to `CHANGED`.

**ORDER_CONFIRMATION body** (PHASES.md §2.3) — Zod discriminated union on `mode`:

```ts
// FULL_ACCEPT — accept the PO as issued.
{
  mode: 'FULL_ACCEPT',
  poDocumentNumber: string,
  poDocumentId: string,              // cuid of PO being acknowledged
  comments?: string,
}

// ACCEPT_WITH_CHANGES — accept in principle, propose amendments.
// proposedChanges must include at least one of revisedRequestedDeliveryDate
// or a non-empty revisedLines array.
{
  mode: 'ACCEPT_WITH_CHANGES',
  poDocumentNumber: string,
  poDocumentId: string,
  comments?: string,
  proposedChanges: {
    revisedRequestedDeliveryDate?: string,        // ISO YYYY-MM-DD
    revisedLines?: Array<{
      lineRef: string,                            // matches PO line's lineRef or sku
      revisedQuantity?: number,                   // > 0
      revisedUnitPrice?: number,                  // ≥ 0
      revisedDeliveryDate?: string,               // ISO YYYY-MM-DD
      comments?: string,
    }>,
  },
}

// REJECT — supplier declines the PO.
{
  mode: 'REJECT',
  poDocumentNumber: string,
  poDocumentId: string,
  comments?: string,
}
```

**Auto-link on ORDER_CONFIRMATION publish.** Because every OC body carries `poDocumentId`, the `POST /documents` route automatically creates the `ACKNOWLEDGES → PO` link in the same response. If that auto-link step encounters an issue (PO not found, duplicate, etc.), the OC is still published and the response includes a `linkWarning` field with the rejection detail; the caller can retry the link separately.

**201** for ORDER_CONFIRMATION may include `linkWarning`:

```json
{
  "documentId": "cuid_...",
  "versionId": "cuid_...",
  "documentNumber": "ORDER_CONFIRMATION-000001",
  "linkWarning": { "kind": "...", "detail": { ... } }   // present only if auto-link failed
}
```

**Proposed changes are advisory.** The OC body never mutates the PO. If the buyer wants to materialise the supplier's `ACCEPT_WITH_CHANGES` amendments, the buyer must issue a `PO_CHANGE` document (PHASES.md §2.2 / Task #8). This keeps the PO's body single-sourced through PO versions only.

**201**

```json
{
  "documentId": "cuid_...",
  "versionId": "cuid_...",
  "documentNumber": "PO-000001"
}
```

**400** errors: `validation`, `unknown_document_type`, `publish_rejected`. The `reason.kind` may be:

- `guard` — relationship missing/inactive, doc type not enabled, SUMMARY mode without `summaryInvoicingEnabled`
- `body_schema` — body fails Zod validation
- `repository` — DB-level rejection (e.g. duplicate document number)

---

### `GET /documents/:id`

Fetch a document with its versions, links, audit log, and attachments.

**200**

```json
{
  "id": "...",
  "documentType": "PO",
  "documentNumber": "PO-000001",
  "issuerOrgId": "...",
  "recipientOrgId": "...",
  "tradingRelationshipId": "...",
  "currentVersionId": "...",
  "status": "ISSUED",
  "createdAt": "...",
  "updatedAt": "...",
  "versions": [ { "versionNumber": 1, "body": {...}, "createdAt": "...", "createdById": "...", "changeReason": "created" } ],
  "outgoingLinks": [ { "linkType": "...", "fromDocumentId": "...", "toDocumentId": "..." } ],
  "incomingLinks": [ ... ],
  "auditLog": [ { "action": "CREATED", "actorUserId": "...", "actorOrgId": "...", "occurredAt": "...", "payload": {...} } ],
  "attachments": [ { "id": "...", "filename": "...", "mimeType": "...", "sizeBytes": 1234, "sha256": "..." } ]
}
```

**404** errors: `not_found`.

---

### `POST /documents/:id/supersede`

Append a new immutable version. Audit log gets `SUPERSEDED`.

**Body**
| Field | Type | Required |
|---|---|---|
| `body` | object | ✅ — must validate against the doc type's Zod schema |
| `changeReason` | string | optional |

**200**

```json
{ "versionId": "...", "versionNumber": 2 }
```

**400** errors: `validation`, `supersede_rejected` (with `reason.kind` ∈ `body_schema`, `repository`).
**404** errors: `not_found`.

---

### `POST /documents/:id/transition`

Run the document type's state machine to move the document from one status to another.

**Body**
| Field | Type | Required |
|---|---|---|
| `fromStatus` | string | ✅ |
| `toStatus` | string | ✅ |

**200**

```json
{ "nextStatus": "ISSUED" }
```

**400** errors: `validation`, `unknown_document_type`, `transition_rejected`. The `reason.kind` may be:

- `state_machine` — sub-`reason.kind`: `unknown_source_state`, `no_such_transition`, `wrong_role`, `wrong_actor_side`, `guard_rejected`
- `repository` — sub-`reason.kind`: `document_not_found`, `status_mismatch` (optimistic-concurrency loss)

---

### `POST /documents/:id/links`

Add a typed link to another document. The `(fromType, toType, linkType)` triple must be in the link registry; `(fromDocumentId, toDocumentId, linkType)` is unique at the DB level.

**Body**
| Field | Type | Required |
|---|---|---|
| `toDocumentId` | cuid | ✅ |
| `toDocumentType` | string | ✅ |
| `linkType` | string | ✅ |

**201**

```json
{ "linkId": "..." }
```

**400** errors: `validation`, `link_rejected`. The `reason.kind` may be:

- `unknown_link_rule` — triple not registered
- `repository` with `kind: "duplicate_link"` — same triple already exists (the no-double-billing guard)
- `repository` with `kind: "missing_link_target"` — `toDocumentId` doesn't exist

**404** errors: `not_found` (on the _from_ document).

---

### `POST /documents/:id/attachments`

Upload bytes via base64. SHA-256 computed and stored; audit log gets `ATTACHMENT_ADDED`.

**Body**
| Field | Type | Required |
|---|---|---|
| `filename` | string | ✅ |
| `mimeType` | string | ✅ |
| `bytesBase64` | string (base64) | ✅ |

**201**

```json
{
  "id": "cuid_...",
  "storageKey": "docs/<documentId>/<sha256>-<filename>",
  "filename": "...",
  "mimeType": "...",
  "sizeBytes": 1234,
  "sha256": "..."
}
```

**Body size limit:** Express JSON limit is 20 MB.

---

### `GET /attachments/:id`

Stream the bytes back. SHA-256 verified before sending; mismatch surfaces as `404 { "error": "sha256_mismatch" }`.

**200** — `Content-Type` echoes the upload's `mimeType`; `Content-Disposition: attachment; filename="..."`.

**404** errors: `attachment_not_found`, `sha256_mismatch`, `storage_error`.

---

## State machine reference

### `GENERIC_DOCUMENT`

Initial: `PUBLISHED`. Mostly terminal; admins can `CANCELLED`.

### `PO` (PHASES.md §2.1)

| from             | to               | role                             | side      |
| ---------------- | ---------------- | -------------------------------- | --------- |
| `DRAFT`          | `ISSUED`         | `BUYER_ADMIN`/`BUYER_USER`       | issuer    |
| `DRAFT`          | `CANCELLED`      | `BUYER_ADMIN`                    | issuer    |
| `DRAFT`          | `CHANGED`        | `BUYER_ADMIN`                    | issuer    |
| `ISSUED`         | `ACKNOWLEDGED`   | `SUPPLIER_USER`/`SUPPLIER_ADMIN` | recipient |
| `ISSUED`         | `CANCELLED`      | `BUYER_ADMIN`                    | issuer    |
| `ISSUED`         | `CHANGED`        | `BUYER_ADMIN`                    | issuer    |
| `ACKNOWLEDGED`   | `IN_FULFILLMENT` | `BUYER_ADMIN`/`BUYER_USER`       | issuer    |
| `ACKNOWLEDGED`   | `CANCELLED`      | `BUYER_ADMIN`                    | issuer    |
| `ACKNOWLEDGED`   | `CHANGED`        | `BUYER_ADMIN`                    | issuer    |
| `IN_FULFILLMENT` | `CLOSED`         | `BUYER_ADMIN`/`BUYER_USER`       | issuer    |
| `IN_FULFILLMENT` | `CANCELLED`      | `BUYER_ADMIN`                    | issuer    |
| `IN_FULFILLMENT` | `CHANGED`        | `BUYER_ADMIN`                    | issuer    |

`CLOSED`, `CANCELLED`, `CHANGED` are terminal.

**Precondition for `→ CHANGED`** — an `ACCEPTED_BY_SUPPLIER` PO_CHANGE must `SUPERSEDES`-link this PO. Without one, the route rejects with `reason.kind: "precondition_failed"` / `detail.kind: "no_accepted_po_change"`.

### `ORDER_CONFIRMATION` (PHASES.md §2.3)

| from     | to                  | role                             | side      |
| -------- | ------------------- | -------------------------------- | --------- |
| `DRAFT`  | `ISSUED`            | `SUPPLIER_USER`/`SUPPLIER_ADMIN` | issuer    |
| `ISSUED` | `ACCEPTED_BY_BUYER` | `BUYER_USER`/`BUYER_ADMIN`       | recipient |
| `ISSUED` | `REJECTED_BY_BUYER` | `BUYER_USER`/`BUYER_ADMIN`       | recipient |

`ACCEPTED_BY_BUYER`, `REJECTED_BY_BUYER` are terminal. Buyer transitions are most meaningful for `ACCEPT_WITH_CHANGES` mode (signals intent to issue a PO_CHANGE).

### `PO_CHANGE` (PHASES.md §2.2)

| from     | to                     | role                             | side      |
| -------- | ---------------------- | -------------------------------- | --------- |
| `DRAFT`  | `ISSUED`               | `BUYER_ADMIN`/`BUYER_USER`       | issuer    |
| `ISSUED` | `ACCEPTED_BY_SUPPLIER` | `SUPPLIER_USER`/`SUPPLIER_ADMIN` | recipient |
| `ISSUED` | `REJECTED_BY_SUPPLIER` | `SUPPLIER_USER`/`SUPPLIER_ADMIN` | recipient |

`ACCEPTED_BY_SUPPLIER`, `REJECTED_BY_SUPPLIER` are terminal.

---

## Link registry reference

| from → to                               | linkType       | inboundCardinality | outboundCardinality | Notes                              |
| --------------------------------------- | -------------- | ------------------ | ------------------- | ---------------------------------- |
| `GENERIC_DOCUMENT` → `GENERIC_DOCUMENT` | `RESPONDS_TO`  | many               | one                 |                                    |
| `ORDER_CONFIRMATION` → `PO`             | `ACKNOWLEDGES` | one                | one                 |                                    |
| `PO_CHANGE` → `PO`                      | `SUPERSEDES`   | one                | one                 | Precondition for PO `→ CHANGED`    |
| `PO` → `PO`                             | `SUPERSEDES`   | one                | one                 | Reserved for cross-PO supersession |

---

**Last updated:** 2026-06-19 · Phase 2.1 (PO), 2.2 (PO_CHANGE), and 2.3 (ORDER_CONFIRMATION) complete.
