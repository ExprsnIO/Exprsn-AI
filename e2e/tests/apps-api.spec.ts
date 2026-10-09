import { test, expect, open, expectLive, toast, confirmDialog, apiAs } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { serverState } from './support/state';

/*
 * 1.6.0, Sprint 39d (B-8601 to B-8603, B-8701, B-8702): the Apps screen's API tab (schema versions, OpenAPI and the
 * client) and Embed tab (settings, keys, public pages); a published form's embed page opens on its own and submits.
 */
const uniq = () => Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
const modal = (page: import('@playwright/test').Page) => page.locator('#overlay .modal');

test.describe('Apps: API and Embed', () => {
  test('the API tab lists the entity API, the schema versions and the documents; the Embed tab publishes a form that embeds and submits', async ({ page }) => {
    const id = uniq();
    const appName = `tickets_${id}`;
    const root = await apiAs('root');
    const ws = (await root.get('/api/me')).workspaces[0];
    await root.post('/api/apps', { name: appName, title: `Tickets ${id}`, label: 'internal', workspaceId: ws.id });
    await root.post(`/api/apps/${appName}/entities`, { name: 'ticket', title: 'Ticket', label: 'internal', definition: { fields: [{ name: 'subject', type: 'string', required: true, indexed: true, maxLength: 120 }, { name: 'priority', type: 'enum', indexed: true, options: [{ value: 'low' }, { value: 'high' }] }], states: { initial: 'open', states: [{ name: 'open' }, { name: 'closed' }], transitions: [{ from: ['open'], to: 'closed' }] } } });
    await root.post(`/api/apps/${appName}/forms`, { name: 'report', title: 'Report a problem', entity: 'ticket', definition: { fields: [{ field: 'subject', label: 'What happened' }, { field: 'priority' }] } });
    await root.post(`/api/apps/${appName}/forms/report/public`, { enabled: true });
    await root.close();

    await open(page, 'apps');
    await expectLive(page);
    await page.locator('#main .leftpane [data-app]', { hasText: `Tickets ${id}` }).click();

    // API tab: routes per entity, the version and hash, the versions table.
    await page.locator('[data-tab="api"]').click();
    await expect(page.locator('#main')).toContainText(`/api/apps/${appName}/ticket/{id}/transition`);
    await expect(page.locator('#main')).toContainText('open, closed');
    await expect(page.locator('#main')).toContainText('entity.created');
    await expect(page.locator('#main')).toContainText('form.created');
    await expect(page.locator('#main a', { hasText: `/api/apps/${appName}/openapi.json` })).toBeVisible();
    await expectAxeClean(page, 'aa', 'Apps, API tab');
    // The documents answer with the schema version.
    const openapi = await page.request.get(`${serverState().url}/api/apps/${appName}/openapi.json`);
    expect(openapi.ok()).toBe(true);
    expect((await openapi.json()).info.version).toBe('2');

    // Embed tab: hosts, public pages on, a key, a page.
    await page.locator('[data-tab="embed"]').click();
    await expect(page.locator('#main')).toContainText('No keys');
    await page.locator('[data-emhosts]').fill('https://partner.example.com');
    await page.locator('[data-empublic]').click();
    await page.locator('[data-emsave]').click();
    await toast(page, 'Embed settings saved');
    await expect(page.locator('#main')).toContainText("'self' https://partner.example.com");
    await page.locator('[data-emaddkey]').click();
    await modal(page).locator('[data-kid]').fill('partner-1');
    await modal(page).locator('[data-alg]').selectOption('HS256');
    await modal(page).locator('[data-go]').click();
    await toast(page, 'Key partner-1 added');
    await expect(page.locator('#main')).toContainText('Copy it now; it is shown once');
    await page.locator('[data-emsecretdone]').click();
    await expect(page.locator('#main [data-emkey]')).toContainText('partner-1');
    await page.locator('[data-emaddpage]').click();
    await modal(page).locator('[data-go]').click();
    await toast(page, 'Embed page for report published');
    const url = (await page.locator('#main [data-empage] .mono', { hasText: '/embed/' }).first().textContent())!.trim();
    expect(url).toMatch(/\/embed\/[0-9A-Z]{26}$/);
    await page.locator('[data-emsnippet]').first().click();
    await expect(modal(page)).toContainText('<iframe src="' + url);
    await page.keyboard.press('Escape');
    await expectAxeClean(page, 'aa', 'Apps, Embed tab');

    // The embed page on its own: the form's fields, a submission, the record on the Records tab.
    const embed = await page.context().newPage();
    const res = await embed.goto(url);
    expect(res?.headers()['content-security-policy']).toContain("frame-ancestors 'self' https://partner.example.com");
    await expect(embed.locator('h1')).toHaveText('Report a problem');
    await embed.locator('[name="subject"]').fill(`Printer on fire ${id}`);
    await embed.locator('[name="priority"]').selectOption('high');
    await embed.locator('button[type=submit]').click();
    await expect(embed.locator('#embed')).toContainText('Thank you');
    await expectAxeClean(embed, 'aa', 'Embed page, submitted');
    await embed.close();
    await page.locator('[data-tab="records"]').click();
    await expect(page.locator('#main')).toContainText(`Printer on fire ${id}`);

    // Removing the page takes it away.
    await page.locator('[data-tab="embed"]').click();
    await page.locator('[data-emrmpage]').first().click();
    await confirmDialog(page, 'Remove');
    await toast(page, 'Embed page removed');
    expect((await page.request.get(url)).status()).toBe(404);
  });
});
