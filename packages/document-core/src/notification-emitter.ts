/**
 * Notification emitter (PHASES.md §1.5, §4.5).
 *
 * Writes to `notification_outbox`. Phase 4.5 ships the pg-boss consumer that
 * reads this outbox, dispatches in-app notifications and emails, and marks
 * rows DELIVERED / FAILED. Until then, rows simply accumulate harmlessly —
 * the document choreography is unblocked.
 *
 * Outbox-pattern reasoning: producing the notification in the SAME
 * transaction as the underlying document mutation guarantees that no
 * notification is ever lost mid-flight (we never produce a notification
 * for a write that didn't commit, and we never miss producing one for a
 * write that did). Phase 2 services will pass a Prisma.TransactionClient
 * here so the emit is part of their publish/acknowledge transaction.
 */

import type { Prisma, PrismaClient } from '@xbn/db';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Network-level event types the substrate produces. Phase 4.5 may add more.
 * Strings (not enum) so adding new event types in later phases doesn't
 * require a Prisma migration.
 */
export type NotificationEvent =
  | 'DOCUMENT_PUBLISHED'
  | 'DOCUMENT_ACKNOWLEDGED'
  | 'DOCUMENT_SUPERSEDED'
  | 'DOCUMENT_CANCELLED'
  | 'DOCUMENT_LINKED'
  | 'ATTACHMENT_ADDED';

export interface EmitInput {
  readonly eventType: NotificationEvent | string;
  readonly documentId: string;
  /**
   * User IDs that should receive the notification. Typically the document's
   * recipient org's users; the caller resolves the membership and passes
   * the list. We don't expand "all users in this org" here — that's a Phase
   * 4.5 consumer concern.
   */
  readonly recipientUserIds: ReadonlyArray<string>;
  /**
   * Free-form payload visible to the consumer. Stays small — large blobs
   * belong on the document itself, not the notification.
   */
  readonly payload?: Prisma.InputJsonValue;
}

export class NotificationEmitter {
  constructor(private readonly db: Db) {}

  /**
   * Insert one outbox row per recipient. Idempotent at the row level — a
   * duplicate emit produces duplicate rows, but the consumer is responsible
   * for de-duping by (eventType, documentId, recipientId) if it cares.
   * For the substrate that's the right tradeoff: we never silently drop.
   */
  async emit(input: EmitInput): Promise<{ rowsCreated: number }> {
    if (input.recipientUserIds.length === 0) {
      return { rowsCreated: 0 };
    }

    const rows = input.recipientUserIds.map((recipientId) => ({
      recipientId,
      eventType: input.eventType,
      documentId: input.documentId,
      ...(input.payload !== undefined && { payload: input.payload }),
    }));

    const result = await this.db.notificationOutbox.createMany({ data: rows });
    return { rowsCreated: result.count };
  }
}
