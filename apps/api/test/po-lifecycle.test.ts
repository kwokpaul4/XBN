/**
 * Task #7 acceptance — PO §2.1 full lifecycle.
 *
 * Verifies the canonical Phase 2.1 PO state machine end-to-end via the
 * HTTP layer:
 *
 *   DRAFT → ISSUED → ACKNOWLEDGED → IN_FULFILLMENT → CLOSED
 *
 * Plus negative paths:
 *   - Body schema validation (missing required header fields)
 *   - DRAFT → IN_FULFILLMENT rejected (no_such_transition)
 *   - Supplier trying to issue a buyer-side transition rejected (wrong_actor_side)
 *   - Cancel from ACKNOWLEDGED works for buyer admin
 *   - Numbering sequential per (issuer, type)
 *
 * Phase 2.1's state machine permits CHANGED transitions but Task #8 will
 * tighten them with a guard that requires an accepted PO_CHANGE link;
 * this test deliberately skips CHANGED to avoid pre-empting #8.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@xbn/db';

import { buildApp } from '../src/app.js';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://xbn:xbn_dev@localhost:5432/xbn';

let db: PrismaClient;
let app: ReturnType<typeof buildApp>;

beforeAll(() => {
  db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL }),
    log: ['warn', 'error'],
  });
  app = buildApp(db);
});

beforeEach(async () => {
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
});

afterAll(async () => {
  await db.$disconnect();
});

interface User {
  id: string;
  cookie: string;
}

async function registerVerifyLogin(email: string, password = 'correcthorse'): Promise<User> {
  const reg = await request(app).post('/auth/register').send({ email, password }).expect(201);
  await request(app)
    .post('/auth/verify-email')
    .send({ token: reg.body.verificationToken })
    .expect(200);
  const login = await request(app).post('/auth/login').send({ email, password }).expect(200);
  const setCookie = login.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  const sessionCookie = cookies.find((c) => c.startsWith('xbn_session='));
  if (!sessionCookie) throw new Error('login did not set xbn_session cookie');
  return { id: reg.body.userId as string, cookie: sessionCookie.split(';')[0] ?? '' };
}

async function createOrg(
  user: User,
  legalName: string,
  orgType: 'BUYER' | 'SUPPLIER',
): Promise<string> {
  const res = await request(app)
    .post('/network/orgs')
    .set('Cookie', user.cookie)
    .send({
      legalName,
      displayName: legalName,
      orgType,
      bindAsRole: orgType === 'BUYER' ? 'BUYER_ADMIN' : 'SUPPLIER_ADMIN',
    })
    .expect(201);
  return res.body.org.id as string;
}

interface Setup {
  buyer: User;
  supplier: User;
  buyerOrgId: string;
  supplierOrgId: string;
}

async function setupBuyerSupplierWithRelationship(suffix = ''): Promise<Setup> {
  const buyer = await registerVerifyLogin(`buyer${suffix}@example.com`);
  const supplier = await registerVerifyLogin(`supplier${suffix}@example.com`);
  const buyerOrgId = await createOrg(buyer, 'Buyer Co', 'BUYER');
  const supplierOrgId = await createOrg(supplier, 'Supplier Co', 'SUPPLIER');
  await request(app)
    .post('/network/relationships')
    .set('Cookie', buyer.cookie)
    .set('x-active-org', buyerOrgId)
    .send({
      buyerOrgId,
      supplierOrgId,
      status: 'ACTIVE',
      enabledDocumentTypes: ['PO', 'ORDER_CONFIRMATION'],
      defaultCurrency: 'USD',
    })
    .expect(201);
  return { buyer, supplier, buyerOrgId, supplierOrgId };
}

function validPoBody(): unknown {
  return {
    currency: 'USD',
    paymentTermsRef: 'NET-30',
    incoterms: 'FOB',
    requestedDeliveryDate: '2026-07-15',
    shipTo: {
      name: 'Buyer Receiving',
      line1: '1 Buyer Way',
      city: 'Buyerville',
      countryCode: 'US',
    },
    billTo: {
      name: 'Buyer AP',
      line1: '1 Buyer Way',
      city: 'Buyerville',
      countryCode: 'US',
    },
    lines: [
      {
        sku: 'WIDGET-1',
        description: 'Widget Mk I',
        quantity: 10,
        unitPrice: 12.5,
        unitOfMeasure: 'EA',
      },
      {
        sku: 'WIDGET-2',
        description: 'Widget Mk II',
        quantity: 4,
        unitPrice: 30,
        unitOfMeasure: 'EA',
      },
    ],
  };
}

describe('PO §2.1 lifecycle', () => {
  it('happy path: DRAFT → ISSUED → ACKNOWLEDGED → IN_FULFILLMENT → CLOSED', async () => {
    const s = await setupBuyerSupplierWithRelationship('-h');

    // Buyer publishes the PO
    const poRes = await request(app)
      .post('/documents')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({
        documentType: 'PO',
        recipientOrgId: s.supplierOrgId,
        body: validPoBody(),
      })
      .expect(201);
    const poId = poRes.body.documentId as string;
    expect(poRes.body.documentNumber).toBe('PO-000001');

    // DRAFT → ISSUED (buyer)
    await request(app)
      .post(`/documents/${poId}/transition`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ fromStatus: 'DRAFT', toStatus: 'ISSUED' })
      .expect(200);

    // ISSUED → ACKNOWLEDGED (supplier)
    await request(app)
      .post(`/documents/${poId}/transition`)
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .send({ fromStatus: 'ISSUED', toStatus: 'ACKNOWLEDGED' })
      .expect(200);

    // ACKNOWLEDGED → IN_FULFILLMENT (buyer, observation that ASN arrived)
    await request(app)
      .post(`/documents/${poId}/transition`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ fromStatus: 'ACKNOWLEDGED', toStatus: 'IN_FULFILLMENT' })
      .expect(200);

    // IN_FULFILLMENT → CLOSED (buyer, final GR posted)
    await request(app)
      .post(`/documents/${poId}/transition`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ fromStatus: 'IN_FULFILLMENT', toStatus: 'CLOSED' })
      .expect(200);

    // Final state and audit log
    const final = await request(app)
      .get(`/documents/${poId}`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .expect(200);
    expect(final.body.status).toBe('CLOSED');
    const actions = (final.body.auditLog as { action: string }[]).map((a) => a.action);
    // 1 CREATED + 4 STATUS_CHANGED
    expect(actions.filter((a) => a === 'STATUS_CHANGED')).toHaveLength(4);
    expect(actions[0]).toBe('CREATED');
  });

  it('rejects body missing required header fields', async () => {
    const s = await setupBuyerSupplierWithRelationship('-b');
    const bad = await request(app)
      .post('/documents')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({
        documentType: 'PO',
        recipientOrgId: s.supplierOrgId,
        body: { currency: 'USD', lines: [] }, // missing shipTo, billTo, requestedDeliveryDate; empty lines
      })
      .expect(400);
    expect(bad.body.error).toBe('publish_rejected');
    expect(bad.body.reason.kind).toBe('body_schema');
  });

  it('rejects DRAFT → IN_FULFILLMENT (no such transition)', async () => {
    const s = await setupBuyerSupplierWithRelationship('-d2f');
    const poRes = await request(app)
      .post('/documents')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({
        documentType: 'PO',
        recipientOrgId: s.supplierOrgId,
        body: validPoBody(),
      })
      .expect(201);
    const reject = await request(app)
      .post(`/documents/${poRes.body.documentId}/transition`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ fromStatus: 'DRAFT', toStatus: 'IN_FULFILLMENT' })
      .expect(400);
    expect(reject.body.error).toBe('transition_rejected');
    expect(reject.body.reason.kind).toBe('state_machine');
    expect(reject.body.reason.detail.kind).toBe('no_such_transition');
  });

  it('rejects supplier trying to issue (wrong actor side)', async () => {
    const s = await setupBuyerSupplierWithRelationship('-was');
    const poRes = await request(app)
      .post('/documents')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({
        documentType: 'PO',
        recipientOrgId: s.supplierOrgId,
        body: validPoBody(),
      })
      .expect(201);
    // Supplier (recipient) attempts the buyer-only DRAFT → ISSUED transition
    const reject = await request(app)
      .post(`/documents/${poRes.body.documentId}/transition`)
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .send({ fromStatus: 'DRAFT', toStatus: 'ISSUED' })
      .expect(400);
    expect(reject.body.error).toBe('transition_rejected');
    expect(reject.body.reason.kind).toBe('state_machine');
    // Either 'wrong_role' (SUPPLIER_ADMIN can't issue) or 'wrong_actor_side'
    // depending on which check the machine prioritises — both indicate
    // the supplier was correctly blocked.
    expect(['wrong_role', 'wrong_actor_side']).toContain(reject.body.reason.detail.kind);
  });

  it('cancel from ACKNOWLEDGED is allowed for buyer admin', async () => {
    const s = await setupBuyerSupplierWithRelationship('-c');
    const poRes = await request(app)
      .post('/documents')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({
        documentType: 'PO',
        recipientOrgId: s.supplierOrgId,
        body: validPoBody(),
      })
      .expect(201);
    const poId = poRes.body.documentId as string;

    await request(app)
      .post(`/documents/${poId}/transition`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ fromStatus: 'DRAFT', toStatus: 'ISSUED' })
      .expect(200);
    await request(app)
      .post(`/documents/${poId}/transition`)
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .send({ fromStatus: 'ISSUED', toStatus: 'ACKNOWLEDGED' })
      .expect(200);
    await request(app)
      .post(`/documents/${poId}/transition`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ fromStatus: 'ACKNOWLEDGED', toStatus: 'CANCELLED' })
      .expect(200);

    const final = await request(app)
      .get(`/documents/${poId}`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .expect(200);
    expect(final.body.status).toBe('CANCELLED');
  });

  it('numbering is sequential per (issuer, type)', async () => {
    const s = await setupBuyerSupplierWithRelationship('-n');
    const numbers: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await request(app)
        .post('/documents')
        .set('Cookie', s.buyer.cookie)
        .set('x-active-org', s.buyerOrgId)
        .send({ documentType: 'PO', recipientOrgId: s.supplierOrgId, body: validPoBody() })
        .expect(201);
      numbers.push(r.body.documentNumber as string);
    }
    expect(numbers).toEqual(['PO-000001', 'PO-000002', 'PO-000003']);
  });
});

describe('GET /documents — inbox/outbox listing', () => {
  it('returns inbox docs for the recipient org and outbox docs for the issuer org', async () => {
    const s = await setupBuyerSupplierWithRelationship('-list');

    // Buyer issues 2 POs
    for (let i = 0; i < 2; i++) {
      await request(app)
        .post('/documents')
        .set('Cookie', s.buyer.cookie)
        .set('x-active-org', s.buyerOrgId)
        .send({ documentType: 'PO', recipientOrgId: s.supplierOrgId, body: validPoBody() })
        .expect(201);
    }

    // Buyer outbox
    const outbox = await request(app)
      .get('/documents?box=outbox')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .expect(200);
    expect(outbox.body.total).toBe(2);
    expect(outbox.body.documents).toHaveLength(2);

    // Buyer inbox is empty (no docs sent TO the buyer in this test)
    const buyerInbox = await request(app)
      .get('/documents?box=inbox')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .expect(200);
    expect(buyerInbox.body.total).toBe(0);

    // Supplier inbox sees both
    const supplierInbox = await request(app)
      .get('/documents?box=inbox')
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .expect(200);
    expect(supplierInbox.body.total).toBe(2);

    // Filter by status: only DRAFT POs
    const onlyDraft = await request(app)
      .get('/documents?box=outbox&status=DRAFT')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .expect(200);
    expect(onlyDraft.body.total).toBe(2);
  });
});
