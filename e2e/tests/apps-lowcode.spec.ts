import { test, expect, open, expectLive, toast, confirmDialog, apiAs, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { serverState } from './support/state';

/*
 * The exprsn-platform low-code port (docs/decisions/lowcode-port.md): the flow canvas with its condition builder on
 * Workflows, the records board, the column chooser and header sort, and the CSV import with a column mapping.
 */
const uniq = () => Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
const modal = (page: Page) => page.locator('#overlay .modal');

const dealDefinition = {
  fields: [
    { name: 'title', type: 'string', required: true, indexed: true, unique: true, maxLength: 120 },
    { name: 'amount', type: 'number', indexed: true },
    { name: 'stage', type: 'enum', indexed: true, options: [{ value: 'Lead' }, { value: 'Won' }, { value: 'Lost' }] },
    { name: 'notes', type: 'string', maxLength: 500 }
  ],
  states: { initial: 'open', states: [{ name: 'open' }, { name: 'review' }, { name: 'closed' }], transitions: [{ from: ['open'], to: 'review' }, { from: ['review'], to: 'closed' }] }
};

async function setupApp(id: string) {
  const root = await apiAs('root');
  const appName = `deals_${id}`;
  await root.post('/api/apps', { name: appName, title: `Deals ${id}`, label: 'internal', workspaceId: serverState().workspace.id });
  await root.post(`/api/apps/${appName}/entities`, { name: 'deal', title: 'Deal', definition: dealDefinition });
  return { root, appName };
}

async function pickApp(page: Page, title: string): Promise<void> {
  await page.locator('#main .leftpane [data-app]', { hasText: title }).click();
  await expect(page.locator('#main .page h1, #main .page .pagehead').first()).toContainText(title);
}

test.describe('Apps: the low-code port', () => {
  test('builds a flow on the canvas with a condition, publishes it as a workflow and it runs on a matching record', async ({ page }) => {
    const id = uniq();
    const { root, appName } = await setupApp(id);
    await open(page, 'apps');
    await expectLive(page);
    await pickApp(page, `Deals ${id}`);
    await page.locator('#main [data-tab="flows"]').click();
    await expect(page.locator('#main')).toContainText('No flows');
    await page.locator('#main [data-flownew]').click();

    // The trigger: a name, on created records.
    await page.locator('#main aside [data-fd="name"]').fill('won_deals');
    await page.locator('#main aside [data-fd="name"]').press('Tab');
    // The condition: stage equals Won.
    await page.locator('#main [data-fnode="condition"]').click();
    await page.locator('#main aside [data-cadd]').first().click();
    await page.locator('#main aside [data-cf]').selectOption('stage');
    await page.locator('#main aside [data-cv]').fill('Won');
    await page.locator('#main aside [data-cv]').press('Tab');
    await expect(page.locator('#main [data-fnode="condition"]')).toContainText('stage equals Won');
    // The action: update notes.
    await page.locator('#main [data-fnode="a0"]').click();
    await page.locator('#main aside [data-fvadd]').click();
    await page.locator('#main aside [data-fvk="0"]').selectOption('notes');
    await page.locator('#main aside [data-fvv="0"]').fill('won: {{input.record.values.title}}');
    await page.locator('#main aside [data-fvv="0"]').press('Tab');
    await expectAxeClean(page, 'aa', 'Apps, flow canvas');
    await page.locator('#main [data-fsave]').click();
    await toast(page, /Flow won_deals saved; workflow app-deals-.*-won-deals published as version 1/);
    await expect(page.locator('#main tr[data-flow]')).toContainText('won_deals');

    // A matching record gets the note; another does not.
    const won = await root.post(`/api/apps/${appName}/entities/deal/records`, { values: { title: 'Kilo', stage: 'Won' } });
    const lost = await root.post(`/api/apps/${appName}/entities/deal/records`, { values: { title: 'Lima', stage: 'Lost' } });
    await expect.poll(async () => (await root.get(`/api/apps/${appName}/entities/deal/records/${won.id}`)).values.notes, { timeout: 20_000 }).toBe('won: Kilo');
    expect((await root.get(`/api/apps/${appName}/entities/deal/records/${lost.id}`)).values.notes).toBeUndefined();

    // The runs show under the flow; a dry run on a record changes nothing.
    await page.locator('#main [data-fruns]').click();
    await expect(page.locator('#main a[data-gorun]').first()).toBeVisible();
    await page.locator('#main [data-ftestrun]').click();
    await modal(page).locator('[data-ft-go]').click();
    await expect(modal(page)).toContainText('Dry run');
    await page.keyboard.press('Escape');
    await expect(page.locator('#overlay')).toHaveCount(0);

    // Deleting the flow deletes its workflow.
    await page.locator('#main [data-fdelflow]').click();
    await confirmDialog(page, 'Delete flow');
    await toast(page, /Flow deleted/);
    await expect(page.locator('#main')).toContainText('No flows');
    await root.close();
  });

  test('the board moves a card by transition, columns are chosen and sorted from the header, and a CSV is mapped on import', async ({ page }) => {
    const id = uniq();
    const { root, appName } = await setupApp(id);
    await root.post(`/api/apps/${appName}/entities/deal/records/bulk`, { create: [{ values: { title: 'Alpha', amount: 3, stage: 'Lead' } }, { values: { title: 'Bravo', amount: 1, stage: 'Won' } }] });
    await open(page, 'apps');
    await pickApp(page, `Deals ${id}`);
    await page.locator('#main [data-tab="records"]').click();

    // Header sort on an indexed field.
    await page.locator('#main [data-hsort="amount"]').click();
    await expect(page.locator('#main th[aria-sort="ascending"]')).toContainText('amount');
    await expect(page.locator('#main tr[data-rec]').first()).toContainText('Bravo');
    // The column chooser hides a field.
    await page.locator('#main [data-columns]').click();
    await modal(page).locator('[data-colf="amount"]').uncheck();
    await modal(page).locator('[data-col-ok]').click();
    await expect(page.locator('#main [data-hsort="amount"]')).toHaveCount(0);

    // The board, by state: Alpha moves from open to review.
    await page.locator('#main [data-recview] [data-seg="board"]').click();
    await expect(page.locator('#main [data-bcol="open"]')).toContainText('Alpha');
    await expectAxeClean(page, 'aa', 'Apps, records board');
    const card = page.locator('#main [data-bcard]', { hasText: 'Alpha' });
    await card.locator('[data-bmove]').selectOption('review');
    await toast(page, /is now review/);
    await expect(page.locator('#main [data-bcol="review"]')).toContainText('Alpha');
    // By stage: a field move.
    await page.locator('#main [data-boardby]').selectOption('stage');
    await page.locator('#main [data-bcard]', { hasText: 'Bravo' }).locator('[data-bmove]').selectOption('Lost');
    await toast(page, /moved to Lost/);
    await page.locator('#main [data-recview] [data-seg="table"]').click();

    // CSV import with the columns mapped by title, one skipped (since Sprint 45, B-127, the import stepper).
    await page.locator('#main [data-importcsv]').click();
    const m = modal(page);
    await m.locator('[data-ai-kind] [data-seg="text"]').click();
    await m.locator('[data-ai-text]').fill('Title,Stage,Ignored\nCharlie,Won,x\nDelta,Lead,y\n');
    await m.locator('[data-ai-next]').click();
    await expect(m.locator('[data-ai-content] table')).toContainText('Charlie', { timeout: 10_000 });
    await m.locator('[data-ai-next]').click();
    await expect(m.locator('[data-ai-map-col="0"]')).toHaveValue('title');
    await expect(m.locator('[data-ai-map-col="1"]')).toHaveValue('stage');
    await expect(m.locator('[data-ai-map-col="2"]')).toHaveValue('');
    await m.locator('[data-ai-next]').click();
    await m.locator('[data-ai-dryrun]').click();
    await expect(m).toContainText('Dry run finished', { timeout: 30_000 });
    await m.locator('[data-ai-next]').click();
    await m.locator('[data-ai-import]').click();
    await m.locator('[data-ai-confirm]').click();
    await toast(page, /Import of 2 rows queued/);
    await expect.poll(async () => (await root.get(`/api/apps/${appName}/entities/deal/records?limit=10`)).total, { timeout: 20_000 }).toBe(4);
    await root.close();
  });
});
