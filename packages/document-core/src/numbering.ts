/**
 * Document numbering (PHASES.md §1.5, schema.prisma `DocumentNumberSource`).
 *
 * Two strategies coexist:
 *
 *   - NETWORK   — XBN issues a sequential number per (issuer_org, document_type)
 *                 using a configurable prefix. The current portal-only MVP uses
 *                 this everywhere.
 *
 *   - EXTERNAL  — the buyer's ERP issues the number; XBN records it verbatim
 *                 and is responsible for uniqueness only at the
 *                 (issuer_org, document_type, document_number) DB index.
 *                 Used in the future Phase 6 when ERPs integrate via cXML/REST.
 *
 * The strategy is selected per *trading relationship*, not per document type
 * or per org — the column lives on TradingRelationship.documentNumberSource.
 *
 * The interface here is pure (no DB). Stage C will provide a Prisma-backed
 * NetworkNumberingStrategy that atomically reserves the next number with
 * SELECT FOR UPDATE / advisory lock. This module exposes the interface, an
 * external pass-through, and an in-memory implementation for tests.
 */

export interface NumberingRequest {
  readonly issuerOrgId: string;
  readonly documentType: string;
  /**
   * Per-relationship prefix override. Lets each buyer configure prefixes like
   * 'PO-' or 'BUY-2026-' on their relationships without code changes.
   */
  readonly prefix?: string;
  /**
   * Only set when source is EXTERNAL. Caller passes the ERP-issued number.
   */
  readonly externalNumber?: string;
}

export interface NumberingStrategy {
  next(request: NumberingRequest): Promise<string>;
}

/**
 * Pass-through: caller must provide externalNumber. Throws if absent.
 */
export class ExternalNumberingStrategy implements NumberingStrategy {
  async next(request: NumberingRequest): Promise<string> {
    if (!request.externalNumber || request.externalNumber.trim().length === 0) {
      throw new Error(
        `ExternalNumberingStrategy: externalNumber is required for ${request.documentType} from ${request.issuerOrgId}`,
      );
    }
    return request.externalNumber;
  }
}

/**
 * In-memory NETWORK numbering for tests and seeds. Maintains a counter per
 * (issuerOrgId, documentType). Format: `${prefix ?? documentType}-${counter}`
 * with zero-padding to 6 digits.
 *
 * Stage C ships a Prisma-backed implementation that reserves numbers atomically
 * across processes; do not use this strategy in production.
 */
export class InMemoryNetworkNumberingStrategy implements NumberingStrategy {
  private readonly counters = new Map<string, number>();

  async next(request: NumberingRequest): Promise<string> {
    const key = `${request.issuerOrgId}|${request.documentType}`;
    const current = this.counters.get(key) ?? 0;
    const nextValue = current + 1;
    this.counters.set(key, nextValue);
    const prefix = request.prefix ?? request.documentType;
    return `${prefix}-${String(nextValue).padStart(6, '0')}`;
  }

  /**
   * Test helper: reset the in-memory counters.
   */
  reset(): void {
    this.counters.clear();
  }
}
