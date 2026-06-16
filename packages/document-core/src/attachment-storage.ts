/**
 * Attachment storage abstraction (PHASES.md §1.5).
 *
 * S3-compatible put/get/presign/delete over MinIO locally and (real S3 or
 * any S3-compatible store) in deployed envs. SHA-256 is computed at put
 * time and verified at get time — caller can detect tampered/corrupted
 * objects without trusting the storage layer.
 *
 * The Attachment row in Postgres is the system of record (FK to Document,
 * FK to Version, hash, mime, size, who uploaded). The S3 object is the
 * blob. Stage D wires put + the attachment row in one logical operation;
 * if the S3 put succeeds but the DB insert fails, the orphan blob is
 * cleaned up by a separate sweeper (out of MVP scope — TODO Phase 5).
 */

import { createHash } from 'node:crypto';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Prisma, PrismaClient } from '@xbn/db';

type Db = PrismaClient | Prisma.TransactionClient;

export interface AttachmentStorageConfig {
  readonly endpoint: string; // 'http://localhost:9000' for MinIO
  readonly region: string; // 'us-east-1' (MinIO ignores it but SDK requires)
  readonly accessKey: string;
  readonly secretKey: string;
  readonly bucket: string; // 'xbn-attachments'
  /** path-style addressing — MinIO requires it; real S3 supports both. */
  readonly forcePathStyle?: boolean;
}

export interface PutAttachmentInput {
  readonly documentId: string;
  readonly versionId?: string;
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly mimeType: string;
  readonly uploadedById: string;
}

export interface AttachmentDescriptor {
  readonly id: string;
  readonly storageKey: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export type GetAttachmentResult =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      readonly mimeType: string;
      readonly filename: string;
    }
  | { readonly ok: false; readonly reason: AttachmentRejection };

export type AttachmentRejection =
  | { readonly kind: 'attachment_not_found'; readonly attachmentId: string }
  | { readonly kind: 'sha256_mismatch'; readonly expected: string; readonly actual: string }
  | { readonly kind: 'storage_error'; readonly detail: string };

/**
 * Build an S3 client from config. Cheap — keep one per process.
 */
function buildClient(config: AttachmentStorageConfig): S3Client {
  const opts: S3ClientConfig = {
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
    forcePathStyle: config.forcePathStyle ?? true,
  };
  return new S3Client(opts);
}

/**
 * Stable SHA-256 hex digest of bytes.
 */
function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Storage-key strategy: docs/<documentId>/<sha256>-<filename>. Keying by
 * sha makes natural dedup possible later (two uploads of the same bytes
 * collide on key); keeping the filename suffix preserves readability in
 * the MinIO console.
 */
function buildStorageKey(documentId: string, sha256: string, filename: string): string {
  // Sanitise filename — strip path separators and trim length.
  const safe = filename.replace(/[/\\]/g, '_').slice(0, 120);
  return `docs/${documentId}/${sha256}-${safe}`;
}

export class AttachmentStorage {
  private readonly client: S3Client;

  constructor(
    private readonly db: Db,
    private readonly config: AttachmentStorageConfig,
  ) {
    this.client = buildClient(config);
  }

  /**
   * Put bytes to S3 and record the Attachment row. Returns the descriptor
   * the caller can hand back to a UI / API.
   */
  async put(input: PutAttachmentInput): Promise<AttachmentDescriptor> {
    const sha256 = sha256Hex(input.bytes);
    const storageKey = buildStorageKey(input.documentId, sha256, input.filename);

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: storageKey,
        Body: input.bytes,
        ContentType: input.mimeType,
        Metadata: {
          'document-id': input.documentId,
          ...(input.versionId !== undefined && { 'version-id': input.versionId }),
          sha256: sha256,
        },
      }),
    );

    const row = await this.db.attachment.create({
      data: {
        documentId: input.documentId,
        ...(input.versionId !== undefined && { versionId: input.versionId }),
        storageKey,
        filename: input.filename,
        mimeType: input.mimeType,
        sizeBytes: BigInt(input.bytes.length),
        sha256,
        uploadedById: input.uploadedById,
      },
    });

    return {
      id: row.id,
      storageKey,
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.bytes.length,
      sha256,
    };
  }

  /**
   * Fetch bytes by Attachment id. Verifies SHA-256 before returning;
   * mismatch surfaces as a typed rejection.
   */
  async get(attachmentId: string): Promise<GetAttachmentResult> {
    const row = await this.db.attachment.findUnique({ where: { id: attachmentId } });
    if (!row) {
      return { ok: false, reason: { kind: 'attachment_not_found', attachmentId } };
    }

    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: row.storageKey }),
      );
      const bytes = await streamToBytes(response.Body as NodeJS.ReadableStream | undefined);
      const actualSha = sha256Hex(bytes);
      if (actualSha !== row.sha256) {
        return {
          ok: false,
          reason: { kind: 'sha256_mismatch', expected: row.sha256, actual: actualSha },
        };
      }
      return { ok: true, bytes, mimeType: row.mimeType, filename: row.filename };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: { kind: 'storage_error', detail } };
    }
  }

  /**
   * Generate a time-limited presigned GET URL. Used by the portal when the
   * browser fetches the bytes directly rather than tunnelling through the API.
   */
  async presignGet(attachmentId: string, expiresInSeconds = 300): Promise<string | null> {
    const row = await this.db.attachment.findUnique({ where: { id: attachmentId } });
    if (!row) return null;
    const command = new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: row.storageKey,
    });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }

  /**
   * Hard delete (S3 object + DB row). Used by sweepers and admin tools;
   * normal document lifecycle does NOT delete attachments — Document soft
   * cancel keeps history.
   */
  async delete(attachmentId: string): Promise<{ deleted: boolean }> {
    const row = await this.db.attachment.findUnique({ where: { id: attachmentId } });
    if (!row) return { deleted: false };

    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: row.storageKey }),
    );
    await this.db.attachment.delete({ where: { id: attachmentId } });
    return { deleted: true };
  }
}

/**
 * Collect a Node Readable into a single Uint8Array. Small attachments only;
 * Phase 5 may revisit if we start serving large files.
 */
async function streamToBytes(stream: NodeJS.ReadableStream | undefined): Promise<Uint8Array> {
  if (!stream) return new Uint8Array(0);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return new Uint8Array(Buffer.concat(chunks));
}
