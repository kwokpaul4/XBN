/**
 * Task #9 acceptance — ORDER_CONFIRMATION §2.3 full choreography.
 *
 * Three response modes:
 *   FULL_ACCEPT          → simple ack, buyer transitions PO normally.
 *   ACCEPT_WITH_CHANGES  → supplier proposes amendments; buyer reviews
 *                          and ACCEPTED_BY_BUYER (then issues PO_CHANGE
 *                          to materialise) or REJECTED_BY_BUYER.
 *   REJECT               → supplier declines.
 *
 * Auto-link verification: ORDER_CONFIRMATION publish auto-creates the
 * ACKNOWLEDGES → PO link. No second POST needed.
 *
 * Buyer-response transitions (ISSUED → ACCEPTED_BY_BUYER /
 * REJECTED_BY_BUYER) are new in §2.3.
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

async function setupBuyerSupplier(suffix = ''): Promise<Setup> {
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
      enabledDocumentTypes: ['PO', 'ORDER_CONFIRMATION', 'PO_CHANGE'],
      defaultCurrency: 'USD',
    })
    .expect(201);
  return { buyer, supplier, buyerOrgId, supplierOrgId };
}

function poBody(): unknown {
  return {
    currency: 'USD',
    paymentTermsRef: 'NET-30',
    requestedDeliveryDate: '2026-07-15',
    shipTo: {
      name: 'Buyer Receiving',
      line1: '1 Buyer Way',
      city: 'Buyerville',
      countryCode: 'US',
    },
    billTo: { name: 'Buyer AP', line1: '1 Buyer Way', city: 'Buyerville', countryCode: 'US' },
    lines: [
      {
        sku: 'WIDGET-1',
        description: 'Widget Mk I',
        quantity: 5,
        unitPrice: 10,
        unitOfMeasure: 'EA',
        lineRef: 'L-001',
      },
    ],
  };
}

async function publishPo(s: Setup): Promise<{ poId: string; poNumber: string }> {
  const res = await request(app)
    .post('/documents')
    .set('Cookie', s.buyer.cookie)
    .set('x-active-org', s.buyerOrgId)
    .send({ documentType: 'PO', recipientOrgId: s.supplierOrgId, body: poBody() })
    .expect(201);
  await request(app)
    .post(`/documents/${res.body.documentId}/transition`)
    .set('Cookie', s.buyer.cookie)
    .set('x-active-org', s.buyerOrgId)
    .send({ fromStatus: 'DRAFT', toStatus: 'ISSUED' })
    .expect(200);
  return { poId: res.body.documentId, poNumber: res.body.documentNumber };
}

describe('ORDER_CONFIRMATION §2.3 lifecycle', () => {
  it('FULL_ACCEPT mode: auto-links to PO on publish, transitions DRAFT → ISSUED', async () => {
    const s = await setupBuyerSupplier('-fa');
    const { poId, poNumber } = await publishPo(s);

    const ocRes = await request(app)
      .post('/documents')
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .send({
        documentType: 'ORDER_CONFIRMATION',
        recipientOrgId: s.buyerOrgId,
        body: { mode: 'FULL_ACCEPT', poDocumentNumber: poNumber, poDocumentId: poId },
      })
      .expect(201);
    const ocId = ocRes.body.documentId as string;
    expect(ocRes.body.linkWarning).toBeUndefined(); // auto-link succeeded

    // Verify the auto-link landed
    const ocDetail = await request(app)
      .get(`/documents/${ocId}`)
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .expect(200);
    expect(ocDetail.body.outgoingLinks).toContainEqual(
      expect.objectContaining({ toDocumentId: poId, linkType: 'ACKNOWLEDGES' }),
    );

    // Supplier transitions OC: DRAFT → ISSUED
    await request(app)
      .post(`/documents/${ocId}/transition`)
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .send({ fromStatus: 'DRAFT', toStatus: 'ISSUED' })
      .expect(200);
  });

  it('ACCEPT_WITH_CHANGES: supplier proposes line changes; buyer ACCEPTED_BY_BUYER → buyer issues PO_CHANGE', async () => {
    const s = await setupBuyerSupplier('-awc');
    const { poId, poNumber } = await publishPo(s);

    // Supplier publishes ACCEPT_WITH_CHANGES with proposed changes
    const ocRes = await request(app)
      .post('/documents')
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .send({
        documentType: 'ORDER_CONFIRMATION',
        recipientOrgId: s.buyerOrgId,
        body: {
          mode: 'ACCEPT_WITH_CHANGES',
          poDocumentNumber: poNumber,
          poDocumentId: poId,
          comments: 'we can ship 4 units, not 5; need 2 weeks',
          proposedChanges: {
            revisedRequestedDeliveryDate: '2026-07-29',
            revisedLines: [
              {
                lineRef: 'L-001',
                revisedQuantity: 4,
                comments: 'limited stock',
              },
            ],
          },
        },
      })
      .expect(201);
    const ocId = ocRes.body.documentId as string;

    // Supplier moves OC to ISSUED
    await request(app)
      .post(`/documents/${ocId}/transition`)
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .send({ fromStatus: 'DRAFT', toStatus: 'ISSUED' })
      .expect(200);

    // Buyer ACCEPTED_BY_BUYER (means: I'll issue a PO_CHANGE to materialise these)
    await request(app)
      .post(`/documents/${ocId}/transition`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ fromStatus: 'ISSUED', toStatus: 'ACCEPTED_BY_BUYER' })
      .expect(200);

    const final = await request(app)
      .get(`/documents/${ocId}`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .expect(200);
    expect(final.body.status).toBe('ACCEPTED_BY_BUYER');

    // Now the buyer would issue a PO_CHANGE — this is just to demonstrate the
    // intended downstream action (covered fully in po-change-lifecycle.test.ts).
    // We assert the PO body has NOT been mutated by the OC's proposed changes.
    const po = await request(app)
      .get(`/documents/${poId}`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .expect(200);
    expect(po.body.versions).toHaveLength(1);
    expect((po.body.versions[0].body as { lines: { quantity: number }[] }).lines[0]?.quantity).toBe(
      5,
    );
  });

  it('ACCEPT_WITH_CHANGES: buyer can REJECTED_BY_BUYER instead', async () => {
    const s = await setupBuyerSupplier('-rwc');
    const { poId, poNumber } = await publishPo(s);

    const ocRes = await request(app)
      .post('/documents')
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .send({
        documentType: 'ORDER_CONFIRMATION',
        recipientOrgId: s.buyerOrgId,
        body: {
          mode: 'ACCEPT_WITH_CHANGES',
          poDocumentNumber: poNumber,
          poDocumentId: poId,
          proposedChanges: { revisedRequestedDeliveryDate: '2026-08-15' },
        },
      })
      .expect(201);
    const ocId = ocRes.body.documentId as string;

    await request(app)
      .post(`/documents/${ocId}/transition`)
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .send({ fromStatus: 'DRAFT', toStatus: 'ISSUED' })
      .expect(200);

    await request(app)
      .post(`/documents/${ocId}/transition`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ fromStatus: 'ISSUED', toStatus: 'REJECTED_BY_BUYER' })
      .expect(200);
  });

  it('REJECT mode: terminal, no proposed changes', async () => {
    const s = await setupBuyerSupplier('-rej');
    const { poId, poNumber } = await publishPo(s);

    await request(app)
      .post('/documents')
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .send({
        documentType: 'ORDER_CONFIRMATION',
        recipientOrgId: s.buyerOrgId,
        body: {
          mode: 'REJECT',
          poDocumentNumber: poNumber,
          poDocumentId: poId,
          comments: 'cannot fulfil — capacity full',
        },
      })
      .expect(201);
  });

  it('rejects ACCEPT_WITH_CHANGES with no proposed changes block', async () => {
    const s = await setupBuyerSupplier('-empty-awc');
    const { poId, poNumber } = await publishPo(s);

    const r = await request(app)
      .post('/documents')
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .send({
        documentType: 'ORDER_CONFIRMATION',
        recipientOrgId: s.buyerOrgId,
        body: {
          mode: 'ACCEPT_WITH_CHANGES',
          poDocumentNumber: poNumber,
          poDocumentId: poId,
          // Missing proposedChanges — should fail Zod
        },
      })
      .expect(400);
    expect(r.body.error).toBe('publish_rejected');
    expect(r.body.reason.kind).toBe('body_schema');
  });

  it('rejects ACCEPT_WITH_CHANGES with empty proposed changes', async () => {
    const s = await setupBuyerSupplier('-empty-pc');
    const { poId, poNumber } = await publishPo(s);

    const r = await request(app)
      .post('/documents')
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .send({
        documentType: 'ORDER_CONFIRMATION',
        recipientOrgId: s.buyerOrgId,
        body: {
          mode: 'ACCEPT_WITH_CHANGES',
          poDocumentNumber: poNumber,
          poDocumentId: poId,
          proposedChanges: {}, // empty — must have at least one of revisedRequestedDeliveryDate or revisedLines
        },
      })
      .expect(400);
    expect(r.body.error).toBe('publish_rejected');
    expect(r.body.reason.kind).toBe('body_schema');
  });

  it('rejects buyer-side transition by supplier (wrong actor side)', async () => {
    const s = await setupBuyerSupplier('-was');
    const { poId, poNumber } = await publishPo(s);

    const ocRes = await request(app)
      .post('/documents')
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .send({
        documentType: 'ORDER_CONFIRMATION',
        recipientOrgId: s.buyerOrgId,
        body: { mode: 'FULL_ACCEPT', poDocumentNumber: poNumber, poDocumentId: poId },
      })
      .expect(201);
    const ocId = ocRes.body.documentId as string;

    await request(app)
      .post(`/documents/${ocId}/transition`)
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .send({ fromStatus: 'DRAFT', toStatus: 'ISSUED' })
      .expect(200);

    // Supplier tries to ACCEPT_BY_BUYER — should be rejected (only buyer/recipient can)
    const reject = await request(app)
      .post(`/documents/${ocId}/transition`)
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .send({ fromStatus: 'ISSUED', toStatus: 'ACCEPTED_BY_BUYER' })
      .expect(400);
    expect(reject.body.reason.kind).toBe('state_machine');
    expect(['wrong_role', 'wrong_actor_side']).toContain(reject.body.reason.detail.kind);
  });
});
