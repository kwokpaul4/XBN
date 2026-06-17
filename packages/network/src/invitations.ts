/**
 * RelationshipInvitation service (PHASES.md §1.3).
 *
 * Invitation flow:
 *   1. Buyer admin issues an invitation to an email address.
 *   2. Invitation includes a one-time token (random 32 bytes, hashed at rest).
 *   3. Recipient opens the email link; the front-end calls accept() with the
 *      token. If the recipient is not yet a user, they must register first;
 *      the accept call binds their userId to the invitation.
 *   4. acceptInvitation creates the TradingRelationship (or activates an
 *      existing PENDING_INVITATION one).
 *
 * Tokens follow the same pattern as auth tokens: opaque random in the URL,
 * SHA-256 stored on the row. The invitation row IS the system of record
 * here (not a notification_outbox row), since invitations have richer
 * lifecycle than tokens.
 */

import type { PrismaClient } from '@xbn/db';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeBase32LowerCaseNoPadding, encodeHexLowerCase } from '@oslojs/encoding';

const INVITATION_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export interface InvitationDescriptor {
  readonly id: string;
  readonly invitedByUserId: string;
  readonly invitedEmail: string;
  readonly invitedOrgName: string;
  readonly status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED';
  readonly expiresAt: Date;
}

export interface IssueInvitationInput {
  readonly invitedByUserId: string;
  readonly buyerOrgId: string;
  readonly invitedEmail: string;
  readonly invitedOrgName: string;
}

export interface IssueInvitationResult {
  readonly invitation: InvitationDescriptor;
  /** Plaintext token for the invitation link. Pass to email send. */
  readonly token: string;
}

/**
 * Issue an invitation. The buyer org is implied by the issuer's membership;
 * we record `buyerOrgId` so we know who is doing the inviting and can later
 * scope the relationship correctly.
 */
export async function issueInvitation(
  db: PrismaClient,
  input: IssueInvitationInput,
): Promise<IssueInvitationResult> {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

  const row = await db.relationshipInvitation.create({
    data: {
      invitedByUserId: input.invitedByUserId,
      invitedEmail: normalizeEmail(input.invitedEmail),
      invitedOrgName: input.invitedOrgName,
      token: tokenHash,
      status: 'PENDING',
      expiresAt,
    },
  });

  // Note: buyerOrgId would normally be on the invitation; the schema doesn't
  // currently model it (PHASES.md §1.3 keeps the invitation lean). The
  // accept step looks it up via the inviter's membership.
  void input.buyerOrgId;

  return {
    token,
    invitation: {
      id: row.id,
      invitedByUserId: row.invitedByUserId,
      invitedEmail: row.invitedEmail,
      invitedOrgName: row.invitedOrgName,
      status: row.status as InvitationDescriptor['status'],
      expiresAt: row.expiresAt,
    },
  };
}

export type AcceptInvitationResult =
  | {
      readonly ok: true;
      readonly invitationId: string;
      readonly invitedEmail: string;
      readonly invitedByUserId: string;
    }
  | { readonly ok: false; readonly reason: 'invalid' | 'expired' | 'already_resolved' };

/**
 * Look up an invitation by its plaintext token, validate, mark ACCEPTED.
 * The caller (TradingRelationship layer) then provisions / activates the
 * relationship using the returned info.
 */
export async function acceptInvitation(
  db: PrismaClient,
  token: string,
): Promise<AcceptInvitationResult> {
  const tokenHash = hashToken(token);
  const row = await db.relationshipInvitation.findUnique({ where: { token: tokenHash } });
  if (!row) {
    return { ok: false, reason: 'invalid' };
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    if (row.status === 'PENDING') {
      await db.relationshipInvitation.update({
        where: { id: row.id },
        data: { status: 'EXPIRED' },
      });
    }
    return { ok: false, reason: 'expired' };
  }
  if (row.status !== 'PENDING') {
    return { ok: false, reason: 'already_resolved' };
  }
  const updated = await db.relationshipInvitation.updateMany({
    where: { id: row.id, status: 'PENDING' },
    data: { status: 'ACCEPTED', acceptedAt: new Date() },
  });
  if (updated.count === 0) {
    return { ok: false, reason: 'already_resolved' };
  }
  return {
    ok: true,
    invitationId: row.id,
    invitedEmail: row.invitedEmail,
    invitedByUserId: row.invitedByUserId,
  };
}

export async function declineInvitation(db: PrismaClient, token: string): Promise<{ ok: boolean }> {
  const tokenHash = hashToken(token);
  const result = await db.relationshipInvitation.updateMany({
    where: { token: tokenHash, status: 'PENDING' },
    data: { status: 'DECLINED', declinedAt: new Date() },
  });
  return { ok: result.count > 0 };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return encodeBase32LowerCaseNoPadding(bytes);
}

function hashToken(token: string): string {
  return encodeHexLowerCase(sha256(new TextEncoder().encode(token)));
}
