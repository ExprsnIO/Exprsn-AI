import { test, expect, open, toast, confirmDialog, apiAs, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';
import { serverState } from './support/state';

/*
 * 1.8.0, Sprint 45 (B-128): many-to-many relations and back-references on the Apps screen: the relation column of
 * the Records table (titles, then +N), the inspector's Related records (paging, the add-link picker, Up and Down,
 * remove) and the relation field editor of the entity designer.
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

test.describe('Apps: relations and related records', () => {
  test('shows linked titles, links and unlinks from the record, reorders, and designs a relation field', async ({ page }) => {
    const id = uniq();
    const root = await apiAs('root');
    const appName = `rel_${id}`;
    await root.post('/api/apps', { name: appName, title: `Relations ${id}`, label: 'internal', workspaceId: serverState().workspace.id });
    await root.post(`/api/apps/${appName}/entities`, { name: 'company', title: 'Company', definition: { fields: [{ name: 'name', type: 'string', required: true, indexed: true, maxLength: 80 }] } });
    await root.post(`/api/apps/${appName}/entities`, {
      name: 'ticket',
      title: 'Ticket',
      definition: { fields: [{ name: 'title', type: 'string', required: true, indexed: true, maxLength: 80 }, { name: 'companies', type: 'relation', title: 'Companies', entity: 'company', inverse: 'tickets', inverseTitle: 'Tickets', twoWay: true }] }
    });
    const co: Record<string, string> = {};
    for (const n of ['Acme', 'Bolt', 'Crux', 'Dyne', 'Echo']) co[n] = (await root.post(`/api/apps/${appName}/entities/company/records`, { values: { name: n } })).id;
    const t = await root.post(`/api/apps/${appName}/entities/ticket/records`, { values: { title: `Printer ${id}`, companies: [co.Acme, co.Bolt, co.Dyne, co.Echo] } });

    await open(page, 'apps');
    await pickApp(page, `Relations ${id}`);
    await page.locator('#main [data-tab="records"]').click();
    await page.locator('#main [data-entityseg] [data-seg]', { hasText: 'Ticket' }).first().click();

    // The relation column: the first linked titles, then +N.
    const row = page.locator('#main tr[data-rec]', { hasText: `Printer ${id}` });
    await expect(row).toContainText('Acme, Bolt, Dyne');
    await expect(row).toContainText('+1');

    // The inspector's Related records: a page of five, the add-link picker, Up and Down, remove.
    await row.click();
    const panel = page.locator('#main .inspector .apps-rel', { hasText: 'Companies' });
    await expect(panel).toContainText('(4)');
    await expect(panel.locator('li')).toHaveCount(4);
    await panel.locator('[data-reladd]').click();
    await modal(page).locator('[data-rp-q]').fill('Cr');
    const link = modal(page).getByRole('button', { name: 'Link Crux' });
    await expect(link).toBeVisible();
    await expectAxeClean(page, 'aa', 'Apps, the add-link picker');
    await link.click();
    await expect(modal(page).locator('[data-rp-status]')).toContainText('Linked Crux');
    await modal(page).getByRole('button', { name: 'Done' }).click();
    await expect(panel).toContainText('(5)');

    await panel.getByRole('button', { name: 'Move Acme down' }).click();
    await toast(page, /Order saved/);
    const order = (await root.get(`/api/apps/${appName}/entities/ticket/records/${t.id}/links/companies`)).records.map((r: { title: string }) => r.title);
    expect(order.slice(0, 2)).toEqual(['Bolt', 'Acme']);

    await panel.getByRole('button', { name: 'Remove the link to Echo' }).click();
    await confirmDialog(page, 'Remove link');
    await toast(page, /Link removed/);
    await expect(panel).toContainText('(4)');
    await expectAxeClean(page, 'aa', 'Apps, related records');
    await reflow(page, 'apps: related records and the relation column');

    // The back-reference on the company, two-way: it lists the ticket.
    await page.locator('#main [data-entityseg] [data-seg]', { hasText: 'Company' }).first().click();
    await page.locator('#main tr[data-rec]', { hasText: 'Bolt' }).click();
    await expect(page.locator('#main .inspector .apps-rel', { hasText: 'Tickets' })).toContainText(`Printer ${id}`);

    // The relation field editor: target, cardinality, back-reference, on delete, max.
    await page.locator('#main [data-tab="entities"]').click();
    await page.locator('#main [data-entityseg] [data-seg]', { hasText: 'Ticket' }).first().click();
    await page.locator('#main [data-addfield]').click();
    const m = modal(page);
    await m.locator('[data-ff="name"]').fill('related');
    await m.locator('[data-ff="type"]').selectOption('relation');
    await m.locator('[data-ff="entity"]').selectOption('ticket');
    await m.locator('[data-ff="symmetric"]').check();
    await m.locator('[data-ff="onDelete"]').selectOption('block');
    await m.locator('[data-ff="max"]').fill('10');
    await expectAxeClean(page, 'aa', 'Apps, the relation field editor');
    await m.locator('[data-ff-ok]').click();
    await toast(page, 'Field related added.');
    await expect(page.locator('#main tr[data-field="related"]')).toContainText('many to many');
    const ent = await root.get(`/api/apps/${appName}/entities/ticket`);
    expect(ent.definition.fields.find((f: { name: string }) => f.name === 'related')).toMatchObject({ type: 'relation', entity: 'ticket', symmetric: true, onDelete: 'block', max: 10 });
    await root.close();
  });
});
