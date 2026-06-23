import { defineStateMachine, type StateMachine } from '@xbn/document-core';
import type { OrgRole } from '@xbn/db';

/**
 * ASN state machine (PHASES.md §2.4).
 *
 *   DRAFT
 *     │ (SUPPLIER_*, issuer)
 *     ▼
 *   ISSUED
 *     │ (SUPPLIER_*, issuer)
 *     ├──► IN_TRANSIT
 *     │      │ (BUYER_*, recipient — observation that GR was posted)
 *     │      ▼
 *     │    DELIVERED   [terminal]
 *     │ (SUPPLIER_*, issuer; may cancel before delivered)
 *     └──► CANCELLED  [terminal]
 *
 * Note on DELIVERED: the buyer marks DELIVERED when they post the GR
 * (Task #11 will trigger this transition automatically when GR is
 * created against the ASN). Until then, the ASN sits in IN_TRANSIT.
 */
export const asnMachine: StateMachine<string, OrgRole, unknown> = defineStateMachine<
  string,
  OrgRole,
  unknown
>({
  initialState: 'DRAFT',
  transitions: {
    DRAFT: [
      { to: 'ISSUED', requiredRole: 'SUPPLIER_USER', actor: 'issuer' },
      { to: 'ISSUED', requiredRole: 'SUPPLIER_ADMIN', actor: 'issuer' },
      { to: 'CANCELLED', requiredRole: 'SUPPLIER_ADMIN', actor: 'issuer' },
    ],
    ISSUED: [
      { to: 'IN_TRANSIT', requiredRole: 'SUPPLIER_USER', actor: 'issuer' },
      { to: 'IN_TRANSIT', requiredRole: 'SUPPLIER_ADMIN', actor: 'issuer' },
      { to: 'CANCELLED', requiredRole: 'SUPPLIER_ADMIN', actor: 'issuer' },
    ],
    IN_TRANSIT: [
      { to: 'DELIVERED', requiredRole: 'BUYER_USER', actor: 'recipient' },
      { to: 'DELIVERED', requiredRole: 'BUYER_ADMIN', actor: 'recipient' },
      { to: 'CANCELLED', requiredRole: 'SUPPLIER_ADMIN', actor: 'issuer' },
    ],
    DELIVERED: [],
    CANCELLED: [],
  },
});
