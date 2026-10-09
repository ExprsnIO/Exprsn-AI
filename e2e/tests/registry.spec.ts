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

  test('B-7701, B-7801: an agent gets an identity with a key shown once, and a draft lists its handoffs', async ({ page }) => {
    await open(page, 'registry?tab=agents');
    await expectLive(page);
    await page.locator('#main tr', { hasText: 'Expense checker' }).first().click();
    const card = page.locator('#main .panel', { hasText: 'Agent: Expense checker' });
    await expect(card).toContainText('none: runs act as their owner');

    // The identity: roles and a ceiling; a run then acts within both grants.
    await card.getByRole('button', { name: 'Identity' }).click();
    const modal = page.locator('#overlay .modal');
    await expect(modal).toContainText('Identity of Expense checker');
    await modal.locator('[data-iroles]').fill('member');
    await modal.locator('[data-iceil]').selectOption('internal');
    await modal.getByRole('button', { name: 'Save identity' }).click();
    await toast(page, 'Identity of Expense checker saved: member, ceiling internal');
    await expect(card).toContainText('Member, ceiling internal, 0 keys');

    // A key minted for it is shown once and listed by the agent.
    await card.getByRole('button', { name: 'Identity' }).click();
    await modal.getByRole('button', { name: 'Mint key' }).click();
    await modal.locator('[data-kn]').fill('robot');
    await modal.locator('[data-ks]').fill('agents:run, inference:invoke');
    await modal.getByRole('button', { name: 'Create key' }).click();
    await expect(modal).toContainText('Key minted, shown once');
    await expect(modal.locator('[data-newkey]')).toHaveText(/^exai_k1_/);
    await expect(modal).toContainText('robot');
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    // The card reads the identity again when the agent is selected.
    await page.locator('#main tr', { hasText: 'Expense checker' }).first().click();
    await expect(card).toContainText('Member, ceiling internal, 1 key');

    // A draft agent that hands the conversation to the published one.
    await page.getByRole('button', { name: 'Submit entry' }).click();
    await modal.locator('[data-kind]').selectOption('agent');
    await modal.locator('[data-name]').fill('Expense triage');
    await modal.locator('[data-version]').fill('1.0.0');
    await modal.locator('[data-desc]').fill('Routes expense questions to the expense checker and summarises what it found for the user.');
    await modal.locator('[data-label]').selectOption('internal');
    await modal.locator('[data-profile]').fill('general');
    await modal.locator('[data-handoffs]').fill('Expense checker');
    await modal.getByRole('button', { name: 'Save draft and run checks' }).click();
    await toast(page, 'Draft Expense triage 1.0.0 saved');
    await expect(page.locator('#main .inspector')).toContainText('Handoffs');
    await expect(page.locator('#main .inspector').getByRole('link', { name: 'agent:Expense checker' })).toBeVisible();
  });
});
