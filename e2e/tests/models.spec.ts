import { test, expect, open, expectLive, confirmDialog, ready } from './support/fixtures';

test.describe('Models', () => {
  test('requests an import, pulls and evaluates it, and a second admin approves it', async ({ page, as }) => {
    await open(page, 'models');
    await expectLive(page);
    await expect(page.locator('#main')).toContainText('4 of 4 models');

    await page.getByRole('button', { name: 'Request import' }).click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-f="name"]').fill('mistral:7b');
    await modal.locator('[data-f="label"]').selectOption('confidential');
    await modal.locator('[data-f="licence"]').fill('Apache 2.0');
    await modal.locator('[data-f="pool"]').selectOption({ index: 1 });
    await modal.locator('[data-f="notes"]').fill('A second general model for comparisons.');
    await modal.getByRole('button', { name: 'Send request' }).click();

    const row = page.locator('#main tr', { hasText: 'mistral:7b' });
    await expect(row).toBeVisible();
    await row.click();
    // The pull runs as a job on the fake Ollama; then the evaluation can start.
    await expect(page.locator('[data-evaluate]')).toBeEnabled({ timeout: 20_000 });
    await page.locator('[data-evaluate]').click();
    await confirmDialog(page, 'Run evaluation');
    await expect(row).toContainText('evaluated', { timeout: 20_000 });
    // Dual control: the requester cannot approve.
    await expect(page.locator('[data-approve]')).toBeDisabled();
    await expect(page.locator('#main')).toContainText('someone other than the requester must approve it');

    const second = await as('root2');
    await second.goto('/#/models');
    await ready(second, 'models');
    await second.locator('#main tr', { hasText: 'mistral:7b' }).click();
    await expect(second.locator('[data-approve]')).toBeEnabled();
    await second.locator('[data-approve]').click();
    await confirmDialog(second, 'Approve');
    await expect(second.locator('#main tr', { hasText: 'mistral:7b' })).toContainText('approved');
  });
});
