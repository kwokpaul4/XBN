import { describe, expect, it } from 'vitest';
import { defineStateMachine } from './state-machine.js';

// A representative state machine modelled after the PO lifecycle from PHASES.md §2.1
// without committing to the real one (that's defined in apps/api/document-types).
type PoState = 'DRAFT' | 'ISSUED' | 'ACKNOWLEDGED' | 'CANCELLED';
type Role = 'BUYER_ADMIN' | 'BUYER_USER' | 'SUPPLIER_USER' | 'SUPPLIER_ADMIN';

interface PoGuardCtx {
  totalAmount: number;
}

const poMachine = defineStateMachine<PoState, Role, PoGuardCtx>({
  initialState: 'DRAFT',
  transitions: {
    DRAFT: [
      // Buyer issues a PO. Guard: total must be > 0.
      {
        to: 'ISSUED',
        requiredRole: 'BUYER_ADMIN',
        actor: 'issuer',
        guard: (ctx) => ctx.totalAmount > 0,
      },
      // Buyer can also cancel a draft.
      { to: 'CANCELLED', requiredRole: 'BUYER_ADMIN', actor: 'issuer' },
    ],
    ISSUED: [
      // Supplier acknowledges.
      { to: 'ACKNOWLEDGED', requiredRole: 'SUPPLIER_USER', actor: 'recipient' },
      // Buyer cancels.
      { to: 'CANCELLED', requiredRole: 'BUYER_ADMIN', actor: 'issuer' },
    ],
    ACKNOWLEDGED: [],
    CANCELLED: [],
  },
});

describe('StateMachine', () => {
  it('exposes initialState', () => {
    expect(poMachine.initialState).toBe('DRAFT');
  });

  it('reachableFrom returns the set of next states', () => {
    expect([...poMachine.reachableFrom('DRAFT')].sort()).toEqual(['CANCELLED', 'ISSUED']);
    expect([...poMachine.reachableFrom('ISSUED')].sort()).toEqual(['ACKNOWLEDGED', 'CANCELLED']);
    expect(poMachine.reachableFrom('ACKNOWLEDGED')).toEqual([]);
  });

  it('isTerminal identifies leaves', () => {
    expect(poMachine.isTerminal('DRAFT')).toBe(false);
    expect(poMachine.isTerminal('ISSUED')).toBe(false);
    expect(poMachine.isTerminal('ACKNOWLEDGED')).toBe(true);
    expect(poMachine.isTerminal('CANCELLED')).toBe(true);
  });

  it('accepts a valid transition', () => {
    const result = poMachine.attempt('DRAFT', {
      to: 'ISSUED',
      actorRole: 'BUYER_ADMIN',
      actorSide: 'issuer',
      guardCtx: { totalAmount: 100 },
    });
    expect(result).toEqual({ ok: true, nextState: 'ISSUED' });
  });

  it('rejects with no_such_transition when source state has no outgoing transitions', () => {
    // ACKNOWLEDGED is in the config but has []. The state is *known*; it just
    // has nothing reachable from it. unknown_source_state is reserved for
    // states that don't appear in the config map at all.
    const result = poMachine.attempt('ACKNOWLEDGED', {
      to: 'CANCELLED' as PoState,
      actorRole: 'BUYER_ADMIN',
      actorSide: 'issuer',
      guardCtx: { totalAmount: 100 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.kind).toBe('no_such_transition');
    }
  });

  it('rejects with unknown_source_state when source is not in the config', () => {
    // Cast to PoState to bypass the compile-time check — at runtime a stale
    // value from the DB could in principle land here, and we want a stable
    // rejection rather than a crash.
    const result = poMachine.attempt('NEVER_HEARD_OF_THIS' as PoState, {
      to: 'ISSUED',
      actorRole: 'BUYER_ADMIN',
      actorSide: 'issuer',
      guardCtx: { totalAmount: 100 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.kind).toBe('unknown_source_state');
    }
  });

  it('rejects when target state is not reachable', () => {
    const result = poMachine.attempt('DRAFT', {
      to: 'ACKNOWLEDGED',
      actorRole: 'BUYER_ADMIN',
      actorSide: 'issuer',
      guardCtx: { totalAmount: 100 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.kind).toBe('no_such_transition');
    }
  });

  it('rejects when actor has the wrong role', () => {
    const result = poMachine.attempt('DRAFT', {
      to: 'ISSUED',
      actorRole: 'BUYER_USER', // not BUYER_ADMIN
      actorSide: 'issuer',
      guardCtx: { totalAmount: 100 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.kind).toBe('wrong_role');
    }
  });

  it('rejects when actor is on the wrong side of the trading relationship', () => {
    // Supplier (recipient of a PO) tries to issue it themselves.
    const result = poMachine.attempt('DRAFT', {
      to: 'ISSUED',
      actorRole: 'BUYER_ADMIN',
      actorSide: 'recipient',
      guardCtx: { totalAmount: 100 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.kind).toBe('wrong_actor_side');
    }
  });

  it('rejects when guard returns false', () => {
    const result = poMachine.attempt('DRAFT', {
      to: 'ISSUED',
      actorRole: 'BUYER_ADMIN',
      actorSide: 'issuer',
      guardCtx: { totalAmount: 0 }, // guard requires > 0
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.kind).toBe('guard_rejected');
    }
  });

  it('routes to the right transition when multiple share a target state', () => {
    // ISSUED → CANCELLED is allowed for buyer.
    const buyerCancel = poMachine.attempt('ISSUED', {
      to: 'CANCELLED',
      actorRole: 'BUYER_ADMIN',
      actorSide: 'issuer',
      guardCtx: { totalAmount: 100 },
    });
    expect(buyerCancel).toEqual({ ok: true, nextState: 'CANCELLED' });

    // Supplier should not be able to cancel.
    const supplierCancel = poMachine.attempt('ISSUED', {
      to: 'CANCELLED',
      actorRole: 'SUPPLIER_ADMIN',
      actorSide: 'recipient',
      guardCtx: { totalAmount: 100 },
    });
    expect(supplierCancel.ok).toBe(false);
  });
});
