import { defineStateMachine, type StateMachine } from '@xbn/document-core';
import type { OrgRole } from '@xbn/db';

/**
 * SA_RELEASE_FORECAST state machine.
 *
 *   DRAFT → ISSUED  [terminal]
 *
 * Buyer-originated planning release. Immutable once issued — to revise,
 * publish a new release with a SUPERSEDES link.
 */
export const saReleaseForecastMachine: StateMachine<string, OrgRole, unknown> = defineStateMachine<
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
