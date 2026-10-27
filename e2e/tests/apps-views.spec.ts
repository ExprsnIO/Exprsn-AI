import { test, expect, open, toast, confirmDialog, apiAs, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';
import { serverState } from './support/state';

/*
 * The exprsn-platform low-code port, follow-ups 1 and 4 (docs/decisions/lowcode-port.md): saved views on the Records
 * tab (save as, save, unsaved changes, rename, share, default, delete) and the board paged per column on the server.
 */
const uniq = () => Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
const modal = (page: Page) => page.locator('#overlay .modal');

const dealDefinition = {
  fields: [
    { name: 'title', type: 'string', required: true, indexed: true, unique: true, maxLength: 120 },
    { name: 'amount', type: 'number', indexed: true },
    { name: 'stage', type: 'enum', indexed: true, options: [{ value: 'Lead' }, { value: 'Won' }, { value: 'Lost' }] }
  ],
  states: { initial: 'open', states: [{ name: 'open' }, { name: 'review' }, { name: 'closed' }], transitions: [{ from: ['open'], to: 'review' }, { from: ['review'], to: 'closed' }] }
};

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

test.describe('Apps: saved views and the paged board', () => {
  test('saves, changes, shares, defaults and deletes a view; the board pages a column with Load more', async ({ page }) => {
    const id = uniq();
    const root = await apiAs('root');
    const appName = `views_${id}`;
    await root.post('/api/apps', { name: appName, title: `Views ${id}`, label: 'internal', workspaceId: serverState().workspace.id });
    await root.post(`/api/apps/${appName}/entities`, { name: 'deal', title: 'Deal', definition: dealDefinition });
    const create = Array.from({ length: 30 }, (_, i) => ({ values: { title: `Lead ${String(i).padStart(2, '0')}`, amount: i, stage: 'Lead' } })).concat([{ values: { title: 'Winner', amount: 99, stage: 'Won' } }]);
    await root.post(`/api/apps/${appName}/entities/deal/records/bulk`, { create });

    await open(page, 'apps');
    await pickApp(page, `Views ${id}`);
    await page.locator('#main [data-tab="records"]').click();
    const picker = page.locator('#main .apps-views');
    await expect(picker).toContainText('No saved views yet');

    // Sort by amount, then save it as a private view that is also the default.
    await page.locator('#main [data-hsort="amount"]').click();
    await expect(page.locator('#main th[aria-sort="ascending"]')).toContainText('amount');
    await picker.locator('[data-vsaveas]').click();
    await modal(page).locator('[data-vs-name]').fill('Smallest first');
    await modal(page).locator('[data-vs-default]').check();
    await expectAxeClean(page, 'aa', 'Apps, save a view');
    await modal(page).locator('[data-vs-ok]').click();
    await toast(page, /Saved the view Smallest first/);
    await expect(picker.locator('[data-viewsel]')).toHaveValue(/.{26}/);
    await expect(picker).toContainText('Private view, your default');

    // A change shows as unsaved; Discard goes back to the view.
    await page.locator('#main [data-hsort="amount"]').click();
    await expect(page.locator('#main th[aria-sort="descending"]')).toContainText('amount');
    await expect(picker).toContainText('Unsaved changes');
    await picker.locator('[data-vdiscard]').click();
    await expect(page.locator('#main th[aria-sort="ascending"]')).toContainText('amount');
    await expect(picker).not.toContainText('Unsaved changes');

    // The board: by stage, each column paged from the server, Load more on the long one.
    await page.locator('#main [data-recview] [data-seg="board"]').click();
    await expect(page.locator('#main [data-bcol="open"] .apps-colhead')).toContainText('25 of 31');
    await page.locator('#main [data-boardby]').selectOption('stage');
    const lead = page.locator('#main [data-bcol="Lead"]');
    await expect(lead.locator('.apps-colhead')).toContainText('25 of 30');
    await expect(lead.locator('[data-bcard]')).toHaveCount(25);
    await expect(page.locator('#main [data-bcol="Won"]')).toContainText('Winner');
    await lead.locator('[data-bmore]').click();
    await expect(lead.locator('[data-bcard]')).toHaveCount(30);
    await expect(lead.locator('[data-bmore]')).toHaveCount(0);
    await expect(picker).toContainText('Unsaved changes');
    await expectAxeClean(page, 'aa', 'Apps, saved views and the paged board');
    await reflow(page, 'apps: the saved view picker and the paged board');

    // Save the board into the view, rename it with the keyboard, share it.
    await picker.locator('[data-vsave]').click();
    await toast(page, /Saved Smallest first/);
    await expect(picker).not.toContainText('Unsaved changes');
    await picker.locator('[data-vrename]').click();
    await modal(page).locator('[data-vr-name]').fill('Pipeline by stage');
    await modal(page).locator('[data-vr-name]').press('Enter');
    await toast(page, /Renamed to Pipeline by stage/);
    await picker.locator('[data-vshare]').click();
    await confirmDialog(page, 'Share');
    await toast(page, /shared with the app's readers/);
    await expect(picker.locator('[data-vshare]')).toHaveAttribute('aria-pressed', 'true');
    const listed = (await root.get(`/api/apps/${appName}/entities/deal/views`)).views as { name: string; shared: boolean; settings: { layout: string; groupBy: string } }[];
    expect(listed.find((v) => v.name === 'Pipeline by stage')).toMatchObject({ shared: true, settings: { layout: 'board', groupBy: 'stage' } });

    // The default opens on the next visit: the board by stage.
    await page.reload();
    await pickApp(page, `Views ${id}`);
    await page.locator('#main [data-tab="records"]').click();
    await expect(page.locator('#main [data-bcol="Lead"]')).toBeVisible();
    await expect(page.locator('#main .apps-views')).toContainText('Shared view, your default');

    // Clear the default, choose no view, then delete the view.
    await page.locator('#main .apps-views [data-vdefault]').click();
    await toast(page, /No default view/);
    await page.locator('#main .apps-views [data-vdelete]').click();
    await confirmDialog(page, 'Delete view');
    await toast(page, /Deleted the view Pipeline by stage/);
    await expect(page.locator('#main .apps-views')).toContainText('No saved views yet');
    expect((await root.get(`/api/apps/${appName}/entities/deal/views`)).views).toEqual([]);
    await root.close();
  });
});
