import { test, expect, open, expectLive, toast } from './support/fixtures';

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/*
 * 2.0.0, file management: documents created and edited in the console, duplicates, the spreadsheet grid, and the
 * Files dashboard and reports.
 */
test.describe('Files documents', () => {
  test.use({ user: 'member' });

  test('a member creates a Markdown document, edits it in the WYSIWYG editor, saves a version and duplicates it', async ({ page }) => {
    const name = `Notes ${uid()}`;
    await open(page, 'files');
    await expectLive(page);
    await page.locator('#main .page [data-newdoc]').click();
    await page.locator('#main .dropdown button[data-v="markdown"]').click();
    const nd = page.locator('#overlay .modal');
    await nd.locator('[data-nd-name]').fill(name);
    await nd.locator('[data-nd-ok]').click();
    await toast(page, `${name}.md created`);

    // The editor opens on the new file, once its scan has passed.
    const rich = page.locator('#main [data-fe-rich]');
    await expect(rich).toBeVisible({ timeout: 20_000 });
    await expect(rich.locator('h1')).toHaveText(name);
    await rich.locator('h1').click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Agenda for Monday');
    await page.locator('#main [data-fe-save]').click();
    await toast(page, /Saved as version 2/);

    // Back in Files: version 2 is current, the CID shows, and a duplicate is made.
    await page.locator('#main [data-fe-back]').click();
    const inspector = page.locator('#main aside.inspector');
    await expect(inspector).toContainText(`${name}.md`);
    await expect(inspector).toContainText('bafkrei');
    await inspector.locator('[data-dupfile]').click();
    const dup = page.locator('#overlay .modal');
    await expect(dup.locator('[data-dp-name]')).toHaveValue(`${name} copy.md`);
    await dup.locator('[data-dp-ok]').click();
    await toast(page, `${name} copy.md created (202)`);
  });

  test('a member creates a CSV table with typed columns and sees them in the grid', async ({ page }) => {
    const name = `ledger-${uid()}`;
    await open(page, 'files');
    await expectLive(page);
    await page.locator('#main .page [data-newdoc]').click();
    await page.locator('#main .dropdown button[data-v="csv"]').click();
    const nd = page.locator('#overlay .modal');
    await nd.locator('[data-nd-name]').fill(name);
    await nd.locator('[data-nd-columns]').fill('Item, Amount:number, Due:date');
    await nd.locator('[data-nd-ok]').click();
    await toast(page, `${name}.csv created`);
    const grid = page.locator('#main table.fe-grid');
    await expect(grid).toBeVisible({ timeout: 20_000 });
    await expect(grid.locator('thead')).toContainText('Amount');
    await expect(grid.locator('thead')).toContainText('number');
    await expect(grid.locator('thead')).toContainText('date');
  });

  test('the dashboard and the inventory report cover the workspace', async ({ page }) => {
    await open(page, 'files');
    await expectLive(page);
    await page.locator('#main [data-view="dashboard"]').click();
    await expect(page.locator('#main .page')).toContainText(/files/i);
    await expect(page.locator('#main .page .stat').first()).toBeVisible({ timeout: 15_000 });
    await page.locator('#main [data-view="reports"]').click();
    await expect(page.locator('#main .page table').first()).toBeVisible({ timeout: 15_000 });
  });
});
