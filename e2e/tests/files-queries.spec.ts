import { test, expect, open, expectLive, toast } from './support/fixtures';

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
type Api = { App: { post(u: string, b: unknown): Promise<{ id: string; name: string }> } };

/*
 * Files, the table builder: a member starts a query from a CSV file, sees the detected types as the first step, groups
 * by a column from the ribbon, filters from a column menu, steps back through Applied steps, then saves the query and
 * loads its result into a new workbook.
 */
test.describe('Files table builder', () => {
  test.use({ user: 'member' });

  test('a member builds a grouped table from a CSV file and loads it into a new workbook', async ({ page }) => {
    const name = `sales-${uid()}`;
    await open(page, 'files');
    await expectLive(page);
    const file = await page.evaluate((n) => (window as unknown as Api).App.post('/api/files/documents', {
      name: n, kind: 'csv', label: 'internal',
      workbook: { sheets: [{ name: 'Sheet1', header: true, columns: [], rows: [['Region', 'Rep', 'Amount'], ['North', 'Ann', '1200'], ['South', 'Bob', '300'], ['North', 'Cy', '50'], ['West', 'Dee', '10']].map((r) => r.map((v) => ({ v }))) }] }
    }), name);

    await page.goto('/#/file-query?file=' + file.id);
    const grid = page.locator('#main table.fq-grid');
    await expect(grid).toBeVisible({ timeout: 20_000 });
    await expect(grid.locator('thead')).toContainText('Amount');
    const steps = page.locator('#main [aria-label="Applied steps"]');
    await expect(steps).toContainText('Changed type: Amount to integer');

    // Group by Region with a sum of Amount, from the ribbon.
    await grid.locator('[data-fq-col="Region"]').click();
    await page.locator('#main [data-fq-cmd="group"]').click();
    const g = page.locator('#overlay .modal');
    await g.locator('[data-fq-as]').fill('Total');
    await g.locator('[data-fq-afn]').selectOption('sum');
    await g.locator('[data-fq-acol]').selectOption('Amount');
    await g.locator('[data-fq-ok]').click();
    await expect(steps).toContainText('Grouped by Region');
    await expect(grid.locator('tbody tr')).toHaveCount(3);
    await expect(grid.locator('tbody tr').first()).toContainText('1250');

    // Filter from the column menu: keep totals of at least 100.
    await grid.locator('[data-fq-cmenu="Total"]').click();
    await page.locator('#main .dropdown [data-v="filter"]').click();
    const f = page.locator('#overlay .modal');
    await f.locator('[data-fq-ft="1"]').click();
    await f.locator('[data-fq-op="0"]').selectOption('gte');
    await f.locator('[data-fq-cv="0"]').fill('100');
    await f.locator('[data-fq-ok]').click();
    await expect(steps).toContainText('Filtered rows: Total is greater than or equal to 100');
    await expect(grid.locator('tbody tr')).toHaveCount(2);

    // A step chosen in Applied steps shows the table after it.
    await steps.locator('[data-fq-sel="0"]').click();
    await expect(grid.locator('tbody tr')).toHaveCount(4);
    await steps.locator('[data-fq-sel="2"]').click();
    await expect(grid.locator('tbody tr')).toHaveCount(2);

    // Close and load: the query is saved first, then written into a new workbook.
    await page.locator('#main [data-fq-loadto]').click();
    const s = page.locator('#overlay .modal');
    await s.locator('[data-fq-qn]').fill(`Totals ${name}`);
    await s.locator('[data-fq-ok]').click();
    await toast(page, `Saved the query Totals ${name}.`);
    const l = page.locator('#overlay .modal');
    await expect(l.locator('[data-fq-fn]')).toHaveValue(`Totals ${name}`);
    await l.locator('[data-fq-load]').click();
    await toast(page, /Loaded 2 rows into Totals .*\.xlsx/);
    await expect(page.locator('#main [data-fq-refresh]')).toBeVisible();
    await page.locator('#main [data-fq-refresh]').click();
    await toast(page, /Refreshed Totals .*\.xlsx/);
  });
});
