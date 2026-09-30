import { test, expect, open, expectLive, confirmDialog } from './support/fixtures';

test.describe('Flags', () => {
  test('opens a flag from the queue and confirms it as a true positive', async ({ page }) => {
    await open(page, 'flags');
    await expectLive(page);
    await expect(page.locator('#main')).toContainText('IBAN in a prompt');
    await expect(page.locator('#main')).toContainText('DE89 3704 0044 0532 0130 00');
    await page.locator('[data-act="confirmed"]').click();
    await confirmDialog(page, 'Confirm');
    await expect(page.locator('#toasts')).toContainText('confirmed. Eval case created; audit entry written.');
    // The decision shows in the last 24 hours of decisions.
    await expect(page.locator('#main tr', { hasText: 'IBAN in a prompt' }).first()).toContainText(/confirmed/i);
  });
});
