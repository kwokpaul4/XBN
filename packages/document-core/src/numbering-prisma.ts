/**
 * Prisma-backed network numbering (PHASES.md §1.5, schema.prisma).
 *
 * Atomically reserves the next number for (issuerOrgId, documentType, prefix).
 * Strategy: Postgres advisory lock keyed by hash(issuer|type), then read
 * MAX(documentNumber) for that scope and increment. The advisory lock is
 * scoped to the transaction — if a caller invokes `next` inside a wider
 * transaction, the lock holds until that transaction commits.
 *
 * Note: we do not store a counter row anywhere. The current max is derived
 * from the documents table itself, so no separate counter to drift out of
 * sync. Tradeoff: a deleted document's number is reused, which is fine for
 * a network MVP.
 */

import type { Prisma, PrismaClient } from '@xbn/db';

import type { NumberingRequest, NumberingStrategy } from './numbering.js';

/** Prisma transaction client (the handle passed into $transaction callbacks). */
type Tx = Prisma.TransactionClient;

/**
 * djb2 hash → signed 64-bit BigInt for Postgres `pg_advisory_xact_lock`.
 * Collision-resistance is sufficient: a collision just costs a small
 * serialisation, correctness is preserved by the SQL underneath.
 */
function hashLockKey(input: string): bigint {
  let hash = 5381n;
  for (let i = 0; i < input.length; i++) {
    const charCode = BigInt(input.charCodeAt(i));
    hash = (hash * 33n) ^ charCode;
    hash = hash & 0xffff_ffff_ffff_ffffn;
  }
  // Postgres advisory lock takes a SIGNED bigint, so center on zero.
  return hash > 0x7fff_ffff_ffff_ffffn ? hash - 0x1_0000_0000_0000_0000n : hash;
}

export class PrismaNetworkNumberingStrategy implements NumberingStrategy {
  /**
   * Pass either the full PrismaClient (for one-shot calls — `next` will open
   * its own transaction) or a Prisma.TransactionClient (for participation in
   * a larger transaction — the lock holds until that transaction commits).
   */
  constructor(private readonly db: PrismaClient | Tx) {}

  async next(request: NumberingRequest): Promise<string> {
    // The "full client" branch supports $transaction; the "tx client" branch
    // does not. We detect by feature presence, which is the documented
    // pattern for code that wants to participate in either context.
    if ('$transaction' in this.db) {
      return this.db.$transaction((tx) => this.exec(tx, request));
    }
    return this.exec(this.db, request);
  }

  private async exec(tx: Tx, request: NumberingRequest): Promise<string> {
    const prefix = request.prefix ?? request.documentType;
    const lockKey = hashLockKey(`${request.issuerOrgId}|${request.documentType}`);

    // Hold the advisory lock for the rest of this transaction.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${lockKey})`;

    // Read the current max for this (issuer, type, prefix). Matching on
    // `documentNumber LIKE prefix-%` rather than just (issuer, type) lets a
    // relationship that switches prefixes mid-life keep separate series per
    // prefix instead of resetting the counter.
    const previous = await tx.document.findFirst({
      where: {
        issuerOrgId: request.issuerOrgId,
        documentType: request.documentType,
        documentNumber: { startsWith: `${prefix}-` },
      },
      orderBy: { documentNumber: 'desc' },
      select: { documentNumber: true },
    });

    const previousNumeric = previous ? parsePrefixedSequential(previous.documentNumber, prefix) : 0;
    const nextValue = previousNumeric + 1;
    return `${prefix}-${String(nextValue).padStart(6, '0')}`;
  }
}

/**
 * Parse "PREFIX-000042" → 42. Returns 0 if the suffix isn't a number.
 */
function parsePrefixedSequential(documentNumber: string, prefix: string): number {
  if (!documentNumber.startsWith(`${prefix}-`)) return 0;
  const tail = documentNumber.slice(prefix.length + 1);
  const n = Number.parseInt(tail, 10);
  return Number.isFinite(n) ? n : 0;
}
