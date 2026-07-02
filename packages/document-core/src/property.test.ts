/**
 * Property-based tests for the substrate (PHASES.md §5.2).
 *
 * The state-machine factory and link registry are two of the small pieces
 * every document type reuses. If either of them lets an invalid input
 * through, EVERY phase inherits the bug. That justifies a heavier check
 * than the example-based tests can give: fast-check drives them with
 * random inputs and asserts the invariants directly.
 *
 * Invariants exercised:
 *
 *  A. `reachableFrom(x)` matches the set of `to` values in the config
 *     for source `x`. (Consistency between the accessor and the config.)
 *
 *  B. If `attempt(from, {to, role, side, ctx})` returns { ok: true, next },
 *     then `next` is present in `reachableFrom(from)`.
 *     Contrapositive: no successful transition ever produces an
 *     unreachable target — the guardrail against introducing a bug where
 *     the machine accepts something not declared.
 *
 *  C. `attempt` never throws — every input path is a typed rejection or
 *     a typed success.
 *
 *  D. `isTerminal(x)` iff `reachableFrom(x).length === 0`.
 *
 *  E. Link registry: after `register(rule)`, `isAllowed(rule.fromType,
 *     rule.toType, rule.linkType)` is true; for any triple NOT registered,
 *     it is false. (Correctness of the map and the negative case.)
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { defineStateMachine, type StateMachineConfig } from './state-machine.js';
import { LinkRegistry, type LinkRule } from './link-registry.js';

type S = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
type R = 'BUYER_ADMIN' | 'SUPPLIER_ADMIN' | 'BUYER_USER' | 'SUPPLIER_USER';
type Side = 'issuer' | 'recipient';

const states: S[] = ['A', 'B', 'C', 'D', 'E', 'F'];
const roles: R[] = ['BUYER_ADMIN', 'SUPPLIER_ADMIN', 'BUYER_USER', 'SUPPLIER_USER'];
const sides: Side[] = ['issuer', 'recipient'];

/**
 * Random state-machine config: for each state, 0..3 outbound transitions
 * to distinct target states. Small alphabet keeps counterexamples readable.
 */
const machineArb = fc
  .record({
    initialState: fc.constantFrom(...states),
    transitionsBy: fc.dictionary(
      fc.constantFrom(...states),
      fc.uniqueArray(
        fc.record({
          to: fc.constantFrom(...states),
          requiredRole: fc.constantFrom(...roles),
          actor: fc.constantFrom(...sides),
        }),
        { maxLength: 3, selector: (t) => `${t.to}|${t.requiredRole}|${t.actor}` },
      ),
    ),
  })
  .map(({ initialState, transitionsBy }): StateMachineConfig<S, R, void> => {
    // Fill in empty arrays for states with no key in the dictionary.
    type T = { to: S; requiredRole: R; actor: Side };
    const transitions = {} as Record<S, T[]>;
    for (const s of states) transitions[s] = (transitionsBy[s] ?? []) as T[];
    return { initialState, transitions };
  });

describe('§5.2 property-based — state machine', () => {
  it('A. reachableFrom(x) equals the set of `to` in the config for x', () => {
    fc.assert(
      fc.property(machineArb, fc.constantFrom(...states), (cfg, from) => {
        const m = defineStateMachine<S, R, void>(cfg);
        const declared = new Set((cfg.transitions[from] ?? []).map((t) => t.to));
        const reachable = new Set(m.reachableFrom(from));
        // reachable is exactly declared
        expect(reachable).toEqual(declared);
      }),
      { numRuns: 200 },
    );
  });

  it('B. any successful attempt yields a target that is reachable from `from`', () => {
    fc.assert(
      fc.property(
        machineArb,
        fc.constantFrom(...states),
        fc.constantFrom(...states),
        fc.constantFrom(...roles),
        fc.constantFrom(...sides),
        (cfg, from, to, role, side) => {
          const m = defineStateMachine<S, R, void>(cfg);
          const r = m.attempt(from, { to, actorRole: role, actorSide: side, guardCtx: undefined });
          if (r.ok) {
            expect(m.reachableFrom(from)).toContain(r.nextState);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('C. attempt never throws — every path returns a typed result', () => {
    fc.assert(
      fc.property(
        machineArb,
        fc.constantFrom(...states),
        fc.constantFrom(...states),
        fc.constantFrom(...roles),
        fc.constantFrom(...sides),
        (cfg, from, to, role, side) => {
          const m = defineStateMachine<S, R, void>(cfg);
          expect(() =>
            m.attempt(from, { to, actorRole: role, actorSide: side, guardCtx: undefined }),
          ).not.toThrow();
        },
      ),
      { numRuns: 500 },
    );
  });

  it('D. isTerminal(x) iff reachableFrom(x) is empty', () => {
    fc.assert(
      fc.property(machineArb, fc.constantFrom(...states), (cfg, s) => {
        const m = defineStateMachine<S, R, void>(cfg);
        const declared = cfg.transitions[s] ?? [];
        expect(m.isTerminal(s)).toBe(declared.length === 0);
      }),
      { numRuns: 200 },
    );
  });
});

describe('§5.2 property-based — link registry', () => {
  const typeArb = fc.constantFrom(
    'PO',
    'ORDER_CONFIRMATION',
    'ASN',
    'INVOICE',
    'SCHEDULING_AGREEMENT',
  );
  const linkArb = fc.constantFrom<LinkRule['linkType']>(
    'ACKNOWLEDGES',
    'SUPERSEDES',
    'SHIPS_AGAINST',
  );

  it('E. registered triple is allowed; unregistered triple is not', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            fromType: typeArb,
            toType: typeArb,
            linkType: linkArb,
          }),
          {
            maxLength: 5,
            selector: (r) => `${r.fromType}|${r.toType}|${r.linkType}`,
          },
        ),
        (rules) => {
          const reg = new LinkRegistry();
          for (const r of rules) {
            reg.register({
              fromType: r.fromType,
              toType: r.toType,
              linkType: r.linkType,
              inboundCardinality: 'many',
              outboundCardinality: 'many',
            });
          }
          for (const r of rules) {
            expect(reg.lookup(r.fromType, r.toType, r.linkType).ok).toBe(true);
          }
          // Any triple not in the set is disallowed.
          const registered = new Set(rules.map((r) => `${r.fromType}|${r.toType}|${r.linkType}`));
          const allTypes = ['PO', 'ORDER_CONFIRMATION', 'ASN', 'INVOICE', 'SCHEDULING_AGREEMENT'];
          const allLinks = ['ACKNOWLEDGES', 'SUPERSEDES', 'SHIPS_AGAINST'];
          for (const f of allTypes) {
            for (const t of allTypes) {
              for (const l of allLinks) {
                const key = `${f}|${t}|${l}`;
                if (!registered.has(key)) {
                  expect(reg.lookup(f, t, l).ok).toBe(false);
                }
              }
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
