/**
 * XBN API entry point.
 */

import { buildApp } from './app.js';
import { buildPrisma } from './db.js';

const PORT = Number(process.env.API_PORT ?? 3000);

async function main(): Promise<void> {
  const db = buildPrisma();
  const app = buildApp(db);
  app.listen(PORT, () => {
    console.log(`XBN API listening on :${PORT}`);
  });
}

main().catch((err: unknown) => {
  console.error('Fatal:', err);
  process.exit(1);
});
