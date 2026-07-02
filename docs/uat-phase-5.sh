#!/usr/bin/env bash
#
# XBN Phase 5 UAT — drives the production-readiness surface and verifies
# every PHASES.md §5 contract in scope for M5.
#
# Scope (in scope for M5 / this script):
#   #28 §5.1 Observability — /health liveness, /ready readiness,
#                            x-request-id echo/generate, structured logs,
#                            /network/audit-log scoped to active org
#   #29 §5.2 Testing breadth — smoke on the property-based test file
#                              existing (the vitest suite is the real gate)
#   #30 §5.3 CI/CD & release — verifies CI + Docker artifacts exist on disk
#   #31 §5.4 Documentation — verifies the promised docs exist on disk
#
# Usage:
#   ./docs/uat-phase-5.sh                  # full UAT
#   ./docs/uat-phase-5.sh --api=URL        # override API base URL
#
# Prereqs:
#   - docker compose up -d  (Postgres + MinIO healthy)
#   - pnpm --filter @xbn/api dev  (API listening on :3000)
#   - jq installed
#
# Exit codes:
#   0  all assertions passed
#   1  setup failed
#   2  one or more assertions failed (stops at first failure)

set -euo pipefail

API="${API:-http://localhost:3000}"
for arg in "$@"; do
  case "$arg" in
    --api=*) API="${arg#--api=}" ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
  esac
done

PASS_COUNT=0
FAIL_COUNT=0
COOKIE_DIR=$(mktemp -d)
trap 'rm -rf "$COOKIE_DIR"' EXIT
SUFFIX="$(date +%s)-$$-p5"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

GREEN='\033[0;32m'; RED='\033[0;31m'; DIM='\033[2m'; BOLD='\033[1m'; NC='\033[0m'

section() { printf '\n%b%s%b\n' "$BOLD" "----------------------------------------------------------------------" "$NC"; printf '%b %s%b\n' "$BOLD" "$1" "$NC"; printf '%b%s%b\n' "$BOLD" "----------------------------------------------------------------------" "$NC"; }
hdr()     { printf '\n%b%s%b\n' "$BOLD" "======================================================================" "$NC"; printf '%b %s%b\n' "$BOLD" "$1" "$NC"; printf '%b%s%b\n' "$BOLD" "======================================================================" "$NC"; }
pass() { printf '  %b✓%b %s\n' "$GREEN" "$NC" "$1"; PASS_COUNT=$((PASS_COUNT+1)); }
fail() {
  printf '  %b✗%b %s\n' "$RED" "$NC" "$1"
  if [[ -n "${2:-}" ]]; then printf '    %bdetail:%b %s\n' "$DIM" "$NC" "$2"; fi
  FAIL_COUNT=$((FAIL_COUNT+1)); exit 2
}
info() { printf '  %s\n' "$1"; }

assert_eq() {
  local label="$1" body="$2" path="$3" expected="$4"
  local actual; actual=$(printf '%s' "$body" | jq -r "$path" 2>/dev/null || echo '__JQ_ERR__')
  if [[ "$actual" == "$expected" ]]; then pass "$label"; else fail "$label — expected '$expected', got '$actual'" "$body"; fi
}

assert_file() {
  local label="$1" path="$2"
  if [[ -f "$REPO_ROOT/$path" ]]; then
    pass "$label"
  else
    fail "$label — expected $path to exist"
  fi
}

post_json() {
  local url="$1" cookie="$2" org="$3" body="$4"
  local args=(-s -X POST "$url" -H 'Content-Type: application/json' -b "$cookie" --data-raw "$body")
  if [[ -n "$org" ]]; then args+=(-H "x-active-org: $org"); fi
  curl "${args[@]}"
}

get_json() {
  local url="$1" cookie="$2" org="$3"
  local args=(-s "$url" -b "$cookie")
  if [[ -n "$org" ]]; then args+=(-H "x-active-org: $org"); fi
  curl "${args[@]}"
}

# ----------------------------------------------------------------------
# Preflight
# ----------------------------------------------------------------------

hdr "XBN Phase 5 UAT — production readiness (§5.1–§5.4)"

command -v jq >/dev/null 2>&1 || { echo "✗ jq is required (brew install jq)" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "✗ curl is required." >&2; exit 1; }

info "Probing API at $API ..."
HEALTH_STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$API/health" || echo 'fail')
if [[ "$HEALTH_STATUS" != "200" ]]; then
  echo "✗ API not reachable at $API/health (status: $HEALTH_STATUS)" >&2
  echo "  Start it with: pnpm --filter @xbn/api dev" >&2
  exit 1
fi

# ----------------------------------------------------------------------
# Scenario 1 — §5.1 health + readiness probes
# ----------------------------------------------------------------------

section "Scenario 1 — §5.1 health + readiness probes"

# 1.1 — /health returns ok + service tag
H=$(curl -s "$API/health")
assert_eq "[1.1] /health responds ok:true"          "$H" '.ok' 'true'
assert_eq "[1.1] /health names the service"          "$H" '.service' 'xbn-api'

# 1.2 — /ready responds ok + db:'up' when Postgres is reachable
R=$(curl -s -w '\n%{http_code}' "$API/ready")
READY_STATUS=$(echo "$R" | tail -1)
READY_BODY=$(echo "$R" | sed '$d')
assert_eq "[1.2] /ready HTTP 200 (Postgres reachable)" "$(jq -n --arg s "$READY_STATUS" '{status:$s|tonumber}')" '.status' '200'
assert_eq "[1.2] /ready returns db:'up'"                "$READY_BODY" '.db' 'up'

# ----------------------------------------------------------------------
# Scenario 2 — §5.1 x-request-id correlation
# ----------------------------------------------------------------------

section "Scenario 2 — §5.1 x-request-id correlation"

# 2.1 — API generates a UUIDv4-shaped request id when the caller doesn't
# provide one.
GEN_ID=$(curl -s -D - "$API/health" -o /dev/null | awk 'tolower($1)=="x-request-id:" {print $2}' | tr -d '\r')
if [[ -n "$GEN_ID" && "$GEN_ID" =~ ^[0-9a-f-]{20,}$ ]]; then
  pass "[2.1] response carries a generated x-request-id ($GEN_ID)"
else
  fail "[2.1] expected a UUID-shaped x-request-id header, got '$GEN_ID'"
fi

# 2.2 — a caller-provided id is echoed verbatim.
ECHO_ID=$(curl -s -D - "$API/health" -H "x-request-id: uat-p5-echo-42" -o /dev/null | awk 'tolower($1)=="x-request-id:" {print $2}' | tr -d '\r')
if [[ "$ECHO_ID" == "uat-p5-echo-42" ]]; then
  pass "[2.2] caller-provided x-request-id is echoed verbatim"
else
  fail "[2.2] expected 'uat-p5-echo-42', got '$ECHO_ID'"
fi

# ----------------------------------------------------------------------
# Scenario 3 — §5.1 /network/audit-log scoping
# ----------------------------------------------------------------------

section "Scenario 3 — §5.1 audit-log explorer scoping"

register_and_login() {
  local email="$1" cookie="$2"
  local reg; reg=$(curl -s -X POST "$API/auth/register" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"correcthorse\"}")
  local user_id token
  user_id=$(echo "$reg" | jq -r .userId)
  token=$(echo "$reg" | jq -r .verificationToken)
  [[ "$user_id" == "null" || "$token" == "null" ]] && fail "register failed for $email" "$reg"
  curl -s -X POST "$API/auth/verify-email" -H 'Content-Type: application/json' -d "{\"token\":\"$token\"}" >/dev/null
  curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' -c "$cookie" \
    -d "{\"email\":\"$email\",\"password\":\"correcthorse\"}" >/dev/null
}

create_org() {
  local cookie="$1" name="$2" type="$3"
  local role="BUYER_ADMIN"; [[ "$type" == "SUPPLIER" ]] && role="SUPPLIER_ADMIN"
  local resp; resp=$(curl -s -X POST "$API/network/orgs" -H 'Content-Type: application/json' -b "$cookie" \
    -d "{\"legalName\":\"$name\",\"displayName\":\"$name\",\"orgType\":\"$type\",\"bindAsRole\":\"$role\"}")
  local oid; oid=$(echo "$resp" | jq -r .org.id)
  [[ "$oid" == "null" ]] && fail "create_org failed for $name" "$resp"
  echo "$oid"
}

BUYER_COOKIES="$COOKIE_DIR/buyer.cookies"
SUPPLIER_COOKIES="$COOKIE_DIR/supplier.cookies"
OUTSIDER_COOKIES="$COOKIE_DIR/outsider.cookies"
register_and_login "buyer-$SUFFIX@uat.local" "$BUYER_COOKIES"
register_and_login "supplier-$SUFFIX@uat.local" "$SUPPLIER_COOKIES"
register_and_login "outsider-$SUFFIX@uat.local" "$OUTSIDER_COOKIES"

BUYER_ORG=$(create_org "$BUYER_COOKIES" "UAT Phase5 Buyer" "BUYER")
SUPPLIER_ORG=$(create_org "$SUPPLIER_COOKIES" "UAT Phase5 Supplier" "SUPPLIER")
OUTSIDER_ORG=$(create_org "$OUTSIDER_COOKIES" "UAT Phase5 Outsider" "BUYER")

post_json "$API/network/relationships" "$BUYER_COOKIES" "$BUYER_ORG" "$(cat <<JSON
{
  "buyerOrgId":"$BUYER_ORG","supplierOrgId":"$SUPPLIER_ORG","status":"ACTIVE",
  "enabledDocumentTypes":["PO"],"defaultCurrency":"USD"
}
JSON
)" >/dev/null

# Publish a PO so we have an audit trail to inspect.
PO_RESP=$(post_json "$API/documents" "$BUYER_COOKIES" "$BUYER_ORG" "$(cat <<JSON
{
  "documentType":"PO","recipientOrgId":"$SUPPLIER_ORG",
  "body":{
    "currency":"USD","paymentTermsRef":"NET-30","requestedDeliveryDate":"2026-07-15",
    "shipTo":{"name":"Plant","line1":"1 Way","city":"City","countryCode":"US"},
    "billTo":{"name":"Bill","line1":"1 Way","city":"City","countryCode":"US"},
    "lines":[{"sku":"X","description":"x","quantity":1,"unitPrice":1,"unitOfMeasure":"EA"}]
  }
}
JSON
)")
PO_ID=$(echo "$PO_RESP" | jq -r .documentId)
[[ "$PO_ID" == "null" ]] && fail "PO publish failed for audit setup" "$PO_RESP"

# 3.1 — buyer (party to the doc) sees audit entries for the PO
AUDIT_B=$(get_json "$API/network/audit-log?documentId=$PO_ID" "$BUYER_COOKIES" "$BUYER_ORG")
TOTAL=$(echo "$AUDIT_B" | jq -r '.total')
if [[ "$TOTAL" =~ ^[0-9]+$ ]] && (( TOTAL >= 1 )); then
  pass "[3.1] buyer sees ≥ 1 audit entry for the PO (total=$TOTAL)"
else
  fail "[3.1] expected audit entries for the PO, total='$TOTAL'" "$AUDIT_B"
fi
assert_eq "[3.1] every entry references the same PO document id" \
  "$AUDIT_B" '.entries | all(.documentId == "'"$PO_ID"'") | tostring' 'true'

# 3.2 — supplier (also a party) sees the same rows
AUDIT_S=$(get_json "$API/network/audit-log?documentId=$PO_ID" "$SUPPLIER_COOKIES" "$SUPPLIER_ORG")
S_TOTAL=$(echo "$AUDIT_S" | jq -r '.total')
if [[ "$S_TOTAL" =~ ^[0-9]+$ ]] && (( S_TOTAL >= 1 )); then
  pass "[3.2] supplier (recipient party) also sees the audit entries (total=$S_TOTAL)"
else
  fail "[3.2] expected supplier to see the audit rows, total='$S_TOTAL'" "$AUDIT_S"
fi

# 3.3 — outsider (unrelated org) sees zero rows for the PO
AUDIT_O=$(get_json "$API/network/audit-log?documentId=$PO_ID" "$OUTSIDER_COOKIES" "$OUTSIDER_ORG")
assert_eq "[3.3] outsider sees 0 audit rows (scoping guard works)" "$AUDIT_O" '.total' '0'

# 3.4 — action + since filters accepted without crashing (may return 0)
AUDIT_F=$(get_json "$API/network/audit-log?action=PUBLISHED&since=2026-01-01T00:00:00Z" "$BUYER_COOKIES" "$BUYER_ORG")
if echo "$AUDIT_F" | jq -e '.entries and (.total | numbers)' >/dev/null 2>&1; then
  pass "[3.4] audit-log accepts action + since filters (returns typed body)"
else
  fail "[3.4] expected .entries + .total in the response" "$AUDIT_F"
fi

# ----------------------------------------------------------------------
# Scenario 4 — §5.3 CI/CD + Docker artifacts on disk
# ----------------------------------------------------------------------

section "Scenario 4 — §5.3 CI/CD + Docker artifacts"

assert_file "[4.1] GitHub Actions CI workflow exists"     ".github/workflows/ci.yml"
assert_file "[4.2] API Dockerfile exists"                 "apps/api/Dockerfile"
assert_file "[4.3] Web portal Dockerfile exists"          "apps/web/Dockerfile"
assert_file "[4.4] Web portal nginx.conf exists"          "apps/web/nginx.conf"
assert_file "[4.5] .env.example (env reference) exists"   ".env.example"

# Sanity-check the CI workflow names the four gates we depend on.
if grep -q "prisma migrate deploy" "$REPO_ROOT/.github/workflows/ci.yml"; then
  pass "[4.6] CI workflow runs prisma migrate"
else
  fail "[4.6] CI workflow missing prisma migrate step"
fi
if grep -qE "pnpm (-r )?typecheck" "$REPO_ROOT/.github/workflows/ci.yml"; then
  pass "[4.7] CI workflow runs typecheck"
else
  fail "[4.7] CI workflow missing typecheck step"
fi

# ----------------------------------------------------------------------
# Scenario 5 — §5.4 documentation surface
# ----------------------------------------------------------------------

section "Scenario 5 — §5.4 documentation surface"

assert_file "[5.1] DOCUMENT_TYPE_CATALOG.md exists"       "docs/DOCUMENT_TYPE_CATALOG.md"
assert_file "[5.2] ONBOARDING_RUNBOOK.md exists"          "docs/ONBOARDING_RUNBOOK.md"
assert_file "[5.3] OPERATIONS.md exists"                  "docs/OPERATIONS.md"
assert_file "[5.4] API_REFERENCE.md exists"               "docs/API_REFERENCE.md"
assert_file "[5.5] UAT_PHASE_2.md exists"                 "docs/UAT_PHASE_2.md"
assert_file "[5.6] UAT_PHASE_3.md exists"                 "docs/UAT_PHASE_3.md"
assert_file "[5.7] uat-phase-2.sh exists"                 "docs/uat-phase-2.sh"
assert_file "[5.8] uat-phase-3.sh exists"                 "docs/uat-phase-3.sh"
assert_file "[5.9] docs/README.md index exists"           "docs/README.md"
assert_file "[5.10] property-based tests file exists"     "packages/document-core/src/property.test.ts"

# ----------------------------------------------------------------------
# Final report
# ----------------------------------------------------------------------

printf '\n%b======================================================================%b\n' "$BOLD" "$NC"
if [[ $FAIL_COUNT -eq 0 ]]; then
  printf '%b ✓ Phase 5 UAT PASSED %b — %d assertions, 0 failures\n' "$GREEN$BOLD" "$NC" "$PASS_COUNT"
else
  printf '%b ✗ Phase 5 UAT FAILED %b — %d passed, %d failed\n' "$RED$BOLD" "$NC" "$PASS_COUNT" "$FAIL_COUNT"
fi
printf '%b======================================================================%b\n' "$BOLD" "$NC"

exit $([[ $FAIL_COUNT -eq 0 ]] && echo 0 || echo 2)
