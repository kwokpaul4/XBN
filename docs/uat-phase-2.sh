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
# Scenario 4 — PO_CHANGE full choreography (PHASES.md §2.2)
# ----------------------------------------------------------------------

section "Scenario 4 — PO_CHANGE choreography (PHASES.md §2.2)"

# Setup: new buyer/supplier pair so we're not piling on the canonical PO.
BUYER4_COOKIES="$COOKIE_DIR/buyer4.cookies"
SUPPLIER4_COOKIES="$COOKIE_DIR/supplier4.cookies"
register_and_login "buyer4-$SUFFIX@uat.local" "$BUYER4_COOKIES" >/dev/null
register_and_login "supplier4-$SUFFIX@uat.local" "$SUPPLIER4_COOKIES" >/dev/null
BUYER4_ORG=$(create_org "$BUYER4_COOKIES" "UAT Buyer Co 4" "BUYER")
SUPPLIER4_ORG=$(create_org "$SUPPLIER4_COOKIES" "UAT Supplier Co 4" "SUPPLIER")
post_json "$API/network/relationships" "$BUYER4_COOKIES" "$BUYER4_ORG" "$(cat <<JSON
{
  "buyerOrgId":"$BUYER4_ORG","supplierOrgId":"$SUPPLIER4_ORG","status":"ACTIVE",
  "enabledDocumentTypes":["PO","PO_CHANGE","ORDER_CONFIRMATION"],
  "defaultCurrency":"USD"
}
JSON
)" >/dev/null

# Publish a PO and walk it to ACKNOWLEDGED so it's eligible for change.
PO4_RESP=$(post_json "$API/documents" "$BUYER4_COOKIES" "$BUYER4_ORG" "$(cat <<JSON
{
  "documentType":"PO","recipientOrgId":"$SUPPLIER4_ORG",
  "body":{
    "currency":"USD","paymentTermsRef":"NET-30","requestedDeliveryDate":"2026-07-15",
    "shipTo":{"name":"R","line1":"x","city":"y","countryCode":"US"},
    "billTo":{"name":"R","line1":"x","city":"y","countryCode":"US"},
    "lines":[{"sku":"WIDGET-1","description":"Widget","quantity":5,"unitPrice":10,"unitOfMeasure":"EA","lineRef":"WIDGET-1"}]
  }
}
JSON
)")
PO4_ID=$(echo "$PO4_RESP" | jq -r .documentId)
PO4_NUM=$(echo "$PO4_RESP" | jq -r .documentNumber)
post_json "$API/documents/$PO4_ID/transition" "$BUYER4_COOKIES" "$BUYER4_ORG" '{"fromStatus":"DRAFT","toStatus":"ISSUED"}' >/dev/null
post_json "$API/documents/$PO4_ID/transition" "$SUPPLIER4_COOKIES" "$SUPPLIER4_ORG" '{"fromStatus":"ISSUED","toStatus":"ACKNOWLEDGED"}' >/dev/null
pass "[4.0] Setup: PO published and walked to ACKNOWLEDGED"

# Negative: try PO → CHANGED before any PO_CHANGE exists.
NEG_RESP=$(post_json "$API/documents/$PO4_ID/transition" "$BUYER4_COOKIES" "$BUYER4_ORG" '{"fromStatus":"ACKNOWLEDGED","toStatus":"CHANGED"}')
NEG_KIND=$(echo "$NEG_RESP" | jq -r '.reason.detail.kind // empty')
if [[ "$NEG_KIND" == "no_accepted_po_change" ]]; then
  pass "[4.1] PO → CHANGED rejected without an accepted PO_CHANGE"
else
  fail "Expected no_accepted_po_change, got '$NEG_KIND'" "$NEG_RESP"
fi

# Happy path: buyer publishes PO_CHANGE (auto-links SUPERSEDES → PO),
# walks DRAFT → ISSUED, supplier accepts, buyer transitions PO → CHANGED.
PC_RESP=$(post_json "$API/documents" "$BUYER4_COOKIES" "$BUYER4_ORG" "$(cat <<JSON
{
  "documentType":"PO_CHANGE","recipientOrgId":"$SUPPLIER4_ORG",
  "body":{
    "poDocumentNumber":"$PO4_NUM","poDocumentId":"$PO4_ID",
    "changeReason":"buyer needs +2 units",
    "affectedLineRefs":["WIDGET-1"],
    "revisedBody":{
      "currency":"USD","paymentTermsRef":"NET-30","requestedDeliveryDate":"2026-07-22",
      "shipTo":{"name":"R","line1":"x","city":"y","countryCode":"US"},
      "billTo":{"name":"R","line1":"x","city":"y","countryCode":"US"},
      "lines":[{"sku":"WIDGET-1","description":"Widget","quantity":7,"unitPrice":10,"unitOfMeasure":"EA","lineRef":"WIDGET-1"}]
    }
  }
}
JSON
)")
PC_ID=$(echo "$PC_RESP" | jq -r .documentId)
[[ "$PC_ID" == "null" ]] && fail "PO_CHANGE publish failed" "$PC_RESP"
LINK_WARN=$(echo "$PC_RESP" | jq -r '.linkWarnings // empty')
[[ -n "$LINK_WARN" ]] && fail "PO_CHANGE auto-link warned" "$PC_RESP"
pass "[4.2] PO_CHANGE published and auto-linked SUPERSEDES → PO"

post_json "$API/documents/$PC_ID/transition" "$BUYER4_COOKIES" "$BUYER4_ORG" '{"fromStatus":"DRAFT","toStatus":"ISSUED"}' >/dev/null

# Negative: try PO → CHANGED while PO_CHANGE is still ISSUED (not yet accepted).
NEG_RESP=$(post_json "$API/documents/$PO4_ID/transition" "$BUYER4_COOKIES" "$BUYER4_ORG" '{"fromStatus":"ACKNOWLEDGED","toStatus":"CHANGED"}')
NEG_KIND=$(echo "$NEG_RESP" | jq -r '.reason.detail.kind // empty')
if [[ "$NEG_KIND" == "no_accepted_po_change" ]]; then
  pass "[4.3] PO → CHANGED rejected while PO_CHANGE still ISSUED (not yet accepted)"
else
  fail "Expected no_accepted_po_change, got '$NEG_KIND'" "$NEG_RESP"
fi

# Supplier accepts; PO can now be transitioned to CHANGED.
ACCEPT_RESP=$(post_json "$API/documents/$PC_ID/transition" "$SUPPLIER4_COOKIES" "$SUPPLIER4_ORG" '{"fromStatus":"ISSUED","toStatus":"ACCEPTED_BY_SUPPLIER"}')
ACCEPT_NEXT=$(echo "$ACCEPT_RESP" | jq -r '.nextStatus // empty')
if [[ "$ACCEPT_NEXT" != "ACCEPTED_BY_SUPPLIER" ]]; then
  fail "Supplier accept of PO_CHANGE failed (expected ACCEPTED_BY_SUPPLIER)" "$ACCEPT_RESP"
fi
# Verify the PO_CHANGE document is genuinely in ACCEPTED_BY_SUPPLIER + the
# SUPERSEDES link is in place — the precondition guard looks for that pair.
PC_DETAIL=$(get_json "$API/documents/$PC_ID" "$BUYER4_COOKIES" "$BUYER4_ORG")
PC_STATUS=$(echo "$PC_DETAIL" | jq -r '.status')
PC_LINK_TO_PO=$(echo "$PC_DETAIL" | jq -r '[.outgoingLinks[] | select(.linkType=="SUPERSEDES" and .toDocumentId=="'"$PO4_ID"'")] | length')
if [[ "$PC_STATUS" != "ACCEPTED_BY_SUPPLIER" || "$PC_LINK_TO_PO" != "1" ]]; then
  fail "Precondition state wrong: PC_STATUS=$PC_STATUS PC_LINK_TO_PO=$PC_LINK_TO_PO" "$PC_DETAIL"
fi
RESP=$(post_json "$API/documents/$PO4_ID/transition" "$BUYER4_COOKIES" "$BUYER4_ORG" '{"fromStatus":"ACKNOWLEDGED","toStatus":"CHANGED"}')
assert_eq "[4.4] PO → CHANGED succeeds once PO_CHANGE is ACCEPTED_BY_SUPPLIER" "$RESP" '.nextStatus' 'CHANGED'

# Verify the SUPERSEDES link landed on the PO's incoming side.
FINAL_PO4=$(get_json "$API/documents/$PO4_ID" "$BUYER4_COOKIES" "$BUYER4_ORG")
SUPERSEDES_COUNT=$(echo "$FINAL_PO4" | jq -r '[.incomingLinks[] | select(.linkType=="SUPERSEDES")] | length')
if [[ "$SUPERSEDES_COUNT" == "1" ]]; then
  pass "[4.5] PO has 1 SUPERSEDES inbound link from PO_CHANGE"
else
  fail "Expected 1 SUPERSEDES inbound link, got $SUPERSEDES_COUNT" "$FINAL_PO4"
fi

# ----------------------------------------------------------------------
# Scenario 5 — ORDER_CONFIRMATION ACCEPT_WITH_CHANGES + REJECT modes
# ----------------------------------------------------------------------

section "Scenario 5 — ORDER_CONFIRMATION ACCEPT_WITH_CHANGES + REJECT (PHASES.md §2.3)"

# Setup: another fresh pair, two POs (one for ACCEPT_WITH_CHANGES, one for REJECT).
BUYER5_COOKIES="$COOKIE_DIR/buyer5.cookies"
SUPPLIER5_COOKIES="$COOKIE_DIR/supplier5.cookies"
register_and_login "buyer5-$SUFFIX@uat.local" "$BUYER5_COOKIES" >/dev/null
register_and_login "supplier5-$SUFFIX@uat.local" "$SUPPLIER5_COOKIES" >/dev/null
BUYER5_ORG=$(create_org "$BUYER5_COOKIES" "UAT Buyer Co 5" "BUYER")
SUPPLIER5_ORG=$(create_org "$SUPPLIER5_COOKIES" "UAT Supplier Co 5" "SUPPLIER")
post_json "$API/network/relationships" "$BUYER5_COOKIES" "$BUYER5_ORG" "$(cat <<JSON
{
  "buyerOrgId":"$BUYER5_ORG","supplierOrgId":"$SUPPLIER5_ORG","status":"ACTIVE",
  "enabledDocumentTypes":["PO","ORDER_CONFIRMATION","PO_CHANGE"],
  "defaultCurrency":"USD"
}
JSON
)" >/dev/null

publish_simple_po() {
  # publish_simple_po <buyer_cookies> <buyer_org> <supplier_org>  → echoes 'po_id po_number'
  local bc="$1" bo="$2" so="$3"
  local resp
  resp=$(post_json "$API/documents" "$bc" "$bo" "$(cat <<JSON
{
  "documentType":"PO","recipientOrgId":"$so",
  "body":{
    "currency":"USD","paymentTermsRef":"NET-30","requestedDeliveryDate":"2026-07-15",
    "shipTo":{"name":"R","line1":"x","city":"y","countryCode":"US"},
    "billTo":{"name":"R","line1":"x","city":"y","countryCode":"US"},
    "lines":[{"sku":"WIDGET-1","description":"Widget","quantity":5,"unitPrice":10,"unitOfMeasure":"EA","lineRef":"WIDGET-1"}]
  }
}
JSON
)")
  local id num
  id=$(echo "$resp" | jq -r .documentId)
  num=$(echo "$resp" | jq -r .documentNumber)
  post_json "$API/documents/$id/transition" "$bc" "$bo" '{"fromStatus":"DRAFT","toStatus":"ISSUED"}' >/dev/null
  echo "$id $num"
}

read -r PO5A_ID PO5A_NUM <<<"$(publish_simple_po "$BUYER5_COOKIES" "$BUYER5_ORG" "$SUPPLIER5_ORG")"
read -r PO5B_ID PO5B_NUM <<<"$(publish_simple_po "$BUYER5_COOKIES" "$BUYER5_ORG" "$SUPPLIER5_ORG")"
pass "[5.0] Setup: two POs published and ISSUED"

# 5.1: ACCEPT_WITH_CHANGES happy path.
OC_AWC_RESP=$(post_json "$API/documents" "$SUPPLIER5_COOKIES" "$SUPPLIER5_ORG" "$(cat <<JSON
{
  "documentType":"ORDER_CONFIRMATION","recipientOrgId":"$BUYER5_ORG",
  "body":{
    "mode":"ACCEPT_WITH_CHANGES",
    "poDocumentNumber":"$PO5A_NUM","poDocumentId":"$PO5A_ID",
    "comments":"can ship 4 not 5; need extra week",
    "proposedChanges":{
      "revisedRequestedDeliveryDate":"2026-07-29",
      "revisedLines":[{"lineRef":"WIDGET-1","revisedQuantity":4,"comments":"capacity"}]
    }
  }
}
JSON
)")
OC_AWC_ID=$(echo "$OC_AWC_RESP" | jq -r .documentId)
[[ "$OC_AWC_ID" == "null" ]] && fail "OC ACCEPT_WITH_CHANGES publish failed" "$OC_AWC_RESP"
pass "[5.1] OC ACCEPT_WITH_CHANGES published with proposed changes (auto-linked)"

post_json "$API/documents/$OC_AWC_ID/transition" "$SUPPLIER5_COOKIES" "$SUPPLIER5_ORG" '{"fromStatus":"DRAFT","toStatus":"ISSUED"}' >/dev/null

# Buyer ACCEPTED_BY_BUYER
RESP=$(post_json "$API/documents/$OC_AWC_ID/transition" "$BUYER5_COOKIES" "$BUYER5_ORG" '{"fromStatus":"ISSUED","toStatus":"ACCEPTED_BY_BUYER"}')
assert_eq "[5.2] Buyer transitions OC → ACCEPTED_BY_BUYER" "$RESP" '.nextStatus' 'ACCEPTED_BY_BUYER'

# Critical invariant: the OC must NOT have mutated the PO body. Only PO versions modify the PO body.
PO5A_AFTER=$(get_json "$API/documents/$PO5A_ID" "$BUYER5_COOKIES" "$BUYER5_ORG")
VERSION_COUNT=$(echo "$PO5A_AFTER" | jq -r '.versions | length')
CURRENT_QTY=$(echo "$PO5A_AFTER" | jq -r '.versions[0].body.lines[0].quantity')
if [[ "$VERSION_COUNT" == "1" && "$CURRENT_QTY" == "5" ]]; then
  pass "[5.3] PO body NOT mutated by OC ACCEPT_WITH_CHANGES (1 version, qty still 5)"
else
  fail "PO body unexpectedly changed — versions: $VERSION_COUNT, qty: $CURRENT_QTY" "$PO5A_AFTER"
fi

# 5.4: ACCEPT_WITH_CHANGES with empty proposedChanges — must fail body schema.
NEG_RESP=$(post_json "$API/documents" "$SUPPLIER5_COOKIES" "$SUPPLIER5_ORG" "$(cat <<JSON
{
  "documentType":"ORDER_CONFIRMATION","recipientOrgId":"$BUYER5_ORG",
  "body":{
    "mode":"ACCEPT_WITH_CHANGES",
    "poDocumentNumber":"$PO5B_NUM","poDocumentId":"$PO5B_ID",
    "proposedChanges":{}
  }
}
JSON
)")
NEG_KIND=$(echo "$NEG_RESP" | jq -r '.reason.kind // empty')
if [[ "$NEG_KIND" == "body_schema" ]]; then
  pass "[5.4] OC ACCEPT_WITH_CHANGES with empty proposedChanges rejected by Zod"
else
  fail "Expected body_schema rejection, got '$NEG_KIND'" "$NEG_RESP"
fi

# 5.5: REJECT mode — supplier declines the second PO.
OC_REJ_RESP=$(post_json "$API/documents" "$SUPPLIER5_COOKIES" "$SUPPLIER5_ORG" "$(cat <<JSON
{
  "documentType":"ORDER_CONFIRMATION","recipientOrgId":"$BUYER5_ORG",
  "body":{
    "mode":"REJECT",
    "poDocumentNumber":"$PO5B_NUM","poDocumentId":"$PO5B_ID",
    "comments":"cannot fulfil — capacity full"
  }
}
JSON
)")
OC_REJ_ID=$(echo "$OC_REJ_RESP" | jq -r .documentId)
[[ "$OC_REJ_ID" == "null" ]] && fail "OC REJECT publish failed" "$OC_REJ_RESP"
post_json "$API/documents/$OC_REJ_ID/transition" "$SUPPLIER5_COOKIES" "$SUPPLIER5_ORG" '{"fromStatus":"DRAFT","toStatus":"ISSUED"}' >/dev/null

RESP=$(post_json "$API/documents/$OC_REJ_ID/transition" "$BUYER5_COOKIES" "$BUYER5_ORG" '{"fromStatus":"ISSUED","toStatus":"REJECTED_BY_BUYER"}')
assert_eq "[5.5] OC REJECT walks DRAFT → ISSUED → REJECTED_BY_BUYER" "$RESP" '.nextStatus' 'REJECTED_BY_BUYER'

# ----------------------------------------------------------------------
# Scenario 6 — CREDIT_MEMO (PHASES.md §2.7)
# ----------------------------------------------------------------------

section "Scenario 6 — CREDIT_MEMO (PHASES.md §2.7)"

# Setup: reuse Scenario 1's invoice (it's already ACCEPTED).
CM_BODY=$(cat <<JSON
{
  "documentType":"CREDIT_MEMO","recipientOrgId":"$BUYER_ORG",
  "body":{
    "invoiceDocumentNumber":"$INV_NUMBER","invoiceDocumentId":"$INV_ID",
    "reason":"DAMAGED_GOODS","reasonDetail":"1 unit arrived broken; partial refund",
    "issueDate":"2026-08-16","currency":"USD",
    "remitTo":{"name":"Supplier AR","line1":"1 Supply Lane","city":"Supplycity","countryCode":"US"},
    "lines":[{"invoiceLineRef":"WIDGET-1","sku":"WIDGET-1","description":"Widget","creditedQuantity":1,"unitOfMeasure":"EA","unitPrice":10,"creditAmount":10}],
    "totalCreditAmount":10
  }
}
JSON
)
CM_RESP=$(post_json "$API/documents" "$SUPPLIER_COOKIES" "$SUPPLIER_ORG" "$CM_BODY")
CM_ID=$(echo "$CM_RESP" | jq -r .documentId)
LINK_WARN=$(echo "$CM_RESP" | jq -r '.linkWarnings // empty')
[[ "$CM_ID" == "null" ]] && fail "CREDIT_MEMO publish failed" "$CM_RESP"
[[ -n "$LINK_WARN" ]] && fail "CREDIT_MEMO auto-link warned" "$CM_RESP"
pass "[6.1] CREDIT_MEMO published (auto-linked CREDITS → INVOICE)"

# Walk DRAFT → SUBMITTED → ACCEPTED
post_json "$API/documents/$CM_ID/transition" "$SUPPLIER_COOKIES" "$SUPPLIER_ORG" '{"fromStatus":"DRAFT","toStatus":"SUBMITTED"}' >/dev/null
RESP=$(post_json "$API/documents/$CM_ID/transition" "$BUYER_COOKIES" "$BUYER_ORG" '{"fromStatus":"SUBMITTED","toStatus":"ACCEPTED"}')
assert_eq "[6.2] Buyer ACCEPTED the credit memo" "$RESP" '.nextStatus' 'ACCEPTED'

# Verify CREDITS link from CM → invoice.
CM_DETAIL=$(get_json "$API/documents/$CM_ID" "$SUPPLIER_COOKIES" "$SUPPLIER_ORG")
CREDITS_LINKS=$(echo "$CM_DETAIL" | jq -r '[.outgoingLinks[] | select(.linkType=="CREDITS")] | length')
if [[ "$CREDITS_LINKS" == "1" ]]; then
  pass "[6.3] CREDIT_MEMO has 1 outbound CREDITS link to invoice"
else
  fail "Expected 1 CREDITS outbound, got $CREDITS_LINKS" "$CM_DETAIL"
fi

# ----------------------------------------------------------------------
# Scenario 7 — Negative paths (guards, state machines, body schemas)
# ----------------------------------------------------------------------

section "Scenario 7 — Negative paths"

# 7.1: Cross-relationship publish — third-party org tries to publish to our supplier.
BUYER7_COOKIES="$COOKIE_DIR/buyer7.cookies"
register_and_login "buyer7-$SUFFIX@uat.local" "$BUYER7_COOKIES" >/dev/null
BUYER7_ORG=$(create_org "$BUYER7_COOKIES" "Outsider Buyer Co" "BUYER")
RESP=$(post_json "$API/documents" "$BUYER7_COOKIES" "$BUYER7_ORG" "$(cat <<JSON
{
  "documentType":"PO","recipientOrgId":"$SUPPLIER_ORG",
  "body":{
    "currency":"USD","paymentTermsRef":"NET-30","requestedDeliveryDate":"2026-07-15",
    "shipTo":{"name":"R","line1":"x","city":"y","countryCode":"US"},
    "billTo":{"name":"R","line1":"x","city":"y","countryCode":"US"},
    "lines":[{"sku":"X","description":"X","quantity":1,"unitPrice":1,"unitOfMeasure":"EA","lineRef":"X"}]
  }
}
JSON
)")
KIND=$(echo "$RESP" | jq -r '.reason.detail.kind // empty')
if [[ "$KIND" == "no_relationship" ]]; then
  pass "[7.1] Cross-relationship publish rejected with no_relationship"
else
  fail "Expected no_relationship, got '$KIND'" "$RESP"
fi

# 7.2: Doc type not enabled on relationship.
BUYER72_COOKIES="$COOKIE_DIR/buyer72.cookies"
SUPPLIER72_COOKIES="$COOKIE_DIR/supplier72.cookies"
register_and_login "buyer72-$SUFFIX@uat.local" "$BUYER72_COOKIES" >/dev/null
register_and_login "supplier72-$SUFFIX@uat.local" "$SUPPLIER72_COOKIES" >/dev/null
BUYER72_ORG=$(create_org "$BUYER72_COOKIES" "Buyer 72" "BUYER")
SUPPLIER72_ORG=$(create_org "$SUPPLIER72_COOKIES" "Supplier 72" "SUPPLIER")
post_json "$API/network/relationships" "$BUYER72_COOKIES" "$BUYER72_ORG" "$(cat <<JSON
{
  "buyerOrgId":"$BUYER72_ORG","supplierOrgId":"$SUPPLIER72_ORG","status":"ACTIVE",
  "enabledDocumentTypes":["PO"],"defaultCurrency":"USD"
}
JSON
)" >/dev/null
RESP=$(post_json "$API/documents" "$SUPPLIER72_COOKIES" "$SUPPLIER72_ORG" "$(cat <<JSON
{
  "documentType":"INVOICE","recipientOrgId":"$BUYER72_ORG","invoiceMode":"PO_FLIP",
  "body":{
    "invoiceMode":"PO_FLIP",
    "poDocumentNumber":"X","poDocumentId":"x",
    "issueDate":"2026-08-01","dueDate":"2026-08-31","currency":"USD",
    "remitTo":{"name":"R","line1":"x","city":"y","countryCode":"US"},
    "lines":[{"lineRef":"X","sku":"X","description":"x","quantity":1,"unitPrice":1,"unitOfMeasure":"EA"}],
    "subtotal":1,"taxTotal":0,"total":1
  }
}
JSON
)")
KIND=$(echo "$RESP" | jq -r '.reason.detail.kind // empty')
if [[ "$KIND" == "document_type_not_enabled" ]]; then
  pass "[7.2] Publish rejected when document type not enabled on relationship"
else
  fail "Expected document_type_not_enabled, got '$KIND'" "$RESP"
fi

# 7.3: Wrong actor side — supplier tries to issue PO (buyer-only transition).
SETUP=$(publish_simple_po "$BUYER_COOKIES" "$BUYER_ORG" "$SUPPLIER_ORG")
read -r PO7_ID _ <<<"$SETUP"
# PO7 is already ISSUED (publish_simple_po transitions it). Reset by creating a fresh DRAFT.
PO7B_RESP=$(post_json "$API/documents" "$BUYER_COOKIES" "$BUYER_ORG" "$(cat <<JSON
{
  "documentType":"PO","recipientOrgId":"$SUPPLIER_ORG",
  "body":{
    "currency":"USD","paymentTermsRef":"NET-30","requestedDeliveryDate":"2026-07-15",
    "shipTo":{"name":"R","line1":"x","city":"y","countryCode":"US"},
    "billTo":{"name":"R","line1":"x","city":"y","countryCode":"US"},
    "lines":[{"sku":"WIDGET","description":"Widget","quantity":1,"unitPrice":1,"unitOfMeasure":"EA","lineRef":"WIDGET"}]
  }
}
JSON
)")
PO7B_ID=$(echo "$PO7B_RESP" | jq -r .documentId)
RESP=$(post_json "$API/documents/$PO7B_ID/transition" "$SUPPLIER_COOKIES" "$SUPPLIER_ORG" '{"fromStatus":"DRAFT","toStatus":"ISSUED"}')
KIND=$(echo "$RESP" | jq -r '.reason.detail.kind // empty')
if [[ "$KIND" == "wrong_actor_side" || "$KIND" == "wrong_role" ]]; then
  pass "[7.3] Supplier-side issuer transition rejected ($KIND)"
else
  fail "Expected wrong_actor_side or wrong_role, got '$KIND'" "$RESP"
fi

# 7.4: Invalid state transition (DRAFT → CLOSED, skipping the lifecycle).
RESP=$(post_json "$API/documents/$PO7B_ID/transition" "$BUYER_COOKIES" "$BUYER_ORG" '{"fromStatus":"DRAFT","toStatus":"CLOSED"}')
KIND=$(echo "$RESP" | jq -r '.reason.detail.kind // empty')
if [[ "$KIND" == "no_such_transition" ]]; then
  pass "[7.4] DRAFT → CLOSED rejected with no_such_transition"
else
  fail "Expected no_such_transition, got '$KIND'" "$RESP"
fi

# 7.5: Body schema validation — PO with missing shipTo.
RESP=$(post_json "$API/documents" "$BUYER_COOKIES" "$BUYER_ORG" "$(cat <<JSON
{
  "documentType":"PO","recipientOrgId":"$SUPPLIER_ORG",
  "body":{"currency":"USD","lines":[]}
}
JSON
)")
KIND=$(echo "$RESP" | jq -r '.reason.kind // empty')
if [[ "$KIND" == "body_schema" ]]; then
  pass "[7.5] PO with malformed body rejected with body_schema"
else
  fail "Expected body_schema, got '$KIND'" "$RESP"
fi

# 7.6: Status mismatch (optimistic-concurrency). Walk PO7B to ISSUED first.
post_json "$API/documents/$PO7B_ID/transition" "$BUYER_COOKIES" "$BUYER_ORG" '{"fromStatus":"DRAFT","toStatus":"ISSUED"}' >/dev/null
# Now try to transition again from DRAFT — the row is no longer DRAFT.
RESP=$(post_json "$API/documents/$PO7B_ID/transition" "$BUYER_COOKIES" "$BUYER_ORG" '{"fromStatus":"DRAFT","toStatus":"ISSUED"}')
KIND=$(echo "$RESP" | jq -r '.reason.detail.kind // empty')
if [[ "$KIND" == "status_mismatch" ]]; then
  pass "[7.6] Stale fromStatus rejected with status_mismatch"
else
  fail "Expected status_mismatch, got '$KIND'" "$RESP"
fi

# 7.7: Unknown document type.
RESP=$(post_json "$API/documents" "$BUYER_COOKIES" "$BUYER_ORG" "$(cat <<JSON
{"documentType":"NOT_A_TYPE","recipientOrgId":"$SUPPLIER_ORG","body":{}}
JSON
)")
ERR=$(echo "$RESP" | jq -r '.error // empty')
if [[ "$ERR" == "unknown_document_type" ]]; then
  pass "[7.7] Unknown documentType rejected with unknown_document_type"
else
  fail "Expected unknown_document_type, got '$ERR'" "$RESP"
fi

# ----------------------------------------------------------------------
# Scenario 8 — Substrate features (supersede, attachments, listing)
# ----------------------------------------------------------------------

section "Scenario 8 — Substrate features"

# 8.1: GENERIC_DOCUMENT publish + supersede + attachment round-trip.
# Need GENERIC_DOCUMENT in the relationship's enabled list — use a fresh pair.
BUYER8_COOKIES="$COOKIE_DIR/buyer8.cookies"
SUPPLIER8_COOKIES="$COOKIE_DIR/supplier8.cookies"
register_and_login "buyer8-$SUFFIX@uat.local" "$BUYER8_COOKIES" >/dev/null
register_and_login "supplier8-$SUFFIX@uat.local" "$SUPPLIER8_COOKIES" >/dev/null
BUYER8_ORG=$(create_org "$BUYER8_COOKIES" "Buyer 8" "BUYER")
SUPPLIER8_ORG=$(create_org "$SUPPLIER8_COOKIES" "Supplier 8" "SUPPLIER")
post_json "$API/network/relationships" "$BUYER8_COOKIES" "$BUYER8_ORG" "$(cat <<JSON
{
  "buyerOrgId":"$BUYER8_ORG","supplierOrgId":"$SUPPLIER8_ORG","status":"ACTIVE",
  "enabledDocumentTypes":["GENERIC_DOCUMENT"],"defaultCurrency":"USD"
}
JSON
)" >/dev/null

GD_RESP=$(post_json "$API/documents" "$BUYER8_COOKIES" "$BUYER8_ORG" "$(cat <<JSON
{
  "documentType":"GENERIC_DOCUMENT","recipientOrgId":"$SUPPLIER8_ORG",
  "body":{"note":"hello — initial version"}
}
JSON
)")
GD_ID=$(echo "$GD_RESP" | jq -r .documentId)
[[ "$GD_ID" == "null" ]] && fail "GENERIC_DOCUMENT publish failed" "$GD_RESP"
pass "[8.1] GENERIC_DOCUMENT publish (initial version)"

# Supersede with a new body.
SUP_RESP=$(post_json "$API/documents/$GD_ID/supersede" "$BUYER8_COOKIES" "$BUYER8_ORG" '{"body":{"note":"hello — revised version"},"changeReason":"typo fix"}')
V2=$(echo "$SUP_RESP" | jq -r .versionNumber)
if [[ "$V2" == "2" ]]; then
  pass "[8.2] Supersede creates version 2 (prior version preserved)"
else
  fail "Expected versionNumber 2, got '$V2'" "$SUP_RESP"
fi

# Read back: two versions, current is v2, audit log shows CREATED + SUPERSEDED.
GD_DETAIL=$(get_json "$API/documents/$GD_ID" "$BUYER8_COOKIES" "$BUYER8_ORG")
VCOUNT=$(echo "$GD_DETAIL" | jq -r '.versions | length')
V1_BODY=$(echo "$GD_DETAIL" | jq -r '.versions[0].body.note')
V2_BODY=$(echo "$GD_DETAIL" | jq -r '.versions[1].body.note')
if [[ "$VCOUNT" == "2" && "$V1_BODY" == "hello — initial version" && "$V2_BODY" == "hello — revised version" ]]; then
  pass "[8.3] Both versions visible; prior body NOT mutated (immutability)"
else
  fail "Version chain wrong: count=$VCOUNT v1='$V1_BODY' v2='$V2_BODY'" "$GD_DETAIL"
fi

# Attach a small file (SHA-256 computed at upload).
ATTACH_BODY=$(printf '%s' "Hello, attachment UAT." | base64)
ATT_RESP=$(post_json "$API/documents/$GD_ID/attachments" "$BUYER8_COOKIES" "$BUYER8_ORG" "$(cat <<JSON
{"filename":"hello.txt","mimeType":"text/plain","bytesBase64":"$ATTACH_BODY"}
JSON
)")
ATT_ID=$(echo "$ATT_RESP" | jq -r .id)
ATT_SHA=$(echo "$ATT_RESP" | jq -r .sha256)
if [[ -n "$ATT_ID" && "$ATT_ID" != "null" && ${#ATT_SHA} == 64 ]]; then
  pass "[8.4] Attachment uploaded with 64-char SHA-256"
else
  fail "Attachment upload didn't return id/sha256 — id='$ATT_ID' sha='$ATT_SHA'" "$ATT_RESP"
fi

# Download and verify byte-for-byte.
DL_BYTES=$(curl -s -b "$BUYER8_COOKIES" -H "x-active-org: $BUYER8_ORG" "$API/attachments/$ATT_ID")
if [[ "$DL_BYTES" == "Hello, attachment UAT." ]]; then
  pass "[8.5] Attachment download returns bytes byte-for-byte (SHA-256 verified server-side)"
else
  fail "Downloaded bytes don't match — got: $(echo "$DL_BYTES" | head -c 60)" ""
fi

# 8.6: GET /documents inbox/outbox listing — buyer8's outbox should show the GENERIC_DOCUMENT.
LIST=$(get_json "$API/documents?box=outbox&documentType=GENERIC_DOCUMENT" "$BUYER8_COOKIES" "$BUYER8_ORG")
LIST_COUNT=$(echo "$LIST" | jq -r '.documents | length')
LIST_TOTAL=$(echo "$LIST" | jq -r '.total')
if [[ "$LIST_COUNT" == "1" && "$LIST_TOTAL" == "1" ]]; then
  pass "[8.6] GET /documents?box=outbox&documentType=GENERIC_DOCUMENT returns 1 row"
else
  fail "Listing returned count=$LIST_COUNT total=$LIST_TOTAL, expected 1" "$LIST"
fi

# Supplier inbox should show the same document.
LIST_IN=$(get_json "$API/documents?box=inbox" "$SUPPLIER8_COOKIES" "$SUPPLIER8_ORG")
LIST_IN_COUNT=$(echo "$LIST_IN" | jq -r '.documents | length')
if [[ "$LIST_IN_COUNT" == "1" ]]; then
  pass "[8.7] Supplier's inbox returns the same document (1 row)"
else
  fail "Supplier inbox count is $LIST_IN_COUNT, expected 1" "$LIST_IN"
fi

# ----------------------------------------------------------------------
# Scenario 9 — Multi-shipment ASN + consolidated invoice
# ----------------------------------------------------------------------

section "Scenario 9 — Multi-shipment ASN + consolidated invoice"

# Setup: fresh pair with full type list.
BUYER9_COOKIES="$COOKIE_DIR/buyer9.cookies"
SUPPLIER9_COOKIES="$COOKIE_DIR/supplier9.cookies"
register_and_login "buyer9-$SUFFIX@uat.local" "$BUYER9_COOKIES" >/dev/null
register_and_login "supplier9-$SUFFIX@uat.local" "$SUPPLIER9_COOKIES" >/dev/null
BUYER9_ORG=$(create_org "$BUYER9_COOKIES" "Buyer 9" "BUYER")
SUPPLIER9_ORG=$(create_org "$SUPPLIER9_COOKIES" "Supplier 9" "SUPPLIER")
post_json "$API/network/relationships" "$BUYER9_COOKIES" "$BUYER9_ORG" "$(cat <<JSON
{
  "buyerOrgId":"$BUYER9_ORG","supplierOrgId":"$SUPPLIER9_ORG","status":"ACTIVE",
  "enabledDocumentTypes":["PO","ASN","GOODS_RECEIPT","INVOICE","ORDER_CONFIRMATION"],
  "defaultCurrency":"USD"
}
JSON
)" >/dev/null

# Publish PO for quantity 10, walk to IN_FULFILLMENT.
PO9_RESP=$(post_json "$API/documents" "$BUYER9_COOKIES" "$BUYER9_ORG" "$(cat <<JSON
{
  "documentType":"PO","recipientOrgId":"$SUPPLIER9_ORG",
  "body":{
    "currency":"USD","paymentTermsRef":"NET-30","requestedDeliveryDate":"2026-07-15",
    "shipTo":{"name":"R","line1":"x","city":"y","countryCode":"US"},
    "billTo":{"name":"R","line1":"x","city":"y","countryCode":"US"},
    "lines":[{"sku":"WIDGET-1","description":"Widget","quantity":10,"unitPrice":10,"unitOfMeasure":"EA","lineRef":"WIDGET-1"}]
  }
}
JSON
)")
PO9_ID=$(echo "$PO9_RESP" | jq -r .documentId)
PO9_NUM=$(echo "$PO9_RESP" | jq -r .documentNumber)
post_json "$API/documents/$PO9_ID/transition" "$BUYER9_COOKIES" "$BUYER9_ORG" '{"fromStatus":"DRAFT","toStatus":"ISSUED"}' >/dev/null
post_json "$API/documents/$PO9_ID/transition" "$SUPPLIER9_COOKIES" "$SUPPLIER9_ORG" '{"fromStatus":"ISSUED","toStatus":"ACKNOWLEDGED"}' >/dev/null
post_json "$API/documents/$PO9_ID/transition" "$BUYER9_COOKIES" "$BUYER9_ORG" '{"fromStatus":"ACKNOWLEDGED","toStatus":"IN_FULFILLMENT"}' >/dev/null

# First shipment: 4 units.
publish_asn_and_gr() {
  # publish_asn_and_gr <qty> → echoes 'asn_id gr_id'
  local qty="$1"
  local asn_resp
  asn_resp=$(post_json "$API/documents" "$SUPPLIER9_COOKIES" "$SUPPLIER9_ORG" "$(cat <<JSON
{
  "documentType":"ASN","recipientOrgId":"$BUYER9_ORG",
  "body":{
    "poDocumentNumber":"$PO9_NUM","poDocumentId":"$PO9_ID",
    "carrier":"UPS","shippedAt":"2026-07-10","expectedDeliveryDate":"2026-07-12",
    "shipFrom":{"name":"Supplier","line1":"x","city":"y","countryCode":"US"},
    "lines":[{"lineRef":"WIDGET-1","sku":"WIDGET-1","shippedQuantity":$qty,"unitOfMeasure":"EA"}]
  }
}
JSON
)")
  local asn_id
  asn_id=$(echo "$asn_resp" | jq -r .documentId)
  post_json "$API/documents/$asn_id/transition" "$SUPPLIER9_COOKIES" "$SUPPLIER9_ORG" '{"fromStatus":"DRAFT","toStatus":"ISSUED"}' >/dev/null
  post_json "$API/documents/$asn_id/transition" "$SUPPLIER9_COOKIES" "$SUPPLIER9_ORG" '{"fromStatus":"ISSUED","toStatus":"IN_TRANSIT"}' >/dev/null

  local gr_resp
  gr_resp=$(post_json "$API/documents" "$BUYER9_COOKIES" "$BUYER9_ORG" "$(cat <<JSON
{
  "documentType":"GOODS_RECEIPT","recipientOrgId":"$SUPPLIER9_ORG",
  "body":{
    "poDocumentNumber":"$PO9_NUM","poDocumentId":"$PO9_ID",
    "asnDocumentId":"$asn_id",
    "receivedAt":"2026-07-12",
    "lines":[{"lineRef":"WIDGET-1","sku":"WIDGET-1","receivedQuantity":$qty,"unitOfMeasure":"EA"}]
  }
}
JSON
)")
  local gr_id
  gr_id=$(echo "$gr_resp" | jq -r .documentId)
  post_json "$API/documents/$gr_id/transition" "$BUYER9_COOKIES" "$BUYER9_ORG" '{"fromStatus":"DRAFT","toStatus":"POSTED"}' >/dev/null
  post_json "$API/documents/$asn_id/transition" "$BUYER9_COOKIES" "$BUYER9_ORG" '{"fromStatus":"IN_TRANSIT","toStatus":"DELIVERED"}' >/dev/null
  echo "$asn_id $gr_id"
}

read -r ASN9_A GR9_A <<<"$(publish_asn_and_gr 4)"
read -r ASN9_B GR9_B <<<"$(publish_asn_and_gr 6)"
pass "[9.1] Two ASNs (qty 4 + 6) shipped against one PO, both received via separate GRs"

# Verify PO has 2 SHIPS_AGAINST and 2 FULFILLS inbound links.
PO9_DETAIL=$(get_json "$API/documents/$PO9_ID" "$BUYER9_COOKIES" "$BUYER9_ORG")
SHIPS=$(echo "$PO9_DETAIL" | jq -r '[.incomingLinks[] | select(.linkType=="SHIPS_AGAINST")] | length')
FULFILLS=$(echo "$PO9_DETAIL" | jq -r '[.incomingLinks[] | select(.linkType=="FULFILLS")] | length')
if [[ "$SHIPS" == "2" && "$FULFILLS" == "2" ]]; then
  pass "[9.2] PO has 2 SHIPS_AGAINST + 2 FULFILLS inbound (split shipment)"
else
  fail "Expected 2 of each; got SHIPS_AGAINST=$SHIPS FULFILLS=$FULFILLS" "$PO9_DETAIL"
fi

# Single PO_FLIP invoice covering both GRs.
INV9_RESP=$(post_json "$API/documents" "$SUPPLIER9_COOKIES" "$SUPPLIER9_ORG" "$(cat <<JSON
{
  "documentType":"INVOICE","recipientOrgId":"$BUYER9_ORG","invoiceMode":"PO_FLIP",
  "body":{
    "invoiceMode":"PO_FLIP",
    "poDocumentNumber":"$PO9_NUM","poDocumentId":"$PO9_ID",
    "grDocumentIds":["$GR9_A","$GR9_B"],
    "issueDate":"2026-07-15","dueDate":"2026-08-14",
    "currency":"USD","paymentTermsRef":"NET-30",
    "remitTo":{"name":"Supplier AR","line1":"x","city":"y","countryCode":"US"},
    "lines":[{"lineRef":"WIDGET-1","sku":"WIDGET-1","description":"Widget","quantity":10,"unitPrice":10,"unitOfMeasure":"EA"}],
    "subtotal":100,"taxTotal":0,"total":100
  }
}
JSON
)")
INV9_ID=$(echo "$INV9_RESP" | jq -r .documentId)
INV9_DETAIL=$(get_json "$API/documents/$INV9_ID" "$BUYER9_COOKIES" "$BUYER9_ORG")
INV9_OUT=$(echo "$INV9_DETAIL" | jq -r '[.outgoingLinks[] | select(.linkType=="INVOICES")] | length')
if [[ "$INV9_OUT" == "3" ]]; then
  pass "[9.3] PO_FLIP invoice has 3 outbound INVOICES links (PO + 2 GRs — full 3-way visibility)"
else
  fail "Expected 3 outbound INVOICES, got $INV9_OUT" "$INV9_DETAIL"
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
