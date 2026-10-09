import { test, expect, open, expectLive, apiAs, toast } from './support/fixtures';
import { expectAccessible } from './support/a11y';
import { expectAxeClean } from './support/axe';

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
});
