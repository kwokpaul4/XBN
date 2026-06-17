/**
 * Org service (PHASES.md §1.3).
 */

import type { OrgType, Prisma, PrismaClient } from '@xbn/db';

export interface OrgInput {
  readonly legalName: string;
  readonly displayName: string;
  readonly orgType: OrgType;
  readonly contact?: Prisma.InputJsonValue;
}

export interface OrgDescriptor {
  readonly id: string;
  readonly legalName: string;
  readonly displayName: string;
  readonly orgType: OrgType;
}

export async function createOrg(db: PrismaClient, input: OrgInput): Promise<OrgDescriptor> {
  const row = await db.org.create({
    data: {
      legalName: input.legalName,
      displayName: input.displayName,
      orgType: input.orgType,
      ...(input.contact !== undefined && { contact: input.contact }),
    },
  });
  return descriptor(row);
}

export async function getOrg(db: PrismaClient, orgId: string): Promise<OrgDescriptor | null> {
  const row = await db.org.findUnique({ where: { id: orgId } });
  return row ? descriptor(row) : null;
}

export async function listOrgs(db: PrismaClient): Promise<ReadonlyArray<OrgDescriptor>> {
  const rows = await db.org.findMany({ orderBy: { createdAt: 'asc' } });
  return rows.map(descriptor);
}

function descriptor(row: {
  id: string;
  legalName: string;
  displayName: string;
  orgType: OrgType;
}): OrgDescriptor {
  return {
    id: row.id,
    legalName: row.legalName,
    displayName: row.displayName,
    orgType: row.orgType,
  };
}
