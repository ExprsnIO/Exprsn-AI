import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { LABELS, type Label } from '../authz/labels.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { PACKAGING, PRIORITIES, STAGES, type DatasetRow, type TrainingJobRow } from '../training/service.js';
import type { Services } from '../services.js';

const name63 = z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/, 'Lower-case letters, digits, dot, dash and underscore; up to 63');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');
const id26 = z.string().length(26);

const methodSchema = z
  .object({
    kind: z.enum(['lora', 'qlora', 'full']),
    rank: z.number().int().min(1).max(1024).nullable().default(16),
    alpha: z.number().int().min(1).max(4096).nullable().default(32),
    learningRate: z.number().positive().max(1).default(2e-4),
    epochs: z.number().int().min(1).max(100).default(3),
    seed: z.number().int().min(0).max(2 ** 31 - 1).default(1337),
    seqLen: z.number().int().min(128).max(131_072).default(8192),
    microBatch: z.number().int().min(1).max(1024).default(4)
  })
  .strict();

const submitSchema = z
  .object({
    name: name63,
    baseModel: z.string().trim().min(1).max(200),
    datasetId: id26,
    method: methodSchema,
    trainer: z.enum(['unsloth', 'axolotl', 'trl']).default('unsloth'),
    hardware: z.object({ accelerator: z.enum(['cuda', 'rocm', 'metal']).default('cuda'), gpus: z.number().int().min(1).max(64), memoryGb: z.number().int().min(1).max(1024).default(80) }).strict(),
    maxHours: z.number().positive().max(24 * 14).default(8),
    deadline: z.number().int().nullable().default(null),
    priority: z.enum(PRIORITIES).default('normal'),
    preemptible: z.boolean().default(true),
    packaging: z.enum(PACKAGING).default('GGUF Q4_K_M'),
    canary: z.number().int().min(0).max(50).default(10),
    checkpointEvery: z.number().int().min(10).max(100_000).default(250),
    steps: z.number().int().min(1).max(10_000_000).default(3500)
  })
  .strict();

/**
 * Training: datasets, jobs, windows, recurring schedules and evals (Sprint 9). Everything is tenant-scoped (the
 * tenant comes from the session) and filtered by the caller's clearance against each dataset's or job's label.
 * Reading and submitting need `training:submit`; approving, windows, schedules, withdrawals and thresholds need
 * `training:manage`. The GPU work runs on the training worker (`training/trainer.ts`).
 */
export function trainingRoutes(s: Services): Router {
  const r = Router();
  r.use('/training', noStore, requireAuth());
  const submit = requirePermission(s, 'training:submit');
  const manage = requirePermission(s, 'training:manage');
  const t = s.training;

  const audit = (req: Request, action: string, target: Record<string, unknown>, label?: Label, detail?: Record<string, unknown>) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, ...(label ? { label } : {}), ...(detail ? { detail } : {}), traceId: req.traceId });
  };

  const jobViews = async (req: Request, jobs: TrainingJobRow[]) => {
    const p = principalOf(req);
    const datasets = new Map(((await s.db('training_datasets').where({ tenant_id: p.tenantId })) as Record<string, unknown>[]).map((x) => [String(x.id), { ...(x as unknown as DatasetRow), version: Number(x.version), rows: Number(x.rows) }]));
    const names = await t.names(jobs.flatMap((j) => [j.created_by, j.approved_by]));
    const windows = await t.windows(p.tenantId);
    const ctx = await t.viewContext(p.tenantId);
    return Promise.all(jobs.map((j) => t.jobView(j, names, datasets, windows, ctx)));
  };
  const oneJob = async (req: Request, j: TrainingJobRow) => (await jobViews(req, [j]))[0]!;

  // ---------- overview ----------

  r.get('/training/summary', submit, async (req, res) => {
    const p = principalOf(req);
    const tr = s.trainer;
    let worker: Record<string, unknown> = { available: tr.available, reason: tr.reason, kind: tr.kind };
    if (tr.available) {
      try {
        worker = { ...worker, ...(await tr.info()) };
      } catch (err) {
        worker = { ...worker, reachable: false, reason: (err as Error).message };
      }
    }
    const tenant = await s.db('tenants').where({ id: p.tenantId }).first('name');
    res.json({ stages: STAGES, worker, quota: await t.quota(p.tenantId), tenant: tenant?.name ?? null, settings: await t.settings(p.tenantId), tickSeconds: s.cfg.TRAINING_TICK_SECONDS });
  });

  r.get('/training/settings', submit, async (req, res) => {
    res.json(await t.settings(principalOf(req).tenantId));
  });

  /** Per-tenant eval thresholds (ML admin); the conversation-data opt-in is a tenant admin's (checked inside). */
  r.put('/training/settings', manage, async (req, res) => {
    const body = parseBody(z.object({ thresholds: z.record(z.string(), z.number().min(0).max(1)).optional(), conversationOptIn: z.boolean().optional(), optInScope: z.string().trim().max(200).nullable().optional() }).strict(), req.body);
    const before = await t.settings(principalOf(req).tenantId);
    const after = await t.updateSettings(principalOf(req), body);
    await audit(req, 'training.settings.updated', { settings: 'training' }, undefined, { before: { thresholds: before.thresholds, conversationOptIn: before.conversationOptIn }, after: { thresholds: after.thresholds, conversationOptIn: after.conversationOptIn, optInScope: after.optInScope } });
    res.json(after);
  });

  // ---------- datasets ----------

  r.get('/training/datasets', submit, async (req, res) => {
    const p = principalOf(req);
    const list = await t.datasets(p);
    const used = await t.usedBy(p.tenantId);
    const names = await t.names(list.flatMap((d) => [d.created_by, d.withdrawn_by]));
    res.json(list.map((d) => t.datasetView(d, used, names)));
  });

  r.post('/training/datasets', submit, async (req, res) => {
    const body = parseBody(
      z
        .object({
          name: name63,
          version: z.number().int().min(1).max(100_000).optional(),
          label: z.enum(LABELS),
          source: z.string().trim().min(1).max(500),
          rows: z.array(z.record(z.string(), z.unknown())).min(1).max(20_000).optional(),
          stagingPath: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._\-/]{0,400}$/, 'A path in the staging area').optional(),
          conversationData: z.boolean().default(false),
          splits: z.object({ train: z.number().int().min(1).max(98), val: z.number().int().min(1).max(98), test: z.number().int().min(0).max(98) }).default({ train: 80, val: 10, test: 10 })
        })
        .strict(),
      req.body
    );
    const d = await t.registerDataset(principalOf(req), body);
    await audit(req, 'training.dataset.registered', { dataset: d.id, name: d.name, version: d.version }, d.label, { source: d.source, sourceKind: d.source_kind, conversationData: d.conversation_data, optIn: d.opt_in, splits: d.splits.pct });
    res.status(202).json(t.datasetView(d, new Map(), new Map()));
  });

  r.get('/training/datasets/:id', submit, async (req, res) => {
    const p = principalOf(req);
    const d = await t.dataset(p, String(req.params.id));
    res.json(t.datasetView(d, await t.usedBy(p.tenantId), await t.names([d.created_by, d.withdrawn_by])));
  });

  /** The scrub report: counts by kind and the rows and fields affected, never the values. Every read is audited. */
  r.get('/training/datasets/:id/report', submit, async (req, res) => {
    const { dataset, report } = await t.report(principalOf(req), String(req.params.id));
    await audit(req, 'training.dataset.report.read', { dataset: dataset.id, name: dataset.name, version: dataset.version }, dataset.label);
    res.setHeader('Content-Disposition', `attachment; filename="pii-report-${dataset.name}-v${dataset.version}.json"`);
    res.json(report);
  });

  r.post('/training/datasets/:id/withdraw', manage, async (req, res) => {
    const body = parseBody(z.object({ reason: z.string().trim().min(1).max(500) }).strict(), req.body);
    const { dataset, cancelled } = await t.withdraw(principalOf(req), String(req.params.id), body.reason);
    await audit(req, 'training.dataset.withdrawn', { dataset: dataset.id, name: dataset.name, version: dataset.version }, dataset.label, { reason: body.reason, cancelled });
    res.json({ dataset: t.datasetView(dataset, new Map(), new Map()), cancelled });
  });

  // ---------- jobs ----------

  r.get('/training/jobs', submit, async (req, res) => {
    res.json(await jobViews(req, await t.jobs(principalOf(req))));
  });

  r.get('/training/base-models', submit, async (req, res) => {
    res.json((await t.baseModels(principalOf(req))).map((m) => ({ id: m.id, name: m.name, state: m.state, label: m.label, capabilities: m.capabilities })));
  });

  r.post('/training/jobs', submit, async (req, res) => {
    const body = parseBody(submitSchema, req.body);
    const j = await t.submit(principalOf(req), body);
    await audit(req, 'training.job.submitted', { job: j.id, name: j.name }, j.label, { baseModel: j.base_model, dataset: j.dataset_id, method: j.method, hardware: j.hardware, priority: j.priority, packaging: j.packaging, approval: j.approval });
    res.status(201).json(await oneJob(req, j));
  });

  r.get('/training/jobs/:id', submit, async (req, res) => {
    res.json(await oneJob(req, await t.job(principalOf(req), String(req.params.id))));
  });

  r.get('/training/jobs/:id/card', submit, async (req, res) => {
    const j = await t.job(principalOf(req), String(req.params.id));
    res.json(t.cardView(j, await t.names([j.card.approval?.by])));
  });

  r.post('/training/jobs/:id/approve', manage, async (req, res) => {
    const j = await t.approve(principalOf(req), String(req.params.id));
    await audit(req, 'training.job.approved', { job: j.id, name: j.name }, j.label, { dataset: j.card.dataset, submitter: j.created_by });
    res.json(await oneJob(req, j));
  });

  r.post('/training/jobs/:id/pause', submit, async (req, res) => {
    const j = await t.pause(principalOf(req), String(req.params.id));
    await audit(req, 'training.job.paused', { job: j.id, name: j.name }, j.label, { checkpoint: j.checkpoint?.step ?? null });
    res.json(await oneJob(req, j));
  });

  r.post('/training/jobs/:id/resume', submit, async (req, res) => {
    const j = await t.resume(principalOf(req), String(req.params.id));
    await audit(req, 'training.job.resumed', { job: j.id, name: j.name }, j.label, { from: j.checkpoint?.step ?? 0, outsideWindow: true });
    res.json(await oneJob(req, j));
  });

  r.post('/training/jobs/:id/cancel', submit, async (req, res) => {
    const j = await t.cancel(principalOf(req), String(req.params.id));
    await audit(req, 'training.job.cancelled', { job: j.id, name: j.name }, j.label, { step: j.step });
    res.json(await oneJob(req, j));
  });

  r.post('/training/jobs/:id/retry', submit, async (req, res) => {
    const body = parseBody(z.object({ change: z.enum(['gpus4', 'half-batch', 'seq4096', 'none']).default('none') }).strict(), req.body);
    const j = await t.retry(principalOf(req), String(req.params.id), body.change);
    await audit(req, 'training.job.retried', { job: j.id, name: j.name }, j.label, { change: body.change, from: j.checkpoint?.step ?? 0 });
    res.json(await oneJob(req, j));
  });

  // ---------- evals ----------

  r.get('/training/evals', submit, async (req, res) => {
    res.json(await t.evals(principalOf(req)));
  });

  r.post('/training/evals', submit, async (req, res) => {
    const body = parseBody(z.object({ jobId: id26.optional(), model: z.string().trim().min(1).max(200).optional(), hardware: z.array(z.enum(['cuda', 'rocm', 'metal', 'cpu'])).min(1).max(4).optional(), suites: z.array(z.string().max(40)).min(1).max(10).optional() }).strict().refine((b) => !!b.jobId !== !!b.model, 'Give a job or a model'), req.body);
    const out = await t.queueEvals(principalOf(req), body);
    await audit(req, 'training.evals.queued', out.job ? { job: out.job.id, name: out.job.name } : { model: out.model }, out.job?.label, { hardware: body.hardware ?? null, suites: body.suites ?? null });
    res.status(202).json({ queued: true, model: out.model });
  });

  // ---------- windows ----------

  r.get('/training/windows', submit, async (req, res) => {
    const p = principalOf(req);
    const pools = await s.gateway.repo.pools();
    const names = new Map(pools.map((x) => [x.id, x.name]));
    res.json({ windows: (await t.windows(p.tenantId)).map((w) => t.windowView(w, names)), pools: pools.map((x) => ({ id: x.id, name: x.name, accelerator: x.accelerator })) });
  });

  r.post('/training/windows', manage, async (req, res) => {
    const body = parseBody(
      z
        .object({
          name: z.string().trim().min(1).max(63),
          poolId: id26.nullable().default(null),
          kind: z.enum(['always', 'daily', 'weekly']),
          startDay: z.number().int().min(0).max(6).nullable().default(null),
          startTime: hhmm.nullable().default(null),
          endDay: z.number().int().min(0).max(6).nullable().default(null),
          endTime: hhmm.nullable().default(null),
          reloadMinutes: z.number().int().min(0).max(240).default(20)
        })
        .strict(),
      req.body
    );
    const w = await t.addWindow(principalOf(req), body);
    await audit(req, 'training.window.created', { window: w.id, name: w.name, pool: w.pool_id }, undefined, { kind: w.kind, start: [w.start_day, w.start_time], end: [w.end_day, w.end_time], reloadMinutes: w.reload_minutes });
    const pools = new Map((await s.gateway.repo.pools()).map((x) => [x.id, x.name]));
    res.status(201).json(t.windowView(w, pools));
  });

  r.delete('/training/windows/:id', manage, async (req, res) => {
    const w = await t.removeWindow(principalOf(req), String(req.params.id));
    await audit(req, 'training.window.deleted', { window: w.id, name: w.name, pool: w.pool_id });
    res.status(204).end();
  });

  // ---------- recurring schedules ----------

  r.get('/training/schedules', submit, async (req, res) => {
    const p = principalOf(req);
    const jobs = new Map(((await s.db('training_jobs').where({ tenant_id: p.tenantId }).select('id', 'name')) as { id: string; name: string }[]).map((x) => [x.id, x.name]));
    const windows = new Map((await t.windows(p.tenantId)).map((w) => [w.id, w.name]));
    res.json((await t.schedules(p.tenantId)).map((sc) => t.scheduleView(sc, jobs, windows)));
  });

  r.post('/training/schedules', manage, async (req, res) => {
    const body = parseBody(z.object({ name: z.string().trim().min(1).max(100), templateJobId: id26, cron: z.string().trim().min(9).max(100), condition: z.enum(['dataset-changed', 'always']).default('dataset-changed'), windowId: id26.nullable().default(null), priority: z.enum(PRIORITIES).default('low') }).strict(), req.body);
    const sc = await t.addSchedule(principalOf(req), body);
    await audit(req, 'training.schedule.created', { schedule: sc.id, name: sc.name, template: sc.template_job_id }, undefined, { cron: sc.cron, condition: sc.condition, priority: sc.priority });
    res.status(201).json(t.scheduleView(sc, new Map(), new Map()));
  });

  r.patch('/training/schedules/:id', manage, async (req, res) => {
    const body = parseBody(z.object({ enabled: z.boolean() }).strict(), req.body);
    const sc = await t.setSchedule(principalOf(req), String(req.params.id), body.enabled);
    await audit(req, body.enabled ? 'training.schedule.enabled' : 'training.schedule.paused', { schedule: sc.id, name: sc.name });
    res.json(t.scheduleView(sc, new Map(), new Map()));
  });

  r.delete('/training/schedules/:id', manage, async (req, res) => {
    const sc = await t.removeSchedule(principalOf(req), String(req.params.id));
    await audit(req, 'training.schedule.deleted', { schedule: sc.id, name: sc.name });
    res.status(204).end();
  });

  return r;
}
