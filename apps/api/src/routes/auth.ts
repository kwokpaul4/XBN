import { Router } from 'express';
import { z } from 'zod';
import {
  completePasswordReset,
  invalidateSession,
  login,
  register,
  requestPasswordReset,
  verifyEmail,
} from '@xbn/auth';
import type { PrismaClient } from '@xbn/db';

import { SESSION_COOKIE_NAME } from '../auth-middleware.js';

const RegisterBody = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().optional(),
});

const VerifyBody = z.object({ token: z.string() });

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string(),
});

const RequestResetBody = z.object({ email: z.string().email() });

const CompleteResetBody = z.object({
  token: z.string(),
  newPassword: z.string().min(8),
});

export function authRouter(db: PrismaClient): Router {
  const r = Router();

  r.post('/register', async (req, res) => {
    const parsed = RegisterBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation', issues: parsed.error.issues });
      return;
    }
    // Strip undefined optional fields to satisfy exactOptionalPropertyTypes.
    const result = await register(db, {
      email: parsed.data.email,
      password: parsed.data.password,
      ...(parsed.data.displayName !== undefined && { displayName: parsed.data.displayName }),
    });
    if (!result.ok) {
      res.status(400).json({ error: result.reason });
      return;
    }
    res.status(201).json({
      userId: result.userId,
      verificationToken: result.verificationToken,
    });
  });

  r.post('/verify-email', async (req, res) => {
    const parsed = VerifyBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation' });
      return;
    }
    const result = await verifyEmail(db, parsed.data.token);
    if (!result.ok) {
      res.status(400).json({ error: result.reason });
      return;
    }
    res.json({ userId: result.userId });
  });

  r.post('/login', async (req, res) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation' });
      return;
    }
    const result = await login(db, parsed.data);
    if (!result.ok) {
      res.status(401).json({ error: result.reason });
      return;
    }
    res.cookie(SESSION_COOKIE_NAME, result.session.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      expires: result.session.session.expiresAt,
    });
    res.json({ userId: result.userId });
  });

  r.post('/logout', async (req, res) => {
    const cookies = req.cookies as Record<string, string | undefined> | undefined;
    const token = cookies?.[SESSION_COOKIE_NAME];
    if (token) {
      await invalidateSession(db, token);
    }
    res.clearCookie(SESSION_COOKIE_NAME);
    res.json({ ok: true });
  });

  r.post('/request-password-reset', async (req, res) => {
    const parsed = RequestResetBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation' });
      return;
    }
    const result = await requestPasswordReset(db, parsed.data.email);
    res.json({ ok: true, token: result.ok ? (result.token ?? null) : null });
  });

  r.post('/complete-password-reset', async (req, res) => {
    const parsed = CompleteResetBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation' });
      return;
    }
    const result = await completePasswordReset(db, parsed.data.token, parsed.data.newPassword);
    if (!result.ok) {
      res.status(400).json({ error: result.reason });
      return;
    }
    res.json({ userId: result.userId });
  });

  return r;
}
