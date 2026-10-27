import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { test, expect, open, expectLive, toast, apiAs } from './support/fixtures';
import { expectAccessible } from './support/a11y';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';
import { serverState } from './support/state';

/*
 * 1.9.0, Sprint 49 (B-151, B-152, B-154): Platform › Push providers. A platform admin adds an HTTP vendor provider
 * (a fake vendor this spec serves on loopback, which SERVICE_ALLOWED_HOSTS admits), checks it without sending, sends
 * a test to their own device, and reads the attempt in the delivery log. Accessibility in Standard and Enhanced, light
 * and dark; no sideways scrolling at 320 and 640 px.
 */

type AppGlobal = { App: { setA11y(m: 'aa' | 'aaa' | null): void } };

async function accessible(page: Page, where: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await expectAccessible(page, `${where} (${scheme})`);
    for (const mode of ['aa', 'aaa'] as const) {
      await page.evaluate((m) => (window as unknown as AppGlobal).App.setA11y(m), mode);
      await expectAxeClean(page, mode, `${where} (${scheme}, ${mode})`);
    }
    await page.evaluate(() => (window as unknown as AppGlobal).App.setA11y(null));
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}

async function reflow(page: Page, where: string): Promise<void> {
  for (const width of [320, 640]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(300);
    expect.soft(await reflowProblems(page), `${where} at ${width} px`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(150);
}

async function stepUpIfAsked(page: Page): Promise<void> {
  const modal = page.locator('#overlay .modal').filter({ hasText: 'Confirm it is you' });
  const asked = await modal.waitFor({ timeout: 2500 }).then(() => true).catch(() => false);
  if (!asked) return;
  await modal.locator('[data-supw]').fill(serverState().password);
  await modal.locator('[data-sugo]').click();
}

test.describe('Platform › Push providers', () => {
  let vendor: Server;
  let url = '';
  const got: { body: string }[] = [];

  test.beforeAll(async () => {
    vendor = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        got.push({ body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => vendor.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(vendor.address() as AddressInfo).port}/send`;
    const root = await apiAs('root');
    try {
      await root.post('/api/me/devices', { platform: 'android', provider: 'http', token: 'e2e-push-phone-token', name: 'E2E phone' });
    } finally {
      await root.close();
    }
  });
  test.afterAll(async () => {
    await new Promise<void>((r) => vendor.close(() => r()));
  });

  test('adds a provider, checks it, sends a test and shows it in the log', async ({ page, watch }) => {
    watch.allow.push(/ -> 401$/); // step-up, when the session is older than the window
    await open(page, 'platform?tab=push');
    await expectLive(page);
    await expect(page.locator('#main')).toContainText('No push providers');
    await accessible(page, 'Platform › Push providers (empty)');

    await page.locator('[data-padd]').click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-kind]').selectOption('http');
    await modal.locator('[data-name]').fill('E2E vendor');
    await modal.locator('[data-f="url"]').fill(url);
    await modal.locator('[data-psave]').click();
    await stepUpIfAsked(page);
    await toast(page, 'Provider added');
    const row = page.locator('#main tr', { hasText: 'E2E vendor' }).first();
    await expect(row).toContainText('HTTP vendor');
    await expect(row).toContainText('not checked');

    await row.locator('[data-pcheck]').click();
    await toast(page, 'Credentials work');
    await expect(page.locator('#main tr', { hasText: 'E2E vendor' }).first()).toContainText('credentials ok');

    await page.locator('#main tr', { hasText: 'E2E vendor' }).first().locator('[data-ptest]').click();
    const tm = page.locator('#overlay .modal');
    await expect(tm).toContainText('Send a test through E2E vendor');
    await tm.locator('[data-tdev]').selectOption({ label: 'E2E phone' });
    await tm.locator('[data-tgo]').click();
    await expect(tm.locator('[data-tres]')).toContainText('sent');
    expect(got.some((g) => g.body.includes('e2e-push-phone-token'))).toBe(true);
    await accessible(page, 'Platform › Push providers, test dialog');
    await tm.locator('[data-close]').first().click();

    const log = page.locator('#main section', { hasText: 'Delivery log' });
    await expect(log).toContainText('sent');
    await expect(log).toContainText('test');
    await expect(log).not.toContainText('e2e-push-phone-token');
    await page.locator('[data-lf="outcome"]').selectOption('failed');
    await expect(page.locator('#main section', { hasText: 'Delivery log' })).toContainText('No deliveries yet');
    await page.locator('[data-lf="outcome"]').selectOption('');
    await accessible(page, 'Platform › Push providers');
    await reflow(page, 'Platform › Push providers');
  });
});
