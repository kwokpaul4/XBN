/**
 * Email-verification and password-reset tokens.
 *
 * Tokens follow the same pattern as session tokens: random 32 bytes,
 * base32-encoded in the link, SHA-256 hashed at rest. We store them in
 * dedicated tables — but Phase 1 hasn't migrated those yet, so we
 * piggyback on `notification_outbox` rows tagged with eventType
 * 'EMAIL_VERIFICATION_PENDING' / 'PASSWORD_RESET_PENDING' as the
 * canonical record. The token's hash is stored in the payload JSONB.
 *
 * A future migration will lift these into proper `auth_tokens` rows;
 * for now this keeps Phase 1.2 small without blocking on a schema change.
 */

import type { PrismaClient } from '@xbn/db';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeBase32LowerCaseNoPadding, encodeHexLowerCase } from '@oslojs/encoding';

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const RESET_TTL_MS = 1 * 60 * 60 * 1000; // 1h

export type AuthTokenKind = 'EMAIL_VERIFICATION' | 'PASSWORD_RESET';

export interface IssueTokenResult {
  /** The plaintext token to embed in the email link. NEVER persisted. */
  readonly token: string;
  readonly expiresAt: Date;
}

export async function issueAuthToken(
  db: PrismaClient,
  userId: string,
  kind: AuthTokenKind,
): Promise<IssueTokenResult> {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const ttl = kind === 'EMAIL_VERIFICATION' ? VERIFICATION_TTL_MS : RESET_TTL_MS;
  const expiresAt = new Date(Date.now() + ttl);

  await db.notificationOutbox.create({
    data: {
      recipientId: userId,
      eventType:
        kind === 'EMAIL_VERIFICATION' ? 'EMAIL_VERIFICATION_PENDING' : 'PASSWORD_RESET_PENDING',
      payload: { tokenHash, expiresAt: expiresAt.toISOString() },
    },
  });

  return { token, expiresAt };
}

export type ConsumeTokenResult =
  | { readonly ok: true; readonly userId: string }
  | { readonly ok: false; readonly reason: 'invalid' | 'expired' | 'consumed' };

/**
 * Look up a token by its hash, verify expiry, mark consumed (DELIVERED),
 * and return the userId. Single-use.
 */
export async function consumeAuthToken(
  db: PrismaClient,
  token: string,
  kind: AuthTokenKind,
): Promise<ConsumeTokenResult> {
  const tokenHash = hashToken(token);
  const eventType =
    kind === 'EMAIL_VERIFICATION' ? 'EMAIL_VERIFICATION_PENDING' : 'PASSWORD_RESET_PENDING';

  // Find a PENDING outbox row whose payload.tokenHash matches.
  const candidates = await db.notificationOutbox.findMany({
    where: {
      eventType,
      status: 'PENDING',
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  const match = candidates.find((row) => {
    const payload = row.payload as { tokenHash?: string } | null;
    return payload?.tokenHash === tokenHash;
  });

  if (!match) {
    return { ok: false, reason: 'invalid' };
  }

  const payload = match.payload as { expiresAt?: string };
  const expiresAt = payload.expiresAt ? new Date(payload.expiresAt) : null;
  if (!expiresAt || expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: 'expired' };
  }

  // Mark consumed by flipping status. CANCELLED would also work; DELIVERED
  // signals "we acted on it".
  const updated = await db.notificationOutbox.updateMany({
    where: { id: match.id, status: 'PENDING' },
    data: { status: 'DELIVERED', deliveredAt: new Date() },
  });
  if (updated.count === 0) {
    return { ok: false, reason: 'consumed' };
  }

  return { ok: true, userId: match.recipientId };
}

// ---------------------------------------------------------------------------

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return encodeBase32LowerCaseNoPadding(bytes);
}

function hashToken(token: string): string {
  return encodeHexLowerCase(sha256(new TextEncoder().encode(token)));
}
