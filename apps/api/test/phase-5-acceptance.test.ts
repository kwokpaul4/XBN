/**
 * Phase 5 acceptance — production-readiness (M5 milestone gate).
 *
 * Six scenarios spanning §5.1 observability, §5.2 substrate coverage, and
 * §5.4 doc surface. §5.3 (CI + Dockerfiles) is exercised outside this
 * suite — those artifacts are verified by GitHub Actions running the very
 * same test file, and by `docker build` in a local smoke-test.
 *
 *   1. §5.1 GET /health returns 200 + ok:true
 *   2. §5.1 GET /ready returns 200 + db:'up' when Postgres is reachable
 *   3. §5.1 every response carries an x-request-id header, echoed back
 *      when the client provides one
 *   4. §5.1 GET /network/audit-log filters by documentId and scopes to
 *      the active org (non-NETWORK_ADMIN can't see other orgs' rows)
 *   5. §5.1 audit-log endpoint accepts action + since filters
 *   6. §5.4 documentation files exist on disk (a lightweight guard so a
 *      later refactor that renames doc files fails CI rather than silently
 *      breaking the catalog)
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
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

describe('Phase 5 acceptance — §5.1 observability', () => {
  it('GET /health returns { ok: true }', async () => {
    const r = await request(app).get('/health').expect(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.service).toBe('xbn-api');
  });

  it('GET /ready returns { ok: true, db: "up" } when Postgres is reachable', async () => {
    const r = await request(app).get('/ready').expect(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.db).toBe('up');
  });

  it('every response echoes x-request-id — generated if absent, preserved if provided', async () => {
    const generated = await request(app).get('/health').expect(200);
    expect(generated.headers['x-request-id']).toBeTruthy();
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{20,}$/);

    const echoed = await request(app)
      .get('/health')
      .set('x-request-id', 'my-caller-provided-id-42')
      .expect(200);
    expect(echoed.headers['x-request-id']).toBe('my-caller-provided-id-42');
  });
});

describe('Phase 5 acceptance — §5.1 audit-log explorer', () => {
  it('scopes rows to the active org and filters by documentId', async () => {
    const buyer = await registerVerifyLogin('buyer@uat-p5.local');
    const supplier = await registerVerifyLogin('supplier@uat-p5.local');
    const buyerOrgId = await createOrg(buyer, 'Buyer Co P5', 'BUYER');
    const supplierOrgId = await createOrg(supplier, 'Supplier Co P5', 'SUPPLIER');
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

    // Publish a PO so we have an audit trail.
    const po = await request(app)
      .post('/documents')
      .set('Cookie', buyer.cookie)
      .set('x-active-org', buyerOrgId)
      .send({
        documentType: 'PO',
        recipientOrgId: supplierOrgId,
        body: {
          currency: 'USD',
          paymentTermsRef: 'NET-30',
          requestedDeliveryDate: '2026-07-15',
          shipTo: {
            name: 'Ship',
            line1: '1 Way',
            city: 'City',
            countryCode: 'US',
          },
          billTo: {
            name: 'Bill',
            line1: '1 Way',
            city: 'City',
            countryCode: 'US',
          },
          lines: [
            {
              sku: 'X',
              description: 'x',
              quantity: 1,
              unitPrice: 1,
              unitOfMeasure: 'EA',
            },
          ],
        },
      })
      .expect(201);

    const audit = await request(app)
      .get(`/network/audit-log?documentId=${po.body.documentId}`)
      .set('Cookie', buyer.cookie)
      .set('x-active-org', buyerOrgId)
      .expect(200);
    // At least one entry — PUBLISHED (substrate emits one on publish).
    expect(audit.body.entries.length).toBeGreaterThan(0);
    for (const entry of audit.body.entries) {
      expect(entry.documentId).toBe(po.body.documentId);
    }

    // A third party (fresh user with a new unrelated org) cannot see the
    // rows for a document their active org isn't a party to.
    const outsider = await registerVerifyLogin('outsider@uat-p5.local');
    const outsiderOrgId = await createOrg(outsider, 'Outsider Co P5', 'BUYER');
    const outsiderView = await request(app)
      .get(`/network/audit-log?documentId=${po.body.documentId}`)
      .set('Cookie', outsider.cookie)
      .set('x-active-org', outsiderOrgId)
      .expect(200);
    expect(outsiderView.body.entries).toHaveLength(0);
  }, 30_000);

  it('accepts action and since filters without crashing', async () => {
    const u = await registerVerifyLogin('filterer@uat-p5.local');
    const oid = await createOrg(u, 'Filterer Co P5', 'BUYER');
    // Empty audit log: filter should return 0 without error.
    const audit = await request(app)
      .get('/network/audit-log?action=PUBLISHED&since=2026-01-01T00:00:00Z')
      .set('Cookie', u.cookie)
      .set('x-active-org', oid)
      .expect(200);
    expect(audit.body.total).toBe(0);
    expect(audit.body.entries).toHaveLength(0);
  });
});

describe('Phase 5 acceptance — §5.4 documentation surface', () => {
  it('the promised doc files exist on disk', () => {
    const repo = resolve(__dirname, '../../..');
    const required = [
      'docs/DOCUMENT_TYPE_CATALOG.md',
      'docs/ONBOARDING_RUNBOOK.md',
      'docs/OPERATIONS.md',
      'docs/API_REFERENCE.md',
      'docs/UAT_PHASE_2.md',
      'docs/UAT_PHASE_3.md',
      'docs/uat-phase-2.sh',
      'docs/uat-phase-3.sh',
      'docs/README.md',
      '.env.example',
      '.github/workflows/ci.yml',
      'apps/api/Dockerfile',
      'apps/web/Dockerfile',
      'apps/web/nginx.conf',
    ];
    for (const p of required) {
      const full = resolve(repo, p);
      expect(existsSync(full), `expected ${p} to exist`).toBe(true);
    }
  });
});
