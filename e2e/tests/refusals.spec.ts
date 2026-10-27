import { test, expect, open, expectLive, toast } from './support/fixtures';

// Refusal and error states, as the console shows them (the other specs cover the primary path of each screen).

test.describe('Refusals: user stores', () => {
  test('refuses a store that references one of the server\'s own secrets and says why', async ({ page, watch }) => {
    await open(page, 'directories');
    await expectLive(page);
    // 1.9.0 (B-181): "Add user store" is the wizard; its JSON view is the advanced editor, checked at each step.
    await page.locator('[data-add]').click();
    await page.locator('[data-wname]').fill('Rogue directory');
    await page.locator('[data-wkind="ldap"]:not([data-wpreset])').click();
    await page.locator('[data-wnext]').click();
    await page.locator('#overlay [data-seg="json"]').click();
    const cfg = { url: 'ldaps://10.0.0.5:636', bindDN: 'cn=svc,dc=corp', bindPassword: 'env:DATA_KEY', userBase: 'ou=people,dc=corp', groupBase: 'ou=groups,dc=corp' };
    await page.locator('[data-wjson]').fill(JSON.stringify(cfg));
    await page.locator('[data-wnext]').click();
    const err = page.locator('[data-werr]');
    await expect(err).toContainText('config.bindPassword');
    await expect(err).toContainText("DATA_KEY is one of the server's own settings");
    await page.locator('[data-close]').first().click();
    await expect(page.locator('#main')).not.toContainText('Rogue directory');
  });
});

test.describe('Refusals: data connections', () => {
  test('refuses to connect to a database on a public address and says so', async ({ page }) => {
    await open(page, 'connections');
    await expectLive(page);
    await page.locator('[data-register]').first().click(); // "Register a connection" when empty, "Register" otherwise
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-name]').fill('public-ro');
    await modal.locator('[data-endpoint]').fill('8.8.8.8:5432');
    await modal.locator('[data-db]').fill('ledger');
    await modal.locator('[data-user]').fill('reader');
    await modal.locator('[data-pass]').fill('not-a-real-password');
    await modal.locator('[data-doreg]').click();
    await toast(page, 'Connection registered');
    await page.locator('.conn-list').getByText('public-ro').click();
    await expect(page.locator('#main h1')).toContainText('public-ro');
    await page.locator('[data-test]').click();
    // Refused before any packet leaves: internal hosts only unless CONNECTIONS_ALLOWED_HOSTS names it.
    await expect(page.locator('#main')).toContainText(/public address/, { timeout: 20_000 });
  });
});
