/**
 * Authorization guards (PHASES.md §1.2).
 *
 * The role hierarchy is a flat enum, not a tree. A guard is just a check
 * that the membership's role is in an allowlist. This is intentionally
 * simple — RBAC trees and capability ACLs are out of MVP scope.
 *
 * Used by:
 *   - apps/api NestJS guards
 *   - any direct service-call site that needs to enforce a role
 */

import type { OrgRole } from '@xbn/db';

import type { MembershipDescriptor } from './memberships.js';

export type AssertRoleResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'no_membership' | 'wrong_role' };

/**
 * Returns ok if `membership` exists and its role is in `allowed`.
 */
export function assertRole(
  membership: MembershipDescriptor | null,
  allowed: ReadonlyArray<OrgRole>,
): AssertRoleResult {
  if (!membership) {
    return { ok: false, reason: 'no_membership' };
  }
  if (!allowed.includes(membership.role)) {
    return { ok: false, reason: 'wrong_role' };
  }
  return { ok: true };
}

/**
 * Convenience: ADMIN-class roles for when a feature should be visible to
 * any admin (org-internal or network-wide).
 */
export const ANY_ADMIN: ReadonlyArray<OrgRole> = ['BUYER_ADMIN', 'SUPPLIER_ADMIN', 'NETWORK_ADMIN'];

export const NETWORK_ADMIN_ONLY: ReadonlyArray<OrgRole> = ['NETWORK_ADMIN'];

export const BUYER_SIDE: ReadonlyArray<OrgRole> = ['BUYER_USER', 'BUYER_ADMIN'];
export const SUPPLIER_SIDE: ReadonlyArray<OrgRole> = ['SUPPLIER_USER', 'SUPPLIER_ADMIN'];
