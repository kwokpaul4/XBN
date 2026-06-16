/**
 * Prisma client adapter (PHASES.md §1.5).
 *
 * `document-core` is library code — it does NOT own a connection. Callers
 * (the API service, integration tests) construct a PrismaClient and pass it
 * in. This keeps the library free of singleton state and lets each test
 * use a fresh in-memory or testcontainer-backed database.
 *
 * The exported type is the structural surface document-core needs from any
 * Prisma client. Using PrismaClient directly works; passing a transaction
 * client (Prisma.TransactionClient) also works because both expose the same
 * model accessors.
 */

import type { PrismaClient } from '@xbn/db';

/**
 * Either the full PrismaClient or a transaction handle. Document-core
 * accepts either; callers pass the transaction handle when wrapping
 * multi-step operations in a single $transaction.
 */
export type Db = PrismaClient | Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];
