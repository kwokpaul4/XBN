/**
 * Express app builder. Pure function over a PrismaClient — used by main.ts
 * for the live server and by the M1 acceptance test via supertest.
 */

import cookieParser from 'cookie-parser';
import express, { type Application } from 'express';
import type { PrismaClient } from '@xbn/db';

import { authRouter } from './routes/auth.js';
import { documentsRouter } from './routes/documents.js';
import { meRouter } from './routes/me.js';
import { networkRouter } from './routes/network.js';

export interface BuildAppOptions {
  readonly storage?: {
    readonly endpoint: string;
    readonly region: string;
    readonly accessKey: string;
    readonly secretKey: string;
    readonly bucket: string;
  };
}

export function buildApp(db: PrismaClient, options: BuildAppOptions = {}): Application {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use(cookieParser());

  const storage = options.storage ?? {
    endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
    region: process.env.S3_REGION ?? 'us-east-1',
    accessKey: process.env.S3_ACCESS_KEY ?? 'xbn',
    secretKey: process.env.S3_SECRET_KEY ?? 'xbn_dev_minio',
    bucket: process.env.S3_BUCKET ?? 'xbn-attachments',
  };

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/auth', authRouter(db));
  app.use('/me', meRouter(db));
  app.use('/network', networkRouter(db));
  app.use('/', documentsRouter(db, storage));

  return app;
}
