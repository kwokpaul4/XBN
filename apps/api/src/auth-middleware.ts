/**
 * Auth helper. Stores the auth context on res.locals (typed via this
 * module's `readAuth`/`mustAuth` getters) — NO global Request augmentation,
 * which fights TypeScript in Express 5.
 *
 * Route handlers call `mustAuth(res)` to get a typed context object or
 * have a 401 sent back automatically.
 */

import type { NextFunction, Request, Response } from 'express';
import {
  findMembership,
  listMembershipsForUser,
  validateSession,
  type MembershipDescriptor,
} from '@xbn/auth';
import type { OrgRole, PrismaClient } from '@xbn/db';

export const SESSION_COOKIE_NAME = 'xbn_session';

export interface AuthContext {
  readonly userId: string;
  readonly sessionId: string;
  readonly activeMembership: MembershipDescriptor | null;
}

const LOCALS_KEY = 'xbnAuth';

export function authMiddleware(db: PrismaClient) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const cookies = req.cookies as Record<string, string | undefined> | undefined;
    const token = cookies?.[SESSION_COOKIE_NAME];
    if (!token) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const session = await validateSession(db, token);
    if (!session.ok) {
      res.status(401).json({ error: 'unauthenticated', reason: session.reason });
      return;
    }

    const activeOrgHeader = req.header('x-active-org');
    let activeMembership: MembershipDescriptor | null = null;
    if (activeOrgHeader) {
      activeMembership = await findMembership(db, session.session.userId, activeOrgHeader);
      if (!activeMembership) {
        res.status(403).json({ error: 'no_membership_in_active_org' });
        return;
      }
    } else {
      const list = await listMembershipsForUser(db, session.session.userId);
      activeMembership = list[0] ?? null;
    }

    const ctx: AuthContext = {
      userId: session.session.userId,
      sessionId: session.session.id,
      activeMembership,
    };
    (res.locals as Record<string, unknown>)[LOCALS_KEY] = ctx;
    next();
  };
}

/**
 * Read the auth context written by authMiddleware. Returns null if the
 * route isn't behind authMiddleware.
 */
export function readAuth(res: Response): AuthContext | null {
  const locals = res.locals as Record<string, unknown>;
  const ctx = locals[LOCALS_KEY] as AuthContext | undefined;
  return ctx ?? null;
}

/**
 * Convenience: read auth or send 401 and return null.
 *   const ctx = mustAuth(res); if (!ctx) return;
 */
export function mustAuth(res: Response): AuthContext | null {
  const ctx = readAuth(res);
  if (!ctx) {
    res.status(401).json({ error: 'unauthenticated' });
    return null;
  }
  return ctx;
}

/**
 * Convenience: ensure active membership has one of the allowed roles.
 */
export function mustRole(res: Response, allowed: ReadonlyArray<OrgRole>): AuthContext | null {
  const ctx = mustAuth(res);
  if (!ctx) return null;
  if (!ctx.activeMembership) {
    res.status(403).json({ error: 'no_active_membership' });
    return null;
  }
  if (!allowed.includes(ctx.activeMembership.role)) {
    res.status(403).json({
      error: 'wrong_role',
      required: allowed,
      actual: ctx.activeMembership.role,
    });
    return null;
  }
  return ctx;
}
