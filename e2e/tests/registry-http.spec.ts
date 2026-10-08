import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, open, expectLive, toast, confirmDialog, ready, apiAs } from './support/fixtures';

/*
 * 1.6.0, Sprint 37a (B-8904): an HTTP tool is created, tested and published from the console; the tenant's list of
 * allowed hosts is kept from the Registry screen. The outside API is served from this process on loopback (the e2e
 * server names 127.0.0.1 in SERVICE_ALLOWED_HOSTS); its token is a vault reference picked in the form.
 */
test.describe('Registry: HTTP tools', () => {
  let api: Server;
  let apiUrl = '';
  const seen: { path: string; auth: string | undefined }[] = [];

  test.beforeAll(async () => {
    api = createServer((req, res) => {
      seen.push({ path: req.url ?? '', auth: req.headers.authorization });
      const ok = req.headers.authorization === 'Bearer e2e-catalog-token';
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ok ? { data: { id: (req.url ?? '').split('/').pop(), name: 'Widget', price: 19.99 } } : { error: 'no token' }));
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    // Seed what the steps need: a vault secret root may read.
    const root = await apiAs('root');
    const me = await root.get('/api/me');
    await root.post('/api/vault/policies', { subjectKind: 'user', subject: me.user.id, path: 'kv/apis', capabilities: ['*'] }).catch(() => undefined);
    await root.put('/api/vault/kv/data/apis/catalog', { data: { token: 'e2e-catalog-token' } });
    await root.close();
  });
  test.afterAll(async () => {
    await new Promise<void>((r) => api.close(() => r()));
  });

  test('keeps the allowed hosts, and an HTTP tool is created with a vault reference, tested and published', async ({ page, as }) => {
    await open(page, 'registry');
    await expectLive(page);

    // The tenant's list of allowed public hosts.
    await page.getByRole('button', { name: 'Allowed hosts' }).click();
    const drawer = page.locator('#overlay .drawer');
    await expect(drawer).toContainText('HTTP tools call a public host only when it is on this list');
    await drawer.locator('[data-newhost]').fill('api.partner.example');
    await drawer.locator('[data-addhost]').click();
    await toast(page, 'api.partner.example added');
    await expect(drawer).toContainText('api.partner.example');
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);

    // The form: kind HTTP request, URL template, parameters from the schema, a vault reference, the mapping.
    await page.getByRole('button', { name: 'Submit entry' }).click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-kind]').selectOption('http');
    await modal.locator('[data-name]').fill('catalog.get_item');
    await modal.locator('[data-version]').fill('1.0.0');
    await modal.locator('[data-desc]').fill('Looks up one catalogue item by its id and returns its name from the partner catalogue API.');
    await modal.locator('[data-label]').selectOption('internal');
    await modal.locator('[data-hurl]').fill(`${apiUrl}/v1/items/{id}`);
    await modal.locator('[data-hfill]').click();
    await expect(modal.locator('[data-in]')).toHaveValue(/"id"/);
    await expect(modal.locator('[data-hvault] option', { hasText: 'apis/catalog' })).toHaveCount(1);
    await modal.locator('[data-hvault]').selectOption('apis/catalog');
    await modal.locator('[data-hkey]').fill('token');
    await modal.locator('[data-hinsert]').click();
    await expect(modal.locator('[data-hheaders]')).toHaveValue('Authorization: Bearer vault:apis/catalog#token');
    await modal.locator('[data-hptr]').fill('/data/name');
    await modal.getByRole('button', { name: 'Save draft and run checks' }).click();
    await toast(page, 'Draft catalog.get_item 1.0.0 saved');
    const insp = page.locator('.registry-insp');
    await expect(insp).toContainText('HTTP request');
    await expect(insp).toContainText(`GET ${apiUrl}/v1/items/{id}`);
    await expect(insp).toContainText('Authorization: Bearer vault:apis/catalog#token');

    // A test call through the outbound address guard, with the token resolved at call time.
    await insp.getByRole('button', { name: 'Test harness' }).click();
    await insp.locator('[data-args]').fill('{ "id": "42" }');
    await insp.locator('[data-harness-run]').click();
    await toast(page, 'Harness run finished');
    await expect(insp).toContainText('"Widget"');
    expect(seen.at(-1)).toEqual({ path: '/v1/items/42', auth: 'Bearer e2e-catalog-token' });

    await insp.getByRole('button', { name: 'Submit for review' }).click();
    await confirmDialog(page, 'Submit');
    await toast(page, 'catalog.get_item is in the review queue');

    // Another tool admin approves and publishes it for the tenant.
    const reviewer = await as('root2');
    await reviewer.goto('/#/registry');
    await ready(reviewer, 'registry');
    await reviewer.locator('#main tr', { hasText: 'catalog.get_item' }).click();
    await expect(reviewer.locator('[data-approve]')).toBeEnabled();
    await reviewer.locator('[data-approve]').click();
    await confirmDialog(reviewer);
    await reviewer.locator('#overlay .modal').getByRole('button', { name: 'Publish' }).click();
    await expect(reviewer.locator('#main tr', { hasText: 'catalog.get_item' })).toContainText('published');
    await expect(reviewer.locator('.registry-insp')).toContainText('Calls, last day');
  });

  test('a literal credential is refused when saved', async ({ page, watch }) => {
    watch.allow.push(/POST \/api\/admin\/registry -> 400/);
    await open(page, 'registry');
    await page.getByRole('button', { name: 'Submit entry' }).click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-kind]').selectOption('http');
    await modal.locator('[data-name]').fill('catalog.leaky');
    await modal.locator('[data-desc]').fill('Looks up one catalogue item by its id with a key written into the tool, which is refused.');
    await modal.locator('[data-hurl]').fill(`${apiUrl}/v1/items/{id}`);
    await modal.locator('[data-hheaders]').fill('Authorization: Bearer e2e-literal-token');
    await modal.getByRole('button', { name: 'Save draft and run checks' }).click();
    await expect(page.locator('.registry-insp')).toContainText('Authorization carries a credential');
  });
});
