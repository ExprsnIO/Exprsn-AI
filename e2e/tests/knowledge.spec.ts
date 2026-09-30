import { test, expect, open, expectLive, toast } from './support/fixtures';

test.describe('Knowledge', () => {
  test('creates a knowledge base and uploads a document into it', async ({ page }) => {
    await open(page, 'knowledge');
    await expectLive(page);
    await page.getByRole('button', { name: 'New knowledge base' }).click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-name]').fill('Treasury KB');
    await expect(modal.locator('[data-emb]')).toHaveValue('nomic-embed-text');
    await modal.getByRole('button', { name: 'Create' }).click();
    await toast(page, 'Created Treasury KB as a draft');
    await expect(page.locator('#main h1')).toContainText('Treasury KB');

    // Add an upload source with a Markdown file; it goes through quarantine and shows on the documents tab.
    await page.locator('[data-addsource]').first().click();
    const drawer = page.locator('#overlay .drawer');
    await drawer.locator('[data-type]').selectOption('upload');
    await drawer.locator('[data-files]').setInputFiles({ name: 'refunds.md', mimeType: 'text/markdown', buffer: Buffer.from('# Refunds\n\nRefunds are paid within 14 days of the request.\n') });
    await drawer.getByRole('button', { name: 'Add and sync' }).click();
    await toast(page, '1 file uploaded to quarantine');
    await expect(page.locator('#main').getByText('refunds.md').first()).toBeVisible();
  });
});
