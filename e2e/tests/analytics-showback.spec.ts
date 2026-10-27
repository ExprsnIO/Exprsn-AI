import { test, expect, open, expectLive, toast, confirmDialog, apiAs, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { expectAccessible } from './support/a11y';
import { reflowProblems } from './support/reflow';

/*
 * 1.9.99-final, Sprint 61 (B-10604): the Analytics screen's Cloud showback view. The e2e server seeds one ingested
 * cloud cost this month (USD 12.50 on the DigitalOcean GPU deployment; nothing reaches a cloud). The view shows the
 * month per currency with the ingested total and the unallocated rest for a platform admin, exports CSV (audited),
 * lists the allocation rules, and turns the tenant's statement lines on and off (audited). It passes the WCAG checker
 * and axe-core (Standard and Enhanced, light and dark) and reflows at 320 and 640 px.
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
    await page.waitForTimeout(200);
    expect.soft(await reflowProblems(page), `${where} at ${width} px`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(100);
}

test.describe('Analytics: cloud showback', () => {
  test('shows the month per currency, exports CSV, lists the rules and turns statement lines on, accessibly', async ({ page }) => {
    await open(page, 'analytics');
    await expectLive(page);
    await page.getByRole('tab', { name: 'Cloud showback' }).click();
    await expect(page.getByRole('tab', { name: 'Cloud showback' })).toHaveAttribute('aria-selected', 'true');
    const main = page.locator('#main');
    await expect(main).toContainText('Cloud costs shown back');
    await expect(main).toContainText('Ingested USD 12.50');
    await expect(main).toContainText('Allocation rules');
    await expect(main).toContainText('Databases and caches');
    await expect(main).toContainText('never converted');
    await accessible(page, 'Cloud showback');
    await reflow(page, 'Cloud showback');

    // The CSV export is a download; the audit chain records it.
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()]);
    expect(download.suggestedFilename()).toMatch(/^showback-\d{4}-\d{2}\.csv$/);
    await toast(page, /Showback export started/);
    const root = await apiAs('root');
    expect(((await root.get('/api/admin/audit?action=cloud.showback.exported&limit=5')) as unknown[]).length).toBeGreaterThan(0);

    // The rules dialog is labelled; cancelling leaves the rules as they were.
    await page.getByRole('button', { name: 'Change rules' }).click();
    const modal = page.locator('#overlay .modal');
    await expect(modal.getByLabel('GPU time')).toHaveValue('gpu_time');
    await accessible(page, 'Allocation rules dialog');
    await modal.getByRole('button', { name: 'Cancel' }).click();

    // Statement lines: off by default, turned on after a confirmation, audited, and off again.
    const toggle = page.getByRole('switch', { name: /Show showback lines/ });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await confirmDialog(page, 'Show');
    await toast(page, 'Showback lines are on the statements.');
    await expect(page.getByRole('switch', { name: /Show showback lines/ })).toHaveAttribute('aria-checked', 'true');
    expect(((await root.get('/api/admin/cloud/showback/settings')) as { statementLines: boolean }).statementLines).toBe(true);
    expect(((await root.get('/api/admin/audit?action=cloud.showback.settings.updated&limit=5')) as unknown[]).length).toBeGreaterThan(0);
    await page.getByRole('switch', { name: /Show showback lines/ }).click();
    await confirmDialog(page, 'Stop showing');
    await toast(page, 'Showback lines are off the statements.');
    await root.close();
  });
});
