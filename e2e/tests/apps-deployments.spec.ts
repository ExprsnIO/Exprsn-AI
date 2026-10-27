import { test, expect, open, expectLive, toast, confirmDialog, apiAs, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';

/*
 * 1.6.0, Sprint 39b (B-8201 to B-8204): the Apps screen's Deployments tab. A designer makes a package, creates a
 * pipeline over three apps, promotes development to test (the job runs on the e2e server), reads the history with
 * the backup and the report, rolls the deployment back, and a package pasted in with a changed byte is refused.
 */
const uniq = () => Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
const modal = (page: Page) => page.locator('#overlay .modal');

async function pickApp(page: Page, title: string): Promise<void> {
  await page.locator('#main .leftpane [data-app]', { hasText: title }).click();
  await expect(page.locator('#main .page h1, #main .page .pagehead').first()).toContainText(title);
}

test.describe('Apps: packages and deployments', () => {
  test('packages, a pipeline, a promotion to test, the history and a rollback, all from the screen', async ({ page, watch }) => {
    test.setTimeout(120_000);
    watch.allow.push(/POST \/api\/apps\/pipelines\/[A-Z0-9]+\/promote -> 409/, /POST \/api\/apps\/packages\/import -> 422/); // refused on purpose: production before test, a changed package
    const noToasts = async () => expect(page.locator('.toast')).toHaveCount(0, { timeout: 15_000 });
    const id = uniq();
    const dev = `crm_${id}`;
    const root = await apiAs('root');
    const me = await root.get('/api/me');
    const ws = me.workspaces[0];
    await root.post('/api/apps', { name: dev, title: `Dev CRM ${id}`, label: 'internal', workspaceId: ws.id });
    await root.post(`/api/apps/${dev}/entities`, { name: 'deal', title: 'Deal', label: 'internal', definition: { fields: [{ name: 'title', type: 'string', required: true, indexed: true, unique: true, maxLength: 120 }, { name: 'amount', type: 'number' }] } });
    await root.post(`/api/apps/${dev}/forms`, { name: 'new_deal', entity: 'deal', definition: { fields: [{ field: 'title' }] } });
    await root.post('/api/apps', { name: `${dev}_test`, title: `Test CRM ${id}`, label: 'internal', workspaceId: ws.id });
    await root.post('/api/apps', { name: `${dev}_prod`, title: `Prod CRM ${id}`, label: 'internal', workspaceId: ws.id });
    await root.close();

    await open(page, 'apps');
    await expectLive(page);
    await pickApp(page, `Dev CRM ${id}`);
    await page.locator('[data-tab="deployments"]').click();
    await expect(page.locator('#main')).toContainText('No packages yet');
    await expect(page.locator('#main')).toContainText('No pipeline');

    // A package of the design.
    await page.locator('[data-pkg-new]').click();
    await modal(page).locator('[data-pk-note]').fill('first cut');
    await modal(page).locator('[data-pk-ok]').click();
    await toast(page, 'Package v1 made and signed');
    await expect(page.locator('#main [data-pkg]')).toHaveCount(1);
    await expect(page.locator('#main [data-pkg]').first()).toContainText('first cut');

    // A pipeline over the three apps, without an approval workflow.
    await page.locator('[data-pl-new]').click();
    await modal(page).locator('[data-p-name]').fill(`CRM ${id}`);
    await modal(page).locator('[data-p-development]').selectOption(dev);
    await modal(page).locator('[data-p-test]').selectOption(`${dev}_test`);
    await modal(page).locator('[data-p-production]').selectOption(`${dev}_prod`);
    await modal(page).locator('[data-p-ok]').click();
    await toast(page, `Pipeline CRM ${id} created`);
    await expect(page.locator('#main [data-stage="test"]')).toContainText('nothing deployed');
    await expect(page.locator('#main')).toContainText('a promotion to production is refused until a workflow with an approval step is named');
    await noToasts();
    await expectAxeClean(page, 'aa', 'Apps, Deployments tab');

    // Production first: refused, a stage cannot be skipped.
    await page.locator('[data-promote="production"]').click();
    await confirmDialog(page, 'Promote');
    await expect(page.locator('#main')).toContainText('Nothing has passed test yet');

    // Development to test: the job runs on the server; the page refreshes until it ends.
    await page.locator('[data-promote="test"]').click();
    await confirmDialog(page, 'Promote');
    await toast(page, 'Deployment to test queued (v2)');
    await expect(page.locator('#main [data-dep]').first()).toContainText('succeeded', { timeout: 30_000 });
    await expect(page.locator('#main [data-dep]').first()).toContainText('Development → Test');
    await expect(page.locator('#main [data-dep]').first()).toContainText('entities 1 changed');
    await expect(page.locator('#main [data-stage="test"]')).toContainText('v2');
    // the promotion package joined the list
    await expect(page.locator('#main [data-pkg]')).toHaveCount(2);

    // Roll it back: the backup (the empty test app) returns, as its own deployment.
    await page.locator('#main [data-dep] [data-rollback]').first().click();
    await confirmDialog(page, 'Roll back');
    await toast(page, 'Rollback queued');
    await expect(page.locator('#main [data-dep]').first()).toContainText('rollback', { timeout: 30_000 });
    await expect(page.locator('#main [data-dep]').first()).toContainText('succeeded', { timeout: 30_000 });
    await expect(page.locator('#main [data-dep]')).toHaveCount(2);

    // A changed package is refused on the screen.
    const dl = await apiAs('root');
    const pkgs = await dl.get(`/api/apps/${dev}/packages`);
    const one = await dl.get(`/api/apps/${dev}/packages/${pkgs.packages[0].id}`);
    await dl.close();
    const tampered = JSON.parse(JSON.stringify(one.package));
    tampered.app.title = 'Changed after signing';
    await page.locator('[data-pkg-import]').click();
    await modal(page).locator('[data-pi-json]').fill(JSON.stringify(tampered));
    await modal(page).locator('[data-pi-name]').fill(`${dev}_bad`);
    await modal(page).locator('[data-pi-ok]').click();
    await expect(page.locator('#main')).toContainText('Package refused');
    await expect(page.locator('#main')).toContainText('signature does not verify');
    await noToasts();
    await expectAxeClean(page, 'aa', 'Apps, Deployments tab with a refused package');
  });
});
