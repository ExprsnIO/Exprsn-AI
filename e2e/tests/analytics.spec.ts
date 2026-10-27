import type { Page } from '@playwright/test';
import { test, expect, open, expectLive, apiAs, toast } from './support/fixtures';
import { expectAccessible } from './support/a11y';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';

const setA11y = (page: Page, m: string) => page.evaluate((x) => (window as unknown as { App: { setA11y(m: string): void } }).App.setA11y(x), m);

// 1.6.0, Sprint 38a (B-7401, B-7402): the Analytics screen.
test.describe('Analytics', () => {
  test('shows usage by dimension, prices give rows a cost, and the chargeback export downloads', async ({ page }) => {
    // Some usage to count: a chat turn by a member on the seeded profile.
    const member = await apiAs('mladmin');
    await member.post('/api/chat', { content: 'Two sentences on token metering, please.', profile: 'general' });
    await member.close();
    const root = await apiAs('root');
    await expect.poll(async () => ((await root.get('/api/admin/analytics/summary?by=user&days=1')) as { rows: unknown[] }).rows.length, { timeout: 20_000 }).toBeGreaterThan(0);

    await open(page, 'analytics');
    await expectLive(page);
    await expect(page.locator('#main')).toContainText('Usage by');
    await expect(page.locator('#main tr[data-total]')).toBeVisible();
    await expectAccessible(page, 'analytics');
    await expectAxeClean(page, 'aa', 'analytics');

    // The user dimension names the member; the model dimension names the seeded model.
    await page.locator('[data-byseg] [data-seg="user"]').click();
    await expect(page.locator('#main')).toContainText('Asha Patel');
    await page.locator('[data-byseg] [data-seg="model"]').click();
    const modelRow = page.locator('#main tr[data-key]').first();
    await expect(modelRow).toBeVisible();
    // The table re-renders for the new dimension: until it has, the first row is still a user (keyed by a ULID).
    await expect.poll(async () => modelRow.getAttribute('data-key'), { timeout: 10_000 }).not.toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    await expect(modelRow).toContainText('no price');
    const modelName = (await modelRow.getAttribute('data-key'))!;
    await modelRow.click();
    await expect(page.locator('#main .inspector')).toContainText('Prompt tokens');

    // A price per model (one currency per tenant); the row then carries a cost.
    await page.getByRole('button', { name: 'Add price' }).click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-pref]').fill(modelName);
    await modal.locator('[data-pcur]').fill('EUR');
    await modal.locator('[data-pin]').fill('0.5');
    await modal.locator('[data-pout]').fill('1.5');
    await modal.locator('[data-pgo]').click();
    await toast(page, /Price saved for /);
    await expect(page.locator('#main tr[data-key]').first()).not.toContainText('no price');
    await expect(page.locator('#main')).toContainText('Prices, EUR');

    // The chargeback export is a download; the audit chain records it.
    const [download] = await Promise.all([page.waitForEvent('download'), (async () => { await page.getByRole('button', { name: 'Chargeback export' }).first().click(); await page.locator('#overlay .modal [data-cbgo]').click(); })()]);
    expect(download.suggestedFilename()).toMatch(/^chargeback-.*\.csv$/);
    const events = (await root.get('/api/admin/audit?action=analytics.chargeback.exported&limit=5')) as { action: string }[];
    expect(events.length).toBeGreaterThan(0);
    await root.close();
  });
  // 2026-10-19: embedding and classifier usage per profile and per user (class=embedding).
  test('the Embeddings and classifiers view breaks that usage down per profile and per user, accessibly', async ({ page }) => {
    // A memory is embedded when it is added: one embedding record for the member.
    const member = await apiAs('mladmin');
    await member.post('/api/memory', { text: `Prefers short answers ${Date.now().toString(36)}`, label: 'internal' });
    await member.close();
    const root = await apiAs('root');
    await expect.poll(async () => ((await root.get('/api/admin/analytics/summary?by=profile&days=1&class=embedding')) as { rows: unknown[] }).rows.length, { timeout: 20_000 }).toBeGreaterThan(0);
    await root.close();

    await open(page, 'analytics');
    await expectLive(page);
    await page.getByRole('tab', { name: 'Embeddings and classifiers' }).click();
    await expect(page.getByRole('tab', { name: 'Embeddings and classifiers' })).toHaveAttribute('aria-selected', 'true');
    const seg = page.locator('[data-embseg]');
    await expect(seg.getByRole('button', { name: 'Per profile' })).toBeVisible();
    await expect(seg.getByRole('button', { name: 'Per user' })).toBeVisible();
    await expect(page.locator('#main')).toContainText('Embeddings and classifiers,');
    // Per profile: the embedding model's row (no profile is published for it here, so it is named after the model).
    await expect(page.locator('#main tr[data-key]').first()).toBeVisible();
    await expect(page.locator('#main')).toContainText('nomic-embed-text');
    await expect(page.locator('#main tr[data-total]')).toBeVisible();

    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(150);
      await expectAccessible(page, `analytics embeddings (${scheme})`);
      await expectAxeClean(page, 'aa', `analytics embeddings (${scheme})`);
      await setA11y(page, 'aaa');
      await page.waitForTimeout(150);
      await expectAxeClean(page, 'aaa', `analytics embeddings (${scheme}), Enhanced`);
      await setA11y(page, 'aa');
    }
    await page.emulateMedia({ colorScheme: 'light' });

    // Per user: the member who added the memory.
    await seg.getByRole('button', { name: 'Per user' }).click();
    await expect(seg.getByRole('button', { name: 'Per user' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#main table')).toContainText('User');
    await expect(page.locator('#main tr[data-key]').first()).toBeVisible();
    await expectAxeClean(page, 'aa', 'analytics embeddings per user');

    for (const width of [320, 640]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(350);
      expect.soft(await reflowProblems(page), `analytics embeddings at ${width} px`).toEqual([]);
    }
    await page.setViewportSize({ width: 1440, height: 900 });

    // Back to all usage: the original dimensions are there again.
    await page.getByRole('tab', { name: 'All usage' }).click();
    await expect(page.locator('[data-byseg] [data-seg="workspace"]')).toBeVisible();
  });
});
