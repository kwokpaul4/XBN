/**
 * Express app builder. Pure function over a PrismaClient — used by main.ts
 * for the live server and by the M1 acceptance test via supertest.
 */

import cookieParser from 'cookie-parser';
import express, { type Application, type Request, type Response } from 'express';
import type { PrismaClient } from '@xbn/db';

import { logger, requestLogger } from './logger.js';
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
  app.use(requestLogger);
  app.use(express.json({ limit: '20mb' }));
  app.use(cookieParser());

  const storage = options.storage ?? {
    endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
    region: process.env.S3_REGION ?? 'us-east-1',
    accessKey: process.env.S3_ACCESS_KEY ?? 'xbn',
    secretKey: process.env.S3_SECRET_KEY ?? 'xbn_dev_minio',
    bucket: process.env.S3_BUCKET ?? 'xbn-attachments',
  };

  // PHASES.md §5.1 — health probes.
  //   /health  liveness (process alive)
  //   /ready   readiness (Postgres reachable)
  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'xbn-api' });
  });

  app.get('/ready', async (_req: Request, res: Response) => {
    try {
      await db.$queryRawUnsafe('SELECT 1');
      res.json({ ok: true, db: 'up' });
    } catch (err) {
      logger.error({ err }, 'ready.db_unreachable');
      res.status(503).json({ ok: false, db: 'unreachable' });
    }
  });

  app.use('/auth', authRouter(db));
  app.use('/me', meRouter(db));
  app.use('/network', networkRouter(db));
  app.use('/', documentsRouter(db, storage));

  return app;
}
