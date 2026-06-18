import { defineStateMachine, type StateMachine } from '@xbn/document-core';
import type { OrgRole } from '@xbn/db';

/**
 * PO state machine (PHASES.md §2.1).
 *
 *   DRAFT
 *     │ (BUYER_ADMIN/USER, issuer)
 *     ▼
 *   ISSUED ──────────(BUYER_ADMIN, issuer)──► CANCELLED   [terminal]
 *     │ (SUPPLIER_*, recipient)             ─(BUYER_ADMIN)─► CHANGED [side]
 *     ▼
 *   ACKNOWLEDGED ────(BUYER_ADMIN, issuer)──► CANCELLED
 *     │              (any party)             ─► CHANGED
 *     │ (BUYER_ADMIN/USER, issuer or recipient — fulfilment is observed,
 *     │  not granted; the buyer marks IN_FULFILLMENT when the first ASN
 *     │  arrives and CLOSED when the final GR is posted)
 *     ▼
 *   IN_FULFILLMENT ─(BUYER_*, issuer)─► CLOSED   [terminal]
 *
 * Side states (reachable from any non-terminal):
 *   - CANCELLED — buyer cancels. Terminal.
 *   - CHANGED   — a PO_CHANGE has been issued and accepted (Task #8).
 *                 This is reachable from DRAFT/ISSUED/ACKNOWLEDGED/
 *                 IN_FULFILLMENT. The PO is then superseded by the change;
 *                 lifecycle continues on the new effective state.
 *
 * Notes on PO_CHANGE wiring:
 *   - A `CHANGED` transition is gated on "a PO_CHANGE document has been
 *     accepted by the supplier". Today the state machine doesn't enforce
 *     that precondition — Task #8 (PO_CHANGE) will introduce a guard
 *     predicate that consults the document_links table for an accepted
 *     PO_CHANGE referencing this PO. For Phase 2.1 we permit the
 *     transition but expect Task #8 to tighten it.
 *
 * IN_FULFILLMENT vs CLOSED semantics:
 *   - Per PHASES.md §2.1 the buyer marks IN_FULFILLMENT when fulfilment
 *     starts (first ASN). CLOSED when the final GR is posted. These are
 *     buyer-side actions performed via /transition; Task #11 will tighten
 *     them with guards so the buyer can't close a PO with outstanding
 *     line quantities.
 */
export const poMachine: StateMachine<string, OrgRole, unknown> = defineStateMachine<
  string,
  OrgRole,
  unknown
>({
  initialState: 'DRAFT',
  transitions: {
    DRAFT: [
      { to: 'ISSUED', requiredRole: 'BUYER_ADMIN', actor: 'issuer' },
      { to: 'ISSUED', requiredRole: 'BUYER_USER', actor: 'issuer' },
      { to: 'CANCELLED', requiredRole: 'BUYER_ADMIN', actor: 'issuer' },
      { to: 'CHANGED', requiredRole: 'BUYER_ADMIN', actor: 'issuer' },
    ],
    ISSUED: [
      { to: 'ACKNOWLEDGED', requiredRole: 'SUPPLIER_USER', actor: 'recipient' },
      { to: 'ACKNOWLEDGED', requiredRole: 'SUPPLIER_ADMIN', actor: 'recipient' },
      { to: 'CANCELLED', requiredRole: 'BUYER_ADMIN', actor: 'issuer' },
      { to: 'CHANGED', requiredRole: 'BUYER_ADMIN', actor: 'issuer' },
    ],
    ACKNOWLEDGED: [
      { to: 'IN_FULFILLMENT', requiredRole: 'BUYER_ADMIN', actor: 'issuer' },
      { to: 'IN_FULFILLMENT', requiredRole: 'BUYER_USER', actor: 'issuer' },
      { to: 'CANCELLED', requiredRole: 'BUYER_ADMIN', actor: 'issuer' },
      { to: 'CHANGED', requiredRole: 'BUYER_ADMIN', actor: 'issuer' },
    ],
    IN_FULFILLMENT: [
      { to: 'CLOSED', requiredRole: 'BUYER_ADMIN', actor: 'issuer' },
      { to: 'CLOSED', requiredRole: 'BUYER_USER', actor: 'issuer' },
      { to: 'CANCELLED', requiredRole: 'BUYER_ADMIN', actor: 'issuer' },
      { to: 'CHANGED', requiredRole: 'BUYER_ADMIN', actor: 'issuer' },
    ],
    CLOSED: [],
    CANCELLED: [],
    CHANGED: [],
  },
});
