import { defineStateMachine, type StateMachine } from '@xbn/document-core';
import type { OrgRole } from '@xbn/db';

/**
 * ORDER_CONFIRMATION state machine.
 *
 *   DRAFT
 *     │ (SUPPLIER_*, issuer)
 *     ▼
 *   ISSUED — terminal at this layer; the PO it acknowledges advances on
 *   the buyer's side via that PO's own state machine.
 *
 * Task #9 will add ACCEPTED_BY_BUYER / REJECTED_BY_BUYER terminal states
 * for the buyer's response when ACCEPT_WITH_CHANGES requires negotiation.
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
    ISSUED: [],
  },
});
