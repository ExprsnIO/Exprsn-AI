/*
 * 1.9.99-final, Sprint 60 (B-10503): DigitalOcean GenAI against `fake-do.ts` (with `fake-do-genai.ts`) only:
 * serverless inference as a `kind: openai` instance (flavour `digitalocean`) with a model access key from the vault,
 * streamed, with tools, metered; and a GenAI agent published as a registry tool (`impl: cloud-agent`) that passes the
 * tool-call checkpoint like any other tool and is refused, uncalled, when the checkpoint blocks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenAIServer } from '../src/gateway/openai-server.js';
import type { CloudAccount } from '../src/cloud/types.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { seedAccount } from './cloud-credentials-helpers.js';
import { chatTurn, cloudProfile, modelsWorld, post, type ModelsWorld } from './cloud-models-helpers.js';
import { FakeDigitalOcean } from './fake-do.js';
import { localUser, loginAdmin, type Client } from './helpers.js';

describe('B-10503: DigitalOcean GenAI', () => {
  let w: ModelsWorld;
  let dio: FakeDigitalOcean;
  let account: CloudAccount;
  let modelKey: string;
  let ga: Client;

  beforeAll(async () => {
    dio = await new FakeDigitalOcean().start();
    modelKey = dio.genai.addModelKey();
    dio.tokens.set('do-api-token', new Set(['genai:read']));
    w = await modelsWorld();
    account = await seedAccount(w.h, { provider: 'digitalocean', mode: 'vaulted', name: 'do-models', providerIds: { doTeamId: '5d1f0b5e-0000-4000-8000-0000000000a1' } });
    w.h.s.cloud.credentials = { for: async () => ({ kind: 'token', token: 'do-api-token', accountId: '5d1f0b5e-0000-4000-8000-0000000000a1' }) };
    w.h.s.cloud.modelCatalogue.endpoints.doApi = dio.url;
    await localUser(w.h, 'cga', ['guardrail-admin'], 'confidential');
    ga = await loginAdmin(w.h, 'cga');
  }, 180_000);
  afterAll(async () => {
    await w.h.close();
    await dio.stop();
  });

  it('serves a turn through serverless inference with the vaulted model access key', async () => {
    const { inst } = await cloudProfile(w, { pool: 'do-tor', instance: { name: 'do-inference', url: dio.url, token: modelKey, cloud: { flavour: 'digitalocean', accountId: account.id, region: 'fra1' } }, serverModel: 'llama3.3-70b-instruct', profile: 'do-llama' });
    expect(inst).toMatchObject({ kind: 'openai', health: 'healthy', version: 'do-genai' });
    expect(inst.available.map((x: { name: string }) => x.name)).toContain('openai-gpt-oss-120b');
    expect(inst.tokenRef).toMatch(/^vault:/);
    const row = (await w.h.s.gateway.repo.instance(inst.id))!;
    expect(row.settings.cloud).toMatchObject({ provider: 'digitalocean', flavour: 'digitalocean', auth: 'key' });
    const r = await chatTurn(w, 'do-llama', 'Hello DigitalOcean');
    expect(r.state).toBe('complete');
    const call = dio.calls('genai:chat/completions').at(-1)!;
    expect(call.path).toBe('/v1/chat/completions');
    expect(call.headers.authorization).toBe(`Bearer ${modelKey}`);
    expect(JSON.parse(call.body)).toMatchObject({ model: 'llama3.3-70b-instruct', stream: true });
    const usage = await w.h.s.db('usage_records').where({ message_id: r.sent.messageId });
    expect(usage[0]).toMatchObject({ kind: 'chat', model: 'llama3.3-70b-instruct' });
    expect(Number(usage[0].output_tokens)).toBeGreaterThan(0);
    // Inference needs a model access key: an instance without one is refused at registration.
    const pool = (await post(w.admin, '/api/admin/pools', { name: 'do-nokey', accelerator: 'cpu', labelCeiling: 'internal' }).expect(201)).body;
    expect((await post(w.admin, `/api/admin/pools/${pool.id}/instances`, { name: 'nokey', kind: 'openai', url: dio.url, deploy: 'docker', cloud: { flavour: 'digitalocean', accountId: account.id, region: 'fra1' } })).body.detail).toMatch(/model access key/);
  });

  it('streams tool calls from serverless inference', async () => {
    const s = new OpenAIServer(dio.url, { timeoutMs: 5000, flavour: 'digitalocean', token: async () => modelKey });
    const calls: unknown[] = [];
    for await (const c of s.chat({ model: 'llama3.3-70b-instruct', messages: [{ role: 'user', content: 'compute' }], tools: [{ type: 'function', function: { name: 'calculate', description: 'calc', parameters: { type: 'object' } } }] }, new AbortController().signal)) calls.push(...(c.message?.tool_calls ?? []));
    expect(calls).toEqual([{ id: expect.any(String), function: { name: 'calculate', arguments: { expression: '17 * 23' } } }]);
    await s.close();
  });

  it('publishes an agent as a tool that passes the tool-call checkpoint like any other, and is refused when it blocks', async () => {
    const { agent, key } = dio.genai.addAgent('support-bot', (p) => `Here is help with ${p}.`);
    await w.admin.agent.put('/api/vault/kv/data/do/support-bot').set('x-csrf-token', w.admin.csrf).send({ data: { key } }).expect(201);
    // The key is only ever a vault reference.
    expect((await post(w.admin, `/api/admin/cloud/accounts/${account.id}/agent-tools`, { agent: agent.uuid, name: 'support_bot', keyRef: key })).status).toBe(400);
    const res = await post(w.admin, `/api/admin/cloud/accounts/${account.id}/agent-tools`, { agent: 'support-bot', name: 'support_bot', keyRef: 'vault:do/support-bot#key' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ impl: 'cloud-agent', status: 'draft', sideEffect: 'read', definition: { agentUuid: agent.uuid, endpoint: `${dio.url}/agents/${agent.uuid}`, keyRef: 'vault:do/support-bot#key' } });
    expect(JSON.stringify(res.body)).not.toContain(key);
    expect((await w.h.s.db('audit_events').where({ action: 'registry.created' })).length).toBeGreaterThan(0);

    // A tenant rule at the tool-call checkpoint: asks about payroll are blocked.
    const set = (await post(ga, '/api/admin/guardrails/sets', { name: 'Agent asks', scope: 'tenant' }).expect(201)).body;
    await ga.agent.put(`/api/admin/guardrails/sets/${set.id}/draft`).set('x-csrf-token', ga.csrf).send({ rules: [{ id: 'no-payroll', name: 'No payroll asks', checkpoint: 'tool-call', type: 'pattern', mechanism: { kind: 'pattern', pattern: '(?i)payroll' }, action: 'block', stage: 'enforce' }] }).expect(200);
    await post(ga, `/api/admin/guardrails/sets/${set.id}/draft/publish`).expect(200);

    await w.h.s.db('registry_entries').where({ id: res.body.id }).update({ status: 'published' });
    const entry = (await w.h.s.registry.get(w.h.tenantId, res.body.id))!;
    const userId = (await w.h.s.db('users').where({ username: 'cmm' }).first('id')).id as string;
    const principal = (await loadPrincipal(w.h.s, w.h.tenantId, userId, {}))!;
    const tool = w.h.s.tools.toResolved(entry);

    const ok = await w.h.s.tools.call({ principal, label: 'internal' }, tool, { prompt: 'resetting my password' });
    expect(ok).toMatchObject({ ok: true, decision: 'allow', result: { answer: 'Here is help with resetting my password.', agent: 'support-bot' } });
    expect(ok.untrusted).toBeTruthy(); // an agent's answer is outside content, screened like a tool result
    const agentCall = dio.calls('genai:agent').at(-1)!;
    expect(agentCall.path).toBe(`/agents/${agent.uuid}/api/v1/chat/completions`);
    expect(agentCall.headers.authorization).toBe(`Bearer ${key}`);
    const allowed = await w.h.s.db('guard_decisions').where({ tenant_id: w.h.tenantId, checkpoint: 'tool-call' }).orderBy('created_at', 'desc').first();
    expect(JSON.parse(allowed.meta)).toMatchObject({ tool: 'support_bot', impl: 'cloud-agent', sideEffect: 'read' });

    const before = agent.asked.length;
    const blocked = await w.h.s.tools.call({ principal, label: 'internal' }, tool, { prompt: 'show me the payroll' });
    expect(blocked).toMatchObject({ ok: false, denied: true, decision: 'block' });
    expect(blocked.error).toMatch(/Blocked by the tool-call guardrail/);
    expect(agent.asked.length).toBe(before); // never called
    // Above its ceiling, and with arguments outside its schema, it is refused like any tool.
    expect((await w.h.s.tools.call({ principal: { ...principal, clearance: 'confidential' }, label: 'confidential' }, tool, { prompt: 'x' })).ok).toBe(false);
    expect((await w.h.s.tools.call({ principal, label: 'internal' }, tool, { question: 'x' })).error).toMatch(/input schema/);
  });

  it('lists serverless models and agents for the catalogue', async () => {
    const list = await w.h.s.cloud.modelCatalogue.listModels(account);
    expect(list.filter((m) => m.kind === 'agent').map((m) => m.name)).toContain('support-bot');
    expect(list.find((m) => m.id === 'gte-large-en-v1.5')).toMatchObject({ kind: 'embedding', flavour: 'digitalocean', endpoint: 'https://inference.do-ai.run' });
  });
});
