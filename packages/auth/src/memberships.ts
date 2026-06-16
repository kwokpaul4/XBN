/**
 * Multi-org membership management (PHASES.md §1.3 prerequisite).
 *
 * A user may belong to multiple Orgs with a distinct OrgRole per (user, org).
 * The org switcher picks the active membership; every API request carries
 * the active org id in a header so the server can resolve the membership.
 */

import type { OrgRole, PrismaClient } from '@xbn/db';

export interface MembershipDescriptor {
  readonly id: string;
  readonly userId: string;
  readonly orgId: string;
  readonly role: OrgRole;
}

/**
 * Add a user to an org with a role. Fails if a membership already exists —
 * caller decides whether to update the role or call this idempotently.
 */
export async function addMembership(
  db: PrismaClient,
  userId: string,
  orgId: string,
  role: OrgRole,
): Promise<MembershipDescriptor> {
  const row = await db.userOrgMembership.create({
    data: { userId, orgId, role },
  });
  return { id: row.id, userId: row.userId, orgId: row.orgId, role: row.role };
}

export async function listMembershipsForUser(
  db: PrismaClient,
  userId: string,
): Promise<ReadonlyArray<MembershipDescriptor>> {
  const rows = await db.userOrgMembership.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => ({ id: r.id, userId: r.userId, orgId: r.orgId, role: r.role }));
}

export async function findMembership(
  db: PrismaClient,
  userId: string,
  orgId: string,
): Promise<MembershipDescriptor | null> {
  const row = await db.userOrgMembership.findUnique({
    where: { userId_orgId: { userId, orgId } },
  });
  if (!row) return null;
  return { id: row.id, userId: row.userId, orgId: row.orgId, role: row.role };
}

/**
 * Remove a user's membership in an org. Cascades sessions only if the user
 * has no remaining memberships (handled by the caller — we don't auto-prune
 * sessions here because admin-only memberships are common).
 */
export async function removeMembership(
  db: PrismaClient,
  userId: string,
  orgId: string,
): Promise<{ removed: boolean }> {
  const result = await db.userOrgMembership.deleteMany({
    where: { userId, orgId },
  });
  return { removed: result.count > 0 };
}
