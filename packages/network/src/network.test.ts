/**
 * Integration tests for @xbn/network.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@xbn/db';

import {
  acceptInvitation,
  activateRelationship,
  addIdentifier,
  createOrg,
  createRelationship,
  declineInvitation,
  getRelationshipBetween,
  issueInvitation,
  listIdentifiers,
  listRelationshipsForOrg,
  removeIdentifier,
  suspendRelationship,
  terminateRelationship,
  updateRelationshipConfig,
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
// Org / OrgIdentifier
// ---------------------------------------------------------------------------

describe('Org & OrgIdentifier', () => {
  it('creates an org and lists identifiers', async () => {
    const org = await createOrg(db, {
      legalName: 'Acme Corp',
      displayName: 'Acme',
      orgType: 'BUYER',
    });
    expect(org.id).toBeTypeOf('string');
    const dunsResult = await addIdentifier(db, org.id, 'DUNS', '123456789');
    expect(dunsResult.ok).toBe(true);
    const list = await listIdentifiers(db, org.id);
    expect(list).toHaveLength(1);
    expect(list[0]?.scheme).toBe('DUNS');
  });

  it('rejects two orgs claiming the same (scheme, value)', async () => {
    const a = await createOrg(db, {
      legalName: 'A',
      displayName: 'A',
      orgType: 'BUYER',
    });
    const b = await createOrg(db, {
      legalName: 'B',
      displayName: 'B',
      orgType: 'SUPPLIER',
    });
    const first = await addIdentifier(db, a.id, 'DUNS', '999');
    expect(first.ok).toBe(true);
    const second = await addIdentifier(db, b.id, 'DUNS', '999');
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('duplicate_scheme_value');
  });

  it('removeIdentifier deletes the row', async () => {
    const org = await createOrg(db, {
      legalName: 'A',
      displayName: 'A',
      orgType: 'BUYER',
    });
    const r = await addIdentifier(db, org.id, 'GLN', 'GLN-1');
    if (!r.ok) throw new Error('add failed');
    const removed = await removeIdentifier(db, r.identifier.id);
    expect(removed.removed).toBe(true);
    const after = await listIdentifiers(db, org.id);
    expect(after).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// TradingRelationship lifecycle
// ---------------------------------------------------------------------------

describe('TradingRelationship lifecycle', () => {
  async function createBuyerSupplier() {
    const buyer = await createOrg(db, {
      legalName: 'Buyer',
      displayName: 'Buyer',
      orgType: 'BUYER',
    });
    const supplier = await createOrg(db, {
      legalName: 'Supplier',
      displayName: 'Supplier',
      orgType: 'SUPPLIER',
    });
    return { buyer, supplier };
  }

  it('creates an ACTIVE relationship with config and reads it back', async () => {
    const { buyer, supplier } = await createBuyerSupplier();
    const r = await createRelationship(db, buyer.id, supplier.id, 'ACTIVE', {
      enabledDocumentTypes: ['PO', 'INVOICE'],
      defaultCurrency: 'USD',
      defaultIncoterms: 'FOB',
      summaryInvoicingEnabled: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.relationship.status).toBe('ACTIVE');

    const fetched = await getRelationshipBetween(db, buyer.id, supplier.id);
    expect(fetched?.summaryInvoicingEnabled).toBe(true);
    expect([...(fetched?.enabledDocumentTypes ?? [])].sort()).toEqual(['INVOICE', 'PO']);
  });

  it('rejects duplicate (buyer, supplier) pair', async () => {
    const { buyer, supplier } = await createBuyerSupplier();
    await createRelationship(db, buyer.id, supplier.id, 'ACTIVE');
    const dup = await createRelationship(db, buyer.id, supplier.id, 'ACTIVE');
    expect(dup.ok).toBe(false);
    if (dup.ok) return;
    expect(dup.reason).toBe('already_exists');
  });

  it('PENDING_INVITATION → ACTIVE → SUSPENDED → TERMINATED transitions', async () => {
    const { buyer, supplier } = await createBuyerSupplier();
    const r = await createRelationship(db, buyer.id, supplier.id, 'PENDING_INVITATION');
    if (!r.ok) throw new Error('create failed');

    const activated = await activateRelationship(db, r.relationship.id);
    expect(activated.ok).toBe(true);

    const suspended = await suspendRelationship(db, r.relationship.id);
    expect(suspended.ok).toBe(true);

    const terminated = await terminateRelationship(db, r.relationship.id);
    expect(terminated.ok).toBe(true);

    // Re-terminate is a no-op.
    const again = await terminateRelationship(db, r.relationship.id);
    expect(again.ok).toBe(false);
  });

  it('updateRelationshipConfig only updates provided fields', async () => {
    const { buyer, supplier } = await createBuyerSupplier();
    const r = await createRelationship(db, buyer.id, supplier.id, 'ACTIVE', {
      defaultCurrency: 'USD',
      summaryInvoicingEnabled: false,
    });
    if (!r.ok) throw new Error('create failed');

    await updateRelationshipConfig(db, r.relationship.id, { summaryInvoicingEnabled: true });
    const after = await getRelationshipBetween(db, buyer.id, supplier.id);
    expect(after?.summaryInvoicingEnabled).toBe(true);
    expect(after?.defaultCurrency).toBe('USD'); // untouched
  });

  it('listRelationshipsForOrg returns relationships for either side', async () => {
    const { buyer, supplier } = await createBuyerSupplier();
    await createRelationship(db, buyer.id, supplier.id, 'ACTIVE');
    const fromBuyer = await listRelationshipsForOrg(db, buyer.id);
    const fromSupplier = await listRelationshipsForOrg(db, supplier.id);
    expect(fromBuyer).toHaveLength(1);
    expect(fromSupplier).toHaveLength(1);
    expect(fromBuyer[0]?.id).toBe(fromSupplier[0]?.id);
  });
});

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

describe('RelationshipInvitation', () => {
  async function setup() {
    const inviter = await db.user.create({
      data: { email: 'inviter@example.com', displayName: 'Inviter' },
    });
    const buyer = await createOrg(db, {
      legalName: 'Buyer',
      displayName: 'Buyer',
      orgType: 'BUYER',
    });
    return { inviterId: inviter.id, buyerId: buyer.id };
  }

  it('issue → accept marks ACCEPTED and returns invitedEmail', async () => {
    const { inviterId, buyerId } = await setup();
    const issued = await issueInvitation(db, {
      invitedByUserId: inviterId,
      buyerOrgId: buyerId,
      invitedEmail: 'supplier@example.com',
      invitedOrgName: 'Supplier Co',
    });
    expect(issued.invitation.status).toBe('PENDING');

    const accepted = await acceptInvitation(db, issued.token);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.invitedEmail).toBe('supplier@example.com');
  });

  it('accept rejects invalid token', async () => {
    const result = await acceptInvitation(db, 'not-a-real-token');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid');
  });

  it('cannot accept twice — already_resolved on replay', async () => {
    const { inviterId, buyerId } = await setup();
    const issued = await issueInvitation(db, {
      invitedByUserId: inviterId,
      buyerOrgId: buyerId,
      invitedEmail: 'supplier@example.com',
      invitedOrgName: 'Supplier Co',
    });
    const first = await acceptInvitation(db, issued.token);
    expect(first.ok).toBe(true);
    const second = await acceptInvitation(db, issued.token);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('already_resolved');
  });

  it('decline marks DECLINED and prevents accept', async () => {
    const { inviterId, buyerId } = await setup();
    const issued = await issueInvitation(db, {
      invitedByUserId: inviterId,
      buyerOrgId: buyerId,
      invitedEmail: 'supplier@example.com',
      invitedOrgName: 'Supplier Co',
    });
    const declined = await declineInvitation(db, issued.token);
    expect(declined.ok).toBe(true);
    const tryAccept = await acceptInvitation(db, issued.token);
    expect(tryAccept.ok).toBe(false);
    if (tryAccept.ok) return;
    expect(tryAccept.reason).toBe('already_resolved');
  });
});
