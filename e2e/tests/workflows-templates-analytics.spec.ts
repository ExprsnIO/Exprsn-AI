import { test, expect, open, expectLive, toast, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';

/*
 * 1.8.0, Sprint 47 (B-136, B-138, B-139): the template gallery (#/workflows?view=templates: search, filters, preview,
 * the use-template dialog with its bindings), the schedule editor on a schedule trigger (preset, time zone, next
 * runs), save as template, the Analytics tab and the Running now view (#/workflows?view=activity). Axe-clean and
 * reflowing at 320 and 640 px.
 */
const uniq = () => Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
const modal = (page: Page) => page.locator('#overlay .modal');
const noToasts = (page: Page) => expect(page.locator('#toasts .toast')).toHaveCount(0, { timeout: 20_000 });

async function reflow(page: Page, where: string): Promise<void> {
  for (const width of [320, 640]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(250);
    expect(await reflowProblems(page), `${where} at ${width} px`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test.describe('Workflows: templates, schedules and analytics', () => {
  test('B-136, B-138: browses the gallery, makes a draft from a template, edits its schedule and saves it as a template', async ({ page, watch }) => {
    // The schedule that never runs is refused on purpose.
    watch.allow.push(/POST \/api\/workflow-schedules\/preview -> 422/);
    const name = `report-${uniq()}`;
    await open(page, 'workflows?view=templates');
    await expectLive(page);
    await expect(page.locator('#main h1', { hasText: 'Workflow templates' })).toBeVisible();
    await expect(page.locator('#main .wftpl-card')).toHaveCount(6, { timeout: 15_000 });

    // Search and filters.
    await page.locator('#main [data-wftpl-q]').fill('invoice');
    await expect(page.locator('#main .wftpl-card')).toHaveCount(1);
    await expect(page.locator('#main .wftpl-card')).toContainText('Invoice approval by amount');
    await page.locator('#main [data-wftpl-q]').fill('');
    await page.locator('#main [data-wftpl-cat]').selectOption('Reporting');
    await expect(page.locator('#main .wftpl-card')).toHaveCount(1);
    await page.locator('#main [data-wftpl-cat]').selectOption('');
    await page.locator('#main [data-wftpl-tag]').selectOption('approvals');
    await expect(page.locator('#main .wftpl-card')).toHaveCount(3);
    await page.locator('#main [data-wftpl-tag]').selectOption('');

    // Preview, keyboard-selected.
    const card = page.locator('#main .wftpl-card', { hasText: 'Weekly report' });
    await card.focus();
    await page.keyboard.press('Enter');
    await expect(card).toHaveAttribute('aria-pressed', 'true');
    const preview = page.locator('#main [aria-label="Template preview"]');
    await expect(preview).toContainText('report-writer');
    await expect(preview.locator('svg[role="img"]')).toBeVisible();
    await noToasts(page);
    await expectAxeClean(page, 'aa', 'the template gallery');
    await reflow(page, 'the template gallery');

    // Use it: every reference is listed with its status; bind the profile.
    await preview.locator('[data-wftpl-use]').click();
    await expect(modal(page)).toContainText('Saved query');
    await expect(modal(page).locator('[data-wftpl-bind]').first()).toBeVisible();
    await expectAxeClean(page, 'aa', 'the use-template dialog');
    const profile = modal(page).locator('[aria-label="Profile report-writer binds to"]');
    const options = await profile.locator('option').allTextContents();
    if (options.length > 1) await profile.selectOption({ index: 1 });
    await modal(page).locator('[data-wftpl-name]').fill(name);
    await modal(page).locator('[data-wftpl-go]').click();
    await toast(page, `${name} made from Weekly report as a draft`);

    // The designer shows the new draft; its trigger has the schedule editor.
    await expect(page.locator('#main [data-wf]')).toHaveValue(/.+/);
    await page.locator('.wf-node[data-node="trigger"]').click();
    const insp = page.locator('.inspector');
    await expect(insp.locator('[data-wfsch-cron]')).toHaveValue('0 8 * * 1');
    await insp.locator('[data-wfsch-preset]').selectOption('weekdays');
    await insp.locator('[data-wfsch-apply]').click();
    await toast(page, 'Schedule set: On weekdays, at 09:00');
    await expect(insp.locator('[data-wfsch-cron]')).toHaveValue('0 9 * * 1-5');
    await insp.locator('[data-wfsch-tz]').selectOption('Europe/Berlin');
    await expect(insp.locator('[data-wfsch-preview]')).toContainText('On weekdays, at 09:00 (Europe/Berlin)');
    await expect(insp.locator('[data-wfsch-preview] li')).toHaveCount(5);
    await expect(insp.locator('[data-wfsch-preview] li').first()).toContainText(/09:00 CES?T/);
    // A cron that never runs is explained in plain words.
    await insp.locator('[data-wfsch-cron]').fill('0 9 30 2 *');
    await insp.locator('[data-wfsch-cron]').press('Tab');
    await expect(insp.locator('[data-wfsch-preview]')).toContainText('never runs within a year');
    await insp.locator('[data-wfsch-cron]').fill('0 9 * * 1-5');
    await insp.locator('[data-wfsch-cron]').press('Tab');
    await expect(insp.locator('[data-wfsch-preview] li')).toHaveCount(5);
    await page.locator('.wf-toolbar [data-save]').click();
    await noToasts(page);
    await expectAxeClean(page, 'aa', 'the schedule editor');

    // Save as template.
    await page.locator('#main [data-wfsavetpl]').click();
    await modal(page).locator('[data-wftpl-sname]').fill(`${name}-tpl`);
    await modal(page).locator('[data-wftpl-stitle]').fill(`Weekday report ${name}`);
    await modal(page).locator('[data-wftpl-scat]').fill('Reporting');
    await modal(page).locator('[data-wftpl-ssum]').fill('Every weekday at 09:00 in Berlin.');
    await expectAxeClean(page, 'aa', 'the save-as-template dialog');
    await modal(page).locator('[data-wftpl-sgo]').click();
    await toast(page, `Weekday report ${name} saved to the template gallery`);
    await page.locator('#main [data-goview="templates"]').first().click();
    await expect(page.locator('#main .wftpl-card', { hasText: `Weekday report ${name}` })).toContainText('this tenant');
  });

  test('B-139: the Analytics tab and the Running now view', async ({ page }) => {
    await open(page, 'workflows');
    await expectLive(page);
    const tab = page.locator('#main [data-tab="analytics"]');
    if (await tab.count()) {
      await tab.click();
      await expect(page.locator('#main')).toContainText('Success rate');
      await expect(page.locator('#main')).toContainText('Runs by day');
      await page.locator('#main [data-wfan-range] [data-seg="7"]').click();
      await expect(page.locator('#main [data-wfan-range] [data-seg="7"]')).toHaveAttribute('aria-pressed', 'true');
      await noToasts(page);
      await expectAxeClean(page, 'aa', 'the Analytics tab');
    }
    await open(page, 'workflows?view=activity');
    await expect(page.locator('#main h1', { hasText: 'Running now' })).toBeVisible();
    await expect(page.locator('#main [aria-label="Running now"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#main')).toContainText('Workflows over the last 7 days');
    await page.locator('#main [data-act-filter] [data-seg="waiting"]').click();
    await expect(page.locator('#main [data-act-filter] [data-seg="waiting"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#main [data-act-days] [data-seg="30"]').click();
    await expect(page.locator('#main')).toContainText('Workflows over the last 30 days');
    await noToasts(page);
    await expectAxeClean(page, 'aa', 'the Running now view');
    await reflow(page, 'the Running now view');
    await page.locator('#main [data-act-back]').click();
    await expect(page.locator('#main h1', { hasText: 'Running now' })).toHaveCount(0);
  });
});
