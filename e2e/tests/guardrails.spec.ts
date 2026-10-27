import { test, expect, open, expectLive, toast, confirmDialog } from './support/fixtures';
import { expectAccessible } from './support/a11y';
import { expectAxeClean } from './support/axe';

test.describe('Guardrails', () => {
  test('live-tests the baseline secrets rule and creates a tenant rule set', async ({ page }) => {
    await open(page, 'guardrails');
    await expectLive(page);
    // The screen opens the tenant's own rule set when an earlier spec made one (chat-capabilities does): start from the baseline.
    const baseline = await page.locator('[data-profile] option', { hasText: 'Platform baseline' }).first().getAttribute('value');
    await page.locator('[data-profile]').selectOption(baseline!);
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

  test('B-9602: a rule is described, saved in shadow, replayed and promoted, and enforces once a second admin approves', async ({ page, as }) => {
    await open(page, 'guardrails');
    // A rule set of its own, so that approving it publishes this rule only (Finance baseline stays a draft).
    await page.locator('[data-profile]').selectOption('new');
    await page.locator('#overlay .modal [data-n]').fill('Card rules');
    await page.locator('#overlay .modal [data-create]').click();
    await toast(page, 'Rule set Card rules created');
    await expect(page.locator('[data-profile] option:checked')).toHaveText(/Card rules/);
    const pick = async (p: typeof page) => {
      const option = await p.locator('[data-profile] option', { hasText: 'Card rules' }).first().getAttribute('value');
      await p.locator('[data-profile]').selectOption(option!);
    };

    // The model drafts one rule; the dialog shows it with its diff against the rule set, and nothing is saved yet.
    await page.locator('[data-describe]').click();
    const modal = page.locator('#overlay .modal');
    await expect(modal).toContainText('Describe a rule for Card rules');
    await expect(modal.locator('[data-savedraft]')).toBeDisabled();
    await modal.locator('[data-desc]').fill('hold answers that quote a card number');
    await modal.locator('[data-draft]').click();
    await expect(modal.locator('[data-result]')).toContainText('Hold card numbers in answers');
    await expect(modal.locator('[data-result]')).toContainText('one rule added, no rule changed or removed');
    await expect(modal.locator('[data-result] .codebox')).toContainText('stage: shadow');
    await expect(modal.locator('[data-result] .codebox')).toContainText('payment_card');
    await expectAccessible(page, 'the describe-a-rule dialog with a draft');
    await expectAxeClean(page, 'aa', 'the describe-a-rule dialog with a draft');
    // The dialog fits the window at 400 % and 200 % zoom: neither it nor the page scrolls sideways (its diff is code, which may).
    for (const width of [320, 640]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(250);
      expect(await page.evaluate(() => {
        const m = document.querySelector('#overlay .modal') as HTMLElement;
        const out: string[] = [];
        if (m.scrollWidth > m.clientWidth + 1) out.push('the dialog scrolls sideways');
        if (document.scrollingElement!.scrollWidth > window.innerWidth + 1) out.push('the page scrolls sideways');
        if (m.getBoundingClientRect().right > window.innerWidth + 1) out.push('the dialog is wider than the window');
        for (const el of Array.from(m.querySelectorAll('*'))) {
          if (!(el instanceof HTMLElement) || !el.getClientRects().length || el.closest('.codebox')) continue;
          if (el.getBoundingClientRect().right > Math.min(window.innerWidth, m.getBoundingClientRect().right) + 1) out.push(`${el.tagName.toLowerCase()} sticks out at the right edge`);
        }
        return [...new Set(out)];
      }), `the describe-a-rule dialog at ${width} px`).toEqual([]);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await modal.locator('[data-savedraft]').click();
    await toast(page, 'Hold card numbers in answers added to Card rules');

    // It joined the draft in shadow, marked as drafted from a description.
    const row = page.locator('#main tr', { hasText: 'Hold card numbers in answers' });
    await expect(row).toContainText('shadow');
    await expect(row).toContainText('described');
    await expect(page.locator('#main')).toContainText('Drafted from a description.');
    await expect(page.locator('[data-testpane]')).toContainText('Would allow');

    // Replayed over the recorded traffic, then promoted: it would enforce, so the draft no longer publishes directly.
    await page.locator('[data-replay]').click();
    await toast(page, /Replaying v\d+ over 7 days/);
    await expect(page.locator('#main')).toContainText(/Replay of v\d+ finished over \d+ recorded turns/, { timeout: 30_000 });
    await page.locator('[data-promote]').click();
    await confirmDialog(page, 'Promote');
    await toast(page, 'Hold card numbers in answers now enforces');
    await expect(page.locator('[data-publish]')).toBeDisabled();
    await expect(page.locator('#main .reviewbar')).toContainText('drafted from a description and would enforce');
    await page.locator('[data-reqreview]').click();
    await toast(page, 'Review requested');
    await expect(page.locator('[data-approve]')).toBeDisabled();

    // The second guardrail admin approves, and the version with the enforcing rule is published.
    const other = await as('root2');
    await open(other, 'guardrails');
    await pick(other);
    await expect(other.locator('#main .reviewbar')).toContainText('Second approver needed');
    await other.locator('[data-approve]').click();
    await confirmDialog(other, 'Approve');
    await toast(other, /Approved\. Card rules v\d+ is published/);
    await page.reload();
    await open(page, 'guardrails');
    await pick(page);
    await page.locator('[data-cp="model-output"]').click();
    await expect(page.locator('#main tr', { hasText: 'Hold card numbers in answers' })).toContainText('enforce');
    await expect(page.locator('#main')).toContainText('A second guardrail admin approved it enforcing.');
  });
});
