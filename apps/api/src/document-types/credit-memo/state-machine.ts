import { defineStateMachine, type StateMachine } from '@xbn/document-core';
import type { OrgRole } from '@xbn/db';

/**
 * CREDIT_MEMO state machine (PHASES.md §2.7).
 *
 *   DRAFT → SUBMITTED → ACCEPTED | REJECTED
 *
 * Same shape as a simple invoice — supplier issues, buyer accepts or
 * rejects. No DISPUTED state at MVP; disputes route through the
 * referenced invoice.
 */
export const creditMemoMachine: StateMachine<string, OrgRole, unknown> = defineStateMachine<
  string,
  OrgRole,
  unknown
>({
  initialState: 'DRAFT',
  transitions: {
    DRAFT: [
      { to: 'SUBMITTED', requiredRole: 'SUPPLIER_USER', actor: 'issuer' },
      { to: 'SUBMITTED', requiredRole: 'SUPPLIER_ADMIN', actor: 'issuer' },
    ],
    SUBMITTED: [
      { to: 'ACCEPTED', requiredRole: 'BUYER_ADMIN', actor: 'recipient' },
      { to: 'REJECTED', requiredRole: 'BUYER_ADMIN', actor: 'recipient' },
    ],
    ACCEPTED: [],
    REJECTED: [],
  },
});
