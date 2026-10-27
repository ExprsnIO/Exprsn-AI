import { test, expect, open, expectLive, toast, confirmDialog, apiAs, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';
import { serverState } from './support/state';

/*
 * 1.8.0, Sprint 44 (B-124): scheduled delivery. The Subscribe button on a saved view opens the dialog (format, a
 * schedule preset in a time zone with the next runs from the server, destinations, options); the subscription then
 * shows under Subscriptions (My subscriptions, and All in the tenant for an admin) with its schedule, state and
 * history, and is paused, resumed and deleted there. Axe-clean, and reflowing at 320 and 640 px, dialog included.
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

test.describe('Apps: scheduled delivery (B-124)', () => {
  test('subscribes to a saved view, previews the schedule, then pauses, resumes and deletes the subscription', async ({ page, watch }) => {
    // The too-frequent schedule is refused on purpose.
    watch.allow.push(/POST \/api\/apps\/subscriptions\/preview -> 422/);
    const id = uniq();
    const root = await apiAs('root');
    const appName = `subs_${id}`;
    await root.post('/api/apps', { name: appName, title: `Deliveries ${id}`, label: 'internal', workspaceId: serverState().workspace.id });
    await root.post(`/api/apps/${appName}/entities`, { name: 'deal', title: 'Deal', definition: { fields: [{ name: 'title', type: 'string', required: true, maxLength: 120 }, { name: 'amount', type: 'number' }] } });
    await root.post(`/api/apps/${appName}/entities/deal/records`, { values: { title: 'Acme renewal', amount: 120 } });
    const view = await root.post(`/api/apps/${appName}/entities/deal/views`, { name: `Big deals ${id}`, shared: true, settings: {} });

    await open(page, 'apps');
    await page.locator('#main .leftpane [data-app]', { hasText: `Deliveries ${id}` }).click();
    await page.locator('#main [data-tab="records"]').click();
    const picker = page.locator('#main .apps-views');
    await picker.locator('[data-viewsel]').selectOption(view.id);
    await picker.locator('[data-app-subscribe]').click();

    // The dialog: a preset in a zone, and the next runs from the server.
    const dlg = modal(page);
    await expect(dlg.locator('h2')).toContainText(`Subscribe to Big deals ${id}`);
    await dlg.locator('[data-sb-preset]').selectOption('weekly');
    await dlg.locator('[data-sb-param="dow"]').fill('1');
    await dlg.locator('[data-sb-param="hour"]').fill('8');
    await dlg.locator('[data-sb-tz]').fill('Europe/Berlin');
    await expect(dlg.locator('[data-sb-runs]')).toContainText('On Mondays, at 08:00 (Europe/Berlin)');
    await expect(dlg.locator('[data-sb-runs] li')).toHaveCount(5);
    await dlg.locator('[data-sb-format]').selectOption('csv');
    await dlg.locator('[data-sb-rows]').check();
    await dlg.locator('[data-sb-message]').fill('For the Monday review');
    await expectAxeClean(page, 'aa', 'Apps, the Subscribe dialog');
    await reflow(page, 'apps: the Subscribe dialog');
    // A schedule that runs too often is refused in plain words before anything is saved.
    await dlg.locator('[data-sb-preset]').selectOption('custom');
    await dlg.locator('[data-sb-cron]').fill('*/5 * * * *');
    await expect(dlg.locator('[data-sb-runs]')).toContainText('at least 60 minutes apart');
    await dlg.locator('[data-sb-cron]').fill('0 8 * * 1');
    await expect(dlg.locator('[data-sb-runs] li')).toHaveCount(5);
    await dlg.locator('[data-sb-ok]').click();
    await toast(page, /Subscribed to Big deals/);

    const listed = (await root.get('/api/apps/subscriptions')).subscriptions as { id: string; name: string; format: string; options: { onlyIfRows: boolean; message: string }; schedule: { cron: string; timezone: string } }[];
    const sub = listed.find((x) => x.name === `Big deals ${id}`)!;
    expect(sub).toMatchObject({ format: 'csv', options: { onlyIfRows: true, message: 'For the Monday review' }, schedule: { cron: '0 8 * * 1', timezone: 'Europe/Berlin' } });

    // My subscriptions: the row, its inspector and history; pause and resume; then delete.
    await open(page, `app-subscriptions?id=${sub.id}`);
    await expectLive(page);
    const row = page.locator(`#main tr[data-sx="${sub.id}"]`);
    await expect(row).toContainText(`Big deals ${id}`);
    await expect(row).toContainText('On Mondays, at 08:00 (Europe/Berlin)');
    const insp = page.locator('#main aside.inspector');
    await expect(insp).toContainText('Delivery history');
    await expect(insp).toContainText('No deliveries yet');
    await expectAxeClean(page, 'aa', 'Subscriptions, my subscriptions');
    await reflow(page, 'app-subscriptions: my subscriptions with the inspector');
    await insp.locator('[data-sx-toggle]').click();
    await confirmDialog(page, 'Pause');
    await toast(page, /is paused/);
    await expect(page.locator(`#main tr[data-sx="${sub.id}"]`)).toContainText('paused');
    await page.locator('#main aside.inspector [data-sx-toggle]').click();
    await confirmDialog(page, 'Resume');
    await toast(page, /is active again/);

    // An admin sees it under All in the tenant.
    await page.locator('#main [data-tab="all"]').click();
    await expect(page.locator(`#main tr[data-sx="${sub.id}"]`)).toBeVisible();
    await expectAxeClean(page, 'aa', 'Subscriptions, all in the tenant');
    await page.locator('#main [data-tab="mine"]').click();
    await page.locator(`#main tr[data-sx="${sub.id}"]`).click();
    await page.locator('#main aside.inspector [data-sx-delete]').click();
    await confirmDialog(page, 'Delete subscription');
    await toast(page, /Deleted Big deals/);
    await expect(page.locator(`#main tr[data-sx="${sub.id}"]`)).toHaveCount(0);
    expect(((await root.get('/api/apps/subscriptions')).subscriptions as { id: string }[]).some((x) => x.id === sub.id)).toBe(false);
    await root.close();
  });
});
