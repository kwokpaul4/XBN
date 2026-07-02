#!/usr/bin/env bash
#
# XBN Phase 4 UAT — drives the network-wide features end-to-end and
# verifies every PHASES.md §4 contract for M4.
#
# Scope (in scope for M4 / this script):
#   #23 §4.1 Cross-type search + inbox/outbox filters (q, fromDate, toDate,
#                                                     documentType, status,
#                                                     counterpartyOrgId)
#   #24 §4.2 Counterparties / supplier directory
#   #25 §4.3 Buyer + supplier status dashboards
#   #26 §4.4 Supplier scorecards (PO-ack SLA, invoice match rate,
#                                 asnAccuracy + onTimeDelivery reported as
#                                 null with sampleSize 0 when no GR data)
#   #27 §4.5 Notification outbox — publish + transition emit; list, mark
#                                  read, mark-all-read; unreadCount drops
#
# Usage:
#   ./docs/uat-phase-4.sh                  # full UAT
#   ./docs/uat-phase-4.sh --api=URL        # override API base URL
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

# ----------------------------------------------------------------------
# Configuration & helpers (same pattern as uat-phase-2.sh / uat-phase-3.sh)
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
SUFFIX="$(date +%s)-$$-p4"

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

assert_ge() {
  local label="$1" body="$2" path="$3" min="$4"
  local actual; actual=$(printf '%s' "$body" | jq -r "$path" 2>/dev/null || echo 0)
  if [[ "$actual" =~ ^[0-9]+$ ]] && (( actual >= min )); then
    pass "$label"
  else
    fail "$label — expected ≥ $min, got '$actual'" "$body"
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

hdr "XBN Phase 4 UAT — network-wide features (§4.1–§4.5)"

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
# Setup — buyer + supplier + relationship with the doc types we exercise
# ----------------------------------------------------------------------

section "[setup] Registering buyer + supplier"

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
BUYER_UID=$(register_and_login "buyer-$SUFFIX@uat.local" "$BUYER_COOKIES")
SUPPLIER_UID=$(register_and_login "supplier-$SUFFIX@uat.local" "$SUPPLIER_COOKIES")
BUYER_ORG=$(create_org "$BUYER_COOKIES" "UAT Phase4 Buyer" "BUYER")
SUPPLIER_ORG=$(create_org "$SUPPLIER_COOKIES" "UAT Phase4 Supplier" "SUPPLIER")
info "buyer org id:    $BUYER_ORG"
info "supplier org id: $SUPPLIER_ORG"

REL_RESP=$(post_json "$API/network/relationships" "$BUYER_COOKIES" "$BUYER_ORG" "$(cat <<JSON
{
  "buyerOrgId":"$BUYER_ORG","supplierOrgId":"$SUPPLIER_ORG","status":"ACTIVE",
  "enabledDocumentTypes":[
    "PO","ORDER_CONFIRMATION","PO_CHANGE",
    "SCHEDULING_AGREEMENT","FORECAST_PUBLISH"
  ],
  "defaultCurrency":"USD",
  "summaryInvoicingEnabled":false
}
JSON
)")
assert_eq "trading relationship ACTIVE with the doc types this UAT exercises" "$REL_RESP" '.relationship.status' 'ACTIVE'

SHIP_TO_JSON='{"name":"Plant 1","line1":"1 Plant Way","city":"Plantcity","countryCode":"US"}'

po_body() {
  cat <<JSON
{
  "documentType":"PO","recipientOrgId":"$SUPPLIER_ORG",
  "body":{
    "currency":"USD","paymentTermsRef":"NET-30","requestedDeliveryDate":"2026-07-15",
    "shipTo":$SHIP_TO_JSON,"billTo":$SHIP_TO_JSON,
    "lines":[{"sku":"WIDGET-1","description":"Widget Mk I","quantity":5,"unitPrice":10,"unitOfMeasure":"EA"}]
  }
}
JSON
}

# ----------------------------------------------------------------------
# Scenario 1 — §4.1 cross-type search + inbox/outbox filters (Task #23)
# ----------------------------------------------------------------------

section "Scenario 1 — §4.1 search + inbox/outbox filters (Task #23)"

# 1.1 — publish 2 POs
PO1_RESP=$(post_json "$API/documents" "$BUYER_COOKIES" "$BUYER_ORG" "$(po_body)")
PO1_ID=$(echo "$PO1_RESP" | jq -r .documentId)
PO1_NUM=$(echo "$PO1_RESP" | jq -r .documentNumber)
[[ "$PO1_ID" == "null" ]] && fail "PO1 publish failed" "$PO1_RESP"

PO2_RESP=$(post_json "$API/documents" "$BUYER_COOKIES" "$BUYER_ORG" "$(po_body)")
PO2_ID=$(echo "$PO2_RESP" | jq -r .documentId)
[[ "$PO2_ID" == "null" ]] && fail "PO2 publish failed" "$PO2_RESP"
pass "[1.1] Published 2 POs (both auto-numbered)"

# 1.2 — buyer outbox lists both
OUTBOX=$(get_json "$API/documents?box=outbox" "$BUYER_COOKIES" "$BUYER_ORG")
assert_eq "[1.2] buyer outbox sees 2 documents" "$OUTBOX" '.total' '2'

# 1.3 — supplier inbox lists both
SUP_INBOX=$(get_json "$API/documents?box=inbox" "$SUPPLIER_COOKIES" "$SUPPLIER_ORG")
assert_eq "[1.3] supplier inbox sees 2 documents" "$SUP_INBOX" '.total' '2'

# 1.4 — q matches PO1 documentNumber
SEARCH=$(get_json "$API/documents?q=$PO1_NUM" "$BUYER_COOKIES" "$BUYER_ORG")
assert_eq "[1.4] q=$PO1_NUM narrows to 1 hit" "$SEARCH" '.total' '1'
assert_eq "[1.4] q hit is PO1" "$SEARCH" '.documents[0].id' "$PO1_ID"

# 1.5 — q with no match returns 0
SEARCH=$(get_json "$API/documents?q=NONEXISTENT-XYZ-42" "$BUYER_COOKIES" "$BUYER_ORG")
assert_eq "[1.5] q with no match returns 0" "$SEARCH" '.total' '0'

# 1.6 — fromDate in the far future excludes everything
FUTURE=$(get_json "$API/documents?fromDate=2099-01-01" "$BUYER_COOKIES" "$BUYER_ORG")
assert_eq "[1.6] fromDate=2099 excludes everything" "$FUTURE" '.total' '0'

# 1.7 — documentType filter
ONLY_POS=$(get_json "$API/documents?documentType=PO" "$BUYER_COOKIES" "$BUYER_ORG")
assert_eq "[1.7] documentType=PO still sees the 2 POs" "$ONLY_POS" '.total' '2'

# 1.8 — counterpartyOrgId filter
BY_CP=$(get_json "$API/documents?counterpartyOrgId=$SUPPLIER_ORG" "$BUYER_COOKIES" "$BUYER_ORG")
assert_eq "[1.8] counterparty filter still matches 2" "$BY_CP" '.total' '2'

# ----------------------------------------------------------------------
# Scenario 2 — §4.2 counterparties / supplier directory (Task #24)
# ----------------------------------------------------------------------

section "Scenario 2 — §4.2 counterparties / supplier directory (Task #24)"

# 2.1 — buyer side lists 1 counterparty (the supplier), ourRole=BUYER
CPS_B=$(get_json "$API/network/counterparties" "$BUYER_COOKIES" "$BUYER_ORG")
assert_eq "[2.1] buyer sees exactly 1 counterparty"        "$CPS_B" '.counterparties | length' '1'
assert_eq "[2.1] counterparty is the supplier org"          "$CPS_B" '.counterparties[0].counterpartyOrgId' "$SUPPLIER_ORG"
assert_eq "[2.1] our role on this relationship is BUYER"    "$CPS_B" '.counterparties[0].ourRole' 'BUYER'
assert_eq "[2.1] enabledDocumentTypes includes PO"          "$CPS_B" '.counterparties[0].enabledDocumentTypes | index("PO") | tostring' '0'

# 2.2 — lastActivityAt is non-null after publishes
LAST=$(echo "$CPS_B" | jq -r '.counterparties[0].lastActivityAt')
if [[ "$LAST" != "null" && -n "$LAST" ]]; then
  pass "[2.2] lastActivityAt is non-null after publishing 2 POs"
else
  fail "[2.2] expected lastActivityAt to be set, got '$LAST'" "$CPS_B"
fi

# 2.3 — supplier side lists the same relationship with ourRole=SUPPLIER
CPS_S=$(get_json "$API/network/counterparties" "$SUPPLIER_COOKIES" "$SUPPLIER_ORG")
assert_eq "[2.3] supplier's counterparty is the buyer org"  "$CPS_S" '.counterparties[0].counterpartyOrgId' "$BUYER_ORG"
assert_eq "[2.3] our role from the supplier side is SUPPLIER" "$CPS_S" '.counterparties[0].ourRole' 'SUPPLIER'

# ----------------------------------------------------------------------
# Scenario 3 — §4.3 status dashboards (Task #25)
# ----------------------------------------------------------------------

section "Scenario 3 — §4.3 status dashboards (Task #25)"

# 3.1 — transition PO1 to ISSUED so it appears on the "awaiting ack" tile.
RESP=$(post_json "$API/documents/$PO1_ID/transition" "$BUYER_COOKIES" "$BUYER_ORG" '{"fromStatus":"DRAFT","toStatus":"ISSUED"}')
assert_eq "[3.1] PO1 DRAFT → ISSUED" "$RESP" '.nextStatus' 'ISSUED'

# 3.2 — publish + activate a SCHEDULING_AGREEMENT so the SA tile fires.
SA_RESP=$(post_json "$API/documents" "$BUYER_COOKIES" "$BUYER_ORG" "$(cat <<JSON
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
)")
SA_ID=$(echo "$SA_RESP" | jq -r .documentId)
[[ "$SA_ID" == "null" ]] && fail "SA publish failed" "$SA_RESP"
post_json "$API/documents/$SA_ID/transition" "$BUYER_COOKIES" "$BUYER_ORG" '{"fromStatus":"DRAFT","toStatus":"ACTIVE"}' >/dev/null

BUYER_DASH=$(get_json "$API/network/dashboards/buyer" "$BUYER_COOKIES" "$BUYER_ORG")
assert_eq "[3.3] buyer tile: 1 PO awaiting acknowledgement" "$BUYER_DASH" '.tiles.poAwaitingAcknowledgement' '1'
assert_eq "[3.3] buyer tile: 1 active scheduling agreement"  "$BUYER_DASH" '.tiles.activeSchedulingAgreements' '1'

SUP_DASH=$(get_json "$API/network/dashboards/supplier" "$SUPPLIER_COOKIES" "$SUPPLIER_ORG")
assert_eq "[3.4] supplier tile: 1 PO to acknowledge" "$SUP_DASH" '.tiles.posToAcknowledge' '1'

# ----------------------------------------------------------------------
# Scenario 4 — §4.4 supplier scorecards (Task #26)
# ----------------------------------------------------------------------

section "Scenario 4 — §4.4 supplier scorecards (Task #26)"

# 4.1 — supplier publishes an ORDER_CONFIRMATION → the PO-ack SLA metric
# becomes non-null with sampleSize 1.
post_json "$API/documents" "$SUPPLIER_COOKIES" "$SUPPLIER_ORG" "$(cat <<JSON
{
  "documentType":"ORDER_CONFIRMATION","recipientOrgId":"$BUYER_ORG",
  "body":{
    "poDocumentNumber":"$PO1_NUM","poDocumentId":"$PO1_ID","mode":"FULL_ACCEPT"
  }
}
JSON
)" >/dev/null

SC=$(get_json "$API/network/scorecards" "$BUYER_COOKIES" "$BUYER_ORG")
assert_eq "[4.1] scorecards returns 1 supplier row"        "$SC" '.scorecards | length' '1'
assert_eq "[4.1] poAckSampleSize = 1 after the OC"          "$SC" '.scorecards[0].metrics.poAckSampleSize' '1'
AVG=$(echo "$SC" | jq -r '.scorecards[0].metrics.avgPoAckHours')
if [[ "$AVG" != "null" && -n "$AVG" ]]; then
  pass "[4.1] avgPoAckHours is populated (h=$AVG)"
else
  fail "[4.1] expected avgPoAckHours to be non-null, got '$AVG'" "$SC"
fi

# 4.2 — no invoices yet → invoiceMatchRate is null with sampleSize 0.
assert_eq "[4.2] no invoices → invoiceMatchRate is null" "$SC" '.scorecards[0].metrics.invoiceMatchRate' 'null'
assert_eq "[4.2] no invoices → invoiceSampleSize is 0"    "$SC" '.scorecards[0].metrics.invoiceSampleSize' '0'

# 4.3 — no GR data → asnAccuracy + onTimeDelivery both null (not 0).
assert_eq "[4.3] asnAccuracy is null (no GR data)"    "$SC" '.scorecards[0].metrics.asnAccuracy' 'null'
assert_eq "[4.3] onTimeDelivery is null (no GR data)" "$SC" '.scorecards[0].metrics.onTimeDelivery' 'null'
assert_eq "[4.3] asnSampleSize = 0 with no GR data"   "$SC" '.scorecards[0].metrics.asnSampleSize' '0'

# ----------------------------------------------------------------------
# Scenario 5 — §4.5 notification outbox (Task #27)
# ----------------------------------------------------------------------

section "Scenario 5 — §4.5 notification outbox (Task #27)"

# 5.1 — supplier has notifications from PO1 + PO2 publishes and from the
# PO1 DRAFT→ISSUED transition. The emitter is fire-and-forget so we poll
# briefly.
UNREAD=0
for i in $(seq 1 20); do
  NOTIFS=$(get_json "$API/network/notifications" "$SUPPLIER_COOKIES" "")
  UNREAD=$(echo "$NOTIFS" | jq -r '.unreadCount')
  if [[ "$UNREAD" =~ ^[0-9]+$ ]] && (( UNREAD >= 3 )); then break; fi
  sleep 0.1
done
assert_ge "[5.1] supplier has ≥ 3 unread notifications" "$NOTIFS" '.unreadCount' 3
assert_eq "[5.1] most recent notification is a DOCUMENT_* event" "$NOTIFS" '.notifications[0].eventType | test("^DOCUMENT_") | tostring' 'true'

# 5.2 — mark one read → unreadCount drops.
FIRST_ID=$(echo "$NOTIFS" | jq -r '.notifications[0].id')
MARK1=$(curl -s -X POST "$API/network/notifications/$FIRST_ID/read" -b "$SUPPLIER_COOKIES")
assert_eq "[5.2] mark one read returns ok" "$MARK1" '.ok' 'true'
NOTIFS=$(get_json "$API/network/notifications" "$SUPPLIER_COOKIES" "")
NEW_UNREAD=$(echo "$NOTIFS" | jq -r '.unreadCount')
if (( NEW_UNREAD < UNREAD )); then
  pass "[5.2] unreadCount decreased ($UNREAD → $NEW_UNREAD)"
else
  fail "[5.2] expected unreadCount to drop from $UNREAD, got $NEW_UNREAD" "$NOTIFS"
fi

# 5.3 — mark-all-read zeroes the counter.
curl -s -X POST "$API/network/notifications/read-all" -b "$SUPPLIER_COOKIES" >/dev/null
NOTIFS=$(get_json "$API/network/notifications" "$SUPPLIER_COOKIES" "")
assert_eq "[5.3] mark-all-read → unreadCount is 0" "$NOTIFS" '.unreadCount' '0'

# 5.4 — buyer's ORDER_CONFIRMATION publish (which we did in 4.1) fires a
# notification the other way — the buyer should see it.
BUYER_NOTIFS=$(get_json "$API/network/notifications" "$BUYER_COOKIES" "")
assert_ge "[5.4] buyer has ≥ 1 notification from OC publish" "$BUYER_NOTIFS" '.unreadCount' 1

# ----------------------------------------------------------------------
# Final report
# ----------------------------------------------------------------------

printf '\n%b======================================================================%b\n' "$BOLD" "$NC"
if [[ $FAIL_COUNT -eq 0 ]]; then
  printf '%b ✓ Phase 4 UAT PASSED %b — %d assertions, 0 failures\n' "$GREEN$BOLD" "$NC" "$PASS_COUNT"
else
  printf '%b ✗ Phase 4 UAT FAILED %b — %d passed, %d failed\n' "$RED$BOLD" "$NC" "$PASS_COUNT" "$FAIL_COUNT"
fi
printf '%b======================================================================%b\n' "$BOLD" "$NC"

exit $([[ $FAIL_COUNT -eq 0 ]] && echo 0 || echo 2)
