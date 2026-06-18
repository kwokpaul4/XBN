# XBN — Troubleshooting

Companion to [`OPERATIONS.md`](./OPERATIONS.md). Lists the failure modes you'll most commonly hit, what they mean, and how to recover.

---

## Stack startup

### `docker compose up -d` says "command not found: docker"

Docker isn't installed or your shell hasn't picked it up. On macOS with Colima:

```bash
brew install colima docker docker-compose
colima start
# In a new shell:
docker --version
docker compose version
```

If `docker compose` (subcommand) isn't recognised but `docker-compose` (hyphen) is, your CLI plugins directory needs the binary symlinked:

```bash
mkdir -p "$HOME/.docker/cli-plugins"
ln -sf /opt/homebrew/Cellar/docker-compose/*/lib/docker/cli-plugins/docker-compose \
       "$HOME/.docker/cli-plugins/docker-compose"
docker compose version
```

### `docker compose ps` shows containers but `xbn-postgres` is "unhealthy"

Postgres takes a few seconds to bootstrap on first run. Wait 10s and re-check. If it's still unhealthy:

```bash
docker compose logs xbn-postgres | tail -50
```

Common causes: port `:5432` already in use by a host Postgres, or a stale `postgres-data` volume from a different version. To wipe and restart:

```bash
docker compose down
docker volume rm xbn_postgres-data
docker compose up -d
DATABASE_URL="postgresql://xbn:xbn_dev@localhost:5432/xbn" \
  pnpm --filter @xbn/db exec prisma migrate deploy
```

### MailHog logs say "platform mismatch"

MailHog publishes only `linux/amd64`; on Apple Silicon Docker emulates it. This is a perf hit, not a correctness issue — Phase 1 doesn't use MailHog yet so leave it.

---

## API server

### `pnpm --filter @xbn/api dev` exits immediately with `ECONNREFUSED 127.0.0.1:5432`

Postgres isn't reachable. Run `docker compose ps` and confirm `xbn-postgres` is up + healthy. If it just started, give it 5–10s.

### `pnpm --filter @xbn/api dev` says `relation "users" does not exist`

You haven't applied the migration. From the repo root:

```bash
DATABASE_URL="postgresql://xbn:xbn_dev@localhost:5432/xbn" \
  pnpm --filter @xbn/db exec prisma migrate deploy
```

### Port `:3000` already in use

Either you have another API instance running, or another project owns the port. Find it:

```bash
lsof -iTCP:3000 -sTCP:LISTEN
```

Kill the offender or set `API_PORT=3001 pnpm --filter @xbn/api dev`.

---

## Auth flows

### Register returns `400 { "error": "email_taken" }` for an email I never registered

You did register it earlier in a previous run that left rows in Postgres. The DB volume persists across `docker compose stop`. Either pick a different email, or wipe the user (and everything else):

```bash
docker exec xbn-postgres psql -U xbn -d xbn -c "
  TRUNCATE TABLE
    attachments, document_audit_log, document_links, document_versions,
    documents, relationship_invitations, trading_relationships,
    org_identifiers, user_org_memberships, user_sessions, orgs, users,
    notification_outbox
  RESTART IDENTITY CASCADE;
"
```

### Login returns `401 { "error": "email_not_verified" }`

You registered but never called `/auth/verify-email` with the token from the registration response. Re-issue verification by registering with a new email, or run a quick SQL:

```bash
docker exec xbn-postgres psql -U xbn -d xbn -c "
  UPDATE users SET email_verified_at = NOW() WHERE email = 'alice@example.com';
"
```

### Login returns `401 { "error": "invalid_credentials" }` and the password is correct

- Verify the email is exactly the one you registered with (it's stored lower-cased and trimmed).
- Argon2id verification is intentionally slow (~50 ms); not a timing issue, but `curl --max-time 30` is needed for the very first hit on a cold container.
- Make sure your `Content-Type: application/json` header is set; without it Express won't parse the body and the email/password will be undefined.

### Subsequent calls after `/auth/login` return `401 { "error": "unauthenticated" }`

The session cookie isn't being sent. With curl:

```bash
# Login with -c <file> to save cookies, then -b <file> to send them.
curl -X POST http://localhost:3000/auth/login -H "Content-Type: application/json" \
  -c cookies.txt -d '{"email":"...","password":"..."}'
curl http://localhost:3000/me -b cookies.txt
```

In a browser context, fetches must use `credentials: "include"`. The portal's `api()` wrapper does this already.

### After password reset, my old session still works

It shouldn't. `completePasswordReset` calls `invalidateAllUserSessions`. If you see this, it's a bug — please report. To verify the expected behaviour:

```bash
# Old session token should now return 401:
curl http://localhost:3000/me -b old-cookies.txt
# → 401 { "error": "unauthenticated", "reason": "invalid" }
```

---

## Org / membership

### `POST /network/orgs` returns `401 { "error": "unauthenticated" }`

You're not sending the session cookie. See [auth section](#subsequent-calls-after-authlogin-return-401--error-unauthenticated-).

### `GET /network/relationships` returns `403 { "error": "no_active_membership" }`

You haven't sent `x-active-org` and the user has no memberships. Create an org first (`POST /network/orgs`) — that automatically adds a membership.

### `POST /network/orgs` rejects with a Zod issue about `bindAsRole`

`bindAsRole` is required and must match the OrgRole enum exactly: `BUYER_USER`, `BUYER_ADMIN`, `SUPPLIER_USER`, `SUPPLIER_ADMIN`, or `NETWORK_ADMIN`.

### Org switcher in the portal shows nothing in the dropdown

The signed-in user has zero memberships. Go to `/admin` and create an org, then refresh.

---

## Trading relationships

### `POST /network/relationships` returns `409 { "error": "already_exists" }`

A relationship with the same `(buyerOrgId, supplierOrgId)` pair already exists. The DB schema enforces one per pair. To inspect:

```bash
curl http://localhost:3000/network/relationships \
  -H "x-active-org: $BUYER_ORG_ID" -b cookies.txt | python3 -m json.tool
```

If you want to swap roles (B→A instead of A→B), terminate the original first via SQL (no API yet):

```bash
docker exec xbn-postgres psql -U xbn -d xbn -c "
  UPDATE trading_relationships
     SET status = 'TERMINATED', terminated_at = NOW()
   WHERE buyer_org_id = '...' AND supplier_org_id = '...';
"
```

### Publishing a document returns `400 { "error": "publish_rejected", "reason": { "kind": "guard" } }`

The trading-relationship guard rejected it. Sub-causes:

| `reason.detail.kind` | Meaning | Fix |
|---|---|---|
| `no_relationship` | No relationship between issuer and recipient | Create one with `POST /network/relationships` |
| `relationship_inactive` | Status is `PENDING_INVITATION`, `SUSPENDED`, or `TERMINATED` | Activate it via `POST /network/relationships/:id/activate` |
| `document_type_not_enabled` | `documentType` not in the relationship's `enabledDocumentTypes` | Update the relationship to add the type (no HTTP route yet — SQL or recreate) |
| `summary_invoicing_not_enabled` | `invoiceMode: "SUMMARY"` but the relationship hasn't opted in | Set `summaryInvoicingEnabled: true` on the relationship |

To inspect the relationship's current config:

```bash
docker exec xbn-postgres psql -U xbn -d xbn -c "
  SELECT id, status, enabled_document_types, summary_invoicing_enabled
    FROM trading_relationships;
"
```

---

## Documents

### `400 { "error": "publish_rejected", "reason": { "kind": "body_schema", ... } }`

Body fails Zod validation. The full validation issue list is in `reason.detail.issues`. Common culprits:

- `PO`: `currency` must be exactly 3 chars (`"USD"` not `"US"`); `quantity` must be `> 0`; `unitPrice` must be `≥ 0`.
- `GENERIC_DOCUMENT`: `note` is required (string); `metadata` is optional.

### `400 { "error": "transition_rejected" }`

| `reason.detail.kind` | Meaning |
|---|---|
| `unknown_source_state` | The current status isn't in the type's state machine config (shouldn't happen normally) |
| `no_such_transition` | No edge `(fromStatus → toStatus)` declared |
| `wrong_role` | Caller's active-org role isn't allowed for this edge |
| `wrong_actor_side` | Caller's org is on the wrong side of the relationship (e.g. supplier trying to issue a PO transition) |
| `guard_rejected` | Optional guard predicate returned false (no current document type uses guards) |
| `repository` with `kind: "status_mismatch"` | Optimistic concurrency lost — another transition advanced the row first |

To check what state machines actually allow, see `apps/api/src/routes/documents.ts` or [`API_REFERENCE.md`](./API_REFERENCE.md#state-machine-reference).

### `400 { "error": "link_rejected", "reason": { "kind": "unknown_link_rule" } }`

The `(fromType, toType, linkType)` triple isn't registered. The current registry is small (see [`API_REFERENCE.md`](./API_REFERENCE.md#link-registry-reference)) — most types and link types arrive in Phase 2/3.

### `400 { "error": "link_rejected", "reason": { "kind": "repository", "detail": { "kind": "duplicate_link" } } }`

You're trying to add a `(fromDocumentId, toDocumentId, linkType)` triple that already exists. This is the **no-double-billing guard**. It's intentional — relevant for SUMMARY invoicing in Phase 2.6 to prevent invoicing the same source document twice.

### Attachment upload returns `413` or hangs

The Express JSON body limit is 20 MB. Check the file size; large uploads need streaming, which is Phase 5 scope. For now, keep attachments small.

### `GET /attachments/:id` returns `404 { "error": "sha256_mismatch" }`

The bytes in MinIO don't match the SHA-256 recorded at upload time. Either bit-rot (rare in a healthy MinIO) or someone swapped the object. Inspect:

```bash
docker exec xbn-minio mc ls local/xbn-attachments
docker exec xbn-minio mc stat local/xbn-attachments/<storageKey>
```

You probably want to delete the bad attachment and re-upload:

```bash
curl -X DELETE http://localhost:3000/attachments/$ATTACHMENT_ID -b cookies.txt
# (Note: no DELETE route yet — drop the row via SQL and the object via mc rm.)
```

---

## Database & migrations

### Prisma migrate says "Drift detected"

You changed the schema by hand. Either revert your changes or run `prisma migrate dev --create-only` to generate a new migration capturing them.

### Prisma client has stale types after a schema change

Regenerate:

```bash
DATABASE_URL="postgresql://xbn:xbn_dev@localhost:5432/xbn" \
  pnpm --filter @xbn/db exec prisma generate
```

Then restart the dev server (`Ctrl-C` and re-run `pnpm --filter @xbn/api dev`).

### Need to wipe data but keep schema

```bash
docker exec xbn-postgres psql -U xbn -d xbn -c "
  TRUNCATE TABLE
    attachments, document_audit_log, document_links, document_versions,
    documents, relationship_invitations, trading_relationships,
    org_identifiers, user_org_memberships, user_sessions, orgs, users,
    notification_outbox
  RESTART IDENTITY CASCADE;
"
```

This is exactly what the integration tests do between cases.

### Need to inspect data quickly

```bash
docker exec -it xbn-postgres psql -U xbn -d xbn
# \dt   list tables
# \d documents   describe one
# SELECT * FROM users;
```

Or use Prisma Studio for a GUI:

```bash
DATABASE_URL="postgresql://xbn:xbn_dev@localhost:5432/xbn" \
  pnpm --filter @xbn/db exec prisma studio
# Opens a browser tab against the local DB.
```

---

## Tests

### Tests fail with "Failed to deserialize column of type 'void'"

You're running an older `numbering-prisma.ts` that used `$queryRaw` for `pg_advisory_xact_lock` (which returns void). The fix is on `main`: it uses `$executeRaw`. Pull the latest, re-run.

### Integration tests time out

Most likely the local Postgres or MinIO isn't running, or a previous test run left long transactions hanging. Try:

```bash
docker compose restart xbn-postgres
docker compose restart xbn-minio
pnpm test
```

### `vitest run` says "No test files found, exiting with code 1"

A workspace has no tests yet. The fix already on main is `--passWithNoTests` in each workspace's `package.json`. If you see this, your local files are out of sync.

---

## Portal (Vite)

### `/me` calls return 404 in the portal

The Vite proxy is missing or misconfigured. `apps/web/vite.config.ts` should have:

```ts
proxy: {
  '/auth': 'http://localhost:3000',
  '/me': 'http://localhost:3000',
  '/network': 'http://localhost:3000',
  '/documents': 'http://localhost:3000',
  '/attachments': 'http://localhost:3000',
  '/health': 'http://localhost:3000',
}
```

### Logged-in but the header doesn't show the user

`useMe()` is hitting `/me` and getting back a 401. Check the API server is running and your cookie is intact (DevTools → Application → Cookies → `localhost:5173`).

### "Cannot find namespace 'JSX'"

React 19 dropped the global `JSX` namespace. Use `React.ReactElement` for component return types and ensure `import React from 'react'` is at the top of the file.

---

## Getting unstuck

If none of the above helps:

1. Run the full test suite to see what's still green:
   ```bash
   pnpm -r typecheck && pnpm lint && pnpm test
   ```
2. Check `docker compose ps` and `docker compose logs --tail 50` for each container.
3. The repo's commit history is short and well-tagged — `git log --oneline` shows what landed when. The last green commit on `main` is `ab8dbb8`.
4. Open an issue on GitHub: <https://github.com/kwokpaul4/XBN>

---

**Last updated:** 2026-06-18 · matches commit `ab8dbb8` on `main`.
