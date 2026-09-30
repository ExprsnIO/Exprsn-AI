import { afterEach, describe, expect, it } from 'vitest';
import { describeWindow, nextCron, parseCron, windowAt } from '../src/training/calendar.js';
import { maskText, parseRows, scrubRows } from '../src/training/scrub.js';
import { NO_TRAINER } from '../src/training/trainer.js';
import type { Label } from '../src/authz/labels.js';
import { FakeOllama } from './fake-ollama.js';
import { FakeTrainer } from './fake-trainer.js';
import { localUser, loginAdmin, type Harness } from './helpers.js';
import { client, drain, harnessWith } from './retrieval-seed.js';

const BASE = 'llama3.1:8b-q5_K_M';
const GB = 1_000_000_000;

const ROWS = [
  { prompt: 'What is the refund window?', completion: 'Thirty days. Contact billing@northwind.example for exceptions.' },
  { prompt: 'Card on file?', completion: 'The card 4111 1111 1111 1111 was charged.' },
  { messages: [{ role: 'user', content: 'Close the quarter' }, { role: 'assistant', content: 'Done, the ledger is closed.' }] }
];

async function admin(h: Harness, name: string, roles: string[], clearance: Label = 'confidential') {
  const user = await localUser(h, name, roles, clearance);
  const c = await loginAdmin(h, name);
  const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
  return { user, get: (p: string) => c.agent.get(p), post: (p: string, b?: object) => send('post', p, b), patch: (p: string, b?: object) => send('patch', p, b), put: (p: string, b?: object) => send('put', p, b), del: (p: string) => send('delete', p) };
}
type Admin = Awaited<ReturnType<typeof admin>>;

async function seedBase(h: Harness, label: Label = 'confidential') {
  const repo = h.s.gateway.repo;
  const m = await repo.createModel({ name: BASE, source: 'Ollama library', expectedDigest: null, license: { name: 'Llama 3.1 Community' }, label, notes: null, requestedBy: 'x', requestedTenant: h.tenantId });
  await repo.updateModel(m.id, { state: 'approved', import_state: 'pulled', digest: 'sha256:7d21e6b0', family: 'llama', parameter_size: '8B', capabilities: ['completion'] });
  return m;
}

const jobBody = (name: string, datasetId: string, extra: Record<string, unknown> = {}) => ({ name, baseModel: BASE, datasetId, method: { kind: 'lora', rank: 16, alpha: 32, epochs: 2, seed: 1337 }, hardware: { accelerator: 'cuda', gpus: 2, memoryGb: 80 }, steps: 1000, checkpointEvery: 250, ...extra });

async function dataset(h: Harness, a: Admin, name: string, label: Label, rows: object[] = ROWS) {
  const d = await a.post('/api/training/datasets', { name, label, source: `${name} pairs`, rows }).expect(202);
  await drain(h);
  return (await a.get(`/api/training/datasets/${d.body.id}`).expect(200)).body;
}

/** Ticks the orchestrator and runs the jobs it queued, `n` times. */
async function ticks(h: Harness, n = 1) {
  for (let i = 0; i < n; i++) {
    await h.s.training.tick();
    await drain(h);
  }
}

describe('training calendar and scrub', () => {
  it('parses cron and computes the next run in UTC', () => {
    expect(() => parseCron('0 22 * *')).toThrow(/five fields/);
    expect(() => parseCron('61 * * * *')).toThrow(/out of range/);
    const thu = Date.UTC(2026, 8, 24, 21, 0); // Thursday 24 Sep 2026
    expect(new Date(nextCron('0 22 * * 4', thu)!).toISOString()).toBe('2026-09-24T22:00:00.000Z');
    expect(new Date(nextCron('0 22 * * 4', Date.UTC(2026, 8, 24, 22, 0))!).toISOString()).toBe('2026-10-01T22:00:00.000Z');
    expect(new Date(nextCron('*/15 * * * *', Date.UTC(2026, 8, 24, 10, 7))!).toISOString()).toBe('2026-09-24T10:15:00.000Z');
  });

  it('knows when a window is open and closing', () => {
    const nights = { kind: 'daily' as const, start_day: null, start_time: '22:00', end_day: null, end_time: '06:00', reload_minutes: 20 };
    expect(windowAt(nights, Date.UTC(2026, 8, 24, 1, 0))).toMatchObject({ open: true, closing: false, closesAt: Date.UTC(2026, 8, 24, 6, 0) });
    expect(windowAt(nights, Date.UTC(2026, 8, 24, 5, 45))).toMatchObject({ open: true, closing: true });
    expect(windowAt(nights, Date.UTC(2026, 8, 24, 12, 0))).toMatchObject({ open: false, opensAt: Date.UTC(2026, 8, 24, 22, 0) });
    const weekend = { kind: 'weekly' as const, start_day: 6, start_time: '22:00', end_day: 1, end_time: '06:00', reload_minutes: 20 };
    expect(windowAt(weekend, Date.UTC(2026, 8, 27, 12, 0)).open).toBe(true); // Sunday
    expect(windowAt(weekend, Date.UTC(2026, 8, 30, 12, 0)).open).toBe(false); // Wednesday
    expect(describeWindow(weekend)).toBe('Sat 22:00 to Mon 06:00');
  });

  it('masks PII with placeholders and reports kinds, rows and fields without values', () => {
    expect(maskText('mail a@b.example now').text).toBe('mail [EMAIL] now');
    const { rows, report } = scrubRows(parseRows(ROWS.map((r) => JSON.stringify(r)).join('\n')));
    expect(JSON.stringify(rows)).not.toContain('billing@northwind');
    expect(JSON.stringify(rows)).toContain('[PAYMENT_CARD]');
    expect(report).toMatchObject({ masked: 2, rowsAffected: 2, byKind: { email: 1, payment_card: 1 } });
    expect(report.findings[0]).toEqual({ row: 1, field: 'completion', kind: 'email' });
    expect(() => parseRows('{"prompt":"x"}\n')).toThrow(/Line 1 needs/);
  });
});

describe('training', () => {
  let h: Harness;
  let trainer: FakeTrainer;
  let ollama: FakeOllama | null = null;
  afterEach(async () => {
    await h.close();
    await ollama?.stop();
    ollama = null;
  });

  async function setup() {
    trainer = new FakeTrainer();
    h = await harnessWith({ trainer });
    await seedBase(h);
    const ml1 = await admin(h, 'mara', ['ml-admin']);
    const ml2 = await admin(h, 'sam', ['ml-admin']);
    await ml1.post('/api/training/windows', { name: 'dedicated', kind: 'always' }).expect(201);
    return { ml1, ml2 };
  }

  it('registers a dataset version: scrubbed, hashed, sealed, with an audited report', async () => {
    const { ml1 } = await setup();
    const d = await dataset(h, ml1, 'finance-qa', 'confidential');
    expect(d).toMatchObject({ state: 'ready', version: 1, rows: 3, pii: '2 masked, report attached', splits: { pct: { train: 80, val: 10, test: 10 } } });
    expect(d.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const row = await h.s.db('training_datasets').where({ id: d.id }).first();
    const blob = (await h.s.blobs.get(row.blob_key))!.toString();
    expect(blob).not.toContain('refund');
    expect(await h.s.blobs.get(`training/${h.tenantId}/datasets/${d.id}/raw.jsonl`)).toBeNull();
    const rep = await ml1.get(`/api/training/datasets/${d.id}/report`).expect(200);
    expect(rep.body).toMatchObject({ masked: 2, byKind: { email: 1, payment_card: 1 } });
    expect(JSON.stringify(rep.body)).not.toContain('billing@');
    expect(await h.s.db('audit_events').where({ action: 'training.dataset.report.read' }).first()).toBeTruthy();
    // Next version, and conversation data needs the tenant opt-in.
    const v2 = await ml1.post('/api/training/datasets', { name: 'finance-qa', label: 'confidential', source: 'x', rows: ROWS }).expect(202);
    expect(v2.body.version).toBe(2);
    const conv = await ml1.post('/api/training/datasets', { name: 'chats', label: 'internal', source: 'x', rows: ROWS, conversationData: true }).expect(409);
    expect(conv.body.detail).toMatch(/opt-in/);
    await ml1.put('/api/training/settings', { conversationOptIn: true }).expect(403);
  });

  it('holds a confidential job for approval by a different ML admin, then trains, evaluates and registers a draft', async () => {
    const { ml1, ml2 } = await setup();
    const low = await admin(h, 'lee', ['ml-admin'], 'internal');
    const d = await dataset(h, ml1, 'finance-qa', 'confidential');
    const j = (await ml1.post('/api/training/jobs', jobBody('finance-lora-v5', d.id)).expect(201)).body;
    expect(j).toMatchObject({ state: 'queued', awaiting: true, stage: 1, label: 'confidential', waitReason: 'waits for approval' });
    await ticks(h);
    expect(trainer.submits).toHaveLength(0);
    // Clearance: an ML admin cleared to internal does not see it.
    await low.get(`/api/training/jobs/${j.id}`).expect(404);
    expect((await low.get('/api/training/jobs').expect(200)).body).toHaveLength(0);
    expect((await low.get('/api/training/datasets').expect(200)).body).toHaveLength(0);
    // Dual control.
    const self = await ml1.post(`/api/training/jobs/${j.id}/approve`).expect(403);
    expect(self.body.step).toBe('dual-control');
    const ok = await ml2.post(`/api/training/jobs/${j.id}/approve`).expect(200);
    expect(ok.body).toMatchObject({ awaiting: false, approvedBy: 'SAM', stage: 2 });
    await drain(h); // the kick dispatches it
    expect(trainer.submits).toHaveLength(1);
    expect(trainer.submits[0]!.spec).toMatchObject({ baseModel: BASE, dataset: { name: 'finance-qa', version: 1, rows: 3 }, resumeFrom: null });
    expect(trainer.submits[0]!.data).toContain('[EMAIL]');
    await ticks(h, 2);
    const done = (await ml1.get(`/api/training/jobs/${j.id}`).expect(200)).body;
    expect(done).toMatchObject({ state: 'succeeded', stage: 6, step: 1000 });
    expect(done.series.length).toBeGreaterThan(5);
    expect(done.gpuHours).toBeGreaterThan(0);
    expect(done.model).toMatchObject({ name: 'finance-lora-v5:8b', state: 'draft' });
    const model = await h.s.gateway.repo.modelByName('finance-lora-v5:8b');
    expect(model).toMatchObject({ state: 'draft', label: 'confidential', source: `training:${j.id}`, format: 'gguf', quantization: 'Q4_K_M', expected_digest: `sha256:${'ab'.repeat(32)}` });
    const card = (await ml1.get(`/api/training/jobs/${j.id}/card`).expect(200)).body;
    expect(card).toMatchObject({ baseDigest: 'sha256:7d21e6b0', dataset: { name: 'finance-qa', version: 1, hash: d.hash }, approval: { byName: 'SAM' }, registration: { state: 'registered' }, packaging: { quantization: 'Q4_K_M' } });
    expect(card.evals).toHaveLength(3);
    expect(card.manifest.signature).toMatch(/^local:v1:/);
    // Metered against the tenant's training GPU-hours.
    const used = await h.s.quotas.used(h.tenantId, null);
    expect(used.trainingGpuHoursMonth).toBeGreaterThan(0);
    const actions = (await h.s.db('audit_events').where('action', 'like', 'training.%').select('action')).map((r: { action: string }) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['training.job.submitted', 'training.job.approved', 'training.job.started', 'training.job.trained', 'training.evals.passed', 'training.model.registered']));
  });

  it('checkpoints on preemption and resumes from the checkpoint, not from zero; pause does the same', async () => {
    const { ml1 } = await setup();
    const d = await dataset(h, ml1, 'feedback', 'internal');
    const j = (await ml1.post('/api/training/jobs', jobBody('guard-tune-v2', d.id, { priority: 'low' })).expect(201)).body;
    expect(j.awaiting).toBe(false);
    await drain(h);
    trainer.preemptAt = 500;
    await ticks(h);
    let v = (await ml1.get(`/api/training/jobs/${j.id}`).expect(200)).body;
    expect(v).toMatchObject({ state: 'preempted', step: 500, checkpoint: { step: 500 } });
    expect(v.note).toMatch(/Resumes from the checkpoint, not from zero/);
    await ticks(h); // dispatched again
    expect(trainer.submits).toHaveLength(2);
    expect(trainer.submits[1]!.spec.resumeFrom).toMatchObject({ step: 500, ref: expect.stringContaining('step-500') });
    v = (await ml1.get(`/api/training/jobs/${j.id}`).expect(200)).body;
    expect(v).toMatchObject({ state: 'running', step: 500 });
    expect(v.note).toMatch(/Resumed from the checkpoint at step 500/);

    // Pause: checkpoint at the current step, GPUs released, held until run again.
    trainer.stepsPerPoll = 250;
    await ticks(h);
    const paused = (await ml1.post(`/api/training/jobs/${j.id}/pause`).expect(200)).body;
    expect(paused).toMatchObject({ state: 'queued', holding: true, checkpoint: { step: 750, reason: 'pause' } });
    await ticks(h);
    expect(trainer.submits).toHaveLength(2);
    await ml1.post(`/api/training/jobs/${j.id}/resume`).expect(200);
    await drain(h);
    expect(trainer.submits).toHaveLength(3);
    expect(trainer.submits[2]!.spec.resumeFrom?.step).toBe(750);
    // Cancel keeps the checkpoint; retry requeues from it with a change.
    await ml1.post(`/api/training/jobs/${j.id}/cancel`).expect(200);
    const retried = (await ml1.post(`/api/training/jobs/${j.id}/retry`, { change: 'gpus4' }).expect(200)).body;
    expect(retried).toMatchObject({ state: 'queued', hardware: { gpus: 4 } });
    expect(retried.note).toMatch(/step 750 with 4 GPUs requested/);
  });

  it('stops before registration when an eval is below threshold, records it on the card, and registers after a passing re-run', async () => {
    const { ml1 } = await setup();
    trainer.scores.redteam = 0.968;
    const d = await dataset(h, ml1, 'finance-qa', 'internal');
    const j = (await ml1.post('/api/training/jobs', jobBody('finance-lora-v3', d.id)).expect(201)).body;
    await drain(h);
    await ticks(h, 2);
    const v = (await ml1.get(`/api/training/jobs/${j.id}`).expect(200)).body;
    expect(v).toMatchObject({ state: 'succeeded', stage: 3, stageTone: 'danger', model: null, registration: { state: 'blocked' } });
    expect(v.registration.reason).toMatch(/Guardrail red-team suite 0\.968 against a threshold of 0\.980 on cuda/);
    expect(trainer.converts).toHaveLength(0);
    expect(await h.s.gateway.repo.modelByName('finance-lora-v3:8b')).toBeUndefined();
    const card = (await ml1.get(`/api/training/jobs/${j.id}/card`).expect(200)).body;
    expect(card.evals.find((e: { suite: string }) => e.suite === 'redteam')).toMatchObject({ result: 'fail', scoreText: '0.968', thresholdText: '0.980' });
    const evals = (await ml1.get('/api/training/evals').expect(200)).body;
    expect(evals.filter((e: { result: string }) => e.result === 'fail')).toHaveLength(1);
    // A per-tenant threshold change and a re-run: registration proceeds on a pass.
    await ml1.put('/api/training/settings', { thresholds: { redteam: 0.96 } }).expect(200);
    await ml1.post('/api/training/evals', { jobId: j.id }).expect(202);
    await drain(h);
    const after = (await ml1.get(`/api/training/jobs/${j.id}`).expect(200)).body;
    expect(after).toMatchObject({ stage: 6, stageTone: null, model: { name: 'finance-lora-v3:8b', state: 'draft' } });
  });

  it('refuses admission with 429 when the tenant used its training GPU-hours', async () => {
    const { ml1 } = await setup();
    const d = await dataset(h, ml1, 'feedback', 'internal');
    await h.s.quotas.set(h.tenantId, null, { trainingGpuHoursPerMonth: 1 }, 'x');
    await h.s.quotas.record({ tenantId: h.tenantId, workspaceId: null, userId: null, kind: 'training', model: 'earlier', gpuMs: 2 * 3_600_000 });
    const res = await ml1.post('/api/training/jobs', jobBody('over', d.id)).expect(429);
    expect(res.body).toMatchObject({ limit: 'training_gpu_hours_per_month', used: 2, max: 1 });
    expect(res.headers['retry-after']).toBeTruthy();
    const summary = (await ml1.get('/api/training/summary').expect(200)).body;
    expect(summary.quota).toMatchObject({ usedHours: 2, limitHours: 1 });
  });

  it('needs the training permissions, MFA and pools:manage for lending a pool', async () => {
    const { ml1 } = await setup();
    const member = await client(h, 'mem', ['member'], 'restricted');
    await member.get('/api/training/jobs').expect(403);
    await member.post('/api/training/datasets', { name: 'x', label: 'internal', source: 'x', rows: ROWS }).expect(403);
    const pool = await h.s.gateway.repo.createPool({ name: 'gpu-large-2', accelerator: 'cuda', zone: 'inference', labelCeiling: 'confidential' });
    const res = await ml1.post('/api/training/windows', { name: 'nights', poolId: pool.id, kind: 'daily', startTime: '22:00', endTime: '06:00' }).expect(403);
    expect(res.body.detail).toMatch(/pools:manage/);
    expect(await h.s.db('audit_events').where({ action: 'authz.denied' }).first()).toBeTruthy();
  });

  it('lends a pool in a window: drains it on open, checkpoints jobs and reloads pinned models before close', async () => {
    trainer = new FakeTrainer();
    h = await harnessWith({ trainer });
    await seedBase(h);
    ollama = await new FakeOllama().start();
    ollama.addAvailable({ name: 'pinned-8b', size: 2 * GB });
    const repo = h.s.gateway.repo;
    const pool = await repo.createPool({ name: 'gpu-large-2', accelerator: 'cuda', zone: 'inference', labelCeiling: 'confidential' });
    const inst = await repo.createInstance({ poolId: pool.id, name: 'gpu-2a', url: ollama.url, deploy: 'docker', settings: { memoryBytes: 80 * GB } });
    const pm = await repo.createModel({ name: 'pinned-8b', source: 'Ollama library', expectedDigest: null, license: null, label: 'internal', notes: null, requestedBy: 'x', requestedTenant: h.tenantId });
    await repo.updateModel(pm.id, { state: 'approved', import_state: 'pulled', size_bytes: 2 * GB });
    await repo.place(pm.id, pool.id, 'pinned', 'x');
    await h.s.gateway.pollAll();
    const ops = await admin(h, 'ops', ['ml-admin', 'model-admin']);
    const now = new Date();
    const hh = (d: Date) => d.toISOString().slice(11, 16);
    const w = (await ops.post('/api/training/windows', { name: 'now', poolId: pool.id, kind: 'daily', startTime: hh(new Date(now.getTime() - 3_600_000)), endTime: hh(new Date(now.getTime() + 3 * 3_600_000)), reloadMinutes: 20 }).expect(201)).body;
    expect(w.effect).toMatch(/drained first, pinned models reloaded at/);
    const d = await dataset(h, ops, 'feedback', 'internal');
    const j = (await ops.post('/api/training/jobs', jobBody('nightly', d.id)).expect(201)).body;
    await drain(h);
    expect((await repo.instance(inst.id))!.state).toBe('draining');
    expect((await ops.get(`/api/training/jobs/${j.id}`).expect(200)).body).toMatchObject({ state: 'running', window: 'now' });
    // Two hours and fifty minutes later the window is closing.
    await h.s.training.tick(now.getTime() + 2 * 3_600_000 + 50 * 60_000);
    const v = (await ops.get(`/api/training/jobs/${j.id}`).expect(200)).body;
    expect(v.state).toBe('preempted');
    expect(v.note).toMatch(/when the now window closed/);
    expect((await repo.instance(inst.id))!.state).toBe('active');
    expect(ollama.requests.some((r) => r.path === '/api/generate' && r.body.model === 'pinned-8b' && r.body.keep_alive === -1)).toBe(true);
    const closed = await h.s.db('audit_events').where({ action: 'training.window.closed' }).first();
    expect(JSON.parse(closed.detail).reloaded).toEqual(['pinned-8b@gpu-2a']);
  });

  it('fires a recurring schedule only when the dataset version changed', async () => {
    const { ml1 } = await setup();
    const d = await dataset(h, ml1, 'feedback-approved', 'internal');
    const tpl = (await ml1.post('/api/training/jobs', jobBody('weekly-template', d.id)).expect(201)).body;
    const sc = (await ml1.post('/api/training/schedules', { name: 'weekly refresh', templateJobId: tpl.id, cron: '0 22 * * 4' }).expect(201)).body;
    expect(sc).toMatchObject({ enabled: true, conditionText: 'only when the input dataset version changed', cronText: 'Thu 22:00 (0 22 * * 4)' });
    const row = (await h.s.training.schedules(h.tenantId))[0]!;
    expect(await h.s.training.fireSchedule(row)).toBeNull();
    await dataset(h, ml1, 'feedback-approved', 'internal');
    const fired = await h.s.training.fireSchedule((await h.s.training.schedules(h.tenantId))[0]!);
    expect(fired).toMatchObject({ priority: 'low', schedule_id: sc.id });
    const list = (await ml1.get('/api/training/schedules').expect(200)).body;
    expect(list[0].lastResult).toMatch(/submitted weekly-refresh-.* on feedback-approved v2/);
    await ml1.patch(`/api/training/schedules/${sc.id}`, { enabled: false }).expect(200);
    expect((await ml1.get('/api/training/schedules').expect(200)).body[0]).toMatchObject({ enabled: false, nextRunAt: null });
  });

  it('says clearly when no training worker is configured', async () => {
    h = await harnessWith({});
    await seedBase(h);
    const ml1 = await admin(h, 'mara', ['ml-admin']);
    await ml1.post('/api/training/windows', { name: 'dedicated', kind: 'always' }).expect(201);
    const summary = (await ml1.get('/api/training/summary').expect(200)).body;
    expect(summary.worker).toMatchObject({ available: false, reason: NO_TRAINER });
    const d = await dataset(h, ml1, 'feedback', 'internal');
    const j = (await ml1.post('/api/training/jobs', jobBody('no-worker', d.id)).expect(201)).body;
    await ticks(h);
    expect((await ml1.get(`/api/training/jobs/${j.id}`).expect(200)).body).toMatchObject({ state: 'queued', waitReason: NO_TRAINER });
  });
});
