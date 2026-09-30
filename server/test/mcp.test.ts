import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addressProblem, checkUrl, parseAllowList } from '../src/mcp/hosts.js';
import { FakeMcp } from './fake-mcp.js';
import { FakeOllama } from './fake-ollama.js';
import { seedGateway } from './seed-gateway.js';
import { harness, localUser, login, loginAdmin, type Harness } from './helpers.js';

const none = parseAllowList('');

describe('MCP hosts', () => {
  it('accepts internal addresses only, unless the allow-list names the host or network', async () => {
    expect(addressProblem('10.1.2.3', 'jira.internal', none)).toBeNull();
    expect(addressProblem('192.168.1.5', 'x', none)).toBeNull();
    expect(addressProblem('127.0.0.1', 'localhost', none)).toBeNull();
    expect(addressProblem('fd12::1', 'x', none)).toBeNull();
    expect(addressProblem('::ffff:10.0.0.1', 'x', none)).toBeNull();
    expect(addressProblem('8.8.8.8', 'mcp.vendor-saas.com', none)).toMatch(/public address/);
    expect(addressProblem('::ffff:8.8.8.8', 'x', none)).toMatch(/public address/);
    expect(addressProblem('169.254.169.254', 'metadata', none)).toMatch(/link-local/);
    expect(addressProblem('fe80::1', 'x', none)).toMatch(/link-local/);
    const allow = parseAllowList('mcp.vendor-saas.com, *.partner.example, 203.0.113.0/24, 169.254.169.254');
    expect(addressProblem('8.8.8.8', 'mcp.vendor-saas.com', allow)).toBeNull();
    expect(addressProblem('8.8.4.4', 'api.partner.example', allow)).toBeNull();
    expect(addressProblem('203.0.113.9', 'x', allow)).toBeNull();
    expect(addressProblem('169.254.169.254', 'x', allow)).toMatch(/link-local/); // never, even when listed
    await expect(checkUrl('http://localhost:9/mcp', none)).resolves.toMatchObject({ host: 'localhost' });
    await expect(checkUrl('https://8.8.8.8/mcp', none)).rejects.toThrow(/public address/);
    await expect(checkUrl('https://user:pw@10.0.0.1/mcp', none)).rejects.toThrow(/credentials/);
    await expect(checkUrl('ftp://10.0.0.1/mcp', none)).rejects.toThrow(/http/);
  });
});

describe('MCP servers', () => {
  let h: Harness;
  let mcp: FakeMcp;

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000', MCP_TIMEOUT_MS: '3000' });
    mcp = await new FakeMcp().start();
    mcp.tools = [
      { name: 'search_issues', description: 'Searches issues by text.', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, annotations: { readOnlyHint: true }, run: (a) => ({ hits: [`${String(a.q)}-1`] }) },
      { name: 'create_issue', description: 'Creates an issue.', inputSchema: { type: 'object', properties: { summary: { type: 'string' } } }, annotations: { destructiveHint: false }, run: () => ({ key: 'FIN-1188' }) }
    ];
  });
  afterEach(async () => {
    await h.close();
    await mcp.stop();
  });

  async function admin(name = 'tooladmin', roles = ['tool-admin']) {
    await localUser(h, name, roles, 'confidential');
    const c = await loginAdmin(h, name);
    return { ...c, post: (path: string, body: object = {}) => c.agent.post(path).set('x-csrf-token', c.csrf).send(body) };
  }

  it('refuses public hosts at registration and audits the refusal', async () => {
    const a = await admin();
    const r = await a.post('/api/admin/mcp-servers', { name: 'vendor', url: 'https://8.8.8.8/mcp' }).expect(422);
    expect(r.body).toMatchObject({ title: 'Internal only', reason: 'public-host' });
    expect(r.body.detail).toMatch(/public address/);
    expect((await h.s.audit.list(h.tenantId, { action: 'mcp.register.refused' }))).toHaveLength(1);
  });

  it('registers, hashes tools, gates them on review, and detects schema changes by the polling job', async () => {
    const a = await admin();
    const reg = (await a.post('/api/admin/mcp-servers', { name: 'jira', url: mcp.url, zone: 'app-internal' }).expect(201)).body;
    expect(reg).toMatchObject({ name: 'jira', health: 'healthy', protocolVersion: '2025-06-18' });
    expect(reg.report.map((x: { check: string; result: string }) => `${x.check}:${x.result}`)).toEqual(['Internal address:passed', 'Initialize handshake:passed', 'tools/list:passed']);
    // The session id from initialize rides on later requests, with the protocol version.
    const listReq = mcp.requests.find((x) => x.method === 'tools/list')!;
    expect(listReq.session).toBeTruthy();
    expect(listReq.protocol).toBe('2025-06-18');

    let detail = (await a.agent.get(`/api/admin/mcp-servers/${reg.id}`).expect(200)).body;
    expect(detail.tools.map((t: { name: string; state: string; suggestedSideEffect: string }) => [t.name, t.state, t.suggestedSideEffect])).toEqual([['create_issue', 'pending', 'write'], ['search_issues', 'pending', 'read']]);
    expect(detail.tools[1].hash).toMatch(/^[a-f0-9]{64}$/);

    await a.post(`/api/admin/mcp-servers/${reg.id}/tools/create_issue/approve`, { sideEffect: 'write', confirm: 'never' }).expect(409);
    await a.post(`/api/admin/mcp-servers/${reg.id}/tools/create_issue/approve`, { sideEffect: 'write', confirm: 'always', label: 'confidential' }).expect(200);
    const approved = (await a.post(`/api/admin/mcp-servers/${reg.id}/tools/search_issues/approve`, { sideEffect: 'read', confirm: 'never', label: 'confidential' }).expect(200)).body;
    expect(approved).toMatchObject({ state: 'approved', approvedHash: approved.hash, sideEffect: 'read' });
    // Approval publishes a registry entry for the tool.
    const entry = (await h.s.registry.list(h.tenantId, { kind: 'tool' })).find((e) => e.name === 'jira.search_issues')!;
    expect(entry).toMatchObject({ impl: 'mcp', status: 'published', approved_hash: approved.hash, side_effect: 'read' });

    // The server changes a tool's schema; the scheduled poll (a job) notices and disables it.
    mcp.tools[0]!.inputSchema = { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'integer' } }, required: ['q'] };
    mcp.tools.push({ name: 'delete_project', description: 'Deletes a project.', annotations: { destructiveHint: true } });
    await h.s.jobs.enqueue({ tenantId: h.tenantId, type: 'mcp.poll', payload: { tenantId: h.tenantId } });
    await h.s.jobs.runDue();
    detail = (await a.agent.get(`/api/admin/mcp-servers/${reg.id}`).expect(200)).body;
    expect(detail.health).toBe('changed');
    const changed = detail.tools.find((t: { name: string }) => t.name === 'search_issues');
    expect(changed.state).toBe('changed');
    expect(changed.hash).not.toBe(changed.approvedHash);
    expect(changed.approvedSchema.inputSchema.properties.limit).toBeUndefined();
    expect(detail.tools.find((t: { name: string }) => t.name === 'delete_project')).toMatchObject({ state: 'pending', suggestedSideEffect: 'destructive' });
    expect(detail.events.map((e: { title: string }) => e.title)).toEqual(expect.arrayContaining(['Schema changed', 'delete_project offered by server', 'Tool schema changed']));
    expect(await h.s.mcp.unavailable(reg.id, 'search_issues', 'anyone')).toMatch(/disabled until its new schema is approved/);
    const userId = (await h.s.users.byUsername(h.tenantId, 'tooladmin'))!.id;
    expect((await h.s.notifications.list(userId)).map((n) => n.title)).toContain('jira.search_issues changed its schema');
    expect(await h.s.audit.list(h.tenantId, { action: 'mcp.tool.changed' })).toHaveLength(1);

    // Rejecting keeps it disabled; approving the new schema re-enables it and clears the server's state.
    await a.post(`/api/admin/mcp-servers/${reg.id}/tools/search_issues/reject-change`).expect(200);
    expect(await h.s.mcp.unavailable(reg.id, 'search_issues', 'anyone')).toMatch(/rejected/);
    await a.post(`/api/admin/mcp-servers/${reg.id}/tools/search_issues/approve`, { sideEffect: 'read', confirm: 'never', label: 'confidential' }).expect(200);
    detail = (await a.agent.get(`/api/admin/mcp-servers/${reg.id}`).expect(200)).body;
    expect(detail.health).toBe('healthy');
    expect(await h.s.mcp.unavailable(reg.id, 'search_issues', 'anyone')).toBeNull();

    // A tool the server stops offering is removed from routing.
    mcp.tools = mcp.tools.filter((t) => t.name !== 'create_issue');
    await a.post(`/api/admin/mcp-servers/${reg.id}/check`).expect(200);
    detail = (await a.agent.get(`/api/admin/mcp-servers/${reg.id}`).expect(200)).body;
    expect(detail.tools.find((t: { name: string }) => t.name === 'create_issue').state).toBe('removed');
    // Revoking hides a tool again.
    await a.post(`/api/admin/mcp-servers/${reg.id}/tools/search_issues/revoke`).expect(200);
    expect(await h.s.mcp.unavailable(reg.id, 'search_issues', 'anyone')).toMatch(/not approved/);
  });

  it('speaks event streams with pagination, and reports unreachable and incompatible servers', async () => {
    const a = await admin();
    mcp.sse = true;
    mcp.pageSize = 1;
    const reg = (await a.post('/api/admin/mcp-servers', { name: 'jira', url: mcp.url }).expect(201)).body;
    expect(reg.health).toBe('healthy');
    expect((await a.agent.get(`/api/admin/mcp-servers/${reg.id}`).expect(200)).body.tools).toHaveLength(2);

    mcp.down = true;
    const down = (await a.post(`/api/admin/mcp-servers/${reg.id}/check`).expect(200)).body;
    expect(down).toMatchObject({ health: 'unreachable', failures: 1 });
    expect(down.report.find((x: { check: string }) => x.check === 'Initialize handshake').result).toBe('failed');
    mcp.down = false;
    mcp.protocolVersion = '2024-11-05';
    const old = (await a.post(`/api/admin/mcp-servers/${reg.id}/check`).expect(200)).body;
    expect(old.health).toBe('incompatible');
    expect(old.healthDetail).toMatch(/2024-11-05/);
    mcp.protocolVersion = '2025-03-26';
    expect((await a.post(`/api/admin/mcp-servers/${reg.id}/check`).expect(200)).body).toMatchObject({ health: 'healthy', failures: 0 });
  });

  it('keeps service credentials and per-user vault tokens sealed and never returns them', async () => {
    const a = await admin();
    mcp.token = 'service-token-123456';
    await a.post('/api/admin/mcp-servers', { name: 'svc', url: mcp.url, auth: 'service' }).expect(409);
    const svc = (await a.post('/api/admin/mcp-servers', { name: 'svc', url: mcp.url, auth: 'service', credential: 'service-token-123456' }).expect(201)).body;
    expect(svc).toMatchObject({ health: 'healthy', hasCredential: true });
    expect(JSON.stringify(svc)).not.toContain('service-token');
    const raw = await h.s.db('mcp_servers').where({ id: svc.id }).first();
    expect(raw.credential).toMatch(/^v2\./);
    mcp.token = 'rotated-token-7890';
    expect((await a.post(`/api/admin/mcp-servers/${svc.id}/check`).expect(200)).body.health).toBe('unreachable');
    await a.agent.put(`/api/admin/mcp-servers/${svc.id}/credential`).set('x-csrf-token', a.csrf).send({ secret: 'rotated-token-7890' }).expect(200);
    expect((await a.post(`/api/admin/mcp-servers/${svc.id}/check`).expect(200)).body.health).toBe('healthy');

    // A per-user server: tools are listed openly, calls need the user's own token.
    mcp.token = 'user-token-abcdef';
    mcp.tokenFor = 'call';
    const usr = (await a.post('/api/admin/mcp-servers', { name: 'gitlab', url: mcp.url, auth: 'user' }).expect(201)).body;
    await a.post(`/api/admin/mcp-servers/${usr.id}/tools/search_issues/approve`, { sideEffect: 'read', confirm: 'never', label: 'internal' }).expect(200);
    await localUser(h, 'mem', ['member']);
    const m = await login(h, 'mem');
    const memberP = (await h.s.users.byUsername(h.tenantId, 'mem'))!;
    expect(await h.s.mcp.unavailable(usr.id, 'search_issues', memberP.id)).toMatch(/vault connection needed/);
    expect((await m.agent.get('/api/mcp/servers').expect(200)).body).toEqual([expect.objectContaining({ name: 'gitlab', connected: false })]);
    const put = (await m.agent.put(`/api/mcp/servers/${usr.id}/token`).set('x-csrf-token', m.csrf).send({ token: 'user-token-abcdef', scopes: 'api' }).expect(200)).body;
    expect(put).toMatchObject({ connected: true, scopes: 'api' });
    expect(JSON.stringify(put)).not.toContain('abcdef');
    const tok = await h.s.db('mcp_tokens').where({ server_id: usr.id }).first();
    expect(tok.token).toMatch(/^v2\./);
    expect(tok.token).not.toContain('abcdef');
    const detail = (await a.agent.get(`/api/admin/mcp-servers/${usr.id}`).expect(200)).body;
    expect(detail.connections).toEqual([expect.objectContaining({ name: 'MEM', scopes: 'api' })]);
    expect(JSON.stringify(detail)).not.toContain('abcdef');

    // The dispatcher calls the tool with the member's own token.
    const p = (await h.s.users.get(h.tenantId, memberP.id))!;
    const principal = { kind: 'user' as const, userId: p.id, tenantId: h.tenantId, tenantSlug: 'default', username: 'mem', displayName: 'MEM', roles: ['member'], clearance: 'internal' as const, scopes: null, sessionId: null, apiKeyId: null, mfa: false, workspaceId: null };
    const { tools } = await h.s.tools.resolve(principal, ['gitlab.search_issues'], 'internal');
    const out = await h.s.tools.call({ principal, label: 'internal' }, tools[0]!, { q: 'overrun' });
    expect(out).toMatchObject({ ok: true, result: { hits: ['overrun-1'] } });
    expect(mcp.calls.at(-1)).toMatchObject({ name: 'search_issues', auth: 'Bearer user-token-abcdef' });
    // Above the tool's ceiling, the call is refused before it leaves.
    const high = await h.s.tools.call({ principal, label: 'confidential' }, tools[0]!, { q: 'x' });
    expect(high).toMatchObject({ ok: false, denied: true });
    expect(high.error).toMatch(/ceiling is internal/);
    await m.agent.delete(`/api/mcp/servers/${usr.id}/token`).set('x-csrf-token', m.csrf).expect(204);
    expect(await h.s.mcp.unavailable(usr.id, 'search_issues', memberP.id)).toMatch(/vault connection needed/);
  });

  it('binds approved tools to a tools-capable profile, offers them in chat through the dispatcher, and unbinds on deregistration', async () => {
    const ollama = await new FakeOllama().start();
    try {
      const { profile } = await seedGateway(h, ollama);
      const a = await admin('boss', ['tool-admin', 'model-admin']);
      const reg = (await a.post('/api/admin/mcp-servers', { name: 'jira', url: mcp.url }).expect(201)).body;
      await a.post(`/api/admin/mcp-servers/${reg.id}/bind`, { profileId: profile.id }).expect(409); // nothing approved
      await a.post(`/api/admin/mcp-servers/${reg.id}/tools/search_issues/approve`, { sideEffect: 'read', confirm: 'never', label: 'confidential' }).expect(200);
      await a.post(`/api/admin/mcp-servers/${reg.id}/tools/create_issue/approve`, { sideEffect: 'write', confirm: 'always', label: 'confidential' }).expect(200);
      const bound = (await a.post(`/api/admin/mcp-servers/${reg.id}/bind`, { profileId: profile.id }).expect(200)).body;
      expect(bound.tools.sort()).toEqual(['jira.create_issue', 'jira.search_issues']);
      const detail = (await a.agent.get(`/api/admin/mcp-servers/${reg.id}`).expect(200)).body;
      expect(detail.bindings).toEqual([expect.objectContaining({ profile: 'general', model: 'llama3.1:8b', toolsCapable: true, tools: ['create_issue', 'search_issues'] })]);
      // A tool admin without profiles:manage cannot bind.
      const t = await admin('plain');
      await t.post(`/api/admin/mcp-servers/${reg.id}/bind`, { profileId: profile.id }).expect(403);

      // Chat: only the read-class tool is offered; the model calls it and the answer uses the result.
      ollama.reply = (messages, opts) => {
        const last = messages[messages.length - 1]!;
        if (last.role === 'tool') return { content: `Found ${last.content}` };
        expect((opts.tools as { function: { name: string } }[]).map((x) => x.function.name)).toEqual(['jira_search_issues']);
        return { content: '', toolCall: { name: 'jira_search_issues', arguments: { q: 'travel' } } };
      };
      await localUser(h, 'mem', ['member'], 'confidential');
      const m = await login(h, 'mem');
      const sent = (await m.agent.post('/api/chat').set('x-csrf-token', m.csrf).send({ content: 'Find travel issues', profile: 'general' }).expect(202)).body;
      let view;
      for (let i = 0; i < 100; i++) {
        view = (await m.agent.get(`/api/conversations/${sent.conversationId}`).expect(200)).body;
        if (view.messages[1].state !== 'queued' && view.messages[1].state !== 'streaming') break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(view.messages[1]).toMatchObject({ state: 'complete', content: 'Found {"hits":["travel-1"]}' });
      expect(view.messages[1].tools[0]).toMatchObject({ name: 'jira.search_issues', output: { hits: ['travel-1'] } });
      expect(mcp.calls).toEqual([expect.objectContaining({ name: 'search_issues', arguments: { q: 'travel' } })]);

      // A blocking tool-call guardrail stops the call; the model gets the reason as the tool result.
      h.s.guardrails = { check: async (i) => (i.checkpoint === 'tool-call' ? { action: 'block', text: i.text, findings: [], reason: 'No issue searches today.' } : { action: 'allow', text: i.text, findings: [] }) };
      const again = (await m.agent.post(`/api/conversations/${sent.conversationId}/messages`).set('x-csrf-token', m.csrf).send({ content: 'Again', profile: 'general' }).expect(202)).body;
      for (let i = 0; i < 100; i++) {
        view = (await m.agent.get(`/api/conversations/${sent.conversationId}`).expect(200)).body;
        const msg = view.messages.find((x: { id: string }) => x.id === again.messageId);
        if (msg.state === 'complete' || msg.state === 'failed') break;
        await new Promise((r) => setTimeout(r, 20));
      }
      const msg = view.messages.find((x: { id: string }) => x.id === again.messageId);
      expect(msg.tools[0].error).toMatch(/No issue searches today/);
      expect(mcp.calls).toHaveLength(1);

      // Tool results pass the context checkpoint before the model sees them: a block withholds the result (the
      // call itself ran), a redaction replaces it.
      const ask = async (content: string) => {
        const sentX = (await m.agent.post(`/api/conversations/${sent.conversationId}/messages`).set('x-csrf-token', m.csrf).send({ content, profile: 'general' }).expect(202)).body;
        for (let i = 0; i < 100; i++) {
          view = (await m.agent.get(`/api/conversations/${sent.conversationId}`).expect(200)).body;
          const x = view.messages.find((y: { id: string }) => y.id === sentX.messageId);
          if (x.state === 'complete' || x.state === 'failed') return x;
          await new Promise((r) => setTimeout(r, 20));
        }
        throw new Error('no answer');
      };
      const seen: string[] = [];
      h.s.guardrails = { check: async (i) => (i.checkpoint === 'context' && i.meta?.via === 'tool-result' ? (seen.push(i.text), { action: 'block', text: i.text, findings: [], reason: 'Looks like an injected instruction.' }) : { action: 'allow', text: i.text, findings: [] }) };
      const withheld = await ask('Search once more');
      expect(mcp.calls).toHaveLength(2);
      expect(seen[0]).toContain('travel-1');
      expect(withheld.tools[0].error).toMatch(/withheld by a guardrail: Looks like an injected instruction/);
      expect(withheld.content).not.toContain('travel-1');
      h.s.guardrails = { check: async (i) => (i.checkpoint === 'context' && i.meta?.via === 'tool-result' ? { action: 'redact', text: i.text.replace('travel-1', '[REDACTED]'), findings: [] } : { action: 'allow', text: i.text, findings: [] }) };
      const redacted = await ask('And again');
      expect(redacted.tools[0].output).toEqual({ hits: ['[REDACTED]'] });
      expect(redacted.content).toBe('Found {"hits":["[REDACTED]"]}');

      await a.agent.delete(`/api/admin/mcp-servers/${reg.id}`).set('x-csrf-token', a.csrf).expect(200);
      expect((await h.s.gateway.repo.profile(h.tenantId, profile.id))!.tools).toEqual([]);
      const entries = (await h.s.registry.list(h.tenantId, { kind: 'tool' })).filter((e) => e.impl === 'mcp');
      expect(entries.map((e) => e.status)).toEqual(['deprecated', 'deprecated']);
    } finally {
      await ollama.stop();
    }
  });
});
