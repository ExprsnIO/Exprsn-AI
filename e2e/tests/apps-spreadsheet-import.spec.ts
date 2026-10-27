import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, open, expectLive, apiAs, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { serverState } from './support/state';

/*
 * Sprint 45 (B-127): the import stepper on Apps. A workbook goes to the file store (quarantine and scan), its second
 * sheet is read with the header on row 3, a transformation is added and previewed, the dry run reports every row,
 * and the import writes them; "New entity from file" infers the fields from pasted rows, the designer skips one, and
 * the entity is created and filled. Each step is checked with axe and at 320 and 640 px.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const uniq = () => Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
const modal = (page: Page) => page.locator('#overlay .modal');

/** The dialog fits the window at 320 and 640 px: nothing scrolls sideways but named table scrollers. */
async function reflow(page: Page, where: string): Promise<void> {
  for (const width of [320, 640]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(250);
    const problems = await page.evaluate(() => {
      const out: string[] = [];
      const box = document.querySelector('#overlay > .modal') as HTMLElement | null;
      if (!box) return ['no dialog'];
      if (document.scrollingElement!.scrollWidth > window.innerWidth + 1) out.push('the page scrolls sideways');
      if (box.scrollWidth > box.clientWidth + 1) out.push(`the dialog scrolls sideways by ${box.scrollWidth - box.clientWidth} px`);
      const edge = Math.min(window.innerWidth, box.getBoundingClientRect().right);
      const scrollers = Array.from(box.querySelectorAll('.tablewrap,.codebox,pre,textarea,[data-scroll-x]'));
      for (const el of Array.from(box.querySelectorAll('*'))) {
        if (!(el instanceof HTMLElement) || !el.getClientRects().length) continue;
        const cs = getComputedStyle(el);
        if (/(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1 && !el.matches('.tablewrap,.codebox,pre,textarea,[data-scroll-x]')) out.push(`${el.tagName.toLowerCase()}.${el.className} scrolls sideways`);
        const r = el.getBoundingClientRect();
        if (r.width >= 2 && r.right > edge + 1 && !scrollers.some((s) => s.contains(el))) out.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 30)} sticks out`);
      }
      return [...new Set(out)].slice(0, 10);
    });
    expect.soft(problems, `${where} at ${width} px`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(100);
}

async function pickApp(page: Page, title: string): Promise<void> {
  await page.locator('#main .leftpane [data-app]', { hasText: title }).click();
  await expect(page.locator('#main .page h1, #main .page .pagehead').first()).toContainText(title);
}

test.describe('Apps: spreadsheet import (B-127)', () => {
  test('imports a workbook sheet with its header on row 3, a transformation, the dry run and the import', async ({ page }) => {
    const id = uniq();
    const root = await apiAs('root');
    const appName = `orders_${id}`;
    await root.post('/api/apps', { name: appName, title: `Orders ${id}`, label: 'internal', workspaceId: serverState().workspace.id });
    await root.post(`/api/apps/${appName}/entities`, {
      name: 'order',
      title: 'Order',
      definition: {
        fields: [
          { name: 'ref', title: 'Order ref', type: 'string', required: true, unique: true, indexed: true, maxLength: 20 },
          { name: 'customer', title: 'Customer', type: 'string', maxLength: 100 },
          { name: 'amount', title: 'Amount', type: 'number' },
          { name: 'paid', title: 'Paid', type: 'boolean' }
        ]
      }
    });
    await open(page, 'apps');
    await expectLive(page);
    await pickApp(page, `Orders ${id}`);
    await page.locator('#main [data-tab="records"]').click();
    await page.locator('#main [data-importcsv]').click();
    const m = modal(page);
    await expect(m.locator('[aria-current="step"]')).toContainText('Source');

    // Step 1: the file goes to the file store and passes its scan.
    await m.locator('[data-ai-file]').setInputFiles(path.join(here, 'fixtures', 'orders.xlsx'));
    await expect(m).toContainText('passed its scan and is ready', { timeout: 30_000 });
    await expectAxeClean(page, 'aa', 'Apps import, source');
    await m.locator('[data-ai-next]').click();

    // Step 2: the second sheet, its header on row 3.
    await expect(m.locator('[data-ai-sheet]')).toBeVisible();
    await m.locator('[data-ai-sheet]').selectOption('Orders');
    await m.locator('[data-ai-header]').fill('3');
    await m.locator('[data-ai-header]').press('Tab');
    await expect(m.locator('[data-ai-content] table')).toContainText('Order ref', { timeout: 10_000 });
    await expect(m.locator('[data-ai-content]')).toContainText('Contoso');
    await expectAxeClean(page, 'aa', 'Apps import, sheet and range');
    await reflow(page, 'Apps import, sheet and range');
    await m.locator('[data-ai-next]').click();

    // Step 3: the columns mapped by title; a transformation, previewed by the server.
    await expect(m.locator('[data-ai-map-col="0"]')).toHaveValue('ref');
    await expect(m.locator('[data-ai-map-col="1"]')).toHaveValue('customer');
    await m.locator('[data-ai-add]').selectOption('case');
    await m.locator('[data-ai-tcols]').selectOption(['Customer']);
    await m.locator('[data-ai-to]').selectOption('upper');
    await m.locator('[data-ai-tok]').click();
    await expect(m.locator('.apps-ai-tlist')).toContainText('Make Customer upper case');
    await expect(m.locator('[data-ai-content]')).toContainText('CONTOSO', { timeout: 10_000 });
    await expectAxeClean(page, 'aa', 'Apps import, mapping');
    await page.evaluate(() => (window as unknown as { App: { setA11y(m: string | null): void } }).App.setA11y('aaa'));
    await expectAxeClean(page, 'aaa', 'Apps import, mapping (Enhanced)');
    await page.evaluate(() => (window as unknown as { App: { setA11y(m: string | null): void } }).App.setA11y(null));
    await reflow(page, 'Apps import, mapping');
    // Keyboard: the Next button is reachable and works from the keyboard.
    await m.locator('[data-ai-next]').focus();
    await page.keyboard.press('Enter');

    // Step 4: the dry run writes nothing and reports the rows.
    await expect(m.locator('[aria-current="step"]')).toContainText('Dry run');
    await m.locator('[data-ai-dryrun]').click();
    await expect(m).toContainText('Dry run finished', { timeout: 30_000 });
    await expect(m.locator('.apps-ai-stats')).toContainText('3would be created');
    expect((await root.get(`/api/apps/${appName}/entities/order/records?limit=10`)).total).toBe(0);
    await expectAxeClean(page, 'aa', 'Apps import, dry run');
    await m.locator('[data-ai-next]').click();

    // Step 5: the import, confirmed inline, with its outcome.
    await m.locator('[data-ai-import]').click();
    await m.locator('[data-ai-confirm]').click();
    await expect(m).toContainText('Import finished', { timeout: 30_000 });
    await expect(m.locator('.apps-ai-stats')).toContainText('3created');
    await reflow(page, 'Apps import, done');
    const recs = await root.post(`/api/apps/${appName}/entities/order/records/query`, { sort: [{ field: 'ref', dir: 'asc' }] });
    expect(recs.records.map((r: { values: { ref: string; customer: string } }) => [r.values.ref, r.values.customer])).toEqual([['A-100', 'CONTOSO'], ['A-101', 'FABRIKAM'], ['A-102', 'NORTHWIND']]);
    await m.locator('[data-ai-finish]').click();
    await expect(m).toHaveCount(0);
    await root.close();
  });

  test('creates a new entity from pasted rows: inferred fields, one skipped, created and filled', async ({ page }) => {
    const id = uniq();
    const root = await apiAs('root');
    const appName = `accounts_${id}`;
    await root.post('/api/apps', { name: appName, title: `Accounts ${id}`, label: 'confidential', workspaceId: serverState().workspace.id });
    await open(page, 'apps');
    await pickApp(page, `Accounts ${id}`);
    await page.locator('#main [data-tab="entities"]').click();
    await page.locator('#main [data-entityfromfile]').click();
    const m = modal(page);
    await m.locator('[data-ai-kind] [data-seg="text"]').click();
    await m.locator('[data-ai-text]').fill('Code,Contact e-mail,Seats,Plan,Notes\nC-1,a@example.com,3,basic,first\nC-2,b@example.com,5,pro,\nC-3,c@example.com,1,basic,third\nC-4,d@example.com,2,pro,fourth\n');
    await m.locator('[data-ai-next]').click();
    await expect(m.locator('[data-ai-content] table')).toContainText('Contact e-mail', { timeout: 10_000 });
    await m.locator('[data-ai-next]').click();

    // Step 3: the proposal, with the e-mail column flagged.
    await expect(m.locator('[data-ai-cname="0"]')).toHaveValue('code', { timeout: 10_000 });
    await expect(m.locator('[data-ai-ctype="2"]')).toHaveValue('integer');
    await expect(m.locator('[data-ai-ctype="3"]')).toHaveValue('enum');
    await expect(m.locator('[data-ai-content]')).toContainText('email in 4 rows');
    await m.locator('[data-ai-ename]').fill('account');
    await m.locator('[data-ai-cname="1"]').fill('email');
    await m.locator('[data-ai-ckeep="4"]').uncheck();
    await expectAxeClean(page, 'aa', 'Apps new entity from file, fields');
    await reflow(page, 'Apps new entity from file, fields');
    await m.locator('[data-ai-next]').click();

    // Step 4: create through the design path, then import.
    await m.locator('[data-ai-create]').click();
    await expect(m).toContainText('Import finished', { timeout: 30_000 });
    await expect(m.locator('.apps-ai-stats')).toContainText('4created');
    const ent = await root.get(`/api/apps/${appName}/entities/account`);
    expect(ent.definition.fields.map((f: { name: string }) => f.name)).toEqual(['code', 'email', 'seats', 'plan']);
    expect(ent.label).toBe('confidential');
    await m.locator('[data-ai-done]').click();
    await expect(page.locator('#main [data-entityseg]')).toContainText('account');
    await root.close();
  });
});
