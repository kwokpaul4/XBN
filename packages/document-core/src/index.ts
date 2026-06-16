// Reusable document substrate (PHASES.md §1.5).
//
// Stage A complete: full Prisma schema in @xbn/db.
// Stage B complete: pure-TS primitives (state machine, link registry,
//                   body-schema registry, in-memory + external numbering).
// Stage C complete: DB-backed substrate (repository, guard, 5 universal
//                   operations, atomic numbering).
// Stage D complete: notification emitter + S3/MinIO attachment storage.
// TASK #5 COMPLETE — substrate is ready for Phase 2/3 to consume.

export * from './state-machine.js';
export * from './link-registry.js';
export * from './body-schema-registry.js';
export * from './numbering.js';
export * from './numbering-prisma.js';
export * from './trading-relationship-guard.js';
export * from './document-repository.js';
export * from './operations.js';
export * from './notification-emitter.js';
export * from './attachment-storage.js';
