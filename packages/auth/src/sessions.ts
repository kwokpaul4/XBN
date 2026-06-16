/**
 * Session management. Tokens are random 32-byte values, base32-encoded in
 * the cookie. The DB stores SHA-256 of the token as the session id; the
 * raw token is never persisted.
 *
 * Cookie value layout (base32, no padding): TOKEN
 * DB session.id: SHA-256(TOKEN) hex
 *
 * Sessions live for 30 days, sliding window: each successful validate()
 * call extends expiry by another 30 days if the session is older than
 * 15 days. This is the same pattern Lucia v3 used and is a good default.
 */

import type { PrismaClient } from '@xbn/db';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeBase32LowerCaseNoPadding, encodeHexLowerCase } from '@oslojs/encoding';

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_REFRESH_THRESHOLD_MS = 15 * 24 * 60 * 60 * 1000; // refresh if < 15d remaining

export interface SessionDescriptor {
  /** Session id in DB. */
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: Date;
}

export interface CreateSessionResult {
  /** Raw token to put in the cookie. NEVER persisted. */
  readonly token: string;
  readonly session: SessionDescriptor;
}

export type ValidateSessionResult =
  | { readonly ok: true; readonly session: SessionDescriptor; readonly refreshed: boolean }
  | { readonly ok: false; readonly reason: 'invalid' | 'expired' };

/**
 * Generate a new random token + persist its hash as a session row.
 * Returns both the token (for the cookie) and the session descriptor.
 */
export async function createSession(
  db: PrismaClient,
  userId: string,
): Promise<CreateSessionResult> {
  const token = generateToken();
  const sessionId = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);

  const session = await db.userSession.create({
    data: { id: sessionId, userId, expiresAt },
  });

  return {
    token,
    session: { id: session.id, userId: session.userId, expiresAt: session.expiresAt },
  };
}

/**
 * Look up a session by its cookie token. Validates expiry and refreshes if
 * we're inside the sliding window.
 *
 * Returns ok:false / 'invalid' for an unknown id (forgery, expired session
 * cleanup, etc.) and ok:false / 'expired' for an expired session that we
 * also delete from the DB.
 */
export async function validateSession(
  db: PrismaClient,
  token: string,
): Promise<ValidateSessionResult> {
  const sessionId = hashToken(token);
  const session = await db.userSession.findUnique({ where: { id: sessionId } });
  if (!session) {
    return { ok: false, reason: 'invalid' };
  }

  const now = Date.now();
  if (session.expiresAt.getTime() <= now) {
    await db.userSession.delete({ where: { id: sessionId } }).catch(() => {});
    return { ok: false, reason: 'expired' };
  }

  // Sliding refresh.
  let refreshed = false;
  let expiresAt = session.expiresAt;
  if (session.expiresAt.getTime() - now < SESSION_REFRESH_THRESHOLD_MS) {
    expiresAt = new Date(now + SESSION_LIFETIME_MS);
    await db.userSession.update({ where: { id: sessionId }, data: { expiresAt } });
    refreshed = true;
  }

  return {
    ok: true,
    refreshed,
    session: { id: session.id, userId: session.userId, expiresAt },
  };
}

/**
 * Logout: delete the session row by token.
 */
export async function invalidateSession(db: PrismaClient, token: string): Promise<void> {
  const sessionId = hashToken(token);
  await db.userSession.delete({ where: { id: sessionId } }).catch(() => {});
}

/**
 * Logout-all: delete every session for a user. Used after password reset.
 */
export async function invalidateAllUserSessions(db: PrismaClient, userId: string): Promise<void> {
  await db.userSession.deleteMany({ where: { userId } });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return encodeBase32LowerCaseNoPadding(bytes);
}

function hashToken(token: string): string {
  return encodeHexLowerCase(sha256(new TextEncoder().encode(token)));
}
