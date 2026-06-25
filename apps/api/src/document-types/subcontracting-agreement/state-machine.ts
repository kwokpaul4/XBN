import { defineStateMachine, type StateMachine } from '@xbn/document-core';
import type { OrgRole } from '@xbn/db';

/**
 * SUBCONTRACTING_AGREEMENT state machine — same shape as the other anchors.
 */
export const subcontractingAgreementMachine: StateMachine<string, OrgRole, unknown> =
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
