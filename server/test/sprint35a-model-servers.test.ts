import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sseData, toWireMessages, toWireRequest } from '../src/gateway/openai-server.js';
import { orSkip, Unsupported } from '../src/gateway/server.js';
import { FakeOllama } from './fake-ollama.js';
import { FakeOpenAIServer } from './fake-openai-server.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

const GB = 1_000_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('sprint 35a: Chat Completions mapping (B-4303)', () => {
  it('gives tool calls ids and pairs each tool result with its call', () => {
    const wire = toWireMessages([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'What is 17 * 23 and 2 + 2?' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call-A', function: { name: 'calculate', arguments: { expression: '17*23' } } }, { function: { name: 'calculate', arguments: { expression: '2+2' } } }] },
      { role: 'tool', tool_name: 'calculate', content: '{"result":391}' },
      { role: 'tool', tool_name: 'calculate', content: '{"result":4}' }
    ]);
    expect(wire[2]).toEqual({ role: 'assistant', content: null, tool_calls: [{ id: 'call-A', type: 'function', function: { name: 'calculate', arguments: '{"expression":"17*23"}' } }, { id: 'call_2_1', type: 'function', function: { name: 'calculate', arguments: '{"expression":"2+2"}' } }] });
    expect(wire[3]).toMatchObject({ role: 'tool', tool_call_id: 'call-A', name: 'calculate' });
    expect(wire[4]).toMatchObject({ role: 'tool', tool_call_id: 'call_2_1' });
  });

  it('maps options, drops the Ollama-only ones and turns a format into response_format', () => {
    const { body, dropped } = toWireRequest({ model: 'system', messages: [{ role: 'user', content: 'hi', images: ['iVBORw0KGgo'] }], think: false, keep_alive: '30m', options: { num_ctx: 8192, temperature: 0.2, num_predict: 16, stop: ['\n'], top_k: 40 }, format: { type: 'object', properties: { a: { type: 'string' } } } });
    expect(body).toMatchObject({ model: 'system', stream: true, temperature: 0.2, max_tokens: 16, stop: ['\n'], response_format: { type: 'json_schema', json_schema: { name: 'response', strict: true, schema: { type: 'object' } } } });
    expect(body).not.toHaveProperty('num_ctx');
    expect(dropped.sort()).toEqual(['keep_alive', 'num_ctx', 'think', 'top_k']);
    expect((body.messages as { content: { type: string; image_url?: { url: string } }[] }[])[0]!.content[1]!.image_url!.url).toMatch(/^data:image\/png;base64,/);
    expect(toWireRequest({ model: 'm', messages: [], format: 'json' }).body.response_format).toEqual({ type: 'json_object' });
  });

  it('reads server-sent events split anywhere, with CRLF line ends', async () => {
    const raw = 'data: {"a":1}\r\n\r\ndata: {"b"' + ':2}\n\n: comment\n\ndata: [DONE]\n\n';
    const parts = [raw.slice(0, 7), raw.slice(7, 19), raw.slice(19)].map((x) => new TextEncoder().encode(x));
    const out: string[] = [];
    for await (const d of sseData((async function* () { yield* parts; })())) out.push(d);
    expect(out).toEqual(['{"a":1}', '{"b":2}', '[DONE]']);
  });

  it('treats unsupported as skip', async () => {
    await expect(orSkip(Promise.reject(new Unsupported('loaded', 'openai')), null)).resolves.toBeNull();
    await expect(orSkip(Promise.reject(new Error('boom')), null)).rejects.toThrow('boom');
  });
});

describe('sprint 35a: model servers beyond Ollama (B-4302 to B-4305)', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let fm: FakeOpenAIServer;
  let llama: FakeOpenAIServer;
  let a: Client;
  let b: Client;
  let socket: string;
  const post = (c: Client, url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body);
  const patch = (c: Client, url: string, body: object) => c.agent.patch(url).set('x-csrf-token', c.csrf).send(body);

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    ollama = await new FakeOllama().start();
    // Apple's fm serve: the on-device model, and Private Cloud Compute listed but refused.
    socket = path.join(tmpdir(), `s35a-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`);
    fm = new FakeOpenAIServer();
    fm.add({ id: 'system', ownedBy: 'Apple' }).add({ id: 'pcc', ownedBy: 'Apple', available: false, reason: 'PCC inference is not available in this context.' });
    await fm.start({ socketPath: socket });
    // llama.cpp's llama-server on a port, behind a bearer token, reporting its context and usage.
    llama = new FakeOpenAIServer();
    llama.style = 'llama';
    llama.token = 'sk-llama-test';
    llama.streamUsage = true;
    llama.add({ id: 'qwen2.5-7b-instruct-q4_k_m.gguf', meta: { n_ctx_train: 32768, size: 4_700_000_000 } });
    await llama.start();
    await localUser(h, 'ma', ['model-admin', 'tenant-admin'], 'confidential');
    await localUser(h, 'mb', ['model-admin'], 'confidential');
    a = await loginAdmin(h, 'ma');
    b = await loginAdmin(h, 'mb');
    const ma = await h.s.db('users').where({ username: 'ma' }).first('id');
    await post(a, '/api/vault/policies', { subjectKind: 'user', subject: ma.id, path: '*', capabilities: ['*'], description: 'model servers' }).expect(201);
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
    await fm.stop();
    await llama.stop();
  });

  async function servers() {
    const pool = (await post(a, '/api/admin/pools', { name: 'apple', accelerator: 'metal', labelCeiling: 'confidential' }).expect(201)).body;
    const fmInst = (await post(a, `/api/admin/pools/${pool.id}/instances`, { name: 'mac-1-fm', kind: 'openai', socketPath: socket, deploy: 'baremetal' }).expect(201)).body;
    const llamaInst = (await post(a, `/api/admin/pools/${pool.id}/instances`, { name: 'mac-1-llama', kind: 'openai', url: llama.url, token: 'sk-llama-test', deploy: 'baremetal' }).expect(201)).body;
    return { pool, fmInst, llamaInst };
  }

  /** Registers Apple's model from the picker, evaluates it and has the second administrator approve it. */
  async function approvedSystem() {
    const s = await servers();
    const m = (await post(a, '/api/admin/models', { serverInstanceId: s.fmInst.id, serverModel: 'system', license: { name: 'Apple Foundation Models terms' }, label: 'confidential' }).expect(201)).body;
    await post(a, `/api/admin/models/${m.id}/evaluate`).expect(202);
    await h.s.jobs.runDue();
    await post(b, `/api/admin/models/${m.id}/lifecycle`, { to: 'approved' }).expect(200);
    return { ...s, model: m };
  }

  it('registers an fm serve socket and a llama-server port as healthy instances that list their models', async () => {
    const { fmInst, llamaInst } = await servers();
    expect(fmInst).toMatchObject({ kind: 'openai', socketPath: socket, health: 'healthy', version: 'fm serve', supports: { load: false, unload: false, pull: false } });
    expect(fmInst.available.map((x: { name: string }) => x.name)).toEqual(['system']); // pcc is listed but unavailable
    expect(fmInst.probeJobId).toBeTruthy();
    expect(llamaInst).toMatchObject({ kind: 'openai', health: 'healthy', version: 'llama.cpp' });
    expect(llamaInst.tokenRef).toMatch(/^vault:model-servers\/[0-9a-z]{26}#token$/);
    expect(JSON.stringify(llamaInst)).not.toContain('sk-llama-test');
    expect(llama.requests.every((r) => r.auth === 'Bearer sk-llama-test')).toBe(true);

    // The probe: tool calls and JSON schema output, recorded in the instance's settings.
    await h.s.jobs.runDue();
    const picker = (await a.agent.get('/api/admin/model-servers').expect(200)).body;
    const f = picker.find((x: { instance: string }) => x.instance === 'mac-1-fm');
    expect(f).toMatchObject({ transport: 'socket', token: false, health: 'healthy', reported: { server: 'fm serve', tools: true, jsonSchema: true, probedModel: 'system', embeddings: null } });
    expect(f.models).toEqual([
      { id: 'system', available: true, reason: null, ownedBy: 'Apple', catalogued: null },
      { id: 'pcc', available: false, reason: 'PCC inference is not available in this context.', ownedBy: 'Apple', catalogued: null }
    ]);
    const l = picker.find((x: { instance: string }) => x.instance === 'mac-1-llama');
    expect(l).toMatchObject({ transport: 'url', token: true, reported: { server: 'llama.cpp', contextLength: 8192 } });
    expect(JSON.stringify(picker)).not.toContain(llama.url);
    const fmChats = fm.chats();
    expect(fmChats.some((c) => (c.tools as unknown[])?.length)).toBe(true);
    expect(fmChats.some((c) => (c.response_format as { type: string })?.type === 'json_schema')).toBe(true);

    // Audit: the creation names the kind and the vault reference, never the token.
    const events = await h.s.db('audit_events').where({ action: 'instance.created' });
    expect(events).toHaveLength(2);
    expect(events.map((e: { detail: string }) => e.detail).join(' ')).not.toContain('sk-llama-test');
    const vault = await h.s.db('vault_secrets').where({ tenant_id: h.tenantId }).first();
    expect(vault.path).toMatch(/^model-servers\//);
  });

  it('refuses tokens and sockets on Ollama instances, and a socket with mutual TLS', async () => {
    const pool = (await post(a, '/api/admin/pools', { name: 'gpu', accelerator: 'cuda' }).expect(201)).body;
    expect((await post(a, `/api/admin/pools/${pool.id}/instances`, { name: 'o', url: ollama.url, token: 'x', deploy: 'docker' }).expect(400)).body.detail).toMatch(/bearer token is for Chat Completions/);
    await post(a, `/api/admin/pools/${pool.id}/instances`, { name: 'o', socketPath: socket, deploy: 'docker' }).expect(400);
    await post(a, `/api/admin/pools/${pool.id}/instances`, { name: 'f', kind: 'openai', socketPath: socket, deploy: 'docker', tls: { caFile: '/etc/ca.pem' } }).expect(400);
    await post(a, `/api/admin/pools/${pool.id}/instances`, { name: 'f', kind: 'openai', deploy: 'docker' }).expect(400);
    // Storing a raw token needs secrets permissions; mb has none.
    expect((await post(b, `/api/admin/pools/${pool.id}/instances`, { name: 'f', kind: 'openai', url: llama.url, token: 'x', deploy: 'docker' }).expect(403)).body.detail).toMatch(/secrets:write/);
  });

  it('fails requests when the token is wrong and recovers when it is replaced', async () => {
    const pool = (await post(a, '/api/admin/pools', { name: 'cpu', accelerator: 'cpu' }).expect(201)).body;
    const inst = (await post(a, `/api/admin/pools/${pool.id}/instances`, { name: 'l', kind: 'openai', url: llama.url, token: 'wrong', deploy: 'docker' }).expect(201)).body;
    expect(inst.health).toBe('unreachable');
    expect(inst.health_detail).toMatch(/bearer token/i);
    const fixed = (await patch(a, `/api/admin/instances/${inst.id}`, { token: 'sk-llama-test' }).expect(200)).body;
    expect(fixed.health).toBe('healthy');
    expect(fixed.tokenRef).not.toBe(inst.tokenRef);
  });

  it('approves, evaluates and places Apple\'s model like an Ollama one, refusing the requester\'s own approval', async () => {
    const { pool, fmInst } = await servers();
    // The picker refuses what the server lists as unavailable, and a digest it cannot check.
    expect((await post(a, '/api/admin/models', { serverInstanceId: fmInst.id, serverModel: 'pcc', label: 'internal' }).expect(409)).body.detail).toMatch(/unavailable: PCC inference/);
    await post(a, '/api/admin/models', { serverInstanceId: fmInst.id, serverModel: 'system', expectedDigest: 'a'.repeat(64) }).expect(400);
    await post(a, '/api/admin/models', { serverInstanceId: fmInst.id, serverModel: 'nope' }).expect(409);
    const m = (await post(a, '/api/admin/models', { serverInstanceId: fmInst.id, serverModel: 'system', license: { name: 'Apple Foundation Models terms' }, label: 'confidential' }).expect(201)).body;
    expect(m).toMatchObject({ name: 'system', format: 'server', held: true, expectedDigest: null, digest: null, importState: 'pulled', source: 'server:mac-1-fm/system', serverModel: 'system', serverInstanceId: fmInst.id, jobId: null, state: 'draft' });
    const listed = (await a.agent.get('/api/admin/models').expect(200)).body.find((x: { id: string }) => x.id === m.id);
    expect(listed.pools).toEqual([expect.objectContaining({ pool: 'apple', residency: 'warm' })]);
    expect(listed.server).toMatchObject({ instance: 'mac-1-fm', model: 'system', health: 'healthy' });

    await post(a, `/api/admin/models/${m.id}/lifecycle`, { to: 'approved' }).expect(409); // evaluate first
    await post(a, `/api/admin/models/${m.id}/evaluate`).expect(202);
    await h.s.jobs.runDue();
    const ev = (await a.agent.get('/api/admin/models').expect(200)).body.find((x: { id: string }) => x.id === m.id);
    expect(ev.state).toBe('evaluated');
    expect(ev.evaluation).toMatchObject({ instance: 'mac-1-fm', passed: ev.evaluation.total });
    const self = await post(a, `/api/admin/models/${m.id}/lifecycle`, { to: 'approved' }).expect(403);
    expect(self.body.step).toBe('dual-control');
    await post(b, `/api/admin/models/${m.id}/lifecycle`, { to: 'approved' }).expect(200);

    // Placements on a pool with Chat Completions servers are warm only.
    await patch(a, `/api/admin/placements/${listed.pools[0].placementId}`, { residency: 'pinned' }).expect(409);
    // The same audit events as an Ollama model.
    const actions = (await h.s.db('audit_events').whereIn('action', ['model.import.requested', 'model.evaluation.started', 'model.approved']).orderBy('seq')).map((e: { action: string }) => e.action);
    expect(actions).toEqual(['model.import.requested', 'model.evaluation.started', 'model.approved']);
    const req = (await h.s.db('audit_events').where({ action: 'model.import.requested' }).first()) as { detail: string };
    expect(JSON.parse(req.detail)).toMatchObject({ format: 'server', server: 'mac-1-fm', serverModel: 'system', pool: 'apple' });

    // Loads and unloads are recorded as unsupported, not sent and not failed.
    const ld = (await post(a, `/api/admin/instances/${fmInst.id}/load`, { model: 'system', pinned: true }).expect(200)).body;
    expect(ld).toEqual({ evicted: [], unsupported: true });
    expect((await post(a, `/api/admin/instances/${fmInst.id}/unload`, { model: 'system' }).expect(200)).body).toEqual({ ok: true, unsupported: true });
    const evs = (await a.agent.get(`/api/admin/instances/${fmInst.id}/events`).expect(200)).body;
    expect(evs.filter((e: { event: string }) => e.event === 'unsupported')).toHaveLength(2);
    // An Ollama model cannot be pulled onto a pool of servers that hold their own models.
    ollama.registry.set('llama3.1:8b', { name: 'llama3.1:8b', size: 5 * GB });
    const om = (await post(a, '/api/admin/models', { name: 'llama3.1:8b', label: 'internal' }).expect(201)).body;
    expect((await post(a, '/api/admin/placements', { modelId: om.id, poolId: pool.id }).expect(409)).body.detail).toMatch(/Chat Completions server/);

    // Retiring deletes nothing on the server.
    await post(a, `/api/admin/models/${m.id}/lifecycle`, { to: 'deprecated' }).expect(200);
    await post(a, `/api/admin/models/${m.id}/lifecycle`, { to: 'retired' }).expect(200);
    expect(fm.requests.filter((r) => r.method === 'DELETE' || /delete|pull/.test(r.path))).toHaveLength(0);
  });

  it('streams a conversation on Apple\'s model, calls a read-only tool and meters it like an Ollama turn', async () => {
    const { pool, model } = await approvedSystem();
    const t = Date.now();
    await h.s.gateway.repo.createProfile({ id: 'APPLE00000000000000000000A', tenant_id: h.tenantId, name: 'apple', display_name: 'Apple on-device', description: null, alias_of: null, model_id: model.id, pool_id: pool.id, num_ctx: 4096, temperature: 0.2, think_default: 'off', think_ceiling: 'off', system_prompt: 'Be brief.', fallback: null, canary: null, tools: ['calculate'], label: 'internal', status: 'published', version: 1, updated_by: null, created_at: t, updated_at: t });
    fm.reply = (msgs) => {
      const last = msgs[msgs.length - 1]!;
      if (last.role === 'tool') return { content: `It is ${JSON.parse(String(last.content)).decimal}.` };
      return { content: '', toolCall: { name: 'calculate', arguments: { expression: '17 * 23' } } };
    };
    await localUser(h, 'mem', ['member'], 'internal');
    const m = await login(h, 'mem');
    const sent = await m.agent.post('/api/chat').set('x-csrf-token', m.csrf).send({ content: 'What is 17 times 23?', profile: 'apple' }).expect(202);
    let msg: { state: string } | undefined;
    for (let i = 0; i < 200; i++) {
      msg = await h.s.db('messages').where({ id: sent.body.messageId }).first();
      if (msg && ['complete', 'failed'].includes(msg.state)) break;
      await sleep(20);
    }
    expect(msg!.state).toBe('complete');
    const view = (await m.agent.get(`/api/conversations/${sent.body.conversationId}`).expect(200)).body;
    expect(view.messages[1].content).toBe('It is 391.');
    expect(view.messages[1].tools).toEqual([expect.objectContaining({ name: 'calculate', expression: '17 * 23' })]);
    expect(view.messages[1].usage.calcCalls).toBe(1);
    const usage = await h.s.db('usage_records').where({ message_id: sent.body.messageId });
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ kind: 'chat', model: 'system' });
    expect(Number(usage[0].output_tokens)).toBeGreaterThan(0);
    expect(Number(usage[0].prompt_tokens)).toBeGreaterThan(0);
    // The second round sent the result back paired with the server's own call id; num_ctx was dropped and noted.
    const second = fm.chats().filter((c) => (c.messages as { role: string }[]).some((x) => x.role === 'tool')).pop()!;
    expect((second.messages as { role: string; tool_call_id?: string }[]).find((x) => x.role === 'tool')!.tool_call_id).toBe('call-7F3A');
    expect(second).toMatchObject({ model: 'system', stream: true, temperature: 0.2 });
    expect(second).not.toHaveProperty('num_ctx');
    const dropped = await h.s.db('model_events').where({ event: 'dropped', model: 'system' });
    expect(dropped.some((e: { reason: string }) => /num_ctx/.test(e.reason))).toBe(true);
  });

  it('embeds on an Ollama pool when the server offers no /v1/embeddings, and on the server when it does', async () => {
    // The same embedding model is on a llama.cpp server (no embeddings at first) and on an Ollama pool.
    llama.add({ id: 'qwen3-embedding:0.6b' });
    ollama.addAvailable({ name: 'qwen3-embedding:0.6b', size: GB, capabilities: ['embedding'] });
    const repo = h.s.gateway.repo;
    const srv = await repo.createPool({ name: 'srv', accelerator: 'metal', zone: 'inference', labelCeiling: 'confidential' });
    const gpu = await repo.createPool({ name: 'gpu', accelerator: 'cuda', zone: 'inference', labelCeiling: 'confidential' });
    llama.token = null;
    const li = await repo.createInstance({ poolId: srv.id, name: 'srv-1', url: llama.url, deploy: 'baremetal', settings: {}, kind: 'openai' });
    await repo.createInstance({ poolId: gpu.id, name: 'gpu-1', url: ollama.url, deploy: 'docker', settings: {} });
    const m = await repo.createModel({ name: 'qwen3-embedding:0.6b', source: 'Ollama library', expectedDigest: null, license: { name: 'Apache 2.0' }, label: 'confidential', notes: null, requestedBy: 'x', requestedTenant: h.tenantId });
    await repo.updateModel(m.id, { state: 'approved', import_state: 'pulled', capabilities: ['embedding'] });
    await repo.place(m.id, srv.id, 'warm', 'x');
    await repo.place(m.id, gpu.id, 'warm', 'x');
    await h.s.gateway.pollAll();
    for (let i = 0; i < 3; i++) {
      const out = await h.s.gateway.embed('qwen3-embedding:0.6b', ['knowledge passage'], 'internal');
      expect(out.embeddings).toHaveLength(1);
      expect(out.poolId).toBe(gpu.id);
    }
    expect(llama.requests.filter((r) => r.path === '/v1/embeddings').length).toBeLessThanOrEqual(1);
    // A server that offers /v1/embeddings serves them (registered again, as after an upgrade of the server).
    llama.embeddings = true;
    await repo.deleteInstance(li.id);
    await repo.createInstance({ poolId: srv.id, name: 'srv-2', url: llama.url, deploy: 'baremetal', settings: {}, kind: 'openai' });
    await repo.unplace((await repo.placements()).find((x) => x.pool_id === gpu.id)!.id);
    await h.s.gateway.pollAll();
    const onServer = (await h.s.gateway.embed('qwen3-embedding:0.6b', ['x'], 'internal')).poolId === srv.id;
    expect(onServer).toBe(true);
  });

  it('skips Chat Completions servers when pulling onto a mixed pool and when rolling an upgrade', async () => {
    ollama.registry.set('llama3.1:8b', { name: 'llama3.1:8b', size: 5 * GB });
    const pool = (await post(a, '/api/admin/pools', { name: 'mixed', accelerator: 'metal', labelCeiling: 'confidential' }).expect(201)).body;
    await post(a, `/api/admin/pools/${pool.id}/instances`, { name: 'ollama-1', url: ollama.url, deploy: 'docker' }).expect(201);
    await post(a, `/api/admin/pools/${pool.id}/instances`, { name: 'fm-1', kind: 'openai', socketPath: socket, deploy: 'baremetal' }).expect(201);
    const m = (await post(a, '/api/admin/models', { name: 'llama3.1:8b', label: 'internal', poolId: pool.id }).expect(201)).body;
    await h.s.jobs.runDue();
    const job = await h.s.db('jobs').where({ id: m.jobId }).first();
    expect(job.state).toBe('succeeded');
    expect(JSON.parse(job.result).instances).toMatchObject({ 'fm-1': expect.stringMatching(/^skipped/) });
    expect((await a.agent.get('/api/admin/models').expect(200)).body.find((x: { id: string }) => x.id === m.id).importState).toBe('pulled');
    const up = (await post(a, `/api/admin/pools/${pool.id}/upgrade`, { targetVersion: '0.12.3' }).expect(202)).body;
    await h.s.jobs.runDue();
    const uj = await h.s.db('jobs').where({ id: up.jobId }).first();
    expect(JSON.parse(uj.result).done).toEqual(expect.arrayContaining([expect.stringMatching(/fm-1 skipped/)]));
  });

  it('reports a server that is down, and one without /health through its model list', async () => {
    const mlx = new FakeOpenAIServer();
    mlx.style = 'mlx';
    mlx.add({ id: 'mlx-community/Qwen3-4B-4bit' });
    await mlx.start();
    try {
      const pool = (await post(a, '/api/admin/pools', { name: 'mlx', accelerator: 'metal' }).expect(201)).body;
      const inst = (await post(a, `/api/admin/pools/${pool.id}/instances`, { name: 'mlx-1', kind: 'openai', url: mlx.url, deploy: 'baremetal' }).expect(201)).body;
      expect(inst).toMatchObject({ health: 'healthy', version: 'chat-completions' });
      expect(inst.available.map((x: { name: string }) => x.name)).toEqual(['mlx-community/Qwen3-4B-4bit']);
      mlx.down = true;
      await h.s.gateway.pollAll();
      expect((await a.agent.get('/api/admin/pools').expect(200)).body.find((p: { id: string }) => p.id === pool.id).instances[0].health).toBe('unreachable');
      await post(a, `/api/admin/instances/${inst.id}/probe`).expect(202);
      const ol = (await post(a, '/api/admin/pools', { name: 'o', accelerator: 'cpu' }).expect(201)).body;
      const oi = (await post(a, `/api/admin/pools/${ol.id}/instances`, { name: 'o-1', url: ollama.url, deploy: 'docker' }).expect(201)).body;
      await post(a, `/api/admin/instances/${oi.id}/probe`).expect(409);
    } finally {
      await mlx.stop();
    }
  });
});
