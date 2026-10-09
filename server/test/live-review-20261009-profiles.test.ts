/*
 * Fixes from the live review (2026-10-09), 1 of 2: a profile whose stored tool list holds nulls (seen live:
 * ["calculate", null, null, null, null, null]) no longer breaks GET /api/admin/mcp-servers or a conversation's
 * capabilities; profile writes refuse nulls and unknown tool names, and the repository never writes a non-string entry.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeMcp } from './fake-mcp.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, login, loginAdmin, type Harness } from './helpers.js';
import { seedGateway } from './seed-gateway.js';

type Client = { agent: Awaited<ReturnType<typeof login>>['agent']; csrf: string };
const post = (c: Client, url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body);
const patch = (c: Client, url: string, body: object = {}) => c.agent.patch(url).set('x-csrf-token', c.csrf).send(body);

async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('Live review 2026-10-09: profiles with null tool entries', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let mcp: FakeMcp;

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000', MCP_TIMEOUT_MS: '3000' });
    ollama = await new FakeOllama().start();
    ollama.chatDelayMs = 0;
    mcp = await new FakeMcp().start();
    mcp.tools = [{ name: 'lookup_invoice', description: 'Looks up an invoice.', inputSchema: { type: 'object', properties: { number: { type: 'string' } } }, annotations: { readOnlyHint: true }, run: (a) => ({ invoice: a.number }) }];
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
    await mcp.stop();
  });

  it('lists the MCP servers and chat capabilities over a profile row seeded with nulls, and refuses or cleans nulls on write', async () => {
    const { profile } = await seedGateway(h, ollama, { tools: ['calculate'] });
    await localUser(h, 'tadmin', ['tool-admin', 'model-admin'], 'confidential');
    await localUser(h, 'mem', ['member'], 'confidential');
    const t = await loginAdmin(h, 'tadmin');
    const m = await login(h, 'mem');
    const reg = (await post(t, '/api/admin/mcp-servers', { name: 'jira', url: mcp.url }).expect(201)).body;
    await post(t, `/api/admin/mcp-servers/${reg.id}/tools/lookup_invoice/approve`, { sideEffect: 'read', confirm: 'never', label: 'confidential' }).expect(200);
    await post(t, `/api/admin/mcp-servers/${reg.id}/bind`, { profileId: profile.id, tools: ['lookup_invoice'] }).expect(200);

    // The live row: nulls beside real names, written behind the API's back.
    await h.s.db('profiles').where({ id: profile.id }).update({ tools: JSON.stringify(['calculate', null, 'jira.lookup_invoice', null, null, 7]) });
    expect((await h.s.gateway.repo.profile(h.tenantId, profile.id))!.tools).toEqual(['calculate', 'jira.lookup_invoice']);

    const list = (await t.agent.get('/api/admin/mcp-servers').expect(200)).body as { name: string; profiles: string[] }[];
    expect(list.find((x) => x.name === 'jira')!.profiles).toEqual(['general']);
    const detail = (await t.agent.get(`/api/admin/mcp-servers/${reg.id}`).expect(200)).body;
    expect(detail.bindings).toEqual([expect.objectContaining({ profile: 'general', tools: ['lookup_invoice'], toolCount: 2 })]);
    expect((await t.agent.get('/api/admin/profiles').expect(200)).body.find((x: { name: string }) => x.name === 'general').tools).toEqual(['calculate', 'jira.lookup_invoice']);

    // Chat capabilities read the same list.
    const chat = (await post(m, '/api/chat', { content: 'Hello', profile: 'general' }).expect(202)).body as { conversationId: string; messageId: string };
    await until(async () => (await m.agent.get(`/api/conversations/${chat.conversationId}`).expect(200)).body.messages.find((x: { id: string; state: string }) => x.id === chat.messageId && x.state !== 'streaming' && x.state !== 'queued'));
    const caps = (await m.agent.get(`/api/conversations/${chat.conversationId}/capabilities`).expect(200)).body;
    expect(caps.tools.map((x: { name: string }) => x.name)).toEqual(['calculate', 'jira.lookup_invoice']);

    // A patch carrying a null is refused; an unknown tool name too; names already on the profile are kept.
    const bad = (await patch(t, `/api/admin/profiles/${profile.id}`, { tools: ['calculate', null] }).expect(400)).body;
    expect(bad.errors).toEqual([expect.objectContaining({ path: 'tools.1' })]);
    expect((await patch(t, `/api/admin/profiles/${profile.id}`, { tools: ['calculate', 'jira.nope'] }).expect(400)).body.detail).toMatch(/No such tool: jira\.nope/);
    expect((await post(t, '/api/admin/profiles', { name: 'other', displayName: 'Other', tools: ['ghost'] }).expect(400)).body.detail).toMatch(/ghost/);
    const ok = (await patch(t, `/api/admin/profiles/${profile.id}`, { tools: ['calculate', 'jira.lookup_invoice'] }).expect(200)).body;
    expect(ok.tools).toEqual(['calculate', 'jira.lookup_invoice']);

    // The repository writes strings only, whatever it is handed; the version snapshot too.
    await h.s.gateway.repo.updateProfile(h.tenantId, profile.id, { tools: ['calculate', null, undefined] as unknown as string[] });
    expect(JSON.parse((await h.s.db('profiles').where({ id: profile.id }).first('tools')).tools)).toEqual(['calculate']);
    const versions = (await t.agent.get(`/api/admin/profiles/${profile.id}/versions`).expect(200)).body as { profile: { tools: unknown[] } }[];
    for (const v of versions) expect(v.profile.tools.every((x) => typeof x === 'string')).toBe(true);
  });
});
