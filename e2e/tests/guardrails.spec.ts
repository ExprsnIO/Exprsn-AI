import { test, expect, open, expectLive, toast, confirmDialog } from './support/fixtures';

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

  test('B-6902: the untrusted-content checkpoint shows the injection defence and adds a blocking rule to a tenant set', async ({ page }) => {
    await open(page, 'guardrails');
    await page.locator('[data-cp="untrusted-content"]').click();
    const panel = page.locator('#main .panel', { hasText: 'Prompt-injection defence' });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Detections by source');
    await expect(panel).toContainText('CI corpus');
    await expect(panel).toContainText('annotate');
    // The live test runs the platform baseline's rule (annotate) on an injected sample.
    const base = await page.locator('[data-profile] option', { hasText: 'Platform baseline' }).first().getAttribute('value');
    await page.locator('[data-profile]').selectOption(base!);
    await page.locator('[data-cp="untrusted-content"]').click();
    await expect(page.locator('#main')).toContainText('Instructions in untrusted content');
    await expect(page.locator('[data-testpane]')).toContainText('Would warn');
    // In the tenant set, block mode is one rule away.
    const option = await page.locator('[data-profile] option', { hasText: 'Finance baseline' }).first().getAttribute('value');
    await page.locator('[data-profile]').selectOption(option!);
    await page.locator('[data-cp="untrusted-content"]').click();
    await page.locator('[data-injblock]').click();
    await confirmDialog(page, 'Add rule');
    await toast(page, 'injection-block added to Finance baseline');
    await expect(page.locator('#main tr', { hasText: 'Block instructions in untrusted content' })).toContainText('block');
  });
});
