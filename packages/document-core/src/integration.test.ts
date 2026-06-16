/**
 * Integration tests for the Stage C substrate.
 *
 * Covers the cross-cutting invariants from CLAUDE.md against a real Postgres:
 *   - Versioning + lineage + audit triad: every mutation produces a new
 *     version row, optional link rows, and an audit-log entry.
 *   - DocumentVersion is append-only — no in-place body update reaches the DB.
 *   - DocumentLink uniqueness rejects double-billing (PHASES.md §2.6).
 *   - TradingRelationshipGuard rejects cross-relationship publish.
 *   - PrismaNetworkNumberingStrategy is monotonic per (issuer, type, prefix).
 *   - State machine transitions integrate with the repository.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { BodySchemaRegistry } from './body-schema-registry.js';
import { LinkRegistry } from './link-registry.js';
import { acknowledge, cancel, link, publish, supersede } from './operations.js';
import { PrismaNetworkNumberingStrategy } from './numbering-prisma.js';
import { defineStateMachine } from './state-machine.js';
import { disposeTestDb, getTestDb, seedTradingRelationship, truncateAll } from './test-helpers.js';
import { TradingRelationshipGuard } from './trading-relationship-guard.js';

const db = getTestDb();

// Reset the database before every test for full isolation.
beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await disposeTestDb();
});

// ---------------------------------------------------------------------------
// Test fixtures: a tiny PO state machine + body schema + link registry
// representative of what Phase 2 will register.
// ---------------------------------------------------------------------------

type PoState = 'DRAFT' | 'ISSUED' | 'ACKNOWLEDGED' | 'CANCELLED';
type Role = 'BUYER_ADMIN' | 'BUYER_USER' | 'SUPPLIER_USER' | 'SUPPLIER_ADMIN';

const poMachine = defineStateMachine<PoState, Role, unknown>({
  initialState: 'DRAFT',
  transitions: {
    DRAFT: [
      { to: 'ISSUED', requiredRole: 'BUYER_ADMIN', actor: 'issuer' },
      { to: 'CANCELLED', requiredRole: 'BUYER_ADMIN', actor: 'issuer' },
    ],
    ISSUED: [
      { to: 'ACKNOWLEDGED', requiredRole: 'SUPPLIER_USER', actor: 'recipient' },
      { to: 'CANCELLED', requiredRole: 'BUYER_ADMIN', actor: 'issuer' },
    ],
    ACKNOWLEDGED: [],
    CANCELLED: [],
  },
});

function buildBodySchemas(): BodySchemaRegistry {
  const reg = new BodySchemaRegistry();
  reg.register(
    'PO',
    z.object({
      currency: z.string().length(3),
      lines: z.array(
        z.object({
          sku: z.string(),
          quantity: z.number().positive(),
          unitPrice: z.number().nonnegative(),
        }),
      ),
    }),
  );
  reg.register(
    'ORDER_CONFIRMATION',
    z.object({
      poDocumentNumber: z.string(),
      mode: z.enum(['FULL_ACCEPT', 'ACCEPT_WITH_CHANGES', 'REJECT']),
    }),
  );
  reg.register(
    'INVOICE',
    z.object({
      invoiceMode: z.enum(['PO_FLIP', 'SUMMARY']),
      total: z.number(),
    }),
  );
  return reg;
}

function buildLinkRegistry(): LinkRegistry {
  const reg = new LinkRegistry();
  reg.register({
    fromType: 'ORDER_CONFIRMATION',
    toType: 'PO',
    linkType: 'ACKNOWLEDGES',
    inboundCardinality: 'one',
    outboundCardinality: 'one',
  });
  reg.register({
    fromType: 'INVOICE',
    toType: 'PO',
    linkType: 'INVOICES',
    inboundCardinality: 'many',
    outboundCardinality: 'many',
  });
  return reg;
}

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

describe('publish', () => {
  it('creates a document with version 1, sets currentVersionId, writes audit log', async () => {
    const seed = await seedTradingRelationship(db);
    const guard = new TradingRelationshipGuard(db);
    const numbering = new PrismaNetworkNumberingStrategy(db);
    const bodySchemas = buildBodySchemas();

    const result = await publish(
      { db, guard, numbering, bodySchemas },
      {
        documentType: 'PO',
        issuerOrgId: seed.buyerOrgId,
        recipientOrgId: seed.supplierOrgId,
        body: {
          currency: 'USD',
          lines: [{ sku: 'WIDGET-1', quantity: 5, unitPrice: 10 }],
        },
        actorUserId: seed.buyerUserId,
        actorOrgId: seed.buyerOrgId,
        actorRole: 'BUYER_ADMIN' as Role,
        stateMachine: poMachine,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.documentNumber).toBe('PO-000001');

    const doc = await db.document.findUniqueOrThrow({
      where: { id: result.documentId },
      include: { versions: true, auditLog: true },
    });
    expect(doc.status).toBe('DRAFT');
    expect(doc.currentVersionId).toBe(result.versionId);
    expect(doc.versions).toHaveLength(1);
    expect(doc.versions[0]?.versionNumber).toBe(1);
    expect(doc.auditLog).toHaveLength(1);
    expect(doc.auditLog[0]?.action).toBe('CREATED');
  });

  it('rejects with no_relationship when orgs have none', async () => {
    const otherBuyer = await db.org.create({
      data: { legalName: 'Other Buyer', displayName: 'OtherCo', orgType: 'BUYER' },
    });
    const seed = await seedTradingRelationship(db);
    const guard = new TradingRelationshipGuard(db);
    const numbering = new PrismaNetworkNumberingStrategy(db);
    const bodySchemas = buildBodySchemas();

    const result = await publish(
      { db, guard, numbering, bodySchemas },
      {
        documentType: 'PO',
        issuerOrgId: otherBuyer.id, // no relationship to seed.supplierOrgId
        recipientOrgId: seed.supplierOrgId,
        body: { currency: 'USD', lines: [{ sku: 'X', quantity: 1, unitPrice: 1 }] },
        actorUserId: seed.buyerUserId,
        actorOrgId: otherBuyer.id,
        actorRole: 'BUYER_ADMIN' as Role,
        stateMachine: poMachine,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.kind).toBe('guard');
  });

  it('rejects when document type is not enabled on the relationship', async () => {
    const seed = await seedTradingRelationship(db, { enabledDocumentTypes: ['PO'] });
    const guard = new TradingRelationshipGuard(db);
    const numbering = new PrismaNetworkNumberingStrategy(db);
    const bodySchemas = buildBodySchemas();

    const result = await publish(
      { db, guard, numbering, bodySchemas },
      {
        documentType: 'INVOICE', // not in enabledDocumentTypes
        issuerOrgId: seed.supplierOrgId,
        recipientOrgId: seed.buyerOrgId,
        body: { invoiceMode: 'PO_FLIP', total: 100 },
        actorUserId: seed.supplierUserId,
        actorOrgId: seed.supplierOrgId,
        actorRole: 'SUPPLIER_USER' as Role,
        stateMachine: poMachine,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.reason.kind !== 'guard') throw new Error('expected guard rejection');
  });

  it('rejects SUMMARY invoice when summaryInvoicingEnabled is false', async () => {
    const seed = await seedTradingRelationship(db, {
      enabledDocumentTypes: ['INVOICE'],
      summaryInvoicingEnabled: false,
    });
    const guard = new TradingRelationshipGuard(db);
    const numbering = new PrismaNetworkNumberingStrategy(db);
    const bodySchemas = buildBodySchemas();

    const result = await publish(
      { db, guard, numbering, bodySchemas },
      {
        documentType: 'INVOICE',
        issuerOrgId: seed.supplierOrgId,
        recipientOrgId: seed.buyerOrgId,
        body: { invoiceMode: 'SUMMARY', total: 100 },
        actorUserId: seed.supplierUserId,
        actorOrgId: seed.supplierOrgId,
        actorRole: 'SUPPLIER_USER' as Role,
        invoiceMode: 'SUMMARY',
        stateMachine: poMachine,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.reason.kind !== 'guard') throw new Error('expected guard rejection');
  });

  it('accepts SUMMARY invoice when summaryInvoicingEnabled is true', async () => {
    const seed = await seedTradingRelationship(db, {
      enabledDocumentTypes: ['INVOICE'],
      summaryInvoicingEnabled: true,
    });
    const guard = new TradingRelationshipGuard(db);
    const numbering = new PrismaNetworkNumberingStrategy(db);
    const bodySchemas = buildBodySchemas();

    const result = await publish(
      { db, guard, numbering, bodySchemas },
      {
        documentType: 'INVOICE',
        issuerOrgId: seed.supplierOrgId,
        recipientOrgId: seed.buyerOrgId,
        body: { invoiceMode: 'SUMMARY', total: 100 },
        actorUserId: seed.supplierUserId,
        actorOrgId: seed.supplierOrgId,
        actorRole: 'SUPPLIER_USER' as Role,
        invoiceMode: 'SUMMARY',
        stateMachine: poMachine,
      },
    );

    expect(result.ok).toBe(true);
  });

  it('rejects body that fails Zod validation', async () => {
    const seed = await seedTradingRelationship(db);
    const guard = new TradingRelationshipGuard(db);
    const numbering = new PrismaNetworkNumberingStrategy(db);
    const bodySchemas = buildBodySchemas();

    const result = await publish(
      { db, guard, numbering, bodySchemas },
      {
        documentType: 'PO',
        issuerOrgId: seed.buyerOrgId,
        recipientOrgId: seed.supplierOrgId,
        body: {
          currency: 'US', // wrong length
          lines: [{ sku: 'X', quantity: -1, unitPrice: 1 }], // negative qty
        },
        actorUserId: seed.buyerUserId,
        actorOrgId: seed.buyerOrgId,
        actorRole: 'BUYER_ADMIN' as Role,
        stateMachine: poMachine,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.kind).toBe('body_schema');
  });
});

// ---------------------------------------------------------------------------
// Numbering — monotonic per (issuer, type, prefix)
// ---------------------------------------------------------------------------

describe('numbering', () => {
  it('issues sequential numbers for the same (issuer, type)', async () => {
    const seed = await seedTradingRelationship(db);
    const guard = new TradingRelationshipGuard(db);
    const numbering = new PrismaNetworkNumberingStrategy(db);
    const bodySchemas = buildBodySchemas();

    const numbers: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await publish(
        { db, guard, numbering, bodySchemas },
        {
          documentType: 'PO',
          issuerOrgId: seed.buyerOrgId,
          recipientOrgId: seed.supplierOrgId,
          body: { currency: 'USD', lines: [{ sku: `S-${i}`, quantity: 1, unitPrice: 1 }] },
          actorUserId: seed.buyerUserId,
          actorOrgId: seed.buyerOrgId,
          actorRole: 'BUYER_ADMIN' as Role,
          stateMachine: poMachine,
        },
      );
      expect(r.ok).toBe(true);
      if (r.ok) numbers.push(r.documentNumber);
    }

    expect(numbers).toEqual(['PO-000001', 'PO-000002', 'PO-000003']);
  });

  it('isolates counters across different issuer orgs', async () => {
    const seedA = await seedTradingRelationship(db);
    const seedB = await seedTradingRelationship(db);
    const guard = new TradingRelationshipGuard(db);
    const numbering = new PrismaNetworkNumberingStrategy(db);
    const bodySchemas = buildBodySchemas();

    const a = await publish(
      { db, guard, numbering, bodySchemas },
      {
        documentType: 'PO',
        issuerOrgId: seedA.buyerOrgId,
        recipientOrgId: seedA.supplierOrgId,
        body: { currency: 'USD', lines: [{ sku: 'A', quantity: 1, unitPrice: 1 }] },
        actorUserId: seedA.buyerUserId,
        actorOrgId: seedA.buyerOrgId,
        actorRole: 'BUYER_ADMIN' as Role,
        stateMachine: poMachine,
      },
    );
    const b = await publish(
      { db, guard, numbering, bodySchemas },
      {
        documentType: 'PO',
        issuerOrgId: seedB.buyerOrgId,
        recipientOrgId: seedB.supplierOrgId,
        body: { currency: 'USD', lines: [{ sku: 'B', quantity: 1, unitPrice: 1 }] },
        actorUserId: seedB.buyerUserId,
        actorOrgId: seedB.buyerOrgId,
        actorRole: 'BUYER_ADMIN' as Role,
        stateMachine: poMachine,
      },
    );

    if (!a.ok || !b.ok) throw new Error('publish failed');
    expect(a.documentNumber).toBe('PO-000001');
    expect(b.documentNumber).toBe('PO-000001');
  });

  it('honours numberingPrefix override', async () => {
    const seed = await seedTradingRelationship(db);
    const guard = new TradingRelationshipGuard(db);
    const numbering = new PrismaNetworkNumberingStrategy(db);
    const bodySchemas = buildBodySchemas();

    const r = await publish(
      { db, guard, numbering, bodySchemas },
      {
        documentType: 'PO',
        issuerOrgId: seed.buyerOrgId,
        recipientOrgId: seed.supplierOrgId,
        body: { currency: 'USD', lines: [{ sku: 'X', quantity: 1, unitPrice: 1 }] },
        actorUserId: seed.buyerUserId,
        actorOrgId: seed.buyerOrgId,
        actorRole: 'BUYER_ADMIN' as Role,
        numberingPrefix: 'BUY-2026',
        stateMachine: poMachine,
      },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.documentNumber).toBe('BUY-2026-000001');
  });
});

// ---------------------------------------------------------------------------
// supersede — append-only versioning
// ---------------------------------------------------------------------------

describe('supersede', () => {
  it('appends a new version, leaves prior version untouched, advances currentVersionId', async () => {
    const seed = await seedTradingRelationship(db);
    const guard = new TradingRelationshipGuard(db);
    const numbering = new PrismaNetworkNumberingStrategy(db);
    const bodySchemas = buildBodySchemas();

    const created = await publish(
      { db, guard, numbering, bodySchemas },
      {
        documentType: 'PO',
        issuerOrgId: seed.buyerOrgId,
        recipientOrgId: seed.supplierOrgId,
        body: { currency: 'USD', lines: [{ sku: 'X', quantity: 1, unitPrice: 10 }] },
        actorUserId: seed.buyerUserId,
        actorOrgId: seed.buyerOrgId,
        actorRole: 'BUYER_ADMIN' as Role,
        stateMachine: poMachine,
      },
    );
    if (!created.ok) throw new Error('publish failed');

    const v1Id = created.versionId;
    const v1 = await db.documentVersion.findUniqueOrThrow({ where: { id: v1Id } });

    // Supersede with a new body — quantity changed.
    const supersedeResult = await supersede(
      { db, bodySchemas },
      {
        documentId: created.documentId,
        documentType: 'PO',
        body: { currency: 'USD', lines: [{ sku: 'X', quantity: 2, unitPrice: 10 }] },
        changeReason: 'quantity bumped',
        actorUserId: seed.buyerUserId,
        actorOrgId: seed.buyerOrgId,
      },
    );
    if (!supersedeResult.ok) throw new Error('supersede failed');
    expect(supersedeResult.versionNumber).toBe(2);

    // v1 is untouched.
    const v1Again = await db.documentVersion.findUniqueOrThrow({ where: { id: v1Id } });
    expect(v1Again.body).toEqual(v1.body);

    // Doc.currentVersionId now points at v2.
    const doc = await db.document.findUniqueOrThrow({ where: { id: created.documentId } });
    expect(doc.currentVersionId).toBe(supersedeResult.versionId);

    // Audit log has CREATED + SUPERSEDED.
    const audit = await db.documentAuditLog.findMany({
      where: { documentId: created.documentId },
      orderBy: { occurredAt: 'asc' },
    });
    expect(audit.map((a) => a.action)).toEqual(['CREATED', 'SUPERSEDED']);
  });
});

// ---------------------------------------------------------------------------
// acknowledge / cancel — status transitions
// ---------------------------------------------------------------------------

describe('acknowledge / cancel', () => {
  async function setupPo() {
    const seed = await seedTradingRelationship(db);
    const guard = new TradingRelationshipGuard(db);
    const numbering = new PrismaNetworkNumberingStrategy(db);
    const bodySchemas = buildBodySchemas();
    const created = await publish(
      { db, guard, numbering, bodySchemas },
      {
        documentType: 'PO',
        issuerOrgId: seed.buyerOrgId,
        recipientOrgId: seed.supplierOrgId,
        body: { currency: 'USD', lines: [{ sku: 'X', quantity: 1, unitPrice: 1 }] },
        actorUserId: seed.buyerUserId,
        actorOrgId: seed.buyerOrgId,
        actorRole: 'BUYER_ADMIN' as Role,
        stateMachine: poMachine,
      },
    );
    if (!created.ok) throw new Error('publish failed');
    return { seed, documentId: created.documentId };
  }

  it('transitions DRAFT → ISSUED for buyer_admin', async () => {
    const { seed, documentId } = await setupPo();
    const result = await acknowledge(
      { db },
      {
        documentId,
        fromStatus: 'DRAFT' as PoState,
        toStatus: 'ISSUED' as PoState,
        actorUserId: seed.buyerUserId,
        actorOrgId: seed.buyerOrgId,
        actorRole: 'BUYER_ADMIN' as Role,
        actorSide: 'issuer',
        stateMachine: poMachine,
      },
    );
    expect(result.ok).toBe(true);
    const doc = await db.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(doc.status).toBe('ISSUED');
  });

  it('rejects state machine transition with wrong role', async () => {
    const { seed, documentId } = await setupPo();
    const result = await acknowledge(
      { db },
      {
        documentId,
        fromStatus: 'DRAFT' as PoState,
        toStatus: 'ISSUED' as PoState,
        actorUserId: seed.supplierUserId,
        actorOrgId: seed.supplierOrgId,
        actorRole: 'SUPPLIER_USER' as Role, // PO ISSUE requires BUYER_ADMIN
        actorSide: 'issuer',
        stateMachine: poMachine,
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.kind).toBe('state_machine');
    // Doc status is unchanged.
    const doc = await db.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(doc.status).toBe('DRAFT');
  });

  it('rejects status_mismatch when fromStatus does not match current row', async () => {
    const { seed, documentId } = await setupPo();
    // First, legitimately move to ISSUED.
    await acknowledge(
      { db },
      {
        documentId,
        fromStatus: 'DRAFT' as PoState,
        toStatus: 'ISSUED' as PoState,
        actorUserId: seed.buyerUserId,
        actorOrgId: seed.buyerOrgId,
        actorRole: 'BUYER_ADMIN' as Role,
        actorSide: 'issuer',
        stateMachine: poMachine,
      },
    );

    // Now try the original DRAFT → ISSUED again — fromStatus no longer matches.
    const result = await acknowledge(
      { db },
      {
        documentId,
        fromStatus: 'DRAFT' as PoState,
        toStatus: 'ISSUED' as PoState,
        actorUserId: seed.buyerUserId,
        actorOrgId: seed.buyerOrgId,
        actorRole: 'BUYER_ADMIN' as Role,
        actorSide: 'issuer',
        stateMachine: poMachine,
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.kind).toBe('repository');
  });

  it('cancel writes an audit row with action STATUS_CHANGED and the toStatus', async () => {
    const { seed, documentId } = await setupPo();
    await cancel(
      { db },
      {
        documentId,
        fromStatus: 'DRAFT' as PoState,
        toStatus: 'CANCELLED' as PoState,
        actorUserId: seed.buyerUserId,
        actorOrgId: seed.buyerOrgId,
        actorRole: 'BUYER_ADMIN' as Role,
        actorSide: 'issuer',
        stateMachine: poMachine,
      },
    );
    const audit = await db.documentAuditLog.findMany({
      where: { documentId },
      orderBy: { occurredAt: 'asc' },
    });
    expect(audit.map((a) => a.action)).toEqual(['CREATED', 'STATUS_CHANGED']);
    const transition = audit[1];
    expect(transition?.payload).toMatchObject({ fromStatus: 'DRAFT', toStatus: 'CANCELLED' });
  });
});

// ---------------------------------------------------------------------------
// link — DAG with uniqueness as the no-double-billing guard
// ---------------------------------------------------------------------------

describe('link', () => {
  async function setupPair() {
    const seed = await seedTradingRelationship(db);
    const guard = new TradingRelationshipGuard(db);
    const numbering = new PrismaNetworkNumberingStrategy(db);
    const bodySchemas = buildBodySchemas();

    const po = await publish(
      { db, guard, numbering, bodySchemas },
      {
        documentType: 'PO',
        issuerOrgId: seed.buyerOrgId,
        recipientOrgId: seed.supplierOrgId,
        body: { currency: 'USD', lines: [{ sku: 'X', quantity: 1, unitPrice: 1 }] },
        actorUserId: seed.buyerUserId,
        actorOrgId: seed.buyerOrgId,
        actorRole: 'BUYER_ADMIN' as Role,
        stateMachine: poMachine,
      },
    );
    if (!po.ok) throw new Error('po publish failed');

    const ack = await publish(
      { db, guard, numbering, bodySchemas },
      {
        documentType: 'ORDER_CONFIRMATION',
        issuerOrgId: seed.supplierOrgId,
        recipientOrgId: seed.buyerOrgId,
        body: { poDocumentNumber: po.documentNumber, mode: 'FULL_ACCEPT' },
        actorUserId: seed.supplierUserId,
        actorOrgId: seed.supplierOrgId,
        actorRole: 'SUPPLIER_USER' as Role,
        stateMachine: poMachine,
      },
    );
    if (!ack.ok) throw new Error('ack publish failed');

    return { seed, poId: po.documentId, ackId: ack.documentId };
  }

  it('creates a link and writes an audit row', async () => {
    const linkRegistry = buildLinkRegistry();
    const { seed, poId, ackId } = await setupPair();

    const result = await link(
      { db, linkRegistry },
      {
        fromDocumentId: ackId,
        fromDocumentType: 'ORDER_CONFIRMATION',
        toDocumentId: poId,
        toDocumentType: 'PO',
        linkType: 'ACKNOWLEDGES',
        actorUserId: seed.supplierUserId,
        actorOrgId: seed.supplierOrgId,
      },
    );
    expect(result.ok).toBe(true);

    const links = await db.documentLink.findMany({});
    expect(links).toHaveLength(1);
    expect(links[0]?.linkType).toBe('ACKNOWLEDGES');

    const audit = await db.documentAuditLog.findMany({
      where: { documentId: ackId, action: 'LINKED' },
    });
    expect(audit).toHaveLength(1);
  });

  it('rejects unknown_link_rule when the (from, to, linkType) triple is not registered', async () => {
    const linkRegistry = new LinkRegistry(); // empty registry
    const { seed, poId, ackId } = await setupPair();

    const result = await link(
      { db, linkRegistry },
      {
        fromDocumentId: ackId,
        fromDocumentType: 'ORDER_CONFIRMATION',
        toDocumentId: poId,
        toDocumentType: 'PO',
        linkType: 'ACKNOWLEDGES',
        actorUserId: seed.supplierUserId,
        actorOrgId: seed.supplierOrgId,
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.kind).toBe('unknown_link_rule');
  });

  it('rejects duplicate link — the no-double-billing guard from PHASES.md §2.6', async () => {
    const linkRegistry = buildLinkRegistry();
    const { seed, poId, ackId } = await setupPair();

    // First link succeeds.
    const first = await link(
      { db, linkRegistry },
      {
        fromDocumentId: ackId,
        fromDocumentType: 'ORDER_CONFIRMATION',
        toDocumentId: poId,
        toDocumentType: 'PO',
        linkType: 'ACKNOWLEDGES',
        actorUserId: seed.supplierUserId,
        actorOrgId: seed.supplierOrgId,
      },
    );
    expect(first.ok).toBe(true);

    // Attempting the same triple again is rejected by the DB unique constraint.
    const second = await link(
      { db, linkRegistry },
      {
        fromDocumentId: ackId,
        fromDocumentType: 'ORDER_CONFIRMATION',
        toDocumentId: poId,
        toDocumentType: 'PO',
        linkType: 'ACKNOWLEDGES',
        actorUserId: seed.supplierUserId,
        actorOrgId: seed.supplierOrgId,
      },
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason.kind).toBe('repository');
    if (second.reason.kind === 'repository') {
      expect(second.reason.detail.kind).toBe('duplicate_link');
    }

    // Verify only one row landed in document_links.
    const links = await db.documentLink.findMany({});
    expect(links).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Repository invariants: append-only audit log, append-only versions
// ---------------------------------------------------------------------------

describe('append-only invariants', () => {
  it('audit log entries are never modified after insert', async () => {
    const seed = await seedTradingRelationship(db);
    const guard = new TradingRelationshipGuard(db);
    const numbering = new PrismaNetworkNumberingStrategy(db);
    const bodySchemas = buildBodySchemas();

    const created = await publish(
      { db, guard, numbering, bodySchemas },
      {
        documentType: 'PO',
        issuerOrgId: seed.buyerOrgId,
        recipientOrgId: seed.supplierOrgId,
        body: { currency: 'USD', lines: [{ sku: 'X', quantity: 1, unitPrice: 1 }] },
        actorUserId: seed.buyerUserId,
        actorOrgId: seed.buyerOrgId,
        actorRole: 'BUYER_ADMIN' as Role,
        stateMachine: poMachine,
      },
    );
    if (!created.ok) throw new Error('publish failed');

    // Several mutations.
    await acknowledge(
      { db },
      {
        documentId: created.documentId,
        fromStatus: 'DRAFT' as PoState,
        toStatus: 'ISSUED' as PoState,
        actorUserId: seed.buyerUserId,
        actorOrgId: seed.buyerOrgId,
        actorRole: 'BUYER_ADMIN' as Role,
        actorSide: 'issuer',
        stateMachine: poMachine,
      },
    );
    await supersede(
      { db, bodySchemas },
      {
        documentId: created.documentId,
        documentType: 'PO',
        body: { currency: 'USD', lines: [{ sku: 'X', quantity: 2, unitPrice: 1 }] },
        changeReason: 'tweak',
        actorUserId: seed.buyerUserId,
        actorOrgId: seed.buyerOrgId,
      },
    );

    const audit = await db.documentAuditLog.findMany({
      where: { documentId: created.documentId },
      orderBy: { occurredAt: 'asc' },
    });
    expect(audit.map((a) => a.action)).toEqual(['CREATED', 'STATUS_CHANGED', 'SUPERSEDED']);
    // Each entry is a discrete row — no UPDATE merged them.
    expect(audit.length).toBe(3);
  });

  it('document_versions: prior versions are preserved verbatim across multiple supersedes', async () => {
    const seed = await seedTradingRelationship(db);
    const guard = new TradingRelationshipGuard(db);
    const numbering = new PrismaNetworkNumberingStrategy(db);
    const bodySchemas = buildBodySchemas();

    const created = await publish(
      { db, guard, numbering, bodySchemas },
      {
        documentType: 'PO',
        issuerOrgId: seed.buyerOrgId,
        recipientOrgId: seed.supplierOrgId,
        body: { currency: 'USD', lines: [{ sku: 'X', quantity: 1, unitPrice: 10 }] },
        actorUserId: seed.buyerUserId,
        actorOrgId: seed.buyerOrgId,
        actorRole: 'BUYER_ADMIN' as Role,
        stateMachine: poMachine,
      },
    );
    if (!created.ok) throw new Error('publish failed');

    const supersede1 = await supersede(
      { db, bodySchemas },
      {
        documentId: created.documentId,
        documentType: 'PO',
        body: { currency: 'USD', lines: [{ sku: 'X', quantity: 2, unitPrice: 10 }] },
        actorUserId: seed.buyerUserId,
        actorOrgId: seed.buyerOrgId,
      },
    );
    const supersede2 = await supersede(
      { db, bodySchemas },
      {
        documentId: created.documentId,
        documentType: 'PO',
        body: { currency: 'USD', lines: [{ sku: 'X', quantity: 3, unitPrice: 10 }] },
        actorUserId: seed.buyerUserId,
        actorOrgId: seed.buyerOrgId,
      },
    );
    if (!supersede1.ok || !supersede2.ok) throw new Error('supersede failed');

    const versions = await db.documentVersion.findMany({
      where: { documentId: created.documentId },
      orderBy: { versionNumber: 'asc' },
    });
    expect(versions.map((v) => v.versionNumber)).toEqual([1, 2, 3]);

    // Each version's body matches what was written; nothing was rewritten.
    interface PoBody {
      lines: { quantity: number }[];
    }
    expect((versions[0]?.body as unknown as PoBody).lines[0]?.quantity).toBe(1);
    expect((versions[1]?.body as unknown as PoBody).lines[0]?.quantity).toBe(2);
    expect((versions[2]?.body as unknown as PoBody).lines[0]?.quantity).toBe(3);
  });
});
