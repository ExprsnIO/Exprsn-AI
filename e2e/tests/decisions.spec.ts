import { test, expect, open, expectLive, toast } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';

/*
 * Sprint 46 (B-131, B-132): the Decision tables view of the Workflows screen (#/workflows?view=decisions): a table is
 * created, its rules edited in the grid (keyboard included), checked under another hit policy, published and tested;
 * then the designer offers the Decision step with the table picker and the Switch step with its cases.
 */
const uniq = () => Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
const modal = (page: import('@playwright/test').Page) => page.locator('#overlay .modal');
/** Toasts fade in and out; axe reads their colours mid-fade, so the checks wait for them to go. */
const noToasts = (page: import('@playwright/test').Page) => expect(page.locator('#toasts .toast')).toHaveCount(0, { timeout: 20_000 });

test.describe('Workflows: decision tables and the switch step', () => {
  test('creates, edits, checks, publishes and tests a decision table; the designer offers Decision and Switch steps', async ({ page }) => {
    const name = `approvals-${uniq()}`;
    await open(page, 'workflows?view=decisions');
    await expectLive(page);
    await expect(page.locator('#main h1', { hasText: 'Decision tables' })).toBeVisible();

    // New table: it starts with two rules (>= 1000 → review, anything → approve).
    await page.locator('#main [data-dec-new]').first().click();
    await modal(page).locator('[data-n]').fill(name);
    await modal(page).locator('[data-t]').fill('Expense approvals');
    await modal(page).locator('[data-go]').click();
    await toast(page, `${name} created as a draft with two rules`);
    await expect(page.locator('#main .leftpane')).toContainText('Expense approvals');
    const cell = (r: number, c: number) => page.locator(`#main [data-dec-cell="${r},${c}"]`);
    await expect(cell(0, 0)).toHaveValue('≥ 1000');
    await expect(cell(1, 0)).toHaveValue('-');

    // The grid: a third rule, cells typed as text, arrow keys between cells.
    await page.locator('#main [data-dec-radd]').click();
    await cell(2, 0).fill('[100..999]');
    await cell(2, 0).press('ArrowRight');
    await expect(cell(2, 1)).toBeFocused();
    await cell(2, 1).fill('manager');
    await cell(2, 1).press('ArrowUp');
    await expect(cell(1, 1)).toBeFocused();
    // Move the new rule above the catch-all, so it can be reached.
    await page.locator('#main [data-dec-rup="2"]').click();
    await expect(cell(1, 0)).toHaveValue('[100..999]');
    await page.locator('#main [data-dec-save]').click();
    await toast(page, 'Draft saved as revision 2');
    await expect(cell(1, 0)).toHaveValue('[100..999]');
    await expect(page.locator('#main')).toContainText('3 rules, valid');

    // Under unique the overlapping rules are problems to fix before publishing.
    await page.locator('#main [data-dec-policy]').selectOption('unique');
    await expect(page.locator('#main')).toContainText('problems to fix before publishing');
    await expect(page.locator('#main')).toContainText('overlap: some input matches both');
    await page.locator('#main [data-dec-policy]').selectOption('first');
    await expect(page.locator('#main')).not.toContainText('problems to fix before publishing');

    // Publish v1.
    await page.locator('#main [data-dec-publish]').click();
    await modal(page).locator('[data-note]').fill('First rules');
    await modal(page).locator('[data-go]').click();
    await toast(page, `${name} v1 published`);
    await expect(page.locator('#main')).toContainText('v1 published');

    // Columns tab: the input and output columns with their types.
    await page.locator('#main [data-tab="columns"]').click();
    await expect(page.locator('#main [data-dec-cname="in,0"]')).toHaveValue('amount');
    await expect(page.locator('#main [data-dec-cname="out,0"]')).toHaveValue('result');

    // Test tab: sample inputs against the published version, with the explanation.
    await page.locator('#main [data-tab="test"]').click();
    await page.locator('#main [data-dec-tver]').selectOption('published');
    await page.locator('#main [data-dec-tin="amount"]').fill('450');
    await page.locator('#main [data-dec-test]').click();
    await toast(page, 'Evaluated: 1 rule matched');
    await expect(page.locator('#main')).toContainText('is the first that matches');
    await expect(page.locator('#main')).toContainText('"manager"');
    await noToasts(page);
    await expectAxeClean(page, 'aa', 'Workflows, Decision tables, Test');
    for (const width of [320, 640]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(250);
      expect(await reflowProblems(page), `Decision tables at ${width} px`).toEqual([]);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('#main [data-tab="rules"]').click();
    await noToasts(page);
    await expectAxeClean(page, 'aa', 'Workflows, Decision tables, Rules');
    for (const width of [320, 640]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(250);
      expect(await reflowProblems(page), `Decision table rules at ${width} px`).toEqual([]);
    }
    await page.setViewportSize({ width: 1440, height: 900 });

    // Versions tab.
    await page.locator('#main [data-tab="versions"]').click();
    await expect(page.locator('#main')).toContainText('First rules');

    // The designer: a Decision step with the table picker, and a Switch step with its cases.
    await page.locator('#main [data-dec-back]').click();
    const wfName = `routing-${uniq()}`;
    await expect(page.locator('#main [data-new], #main [data-wf]').first()).toBeVisible();
    const first = page.locator('[data-new]').first();
    if (await first.count()) await first.click();
    else await page.locator('[data-wf]').selectOption('__new');
    await modal(page).locator('[data-name]').fill(wfName);
    await modal(page).locator('[data-go]').click();
    await toast(page, `${wfName} created as a draft`);
    await page.locator('.wf-palette [data-add="decision"]').click();
    const insp = page.locator('.inspector');
    await insp.locator('[data-dc="table"]').selectOption(name);
    await expect(insp).toContainText('Columns: amount (number)');
    await insp.locator('[data-dc="inputs"]').fill('amount: {{input.amount}}');
    await insp.locator('[data-dc="source"]').click();
    await expect(page.locator('.wf-node[data-node="decision1"]')).toContainText(`table ${name}, latest`);
    await page.locator('.wf-palette [data-add="switch"]').click();
    await expect(insp.locator('[data-sw="value"]')).toHaveValue('{{input.amount}}');
    await expect(insp.locator('[data-swc="0,label"]')).toHaveValue('small');
    await insp.locator('[data-swadd]').click();
    await expect(insp.locator('[data-swc="2,label"]')).toHaveValue('case3');
    await expect(page.locator('.wf-node[data-node="switch1"]')).toContainText('small, large, case3, default');
    await noToasts(page);
    await expectAxeClean(page, 'aa', 'Workflows, a switch step in the inspector');
  });
});
