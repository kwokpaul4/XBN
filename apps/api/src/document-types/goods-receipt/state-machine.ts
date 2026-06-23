import { defineStateMachine, type StateMachine } from '@xbn/document-core';
import type { OrgRole } from '@xbn/db';

/**
 * GOODS_RECEIPT state machine (PHASES.md §2.5).
 *
 *   DRAFT
 *     │ (BUYER_*, issuer)
 *     ▼
 *   POSTED  [terminal]
 *
 * GR is a buyer-internal record of what was received. The supplier sees
 * it (it's a network document), but the supplier doesn't transition it.
 * Once POSTED, it's the system-of-record of what actually arrived;
 * corrections issue a new GR with a SUPERSEDES link to the original
 * (handled by the link registry, not the state machine).
 */
export const goodsReceiptMachine: StateMachine<string, OrgRole, unknown> = defineStateMachine<
  string,
  OrgRole,
  unknown
>({
  initialState: 'DRAFT',
  transitions: {
    DRAFT: [
      { to: 'POSTED', requiredRole: 'BUYER_USER', actor: 'issuer' },
      { to: 'POSTED', requiredRole: 'BUYER_ADMIN', actor: 'issuer' },
    ],
    POSTED: [],
  },
});
