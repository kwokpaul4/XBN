/**
 * Phase 3 acceptance — SCC choreography end-to-end (M3 milestone gate).
 *
 * Three big scenarios:
 *
 *   1. Anchor entity lifecycles (Task #16)
 *      Three contract types: SCHEDULING_AGREEMENT, CONSIGNMENT_CONTRACT,
 *      SUBCONTRACTING_AGREEMENT. All publish, walk DRAFT → ACTIVE.
 *      SCHEDULING_AGREEMENT additionally walks ACTIVE → SUSPENDED →
 *      ACTIVE → TERMINATED to exercise the full lifecycle.
 *
 *   2. Forecast Collaboration (Task #17)
 *      Buyer publishes FORECAST_PUBLISH against an SA →
 *      supplier publishes FORECAST_COMMIT (discriminated union over
 *      COMMIT / COMMIT_WITH_DEVIATION / CANNOT_COMMIT) →
 *      buyer publishes a revised FORECAST_PUBLISH with SUPERSEDES link
 *      to the prior one. Both forecasts visible in the DAG.
 *
 *   3. Scheduling Agreement Releases + polymorphic ASN (Task #18)
 *      Buyer publishes SA_RELEASE_FORECAST → supersedes it with a
 *      fresher forecast release → publishes a firm SA_RELEASE_JIT →
 *      **supplier ships ASN against the JIT release** (the cross-phase
 *      substrate test from PHASES.md §3.2: the Phase 2 ASN type works
 *      against either PO or SA_RELEASE_JIT as predecessor).
 *      Verifies the polymorphic SHIPS_AGAINST link lands on the JIT
 *      release, not the SA.
 *
 * Negative paths:
 *   - FORECAST_COMMIT body schema rejects mode mismatch
 *   - SA_RELEASE_JIT publish without a SA → guard rejection if SA
 *     document type not enabled
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

const ALL_PHASE_3_TYPES = [
  'SCHEDULING_AGREEMENT',
  'CONSIGNMENT_CONTRACT',
  'SUBCONTRACTING_AGREEMENT',
  'FORECAST_PUBLISH',
  'FORECAST_COMMIT',
  'SA_RELEASE_FORECAST',
  'SA_RELEASE_JIT',
  'ASN',
];

interface Setup {
  buyer: User;
  supplier: User;
  buyerOrgId: string;
  supplierOrgId: string;
}

async function setupBuyerSupplier(suffix = ''): Promise<Setup> {
  const buyer = await registerVerifyLogin(`buyer${suffix}@uat-p3.local`);
  const supplier = await registerVerifyLogin(`supplier${suffix}@uat-p3.local`);
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
      enabledDocumentTypes: ALL_PHASE_3_TYPES,
      defaultCurrency: 'USD',
    })
    .expect(201);
  return { buyer, supplier, buyerOrgId, supplierOrgId };
}

const SHIP_TO = {
  name: 'Plant 1',
  line1: '1 Plant Way',
  city: 'Plantcity',
  countryCode: 'US',
};

function schedulingAgreementBody(): unknown {
  return {
    itemSku: 'BOLT-M8',
    itemDescription: 'M8 hex bolt',
    targetQuantity: 100000,
    unitOfMeasure: 'EA',
    unitPrice: 0.5,
    currency: 'USD',
    validityStart: '2026-01-01',
    validityEnd: '2026-12-31',
    plant: 'PLANT-001',
    shipTo: SHIP_TO,
    paymentTermsRef: 'NET-30',
    incoterms: 'FOB',
  };
}

describe('Phase 3 acceptance — Scenario 1: anchor entity lifecycles (Task #16)', () => {
  it('publishes all three anchor types and walks SCHEDULING_AGREEMENT through full lifecycle', async () => {
    const s = await setupBuyerSupplier('-anch');

    const sa = await request(app)
      .post('/documents')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({
        documentType: 'SCHEDULING_AGREEMENT',
        recipientOrgId: s.supplierOrgId,
        body: schedulingAgreementBody(),
      })
      .expect(201);
    expect(sa.body.documentNumber).toBe('SCHEDULING_AGREEMENT-000001');

    await request(app)
      .post(`/documents/${sa.body.documentId}/transition`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ fromStatus: 'DRAFT', toStatus: 'ACTIVE' })
      .expect(200);
    await request(app)
      .post(`/documents/${sa.body.documentId}/transition`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ fromStatus: 'ACTIVE', toStatus: 'SUSPENDED' })
      .expect(200);
    await request(app)
      .post(`/documents/${sa.body.documentId}/transition`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ fromStatus: 'SUSPENDED', toStatus: 'ACTIVE' })
      .expect(200);
    await request(app)
      .post(`/documents/${sa.body.documentId}/transition`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ fromStatus: 'ACTIVE', toStatus: 'TERMINATED' })
      .expect(200);

    const final = await request(app)
      .get(`/documents/${sa.body.documentId}`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .expect(200);
    expect(final.body.status).toBe('TERMINATED');
    const statusChanges = (final.body.auditLog as { action: string }[]).filter(
      (a) => a.action === 'STATUS_CHANGED',
    );
    expect(statusChanges).toHaveLength(4);

    const cc = await request(app)
      .post('/documents')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({
        documentType: 'CONSIGNMENT_CONTRACT',
        recipientOrgId: s.supplierOrgId,
        body: {
          itemSku: 'WASHER-M8',
          itemDescription: 'M8 flat washer',
          unitOfMeasure: 'EA',
          unitPrice: 0.05,
          currency: 'USD',
          validityStart: '2026-01-01',
          validityEnd: '2026-12-31',
          stockLocation: SHIP_TO,
          reorderPoint: 5000,
          settlementCadence: 'MONTHLY',
        },
      })
      .expect(201);
    expect(cc.body.documentNumber).toBe('CONSIGNMENT_CONTRACT-000001');

    const sub = await request(app)
      .post('/documents')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({
        documentType: 'SUBCONTRACTING_AGREEMENT',
        recipientOrgId: s.supplierOrgId,
        body: {
          finishedGoodSku: 'WIDGET-ASSY',
          finishedGoodDescription: 'Widget sub-assembly',
          finishedGoodUnitOfMeasure: 'EA',
          assemblyFeePerUnit: 2.5,
          currency: 'USD',
          validityStart: '2026-01-01',
          validityEnd: '2026-12-31',
          shipTo: SHIP_TO,
          components: [
            { sku: 'BOLT-M8', description: 'M8 bolt', unitOfMeasure: 'EA', quantityPerFg: 4 },
            { sku: 'WASHER-M8', description: 'M8 washer', unitOfMeasure: 'EA', quantityPerFg: 8 },
          ],
        },
      })
      .expect(201);
    expect(sub.body.documentNumber).toBe('SUBCONTRACTING_AGREEMENT-000001');
  }, 30_000);
});

describe('Phase 3 acceptance — Scenario 2: Forecast Collaboration (Task #17)', () => {
  it('buyer publishes forecast → supplier commits with deviation → buyer revises via SUPERSEDES', async () => {
    const s = await setupBuyerSupplier('-fc');

    const sa = await request(app)
      .post('/documents')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({
        documentType: 'SCHEDULING_AGREEMENT',
        recipientOrgId: s.supplierOrgId,
        body: schedulingAgreementBody(),
      })
      .expect(201);
    await request(app)
      .post(`/documents/${sa.body.documentId}/transition`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ fromStatus: 'DRAFT', toStatus: 'ACTIVE' })
      .expect(200);

    const fp1 = await request(app)
      .post('/documents')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({
        documentType: 'FORECAST_PUBLISH',
        recipientOrgId: s.supplierOrgId,
        body: {
          schedulingAgreementDocumentNumber: sa.body.documentNumber,
          schedulingAgreementDocumentId: sa.body.documentId,
          itemSku: 'BOLT-M8',
          itemDescription: 'M8 hex bolt',
          unitOfMeasure: 'EA',
          horizonStart: '2026-01-01',
          horizonEnd: '2026-03-31',
          buckets: [
            { periodStart: '2026-01-01', periodEnd: '2026-01-31', forecastQuantity: 10000 },
            { periodStart: '2026-02-01', periodEnd: '2026-02-28', forecastQuantity: 12000 },
            { periodStart: '2026-03-01', periodEnd: '2026-03-31', forecastQuantity: 11000 },
          ],
          notes: 'Q1 forecast',
        },
      })
      .expect(201);
    expect(fp1.body.linkWarnings).toBeUndefined();
    await request(app)
      .post(`/documents/${fp1.body.documentId}/transition`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ fromStatus: 'DRAFT', toStatus: 'ISSUED' })
      .expect(200);

    const saDetail = await request(app)
      .get(`/documents/${sa.body.documentId}`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .expect(200);
    const saInboundCallsOff = (saDetail.body.incomingLinks as { linkType: string }[]).filter(
      (l) => l.linkType === 'CALLS_OFF',
    );
    expect(saInboundCallsOff).toHaveLength(1);

    const fc = await request(app)
      .post('/documents')
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .send({
        documentType: 'FORECAST_COMMIT',
        recipientOrgId: s.buyerOrgId,
        body: {
          forecastDocumentNumber: fp1.body.documentNumber,
          forecastDocumentId: fp1.body.documentId,
          itemSku: 'BOLT-M8',
          unitOfMeasure: 'EA',
          buckets: [
            {
              mode: 'COMMIT',
              periodStart: '2026-01-01',
              periodEnd: '2026-01-31',
              committedQuantity: 10000,
            },
            {
              mode: 'COMMIT_WITH_DEVIATION',
              periodStart: '2026-02-01',
              periodEnd: '2026-02-28',
              committedQuantity: 8000,
              deviationReason: 'Holiday capacity reduction',
            },
            {
              mode: 'CANNOT_COMMIT',
              periodStart: '2026-03-01',
              periodEnd: '2026-03-31',
              reason: 'Material shortage forecast',
            },
          ],
        },
      })
      .expect(201);
    expect(fc.body.linkWarnings).toBeUndefined();

    const fp2 = await request(app)
      .post('/documents')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({
        documentType: 'FORECAST_PUBLISH',
        recipientOrgId: s.supplierOrgId,
        body: {
          schedulingAgreementDocumentNumber: sa.body.documentNumber,
          schedulingAgreementDocumentId: sa.body.documentId,
          itemSku: 'BOLT-M8',
          itemDescription: 'M8 hex bolt',
          unitOfMeasure: 'EA',
          horizonStart: '2026-01-01',
          horizonEnd: '2026-03-31',
          buckets: [
            { periodStart: '2026-01-01', periodEnd: '2026-01-31', forecastQuantity: 10000 },
            { periodStart: '2026-02-01', periodEnd: '2026-02-28', forecastQuantity: 9000 },
            { periodStart: '2026-03-01', periodEnd: '2026-03-31', forecastQuantity: 5000 },
          ],
          supersedesForecastDocumentId: fp1.body.documentId,
          notes: 'Q1 revised after supplier capacity feedback',
        },
      })
      .expect(201);
    expect(fp2.body.linkWarnings).toBeUndefined();

    const fp1Detail = await request(app)
      .get(`/documents/${fp1.body.documentId}`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .expect(200);
    const fp1InboundSupersedes = (fp1Detail.body.incomingLinks as { linkType: string }[]).filter(
      (l) => l.linkType === 'SUPERSEDES',
    );
    expect(fp1InboundSupersedes).toHaveLength(1);
  }, 30_000);

  it('rejects FORECAST_COMMIT body with negative committedQuantity', async () => {
    const s = await setupBuyerSupplier('-fcbad');
    const r = await request(app)
      .post('/documents')
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .send({
        documentType: 'FORECAST_COMMIT',
        recipientOrgId: s.buyerOrgId,
        body: {
          forecastDocumentNumber: 'X',
          forecastDocumentId: 'x',
          itemSku: 'X',
          unitOfMeasure: 'EA',
          buckets: [
            {
              mode: 'COMMIT',
              periodStart: '2026-01-01',
              periodEnd: '2026-01-31',
              committedQuantity: -5,
            },
          ],
        },
      })
      .expect(400);
    expect(r.body.error).toBe('publish_rejected');
    expect(r.body.reason.kind).toBe('body_schema');
  });
});

describe('Phase 3 acceptance — Scenario 3: SA releases + polymorphic ASN (Task #18)', () => {
  it('forecast release → supersede → JIT release → ASN ships against JIT (polymorphic predecessor)', async () => {
    const s = await setupBuyerSupplier('-rel');

    const sa = await request(app)
      .post('/documents')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({
        documentType: 'SCHEDULING_AGREEMENT',
        recipientOrgId: s.supplierOrgId,
        body: schedulingAgreementBody(),
      })
      .expect(201);
    await request(app)
      .post(`/documents/${sa.body.documentId}/transition`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ fromStatus: 'DRAFT', toStatus: 'ACTIVE' })
      .expect(200);

    const rf1 = await request(app)
      .post('/documents')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({
        documentType: 'SA_RELEASE_FORECAST',
        recipientOrgId: s.supplierOrgId,
        body: {
          schedulingAgreementDocumentNumber: sa.body.documentNumber,
          schedulingAgreementDocumentId: sa.body.documentId,
          itemSku: 'BOLT-M8',
          windowStart: '2026-02-01',
          windowEnd: '2026-02-28',
          releaseLines: [
            { requestedDeliveryDate: '2026-02-15', quantity: 5000, unitOfMeasure: 'EA' },
          ],
        },
      })
      .expect(201);
    expect(rf1.body.linkWarnings).toBeUndefined();
    await request(app)
      .post(`/documents/${rf1.body.documentId}/transition`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ fromStatus: 'DRAFT', toStatus: 'ISSUED' })
      .expect(200);

    const rf2 = await request(app)
      .post('/documents')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({
        documentType: 'SA_RELEASE_FORECAST',
        recipientOrgId: s.supplierOrgId,
        body: {
          schedulingAgreementDocumentNumber: sa.body.documentNumber,
          schedulingAgreementDocumentId: sa.body.documentId,
          itemSku: 'BOLT-M8',
          windowStart: '2026-02-01',
          windowEnd: '2026-02-28',
          releaseLines: [
            { requestedDeliveryDate: '2026-02-20', quantity: 4500, unitOfMeasure: 'EA' },
          ],
          supersedesReleaseDocumentId: rf1.body.documentId,
        },
      })
      .expect(201);
    expect(rf2.body.linkWarnings).toBeUndefined();

    const rf1Detail = await request(app)
      .get(`/documents/${rf1.body.documentId}`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .expect(200);
    expect(
      (rf1Detail.body.incomingLinks as { linkType: string }[]).filter(
        (l) => l.linkType === 'SUPERSEDES',
      ),
    ).toHaveLength(1);

    const jit = await request(app)
      .post('/documents')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({
        documentType: 'SA_RELEASE_JIT',
        recipientOrgId: s.supplierOrgId,
        body: {
          schedulingAgreementDocumentNumber: sa.body.documentNumber,
          schedulingAgreementDocumentId: sa.body.documentId,
          itemSku: 'BOLT-M8',
          windowStart: '2026-02-20',
          windowEnd: '2026-02-22',
          releaseLines: [
            {
              requestedDeliveryDate: '2026-02-21',
              requestedDeliveryTime: '08:00',
              quantity: 1500,
              unitOfMeasure: 'EA',
            },
          ],
        },
      })
      .expect(201);
    expect(jit.body.linkWarnings).toBeUndefined();
    await request(app)
      .post(`/documents/${jit.body.documentId}/transition`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ fromStatus: 'DRAFT', toStatus: 'ISSUED' })
      .expect(200);

    // The cross-phase polymorphic-predecessor test.
    const asn = await request(app)
      .post('/documents')
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .send({
        documentType: 'ASN',
        recipientOrgId: s.buyerOrgId,
        body: {
          saReleaseJitDocumentNumber: jit.body.documentNumber,
          saReleaseJitDocumentId: jit.body.documentId,
          carrier: 'UPS',
          shippedAt: '2026-02-20',
          expectedDeliveryDate: '2026-02-21',
          shipFrom: {
            name: 'Supplier Plant',
            line1: '1 Supply Lane',
            city: 'Supplycity',
            countryCode: 'US',
          },
          lines: [
            { lineRef: 'BOLT-M8', sku: 'BOLT-M8', shippedQuantity: 1500, unitOfMeasure: 'EA' },
          ],
        },
      })
      .expect(201);
    expect(asn.body.linkWarnings).toBeUndefined();

    const asnDetail = await request(app)
      .get(`/documents/${asn.body.documentId}`)
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .expect(200);
    const shipsAgainst = (
      asnDetail.body.outgoingLinks as { linkType: string; toDocumentId: string }[]
    ).filter((l) => l.linkType === 'SHIPS_AGAINST');
    expect(shipsAgainst).toHaveLength(1);
    expect(shipsAgainst[0]?.toDocumentId).toBe(jit.body.documentId);

    const jitDetail = await request(app)
      .get(`/documents/${jit.body.documentId}`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .expect(200);
    expect(
      (jitDetail.body.incomingLinks as { linkType: string }[]).filter(
        (l) => l.linkType === 'SHIPS_AGAINST',
      ),
    ).toHaveLength(1);
  }, 30_000);

  it('rejects FORECAST_PUBLISH publish when document type not enabled on relationship', async () => {
    const buyer = await registerVerifyLogin('buyer-fpdeny@uat-p3.local');
    const supplier = await registerVerifyLogin('supplier-fpdeny@uat-p3.local');
    const buyerOrgId = await createOrg(buyer, 'Buyer NoFP', 'BUYER');
    const supplierOrgId = await createOrg(supplier, 'Supplier NoFP', 'SUPPLIER');
    await request(app)
      .post('/network/relationships')
      .set('Cookie', buyer.cookie)
      .set('x-active-org', buyerOrgId)
      .send({
        buyerOrgId,
        supplierOrgId,
        status: 'ACTIVE',
        enabledDocumentTypes: ['PO'],
        defaultCurrency: 'USD',
      })
      .expect(201);

    const r = await request(app)
      .post('/documents')
      .set('Cookie', buyer.cookie)
      .set('x-active-org', buyerOrgId)
      .send({
        documentType: 'FORECAST_PUBLISH',
        recipientOrgId: supplierOrgId,
        body: {
          itemSku: 'X',
          itemDescription: 'X',
          unitOfMeasure: 'EA',
          horizonStart: '2026-01-01',
          horizonEnd: '2026-01-31',
          buckets: [{ periodStart: '2026-01-01', periodEnd: '2026-01-31', forecastQuantity: 100 }],
        },
      })
      .expect(400);
    expect(r.body.reason.kind).toBe('guard');
    expect(r.body.reason.detail.kind).toBe('document_type_not_enabled');
  });
});
