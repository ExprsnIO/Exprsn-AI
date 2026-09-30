import { test, expect, open, expectLive, toast } from './support/fixtures';

test.describe('Connections', () => {
  test('shows the empty state, registers a PostgreSQL connection and tests it', async ({ page }) => {
    await open(page, 'connections');
    await expectLive(page);
    await expect(page.locator('#main h3', { hasText: 'No connections yet' }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Register a connection' }).click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-name]').fill('ledger-ro');
    // Nothing listens on port 9: the test step reports the server as unreachable instead of hanging.
    await modal.locator('[data-endpoint]').fill('127.0.0.1:9');
    await modal.locator('[data-db]').fill('ledger');
    await modal.locator('[data-label]').selectOption('confidential');
    await modal.locator('[data-user]').fill('ledger_ro');
    await modal.locator('[data-pass]').fill('not-a-real-password');
    await modal.locator('[data-doreg]').click();
    await toast(page, 'Connection registered');
    await expect(page.locator('#main h1')).toContainText('ledger-ro');
    await expect(page.locator('.conn-list')).toContainText('ledger-ro');

    await page.locator('[data-test]').click();
    await expect(page.locator('#main')).toContainText(/unreachable|could not reach|refused/i, { timeout: 20_000 });
  });
});
