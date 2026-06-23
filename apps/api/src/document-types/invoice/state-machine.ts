import { defineStateMachine, type StateMachine } from '@xbn/document-core';
import type { OrgRole } from '@xbn/db';

/**
 * INVOICE state machine (PHASES.md §2.6).
 *
 *   DRAFT
 *     │ (SUPPLIER_*, issuer)
 *     ▼
 *   SUBMITTED
 *     │ (BUYER_*, recipient — viewed)
 *     ▼
 *   ACKNOWLEDGED_BY_BUYER
 *     ├ (BUYER_ADMIN, recipient) ──► DISPUTED
 *     │     │ (resolution outside XBN; buyer transitions back)
 *     │     ├──► ACKNOWLEDGED_BY_BUYER
 *     │     ├──► ACCEPTED
 *     │     └──► REJECTED  [terminal]
 *     ├ (BUYER_ADMIN, recipient) ──► ACCEPTED
 *     └ (BUYER_ADMIN, recipient) ──► REJECTED  [terminal]
 *   ACCEPTED  [terminal]
 *
 * IMPORTANT: per PHASES.md §2.6, acceptance is a *visibility flag*, not
 * an approval gate. XBN doesn't pay anything; the buyer's ERP does.
 * Match-status is computed separately and surfaced in the document row.
 */
export const invoiceMachine: StateMachine<string, OrgRole, unknown> = defineStateMachine<
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
      { to: 'ACKNOWLEDGED_BY_BUYER', requiredRole: 'BUYER_USER', actor: 'recipient' },
      { to: 'ACKNOWLEDGED_BY_BUYER', requiredRole: 'BUYER_ADMIN', actor: 'recipient' },
      { to: 'DISPUTED', requiredRole: 'BUYER_ADMIN', actor: 'recipient' },
    ],
    ACKNOWLEDGED_BY_BUYER: [
      { to: 'ACCEPTED', requiredRole: 'BUYER_ADMIN', actor: 'recipient' },
      { to: 'REJECTED', requiredRole: 'BUYER_ADMIN', actor: 'recipient' },
      { to: 'DISPUTED', requiredRole: 'BUYER_ADMIN', actor: 'recipient' },
    ],
    DISPUTED: [
      { to: 'ACKNOWLEDGED_BY_BUYER', requiredRole: 'BUYER_ADMIN', actor: 'recipient' },
      { to: 'ACCEPTED', requiredRole: 'BUYER_ADMIN', actor: 'recipient' },
      { to: 'REJECTED', requiredRole: 'BUYER_ADMIN', actor: 'recipient' },
    ],
    ACCEPTED: [],
    REJECTED: [],
  },
});
