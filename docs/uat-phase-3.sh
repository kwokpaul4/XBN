#!/usr/bin/env bash
#
# XBN Phase 3 UAT — drives the direct-materials SCC choreography
# end-to-end and verifies every PHASES.md §3 contract that's in scope
# for M3.
#
# Scope (in scope for M3 / this script):
#   #16 SCC anchor entities — SCHEDULING_AGREEMENT, CONSIGNMENT_CONTRACT,
#                              SUBCONTRACTING_AGREEMENT
#   #17 Forecast Collaboration — FORECAST_PUBLISH, FORECAST_COMMIT
#   #18 Scheduling Agreement Releases — SA_RELEASE_FORECAST,
#                                        SA_RELEASE_JIT + polymorphic ASN
#
# Deferred per the original plan (NOT covered):
#   #20 Subcontracting docs (CONSIGNMENT_FILL siblings)
#   #21 Consignment docs (settlement flows)
#   #22 Quality Notifications
#
# Usage:
#   ./docs/uat-phase-3.sh                  # full UAT
#   ./docs/uat-phase-3.sh --api=URL        # override API base URL
#                                          # default: http://localhost:3000
#
# Prereqs:
#   - docker compose up -d  (Postgres + MinIO healthy)
#   - pnpm --filter @xbn/api dev  (API listening on :3000)
#   - jq installed (brew install jq | apt install jq)
#
# Exit codes:
#   0  all assertions passed
#   1  setup failed
#   2  one or more assertions failed (stops at first failure)

set -euo pipefail

# ----------------------------------------------------------------------
# Configuration & helpers (same pattern as uat-phase-2.sh)
# ----------------------------------------------------------------------

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
SUFFIX="$(date +%s)-$$-p3"

GREEN='\033[0;32m'; RED='\033[0;31m'; DIM='\033[2m'; BOLD='\033[1m'; NC='\033[0m'

section() { printf '\n%b%s%b\n' "$BOLD" "----------------------------------------------------------------------" "$NC"; printf '%b %s%b\n' "$BOLD" "$1" "$NC"; printf '%b%s%b\n' "$BOLD" "----------------------------------------------------------------------" "$NC"; }
hdr()     { printf '\n%b%s%b\n' "$BOLD" "======================================================================" "$NC"; printf '%b %s%b\n' "$BOLD" "$1" "$NC"; printf '%b%s%b\n' "$BOLD" "======================================================================" "$NC"; }
pass() { printf '  %b✓%b %s\n' "$GREEN" "$NC" "$1"; PASS_COUNT=$((PASS_COUNT+1)); }
fail() {
  printf '  %b✗%b %s\n' "$RED" "$NC" "$1"
  if [[ -n "${2:-}" ]]; then printf '    %bresponse:%b %s\n' "$DIM" "$NC" "$2"; fi
  FAIL_COUNT=$((FAIL_COUNT+1)); exit 2
}
info() { printf '  %s\n' "$1"; }

assert_eq() {
  local label="$1" body="$2" path="$3" expected="$4"
  local actual; actual=$(printf '%s' "$body" | jq -r "$path" 2>/dev/null || echo '__JQ_ERR__')
  if [[ "$actual" == "$expected" ]]; then pass "$label"; else fail "$label — expected '$expected', got '$actual'" "$body"; fi
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

hdr "XBN Phase 3 UAT — direct-materials SCC choreography"

command -v jq >/dev/null 2>&1 || { echo "✗ jq is required (brew install jq)" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "✗ curl is required." >&2; exit 1; }

info "Probing API at $API ..."
HEALTH=$(curl -s -o /dev/null -w '%{http_code}' "$API/health" || echo 'fail')
if [[ "$HEALTH" != "200" ]]; then
  echo "✗ API not reachable at $API/health (status: $HEALTH)" >&2
  echo "  Start it with: pnpm --filter @xbn/api dev" >&2
  exit 1
fi
pass "API reachable"

# ----------------------------------------------------------------------
# Setup primary buyer/supplier with all Phase 3 doc types enabled
# ----------------------------------------------------------------------

section "[setup] Registering buyer + supplier with full SCC type set"

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
  echo "$user_id"
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
register_and_login "buyer-$SUFFIX@uat.local" "$BUYER_COOKIES" >/dev/null
register_and_login "supplier-$SUFFIX@uat.local" "$SUPPLIER_COOKIES" >/dev/null
BUYER_ORG=$(create_org "$BUYER_COOKIES" "UAT Phase3 Buyer" "BUYER")
SUPPLIER_ORG=$(create_org "$SUPPLIER_COOKIES" "UAT Phase3 Supplier" "SUPPLIER")
info "buyer org id:    $BUYER_ORG"
info "supplier org id: $SUPPLIER_ORG"

REL_RESP=$(post_json "$API/network/relationships" "$BUYER_COOKIES" "$BUYER_ORG" "$(cat <<JSON
{
  "buyerOrgId":"$BUYER_ORG","supplierOrgId":"$SUPPLIER_ORG","status":"ACTIVE",
  "enabledDocumentTypes":[
    "SCHEDULING_AGREEMENT","CONSIGNMENT_CONTRACT","SUBCONTRACTING_AGREEMENT",
    "FORECAST_PUBLISH","FORECAST_COMMIT",
    "SA_RELEASE_FORECAST","SA_RELEASE_JIT",
    "ASN"
  ],
  "defaultCurrency":"USD"
}
JSON
)")
assert_eq "trading relationship is ACTIVE with full Phase 3 doc type set" "$REL_RESP" '.relationship.status' 'ACTIVE'

# Shared fixture: ship-to/plant address used everywhere.
SHIP_TO_JSON='{"name":"Plant 1","line1":"1 Plant Way","city":"Plantcity","countryCode":"US"}'

# ----------------------------------------------------------------------
# Scenario 1 — SCC anchor lifecycles (Task #16)
# ----------------------------------------------------------------------

section "Scenario 1 — SCC anchor entity lifecycles (Task #16, PHASES.md §3)"

# 1.1 — SCHEDULING_AGREEMENT publish + full lifecycle
SA_BODY=$(cat <<JSON
{
  "documentType":"SCHEDULING_AGREEMENT","recipientOrgId":"$SUPPLIER_ORG",
  "body":{
    "itemSku":"BOLT-M8","itemDescription":"M8 hex bolt","targetQuantity":100000,
    "unitOfMeasure":"EA","unitPrice":0.5,"currency":"USD",
    "validityStart":"2026-01-01","validityEnd":"2026-12-31",
    "plant":"PLANT-001","shipTo":$SHIP_TO_JSON,
    "paymentTermsRef":"NET-30","incoterms":"FOB"
  }
}
JSON
)
SA_RESP=$(post_json "$API/documents" "$BUYER_COOKIES" "$BUYER_ORG" "$SA_BODY")
SA_ID=$(echo "$SA_RESP" | jq -r .documentId)
SA_NUM=$(echo "$SA_RESP" | jq -r .documentNumber)
[[ "$SA_ID" == "null" ]] && fail "SCHEDULING_AGREEMENT publish failed" "$SA_RESP"
assert_eq "[1.1] SCHEDULING_AGREEMENT published with sequential numbering" "$SA_RESP" '.documentNumber' 'SCHEDULING_AGREEMENT-000001'

# Walk SA: DRAFT → ACTIVE → SUSPENDED → ACTIVE → TERMINATED
RESP=$(post_json "$API/documents/$SA_ID/transition" "$BUYER_COOKIES" "$BUYER_ORG" '{"fromStatus":"DRAFT","toStatus":"ACTIVE"}')
assert_eq "[1.2] SA DRAFT → ACTIVE" "$RESP" '.nextStatus' 'ACTIVE'
RESP=$(post_json "$API/documents/$SA_ID/transition" "$BUYER_COOKIES" "$BUYER_ORG" '{"fromStatus":"ACTIVE","toStatus":"SUSPENDED"}')
assert_eq "[1.3] SA ACTIVE → SUSPENDED" "$RESP" '.nextStatus' 'SUSPENDED'
RESP=$(post_json "$API/documents/$SA_ID/transition" "$BUYER_COOKIES" "$BUYER_ORG" '{"fromStatus":"SUSPENDED","toStatus":"ACTIVE"}')
assert_eq "[1.4] SA re-ACTIVATEs from SUSPENDED" "$RESP" '.nextStatus' 'ACTIVE'

# Keep this SA active for use in Scenarios 2 and 3 — don't terminate yet.

# 1.5 — CONSIGNMENT_CONTRACT publish
CC_RESP=$(post_json "$API/documents" "$BUYER_COOKIES" "$BUYER_ORG" "$(cat <<JSON
{
  "documentType":"CONSIGNMENT_CONTRACT","recipientOrgId":"$SUPPLIER_ORG",
  "body":{
    "itemSku":"WASHER-M8","itemDescription":"M8 flat washer",
    "unitOfMeasure":"EA","unitPrice":0.05,"currency":"USD",
    "validityStart":"2026-01-01","validityEnd":"2026-12-31",
    "stockLocation":$SHIP_TO_JSON,
    "reorderPoint":5000,"settlementCadence":"MONTHLY"
  }
}
JSON
)")
CC_ID=$(echo "$CC_RESP" | jq -r .documentId)
[[ "$CC_ID" == "null" ]] && fail "CONSIGNMENT_CONTRACT publish failed" "$CC_RESP"
pass "[1.5] CONSIGNMENT_CONTRACT published"

# 1.6 — SUBCONTRACTING_AGREEMENT publish
SUB_RESP=$(post_json "$API/documents" "$BUYER_COOKIES" "$BUYER_ORG" "$(cat <<JSON
{
  "documentType":"SUBCONTRACTING_AGREEMENT","recipientOrgId":"$SUPPLIER_ORG",
  "body":{
    "finishedGoodSku":"WIDGET-ASSY","finishedGoodDescription":"Widget sub-assembly",
    "finishedGoodUnitOfMeasure":"EA","assemblyFeePerUnit":2.5,"currency":"USD",
    "validityStart":"2026-01-01","validityEnd":"2026-12-31",
    "shipTo":$SHIP_TO_JSON,
    "components":[
      {"sku":"BOLT-M8","description":"M8 bolt","unitOfMeasure":"EA","quantityPerFg":4},
      {"sku":"WASHER-M8","description":"M8 washer","unitOfMeasure":"EA","quantityPerFg":8}
    ]
  }
}
JSON
)")
SUB_ID=$(echo "$SUB_RESP" | jq -r .documentId)
[[ "$SUB_ID" == "null" ]] && fail "SUBCONTRACTING_AGREEMENT publish failed" "$SUB_RESP"
pass "[1.6] SUBCONTRACTING_AGREEMENT published"

# ----------------------------------------------------------------------
# Scenario 2 — Forecast Collaboration (Task #17, PHASES.md §3.1)
# ----------------------------------------------------------------------

section "Scenario 2 — Forecast Collaboration (Task #17, PHASES.md §3.1)"

# 2.1 — Buyer publishes FORECAST_PUBLISH; auto-link CALLS_OFF → SA
FP1_RESP=$(post_json "$API/documents" "$BUYER_COOKIES" "$BUYER_ORG" "$(cat <<JSON
{
  "documentType":"FORECAST_PUBLISH","recipientOrgId":"$SUPPLIER_ORG",
  "body":{
    "schedulingAgreementDocumentNumber":"$SA_NUM",
    "schedulingAgreementDocumentId":"$SA_ID",
    "itemSku":"BOLT-M8","itemDescription":"M8 hex bolt","unitOfMeasure":"EA",
    "horizonStart":"2026-01-01","horizonEnd":"2026-03-31",
    "buckets":[
      {"periodStart":"2026-01-01","periodEnd":"2026-01-31","forecastQuantity":10000},
      {"periodStart":"2026-02-01","periodEnd":"2026-02-28","forecastQuantity":12000},
      {"periodStart":"2026-03-01","periodEnd":"2026-03-31","forecastQuantity":11000}
    ],
    "notes":"Q1 forecast"
  }
}
JSON
)")
FP1_ID=$(echo "$FP1_RESP" | jq -r .documentId)
FP1_NUM=$(echo "$FP1_RESP" | jq -r .documentNumber)
LINK_WARN=$(echo "$FP1_RESP" | jq -r '.linkWarnings // empty')
[[ "$FP1_ID" == "null" ]] && fail "FORECAST_PUBLISH failed" "$FP1_RESP"
[[ -n "$LINK_WARN" ]] && fail "FORECAST_PUBLISH auto-link surfaced warnings" "$FP1_RESP"
pass "[2.1] FORECAST_PUBLISH published (auto-linked CALLS_OFF → SA)"

post_json "$API/documents/$FP1_ID/transition" "$BUYER_COOKIES" "$BUYER_ORG" '{"fromStatus":"DRAFT","toStatus":"ISSUED"}' >/dev/null

# Verify SA has a CALLS_OFF inbound link
SA_DETAIL=$(get_json "$API/documents/$SA_ID" "$BUYER_COOKIES" "$BUYER_ORG")
CALLS_OFF_COUNT=$(echo "$SA_DETAIL" | jq -r '[.incomingLinks[] | select(.linkType=="CALLS_OFF")] | length')
[[ "$CALLS_OFF_COUNT" -ge 1 ]] || fail "Expected ≥1 CALLS_OFF inbound on SA, got $CALLS_OFF_COUNT" "$SA_DETAIL"
pass "[2.2] SA has CALLS_OFF inbound link from FORECAST_PUBLISH"

# 2.3 — Supplier publishes FORECAST_COMMIT with all three modes
FC_RESP=$(post_json "$API/documents" "$SUPPLIER_COOKIES" "$SUPPLIER_ORG" "$(cat <<JSON
{
  "documentType":"FORECAST_COMMIT","recipientOrgId":"$BUYER_ORG",
  "body":{
    "forecastDocumentNumber":"$FP1_NUM","forecastDocumentId":"$FP1_ID",
    "itemSku":"BOLT-M8","unitOfMeasure":"EA",
    "buckets":[
      {"mode":"COMMIT","periodStart":"2026-01-01","periodEnd":"2026-01-31","committedQuantity":10000},
      {"mode":"COMMIT_WITH_DEVIATION","periodStart":"2026-02-01","periodEnd":"2026-02-28","committedQuantity":8000,"deviationReason":"Holiday capacity"},
      {"mode":"CANNOT_COMMIT","periodStart":"2026-03-01","periodEnd":"2026-03-31","reason":"Material shortage"}
    ]
  }
}
JSON
)")
FC_ID=$(echo "$FC_RESP" | jq -r .documentId)
LINK_WARN=$(echo "$FC_RESP" | jq -r '.linkWarnings // empty')
[[ "$FC_ID" == "null" ]] && fail "FORECAST_COMMIT failed" "$FC_RESP"
[[ -n "$LINK_WARN" ]] && fail "FORECAST_COMMIT auto-link warned" "$FC_RESP"
pass "[2.3] FORECAST_COMMIT published (3 modes: COMMIT / WITH_DEVIATION / CANNOT) auto-linked RESPONDS_TO"

# 2.4 — Buyer revises forecast — FORECAST_PUBLISH with SUPERSEDES → fp1
FP2_RESP=$(post_json "$API/documents" "$BUYER_COOKIES" "$BUYER_ORG" "$(cat <<JSON
{
  "documentType":"FORECAST_PUBLISH","recipientOrgId":"$SUPPLIER_ORG",
  "body":{
    "schedulingAgreementDocumentNumber":"$SA_NUM",
    "schedulingAgreementDocumentId":"$SA_ID",
    "itemSku":"BOLT-M8","itemDescription":"M8 hex bolt","unitOfMeasure":"EA",
    "horizonStart":"2026-01-01","horizonEnd":"2026-03-31",
    "buckets":[
      {"periodStart":"2026-01-01","periodEnd":"2026-01-31","forecastQuantity":10000},
      {"periodStart":"2026-02-01","periodEnd":"2026-02-28","forecastQuantity":9000},
      {"periodStart":"2026-03-01","periodEnd":"2026-03-31","forecastQuantity":5000}
    ],
    "supersedesForecastDocumentId":"$FP1_ID",
    "notes":"revised after supplier capacity feedback"
  }
}
JSON
)")
FP2_ID=$(echo "$FP2_RESP" | jq -r .documentId)
LINK_WARN=$(echo "$FP2_RESP" | jq -r '.linkWarnings // empty')
[[ "$FP2_ID" == "null" ]] && fail "Revised FORECAST_PUBLISH failed" "$FP2_RESP"
[[ -n "$LINK_WARN" ]] && fail "Revised FORECAST_PUBLISH auto-link warned" "$FP2_RESP"
pass "[2.4] Revised FORECAST_PUBLISH auto-linked SUPERSEDES → fp1"

# Verify fp1 has SUPERSEDES inbound
FP1_DETAIL=$(get_json "$API/documents/$FP1_ID" "$BUYER_COOKIES" "$BUYER_ORG")
SUPERSEDES_COUNT=$(echo "$FP1_DETAIL" | jq -r '[.incomingLinks[] | select(.linkType=="SUPERSEDES")] | length')
if [[ "$SUPERSEDES_COUNT" == "1" ]]; then
  pass "[2.5] Prior forecast (fp1) has 1 SUPERSEDES inbound link"
else
  fail "Expected 1 SUPERSEDES inbound on fp1, got $SUPERSEDES_COUNT" "$FP1_DETAIL"
fi

# 2.6 — Negative: FORECAST_COMMIT with negative quantity rejected
NEG_RESP=$(post_json "$API/documents" "$SUPPLIER_COOKIES" "$SUPPLIER_ORG" "$(cat <<JSON
{
  "documentType":"FORECAST_COMMIT","recipientOrgId":"$BUYER_ORG",
  "body":{
    "forecastDocumentNumber":"X","forecastDocumentId":"x","itemSku":"X","unitOfMeasure":"EA",
    "buckets":[{"mode":"COMMIT","periodStart":"2026-01-01","periodEnd":"2026-01-31","committedQuantity":-5}]
  }
}
JSON
)")
NEG_KIND=$(echo "$NEG_RESP" | jq -r '.reason.kind // empty')
if [[ "$NEG_KIND" == "body_schema" ]]; then
  pass "[2.6] FORECAST_COMMIT with negative committedQuantity rejected by Zod"
else
  fail "Expected body_schema rejection, got '$NEG_KIND'" "$NEG_RESP"
fi

# ----------------------------------------------------------------------
# Scenario 3 — SA Releases + polymorphic ASN (Task #18, PHASES.md §3.2)
# ----------------------------------------------------------------------

section "Scenario 3 — SA Releases + polymorphic ASN (Task #18, PHASES.md §3.2)"

# 3.1 — Buyer publishes SA_RELEASE_FORECAST (auto-links CALLS_OFF → SA)
RF1_RESP=$(post_json "$API/documents" "$BUYER_COOKIES" "$BUYER_ORG" "$(cat <<JSON
{
  "documentType":"SA_RELEASE_FORECAST","recipientOrgId":"$SUPPLIER_ORG",
  "body":{
    "schedulingAgreementDocumentNumber":"$SA_NUM",
    "schedulingAgreementDocumentId":"$SA_ID",
    "itemSku":"BOLT-M8",
    "windowStart":"2026-02-01","windowEnd":"2026-02-28",
    "releaseLines":[{"requestedDeliveryDate":"2026-02-15","quantity":5000,"unitOfMeasure":"EA"}]
  }
}
JSON
)")
RF1_ID=$(echo "$RF1_RESP" | jq -r .documentId)
LINK_WARN=$(echo "$RF1_RESP" | jq -r '.linkWarnings // empty')
[[ "$RF1_ID" == "null" ]] && fail "SA_RELEASE_FORECAST publish failed" "$RF1_RESP"
[[ -n "$LINK_WARN" ]] && fail "SA_RELEASE_FORECAST auto-link warned" "$RF1_RESP"
pass "[3.1] SA_RELEASE_FORECAST published (auto-linked CALLS_OFF → SA)"

post_json "$API/documents/$RF1_ID/transition" "$BUYER_COOKIES" "$BUYER_ORG" '{"fromStatus":"DRAFT","toStatus":"ISSUED"}' >/dev/null

# 3.2 — Buyer publishes a REVISED forecast release with SUPERSEDES → rf1
RF2_RESP=$(post_json "$API/documents" "$BUYER_COOKIES" "$BUYER_ORG" "$(cat <<JSON
{
  "documentType":"SA_RELEASE_FORECAST","recipientOrgId":"$SUPPLIER_ORG",
  "body":{
    "schedulingAgreementDocumentNumber":"$SA_NUM",
    "schedulingAgreementDocumentId":"$SA_ID",
    "itemSku":"BOLT-M8",
    "windowStart":"2026-02-01","windowEnd":"2026-02-28",
    "releaseLines":[{"requestedDeliveryDate":"2026-02-20","quantity":4500,"unitOfMeasure":"EA"}],
    "supersedesReleaseDocumentId":"$RF1_ID"
  }
}
JSON
)")
RF2_ID=$(echo "$RF2_RESP" | jq -r .documentId)
LINK_WARN=$(echo "$RF2_RESP" | jq -r '.linkWarnings // empty')
[[ -n "$LINK_WARN" ]] && fail "Revised SA_RELEASE_FORECAST auto-link warned" "$RF2_RESP"
pass "[3.2] Revised SA_RELEASE_FORECAST auto-linked SUPERSEDES → rf1"

# 3.3 — Buyer publishes firm SA_RELEASE_JIT
JIT_RESP=$(post_json "$API/documents" "$BUYER_COOKIES" "$BUYER_ORG" "$(cat <<JSON
{
  "documentType":"SA_RELEASE_JIT","recipientOrgId":"$SUPPLIER_ORG",
  "body":{
    "schedulingAgreementDocumentNumber":"$SA_NUM",
    "schedulingAgreementDocumentId":"$SA_ID",
    "itemSku":"BOLT-M8",
    "windowStart":"2026-02-20","windowEnd":"2026-02-22",
    "releaseLines":[
      {"requestedDeliveryDate":"2026-02-21","requestedDeliveryTime":"08:00","quantity":1500,"unitOfMeasure":"EA"}
    ]
  }
}
JSON
)")
JIT_ID=$(echo "$JIT_RESP" | jq -r .documentId)
JIT_NUM=$(echo "$JIT_RESP" | jq -r .documentNumber)
LINK_WARN=$(echo "$JIT_RESP" | jq -r '.linkWarnings // empty')
[[ "$JIT_ID" == "null" ]] && fail "SA_RELEASE_JIT publish failed" "$JIT_RESP"
[[ -n "$LINK_WARN" ]] && fail "SA_RELEASE_JIT auto-link warned" "$JIT_RESP"
pass "[3.3] SA_RELEASE_JIT (firm call-off) published (auto-linked CALLS_OFF → SA)"

post_json "$API/documents/$JIT_ID/transition" "$BUYER_COOKIES" "$BUYER_ORG" '{"fromStatus":"DRAFT","toStatus":"ISSUED"}' >/dev/null

# 3.4 — THE CROSS-PHASE POLYMORPHIC TEST
# Supplier ships an ASN against the JIT release (NOT a PO). The Phase 2
# ASN type accepts either predecessor; the SHIPS_AGAINST link must land
# on the JIT release.
ASN_RESP=$(post_json "$API/documents" "$SUPPLIER_COOKIES" "$SUPPLIER_ORG" "$(cat <<JSON
{
  "documentType":"ASN","recipientOrgId":"$BUYER_ORG",
  "body":{
    "saReleaseJitDocumentNumber":"$JIT_NUM",
    "saReleaseJitDocumentId":"$JIT_ID",
    "carrier":"UPS","shippedAt":"2026-02-20","expectedDeliveryDate":"2026-02-21",
    "shipFrom":{"name":"Supplier Plant","line1":"1 Supply Lane","city":"Supplycity","countryCode":"US"},
    "lines":[{"lineRef":"BOLT-M8","sku":"BOLT-M8","shippedQuantity":1500,"unitOfMeasure":"EA"}]
  }
}
JSON
)")
ASN_ID=$(echo "$ASN_RESP" | jq -r .documentId)
LINK_WARN=$(echo "$ASN_RESP" | jq -r '.linkWarnings // empty')
[[ "$ASN_ID" == "null" ]] && fail "ASN against JIT publish failed" "$ASN_RESP"
[[ -n "$LINK_WARN" ]] && fail "ASN against JIT auto-link warned" "$ASN_RESP"
pass "[3.4] ASN published with saReleaseJitDocumentId — polymorphic predecessor accepted"

# 3.5 — Verify the link landed on the JIT release, NOT the SA
ASN_DETAIL=$(get_json "$API/documents/$ASN_ID" "$SUPPLIER_COOKIES" "$SUPPLIER_ORG")
SHIPS_TO=$(echo "$ASN_DETAIL" | jq -r '[.outgoingLinks[] | select(.linkType=="SHIPS_AGAINST")] | .[0].toDocumentId')
if [[ "$SHIPS_TO" == "$JIT_ID" ]]; then
  pass "[3.5] ASN's SHIPS_AGAINST link points at the JIT release (polymorphic resolution)"
else
  fail "Expected SHIPS_AGAINST → $JIT_ID, got → $SHIPS_TO" "$ASN_DETAIL"
fi

# 3.6 — Verify the JIT release has 1 inbound SHIPS_AGAINST
JIT_DETAIL=$(get_json "$API/documents/$JIT_ID" "$BUYER_COOKIES" "$BUYER_ORG")
JIT_INBOUND_SHIPS=$(echo "$JIT_DETAIL" | jq -r '[.incomingLinks[] | select(.linkType=="SHIPS_AGAINST")] | length')
if [[ "$JIT_INBOUND_SHIPS" == "1" ]]; then
  pass "[3.6] JIT release has 1 SHIPS_AGAINST inbound (cross-phase substrate test passes)"
else
  fail "Expected 1 SHIPS_AGAINST inbound on JIT, got $JIT_INBOUND_SHIPS" "$JIT_DETAIL"
fi

# ----------------------------------------------------------------------
# Scenario 4 — Negative paths
# ----------------------------------------------------------------------

section "Scenario 4 — Negative paths"

# 4.1 — FORECAST_PUBLISH rejected when doc type not enabled on relationship
BUYER41_COOKIES="$COOKIE_DIR/buyer41.cookies"
SUPPLIER41_COOKIES="$COOKIE_DIR/supplier41.cookies"
register_and_login "buyer41-$SUFFIX@uat.local" "$BUYER41_COOKIES" >/dev/null
register_and_login "supplier41-$SUFFIX@uat.local" "$SUPPLIER41_COOKIES" >/dev/null
BUYER41_ORG=$(create_org "$BUYER41_COOKIES" "Buyer 4.1" "BUYER")
SUPPLIER41_ORG=$(create_org "$SUPPLIER41_COOKIES" "Supplier 4.1" "SUPPLIER")
post_json "$API/network/relationships" "$BUYER41_COOKIES" "$BUYER41_ORG" "$(cat <<JSON
{
  "buyerOrgId":"$BUYER41_ORG","supplierOrgId":"$SUPPLIER41_ORG","status":"ACTIVE",
  "enabledDocumentTypes":["SCHEDULING_AGREEMENT"],
  "defaultCurrency":"USD"
}
JSON
)" >/dev/null

R=$(post_json "$API/documents" "$BUYER41_COOKIES" "$BUYER41_ORG" "$(cat <<JSON
{
  "documentType":"FORECAST_PUBLISH","recipientOrgId":"$SUPPLIER41_ORG",
  "body":{
    "itemSku":"X","itemDescription":"X","unitOfMeasure":"EA",
    "horizonStart":"2026-01-01","horizonEnd":"2026-01-31",
    "buckets":[{"periodStart":"2026-01-01","periodEnd":"2026-01-31","forecastQuantity":100}]
  }
}
JSON
)")
KIND=$(echo "$R" | jq -r '.reason.detail.kind // empty')
if [[ "$KIND" == "document_type_not_enabled" ]]; then
  pass "[4.1] FORECAST_PUBLISH rejected when doc type not enabled (document_type_not_enabled)"
else
  fail "Expected document_type_not_enabled, got '$KIND'" "$R"
fi

# 4.2 — SA invalid transition (DRAFT → SUSPENDED, skipping ACTIVE)
SA42_RESP=$(post_json "$API/documents" "$BUYER_COOKIES" "$BUYER_ORG" "$SA_BODY")
SA42_ID=$(echo "$SA42_RESP" | jq -r .documentId)
R=$(post_json "$API/documents/$SA42_ID/transition" "$BUYER_COOKIES" "$BUYER_ORG" '{"fromStatus":"DRAFT","toStatus":"SUSPENDED"}')
KIND=$(echo "$R" | jq -r '.reason.detail.kind // empty')
if [[ "$KIND" == "no_such_transition" ]]; then
  pass "[4.2] SA DRAFT → SUSPENDED rejected (no_such_transition)"
else
  fail "Expected no_such_transition, got '$KIND'" "$R"
fi

# 4.3 — Supplier trying to issue a buyer-only transition (wrong actor side)
R=$(post_json "$API/documents/$SA42_ID/transition" "$SUPPLIER_COOKIES" "$SUPPLIER_ORG" '{"fromStatus":"DRAFT","toStatus":"ACTIVE"}')
KIND=$(echo "$R" | jq -r '.reason.detail.kind // empty')
if [[ "$KIND" == "wrong_actor_side" || "$KIND" == "wrong_role" ]]; then
  pass "[4.3] Supplier trying SA DRAFT → ACTIVE rejected ($KIND)"
else
  fail "Expected wrong_actor_side or wrong_role, got '$KIND'" "$R"
fi

# 4.4 — FORECAST_PUBLISH body schema validation (empty buckets)
R=$(post_json "$API/documents" "$BUYER_COOKIES" "$BUYER_ORG" "$(cat <<JSON
{
  "documentType":"FORECAST_PUBLISH","recipientOrgId":"$SUPPLIER_ORG",
  "body":{
    "itemSku":"X","itemDescription":"X","unitOfMeasure":"EA",
    "horizonStart":"2026-01-01","horizonEnd":"2026-01-31",
    "buckets":[]
  }
}
JSON
)")
KIND=$(echo "$R" | jq -r '.reason.kind // empty')
if [[ "$KIND" == "body_schema" ]]; then
  pass "[4.4] FORECAST_PUBLISH with empty buckets[] rejected by Zod"
else
  fail "Expected body_schema, got '$KIND'" "$R"
fi

# ----------------------------------------------------------------------
# Scenario 5 — End-to-end SCC choreography summary
# ----------------------------------------------------------------------

section "Scenario 5 — End-to-end SCC DAG verification"

# Inspect the SA — it should now be the hub of a substantial DAG:
#   - 1 FORECAST_PUBLISH (initial) via CALLS_OFF
#   - 1 FORECAST_PUBLISH (revised) via CALLS_OFF
#   - 1 SA_RELEASE_FORECAST (initial) via CALLS_OFF
#   - 1 SA_RELEASE_FORECAST (revised) via CALLS_OFF
#   - 1 SA_RELEASE_JIT via CALLS_OFF
# = 5 CALLS_OFF inbound on the SA.
SA_FINAL=$(get_json "$API/documents/$SA_ID" "$BUYER_COOKIES" "$BUYER_ORG")
SA_CALLS_OFF=$(echo "$SA_FINAL" | jq -r '[.incomingLinks[] | select(.linkType=="CALLS_OFF")] | length')
if [[ "$SA_CALLS_OFF" == "5" ]]; then
  pass "[5.1] SA hub has 5 CALLS_OFF inbound (2 forecasts + 2 release forecasts + 1 JIT)"
else
  fail "Expected 5 CALLS_OFF on SA, got $SA_CALLS_OFF" "$SA_FINAL"
fi

# Inspect the JIT release: should have 1 SHIPS_AGAINST from the ASN.
JIT_FINAL=$(get_json "$API/documents/$JIT_ID" "$BUYER_COOKIES" "$BUYER_ORG")
JIT_SHIPS=$(echo "$JIT_FINAL" | jq -r '[.incomingLinks[] | select(.linkType=="SHIPS_AGAINST")] | length')
if [[ "$JIT_SHIPS" == "1" ]]; then
  pass "[5.2] JIT release has 1 SHIPS_AGAINST inbound (ASN polymorphic predecessor)"
else
  fail "Expected 1 SHIPS_AGAINST on JIT, got $JIT_SHIPS" "$JIT_FINAL"
fi

# Inspect the fp1 (original forecast): should have 1 RESPONDS_TO from
# the supplier's commit, and 1 SUPERSEDES from the revised forecast.
FP1_FINAL=$(get_json "$API/documents/$FP1_ID" "$BUYER_COOKIES" "$BUYER_ORG")
RESPONDS=$(echo "$FP1_FINAL" | jq -r '[.incomingLinks[] | select(.linkType=="RESPONDS_TO")] | length')
SUPERSEDED=$(echo "$FP1_FINAL" | jq -r '[.incomingLinks[] | select(.linkType=="SUPERSEDES")] | length')
if [[ "$RESPONDS" == "1" && "$SUPERSEDED" == "1" ]]; then
  pass "[5.3] Original forecast has 1 RESPONDS_TO (commit) + 1 SUPERSEDES (revision)"
else
  fail "Expected 1 RESPONDS_TO + 1 SUPERSEDES on fp1, got $RESPONDS + $SUPERSEDED" "$FP1_FINAL"
fi

# Final terminal state for SA — keep it active for graph clarity rather than terminate.

# ----------------------------------------------------------------------
# Final report
# ----------------------------------------------------------------------

printf '\n%b======================================================================%b\n' "$BOLD" "$NC"
if [[ $FAIL_COUNT -eq 0 ]]; then
  printf '%b ✓ Phase 3 UAT PASSED %b — %d assertions, 0 failures\n' "$GREEN$BOLD" "$NC" "$PASS_COUNT"
else
  printf '%b ✗ Phase 3 UAT FAILED %b — %d passed, %d failed\n' "$RED$BOLD" "$NC" "$PASS_COUNT" "$FAIL_COUNT"
fi
printf '%b======================================================================%b\n' "$BOLD" "$NC"

exit $([[ $FAIL_COUNT -eq 0 ]] && echo 0 || echo 2)
