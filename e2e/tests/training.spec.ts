import { test, expect, open, expectLive, toast, confirmDialog, ready } from './support/fixtures';

test.describe('Training', () => {
  test.use({ user: 'mladmin' });

  test('registers a dataset version, submits a job on confidential data and a different admin approves it', async ({ page, as }) => {
    await open(page, 'training');
    await expectLive(page);
    await page.locator('[data-tab="datasets"]').click();
    await page.locator('[data-newds]').click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-dsn]').selectOption('new dataset');
    await modal.locator('[data-newname]').fill('finance-qa');
    await modal.locator('[data-lbl]').selectOption('confidential');
    await modal.locator('[data-path]').fill('finance-qa/2026-09-20/rows.jsonl');
    await modal.locator('[data-src]').fill('finance ticket export');
    await modal.locator('[data-ok]').click();
    await toast(page, 'finance-qa v1 registered; PII scrub running');
    // The scrub job masks the e-mail address and marks the version ready.
    const row = page.locator('#main tr', { hasText: 'finance-qa' }).first();
    await expect(async () => {
      await page.locator('[data-tab="datasets"]').click();
      await expect(row).toContainText('1 masked, report attached', { timeout: 1000 });
    }).toPass({ timeout: 20_000 });

    await page.locator('[data-tab="jobs"]').click();
    await page.locator('[data-newjob]').first().click();
    const job = page.locator('#overlay .modal');
    await job.locator('[data-n]').fill('finance-lora-e2e');
    await expect(job).toContainText('The job waits for an ML admin approval before training starts');
    await job.locator('[data-submit]').click();
    await toast(page, 'Waiting for ML admin approval');
    await expect(page.locator('[data-approvejob]')).toBeDisabled();

    // root (a system admin, so also an ML admin) approves it.
    const approver = await as('root');
    await approver.goto('/#/training');
    await ready(approver, 'training');
    await approver.locator('#main tr', { hasText: 'finance-lora-e2e' }).first().click();
    await approver.locator('[data-approvejob]').click();
    await confirmDialog(approver);
    await expect(approver.locator('#toasts')).toContainText('finance-lora-e2e approved and queued');
    await expect(approver.locator('[data-approvejob]')).toHaveCount(0);
  });
});
