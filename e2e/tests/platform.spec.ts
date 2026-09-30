import { test, expect, open, expectLive, toast, confirmDialog } from './support/fixtures';

test.describe('Platform', () => {
  test('runs a backup and a restore drill that verifies it', async ({ page }) => {
    await open(page, 'platform');
    await expectLive(page);
    await page.locator('[data-tab="backups"]').click();
    await page.locator('[data-backup]').click();
    await confirmDialog(page, 'Back up');
    await toast(page, 'Backup started.');
    const row = page.locator('#main tr', { hasText: 'manual' }).first();
    await expect(async () => {
      await page.locator('[data-tab="backups"]').click();
      await expect(row).toContainText(/succeeded|verified|complete/i, { timeout: 1000 });
    }).toPass({ timeout: 30_000 });

    await page.locator('#main .panel [data-drill]').click();
    await confirmDialog(page);
    await toast(page, 'Restore drill started.');
    // The drill restores into a scratch database and records the measured RPO and RTO when it passes.
    await expect(async () => {
      await page.locator('[data-tab="backups"]').click();
      await expect(page.locator('#main')).toContainText(/Measured RPO .*; RTO .* against/, { timeout: 1000 });
    }).toPass({ timeout: 30_000 });
    await expect(page.locator('#main')).toContainText('within target');
  });

  test('issues a certificate from the internal ACME directory', async ({ page }) => {
    await open(page, 'platform');
    await page.locator('[data-tab="certs"]').click();
    await page.locator('[data-request-cert]').click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-cdomains]').fill('inference-gw.app.internal, gw.app.internal');
    await modal.locator('[data-cto]').fill('inference gateway');
    await modal.locator('[data-cgo]').click();
    await toast(page, 'Certificate for inference-gw.app.internal requested over ACME.');
    const row = page.locator('#main tr', { hasText: 'inference-gw.app.internal' }).first();
    await expect(async () => {
      await page.locator('[data-tab="certs"]').click();
      await expect(row).toContainText('valid', { timeout: 1000 });
    }).toPass({ timeout: 30_000 });
    await expect(row).toContainText('Fake internal CA');
  });
});
