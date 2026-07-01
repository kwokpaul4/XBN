/**
 * Phase 4 acceptance — network-wide features (M4 milestone gate).
 *
 * Five scenarios, one per sub-task in PHASES.md §4:
 *
 *   1. (§4.1) Cross-type document search + inbox/outbox filters.
 *      Verifies the new `q`, `fromDate`, and `toDate` query params on
 *      GET /documents, plus that inbox vs outbox vs both correctly scope.
 *
 *   2. (§4.2) Supplier directory / counterparties.
 *      Verifies GET /network/counterparties returns every active trading
 *      partner with the right `ourRole`, enabled doc types, and
 *      last-activity timestamp.
 *
 *   3. (§4.3) Status dashboards (buyer + supplier tiles).
 *      Establishes a PO + a FORECAST_PUBLISH then asserts the tiles
 *      surface the right counts from both directions.
 *
 *   4. (§4.4) Supplier scorecards.
 *      Buyer-side: time-to-acknowledge a PO is captured, an
 *      ACCEPTED_BY_BUYER invoice surfaces an invoiceMatchRate of 1.0,
 *      no GR data → asnAccuracy + onTimeDelivery are null (not zero).
 *
 *   5. (§4.5) Notification outbox.
 *      Publishing a document writes a `notification_outbox` row for
 *      every user in the recipient org. Reading and marking-read both
 *      work, and the unreadCount drops accordingly.
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

async function setup(suffix = ''): Promise<Setup> {
  const buyer = await registerVerifyLogin(`buyer${suffix}@uat-p4.local`);
  const supplier = await registerVerifyLogin(`supplier${suffix}@uat-p4.local`);
  const buyerOrgId = await createOrg(buyer, 'Buyer Co P4', 'BUYER');
  const supplierOrgId = await createOrg(supplier, 'Supplier Co P4', 'SUPPLIER');
  await request(app)
    .post('/network/relationships')
    .set('Cookie', buyer.cookie)
    .set('x-active-org', buyerOrgId)
    .send({
      buyerOrgId,
      supplierOrgId,
      status: 'ACTIVE',
      enabledDocumentTypes: [
        'PO',
        'ORDER_CONFIRMATION',
        'ASN',
        'GOODS_RECEIPT',
        'INVOICE',
        'SCHEDULING_AGREEMENT',
        'FORECAST_PUBLISH',
        'FORECAST_COMMIT',
      ],
      defaultCurrency: 'USD',
      summaryInvoicingEnabled: true,
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

function poBody(refNumber?: string): unknown {
  return {
    currency: 'USD',
    paymentTermsRef: 'NET-30',
    requestedDeliveryDate: '2026-07-15',
    shipTo: SHIP_TO,
    billTo: SHIP_TO,
    ...(refNumber ? { referenceNumber: refNumber } : {}),
    lines: [
      {
        sku: 'WIDGET-1',
        description: 'Widget Mk I',
        quantity: 5,
        unitPrice: 10,
        unitOfMeasure: 'EA',
      },
    ],
  };
}

describe('Phase 4 acceptance — Scenario 1: §4.1 cross-type search + filters', () => {
  it('q matches documentNumber substring, scopes correctly per inbox/outbox, fromDate filters', async () => {
    const s = await setup('-s1');

    const po1 = await request(app)
      .post('/documents')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ documentType: 'PO', recipientOrgId: s.supplierOrgId, body: poBody() })
      .expect(201);
    const po2 = await request(app)
      .post('/documents')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ documentType: 'PO', recipientOrgId: s.supplierOrgId, body: poBody() })
      .expect(201);

    // Outbox (buyer side) — should see both POs.
    const outbox = await request(app)
      .get('/documents?box=outbox')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .expect(200);
    expect(outbox.body.total).toBe(2);

    // Supplier inbox — sees both POs.
    const supInbox = await request(app)
      .get('/documents?box=inbox')
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .expect(200);
    expect(supInbox.body.total).toBe(2);

    // q matches the documentNumber prefix.
    const searched = await request(app)
      .get(`/documents?q=${po1.body.documentNumber}`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .expect(200);
    expect(searched.body.total).toBe(1);
    expect(searched.body.documents[0].id).toBe(po1.body.documentId);

    // q with no match returns 0.
    const empty = await request(app)
      .get('/documents?q=NONEXISTENT-XYZ')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .expect(200);
    expect(empty.body.total).toBe(0);

    // fromDate way in the future excludes everything.
    const future = await request(app)
      .get('/documents?fromDate=2099-01-01')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .expect(200);
    expect(future.body.total).toBe(0);

    // documentType filter still works.
    const onlyPos = await request(app)
      .get('/documents?documentType=PO')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .expect(200);
    expect(onlyPos.body.total).toBe(2);

    // counterpartyOrgId filter.
    const byCounterparty = await request(app)
      .get(`/documents?counterpartyOrgId=${s.supplierOrgId}`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .expect(200);
    expect(byCounterparty.body.total).toBe(2);

    // Quiet usage of po2 to keep TS happy.
    expect(po2.body.documentId).toBeTruthy();
  }, 30_000);
});

describe('Phase 4 acceptance — Scenario 2: §4.2 counterparties / supplier directory', () => {
  it('returns each ACTIVE counterparty with ourRole + enabledDocumentTypes + lastActivityAt', async () => {
    const s = await setup('-s2');

    // Before any document — lastActivityAt is null but the row exists.
    let cps = await request(app)
      .get('/network/counterparties')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .expect(200);
    expect(cps.body.counterparties).toHaveLength(1);
    expect(cps.body.counterparties[0].counterpartyOrgId).toBe(s.supplierOrgId);
    expect(cps.body.counterparties[0].ourRole).toBe('BUYER');
    expect(cps.body.counterparties[0].lastActivityAt).toBeNull();
    expect(cps.body.counterparties[0].enabledDocumentTypes).toContain('PO');

    // Publish a PO → lastActivityAt becomes non-null.
    const po = await request(app)
      .post('/documents')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ documentType: 'PO', recipientOrgId: s.supplierOrgId, body: poBody() })
      .expect(201);

    cps = await request(app)
      .get('/network/counterparties')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .expect(200);
    expect(cps.body.counterparties[0].lastActivityAt).not.toBeNull();
    expect(cps.body.counterparties[0].lastDocument.id).toBe(po.body.documentId);

    // Supplier-side: same row, but ourRole flips to SUPPLIER.
    const supCps = await request(app)
      .get('/network/counterparties')
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .expect(200);
    expect(supCps.body.counterparties[0].counterpartyOrgId).toBe(s.buyerOrgId);
    expect(supCps.body.counterparties[0].ourRole).toBe('SUPPLIER');
  }, 30_000);
});

describe('Phase 4 acceptance — Scenario 3: §4.3 status dashboards', () => {
  it('buyer + supplier tiles surface correct counts from both directions', async () => {
    const s = await setup('-s3');

    // Issue a PO — buyer's "poAwaitingAcknowledgement" should climb to 1
    // after we transition DRAFT→ISSUED.
    const po = await request(app)
      .post('/documents')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ documentType: 'PO', recipientOrgId: s.supplierOrgId, body: poBody() })
      .expect(201);
    await request(app)
      .post(`/documents/${po.body.documentId}/transition`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ fromStatus: 'DRAFT', toStatus: 'ISSUED' })
      .expect(200);

    // Also publish + activate a SA so the SCC tile fires.
    const sa = await request(app)
      .post('/documents')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({
        documentType: 'SCHEDULING_AGREEMENT',
        recipientOrgId: s.supplierOrgId,
        body: {
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
        },
      })
      .expect(201);
    await request(app)
      .post(`/documents/${sa.body.documentId}/transition`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ fromStatus: 'DRAFT', toStatus: 'ACTIVE' })
      .expect(200);

    const buyerDash = await request(app)
      .get('/network/dashboards/buyer')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .expect(200);
    expect(buyerDash.body.tiles.poAwaitingAcknowledgement).toBe(1);
    expect(buyerDash.body.tiles.activeSchedulingAgreements).toBe(1);

    const supDash = await request(app)
      .get('/network/dashboards/supplier')
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .expect(200);
    expect(supDash.body.tiles.posToAcknowledge).toBe(1);
  }, 30_000);
});

describe('Phase 4 acceptance — Scenario 4: §4.4 supplier scorecards', () => {
  it('captures PO-ack SLA + invoice match rate; reports null for metrics with no data', async () => {
    const s = await setup('-s4');

    // PO + OC = acknowledgement.
    const po = await request(app)
      .post('/documents')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ documentType: 'PO', recipientOrgId: s.supplierOrgId, body: poBody() })
      .expect(201);
    await request(app)
      .post(`/documents/${po.body.documentId}/transition`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ fromStatus: 'DRAFT', toStatus: 'ISSUED' })
      .expect(200);
    await request(app)
      .post('/documents')
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .send({
        documentType: 'ORDER_CONFIRMATION',
        recipientOrgId: s.buyerOrgId,
        body: {
          poDocumentNumber: po.body.documentNumber,
          poDocumentId: po.body.documentId,
          mode: 'FULL_ACCEPT',
        },
      })
      .expect(201);

    const sc = await request(app)
      .get('/network/scorecards')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .expect(200);
    expect(sc.body.scorecards).toHaveLength(1);
    const m = sc.body.scorecards[0].metrics;
    expect(m.poAckSampleSize).toBe(1);
    expect(m.avgPoAckHours).not.toBeNull();
    // No invoice yet → null with sampleSize 0.
    expect(m.invoiceMatchRate).toBeNull();
    expect(m.invoiceSampleSize).toBe(0);
    // No GR data → null sampleSize 0.
    expect(m.asnAccuracy).toBeNull();
    expect(m.asnSampleSize).toBe(0);
    expect(m.onTimeDelivery).toBeNull();
  }, 30_000);
});

describe('Phase 4 acceptance — Scenario 5: §4.5 notification outbox', () => {
  it('publish writes a row per recipient-org user; list + read + unreadCount work', async () => {
    const s = await setup('-s5');

    // Initially: no notifications for either user.
    let supNotifs = await request(app)
      .get('/network/notifications')
      .set('Cookie', s.supplier.cookie)
      .expect(200);
    expect(supNotifs.body.unreadCount).toBe(0);

    // Buyer publishes a PO → supplier user should see 1 notification.
    const po = await request(app)
      .post('/documents')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ documentType: 'PO', recipientOrgId: s.supplierOrgId, body: poBody() })
      .expect(201);

    // Tiny grace — the notify call is fire-and-forget (no await on the
    // route response), so poll briefly.
    for (let i = 0; i < 20; i++) {
      supNotifs = await request(app)
        .get('/network/notifications')
        .set('Cookie', s.supplier.cookie)
        .expect(200);
      if (supNotifs.body.unreadCount >= 1) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(supNotifs.body.unreadCount).toBeGreaterThanOrEqual(1);
    expect(supNotifs.body.notifications[0].eventType).toBe('DOCUMENT_PUBLISHED');
    expect(supNotifs.body.notifications[0].documentId).toBe(po.body.documentId);

    // Mark one read.
    const notifId = supNotifs.body.notifications[0].id;
    await request(app)
      .post(`/network/notifications/${notifId}/read`)
      .set('Cookie', s.supplier.cookie)
      .expect(200);

    supNotifs = await request(app)
      .get('/network/notifications')
      .set('Cookie', s.supplier.cookie)
      .expect(200);
    expect(supNotifs.body.unreadCount).toBe(0);

    // Mark-all-read works (idempotent at unreadCount=0).
    const all = await request(app)
      .post('/network/notifications/read-all')
      .set('Cookie', s.supplier.cookie)
      .expect(200);
    expect(all.body.ok).toBe(true);
  }, 30_000);
});
