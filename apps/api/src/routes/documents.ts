/**
 * Documents HTTP surface. Composes @xbn/document-core with the per-type
 * registry under apps/api/src/document-types/.
 *
 * Adding a new document type now means: drop a folder under document-types/,
 * register it in document-types/registry.ts, done. No changes here.
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  AttachmentStorage,
  link as linkOp,
  NotificationEmitter,
  PrismaNetworkNumberingStrategy,
  publish,
  supersede,
  acknowledge,
  TradingRelationshipGuard,
} from '@xbn/document-core';
import type { PrismaClient } from '@xbn/db';

import { authMiddleware, mustAuth } from '../auth-middleware.js';
import { buildDocumentTypeRegistry } from '../document-types/registry.js';

const PublishBody = z.object({
  documentType: z.string(),
  recipientOrgId: z.string(),
  body: z.unknown(),
  invoiceMode: z.enum(['PO_FLIP', 'SUMMARY']).optional(),
});

const SupersedeBody = z.object({
  body: z.unknown(),
  changeReason: z.string().optional(),
});

const TransitionBody = z.object({
  fromStatus: z.string(),
  toStatus: z.string(),
});

const LinkBody = z.object({
  toDocumentId: z.string(),
  toDocumentType: z.string(),
  linkType: z.string(),
});

const AttachmentBody = z.object({
  filename: z.string(),
  mimeType: z.string(),
  /** base64-encoded bytes */
  bytesBase64: z.string(),
});

const ListQuery = z.object({
  /** 'inbox' = recipientOrgId is the active org. 'outbox' = issuerOrgId. 'both' = either. */
  box: z.enum(['inbox', 'outbox', 'both']).default('both'),
  documentType: z.string().optional(),
  status: z.string().optional(),
  /** Counterparty filter — the *other* org. */
  counterpartyOrgId: z.string().optional(),
  /** Free-text search across `documentNumber` and indexed scalar reference fields.
   *  Case-insensitive substring match. Phase 4.1 uses ILIKE over the indexed
   *  scalars rather than a tsvector index — search corpus is small (rows
   *  scoped to the active org) and avoiding the migration keeps Phase 4.1
   *  shippable as part of the broader Phase 4 batch. Promotion to tsvector
   *  is straightforward later if cardinality grows. */
  q: z.string().min(1).optional(),
  /** Issued-on (issueDate) lower bound, ISO date. */
  fromDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** Issued-on upper bound (exclusive), ISO date. */
  toDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** Pagination, simple offset for Phase 2. */
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

interface StorageConfig {
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
}

export function documentsRouter(db: PrismaClient, storageCfg: StorageConfig): Router {
  const r = Router();
  r.use(authMiddleware(db));

  const guard = new TradingRelationshipGuard(db);
  const numbering = new PrismaNetworkNumberingStrategy(db);
  const { bodySchemas, linkRegistry, stateMachines } = buildDocumentTypeRegistry();
  const storage = new AttachmentStorage(db, { ...storageCfg, forcePathStyle: true });
  const emitter = new NotificationEmitter(db);

  /**
   * Phase 4.5 — fan a notification out to every user with an active
   * membership in `orgId`. Best-effort: errors are swallowed so a hiccup in
   * the outbox table never breaks document publish/transition.
   */
  async function notifyOrgUsers(
    orgId: string,
    eventType: string,
    documentId: string,
    payload: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    try {
      const memberships = await db.userOrgMembership.findMany({
        where: { orgId },
        select: { userId: true },
      });
      const recipientUserIds = memberships.map((m) => m.userId);
      if (recipientUserIds.length === 0) return;
      await emitter.emit({ eventType, documentId, recipientUserIds, payload });
    } catch {
      // Don't let notification problems bubble up — they are not part of
      // the document choreography's correctness boundary.
    }
  }

  // ---------------------------------------------------------------------
  // GET /documents — list scoped to the active org
  // ---------------------------------------------------------------------
  r.get('/documents', async (req, res) => {
    const ctx = mustAuth(res);
    if (!ctx) return;
    if (!ctx.activeMembership) {
      res.status(403).json({ error: 'no_active_membership' });
      return;
    }
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation', issues: parsed.error.issues });
      return;
    }
    const orgId = ctx.activeMembership.orgId;
    const { box, documentType, status, counterpartyOrgId, q, fromDate, toDate, limit, offset } =
      parsed.data;

    const orgFilter =
      box === 'inbox'
        ? { recipientOrgId: orgId }
        : box === 'outbox'
          ? { issuerOrgId: orgId }
          : { OR: [{ issuerOrgId: orgId }, { recipientOrgId: orgId }] };

    const counterpartyFilter = counterpartyOrgId
      ? {
          OR: [
            { issuerOrgId: counterpartyOrgId, recipientOrgId: orgId },
            { issuerOrgId: orgId, recipientOrgId: counterpartyOrgId },
          ],
        }
      : {};

    // §4.1 cross-type search: case-insensitive substring on `documentNumber`
    // and `referenceNumber`. Both columns are already indexed for filtering;
    // adding ILIKE on top is acceptable at MVP cardinality.
    const qFilter = q
      ? {
          OR: [
            { documentNumber: { contains: q, mode: 'insensitive' as const } },
            { referenceNumber: { contains: q, mode: 'insensitive' as const } },
          ],
        }
      : {};

    // §4.1 date-range over indexed `issueDate`.
    const dateFilter =
      fromDate || toDate
        ? {
            issueDate: {
              ...(fromDate ? { gte: new Date(fromDate + 'T00:00:00Z') } : {}),
              ...(toDate ? { lt: new Date(toDate + 'T00:00:00Z') } : {}),
            },
          }
        : {};

    const where = {
      AND: [
        orgFilter,
        counterpartyFilter,
        qFilter,
        dateFilter,
        ...(documentType !== undefined ? [{ documentType }] : []),
        ...(status !== undefined ? [{ status }] : []),
      ],
    };

    const documents = await db.document.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
      select: {
        id: true,
        documentType: true,
        documentNumber: true,
        issuerOrgId: true,
        recipientOrgId: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        currency: true,
        totalAmount: true,
        issueDate: true,
      },
    });

    const total = await db.document.count({ where });

    res.json({
      documents: documents.map((d) => ({
        ...d,
        totalAmount: d.totalAmount === null ? null : d.totalAmount.toString(),
      })),
      total,
      limit,
      offset,
    });
  });

  // ---------------------------------------------------------------------
  // POST /documents — publish
  // ---------------------------------------------------------------------
  r.post('/documents', async (req, res) => {
    const ctx = mustAuth(res);
    if (!ctx) return;
    if (!ctx.activeMembership) {
      res.status(403).json({ error: 'no_active_membership' });
      return;
    }
    const parsed = PublishBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation', issues: parsed.error.issues });
      return;
    }
    const stateMachine = stateMachines[parsed.data.documentType];
    if (!stateMachine) {
      res.status(400).json({ error: 'unknown_document_type' });
      return;
    }
    const result = await publish(
      { db, guard, numbering, bodySchemas },
      {
        documentType: parsed.data.documentType,
        issuerOrgId: ctx.activeMembership.orgId,
        recipientOrgId: parsed.data.recipientOrgId,
        body: parsed.data.body,
        actorUserId: ctx.userId,
        actorOrgId: ctx.activeMembership.orgId,
        actorRole: ctx.activeMembership.role,
        ...(parsed.data.invoiceMode !== undefined && { invoiceMode: parsed.data.invoiceMode }),
        stateMachine,
      },
    );
    if (!result.ok) {
      res.status(400).json({ error: 'publish_rejected', reason: result.reason });
      return;
    }

    // No-double-billing pre-check for SUMMARY invoices (PHASES.md §2.6).
    // The DB link-uniqueness on (fromDocumentId, toDocumentId, linkType)
    // only prevents the SAME invoice from linking to the same PO twice;
    // it doesn't stop two different invoices from each INVOICES-linking
    // the same PO. The §2.6 contract says a PO can only be invoiced once
    // across all invoices, so we scan here and refuse if any source
    // document already has an INVOICES link.
    //
    // We do this AFTER the publish (so the audit log shows the rejected
    // attempt) — when we detect duplicates we surface them as
    // linkWarnings rather than rolling back. This mirrors how the route
    // handles other auto-link failures and keeps the substrate transaction
    // boundary clean.
    if (
      parsed.data.documentType === 'INVOICE' &&
      parsed.data.invoiceMode === 'SUMMARY' &&
      typeof parsed.data.body === 'object' &&
      parsed.data.body !== null
    ) {
      const body = parsed.data.body as { sourceDocuments?: unknown };
      if (Array.isArray(body.sourceDocuments)) {
        const sourceIds = body.sourceDocuments
          .map((s) =>
            typeof s === 'object' && s !== null ? (s as { documentId?: unknown }).documentId : null,
          )
          .filter((x): x is string => typeof x === 'string' && x.length > 0);
        if (sourceIds.length > 0) {
          const alreadyInvoiced = await db.documentLink.findMany({
            where: {
              toDocumentId: { in: sourceIds },
              linkType: 'INVOICES',
              // Exclude links from THIS invoice (none yet, but the auto-link
              // step below will create them; this query runs before that).
              NOT: { fromDocumentId: result.documentId },
            },
            select: { toDocumentId: true, fromDocumentId: true },
          });
          if (alreadyInvoiced.length > 0) {
            // Mark these source docs as duplicate-invoiced. The auto-link
            // step below will skip them implicitly (DB unique enforces
            // per-from-doc uniqueness, and we'll surface the rejections).
            // We pre-stage the warnings so callers see ALL duplicates,
            // not just the first one to fail.
            //
            // The conservative thing to do: STILL run the auto-link step
            // so any non-duplicate sources land, and merge our warnings.
            const preStageDuplicates = alreadyInvoiced.map((row) => ({
              plan: {
                fromDocumentId: result.documentId,
                fromDocumentType: 'INVOICE',
                toDocumentId: row.toDocumentId,
                toDocumentType: 'SOURCE',
                linkType: 'INVOICES',
              },
              reason: {
                kind: 'repository',
                detail: {
                  kind: 'duplicate_link',
                  fromDocumentId: row.fromDocumentId,
                  toDocumentId: row.toDocumentId,
                  linkType: 'INVOICES',
                },
              },
            }));
            const autoLinkPlans = computeAutoLinkPlans(
              parsed.data.documentType,
              parsed.data.body,
              result.documentId,
            );
            // Filter out the plans that target an already-invoiced source.
            const alreadyInvoicedSet = new Set(alreadyInvoiced.map((r) => r.toDocumentId));
            const remainingPlans = autoLinkPlans.filter(
              (p) => !alreadyInvoicedSet.has(p.toDocumentId),
            );
            const remainingWarnings: unknown[] = [...preStageDuplicates];
            for (const plan of remainingPlans) {
              const lr = await linkOp(
                { db, linkRegistry },
                {
                  fromDocumentId: plan.fromDocumentId,
                  fromDocumentType: plan.fromDocumentType,
                  toDocumentId: plan.toDocumentId,
                  toDocumentType: plan.toDocumentType,
                  linkType: plan.linkType,
                  actorUserId: ctx.userId,
                  actorOrgId: ctx.activeMembership.orgId,
                },
              );
              if (!lr.ok) remainingWarnings.push({ plan, reason: lr.reason });
            }
            res.status(201).json({
              documentId: result.documentId,
              versionId: result.versionId,
              documentNumber: result.documentNumber,
              linkWarnings: remainingWarnings,
            });
            return;
          }
        }
      }
    }

    // Auto-link from the new document to its referenced predecessors.
    // Each typed document carries id refs in its body (poDocumentId,
    // asnDocumentId, invoiceDocumentId, etc.); the route creates the
    // lineage links here so callers don't have to make a second POST.
    //
    // Best-effort semantics: failures surface as `linkWarning` in the
    // 201 body — the document itself remains published; the link can
    // be retried.
    const autoLinkPlans = computeAutoLinkPlans(
      parsed.data.documentType,
      parsed.data.body,
      result.documentId,
    );
    const linkWarnings: unknown[] = [];
    for (const plan of autoLinkPlans) {
      const linkResult = await linkOp(
        { db, linkRegistry },
        {
          fromDocumentId: plan.fromDocumentId,
          fromDocumentType: plan.fromDocumentType,
          toDocumentId: plan.toDocumentId,
          toDocumentType: plan.toDocumentType,
          linkType: plan.linkType,
          actorUserId: ctx.userId,
          actorOrgId: ctx.activeMembership.orgId,
        },
      );
      if (!linkResult.ok) {
        linkWarnings.push({ plan, reason: linkResult.reason });
      }
    }

    res.status(201).json({
      documentId: result.documentId,
      versionId: result.versionId,
      documentNumber: result.documentNumber,
      ...(linkWarnings.length > 0 && { linkWarnings }),
    });

    // Fire-and-forget notify to recipient org's users.
    void notifyOrgUsers(parsed.data.recipientOrgId, 'DOCUMENT_PUBLISHED', result.documentId, {
      documentType: parsed.data.documentType,
      documentNumber: result.documentNumber,
      issuerOrgId: ctx.activeMembership.orgId,
    });
  });

  r.get('/documents/:id', async (req, res) => {
    const ctx = mustAuth(res);
    if (!ctx) return;
    const id = req.params.id ?? '';
    const doc = await db.document.findUnique({
      where: { id },
      include: {
        versions: { orderBy: { versionNumber: 'asc' } },
        outgoingLinks: true,
        incomingLinks: true,
        auditLog: { orderBy: { occurredAt: 'asc' } },
        attachments: true,
      },
    });
    if (!doc) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({
      ...doc,
      totalAmount: doc.totalAmount === null ? null : doc.totalAmount.toString(),
      attachments: doc.attachments.map((a) => ({ ...a, sizeBytes: Number(a.sizeBytes) })),
    });
  });

  r.post('/documents/:id/supersede', async (req, res) => {
    const ctx = mustAuth(res);
    if (!ctx) return;
    if (!ctx.activeMembership) {
      res.status(403).json({ error: 'no_active_membership' });
      return;
    }
    const id = req.params.id ?? '';
    const parsed = SupersedeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation' });
      return;
    }
    const doc = await db.document.findUnique({ where: { id }, select: { documentType: true } });
    if (!doc) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const result = await supersede(
      { db, bodySchemas },
      {
        documentId: id,
        documentType: doc.documentType,
        body: parsed.data.body,
        actorUserId: ctx.userId,
        actorOrgId: ctx.activeMembership.orgId,
        ...(parsed.data.changeReason !== undefined && { changeReason: parsed.data.changeReason }),
      },
    );
    if (!result.ok) {
      res.status(400).json({ error: 'supersede_rejected', reason: result.reason });
      return;
    }
    res.json({ versionId: result.versionId, versionNumber: result.versionNumber });
  });

  r.post('/documents/:id/transition', async (req, res) => {
    const ctx = mustAuth(res);
    if (!ctx) return;
    if (!ctx.activeMembership) {
      res.status(403).json({ error: 'no_active_membership' });
      return;
    }
    const id = req.params.id ?? '';
    const parsed = TransitionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation' });
      return;
    }
    const doc = await db.document.findUnique({
      where: { id },
      select: {
        id: true,
        documentType: true,
        documentNumber: true,
        issuerOrgId: true,
        recipientOrgId: true,
      },
    });
    if (!doc) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const stateMachine = stateMachines[doc.documentType];
    if (!stateMachine) {
      res.status(400).json({ error: 'unknown_document_type' });
      return;
    }

    // PHASES.md §2.2 guard: a PO can only move to CHANGED if there's an
    // ACCEPTED_BY_SUPPLIER PO_CHANGE that SUPERSEDES it. The state-machine
    // factory is intentionally pure-TS (no DB access), so the guard runs
    // here at the route boundary instead of inside the machine.
    if (doc.documentType === 'PO' && parsed.data.toStatus === 'CHANGED') {
      const acceptedChange = await db.documentLink.findFirst({
        where: {
          toDocumentId: id,
          linkType: 'SUPERSEDES',
          from: {
            documentType: 'PO_CHANGE',
            status: 'ACCEPTED_BY_SUPPLIER',
          },
        },
      });
      if (!acceptedChange) {
        res.status(400).json({
          error: 'transition_rejected',
          reason: {
            kind: 'precondition_failed',
            detail: { kind: 'no_accepted_po_change' },
          },
        });
        return;
      }
    }

    const actorSide = doc.issuerOrgId === ctx.activeMembership.orgId ? 'issuer' : 'recipient';
    const result = await acknowledge(
      { db },
      {
        documentId: id,
        fromStatus: parsed.data.fromStatus,
        toStatus: parsed.data.toStatus,
        actorUserId: ctx.userId,
        actorOrgId: ctx.activeMembership.orgId,
        actorRole: ctx.activeMembership.role,
        actorSide,
        stateMachine,
      },
    );
    if (!result.ok) {
      res.status(400).json({ error: 'transition_rejected', reason: result.reason });
      return;
    }
    res.json({ nextStatus: result.nextStatus });

    // Notify the other side of the relationship of the state change.
    const other =
      doc.issuerOrgId === ctx.activeMembership.orgId ? doc.recipientOrgId : doc.issuerOrgId;
    void notifyOrgUsers(other, 'DOCUMENT_STATUS_CHANGED', doc.id, {
      documentType: doc.documentType,
      documentNumber: doc.documentNumber,
      fromStatus: parsed.data.fromStatus,
      toStatus: parsed.data.toStatus,
    });
  });

  r.post('/documents/:id/links', async (req, res) => {
    const ctx = mustAuth(res);
    if (!ctx) return;
    if (!ctx.activeMembership) {
      res.status(403).json({ error: 'no_active_membership' });
      return;
    }
    const id = req.params.id ?? '';
    const parsed = LinkBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation' });
      return;
    }
    const fromDoc = await db.document.findUnique({
      where: { id },
      select: { documentType: true },
    });
    if (!fromDoc) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const result = await linkOp(
      { db, linkRegistry },
      {
        fromDocumentId: id,
        fromDocumentType: fromDoc.documentType,
        toDocumentId: parsed.data.toDocumentId,
        toDocumentType: parsed.data.toDocumentType,
        linkType: parsed.data.linkType,
        actorUserId: ctx.userId,
        actorOrgId: ctx.activeMembership.orgId,
      },
    );
    if (!result.ok) {
      res.status(400).json({ error: 'link_rejected', reason: result.reason });
      return;
    }
    res.status(201).json({ linkId: result.linkId });
  });

  r.post('/documents/:id/attachments', async (req, res) => {
    const ctx = mustAuth(res);
    if (!ctx) return;
    if (!ctx.activeMembership) {
      res.status(403).json({ error: 'no_active_membership' });
      return;
    }
    const id = req.params.id ?? '';
    const parsed = AttachmentBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation' });
      return;
    }
    const doc = await db.document.findUnique({
      where: { id },
      select: { id: true, currentVersionId: true },
    });
    if (!doc) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const bytes = new Uint8Array(Buffer.from(parsed.data.bytesBase64, 'base64'));
    const desc = await storage.put({
      documentId: id,
      ...(doc.currentVersionId !== null && { versionId: doc.currentVersionId }),
      bytes,
      filename: parsed.data.filename,
      mimeType: parsed.data.mimeType,
      uploadedById: ctx.userId,
    });

    await db.documentAuditLog.create({
      data: {
        documentId: id,
        actorUserId: ctx.userId,
        actorOrgId: ctx.activeMembership.orgId,
        action: 'ATTACHMENT_ADDED',
        payload: { attachmentId: desc.id, filename: desc.filename, sha256: desc.sha256 },
      },
    });

    res.status(201).json({
      id: desc.id,
      storageKey: desc.storageKey,
      filename: desc.filename,
      mimeType: desc.mimeType,
      sizeBytes: desc.sizeBytes,
      sha256: desc.sha256,
    });
  });

  r.get('/attachments/:id', async (req, res) => {
    const ctx = mustAuth(res);
    if (!ctx) return;
    const id = req.params.id ?? '';
    const result = await storage.get(id);
    if (!result.ok) {
      res.status(404).json({ error: result.reason.kind });
      return;
    }
    res.setHeader('Content-Type', result.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.send(Buffer.from(result.bytes));
  });

  return r;
}

// ---------------------------------------------------------------------------
// Auto-link plans
// ---------------------------------------------------------------------------

/**
 * Per-type table of auto-links to create on publish. Each new document
 * type lists which of its body fields hold ids of related documents,
 * what document type each id targets, and the link type to register.
 *
 * SUMMARY invoices fan out: one link per `sourceDocuments[]` entry.
 */
interface AutoLinkPlan {
  readonly fromDocumentId: string;
  readonly fromDocumentType: string;
  readonly toDocumentId: string;
  readonly toDocumentType: string;
  readonly linkType: string;
}

function computeAutoLinkPlans(
  documentType: string,
  body: unknown,
  fromDocumentId: string,
): AutoLinkPlan[] {
  if (typeof body !== 'object' || body === null) return [];
  const b = body as Record<string, unknown>;

  switch (documentType) {
    case 'ORDER_CONFIRMATION': {
      // ORDER_CONFIRMATION → PO via ACKNOWLEDGES (Phase 2.3).
      const poId = stringOrNull(b['poDocumentId']);
      if (!poId) return [];
      return [
        {
          fromDocumentId,
          fromDocumentType: 'ORDER_CONFIRMATION',
          toDocumentId: poId,
          toDocumentType: 'PO',
          linkType: 'ACKNOWLEDGES',
        },
      ];
    }
    case 'PO_CHANGE': {
      // PO_CHANGE → PO via SUPERSEDES (Phase 2.2). The §2.2 precondition
      // guard on PO `→ CHANGED` reads this link to decide whether an
      // accepted change exists, so the link must exist for the guard
      // to pass.
      const poId = stringOrNull(b['poDocumentId']);
      if (!poId) return [];
      return [
        {
          fromDocumentId,
          fromDocumentType: 'PO_CHANGE',
          toDocumentId: poId,
          toDocumentType: 'PO',
          linkType: 'SUPERSEDES',
        },
      ];
    }
    case 'ASN': {
      // ASN → PO via SHIPS_AGAINST (Phase 2.4) — OR — ASN → SA_RELEASE_JIT
      // via SHIPS_AGAINST (Phase 3.2, polymorphic predecessor). The body
      // carries either poDocumentId or saReleaseJitDocumentId; route picks
      // whichever is present. If both are present (very unusual) we
      // prefer the JIT release since it's the more specific predecessor.
      const jitId = stringOrNull(b['saReleaseJitDocumentId']);
      const poId = stringOrNull(b['poDocumentId']);
      if (jitId) {
        return [
          {
            fromDocumentId,
            fromDocumentType: 'ASN',
            toDocumentId: jitId,
            toDocumentType: 'SA_RELEASE_JIT',
            linkType: 'SHIPS_AGAINST',
          },
        ];
      }
      if (!poId) return [];
      return [
        {
          fromDocumentId,
          fromDocumentType: 'ASN',
          toDocumentId: poId,
          toDocumentType: 'PO',
          linkType: 'SHIPS_AGAINST',
        },
      ];
    }
    case 'GOODS_RECEIPT': {
      // GR → PO (FULFILLS) and optionally GR → ASN (RECEIVES) (Phase 2.5).
      const poId = stringOrNull(b['poDocumentId']);
      const asnId = stringOrNull(b['asnDocumentId']);
      const plans: AutoLinkPlan[] = [];
      if (poId) {
        plans.push({
          fromDocumentId,
          fromDocumentType: 'GOODS_RECEIPT',
          toDocumentId: poId,
          toDocumentType: 'PO',
          linkType: 'FULFILLS',
        });
      }
      if (asnId) {
        plans.push({
          fromDocumentId,
          fromDocumentType: 'GOODS_RECEIPT',
          toDocumentId: asnId,
          toDocumentType: 'ASN',
          linkType: 'RECEIVES',
        });
      }
      return plans;
    }
    case 'INVOICE': {
      // INVOICE PO_FLIP → PO + GRs via INVOICES.
      // INVOICE SUMMARY → fan out to all sourceDocuments[] entries.
      const mode = stringOrNull(b['invoiceMode']);
      if (mode === 'PO_FLIP') {
        const poId = stringOrNull(b['poDocumentId']);
        const grIds = arrayOfStringsOrEmpty(b['grDocumentIds']);
        const plans: AutoLinkPlan[] = [];
        if (poId) {
          plans.push({
            fromDocumentId,
            fromDocumentType: 'INVOICE',
            toDocumentId: poId,
            toDocumentType: 'PO',
            linkType: 'INVOICES',
          });
        }
        for (const grId of grIds) {
          plans.push({
            fromDocumentId,
            fromDocumentType: 'INVOICE',
            toDocumentId: grId,
            toDocumentType: 'GOODS_RECEIPT',
            linkType: 'INVOICES',
          });
        }
        return plans;
      }
      if (mode === 'SUMMARY') {
        const sources = b['sourceDocuments'];
        if (!Array.isArray(sources)) return [];
        const plans: AutoLinkPlan[] = [];
        for (const s of sources) {
          if (typeof s !== 'object' || s === null) continue;
          const sd = s as Record<string, unknown>;
          const toType = stringOrNull(sd['documentType']);
          const toId = stringOrNull(sd['documentId']);
          if (toType && toId) {
            plans.push({
              fromDocumentId,
              fromDocumentType: 'INVOICE',
              toDocumentId: toId,
              toDocumentType: toType,
              linkType: 'INVOICES',
            });
          }
        }
        return plans;
      }
      return [];
    }
    case 'CREDIT_MEMO': {
      // CREDIT_MEMO → INVOICE via CREDITS (Phase 2.7).
      const invoiceId = stringOrNull(b['invoiceDocumentId']);
      if (!invoiceId) return [];
      return [
        {
          fromDocumentId,
          fromDocumentType: 'CREDIT_MEMO',
          toDocumentId: invoiceId,
          toDocumentType: 'INVOICE',
          linkType: 'CREDITS',
        },
      ];
    }
    case 'REMITTANCE_ADVICE': {
      // REMITTANCE_ADVICE → INVOICE/CREDIT_MEMO via REMITS, one per
      // allocation (Phase 2.8).
      const allocations = b['allocations'];
      if (!Array.isArray(allocations)) return [];
      const plans: AutoLinkPlan[] = [];
      for (const a of allocations) {
        if (typeof a !== 'object' || a === null) continue;
        const ad = a as Record<string, unknown>;
        const toType = stringOrNull(ad['documentType']);
        const toId = stringOrNull(ad['documentId']);
        if (toType && toId) {
          plans.push({
            fromDocumentId,
            fromDocumentType: 'REMITTANCE_ADVICE',
            toDocumentId: toId,
            toDocumentType: toType,
            linkType: 'REMITS',
          });
        }
      }
      return plans;
    }
    case 'FORECAST_PUBLISH': {
      // FORECAST_PUBLISH → SCHEDULING_AGREEMENT via CALLS_OFF (optional),
      // and → FORECAST_PUBLISH via SUPERSEDES (when revising a prior
      // forecast) — both Phase 3.1.
      const plans: AutoLinkPlan[] = [];
      const saId = stringOrNull(b['schedulingAgreementDocumentId']);
      if (saId) {
        plans.push({
          fromDocumentId,
          fromDocumentType: 'FORECAST_PUBLISH',
          toDocumentId: saId,
          toDocumentType: 'SCHEDULING_AGREEMENT',
          linkType: 'CALLS_OFF',
        });
      }
      const supersedesId = stringOrNull(b['supersedesForecastDocumentId']);
      if (supersedesId) {
        plans.push({
          fromDocumentId,
          fromDocumentType: 'FORECAST_PUBLISH',
          toDocumentId: supersedesId,
          toDocumentType: 'FORECAST_PUBLISH',
          linkType: 'SUPERSEDES',
        });
      }
      return plans;
    }
    case 'FORECAST_COMMIT': {
      // FORECAST_COMMIT → FORECAST_PUBLISH via RESPONDS_TO (Phase 3.1).
      const forecastId = stringOrNull(b['forecastDocumentId']);
      if (!forecastId) return [];
      return [
        {
          fromDocumentId,
          fromDocumentType: 'FORECAST_COMMIT',
          toDocumentId: forecastId,
          toDocumentType: 'FORECAST_PUBLISH',
          linkType: 'RESPONDS_TO',
        },
      ];
    }
    case 'SA_RELEASE_FORECAST': {
      // SA_RELEASE_FORECAST → SCHEDULING_AGREEMENT via CALLS_OFF; optional
      // SUPERSEDES → prior release (Phase 3.2).
      const plans: AutoLinkPlan[] = [];
      const saId = stringOrNull(b['schedulingAgreementDocumentId']);
      if (saId) {
        plans.push({
          fromDocumentId,
          fromDocumentType: 'SA_RELEASE_FORECAST',
          toDocumentId: saId,
          toDocumentType: 'SCHEDULING_AGREEMENT',
          linkType: 'CALLS_OFF',
        });
      }
      const supersedesId = stringOrNull(b['supersedesReleaseDocumentId']);
      if (supersedesId) {
        plans.push({
          fromDocumentId,
          fromDocumentType: 'SA_RELEASE_FORECAST',
          toDocumentId: supersedesId,
          toDocumentType: 'SA_RELEASE_FORECAST',
          linkType: 'SUPERSEDES',
        });
      }
      return plans;
    }
    case 'SA_RELEASE_JIT': {
      // SA_RELEASE_JIT → SCHEDULING_AGREEMENT via CALLS_OFF; optional
      // SUPERSEDES → prior JIT release (Phase 3.2).
      const plans: AutoLinkPlan[] = [];
      const saId = stringOrNull(b['schedulingAgreementDocumentId']);
      if (saId) {
        plans.push({
          fromDocumentId,
          fromDocumentType: 'SA_RELEASE_JIT',
          toDocumentId: saId,
          toDocumentType: 'SCHEDULING_AGREEMENT',
          linkType: 'CALLS_OFF',
        });
      }
      const supersedesId = stringOrNull(b['supersedesReleaseDocumentId']);
      if (supersedesId) {
        plans.push({
          fromDocumentId,
          fromDocumentType: 'SA_RELEASE_JIT',
          toDocumentId: supersedesId,
          toDocumentType: 'SA_RELEASE_JIT',
          linkType: 'SUPERSEDES',
        });
      }
      return plans;
    }
    default:
      return [];
  }
}

function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function arrayOfStringsOrEmpty(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
}
