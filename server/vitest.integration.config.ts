import { defineConfig } from 'vitest/config';

// Runs the contract tests against real OpenLDAP, PostgreSQL, MySQL and Redis
// (see deploy/docker/compose.dev.yml and .github/workflows/ci.yml).
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 30000
  }
});
