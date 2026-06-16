/**
 * The five universal document operations (PHASES.md §1.5, CLAUDE.md
 * cross-cutting concern #1+#2+#3).
 *
 * Each operation composes the document substrate primitives:
 *   - TradingRelationshipGuard    — is this publish allowed?
 *   - NumberingStrategy           — what number does it get? (publish only)
 *   - StateMachine                — is this transition legal? (acknowledge/cancel)
 *   - LinkRegistry                — is this link valid? (link)
 *   - DocumentRepository          — apply the writes in one transaction
 *
 * All five are thin functions, not classes. Phase 2 services compose them
 * with their per-document-type configs (state machine, body schema, link
 * rules) to deliver typed publish/acknowledge/etc. flows for PO, ASN,
 * INVOICE, and so on.
 *
 * IMPORTANT: these functions return TYPED RESULT OBJECTS (ok/reason),
 * not throw. Repository-level errors do throw — they mean "the DB layer
 * is in an unexpected state and we want a stack trace" — but business-rule
 * rejections (guard failed, state machine refused, link registry has no
 * such rule) are non-exceptional and the caller decides what to do.
 */

import type { PrismaClient, Prisma } from '@xbn/db';

import type { BodySchemaRegistry } from './body-schema-registry.js';
import {
  DocumentRepository,
  DocumentRepositoryError,
  type RepositoryError,
} from './document-repository.js';
import type { LinkRegistry } from './link-registry.js';
import type { NumberingStrategy } from './numbering.js';
import type { ActorSide, StateMachine } from './state-machine.js';
import type { TradingRelationshipGuard } from './trading-relationship-guard.js';

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

export interface PublishRequest<TState extends string, TRole extends string> {
  readonly documentType: string;
  readonly issuerOrgId: string;
  readonly recipientOrgId: string;
  readonly body: unknown;
  readonly actorUserId: string;
  readonly actorOrgId: string;
  readonly actorRole: TRole;
  /** Optional numbering prefix override (e.g. 'BUY-2026'). */
  readonly numberingPrefix?: string;
  /** External-numbering source: pass the ERP-issued number through. */
  readonly externalNumber?: string;
  /** PHASES.md §2.6 INVOICE invoice_mode — gates SUMMARY guard check. */
  readonly invoiceMode?: 'PO_FLIP' | 'SUMMARY';
  /** Optional surfaced fields. */
  readonly referenceNumber?: string;
  readonly totalAmount?: Prisma.Decimal | string | number;
  readonly currency?: string;
  readonly issueDate?: Date;
  readonly stateMachine: StateMachine<TState, TRole, unknown>;
}

export type PublishResult =
  | {
      readonly ok: true;
      readonly documentId: string;
      readonly versionId: string;
      readonly documentNumber: string;
    }
  | { readonly ok: false; readonly reason: PublishRejection };

export type PublishRejection =
  | { readonly kind: 'guard'; readonly detail: unknown }
  | { readonly kind: 'body_schema'; readonly detail: unknown }
  | { readonly kind: 'repository'; readonly detail: RepositoryError };

export interface PublishDeps {
  readonly db: PrismaClient;
  readonly guard: TradingRelationshipGuard;
  readonly numbering: NumberingStrategy;
  readonly bodySchemas: BodySchemaRegistry;
  readonly repository?: DocumentRepository;
}

export async function publish<TState extends string, TRole extends string>(
  deps: PublishDeps,
  request: PublishRequest<TState, TRole>,
): Promise<PublishResult> {
  // 1. Guard: the relationship must exist and the doc type must be enabled.
  const guard = await deps.guard.check({
    issuerOrgId: request.issuerOrgId,
    recipientOrgId: request.recipientOrgId,
    documentType: request.documentType,
    ...(request.invoiceMode !== undefined && { invoiceMode: request.invoiceMode }),
  });
  if (!guard.ok) {
    return { ok: false, reason: { kind: 'guard', detail: guard.reason } };
  }

  // 2. Body schema: validate the body against the registered Zod schema.
  const validated = deps.bodySchemas.parse(request.documentType, request.body);
  if (!validated.ok) {
    return { ok: false, reason: { kind: 'body_schema', detail: validated.reason } };
  }

  // 3. Reserve a document number.
  const documentNumber = await deps.numbering.next({
    issuerOrgId: request.issuerOrgId,
    documentType: request.documentType,
    ...(request.numberingPrefix !== undefined && { prefix: request.numberingPrefix }),
    ...(request.externalNumber !== undefined && { externalNumber: request.externalNumber }),
  });

  // 4. Repository: insert document + first version + audit log in one tx.
  const repo = deps.repository ?? new DocumentRepository(deps.db);
  try {
    const created = await repo.create({
      documentType: request.documentType,
      documentNumber,
      issuerOrgId: request.issuerOrgId,
      recipientOrgId: request.recipientOrgId,
      tradingRelationshipId: guard.tradingRelationshipId,
      initialStatus: request.stateMachine.initialState,
      body: validated.body as Prisma.InputJsonValue,
      actorUserId: request.actorUserId,
      actorOrgId: request.actorOrgId,
      ...(request.referenceNumber !== undefined && { referenceNumber: request.referenceNumber }),
      ...(request.totalAmount !== undefined && { totalAmount: request.totalAmount }),
      ...(request.currency !== undefined && { currency: request.currency }),
      ...(request.issueDate !== undefined && { issueDate: request.issueDate }),
    });
    return {
      ok: true,
      documentId: created.documentId,
      versionId: created.versionId,
      documentNumber,
    };
  } catch (err) {
    if (err instanceof DocumentRepositoryError) {
      return { ok: false, reason: { kind: 'repository', detail: err.detail } };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// acknowledge / cancel — both are status transitions, share machinery
// ---------------------------------------------------------------------------

export interface TransitionRequest<TState extends string, TRole extends string> {
  readonly documentId: string;
  readonly fromStatus: TState;
  readonly toStatus: TState;
  readonly actorUserId: string;
  readonly actorOrgId: string;
  readonly actorRole: TRole;
  readonly actorSide: ActorSide;
  readonly stateMachine: StateMachine<TState, TRole, unknown>;
  readonly guardCtx?: unknown;
}

export type TransitionOpResult =
  | { readonly ok: true; readonly nextStatus: string }
  | { readonly ok: false; readonly reason: TransitionOpRejection };

export type TransitionOpRejection =
  | { readonly kind: 'state_machine'; readonly detail: unknown }
  | { readonly kind: 'repository'; readonly detail: RepositoryError };

export interface TransitionDeps {
  readonly db: PrismaClient;
  readonly repository?: DocumentRepository;
}

async function transition<TState extends string, TRole extends string>(
  deps: TransitionDeps,
  request: TransitionRequest<TState, TRole>,
): Promise<TransitionOpResult> {
  const machineResult = request.stateMachine.attempt(request.fromStatus, {
    to: request.toStatus,
    actorRole: request.actorRole,
    actorSide: request.actorSide,
    guardCtx: request.guardCtx,
  });

  if (!machineResult.ok) {
    return { ok: false, reason: { kind: 'state_machine', detail: machineResult.reason } };
  }

  const repo = deps.repository ?? new DocumentRepository(deps.db);
  try {
    await repo.transitionStatus({
      documentId: request.documentId,
      fromStatus: request.fromStatus,
      toStatus: request.toStatus,
      actorUserId: request.actorUserId,
      actorOrgId: request.actorOrgId,
      actorSide: request.actorSide,
    });
    return { ok: true, nextStatus: request.toStatus };
  } catch (err) {
    if (err instanceof DocumentRepositoryError) {
      return { ok: false, reason: { kind: 'repository', detail: err.detail } };
    }
    throw err;
  }
}

/** Acknowledge / accept-with-changes / accept-by-buyer / etc. */
export const acknowledge = transition;

/** Cancel a document (typically only legal in non-terminal states). */
export const cancel = transition;

// ---------------------------------------------------------------------------
// supersede
// ---------------------------------------------------------------------------

export interface SupersedeRequest {
  readonly documentId: string;
  readonly documentType: string;
  readonly body: unknown;
  readonly changeReason?: string;
  readonly actorUserId: string;
  readonly actorOrgId: string;
}

export type SupersedeResult =
  | { readonly ok: true; readonly versionId: string; readonly versionNumber: number }
  | { readonly ok: false; readonly reason: SupersedeRejection };

export type SupersedeRejection =
  | { readonly kind: 'body_schema'; readonly detail: unknown }
  | { readonly kind: 'repository'; readonly detail: RepositoryError };

export interface SupersedeDeps {
  readonly db: PrismaClient;
  readonly bodySchemas: BodySchemaRegistry;
  readonly repository?: DocumentRepository;
}

export async function supersede(
  deps: SupersedeDeps,
  request: SupersedeRequest,
): Promise<SupersedeResult> {
  const validated = deps.bodySchemas.parse(request.documentType, request.body);
  if (!validated.ok) {
    return { ok: false, reason: { kind: 'body_schema', detail: validated.reason } };
  }

  const repo = deps.repository ?? new DocumentRepository(deps.db);
  try {
    const result = await repo.appendVersion({
      documentId: request.documentId,
      body: validated.body as Prisma.InputJsonValue,
      actorUserId: request.actorUserId,
      actorOrgId: request.actorOrgId,
      ...(request.changeReason !== undefined && { changeReason: request.changeReason }),
    });
    return { ok: true, versionId: result.versionId, versionNumber: result.versionNumber };
  } catch (err) {
    if (err instanceof DocumentRepositoryError) {
      return { ok: false, reason: { kind: 'repository', detail: err.detail } };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// link
// ---------------------------------------------------------------------------

export interface LinkRequest {
  readonly fromDocumentId: string;
  readonly fromDocumentType: string;
  readonly toDocumentId: string;
  readonly toDocumentType: string;
  readonly linkType: string;
  readonly actorUserId: string;
  readonly actorOrgId: string;
}

export type LinkOpResult =
  | { readonly ok: true; readonly linkId: string }
  | { readonly ok: false; readonly reason: LinkOpRejection };

export type LinkOpRejection =
  | { readonly kind: 'unknown_link_rule'; readonly detail: unknown }
  | { readonly kind: 'repository'; readonly detail: RepositoryError };

export interface LinkDeps {
  readonly db: PrismaClient;
  readonly linkRegistry: LinkRegistry;
  readonly repository?: DocumentRepository;
}

export async function link(deps: LinkDeps, request: LinkRequest): Promise<LinkOpResult> {
  // 1. Validate the (fromType, toType, linkType) rule is registered.
  const lookup = deps.linkRegistry.lookup(
    request.fromDocumentType,
    request.toDocumentType,
    request.linkType,
  );
  if (!lookup.ok) {
    return { ok: false, reason: { kind: 'unknown_link_rule', detail: lookup.reason } };
  }

  // 2. Persist the link + audit-log entry in one tx.
  const repo = deps.repository ?? new DocumentRepository(deps.db);
  try {
    const result = await repo.addLink({
      fromDocumentId: request.fromDocumentId,
      toDocumentId: request.toDocumentId,
      linkType: request.linkType,
      actorUserId: request.actorUserId,
      actorOrgId: request.actorOrgId,
    });
    return { ok: true, linkId: result.linkId };
  } catch (err) {
    if (err instanceof DocumentRepositoryError) {
      return { ok: false, reason: { kind: 'repository', detail: err.detail } };
    }
    throw err;
  }
}
