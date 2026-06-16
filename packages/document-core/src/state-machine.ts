/**
 * State-machine factory (PHASES.md §1.5, CLAUDE.md cross-cutting concern #4).
 *
 * Declarative per-document-type state machines. Adding a document type means
 * adding a config — no transition code per type. We deliberately do NOT use
 * XState or a workflow engine; the substrate stays small.
 *
 * Each transition records:
 *   - `to`: target state
 *   - `requiredRole`: the OrgRole that may execute this transition
 *   - `actor`: which side of the trading relationship is allowed to do it
 *               ('issuer' | 'recipient'). The recipient of a PO is the supplier;
 *               for them to acknowledge it, actor must be 'recipient'. This is
 *               the orthogonal axis to requiredRole — both must hold.
 *   - `guard`: optional predicate over a context object (lets a state machine
 *              say "only allow ACCEPT if all line totals are non-negative" etc.).
 *
 * The factory itself is type-parameterised over the state and role string sets,
 * so each document type's config is self-checking at compile time.
 */

export type ActorSide = 'issuer' | 'recipient';

export interface Transition<TState extends string, TRole extends string, TGuardCtx> {
  readonly to: TState;
  readonly requiredRole: TRole;
  readonly actor: ActorSide;
  readonly guard?: (ctx: TGuardCtx) => boolean;
}

/**
 * Map of source state → list of allowed transitions.
 * A state with no entry (or an empty list) is terminal.
 */
export type StateMachineConfig<TState extends string, TRole extends string, TGuardCtx> = {
  readonly initialState: TState;
  readonly transitions: Readonly<
    Record<TState, ReadonlyArray<Transition<TState, TRole, TGuardCtx>>>
  >;
};

export interface TransitionAttempt<TRole extends string, TGuardCtx> {
  readonly to: string;
  readonly actorRole: TRole;
  readonly actorSide: ActorSide;
  readonly guardCtx: TGuardCtx;
}

export type TransitionResult<TState extends string> =
  | { readonly ok: true; readonly nextState: TState }
  | { readonly ok: false; readonly reason: TransitionRejection };

export type TransitionRejection =
  | { readonly kind: 'unknown_source_state'; readonly fromState: string }
  | { readonly kind: 'no_such_transition'; readonly fromState: string; readonly toState: string }
  | { readonly kind: 'wrong_role'; readonly required: string; readonly actual: string }
  | { readonly kind: 'wrong_actor_side'; readonly required: ActorSide; readonly actual: ActorSide }
  | { readonly kind: 'guard_rejected' };

export class StateMachine<TState extends string, TRole extends string, TGuardCtx> {
  constructor(private readonly config: StateMachineConfig<TState, TRole, TGuardCtx>) {}

  get initialState(): TState {
    return this.config.initialState;
  }

  /**
   * Returns the list of states reachable from `from` for any role/actor.
   * Useful for UIs that show "what can I do next?".
   */
  reachableFrom(from: TState): ReadonlyArray<TState> {
    const list = this.config.transitions[from];
    if (!list) return [];
    return list.map((t) => t.to);
  }

  /**
   * Returns true if `state` has no outgoing transitions (terminal).
   */
  isTerminal(state: TState): boolean {
    const list = this.config.transitions[state];
    return !list || list.length === 0;
  }

  /**
   * Attempt a transition. Pure — does not mutate anything; the caller
   * persists the new state on success.
   */
  attempt(from: TState, attempt: TransitionAttempt<TRole, TGuardCtx>): TransitionResult<TState> {
    const candidates = this.config.transitions[from];
    if (!candidates) {
      return { ok: false, reason: { kind: 'unknown_source_state', fromState: from } };
    }

    const matches = candidates.filter((t) => t.to === attempt.to);
    if (matches.length === 0) {
      return {
        ok: false,
        reason: { kind: 'no_such_transition', fromState: from, toState: attempt.to },
      };
    }

    // Among the candidates with matching `to`, pick the first whose role+actor
    // permission AND guard accept. This lets a state machine declare multiple
    // transitions to the same target (e.g. ACCEPTED reachable by either party).
    let lastRejection: TransitionRejection = { kind: 'guard_rejected' };
    for (const t of matches) {
      if (t.requiredRole !== attempt.actorRole) {
        lastRejection = {
          kind: 'wrong_role',
          required: t.requiredRole,
          actual: attempt.actorRole,
        };
        continue;
      }
      if (t.actor !== attempt.actorSide) {
        lastRejection = {
          kind: 'wrong_actor_side',
          required: t.actor,
          actual: attempt.actorSide,
        };
        continue;
      }
      if (t.guard && !t.guard(attempt.guardCtx)) {
        lastRejection = { kind: 'guard_rejected' };
        continue;
      }
      return { ok: true, nextState: t.to };
    }

    return { ok: false, reason: lastRejection };
  }
}

/**
 * Factory helper. Lets caller write config inline with full type inference:
 *
 *   const poMachine = defineStateMachine({
 *     initialState: 'DRAFT',
 *     transitions: {
 *       DRAFT: [{ to: 'ISSUED', requiredRole: 'BUYER_ADMIN', actor: 'issuer' }],
 *       ISSUED: [{ to: 'ACKNOWLEDGED', requiredRole: 'SUPPLIER_USER', actor: 'recipient' }],
 *       ACKNOWLEDGED: [],
 *     },
 *   });
 */
export function defineStateMachine<TState extends string, TRole extends string, TGuardCtx = void>(
  config: StateMachineConfig<TState, TRole, TGuardCtx>,
): StateMachine<TState, TRole, TGuardCtx> {
  return new StateMachine(config);
}
