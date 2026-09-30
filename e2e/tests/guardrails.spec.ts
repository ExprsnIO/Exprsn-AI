import { test, expect, open, expectLive, toast } from './support/fixtures';

test.describe('Guardrails', () => {
  test('live-tests the baseline secrets rule and creates a tenant rule set', async ({ page }) => {
    await open(page, 'guardrails');
    await expectLive(page);
    await expect(page.locator('#main')).toContainText('Secrets and private keys');

    // The live test runs the rule on the gateway with a sample.
    const pane = page.locator('[data-testpane]');
    await pane.locator('[data-editsample]').click();
    await pane.locator('[data-sample]').fill('Use the key AKIAIOSFODNN7EXAMPLE with secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY for the upload');
    await pane.locator('[data-runtest]').click();
    await expect(pane).toContainText('Would block');
    await pane.locator('[data-editsample]').click();
    await pane.locator('[data-sample]').fill('The quarterly report is attached.');
    await pane.locator('[data-runtest]').click();
    await expect(pane).toContainText('Would allow');

    // A tenant rule set starts as an empty draft.
    await page.locator('[data-profile]').selectOption('new');
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-n]').fill('Finance baseline');
    await modal.locator('[data-create]').click();
    await toast(page, 'Rule set Finance baseline created');
    await expect(page.locator('[data-profile] option:checked')).toHaveText(/Finance baseline/);
  });
});
