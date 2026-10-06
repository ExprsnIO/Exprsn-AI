import { defineConfig } from 'vitest/config';

// Runs the contract tests against real OpenLDAP, PostgreSQL, MySQL and Redis
// (see deploy/docker/compose.dev.yml and .github/workflows/ci.yml).
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    // The files share one database per engine and each runs the migrations: one file at a time.
    fileParallelism: false,
    testTimeout: 30000,
    // A file's beforeAll may roll the schema back and run every migration (stores.test.ts): on a CI runner that took
    // over the 10 s default and left the migration lock held for the files after it.
    hookTimeout: 120000
  }
});
