/*
 * Sprint 37b (1.6.0): the MCP server (B-7101), its authorization as an OAuth 2.1 resource server of the tenant's own
 * issuer (B-7102), and OAuth for the MCP client per user (B-7103).
 */
import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { challengeParams } from '../src/mcp/oauth.js';
import { canonicalResource, mcpResource, parseMcpResource } from '../src/mcp/server/resource.js';
import { loadPrincipal } from '../src/http/middleware.js';
import type { WfGraph } from '../src/workflows/graph.js';
import { FakeMcp } from './fake-mcp.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';
import { seedGateway } from './seed-gateway.js';
import { FakeAs } from './sprint37b-fakes.js';

const REDIRECT = 'http://127.0.0.1:33418/callback';
const SCOPE = 'tools:invoke agents:run inference:invoke knowledge:read records:read records:write offline_access';
const b64u = (b: Buffer) => b.toString('base64url');
const pkce = () => {
  const verifier = b64u(randomBytes(48));
  return { verifier, challenge: b64u(createHash('sha256').update(verifier).digest()) };
};
const post = (c: Client, url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body);
const put = (c: Client, url: string, body: object) => c.agent.put(url).set('x-csrf-token', c.csrf).send(body);
const TOPIC = { type: 'object' as const, properties: { topic: { type: 'string' as const } }, required: ['topic'] };
const GRAPH: WfGraph = { nodes: [{ id: 'trigger', kind: 'trigger', title: 'Trigger', x: 20, y: 20, config: { source: 'api' }, output: TOPIC }, { id: 'shape', kind: 'transform', title: 'Shape', x: 200, y: 20, config: { fields: { text: 'hello' } } }], edges: [{ from: 'trigger', to: 'shape' }], limits: {} } as unknown as WfGraph;
const BUDGETS = { steps: 10, tokens: 10_000, wallSeconds: 600, toolCalls: 4 };

async function drain(h: Harness, rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) if (!(await h.s.jobs.runDue())) break;
}

describe('Sprint 37b: resource identifiers', () => {
  const cfg = { PUBLIC_URL: 'https://ai.example.com/console', API_PUBLIC_URL: undefined };
  it('canonicalises and parses MCP resource URLs', () => {
    expect(canonicalResource('https://ai.example.com/mcp/acme/01J8ZZZZZZZZZZZZZZZZZZZZZZ/?groups=records#x')).toBe('https://ai.example.com/mcp/acme/01J8ZZZZZZZZZZZZZZZZZZZZZZ');
    expect(canonicalResource('ftp://x/y')).toBeNull();
    expect(mcpResource(cfg, 'acme', '01J8ZZZZZZZZZZZZZZZZZZZZZZ')).toBe('https://ai.example.com/mcp/acme/01J8ZZZZZZZZZZZZZZZZZZZZZZ');
    expect(parseMcpResource(cfg, 'https://ai.example.com/mcp/acme/01J8ZZZZZZZZZZZZZZZZZZZZZZ?groups=tools')).toEqual({ tenantSlug: 'acme', workspaceId: '01J8ZZZZZZZZZZZZZZZZZZZZZZ' });
    expect(parseMcpResource(cfg, 'https://elsewhere.example.com/mcp/acme/01J8ZZZZZZZZZZZZZZZZZZZZZZ')).toBeNull();
    expect(parseMcpResource({ ...cfg, API_PUBLIC_URL: 'https://api.example.com/base/' }, 'https://api.example.com/base/mcp/acme/01J8ZZZZZZZZZZZZZZZZZZZZZZ')).not.toBeNull();
  });
  it('reads WWW-Authenticate parameters', () => {
    expect(challengeParams('Bearer resource_metadata="https://x/.well-known/oauth-protected-resource/mcp", scope="a b", error=invalid_token')).toEqual({ resource_metadata: 'https://x/.well-known/oauth-protected-resource/mcp', scope: 'a b', error: 'invalid_token' });
  });
});

describe('Sprint 37b: the MCP server and its authorization (B-7101, B-7102)', () => {
  let h: Harness;
  let ollama: FakeOllama | null = null;
  afterEach(async () => {
    await h.close();
    await ollama?.stop();
    ollama = null;
  });

  async function setup() {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    ollama = await new FakeOllama().start();
    ollama.chatDelayMs = 0;
    await seedGateway(h, ollama);
    const ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Sales', 'confidential')).id;
    const other = (await h.s.tenants.createWorkspace(h.tenantId, 'Legal', 'confidential')).id;
    const users = [await localUser(h, 'idadmin', ['tenant-admin', 'workflow-admin', 'member'], 'confidential'), await localUser(h, 'tadmin', ['tool-admin', 'agent-admin'], 'confidential'), await localUser(h, 'tadmin2', ['tool-admin', 'agent-admin'], 'confidential'), await localUser(h, 'mia', ['member'], 'confidential'), await localUser(h, 'noah', ['member'], 'internal')];
    for (const u of users) await h.s.tenants.addMember(ws, u.id);
    await h.s.tenants.addMember(other, users[3]!.id);
    const c = { admin: await loginAdmin(h, 'idadmin'), t: await loginAdmin(h, 'tadmin'), t2: await loginAdmin(h, 'tadmin2'), mia: await login(h, 'mia'), noah: await login(h, 'noah'), ws, other, miaId: users[3]!.id };
    for (const x of [c.admin, c.t, c.t2, c.mia, c.noah]) await put(x, '/api/me/workspace', { workspaceId: ws }).expect(200);
    const slug = (await h.s.tenants.byId(h.tenantId))!.slug;
    // An app with records, a published workflow, and a public OIDC client for MCP clients.
    await post(c.admin, '/api/apps', { name: 'crm', title: 'CRM', label: 'confidential', workspaceId: ws }).expect(201);
    await post(c.admin, '/api/apps/crm/entities', { name: 'deal', title: 'Deal', label: 'internal', definition: { fields: [{ name: 'title', type: 'string', required: true, maxLength: 120 }, { name: 'amount', type: 'number', indexed: true }] } }).expect(201);
    await post(c.admin, '/api/apps/crm/entities/deal/records', { values: { title: 'Acme renewal', amount: 1200 } }).expect(201);
    const wf = (await post(c.admin, '/api/workflows', { name: 'summarise', label: 'internal' }).expect(201)).body as { id: string };
    await put(c.admin, `/api/workflows/${wf.id}/draft`, { graph: GRAPH }).expect(200);
    await post(c.admin, `/api/workflows/${wf.id}/publish`, { note: null }).expect(200);
    const client = (await post(c.admin, '/api/admin/federation/oidc/clients', { name: 'Claude Desktop', type: 'public', redirectUris: [REDIRECT], scopes: SCOPE.split(' '), grants: ['authorization_code', 'refresh_token'] }).expect(201)).body.client as { clientId: string };
    return { ...c, slug, clientId: client.clientId, resource: mcpResource(h.s.cfg, slug, ws), path: `/mcp/${slug}/${ws}` };
  }
  type Ctx = Awaited<ReturnType<typeof setup>>;

  /** The authorization code grant with PKCE as an MCP client runs it, naming the resource; consent given in the browser. */
  async function token(c: Ctx, user: Client, resource: string | null, scope = SCOPE) {
    const { verifier, challenge } = pkce();
    const q = new URLSearchParams({ response_type: 'code', client_id: c.clientId, redirect_uri: REDIRECT, scope, state: 'st', code_challenge: challenge, code_challenge_method: 'S256', ...(resource ? { resource } : {}) });
    let res = await user.agent.get(`/oauth/authorize?${q}`);
    if (res.status === 200) {
      const handle = /name="handle" value="([^"]+)"/.exec(res.text)![1]!;
      const csrf = /name="csrf" value="([^"]+)"/.exec(res.text)![1]!;
      res = await user.agent.post('/oauth/authorize').type('form').send({ handle, csrf, decision: 'allow' });
    }
    expect(res.status, res.text).toBe(302);
    const code = new URL(res.headers.location as string).searchParams.get('code');
    expect(code, res.headers.location as string).toBeTruthy();
    const tok = await request(h.app).post('/oauth/token').type('form').send({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: c.clientId, ...(resource ? { resource } : {}) });
    expect(tok.status, JSON.stringify(tok.body)).toBe(200);
    return tok.body as { access_token: string; refresh_token: string; scope: string };
  }

  const rpc = (path: string, tok: string | null, method: string, params: object = {}, query = '') => {
    const r = request(h.app).post(`${path}${query}`).set('content-type', 'application/json').set('accept', 'application/json, text/event-stream').set('mcp-protocol-version', '2025-06-18');
    if (tok) r.set('authorization', `Bearer ${tok}`);
    return r.send(JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }));
  };

  async function publish(c: Ctx, body: object = { enabled: true }) {
    return (await put(c.admin, `/api/admin/mcp-server/workspaces/${c.ws}`, body).expect(200)).body;
  }

  it('B-7102: answers 401 with resource metadata, publishes RFC 9728 and RFC 8414 metadata, and is off until published', async () => {
    const c = await setup();
    // Not published yet: nothing answers.
    expect((await rpc(c.path, null, 'initialize')).status).toBe(404);
    expect((await request(h.app).get(`/.well-known/oauth-protected-resource${c.path}`)).status).toBe(404);
    const pub = await publish(c);
    expect(pub).toMatchObject({ enabled: true, url: c.resource, label: 'internal', requireDpop: false });

    const res = await rpc(c.path, null, 'initialize');
    expect(res.status).toBe(401);
    const challenge = challengeParams(res.headers['www-authenticate'] as string);
    expect(challenge.resource_metadata).toBe(`http://localhost:8080/.well-known/oauth-protected-resource${c.path}`);
    expect(challenge.scope).toContain('records:read');

    const prm = await request(h.app).get(`/.well-known/oauth-protected-resource${c.path}`).expect(200);
    expect(prm.body).toMatchObject({ resource: c.resource, authorization_servers: ['http://localhost:8080'], bearer_methods_supported: ['header'], dpop_bound_access_tokens_required: false });
    expect(prm.headers['access-control-allow-origin']).toBe('*');

    const as = await request(h.app).get('/.well-known/oauth-authorization-server').expect(200);
    expect(as.body).toMatchObject({ issuer: 'http://localhost:8080', code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true });
    expect(as.body.registration_endpoint).toBeUndefined();
    // GET and DELETE: no event stream, no sessions.
    expect((await request(h.app).get(c.path)).status).toBe(405);
    // The admin page shows it.
    const admin = (await c.admin.agent.get('/api/admin/mcp-server').expect(200)).body;
    expect(admin.publications.find((x: { workspaceId: string }) => x.workspaceId === c.ws)).toMatchObject({ enabled: true, url: c.resource });
    // A member may not change it.
    await put(c.mia, `/api/admin/mcp-server/workspaces/${c.ws}`, { enabled: false }).expect(403);
    expect((await h.s.db('audit_events').where({ action: 'mcp.server.published' }).count({ n: '*' }).first())!.n).toEqual(expect.anything());
  });

  it('B-7101, B-7102 end to end: an MCP client gets a token from the tenant issuer and calls a published workflow, audited', async () => {
    const c = await setup();
    await publish(c);
    const tok = await token(c, c.mia, `${c.resource}?groups=workflows,records`);
    // The audience is the canonical endpoint URL (no query).
    const claims = JSON.parse(Buffer.from(tok.access_token.split('.')[1]!, 'base64url').toString()) as { aud: string };
    expect(claims.aud).toBe(c.resource);

    const init = await rpc(c.path, tok.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-desktop', version: '1' } }).expect(200);
    expect(init.body.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'exprsn-ai' } });
    expect((await rpc(c.path, tok.access_token, 'notifications/initialized').send()).status).toBeLessThan(500);

    const list = await rpc(c.path, tok.access_token, 'tools/list').expect(200);
    const names = (list.body.result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toContain('workflow_summarise');
    expect(names).toEqual(expect.arrayContaining(['records_query', 'records_count', 'records_create', 'records_delete', 'knowledge_search'].filter((n) => n !== 'knowledge_search')));
    const create = (list.body.result.tools as { name: string; annotations: Record<string, unknown> }[]).find((t) => t.name === 'records_delete')!;
    expect(create.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });

    const call = await rpc(c.path, tok.access_token, 'tools/call', { name: 'workflow_summarise', arguments: { topic: 'Q3 pipeline' } }).expect(200);
    expect(call.body.result.isError, JSON.stringify(call.body)).toBe(false);
    expect(JSON.parse(call.body.result.content[0].text)).toMatchObject({ run: expect.any(String) });
    const audit = (await h.s.db('audit_events').where({ action: 'mcp.server.call' }).orderBy('seq', 'desc').first()) as { actor: string; target: string; detail: string };
    expect(JSON.parse(audit.target)).toMatchObject({ workspace: c.ws, tool: 'workflow_summarise' });
    expect(JSON.parse(audit.detail)).toMatchObject({ group: 'workflows', outcome: 'ok' });
    expect(JSON.parse(audit.actor)).toMatchObject({ user: c.miaId, service: c.clientId });

    // Records: query and count as the user.
    const q = await rpc(c.path, tok.access_token, 'tools/call', { name: 'records_query', arguments: { app: 'crm', entity: 'deal' } }).expect(200);
    expect(q.body.result.structuredContent.records).toEqual([expect.objectContaining({ values: expect.objectContaining({ title: 'Acme renewal' }) })]);
    const n = await rpc(c.path, tok.access_token, 'tools/call', { name: 'records_count', arguments: { app: 'crm', entity: 'deal', filter: { field: 'amount', op: 'gt', value: 2000 } } }).expect(200);
    expect(n.body.result.structuredContent, JSON.stringify(n.body)).toEqual({ count: 0 });
    // The groups the client picked narrow what it sees.
    const only = await rpc(c.path, tok.access_token, 'tools/list', {}, '?groups=records').expect(200);
    expect((only.body.result.tools as { name: string }[]).some((t) => t.name === 'workflow_summarise')).toBe(false);
    // Unknown tools and methods are JSON-RPC errors.
    expect((await rpc(c.path, tok.access_token, 'tools/call', { name: 'nope' })).body.error.code).toBe(-32602);
    expect((await rpc(c.path, tok.access_token, 'resources/list')).body.error.code).toBe(-32601);

    // The refresh keeps the audience.
    const ref = await request(h.app).post('/oauth/token').type('form').send({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: c.clientId }).expect(200);
    expect(JSON.parse(Buffer.from(ref.body.access_token.split('.')[1], 'base64url').toString()).aud).toBe(c.resource);
    await rpc(c.path, ref.body.access_token, 'ping').expect(200);
    // Naming another resource at refresh is refused (RFC 8707).
    const bad = await request(h.app).post('/oauth/token').type('form').send({ grant_type: 'refresh_token', refresh_token: ref.body.refresh_token, client_id: c.clientId, resource: 'http://localhost:8080/api' });
    expect(bad.body.error).toBe('invalid_target');
  });

  it('B-7102: a token issued for another resource is refused with 401 and the metadata URL; MCP tokens do not open the API', async () => {
    const c = await setup();
    await publish(c);
    await put(c.admin, `/api/admin/mcp-server/workspaces/${c.other}`, { enabled: true }).expect(200);
    // A token for the API.
    const api = await token(c, c.mia, null);
    const r1 = await rpc(c.path, api.access_token, 'initialize');
    expect(r1.status).toBe(401);
    expect(challengeParams(r1.headers['www-authenticate'] as string)).toMatchObject({ error: 'invalid_token', resource_metadata: `http://localhost:8080/.well-known/oauth-protected-resource${c.path}` });
    await request(h.app).get('/api/me').set('authorization', `Bearer ${api.access_token}`).expect(200);
    // A token for another workspace's MCP server.
    const legal = await token(c, c.mia, mcpResource(h.s.cfg, c.slug, c.other));
    expect((await rpc(c.path, legal.access_token, 'initialize')).status).toBe(401);
    await rpc(`/mcp/${c.slug}/${c.other}`, legal.access_token, 'initialize').expect(200);
    // An MCP token at the API.
    await request(h.app).get('/api/me').set('authorization', `Bearer ${legal.access_token}`).expect(401);
    // A resource this issuer does not serve is refused at the authorization endpoint (RFC 8707 invalid_target).
    const q = new URLSearchParams({ response_type: 'code', client_id: c.clientId, redirect_uri: REDIRECT, scope: SCOPE, state: 'x', code_challenge: pkce().challenge, code_challenge_method: 'S256', resource: 'https://evil.example.com/mcp' });
    const res = await c.mia.agent.get(`/oauth/authorize?${q}`);
    expect(new URL(res.headers.location as string).searchParams.get('error')).toBe('invalid_target');
    // Garbage and a missing scope.
    expect((await rpc(c.path, 'eyJnot.a.jwt', 'initialize')).status).toBe(401);
    const narrow = await token(c, c.mia, c.resource, 'offline_access');
    const r3 = await rpc(c.path, narrow.access_token, 'initialize');
    expect(r3.status).toBe(403);
    expect(challengeParams(r3.headers['www-authenticate'] as string).error).toBe('insufficient_scope');
    // DPoP required: a bearer token is refused.
    await publish(c, { requireDpop: true });
    const dp = await token(c, c.mia, c.resource);
    const r4 = await rpc(c.path, dp.access_token, 'initialize');
    expect(r4.status).toBe(401);
    expect(r4.headers['www-authenticate']).toContain('DPoP algs=');
    // Unpublished: gone.
    await publish(c, { enabled: false, requireDpop: false });
    expect((await rpc(c.path, dp.access_token, 'initialize')).status).toBe(404);
  });

  it('B-7101: writes wait for the user\'s approval from a browser session, and run once approved', async () => {
    const c = await setup();
    await publish(c, { enabled: true, groups: ['records'] });
    const tok = await token(c, c.mia, c.resource);
    const args = { app: 'crm', entity: 'deal', values: { title: 'Globex pilot', amount: 300 } };
    const first = await rpc(c.path, tok.access_token, 'tools/call', { name: 'records_create', arguments: args }).expect(200);
    expect(first.body.result.isError).toBe(true);
    const held = first.body.result.structuredContent.held as { id: string };
    expect(held.id).toHaveLength(26);
    expect(await h.s.db('app_records').count({ n: '*' }).first()).toMatchObject({ n: 1 });
    // The user sees it, with its arguments.
    const mine = (await c.mia.agent.get('/api/me/mcp-server').expect(200)).body;
    expect(mine.servers).toEqual([expect.objectContaining({ workspaceId: c.ws, url: c.resource, groups: ['records'] })]);
    expect(mine.holds).toEqual([expect.objectContaining({ id: held.id, tool: 'records_create', state: 'pending', arguments: args, client: c.clientId })]);
    // The token that asked cannot approve (it is not a browser session, nor a token for the API).
    await request(h.app).post(`/api/me/mcp-holds/${held.id}/decide`).set('authorization', `Bearer ${tok.access_token}`).send({ decision: 'approve' }).expect(401);
    // Nobody else can decide it.
    await post(c.noah, `/api/me/mcp-holds/${held.id}/decide`, { decision: 'approve' }).expect(404);
    await post(c.mia, `/api/me/mcp-holds/${held.id}/decide`, { decision: 'approve' }).expect(200);
    // Other arguments are not covered by the approval.
    const other = await rpc(c.path, tok.access_token, 'tools/call', { name: 'records_create', arguments: { ...args, values: { title: 'Other' } } }).expect(200);
    expect(other.body.result.structuredContent.held).toBeTruthy();
    const second = await rpc(c.path, tok.access_token, 'tools/call', { name: 'records_create', arguments: args }).expect(200);
    expect(second.body.result.isError, JSON.stringify(second.body)).toBe(false);
    expect(second.body.result.structuredContent).toMatchObject({ values: { title: 'Globex pilot' } });
    // Used once.
    const third = await rpc(c.path, tok.access_token, 'tools/call', { name: 'records_create', arguments: args }).expect(200);
    expect(third.body.result.structuredContent.held).toBeTruthy();
    expect(await h.s.db('app_records').count({ n: '*' }).first()).toMatchObject({ n: 2 });
    const actions = ((await h.s.db('audit_events').whereIn('action', ['mcp.server.hold.approved', 'mcp.server.call']).select('action', 'detail')) as { action: string; detail: string }[]).map((a) => `${a.action}:${JSON.parse(a.detail).outcome ?? ''}`);
    expect(actions).toEqual(expect.arrayContaining(['mcp.server.call:held', 'mcp.server.hold.approved:', 'mcp.server.call:ok']));
    // A rejected one stays rejected.
    const h2 = (await h.s.mcpServer.holds((await loadPrincipal(h.s, h.tenantId, c.miaId, {}))!, 'pending')).find((x) => x.state === 'pending')!;
    await post(c.mia, `/api/me/mcp-holds/${h2.id}/decide`, { decision: 'reject' }).expect(200);
    await post(c.mia, `/api/me/mcp-holds/${h2.id}/decide`, { decision: 'approve' }).expect(409);
  });

  it('B-7101: the label the workspace publishes at caps what comes back, and agents run as the user', async () => {
    const c = await setup();
    await post(c.admin, '/api/apps/crm/entities/deal/records', { values: { title: 'Secret merger', amount: 9 }, label: 'confidential' }).expect(201);
    // An agent published to the workspace.
    const e = (await post(c.t, '/api/admin/registry', { kind: 'agent', name: 'Helper', version: '1.0.0', description: 'Helper: answers short questions about the pipeline plainly.', label: 'confidential', definition: { profile: 'general', systemPrompt: 'H.', tools: [], budgets: BUDGETS } }).expect(201)).body;
    await post(c.t, `/api/admin/registry/${e.id}/submit`).expect(200);
    await post(c.t2, `/api/admin/registry/${e.id}/review`, { decision: 'approve' }).expect(200);
    ollama!.reply = () => ({ content: 'The pipeline holds two deals.' });
    await publish(c, { enabled: true, groups: ['records', 'agents'], label: 'internal' });
    const tok = await token(c, c.mia, c.resource);
    const q = await rpc(c.path, tok.access_token, 'tools/call', { name: 'records_query', arguments: { app: 'crm', entity: 'deal' } }).expect(200);
    expect((q.body.result.structuredContent.records as { values: { title: string } }[]).map((r) => r.values.title)).toEqual(['Acme renewal']);

    // The agent's profile is confidential: the workspace publishes at that label for the agent.
    await publish(c, { label: 'confidential' });
    const tools = (await rpc(c.path, tok.access_token, 'tools/list').expect(200)).body.result.tools as { name: string }[];
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['agent_Helper', 'exprsn_run_status']));
    h.s.mcpServer.waitMs = 0;
    const started = await rpc(c.path, tok.access_token, 'tools/call', { name: 'agent_Helper', arguments: { task: 'How many deals?' } }).expect(200);
    expect(started.body.result.isError, JSON.stringify(started.body)).toBe(false);
    const pending = started.body.result.structuredContent.pending as { handle: string; id: string };
    expect(pending.handle).toMatch(/^agent:/);
    await drain(h);
    const done = await rpc(c.path, tok.access_token, 'tools/call', { name: 'exprsn_run_status', arguments: { handle: pending.handle } }).expect(200);
    expect(done.body.result.isError, JSON.stringify(done.body)).toBe(false);
    expect(done.body.result.structuredContent).toMatchObject({ agent: 'Helper', answer: 'The pipeline holds two deals.' });
    const run = (await h.s.db('agent_runs').where({ id: pending.id }).first()) as { user_id: string; label: string };
    expect(run).toMatchObject({ user_id: c.miaId, label: 'confidential' });
    // Another user's handle is not theirs to read.
    const noahTok = await token(c, c.noah, c.resource);
    const peek = await rpc(c.path, noahTok.access_token, 'tools/call', { name: 'exprsn_run_status', arguments: { handle: pending.handle } }).expect(200);
    expect(peek.body.result.isError).toBe(true);
  });

  it('B-7102: dynamic client registration, when the tenant allows it', async () => {
    const c = await setup();
    const reg = { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none' };
    expect((await request(h.app).post('/oauth/register').send(reg)).status).toBe(404);
    await put(c.admin, '/api/admin/mcp-server/settings', { dynamicRegistration: true }).expect(200);
    const as = await request(h.app).get('/.well-known/oauth-authorization-server').expect(200);
    expect(as.body.registration_endpoint).toBe('http://localhost:8080/oauth/register');
    const ok = await request(h.app).post('/oauth/register').send(reg);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ client_name: 'Claude', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] });
    expect(ok.body.client_secret).toBeUndefined();
    expect(ok.body.scope.split(' ')).toEqual(expect.arrayContaining(['tools:invoke', 'inference:invoke', 'records:read']));
    const row = await h.s.federation.oidc.byClientId(h.tenantId, ok.body.client_id);
    expect(row).toMatchObject({ type: 'public', dynamic: true, pkce_required: true });
    // Confidential: a secret, shown once.
    const conf = await request(h.app).post('/oauth/register').send({ ...reg, token_endpoint_auth_method: 'client_secret_basic' });
    expect(conf.status, conf.text).toBe(201);
    expect(conf.body.client_secret).toMatch(/^xs_live_/);
    // Refused metadata.
    expect((await request(h.app).post('/oauth/register').send({ ...reg, redirect_uris: ['http://evil.example.com/cb'] })).body.error).toBe('invalid_redirect_uri');
    expect((await request(h.app).post('/oauth/register').send({ ...reg, grant_types: ['client_credentials'] })).body.error).toBe('invalid_client_metadata');
    // Listed on the MCP server page, and audited.
    const page = (await c.admin.agent.get('/api/admin/mcp-server').expect(200)).body;
    expect(page.dynamicRegistration).toBe(true);
    expect(page.clients.map((x: { clientId: string }) => x.clientId)).toContain(ok.body.client_id);
    expect(await h.s.db('audit_events').where({ action: 'oidc.client.registered' }).count({ n: '*' }).first()).toMatchObject({ n: 2 });
  });
});

describe('Sprint 37b: MCP client OAuth per user (B-7103)', () => {
  let h: Harness;
  let mcp: FakeMcp;
  let as: FakeAs;
  afterEach(async () => {
    await h.close();
    await as.stop();
    await mcp.stop();
  });

  it('discovers, registers, connects two users who act under their own accounts, refreshes, and revokes on disconnect', async () => {
    h = await harness();
    mcp = await new FakeMcp().start();
    mcp.tools = [{ name: 'whoami', description: 'Who the server thinks you are.', annotations: { readOnlyHint: true }, run: (_a, auth) => ({ user: as.userOf(auth) }) }];
    as = await new FakeAs(mcp).start();
    await localUser(h, 'tooladm', ['tool-admin', 'member']);
    await localUser(h, 'ann', ['member']);
    await localUser(h, 'bo', ['member']);
    const admin = await loginAdmin(h, 'tooladm');
    const ann = await login(h, 'ann');
    const bo = await login(h, 'bo');

    const srv = (await post(admin, '/api/admin/mcp-servers', { name: 'notes', url: mcp.url, auth: 'user' }).expect(201)).body as { id: string; health: string };
    expect(srv.health).toBe('unreachable');
    // Start before any configuration: refused with a reason.
    expect((await post(ann, '/api/mcp-oauth/start', { server: srv.id })).status).toBe(409);
    const disc = await post(admin, `/api/admin/mcp-servers/${srv.id}/oauth/discover`).expect(200);
    expect(disc.body.steps.map((x: { check: string; result: string }) => `${x.check}:${x.result}`)).toEqual(['Challenge:passed', 'Protected resource metadata:passed', 'Authorization server metadata:passed', 'Client registration:passed']);
    expect(disc.body.oauth).toMatchObject({ mode: 'discovered', issuer: as.url, clientId: 'dyn-1', registered: true, resource: mcp.url, scopes: 'notes' });
    expect(as.registrations[0]).toMatchObject({ redirect_uris: ['http://localhost:8080/api/mcp-oauth/callback'], token_endpoint_auth_method: 'none' });

    const connect = async (c: Client, user: string) => {
      const start = await post(c, '/api/mcp-oauth/start', { server: srv.id }).expect(200);
      const url = new URL(start.body.authorizeUrl);
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('resource')).toBe(mcp.url);
      url.searchParams.set('user', user);
      const r = await fetch(url, { redirect: 'manual' });
      const back = new URL(r.headers.get('location')!);
      expect(back.pathname).toBe('/api/mcp-oauth/callback');
      return c.agent.get(`${back.pathname}${back.search}`);
    };
    const a = await connect(ann, 'ann@notes');
    expect(a.status).toBe(302);
    expect(a.headers.location).toMatch(/^\/#\/settings\?tab=mcp&server=.*&result=connected$/);
    await connect(bo, 'bo@notes');
    // Sealed at rest.
    const rows = (await h.s.db('mcp_tokens').where({ server_id: srv.id })) as { token: string; refresh_token: string; source: string }[];
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.source).toBe('oauth');
      expect(r.token).not.toContain('at-');
      expect(r.refresh_token).not.toContain('rt-');
    }
    expect((await ann.agent.get('/api/mcp/servers').expect(200)).body[0]).toMatchObject({ id: srv.id, oauth: true, connected: true, source: 'oauth' });

    // The admin connects too, checks, and approves the tool.
    await connect(admin, 'admin@notes');
    await post(admin, `/api/admin/mcp-servers/${srv.id}/check`).expect(200);
    await post(admin, `/api/admin/mcp-servers/${srv.id}/tools/whoami/approve`, { sideEffect: 'read', confirm: 'never', label: 'internal' }).expect(200);
    const as1 = (await loadPrincipal(h.s, h.tenantId, (await h.s.users.byUsername(h.tenantId, 'ann'))!.id, {}))!;
    const bo1 = (await loadPrincipal(h.s, h.tenantId, (await h.s.users.byUsername(h.tenantId, 'bo'))!.id, {}))!;
    expect((await h.s.mcp.call(as1, srv.id, 'whoami', {})).structuredContent).toEqual({ user: 'ann@notes' });
    expect((await h.s.mcp.call(bo1, srv.id, 'whoami', {})).structuredContent).toEqual({ user: 'bo@notes' });

    // Expired access tokens are refreshed before the call (and rotated).
    as.expireAll();
    expect((await h.s.mcp.call(as1, srv.id, 'whoami', {})).structuredContent).toEqual({ user: 'ann@notes' });
    expect(as.tokenRequests.filter((f) => f.grant_type === 'refresh_token' && f.resource === mcp.url)).not.toHaveLength(0);

    // Disconnecting revokes at the authorization server and forgets the token; Bo is unaffected.
    await ann.agent.delete(`/api/mcp/servers/${srv.id}/token`).set('x-csrf-token', ann.csrf).expect(204);
    expect(as.revoked.some((t) => t.startsWith('rt-ann@notes'))).toBe(true);
    expect(as.revoked.some((t) => t.startsWith('at-ann@notes'))).toBe(true);
    expect(await h.s.mcp.unavailable(srv.id, 'whoami', as1.userId)).toMatch(/Connect your token/);
    expect((await h.s.mcp.call(bo1, srv.id, 'whoami', {})).structuredContent).toEqual({ user: 'bo@notes' });
    const actions = ((await h.s.db('audit_events').where('action', 'like', 'mcp.%').select('action')) as { action: string }[]).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['mcp.oauth.discovered', 'mcp.oauth.started', 'mcp.oauth.connected', 'mcp.oauth.refreshed', 'mcp.token.removed']));
  });

  it('refuses a callback from another browser, a replayed state, and takes endpoints by hand', async () => {
    h = await harness();
    mcp = await new FakeMcp().start();
    as = await new FakeAs(mcp).start();
    await localUser(h, 'tooladm', ['tool-admin', 'member']);
    await localUser(h, 'ann', ['member']);
    const admin = await loginAdmin(h, 'tooladm');
    const ann = await login(h, 'ann');
    const srv = (await post(admin, '/api/admin/mcp-servers', { name: 'notes', url: mcp.url, auth: 'user' }).expect(201)).body as { id: string };
    // Manual: the endpoints and a client id entered by hand.
    const man = await put(admin, `/api/admin/mcp-servers/${srv.id}/oauth`, { authorizationEndpoint: `${as.url}/authorize`, tokenEndpoint: `${as.url}/token`, revocationEndpoint: `${as.url}/revoke`, clientId: 'hand-1', scopes: 'notes' }).expect(200);
    expect(man.body.oauth).toMatchObject({ mode: 'manual', clientId: 'hand-1', resource: mcp.url, hasSecret: false });
    const start = await post(ann, '/api/mcp-oauth/start', { server: srv.id }).expect(200);
    const url = new URL(start.body.authorizeUrl);
    url.searchParams.set('user', 'ann@notes');
    const back = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location')!);
    // Another browser (no binding cookie) is refused.
    const stranger = await request(h.app).get(`${back.pathname}${back.search}`).expect(302);
    expect(stranger.headers.location).toMatch(/result=failed/);
    // The state is single use: the right browser now finds it gone too.
    const late = await ann.agent.get(`${back.pathname}${back.search}`).expect(302);
    expect(late.headers.location).toMatch(/result=failed/);
    expect(await h.s.db('mcp_tokens').count({ n: '*' }).first()).toMatchObject({ n: 0 });
    // A refusal from the authorization server.
    const s2 = await post(ann, '/api/mcp-oauth/start', { server: srv.id }).expect(200);
    const state = new URL(s2.body.authorizeUrl).searchParams.get('state')!;
    const denied = await ann.agent.get(`/api/mcp-oauth/callback?state=${state}&error=access_denied`).expect(302);
    expect(new URLSearchParams((denied.headers.location as string).split('?')[1]).get('reason')).toMatch(/refused: access_denied/);
    // Discovery against a server without metadata fails with steps, and a manual configuration can be removed.
    await admin.agent.delete(`/api/admin/mcp-servers/${srv.id}/oauth`).set('x-csrf-token', admin.csrf).expect(204);
    mcp.challenge = 'Bearer';
    as.stop();
    const fail = await post(admin, `/api/admin/mcp-servers/${srv.id}/oauth/discover`);
    expect(fail.status).toBe(422);
    expect(fail.body.steps.at(-1)).toMatchObject({ result: 'failed' });
    as = await new FakeAs(mcp).start();
  });
});
