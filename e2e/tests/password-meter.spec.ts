import { test, expect, open } from './support/fixtures';

// B-802: the strength meter on the password forms (Settings, and the admin's create and reset in User stores; the
// sign-in screen's reset and forced-change forms use the same App.passwordMeter), and the Platform warning while the
// breached-password check is off. B-804: the admin reset offers to revoke the account's API keys, ticked by default.

test.describe('Password strength', () => {
  test('rates the new password in Settings as it is typed', async ({ page }) => {
    await open(page, 'settings');
    const field = page.locator('[data-pwnew]');
    await field.fill('root12345678');
    const meter = page.locator('#main [data-pwmeter]');
    await expect(meter).toBeVisible();
    await expect(meter).toContainText('Strength:');
    await expect(meter).toContainText('does not contain the username');
    await expect(meter).toContainText('Not checked against breached-password lists');
    await field.fill('violet harbour lanterns drift 42');
    await expect(meter).toContainText('Meets the policy.');
    await field.fill('');
    await expect(meter).toBeHidden();
  });

  test('rates the password an admin sets, and offers to revoke API keys on reset', async ({ page }) => {
    await open(page, 'directories?tab=users');
    await page.locator('[data-tab="users"]').click();
    await page.locator('[data-newuser]').click();
    const create = page.locator('#overlay .modal');
    await create.locator('[data-np]').fill('short');
    await expect(create.locator('[data-pwmeter]')).toContainText('at least 12 characters');
    await create.locator('[data-close]').first().click();

    await page.locator('#main [data-user]', { hasText: 'member' }).first().click();
    await page.locator('#overlay [data-resetpw]').click();
    const reset = page.locator('#overlay .modal');
    await expect(reset.locator('[data-rpkeys]')).toBeChecked();
    await reset.locator('[data-rppw]').fill('a sturdy temporary phrase');
    await expect(reset.locator('[data-pwmeter]')).toContainText('Meets the policy.');
    await reset.locator('[data-close]').first().click();
  });

  test('Platform warns that breached passwords are not checked', async ({ page }) => {
    await open(page, 'platform');
    await expect(page.locator('#main')).toContainText('New passwords are not checked against breached-password lists.');
  });
});
