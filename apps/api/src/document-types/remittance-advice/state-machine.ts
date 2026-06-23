import { defineStateMachine, type StateMachine } from '@xbn/document-core';
import type { OrgRole } from '@xbn/db';

/**
 * REMITTANCE_ADVICE state machine (PHASES.md §2.8).
 *
 *   DRAFT → ISSUED  [terminal]
 *
 * Notification document — once issued, terminal. Corrections issue a new
 * remittance advice that supersedes the prior one (link-level, not state).
 */
export const remittanceAdviceMachine: StateMachine<string, OrgRole, unknown> = defineStateMachine<
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
