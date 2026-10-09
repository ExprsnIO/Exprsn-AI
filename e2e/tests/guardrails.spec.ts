import { test, expect, open, ready, expectLive, toast, confirmDialog, apiAs } from './support/fixtures';
import { expectAxeClean } from './support/axe';

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

test.describe('Guardrails: Describe a rule (B-9601, B-9602)', () => {
  test('drafts a rule from a description, saves it in shadow, replays it, promotes it and publishes with a second approver', async ({ page }) => {
    await open(page, 'guardrails');
    await expectLive(page);
    const option = page.locator('[data-profile] option', { hasText: 'Finance baseline' }).first();
    const setId = (await option.getAttribute('value'))!.split(':')[0]!;
    await page.locator('[data-profile]').selectOption(await option.getAttribute('value'));
    await page.locator('[data-cp="model-output"]').click();

    // describe → draft shown as YAML and a diff, in shadow
    await page.locator('[data-describe]').click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-desc]').fill('hold answers that quote a card number');
    await modal.locator('[data-dcp]').selectOption('model-output');
    await modal.locator('[data-draft]').click();
    await expect(modal).toContainText('stage: shadow');
    await expect(modal).toContainText('+- id: card-numbers');
    await expect(modal).toContainText('require-approval');
    await expect(page.locator('.tmsg')).toHaveCount(0, { timeout: 15_000 });
    await expectAxeClean(page, 'aa', 'the Describe a rule dialog with its draft');

    // saved in shadow: the rule is in the draft version, selected, with the note
    await modal.locator('[data-savedraft]').click();
    await toast(page, 'Card numbers saved to Finance baseline');
    await expect(page.locator('#main tr', { hasText: 'Card numbers' })).toContainText('shadow');
    await expect(page.locator('#main')).toContainText('Drafted from a description');

    // replay over recent traffic, then promote (no false positives recorded)
    await page.locator('[data-replay]').click();
    await toast(page, /Replaying v/);
    await expect(page.locator('#main')).toContainText(/Replay of v\d+ finished/, { timeout: 30_000 });
    await page.locator('[data-promote]').click();
    await confirmDialog(page, 'Promote');
    await toast(page, 'Card numbers now enforces');
    await expect(page.locator('#main tr', { hasText: 'Card numbers' })).toContainText('enforce');

    // dual control: review requested, approved by a second admin, published
    await page.locator('[data-reqreview]').click();
    await toast(page, 'Review requested');
    const second = await apiAs('root2');
    try {
      await second.post(`/api/admin/guardrails/sets/${setId}/draft/approve`);
    } finally {
      await second.close();
    }
    await page.reload();
    await ready(page, 'guardrails');
    await expect(page.locator('[data-profile] option[value="' + setId + ':pub"]')).toHaveCount(1);
    await page.locator('[data-profile]').selectOption(`${setId}:pub`);
    await page.locator('[data-cp="model-output"]').click();
    await expect(page.locator('#main tr', { hasText: 'Card numbers' })).toContainText('enforce');
    await expect(page.locator('[data-profile] option:checked')).toHaveText(/published/);
    await expect(page.locator('.tmsg')).toHaveCount(0, { timeout: 15_000 });
    await expectAxeClean(page, 'aa', 'the Guardrails screen with the drafted rule published');
  });
});
