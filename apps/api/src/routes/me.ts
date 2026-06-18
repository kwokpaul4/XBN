import { Router } from 'express';
import { listMembershipsForUser } from '@xbn/auth';
import type { PrismaClient } from '@xbn/db';

import { authMiddleware, mustAuth } from '../auth-middleware.js';

export function meRouter(db: PrismaClient): Router {
  const r = Router();
  r.use(authMiddleware(db));

  r.get('/', async (_req, res) => {
    const ctx = mustAuth(res);
    if (!ctx) return;
    const user = await db.user.findUnique({
      where: { id: ctx.userId },
      select: { id: true, email: true, displayName: true, emailVerifiedAt: true },
    });
    if (!user) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const memberships = await listMembershipsForUser(db, ctx.userId);
    res.json({
      user,
      memberships,
      activeMembership: ctx.activeMembership,
    });
  });

  return r;
}
