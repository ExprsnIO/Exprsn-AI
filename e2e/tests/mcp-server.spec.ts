import { createHash, randomBytes } from 'node:crypto';
import { test, expect, open, expectLive, settle, toast, confirmDialog, apiAs, type Page } from './support/fixtures';
import { serverState } from './support/state';
import { expectAxeClean } from './support/axe';
import { expectAccessible } from './support/a11y';
import { reflowProblems } from './support/reflow';

// 1.6.0 (B-7101 to B-7103): the MCP server and MCP authorization. An identity admin publishes the workspace's MCP
// server on the Identity screen; an MCP client (played by this spec) signs a member in through the tenant's issuer
// with PKCE and the resource, lists the published tools and asks to create a record; the call waits until the member
// approves it under Settings, MCP access, and runs once approved. A tool admin enters OAuth for a per-user server by
// hand on the MCP servers screen, where discovery against a server without metadata fails with its steps, and the
// member finds the server to connect in Settings. Each view passes the WCAG checker and axe-core (Standard and
// Enhanced, light and dark) and reflows at 320 and 640 px.

type AppGlobal = { App: { setA11y(m: 'aa' | 'aaa' | null): void } };
const REDIRECT = 'http://127.0.0.1:33418/callback';
const SCOPE = 'tools:invoke agents:run inference:invoke knowledge:read records:read records:write offline_access';
const b64u = (b: Buffer) => b.toString('base64url');

/** Sideways scrolling or anything sticking out of the open dialog or drawer. */
function dialogReflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const box = document.querySelector('#overlay > .modal, #overlay > .drawer') as HTMLElement | null;
    if (!box) return ['no dialog open'];
    const doc = document.scrollingElement!;
    if (doc.scrollWidth > window.innerWidth + 1) out.push(`the page scrolls sideways by ${doc.scrollWidth - window.innerWidth} px`);
    if (box.scrollWidth > box.clientWidth + 1) out.push(`the dialog scrolls sideways by ${box.scrollWidth - box.clientWidth} px`);
    const edge = Math.min(window.innerWidth, box.getBoundingClientRect().right);
    const scrollers = Array.from(box.querySelectorAll('*')).filter((el) => el instanceof HTMLElement && /(auto|scroll)/.test(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth + 1);
    for (const el of scrollers) if (!el.matches('.tablewrap,.codebox,pre,textarea,[data-scroll-x]')) out.push(`${el.tagName.toLowerCase()}.${(el as HTMLElement).className} scrolls sideways`);
    for (const el of Array.from(box.querySelectorAll('*'))) {
      if (!(el instanceof HTMLElement) || !el.getClientRects().length) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.right <= edge + 1 || scrollers.some((s) => s.contains(el))) continue;
      out.push(`${el.tagName.toLowerCase()}.${el.className} sticks out (${Math.round(r.right)} px of ${Math.round(edge)})`);
    }
    return [...new Set(out)].slice(0, 10);
  });
}

/** The WCAG checker and axe-core in both modes and schemes, then reflow at 320 and 640 px (the screen or a dialog). */
async function checkView(page: Page, where: string, dialog: boolean): Promise<void> {
  // A toast fading in or out has no stable contrast: let the ones shown so far go first.
  await page.locator('#toasts .toast').evaluateAll((els) => els.forEach((e) => e.remove()));
  await expectAccessible(page, where);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const mode of ['aa', 'aaa'] as const) {
      await page.evaluate((m) => (window as unknown as AppGlobal).App.setA11y(m), mode);
      await expectAxeClean(page, mode, `${where} (${scheme}, ${mode})`);
    }
  }
  await page.evaluate(() => (window as unknown as AppGlobal).App.setA11y(null));
  await page.emulateMedia({ colorScheme: 'light' });
  for (const width of [320, 640]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(200);
    expect.soft(dialog ? await dialogReflow(page) : await reflowProblems(page), `${where} at ${width} px`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(100);
}

/** One JSON-RPC message to an MCP endpoint, as an MCP client sends it. */
async function rpc(url: string, token: string | null, method: string, params: object = {}) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return { status: r.status, headers: r.headers, body: r.status === 200 ? ((await r.json()) as { result?: Record<string, any>; error?: { code: number } }) : null };
}

test.describe('MCP server and MCP authorization', () => {
  test('an admin publishes the MCP server; a client signs a member in, and its write waits for the member\'s approval', async ({ page, watch, as }) => {
    test.setTimeout(240_000);
    const st = serverState();
    const root = await apiAs('root');
    await root.post('/api/apps', { name: 'mcpcrm', title: 'MCP CRM', label: 'internal', workspaceId: st.workspace.id });
    await root.post('/api/apps/mcpcrm/entities', { name: 'deal', title: 'Deal', label: 'internal', definition: { fields: [{ name: 'title', type: 'string', required: true, maxLength: 120 }] } });
    const client = (await root.post('/api/admin/federation/oidc/clients', { name: 'E2E MCP client', type: 'public', redirectUris: [REDIRECT], scopes: SCOPE.split(' '), grants: ['authorization_code', 'refresh_token'] })).client as { clientId: string };
    await root.close();

    // The identity admin publishes Finance Ops' MCP server.
    await open(page, 'identity?tab=mcp');
    await expectLive(page);
    await expect(page.locator('#main')).toContainText('Each workspace can publish an MCP server');
    const row = page.locator('#main tr', { hasText: st.workspace.name });
    await expect(row).toContainText('off');
    await checkView(page, 'Identity MCP server', false);
    await row.getByRole('button', { name: `Edit the MCP server of ${st.workspace.name}` }).click();
    const drawer = page.locator('#overlay .drawer');
    await expect(drawer).toContainText('What it publishes, as you would see it');
    await expect(drawer.locator('[data-pubpreview]')).toContainText('records_query');
    await checkView(page, 'Identity MCP server drawer', true);
    await drawer.locator('[data-pubon]').click();
    await drawer.getByRole('button', { name: 'Save' }).click();
    await confirmDialog(page, 'Publish');
    await toast(page, `${st.workspace.name} publishes its MCP server.`);
    await settle(page);
    await expect(page.locator('#main tr', { hasText: st.workspace.name })).toContainText('published');
    const url = (await page.locator('#main tr', { hasText: st.workspace.name }).locator('.mono').first().innerText()).trim();
    expect(url).toMatch(/\/mcp\/[a-z0-9-]+\/[0-9A-Z]{26}$/);
    const endpoint = `${st.url}${new URL(url).pathname}`;

    // An MCP client meets the server: 401 with the resource metadata, which names this tenant's issuer.
    const first = await rpc(endpoint, null, 'initialize');
    expect(first.status).toBe(401);
    const prmUrl = /resource_metadata="([^"]+)"/.exec(first.headers.get('www-authenticate') ?? '')![1]!;
    const prm = (await (await fetch(`${st.url}${new URL(prmUrl).pathname}`)).json()) as { resource: string; authorization_servers: string[] };
    expect(prm.resource).toBe(url);

    // The member signs in through the tenant's issuer and allows the client (authorization code with PKCE, the resource).
    const member = await as('member');
    // The client's redirect URI is not served: the browser's request to it is caught below.
    watch.allow.push(/GET \/callback/);
    let back = '';
    await member.route(`${REDIRECT}**`, async (route) => {
      back = route.request().url();
      await route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' });
    });
    const verifier = b64u(randomBytes(48));
    const q = new URLSearchParams({ response_type: 'code', client_id: client.clientId, redirect_uri: REDIRECT, scope: SCOPE, state: 'e2e', code_challenge: b64u(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', resource: url });
    await member.goto(`/oauth/authorize?${q}`);
    await expect(member.locator('body')).toContainText('Allow E2E MCP client');
    await member.getByRole('button', { name: 'Allow' }).click();
    await expect.poll(() => back).toContain('code=');
    const code = new URL(back).searchParams.get('code')!;
    const tok = (await (await fetch(`${st.url}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: client.clientId, resource: url }) })).json()) as { access_token: string };
    expect(tok.access_token).toBeTruthy();

    expect((await rpc(endpoint, tok.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } })).status).toBe(200);
    const tools = ((await rpc(endpoint, tok.access_token, 'tools/list')).body!.result!.tools as { name: string }[]).map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['records_query', 'records_create']));
    const args = { app: 'mcpcrm', entity: 'deal', values: { title: 'Asked over MCP' } };
    const held = await rpc(endpoint, tok.access_token, 'tools/call', { name: 'records_create', arguments: args });
    expect(held.body!.result!.isError).toBe(true);
    expect(held.body!.result!.structuredContent.held.id).toBeTruthy();

    // The member finds the URL and the held call under Settings, MCP access, and approves it.
    await open(member, 'settings');
    await expectLive(member);
    const panel = member.locator('#main .panel', { hasText: 'MCP access' });
    await expect(panel).toContainText(url);
    const hold = panel.locator('tr', { hasText: 'records_create' });
    await expect(hold).toContainText('Asked over MCP');
    await checkView(member, 'Settings MCP access', false);
    await hold.getByRole('button', { name: 'Approve records_create' }).click();
    await expect(member.locator('#overlay .modal')).toContainText('may run this call once');
    await checkView(member, 'Settings MCP approval', true);
    await confirmDialog(member, 'Approve');
    await toast(member, 'records_create approved');
    const ran = await rpc(endpoint, tok.access_token, 'tools/call', { name: 'records_create', arguments: args });
    expect(ran.body!.result!.isError).toBe(false);
    expect(ran.body!.result!.structuredContent.values.title).toBe('Asked over MCP');
  });

  test('a tool admin enters OAuth for a per-user server by hand; discovery without metadata fails with its steps', async ({ page, watch, as }) => {
    test.setTimeout(180_000);
    const st = serverState();
    const root = await apiAs('root');
    const srv = (await root.post('/api/admin/mcp-servers', { name: 'notes-oauth', url: st.fakes.mcp, auth: 'user' })) as { id: string };
    await root.close();
    watch.allow.push(/POST \/api\/admin\/mcp-servers\/[0-9A-Z]{26}\/oauth\/discover -> 422/);

    await open(page, `mcp-servers?server=${srv.id}`);
    await expectLive(page);
    await page.locator('#main [data-tab="authorization"]').click();
    const panel = page.locator('#main .panel', { hasText: 'OAuth for users' });
    await expect(panel).toContainText('Redirect URI');
    await expect(panel).toContainText('/api/mcp-oauth/callback');

    // Discovery: the fake server publishes no metadata, so it stops at the authorization server's metadata.
    await panel.getByRole('button', { name: 'Discover' }).click();
    const failed = page.locator('#overlay .modal');
    await expect(failed).toContainText('OAuth discovery: notes-oauth');
    await expect(failed).toContainText('Authorization server metadata');
    await checkView(page, 'MCP servers OAuth discovery', true);
    await failed.getByRole('button', { name: 'Enter by hand' }).click();

    // The manual fallback.
    const manual = page.locator('#overlay .modal');
    await expect(manual).toContainText('Enter OAuth by hand: notes-oauth');
    await manual.locator('[data-oa-auth]').fill('http://127.0.0.1:9/authorize');
    await manual.locator('[data-oa-token]').fill('http://127.0.0.1:9/token');
    await manual.locator('[data-oa-client]').fill('hand-entered');
    await manual.locator('[data-oa-scopes]').fill('notes');
    await checkView(page, 'MCP servers OAuth by hand', true);
    await manual.getByRole('button', { name: 'Save' }).click();
    await toast(page, 'OAuth saved for users of notes-oauth.');
    await settle(page);
    const saved = page.locator('#main .panel', { hasText: 'OAuth for users' });
    await expect(saved).toContainText('entered by hand');
    await expect(saved).toContainText('hand-entered');
    await checkView(page, 'MCP servers OAuth for users', false);

    // The member finds it in Settings, ready to connect.
    const member = await as('member');
    await open(member, 'settings');
    const mine = member.locator('#main .panel', { hasText: 'MCP access' }).locator('tr', { hasText: 'notes-oauth' });
    await expect(mine).toContainText('not connected');
    await mine.getByRole('button', { name: 'Connect notes-oauth' }).click();
    await expect(member.locator('#overlay .modal')).toContainText('authorization code with PKCE');
    await checkView(member, 'Settings MCP connect', true);
    await member.locator('#overlay .modal').getByRole('button', { name: 'Cancel' }).click();
  });
});
