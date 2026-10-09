/*
 * 1.6.0, Sprint 38b: B-7701 agent identities.
 *
 *   An agent is a principal of its own: roles, a label ceiling and scoped API keys. A run on behalf of a user acts
 *   within both grants (the user's permissions narrowed to the identity's roles, the lower clearance), so an agent
 *   whose roles grant no knowledge access cannot search knowledge even for an admin; audit events name the agent and
 *   the user; a key minted for the identity authenticates requests as the agent on the owner's behalf.
 */
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, loginAdmin, type Harness } from './helpers.js';
import { seedGateway } from './seed-gateway.js';

describe('B-7701: agent identities', () => {
  let h: Harness;
  let ollama: FakeOllama;

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    ollama = await new FakeOllama().start();
    ollama.chatDelayMs = 0;
    await seedGateway(h, ollama);
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  async function admin(name: string, roles: string[]) {
    await localUser(h, name, roles, 'confidential');
    const c = await loginAdmin(h, name);
    return {
      ...c,
      post: (path: string, body: object = {}) => c.agent.post(path).set('x-csrf-token', c.csrf).send(body),
      put: (path: string, body: object = {}) => c.agent.put(path).set('x-csrf-token', c.csrf).send(body),
      del: (path: string) => c.agent.delete(path).set('x-csrf-token', c.csrf)
    };
  }

  async function publishAgent(name: string, tools: string[]) {
    const a = await admin(`author-${name.toLowerCase()}`, ['tool-admin']);
    const b = await admin(`reviewer-${name.toLowerCase()}`, ['tool-admin']);
    const e = (await a.post('/api/admin/registry', { kind: 'agent', name, version: '1.0.0', description: 'Looks up the answer to policy questions in the published knowledge bases and quotes the source.', label: 'confidential', definition: { profile: 'general', tools, budgets: { steps: 10, tokens: 10000, wallSeconds: 120, toolCalls: 4 } } }).expect(201)).body;
    await a.post(`/api/admin/registry/${e.id}/submit`).expect(200);
    await b.post(`/api/admin/registry/${e.id}/review`, { decision: 'approve' }).expect(200);
    return { entry: e, author: a, reviewer: b };
  }

  it('narrows a run to the identity\'s roles and ceiling, names the agent in the audit, and mints keys that act as the agent', async () => {
    const { author } = await publishAgent('Librarian', ['knowledge_search']);
    const ta = await admin('tenantadmin', ['tenant-admin', 'tool-admin', 'member']);
    // A custom role for the identity: it may think and call tools, but reads no knowledge.
    const role = (await ta.post('/api/authz/roles', { name: 'Bot runner', description: 'Runs as an agent', permissions: ['inference:invoke', 'tools:invoke', 'agents:run'], requiresMfa: false }).expect(201)).body;
    expect(role.pending).toBe(false);
    const roleId = role.role.id as string;

    // Nothing yet; unknown agents and roles are refused; a ceiling above the author's clearance is refused, and so
    // are roles granting what the author does not hold (a tool admin alone cannot run agents).
    expect((await author.agent.get('/api/admin/agent-identities/Librarian').expect(200)).body).toMatchObject({ agent: 'Librarian', identity: null, keys: [] });
    await ta.put('/api/admin/agent-identities/Nobody', { roles: [roleId], ceiling: 'internal' }).expect(404);
    await ta.put('/api/admin/agent-identities/Librarian', { roles: ['no-such-role'], ceiling: 'internal' }).expect(400);
    await ta.put('/api/admin/agent-identities/Librarian', { roles: [roleId], ceiling: 'restricted' }).expect(403);
    expect((await author.put('/api/admin/agent-identities/Librarian', { roles: [roleId], ceiling: 'internal' }).expect(403)).body.detail).toMatch(/which you do not hold/);
    const identity = (await ta.put('/api/admin/agent-identities/Librarian', { roles: [roleId], ceiling: 'confidential' }).expect(200)).body;
    expect(identity).toMatchObject({ agent: 'Librarian', roles: [roleId], roleNames: ['Bot runner'], ceiling: 'confidential', enabled: true, permissions: ['agents:run', 'inference:invoke', 'tools:invoke'] });
    expect((await author.agent.get('/api/admin/agent-identities').expect(200)).body).toEqual([expect.objectContaining({ agent: 'Librarian' })]);

    // The run: the model asks for a knowledge search; the admin holds knowledge:read, the identity does not.
    ollama.reply = (messages) => {
      const last = messages[messages.length - 1]!;
      if (last.role === 'tool') return { content: `Result: ${last.content}` };
      return { content: '', toolCall: { name: 'knowledge_search', arguments: { kbIds: ['01KB000000000000000000000X'], query: 'holiday policy' } } };
    };
    const view = async (id: string) => (await ta.agent.get(`/api/runs/${id}`).expect(200)).body as { state: string; output: string; steps: { title: string; state: string; detail: { error: string | null } }[] };
    const r1 = (await ta.post('/api/runs', { agent: 'Librarian', input: 'What is the holiday policy?', label: 'internal' }).expect(202)).body;
    await h.s.jobs.runDue();
    const v1 = await view(r1.id);
    expect(v1.state, (await h.s.db('agent_runs').where({ id: r1.id }).first()).error).toBe('succeeded');
    const call = v1.steps.find((s) => s.title === 'knowledge_search')!;
    expect(['denied', 'failed']).toContain(call.state);
    expect(call.detail.error).toMatch(/knowledge:read/);
    // The run's audit names the agent beside the user.
    const done = await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'agent.run.succeeded' }).orderBy('seq', 'desc').first();
    expect(JSON.parse(done.actor)).toMatchObject({ user: expect.any(String), agent: 'Librarian' });

    // Above the identity's ceiling: the run fails before it thinks (the profile itself handles confidential data).
    await ta.put('/api/admin/agent-identities/Librarian', { roles: [roleId], ceiling: 'internal' }).expect(200);
    const r2 = (await ta.post('/api/runs', { agent: 'Librarian', input: 'Secret question', label: 'confidential' }).expect(202)).body;
    await h.s.jobs.runDue();
    expect(await view(r2.id)).toMatchObject({ state: 'failed' });
    expect((await h.s.db('agent_runs').where({ id: r2.id }).first()).error).toMatch(/internal/);

    // Identity off: the admin's own permissions apply again, and the call gets as far as the knowledge base lookup.
    await ta.put('/api/admin/agent-identities/Librarian', { roles: [roleId], ceiling: 'internal', enabled: false }).expect(200);
    const r3 = (await ta.post('/api/runs', { agent: 'Librarian', input: 'What is the holiday policy?', label: 'internal' }).expect(202)).body;
    await h.s.jobs.runDue();
    const call3 = (await view(r3.id)).steps.find((s) => s.title === 'knowledge_search')!;
    expect(call3.detail.error).toMatch(/knowledge base/);
    expect(call3.detail.error).not.toMatch(/knowledge:read/);

    // Keys: minted only for an identity that is on, never beyond its roles or the author's permissions.
    await ta.post('/api/admin/agent-identities/Librarian/keys', { name: 'ci', scopes: ['agents:run'], ttlDays: 30 }).expect(409);
    // Back on, with a ceiling the profile's label allows, so a run started with the key can think.
    await ta.put('/api/admin/agent-identities/Librarian', { roles: [roleId], ceiling: 'confidential', enabled: true }).expect(200);
    await ta.post('/api/admin/agent-identities/Librarian/keys', { name: 'ci', scopes: ['agents:run', 'knowledge:read'], ttlDays: 30 }).expect(403);
    await author.post('/api/admin/agent-identities/Librarian/keys', { name: 'ci', scopes: ['agents:run'], ttlDays: 30 }).expect(403);
    const minted = (await ta.post('/api/admin/agent-identities/Librarian/keys', { name: 'ci', scopes: ['agents:run', 'inference:invoke', 'tools:invoke'], ttlDays: 30 }).expect(201)).body;
    expect(minted.key).toMatch(/^exai_k1_/);
    expect(minted.notice).toMatch(/only time/);
    const keys = (await author.agent.get('/api/admin/agent-identities/Librarian').expect(200)).body.keys;
    expect(keys).toEqual([expect.objectContaining({ id: minted.id, name: 'ci', scopes: ['agents:run', 'inference:invoke', 'tools:invoke'], state: 'active', ownerName: 'TENANTADMIN' })]);
    // Not among the owner's personal keys.
    expect((await ta.agent.get('/api/me/api-keys').expect(200)).body.find((k: { id: string }) => k.id === minted.id)).toBeUndefined();

    // A request with the key acts as the agent: permissions are the scopes, and the audit names the agent.
    const me = (await request(h.app).get('/api/me').set('authorization', `Bearer ${minted.key}`).expect(200)).body;
    expect(me.permissions).toEqual(['agents:run', 'inference:invoke', 'tools:invoke']);
    expect(me.user.clearance).toBe('confidential');
    await request(h.app).get('/api/admin/registry').set('authorization', `Bearer ${minted.key}`).expect(403);
    const started = (await request(h.app).post('/api/runs').set('authorization', `Bearer ${minted.key}`).send({ agent: 'Librarian', input: 'Hi', label: 'internal' }).expect(202)).body;
    const ev = await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'agent.run.started' }).orderBy('seq', 'desc').first();
    expect(JSON.parse(ev.actor)).toMatchObject({ agent: 'Librarian', apiKey: minted.id });
    expect(JSON.parse(ev.target)).toMatchObject({ run: started.id });

    // Roles narrowed later narrow the keys; an identity turned off refuses its keys; a revoked key is gone.
    await ta.put('/api/admin/agent-identities/Librarian', { roles: [roleId], ceiling: 'confidential', enabled: false }).expect(200);
    await request(h.app).get('/api/me').set('authorization', `Bearer ${minted.key}`).expect(401);
    await ta.put('/api/admin/agent-identities/Librarian', { roles: [roleId], ceiling: 'confidential', enabled: true }).expect(200);
    await request(h.app).get('/api/me').set('authorization', `Bearer ${minted.key}`).expect(200);
    await ta.del(`/api/admin/agent-identities/Librarian/keys/${minted.id}`).expect(204);
    await request(h.app).get('/api/me').set('authorization', `Bearer ${minted.key}`).expect(401);
    expect((await author.agent.get('/api/admin/agent-identities/Librarian').expect(200)).body.keys[0].state).toBe('revoked');
  });
});
