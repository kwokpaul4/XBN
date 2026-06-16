// Reusable document substrate (PHASES.md §1.5).
//
// Stage A complete: full Prisma schema in @xbn/db.
// Stage B complete: pure-TS primitives (state machine, link registry,
//                   body-schema registry, in-memory + external numbering).
// Stage C (in progress): DB-backed primitives.
//   - PrismaNetworkNumberingStrategy (advisory-lock atomic numbering)
//   - TradingRelationshipGuard
//   - DocumentRepository (next commit)
//   - publish/acknowledge/supersede/cancel/link operations (next commit)
//   - integration tests via testcontainers (next commit)
// Stage D: notification emitter (pg-boss) and S3/MinIO attachment abstraction.

export * from './state-machine.js';
export * from './link-registry.js';
export * from './body-schema-registry.js';
export * from './numbering.js';
export * from './numbering-prisma.js';
export * from './trading-relationship-guard.js';
