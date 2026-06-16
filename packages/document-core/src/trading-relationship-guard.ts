/**
 * TradingRelationshipGuard (PHASES.md §1.3, CLAUDE.md cross-cutting concern #3).
 *
 * Before any document mutation, callers ask the guard:
 *   - Is there an active TradingRelationship between issuer and recipient?
 *   - Is the document type enabled on that relationship?
 *
 * Centralised here once. Never re-implemented per document type.
 *
 * For SUMMARY invoicing (PHASES.md §2.6) the guard also checks
 * `summaryInvoicingEnabled` when the body indicates SUMMARY mode — the
 * invoice service passes that signal through.
 */

import { type Prisma, type PrismaClient } from '@xbn/db';

type Db = PrismaClient | Prisma.TransactionClient;

export interface GuardRequest {
  readonly issuerOrgId: string;
  readonly recipientOrgId: string;
  readonly documentType: string;
  /**
   * Optional invoice mode signal. Only meaningful when documentType === 'INVOICE'.
   * The guard rejects 'SUMMARY' if the relationship hasn't opted in.
   */
  readonly invoiceMode?: 'PO_FLIP' | 'SUMMARY';
}

export type GuardResult =
  | { readonly ok: true; readonly tradingRelationshipId: string }
  | { readonly ok: false; readonly reason: GuardRejection };

export type GuardRejection =
  | {
      readonly kind: 'no_relationship';
      readonly issuerOrgId: string;
      readonly recipientOrgId: string;
    }
  | { readonly kind: 'relationship_inactive'; readonly status: string }
  | { readonly kind: 'document_type_not_enabled'; readonly documentType: string }
  | { readonly kind: 'summary_invoicing_not_enabled' };

export class TradingRelationshipGuard {
  constructor(private readonly db: Db) {}

  /**
   * Look up the relationship and assert all guard conditions.
   *
   * Direction: a TradingRelationship is stored once with (buyer, supplier).
   * Either side may issue depending on the document type (a supplier issues
   * an INVOICE, a buyer issues a PO). The guard searches both orderings.
   */
  async check(request: GuardRequest): Promise<GuardResult> {
    const relationship = await this.db.tradingRelationship.findFirst({
      where: {
        OR: [
          { buyerOrgId: request.issuerOrgId, supplierOrgId: request.recipientOrgId },
          { buyerOrgId: request.recipientOrgId, supplierOrgId: request.issuerOrgId },
        ],
      },
      select: {
        id: true,
        status: true,
        enabledDocumentTypes: true,
        summaryInvoicingEnabled: true,
      },
    });

    if (!relationship) {
      return {
        ok: false,
        reason: {
          kind: 'no_relationship',
          issuerOrgId: request.issuerOrgId,
          recipientOrgId: request.recipientOrgId,
        },
      };
    }

    if (relationship.status !== 'ACTIVE') {
      return {
        ok: false,
        reason: { kind: 'relationship_inactive', status: relationship.status },
      };
    }

    if (!relationship.enabledDocumentTypes.includes(request.documentType)) {
      return {
        ok: false,
        reason: { kind: 'document_type_not_enabled', documentType: request.documentType },
      };
    }

    if (
      request.documentType === 'INVOICE' &&
      request.invoiceMode === 'SUMMARY' &&
      !relationship.summaryInvoicingEnabled
    ) {
      return { ok: false, reason: { kind: 'summary_invoicing_not_enabled' } };
    }

    return { ok: true, tradingRelationshipId: relationship.id };
  }
}
