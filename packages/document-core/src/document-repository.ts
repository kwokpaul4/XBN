/**
 * DocumentRepository (PHASES.md §1.5, CLAUDE.md cross-cutting concern #2).
 *
 * The versioning + lineage + audit-log triad lives here. EVERY mutation to
 * a document body goes through this class, in a single Prisma transaction:
 *
 *   1. INSERT a new immutable row in document_versions
 *   2. UPDATE documents.current_version_id and documents.status
 *   3. Optionally INSERT one or more rows in document_links
 *   4. INSERT a row in document_audit_log
 *
 * Schema-level invariants from packages/db/prisma/schema.prisma:
 *   - document_versions has no updated_at; (document_id, version_number) unique
 *     enforces append-only versioning at the DB level.
 *   - document_links unique on (from_document_id, to_document_id, link_type)
 *     is the no-double-billing guard for SUMMARY invoicing (PHASES.md §2.6).
 *   - documents unique on (issuer_org_id, document_type, document_number)
 *     prevents number reuse within a buyer org.
 *
 * The repository never mutates documents.body in place — there is no body
 * column on documents; body lives on document_versions and is INSERT-only.
 *
 * The operations exported alongside this class (publish/acknowledge/
 * supersede/cancel/link) are the public API; the repository is internal.
 */

import type { Prisma, PrismaClient } from '@xbn/db';

import type { ActorSide } from './state-machine.js';

export type Db = PrismaClient | Prisma.TransactionClient;

/** Inputs for creating a brand-new document with its first version. */
export interface CreateDocumentInput {
  readonly documentType: string;
  readonly documentNumber: string;
  readonly issuerOrgId: string;
  readonly recipientOrgId: string;
  readonly tradingRelationshipId: string;
  readonly initialStatus: string;
  readonly body: Prisma.InputJsonValue;
  readonly actorUserId: string;
  readonly actorOrgId: string;
  /** Optional surfaced fields for fast cross-type queries (PHASES.md §1.5 + §4.1). */
  readonly referenceNumber?: string;
  readonly totalAmount?: Prisma.Decimal | string | number;
  readonly currency?: string;
  readonly issueDate?: Date;
}

/** Inputs for replacing the body of an existing document with a new version. */
export interface AppendVersionInput {
  readonly documentId: string;
  readonly body: Prisma.InputJsonValue;
  readonly changeReason?: string;
  readonly actorUserId: string;
  readonly actorOrgId: string;
}

/** Inputs for transitioning the status of a document. */
export interface TransitionStatusInput {
  readonly documentId: string;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly actorUserId: string;
  readonly actorOrgId: string;
  readonly actorSide: ActorSide;
}

/** Inputs for adding a typed link between two documents. */
export interface AddLinkInput {
  readonly fromDocumentId: string;
  readonly toDocumentId: string;
  readonly linkType: string;
  readonly actorUserId: string;
  readonly actorOrgId: string;
}

export type RepositoryError =
  | { readonly kind: 'document_not_found'; readonly documentId: string }
  | { readonly kind: 'status_mismatch'; readonly expected: string; readonly actual: string }
  | { readonly kind: 'duplicate_document_number'; readonly documentNumber: string }
  | {
      readonly kind: 'duplicate_link';
      readonly fromDocumentId: string;
      readonly toDocumentId: string;
      readonly linkType: string;
    }
  | { readonly kind: 'missing_link_target'; readonly documentId: string };

export class DocumentRepositoryError extends Error {
  constructor(public readonly detail: RepositoryError) {
    super(`DocumentRepository: ${JSON.stringify(detail)}`);
    this.name = 'DocumentRepositoryError';
  }
}

export class DocumentRepository {
  constructor(private readonly db: PrismaClient) {}

  /**
   * Create a brand-new document with its first version (version_number = 1)
   * and an audit-log entry. All four writes happen in one transaction.
   */
  async create(input: CreateDocumentInput): Promise<{ documentId: string; versionId: string }> {
    return this.db.$transaction(async (tx) => {
      const document = await tx.document
        .create({
          data: {
            documentType: input.documentType,
            documentNumber: input.documentNumber,
            issuerOrgId: input.issuerOrgId,
            recipientOrgId: input.recipientOrgId,
            tradingRelationshipId: input.tradingRelationshipId,
            status: input.initialStatus,
            ...(input.referenceNumber !== undefined && { referenceNumber: input.referenceNumber }),
            ...(input.totalAmount !== undefined && { totalAmount: input.totalAmount }),
            ...(input.currency !== undefined && { currency: input.currency }),
            ...(input.issueDate !== undefined && { issueDate: input.issueDate }),
          },
        })
        .catch((err: unknown) => {
          // Prisma raises P2002 for unique constraint violations.
          if (isUniqueViolation(err)) {
            throw new DocumentRepositoryError({
              kind: 'duplicate_document_number',
              documentNumber: input.documentNumber,
            });
          }
          throw err;
        });

      const version = await tx.documentVersion.create({
        data: {
          documentId: document.id,
          versionNumber: 1,
          body: input.body,
          createdById: input.actorUserId,
          changeReason: 'created',
        },
      });

      await tx.document.update({
        where: { id: document.id },
        data: { currentVersionId: version.id },
      });

      await tx.documentAuditLog.create({
        data: {
          documentId: document.id,
          actorUserId: input.actorUserId,
          actorOrgId: input.actorOrgId,
          action: 'CREATED',
          payload: { versionId: version.id, status: input.initialStatus },
        },
      });

      return { documentId: document.id, versionId: version.id };
    });
  }

  /**
   * Append a new immutable version to an existing document. The previous
   * version is left untouched; documents.current_version_id moves forward.
   * An audit-log entry with action='SUPERSEDED' is written.
   */
  async appendVersion(
    input: AppendVersionInput,
  ): Promise<{ versionId: string; versionNumber: number }> {
    return this.db.$transaction(async (tx) => {
      // Optimistic-style read: get the current max version number for this
      // document. Append-only invariant means version_number is strictly
      // increasing — no UPDATE on prior versions, ever.
      const latest = await tx.documentVersion.findFirst({
        where: { documentId: input.documentId },
        orderBy: { versionNumber: 'desc' },
        select: { versionNumber: true },
      });

      if (!latest) {
        throw new DocumentRepositoryError({
          kind: 'document_not_found',
          documentId: input.documentId,
        });
      }

      const nextVersionNumber = latest.versionNumber + 1;

      const version = await tx.documentVersion.create({
        data: {
          documentId: input.documentId,
          versionNumber: nextVersionNumber,
          body: input.body,
          createdById: input.actorUserId,
          ...(input.changeReason !== undefined && { changeReason: input.changeReason }),
        },
      });

      await tx.document.update({
        where: { id: input.documentId },
        data: { currentVersionId: version.id },
      });

      await tx.documentAuditLog.create({
        data: {
          documentId: input.documentId,
          actorUserId: input.actorUserId,
          actorOrgId: input.actorOrgId,
          action: 'SUPERSEDED',
          payload: {
            versionId: version.id,
            versionNumber: nextVersionNumber,
            ...(input.changeReason !== undefined && { changeReason: input.changeReason }),
          },
        },
      });

      return { versionId: version.id, versionNumber: nextVersionNumber };
    });
  }

  /**
   * Transition a document from one status to another. Optimistic-concurrency
   * check on fromStatus — if the row's current status doesn't match, the
   * transition is rejected (a parallel transition won the race). Audit-log
   * entry with action='STATUS_CHANGED' is written.
   */
  async transitionStatus(input: TransitionStatusInput): Promise<void> {
    return this.db.$transaction(async (tx) => {
      const updated = await tx.document.updateMany({
        where: { id: input.documentId, status: input.fromStatus },
        data: { status: input.toStatus },
      });

      if (updated.count === 0) {
        // Either the doc doesn't exist, or its current status is not fromStatus.
        // Distinguish the two for a clearer error.
        const doc = await tx.document.findUnique({
          where: { id: input.documentId },
          select: { status: true },
        });
        if (!doc) {
          throw new DocumentRepositoryError({
            kind: 'document_not_found',
            documentId: input.documentId,
          });
        }
        throw new DocumentRepositoryError({
          kind: 'status_mismatch',
          expected: input.fromStatus,
          actual: doc.status,
        });
      }

      await tx.documentAuditLog.create({
        data: {
          documentId: input.documentId,
          actorUserId: input.actorUserId,
          actorOrgId: input.actorOrgId,
          action: 'STATUS_CHANGED',
          payload: {
            fromStatus: input.fromStatus,
            toStatus: input.toStatus,
            actorSide: input.actorSide,
          },
        },
      });
    });
  }

  /**
   * Add a typed link between two documents. Uniqueness on
   * (fromDocumentId, toDocumentId, linkType) is enforced at the DB level —
   * this method translates the constraint violation into a typed error.
   * Audit-log entry with action='LINKED' is written.
   */
  async addLink(input: AddLinkInput): Promise<{ linkId: string }> {
    return this.db.$transaction(async (tx) => {
      // Verify both endpoints exist before creating the link, so we get a
      // meaningful error instead of a generic FK violation.
      const [fromDoc, toDoc] = await Promise.all([
        tx.document.findUnique({ where: { id: input.fromDocumentId }, select: { id: true } }),
        tx.document.findUnique({ where: { id: input.toDocumentId }, select: { id: true } }),
      ]);
      if (!fromDoc) {
        throw new DocumentRepositoryError({
          kind: 'missing_link_target',
          documentId: input.fromDocumentId,
        });
      }
      if (!toDoc) {
        throw new DocumentRepositoryError({
          kind: 'missing_link_target',
          documentId: input.toDocumentId,
        });
      }

      const link = await tx.documentLink
        .create({
          data: {
            fromDocumentId: input.fromDocumentId,
            toDocumentId: input.toDocumentId,
            linkType: input.linkType,
            createdByUserId: input.actorUserId,
          },
        })
        .catch((err: unknown) => {
          if (isUniqueViolation(err)) {
            throw new DocumentRepositoryError({
              kind: 'duplicate_link',
              fromDocumentId: input.fromDocumentId,
              toDocumentId: input.toDocumentId,
              linkType: input.linkType,
            });
          }
          throw err;
        });

      await tx.documentAuditLog.create({
        data: {
          documentId: input.fromDocumentId,
          actorUserId: input.actorUserId,
          actorOrgId: input.actorOrgId,
          action: 'LINKED',
          payload: {
            linkId: link.id,
            toDocumentId: input.toDocumentId,
            linkType: input.linkType,
          },
        },
      });

      return { linkId: link.id };
    });
  }
}

/**
 * Detect a Prisma P2002 unique-constraint violation without importing the
 * runtime error class (which would force a heavy import). Structural check
 * is enough for our purposes.
 */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown };
  return e.code === 'P2002';
}
