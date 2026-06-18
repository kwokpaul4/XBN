import { defineStateMachine, type StateMachine } from '@xbn/document-core';
import type { OrgRole } from '@xbn/db';

/**
 * PO_CHANGE state machine (PHASES.md §2.2).
 *
 *   DRAFT
 *     │ (BUYER_ADMIN, issuer)
 *     ▼
 *   ISSUED
 *     │ (SUPPLIER_*, recipient)
 *     ├──► ACCEPTED_BY_SUPPLIER  (terminal — original PO advances to CHANGED)
 *     └──► REJECTED_BY_SUPPLIER  (terminal — original PO stays as it was)
 *
 * Compared with PO itself: the PO_CHANGE is short-lived. Its purpose is to
 * communicate the proposed amendment, get a yes/no, and let the original
 * PO's lifecycle continue. The SUPERSEDES link from PO_CHANGE → PO is what
 * the original PO's CHANGED guard reads to decide whether the PO can move
 * to CHANGED.
 */
export const poChangeMachine: StateMachine<string, OrgRole, unknown> = defineStateMachine<
  string,
  OrgRole,
  unknown
>({
  initialState: 'DRAFT',
  transitions: {
    DRAFT: [
      { to: 'ISSUED', requiredRole: 'BUYER_ADMIN', actor: 'issuer' },
      { to: 'ISSUED', requiredRole: 'BUYER_USER', actor: 'issuer' },
    ],
    ISSUED: [
      { to: 'ACCEPTED_BY_SUPPLIER', requiredRole: 'SUPPLIER_USER', actor: 'recipient' },
      { to: 'ACCEPTED_BY_SUPPLIER', requiredRole: 'SUPPLIER_ADMIN', actor: 'recipient' },
      { to: 'REJECTED_BY_SUPPLIER', requiredRole: 'SUPPLIER_USER', actor: 'recipient' },
      { to: 'REJECTED_BY_SUPPLIER', requiredRole: 'SUPPLIER_ADMIN', actor: 'recipient' },
    ],
    ACCEPTED_BY_SUPPLIER: [],
    REJECTED_BY_SUPPLIER: [],
  },
});
