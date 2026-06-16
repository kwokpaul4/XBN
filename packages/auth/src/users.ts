/**
 * User registration, login, password reset (PHASES.md §1.2).
 *
 * All flows return typed result objects (ok/reason). Lower layers throw on
 * unexpected DB errors; auth-business rejections (wrong password, email
 * already taken, expired token) are non-exceptional results.
 */

import type { PrismaClient } from '@xbn/db';

import { hashPassword, verifyPassword } from './password.js';
import { createSession, invalidateAllUserSessions, type CreateSessionResult } from './sessions.js';
import { consumeAuthToken, issueAuthToken } from './tokens.js';

export interface RegisterInput {
  readonly email: string;
  readonly password: string;
  readonly displayName?: string;
}

export type RegisterResult =
  | {
      readonly ok: true;
      readonly userId: string;
      /** Plaintext verification token; pass to email send. */
      readonly verificationToken: string;
    }
  | { readonly ok: false; readonly reason: 'email_taken' | 'password_too_short' };

export async function register(db: PrismaClient, input: RegisterInput): Promise<RegisterResult> {
  if (input.password.length < 8) {
    return { ok: false, reason: 'password_too_short' };
  }

  const email = normalizeEmail(input.email);
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    return { ok: false, reason: 'email_taken' };
  }

  const passwordHash = await hashPassword(input.password);
  const user = await db.user.create({
    data: {
      email,
      passwordHash,
      ...(input.displayName !== undefined && { displayName: input.displayName }),
    },
  });

  const issued = await issueAuthToken(db, user.id, 'EMAIL_VERIFICATION');

  return { ok: true, userId: user.id, verificationToken: issued.token };
}

export type VerifyEmailResult =
  | { readonly ok: true; readonly userId: string }
  | { readonly ok: false; readonly reason: 'invalid' | 'expired' | 'consumed' };

export async function verifyEmail(db: PrismaClient, token: string): Promise<VerifyEmailResult> {
  const result = await consumeAuthToken(db, token, 'EMAIL_VERIFICATION');
  if (!result.ok) {
    return { ok: false, reason: result.reason };
  }
  await db.user.update({
    where: { id: result.userId },
    data: { emailVerifiedAt: new Date() },
  });
  return { ok: true, userId: result.userId };
}

export interface LoginInput {
  readonly email: string;
  readonly password: string;
}

export type LoginResult =
  | { readonly ok: true; readonly userId: string; readonly session: CreateSessionResult }
  | { readonly ok: false; readonly reason: 'invalid_credentials' | 'email_not_verified' };

export async function login(db: PrismaClient, input: LoginInput): Promise<LoginResult> {
  const email = normalizeEmail(input.email);
  const user = await db.user.findUnique({ where: { email } });
  // Always run verifyPassword to keep response time roughly constant
  // whether or not the email exists.
  const fakeHash =
    '$argon2id$v=19$m=65536,t=3,p=4$YWJjZGVmZ2hpamtsbW5vcA$jH9Cq5/4tZRjzyf9dPb5q1gLMx8sB0c8eF4xJU7EgGM';
  const valid = await verifyPassword(input.password, user?.passwordHash ?? fakeHash);
  if (!user || !user.passwordHash || !valid) {
    return { ok: false, reason: 'invalid_credentials' };
  }
  if (!user.emailVerifiedAt) {
    return { ok: false, reason: 'email_not_verified' };
  }

  const session = await createSession(db, user.id);
  return { ok: true, userId: user.id, session };
}

export type RequestPasswordResetResult =
  | { readonly ok: true; readonly token: string | null /* null if email unknown — silent */ }
  | { readonly ok: false; readonly reason: never };

export async function requestPasswordReset(
  db: PrismaClient,
  email: string,
): Promise<RequestPasswordResetResult> {
  const normalized = normalizeEmail(email);
  const user = await db.user.findUnique({ where: { email: normalized } });
  // Don't disclose whether the email exists. Always return ok:true; the
  // token is null when there's no user. The UI should say "if that
  // address is on file, you'll get an email".
  if (!user) {
    return { ok: true, token: null };
  }
  const issued = await issueAuthToken(db, user.id, 'PASSWORD_RESET');
  return { ok: true, token: issued.token };
}

export type CompletePasswordResetResult =
  | { readonly ok: true; readonly userId: string }
  | {
      readonly ok: false;
      readonly reason: 'invalid' | 'expired' | 'consumed' | 'password_too_short';
    };

export async function completePasswordReset(
  db: PrismaClient,
  token: string,
  newPassword: string,
): Promise<CompletePasswordResetResult> {
  if (newPassword.length < 8) {
    return { ok: false, reason: 'password_too_short' };
  }
  const result = await consumeAuthToken(db, token, 'PASSWORD_RESET');
  if (!result.ok) {
    return { ok: false, reason: result.reason };
  }
  const newHash = await hashPassword(newPassword);
  await db.user.update({
    where: { id: result.userId },
    data: { passwordHash: newHash },
  });
  // Security: nuke all existing sessions, force re-login everywhere.
  await invalidateAllUserSessions(db, result.userId);
  return { ok: true, userId: result.userId };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
