/**
 * Prisma client construction. Single place where the connection URL +
 * driver adapter are wired up.
 */

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@xbn/db';

export function buildPrisma(databaseUrl?: string): PrismaClient {
  const url =
    databaseUrl ?? process.env.DATABASE_URL ?? 'postgresql://xbn:xbn_dev@localhost:5432/xbn';
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
    log: ['warn', 'error'],
  });
}
