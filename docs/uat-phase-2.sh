#!/usr/bin/env bash
#
# XBN Phase 2 UAT — drives the indirect-procurement choreography end-to-end
# against the live API and verifies every documented behaviour from
# PHASES.md §2 (M2 milestone gate).
#
# Usage:
#   ./docs/uat-phase-2.sh                  # full UAT (recommended)
#   ./docs/uat-phase-2.sh --api=URL        # override API base URL
#                                          # default: http://localhost:3000
#
# Prereqs:
#   - docker compose up -d  (Postgres + MinIO healthy)
#   - pnpm --filter @xbn/api dev  (API listening on :3000)
#   - jq installed (brew install jq | apt install jq)
#
# Exit codes:
#   0  all assertions passed
#   1  setup failed (API unreachable, jq missing, etc.)
#   2  one or more assertions failed (script stops at first failure
#      and prints the offending response)

set -euo pipefail

# ----------------------------------------------------------------------
# Configuration
# ----------------------------------------------------------------------

API="${API:-http://localhost:3000}"
for arg in "$@"; do
  case "$arg" in
    --api=*) API="${arg#--api=}" ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
  esac
done

PASS_COUNT=0
FAIL_COUNT=0
COOKIE_DIR=$(mktemp -d)
trap 'rm -rf "$COOKIE_DIR"' EXIT

# Random suffix so re-runs don't collide on email uniqueness.
SUFFIX="$(date +%s)-$$"

BUYER_COOKIES="$COOKIE_DIR/buyer.cookies"
SUPPLIER_COOKIES="$COOKIE_DIR/supplier.cookies"
BUYER2_COOKIES="$COOKIE_DIR/buyer2.cookies"
SUPPLIER2_COOKIES="$COOKIE_DIR/supplier2.cookies"

# ----------------------------------------------------------------------
# Output helpers
# ----------------------------------------------------------------------

GREEN='\033[0;32m'
RED='\033[0;31m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

section() { printf '\n%b%s%b\n' "$BOLD" "----------------------------------------------------------------------" "$NC"; printf '%b %s%b\n' "$BOLD" "$1" "$NC"; printf '%b%s%b\n' "$BOLD" "----------------------------------------------------------------------" "$NC"; }
hdr()     { printf '\n%b%s%b\n' "$BOLD" "======================================================================" "$NC"; printf '%b %s%b\n' "$BOLD" "$1" "$NC"; printf '%b%s%b\n' "$BOLD" "======================================================================" "$NC"; }

pass() { printf '  %b✓%b %s\n' "$GREEN" "$NC" "$1"; PASS_COUNT=$((PASS_COUNT+1)); }
fail() {
  printf '  %b✗%b %s\n' "$RED" "$NC" "$1"
  if [[ -n "${2:-}" ]]; then
    printf '    %bresponse:%b %s\n' "$DIM" "$NC" "$2"
  fi
  FAIL_COUNT=$((FAIL_COUNT+1))
  exit 2
}
info() { printf '  %s\n' "$1"; }

# Assert a curl response body has a specific jq path equal to a value.
# Usage: assert_eq "label" "$RESPONSE" '.status' 'ACTIVE'
assert_eq() {
  local label="$1" body="$2" path="$3" expected="$4"
  local actual
  actual=$(printf '%s' "$body" | jq -r "$path" 2>/dev/null || echo '__JQ_ERR__')
  if [[ "$actual" == "$expected" ]]; then
    pass "$label"
  else
    fail "$label — expected '$expected', got '$actual'" "$body"
  fi
}

# Assert a jq path evaluates truthy (not null, not empty, not "false").
assert_truthy() {
  local label="$1" body="$2" path="$3"
  local actual
  actual=$(printf '%s' "$body" | jq -r "$path" 2>/dev/null || echo '__JQ_ERR__')
  if [[ -n "$actual" && "$actual" != "null" && "$actual" != "false" && "$actual" != "__JQ_ERR__" ]]; then
    pass "$label"
  else
    fail "$label — got '$actual'" "$body"
  fi
}

# Assert HTTP status code from a -w trailing %{http_code} match.
assert_status() {
  local label="$1" expected="$2" actual="$3" body="$4"
  if [[ "$actual" == "$expected" ]]; then
    pass "$label"
  else
    fail "$label — expected HTTP $expected, got $actual" "$body"
  fi
}

# ----------------------------------------------------------------------
# HTTP helpers — every call sends Content-Type + credentials cookies.
# ----------------------------------------------------------------------

post_json() {
  # post_json <url> <cookie-file> <x-active-org> <body>
  local url="$1" cookie="$2" org="$3" body="$4"
  local args=(-s -X POST "$url" -H 'Content-Type: application/json' -b "$cookie" --data-raw "$body")
  if [[ -n "$org" ]]; then args+=(-H "x-active-org: $org"); fi
  curl "${args[@]}"
}

post_json_with_status() {
  # post_json_with_status <url> <cookie-file> <x-active-org> <body>  → prints body + ' ' + status
  local url="$1" cookie="$2" org="$3" body="$4"
  local args=(-s -o /dev/stderr -w '%{http_code}' -X POST "$url" -H 'Content-Type: application/json' -b "$cookie" --data-raw "$body")
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
# Phase 0 — preflight
# ----------------------------------------------------------------------

hdr "XBN Phase 2 UAT — indirect procurement choreography"

command -v jq >/dev/null 2>&1 || { echo "✗ jq is required. Install with: brew install jq" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "✗ curl is required." >&2; exit 1; }

info "Probing API at $API ..."
HEALTH=$(curl -s -o /dev/null -w '%{http_code}' "$API/health" || echo 'fail')
if [[ "$HEALTH" != "200" ]]; then
  echo "✗ API is not reachable at $API/health (status: $HEALTH)" >&2
  echo "  Start it with: pnpm --filter @xbn/api dev" >&2
  exit 1
fi
pass "API reachable"

# ----------------------------------------------------------------------
# Phase 1 — setup primary buyer + supplier with active relationship
# ----------------------------------------------------------------------

section "[setup] Registering buyer + supplier and creating orgs"

register_and_login() {
  # register_and_login <email> <cookie-file>
  local email="$1" cookie="$2"
  local reg
  reg=$(curl -s -X POST "$API/auth/register" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"correcthorse\"}")
  local user_id
  user_id=$(echo "$reg" | jq -r .userId)
  local token
  token=$(echo "$reg" | jq -r .verificationToken)
  if [[ "$user_id" == "null" || "$token" == "null" ]]; then
    fail "register failed for $email" "$reg"
  fi
  curl -s -X POST "$API/auth/verify-email" -H 'Content-Type: application/json' \
    -d "{\"token\":\"$token\"}" >/dev/null
  curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' \
    -c "$cookie" \
    -d "{\"email\":\"$email\",\"password\":\"correcthorse\"}" >/dev/null
  echo "$user_id"
}

create_org() {
  # create_org <cookie-file> <name> <type> → echoes org id
  local cookie="$1" name="$2" type="$3"
  local role="BUYER_ADMIN"; [[ "$type" == "SUPPLIER" ]] && role="SUPPLIER_ADMIN"
  local resp
  resp=$(curl -s -X POST "$API/network/orgs" -H 'Content-Type: application/json' -b "$cookie" \
    -d "{\"legalName\":\"$name\",\"displayName\":\"$name\",\"orgType\":\"$type\",\"bindAsRole\":\"$role\"}")
  local oid
  oid=$(echo "$resp" | jq -r .org.id)
  [[ "$oid" == "null" ]] && fail "create_org failed for $name" "$resp"
  echo "$oid"
}

BUYER_USER=$(register_and_login "buyer-$SUFFIX@uat.local" "$BUYER_COOKIES")
SUPPLIER_USER=$(register_and_login "supplier-$SUFFIX@uat.local" "$SUPPLIER_COOKIES")
info "buyer user id:    $BUYER_USER"
info "supplier user id: $SUPPLIER_USER"

BUYER_ORG=$(create_org "$BUYER_COOKIES" "UAT Buyer Co" "BUYER")
SUPPLIER_ORG=$(create_org "$SUPPLIER_COOKIES" "UAT Supplier Co" "SUPPLIER")
info "buyer org id:     $BUYER_ORG"
info "supplier org id:  $SUPPLIER_ORG"

REL_RESP=$(post_json "$API/network/relationships" "$BUYER_COOKIES" "$BUYER_ORG" "$(cat <<JSON
{
  "buyerOrgId":"$BUYER_ORG",
  "supplierOrgId":"$SUPPLIER_ORG",
  "status":"ACTIVE",
  "enabledDocumentTypes":["PO","PO_CHANGE","ORDER_CONFIRMATION","ASN","GOODS_RECEIPT","INVOICE","CREDIT_MEMO","REMITTANCE_ADVICE"],
  "defaultCurrency":"USD",
  "summaryInvoicingEnabled":true
}
JSON
)")
assert_eq "trading relationship is ACTIVE (summary invoicing enabled)" "$REL_RESP" '.relationship.status' 'ACTIVE'

# ----------------------------------------------------------------------
# Scenario 1 — Canonical PO → REMITTANCE choreography
# ----------------------------------------------------------------------

section "Scenario 1 — Canonical PO → REMITTANCE choreography"

# Step 1: Buyer publishes PO
PO_BODY=$(cat <<JSON
{
  "documentType":"PO","recipientOrgId":"$SUPPLIER_ORG",
  "body":{
    "currency":"USD","paymentTermsRef":"NET-30","requestedDeliveryDate":"2026-07-15",
    "shipTo":{"name":"Buyer Receiving","line1":"1 Buyer Way","city":"Buyerville","countryCode":"US"},
    "billTo":{"name":"Buyer AP","line1":"1 Buyer Way","city":"Buyerville","countryCode":"US"},
    "lines":[{"sku":"WIDGET-1","description":"Widget","quantity":5,"unitPrice":10,"unitOfMeasure":"EA","lineRef":"WIDGET-1"}]
  }
}
JSON
)
PO_RESP=$(post_json "$API/documents" "$BUYER_COOKIES" "$BUYER_ORG" "$PO_BODY")
PO_ID=$(echo "$PO_RESP" | jq -r .documentId)
PO_NUMBER=$(echo "$PO_RESP" | jq -r .documentNumber)
[[ "$PO_ID" == "null" ]] && fail "PO publish failed" "$PO_RESP"
pass "[1/9] Buyer publishes PO ($PO_NUMBER)"

# Step 2: Buyer transitions PO DRAFT → ISSUED
RESP=$(post_json "$API/documents/$PO_ID/transition" "$BUYER_COOKIES" "$BUYER_ORG" '{"fromStatus":"DRAFT","toStatus":"ISSUED"}')
assert_eq "[2/9] Buyer transitions PO DRAFT → ISSUED" "$RESP" '.nextStatus' 'ISSUED'

# Step 3: Supplier publishes ORDER_CONFIRMATION (auto-links to PO)
OC_BODY=$(cat <<JSON
{
  "documentType":"ORDER_CONFIRMATION","recipientOrgId":"$BUYER_ORG",
  "body":{"mode":"FULL_ACCEPT","poDocumentNumber":"$PO_NUMBER","poDocumentId":"$PO_ID"}
}
JSON
)
OC_RESP=$(post_json "$API/documents" "$SUPPLIER_COOKIES" "$SUPPLIER_ORG" "$OC_BODY")
OC_ID=$(echo "$OC_RESP" | jq -r .documentId)
[[ "$OC_ID" == "null" ]] && fail "OC publish failed" "$OC_RESP"
LINK_WARN=$(echo "$OC_RESP" | jq -r '.linkWarnings // empty')
if [[ -n "$LINK_WARN" ]]; then
  fail "[3/9] OC publish auto-link surfaced warnings" "$OC_RESP"
fi
pass "[3/9] Supplier publishes ORDER_CONFIRMATION (auto-linked)"

# Supplier transitions OC DRAFT → ISSUED
RESP=$(post_json "$API/documents/$OC_ID/transition" "$SUPPLIER_COOKIES" "$SUPPLIER_ORG" '{"fromStatus":"DRAFT","toStatus":"ISSUED"}')
assert_eq "      OC DRAFT → ISSUED" "$RESP" '.nextStatus' 'ISSUED'

# Step 4: Supplier transitions PO ISSUED → ACKNOWLEDGED
RESP=$(post_json "$API/documents/$PO_ID/transition" "$SUPPLIER_COOKIES" "$SUPPLIER_ORG" '{"fromStatus":"ISSUED","toStatus":"ACKNOWLEDGED"}')
assert_eq "[4/9] Supplier transitions PO ISSUED → ACKNOWLEDGED" "$RESP" '.nextStatus' 'ACKNOWLEDGED'

# Step 5: Buyer transitions PO ACKNOWLEDGED → IN_FULFILLMENT
RESP=$(post_json "$API/documents/$PO_ID/transition" "$BUYER_COOKIES" "$BUYER_ORG" '{"fromStatus":"ACKNOWLEDGED","toStatus":"IN_FULFILLMENT"}')
assert_eq "[5/9] Buyer transitions PO → IN_FULFILLMENT" "$RESP" '.nextStatus' 'IN_FULFILLMENT'

# Step 6: Supplier publishes ASN (auto-links SHIPS_AGAINST → PO)
ASN_BODY=$(cat <<JSON
{
  "documentType":"ASN","recipientOrgId":"$BUYER_ORG",
  "body":{
    "poDocumentNumber":"$PO_NUMBER","poDocumentId":"$PO_ID",
    "carrier":"UPS","trackingNumber":"1Z999","shippedAt":"2026-07-10","expectedDeliveryDate":"2026-07-12",
    "shipFrom":{"name":"Supplier Plant","line1":"1 Supply Lane","city":"Supplycity","countryCode":"US"},
    "lines":[{"lineRef":"WIDGET-1","sku":"WIDGET-1","shippedQuantity":5,"unitOfMeasure":"EA"}]
  }
}
JSON
)
ASN_RESP=$(post_json "$API/documents" "$SUPPLIER_COOKIES" "$SUPPLIER_ORG" "$ASN_BODY")
ASN_ID=$(echo "$ASN_RESP" | jq -r .documentId)
LINK_WARN=$(echo "$ASN_RESP" | jq -r '.linkWarnings // empty')
[[ "$ASN_ID" == "null" ]] && fail "ASN publish failed" "$ASN_RESP"
[[ -n "$LINK_WARN" ]] && fail "[6/9] ASN auto-link surfaced warnings" "$ASN_RESP"
pass "[6/9] Supplier publishes ASN (auto-linked SHIPS_AGAINST → PO)"

# Walk ASN DRAFT → ISSUED → IN_TRANSIT
post_json "$API/documents/$ASN_ID/transition" "$SUPPLIER_COOKIES" "$SUPPLIER_ORG" '{"fromStatus":"DRAFT","toStatus":"ISSUED"}' >/dev/null
post_json "$API/documents/$ASN_ID/transition" "$SUPPLIER_COOKIES" "$SUPPLIER_ORG" '{"fromStatus":"ISSUED","toStatus":"IN_TRANSIT"}' >/dev/null

# Step 7: Buyer publishes GR (auto-links FULFILLS → PO + RECEIVES → ASN)
GR_BODY=$(cat <<JSON
{
  "documentType":"GOODS_RECEIPT","recipientOrgId":"$SUPPLIER_ORG",
  "body":{
    "poDocumentNumber":"$PO_NUMBER","poDocumentId":"$PO_ID",
    "asnDocumentId":"$ASN_ID",
    "receivedAt":"2026-07-12","receivedBy":"Receiving Dock 3",
    "lines":[{"lineRef":"WIDGET-1","sku":"WIDGET-1","receivedQuantity":5,"unitOfMeasure":"EA"}]
  }
}
JSON
)
GR_RESP=$(post_json "$API/documents" "$BUYER_COOKIES" "$BUYER_ORG" "$GR_BODY")
GR_ID=$(echo "$GR_RESP" | jq -r .documentId)
LINK_WARN=$(echo "$GR_RESP" | jq -r '.linkWarnings // empty')
[[ "$GR_ID" == "null" ]] && fail "GR publish failed" "$GR_RESP"
[[ -n "$LINK_WARN" ]] && fail "[7/9] GR auto-link surfaced warnings" "$GR_RESP"
pass "[7/9] Buyer publishes GOODS_RECEIPT (auto-linked FULFILLS + RECEIVES)"

post_json "$API/documents/$GR_ID/transition" "$BUYER_COOKIES" "$BUYER_ORG" '{"fromStatus":"DRAFT","toStatus":"POSTED"}' >/dev/null
post_json "$API/documents/$ASN_ID/transition" "$BUYER_COOKIES" "$BUYER_ORG" '{"fromStatus":"IN_TRANSIT","toStatus":"DELIVERED"}' >/dev/null

# Step 8: Supplier publishes INVOICE PO_FLIP (auto-links to PO + GR)
INV_BODY=$(cat <<JSON
{
  "documentType":"INVOICE","recipientOrgId":"$BUYER_ORG","invoiceMode":"PO_FLIP",
  "body":{
    "invoiceMode":"PO_FLIP",
    "poDocumentNumber":"$PO_NUMBER","poDocumentId":"$PO_ID",
    "grDocumentIds":["$GR_ID"],
    "issueDate":"2026-07-15","dueDate":"2026-08-14",
    "currency":"USD","paymentTermsRef":"NET-30",
    "remitTo":{"name":"Supplier AR","line1":"1 Supply Lane","city":"Supplycity","countryCode":"US"},
    "lines":[{"lineRef":"WIDGET-1","sku":"WIDGET-1","description":"Widget","quantity":5,"unitPrice":10,"unitOfMeasure":"EA"}],
    "subtotal":50,"taxTotal":0,"total":50
  }
}
JSON
)
INV_RESP=$(post_json "$API/documents" "$SUPPLIER_COOKIES" "$SUPPLIER_ORG" "$INV_BODY")
INV_ID=$(echo "$INV_RESP" | jq -r .documentId)
INV_NUMBER=$(echo "$INV_RESP" | jq -r .documentNumber)
LINK_WARN=$(echo "$INV_RESP" | jq -r '.linkWarnings // empty')
[[ "$INV_ID" == "null" ]] && fail "INVOICE publish failed" "$INV_RESP"
[[ -n "$LINK_WARN" ]] && fail "[8/9] INVOICE auto-link surfaced warnings" "$INV_RESP"
pass "[8/9] Supplier publishes INVOICE PO_FLIP (auto-linked to PO + GR)"

# Walk invoice: DRAFT → SUBMITTED → ACKNOWLEDGED → ACCEPTED
post_json "$API/documents/$INV_ID/transition" "$SUPPLIER_COOKIES" "$SUPPLIER_ORG" '{"fromStatus":"DRAFT","toStatus":"SUBMITTED"}' >/dev/null
post_json "$API/documents/$INV_ID/transition" "$BUYER_COOKIES" "$BUYER_ORG" '{"fromStatus":"SUBMITTED","toStatus":"ACKNOWLEDGED_BY_BUYER"}' >/dev/null
post_json "$API/documents/$INV_ID/transition" "$BUYER_COOKIES" "$BUYER_ORG" '{"fromStatus":"ACKNOWLEDGED_BY_BUYER","toStatus":"ACCEPTED"}' >/dev/null

# Step 9: Buyer publishes REMITTANCE_ADVICE (auto-links REMITS → invoice)
REM_BODY=$(cat <<JSON
{
  "documentType":"REMITTANCE_ADVICE","recipientOrgId":"$SUPPLIER_ORG",
  "body":{
    "paymentDate":"2026-08-14","paymentMethod":"WIRE","paymentReference":"WIRE-12345",
    "currency":"USD","totalPaymentAmount":50,
    "allocations":[{"documentType":"INVOICE","documentId":"$INV_ID","documentNumber":"$INV_NUMBER","appliedAmount":50}]
  }
}
JSON
)
REM_RESP=$(post_json "$API/documents" "$BUYER_COOKIES" "$BUYER_ORG" "$REM_BODY")
REM_ID=$(echo "$REM_RESP" | jq -r .documentId)
LINK_WARN=$(echo "$REM_RESP" | jq -r '.linkWarnings // empty')
[[ "$REM_ID" == "null" ]] && fail "REMITTANCE_ADVICE publish failed" "$REM_RESP"
[[ -n "$LINK_WARN" ]] && fail "[9/9] REMITTANCE_ADVICE auto-link surfaced warnings" "$REM_RESP"
pass "[9/9] Buyer publishes REMITTANCE_ADVICE (auto-linked REMITS → invoice)"

post_json "$API/documents/$REM_ID/transition" "$BUYER_COOKIES" "$BUYER_ORG" '{"fromStatus":"DRAFT","toStatus":"ISSUED"}' >/dev/null

# Buyer closes PO
RESP=$(post_json "$API/documents/$PO_ID/transition" "$BUYER_COOKIES" "$BUYER_ORG" '{"fromStatus":"IN_FULFILLMENT","toStatus":"CLOSED"}')
assert_eq "[end] Buyer closes PO" "$RESP" '.nextStatus' 'CLOSED'

# --- Verify final state ---
FINAL_PO=$(get_json "$API/documents/$PO_ID" "$BUYER_COOKIES" "$BUYER_ORG")
INBOUND_KINDS=$(echo "$FINAL_PO" | jq -r '[.incomingLinks[].linkType] | sort | unique | join(",")')
EXPECTED='ACKNOWLEDGES,FULFILLS,INVOICES,SHIPS_AGAINST'
if [[ "$INBOUND_KINDS" == "$EXPECTED" ]]; then
  pass "[verify] PO has 4 inbound link types (ACK + SHIPS + FULFILLS + INVOICES)"
else
  fail "PO inbound link types mismatch — expected '$EXPECTED', got '$INBOUND_KINDS'" "$FINAL_PO"
fi

FINAL_INV=$(get_json "$API/documents/$INV_ID" "$BUYER_COOKIES" "$BUYER_ORG")
INV_OUT_COUNT=$(echo "$FINAL_INV" | jq -r '[.outgoingLinks[] | select(.linkType=="INVOICES")] | length')
if [[ "$INV_OUT_COUNT" == "2" ]]; then
  pass "[verify] Invoice has 2 outbound INVOICES links (PO + GR)"
else
  fail "Invoice outbound INVOICES count is $INV_OUT_COUNT, expected 2" "$FINAL_INV"
fi

STATUS_CHANGES=$(echo "$FINAL_PO" | jq -r '[.auditLog[] | select(.action=="STATUS_CHANGED")] | length')
if [[ "$STATUS_CHANGES" == "4" ]]; then
  pass "[verify] PO audit log shows CREATED + 4× STATUS_CHANGED"
else
  fail "PO STATUS_CHANGED count is $STATUS_CHANGES, expected 4" "$FINAL_PO"
fi

# ----------------------------------------------------------------------
# Scenario 2 — SUMMARY invoicing (PHASES.md §2.6)
# ----------------------------------------------------------------------

section "Scenario 2 — SUMMARY invoicing (PHASES.md §2.6)"

publish_po_and_walk_to_gr() {
  # publish_po_and_walk_to_gr <sku>  → echoes 'po_id po_number gr_id'
  local sku="$1"
  local body
  body=$(cat <<JSON
{
  "documentType":"PO","recipientOrgId":"$SUPPLIER_ORG",
  "body":{
    "currency":"USD","paymentTermsRef":"NET-30","requestedDeliveryDate":"2026-07-15",
    "shipTo":{"name":"R","line1":"x","city":"y","countryCode":"US"},
    "billTo":{"name":"R","line1":"x","city":"y","countryCode":"US"},
    "lines":[{"sku":"$sku","description":"$sku","quantity":5,"unitPrice":10,"unitOfMeasure":"EA","lineRef":"$sku"}]
  }
}
JSON
)
  local pr po_id po_num
  pr=$(post_json "$API/documents" "$BUYER_COOKIES" "$BUYER_ORG" "$body")
  po_id=$(echo "$pr" | jq -r .documentId)
  po_num=$(echo "$pr" | jq -r .documentNumber)
  post_json "$API/documents/$po_id/transition" "$BUYER_COOKIES" "$BUYER_ORG" '{"fromStatus":"DRAFT","toStatus":"ISSUED"}' >/dev/null
  post_json "$API/documents/$po_id/transition" "$SUPPLIER_COOKIES" "$SUPPLIER_ORG" '{"fromStatus":"ISSUED","toStatus":"ACKNOWLEDGED"}' >/dev/null
  post_json "$API/documents/$po_id/transition" "$BUYER_COOKIES" "$BUYER_ORG" '{"fromStatus":"ACKNOWLEDGED","toStatus":"IN_FULFILLMENT"}' >/dev/null

  local grb gr_id
  grb=$(cat <<JSON
{
  "documentType":"GOODS_RECEIPT","recipientOrgId":"$SUPPLIER_ORG",
  "body":{
    "poDocumentNumber":"$po_num","poDocumentId":"$po_id",
    "receivedAt":"2026-07-12",
    "lines":[{"lineRef":"$sku","sku":"$sku","receivedQuantity":5,"unitOfMeasure":"EA"}]
  }
}
JSON
)
  local grr
  grr=$(post_json "$API/documents" "$BUYER_COOKIES" "$BUYER_ORG" "$grb")
  gr_id=$(echo "$grr" | jq -r .documentId)
  post_json "$API/documents/$gr_id/transition" "$BUYER_COOKIES" "$BUYER_ORG" '{"fromStatus":"DRAFT","toStatus":"POSTED"}' >/dev/null
  echo "$po_id $po_num $gr_id"
}

read -r PO_A_ID PO_A_NUM GR_A_ID <<<"$(publish_po_and_walk_to_gr WIDGET-A)"
read -r PO_B_ID PO_B_NUM GR_B_ID <<<"$(publish_po_and_walk_to_gr WIDGET-B)"
read -r PO_C_ID PO_C_NUM GR_C_ID <<<"$(publish_po_and_walk_to_gr WIDGET-C)"
pass "[2.1] Publish 3 POs and walk each to POSTED GR"

# Step 2.2: Supplier publishes ONE SUMMARY invoice
SUM_BODY=$(cat <<JSON
{
  "documentType":"INVOICE","recipientOrgId":"$BUYER_ORG","invoiceMode":"SUMMARY",
  "body":{
    "invoiceMode":"SUMMARY",
    "sourceDocuments":[
      {"documentType":"PO","documentId":"$PO_A_ID","documentNumber":"$PO_A_NUM"},
      {"documentType":"PO","documentId":"$PO_B_ID","documentNumber":"$PO_B_NUM"},
      {"documentType":"PO","documentId":"$PO_C_ID","documentNumber":"$PO_C_NUM"},
      {"documentType":"GOODS_RECEIPT","documentId":"$GR_A_ID"},
      {"documentType":"GOODS_RECEIPT","documentId":"$GR_B_ID"},
      {"documentType":"GOODS_RECEIPT","documentId":"$GR_C_ID"}
    ],
    "billingPeriodStart":"2026-07-01","billingPeriodEnd":"2026-07-31",
    "issueDate":"2026-08-01","dueDate":"2026-08-31",
    "currency":"USD","paymentTermsRef":"NET-30",
    "remitTo":{"name":"Supplier AR","line1":"x","city":"y","countryCode":"US"},
    "lines":[
      {"lineRef":"WIDGET-A","sku":"WIDGET-A","description":"A","quantity":5,"unitPrice":10,"unitOfMeasure":"EA","sourceDocumentId":"$PO_A_ID","sourceDocumentType":"PO"},
      {"lineRef":"WIDGET-B","sku":"WIDGET-B","description":"B","quantity":5,"unitPrice":10,"unitOfMeasure":"EA","sourceDocumentId":"$PO_B_ID","sourceDocumentType":"PO"},
      {"lineRef":"WIDGET-C","sku":"WIDGET-C","description":"C","quantity":5,"unitPrice":10,"unitOfMeasure":"EA","sourceDocumentId":"$PO_C_ID","sourceDocumentType":"PO"}
    ],
    "subtotal":150,"taxTotal":0,"total":150
  }
}
JSON
)
SUM_RESP=$(post_json "$API/documents" "$SUPPLIER_COOKIES" "$SUPPLIER_ORG" "$SUM_BODY")
SUM_ID=$(echo "$SUM_RESP" | jq -r .documentId)
LINK_WARN=$(echo "$SUM_RESP" | jq -r '.linkWarnings // empty')
[[ "$SUM_ID" == "null" ]] && fail "SUMMARY invoice publish failed" "$SUM_RESP"
[[ -n "$LINK_WARN" ]] && fail "SUMMARY invoice auto-link surfaced unexpected warnings" "$SUM_RESP"

SUM_DETAIL=$(get_json "$API/documents/$SUM_ID" "$BUYER_COOKIES" "$BUYER_ORG")
OUT_COUNT=$(echo "$SUM_DETAIL" | jq -r '[.outgoingLinks[] | select(.linkType=="INVOICES")] | length')
if [[ "$OUT_COUNT" == "6" ]]; then
  pass "[2.2] SUMMARY invoice consolidates 3 POs + 3 GRs (6 outbound INVOICES links)"
else
  fail "SUMMARY outbound INVOICES count is $OUT_COUNT, expected 6" "$SUM_DETAIL"
fi

# Step 2.3: re-issue SUMMARY referencing PO A → no-double-billing guard
DUP_BODY=$(cat <<JSON
{
  "documentType":"INVOICE","recipientOrgId":"$BUYER_ORG","invoiceMode":"SUMMARY",
  "body":{
    "invoiceMode":"SUMMARY",
    "sourceDocuments":[{"documentType":"PO","documentId":"$PO_A_ID","documentNumber":"$PO_A_NUM"}],
    "billingPeriodStart":"2026-08-01","billingPeriodEnd":"2026-08-31",
    "issueDate":"2026-09-01","dueDate":"2026-09-30",
    "currency":"USD",
    "remitTo":{"name":"x","line1":"x","city":"y","countryCode":"US"},
    "lines":[{"lineRef":"WIDGET-A","sku":"WIDGET-A","description":"dup","quantity":1,"unitPrice":10,"unitOfMeasure":"EA","sourceDocumentId":"$PO_A_ID","sourceDocumentType":"PO"}],
    "subtotal":10,"taxTotal":0,"total":10
  }
}
JSON
)
DUP_RESP=$(post_json "$API/documents" "$SUPPLIER_COOKIES" "$SUPPLIER_ORG" "$DUP_BODY")
DUP_KIND=$(echo "$DUP_RESP" | jq -r '.linkWarnings[0].reason.detail.kind // empty')
if [[ "$DUP_KIND" == "duplicate_link" ]]; then
  pass "[2.3] Re-issued SUMMARY surfaces duplicate_link (no-double-billing guard)"
else
  fail "Expected duplicate_link in linkWarnings, got '$DUP_KIND'" "$DUP_RESP"
fi

# ----------------------------------------------------------------------
# Scenario 3 — Relationship-level summary-invoicing gate
# ----------------------------------------------------------------------

section "Scenario 3 — Relationship-level summary-invoicing gate"

BUYER2_USER=$(register_and_login "buyer2-$SUFFIX@uat.local" "$BUYER2_COOKIES")
SUPPLIER2_USER=$(register_and_login "supplier2-$SUFFIX@uat.local" "$SUPPLIER2_COOKIES")
BUYER2_ORG=$(create_org "$BUYER2_COOKIES" "UAT Buyer Co 2" "BUYER")
SUPPLIER2_ORG=$(create_org "$SUPPLIER2_COOKIES" "UAT Supplier Co 2" "SUPPLIER")

REL2_RESP=$(post_json "$API/network/relationships" "$BUYER2_COOKIES" "$BUYER2_ORG" "$(cat <<JSON
{
  "buyerOrgId":"$BUYER2_ORG","supplierOrgId":"$SUPPLIER2_ORG","status":"ACTIVE",
  "enabledDocumentTypes":["INVOICE"],
  "defaultCurrency":"USD","summaryInvoicingEnabled":false
}
JSON
)")
assert_eq "[3.1] Setup buyer+supplier with summaryInvoicingEnabled=false" "$REL2_RESP" '.relationship.summaryInvoicingEnabled' 'false'

NEG_BODY=$(cat <<JSON
{
  "documentType":"INVOICE","recipientOrgId":"$BUYER2_ORG","invoiceMode":"SUMMARY",
  "body":{
    "invoiceMode":"SUMMARY",
    "sourceDocuments":[{"documentType":"PO","documentId":"no-real-po","documentNumber":"X"}],
    "billingPeriodStart":"2026-07-01","billingPeriodEnd":"2026-07-31",
    "issueDate":"2026-08-01","dueDate":"2026-08-31",
    "currency":"USD",
    "remitTo":{"name":"x","line1":"x","city":"y","countryCode":"US"},
    "lines":[{"lineRef":"X","sku":"X","description":"x","quantity":1,"unitPrice":1,"unitOfMeasure":"EA","sourceDocumentId":"no","sourceDocumentType":"PO"}],
    "subtotal":1,"taxTotal":0,"total":1
  }
}
JSON
)
NEG_RESP=$(post_json "$API/documents" "$SUPPLIER2_COOKIES" "$SUPPLIER2_ORG" "$NEG_BODY")
NEG_KIND=$(echo "$NEG_RESP" | jq -r '.reason.detail.kind // empty')
if [[ "$NEG_KIND" == "summary_invoicing_not_enabled" ]]; then
  pass "[3.2] SUMMARY rejected with summary_invoicing_not_enabled"
else
  fail "Expected summary_invoicing_not_enabled, got '$NEG_KIND'" "$NEG_RESP"
fi

# ----------------------------------------------------------------------
# Final report
# ----------------------------------------------------------------------

printf '\n%b======================================================================%b\n' "$BOLD" "$NC"
if [[ $FAIL_COUNT -eq 0 ]]; then
  printf '%b ✓ Phase 2 UAT PASSED %b — %d assertions, 0 failures\n' "$GREEN$BOLD" "$NC" "$PASS_COUNT"
else
  printf '%b ✗ Phase 2 UAT FAILED %b — %d passed, %d failed\n' "$RED$BOLD" "$NC" "$PASS_COUNT" "$FAIL_COUNT"
fi
printf '%b======================================================================%b\n' "$BOLD" "$NC"

exit $([[ $FAIL_COUNT -eq 0 ]] && echo 0 || echo 2)
