// Reusable document substrate (PHASES.md §1.5).
//
// Stage A complete: full Prisma schema in @xbn/db.
// Stage B (this commit): pure-TS primitives.
// Stage C: DB-backed primitives (repository, guard, publish/ack/supersede/cancel/link).
// Stage D: notification emitter (pg-boss) and S3/MinIO attachment abstraction.

export * from './state-machine.js';
export * from './link-registry.js';
export * from './body-schema-registry.js';
export * from './numbering.js';
