import { test, expect, open, expectLive, toast } from './support/fixtures';

// Refusal and error states, as the console shows them (the other specs cover the primary path of each screen).

test.describe('Refusals: user stores', () => {
  test('refuses a store that references one of the server\'s own secrets and says why', async ({ page, watch }) => {
    watch.allow.push(/POST \/api\/admin\/identity-providers -> 400/);
    await open(page, 'directories');
    await expectLive(page);
    await page.locator('[data-add]').click();
    await page.locator('[data-sname]').fill('Rogue directory');
    const cfg = { url: 'ldaps://10.0.0.5:636', bindDN: 'cn=svc,dc=corp', bindPassword: 'env:DATA_KEY', userBase: 'ou=people,dc=corp', groupBase: 'ou=groups,dc=corp' };
    await page.locator('[data-scfg]').fill(JSON.stringify(cfg));
    await page.locator('[data-ssave]').click();
    const err = page.locator('[data-serr]');
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
