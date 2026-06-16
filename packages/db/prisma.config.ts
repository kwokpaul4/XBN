// Prisma 7 configuration. The datasource URL moved out of schema.prisma
// and into this file for migrate / introspection commands. The runtime
// client gets its connection via a driver adapter at construction time
// (see packages/db/src/index.ts when wired in Stage C).

import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
});
