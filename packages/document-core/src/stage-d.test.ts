/**
 * Stage D integration tests: notification emitter and attachment storage.
 *
 * Run against the docker-compose stack (Postgres + MinIO).
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { AttachmentStorage } from './attachment-storage.js';
import { NotificationEmitter } from './notification-emitter.js';
import { disposeTestDb, getTestDb, seedTradingRelationship, truncateAll } from './test-helpers.js';

const db = getTestDb();

const storage = new AttachmentStorage(db, {
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  region: process.env.S3_REGION ?? 'us-east-1',
  accessKey: process.env.S3_ACCESS_KEY ?? 'xbn',
  secretKey: process.env.S3_SECRET_KEY ?? 'xbn_dev_minio',
  bucket: process.env.S3_BUCKET ?? 'xbn-attachments',
  forcePathStyle: true,
});

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await disposeTestDb();
});

// Helper to put a minimal document on the table that attachments can FK to.
async function createBareDocument(): Promise<{
  documentId: string;
  versionId: string;
  uploadedById: string;
}> {
  const seed = await seedTradingRelationship(db);
  const doc = await db.document.create({
    data: {
      documentType: 'GENERIC_DOCUMENT',
      documentNumber: 'GD-000001',
      issuerOrgId: seed.buyerOrgId,
      recipientOrgId: seed.supplierOrgId,
      tradingRelationshipId: seed.relationshipId,
      status: 'PUBLISHED',
    },
  });
  const version = await db.documentVersion.create({
    data: {
      documentId: doc.id,
      versionNumber: 1,
      body: { note: 'fixture' },
      createdById: seed.buyerUserId,
    },
  });
  await db.document.update({
    where: { id: doc.id },
    data: { currentVersionId: version.id },
  });
  return { documentId: doc.id, versionId: version.id, uploadedById: seed.buyerUserId };
}

// ---------------------------------------------------------------------------
// Notification emitter
// ---------------------------------------------------------------------------

describe('NotificationEmitter', () => {
  it('emits one outbox row per recipient', async () => {
    const seed = await seedTradingRelationship(db);
    const doc = await db.document.create({
      data: {
        documentType: 'PO',
        documentNumber: 'PO-000001',
        issuerOrgId: seed.buyerOrgId,
        recipientOrgId: seed.supplierOrgId,
        tradingRelationshipId: seed.relationshipId,
        status: 'ISSUED',
      },
    });
    const emitter = new NotificationEmitter(db);
    const result = await emitter.emit({
      eventType: 'DOCUMENT_PUBLISHED',
      documentId: doc.id,
      recipientUserIds: [seed.supplierUserId],
      payload: { documentNumber: 'PO-000001' },
    });
    expect(result.rowsCreated).toBe(1);

    const rows = await db.notificationOutbox.findMany({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe('DOCUMENT_PUBLISHED');
    expect(rows[0]?.recipientId).toBe(seed.supplierUserId);
    expect(rows[0]?.status).toBe('PENDING');
  });

  it('returns zero when recipient list is empty (no rows written)', async () => {
    const seed = await seedTradingRelationship(db);
    const doc = await db.document.create({
      data: {
        documentType: 'PO',
        documentNumber: 'PO-000001',
        issuerOrgId: seed.buyerOrgId,
        recipientOrgId: seed.supplierOrgId,
        tradingRelationshipId: seed.relationshipId,
        status: 'ISSUED',
      },
    });
    const emitter = new NotificationEmitter(db);
    const result = await emitter.emit({
      eventType: 'DOCUMENT_PUBLISHED',
      documentId: doc.id,
      recipientUserIds: [],
    });
    expect(result.rowsCreated).toBe(0);
    expect(await db.notificationOutbox.count()).toBe(0);
  });

  it('accumulates multiple emits — duplicates are intentional, dedup is consumer-side', async () => {
    const seed = await seedTradingRelationship(db);
    const doc = await db.document.create({
      data: {
        documentType: 'PO',
        documentNumber: 'PO-000001',
        issuerOrgId: seed.buyerOrgId,
        recipientOrgId: seed.supplierOrgId,
        tradingRelationshipId: seed.relationshipId,
        status: 'ISSUED',
      },
    });
    const emitter = new NotificationEmitter(db);
    await emitter.emit({
      eventType: 'DOCUMENT_PUBLISHED',
      documentId: doc.id,
      recipientUserIds: [seed.supplierUserId],
    });
    await emitter.emit({
      eventType: 'DOCUMENT_PUBLISHED',
      documentId: doc.id,
      recipientUserIds: [seed.supplierUserId],
    });
    expect(await db.notificationOutbox.count()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Attachment storage (against MinIO)
// ---------------------------------------------------------------------------

describe('AttachmentStorage', () => {
  it('puts bytes, computes SHA-256, records the row, retrieves verbatim', async () => {
    const { documentId, versionId, uploadedById } = await createBareDocument();
    const bytes = new TextEncoder().encode('Hello, XBN attachments.');

    const desc = await storage.put({
      documentId,
      versionId,
      bytes,
      filename: 'hello.txt',
      mimeType: 'text/plain',
      uploadedById,
    });

    expect(desc.sizeBytes).toBe(bytes.length);
    expect(desc.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(desc.storageKey).toContain(`docs/${documentId}/`);

    // Round-trip the bytes back.
    const got = await storage.get(desc.id);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.mimeType).toBe('text/plain');
    expect(got.filename).toBe('hello.txt');
    expect(new TextDecoder().decode(got.bytes)).toBe('Hello, XBN attachments.');
  });

  it('reports attachment_not_found when the row is missing', async () => {
    const result = await storage.get('att_does_not_exist');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.kind).toBe('attachment_not_found');
  });

  it('detects sha256_mismatch when storage bytes diverge from recorded hash', async () => {
    const { documentId, versionId, uploadedById } = await createBareDocument();
    const bytes = new TextEncoder().encode('original');
    const desc = await storage.put({
      documentId,
      versionId,
      bytes,
      filename: 'doc.txt',
      mimeType: 'text/plain',
      uploadedById,
    });

    // Tamper the recorded hash so what's in the DB no longer matches the bytes
    // we'll fetch back — simulating bit-rot or a malicious storage swap.
    await db.attachment.update({
      where: { id: desc.id },
      data: { sha256: 'deadbeef'.repeat(8) },
    });

    const result = await storage.get(desc.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.kind).toBe('sha256_mismatch');
  });

  it('presignGet returns a URL or null when the attachment is missing', async () => {
    const { documentId, versionId, uploadedById } = await createBareDocument();
    const bytes = new TextEncoder().encode('payload');
    const desc = await storage.put({
      documentId,
      versionId,
      bytes,
      filename: 'doc.bin',
      mimeType: 'application/octet-stream',
      uploadedById,
    });

    const url = await storage.presignGet(desc.id, 60);
    expect(url).toBeTypeOf('string');
    expect(url).toContain(desc.storageKey.split('/').pop() ?? '');

    const missing = await storage.presignGet('att_missing');
    expect(missing).toBeNull();
  });

  it('delete() removes both the row and the S3 object', async () => {
    const { documentId, versionId, uploadedById } = await createBareDocument();
    const bytes = new TextEncoder().encode('temp');
    const desc = await storage.put({
      documentId,
      versionId,
      bytes,
      filename: 'temp.txt',
      mimeType: 'text/plain',
      uploadedById,
    });

    const result = await storage.delete(desc.id);
    expect(result.deleted).toBe(true);

    expect(await db.attachment.count()).toBe(0);

    const after = await storage.get(desc.id);
    expect(after.ok).toBe(false);
    if (after.ok) return;
    expect(after.reason.kind).toBe('attachment_not_found');
  });
});
