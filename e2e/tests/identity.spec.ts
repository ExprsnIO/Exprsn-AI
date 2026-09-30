import { test, expect, open, expectLive, toast, ready } from './support/fixtures';

test.describe('Identity', () => {
  test('creates a confidential OIDC client and shows its secret once', async ({ page }) => {
    await open(page, 'identity');
    await expectLive(page);
    await expect(page.locator('#main')).toContainText('ES256');
    await page.locator('[data-create]').click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-cname]').fill('Treasury dashboard');
    await modal.locator('[data-ctype]').selectOption('confidential, BFF');
    await modal.locator('[data-credir]').fill('https://treasury.example.internal/oauth/cb');
    await modal.locator('[data-cgo]').click();
    await toast(page, 'Client Treasury dashboard created. Copy the secret now.');

    const secret = page.locator('.id-secret');
    await expect(secret).toContainText('Secret shown once');
    const value = (await secret.locator('.mono').innerText()).trim();
    expect(value.length).toBeGreaterThan(20);

    // After a reload the secret is gone for good: only its creation date and a rotate action remain.
    await page.reload();
    await ready(page, 'identity');
    await page.locator('#main tr', { hasText: 'Treasury dashboard' }).first().click();
    await expect(page.locator('.id-secret')).toHaveCount(0);
    await expect(page.locator('#main')).not.toContainText(value);
    await expect(page.locator('[data-rotatesecret]')).toBeVisible();
  });
});
