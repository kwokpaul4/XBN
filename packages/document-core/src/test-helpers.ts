/**
 * Integration test harness for document-core.
 *
 * Tests run against the docker-compose Postgres at localhost:5432. Each test
 * gets isolation via `truncateAll` — much faster than spinning up a fresh
 * testcontainer per suite (~50ms vs ~10s) at the cost of running serially
 * within a worker.
 *
 * Vitest's default is to run files in parallel; we keep tests safe by:
 *   - using a per-worker schema (search_path) so workers don't collide, OR
 *   - asking Vitest to run integration tests serially.
 *
 * For Phase 1 we take the simpler path: integration tests run with
 * --pool=forks --poolOptions.forks.singleFork=true (set in vitest.config),
 * which keeps everything single-threaded and deterministic.
 */

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@xbn/db';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://xbn:xbn_dev@localhost:5432/xbn';

let cached: PrismaClient | null = null;

/**
 * Returns a process-wide PrismaClient pointed at the test DB. Lazily created
 * to avoid opening connections in suites that don't actually use it.
 *
 * Prisma 7 requires a driver adapter — we use @prisma/adapter-pg pointed at
 * docker-compose Postgres.
 */
export function getTestDb(): PrismaClient {
  if (!cached) {
    cached = new PrismaClient({
      adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL }),
      log: ['warn', 'error'],
    });
  }
  return cached;
}

/**
 * Truncate all application tables. Order matters — children first to avoid
 * FK violations. CASCADE handles the rest.
 */
export async function truncateAll(db: PrismaClient = getTestDb()): Promise<void> {
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

/**
 * Disconnect the cached client. Call from afterAll() in suites that opened it.
 */
export async function disposeTestDb(): Promise<void> {
  if (cached) {
    await cached.$disconnect();
    cached = null;
  }
}

/**
 * Convenience: build a minimal pair of orgs + users + an active trading
 * relationship. Most integration tests need this same scaffold.
 */
export async function seedTradingRelationship(
  db: PrismaClient,
  options: {
    enabledDocumentTypes?: string[];
    summaryInvoicingEnabled?: boolean;
    relationshipStatus?: 'PENDING_INVITATION' | 'ACTIVE' | 'SUSPENDED' | 'TERMINATED';
  } = {},
): Promise<{
  buyerOrgId: string;
  supplierOrgId: string;
  buyerUserId: string;
  supplierUserId: string;
  relationshipId: string;
}> {
  const buyerOrg = await db.org.create({
    data: { legalName: 'Buyer Org', displayName: 'BuyerCo', orgType: 'BUYER' },
  });
  const supplierOrg = await db.org.create({
    data: { legalName: 'Supplier Org', displayName: 'SupplierCo', orgType: 'SUPPLIER' },
  });

  const buyerUser = await db.user.create({
    data: { email: `buyer-${buyerOrg.id}@example.com`, displayName: 'Buyer User' },
  });
  const supplierUser = await db.user.create({
    data: { email: `supplier-${supplierOrg.id}@example.com`, displayName: 'Supplier User' },
  });

  await db.userOrgMembership.create({
    data: { userId: buyerUser.id, orgId: buyerOrg.id, role: 'BUYER_ADMIN' },
  });
  await db.userOrgMembership.create({
    data: { userId: supplierUser.id, orgId: supplierOrg.id, role: 'SUPPLIER_USER' },
  });

  const relationship = await db.tradingRelationship.create({
    data: {
      buyerOrgId: buyerOrg.id,
      supplierOrgId: supplierOrg.id,
      status: options.relationshipStatus ?? 'ACTIVE',
      establishedAt: new Date(),
      enabledDocumentTypes: options.enabledDocumentTypes ?? ['PO', 'ORDER_CONFIRMATION', 'INVOICE'],
      summaryInvoicingEnabled: options.summaryInvoicingEnabled ?? false,
    },
  });

  return {
    buyerOrgId: buyerOrg.id,
    supplierOrgId: supplierOrg.id,
    buyerUserId: buyerUser.id,
    supplierUserId: supplierUser.id,
    relationshipId: relationship.id,
  };
}
