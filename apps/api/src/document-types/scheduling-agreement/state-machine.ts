import { defineStateMachine, type StateMachine } from '@xbn/document-core';
import type { OrgRole } from '@xbn/db';

/**
 * SCHEDULING_AGREEMENT state machine (PHASES.md §3 anchor entities).
 *
 *   DRAFT
 *     │ (BUYER_*, issuer)
 *     ▼
 *   ACTIVE
 *     │ (BUYER_ADMIN, issuer) - admin tears down a still-active SA
 *     ├──► SUSPENDED   (re-activatable)
 *     │      │ (BUYER_ADMIN, issuer)
 *     │      └──► ACTIVE
 *     │ (BUYER_ADMIN, issuer)
 *     └──► TERMINATED  [terminal]
 *
 * No explicit auto-expiry transition — the validityEnd date in the body
 * is informational; releases against an out-of-window SA are rejected at
 * the route layer in Phase 3.2 (todo: enforce; for MVP we trust the buyer).
 */
export const schedulingAgreementMachine: StateMachine<string, OrgRole, unknown> =
  defineStateMachine<string, OrgRole, unknown>({
    initialState: 'DRAFT',
    transitions: {
      DRAFT: [
        { to: 'ACTIVE', requiredRole: 'BUYER_ADMIN', actor: 'issuer' },
        { to: 'ACTIVE', requiredRole: 'BUYER_USER', actor: 'issuer' },
        { to: 'TERMINATED', requiredRole: 'BUYER_ADMIN', actor: 'issuer' },
      ],
      ACTIVE: [
        { to: 'SUSPENDED', requiredRole: 'BUYER_ADMIN', actor: 'issuer' },
        { to: 'TERMINATED', requiredRole: 'BUYER_ADMIN', actor: 'issuer' },
      ],
      SUSPENDED: [
        { to: 'ACTIVE', requiredRole: 'BUYER_ADMIN', actor: 'issuer' },
        { to: 'TERMINATED', requiredRole: 'BUYER_ADMIN', actor: 'issuer' },
      ],
      TERMINATED: [],
    },
  });
