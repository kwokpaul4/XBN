/**
 * TradingRelationship service (PHASES.md §1.3).
 *
 * The spine of the network. A document only flows on an active relationship
 * with the document type enabled (enforced by document-core's
 * TradingRelationshipGuard); this module manages the relationship lifecycle.
 */

import type { DocumentNumberSource, PrismaClient, RelationshipStatus } from '@xbn/db';

export interface RelationshipConfig {
  readonly buyerInternalSupplierId?: string;
  readonly enabledDocumentTypes?: ReadonlyArray<string>;
  readonly paymentTermsRef?: string;
  readonly defaultCurrency?: string;
  readonly defaultIncoterms?: string;
  readonly documentNumberSource?: DocumentNumberSource;
  readonly summaryInvoicingEnabled?: boolean;
}

export interface RelationshipDescriptor {
  readonly id: string;
  readonly buyerOrgId: string;
  readonly supplierOrgId: string;
  readonly status: RelationshipStatus;
  readonly enabledDocumentTypes: ReadonlyArray<string>;
  readonly summaryInvoicingEnabled: boolean;
  readonly defaultCurrency: string | null;
  readonly defaultIncoterms: string | null;
  readonly documentNumberSource: DocumentNumberSource;
}

export type CreateRelationshipResult =
  | { readonly ok: true; readonly relationship: RelationshipDescriptor }
  | { readonly ok: false; readonly reason: 'already_exists' };

/**
 * Create a relationship in PENDING_INVITATION (the typical invite-flow
 * starting point) or ACTIVE (when an admin manually wires two existing
 * orgs together).
 */
export async function createRelationship(
  db: PrismaClient,
  buyerOrgId: string,
  supplierOrgId: string,
  status: 'PENDING_INVITATION' | 'ACTIVE',
  config: RelationshipConfig = {},
): Promise<CreateRelationshipResult> {
  try {
    const row = await db.tradingRelationship.create({
      data: {
        buyerOrgId,
        supplierOrgId,
        status,
        ...(status === 'ACTIVE' && { establishedAt: new Date() }),
        ...(config.buyerInternalSupplierId !== undefined && {
          buyerInternalSupplierId: config.buyerInternalSupplierId,
        }),
        enabledDocumentTypes: [...(config.enabledDocumentTypes ?? [])],
        ...(config.paymentTermsRef !== undefined && { paymentTermsRef: config.paymentTermsRef }),
        ...(config.defaultCurrency !== undefined && { defaultCurrency: config.defaultCurrency }),
        ...(config.defaultIncoterms !== undefined && { defaultIncoterms: config.defaultIncoterms }),
        ...(config.documentNumberSource !== undefined && {
          documentNumberSource: config.documentNumberSource,
        }),
        ...(config.summaryInvoicingEnabled !== undefined && {
          summaryInvoicingEnabled: config.summaryInvoicingEnabled,
        }),
      },
    });
    return { ok: true, relationship: descriptor(row) };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { ok: false, reason: 'already_exists' };
    }
    throw err;
  }
}

export async function getRelationshipById(
  db: PrismaClient,
  id: string,
): Promise<RelationshipDescriptor | null> {
  const row = await db.tradingRelationship.findUnique({ where: { id } });
  return row ? descriptor(row) : null;
}

export async function getRelationshipBetween(
  db: PrismaClient,
  buyerOrgId: string,
  supplierOrgId: string,
): Promise<RelationshipDescriptor | null> {
  const row = await db.tradingRelationship.findUnique({
    where: { buyerOrgId_supplierOrgId: { buyerOrgId, supplierOrgId } },
  });
  return row ? descriptor(row) : null;
}

export async function listRelationshipsForOrg(
  db: PrismaClient,
  orgId: string,
): Promise<ReadonlyArray<RelationshipDescriptor>> {
  const rows = await db.tradingRelationship.findMany({
    where: {
      OR: [{ buyerOrgId: orgId }, { supplierOrgId: orgId }],
    },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(descriptor);
}

export async function activateRelationship(db: PrismaClient, id: string): Promise<{ ok: boolean }> {
  const result = await db.tradingRelationship.updateMany({
    where: { id, status: 'PENDING_INVITATION' },
    data: { status: 'ACTIVE', establishedAt: new Date() },
  });
  return { ok: result.count > 0 };
}

export async function suspendRelationship(db: PrismaClient, id: string): Promise<{ ok: boolean }> {
  const result = await db.tradingRelationship.updateMany({
    where: { id, status: 'ACTIVE' },
    data: { status: 'SUSPENDED' },
  });
  return { ok: result.count > 0 };
}

export async function terminateRelationship(
  db: PrismaClient,
  id: string,
): Promise<{ ok: boolean }> {
  const result = await db.tradingRelationship.updateMany({
    where: { id, NOT: { status: 'TERMINATED' } },
    data: { status: 'TERMINATED', terminatedAt: new Date() },
  });
  return { ok: result.count > 0 };
}

export async function updateRelationshipConfig(
  db: PrismaClient,
  id: string,
  config: RelationshipConfig,
): Promise<{ ok: boolean }> {
  // Build the update only with fields that were actually provided so we
  // don't reset other config columns to their defaults.
  const data: Record<string, unknown> = {};
  if (config.buyerInternalSupplierId !== undefined)
    data.buyerInternalSupplierId = config.buyerInternalSupplierId;
  if (config.enabledDocumentTypes !== undefined)
    data.enabledDocumentTypes = [...config.enabledDocumentTypes];
  if (config.paymentTermsRef !== undefined) data.paymentTermsRef = config.paymentTermsRef;
  if (config.defaultCurrency !== undefined) data.defaultCurrency = config.defaultCurrency;
  if (config.defaultIncoterms !== undefined) data.defaultIncoterms = config.defaultIncoterms;
  if (config.documentNumberSource !== undefined)
    data.documentNumberSource = config.documentNumberSource;
  if (config.summaryInvoicingEnabled !== undefined)
    data.summaryInvoicingEnabled = config.summaryInvoicingEnabled;

  if (Object.keys(data).length === 0) {
    return { ok: true };
  }

  const result = await db.tradingRelationship.updateMany({
    where: { id },
    data,
  });
  return { ok: result.count > 0 };
}

// ---------------------------------------------------------------------------

function descriptor(row: {
  id: string;
  buyerOrgId: string;
  supplierOrgId: string;
  status: RelationshipStatus;
  enabledDocumentTypes: string[];
  summaryInvoicingEnabled: boolean;
  defaultCurrency: string | null;
  defaultIncoterms: string | null;
  documentNumberSource: DocumentNumberSource;
}): RelationshipDescriptor {
  return {
    id: row.id,
    buyerOrgId: row.buyerOrgId,
    supplierOrgId: row.supplierOrgId,
    status: row.status,
    enabledDocumentTypes: [...row.enabledDocumentTypes],
    summaryInvoicingEnabled: row.summaryInvoicingEnabled,
    defaultCurrency: row.defaultCurrency,
    defaultIncoterms: row.defaultIncoterms,
    documentNumberSource: row.documentNumberSource,
  };
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown };
  return e.code === 'P2002';
}
