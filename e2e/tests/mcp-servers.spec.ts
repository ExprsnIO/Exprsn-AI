import { test, expect, open, expectLive, toast } from './support/fixtures';
import { serverState } from './support/state';

test.describe('MCP servers', () => {
  test('registers the internal MCP server, lists its tools and approves one', async ({ page }) => {
    await open(page, 'mcp-servers');
    await expectLive(page);
    await page.locator('[data-register]').first().click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-name]').fill('erp-bridge');
    await modal.locator('[data-url]').fill(serverState().fakes.mcp);
    await modal.locator('[data-desc]').fill('Invoices and payment reminders');
    await modal.locator('[data-ok]').click();
    await toast(page, 'erp-bridge registered. Its tools wait for review.');

    const lookup = page.locator('#main tr', { hasText: 'lookup_invoice' });
    await expect(lookup).toBeVisible();
    await expect(page.locator('#main tr', { hasText: 'send_reminder' })).toBeVisible();
    await lookup.locator('[data-review]').click();
    const review = page.locator('#overlay .modal');
    await expect(review).toContainText('Review lookup_invoice');
    await review.getByRole('button', { name: 'Approve tool' }).click();
    await expect(lookup).toContainText('approved');
  });
});
