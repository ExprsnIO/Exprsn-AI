import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';

const GB = 1_000_000_000;

describe('Ollama gateway', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let a: Client;
  let b: Client;
  const post = (c: Client, url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body);
  const patch = (c: Client, url: string, body: object) => c.agent.patch(url).set('x-csrf-token', c.csrf).send(body);

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000', OLLAMA_MAX_LOADS_PER_10_MIN: '4' });
    ollama = await new FakeOllama().start();
    ollama.registry.set('llama3.1:8b', { name: 'llama3.1:8b', size: 5 * GB, capabilities: ['completion', 'tools'] });
    ollama.registry.set('qwen3:8b', { name: 'qwen3:8b', size: 6 * GB, capabilities: ['completion', 'tools', 'thinking'] });
    ollama.registry.set('big:70b', { name: 'big:70b', size: 40 * GB, capabilities: ['completion'] });
    ollama.reply = (msgs, o) => (o.tools.length ? { content: '', toolCall: { name: 'calculate', arguments: { expression: '17*23' } } } : { content: 'ready' });
    await localUser(h, 'ma', ['model-admin'], 'confidential');
    await localUser(h, 'mb', ['model-admin'], 'confidential');
    a = await loginAdmin(h, 'ma');
    b = await loginAdmin(h, 'mb');
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  /** Pool with one instance on the fake Ollama, and an approved model placed on it. */
  async function approvedModel(name = 'llama3.1:8b', memoryBytes = 24 * GB) {
    const pool = (await post(a, '/api/admin/pools', { name: 'gpu-large', accelerator: 'cuda', labelCeiling: 'confidential' }).expect(201)).body;
    const inst = (await post(a, `/api/admin/pools/${pool.id}/instances`, { name: 'gpu-large-1', url: ollama.url, deploy: 'docker', settings: { memoryBytes, parallel: 2 } }).expect(201)).body;
    const m = (await post(a, '/api/admin/models', { name, license: { name: 'Llama 3.1 Community' }, label: 'confidential', poolId: pool.id }).expect(201)).body;
    await h.s.jobs.runDue();
    await post(a, `/api/admin/models/${m.id}/evaluate`).expect(202);
    await h.s.jobs.runDue();
    await post(b, `/api/admin/models/${m.id}/lifecycle`, { to: 'approved' }).expect(200);
    return { pool, inst, model: m };
  }

  it('polls instances for version, health and residency', async () => {
    const pool = (await post(a, '/api/admin/pools', { name: 'cpu', accelerator: 'cpu' }).expect(201)).body;
    const inst = await post(a, `/api/admin/pools/${pool.id}/instances`, { name: 'cpu-1', url: ollama.url, deploy: 'baremetal' }).expect(201);
    expect(inst.body).toMatchObject({ health: 'healthy', version: '0.12.3', inflight: 0 });
    ollama.down = true;
    await h.s.gateway.pollAll();
    const snap = await a.agent.get('/api/admin/pools').expect(200);
    expect(snap.body[0].instances[0].health).toBe('unreachable');
  });

  it('refuses pickle checkpoints and blobs whose digest does not match', async () => {
    const r = await post(a, '/api/admin/models', { name: 'evil', source: 'https://example.test/model.bin' }).expect(422);
    expect(r.body).toMatchObject({ title: 'Import refused', reason: 'pickle' });
    const pool = (await post(a, '/api/admin/pools', { name: 'p1', accelerator: 'cuda' }).expect(201)).body;
    await post(a, `/api/admin/pools/${pool.id}/instances`, { name: 'i1', url: ollama.url, deploy: 'docker' }).expect(201);
    const m = (await post(a, '/api/admin/models', { name: 'llama3.1:8b', expectedDigest: 'a'.repeat(64), poolId: pool.id }).expect(201)).body;
    await h.s.jobs.runDue();
    const after = (await a.agent.get('/api/admin/models').expect(200)).body.find((x: { id: string }) => x.id === m.id);
    expect(after).toMatchObject({ importState: 'failed', state: 'draft' });
    expect(after.importError).toMatch(/Digest mismatch/);
    expect(ollama.available.has('llama3.1:8b')).toBe(false);
  });

  it('pulls, evaluates, and approves under dual control with a recorded licence', async () => {
    const pool = (await post(a, '/api/admin/pools', { name: 'p1', accelerator: 'cuda', labelCeiling: 'confidential' }).expect(201)).body;
    await post(a, `/api/admin/pools/${pool.id}/instances`, { name: 'i1', url: ollama.url, deploy: 'docker' }).expect(201);
    const m = (await post(a, '/api/admin/models', { name: 'llama3.1:8b', label: 'internal', poolId: pool.id }).expect(201)).body;
    await post(b, `/api/admin/models/${m.id}/lifecycle`, { to: 'approved' }).expect(409); // not pulled/evaluated
    await h.s.jobs.runDue();
    let row = (await a.agent.get('/api/admin/models').expect(200)).body[0];
    expect(row).toMatchObject({ importState: 'pulled', format: 'gguf', capabilities: ['completion', 'tools'], contextLength: 8192 });
    expect(row.digest).toMatch(/^[a-f0-9]{64}$/);

    ollama.reply = (msgs, o) => (o.tools.length ? { content: '', toolCall: { name: 'calculate', arguments: { expression: '17*23' } } } : { content: 'ready' });
    await post(a, `/api/admin/models/${m.id}/evaluate`).expect(202);
    await h.s.jobs.runDue();
    row = (await a.agent.get('/api/admin/models').expect(200)).body[0];
    expect(row.state).toBe('evaluated');
    expect(row.evaluation).toMatchObject({ passed: 2, total: 2, toolsWithheld: false });

    await post(b, `/api/admin/models/${m.id}/lifecycle`, { to: 'approved' }).expect(409); // no licence
    await patch(a, `/api/admin/models/${m.id}`, { license: { name: 'Llama 3.1 Community', url: 'https://llama.meta.com/llama3_1/license/' } }).expect(200);
    const self = await post(a, `/api/admin/models/${m.id}/lifecycle`, { to: 'approved' }).expect(403);
    expect(self.body.step).toBe('dual-control');
    const ok = await post(b, `/api/admin/models/${m.id}/lifecycle`, { to: 'approved' }).expect(200);
    expect(ok.body).toMatchObject({ state: 'approved' });
    await post(a, `/api/admin/models/${m.id}/lifecycle`, { to: 'retired' }).expect(409);
    await post(a, `/api/admin/models/${m.id}/lifecycle`, { to: 'deprecated' }).expect(200);
    await post(a, `/api/admin/models/${m.id}/lifecycle`, { to: 'retired' }).expect(200);
    const events = (await h.s.audit.list(h.tenantId, { action: 'model.' })).map((e) => e.action);
    expect(events).toEqual(expect.arrayContaining(['model.import.requested', 'model.approved', 'model.deprecated', 'model.retired']));
  });

  it('withholds the tools capability when the tool-calling test fails', async () => {
    ollama.reply = () => ({ content: 'I would rather not call tools.' });
    const pool = (await post(a, '/api/admin/pools', { name: 'p1', accelerator: 'cuda' }).expect(201)).body;
    await post(a, `/api/admin/pools/${pool.id}/instances`, { name: 'i1', url: ollama.url, deploy: 'docker' }).expect(201);
    const m = (await post(a, '/api/admin/models', { name: 'llama3.1:8b', poolId: pool.id }).expect(201)).body;
    await h.s.jobs.runDue();
    await post(a, `/api/admin/models/${m.id}/evaluate`).expect(202);
    await h.s.jobs.runDue();
    const row = (await a.agent.get('/api/admin/models').expect(200)).body[0];
    expect(row.state).toBe('evaluated');
    expect(row.evaluation.toolsWithheld).toBe(true);
  });

  it('plans memory, evicts warm models but never pinned ones, and limits load churn', async () => {
    const { inst } = await approvedModel('llama3.1:8b', 10 * GB);
    const g = h.s.gateway;
    // pull a second model onto the same pool
    const m2 = (await post(a, '/api/admin/models', { name: 'qwen3:8b', license: { name: 'Apache 2.0' }, poolId: inst.pool_id }).expect(201)).body;
    await h.s.jobs.runDue();
    await post(a, `/api/admin/instances/${inst.id}/load`, { model: 'llama3.1:8b' }).expect(200);
    let plan = (await a.agent.get(`/api/admin/instances/${inst.id}/plan?model=qwen3:8b`).expect(200)).body;
    expect(plan).toMatchObject({ fits: true, evict: ['llama3.1:8b'] });
    await post(a, `/api/admin/instances/${inst.id}/load`, { model: 'qwen3:8b' }).expect(200);
    expect([...ollama.loaded.keys()]).toEqual(['qwen3:8b']);
    const events = (await a.agent.get(`/api/admin/instances/${inst.id}/events`).expect(200)).body;
    expect(events.some((e: { model: string; reason: string }) => e.model === 'llama3.1:8b' && /Evicted by the planner/.test(e.reason))).toBe(true);

    // pin qwen3 through its placement: now llama cannot evict it
    const pl = (await a.agent.get('/api/admin/models').expect(200)).body.find((x: { id: string }) => x.id === m2.id).pools[0];
    await patch(a, `/api/admin/placements/${pl.placementId}`, { residency: 'pinned' }).expect(200);
    plan = await g.plan(inst.id, 'llama3.1:8b');
    expect(plan.fits).toBe(false);
    const refused = await post(a, `/api/admin/instances/${inst.id}/load`, { model: 'llama3.1:8b' }).expect(409);
    expect(refused.body.title).toBe('No spare memory');

    // anti-thrash: 4 loads per ten minutes on this instance (2 so far)
    await post(a, `/api/admin/instances/${inst.id}/unload`, { model: 'qwen3:8b' }).expect(200);
    await post(a, `/api/admin/instances/${inst.id}/load`, { model: 'llama3.1:8b' }).expect(200);
    await post(a, `/api/admin/instances/${inst.id}/unload`, { model: 'llama3.1:8b' }).expect(200);
    await post(a, `/api/admin/instances/${inst.id}/load`, { model: 'llama3.1:8b' }).expect(200);
    const thrash = await post(a, `/api/admin/instances/${inst.id}/load`, { model: 'qwen3:8b' }).expect(429);
    expect(thrash.body.limit).toBe('anti_thrash');
    expect(thrash.headers['retry-after']).toBeDefined();
  });

  it('records models that disappear without being unloaded as evicted', async () => {
    const { inst } = await approvedModel();
    await post(a, `/api/admin/instances/${inst.id}/load`, { model: 'llama3.1:8b' }).expect(200);
    ollama.loaded.clear();
    await h.s.gateway.pollAll();
    const events = await h.s.gateway.repo.events(inst.id);
    expect(events[0]).toMatchObject({ model: 'llama3.1:8b', event: 'evicted', actor: 'ollama' });
  });

  it('publishes a profile that routes to the approved model, with aliases, canary and rollback', async () => {
    const { pool, inst, model } = await approvedModel();
    await localUser(h, 'pa', ['model-admin'], 'confidential');
    const prof = (await post(a, '/api/admin/profiles', { name: 'general-8b', displayName: 'General 8B', modelId: model.id, poolId: pool.id, numCtx: 8192, temperature: 0.7, label: 'internal', tools: ['calculate'] }).expect(201)).body;
    expect(prof).toMatchObject({ status: 'draft', version: 1 });
    await post(a, `/api/admin/profiles/${prof.id}/publish`).expect(200);
    const alias = (await post(a, '/api/admin/profiles', { name: 'chat-default', displayName: 'Chat default', aliasOf: prof.id }).expect(201)).body;
    expect(alias.status).toBe('published');

    // the done-when of sprint 3: the profile routes to the model on the pool
    const resolved = await h.s.gateway.resolve(h.tenantId, 'chat-default');
    expect(resolved).toMatchObject({ via: ['chat-default'], model: { name: 'llama3.1:8b' }, canary: false });
    const lease = await h.s.gateway.acquire(resolved.profile, resolved.model, 'internal', { signal: new AbortController().signal });
    expect(lease.instance.id).toBe(inst.id);
    expect(lease.cold).toBe(true);
    lease.release();

    // a pool whose ceiling is below the data label is never used
    await expect(h.s.gateway.acquire(resolved.profile, resolved.model, 'restricted', { signal: new AbortController().signal })).rejects.toMatchObject({ status: 503 });

    // canary: another approved model takes a share of requests
    const m2 = (await post(a, '/api/admin/models', { name: 'qwen3:8b', license: { name: 'Apache 2.0' }, label: 'confidential', poolId: pool.id }).expect(201)).body;
    await h.s.jobs.runDue();
    await post(a, `/api/admin/models/${m2.id}/evaluate`).expect(202);
    await h.s.jobs.runDue();
    await post(b, `/api/admin/models/${m2.id}/lifecycle`, { to: 'approved' }).expect(200);
    const canary = await a.agent.put(`/api/admin/profiles/${prof.id}/canary`).set('x-csrf-token', a.csrf).send({ modelId: m2.id, percent: 10 }).expect(200);
    expect(canary.body.canary).toEqual({ modelId: m2.id, percent: 10 });
    expect((await h.s.gateway.resolve(h.tenantId, 'general-8b', 0.05)).model.name).toBe('qwen3:8b');
    expect((await h.s.gateway.resolve(h.tenantId, 'general-8b', 0.5)).model.name).toBe('llama3.1:8b');

    // rollback to version 2 (published, before the canary)
    const versions = (await a.agent.get(`/api/admin/profiles/${prof.id}/versions`).expect(200)).body;
    expect(versions.map((v: { version: number }) => v.version)).toEqual([3, 2, 1]);
    const rb = await post(a, `/api/admin/profiles/${prof.id}/rollback`, { version: 2 }).expect(200);
    expect(rb.body).toMatchObject({ canary: null, version: 4, status: 'published' });

    // a profile cannot publish with a model the pool's ceiling does not clear, or with thinking the model lacks
    await patch(a, `/api/admin/profiles/${prof.id}`, { thinkCeiling: 'high' }).expect(409);
    const list = (await a.agent.get('/api/admin/profiles').expect(200)).body;
    expect(list.find((x: { name: string }) => x.name === 'general-8b')).toMatchObject({ model: { name: 'llama3.1:8b' }, pool: 'gpu-large', residency: 'loaded' });
    await a.agent.delete(`/api/admin/profiles/${prof.id}`).set('x-csrf-token', a.csrf).expect(409);
  });

  it('queues requests when every slot is busy and hands the slot over in order', async () => {
    const { model, pool } = await approvedModel();
    const prof = (await post(a, '/api/admin/profiles', { name: 'p', displayName: 'P', modelId: model.id, poolId: pool.id }).expect(201)).body;
    await post(a, `/api/admin/profiles/${prof.id}/publish`).expect(200);
    const { profile, model: m } = await h.s.gateway.resolve(h.tenantId, 'p');
    const sig = new AbortController().signal;
    const l1 = await h.s.gateway.acquire(profile, m, 'internal', { signal: sig });
    const l2 = await h.s.gateway.acquire(profile, m, 'internal', { signal: sig });
    const positions: number[] = [];
    const third = h.s.gateway.acquire(profile, m, 'internal', { signal: sig, onPosition: (n) => positions.push(n) });
    await new Promise((r) => setTimeout(r, 20));
    expect(positions).toEqual([1]);
    l1.release(120);
    const l3 = await third;
    expect(l3.instance.id).toBe(l1.instance.id);
    await expect(h.s.gateway.acquire(profile, m, 'internal', { signal: sig, waitMs: 30 })).rejects.toThrow(/busy/);
    l2.release();
    l3.release();
  });

  it('drains an instance and rolls an Ollama upgrade through a pool', async () => {
    const { inst, pool, model } = await approvedModel();
    await post(a, `/api/admin/instances/${inst.id}/load`, { model: 'llama3.1:8b', pinned: true }).expect(200);
    const drained = await post(a, `/api/admin/instances/${inst.id}/drain`).expect(200);
    expect(drained.body.unloaded).toEqual(['llama3.1:8b']);
    expect((await h.s.gateway.repo.instance(inst.id))?.state).toBe('draining');
    await post(a, `/api/admin/instances/${inst.id}/undrain`).expect(200);

    const pl = (await a.agent.get('/api/admin/models').expect(200)).body.find((x: { id: string }) => x.id === model.id).pools[0];
    await patch(a, `/api/admin/placements/${pl.placementId}`, { residency: 'pinned' }).expect(200);
    const job = await post(a, `/api/admin/pools/${pool.id}/upgrade`, { targetVersion: '0.13.0', waitMinutes: 1 }).expect(202);
    // the "operator" upgrades the container while the job waits
    setTimeout(() => (ollama.version = '0.13.0'), 50);
    await h.s.jobs.runDue();
    const done = await h.s.jobs.get(h.tenantId, job.body.jobId);
    expect(done).toMatchObject({ state: 'succeeded', result: { done: ['gpu-large-1 upgraded to 0.13.0'] } });
    expect((await h.s.gateway.repo.instance(inst.id))?.state).toBe('active');
    expect(ollama.loaded.has('llama3.1:8b')).toBe(true);
  });

  it('keeps members to reading the catalogue', async () => {
    await localUser(h, 'mem', ['member']);
    const { login } = await import('./helpers.js');
    const m = await login(h, 'mem');
    await m.agent.get('/api/admin/models').expect(200);
    await m.agent.get('/api/admin/pools').expect(403);
    await m.agent.post('/api/admin/models').set('x-csrf-token', m.csrf).send({ name: 'x' }).expect(403);
  });
});
