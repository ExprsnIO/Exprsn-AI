import { test, expect, open, expectLive, toast } from './support/fixtures';

test.describe('Tenants', () => {
  test('creates a workspace with a first group mapping', async ({ page }) => {
    await open(page, 'tenants');
    await expectLive(page);
    await expect(page.locator('#main')).toContainText('Finance Ops');
    await page.locator('[data-newws]').first().click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-wsname]').fill('Treasury');
    await modal.locator('[data-wslabel]').selectOption('confidential');
    await modal.locator('[data-wsdesc]').fill('Cash management and forecasting');
    await modal.locator('[data-wsgroup]').fill('cn=treasury,ou=groups,dc=northwind,dc=local');
    await modal.locator('[data-wsgo]').click();
    await toast(page, 'Workspace Treasury created');
    await expect(page.locator('#main h1')).toContainText('Treasury');
    await expect(page.locator('#main')).toContainText('cn=treasury,ou=groups,dc=northwind,dc=local');
  });
});
