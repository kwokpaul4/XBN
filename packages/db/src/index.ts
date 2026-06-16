// Re-export the generated Prisma client. Other packages import from here:
//
//   import { PrismaClient, Prisma } from '@xbn/db';
//   const db = new PrismaClient();
//   const tx: Prisma.TransactionClient = ...
//
// The actual connection (datasource URL, driver adapter) is created at app
// boot, not here — keeps this package free of runtime side effects.
//
// Type re-exports (PrismaClient, Prisma namespace, all model types) flow
// transparently because TypeScript follows export-* through to the generated
// .d.ts. Runtime exports (the PrismaClient constructor) work the same way
// from index.js. Both files live next to each other under .prisma/client.

export * from '../node_modules/.prisma/client/index.js';
