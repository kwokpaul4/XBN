import { defineStateMachine, type StateMachine } from '@xbn/document-core';
import type { OrgRole } from '@xbn/db';

/**
 * GENERIC_DOCUMENT state machine.
 *
 * Initial state: PUBLISHED (the document is "live" the moment it's created).
 * Either party admin may CANCELLED the document. SUPERSEDED is reached via
 * the supersede operation, not via direct state transition.
 */
export const genericDocumentMachine: StateMachine<string, OrgRole, unknown> = defineStateMachine<
  string,
  OrgRole,
  unknown
>({
  initialState: 'PUBLISHED',
  transitions: {
    PUBLISHED: [
      { to: 'CANCELLED', requiredRole: 'BUYER_ADMIN', actor: 'issuer' },
      { to: 'CANCELLED', requiredRole: 'SUPPLIER_ADMIN', actor: 'issuer' },
    ],
    SUPERSEDED: [],
    CANCELLED: [],
  },
});
