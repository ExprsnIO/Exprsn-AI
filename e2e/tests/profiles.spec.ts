import { expectAxeClean } from './support/axe';
import { test, expect, open, expectLive, confirmDialog, toast } from './support/fixtures';

test.describe('Profiles', () => {
  test('creates a draft profile on an approved model and publishes it', async ({ page }) => {
    await open(page, 'profiles');
    await expectLive(page);
    await page.locator('[data-new]').first().click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-nn]').fill('summariser-8b');
    await modal.locator('[data-nd]').fill('Summariser');
    await modal.locator('[data-nm]').selectOption({ label: 'llama3.1:8b, confidential' });
    await modal.locator('[data-nl]').selectOption('internal');
    await modal.locator('[data-nds]').fill('Short summaries of long documents');
    await modal.locator('[data-create]').click();
    await expect(page.locator('#main h1')).toContainText('Summariser');
    await expect(page.locator('#main')).toContainText('draft');

    await page.locator('[data-status="published"]').click();
    await confirmDialog(page, 'Publish');
    await expect(page.locator('.leftpane')).toContainText(/summariser-8b\s*llama3\.1:8b\s*published/);
  });

  // B-11707: a profile on a template model inherits how the model thinks: a ceiling above off passes the checks with
  // no hand-written <think> instructions, and the profile publishes.
  test('B-11707: a profile on a template model inherits its thinking and publishes', async ({ page }) => {
    await open(page, 'profiles');
    await expectLive(page);
    await page.locator('[data-new]').first().click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-nn]').fill('reviewer-24b');
    await modal.locator('[data-nd]').fill('Reviewer');
    await modal.locator('[data-nm]').selectOption({ label: 'magistral:24b, confidential' });
    await modal.locator('[data-nl]').selectOption('internal');
    await modal.locator('[data-nds]').fill('Reasons through a case before answering');
    await modal.locator('[data-create]').click();
    await expect(page.locator('#main h1')).toContainText('Reviewer');
    await page.locator('[data-f="thinkCeiling"]').selectOption('high');
    await page.locator('[data-f="thinkDefault"]').selectOption('high');
    await expect(page.locator('#main')).toContainText('thinks through its own convention (template)');
    await page.locator('[data-save]').click();
    await expect(modal).toContainText('Save reviewer-24b as version 2');
    await modal.locator('[data-ok]').click();
    await expect(page.locator('[data-status="published"]')).toBeEnabled();
    await expect(page.locator('.tmsg')).toHaveCount(0, { timeout: 15_000 }); // the toasts fade before the contrast audit
    await expectAxeClean(page, 'aa', 'the profile editor with an inherited thinking mode');
    await page.locator('[data-status="published"]').click();
    await confirmDialog(page, 'Publish');
    await expect(page.locator('.leftpane')).toContainText(/reviewer-24b\s*magistral:24b\s*published/);
  });

  test('B-6901: trust marking is on by default and is switched off as a new version', async ({ page }) => {
    await open(page, 'profiles?profile=summariser-8b');
    const check = page.locator('input[data-key="trustMarking"]');
    await expect(check).toBeChecked();
    await check.uncheck();
    await page.locator('[data-save]').click();
    const modal = page.locator('#overlay .modal');
    await expect(modal).toContainText('Untrusted content marking');
    await modal.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('#toasts .toast').filter({ hasText: 'saved as version' }).first()).toBeVisible();
    await expect(page.locator('.pf-yaml')).toContainText('trustMarking: off');
  });

  test('B-7001, B-7002: a red-team suite runs against the saved settings, gates publishing while it fails, and its successful attacks are flags', async ({ page }) => {
    await open(page, 'profiles?profile=summariser-8b');
    await expectLive(page);
    await page.locator('[data-tab="evals"]').click();
    const panel = page.locator('#main .panel', { hasText: 'Red team' }).first();
    await expect(panel).toContainText('No red-team suites');

    // A suite from the built-in categories plus one case of our own.
    await panel.getByRole('button', { name: 'New suite' }).click();
    const modal = page.locator('#overlay .modal');
    await expect(modal).toContainText('Built-in attack categories');
    await modal.locator('[data-rn]').fill('Baseline');
    await modal.locator('[data-rc="injection"]').uncheck();
    await modal.getByRole('button', { name: 'Create suite' }).click();
    await toast(page, 'Red-team suite Baseline created');
    await expect(page.locator('#main')).toContainText('Publishing these settings is refused until: Baseline, not red-teamed for these settings');
    await expect(page.locator('#main')).toContainText('gates publishing');

    // The run: the test model echoes every prompt, so every canary comes back and every attack succeeds.
    await page.locator('[data-rtrun]').click();
    await toast(page, 'Red-team run queued');
    await expect(page.locator('#main')).toContainText(/resisted 0 of \d+ attacks/, { timeout: 60_000 });
    await page.locator('[data-rtresults]').first().click();
    const drawer = page.locator('#overlay .drawer');
    await expect(drawer).toContainText('Red-team run, Baseline');
    await expect(drawer).toContainText('Our own');
    await expect(drawer.locator('.pill', { hasText: 'succeeded' }).first()).toBeVisible();
    await expect(drawer.getByRole('link', { name: /^F-\d+$/ }).first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);

    // The suite is deleted with its runs; the gate is open again.
    await page.locator('[data-rtdel]').first().click();
    await confirmDialog(page, 'Delete suite');
    await toast(page, 'Red-team suite Baseline deleted');
    await expect(panel).toContainText('No red-team suites');
  });
});
