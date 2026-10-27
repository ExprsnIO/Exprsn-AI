import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Lease } from '../src/gateway/gateway.js';
import type { ProfileRow } from '../src/gateway/repo.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { FakeOllama } from './fake-ollama.js';
import { seedGateway } from './seed-gateway.js';
import { harness, localUser, login, loginAdmin, type Harness } from './helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A profile's fallback outside chat: the gateway's chain, agent runs and workflow model steps. */
describe('Profile fallback in agent runs and workflow model steps', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let backup: ProfileRow;

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    ollama = await new FakeOllama().start();
    ollama.chatDelayMs = 0;
    const seeded = await seedGateway(h, ollama);
    const repo = h.s.gateway.repo;
    // One slot on the instance, and a second profile the first falls back to after 40 ms in the queue.
    await repo.updateInstance((await repo.instances())[0]!.id, { settings: { parallel: 1 } });
    // The backup runs another model, so that one model failing leaves it standing.
    ollama.addAvailable({ name: 'granite:2b', size: 2_000_000_000, capabilities: ['completion', 'tools'] });
    const spare = await repo.createModel({ name: 'granite:2b', source: 'Ollama library', expectedDigest: null, license: { name: 'test' }, label: 'confidential', notes: null, requestedBy: 'x', requestedTenant: h.tenantId });
    await repo.updateModel(spare.id, { state: 'approved', import_state: 'pulled', capabilities: ['completion', 'tools'], size_bytes: 2_000_000_000 });
    await repo.place(spare.id, seeded.pool.id, 'warm', 'x');
    backup = { ...seeded.profile, id: 'BACKUP'.padEnd(26, '0'), name: 'backup', display_name: 'Backup', model_id: spare.id, fallback: null };
    await repo.createProfile(backup);
    await repo.updateProfile(h.tenantId, seeded.profile.id, { fallback: { profileId: backup.id, afterQueueWaitMs: 40 } });
    await h.s.gateway.pollAll();
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  /** Takes the instance's only slot, as a long answer would. */
  const occupy = async (): Promise<Lease> => {
    const r = await h.s.gateway.resolve(h.tenantId, 'general');
    return h.s.gateway.acquire(r.profile, r.model, 'internal', { signal: new AbortController().signal });
  };

  it('the gateway follows the chain after the queue wait, and stays on the profile when the fallback is refused', async () => {
    const g = h.s.gateway;
    const r = await g.resolve(h.tenantId, 'general');
    const signal = new AbortController().signal;
    // A free slot: the profile itself.
    const free = await g.acquireFollowing(r, 'internal', { signal }, (id) => g.resolve(h.tenantId, id));
    expect([free.resolved.profile.name, free.from]).toEqual(['general', []]);

    // Busy past the wait: the fallback, which gets the slot when it frees.
    const wait = g.acquireFollowing(r, 'internal', { signal }, (id) => g.resolve(h.tenantId, id));
    await sleep(120);
    free.lease.release(null);
    const fell = await wait;
    expect([fell.resolved.profile.name, fell.from]).toEqual(['backup', ['general']]);

    // A fallback the caller may not use (the resolver returns null or throws): the wait goes on for the profile.
    for (const refuse of [async () => null, async () => Promise.reject(new Error('not cleared'))]) {
      const stay = g.acquireFollowing(r, 'internal', { signal }, refuse);
      await sleep(120);
      fell.lease.release(null);
      const kept = await stay;
      expect([kept.resolved.profile.name, kept.from]).toEqual(['general', []]);
      fell.lease = kept.lease;
    }
    fell.lease.release(null);
  });

  it('a call that fails on the profile is made again on its fallback; with none left, the failure stands', async () => {
    const g = h.s.gateway;
    const r = await g.resolve(h.tenantId, 'general');
    const signal = new AbortController().signal;
    const resolve = (id: string) => g.resolve(h.tenantId, id);
    const seen: string[] = [];
    const run = async (use: typeof r, lease: Lease) => {
      seen.push(use.model.name);
      try {
        let text = '';
        for await (const chunk of lease.client.chat({ model: use.model.name, messages: [{ role: 'user', content: 'hello' }] }, signal)) text += chunk.message?.content ?? '';
        return text;
      } finally {
        lease.release(null);
      }
    };
    ollama.reply = () => ({ content: 'Done.' });
    ollama.chatError = (model) => (model === 'llama3.1:8b' ? 'mlx runner failed: panic' : null);
    const out = await g.runFollowing(r, 'internal', { signal }, resolve, run);
    expect(out).toMatchObject({ value: 'Done.', from: ['general'], failed: [{ profile: 'general', error: expect.stringContaining('mlx runner failed') }] });
    expect(out.resolved.profile.name).toBe('backup');
    expect(seen).toEqual(['llama3.1:8b', 'granite:2b']);

    // Both fail: the chain ends at the backup (it has no fallback), and its failure is the one reported.
    ollama.chatError = () => 'out of memory';
    await expect(g.runFollowing(r, 'internal', { signal }, resolve, run)).rejects.toThrow(/out of memory/);
    // A fallback the caller may not use: the profile's own failure stands.
    ollama.chatError = (model) => (model === 'llama3.1:8b' ? 'mlx runner failed: panic' : null);
    await expect(g.runFollowing(r, 'internal', { signal }, async () => null, run)).rejects.toThrow(/mlx runner failed/);
    // A cancelled call is not tried elsewhere.
    const ac = new AbortController();
    const before = seen.length;
    await expect(g.runFollowing(r, 'internal', { signal: ac.signal }, resolve, async (use) => {
      seen.push(use.model.name);
      ac.abort(new Error('stopped'));
      throw new Error('stopped');
    })).rejects.toThrow(/stopped/);
    expect(seen.length).toBe(before + 1);
  });

  it('an agent run\'s model call is served by the fallback and says so in the step', async () => {
    const admin = async (name: string) => {
      await localUser(h, name, ['tool-admin'], 'confidential');
      const c = await loginAdmin(h, name);
      return (path: string, body: object = {}) => c.agent.post(path).set('x-csrf-token', c.csrf).send(body);
    };
    const [author, reviewer] = [await admin('author'), await admin('reviewer')];
    const e = (await author('/api/admin/registry', { kind: 'agent', name: 'Helper', version: '1.0.0', description: 'Answers questions briefly and plainly for the people of the workspace.', label: 'confidential', definition: { profile: 'general', systemPrompt: 'Be brief.', tools: [], budgets: { steps: 5, tokens: 10000, wallSeconds: 60, toolCalls: 1 } } }).expect(201)).body as { id: string };
    await author(`/api/admin/registry/${e.id}/submit`).expect(200);
    await reviewer(`/api/admin/registry/${e.id}/review`, { decision: 'approve' }).expect(200);
    await localUser(h, 'mem', ['member'], 'confidential');
    const m = await login(h, 'mem');
    ollama.reply = () => ({ content: 'Done.' });

    const held = await occupy();
    const run = (await m.agent.post('/api/runs').set('x-csrf-token', m.csrf).send({ agent: 'Helper', input: 'Say done.', label: 'internal' }).expect(202)).body as { id: string };
    const working = h.s.jobs.runDue();
    await sleep(150);
    held.release(null);
    await working;
    const v = (await m.agent.get(`/api/runs/${run.id}`).expect(200)).body as { state: string; steps: { meta: Record<string, unknown> }[] };
    expect(v.state).toBe('succeeded');
    expect(v.steps[0]!.meta).toMatchObject({ profile: 'backup', fallbackFrom: ['general'] });

    // With the slot free, the next run is the profile's own again.
    const again = (await m.agent.post('/api/runs').set('x-csrf-token', m.csrf).send({ agent: 'Helper', input: 'Say done.', label: 'internal' }).expect(202)).body as { id: string };
    await h.s.jobs.runDue();
    const v2 = (await m.agent.get(`/api/runs/${again.id}`).expect(200)).body as typeof v;
    expect(v2.steps[0]!.meta).toMatchObject({ profile: 'general' });
    expect(v2.steps[0]!.meta.fallbackFrom).toBeUndefined();

    // The profile's model fails outright: the run goes on with the fallback and the step says what failed.
    ollama.chatError = (model) => (model === 'llama3.1:8b' ? 'mlx runner failed: panic' : null);
    const third = (await m.agent.post('/api/runs').set('x-csrf-token', m.csrf).send({ agent: 'Helper', input: 'Say done.', label: 'internal' }).expect(202)).body as { id: string };
    await h.s.jobs.runDue();
    const v3 = (await m.agent.get(`/api/runs/${third.id}`).expect(200)).body as typeof v;
    expect(v3.state).toBe('succeeded');
    expect(v3.steps[0]!.meta).toMatchObject({ profile: 'backup', model: 'granite:2b', fallbackFrom: ['general'], fallbackAfter: [{ profile: 'general', error: expect.stringContaining('mlx runner failed') }] });
  });

  it('a workflow model step is served by the fallback and records it in the step\'s detail', async () => {
    const u = await localUser(h, 'flow', ['member', 'workflow-admin'], 'confidential');
    const p = { ...(await loadPrincipal(h.s, h.tenantId, u.id, {}))!, mfa: true };
    const w = await h.s.workflows.create(p, {
      name: 'summarise',
      label: 'internal',
      graph: { nodes: [{ id: 'trigger', kind: 'trigger', title: 'Trigger', x: 0, y: 0, config: {} }, { id: 'sum', kind: 'model', title: 'Summarise', x: 0, y: 0, config: { profile: 'general', prompt: 'Summarise {{input.topic}}', format: 'text' } }], edges: [{ from: 'trigger', to: 'sum' }], limits: {} }
    });
    await h.s.workflows.publish(p, w.id, null);
    const held = await occupy();
    const started = await h.s.workflows.start(p, w.id, { input: { topic: 'q3' }, dry: false });
    const working = h.s.jobs.runDue();
    await sleep(150);
    held.release(null);
    await working;
    const run = await h.s.workflows.runView(p, started.id);
    expect(run.state).toBe('succeeded');
    const step = (run.steps as { nodeId: string; detail: Record<string, unknown> }[]).find((s) => s.nodeId === 'sum')!;
    expect(step.detail).toMatchObject({ profile: 'general', fallback: ['backup'] });

    // The same when the profile's model fails outright.
    ollama.chatError = (model) => (model === 'llama3.1:8b' ? 'mlx runner failed: panic' : null);
    const second = await h.s.workflows.start(p, w.id, { input: { topic: 'q4' }, dry: false });
    await h.s.jobs.runDue();
    const run2 = await h.s.workflows.runView(p, second.id);
    expect(run2.state).toBe('succeeded');
    expect((run2.steps as typeof run.steps as { nodeId: string; detail: Record<string, unknown> }[]).find((s) => s.nodeId === 'sum')!.detail).toMatchObject({ fallback: ['backup'], fallbackAfter: [{ profile: 'general' }] });
  });
});
