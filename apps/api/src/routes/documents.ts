/**
 * Documents HTTP surface. Composes @xbn/document-core: registers the
 * Phase 1 document types (GENERIC_DOCUMENT and the PO ↔ ORDER_CONFIRMATION
 * pair), wires the substrate, and exposes publish / supersede / transition /
 * link / attach.
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  AttachmentStorage,
  BodySchemaRegistry,
  defineStateMachine,
  link as linkOp,
  LinkRegistry,
  PrismaNetworkNumberingStrategy,
  publish,
  supersede,
  acknowledge,
  TradingRelationshipGuard,
  type StateMachine,
} from '@xbn/document-core';
import type { OrgRole, PrismaClient } from '@xbn/db';

import { authMiddleware, mustAuth } from '../auth-middleware.js';

// ---------------------------------------------------------------------------
// Phase 1 document-type registrations
// ---------------------------------------------------------------------------
//
// In Phase 2 these will move into per-document-type modules. For Phase 1.4/1.6
// we keep them inline so the M1 acceptance test can drive everything from
// one place.

type Role = OrgRole;

const genericMachine: StateMachine<string, Role, unknown> = defineStateMachine<
  string,
  Role,
  unknown
>({
  initialState: 'PUBLISHED',
  transitions: {
    PUBLISHED: [
      { to: 'CANCELLED', requiredRole: 'BUYER_ADMIN', actor: 'issuer' },
      { to: 'CANCELLED', requiredRole: 'SUPPLIER_ADMIN', actor: 'issuer' },
    ],
    SUPERSEDED: [],
    CANCELLED: [],
  },
});

const poMachine: StateMachine<string, Role, unknown> = defineStateMachine<string, Role, unknown>({
  initialState: 'DRAFT',
  transitions: {
    DRAFT: [
      { to: 'ISSUED', requiredRole: 'BUYER_ADMIN', actor: 'issuer' },
      { to: 'ISSUED', requiredRole: 'BUYER_USER', actor: 'issuer' },
      { to: 'CANCELLED', requiredRole: 'BUYER_ADMIN', actor: 'issuer' },
    ],
    ISSUED: [
      { to: 'ACKNOWLEDGED', requiredRole: 'SUPPLIER_USER', actor: 'recipient' },
      { to: 'ACKNOWLEDGED', requiredRole: 'SUPPLIER_ADMIN', actor: 'recipient' },
      { to: 'CANCELLED', requiredRole: 'BUYER_ADMIN', actor: 'issuer' },
    ],
    ACKNOWLEDGED: [],
    CANCELLED: [],
  },
});

const orderConfirmationMachine: StateMachine<string, Role, unknown> = defineStateMachine<
  string,
  Role,
  unknown
>({
  initialState: 'DRAFT',
  transitions: {
    DRAFT: [
      { to: 'ISSUED', requiredRole: 'SUPPLIER_USER', actor: 'issuer' },
      { to: 'ISSUED', requiredRole: 'SUPPLIER_ADMIN', actor: 'issuer' },
    ],
    ISSUED: [],
  },
});

function buildBodySchemas(): BodySchemaRegistry {
  const reg = new BodySchemaRegistry();
  reg.register(
    'GENERIC_DOCUMENT',
    z.object({ note: z.string(), metadata: z.record(z.string(), z.any()).optional() }),
  );
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
  return reg;
}

function buildLinkRegistry(): LinkRegistry {
  const reg = new LinkRegistry();
  reg.register({
    fromType: 'GENERIC_DOCUMENT',
    toType: 'GENERIC_DOCUMENT',
    linkType: 'RESPONDS_TO',
    inboundCardinality: 'many',
    outboundCardinality: 'one',
  });
  reg.register({
    fromType: 'ORDER_CONFIRMATION',
    toType: 'PO',
    linkType: 'ACKNOWLEDGES',
    inboundCardinality: 'one',
    outboundCardinality: 'one',
  });
  return reg;
}

const STATE_MACHINES: Record<string, StateMachine<string, Role, unknown>> = {
  GENERIC_DOCUMENT: genericMachine,
  PO: poMachine,
  ORDER_CONFIRMATION: orderConfirmationMachine,
};

// ---------------------------------------------------------------------------

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
  const bodySchemas = buildBodySchemas();
  const linkRegistry = buildLinkRegistry();
  const storage = new AttachmentStorage(db, { ...storageCfg, forcePathStyle: true });

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
    const stateMachine = STATE_MACHINES[parsed.data.documentType];
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
    const stateMachine = STATE_MACHINES[doc.documentType];
    if (!stateMachine) {
      res.status(400).json({ error: 'unknown_document_type' });
      return;
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
