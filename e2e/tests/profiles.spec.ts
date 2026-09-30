import { test, expect, open, expectLive, confirmDialog } from './support/fixtures';

test.describe('Profiles', () => {
  test('creates a draft profile on an approved model and publishes it', async ({ page }) => {
    await open(page, 'profiles');
    await expectLive(page);
    await page.locator('[data-new]').first().click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-nn]').fill('summariser-8b');
    await modal.locator('[data-nd]').fill('Summariser');
    await modal.locator('[data-nm]').selectOption({ label: 'llama3.1:8b, confidential' });
    await modal.locator('[data-nl]').selectOption('internal');
    await modal.locator('[data-nds]').fill('Short summaries of long documents');
    await modal.locator('[data-create]').click();
    await expect(page.locator('#main h1')).toContainText('Summariser');
    await expect(page.locator('#main')).toContainText('draft');

    await page.locator('[data-status="published"]').click();
    await confirmDialog(page, 'Publish');
    await expect(page.locator('.leftpane')).toContainText(/summariser-8b\s*llama3\.1:8b\s*published/);
  });
});
