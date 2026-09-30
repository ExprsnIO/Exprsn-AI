import { test, expect, open, expectLive, toast, confirmDialog } from './support/fixtures';

test.describe('Workflows', () => {
  test('creates a workflow, publishes it and runs the published version', async ({ page }) => {
    await open(page, 'workflows');
    await expectLive(page);
    await page.locator('[data-new]').first().click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-name]').fill('expense-notes');
    await modal.locator('[data-desc]').fill('Turns an expense claim into notes for the controller');
    await modal.locator('[data-go]').click();
    await toast(page, 'expense-notes created as a draft with a manual trigger');

    await page.locator('.wf-toolbar [data-publish]').click();
    await confirmDialog(page, 'Publish');
    await toast(page, 'expense-notes v1 published');

    await page.locator('.wf-toolbar [data-startrun]').click();
    const run = page.locator('#overlay .modal');
    await expect(run).toContainText('Start a run of v1');
    await run.locator('[data-go]').click();
    await toast(page, /Run .* started/);
    await expect(page.locator('#main tr', { hasText: 'manual, Mara Okafor' }).first()).toContainText('succeeded', { timeout: 20_000 });
  });
});
