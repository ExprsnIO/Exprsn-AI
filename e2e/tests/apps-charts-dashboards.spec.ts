import { test, expect, open, toast, apiAs, settle, type Page } from './support/fixtures';
import { expectAccessible } from './support/a11y';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';
import { serverState } from './support/state';

/*
 * 1.8.0, Sprint 44 (B-120, B-121): charts and dashboards of an app. The Dashboards tab with a shared dashboard of a
 * bar chart, a line chart, a number tile, a saved view's table and a note; keyboard through a chart's points and its
 * table alternative; the dashboard filter; the layout's non-drag moves; the chart builder's live preview; both
 * accessibility checkers in Standard and Enhanced, light and dark; reflow at 320 and 640 px.
 */
const uniq = () => Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
const modal = (page: Page) => page.locator('#overlay .modal');
const setA11y = (page: Page, m: string) => page.evaluate((x) => (window as unknown as { App: { setA11y(m: string): void } }).App.setA11y(x), m);

const dealDefinition = {
  fields: [
    { name: 'title', type: 'string', required: true, indexed: true, unique: true, maxLength: 120 },
    { name: 'amount', type: 'number', indexed: true },
    { name: 'stage', type: 'enum', indexed: true, options: [{ value: 'Lead' }, { value: 'Won' }, { value: 'Lost' }] },
    { name: 'closed', type: 'date', indexed: true }
  ]
};

async function reflow(page: Page, where: string): Promise<void> {
  for (const width of [320, 640]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(350);
    expect.soft(await reflowProblems(page), `${where} at ${width} px`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(200);
}

test.describe('Apps: charts and dashboards', () => {
  test('a shared dashboard: keyboard through chart points, the table alternative, filters, layout, builder, AA and AAA, reflow', async ({ page }) => {
    const id = uniq();
    const root = await apiAs('root');
    const appName = `dash_${id}`;
    const A = `/api/apps/${appName}`;
    await root.post('/api/apps', { name: appName, title: `Insight ${id}`, label: 'internal', workspaceId: serverState().workspace.id });
    await root.post(`${A}/entities`, { name: 'deal', title: 'Deal', definition: dealDefinition });
    const stages = ['Lead', 'Won', 'Lost'];
    const create = Array.from({ length: 12 }, (_, i) => ({ values: { title: `Deal ${i}`, amount: (i + 1) * 100, stage: stages[i % 3], closed: `2026-${String((i % 4) + 7).padStart(2, '0')}-1${i % 9}` } }));
    await root.post(`${A}/entities/deal/records/bulk`, { create });
    const bar = await root.post(`${A}/charts`, { name: 'Amount by stage', shared: true, definition: { type: 'bar', source: { kind: 'entity', entity: 'deal' }, dimension: { field: 'stage' }, measures: [{ op: 'sum', field: 'amount' }, { op: 'count' }] } });
    const line = await root.post(`${A}/charts`, { name: 'Deals by month', shared: true, definition: { type: 'line', source: { kind: 'entity', entity: 'deal' }, dimension: { field: 'closed', bucket: 'month' }, split: { field: 'stage' }, measures: [{ op: 'count' }] } });
    const pie = await root.post(`${A}/charts`, { name: 'Share by stage', shared: true, definition: { type: 'donut', source: { kind: 'entity', entity: 'deal' }, dimension: { field: 'stage' }, measures: [{ op: 'count' }] } });
    const tile = await root.post(`${A}/charts`, { name: 'Won amount', shared: true, definition: { type: 'number', source: { kind: 'entity', entity: 'deal', filter: { field: 'stage', op: 'eq', value: 'Won' } }, measures: [{ op: 'sum', field: 'amount' }], compare: { kind: 'target', value: 1000 } } });
    const view = await root.post(`${A}/entities/deal/views`, { name: 'Won deals', shared: true, settings: { filters: [{ field: 'stage', op: 'eq', value: 'Won' }], columns: { fields: ['title', 'amount', 'closed'], meta: [] } } });
    await root.post(`${A}/dashboards`, {
      name: 'Pipeline',
      shared: true,
      description: 'Deals at a glance',
      filters: [{ id: 'when', kind: 'date', field: 'closed', label: 'Closed' }],
      cards: [
        { id: 'bar', kind: 'chart', chart: bar.id, size: 'large' },
        { id: 'tile', kind: 'chart', chart: tile.id, size: 'small' },
        { id: 'pie', kind: 'chart', chart: pie.id, size: 'small' },
        { id: 'line', kind: 'chart', chart: line.id, size: 'wide' },
        { id: 'won', kind: 'view', entity: 'deal', view: view.id, rows: 5, size: 'medium' },
        { id: 'note', kind: 'text', markdown: '## How to read this\n\nAmounts are **gross**.', size: 'full' }
      ]
    });

    await open(page, `apps?app=${appName}&tab=dashboards`);
    await settle(page);
    const barCard = page.locator('#main [data-adb-card="0"]');
    await expect(barCard.locator('h2')).toHaveText('Amount by stage');
    await expect(barCard.locator('svg.ach-svg')).toHaveAttribute('role', 'img');
    await expect(barCard.locator('svg.ach-svg')).toHaveAttribute('aria-label', /^Bar chart: Amount by stage\. 3 categories/);
    await expect(page.locator('#main [data-adb-card="1"] .ach-big')).toHaveText('2,600');
    await expect(page.locator('#main [data-adb-card="5"]')).toContainText('Amounts are gross.');
    await expect(page.locator('#main [data-adb-card="4"] table')).toContainText('Deal 1');

    // keyboard through the bar chart's points: Tab lands on the first, arrows move, names carry the values
    const pts = barCard.locator('.ach-pt');
    await expect(pts).toHaveCount(6);
    await barCard.locator('[data-ach-table]').focus();
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator(':focus')).toHaveAttribute('aria-label', /^Lead, Sum of amount: 2,200 \(1 of 3\)$/);
    await page.keyboard.press('ArrowRight');
    await expect(page.locator(':focus')).toHaveAttribute('aria-label', /^Lost, Sum of amount: 3,000 \(2 of 3\)$/);
    await page.keyboard.press('ArrowDown');
    await expect(page.locator(':focus')).toHaveAttribute('aria-label', /^Lost, Count: 4 \(2 of 3\)$/);
    await page.keyboard.press('End');
    await expect(page.locator(':focus')).toHaveAttribute('aria-label', /^Won, Count: 4/);
    await page.keyboard.press('Home');
    await expect(page.locator(':focus')).toHaveAttribute('aria-label', /^Lead, Sum of amount/);
    await expect(barCard.locator('.ach-pt[tabindex="0"]')).toHaveCount(1);
    // and on the line chart and the donut
    await page.locator('#main [data-adb-card="3"] .ach-pt').first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator(':focus')).toHaveAttribute('aria-label', /\(2 of \d\)$/);
    await page.locator('#main [data-adb-card="2"] .ach-pt').first().focus();
    await expect(page.locator(':focus')).toHaveAttribute('aria-label', /^Lead: 4, 33\.33 % \(1 of 3\)$/);

    // the table alternative, by keyboard
    const toggle = barCard.locator('[data-ach-table]');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const table = barCard.locator('.ach-table table');
    await expect(table).toBeVisible();
    await expect(table.locator('thead th')).toHaveText(['stage', 'Sum of amount', 'Count']);
    await expect(table.locator('tbody tr').first()).toContainText('Lead');
    await expect(table.locator('tbody tr').first()).toContainText('2,200');

    // the dashboard's date filter applies to the cards with that field
    await page.locator('#main [data-adb-fv="when"][data-part="from"]').fill('2026-07-01');
    await page.locator('#main [data-adb-fv="when"][data-part="to"]').fill('2026-07-31');
    await page.locator('#main [data-adb-fapply]').click();
    await settle(page);
    await expect(barCard.locator('svg.ach-svg')).toHaveAttribute('aria-label', /3 categories/);
    await expect(page.locator('#main [data-adb-card="1"] .ach-big')).toHaveText('500');
    await expect(page.locator('#main [data-app-subscribe][data-sub-kind="dashboard"]')).toBeVisible();
    await expect(page.locator('#main [data-adb-dl="pdf"]')).toHaveAttribute('href', /render\?format=pdf&filters=%7B%22when/);

    // accessibility of the tab, its table open, in Standard and Enhanced, light and dark
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(150);
      await expectAccessible(page, `apps dashboards (${scheme})`);
      await expectAxeClean(page, 'aa', `apps dashboards (${scheme})`);
      await setA11y(page, 'aaa');
      await page.waitForTimeout(150);
      await expectAxeClean(page, 'aaa', `apps dashboards (${scheme}), Enhanced`);
      await setA11y(page, 'aa');
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await reflow(page, 'apps: the dashboard grid and charts');

    // the layout: move a card later without dragging, resize it, save
    await page.locator('#main [data-adb-edit]').click();
    await expect(page.locator('#main [data-adb-edit]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#main [data-adb-down="0"]').click();
    await expect(page.locator('#main [data-adb-card="1"] h2')).toHaveText('Amount by stage');
    await expect(page.locator(':focus')).toHaveAttribute('data-adb-down', '1');
    await page.locator('#main [data-adb-size="1"]').selectOption('full');
    await toast(page, /to place 2 of 6/);
    await page.waitForTimeout(600); // the toast's fade-in, which axe would measure halfway
    await expectAxeClean(page, 'aa', 'apps dashboards, editing the layout');
    await reflow(page, 'apps: the dashboard layout editor');
    await page.locator('#main [data-adb-save]').click();
    await toast(page, /Saved the layout of Pipeline/);
    const saved = (await root.get(`${A}/dashboards`)).dashboards.find((d: { name: string }) => d.name === 'Pipeline');
    expect(saved.cards.map((c: { id: string; size: string }) => `${c.id}:${c.size}`).slice(0, 2)).toEqual(['tile:small', 'bar:full']);

    // the chart builder with its live preview
    await page.locator('#main [data-adb-newchart]').click();
    await expect(modal(page)).toContainText('New chart');
    await modal(page).locator('[data-acb="name"]').fill('Count by stage');
    await modal(page).locator('[data-acb="dim"]').selectOption('stage');
    await expect(modal(page).locator('[data-acb-preview] svg.ach-svg')).toHaveAttribute('aria-label', /^Bar chart: Count by stage/);
    await modal(page).locator('[data-acb="type"]').selectOption('pie');
    await expect(modal(page).locator('[data-acb-preview] svg.ach-svg')).toHaveAttribute('aria-label', /^Pie chart: Count by stage/);
    await expectAccessible(page, 'apps chart builder');
    await expectAxeClean(page, 'aa', 'apps chart builder');
    for (const width of [320, 640]) {
      await page.setViewportSize({ width, height: 800 });
      // The console labels scrolling tables in a pass after the resize: wait for it, not a fixed delay (slow under load).
      await page.waitForFunction(() => Array.from(document.querySelectorAll('.tablewrap,.codebox,pre,[data-scroll-x]')).every((el) => {
        const h = el as HTMLElement; const scrolls = h.scrollWidth > h.clientWidth + 1 || h.scrollHeight > h.clientHeight + 1;
        return !scrolls || h.hasAttribute('data-scrolls');
      }), undefined, { timeout: 3000 }).catch(() => undefined);
      expect.soft(await reflowProblems(page), `the chart builder at ${width} px`).toEqual([]);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await modal(page).locator('[data-acb-ok]').click();
    await toast(page, /Created the chart Count by stage/);
    await expect(page.locator('#main .adb-charts')).toContainText('Count by stage');
    await root.close();
  });
});
