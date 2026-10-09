import { test, expect, open, expectLive, toast, confirmDialog, apiAs, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { serverState } from './support/state';

/*
 * 1.6.0, Sprint 39c: B-8301 a description drafts the app's data model as a diff the designer accepts in one step;
 * B-8402 an AI field is filled over every row as a job with an estimate and progress; B-8501 an outside table is
 * attached to an entity, pulled, and a record written on the screen reaches it at once.
 */
const uniq = () => Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
const modal = (page: Page) => page.locator('#overlay .modal');

async function pickApp(page: Page, title: string): Promise<void> {
  await page.locator('#main .leftpane [data-app]', { hasText: title }).click();
  await expect(page.locator('#main .page h1, #main .page .pagehead').first()).toContainText(title);
}

test.describe('Apps: model drafts, AI fills, outside tables', () => {
  test('drafts the data model from a description, shows the diff and accepts it in one step', async ({ page }) => {
    const id = uniq();
    const root = await apiAs('root');
    await root.post('/api/apps', { name: `leave_${id}`, title: `Leave ${id}`, label: 'internal', workspaceId: serverState().workspace.id });
    await root.close();
    await open(page, 'apps');
    await expectLive(page);
    await pickApp(page, `Leave ${id}`);
    await page.locator('#main [data-draft]').first().click();
    const m = modal(page);
    await expect(m).toContainText('Draft the data model');
    await m.locator('[data-dr-prompt]').fill('A leave request app: employees submit requests for a date range; a manager approves or rejects them.');
    await m.locator('[data-dr-go]').click();
    await expect(m.locator('table')).toContainText('request');
    await expect(m).toContainText('state machine added');
    await expect(m).toContainText('no workflow named notify-manager');
    await expectAxeClean(page, 'aa', 'Apps, data model draft');
    await m.locator('[data-dr-save]').click();
    await toast(page, /Model applied: 2 created/);
    await expect(page.locator('#main [data-entityseg]')).toContainText('Leave request');
    await page.locator('#main [data-entityseg] [data-seg]', { hasText: 'Leave request' }).click();
    await expect(page.locator('#main svg.apps-sm')).toHaveAttribute('aria-label', /initial submitted/);
    await expect(page.locator('#main tr[data-field="days"]')).toContainText('formula');
  });

  test('estimates and fills an AI field over every row as a job', async ({ page }) => {
    const id = uniq();
    const root = await apiAs('root');
    const appName = `notes_${id}`;
    await root.post('/api/apps', { name: appName, title: `Notes ${id}`, label: 'internal', workspaceId: serverState().workspace.id });
    const profile = 'general'; // published on the e2e server
    await root.post(`/api/apps/${appName}/entities`, { name: 'note', title: 'Note', definition: { fields: [{ name: 'text', type: 'string', required: true, maxLength: 200 }, { name: 'summary', type: 'ai', profile, prompt: 'Summarise: {{upper(text)}}', maxLength: 200 }] } });
    await root.post(`/api/apps/${appName}/entities/note/records/bulk`, { create: Array.from({ length: 4 }, (_, i) => ({ values: { text: `item ${i}` } })) });
    await root.close();

    await open(page, 'apps');
    await pickApp(page, `Notes ${id}`);
    await expect(page.locator('#main')).toContainText('AI fills over every row');
    await page.locator('#main [data-fill-est="summary"]').click();
    await expect(page.locator('#main')).toContainText(/Estimate for summary \(empty\):/);
    await page.locator('#main [data-fill-go="summary"][data-scope="all"]').click();
    await expect(page.locator('#overlay')).toContainText('4 records');
    await confirmDialog(page, /Refresh|Fill|OK|Confirm/);
    await toast(page, /Fill .* started over 4 records/);
    await expect(page.locator('#main tr[data-fill]').first()).toContainText(/succeeded|running|queued/);
    await expect(page.locator('#main tr[data-fill]').first()).toContainText('succeeded', { timeout: 20_000 });
    await expect(page.locator('#main tr[data-fill]').first()).toContainText('4 done');
    await expectAxeClean(page, 'aa', 'Apps, Entities tab with AI fills');
  });

  test('attaches an outside table, pulls its rows in, and a record written on the screen reaches it', async ({ page }) => {
    const id = uniq();
    const root = await apiAs('root');
    const appName = `crm_${id}`;
    const conn = await root.post('/api/admin/connections', { name: `crm-${id}`, engine: 'postgres', endpoint: 'crm.internal:5432', database: 'crm', label: 'internal', username: 'app', password: 'right' });
    await root.post(`/api/admin/connections/${conn.id}/schema`);
    await root.put(`/api/admin/connections/${conn.id}/allow-list`, { objects: ['public.customers'], piiColumns: [] });
    await root.post('/api/apps', { name: appName, title: `CRM ${id}`, label: 'internal', workspaceId: serverState().workspace.id });
    await root.post(`/api/apps/${appName}/entities`, { name: 'customer', title: 'Customer', definition: { fields: [{ name: 'crm_id', type: 'number', indexed: true, unique: true }, { name: 'name', type: 'string', required: true, indexed: true, maxLength: 200 }, { name: 'tier', type: 'enum', indexed: true, options: [{ value: 'gold' }, { value: 'silver' }] }, { name: 'balance', type: 'number' }] } });
    await root.close();

    await open(page, 'apps');
    await pickApp(page, `CRM ${id}`);
    await page.locator('#main [data-src-attach]').click();
    const m = modal(page);
    await m.locator('[data-sr-conn]').selectOption(conn.id);
    await m.locator('[data-sr-object]').selectOption('public.customers');
    await m.locator('[data-sr-key]').fill('id');
    await m.locator('[data-sr-keyfield]').selectOption('crm_id');
    await m.locator('[data-sr-cols]').fill('crm_id=id');
    await m.locator('[data-sr-writes]').check();
    await m.locator('[data-sr-ok]').click();
    await toast(page, /Table attached/);
    await expect(page.locator('#main')).toContainText('public.customers');
    await expect(page.locator('#main')).toContainText('through to the table at once');
    await page.locator('#main [data-src-pull]').click();
    await toast(page, /Pull queued/);
    await expect(page.locator('#main')).toContainText(/2 rows, 2 created/, { timeout: 15_000 });
    await expectAxeClean(page, 'aa', 'Apps, Entities tab with an outside table');

    // the pulled rows are records; a record made here goes to the table, and the next pull keeps it
    await page.locator('#main [data-tab="records"]').click();
    await expect(page.locator('#main tr[data-rec]', { hasText: 'Contoso' })).toBeVisible();
    await page.locator('#main [data-newrec]').click();
    const rm = modal(page);
    await rm.locator('[data-fv="crm_id"]').fill('7');
    await rm.locator('[data-fv="name"]').fill('Northwind');
    await rm.locator('[data-fv="tier"]').selectOption('silver');
    await rm.locator('[data-rec-ok]').click();
    await toast(page, /Record .* created/);
    await page.locator('#main [data-tab="entities"]').click();
    await page.locator('#main [data-src-pull]').click();
    await toast(page, /Pull queued/);
    await expect(page.locator('#main')).toContainText(/3 rows, 0 created, 0 updated, 0 deleted, 3 unchanged/, { timeout: 15_000 });
  });
});
