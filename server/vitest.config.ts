import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**'],
    environment: 'node',
    pool: 'forks',
    // A worker per core starves a workstation that also runs the model server and other test runs: on 2026-10-13
    // twelve workers took the load average past 200 and every suite into its timeouts. CI keeps the default.
    ...(process.env.CI ? {} : { maxWorkers: Number(process.env.VITEST_MAX_WORKERS) || 4 }),
    testTimeout: 20000,
    setupFiles: ['test/setup-offline.ts', 'test/setup-loopback.ts', 'test/setup-events.ts']
  }
});
