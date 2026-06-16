/**
 * Integration tests for @xbn/auth.
 *
 * Run against the docker-compose Postgres. Each test gets a clean DB via
 * truncateAll from @xbn/document-core's test-helpers (re-imported here).
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@xbn/db';

import {
  ANY_ADMIN,
  addMembership,
  assertRole,
  completePasswordReset,
  findMembership,
  listMembershipsForUser,
  login,
  register,
  requestPasswordReset,
  validateSession,
  verifyEmail,
} from './index.js';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://xbn:xbn_dev@localhost:5432/xbn';

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL }),
  log: ['warn', 'error'],
});

async function truncate(): Promise<void> {
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE
      attachments,
      document_audit_log,
      document_links,
      document_versions,
      documents,
      relationship_invitations,
      trading_relationships,
      org_identifiers,
      user_org_memberships,
      user_sessions,
      orgs,
      users,
      notification_outbox
    RESTART IDENTITY CASCADE
  `);
}

beforeEach(async () => {
  await truncate();
});

afterAll(async () => {
  await db.$disconnect();
});

// ---------------------------------------------------------------------------
// register / verifyEmail / login
// ---------------------------------------------------------------------------

describe('register + verifyEmail', () => {
  it('registers a user, issues a verification token, login fails until verified', async () => {
    const reg = await register(db, {
      email: 'alice@example.com',
      password: 'correcthorse',
      displayName: 'Alice',
    });
    expect(reg.ok).toBe(true);
    if (!reg.ok) return;

    // Login before verification: rejected.
    const earlyLogin = await login(db, {
      email: 'alice@example.com',
      password: 'correcthorse',
    });
    expect(earlyLogin.ok).toBe(false);
    if (earlyLogin.ok) return;
    expect(earlyLogin.reason).toBe('email_not_verified');

    // Verify with the token, then login succeeds.
    const verified = await verifyEmail(db, reg.verificationToken);
    expect(verified.ok).toBe(true);

    const loginResult = await login(db, {
      email: 'alice@example.com',
      password: 'correcthorse',
    });
    expect(loginResult.ok).toBe(true);
  });

  it('rejects duplicate email', async () => {
    await register(db, { email: 'alice@example.com', password: 'correcthorse' });
    const dup = await register(db, { email: 'alice@example.com', password: 'differentpw' });
    expect(dup.ok).toBe(false);
    if (dup.ok) return;
    expect(dup.reason).toBe('email_taken');
  });

  it('rejects short password', async () => {
    const result = await register(db, { email: 'alice@example.com', password: 'short' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('password_too_short');
  });

  it('login with wrong password rejects with invalid_credentials (uniform timing)', async () => {
    const reg = await register(db, { email: 'alice@example.com', password: 'correcthorse' });
    if (!reg.ok) throw new Error('reg failed');
    await verifyEmail(db, reg.verificationToken);

    const result = await login(db, {
      email: 'alice@example.com',
      password: 'WRONGPASSWORD',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid_credentials');
  });

  it('login with unknown email also returns invalid_credentials (no user enumeration)', async () => {
    const result = await login(db, {
      email: 'nobody@example.com',
      password: 'whatever',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid_credentials');
  });
});

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

describe('sessions', () => {
  it('login produces a session token; validateSession resolves it', async () => {
    const reg = await register(db, { email: 'alice@example.com', password: 'correcthorse' });
    if (!reg.ok) throw new Error('reg failed');
    await verifyEmail(db, reg.verificationToken);

    const loginResult = await login(db, {
      email: 'alice@example.com',
      password: 'correcthorse',
    });
    if (!loginResult.ok) throw new Error('login failed');

    const v = await validateSession(db, loginResult.session.token);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.session.userId).toBe(reg.userId);
  });

  it('validateSession rejects unknown token', async () => {
    const v = await validateSession(db, 'not-a-real-token');
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe('invalid');
  });
});

// ---------------------------------------------------------------------------
// password reset
// ---------------------------------------------------------------------------

describe('password reset', () => {
  it('full flow: request → consume token → old sessions invalidated', async () => {
    const reg = await register(db, { email: 'alice@example.com', password: 'correcthorse' });
    if (!reg.ok) throw new Error('reg failed');
    await verifyEmail(db, reg.verificationToken);

    const loginResult = await login(db, {
      email: 'alice@example.com',
      password: 'correcthorse',
    });
    if (!loginResult.ok) throw new Error('login failed');
    const oldToken = loginResult.session.token;

    const reset = await requestPasswordReset(db, 'alice@example.com');
    expect(reset.ok).toBe(true);
    if (!reset.ok) return;
    expect(reset.token).toBeTypeOf('string');
    if (!reset.token) throw new Error('expected token');

    const completed = await completePasswordReset(db, reset.token, 'newpassword123');
    expect(completed.ok).toBe(true);

    // Old session is gone.
    const oldSession = await validateSession(db, oldToken);
    expect(oldSession.ok).toBe(false);

    // Old password no longer works.
    const oldLogin = await login(db, {
      email: 'alice@example.com',
      password: 'correcthorse',
    });
    expect(oldLogin.ok).toBe(false);

    // New password works.
    const newLogin = await login(db, {
      email: 'alice@example.com',
      password: 'newpassword123',
    });
    expect(newLogin.ok).toBe(true);
  });

  it('requestPasswordReset for unknown email returns ok with null token (no enumeration)', async () => {
    const result = await requestPasswordReset(db, 'nobody@example.com');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token).toBeNull();
  });

  it('reset token cannot be replayed', async () => {
    const reg = await register(db, { email: 'alice@example.com', password: 'correcthorse' });
    if (!reg.ok) throw new Error('reg failed');
    await verifyEmail(db, reg.verificationToken);

    const reset = await requestPasswordReset(db, 'alice@example.com');
    if (!reset.ok || !reset.token) throw new Error('reset failed');
    const first = await completePasswordReset(db, reset.token, 'newpassword123');
    expect(first.ok).toBe(true);

    const second = await completePasswordReset(db, reset.token, 'anothernew123');
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(['consumed', 'invalid']).toContain(second.reason);
  });
});

// ---------------------------------------------------------------------------
// memberships + guards
// ---------------------------------------------------------------------------

describe('memberships + guards', () => {
  async function createUserAndOrgs() {
    const reg = await register(db, { email: 'admin@example.com', password: 'correcthorse' });
    if (!reg.ok) throw new Error('reg failed');
    await verifyEmail(db, reg.verificationToken);
    const orgA = await db.org.create({
      data: { legalName: 'Org A', displayName: 'A', orgType: 'BUYER' },
    });
    const orgB = await db.org.create({
      data: { legalName: 'Org B', displayName: 'B', orgType: 'SUPPLIER' },
    });
    return { userId: reg.userId, orgAId: orgA.id, orgBId: orgB.id };
  }

  it('a user can hold memberships in multiple orgs with distinct roles', async () => {
    const { userId, orgAId, orgBId } = await createUserAndOrgs();
    await addMembership(db, userId, orgAId, 'BUYER_ADMIN');
    await addMembership(db, userId, orgBId, 'SUPPLIER_USER');

    const list = await listMembershipsForUser(db, userId);
    expect(list).toHaveLength(2);
    const orgARole = list.find((m) => m.orgId === orgAId)?.role;
    const orgBRole = list.find((m) => m.orgId === orgBId)?.role;
    expect(orgARole).toBe('BUYER_ADMIN');
    expect(orgBRole).toBe('SUPPLIER_USER');
  });

  it('findMembership returns the right row or null', async () => {
    const { userId, orgAId, orgBId } = await createUserAndOrgs();
    await addMembership(db, userId, orgAId, 'BUYER_ADMIN');
    const found = await findMembership(db, userId, orgAId);
    expect(found?.role).toBe('BUYER_ADMIN');
    const missing = await findMembership(db, userId, orgBId);
    expect(missing).toBeNull();
  });

  it('assertRole accepts allowed role', async () => {
    const { userId, orgAId } = await createUserAndOrgs();
    await addMembership(db, userId, orgAId, 'BUYER_ADMIN');
    const m = await findMembership(db, userId, orgAId);
    const result = assertRole(m, ANY_ADMIN);
    expect(result.ok).toBe(true);
  });

  it('assertRole rejects with wrong_role when role is not in allowlist', async () => {
    const { userId, orgAId } = await createUserAndOrgs();
    await addMembership(db, userId, orgAId, 'BUYER_USER');
    const m = await findMembership(db, userId, orgAId);
    const result = assertRole(m, ANY_ADMIN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('wrong_role');
  });

  it('assertRole rejects with no_membership when membership is null', () => {
    const result = assertRole(null, ANY_ADMIN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_membership');
  });
});
