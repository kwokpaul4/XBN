import { Router } from 'express';
import { z } from 'zod';
import { addMembership } from '@xbn/auth';
import type { OrgType, PrismaClient } from '@xbn/db';
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

  return r;
}
