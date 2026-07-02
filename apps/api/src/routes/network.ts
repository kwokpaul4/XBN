import { Router } from 'express';
import { z } from 'zod';
import { addMembership } from '@xbn/auth';
import type { AuditAction, OrgType, PrismaClient } from '@xbn/db';
import {
  acceptInvitation,
  activateRelationship,
  createOrg,
  createRelationship,
  issueInvitation,
  listOrgs,
  listRelationshipsForOrg,
} from '@xbn/network';

import { authMiddleware, mustAuth } from '../auth-middleware.js';

const CreateOrgBody = z.object({
  legalName: z.string().min(1),
  displayName: z.string().min(1),
  orgType: z.enum(['BUYER', 'SUPPLIER', 'BOTH']),
  bindAsRole: z.enum([
    'BUYER_ADMIN',
    'SUPPLIER_ADMIN',
    'BUYER_USER',
    'SUPPLIER_USER',
    'NETWORK_ADMIN',
  ]),
});

const CreateRelationshipBody = z.object({
  buyerOrgId: z.string(),
  supplierOrgId: z.string(),
  status: z.enum(['PENDING_INVITATION', 'ACTIVE']).default('ACTIVE'),
  enabledDocumentTypes: z.array(z.string()).default([]),
  defaultCurrency: z.string().length(3).optional(),
  summaryInvoicingEnabled: z.boolean().default(false),
});

const IssueInvitationBody = z.object({
  buyerOrgId: z.string(),
  invitedEmail: z.string().email(),
  invitedOrgName: z.string(),
});

const AcceptInvitationBody = z.object({ token: z.string() });

export function networkRouter(db: PrismaClient): Router {
  const r = Router();
  r.use(authMiddleware(db));

  r.post('/orgs', async (req, res) => {
    const ctx = mustAuth(res);
    if (!ctx) return;
    const parsed = CreateOrgBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation', issues: parsed.error.issues });
      return;
    }
    const org = await createOrg(db, {
      legalName: parsed.data.legalName,
      displayName: parsed.data.displayName,
      orgType: parsed.data.orgType as OrgType,
    });
    await addMembership(db, ctx.userId, org.id, parsed.data.bindAsRole);
    res.status(201).json({ org });
  });

  r.get('/orgs', async (_req, res) => {
    const ctx = mustAuth(res);
    if (!ctx) return;
    const list = await listOrgs(db);
    res.json({ orgs: list });
  });

  r.post('/relationships', async (req, res) => {
    const ctx = mustAuth(res);
    if (!ctx) return;
    const parsed = CreateRelationshipBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation', issues: parsed.error.issues });
      return;
    }
    const result = await createRelationship(
      db,
      parsed.data.buyerOrgId,
      parsed.data.supplierOrgId,
      parsed.data.status,
      {
        enabledDocumentTypes: parsed.data.enabledDocumentTypes,
        ...(parsed.data.defaultCurrency !== undefined && {
          defaultCurrency: parsed.data.defaultCurrency,
        }),
        summaryInvoicingEnabled: parsed.data.summaryInvoicingEnabled,
      },
    );
    if (!result.ok) {
      res.status(409).json({ error: result.reason });
      return;
    }
    res.status(201).json({ relationship: result.relationship });
  });

  r.get('/relationships', async (_req, res) => {
    const ctx = mustAuth(res);
    if (!ctx) return;
    if (!ctx.activeMembership) {
      res.status(403).json({ error: 'no_active_membership' });
      return;
    }
    const list = await listRelationshipsForOrg(db, ctx.activeMembership.orgId);
    res.json({ relationships: list });
  });

  r.post('/relationships/:id/activate', async (req, res) => {
    const ctx = mustAuth(res);
    if (!ctx) return;
    const result = await activateRelationship(db, req.params.id ?? '');
    res.json(result);
  });

  r.post('/invitations', async (req, res) => {
    const ctx = mustAuth(res);
    if (!ctx) return;
    const parsed = IssueInvitationBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation' });
      return;
    }
    const issued = await issueInvitation(db, {
      invitedByUserId: ctx.userId,
      buyerOrgId: parsed.data.buyerOrgId,
      invitedEmail: parsed.data.invitedEmail,
      invitedOrgName: parsed.data.invitedOrgName,
    });
    res.status(201).json(issued);
  });

  r.post('/invitations/accept', async (req, res) => {
    const ctx = mustAuth(res);
    if (!ctx) return;
    const parsed = AcceptInvitationBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation' });
      return;
    }
    const result = await acceptInvitation(db, parsed.data.token);
    if (!result.ok) {
      res.status(400).json({ error: result.reason });
      return;
    }
    res.json(result);
  });

  // ---------------------------------------------------------------------
  // Phase 4.1 / 4.2 — Counterparties endpoint
  //
  // Lists every org the active org has an ACTIVE TradingRelationship with,
  // plus per-counterparty metadata: relationship id, role (whether the
  // active org is buyer or supplier on that link), enabled doc types, and
  // last-activity timestamp (most recent document either way). Drives both
  // the inbox counterparty filter and the supplier-directory UI.
  // ---------------------------------------------------------------------
  r.get('/counterparties', async (_req, res) => {
    const ctx = mustAuth(res);
    if (!ctx) return;
    if (!ctx.activeMembership) {
      res.status(403).json({ error: 'no_active_membership' });
      return;
    }
    const orgId = ctx.activeMembership.orgId;
    const rels = await db.tradingRelationship.findMany({
      where: { OR: [{ buyerOrgId: orgId }, { supplierOrgId: orgId }] },
      include: { buyerOrg: true, supplierOrg: true },
      orderBy: { createdAt: 'desc' },
    });

    // Last-activity per counterparty: most recent document between the two
    // orgs in either direction.
    const counterparties = await Promise.all(
      rels.map(async (rel) => {
        const isBuyer = rel.buyerOrgId === orgId;
        const counterparty = isBuyer ? rel.supplierOrg : rel.buyerOrg;
        const lastDoc = await db.document.findFirst({
          where: {
            OR: [
              { issuerOrgId: orgId, recipientOrgId: counterparty.id },
              { issuerOrgId: counterparty.id, recipientOrgId: orgId },
            ],
          },
          orderBy: { createdAt: 'desc' },
          select: { id: true, createdAt: true, documentType: true, documentNumber: true },
        });
        return {
          relationshipId: rel.id,
          counterpartyOrgId: counterparty.id,
          counterpartyLegalName: counterparty.legalName,
          counterpartyDisplayName: counterparty.displayName,
          ourRole: isBuyer ? ('BUYER' as const) : ('SUPPLIER' as const),
          status: rel.status,
          enabledDocumentTypes: rel.enabledDocumentTypes,
          defaultCurrency: rel.defaultCurrency,
          summaryInvoicingEnabled: rel.summaryInvoicingEnabled,
          establishedAt: rel.createdAt,
          lastActivityAt: lastDoc?.createdAt ?? null,
          lastDocument: lastDoc
            ? {
                id: lastDoc.id,
                documentType: lastDoc.documentType,
                documentNumber: lastDoc.documentNumber,
              }
            : null,
        };
      }),
    );

    res.json({ counterparties });
  });

  // ---------------------------------------------------------------------
  // Phase 4.3 — Status dashboards
  //
  // Two roll-up endpoints. Each returns counts grouped by document type +
  // status that the relevant role needs to act on. Pure SQL over
  // `documents` + `document_links` — no aggregation service, per PHASES.md
  // §4.3.
  //
  // We deliberately return arrays of { documentType, status, count } rather
  // than a fixed schema, so adding new doc types in Phase 5+ doesn't break
  // the API contract.
  // ---------------------------------------------------------------------

  /** Group `documents` rows by (documentType, status) for either inbox or outbox. */
  async function groupByTypeStatus(
    orgId: string,
    direction: 'inbox' | 'outbox',
  ): Promise<Array<{ documentType: string; status: string; count: number }>> {
    const where = direction === 'inbox' ? { recipientOrgId: orgId } : { issuerOrgId: orgId };
    const rows = await db.document.groupBy({
      by: ['documentType', 'status'],
      where,
      _count: { _all: true },
    });
    return rows.map((r) => ({
      documentType: r.documentType,
      status: r.status,
      count: r._count._all,
    }));
  }

  r.get('/dashboards/buyer', async (_req, res) => {
    const ctx = mustAuth(res);
    if (!ctx) return;
    if (!ctx.activeMembership) {
      res.status(403).json({ error: 'no_active_membership' });
      return;
    }
    const orgId = ctx.activeMembership.orgId;
    // Outbox: docs the buyer issued — PO awaiting ack, releases awaiting
    // commit, etc. Inbox: docs the buyer receives — OCs to accept, ASNs in
    // transit, invoices pending review, forecast commits to review.
    const [issued, received] = await Promise.all([
      groupByTypeStatus(orgId, 'outbox'),
      groupByTypeStatus(orgId, 'inbox'),
    ]);

    // Specific call-out tiles per PHASES.md §4.3.
    const tiles = {
      poAwaitingAcknowledgement: issued
        .filter((r) => r.documentType === 'PO' && r.status === 'ISSUED')
        .reduce((acc, r) => acc + r.count, 0),
      ocsToReview: received
        .filter((r) => r.documentType === 'ORDER_CONFIRMATION' && r.status === 'ISSUED')
        .reduce((acc, r) => acc + r.count, 0),
      asnsInTransit: received
        .filter((r) => r.documentType === 'ASN' && r.status === 'IN_TRANSIT')
        .reduce((acc, r) => acc + r.count, 0),
      invoicesPendingReview: received
        .filter((r) => r.documentType === 'INVOICE' && r.status === 'ISSUED')
        .reduce((acc, r) => acc + r.count, 0),
      releasesAwaitingCommit: issued
        .filter(
          (r) =>
            (r.documentType === 'SA_RELEASE_FORECAST' || r.documentType === 'FORECAST_PUBLISH') &&
            r.status === 'ISSUED',
        )
        .reduce((acc, r) => acc + r.count, 0),
      activeSchedulingAgreements: issued
        .filter((r) => r.documentType === 'SCHEDULING_AGREEMENT' && r.status === 'ACTIVE')
        .reduce((acc, r) => acc + r.count, 0),
    };

    res.json({ tiles, issued, received });
  });

  r.get('/dashboards/supplier', async (_req, res) => {
    const ctx = mustAuth(res);
    if (!ctx) return;
    if (!ctx.activeMembership) {
      res.status(403).json({ error: 'no_active_membership' });
      return;
    }
    const orgId = ctx.activeMembership.orgId;
    const [issued, received] = await Promise.all([
      groupByTypeStatus(orgId, 'outbox'),
      groupByTypeStatus(orgId, 'inbox'),
    ]);
    const tiles = {
      posToAcknowledge: received
        .filter((r) => r.documentType === 'PO' && r.status === 'ISSUED')
        .reduce((acc, r) => acc + r.count, 0),
      forecastsToCommit: received
        .filter((r) => r.documentType === 'FORECAST_PUBLISH' && r.status === 'ISSUED')
        .reduce((acc, r) => acc + r.count, 0),
      jitReleasesToShip: received
        .filter((r) => r.documentType === 'SA_RELEASE_JIT' && r.status === 'ISSUED')
        .reduce((acc, r) => acc + r.count, 0),
      invoicesSubmitted: issued
        .filter((r) => r.documentType === 'INVOICE' && r.status === 'ISSUED')
        .reduce((acc, r) => acc + r.count, 0),
      invoicesAccepted: issued
        .filter((r) => r.documentType === 'INVOICE' && r.status === 'ACCEPTED_BY_BUYER')
        .reduce((acc, r) => acc + r.count, 0),
      remittancesReceived: received
        .filter((r) => r.documentType === 'REMITTANCE_ADVICE')
        .reduce((acc, r) => acc + r.count, 0),
    };
    res.json({ tiles, issued, received });
  });

  // ---------------------------------------------------------------------
  // Phase 4.4 — Network-relevant supplier scorecards
  //
  // Live-computed (no nightly snapshot at MVP — PHASES.md spec calls for a
  // snapshot table but live computation is correct and verifiable now;
  // promote to a snapshot job in Phase 5 if scan cost grows). Buyer-only.
  // For each ACTIVE counterparty supplier we report the four metrics from
  // PHASES.md §4.4 — all derived from the document corpus alone.
  // ---------------------------------------------------------------------
  r.get('/scorecards', async (_req, res) => {
    const ctx = mustAuth(res);
    if (!ctx) return;
    if (!ctx.activeMembership) {
      res.status(403).json({ error: 'no_active_membership' });
      return;
    }
    const buyerOrgId = ctx.activeMembership.orgId;
    const rels = await db.tradingRelationship.findMany({
      where: { buyerOrgId, status: 'ACTIVE' },
      include: { supplierOrg: true },
    });

    const scorecards = await Promise.all(
      rels.map(async (rel) => {
        // 1. Document-response SLA — average time-to-acknowledge a PO.
        //    For each issued PO, find the first OC (ORDER_CONFIRMATION) that
        //    ACKNOWLEDGES it and measure createdAt delta.
        const acks = await db.documentLink.findMany({
          where: {
            linkType: 'ACKNOWLEDGES',
            from: {
              documentType: 'ORDER_CONFIRMATION',
              issuerOrgId: rel.supplierOrgId,
              recipientOrgId: buyerOrgId,
            },
            to: { documentType: 'PO' },
          },
          include: {
            from: { select: { createdAt: true } },
            to: { select: { createdAt: true } },
          },
        });
        const ackTimesMs = acks.map((l) => l.from.createdAt.getTime() - l.to.createdAt.getTime());
        const avgAckMs =
          ackTimesMs.length > 0 ? ackTimesMs.reduce((a, b) => a + b, 0) / ackTimesMs.length : null;

        // 2. ASN accuracy — sum(shippedQuantity) on ASN bodies vs
        //    sum(receivedQuantity) on linked GR bodies. Returned as a
        //    ratio in [0, 1]; null if no GRs.
        const grLinks = await db.documentLink.findMany({
          where: {
            linkType: 'RECEIVES',
            from: {
              documentType: 'GOODS_RECEIPT',
              issuerOrgId: buyerOrgId,
            },
            to: {
              documentType: 'ASN',
              issuerOrgId: rel.supplierOrgId,
            },
          },
          include: {
            from: { include: { currentVersion: true } },
            to: { include: { currentVersion: true } },
          },
        });
        let shippedTotal = 0;
        let receivedTotal = 0;
        for (const l of grLinks) {
          const asnBody = (l.to.currentVersion?.body ?? {}) as {
            lines?: Array<{ shippedQuantity?: number }>;
          };
          const grBody = (l.from.currentVersion?.body ?? {}) as {
            lines?: Array<{ receivedQuantity?: number }>;
          };
          for (const ln of asnBody.lines ?? []) shippedTotal += Number(ln.shippedQuantity ?? 0);
          for (const ln of grBody.lines ?? []) receivedTotal += Number(ln.receivedQuantity ?? 0);
        }
        const asnAccuracy =
          shippedTotal > 0 ? 1 - Math.abs(shippedTotal - receivedTotal) / shippedTotal : null;

        // 3. Invoice match rate — accepted / (accepted + disputed).
        const invoiceCounts = await db.document.groupBy({
          by: ['status'],
          where: {
            documentType: 'INVOICE',
            issuerOrgId: rel.supplierOrgId,
            recipientOrgId: buyerOrgId,
          },
          _count: { _all: true },
        });
        const accepted =
          invoiceCounts.find((r) => r.status === 'ACCEPTED_BY_BUYER')?._count._all ?? 0;
        const disputed = invoiceCounts.find((r) => r.status === 'DISPUTED')?._count._all ?? 0;
        const invoiceMatchRate = accepted + disputed > 0 ? accepted / (accepted + disputed) : null;

        // 4. On-time delivery — GR.postedDate vs PO.requestedDeliveryDate
        //    via FULFILLS. Ratio in [0, 1]; null if no GRs.
        const fulfills = await db.documentLink.findMany({
          where: {
            linkType: 'FULFILLS',
            from: {
              documentType: 'GOODS_RECEIPT',
              issuerOrgId: buyerOrgId,
            },
            to: {
              documentType: 'PO',
              issuerOrgId: buyerOrgId,
              recipientOrgId: rel.supplierOrgId,
            },
          },
          include: {
            from: { include: { currentVersion: true } },
            to: { include: { currentVersion: true } },
          },
        });
        let onTimeCount = 0;
        let onTimeDen = 0;
        for (const l of fulfills) {
          const grBody = (l.from.currentVersion?.body ?? {}) as { postedDate?: string };
          const poBody = (l.to.currentVersion?.body ?? {}) as {
            requestedDeliveryDate?: string;
          };
          if (grBody.postedDate && poBody.requestedDeliveryDate) {
            onTimeDen += 1;
            if (grBody.postedDate <= poBody.requestedDeliveryDate) onTimeCount += 1;
          }
        }
        const onTimeDelivery = onTimeDen > 0 ? onTimeCount / onTimeDen : null;

        return {
          relationshipId: rel.id,
          supplierOrgId: rel.supplierOrgId,
          supplierLegalName: rel.supplierOrg.legalName,
          supplierDisplayName: rel.supplierOrg.displayName,
          metrics: {
            // Surfaced in hours for readability; null = no data yet.
            avgPoAckHours: avgAckMs === null ? null : Math.round((avgAckMs / 3_600_000) * 10) / 10,
            poAckSampleSize: ackTimesMs.length,
            asnAccuracy: asnAccuracy === null ? null : Math.round(asnAccuracy * 1000) / 1000,
            asnSampleSize: grLinks.length,
            invoiceMatchRate:
              invoiceMatchRate === null ? null : Math.round(invoiceMatchRate * 1000) / 1000,
            invoiceSampleSize: accepted + disputed,
            onTimeDelivery:
              onTimeDelivery === null ? null : Math.round(onTimeDelivery * 1000) / 1000,
            onTimeSampleSize: onTimeDen,
          },
        };
      }),
    );

    res.json({ scorecards, computedAt: new Date().toISOString() });
  });

  // ---------------------------------------------------------------------
  // Phase 4.5 — In-app notification centre
  //
  // The pg-boss + SMTP consumer is out of scope at MVP per the
  // simplification in PHASES.md ("we'll wire MailHog + SMTP" — adding the
  // queue worker would land in Phase 5). What we ship now:
  //
  //   GET  /notifications        list current user's notifications, newest first
  //   POST /notifications/:id/read  mark one notification delivered/read
  //   POST /notifications/read-all  mark all of current user's notifications read
  //
  // Documents that get auto-published already write rows to
  // `notification_outbox` via the document-core emitter — this surface
  // exposes them to the portal's nav-bar bell.
  // ---------------------------------------------------------------------
  r.get('/notifications', async (req, res) => {
    const ctx = mustAuth(res);
    if (!ctx) return;
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    const onlyPending = req.query.onlyPending === 'true';
    const notifications = await db.notificationOutbox.findMany({
      where: {
        recipientId: ctx.userId,
        ...(onlyPending ? { status: 'PENDING' } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    const unreadCount = await db.notificationOutbox.count({
      where: { recipientId: ctx.userId, status: 'PENDING' },
    });
    res.json({ notifications, unreadCount });
  });

  r.post('/notifications/:id/read', async (req, res) => {
    const ctx = mustAuth(res);
    if (!ctx) return;
    const id = req.params.id ?? '';
    const updated = await db.notificationOutbox.updateMany({
      where: { id, recipientId: ctx.userId, status: 'PENDING' },
      data: { status: 'DELIVERED', deliveredAt: new Date() },
    });
    if (updated.count === 0) {
      res.status(404).json({ error: 'not_found_or_already_read' });
      return;
    }
    res.json({ ok: true });
  });

  r.post('/notifications/read-all', async (_req, res) => {
    const ctx = mustAuth(res);
    if (!ctx) return;
    const updated = await db.notificationOutbox.updateMany({
      where: { recipientId: ctx.userId, status: 'PENDING' },
      data: { status: 'DELIVERED', deliveredAt: new Date() },
    });
    res.json({ ok: true, marked: updated.count });
  });

  // ---------------------------------------------------------------------
  // Phase 5.1 — Audit-log explorer
  //
  // Read-only surface over the append-only document_audit_log. Any
  // authenticated user gets rows for documents that touch their active
  // org (they are either issuer or recipient). NETWORK_ADMIN sees every
  // row across the network (cross-org visibility per PHASES.md §5.1).
  //
  // Filters: documentId, actorUserId, actorOrgId, action, since (ISO),
  // limit + offset for pagination.
  // ---------------------------------------------------------------------
  r.get('/audit-log', async (req, res) => {
    const ctx = mustAuth(res);
    if (!ctx) return;
    if (!ctx.activeMembership) {
      res.status(403).json({ error: 'no_active_membership' });
      return;
    }
    const orgId = ctx.activeMembership.orgId;
    const isNetworkAdmin = ctx.activeMembership.role === 'NETWORK_ADMIN';

    const documentId = (req.query.documentId as string | undefined) ?? undefined;
    const actorUserId = (req.query.actorUserId as string | undefined) ?? undefined;
    const actorOrgId = (req.query.actorOrgId as string | undefined) ?? undefined;
    const action = (req.query.action as string | undefined) ?? undefined;
    const since = (req.query.since as string | undefined) ?? undefined;
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
    const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);

    // Scope: unless network-admin, restrict to documents the active org
    // is a party to. We do this via a nested `document` where clause.
    const scope = isNetworkAdmin
      ? {}
      : {
          document: {
            OR: [{ issuerOrgId: orgId }, { recipientOrgId: orgId }],
          },
        };

    const where = {
      AND: [
        scope,
        ...(documentId ? [{ documentId }] : []),
        ...(actorUserId ? [{ actorUserId }] : []),
        ...(actorOrgId ? [{ actorOrgId }] : []),
        ...(action ? [{ action: action as AuditAction }] : []),
        ...(since ? [{ occurredAt: { gte: new Date(since) } }] : []),
      ],
    };

    const entries = await db.documentAuditLog.findMany({
      where,
      orderBy: { occurredAt: 'desc' },
      take: limit,
      skip: offset,
      include: {
        document: {
          select: {
            id: true,
            documentType: true,
            documentNumber: true,
            issuerOrgId: true,
            recipientOrgId: true,
          },
        },
      },
    });
    const total = await db.documentAuditLog.count({ where });

    res.json({ entries, total, limit, offset });
  });

  return r;
}
