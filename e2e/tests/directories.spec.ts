import { test, expect, open, expectLive } from './support/fixtures';
import { serverState } from './support/state';

test.describe('User stores', () => {
  test('runs "Test a login" through the real sign-in chain and lists users', async ({ page }) => {
    await open(page, 'directories');
    await expectLive(page);
    await expect(page.locator('#main')).toContainText('Local accounts');

    await page.locator('[data-tab="test"]').click();
    await page.locator('[data-tluser]').fill('member');
    await page.locator('[data-tlpass]').fill(serverState().password);
    await page.locator('[data-runtest]').click();
    await expect(page.locator('#main')).toContainText('Local accounts accepted the password.');
    await expect(page.locator('#main')).toContainText('Would sign in as');
    // Not asserted: for a local account with directly assigned roles the preview says "sign-in would be refused"
    // although the account signs in (the server resolves the preview from group mappings only; reported).

    await page.locator('[data-tlpass]').fill('not the password');
    await page.locator('[data-runtest]').click();
    await expect(page.locator('#main')).toContainText(/owns the username and answered/);

    await page.locator('[data-tab="users"]').click();
    await expect(page.locator('#main')).toContainText('Sam Rivera');
    await expect(page.locator('#main')).toContainText('Asha Patel');
  });
});
