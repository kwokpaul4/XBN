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
    const { box, documentType, status, counterpartyOrgId, limit, offset } = parsed.data;

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

    const documents = await db.document.findMany({
      where: {
        AND: [
          orgFilter,
          counterpartyFilter,
          ...(documentType !== undefined ? [{ documentType }] : []),
          ...(status !== undefined ? [{ status }] : []),
        ],
      },
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

    const total = await db.document.count({
      where: {
        AND: [
          orgFilter,
          counterpartyFilter,
          ...(documentType !== undefined ? [{ documentType }] : []),
          ...(status !== undefined ? [{ status }] : []),
        ],
      },
    });

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

    // Auto-link from ORDER_CONFIRMATION → PO via ACKNOWLEDGES on publish.
    // The body always carries poDocumentId (per the §2.3 schema), so we can
    // create the lineage link immediately rather than asking the caller to
    // make a second POST. Best-effort: a failure here doesn't roll back the
    // publish — the OC exists; the link can be added after the fact.
    if (parsed.data.documentType === 'ORDER_CONFIRMATION') {
      const body = parsed.data.body as { poDocumentId?: string } | null;
      if (body && typeof body.poDocumentId === 'string' && body.poDocumentId.length > 0) {
        const linkResult = await linkOp(
          { db, linkRegistry },
          {
            fromDocumentId: result.documentId,
            fromDocumentType: 'ORDER_CONFIRMATION',
            toDocumentId: body.poDocumentId,
            toDocumentType: 'PO',
            linkType: 'ACKNOWLEDGES',
            actorUserId: ctx.userId,
            actorOrgId: ctx.activeMembership.orgId,
          },
        );
        // We surface link failures in the response so callers can react
        // (e.g. PO not found, or already-linked OC); the OC itself
        // remains published.
        if (!linkResult.ok) {
          res.status(201).json({
            documentId: result.documentId,
            versionId: result.versionId,
            documentNumber: result.documentNumber,
            linkWarning: linkResult.reason,
          });
          return;
        }
      }
    }

    res.status(201).json({
      documentId: result.documentId,
      versionId: result.versionId,
      documentNumber: result.documentNumber,
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
      select: { documentType: true, issuerOrgId: true },
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
