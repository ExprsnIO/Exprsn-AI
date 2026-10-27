import { test, expect, open, toast, apiAs, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';
import { serverState } from './support/state';

/*
 * 1.8.0, Sprint 44 (B-122, B-123): the Apps screen's Reports tab (the run view with parameters, the grouped result
 * with group headers, subtotals and the grand total, formatting in words as well as colour, the run history) and
 * the designer with its live preview; exports of a report and of the Records tab as XLSX, PDF or CSV.
 */
const uniq = () => Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
const modal = (page: Page) => page.locator('#overlay .modal');

async function reflow(page: Page, where: string): Promise<void> {
  for (const width of [320, 640]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(250);
    expect.soft(await reflowProblems(page), `${where} at ${width} px`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(100);
}

async function pickApp(page: Page, title: string): Promise<void> {
  await page.locator('#main .leftpane [data-app]', { hasText: title }).click();
  await expect(page.locator('#main .page h1, #main .page .pagehead').first()).toContainText(title);
}

test.describe('Apps: reports and exports', () => {
  test('runs a grouped report with parameters, designs one with a live preview, and exports', async ({ page }) => {
    const id = uniq();
    const root = await apiAs('root');
    const appName = `rep_${id}`;
    await root.post('/api/apps', { name: appName, title: `Reports ${id}`, label: 'internal', workspaceId: serverState().workspace.id });
    await root.post(`/api/apps/${appName}/entities`, {
      name: 'deal',
      title: 'Deal',
      definition: { fields: [{ name: 'title', type: 'string', title: 'Title', required: true, indexed: true, maxLength: 80 }, { name: 'amount', type: 'number', title: 'Amount', indexed: true }, { name: 'region', type: 'string', title: 'Region', indexed: true, maxLength: 20 }] }
    });
    for (const [title, amount, region] of [['Acme', 100, 'West'], ['Bolt', 50, 'East'], ['Crux', 300, 'West'], ['Dyne', 25, 'North']] as const) await root.post(`/api/apps/${appName}/entities/deal/records`, { values: { title, amount, region } });
    await root.post(`/api/apps/${appName}/reports`, {
      name: 'pipeline',
      definition: {
        title: 'Pipeline by region',
        notes: 'Deals by region with totals.',
        source: { kind: 'entity', entity: 'deal', filters: [{ field: 'amount', op: 'gte', value: { param: 'min' } }] },
        parameters: [{ name: 'min', title: 'Smallest amount', type: 'number', default: 0 }],
        columns: [{ key: 'title' }, { key: 'amount' }],
        layout: { kind: 'grouped', groupBy: ['region'], aggregates: [{ op: 'count' }, { op: 'sum', column: 'amount' }] },
        sort: [{ column: 'amount', dir: 'desc' }],
        formatting: [{ column: 'amount', when: 'gte', value: 100, style: 'good', icon: 'up', text: 'large' }]
      }
    });

    await open(page, 'apps');
    await pickApp(page, `Reports ${id}`);
    await page.locator('#main [data-tab="reports"]').click();
    await expect(page.locator('#main .apps-rp h2')).toHaveText('Pipeline by region');

    // run it with a parameter: only rows of at least 50, grouped by region with subtotals and the grand total
    await page.getByLabel('Smallest amount').fill('50');
    await page.locator('#main [data-rp-run]').click();
    await toast(page, /Ran Pipeline by region: 3 rows/);
    const table = page.locator('#main .rp-res');
    await expect(table.locator('tr.rp-group')).toHaveCount(2);
    await expect(table.locator('tr.rp-group').first()).toContainText('Region: East');
    await expect(table.locator('tr.rp-total')).toContainText('Grand total (3 rows)');
    await expect(table.locator('tr.rp-total')).toContainText('450');
    // formatting carries words, not only colour
    await expect(table.locator('tr.rp-row', { hasText: 'Crux' }).locator('.rp-f-good')).toBeVisible();
    await expect(table.locator('tr.rp-row', { hasText: 'Crux' })).toContainText('large');
    await expect(page.locator('#main .inspector .rp-runs li')).toHaveCount(1);
    await expectAxeClean(page, 'aa', 'Apps, a report run');
    await reflow(page, 'apps: a report run');

    // export the report as CSV: a direct download
    await page.locator('#main [data-rp-export]').click();
    await expect(modal(page)).toContainText('Export Pipeline by region');
    await modal(page).getByLabel(/CSV/).check();
    await expectAxeClean(page, 'aa', 'Apps, the export dialog');
    const dl = page.waitForEvent('download');
    await modal(page).getByRole('button', { name: 'Export', exact: true }).click();
    const file = await dl;
    expect(file.suggestedFilename()).toMatch(/^pipeline-by-region-\d{4}-\d{2}-\d{2}\.csv$/);
    await expect(modal(page).locator('[data-ex-status]')).toContainText('Downloaded');
    await modal(page).getByRole('button', { name: 'Close' }).click();

    // design a new cross-tab report with a live preview
    await page.locator('#main [data-rp-new]').first().click();
    await page.locator('#main [data-path="name"]').fill(`cross_${id}`);
    await page.locator('#main [data-path="def.title"]').fill('Amount by region');
    await page.locator('#main [data-path="def.layout.kind"]').selectOption('crosstab');
    await page.locator('#main [data-path="def.layout.rows.0"]').selectOption('title');
    await page.locator('#main [data-path="def.layout.column"]').selectOption('region');
    await page.locator('#main [data-path="def.layout.values.0.op"]').selectOption('sum');
    await page.locator('#main [data-path="def.layout.values.0.column"]').selectOption('amount');
    const preview = page.locator('#main [data-rp-preview] .rp-res');
    await expect(preview.locator('thead')).toContainText('North');
    await expect(preview.locator('tr.rp-total')).toContainText('475');
    await expectAxeClean(page, 'aa', 'Apps, the report designer');
    await reflow(page, 'apps: the report designer');
    await page.locator('#main [data-rp-save]').first().click();
    await toast(page, /Created the report Amount by region/);
    await expect(page.locator('#main .apps-rp h2')).toHaveText('Amount by region');

    // the Records tab's Export offers the formats too
    await page.locator('#main [data-tab="records"]').click();
    await page.locator('#main [data-exportcsv]').click();
    await expect(modal(page)).toContainText('Excel workbook');
    const dl2 = page.waitForEvent('download');
    await modal(page).getByRole('button', { name: 'Export', exact: true }).click();
    expect((await dl2).suggestedFilename()).toMatch(/^deal-.*\.xlsx$/);
    await modal(page).getByRole('button', { name: 'Close' }).click();
    await root.close();
  });
});
