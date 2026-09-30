import { test, expect, open, expectLive, confirmDialog, toast } from './support/fixtures';

test.describe('Usage and audit', () => {
  test('signs a checkpoint and verifies the audit chain', async ({ page }) => {
    await open(page, 'usage-audit');
    await expectLive(page);
    await expect(page.locator('#main')).toContainText('Default chain');

    await page.locator('[data-checkpoint]').click();
    await confirmDialog(page);
    await toast(page, /Checkpoint signed at sequence \d+/);

    await page.locator('[data-verify]').click();
    await confirmDialog(page, 'Verify');
    await toast(page, /Default chain verified: [\d,]+ events, \d+ checkpoints/);

    // The audit log tab lists the checkpoint event.
    await page.locator('[data-tab="audit"]').click();
    await expect(page.locator('#main')).toContainText('audit.checkpoint');
  });
});
