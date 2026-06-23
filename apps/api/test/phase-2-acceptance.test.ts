/**
 * Phase 2 acceptance — full §2 choreography end-to-end.
 *
 * Two big tests:
 *
 *   1. Canonical PO choreography
 *      Buyer publishes PO →
 *      Supplier ORDER_CONFIRMATION (FULL_ACCEPT, auto-linked) →
 *      Buyer/Supplier transition PO through ISSUED/ACKNOWLEDGED/IN_FULFILLMENT →
 *      Supplier publishes ASN (SHIPS_AGAINST PO, auto-linked) →
 *      Buyer publishes GOODS_RECEIPT (RECEIVES ASN, FULFILLS PO, auto-linked) →
 *      Supplier publishes INVOICE PO_FLIP (INVOICES PO + GR, auto-linked) →
 *      Buyer accepts the invoice →
 *      Buyer publishes REMITTANCE_ADVICE (REMITS the invoice, auto-linked) →
 *      Buyer closes PO →
 *      Final inspection: full DAG, full audit log, all state machines in
 *      terminal states.
 *
 *   2. Summary invoicing (PHASES.md §2.6)
 *      Three POs over a month, all delivered + received →
 *      Supplier publishes one INVOICE in SUMMARY mode referencing all
 *      three (auto-links INVOICES → each PO + each GR via sourceDocuments
 *      list) →
 *      Re-issuing a SUMMARY invoice that points at any of the same source
 *      documents is rejected by the DB link-uniqueness constraint
 *      (linkWarnings surfaces duplicate_link) — this is the
 *      no-double-billing guard from PHASES.md §2.6.
 *
 *   3. Negative: SUMMARY invoice rejected when summaryInvoicingEnabled is
 *      false on the relationship.
 *
 * This is the M2 milestone gate (Task #15).
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

const ALL_PHASE_2_TYPES = [
  'PO',
  'PO_CHANGE',
  'ORDER_CONFIRMATION',
  'ASN',
  'GOODS_RECEIPT',
  'INVOICE',
  'CREDIT_MEMO',
  'REMITTANCE_ADVICE',
];

async function setupBuyerSupplier(suffix = '', summaryInvoicingEnabled = false): Promise<Setup> {
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
      enabledDocumentTypes: ALL_PHASE_2_TYPES,
      defaultCurrency: 'USD',
      summaryInvoicingEnabled,
    })
    .expect(201);
  return { buyer, supplier, buyerOrgId, supplierOrgId };
}

function poBody(skus: string[] = ['WIDGET-1'], quantity = 5, unitPrice = 10): unknown {
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
    lines: skus.map((sku) => ({
      sku,
      description: `${sku} description`,
      quantity,
      unitPrice,
      unitOfMeasure: 'EA',
      lineRef: sku,
    })),
  };
}

const SHIP_FROM = {
  name: 'Supplier Plant',
  line1: '1 Supply Lane',
  city: 'Supplycity',
  countryCode: 'US',
};
const REMIT_TO = {
  name: 'Supplier Co Accounts',
  line1: '1 Supply Lane',
  city: 'Supplycity',
  countryCode: 'US',
};

describe('Phase 2 acceptance: canonical PO → REMITTANCE choreography', () => {
  it('runs the full happy path end-to-end with all auto-links and audit', async () => {
    const s = await setupBuyerSupplier('-canonical');

    // 1. Buyer publishes PO
    const poRes = await request(app)
      .post('/documents')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ documentType: 'PO', recipientOrgId: s.supplierOrgId, body: poBody() })
      .expect(201);
    const poId = poRes.body.documentId as string;
    const poNumber = poRes.body.documentNumber as string;
    expect(poRes.body.linkWarnings).toBeUndefined();

    // Buyer issues PO
    await request(app)
      .post(`/documents/${poId}/transition`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ fromStatus: 'DRAFT', toStatus: 'ISSUED' })
      .expect(200);

    // 2. Supplier publishes ORDER_CONFIRMATION (auto-links to PO)
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
    expect(ocRes.body.linkWarnings).toBeUndefined();

    // OC transitions DRAFT → ISSUED → ACCEPTED_BY_BUYER
    await request(app)
      .post(`/documents/${ocRes.body.documentId}/transition`)
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .send({ fromStatus: 'DRAFT', toStatus: 'ISSUED' })
      .expect(200);
    await request(app)
      .post(`/documents/${ocRes.body.documentId}/transition`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ fromStatus: 'ISSUED', toStatus: 'ACCEPTED_BY_BUYER' })
      .expect(200);

    // 3. Supplier transitions PO: ISSUED → ACKNOWLEDGED (via the PO's own state machine)
    await request(app)
      .post(`/documents/${poId}/transition`)
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .send({ fromStatus: 'ISSUED', toStatus: 'ACKNOWLEDGED' })
      .expect(200);

    // 4. Buyer marks PO IN_FULFILLMENT
    await request(app)
      .post(`/documents/${poId}/transition`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ fromStatus: 'ACKNOWLEDGED', toStatus: 'IN_FULFILLMENT' })
      .expect(200);

    // 5. Supplier publishes ASN (auto-links SHIPS_AGAINST → PO)
    const asnRes = await request(app)
      .post('/documents')
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .send({
        documentType: 'ASN',
        recipientOrgId: s.buyerOrgId,
        body: {
          poDocumentNumber: poNumber,
          poDocumentId: poId,
          carrier: 'UPS',
          trackingNumber: '1Z999',
          shippedAt: '2026-07-10',
          expectedDeliveryDate: '2026-07-12',
          shipFrom: SHIP_FROM,
          lines: [
            { lineRef: 'WIDGET-1', sku: 'WIDGET-1', shippedQuantity: 5, unitOfMeasure: 'EA' },
          ],
        },
      })
      .expect(201);
    const asnId = asnRes.body.documentId as string;
    expect(asnRes.body.linkWarnings).toBeUndefined();

    // ASN: DRAFT → ISSUED → IN_TRANSIT
    await request(app)
      .post(`/documents/${asnId}/transition`)
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .send({ fromStatus: 'DRAFT', toStatus: 'ISSUED' })
      .expect(200);
    await request(app)
      .post(`/documents/${asnId}/transition`)
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .send({ fromStatus: 'ISSUED', toStatus: 'IN_TRANSIT' })
      .expect(200);

    // 6. Buyer publishes GR (auto-links FULFILLS → PO, RECEIVES → ASN)
    const grRes = await request(app)
      .post('/documents')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({
        documentType: 'GOODS_RECEIPT',
        recipientOrgId: s.supplierOrgId,
        body: {
          poDocumentNumber: poNumber,
          poDocumentId: poId,
          asnDocumentNumber: asnRes.body.documentNumber,
          asnDocumentId: asnId,
          receivedAt: '2026-07-12',
          receivedBy: 'Receiving Dock 3',
          lines: [
            { lineRef: 'WIDGET-1', sku: 'WIDGET-1', receivedQuantity: 5, unitOfMeasure: 'EA' },
          ],
        },
      })
      .expect(201);
    const grId = grRes.body.documentId as string;
    expect(grRes.body.linkWarnings).toBeUndefined();

    // GR: DRAFT → POSTED
    await request(app)
      .post(`/documents/${grId}/transition`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ fromStatus: 'DRAFT', toStatus: 'POSTED' })
      .expect(200);

    // Buyer marks ASN DELIVERED
    await request(app)
      .post(`/documents/${asnId}/transition`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ fromStatus: 'IN_TRANSIT', toStatus: 'DELIVERED' })
      .expect(200);

    // 7. Supplier publishes INVOICE in PO_FLIP mode (auto-links to PO + GR)
    const invoiceRes = await request(app)
      .post('/documents')
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .send({
        documentType: 'INVOICE',
        recipientOrgId: s.buyerOrgId,
        invoiceMode: 'PO_FLIP',
        body: {
          invoiceMode: 'PO_FLIP',
          poDocumentNumber: poNumber,
          poDocumentId: poId,
          grDocumentIds: [grId],
          issueDate: '2026-07-15',
          dueDate: '2026-08-14',
          currency: 'USD',
          paymentTermsRef: 'NET-30',
          remitTo: REMIT_TO,
          lines: [
            {
              lineRef: 'WIDGET-1',
              sku: 'WIDGET-1',
              description: 'WIDGET-1 description',
              quantity: 5,
              unitPrice: 10,
              unitOfMeasure: 'EA',
            },
          ],
          subtotal: 50,
          taxTotal: 0,
          total: 50,
        },
      })
      .expect(201);
    const invoiceId = invoiceRes.body.documentId as string;
    expect(invoiceRes.body.linkWarnings).toBeUndefined();

    // Invoice: DRAFT → SUBMITTED → ACKNOWLEDGED_BY_BUYER → ACCEPTED
    await request(app)
      .post(`/documents/${invoiceId}/transition`)
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .send({ fromStatus: 'DRAFT', toStatus: 'SUBMITTED' })
      .expect(200);
    await request(app)
      .post(`/documents/${invoiceId}/transition`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ fromStatus: 'SUBMITTED', toStatus: 'ACKNOWLEDGED_BY_BUYER' })
      .expect(200);
    await request(app)
      .post(`/documents/${invoiceId}/transition`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ fromStatus: 'ACKNOWLEDGED_BY_BUYER', toStatus: 'ACCEPTED' })
      .expect(200);

    // 8. Buyer publishes REMITTANCE_ADVICE (auto-links REMITS → invoice)
    const remRes = await request(app)
      .post('/documents')
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({
        documentType: 'REMITTANCE_ADVICE',
        recipientOrgId: s.supplierOrgId,
        body: {
          paymentDate: '2026-08-14',
          paymentMethod: 'WIRE',
          paymentReference: 'WIRE-12345',
          currency: 'USD',
          totalPaymentAmount: 50,
          allocations: [
            {
              documentType: 'INVOICE',
              documentId: invoiceId,
              documentNumber: invoiceRes.body.documentNumber,
              appliedAmount: 50,
            },
          ],
        },
      })
      .expect(201);
    expect(remRes.body.linkWarnings).toBeUndefined();
    await request(app)
      .post(`/documents/${remRes.body.documentId}/transition`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ fromStatus: 'DRAFT', toStatus: 'ISSUED' })
      .expect(200);

    // 9. Buyer closes PO
    await request(app)
      .post(`/documents/${poId}/transition`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .send({ fromStatus: 'IN_FULFILLMENT', toStatus: 'CLOSED' })
      .expect(200);

    // === FINAL INSPECTION ===

    // PO is CLOSED with the right lineage
    const finalPo = await request(app)
      .get(`/documents/${poId}`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .expect(200);
    expect(finalPo.body.status).toBe('CLOSED');
    const incomingLinkTypes = (finalPo.body.incomingLinks as { linkType: string }[]).map(
      (l) => l.linkType,
    );
    expect(incomingLinkTypes).toContain('ACKNOWLEDGES'); // from OC
    expect(incomingLinkTypes).toContain('SHIPS_AGAINST'); // from ASN
    expect(incomingLinkTypes).toContain('FULFILLS'); // from GR
    expect(incomingLinkTypes).toContain('INVOICES'); // from invoice

    // Invoice is ACCEPTED and links to PO+GR
    const finalInvoice = await request(app)
      .get(`/documents/${invoiceId}`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .expect(200);
    expect(finalInvoice.body.status).toBe('ACCEPTED');
    const invoiceOutbound = (
      finalInvoice.body.outgoingLinks as { linkType: string; toDocumentId: string }[]
    ).filter((l) => l.linkType === 'INVOICES');
    expect(invoiceOutbound).toHaveLength(2); // PO + GR
  }, 30_000);
});

describe('Phase 2 acceptance: SUMMARY invoicing (PHASES.md §2.6)', () => {
  it('consolidates 3 POs into one invoice; auto-links to all source POs + GRs', async () => {
    const s = await setupBuyerSupplier('-summary', /* summaryInvoicingEnabled */ true);

    // Helper: publish a PO, walk to IN_FULFILLMENT, then create a GR.
    async function publishPoAndGr(
      skus: string[],
    ): Promise<{ poId: string; poNumber: string; grId: string }> {
      const po = await request(app)
        .post('/documents')
        .set('Cookie', s.buyer.cookie)
        .set('x-active-org', s.buyerOrgId)
        .send({ documentType: 'PO', recipientOrgId: s.supplierOrgId, body: poBody(skus) })
        .expect(201);
      const poId = po.body.documentId as string;
      const poNumber = po.body.documentNumber as string;
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
        .send({ fromStatus: 'ACKNOWLEDGED', toStatus: 'IN_FULFILLMENT' })
        .expect(200);

      // GR
      const gr = await request(app)
        .post('/documents')
        .set('Cookie', s.buyer.cookie)
        .set('x-active-org', s.buyerOrgId)
        .send({
          documentType: 'GOODS_RECEIPT',
          recipientOrgId: s.supplierOrgId,
          body: {
            poDocumentNumber: poNumber,
            poDocumentId: poId,
            receivedAt: '2026-07-12',
            lines: skus.map((sku) => ({
              lineRef: sku,
              sku,
              receivedQuantity: 5,
              unitOfMeasure: 'EA',
            })),
          },
        })
        .expect(201);
      const grId = gr.body.documentId as string;
      await request(app)
        .post(`/documents/${grId}/transition`)
        .set('Cookie', s.buyer.cookie)
        .set('x-active-org', s.buyerOrgId)
        .send({ fromStatus: 'DRAFT', toStatus: 'POSTED' })
        .expect(200);
      return { poId, poNumber, grId };
    }

    const a = await publishPoAndGr(['WIDGET-A']);
    const b = await publishPoAndGr(['WIDGET-B']);
    const c = await publishPoAndGr(['WIDGET-C']);

    // Supplier publishes ONE consolidated SUMMARY invoice covering all three
    const summaryRes = await request(app)
      .post('/documents')
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .send({
        documentType: 'INVOICE',
        recipientOrgId: s.buyerOrgId,
        invoiceMode: 'SUMMARY',
        body: {
          invoiceMode: 'SUMMARY',
          sourceDocuments: [
            { documentType: 'PO', documentId: a.poId, documentNumber: a.poNumber },
            { documentType: 'PO', documentId: b.poId, documentNumber: b.poNumber },
            { documentType: 'PO', documentId: c.poId, documentNumber: c.poNumber },
            { documentType: 'GOODS_RECEIPT', documentId: a.grId },
            { documentType: 'GOODS_RECEIPT', documentId: b.grId },
            { documentType: 'GOODS_RECEIPT', documentId: c.grId },
          ],
          billingPeriodStart: '2026-07-01',
          billingPeriodEnd: '2026-07-31',
          issueDate: '2026-08-01',
          dueDate: '2026-08-31',
          currency: 'USD',
          paymentTermsRef: 'NET-30',
          remitTo: REMIT_TO,
          lines: [
            {
              lineRef: 'WIDGET-A',
              sku: 'WIDGET-A',
              description: 'Widget A',
              quantity: 5,
              unitPrice: 10,
              unitOfMeasure: 'EA',
              sourceDocumentId: a.poId,
              sourceDocumentType: 'PO',
            },
            {
              lineRef: 'WIDGET-B',
              sku: 'WIDGET-B',
              description: 'Widget B',
              quantity: 5,
              unitPrice: 10,
              unitOfMeasure: 'EA',
              sourceDocumentId: b.poId,
              sourceDocumentType: 'PO',
            },
            {
              lineRef: 'WIDGET-C',
              sku: 'WIDGET-C',
              description: 'Widget C',
              quantity: 5,
              unitPrice: 10,
              unitOfMeasure: 'EA',
              sourceDocumentId: c.poId,
              sourceDocumentType: 'PO',
            },
          ],
          subtotal: 150,
          taxTotal: 0,
          total: 150,
        },
      })
      .expect(201);
    expect(summaryRes.body.linkWarnings).toBeUndefined();

    // Inspect: invoice has 6 outgoing INVOICES links (3 POs + 3 GRs)
    const invoiceDetail = await request(app)
      .get(`/documents/${summaryRes.body.documentId}`)
      .set('Cookie', s.buyer.cookie)
      .set('x-active-org', s.buyerOrgId)
      .expect(200);
    const outboundInvoices = (
      invoiceDetail.body.outgoingLinks as { linkType: string; toDocumentId: string }[]
    ).filter((l) => l.linkType === 'INVOICES');
    expect(outboundInvoices).toHaveLength(6);

    // No-double-billing: a second SUMMARY invoice that overlaps any of the
    // source documents is partially rejected — the duplicate link surfaces
    // as a linkWarning. The invoice itself is published.
    const dupRes = await request(app)
      .post('/documents')
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .send({
        documentType: 'INVOICE',
        recipientOrgId: s.buyerOrgId,
        invoiceMode: 'SUMMARY',
        body: {
          invoiceMode: 'SUMMARY',
          // Re-references PO A (already invoiced) plus a fictional new doc
          sourceDocuments: [{ documentType: 'PO', documentId: a.poId, documentNumber: a.poNumber }],
          billingPeriodStart: '2026-08-01',
          billingPeriodEnd: '2026-08-31',
          issueDate: '2026-09-01',
          dueDate: '2026-09-30',
          currency: 'USD',
          remitTo: REMIT_TO,
          lines: [
            {
              lineRef: 'WIDGET-A',
              sku: 'WIDGET-A',
              description: 'duplicate ref',
              quantity: 1,
              unitPrice: 10,
              unitOfMeasure: 'EA',
              sourceDocumentId: a.poId,
              sourceDocumentType: 'PO',
            },
          ],
          subtotal: 10,
          taxTotal: 0,
          total: 10,
        },
      })
      .expect(201);
    // The duplicate link is what we expect to see flagged.
    const warnings =
      (dupRes.body.linkWarnings as { reason: { detail?: { kind?: string } } }[]) ?? [];
    expect(warnings.length).toBeGreaterThan(0);
    const duplicates = warnings.filter((w) => w.reason.detail?.kind === 'duplicate_link');
    expect(duplicates.length).toBeGreaterThan(0);
  }, 60_000);

  it('rejects SUMMARY invoice when summaryInvoicingEnabled is false on the relationship', async () => {
    const s = await setupBuyerSupplier('-no-summary', /* summaryInvoicingEnabled */ false);
    const result = await request(app)
      .post('/documents')
      .set('Cookie', s.supplier.cookie)
      .set('x-active-org', s.supplierOrgId)
      .send({
        documentType: 'INVOICE',
        recipientOrgId: s.buyerOrgId,
        invoiceMode: 'SUMMARY',
        body: {
          invoiceMode: 'SUMMARY',
          sourceDocuments: [{ documentType: 'PO', documentId: 'no-real-po', documentNumber: 'X' }],
          billingPeriodStart: '2026-07-01',
          billingPeriodEnd: '2026-07-31',
          issueDate: '2026-08-01',
          dueDate: '2026-08-31',
          currency: 'USD',
          remitTo: REMIT_TO,
          lines: [
            {
              lineRef: 'X',
              sku: 'X',
              description: 'x',
              quantity: 1,
              unitPrice: 1,
              unitOfMeasure: 'EA',
              sourceDocumentId: 'no-real-po',
              sourceDocumentType: 'PO',
            },
          ],
          subtotal: 1,
          taxTotal: 0,
          total: 1,
        },
      })
      .expect(400);
    expect(result.body.error).toBe('publish_rejected');
    expect(result.body.reason.kind).toBe('guard');
    expect(result.body.reason.detail.kind).toBe('summary_invoicing_not_enabled');
  });
});
