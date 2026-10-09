/*
 * Sprint 41a (1.7.0): standing approvals for MCP server write calls (B-12201). A person grants, from a browser
 * session, a standing approval for a client's write calls in a workspace's MCP server (one tool or every tool, one
 * client or any, up to a side-effect class, for a period); a covered call runs without the per-call hold of Sprint
 * 37b; a call the tool-call guardrail holds still waits; revoking (or expiry) makes the next call wait again.
 */
import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { mcpResource } from '../src/mcp/server/resource.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';
import { seedGateway } from './seed-gateway.js';

const REDIRECT = 'http://127.0.0.1:33418/callback';
const SCOPE = 'tools:invoke agents:run inference:invoke knowledge:read records:read records:write offline_access';
const b64u = (b: Buffer) => b.toString('base64url');
const post = (c: Client, url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body);
const put = (c: Client, url: string, body: object) => c.agent.put(url).set('x-csrf-token', c.csrf).send(body);
const del = (c: Client, url: string) => c.agent.delete(url).set('x-csrf-token', c.csrf);

describe('Sprint 41a: standing approvals for MCP write calls (B-12201)', () => {
  let h: Harness;
  let ollama: FakeOllama | null = null;
  afterEach(async () => {
    await h.close();
    await ollama?.stop();
    ollama = null;
  });

  async function setup(env: Record<string, string> = {}) {
    h = await harness({ OLLAMA_POLL_MS: '600000', ...env });
    ollama = await new FakeOllama().start();
    ollama.chatDelayMs = 0;
    await seedGateway(h, ollama);
    const ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Sales', 'confidential')).id;
    const users = [await localUser(h, 'idadmin', ['tenant-admin', 'workflow-admin', 'member'], 'confidential'), await localUser(h, 'mia', ['member'], 'confidential'), await localUser(h, 'noah', ['member'], 'confidential')];
    for (const u of users) await h.s.tenants.addMember(ws, u.id);
    const c = { admin: await loginAdmin(h, 'idadmin'), mia: await login(h, 'mia'), noah: await login(h, 'noah'), ws, miaId: users[1]!.id };
    for (const x of [c.admin, c.mia, c.noah]) await put(x, '/api/me/workspace', { workspaceId: ws }).expect(200);
    const slug = (await h.s.tenants.byId(h.tenantId))!.slug;
    await post(c.admin, '/api/apps', { name: 'crm', title: 'CRM', label: 'confidential', workspaceId: ws }).expect(201);
    await post(c.admin, '/api/apps/crm/entities', { name: 'deal', title: 'Deal', label: 'internal', definition: { fields: [{ name: 'title', type: 'string', required: true, maxLength: 120 }] } }).expect(201);
    const client = (await post(c.admin, '/api/admin/federation/oidc/clients', { name: 'Claude Desktop', type: 'public', redirectUris: [REDIRECT], scopes: SCOPE.split(' '), grants: ['authorization_code', 'refresh_token'] }).expect(201)).body.client as { clientId: string };
    await put(c.admin, `/api/admin/mcp-server/workspaces/${ws}`, { enabled: true, groups: ['records'] }).expect(200);
    return { ...c, slug, clientId: client.clientId, resource: mcpResource(h.s.cfg, slug, ws), path: `/mcp/${slug}/${ws}` };
  }
  type Ctx = Awaited<ReturnType<typeof setup>>;

  async function token(c: Ctx, user: Client) {
    const verifier = b64u(randomBytes(48));
    const q = new URLSearchParams({ response_type: 'code', client_id: c.clientId, redirect_uri: REDIRECT, scope: SCOPE, state: 'st', code_challenge: b64u(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', resource: c.resource });
    let res = await user.agent.get(`/oauth/authorize?${q}`);
    if (res.status === 200) {
      const handle = /name="handle" value="([^"]+)"/.exec(res.text)![1]!;
      const csrf = /name="csrf" value="([^"]+)"/.exec(res.text)![1]!;
      res = await user.agent.post('/oauth/authorize').type('form').send({ handle, csrf, decision: 'allow' });
    }
    expect(res.status, res.text).toBe(302);
    const code = new URL(res.headers.location as string).searchParams.get('code');
    const tok = await request(h.app).post('/oauth/token').type('form').send({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: c.clientId, resource: c.resource });
    expect(tok.status, JSON.stringify(tok.body)).toBe(200);
    return (tok.body as { access_token: string }).access_token;
  }

  const rpc = (path: string, tok: string, method: string, params: object = {}) =>
    request(h.app).post(path).set('content-type', 'application/json').set('accept', 'application/json, text/event-stream').set('mcp-protocol-version', '2025-06-18').set('authorization', `Bearer ${tok}`).send(JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }));

  const create = (c: Ctx, tok: string, title: string) => rpc(c.path, tok, 'tools/call', { name: 'records_create', arguments: { app: 'crm', entity: 'deal', values: { title } } });
  const isHeld = (r: request.Response) => !!(r.body.result?.structuredContent as { held?: unknown } | undefined)?.held;

  it('a per-tool standing approval runs write calls without a hold; a guardrail hold still waits; revoking makes the next call wait again', async () => {
    const c = await setup();
    const tok = await token(c, c.mia);
    // Without one: held, as in Sprint 37b.
    expect(isHeld(await create(c, tok, 'Held one').expect(200))).toBe(true);
    // The client's own token cannot grant; the person does, from a browser session.
    await request(h.app).post('/api/me/mcp-approvals').set('authorization', `Bearer ${tok}`).send({ workspaceId: c.ws, tool: 'records_create', sideEffect: 'write', days: 7 }).expect(401);
    const tools = (await c.mia.agent.get(`/api/me/mcp-approvals/tools?workspaceId=${c.ws}`).expect(200)).body.tools as { name: string; sideEffect: string }[];
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['records_create', 'records_update', 'records_delete']));
    expect(tools.some((t) => t.name === 'records_query')).toBe(false);
    const grant = (await post(c.mia, '/api/me/mcp-approvals', { workspaceId: c.ws, tool: 'records_create', clientId: c.clientId, sideEffect: 'write', days: 7, reason: 'My own client' }).expect(201)).body as { id: string; state: string; expiresAt: number; label: string };
    expect(grant).toMatchObject({ state: 'active', tool: 'records_create', client: c.clientId, sideEffect: 'write', label: 'internal' });
    expect(grant.expiresAt).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    // Covered: runs at once, metered and audited with the approval that covered it.
    const ran = await create(c, tok, 'Covered').expect(200);
    expect(ran.body.result.isError, JSON.stringify(ran.body)).toBe(false);
    const calls = (await h.s.audit.list(h.tenantId, { action: 'mcp.server.call' })).map((e) => e.detail as { outcome: string; standing: string | null });
    expect(calls).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: 'ok', standing: grant.id }), expect.objectContaining({ outcome: 'held', standing: null })]));
    expect((await h.s.audit.list(h.tenantId, { action: 'mcp.server.standing.granted' })).length).toBe(1);
    const mine = (await c.mia.agent.get('/api/me/mcp-server').expect(200)).body as { approvals: { id: string; uses: number; state: string }[]; standingMaxDays: number };
    expect(mine.standingMaxDays).toBe(30);
    expect(mine.approvals).toEqual([expect.objectContaining({ id: grant.id, uses: 1, state: 'active', workspace: 'Sales' })]);
    // Not covered: another tool of the server, and a different client.
    expect(isHeld(await rpc(c.path, tok, 'tools/call', { name: 'records_update', arguments: { app: 'crm', entity: 'deal', id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', values: { title: 'x' } } }).expect(200))).toBe(true);
    // The tool-call guardrail's hold is not covered: a rule that holds still waits for a reviewer.
    const orig = h.s.guardrails;
    h.s.guardrails = { ...orig, check: async (i) => (i.checkpoint === 'tool-call' && i.text.includes('hold me') ? { action: 'require-approval', text: i.text, findings: [], reason: 'Held for review.' } : orig.check(i)) } as typeof orig;
    const byRule = await create(c, tok, 'hold me').expect(200);
    expect(isHeld(byRule)).toBe(true);
    expect(String(byRule.body.result.content[0].text)).toContain('held by the tool-call guardrail');
    h.s.guardrails = orig;
    // Someone else cannot revoke it; the owner can; then the next call waits again.
    await del(c.noah, `/api/me/mcp-approvals/${grant.id}`).expect(404);
    await del(c.mia, `/api/me/mcp-approvals/${grant.id}`).expect(204);
    await del(c.mia, `/api/me/mcp-approvals/${grant.id}`).expect(409);
    expect(isHeld(await create(c, tok, 'After revoke').expect(200))).toBe(true);
    expect((await h.s.audit.list(h.tenantId, { action: 'mcp.server.standing.revoked' })).map((e) => (e.detail as { by: string }).by)).toEqual(['owner']);
    expect((await c.mia.agent.get('/api/me/mcp-approvals').expect(200)).body.approvals).toEqual([expect.objectContaining({ id: grant.id, state: 'revoked' })]);
  });

  it('a per-server approval covers every write tool up to its class; validation; an identity admin lists and revokes; expiry is swept and audited', async () => {
    const c = await setup({ MCP_STANDING_APPROVAL_MAX_DAYS: '10' });
    const tok = await token(c, c.mia);
    // Validation.
    await post(c.mia, '/api/me/mcp-approvals', { workspaceId: c.ws, sideEffect: 'write', days: 11 }).expect(409);
    await post(c.mia, '/api/me/mcp-approvals', { workspaceId: c.ws, tool: 'records_query', sideEffect: 'write', days: 1 }).expect(409);
    await post(c.mia, '/api/me/mcp-approvals', { workspaceId: c.ws, tool: 'no_such_tool', sideEffect: 'write', days: 1 }).expect(404);
    await post(c.mia, '/api/me/mcp-approvals', { workspaceId: c.ws, tool: 'records_delete', sideEffect: 'write', days: 1 }).expect(409);
    // Every tool, any client, writes only: create runs, delete (destructive) is still held.
    const all = (await post(c.mia, '/api/me/mcp-approvals', { workspaceId: c.ws, sideEffect: 'write', days: 10 }).expect(201)).body as { id: string };
    const made = await create(c, tok, 'Any tool').expect(200);
    expect(made.body.result.isError, JSON.stringify(made.body)).toBe(false);
    const id = made.body.result.structuredContent.id as string;
    expect(isHeld(await rpc(c.path, tok, 'tools/call', { name: 'records_delete', arguments: { app: 'crm', entity: 'deal', id } }).expect(200))).toBe(true);
    // Noah's grant does not cover Mia's calls, and Mia does not see it.
    await post(c.noah, '/api/me/mcp-approvals', { workspaceId: c.ws, sideEffect: 'destructive', days: 1 }).expect(201);
    expect(isHeld(await rpc(c.path, tok, 'tools/call', { name: 'records_delete', arguments: { app: 'crm', entity: 'deal', id } }).expect(200))).toBe(true);
    expect((await c.mia.agent.get('/api/me/mcp-approvals').expect(200)).body.approvals).toHaveLength(1);
    // The identity admin sees the tenant's approvals and revokes any; a member may not.
    const admin = (await c.admin.agent.get('/api/admin/mcp-server').expect(200)).body as { standingApprovals: { id: string; username: string }[]; standingMaxDays: number };
    expect(admin.standingMaxDays).toBe(10);
    expect(admin.standingApprovals.map((a) => a.username).sort()).toEqual(['mia', 'noah']);
    await del(c.noah, `/api/admin/mcp-server/approvals/${all.id}`).expect(403);
    await del(c.admin, `/api/admin/mcp-server/approvals/${all.id}`).expect(204);
    expect((await h.s.audit.list(h.tenantId, { action: 'mcp.server.standing.revoked' })).map((e) => (e.detail as { by: string }).by)).toEqual(['admin']);
    expect(isHeld(await create(c, tok, 'After admin revoke').expect(200))).toBe(true);
    // Expiry: the sweep marks it, audits it once, and the call waits.
    const late = (await post(c.mia, '/api/me/mcp-approvals', { workspaceId: c.ws, sideEffect: 'write', days: 1 }).expect(201)).body as { id: string };
    await h.s.db('mcp_standing_approvals').where({ id: late.id }).update({ expires_at: Date.now() - 1000 });
    expect(isHeld(await create(c, tok, 'Expired').expect(200))).toBe(true);
    expect(await h.s.mcpServer.expireStanding(h.tenantId)).toBe(1);
    expect(await h.s.mcpServer.expireStanding(h.tenantId)).toBe(0);
    expect((await h.s.audit.list(h.tenantId, { action: 'mcp.server.standing.expired' })).map((e) => (e.target as { standing: string }).standing)).toEqual([late.id]);
    expect((await c.mia.agent.get('/api/me/mcp-approvals').expect(200)).body.approvals).toEqual(expect.arrayContaining([expect.objectContaining({ id: late.id, state: 'expired' })]));
  });
});
