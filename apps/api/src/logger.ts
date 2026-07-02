/**
 * Structured logging with request correlation (PHASES.md §5.1).
 *
 * `logger` is a module-level pino instance so any module can import it
 * without threading it through constructors. The Express `requestLogger`
 * middleware assigns a per-request UUID, hangs a child logger off
 * `res.locals`, and logs the start + finish of every request. Downstream
 * code accesses it via `getLogger(res)` — which falls back to the module
 * logger when called without a Response (e.g. from a background job).
 *
 * We deliberately do NOT reach for OpenTelemetry at MVP. Correlated
 * structured logs cover ~90% of what a small production audit needs, and
 * OTel is a heavy dependency chain to introduce alongside the substrate.
 * Promoting to OTel later is straightforward: wrap `logger.child({...})`
 * in a span-attach helper.
 */

import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { pino, type Logger } from 'pino';

// Level from env; 'info' in production, 'debug' in dev, 'silent' in tests
// (so vitest output stays quiet). Any consumer can override via LOG_LEVEL.
const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST;
const defaultLevel = isTest ? 'silent' : process.env.NODE_ENV === 'production' ? 'info' : 'debug';

export const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? defaultLevel,
  base: { service: 'xbn-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

const LOCAL_LOGGER_KEY = 'xbnLogger';
const LOCAL_REQUEST_ID_KEY = 'xbnRequestId';

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const requestId = (req.header('x-request-id') ?? '').trim() || randomUUID();
  const child = logger.child({ requestId, method: req.method, path: req.path });
  (res.locals as Record<string, unknown>)[LOCAL_LOGGER_KEY] = child;
  (res.locals as Record<string, unknown>)[LOCAL_REQUEST_ID_KEY] = requestId;
  res.setHeader('x-request-id', requestId);

  const startedAt = Date.now();
  child.info({ msg: 'request.start' });

  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    child.info({
      msg: 'request.finish',
      status: res.statusCode,
      durationMs,
    });
  });

  next();
}

export function getLogger(res?: Response): Logger {
  if (!res) return logger;
  const locals = res.locals as Record<string, unknown>;
  const attached = locals[LOCAL_LOGGER_KEY] as Logger | undefined;
  return attached ?? logger;
}

export function getRequestId(res?: Response): string | null {
  if (!res) return null;
  const locals = res.locals as Record<string, unknown>;
  return (locals[LOCAL_REQUEST_ID_KEY] as string | undefined) ?? null;
}
