// Re-export the generated Prisma client. Other packages import from here:
//
//   import { PrismaClient, Prisma } from '@xbn/db';
//
// The actual connection (driver adapter setup) is created at app boot,
// not here — keeps this package free of runtime side effects.

export * from '../node_modules/.prisma/client/index.js';
export { PrismaClient } from '../node_modules/.prisma/client/index.js';
