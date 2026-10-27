import type { Page } from '@playwright/test';
import { test, expect, open, apiAs, toast } from './support/fixtures';
import { expectAccessible } from './support/a11y';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';
import { serverState } from './support/state';

/*
 * 1.9.0, Sprint 55 (B-192 to B-195): Platform › Leaked passwords. A platform admin's list is seeded through the API
 * (created, a plain-text version uploaded and built by its job); the tab shows it with its active version, its
 * versions dialog, the tenant's checks and deny words (saved from the console) and the report. Accessibility in
 * Standard and Enhanced, light and dark; no sideways scrolling at 320 and 640 px.
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

test.describe('Platform › Leaked passwords', () => {
  const NAME = 'E2E common passwords';

  test.beforeAll(async () => {
    const root = await apiAs('root');
    try {
      const existing = (await root.get('/api/admin/leaked-passwords/lists?scope=platform')).lists.find((l: { name: string }) => l.name === NAME);
      const list = existing ?? (await root.post('/api/admin/leaked-passwords/lists', { scope: 'platform', name: NAME, hashKind: 'sha1', description: 'Seeded by the e2e suite' }));
      const session = await (await root.ctx.get('/api/auth/session')).json();
      const up = await root.ctx.put(`/api/admin/leaked-passwords/lists/${list.id}/upload?format=plain&note=seed`, { data: 'e2e-leaked-password-one\ne2e-leaked-password-two\n', headers: { 'content-type': 'text/plain', 'x-csrf-token': session.csrf, origin: serverState().url } });
      expect(up.status()).toBe(202);
      // The build job runs on the e2e server's workers.
      for (let i = 0; i < 100; i++) {
        const d = await root.get(`/api/admin/leaked-passwords/lists/${list.id}`);
        if (d.activeVersion) break;
        await new Promise((r) => setTimeout(r, 200));
      }
    } finally {
      await root.close();
    }
  });

  test('shows the lists, their versions, the tenant\'s checks and the report', async ({ page }) => {
    await open(page, 'platform?tab=leaked');
    const main = page.locator('#main');
    await expect(main.getByText(NAME)).toBeVisible();
    await expect(main.locator('[aria-label="Leaked-password lists"]')).toContainText(/v\d+ of \d+/);
    await accessible(page, 'Platform › Leaked passwords (platform lists)');
    await reflow(page, 'Platform › Leaked passwords (platform lists)');

    // The versions dialog.
    await main.locator('tr', { hasText: NAME }).getByRole('button', { name: 'Versions' }).click();
    const dialog = page.locator('#overlay .modal').filter({ hasText: `Versions of ${NAME}` });
    await expect(dialog.getByText('active')).toBeVisible();
    await accessible(page, 'Leaked passwords: versions dialog');
    await dialog.getByRole('button', { name: 'Close' }).click();

    // The add dialog.
    await main.getByRole('button', { name: 'Add a list' }).click();
    await expect(page.locator('#overlay .modal').filter({ hasText: 'Add a platform list' })).toBeVisible();
    await accessible(page, 'Leaked passwords: add dialog');
    await page.locator('#overlay .modal').getByRole('button', { name: 'Cancel' }).click();

    // This tenant: the checks, deny words and the report.
    await main.getByRole('button', { name: 'This tenant' }).click();
    await expect(main.getByText('Checks for this tenant')).toBeVisible();
    await expect(main.getByText('Accounts found at sign-in')).toBeVisible();
    await main.locator('[data-ls-action]').selectOption('warn');
    await main.locator('[data-ls-words]').fill('Exampleco\nSpringfield');
    await main.locator('[data-ls-save]').click();
    await toast(page, /passwords\.settings\.updated/);
    await expect(main.locator('[data-ls-words]')).toHaveValue('Exampleco\nSpringfield');
    await expect(main.locator('[data-ls-action]')).toHaveValue('warn');
    await accessible(page, 'Platform › Leaked passwords (this tenant)');
    await reflow(page, 'Platform › Leaked passwords (this tenant)');

    // Put the tenant back as it was for other specs.
    const root = await apiAs('root');
    try {
      await root.put('/api/admin/leaked-passwords/settings', { signinAction: 'require_change', denyWords: [] });
    } finally {
      await root.close();
    }
  });
});
