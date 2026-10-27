/*
 * 1.6.0, Sprint 37b against real databases. Each block runs when its variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 039b_mcp_server; B-7101, B-7102 end to end: an MCP client gets a token for
 *                                  a workspace's MCP server from the tenant's issuer (authorization code with PKCE and
 *                                  the resource), calls a published workflow and the record tools (audited), a token
 *                                  for the API is refused with 401 and the metadata URL, a write is held until the user
 *                                  approves it, the refresh keeps the audience, and a client registers itself; B-7103:
 *                                  the MCP client discovers an authorization server, connects two users through the
 *                                  OAuth flow who act under their own accounts, refreshes, and revokes on disconnect
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { createApp } from '../../src/http/app.js';
import { loadPrincipal } from '../../src/http/middleware.js';
import { challengeParams } from '../../src/mcp/oauth.js';
import { mcpResource } from '../../src/mcp/server/resource.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import type { WfGraph } from '../../src/workflows/graph.js';
import { FakeMcp } from '../fake-mcp.js';
import { localUser, login, testConfig, type Client, type Harness } from '../helpers.js';
import { FakeAs } from '../sprint37b-fakes.js';

const REDIRECT = 'http://127.0.0.1:33418/callback';
const SCOPE = 'tools:invoke agents:run inference:invoke knowledge:read records:read records:write offline_access';
const b64u = (b: Buffer) => b.toString('base64url');
const post = (c: Client, url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body);
const put = (c: Client, url: string, body: object) => c.agent.put(url).set('x-csrf-token', c.csrf).send(body);
const GRAPH = { nodes: [{ id: 'trigger', kind: 'trigger', title: 'Trigger', x: 20, y: 20, config: { source: 'api' }, output: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] } }, { id: 'shape', kind: 'transform', title: 'Shape', x: 200, y: 20, config: { fields: { text: 'hello' } } }], edges: [{ from: 'trigger', to: 'shape' }], limits: {} } as unknown as WfGraph;

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`Sprint 37b on ${d.name}`, () => {
    it('migrates 039b_mcp_server; an MCP client gets a token from the tenant issuer and calls published tools; the client side connects users by OAuth', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url!, BLOB_DIR: mkdtempSync(path.join(tmpdir(), 'exprsn-37b-it-')) });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      const mcp = await new FakeMcp().start();
      const as = await new FakeAs(mcp).start();
      try {
        for (const t of ['mcp_publications', 'mcp_server_settings', 'mcp_server_holds', 'mcp_oauth', 'mcp_oauth_states']) expect(await db.schema.hasTable(t), t).toBe(true);
        for (const [t, c] of [['oidc_codes', 'resource'], ['oidc_refresh_tokens', 'resource'], ['oidc_clients', 'dynamic'], ['mcp_tokens', 'refresh_token'], ['mcp_tokens', 'source']] as const) expect(await db.schema.hasColumn(t, c), `${t}.${c}`).toBe(true);
        expect((await db('registry_entries').where('name', 'like', 'records.%').select('name')).length).toBe(7);
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const h: Harness = { s, app: createApp(s), tenantId: tenant.id, close: async () => undefined };
        const ws = await s.tenants.createWorkspace(tenant.id, 'Sales', 'confidential');
        const mia = await localUser(h, 'mia', ['member'], 'confidential');
        const bo = await localUser(h, 'bo', ['member'], 'confidential');
        const wfa = await localUser(h, 'wfa', ['workflow-admin', 'member'], 'confidential');
        for (const u of [mia, bo, wfa]) await s.tenants.addMember(ws.id, u.id);
        const admin = (await loadPrincipal(s, tenant.id, wfa.id, {}))!;
        admin.workspaceId = ws.id;
        admin.mfa = true;

        // A workspace with an app, a published workflow, and its MCP server; a public client for MCP clients.
        const app = await s.apps.create({ principal: admin, source: 'api' }, { name: 'crm', label: 'confidential', workspaceId: ws.id });
        const { entity } = await s.apps.createEntity({ principal: admin, source: 'api' }, app.name, { name: 'deal', label: 'internal', definition: { fields: [{ name: 'title', type: 'string', required: true, maxLength: 120 }] } as never });
        await s.apps.createRecord({ principal: admin, source: 'api' }, app, entity, { values: { title: 'Acme renewal' } });
        const c = await login(h, 'mia');
        await put(c, '/api/me/workspace', { workspaceId: ws.id }).expect(200);
        const wf = await s.workflows.create(admin, { name: 'summarise', label: 'internal', graph: GRAPH });
        await s.workflows.publish(admin, wf.id, null);
        await s.mcpServer.publish(admin, ws.id, { enabled: true });
        const { client } = await s.federation.oidc.createClient(tenant.id, { name: 'MCP client', type: 'public', redirectUris: [REDIRECT], grants: ['authorization_code', 'refresh_token'], scopes: SCOPE.split(' '), pkceRequired: true, accessTtl: 600, refreshTtl: 3600, models: null, serviceUserId: null }, null);
        const resource = mcpResource(cfg, tenant.slug, ws.id);
        const endpoint = `/mcp/${tenant.slug}/${ws.id}`;

        const token = async (user: Client, res: string | null) => {
          const verifier = b64u(randomBytes(48));
          const challenge = b64u(createHash('sha256').update(verifier).digest());
          const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, scope: SCOPE, state: 's', code_challenge: challenge, code_challenge_method: 'S256', ...(res ? { resource: res } : {}) });
          let r = await user.agent.get(`/oauth/authorize?${q}`);
          if (r.status === 200) r = await user.agent.post('/oauth/authorize').type('form').send({ handle: /name="handle" value="([^"]+)"/.exec(r.text)![1], csrf: /name="csrf" value="([^"]+)"/.exec(r.text)![1], decision: 'allow' });
          const code = new URL(r.headers.location as string).searchParams.get('code');
          const tok = await request(h.app).post('/oauth/token').type('form').send({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: client.client_id, ...(res ? { resource: res } : {}) });
          expect(tok.status, JSON.stringify(tok.body)).toBe(200);
          return tok.body as { access_token: string; refresh_token: string };
        };
        const rpc = (tok: string | null, method: string, params: object = {}) => {
          const r = request(h.app).post(endpoint).set('content-type', 'application/json');
          if (tok) r.set('authorization', `Bearer ${tok}`);
          return r.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
        };

        // 401 with the metadata URL; the metadata names the tenant's issuer.
        const anon = await rpc(null, 'initialize');
        expect(anon.status).toBe(401);
        expect(challengeParams(anon.headers['www-authenticate'] as string).resource_metadata).toBe(`http://localhost:8080/.well-known/oauth-protected-resource${endpoint}`);
        expect((await request(h.app).get(`/.well-known/oauth-protected-resource${endpoint}`).expect(200)).body).toMatchObject({ resource, authorization_servers: ['http://localhost:8080'] });

        const tok = await token(c, resource);
        await rpc(tok.access_token, 'initialize', { protocolVersion: '2025-06-18' }).expect(200);
        const names = ((await rpc(tok.access_token, 'tools/list').expect(200)).body.result.tools as { name: string }[]).map((t) => t.name);
        expect(names).toEqual(expect.arrayContaining(['workflow_summarise', 'records_query', 'records_create']));
        const run = await rpc(tok.access_token, 'tools/call', { name: 'workflow_summarise', arguments: { topic: 'Q3' } }).expect(200);
        expect(run.body.result.isError, JSON.stringify(run.body)).toBe(false);
        const q = await rpc(tok.access_token, 'tools/call', { name: 'records_query', arguments: { app: 'crm', entity: 'deal' } }).expect(200);
        expect(q.body.result.structuredContent.records).toHaveLength(1);
        expect(Number(((await db('audit_events').where({ tenant_id: tenant.id, action: 'mcp.server.call' }).count({ n: '*' })) as { n: number | string }[])[0]!.n)).toBe(2);

        // A token for the API is refused here with the metadata URL; the MCP token does not open the API.
        const api = await token(c, null);
        const refused = await rpc(api.access_token, 'initialize');
        expect(refused.status).toBe(401);
        expect(challengeParams(refused.headers['www-authenticate'] as string)).toMatchObject({ error: 'invalid_token' });
        await request(h.app).get('/api/me').set('authorization', `Bearer ${tok.access_token}`).expect(401);

        // A write is held until the user approves it from the browser, then runs once.
        const args = { app: 'crm', entity: 'deal', values: { title: 'Globex pilot' } };
        const held = (await rpc(tok.access_token, 'tools/call', { name: 'records_create', arguments: args }).expect(200)).body.result.structuredContent.held as { id: string };
        await post(c, `/api/me/mcp-holds/${held.id}/decide`, { decision: 'approve' }).expect(200);
        expect((await rpc(tok.access_token, 'tools/call', { name: 'records_create', arguments: args }).expect(200)).body.result.isError).toBe(false);
        expect(Number(((await db('app_records').where({ tenant_id: tenant.id }).count({ n: '*' })) as { n: number | string }[])[0]!.n)).toBe(2);

        // The refresh keeps the audience; dynamic registration when allowed.
        const ref = await request(h.app).post('/oauth/token').type('form').send({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: client.client_id }).expect(200);
        await rpc(ref.body.access_token, 'ping').expect(200);
        await s.mcpServer.setDynamicRegistration(tenant.id, true, admin.userId);
        const reg = await request(h.app).post('/oauth/register').send({ client_name: 'MCP client', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none' }).expect(201);
        expect(await s.federation.oidc.byClientId(tenant.id, reg.body.client_id)).toMatchObject({ dynamic: true, type: 'public' });

        // B-7103: the MCP client side.
        mcp.tools = [{ name: 'whoami', description: 'Who you are to the server.', annotations: { readOnlyHint: true }, run: (_a, auth) => ({ user: as.userOf(auth) }) }];
        const srv = (await s.mcp.register(admin, { name: 'notes', description: null, url: mcp.url, zone: 'app-internal', auth: 'user' })).server;
        const disc = await s.mcp.oauth.discover(srv, admin.userId, tenant.name);
        expect(disc.row).toMatchObject({ issuer: as.url, client_id: 'dyn-1', resource: mcp.url });
        const b = await login(h, 'bo');
        const connect = async (u: Client, who: string) => {
          const start = await post(u, '/api/mcp-oauth/start', { server: srv.id }).expect(200);
          const url = new URL(start.body.authorizeUrl);
          url.searchParams.set('user', who);
          const back = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location')!);
          const r = await u.agent.get(`${back.pathname}${back.search}`).expect(302);
          expect(r.headers.location).toMatch(/result=connected/);
        };
        await connect(c, 'mia@notes');
        await connect(b, 'bo@notes');
        await db('mcp_tools').insert({ id: '01J8ZZZZZZZZZZZZZZZZZZZZZZ', server_id: srv.id, tenant_id: tenant.id, name: 'whoami', description: null, input_schema: null, annotations: null, hash: 'h1', approved_hash: 'h1', approved_schema: null, state: 'approved', side_effect: 'read', confirm: 'never', label: 'internal', approved_by: admin.userId, approved_at: Date.now(), created_at: Date.now(), updated_at: Date.now() });
        await db('mcp_servers').where({ id: srv.id }).update({ health: 'healthy' });
        const pm = (await loadPrincipal(s, tenant.id, mia.id, {}))!;
        const pb = (await loadPrincipal(s, tenant.id, bo.id, {}))!;
        expect((await s.mcp.call(pm, srv.id, 'whoami', {})).structuredContent).toEqual({ user: 'mia@notes' });
        expect((await s.mcp.call(pb, srv.id, 'whoami', {})).structuredContent).toEqual({ user: 'bo@notes' });
        as.expireAll();
        expect((await s.mcp.call(pm, srv.id, 'whoami', {})).structuredContent).toEqual({ user: 'mia@notes' });
        await c.agent.delete(`/api/mcp/servers/${srv.id}/token`).set('x-csrf-token', c.csrf).expect(204);
        expect(as.revoked.some((x) => x.startsWith('rt-mia@notes'))).toBe(true);
        expect(await db('mcp_tokens').where({ server_id: srv.id, user_id: mia.id }).first()).toBeUndefined();
        expect((await s.mcp.call(pb, srv.id, 'whoami', {})).structuredContent).toEqual({ user: 'bo@notes' });
        expect((await s.audit.verify(tenant.id)).status).toBe('verified');
      } finally {
        await as.stop();
        await mcp.stop();
        await s.close();
        await db.destroy();
      }
    }, 120_000);
  });
}
