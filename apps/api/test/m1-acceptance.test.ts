/**
 * M1 acceptance — the canonical Phase 1 verification choreography from
 * PHASES.md "Verification" Phase 1, driven through the HTTP layer via
 * supertest.
 *
 * Choreography:
 *   1. Network admin onboards Buyer Org A and Supplier Org B
 *   2. TradingRelationship established between them
 *   3. Buyer user from A publishes GENERIC_DOCUMENT with a PDF attachment to B
 *   4. Supplier user from B reads it (sees inbox), downloads attachment,
 *      replies with a linked GENERIC_DOCUMENT (RESPONDS_TO)
 *   5. Second version of the buyer's doc published (supersede)
 *   6. Audit log shows: CREATED · ATTACHMENT_ADDED · SUPERSEDED · LINKED · etc.
 *   7. Cross-org publish without a relationship is REJECTED
 *   8. Then PO/POAck typed pair runs end-to-end with state transitions audited
 *
 * Runs against the docker-compose Postgres + MinIO. Uses the real Express app
 * via supertest — no live HTTP listener.
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

/** Register, verify, login. Returns the user and the session cookie. */
async function registerVerifyLogin(email: string, password = 'correcthorse'): Promise<User> {
  const reg = await request(app).post('/auth/register').send({ email, password }).expect(201);
  const userId = reg.body.userId as string;
  const verificationToken = reg.body.verificationToken as string;

  await request(app).post('/auth/verify-email').send({ token: verificationToken }).expect(200);

  const login = await request(app).post('/auth/login').send({ email, password }).expect(200);
  const setCookie = login.headers['set-cookie'];
  const cookieHeader = Array.isArray(setCookie) ? setCookie : [setCookie];
  const sessionCookie = cookieHeader.find((c) => c.startsWith('xbn_session='));
  if (!sessionCookie) throw new Error('login did not set xbn_session cookie');

  return { id: userId, cookie: sessionCookie.split(';')[0] ?? '' };
}

async function createOrg(
  user: User,
  legalName: string,
  orgType: 'BUYER' | 'SUPPLIER',
  bindAsRole: 'BUYER_ADMIN' | 'SUPPLIER_ADMIN' | 'NETWORK_ADMIN' = 'BUYER_ADMIN',
): Promise<string> {
  const res = await request(app)
    .post('/network/orgs')
    .set('Cookie', user.cookie)
    .send({
      legalName,
      displayName: legalName,
      orgType,
      bindAsRole:
        orgType === 'BUYER'
          ? 'BUYER_ADMIN'
          : bindAsRole === 'NETWORK_ADMIN'
            ? 'NETWORK_ADMIN'
            : 'SUPPLIER_ADMIN',
    })
    .expect(201);
  return res.body.org.id as string;
}

describe('M1 acceptance — Phase 1 verification choreography', () => {
  it('full happy path: onboarding + generic document round-trip + version + cross-org rejection', async () => {
    // 1. Two users — one for the buyer org, one for the supplier org.
    const buyer = await registerVerifyLogin('buyer@example.com');
    const supplier = await registerVerifyLogin('supplier@example.com');

    // 2. Each creates their own org and is bound as the appropriate admin.
    const buyerOrgId = await createOrg(buyer, 'Buyer Co', 'BUYER');
    const supplierOrgId = await createOrg(supplier, 'Supplier Co', 'SUPPLIER');

    // 3. Establish an ACTIVE trading relationship with GENERIC_DOCUMENT enabled.
    await request(app)
      .post('/network/relationships')
      .set('Cookie', buyer.cookie)
      .set('x-active-org', buyerOrgId)
      .send({
        buyerOrgId,
        supplierOrgId,
        status: 'ACTIVE',
        enabledDocumentTypes: ['GENERIC_DOCUMENT', 'PO', 'ORDER_CONFIRMATION'],
        defaultCurrency: 'USD',
      })
      .expect(201);

    // 4. Buyer publishes a GENERIC_DOCUMENT to the supplier.
    const publishRes = await request(app)
      .post('/documents')
      .set('Cookie', buyer.cookie)
      .set('x-active-org', buyerOrgId)
      .send({
        documentType: 'GENERIC_DOCUMENT',
        recipientOrgId: supplierOrgId,
        body: { note: 'Hello from buyer' },
      })
      .expect(201);
    const buyerDocId = publishRes.body.documentId as string;
    expect(publishRes.body.documentNumber).toBe('GENERIC_DOCUMENT-000001');

    // 5. Buyer attaches a PDF (well, a tiny text file standing in).
    const pdfBytes = Buffer.from('%PDF-1.4 fake content');
    const attachRes = await request(app)
      .post(`/documents/${buyerDocId}/attachments`)
      .set('Cookie', buyer.cookie)
      .set('x-active-org', buyerOrgId)
      .send({
        filename: 'hello.pdf',
        mimeType: 'application/pdf',
        bytesBase64: pdfBytes.toString('base64'),
      })
      .expect(201);
    const attachmentId = attachRes.body.id as string;
    expect(attachRes.body.sha256).toMatch(/^[0-9a-f]{64}$/);

    // 6. Supplier sees it in their inbox — fetch the document and check fields.
    const supplierViewRes = await request(app)
      .get(`/documents/${buyerDocId}`)
      .set('Cookie', supplier.cookie)
      .set('x-active-org', supplierOrgId)
      .expect(200);
    expect(supplierViewRes.body.recipientOrgId).toBe(supplierOrgId);
    expect(supplierViewRes.body.versions).toHaveLength(1);
    expect(supplierViewRes.body.attachments).toHaveLength(1);

    // 7. Supplier downloads the attachment and verifies the bytes.
    const dlRes = await request(app)
      .get(`/attachments/${attachmentId}`)
      .set('Cookie', supplier.cookie)
      .set('x-active-org', supplierOrgId)
      .expect(200);
    expect(Buffer.from(dlRes.body).toString()).toContain('%PDF-1.4');

    // 8. Supplier replies with a linked GENERIC_DOCUMENT (RESPONDS_TO).
    const replyRes = await request(app)
      .post('/documents')
      .set('Cookie', supplier.cookie)
      .set('x-active-org', supplierOrgId)
      .send({
        documentType: 'GENERIC_DOCUMENT',
        recipientOrgId: buyerOrgId,
        body: { note: 'Got it, thanks' },
      })
      .expect(201);
    const replyDocId = replyRes.body.documentId as string;

    await request(app)
      .post(`/documents/${replyDocId}/links`)
      .set('Cookie', supplier.cookie)
      .set('x-active-org', supplierOrgId)
      .send({
        toDocumentId: buyerDocId,
        toDocumentType: 'GENERIC_DOCUMENT',
        linkType: 'RESPONDS_TO',
      })
      .expect(201);

    // 9. Buyer publishes a second version of the original doc (supersede).
    await request(app)
      .post(`/documents/${buyerDocId}/supersede`)
      .set('Cookie', buyer.cookie)
      .set('x-active-org', buyerOrgId)
      .send({
        body: { note: 'Hello from buyer (revised)' },
        changeReason: 'fix typo',
      })
      .expect(200);

    // 10. Inspect the final state. Both versions visible; audit log captures
    //     CREATED, ATTACHMENT_ADDED, SUPERSEDED, LINKED for the reply.
    const finalRes = await request(app)
      .get(`/documents/${buyerDocId}`)
      .set('Cookie', supplier.cookie)
      .set('x-active-org', supplierOrgId)
      .expect(200);
    expect(finalRes.body.versions).toHaveLength(2);
    expect(finalRes.body.versions[0].versionNumber).toBe(1);
    expect(finalRes.body.versions[1].versionNumber).toBe(2);
    const auditActions = finalRes.body.auditLog.map((a: { action: string }) => a.action);
    expect(auditActions).toContain('CREATED');
    expect(auditActions).toContain('ATTACHMENT_ADDED');
    expect(auditActions).toContain('SUPERSEDED');

    // The reply doc has its own LINKED audit entry.
    const replyView = await request(app)
      .get(`/documents/${replyDocId}`)
      .set('Cookie', supplier.cookie)
      .set('x-active-org', supplierOrgId)
      .expect(200);
    const replyActions = replyView.body.auditLog.map((a: { action: string }) => a.action);
    expect(replyActions).toContain('LINKED');

    // 11. Cross-org publish without a relationship is REJECTED.
    const otherUser = await registerVerifyLogin('lonely@example.com');
    const otherOrgId = await createOrg(otherUser, 'Lonely Co', 'BUYER');
    const rejected = await request(app)
      .post('/documents')
      .set('Cookie', otherUser.cookie)
      .set('x-active-org', otherOrgId)
      .send({
        documentType: 'GENERIC_DOCUMENT',
        recipientOrgId: supplierOrgId, // no relationship
        body: { note: 'should not work' },
      })
      .expect(400);
    expect(rejected.body.error).toBe('publish_rejected');
    expect(rejected.body.reason.kind).toBe('guard');
  });

  it('PO ↔ ORDER_CONFIRMATION typed pair runs end-to-end with state transitions audited', async () => {
    // Setup
    const buyer = await registerVerifyLogin('buyer2@example.com');
    const supplier = await registerVerifyLogin('supplier2@example.com');
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

    // 1. Buyer publishes a PO
    const poRes = await request(app)
      .post('/documents')
      .set('Cookie', buyer.cookie)
      .set('x-active-org', buyerOrgId)
      .send({
        documentType: 'PO',
        recipientOrgId: supplierOrgId,
        body: {
          currency: 'USD',
          lines: [{ sku: 'WIDGET-1', quantity: 5, unitPrice: 10 }],
        },
      })
      .expect(201);
    const poId = poRes.body.documentId as string;
    const poNumber = poRes.body.documentNumber as string;
    expect(poNumber).toBe('PO-000001');

    // 2. Buyer transitions PO from DRAFT -> ISSUED
    await request(app)
      .post(`/documents/${poId}/transition`)
      .set('Cookie', buyer.cookie)
      .set('x-active-org', buyerOrgId)
      .send({ fromStatus: 'DRAFT', toStatus: 'ISSUED' })
      .expect(200);

    // 3. Supplier publishes an ORDER_CONFIRMATION linked to the PO.
    const ackRes = await request(app)
      .post('/documents')
      .set('Cookie', supplier.cookie)
      .set('x-active-org', supplierOrgId)
      .send({
        documentType: 'ORDER_CONFIRMATION',
        recipientOrgId: buyerOrgId,
        body: { poDocumentNumber: poNumber, mode: 'FULL_ACCEPT' },
      })
      .expect(201);
    const ackId = ackRes.body.documentId as string;

    await request(app)
      .post(`/documents/${ackId}/links`)
      .set('Cookie', supplier.cookie)
      .set('x-active-org', supplierOrgId)
      .send({
        toDocumentId: poId,
        toDocumentType: 'PO',
        linkType: 'ACKNOWLEDGES',
      })
      .expect(201);

    // 4. Supplier transitions PO from ISSUED -> ACKNOWLEDGED.
    await request(app)
      .post(`/documents/${poId}/transition`)
      .set('Cookie', supplier.cookie)
      .set('x-active-org', supplierOrgId)
      .send({ fromStatus: 'ISSUED', toStatus: 'ACKNOWLEDGED' })
      .expect(200);

    // 5. Final state: PO has CREATED + STATUS_CHANGED x 2 in audit log.
    const finalPo = await request(app)
      .get(`/documents/${poId}`)
      .set('Cookie', buyer.cookie)
      .set('x-active-org', buyerOrgId)
      .expect(200);
    expect(finalPo.body.status).toBe('ACKNOWLEDGED');
    const actions = finalPo.body.auditLog.map((a: { action: string }) => a.action);
    expect(actions.filter((a: string) => a === 'STATUS_CHANGED').length).toBe(2);

    // 6. Duplicate ACKNOWLEDGES link is rejected (no-double-billing analog).
    const dupRes = await request(app)
      .post(`/documents/${ackId}/links`)
      .set('Cookie', supplier.cookie)
      .set('x-active-org', supplierOrgId)
      .send({
        toDocumentId: poId,
        toDocumentType: 'PO',
        linkType: 'ACKNOWLEDGES',
      })
      .expect(400);
    expect(dupRes.body.error).toBe('link_rejected');
  });
});
