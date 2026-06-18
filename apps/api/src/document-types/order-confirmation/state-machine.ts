import { defineStateMachine, type StateMachine } from '@xbn/document-core';
import type { OrgRole } from '@xbn/db';

/**
 * ORDER_CONFIRMATION state machine (PHASES.md §2.3).
 *
 *   DRAFT
 *     │ (SUPPLIER_*, issuer)
 *     ▼
 *   ISSUED
 *     ├── (BUYER_*, recipient) ──► ACCEPTED_BY_BUYER   [terminal]
 *     └── (BUYER_*, recipient) ──► REJECTED_BY_BUYER   [terminal]
 *
 * Buyer responses (ACCEPTED_BY_BUYER / REJECTED_BY_BUYER) are mostly
 * meaningful when the supplier sent ACCEPT_WITH_CHANGES — the buyer is
 * agreeing to the supplier's counter-proposal. For FULL_ACCEPT and
 * REJECT modes the buyer's transition is informational; the PO state
 * machine continues regardless.
 *
 * On ACCEPTED_BY_BUYER following an ACCEPT_WITH_CHANGES OC, the buyer
 * is expected to issue a PO_CHANGE to materialise the proposed
 * amendments (the OC itself never mutates the PO body).
 */
export const orderConfirmationMachine: StateMachine<string, OrgRole, unknown> = defineStateMachine<
  string,
  OrgRole,
  unknown
>({
  initialState: 'DRAFT',
  transitions: {
    DRAFT: [
      { to: 'ISSUED', requiredRole: 'SUPPLIER_USER', actor: 'issuer' },
      { to: 'ISSUED', requiredRole: 'SUPPLIER_ADMIN', actor: 'issuer' },
    ],
    ISSUED: [
      { to: 'ACCEPTED_BY_BUYER', requiredRole: 'BUYER_USER', actor: 'recipient' },
      { to: 'ACCEPTED_BY_BUYER', requiredRole: 'BUYER_ADMIN', actor: 'recipient' },
      { to: 'REJECTED_BY_BUYER', requiredRole: 'BUYER_USER', actor: 'recipient' },
      { to: 'REJECTED_BY_BUYER', requiredRole: 'BUYER_ADMIN', actor: 'recipient' },
    ],
    ACCEPTED_BY_BUYER: [],
    REJECTED_BY_BUYER: [],
  },
});
