/**
 * OrgIdentifier service (PHASES.md §1.3).
 *
 * Multiple identifiers per org: DUNS, GLN, tax IDs, buyer-internal supplier
 * IDs. (scheme, value) is globally unique to prevent two orgs claiming the
 * same external identifier.
 */

import type { PrismaClient } from '@xbn/db';

export interface OrgIdentifierDescriptor {
  readonly id: string;
  readonly orgId: string;
  readonly scheme: string;
  readonly value: string;
}

export type AddIdentifierResult =
  | { readonly ok: true; readonly identifier: OrgIdentifierDescriptor }
  | { readonly ok: false; readonly reason: 'duplicate_scheme_value' };

export async function addIdentifier(
  db: PrismaClient,
  orgId: string,
  scheme: string,
  value: string,
): Promise<AddIdentifierResult> {
  try {
    const row = await db.orgIdentifier.create({
      data: { orgId, scheme, value },
    });
    return {
      ok: true,
      identifier: { id: row.id, orgId: row.orgId, scheme: row.scheme, value: row.value },
    };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { ok: false, reason: 'duplicate_scheme_value' };
    }
    throw err;
  }
}

export async function listIdentifiers(
  db: PrismaClient,
  orgId: string,
): Promise<ReadonlyArray<OrgIdentifierDescriptor>> {
  const rows = await db.orgIdentifier.findMany({
    where: { orgId },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => ({ id: r.id, orgId: r.orgId, scheme: r.scheme, value: r.value }));
}

export async function removeIdentifier(
  db: PrismaClient,
  identifierId: string,
): Promise<{ removed: boolean }> {
  const result = await db.orgIdentifier.deleteMany({ where: { id: identifierId } });
  return { removed: result.count > 0 };
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown };
  return e.code === 'P2002';
}
