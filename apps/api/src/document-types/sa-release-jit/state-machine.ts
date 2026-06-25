import { defineStateMachine, type StateMachine } from '@xbn/document-core';
import type { OrgRole } from '@xbn/db';

/**
 * SA_RELEASE_JIT state machine (PHASES.md §3.2).
 *
 *   DRAFT → ISSUED  [terminal]
 *
 * Firm call-off — once issued, the supplier ships against it. ASN
 * SHIPS_AGAINST → SA_RELEASE_JIT.
 */
export const saReleaseJitMachine: StateMachine<string, OrgRole, unknown> = defineStateMachine<
  string,
  OrgRole,
  unknown
>({
  initialState: 'DRAFT',
  transitions: {
    DRAFT: [
      { to: 'ISSUED', requiredRole: 'BUYER_USER', actor: 'issuer' },
      { to: 'ISSUED', requiredRole: 'BUYER_ADMIN', actor: 'issuer' },
    ],
    ISSUED: [],
  },
});
