import { defineConfig, devices } from '@playwright/test';

// In cloud sessions the browser is preinstalled: CHROME=/opt/pw-browsers/chromium (never run `playwright install`).
const executablePath = process.env.CHROME || undefined;

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  // One server, shared state (the audit chain, zones, quotas): tests run one after another in a single worker.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }], ['github']] : [['list'], ['html', { open: 'never' }]],
  use: {
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 10_000,
    launchOptions: { executablePath }
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, launchOptions: { executablePath } } },
    { name: 'console', testMatch: /.*\.spec\.ts/, dependencies: ['setup'], use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, launchOptions: { executablePath } } }
  ]
});
