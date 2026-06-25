/**
 * Task #8 acceptance — PO_CHANGE §2.2 full choreography.
 *
 * The full lifecycle through the HTTP layer:
 *
 *   Buyer issues PO              → DRAFT
 *   Buyer transitions PO         → ISSUED
 *   Supplier acknowledges PO     → ACKNOWLEDGED
 *   Buyer publishes PO_CHANGE    → DRAFT  (revised body, change reason)
 *   Buyer SUPERSEDES-links it    → original PO
 *   Buyer transitions PO_CHANGE  → ISSUED
 *   Supplier accepts PO_CHANGE   → ACCEPTED_BY_SUPPLIER
 *   Buyer transitions PO         → CHANGED   (gated by accepted PO_CHANGE)
 *
 * Negative paths verified:
 *   - PO → CHANGED rejected when no PO_CHANGE has been accepted yet
 *   - PO → CHANGED rejected when PO_CHANGE is still ISSUED (not yet accepted)
 *   - Supplier can REJECT a PO_CHANGE; the original PO stays in its
 *     prior state (no auto-CHANGED).
 *
 * NOTE on the SUPERSEDES link cardinality (PHASES.md §2.2): the link
 * registry has inboundCardinality 'one' on PO_CHANGE → PO. Two distinct
 * PO_CHANGE documents can each link-SUPERSEDES the same PO at the DB
 * level (the link rows have different from_document_ids), but the
 * registry hint signals that *currently* one is the in-flight change.
 * The CHANGED guard reads the *latest* ACCEPTED change.
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

function poBody(unitPrice = 10): unknown {
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
        unitPrice,
        unitOfMeasure: 'EA',
      },
    ],
  };
}

function poChangeBody(poId: string, poNumber: string, revisedQuantity: number): unknown {
  return {
    poDocumentNumber: poNumber,
    poDocumentId: poId,
    changeReason: 'buyer increased quantity',
    affectedLineRefs: ['WIDGET-1'],
    revisedBody: {
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
          quantity: revisedQuantity,
          unitPrice: 10,
          unitOfMeasure: 'EA',
        },
      ],
    },
  };
}

/** Helper: publish a PO and walk it to ACKNOWLEDGED. */
async function setupAcknowledgedPo(s: Setup): Promise<{ poId: string; poNumber: string }> {
  const poRes = await request(app)
    .post('/documents')
    .set('Cookie', s.buyer.cookie)
    .set('x-active-org', s.buyerOrgId)
    .send({ documentType: 'PO', recipientOrgId: s.supplierOrgId, body: poBody() })
    .expect(201);
  const poId = poRes.body.documentId as string;
  const poNumber = poRes.body.documentNumber as string;
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
  return { poId, poNumber };
}

describe('PO_CHANGE §2.2 lifecycle', () => {
  it('happy path: buyer issues change, supplier accepts, original PO advances to CHANGED', async () => {
    const s = await setupBuyerSupplier('-h');
    const { poId, poNumber } = await setupAcknowledgedPo(s);

    // Buyer publishes PO_CHANGE
    const changeRes = await request(app)
      .post('/documents')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({
        documentType: 'PO_CHANGE',
        recipientOrgId: s.supplierOrgId,
        body: poChangeBody(poId, poNumber, 7),
      })
      .expect(201);
    const changeId = changeRes.body.documentId as string;
    // SUPERSEDES → PO is auto-linked by the publish route — no explicit
    // POST /links call needed.

    // Buyer transitions PO_CHANGE: DRAFT → ISSUED
    await request(app)
      .post(`/documents/${changeId}/transition`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ fromStatus: 'DRAFT', toStatus: 'ISSUED' })
      .expect(200);

    // Supplier accepts: ISSUED → ACCEPTED_BY_SUPPLIER
    await request(app)
      .post(`/documents/${changeId}/transition`)
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .send({ fromStatus: 'ISSUED', toStatus: 'ACCEPTED_BY_SUPPLIER' })
      .expect(200);

    // Now buyer can transition PO → CHANGED (the guard sees the accepted change)
    await request(app)
      .post(`/documents/${poId}/transition`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ fromStatus: 'ACKNOWLEDGED', toStatus: 'CHANGED' })
      .expect(200);

    // Final inspection
    const po = await request(app)
      .get(`/documents/${poId}`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .expect(200);
    expect(po.body.status).toBe('CHANGED');
    expect(po.body.incomingLinks).toContainEqual(
      expect.objectContaining({ fromDocumentId: changeId, linkType: 'SUPERSEDES' }),
    );

    const change = await request(app)
      .get(`/documents/${changeId}`)
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .expect(200);
    expect(change.body.status).toBe('ACCEPTED_BY_SUPPLIER');
  });

  it('rejects PO → CHANGED when no PO_CHANGE has been issued', async () => {
    const s = await setupBuyerSupplier('-no-change');
    const { poId } = await setupAcknowledgedPo(s);

    const r = await request(app)
      .post(`/documents/${poId}/transition`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ fromStatus: 'ACKNOWLEDGED', toStatus: 'CHANGED' })
      .expect(400);
    expect(r.body.error).toBe('transition_rejected');
    expect(r.body.reason.kind).toBe('precondition_failed');
    expect(r.body.reason.detail.kind).toBe('no_accepted_po_change');
  });

  it('rejects PO → CHANGED when PO_CHANGE is still in ISSUED (not yet accepted)', async () => {
    const s = await setupBuyerSupplier('-not-accepted');
    const { poId, poNumber } = await setupAcknowledgedPo(s);

    const changeRes = await request(app)
      .post('/documents')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({
        documentType: 'PO_CHANGE',
        recipientOrgId: s.supplierOrgId,
        body: poChangeBody(poId, poNumber, 7),
      })
      .expect(201);
    const changeId = changeRes.body.documentId as string;
    await request(app)
      .post(`/documents/${changeId}/transition`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ fromStatus: 'DRAFT', toStatus: 'ISSUED' })
      .expect(200);
    // Note: supplier has NOT yet accepted.

    const r = await request(app)
      .post(`/documents/${poId}/transition`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ fromStatus: 'ACKNOWLEDGED', toStatus: 'CHANGED' })
      .expect(400);
    expect(r.body.reason.kind).toBe('precondition_failed');
    expect(r.body.reason.detail.kind).toBe('no_accepted_po_change');
  });

  it('supplier can REJECT a PO_CHANGE; original PO stays as it was', async () => {
    const s = await setupBuyerSupplier('-reject');
    const { poId, poNumber } = await setupAcknowledgedPo(s);

    const changeRes = await request(app)
      .post('/documents')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({
        documentType: 'PO_CHANGE',
        recipientOrgId: s.supplierOrgId,
        body: poChangeBody(poId, poNumber, 99),
      })
      .expect(201);
    const changeId = changeRes.body.documentId as string;
    await request(app)
      .post(`/documents/${changeId}/transition`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ fromStatus: 'DRAFT', toStatus: 'ISSUED' })
      .expect(200);
    await request(app)
      .post(`/documents/${changeId}/transition`)
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .send({ fromStatus: 'ISSUED', toStatus: 'REJECTED_BY_SUPPLIER' })
      .expect(200);

    // PO_CHANGE is REJECTED_BY_SUPPLIER; PO must NOT be allowed to CHANGED.
    const r = await request(app)
      .post(`/documents/${poId}/transition`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ fromStatus: 'ACKNOWLEDGED', toStatus: 'CHANGED' })
      .expect(400);
    expect(r.body.reason.kind).toBe('precondition_failed');

    // PO is still ACKNOWLEDGED.
    const po = await request(app)
      .get(`/documents/${poId}`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .expect(200);
    expect(po.body.status).toBe('ACKNOWLEDGED');
  });

  it('rejects PO_CHANGE body that fails Zod validation', async () => {
    const s = await setupBuyerSupplier('-bad-body');
    const { poId, poNumber } = await setupAcknowledgedPo(s);
    const r = await request(app)
      .post('/documents')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({
        documentType: 'PO_CHANGE',
        recipientOrgId: s.supplierOrgId,
        body: {
          poDocumentNumber: poNumber,
          poDocumentId: poId,
          // missing changeReason; missing revisedBody
        },
      })
      .expect(400);
    expect(r.body.error).toBe('publish_rejected');
    expect(r.body.reason.kind).toBe('body_schema');
  });
});
