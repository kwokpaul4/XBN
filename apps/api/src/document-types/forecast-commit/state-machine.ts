import { defineStateMachine, type StateMachine } from '@xbn/document-core';
import type { OrgRole } from '@xbn/db';

/**
 * FORECAST_COMMIT state machine (PHASES.md §3.1).
 *
 *   DRAFT → ISSUED  [terminal]
 *
 * Supplier-originated; immutable once issued. To revise, publish a new
 * FORECAST_COMMIT in response to the same FORECAST_PUBLISH — the buyer
 * sees both in the document DAG.
 */
export const forecastCommitMachine: StateMachine<string, OrgRole, unknown> = defineStateMachine<
  string,
  OrgRole,
  unknown
>({
  initialState: 'DRAFT',
  transitions: {
    DRAFT: [
      { to: 'ISSUED', requiredRole: 'SUPPLIER_USER', actor: 'issuer' },
      { to: 'ISSUED', requiredRole: 'SUPPLIER_ADMIN', actor: 'issuer' },
    ],
    ISSUED: [],
  },
});
