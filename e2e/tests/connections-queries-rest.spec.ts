import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, open, expectLive, toast, confirmDialog, apiAs, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';

/*
 * 1.8.0, Sprint 45: the Connections screen's Saved queries tab (B-125: a new parameterised query, a test run with a
 * parameter, publishing, the versions) on the outside table at crm.internal, and a REST API (B-126: registered on a
 * loopback host the tenant allows, an endpoint with a mapping, the test call showing the mapped rows). Axe-clean and
 * reflowing at 320 and 640 px. Everything it makes is removed again, and the tenant's allowed hosts are restored.
 */

/** Toasts fade in and out; the audit waits until none is on screen. */
async function quiet(page: Page): Promise<void> {
  await expect(page.locator('.toast')).toHaveCount(0, { timeout: 15_000 });
}

async function reflow(page: Page, where: string): Promise<void> {
  for (const width of [320, 640]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(250);
    expect(await reflowProblems(page), `${where} at ${width} px`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test.describe('Connections: saved queries and REST APIs', () => {
  let api: Server;
  let apiUrl = '';
  let hostsBefore: string[] = [];
  const made: { conn?: string } = {};

  test.beforeAll(async () => {
    api = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if ((req.url ?? '').startsWith('/v1/people')) return res.end(JSON.stringify({ items: [{ id: 1, profile: { name: 'Ada Lovelace' } }, { id: 2, profile: { name: 'Alan Turing' } }] }));
      if (req.url === '/v1') return res.end('{}');
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    const root = await apiAs('root');
    hostsBefore = (await root.get('/api/admin/integrations/hosts')).hosts;
    await root.put('/api/admin/integrations/hosts', { hosts: [...new Set([...hostsBefore, '127.0.0.1'])] });
    const conn = await root.post('/api/admin/connections', { name: `crm-sq-${Date.now().toString(36)}`, engine: 'postgres', endpoint: 'crm.internal:5432', database: 'crm', label: 'internal', username: 'app', password: 'right' });
    await root.post(`/api/admin/connections/${conn.id}/schema`);
    await root.put(`/api/admin/connections/${conn.id}/allow-list`, { objects: ['public.customers'] });
    made.conn = conn.id;
    await root.close();
  });

  test.afterAll(async () => {
    const root = await apiAs('root');
    if (made.conn) {
      for (const q of await root.get(`/api/admin/connections/${made.conn}/queries`)) await root.del(`/api/admin/connection-queries/${q.id}`);
      await root.del(`/api/admin/connections/${made.conn}`);
    }
    for (const c of await root.get('/api/admin/rest-connections')) if (c.name === 'people-api') await root.del(`/api/admin/rest-connections/${c.id}`);
    await root.put('/api/admin/integrations/hosts', { hosts: hostsBefore });
    await root.close();
    api.closeAllConnections();
    await new Promise((r) => api.close(r));
  });

  test('B-125: saves a parameterised query, test-runs it, publishes it and lists the version', async ({ page }) => {
    await open(page, 'connections');
    await expectLive(page);
    await page.locator(`[data-conn="${made.conn}"]`).click();
    await page.getByRole('tab', { name: 'Saved queries' }).click();
    await expect(page.locator('#main')).toContainText('No saved queries');
    await page.locator('[data-qnew]').click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-n]').fill('customers-by-tier');
    await modal.locator('[data-t]').fill('SELECT id, name, tier\nFROM public.customers\nWHERE tier = :tier\nORDER BY name');
    await expectAxeClean(page, 'aa', 'the new saved query dialog');
    await modal.locator('[data-go]').click();
    await toast(page, 'Saved as a draft, classified read');
    await expect(page.locator('#main table').first()).toContainText('customers-by-tier');

    await page.locator('[data-qp="tier"]').fill('gold');
    await page.locator('[data-qtest]').click();
    await expect(page.locator('#main .cs-res')).toContainText('Contoso');
    await expect(page.locator('#main .cs-res')).not.toContainText('Fabrikam');
    await expect(page.locator('#main')).toContainText('Classified read: public.customers');

    await page.locator('[data-qpublish]').click();
    await confirmDialog(page, 'Publish');
    await toast(page, 'Published as version 1');
    await expect(page.locator('#main')).toContainText('v1');
    await quiet(page);
    await expectAxeClean(page, 'aa', 'the saved queries tab');
    await reflow(page, 'the saved queries tab');
  });

  test('B-126: registers a REST API on an allowed host, adds an endpoint and test-calls it', async ({ page }) => {
    await open(page, 'connections');
    await expectLive(page);
    await page.locator('[data-registerrest]').click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-rn]').fill('people-api');
    await modal.locator('[data-rb]').fill(`${apiUrl}/v1`);
    await expectAxeClean(page, 'aa', 'the REST registration dialog');
    await modal.locator('[data-go]').click();
    await toast(page, 'REST connection registered');
    await expect(page.locator('#main h1')).toContainText('people-api');

    await page.locator('[data-enew]').click();
    await page.locator('[data-ef="name"]').fill('people');
    await page.locator('[data-ef="path"]').fill('/people');
    await page.locator('[data-ef="items"]').fill('items');
    await page.locator('[data-ef="fields"]').fill('[{ "name": "id", "path": "id", "type": "number" }, { "name": "name", "path": "/profile/name" }]');
    await page.locator('[data-etest]').click();
    await expect(page.locator('#main .cs-res')).toContainText('Ada Lovelace');
    await expect(page.locator('#main .cs-res')).toContainText('Alan Turing');
    await page.locator('[data-esave]').click();
    await toast(page, 'Endpoint people saved as version 1');
    await expect(page.locator('#main table').first()).toContainText('GET /people');
    await page.locator('[data-rtest]').click();
    await toast(page, 'answered 200');
    await quiet(page);
    await expectAxeClean(page, 'aa', 'the REST connection');
    await reflow(page, 'the REST connection');
  });
});
