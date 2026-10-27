import { createHmac } from 'node:crypto';
import { test, expect, open, expectLive, toast, confirmDialog, apiAs, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { serverState } from './support/state';

/*
 * App flows integrated with the environment (migration 082_app_flow_integration): an AI step whose answer a later
 * action writes, an HTTP request refused for a host the tenant does not allow, and a webhook flow turned on, with its
 * secret shown once, started by a signed request.
 */
const uniq = () => Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
const modal = (page: Page) => page.locator('#overlay .modal');
const definition = { fields: [{ name: 'title', type: 'string', required: true, indexed: true, maxLength: 120 }, { name: 'notes', type: 'string', maxLength: 2000 }] };

async function setupApp(id: string) {
  const root = await apiAs('root');
  const appName = `leads_${id}`;
  await root.post('/api/apps', { name: appName, title: `Leads ${id}`, label: 'internal', workspaceId: serverState().workspace.id });
  await root.post(`/api/apps/${appName}/entities`, { name: 'lead', title: 'Lead', definition });
  return { root, appName };
}

async function openFlows(page: Page, title: string): Promise<void> {
  await open(page, 'apps');
  await expectLive(page);
  await page.locator('#main .leftpane [data-app]', { hasText: title }).click();
  await page.locator('#main [data-tab="flows"]').click();
  await expect(page.locator('#main')).toContainText('No flows');
}

test.describe('Apps: flow integration actions', () => {
  test('an AI step answers and the next action writes the answer; an HTTP request to a host that is not allowed is refused', async ({ page, watch }) => {
    // The refused save is expected.
    watch.allow.push(/POST \/api\/apps\/[^/]+\/flows -> 400/);
    const id = uniq();
    const { root, appName } = await setupApp(id);
    await openFlows(page, `Leads ${id}`);
    await page.locator('#main [data-flownew]').click();
    await page.locator('#main aside [data-fd="name"]').fill('summarise');
    await page.locator('#main aside [data-fd="name"]').press('Tab');

    // Action 1 becomes an AI step on a profile cleared for the entity's label.
    await page.locator('#main [data-fnode="a0"]').click();
    await page.locator('#main aside [data-fa="type"]').selectOption('ai');
    await expect(page.locator('#main aside [data-fa="profile"] option', { hasText: 'general' })).toHaveCount(1);
    await page.locator('#main aside [data-fa="profile"]').selectOption('general');
    await page.locator('#main aside [data-fa="prompt"]').fill('Summarise the lead {{input.record.values.title}}');
    await page.locator('#main aside [data-fa="prompt"]').press('Tab');
    await expect(page.locator('#main [data-fnode="a0"]')).toContainText('AI step with general');

    // Action 2 writes its answer, read as {{steps.act1.text}}.
    await page.locator('#main [data-fnewtype]').selectOption('update');
    await page.locator('#main [data-faddact]').click();
    await expect(page.locator('#main aside')).toContainText('{{steps.act1.text}}');
    await page.locator('#main aside [data-fvadd]').click();
    await page.locator('#main aside [data-fvk="0"]').selectOption('notes');
    await page.locator('#main aside [data-fvv="0"]').fill('{{steps.act1.text}}');
    await page.locator('#main aside [data-fvv="0"]').press('Tab');
    await expectAxeClean(page, 'aa', 'Apps, flow canvas with an AI step');

    // An HTTP request to a host that is not on the tenant's list: the save is refused with the reason.
    await page.locator('#main [data-fnewtype]').selectOption('http');
    await page.locator('#main [data-faddact]').click();
    await page.locator('#main aside [data-fa="url"]').fill('https://not-allowed.example/leads');
    await page.locator('#main aside [data-fa="url"]').press('Tab');
    await expectAxeClean(page, 'aa', 'Apps, flow canvas with an HTTP request');
    await page.locator('#main [data-fsave]').click();
    await expect(page.locator('#main .notice.danger')).toContainText("not-allowed.example is not on this tenant's list of allowed hosts");
    // Without it the flow saves and runs.
    await page.locator('#main [data-fdelact]').click();
    await page.locator('#main [data-fsave]').click();
    await toast(page, /Flow summarise saved/);
    const rec = await root.post(`/api/apps/${appName}/entities/lead/records`, { values: { title: 'Kestrel' } });
    await expect.poll(async () => String((await root.get(`/api/apps/${appName}/entities/lead/records/${rec.id}`)).values.notes ?? ''), { timeout: 20_000 }).not.toBe('');
    await root.close();
  });

  test('a webhook flow: off by default, a secret shown once, turned on, started by a signed request', async ({ page }) => {
    const id = uniq();
    const { root, appName } = await setupApp(id);
    await openFlows(page, `Leads ${id}`);
    await page.locator('#main [data-flownew]').click();
    await page.locator('#main aside [data-fd="name"]').fill('inbound');
    await page.locator('#main aside [data-fd="name"]').press('Tab');
    await page.locator('#main aside [data-ftk] [data-seg="webhook"]').click();
    await expect(page.locator('#main aside')).toContainText('Save the flow to get its webhook address');
    await page.locator('#main [data-fnode="a0"]').click();
    await page.locator('#main aside [data-fa="type"]').selectOption('create');
    await page.locator('#main aside [data-fvadd]').click();
    await page.locator('#main aside [data-fvk="0"]').selectOption('title');
    await page.locator('#main aside [data-fvv="0"]').fill('{{input.payload.name}}');
    await page.locator('#main aside [data-fvv="0"]').press('Tab');
    await page.locator('#main [data-fsave]').click();
    await toast(page, /Flow inbound saved/);

    await page.locator('#main [data-fnode="trigger"]').click();
    await expect(page.locator('#main aside')).toContainText('Incoming webhook');
    await expect(page.locator('#main aside [data-fhooken="1"]')).toBeDisabled();
    await expectAxeClean(page, 'aa', 'Apps, webhook flow trigger');
    await page.locator('#main aside [data-fhookrot]').click();
    await expect(modal(page)).toContainText('shown once');
    await expectAxeClean(page, 'aa', 'Apps, webhook secret dialog');
    const secret = await modal(page).locator('[data-fhooksecret]').inputValue();
    expect(secret).toMatch(/^whsec_/);
    await modal(page).locator('[data-close]').first().click();
    await page.locator('#main aside [data-fhooken="1"]').click();
    await confirmDialog(page, 'Turn on');
    await toast(page, /Webhook on/);
    const url = await page.locator('#main aside [data-fhookurl]').inputValue();
    const path = new URL(url).pathname;

    const body = JSON.stringify({ name: `Hooked ${id}` });
    const ts = String(Math.floor(Date.now() / 1000));
    const send = (sig: string) => fetch(serverState().url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-exprsn-timestamp': ts, 'x-exprsn-signature': sig }, body });
    expect((await send('sha256=' + '0'.repeat(64))).status).toBe(401);
    const ok = await send('sha256=' + createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex'));
    expect(ok.status).toBe(202);
    expect((await send('sha256=' + createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex'))).status).toBe(409);
    await expect.poll(async () => ((await root.get(`/api/apps/${appName}/entities/lead/records?limit=10`)).records as { values: { title: string } }[]).map((r) => r.values.title), { timeout: 20_000 }).toContain(`Hooked ${id}`);
    await root.close();
  });
});
