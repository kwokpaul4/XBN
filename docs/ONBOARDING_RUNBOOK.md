# XBN — Trading-Partner Onboarding Runbook

The step-by-step for bringing a new supplier (or buyer) onto XBN, from account creation through the first exchanged document.

Two paths are covered:

- **Path A — Direct** (recommended for local dev / demos / pilot customers where both sides know each other): both users self-register and a network admin wires them together.
- **Path B — Invitation** (for real onboarding at scale): the buyer issues an invitation with a token; the supplier accepts to activate the relationship.

The API-only slices call into [`OPERATIONS.md`](./OPERATIONS.md) where the exact curl commands live; this runbook is the ordered checklist.

---

## Roles you'll interact with

| Role                           | Who they are                          | What they do in onboarding                                                 |
| ------------------------------ | ------------------------------------- | -------------------------------------------------------------------------- |
| `NETWORK_ADMIN`                | XBN operator                          | Creates the `TradingRelationship` if using Path A                          |
| `BUYER_ADMIN`                  | Procurement / vendor manager at buyer | Issues invitations, configures enabled document types                      |
| `SUPPLIER_ADMIN`               | AR / customer manager at supplier     | Accepts invitations, configures the supplier's identity in buyer namespace |
| `BUYER_USER` / `SUPPLIER_USER` | Operational users                     | Publish and transition documents once the relationship is active           |

---

## Path A — Direct onboarding (recommended for dev + pilot)

### 1. Prerequisites

- Local stack running: `docker compose up -d`, `pnpm --filter @xbn/api dev`, `pnpm --filter @xbn/web dev`.
- Postgres reachable, MinIO reachable, MailHog running (for local reset tokens).

### 2. Register the buyer user

Portal (`/register`) or API (`POST /auth/register`), then verify the email. See [`OPERATIONS.md` §3](./OPERATIONS.md).

**Verification note:** in local dev the token comes back in the response body. In production it would be emailed via the pg-boss + SMTP consumer (Phase 5 wire-up); until then the token exposure is intentional and confined to `NODE_ENV != production`.

### 3. Buyer creates their org

Portal `/admin` or `POST /network/orgs` with `orgType: BUYER` and `bindAsRole: BUYER_ADMIN`. Capture the returned `org.id` — you'll need it in step 6.

### 4. Register the supplier user

Same as step 2, but with a different email address.

### 5. Supplier creates their org

Portal `/admin` or `POST /network/orgs` with `orgType: SUPPLIER` and `bindAsRole: SUPPLIER_ADMIN`. Capture the supplier's `org.id`.

### 6. Establish the trading relationship

The buyer admin calls `POST /network/relationships` with both org ids and the initial set of enabled document types:

```json
{
  "buyerOrgId": "cuid_buyer",
  "supplierOrgId": "cuid_supplier",
  "status": "ACTIVE",
  "enabledDocumentTypes": [
    "PO",
    "ORDER_CONFIRMATION",
    "PO_CHANGE",
    "ASN",
    "GOODS_RECEIPT",
    "INVOICE",
    "CREDIT_MEMO",
    "REMITTANCE_ADVICE"
  ],
  "defaultCurrency": "USD",
  "summaryInvoicingEnabled": false
}
```

**Which types to enable at first.** For an indirect-procurement pilot: PO / OC / PO_CHANGE / ASN / GR / INVOICE / CREDIT_MEMO / REMITTANCE_ADVICE. For an SCC pilot: SCHEDULING_AGREEMENT + FORECAST_PUBLISH + FORECAST_COMMIT + SA_RELEASE_FORECAST + SA_RELEASE_JIT + ASN. Start narrow and add types with a follow-up `POST /network/relationships/:id/enable-document-types` when the parties are ready — you don't have to enable everything on day one.

**Currency + summary invoicing.** `defaultCurrency` flows through as a hint on new PO / INVOICE forms; it doesn't force line-level currency. `summaryInvoicingEnabled` gates whether the supplier can issue SUMMARY-mode invoices (PHASES.md §2.6) — leave `false` until both sides are comfortable with the no-double-billing guarantees.

### 7. Verify the relationship

Both sides check `/buyer/counterparties` (or `/supplier/counterparties`) — the counterparty should appear in the list with `ourRole` correctly set and `enabledDocumentTypes` matching what step 6 set.

### 8. Smoke test — exchange one document

Buyer publishes a PO from `/buyer/po/new`. Supplier sees it in `/supplier/po`. Supplier acknowledges. Both sides can now see the `ACKNOWLEDGES` link in the graph on the PO detail page.

If this works, the relationship is production-quality. **You've onboarded a partner.**

---

## Path B — Invitation-driven onboarding (for real customer intake)

### 1. Buyer admin issues an invitation

Portal `/admin` (once the UI ships) or `POST /network/invitations`:

```json
{
  "buyerOrgId": "cuid_buyer",
  "invitedEmail": "ap@newvendor.example",
  "invitedOrgName": "New Vendor Ltd"
}
```

Response includes an opaque `token` (single-use, 30-day TTL). Deliver it to the supplier out of band (email, portal share, phone) — the pg-boss + SMTP consumer will eventually make this an email, but the manual delivery path always works.

### 2. Supplier registers + creates their org

Same as Path A steps 4–5. The supplier admin ends up with a `SUPPLIER_ADMIN` membership on their new org.

### 3. Supplier accepts the invitation

Portal `/admin` (once the UI ships) or `POST /network/invitations/accept`:

```json
{ "token": "opaque-token-from-step-1" }
```

The substrate:

- Looks up the invitation by token; validates it is `pending` and not expired.
- Creates the `TradingRelationship(buyer, supplier, status: ACTIVE)`.
- Marks the invitation `accepted` (or `declined` if the supplier rejects).

The supplier admin's active org is set to the supplier org they just created.

### 4. Buyer + supplier configure enabled types

**Neither side is done yet.** By default the relationship activates with an empty `enabledDocumentTypes` — this is deliberate so that neither side accidentally starts receiving documents they haven't provisioned for. The buyer admin updates the enabled set as in Path A step 6 (the current API accepts a full replacement; a diff endpoint is Phase 4.2 pending work per [`OPERATIONS.md` §19](./OPERATIONS.md)).

### 5. Verify + smoke test

Same as Path A steps 7 and 8.

---

## Post-onboarding checklist

| Item                                            | Where                                                | When                                                                                                                   |
| ----------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Confirm counterparty visible                    | `/buyer/counterparties` / `/supplier/counterparties` | Immediately after step 6 / step 4                                                                                      |
| Set the buyer's internal supplier ID            | `POST /network/orgs/:id/identifiers` (add a record)  | Before the first PO, so the ID flows through to invoices                                                               |
| Configure payment terms + default Incoterms     | On the relationship, via update endpoint             | Before the first PO                                                                                                    |
| Decide `summaryInvoicingEnabled`                | On the relationship                                  | Only once both sides know they want it (PHASES.md §2.6)                                                                |
| Wire the notification bell for real users       | `/buyer/inbox` / `/supplier/inbox`                   | Once real activity begins — the `NotificationBell` is on every page and polls every 30 s                               |
| Verify the audit-log explorer sees the activity | `GET /network/audit-log?documentId=...`              | Any time; it's read-only. NETWORK_ADMIN sees everything, other roles see only documents their active org is a party to |

---

## Troubleshooting the first document

If the first publish (step 8) fails, XBN gives you a typed rejection to work from:

| Status | `error`                       | `reason.kind`                         | What to check                                                                                                        |
| ------ | ----------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 400    | `publish_rejected`            | `guard` / `document_type_not_enabled` | The relationship's `enabledDocumentTypes` doesn't include the type you tried to publish — add it in step 6/4         |
| 400    | `publish_rejected`            | `guard` / `no_active_relationship`    | The relationship isn't `ACTIVE` — check `/network/counterparties`; if status is `PENDING_INVITATION` re-run Path B   |
| 400    | `publish_rejected`            | `body_schema`                         | The body failed the Zod schema — the `issues` array names the field                                                  |
| 400    | `transition_rejected`         | `wrong_role` / `wrong_actor_side`     | Wrong org active or wrong role — check the org switcher; NETWORK_ADMIN can't transition documents on parties' behalf |
| 403    | `no_membership_in_active_org` | —                                     | The `x-active-org` header names an org the user isn't a member of — set it via the org switcher                      |

For more, see [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md).

---

## Deprovisioning

Suspending or terminating a relationship stops document publish immediately (the trading-relationship guard fails). The service-layer functions exist (`suspendRelationship`, `terminateRelationship`); the HTTP routes to invoke them are pending Phase 4.2 backend work per [`OPERATIONS.md` §19](./OPERATIONS.md). Until they land, use a Postgres update or drive the service layer directly.

---

**Last updated:** 2026-07-02 · Phases 1.1–1.6, 2.1–2.8, 3.0–3.2, 4.1–4.5 complete (M1–M4 reached).
