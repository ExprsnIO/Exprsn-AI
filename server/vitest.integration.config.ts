import { defineConfig } from 'vitest/config';

// Runs the identity-provider contract tests against real OpenLDAP, PostgreSQL and MySQL
// (see deploy/docker/compose.dev.yml and .github/workflows/ci.yml).
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 30000
  }
});
