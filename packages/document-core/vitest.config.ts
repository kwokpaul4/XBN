import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests share a Postgres instance and truncate tables between
    // tests. Run serially in a single fork so multiple test files don't race
    // on the database.
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    // Hook order: top-level beforeEach truncates the DB; each suite that needs
    // the connection imports getTestDb() and disposes in afterAll.
    fileParallelism: false,
    // Integration tests can be slower than unit tests (Postgres round-trips).
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // Distinguish unit vs integration in CI logs.
    reporters: ['default'],
  },
});
