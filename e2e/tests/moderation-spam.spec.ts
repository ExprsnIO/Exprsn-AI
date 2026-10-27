import type { Page } from '@playwright/test';
import { test, expect, open, expectLive, toast, apiAs, confirmDialog } from './support/fixtures';
import { expectAccessible } from './support/a11y';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';

/*
 * 1.9.0, Sprint 50 (B-158 to B-161): Moderation › Spam and flood. The admin turns the checks on (every surface in
 * shadow), a member posts fast enough to be scored, and the flagged account shows with its reasons and no response;
 * the admin edits a surface's thresholds from the screen; the 30-day metrics show with the CSV export. Accessibility
 * in Standard and Enhanced, light and dark; no sideways scrolling at 320 and 640 px. The checks are turned off again
 * at the end, so other suites post as before.
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

test.describe('Moderation › Spam and flood', () => {
  test.afterAll(async () => {
    const root = await apiAs('root');
    try {
      await root.put('/api/moderation/spam/policy', { enabled: false, surfaces: { post: { account: 20 } } });
    } finally {
      await root.close();
    }
  });

  test('turns the checks on in shadow, shows a scored account and edits a surface', async ({ page }) => {
    test.setTimeout(120_000);
    const root = await apiAs('root');
    const member = await apiAs('mladmin');
    try {
      await root.put('/api/moderation/spam/policy', { enabled: true, surfaces: { post: { account: 1, windowSeconds: 600 } } });
      const me = await member.get('/api/me');
      const ws = me.workspace ?? me.workspaces?.[0]?.id;
      for (let i = 0; i < 3; i++) await member.post('/api/feed/posts', { workspaceId: ws, body: `E2E spam check post ${i} about the bake sale` });
    } finally {
      await member.close();
      await root.close();
    }

    await open(page, 'moderation?tab=spam');
    await expectLive(page);
    const main = page.locator('#main');
    await expect(main).toContainText('The checks are on.');
    await expect(main).toContainText('Policy per surface');
    await expect(main.locator('tr', { hasText: 'Posts' }).first()).toContainText('Shadow (score only)');
    await expect(main.locator('tr', { hasText: 'rate.post.account' }).first()).toBeVisible({ timeout: 15_000 });
    await expect(main).toContainText('Last 30 days');
    await expect(main.locator('[data-spexport]')).toHaveAttribute('href', /\/api\/moderation\/metrics\/export\?days=30/);
    await accessible(page, 'Moderation › Spam and flood');
    await reflow(page, 'Moderation › Spam and flood');

    // Edit a surface's thresholds from the screen (shadow stays shadow).
    await page.locator('[data-spsurface="comment"]').click();
    const modal = page.locator('#overlay .modal');
    await expect(modal).toBeVisible();
    await expectAxeClean(page, 'aa', 'Edit comments dialog');
    await modal.locator('[data-spacc]').fill('35');
    await modal.locator('[data-spsave]').click();
    await toast(page, 'Comments: Shadow (score only). Audited as spam.policy.updated.');
    await expect(main.locator('tr', { hasText: 'Comments' }).first()).toContainText('35');

    // Turning the checks off goes through a confirmation.
    await page.locator('[data-spenable="0"]').click();
    await confirmDialog(page, 'Turn off');
    await toast(page, 'The checks are off.');
    await expect(main).toContainText('The checks are off.');
  });
});
