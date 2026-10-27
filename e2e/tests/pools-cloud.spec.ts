import { test, expect, open, expectLive, toast, confirmDialog, apiAs, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { expectAccessible } from './support/a11y';
import { reflowProblems } from './support/reflow';

/*
 * 1.9.99-final, Sprint 60 (B-10406): the Pools screen's cloud node group card. The e2e server seeds the pool
 * `gpu-cloud` on a DigitalOcean GPU node group of one node (its size changes go to a fake scaler; nothing reaches a
 * cloud). The card shows the size, cost per hour, the idle timer and the spot state; scaling to zero from the card
 * takes effect and is audited. The card passes the WCAG checker and axe-core (Standard and Enhanced, light and dark)
 * and reflows at 320 and 640 px.
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

test.describe('Pools: the cloud node group card', () => {
  test('shows size, cost per hour, idle timer and spot state; scaling to zero takes effect and is audited', async ({ page }) => {
    await open(page, 'pools');
    await expectLive(page);
    const card = page.locator('#main .plc').first();
    await expect(card).toContainText('Cloud node group');
    await expect(card).toContainText('DigitalOcean, fra1');
    await expect(card).toContainText('gpu-h100x1-80gb');
    await expect(card).toContainText('1 asked');
    await expect(card).toContainText('4.41 USD');
    await expect(card).toContainText(/Scales to 0 in \d+ min/);
    await expect(card).toContainText('On demand only');
    await accessible(page, 'Pools with the cloud card');
    await reflow(page, 'Pools with the cloud card');

    // The size and policy dialog is labelled and keyboard-operable; cancel leaves it unchanged.
    await card.locator('[data-plc-edit]').click();
    const modal = page.locator('#overlay .modal');
    await expect(modal.getByLabel('Minimum nodes')).toHaveValue('0');
    await expect(modal.getByLabel('Maximum nodes')).toHaveValue('2');
    await expect(modal.getByLabel('Idle minutes')).toHaveValue('15');
    await accessible(page, 'Cloud node group dialog');
    await modal.locator('[data-close]').first().click();

    await card.locator('[data-plc-zero]').click();
    await confirmDialog(page, 'Scale to zero');
    await toast(page, 'Scaling to zero nodes');
    await expect(page.locator('#main .plc').first()).toContainText('0 asked');
    await expect(page.locator('#main .plc').first()).toContainText('At the minimum of 0 (scaled to zero)');
    await expect(page.locator('#main .plc [data-plc-zero]').first()).toBeDisabled();

    const root = await apiAs('root');
    const events = (await root.get('/api/admin/audit?action=cloud.pool.scaled&limit=5')) as { action: string; detail: Record<string, unknown> }[];
    expect(events.some((e) => e.action === 'cloud.pool.scaled' && e.detail.to === 0 && e.detail.reason === 'manual')).toBe(true);
    const savings = await root.get('/api/admin/cloud/gpu-savings');
    expect(savings.pools.some((p: { pool: string; intervals: number }) => p.pool === 'gpu-cloud' && p.intervals >= 1)).toBe(true);
    await root.close();
  });
});
