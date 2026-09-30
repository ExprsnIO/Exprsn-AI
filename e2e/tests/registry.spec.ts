import { test, expect, open, expectLive, toast, confirmDialog, ready } from './support/fixtures';

test.describe('Registry', () => {
  test('an agent submitted by one admin is approved and published by another', async ({ page, as }) => {
    await open(page, 'registry');
    await expectLive(page);
    await expect(page.locator('#main').getByText('calculate').first()).toBeVisible();

    // Author: root submits an agent entry and sends it to review.
    await page.getByRole('button', { name: 'Submit entry' }).click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-kind]').selectOption('agent');
    await modal.locator('[data-name]').fill('Expense checker');
    await modal.locator('[data-version]').fill('1.0.0');
    await modal.locator('[data-desc]').fill('Checks expense claims against the travel policy and answers questions about them.');
    await modal.locator('[data-label]').selectOption('internal');
    await modal.locator('[data-profile]').fill('general');
    await modal.locator('[data-tools]').fill('calculate');
    await modal.getByRole('button', { name: 'Save draft and run checks' }).click();
    await toast(page, 'Draft Expense checker 1.0.0 saved');
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await confirmDialog(page, 'Submit');
    await toast(page, 'Expense checker is in the review queue');
    // The author cannot approve their own entry.
    await expect(page.locator('[data-approve]')).toBeDisabled();

    // Reviewer: root2 approves it for the whole tenant.
    const reviewer = await as('root2');
    await reviewer.goto('/#/registry');
    await ready(reviewer, 'registry');
    await reviewer.locator('[data-tab="agents"]').click();
    await reviewer.locator('#main tr', { hasText: 'Expense checker' }).click();
    await expect(reviewer.locator('[data-approve]')).toBeEnabled();
    await reviewer.locator('[data-approve]').click();
    await confirmDialog(reviewer);
    const publish = reviewer.locator('#overlay .modal');
    await expect(publish).toContainText('Publish Expense checker');
    await publish.getByRole('button', { name: 'Publish' }).click();
    await expect(reviewer.locator('#main tr', { hasText: 'Expense checker' })).toContainText('published');
  });
});
