import { defineStateMachine, type StateMachine } from '@xbn/document-core';
import type { OrgRole } from '@xbn/db';

/**
 * FORECAST_PUBLISH state machine (PHASES.md §3.1).
 *
 *   DRAFT → ISSUED  [terminal]
 *
 * A forecast is immutable once issued — to revise, publish a new
 * FORECAST_PUBLISH that SUPERSEDES the prior one.
 */
export const forecastPublishMachine: StateMachine<string, OrgRole, unknown> = defineStateMachine<
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
