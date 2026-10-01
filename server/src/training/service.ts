import { ulid } from 'ulid';
import { TrainingWorkerGate } from './worker.js';
import type { Services } from '../services.js';
import type { Scheduler } from '../platform/jobs.js';
import { json } from '../db/knex.js';
import { clears, labelRank, type Label } from '../authz/labels.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { permissionsFor } from '../authz/permissions.js';
import { PLATFORM_TENANT } from '../audit/chain.js';
import { canonicalJson } from '../crypto/index.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound, tooManyRequests } from '../http/problem.js';
import { TOPICS } from '../platform/bus.js';
import { monthOf, nextMonth } from '../tenancy/quotas.js';
import type { ModelRow } from '../gateway/repo.js';
import { describeCron, describeWindow, nextCron, parseCron, reloadTime, windowAt } from './calendar.js';
import { parseRows, scrubRows, sha256, splitCounts, toJsonl, type ScrubReport } from './scrub.js';
import type { Checkpoint, RunStatus, TrainSpec } from './trainer.js';

type Tenants = () => Promise<{ tenantId: string; payload: Record<string, unknown> }[]>;

export const PRIORITIES = ['low', 'normal', 'high'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PACKAGING = ['GGUF Q4_K_M', 'GGUF Q5_K_M', 'GGUF Q8_0', 'LoRA adapter on pinned base'] as const;

/** Eval suites the worker runs, and the default pass thresholds a tenant can change. */
export const SUITES: Record<string, { name: string; threshold: number }> = {
  heldout: { name: 'Task metrics on the held-out split', threshold: 0.7 },
  regression: { name: 'Regression set against the base model', threshold: 0.95 },
  redteam: { name: 'Guardrail red-team suite', threshold: 0.98 },
  tools: { name: 'Tool-calling conformance', threshold: 1 }
};

export const STAGES = ['Dataset', 'Approval', 'Training', 'Evals', 'GGUF convert', 'Registry draft', 'Model admin approval', 'Canary', 'Approved pools'];
const ST = { dataset: 0, approval: 1, training: 2, evals: 3, convert: 4, draft: 5, modelApproval: 6, canary: 7, pools: 8 };

export interface DatasetRow {
  id: string;
  tenant_id: string;
  name: string;
  version: number;
  label: Label;
  source: string;
  source_kind: 'inline' | 'staging';
  staging_key: string | null;
  conversation_data: boolean;
  opt_in: { by: string; byName: string; at: number; scope: string | null } | null;
  state: 'scrubbing' | 'ready' | 'failed' | 'withdrawn';
  rows: number;
  hash: string | null;
  splits: { pct: { train: number; val: number; test: number }; rows: { train: number; val: number; test: number } | null };
  scrub: Omit<ScrubReport, 'findings'> | null;
  blob_key: string | null;
  report_key: string | null;
  error: string | null;
  withdrawn_reason: string | null;
  withdrawn_by: string | null;
  withdrawn_at: number | null;
  created_by: string;
  created_at: number;
}

export interface Method {
  kind: 'lora' | 'qlora' | 'full';
  rank: number | null;
  alpha: number | null;
  learningRate: number;
  epochs: number;
  seed: number;
  seqLen: number;
  microBatch: number;
}

export interface Hardware {
  accelerator: 'cuda' | 'rocm' | 'metal';
  gpus: number;
  memoryGb: number;
}

export interface EvalEntry {
  suite: string;
  name: string;
  hardware: string;
  base: number | null;
  score: number;
  threshold: number;
  passed: number | null;
  total: number | null;
  result: 'pass' | 'fail';
}

export interface ModelCard {
  baseModel: string;
  baseDigest: string | null;
  dataset: { id: string; name: string; version: number; hash: string | null; label: Label; rows: number };
  trainer: string;
  container: string | null;
  hyperparameters: string;
  method: Method;
  hardware: Hardware;
  approval: { by: string; byName: string; at: number } | null;
  evals: EvalEntry[];
  packaging: { requested: string; quantization: string | null; tool: string | null; artifact: string | null; digest: string | null; sizeBytes: number | null } | null;
  registration: { state: 'pending' | 'blocked' | 'registered' | 'failed'; reason: string | null; modelId: string | null; model: string | null };
  manifest: { signature: string; key: string; signedAt: number } | null;
}

export interface TrainingJobRow {
  id: string;
  tenant_id: string;
  name: string;
  base_model: string;
  base_model_id: string | null;
  base_digest: string | null;
  dataset_id: string;
  method: Method;
  trainer: 'unsloth' | 'axolotl' | 'trl';
  hardware: Hardware;
  max_hours: number;
  priority: Priority;
  preemptible: boolean;
  deadline: number | null;
  packaging: string;
  canary: number;
  checkpoint_every: number;
  label: Label;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'preempted';
  stage: number;
  stage_tone: 'danger' | null;
  approval: 'pending' | 'approved' | null;
  approved_by: string | null;
  approved_at: number | null;
  hold: boolean;
  run_now: boolean;
  wait_reason: string | null;
  window_id: string | null;
  run_id: string | null;
  step: number;
  steps: number;
  epoch: number;
  epochs: number;
  loss: number | null;
  series: [number, number][];
  gpu_ms: number;
  run_gpu_ms: number;
  checkpoint: (Checkpoint & { reason: string }) | null;
  container: string | null;
  note: string | null;
  error: string | null;
  card: ModelCard;
  model_id: string | null;
  schedule_id: string | null;
  created_by: string;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  updated_at: number;
}

export interface WindowRow {
  id: string;
  tenant_id: string;
  name: string;
  pool_id: string | null;
  kind: 'always' | 'daily' | 'weekly';
  start_day: number | null;
  start_time: string | null;
  end_day: number | null;
  end_time: string | null;
  reload_minutes: number;
  state: 'idle' | 'open';
  drained: string[];
  opened_at: number | null;
  created_by: string;
  created_at: number;
}

export interface ScheduleRow {
  id: string;
  tenant_id: string;
  name: string;
  template_job_id: string;
  cron: string;
  condition: 'dataset-changed' | 'always';
  window_id: string | null;
  priority: Priority;
  enabled: boolean;
  last_dataset_id: string | null;
  last_job_id: string | null;
  last_result: string | null;
  last_run_at: number | null;
  next_run_at: number | null;
  created_by: string;
  created_at: number;
}

const n0 = (v: unknown) => (v == null ? null : Number(v));
const bool = (v: unknown) => v === true || v === 1 || v === '1' || v === 't';

const datasetFrom = (r: Record<string, unknown>): DatasetRow => ({
  ...(r as unknown as DatasetRow),
  version: Number(r.version),
  rows: Number(r.rows ?? 0),
  conversation_data: bool(r.conversation_data),
  opt_in: json(r.opt_in, null),
  splits: json(r.splits, { pct: { train: 80, val: 10, test: 10 }, rows: null }),
  scrub: json(r.scrub, null),
  withdrawn_at: n0(r.withdrawn_at),
  created_at: Number(r.created_at)
});

const jobFrom = (r: Record<string, unknown>): TrainingJobRow => ({
  ...(r as unknown as TrainingJobRow),
  method: json(r.method, {} as Method),
  hardware: json(r.hardware, {} as Hardware),
  max_hours: Number(r.max_hours),
  preemptible: bool(r.preemptible),
  deadline: n0(r.deadline),
  canary: Number(r.canary ?? 0),
  checkpoint_every: Number(r.checkpoint_every ?? 250),
  stage: Number(r.stage ?? 0),
  approved_at: n0(r.approved_at),
  hold: bool(r.hold),
  run_now: bool(r.run_now),
  step: Number(r.step ?? 0),
  steps: Number(r.steps ?? 0),
  epoch: Number(r.epoch ?? 0),
  epochs: Number(r.epochs ?? 1),
  loss: r.loss == null ? null : Number(r.loss),
  series: json(r.series, []),
  gpu_ms: Number(r.gpu_ms ?? 0),
  run_gpu_ms: Number(r.run_gpu_ms ?? 0),
  checkpoint: json(r.checkpoint, null),
  card: json(r.card, {} as ModelCard),
  created_at: Number(r.created_at),
  started_at: n0(r.started_at),
  finished_at: n0(r.finished_at),
  updated_at: Number(r.updated_at)
});

const windowFrom = (r: Record<string, unknown>): WindowRow => ({
  ...(r as unknown as WindowRow),
  start_day: n0(r.start_day),
  end_day: n0(r.end_day),
  reload_minutes: Number(r.reload_minutes ?? 20),
  drained: json(r.drained, []),
  opened_at: n0(r.opened_at),
  created_at: Number(r.created_at)
});

const scheduleFrom = (r: Record<string, unknown>): ScheduleRow => ({
  ...(r as unknown as ScheduleRow),
  enabled: bool(r.enabled),
  last_run_at: n0(r.last_run_at),
  next_run_at: n0(r.next_run_at),
  created_at: Number(r.created_at)
});

const JSON_COLS = ['method', 'hardware', 'series', 'checkpoint', 'card', 'splits', 'scrub', 'opt_in', 'drained'];
const serialise = (patch: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, JSON_COLS.includes(k) && v != null ? JSON.stringify(v) : v]));

export const methodText = (m: Method): string =>
  m.kind === 'full' ? 'Full fine-tune' : m.kind === 'qlora' ? `QLoRA 4-bit, r=${m.rank}` : `LoRA r=${m.rank}, alpha ${m.alpha}`;
export const hardwareText = (h: Hardware): string => `${h.accelerator}, ${h.gpus} GPU${h.gpus === 1 ? '' : 's'}${h.gpus > 1 ? `, ${h.memoryGb} GB each` : `, ${h.memoryGb} GB`}`;
export const hyperText = (m: Method): string =>
  `${methodText(m)}, lr ${m.learningRate}, ${m.epochs} epoch${m.epochs === 1 ? '' : 's'}, seed ${m.seed}, sequence length ${m.seqLen}, micro-batch ${m.microBatch}`;
const fmtScore = (e: { score: number; passed: number | null; total: number | null }) => (e.total ? `${e.passed} of ${e.total}` : e.score.toFixed(3));
const fmtThreshold = (e: { threshold: number; total: number | null }) => (e.total ? `${Math.ceil(e.threshold * e.total)} of ${e.total}` : e.threshold.toFixed(3));
const prioRank = (p: Priority) => PRIORITIES.indexOf(p);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
const stamp = (t: number) => new Date(t).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
const APPROVAL_LABELS: readonly Label[] = ['confidential', 'restricted'];
const MAX_POINTS = 2000;

export interface SubmitInput {
  name: string;
  baseModel: string;
  datasetId: string;
  method: Method;
  trainer: TrainingJobRow['trainer'];
  hardware: Hardware;
  maxHours: number;
  deadline: number | null;
  priority: Priority;
  preemptible: boolean;
  packaging: string;
  canary: number;
  checkpointEvery: number;
  steps: number;
}

/**
 * Sprint 9: datasets, training jobs, windows, evals and packaging. Reads its collaborators through `s` so later
 * replacements (tests, overrides) are used.
 *
 * The pipeline: Dataset (scrubbed, sealed, hashed) → Approval (an ML admin other than the submitter, when the data
 * is confidential or restricted) → Training (on the worker, inside a window, metered against the tenant's training
 * GPU-hours) → Evals (per hardware class, per-tenant thresholds; a failure stops here and is recorded on the card) →
 * GGUF convert → Registry draft (a draft model in the gateway catalogue) → the model admins' existing lifecycle.
 * The orchestrator's state lives in the database; `tick` (a scheduled job) syncs runs, opens and closes windows,
 * fires recurring schedules and dispatches the queue, so any instance can pick up where another left off.
 */
export class TrainingService {
  /** Sprint 18 (B-905): run keys and artefacts for workers on contract 2. */
  readonly worker: TrainingWorkerGate;

  constructor(private readonly s: () => Services) {
    this.worker = new TrainingWorkerGate(s);
  }

  private get db() {
    return this.s().db;
  }

  /** Registers this area's job handlers on `s.jobs`. */
  registerJobs(): void {
    const s = this.s();
    s.jobs.register('training.tick', () => this.tick(), { timeoutMs: 15 * 60_000 });
    s.jobs.register('training.dataset', (p) => this.scrubJob(String(p.id)), { timeoutMs: 60 * 60_000 });
    s.jobs.register('training.evaluate', (p) => this.evaluateJob(p), { timeoutMs: 6 * 3_600_000 });
    s.jobs.register('training.package', (p) => this.packageJob(String(p.id)), { timeoutMs: 6 * 3_600_000 });
  }

  /** Adds this area's recurring schedules: one orchestrator tick across all tenants (fair share is global). */
  schedule(scheduler: Scheduler, _activeTenants: Tenants): void {
    scheduler.every('training.tick', this.s().cfg.TRAINING_TICK_SECONDS * 1000, async () => [{ tenantId: PLATFORM_TENANT, key: 'all' }]);
  }

  /** Asks for a tick soon (after a submit, approval or resume) instead of waiting for the schedule. */
  async kick(): Promise<void> {
    // One waiting kick is enough; ticks are idempotent, so a race here only costs an extra pass.
    if (await this.db('jobs').where({ type: 'training.tick', state: 'queued' }).first('id')) return;
    await this.s().jobs.enqueue({ tenantId: PLATFORM_TENANT, type: 'training.tick', maxAttempts: 1 });
  }

  // ---------- helpers ----------

  private isManager(p: Principal): boolean {
    return effectivePermissions(p).has('training:manage');
  }

  async names(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
    const uniq = [...new Set(ids.filter((x): x is string => !!x))];
    if (!uniq.length) return new Map();
    const rows = (await this.db('users').whereIn('id', uniq).select('id', 'display_name', 'username')) as { id: string; display_name: string | null; username: string }[];
    return new Map(rows.map((u) => [u.id, u.display_name || u.username]));
  }

  private emit(j: TrainingJobRow, extra: Record<string, unknown> = {}): void {
    const data = { id: j.id, name: j.name, state: j.state, stage: j.stage, stageTone: j.stage_tone, step: j.step, steps: j.steps, epoch: j.epoch, loss: j.loss, gpuHours: Math.round((j.gpu_ms / 3_600_000) * 10) / 10, checkpoint: j.checkpoint, note: j.note, error: j.error, waitReason: j.wait_reason, awaiting: j.approval === 'pending', holding: j.hold, ...extra };
    const bus = this.s().bus;
    // The owner's sockets, and the tenant's ML admins (who may approve, pause or cancel any job).
    bus.publish(TOPICS.runEvent, { userId: j.created_by, event: 'train.progress', data });
    bus.publish(TOPICS.runEvent, { tenantId: j.tenant_id, perm: 'training:manage', event: 'train.progress', data });
  }

  private async update(j: TrainingJobRow, patch: Partial<TrainingJobRow>, emit = true, extra: Record<string, unknown> = {}): Promise<TrainingJobRow> {
    const t = Date.now();
    await this.db('training_jobs').where({ id: j.id }).update(serialise({ ...patch, updated_at: t }));
    Object.assign(j, patch, { updated_at: t });
    if (emit) this.emit(j, extra);
    return j;
  }

  private async audit(tenantId: string, action: string, target: Record<string, unknown>, label: Label, detail?: Record<string, unknown>): Promise<void> {
    await this.s().audit.append({ tenantId, action, kind: 'system', actor: { service: 'training' }, target, label, ...(detail ? { detail } : {}) });
  }

  private async notify(tenantId: string, userIds: string[], title: string, body: string, label: Label): Promise<void> {
    await this.s().notifications.notify({ tenantId, userIds, kind: 'training', title, body: body.slice(0, 1000), route: 'training', label }).catch((err: Error) => this.s().log.warn({ err: err.message }, 'training notification failed'));
  }

  private async putSealed(tenantId: string, key: string, data: Buffer): Promise<void> {
    const s = this.s();
    await s.blobs.put(key, Buffer.from(await s.keys.sealBytes(tenantId, data, `training:${key}`)));
  }

  private async getSealed(tenantId: string, key: string): Promise<Buffer> {
    const s = this.s();
    const sealed = await s.blobs.get(key);
    if (!sealed) throw notFound('Dataset content');
    return s.keys.openBytes(tenantId, sealed.toString(), `training:${key}`);
  }

  // ---------- settings ----------

  async settings(tenantId: string) {
    const r = await this.db('training_settings').where({ tenant_id: tenantId }).first();
    const custom = json<Record<string, number>>(r?.thresholds, {});
    const thresholds = Object.fromEntries(Object.entries(SUITES).map(([k, v]) => [k, custom[k] ?? v.threshold]));
    return {
      thresholds,
      suites: Object.entries(SUITES).map(([id, v]) => ({ id, name: v.name, defaultThreshold: v.threshold, threshold: thresholds[id]! })),
      conversationOptIn: bool(r?.conversation_opt_in),
      optInScope: (r?.opt_in_scope as string | null) ?? null,
      optInBy: (r?.opt_in_by as string | null) ?? null,
      optInAt: n0(r?.opt_in_at)
    };
  }

  async updateSettings(p: Principal, patch: { thresholds?: Record<string, number>; conversationOptIn?: boolean; optInScope?: string | null }) {
    const cur = await this.settings(p.tenantId);
    const row: Record<string, unknown> = { updated_by: p.userId, updated_at: Date.now() };
    if (patch.thresholds) {
      for (const k of Object.keys(patch.thresholds)) if (!SUITES[k]) throw badRequest(`Unknown eval suite ${k}.`);
      row.thresholds = JSON.stringify({ ...cur.thresholds, ...patch.thresholds });
    }
    if (patch.conversationOptIn !== undefined || patch.optInScope !== undefined) {
      // The tenant's decision to let conversation data into training belongs to a tenant admin.
      if (!effectivePermissions(p).has('tenant:manage')) throw forbidden('Only a tenant admin records the tenant opt-in for conversation data.', { step: 'role' });
      const on = patch.conversationOptIn ?? cur.conversationOptIn;
      row.conversation_opt_in = on;
      row.opt_in_scope = on ? (patch.optInScope ?? cur.optInScope) : null;
      row.opt_in_by = on ? p.userId : null;
      row.opt_in_at = on ? Date.now() : null;
    }
    const exists = await this.db('training_settings').where({ tenant_id: p.tenantId }).first();
    if (exists) await this.db('training_settings').where({ tenant_id: p.tenantId }).update(row);
    else await this.db('training_settings').insert({ tenant_id: p.tenantId, ...row });
    return this.settings(p.tenantId);
  }

  // ---------- quota ----------

  /** Training GPU-hours this month against the tenant's limit (tenant scope: training is a tenant resource). */
  async quota(tenantId: string): Promise<{ usedHours: number; limitHours: number | null; resets: number }> {
    const s = this.s();
    const now = Date.now();
    const l = await s.quotas.limits(tenantId, null);
    const r = (await this.db('usage_records').where({ tenant_id: tenantId, month: monthOf(now), kind: 'training' }).sum({ g: 'gpu_ms' })) as Record<string, unknown>[];
    return { usedHours: Math.round((Number(r[0]?.g ?? 0) / 3_600_000) * 10) / 10, limitHours: l.trainingGpuHoursPerMonth, resets: nextMonth(now) };
  }

  /** Throws 429 when the tenant has used its training GPU-hours for the month. */
  async admit(tenantId: string): Promise<void> {
    const q = await this.quota(tenantId);
    if (q.limitHours == null || q.usedHours < q.limitHours) return;
    const now = Date.now();
    const tenant = await this.db('tenants').where({ id: tenantId }).first('name');
    const p = tooManyRequests(`${tenant?.name ?? 'This tenant'} used ${q.usedHours} of ${q.limitHours} training GPU-hours this month. Jobs are not admitted until the monthly reset; a system admin can raise the limit.`, (q.resets - now) / 1000);
    Object.assign(p.extensions, { limit: 'training_gpu_hours_per_month', scope: 'tenant', used: q.usedHours, max: q.limitHours, resets_at: new Date(q.resets).toISOString(), raised_by: 'a system admin' });
    throw p;
  }

  // ---------- datasets ----------

  async dataset(p: Principal, id: string): Promise<DatasetRow> {
    const r = await this.db('training_datasets').where({ tenant_id: p.tenantId, id }).first();
    if (!r) throw notFound('Dataset');
    const d = datasetFrom(r);
    if (!clears(p.clearance, d.label)) throw notFound('Dataset');
    return d;
  }

  async datasets(p: Principal): Promise<DatasetRow[]> {
    return ((await this.db('training_datasets').where({ tenant_id: p.tenantId }).orderBy([{ column: 'name' }, { column: 'version', order: 'desc' }])) as Record<string, unknown>[]).map(datasetFrom).filter((d) => clears(p.clearance, d.label));
  }

  /** Job names that used each dataset version, for the "Used by" column. */
  async usedBy(tenantId: string): Promise<Map<string, string[]>> {
    const rows = (await this.db('training_jobs').where({ tenant_id: tenantId }).select('dataset_id', 'name', 'state')) as { dataset_id: string; name: string; state: string }[];
    const m = new Map<string, string[]>();
    for (const r of rows) m.set(r.dataset_id, [...(m.get(r.dataset_id) ?? []), r.state === 'cancelled' ? `${r.name} (cancelled)` : r.name]);
    return m;
  }

  /**
   * Registers a dataset version. Rows come inline or from a staging object in the blob store (where a pipeline
   * drops JSON Lines); the PII scrub runs as a job, then the scrubbed rows and the report are sealed with the tenant
   * key and the unscrubbed input is deleted. Conversation data needs the tenant's opt-in.
   */
  async registerDataset(p: Principal, input: { name: string; version?: number; label: Label; source: string; rows?: Record<string, unknown>[]; stagingPath?: string; conversationData: boolean; splits: { train: number; val: number; test: number } }): Promise<DatasetRow> {
    const s = this.s();
    if (!clears(p.clearance, input.label)) throw forbidden('You cannot register data above your clearance.', { step: 'clearance' });
    if (!!input.rows === !!input.stagingPath) throw badRequest('Give either rows or a staging path, not both.');
    if (input.splits.train + input.splits.val + input.splits.test !== 100) throw badRequest('The splits must add up to 100.');
    let optIn: DatasetRow['opt_in'] = null;
    if (input.conversationData) {
      const st = await this.settings(p.tenantId);
      if (!st.conversationOptIn) throw conflict('Conversation data enters training only with the tenant\'s opt-in. A tenant admin records it under Training settings.');
      optIn = { by: st.optInBy ?? p.userId, byName: (await this.names([st.optInBy])).get(st.optInBy ?? '') ?? '', at: st.optInAt ?? Date.now(), scope: st.optInScope };
    }
    const latest = (await this.db('training_datasets').where({ tenant_id: p.tenantId, name: input.name }).max({ v: 'version' }))[0] as { v: unknown } | undefined;
    const last = Number(latest?.v ?? 0);
    const version = input.version ?? last + 1;
    if (version <= last) throw conflict(`${input.name} already has v${last}; a new version must be above it.`);
    const id = ulid();
    let stagingKey: string | null = null;
    if (input.stagingPath) {
      if (input.stagingPath.includes('..')) throw badRequest('The staging path may not contain "..".');
      stagingKey = `training/staging/${p.tenantId}/${input.stagingPath.replace(/^\/+/, '')}`;
      if (!(await s.blobs.get(stagingKey))) throw badRequest(`Nothing is staged at ${input.stagingPath}. Pipelines write JSON Lines to training/staging/<tenant>/ in the blob store.`);
    } else {
      await this.putSealed(p.tenantId, `training/${p.tenantId}/datasets/${id}/raw.jsonl`, Buffer.from(toJsonl(input.rows!), 'utf8'));
    }
    const row: DatasetRow = { id, tenant_id: p.tenantId, name: input.name, version, label: input.label, source: input.source, source_kind: stagingKey ? 'staging' : 'inline', staging_key: stagingKey, conversation_data: input.conversationData, opt_in: optIn, state: 'scrubbing', rows: 0, hash: null, splits: { pct: input.splits, rows: null }, scrub: null, blob_key: null, report_key: null, error: null, withdrawn_reason: null, withdrawn_by: null, withdrawn_at: null, created_by: p.userId, created_at: Date.now() };
    await this.db('training_datasets').insert(serialise({ ...row }));
    await s.jobs.enqueue({ tenantId: p.tenantId, type: 'training.dataset', payload: { id }, createdBy: p.userId, maxAttempts: 2 });
    return row;
  }

  private async scrubJob(id: string): Promise<unknown> {
    const r = await this.db('training_datasets').where({ id }).first();
    if (!r) return { skipped: 'missing' };
    const d = datasetFrom(r);
    if (d.state !== 'scrubbing') return { state: d.state };
    const s = this.s();
    const rawKey = `training/${d.tenant_id}/datasets/${d.id}/raw.jsonl`;
    const fail = async (message: string) => {
      await this.db('training_datasets').where({ id }).update({ state: 'failed', error: message.slice(0, 1000) });
      s.bus.publish(TOPICS.runEvent, { userId: d.created_by, event: 'train.dataset', data: { id, state: 'failed', error: message } });
      return { state: 'failed', error: message };
    };
    let text: string;
    if (d.staging_key) {
      const b = await s.blobs.get(d.staging_key);
      if (!b) return fail('The staging object is gone.');
      text = b.toString('utf8');
    } else {
      text = (await this.getSealed(d.tenant_id, rawKey)).toString('utf8');
    }
    let rows;
    try {
      rows = parseRows(text);
    } catch (err) {
      return fail((err as Error).message);
    }
    const { rows: clean, report } = scrubRows(rows);
    const data = Buffer.from(toJsonl(clean), 'utf8');
    const base = `training/${d.tenant_id}/datasets/${d.id}`;
    await this.putSealed(d.tenant_id, `${base}/data.jsonl`, data);
    await this.putSealed(d.tenant_id, `${base}/pii-report.json`, Buffer.from(JSON.stringify({ dataset: d.name, version: d.version, ...report }, null, 2), 'utf8'));
    // The unscrubbed input does not stay behind.
    if (d.staging_key) await s.blobs.delete(d.staging_key).catch(() => undefined);
    else await s.blobs.delete(rawKey).catch(() => undefined);
    const summary = { masked: report.masked, rowsAffected: report.rowsAffected, byKind: report.byKind, detectors: report.detectors };
    const patch = { state: 'ready', rows: clean.length, hash: sha256(data), splits: { pct: d.splits.pct, rows: splitCounts(clean.length, d.splits.pct) }, scrub: summary, blob_key: `${base}/data.jsonl`, report_key: `${base}/pii-report.json`, error: null };
    await this.db('training_datasets').where({ id }).update(serialise(patch));
    await this.audit(d.tenant_id, 'training.dataset.scrubbed', { dataset: d.id, name: d.name, version: d.version }, d.label, { rows: clean.length, hash: patch.hash, masked: report.masked, byKind: report.byKind });
    s.bus.publish(TOPICS.runEvent, { userId: d.created_by, event: 'train.dataset', data: { id, state: 'ready' } });
    return { rows: clean.length, masked: report.masked };
  }

  async report(p: Principal, id: string): Promise<{ dataset: DatasetRow; report: unknown }> {
    const d = await this.dataset(p, id);
    if (!d.report_key) throw conflict(d.state === 'scrubbing' ? 'The PII scrub is still running.' : 'This version has no scrub report.');
    return { dataset: d, report: JSON.parse((await this.getSealed(d.tenant_id, d.report_key)).toString('utf8')) };
  }

  /** Withdraws a version: its rows are deleted, and jobs that have not finished training on it are cancelled. */
  async withdraw(p: Principal, id: string, reason: string): Promise<{ dataset: DatasetRow; cancelled: string[] }> {
    const d = await this.dataset(p, id);
    if (d.state === 'withdrawn') throw conflict('The version is already withdrawn.');
    if (d.blob_key) await this.s().blobs.delete(d.blob_key).catch(() => undefined);
    await this.db('training_datasets').where({ id }).update({ state: 'withdrawn', withdrawn_reason: reason, withdrawn_by: p.userId, withdrawn_at: Date.now(), blob_key: null });
    const cancelled: string[] = [];
    const jobs = ((await this.db('training_jobs').where({ tenant_id: p.tenantId, dataset_id: id }).whereIn('state', ['queued', 'running', 'preempted'])) as Record<string, unknown>[]).map(jobFrom);
    for (const j of jobs) {
      await this.stopRun(j, 'cancel');
      await this.update(j, { state: 'cancelled', finished_at: Date.now(), note: `Cancelled at step ${j.step.toLocaleString('en-GB')}: the dataset was withdrawn (${reason}).` });
      cancelled.push(j.name);
    }
    return { dataset: { ...d, state: 'withdrawn', withdrawn_reason: reason, withdrawn_by: p.userId, blob_key: null }, cancelled };
  }

  // ---------- jobs ----------

  async job(p: Principal, id: string): Promise<TrainingJobRow> {
    const r = await this.db('training_jobs').where({ tenant_id: p.tenantId, id }).first();
    if (!r) throw notFound('Training job');
    const j = jobFrom(r);
    if (!clears(p.clearance, j.label)) throw notFound('Training job');
    return j;
  }

  async jobs(p: Principal): Promise<TrainingJobRow[]> {
    return ((await this.db('training_jobs').where({ tenant_id: p.tenantId }).orderBy('created_at', 'desc').limit(500)) as Record<string, unknown>[]).map(jobFrom).filter((j) => clears(p.clearance, j.label));
  }

  /** Models a job can start from: approved or evaluated, pulled, and cleared for the caller. */
  async baseModels(p: Principal): Promise<ModelRow[]> {
    return (await this.s().gateway.repo.models()).filter((m) => (m.state === 'approved' || m.state === 'evaluated') && clears(p.clearance, m.label));
  }

  async submit(p: Principal, input: SubmitInput, opts: { scheduleId?: string; createdBy?: string } = {}): Promise<TrainingJobRow> {
    const s = this.s();
    const d = await this.dataset(p, input.datasetId);
    if (d.state !== 'ready') throw conflict(d.state === 'withdrawn' ? `${d.name} v${d.version} was withdrawn${d.withdrawn_reason ? `: ${d.withdrawn_reason}` : ''}.` : d.state === 'scrubbing' ? 'The PII scrub is still running; the version is usable once its report is attached.' : `${d.name} v${d.version} failed its scrub.`);
    const base = await s.gateway.repo.modelByName(input.baseModel);
    if (!base || !(base.state === 'approved' || base.state === 'evaluated')) throw conflict(`${input.baseModel} is not an approved or evaluated model in the catalogue.`);
    if (!clears(p.clearance, base.label)) throw notFound('Model');
    if (d.conversation_data && labelRank(d.label) > labelRank(base.label)) throw conflict(`${d.name} v${d.version} holds conversation data labelled ${d.label}; it may only train a model approved for ${d.label} data or above, and ${base.name} is approved for ${base.label}.`);
    if (await this.db('training_jobs').where({ tenant_id: p.tenantId, name: input.name }).first('id')) throw conflict(`A job named ${input.name} already exists.`);
    await this.admit(p.tenantId);
    const needsApproval = APPROVAL_LABELS.includes(d.label);
    const t = Date.now();
    const card: ModelCard = {
      baseModel: base.name,
      baseDigest: base.digest,
      dataset: { id: d.id, name: d.name, version: d.version, hash: d.hash, label: d.label, rows: d.rows },
      trainer: input.trainer,
      container: null,
      hyperparameters: hyperText(input.method),
      method: input.method,
      hardware: input.hardware,
      approval: null,
      evals: [],
      packaging: { requested: input.packaging, quantization: null, tool: null, artifact: null, digest: null, sizeBytes: null },
      registration: { state: 'pending', reason: null, modelId: null, model: null },
      manifest: null
    };
    const row: TrainingJobRow = {
      id: ulid(), tenant_id: p.tenantId, name: input.name, base_model: base.name, base_model_id: base.id, base_digest: base.digest, dataset_id: d.id,
      method: input.method, trainer: input.trainer, hardware: input.hardware, max_hours: input.maxHours, priority: input.priority, preemptible: input.preemptible,
      deadline: input.deadline, packaging: input.packaging, canary: input.canary, checkpoint_every: input.checkpointEvery, label: d.label,
      state: 'queued', stage: needsApproval ? ST.approval : ST.training, stage_tone: null, approval: needsApproval ? 'pending' : null, approved_by: null, approved_at: null,
      hold: false, run_now: false, wait_reason: needsApproval ? 'waits for approval' : null, window_id: null, run_id: null,
      step: 0, steps: input.steps, epoch: 0, epochs: input.method.epochs, loss: null, series: [], gpu_ms: 0, run_gpu_ms: 0, checkpoint: null, container: null,
      note: null, error: null, card, model_id: null, schedule_id: opts.scheduleId ?? null, created_by: opts.createdBy ?? p.userId, created_at: t, started_at: null, finished_at: null, updated_at: t
    };
    await this.db('training_jobs').insert(serialise({ ...row }));
    if (needsApproval) {
      const admins = (await s.notifications.usersWithRoles(p.tenantId, ['ml-admin'])).filter((u) => u !== row.created_by);
      await this.notify(p.tenantId, admins, 'Training job waits for approval', `${row.name} trains on ${d.name} v${d.version}, labelled ${d.label}. An ML admin other than the submitter approves it before training starts.`, d.label);
    } else {
      await this.kick();
    }
    return row;
  }

  /** Approval for confidential or restricted data: an ML admin other than the submitter, cleared for the label. */
  async approve(p: Principal, id: string): Promise<TrainingJobRow> {
    const j = await this.job(p, id);
    if (j.approval !== 'pending') throw conflict(j.approval === 'approved' ? 'The job is already approved.' : 'This job does not need an approval.');
    if (j.created_by === p.userId) throw forbidden('Dual control: an ML admin other than the submitter approves training on confidential data.', { step: 'dual-control' });
    if (!clears(p.clearance, j.label)) throw forbidden('You cannot approve training on data above your clearance.', { step: 'clearance' });
    const at = Date.now();
    const card = { ...j.card, approval: { by: p.userId, byName: p.displayName, at } };
    await this.update(j, { approval: 'approved', approved_by: p.userId, approved_at: at, stage: ST.training, card, wait_reason: null, note: `Approved by ${p.displayName}. Queued for the next window.` });
    await this.notify(j.tenant_id, [j.created_by], 'Training job approved', `${j.name} was approved by ${p.displayName} and is queued.`, j.label);
    await this.kick();
    return j;
  }

  private mayControl(p: Principal, j: TrainingJobRow): void {
    if (j.created_by !== p.userId && !this.isManager(p)) throw forbidden('Only the submitter or an ML admin can change this job.', { step: 'role' });
  }

  /** Checkpoints and stops the job's run on the worker (or cancels it); a failure to reach the worker is reported. */
  private async stopRun(j: TrainingJobRow, how: 'cancel' | 'pause' | 'preempt' | 'window' | 'quota' | 'duration'): Promise<Checkpoint | null> {
    if (j.state !== 'running' || !j.run_id) return null;
    const t = this.s().trainer;
    if (how === 'cancel') {
      await t.cancel(j.run_id);
      await this.syncOne(j, false).catch(() => undefined);
      return null;
    }
    const c = await t.checkpoint(j.run_id, how);
    await this.syncOne(j, false).catch(() => undefined);
    return c;
  }

  /** Pause: the worker checkpoints at the current step and releases the GPUs; the job waits until it is run again. */
  async pause(p: Principal, id: string): Promise<TrainingJobRow> {
    const j = await this.job(p, id);
    this.mayControl(p, j);
    if (j.state !== 'running') throw conflict(`${j.name} is ${j.state}; only a running job can be paused.`);
    const c = (await this.stopRun(j, 'pause'))!;
    return this.update(j, { state: 'queued', hold: true, run_now: false, run_id: null, window_id: null, checkpoint: { ...c, reason: 'pause' }, step: c.step, wait_reason: 'paused; run it again to resume', note: `Paused by ${p.displayName} at step ${c.step.toLocaleString('en-GB')}. Resumes from the checkpoint.` });
  }

  /** Run now / Resume now: may start outside a window, from the last checkpoint. */
  async resume(p: Principal, id: string): Promise<TrainingJobRow> {
    const j = await this.job(p, id);
    this.mayControl(p, j);
    if (j.state !== 'queued' && j.state !== 'preempted') throw conflict(`${j.name} is ${j.state}.`);
    if (j.approval === 'pending') throw conflict('The job waits for an ML admin approval before it can run.');
    await this.admit(j.tenant_id);
    await this.update(j, { hold: false, run_now: true, wait_reason: 'starting', note: null });
    await this.kick();
    return j;
  }

  async cancel(p: Principal, id: string): Promise<TrainingJobRow> {
    const j = await this.job(p, id);
    this.mayControl(p, j);
    if (!['queued', 'running', 'preempted'].includes(j.state)) throw conflict(`${j.name} is ${j.state}.`);
    await this.stopRun(j, 'cancel');
    return this.update(j, { state: 'cancelled', run_id: null, window_id: null, finished_at: Date.now(), wait_reason: null, note: `Cancelled by ${p.displayName} at step ${j.step.toLocaleString('en-GB')}.` });
  }

  /** Requeues a failed or cancelled job with the same dataset version, seed and container, from its checkpoint. */
  async retry(p: Principal, id: string, change: 'gpus4' | 'half-batch' | 'seq4096' | 'none'): Promise<TrainingJobRow> {
    const j = await this.job(p, id);
    this.mayControl(p, j);
    if (j.state !== 'failed' && j.state !== 'cancelled') throw conflict(`${j.name} is ${j.state}; only failed or cancelled jobs are retried.`);
    const d = await this.dataset(p, j.dataset_id);
    if (d.state !== 'ready') throw conflict(`${d.name} v${d.version} is ${d.state}; the job cannot be retried on it.`);
    await this.admit(j.tenant_id);
    const hardware = { ...j.hardware };
    const method = { ...j.method };
    let changed = '';
    if (change === 'gpus4') {
      hardware.gpus = 4;
      changed = ' with 4 GPUs requested';
    } else if (change === 'half-batch') {
      method.microBatch = Math.max(1, Math.floor(method.microBatch / 2));
      changed = ` with micro-batch ${method.microBatch}`;
    } else if (change === 'seq4096') {
      method.seqLen = 4096;
      changed = ' with sequence length 4,096';
    }
    const from = j.checkpoint ? `the checkpoint at step ${j.checkpoint.step.toLocaleString('en-GB')}` : 'the start (no checkpoint was written)';
    const card = { ...j.card, method, hardware, hyperparameters: hyperText(method) };
    return this.update(j, { state: 'queued', error: null, hardware, method, card, run_id: null, hold: false, run_now: false, finished_at: null, stage: ST.training, stage_tone: null, step: j.checkpoint?.step ?? 0, wait_reason: null, note: `Requeued from ${from}${changed}.` }).then(async (r) => {
      await this.kick();
      return r;
    });
  }

  // ---------- windows ----------

  async windows(tenantId: string): Promise<WindowRow[]> {
    return ((await this.db('training_windows').where({ tenant_id: tenantId }).orderBy('created_at')) as Record<string, unknown>[]).map(windowFrom);
  }

  async addWindow(p: Principal, input: { name: string; poolId: string | null; kind: WindowRow['kind']; startDay: number | null; startTime: string | null; endDay: number | null; endTime: string | null; reloadMinutes: number }): Promise<WindowRow> {
    const s = this.s();
    if (input.poolId) {
      // Lending an inference pool drains it for every tenant: that is a pool administrator's decision.
      if (!effectivePermissions(p).has('pools:manage')) throw forbidden('Lending an inference pool to training drains it for every tenant; it needs pools:manage (a model admin).', { step: 'role' });
      if (!(await s.gateway.repo.pool(input.poolId))) throw notFound('Pool');
    }
    if (input.kind !== 'always' && (!input.startTime || !input.endTime)) throw badRequest('A daily or weekly window needs a start and an end time.');
    if (input.kind === 'weekly' && (input.startDay == null || input.endDay == null)) throw badRequest('A weekly window needs a start and an end day.');
    if (await this.db('training_windows').where({ tenant_id: p.tenantId, name: input.name }).first('id')) throw conflict(`A window named ${input.name} already exists.`);
    const row: WindowRow = { id: ulid(), tenant_id: p.tenantId, name: input.name, pool_id: input.poolId, kind: input.kind, start_day: input.kind === 'weekly' ? input.startDay : null, start_time: input.kind === 'always' ? null : input.startTime, end_day: input.kind === 'weekly' ? input.endDay : null, end_time: input.kind === 'always' ? null : input.endTime, reload_minutes: input.reloadMinutes, state: 'idle', drained: [], opened_at: null, created_by: p.userId, created_at: Date.now() };
    await this.db('training_windows').insert(serialise({ ...row }));
    await this.kick();
    return row;
  }

  async removeWindow(p: Principal, id: string): Promise<WindowRow> {
    const w = (await this.windows(p.tenantId)).find((x) => x.id === id);
    if (!w) throw notFound('Window');
    if (w.pool_id && !effectivePermissions(p).has('pools:manage')) throw forbidden('Removing a window that lends an inference pool needs pools:manage.', { step: 'role' });
    if (w.state === 'open') await this.closeWindow(w, 'removed');
    await this.db('training_windows').where({ id }).delete();
    return w;
  }

  /** Opening a window that lends a pool drains each instance (existing gateway operation) so training can use it. */
  private async openWindow(w: WindowRow): Promise<void> {
    const s = this.s();
    // Claim the transition first, so overlapping ticks do not both act on it.
    if (!(await this.db('training_windows').where({ id: w.id, state: 'idle' }).update({ state: 'open', opened_at: Date.now() }))) return;
    const drained: string[] = [];
    if (w.pool_id) {
      for (const inst of await s.gateway.repo.instances(w.pool_id)) {
        if (inst.state !== 'active') continue;
        try {
          await s.gateway.drain(inst.id, `training window ${w.name}`, 60_000);
          drained.push(inst.id);
        } catch (err) {
          s.log.warn({ err: (err as Error).message, window: w.id, instance: inst.id }, 'training window: drain failed');
        }
      }
    }
    await this.db('training_windows').where({ id: w.id }).update({ drained: JSON.stringify(drained) });
    Object.assign(w, { state: 'open', drained });
    await this.audit(w.tenant_id, 'training.window.opened', { window: w.id, name: w.name, pool: w.pool_id }, 'internal', { drained: drained.length });
  }

  /**
   * Before a window closes: jobs running in it checkpoint (resuming in the next window, not from zero), then the
   * lent pool's instances return to service and its pinned models are reloaded.
   */
  private async closeWindow(w: WindowRow, why: 'closing' | 'removed'): Promise<void> {
    const s = this.s();
    if (!(await this.db('training_windows').where({ id: w.id, state: 'open' }).update({ state: 'idle', drained: null }))) return;
    const running = ((await this.db('training_jobs').where({ window_id: w.id, state: 'running' })) as Record<string, unknown>[]).map(jobFrom);
    for (const j of running) {
      if (j.run_now && !w.pool_id) continue;
      await this.preempt(j, 'window', `Checkpointed at step {step} when the ${w.name} window closed. Resumes from the checkpoint in the next window, not from zero.`);
    }
    const reloaded: string[] = [];
    if (w.pool_id) {
      for (const id of w.drained) await s.gateway.undrain(id).catch(() => undefined);
      const pinned = (await s.gateway.repo.placements()).filter((pl) => pl.pool_id === w.pool_id && pl.residency === 'pinned');
      const models = new Map((await s.gateway.repo.models()).map((m) => [m.id, m]));
      for (const inst of await s.gateway.repo.instances(w.pool_id)) {
        if (inst.state !== 'active') continue;
        for (const pl of pinned) {
          const m = models.get(pl.model_id);
          if (!m) continue;
          try {
            await s.gateway.load(inst.id, m.name, { pinned: true, actor: `training window ${w.name}`, reason: 'Pinned model reloaded before the training window closed' });
            reloaded.push(`${m.name}@${inst.name}`);
          } catch (err) {
            s.log.warn({ err: (err as Error).message, window: w.id, model: m.name }, 'training window: reload failed');
          }
        }
      }
    }
    Object.assign(w, { state: 'idle', drained: [] });
    await this.audit(w.tenant_id, 'training.window.closed', { window: w.id, name: w.name, pool: w.pool_id }, 'internal', { reason: why, checkpointed: running.map((j) => j.name), reloaded });
  }

  private async preempt(j: TrainingJobRow, reason: 'window' | 'preempt' | 'quota' | 'duration', note: string, state: 'preempted' | 'failed' = 'preempted'): Promise<void> {
    let c: Checkpoint | null = null;
    try {
      c = await this.stopRun(j, reason);
    } catch (err) {
      this.s().log.warn({ err: (err as Error).message, job: j.id }, 'training: checkpoint failed');
    }
    if (j.state !== 'running') return; // the sync above saw the run end on its own
    const step = c?.step ?? j.checkpoint?.step ?? 0;
    const text = note.replace('{step}', step.toLocaleString('en-GB'));
    await this.update(j, { state, run_id: null, window_id: null, run_now: false, step, checkpoint: c ? { ...c, reason } : j.checkpoint, note: state === 'preempted' ? text : null, error: state === 'failed' ? text : null, ...(state === 'failed' ? { finished_at: Date.now(), stage_tone: 'danger' as const } : {}) });
    await this.audit(j.tenant_id, state === 'failed' ? 'training.job.failed' : 'training.job.preempted', { job: j.id, name: j.name }, j.label, { reason, step });
  }

  // ---------- recurring schedules ----------

  async schedules(tenantId: string): Promise<ScheduleRow[]> {
    return ((await this.db('training_schedules').where({ tenant_id: tenantId }).orderBy('created_at')) as Record<string, unknown>[]).map(scheduleFrom);
  }

  async addSchedule(p: Principal, input: { name: string; templateJobId: string; cron: string; condition: ScheduleRow['condition']; windowId: string | null; priority: Priority }): Promise<ScheduleRow> {
    const tpl = await this.job(p, input.templateJobId);
    try {
      parseCron(input.cron);
    } catch (err) {
      throw badRequest((err as Error).message);
    }
    if (input.windowId && !(await this.windows(p.tenantId)).some((w) => w.id === input.windowId)) throw notFound('Window');
    if (await this.db('training_schedules').where({ tenant_id: p.tenantId, name: input.name }).first('id')) throw conflict(`A schedule named ${input.name} already exists.`);
    const row: ScheduleRow = { id: ulid(), tenant_id: p.tenantId, name: input.name, template_job_id: tpl.id, cron: input.cron, condition: input.condition, window_id: input.windowId, priority: input.priority, enabled: true, last_dataset_id: input.condition === 'dataset-changed' ? tpl.dataset_id : null, last_job_id: null, last_result: null, last_run_at: null, next_run_at: nextCron(input.cron, Date.now()), created_by: p.userId, created_at: Date.now() };
    await this.db('training_schedules').insert({ ...row });
    return row;
  }

  async setSchedule(p: Principal, id: string, enabled: boolean): Promise<ScheduleRow> {
    const sc = (await this.schedules(p.tenantId)).find((x) => x.id === id);
    if (!sc) throw notFound('Schedule');
    const next = enabled ? nextCron(sc.cron, Date.now()) : sc.next_run_at;
    await this.db('training_schedules').where({ id }).update({ enabled, next_run_at: next });
    return { ...sc, enabled, next_run_at: next };
  }

  async removeSchedule(p: Principal, id: string): Promise<ScheduleRow> {
    const sc = (await this.schedules(p.tenantId)).find((x) => x.id === id);
    if (!sc) throw notFound('Schedule');
    await this.db('training_schedules').where({ id }).delete();
    return sc;
  }

  /** Fires a due schedule: a job with the template's spec and the dataset's newest version, when the condition holds. */
  async fireSchedule(sc: ScheduleRow, now = Date.now()): Promise<TrainingJobRow | null> {
    const s = this.s();
    const next = nextCron(sc.cron, now);
    const record = async (result: string, jobId: string | null, datasetId: string | null) => {
      await this.db('training_schedules').where({ id: sc.id }).update({ last_run_at: now, next_run_at: next, last_result: result.slice(0, 300), ...(jobId ? { last_job_id: jobId } : {}), ...(datasetId ? { last_dataset_id: datasetId } : {}) });
    };
    const tplRow = await this.db('training_jobs').where({ id: sc.template_job_id }).first();
    if (!tplRow) {
      await record('skipped: the template job no longer exists', null, null);
      return null;
    }
    const tpl = jobFrom(tplRow);
    const tplDs = datasetFrom(await this.db('training_datasets').where({ id: tpl.dataset_id }).first());
    const newest = ((await this.db('training_datasets').where({ tenant_id: sc.tenant_id, name: tplDs.name, state: 'ready' }).orderBy('version', 'desc').limit(1)) as Record<string, unknown>[]).map(datasetFrom)[0];
    if (!newest) {
      await record(`skipped: ${tplDs.name} has no usable version`, null, null);
      return null;
    }
    if (sc.condition === 'dataset-changed' && newest.id === sc.last_dataset_id) {
      await record(`skipped: ${newest.name} is still v${newest.version}`, null, null);
      return null;
    }
    // The job runs with the owner's standing authority as it is now, never a role the schedule assumes: an owner who
    // has left, been disabled or lost the training role stops their schedules from submitting anything.
    const owner = (await this.db('users').where({ id: sc.created_by, tenant_id: sc.tenant_id }).first()) as { id: string; username: string; display_name: string; state: string; clearance: Label } | undefined;
    if (!owner || owner.state !== 'active') {
      await record('skipped: the schedule\'s owner no longer has an active account', null, null);
      return null;
    }
    const roles = [...new Set((await s.users.roles(owner.id)).map((r) => r.role))];
    if (!permissionsFor(roles).has('training:submit')) {
      await record('skipped: the schedule\'s owner may no longer submit training jobs', null, null);
      return null;
    }
    const tenant = await s.tenants.byId(sc.tenant_id);
    const p: Principal = { kind: 'user', userId: owner.id, tenantId: sc.tenant_id, tenantSlug: tenant?.slug ?? '', username: owner.username, displayName: owner.display_name, roles, clearance: owner.clearance, scopes: null, sessionId: null, apiKeyId: null, mfa: true };
    try {
      const j = await this.submit(p, { name: `${slug(sc.name)}-${stamp(now)}`.slice(0, 63), baseModel: tpl.base_model, datasetId: newest.id, method: tpl.method, trainer: tpl.trainer, hardware: tpl.hardware, maxHours: tpl.max_hours, deadline: null, priority: sc.priority, preemptible: tpl.preemptible, packaging: tpl.packaging, canary: tpl.canary, checkpointEvery: tpl.checkpoint_every, steps: tpl.steps }, { scheduleId: sc.id });
      await record(`submitted ${j.name} on ${newest.name} v${newest.version}`, j.id, newest.id);
      await this.audit(sc.tenant_id, 'training.schedule.fired', { schedule: sc.id, name: sc.name, job: j.id }, j.label, { dataset: newest.id, version: newest.version });
      await this.notify(sc.tenant_id, [sc.created_by], 'Recurring training job submitted', `${sc.name} submitted ${j.name} on ${newest.name} v${newest.version}.`, j.label);
      return j;
    } catch (err) {
      const message = err instanceof HttpProblem ? (err.detail ?? err.title) : (err as Error).message;
      await record(`failed: ${message}`, null, null);
      s.log.warn({ schedule: sc.id, err: message }, 'recurring training job not submitted');
      return null;
    }
  }

  // ---------- the orchestrator tick ----------

  /**
   * One pass: windows open and close, running jobs sync with the worker, due schedules fire, and the queue is
   * dispatched in fair-share order. Idempotent: state changes are conditional, so overlapping ticks do no harm.
   */
  async tick(now = Date.now()): Promise<{ synced: number; started: number }> {
    const s = this.s();
    const began = Date.now();
    // Windows.
    const windows = ((await this.db('training_windows')) as Record<string, unknown>[]).map(windowFrom);
    for (const w of windows) {
      const at = windowAt(w, now);
      try {
        if (at.open && !at.closing && w.state === 'idle') await this.openWindow(w);
        else if ((!at.open || at.closing) && w.state === 'open') await this.closeWindow(w, 'closing');
      } catch (err) {
        s.log.warn({ err: (err as Error).message, window: w.id }, 'training window transition failed');
      }
    }
    // Running jobs.
    let synced = 0;
    if (s.trainer.available) {
      const running = ((await this.db('training_jobs').where({ state: 'running' })) as Record<string, unknown>[]).map(jobFrom);
      for (const j of running) {
        // A claim whose instance stopped before the worker answered goes back to the queue.
        if (!j.run_id) {
          if (j.updated_at < began - 10 * 60_000) await this.db('training_jobs').where({ id: j.id, state: 'running' }).whereNull('run_id').update({ state: 'queued', wait_reason: null, updated_at: Date.now() });
          continue;
        }
        try {
          await this.syncOne(j, true);
          synced++;
        } catch (err) {
          s.log.warn({ err: (err as Error).message, job: j.id }, 'training sync failed');
        }
      }
    }
    // Schedules.
    const due = ((await this.db('training_schedules').where({ enabled: true }).andWhere('next_run_at', '<=', now)) as Record<string, unknown>[]).map(scheduleFrom);
    for (const sc of due) await this.fireSchedule(sc, now);
    // Queue.
    const started = await this.dispatch(windows, now, began);
    return { synced, started };
  }

  /** Reads the run's status: progress, loss points, checkpoint, GPU time (metered), and the end of the run. */
  private async syncOne(j: TrainingJobRow, act: boolean): Promise<void> {
    const s = this.s();
    if (!j.run_id) return;
    const st: RunStatus = await s.trainer.status(j.run_id);
    const delta = Math.max(0, Math.round(st.gpuMs - j.run_gpu_ms));
    if (delta) await s.quotas.record({ tenantId: j.tenant_id, workspaceId: null, userId: j.created_by, kind: 'training', model: j.name, gpuMs: delta });
    const lastStep = j.series.length ? j.series[j.series.length - 1]![0] : -1;
    const fresh = st.points.filter((pt) => pt.step > lastStep).map((pt) => [pt.step, pt.loss] as [number, number]);
    let series = j.series.concat(fresh);
    while (series.length > MAX_POINTS) series = series.filter((_, i) => i % 2 === 0 || i === series.length - 1);
    const patch: Partial<TrainingJobRow> = { step: st.step, steps: st.steps || j.steps, epoch: st.epoch, loss: st.loss ?? j.loss, series, gpu_ms: j.gpu_ms + delta, run_gpu_ms: Math.max(j.run_gpu_ms, st.gpuMs), container: st.container ?? j.container };
    if (st.checkpoint) patch.checkpoint = { ...st.checkpoint, reason: j.checkpoint?.step === st.checkpoint.step ? j.checkpoint.reason : 'interval' };
    if (patch.container) patch.card = { ...j.card, container: patch.container };
    const extra = { points: fresh };
    if (st.state === 'running' || st.state === 'queued') {
      await this.update(j, patch, true, extra);
      if (!act) return;
      // Limits while running: the job's maximum duration and the tenant's monthly training quota.
      const maxMs = j.max_hours * j.hardware.gpus * 3_600_000;
      if (j.gpu_ms >= maxMs) return this.preempt(j, 'duration', `Reached its maximum of ${j.max_hours} h at step {step}; the checkpoint is kept. Retry from checkpoint to continue.`, 'failed');
      const q = await this.quota(j.tenant_id);
      if (q.limitHours != null && q.usedHours >= q.limitHours) return this.preempt(j, 'quota', `Checkpointed at step {step}: the tenant's ${q.limitHours} training GPU-hours for the month are used. Resumes from the checkpoint after the reset or a raised limit.`);
      return;
    }
    if (st.state === 'succeeded') {
      await this.update(j, { ...patch, state: 'succeeded', stage: ST.evals, run_id: null, window_id: null, finished_at: Date.now(), wait_reason: null, note: null, checkpoint: st.checkpoint ? { ...st.checkpoint, reason: 'final' } : (patch.checkpoint ?? j.checkpoint) }, true, extra);
      await this.audit(j.tenant_id, 'training.job.trained', { job: j.id, name: j.name }, j.label, { steps: st.step, loss: st.loss, gpuHours: Math.round((j.gpu_ms / 3_600_000) * 100) / 100 });
      await s.jobs.enqueue({ tenantId: j.tenant_id, type: 'training.evaluate', payload: { id: j.id }, createdBy: j.created_by, maxAttempts: 2 });
      return;
    }
    if (st.state === 'failed') {
      await this.update(j, { ...patch, state: 'failed', stage_tone: 'danger', run_id: null, window_id: null, finished_at: Date.now(), error: st.error ?? 'The worker reported a failure without a reason.' }, true, extra);
      await this.audit(j.tenant_id, 'training.job.failed', { job: j.id, name: j.name }, j.label, { step: st.step, error: st.error });
      await this.notify(j.tenant_id, [j.created_by], 'Training job failed', `${j.name} failed at step ${st.step}: ${st.error ?? ''}`, j.label);
      return;
    }
    if (st.state === 'cancelled') {
      await this.update(j, { ...patch, state: 'cancelled', run_id: null, window_id: null, finished_at: Date.now() }, true, extra);
      return;
    }
    // checkpointed or preempted on the worker's side (a pause we asked for is finished by the caller).
    if (!act) {
      await this.update(j, patch, true, extra);
      return;
    }
    const step = st.checkpoint?.step ?? st.step;
    await this.update(j, { ...patch, step, state: 'preempted', run_id: null, window_id: null, checkpoint: st.checkpoint ? { ...st.checkpoint, reason: 'preempt' } : j.checkpoint, note: `Preempted at step ${step.toLocaleString('en-GB')} by the worker for interactive load. Resumes from the checkpoint, not from zero.` }, true, extra);
    await this.audit(j.tenant_id, 'training.job.preempted', { job: j.id, name: j.name }, j.label, { reason: 'worker', step });
  }

  /**
   * Starts queued and preempted jobs. Order: priority, then the tenant's training GPU-hours this month (fair share),
   * then deadline and age. A job starts inside an open window of its tenant (or anywhere after "Run now"), when the
   * worker has the GPUs and the tenant has quota. A higher-priority job may preempt a lower-priority preemptible one.
   */
  private async dispatch(windows: WindowRow[], now: number, began: number): Promise<number> {
    const s = this.s();
    // A job preempted during this pass waits for the next one, so the capacity it gave up is really used elsewhere.
    const candidates = ((await this.db('training_jobs').whereIn('state', ['queued', 'preempted']).andWhere({ hold: false })) as Record<string, unknown>[]).map(jobFrom).filter((j) => j.approval !== 'pending' && !(j.state === 'preempted' && j.updated_at >= began));
    if (!candidates.length) return 0;
    const waiting = async (j: TrainingJobRow, reason: string) => {
      if (j.wait_reason !== reason) await this.update(j, { wait_reason: reason });
    };
    if (!s.trainer.available) {
      for (const j of candidates) await waiting(j, s.trainer.reason ?? 'No training worker.');
      return 0;
    }
    let free: number;
    try {
      free = (await s.trainer.info()).gpus.free;
    } catch (err) {
      for (const j of candidates) await waiting(j, (err as Error).message.slice(0, 480));
      return 0;
    }
    const usage = new Map<string, number>();
    for (const t of new Set(candidates.map((j) => j.tenant_id))) usage.set(t, (await this.quota(t)).usedHours);
    candidates.sort((a, b) => prioRank(b.priority) - prioRank(a.priority) || usage.get(a.tenant_id)! - usage.get(b.tenant_id)! || (a.deadline ?? Infinity) - (b.deadline ?? Infinity) || a.created_at - b.created_at);
    const openWindow = (tenantId: string) => windows.find((w) => w.tenant_id === tenantId && w.state === 'open' && !windowAt(w, now).closing);
    let started = 0;
    for (const j of candidates) {
      const w = openWindow(j.tenant_id);
      if (!w && !j.run_now) {
        const next = windows.filter((x) => x.tenant_id === j.tenant_id).map((x) => windowAt(x, now).opensAt).filter((x): x is number => x != null).sort((a, b) => a - b)[0];
        await waiting(j, next ? `next window, ${new Date(next).toISOString().slice(11, 16)} UTC` : 'waits for a training window');
        continue;
      }
      const q = await this.quota(j.tenant_id);
      if (q.limitHours != null && q.usedHours >= q.limitHours) {
        await waiting(j, `the tenant's ${q.limitHours} training GPU-hours for the month are used`);
        continue;
      }
      if (j.hardware.gpus > free) {
        // Fair share across priorities: checkpoint the lowest-priority preemptible job that is below this one.
        const victim = ((await this.db('training_jobs').where({ state: 'running', preemptible: true })) as Record<string, unknown>[]).map(jobFrom).filter((r) => prioRank(r.priority) < prioRank(j.priority)).sort((a, b) => prioRank(a.priority) - prioRank(b.priority))[0];
        if (victim) {
          await this.preempt(victim, 'preempt', `Preempted at step {step} for the higher-priority job ${j.name}. Resumes from the checkpoint, not from zero.`);
          await waiting(j, `waiting for ${victim.name} to release its GPUs`);
          break;
        }
        await waiting(j, `waiting for ${j.hardware.gpus} free GPU${j.hardware.gpus === 1 ? '' : 's'} (${free} free)`);
        continue;
      }
      try {
        await this.start(j, w ?? null);
        free -= j.hardware.gpus;
        started++;
      } catch (err) {
        const message = err instanceof HttpProblem ? (err.detail ?? err.title) : (err as Error).message;
        await waiting(j, `could not start: ${message}`.slice(0, 480));
      }
    }
    return started;
  }

  private async start(j: TrainingJobRow, w: WindowRow | null): Promise<void> {
    const s = this.s();
    const d = datasetFrom(await this.db('training_datasets').where({ id: j.dataset_id }).first());
    if (d.state !== 'ready' || !d.blob_key) throw conflict(`${d.name} v${d.version} is ${d.state}.`);
    // Claim the job before talking to the worker (a running row without a run id), so an overlapping tick on this
    // or another instance does not start it twice. A failed submit puts it back.
    const claimed = await this.db('training_jobs').where({ id: j.id, state: j.state, hold: false }).whereNull('run_id').update({ state: 'running', run_id: null, wait_reason: 'starting', updated_at: Date.now() });
    if (!claimed) return;
    // Put back the wait reason too, so a failure that repeats on the next tick is still shown (not "starting").
    const release = () => this.db('training_jobs').where({ id: j.id, state: 'running' }).whereNull('run_id').update({ state: j.state, wait_reason: j.wait_reason, updated_at: Date.now() });
    let runId: string;
    try {
      const plain = await this.getSealed(d.tenant_id, d.blob_key);
      // B-905: a contract-2 worker gets the rows encrypted with a run key it fetches once; contract 1 only if allowed.
      const contract = (await s.trainer.info()).contract ?? 1;
      if (contract < 2 && !s.cfg.TRAINER_PLAINTEXT_FALLBACK) throw conflict('The training worker speaks contract 1, which takes dataset rows in plaintext. Upgrade it to contract 2, or set TRAINER_PLAINTEXT_FALLBACK=true to allow it.');
      const data = contract >= 2 ? await this.worker.seal(j, d.rows, plain) : plain;
      const spec: TrainSpec = {
        job: j.id, name: j.name, baseModel: j.base_model, baseDigest: j.base_digest, method: j.method, trainer: j.trainer, hardware: j.hardware, steps: j.steps, checkpointEvery: j.checkpoint_every,
        dataset: { id: d.id, name: d.name, version: d.version, hash: d.hash!, rows: d.rows, splits: d.splits.rows ?? splitCounts(d.rows, d.splits.pct) },
        resumeFrom: j.checkpoint ? { step: j.checkpoint.step, ref: j.checkpoint.ref, at: j.checkpoint.at } : null
      };
      runId = (await s.trainer.submit(spec, data)).id;
    } catch (err) {
      await release();
      throw err;
    }
    const resumed = j.checkpoint ? `Resumed from the checkpoint at step ${j.checkpoint.step.toLocaleString('en-GB')}, not from zero.` : null;
    await this.update(j, { state: 'running', stage: ST.training, run_id: runId, run_gpu_ms: 0, window_id: w?.id ?? null, started_at: j.started_at ?? Date.now(), wait_reason: null, note: resumed, error: null, step: j.checkpoint?.step ?? j.step });
    await this.audit(j.tenant_id, 'training.job.started', { job: j.id, name: j.name }, j.label, { run: runId, window: w?.name ?? null, resumeFrom: j.checkpoint?.step ?? null, gpus: j.hardware.gpus });
  }

  // ---------- evals ----------

  /** The hardware classes a model will serve on: the accelerators of pools cleared for its label. */
  private async hardwareClasses(label: Label, fallback: string): Promise<string[]> {
    const pools = (await this.s().gateway.repo.pools()).filter((p) => labelRank(p.label_ceiling) >= labelRank(label));
    const classes = [...new Set(pools.map((p) => p.accelerator))];
    return classes.length ? classes : [fallback];
  }

  /** B-906: whether a registered model card's KMS signature still verifies (after a key-encryption-key change, too). */
  async verifyCard(tenantId: string, jobId: string): Promise<boolean> {
    const r = await this.db('training_jobs').where({ tenant_id: tenantId, id: jobId }).first();
    if (!r) throw notFound('Training job');
    const j = jobFrom(r);
    if (!j.card.manifest) return false;
    return this.s().kms.verifyHmac(j.card.manifest.key, canonicalJson(cardManifest(j, j.card)), j.card.manifest.signature).catch(() => false);
  }

  async evals(p: Principal) {
    return ((await this.db('training_evals').where({ tenant_id: p.tenantId }).orderBy('created_at', 'desc').limit(500)) as Record<string, unknown>[])
      .filter((r) => clears(p.clearance, r.label as Label))
      .map((r) => ({ id: String(r.id), jobId: (r.job_id as string | null) ?? null, model: String(r.model), hardware: String(r.hardware), suite: String(r.suite), name: SUITES[String(r.suite)]?.name ?? String(r.suite), score: Number(r.score), base: n0(r.base_score), threshold: Number(r.threshold), passed: n0(r.passed), total: n0(r.total), result: r.result as 'pass' | 'fail', createdAt: Number(r.created_at) }))
      .map((e) => ({ ...e, scoreText: fmtScore(e), thresholdText: fmtThreshold(e) }));
  }

  /** Queues evals: for a training job (re-run), or for a catalogue model on the chosen hardware classes and suites. */
  async queueEvals(p: Principal, input: { jobId?: string; model?: string; hardware?: string[]; suites?: string[] }): Promise<{ job: TrainingJobRow | null; model: string }> {
    const s = this.s();
    for (const k of input.suites ?? []) if (!SUITES[k]) throw badRequest(`Unknown eval suite ${k}.`);
    if (input.jobId) {
      const j = await this.job(p, input.jobId);
      if (j.state !== 'succeeded') throw conflict('Evals run on a job that finished training.');
      await s.jobs.enqueue({ tenantId: p.tenantId, type: 'training.evaluate', payload: { id: j.id, by: p.userId, ...(input.hardware ? { hardware: input.hardware } : {}), ...(input.suites ? { suites: input.suites } : {}) }, createdBy: p.userId, maxAttempts: 2 });
      return { job: j, model: j.card.registration.model ?? j.name };
    }
    const m = input.model ? await s.gateway.repo.modelByName(input.model) : undefined;
    if (!m || !clears(p.clearance, m.label)) throw notFound('Model');
    const fromJob = ((await this.db('training_jobs').where({ tenant_id: p.tenantId, model_id: m.id })) as Record<string, unknown>[]).map(jobFrom)[0];
    if (fromJob) return this.queueEvals(p, { jobId: fromJob.id, ...(input.hardware ? { hardware: input.hardware } : {}), ...(input.suites ? { suites: input.suites } : {}) });
    await s.jobs.enqueue({ tenantId: p.tenantId, type: 'training.evaluate', payload: { model: m.name, by: p.userId, hardware: input.hardware ?? (await this.hardwareClasses(m.label, 'cuda')), suites: input.suites ?? ['regression', 'redteam'] }, createdBy: p.userId, maxAttempts: 2 });
    return { job: null, model: m.name };
  }

  private async evaluateJob(p: Record<string, unknown>): Promise<unknown> {
    const s = this.s();
    const by = (p.by as string | undefined) ?? null;
    if (!p.id) {
      // A catalogue model outside any training job: results are recorded, nothing else changes.
      const m = await s.gateway.repo.modelByName(String(p.model));
      if (!m) return { skipped: 'missing' };
      const tenantId = (await this.db('users').where({ id: by }).first('tenant_id'))?.tenant_id as string | undefined;
      if (!tenantId) return { skipped: 'no tenant' };
      const out = await this.runSuites(tenantId, null, m.name, null, null, (p.hardware as string[]) ?? ['cuda'], (p.suites as string[]) ?? ['regression'], m.label, by);
      await this.notify(tenantId, by ? [by] : [], 'Evals finished', `${m.name}: ${out.filter((e) => e.result === 'pass').length} of ${out.length} passed.`, m.label);
      return { results: out.length };
    }
    const r = await this.db('training_jobs').where({ id: String(p.id) }).first();
    if (!r) return { skipped: 'missing' };
    const j = jobFrom(r);
    if (j.state !== 'succeeded') return { skipped: j.state };
    const base = await s.gateway.repo.modelByName(j.base_model);
    const hardware = (p.hardware as string[] | undefined) ?? (await this.hardwareClasses(j.label, j.hardware.accelerator));
    const suites = (p.suites as string[] | undefined) ?? ['heldout', 'regression', 'redteam', ...(base?.capabilities.includes('tools') ? ['tools'] : [])];
    await this.update(j, { stage: ST.evals, stage_tone: null, note: `Evals running on ${hardware.join(', ')}.` });
    let results: EvalEntry[];
    try {
      results = await this.runSuites(j.tenant_id, j.id, j.card.registration.model ?? j.name, j.base_model, j.checkpoint, hardware, suites, j.label, by);
    } catch (err) {
      await this.update(j, { stage_tone: 'danger', note: `Evals could not run: ${(err as Error).message}`.slice(0, 1000) });
      throw err;
    }
    // A re-run replaces the results of the suites and hardware classes it covered.
    const keep = j.card.evals.filter((e) => !results.some((x) => x.suite === e.suite && x.hardware === e.hardware));
    const evals = [...keep, ...results];
    const failing = evals.filter((e) => e.result === 'fail');
    if (failing.length) {
      const reason = failing.map((e) => `${e.name} ${fmtScore(e)} against a threshold of ${fmtThreshold(e)} on ${e.hardware}`).join('; ');
      const card: ModelCard = { ...j.card, evals, registration: { ...j.card.registration, state: 'blocked', reason } };
      await this.update(j, { stage: ST.evals, stage_tone: 'danger', card, note: null });
      await this.audit(j.tenant_id, 'training.evals.failed', { job: j.id, name: j.name }, j.label, { failing: failing.map((e) => ({ suite: e.suite, hardware: e.hardware, score: e.score, threshold: e.threshold })) });
      await this.notify(j.tenant_id, [j.created_by], 'Eval below threshold', `${j.name}: registration is blocked. ${reason}.`, j.label);
      return { state: 'blocked', failing: failing.length };
    }
    const card: ModelCard = { ...j.card, evals, registration: { ...j.card.registration, state: j.model_id ? 'registered' : 'pending', reason: null } };
    await this.update(j, { stage: j.model_id ? Math.max(j.stage, ST.modelApproval) : ST.convert, stage_tone: null, card, note: null });
    await this.audit(j.tenant_id, 'training.evals.passed', { job: j.id, name: j.name }, j.label, { suites: results.length });
    if (!j.model_id) await s.jobs.enqueue({ tenantId: j.tenant_id, type: 'training.package', payload: { id: j.id }, createdBy: j.created_by, maxAttempts: 2 });
    return { state: 'passed' };
  }

  private async runSuites(tenantId: string, jobId: string | null, model: string, base: string | null, checkpoint: Checkpoint | null, hardware: string[], suites: string[], label: Label, by: string | null): Promise<EvalEntry[]> {
    const s = this.s();
    const { thresholds } = await this.settings(tenantId);
    const out: EvalEntry[] = [];
    for (const hw of hardware) {
      for (const suite of suites) {
        const r = await s.trainer.evaluate({ model, base, checkpoint, suite, hardware: hw });
        const threshold = thresholds[suite] ?? SUITES[suite]?.threshold ?? 1;
        const score = r.total ? (r.passed ?? 0) / r.total : r.score;
        const e: EvalEntry = { suite, name: SUITES[suite]?.name ?? suite, hardware: hw, base: r.base, score, threshold, passed: r.passed, total: r.total, result: score + 1e-9 >= threshold ? 'pass' : 'fail' };
        out.push(e);
        await this.db('training_evals').insert({ id: ulid(), tenant_id: tenantId, job_id: jobId, model, hardware: hw, suite, score, base_score: r.base, threshold, passed: r.passed, total: r.total, result: e.result, label, created_by: by, created_at: Date.now() });
      }
    }
    return out;
  }

  // ---------- packaging and registration ----------

  private async packageJob(id: string): Promise<unknown> {
    const s = this.s();
    const r = await this.db('training_jobs').where({ id }).first();
    if (!r) return { skipped: 'missing' };
    const j = jobFrom(r);
    if (j.state !== 'succeeded' || j.model_id || j.card.registration.state === 'blocked') return { skipped: 'not ready' };
    if (!j.checkpoint) throw new Error('The run left no final checkpoint to convert.');
    const quantization = j.packaging.startsWith('GGUF ') ? j.packaging.slice(5) : 'adapter';
    await this.update(j, { stage: ST.convert, note: `Converting to ${j.packaging}.` });
    const tag = /:([^-]+)/.exec(j.base_model)?.[1] ?? 'latest';
    let conv;
    try {
      conv = await s.trainer.convert({ job: j.id, name: `${j.name}:${tag}`, checkpoint: j.checkpoint, baseModel: j.base_model, quantization });
    } catch (err) {
      await this.update(j, { stage_tone: 'danger', note: `Conversion failed: ${(err as Error).message}`.slice(0, 1000) });
      throw err;
    }
    const packaging = { requested: j.packaging, quantization: conv.quantization, tool: conv.tool, artifact: conv.artifact, digest: conv.digest, sizeBytes: conv.sizeBytes };
    await this.update(j, { stage: ST.draft, card: { ...j.card, packaging }, note: 'Registering as a draft model.' });
    // A draft in the gateway catalogue: the model admins pull, evaluate and approve it with their usual dual control.
    const repo = s.gateway.repo;
    const base = await repo.modelByName(j.base_model);
    let model = await repo.modelByName(conv.name);
    if (model && model.source !== `training:${j.id}`) {
      const reason = `A model named ${conv.name} is already in the catalogue.`;
      await this.update(j, { stage_tone: 'danger', card: { ...j.card, registration: { state: 'failed', reason, modelId: null, model: conv.name } }, note: reason });
      return { state: 'failed', reason };
    }
    if (!model) {
      model = await repo.createModel({ name: conv.name, source: `training:${j.id}`, expectedDigest: conv.digest, license: base?.license ?? null, label: j.label, notes: `Fine-tuned from ${j.base_model} on ${j.card.dataset.name} v${j.card.dataset.version} (${j.card.dataset.hash}) by training job ${j.name}. GGUF ${conv.quantization}, ${conv.artifact}.`.slice(0, 1000), requestedBy: j.created_by, requestedTenant: j.tenant_id });
      await repo.updateModel(model.id, { format: 'gguf', quantization: conv.quantization, family: base?.family ?? null, parameter_size: base?.parameter_size ?? null, capabilities: (base?.capabilities ?? ['completion']).filter((c) => c !== 'tools' || j.card.evals.some((e) => e.suite === 'tools' && e.result === 'pass')), context_length: base?.context_length ?? null, size_bytes: conv.sizeBytes });
    }
    const card: ModelCard = { ...j.card, packaging, registration: { state: 'registered', reason: null, modelId: model.id, model: model.name } };
    const manifest = cardManifest(j, card);
    const key = `${s.cfg.OPENBAO_KEY_PREFIX}training-manifests`;
    card.manifest = { signature: await s.kms.hmac(key, canonicalJson(manifest)), key, signedAt: Date.now() };
    await this.update(j, { stage: ST.modelApproval, model_id: model.id, card, note: null });
    await this.audit(j.tenant_id, 'training.model.registered', { job: j.id, name: j.name, model: model.id }, j.label, { model: model.name, digest: conv.digest, quantization: conv.quantization, signature: card.manifest.signature });
    const admins = await s.notifications.usersWithRoles(j.tenant_id, ['model-admin']);
    await this.notify(j.tenant_id, admins, 'Draft model from training', `${model.name} was registered as a draft from ${j.name}. It needs a pull, the evaluation and an approval under Models.`, j.label);
    await this.notify(j.tenant_id, [j.created_by], 'Training job registered a draft model', `${j.name} passed its evals and is registered as ${model.name}, a draft.`, j.label);
    return { model: model.name };
  }

  // ---------- views ----------

  /** The pipeline stage for display: after registration it follows the model's lifecycle in the catalogue. */
  async stageOf(j: TrainingJobRow, models: Map<string, ModelRow>, canaries: Set<string>): Promise<number> {
    if (!j.model_id || j.stage < ST.modelApproval) return j.stage;
    const m = models.get(j.model_id);
    if (!m || m.state === 'draft' || m.state === 'evaluated') return ST.modelApproval;
    if (m.state === 'approved') return j.canary > 0 && !canaries.has(m.id) ? ST.canary : ST.pools;
    return ST.pools;
  }

  async viewContext(tenantId: string) {
    const repo = this.s().gateway.repo;
    const models = new Map((await repo.models()).map((m) => [m.id, m]));
    // A model counts as past the canary once a profile serves it directly (promoted) rather than as a canary.
    const profiles = await repo.profiles(tenantId);
    const promoted = new Set(profiles.filter((p) => p.model_id && p.status === 'published').map((p) => p.model_id!));
    return { models, canaries: promoted };
  }

  async jobView(j: TrainingJobRow, names: Map<string, string>, datasets: Map<string, DatasetRow>, windows: WindowRow[], ctx: { models: Map<string, ModelRow>; canaries: Set<string> }) {
    const d = datasets.get(j.dataset_id);
    const w = windows.find((x) => x.id === j.window_id);
    const model = j.model_id ? ctx.models.get(j.model_id) : undefined;
    return {
      id: j.id,
      name: j.name,
      desc: `${methodText(j.method).split(',')[0]} on ${j.base_model}, dataset ${d ? `${d.name} v${d.version}` : 'unknown'}, seed ${j.method.seed}`,
      baseModel: j.base_model,
      baseDigest: j.base_digest,
      dataset: d ? { id: d.id, name: d.name, version: d.version, label: d.label, rows: d.rows, state: d.state } : null,
      method: j.method,
      methodText: methodText(j.method),
      trainer: j.trainer,
      hardware: j.hardware,
      hardwareText: hardwareText(j.hardware),
      maxHours: j.max_hours,
      maxGpuHours: j.max_hours * j.hardware.gpus,
      priority: j.priority,
      preemptible: j.preemptible,
      priorityText: `${j.priority}${j.preemptible ? ', preemptible' : ''}`,
      deadline: j.deadline,
      packaging: j.packaging,
      canary: j.canary,
      checkpointEvery: j.checkpoint_every,
      label: j.label,
      state: j.state,
      stage: await this.stageOf(j, ctx.models, ctx.canaries),
      stageTone: j.stage_tone,
      awaiting: j.approval === 'pending',
      approval: j.approval,
      approvedBy: j.approved_by ? (names.get(j.approved_by) ?? null) : null,
      approvedAt: j.approved_at,
      holding: j.hold,
      runNow: j.run_now,
      waitReason: j.wait_reason,
      window: w ? w.name : null,
      step: j.step,
      steps: j.steps,
      epoch: j.epoch,
      epochs: j.epochs,
      loss: j.loss,
      series: j.series,
      gpuHours: Math.round((j.gpu_ms / 3_600_000) * 10) / 10,
      checkpoint: j.checkpoint,
      container: j.container,
      note: j.note,
      error: j.error,
      evals: j.card.evals.map((e) => ({ ...e, scoreText: fmtScore(e), thresholdText: fmtThreshold(e), baseText: e.base == null ? '' : e.base.toFixed(3) })),
      registration: j.card.registration,
      model: model ? { id: model.id, name: model.name, state: model.state } : null,
      scheduleId: j.schedule_id,
      owner: j.schedule_id ? 'scheduler' : (names.get(j.created_by) ?? null),
      ownerId: j.created_by,
      createdAt: j.created_at,
      startedAt: j.started_at,
      finishedAt: j.finished_at
    };
  }

  cardView(j: TrainingJobRow, names: Map<string, string>) {
    const c = j.card;
    return {
      job: j.id,
      name: j.name,
      model: c.registration.model ?? `${j.name} (not registered)`,
      label: j.label,
      baseModel: c.baseModel,
      baseDigest: c.baseDigest,
      dataset: c.dataset,
      trainer: c.trainer,
      container: c.container,
      hyperparameters: c.hyperparameters,
      hardware: hardwareText(c.hardware),
      approval: c.approval ? { ...c.approval, byName: names.get(c.approval.by) ?? c.approval.byName } : null,
      evals: c.evals.map((e) => ({ ...e, scoreText: fmtScore(e), thresholdText: fmtThreshold(e) })),
      packaging: c.packaging,
      registration: c.registration,
      manifest: c.manifest
    };
  }

  datasetView(d: DatasetRow, used: Map<string, string[]>, names: Map<string, string>) {
    const sc = d.scrub;
    const pii = d.state === 'withdrawn' ? `withdrawn: ${d.withdrawn_reason ?? ''}` : d.state === 'scrubbing' ? 'scrub running' : d.state === 'failed' ? `failed: ${d.error ?? ''}` : sc ? `${sc.masked.toLocaleString('en-GB')} masked${sc.masked ? ', report attached' : ''}` : '';
    return {
      id: d.id,
      name: d.name,
      version: d.version,
      ver: `v${d.version}`,
      rows: d.rows,
      label: d.label,
      source: d.source,
      sourceKind: d.source_kind,
      conversationData: d.conversation_data,
      optIn: d.opt_in,
      state: d.state,
      hash: d.hash,
      splits: d.splits,
      scrub: sc,
      pii,
      error: d.error,
      withdrawn: d.state === 'withdrawn',
      withdrawnReason: d.withdrawn_reason,
      withdrawnBy: d.withdrawn_by ? (names.get(d.withdrawn_by) ?? null) : null,
      withdrawnAt: d.withdrawn_at,
      usedBy: used.get(d.id) ?? [],
      stored: d.blob_key ? `blob store, ${d.blob_key.replace(/\/data\.jsonl$/, '/')}, sealed` : null,
      createdBy: names.get(d.created_by) ?? null,
      createdAt: d.created_at
    };
  }

  windowView(w: WindowRow, pools: Map<string, string>, now = Date.now()) {
    const at = windowAt(w, now);
    const reload = reloadTime(w);
    const pool = w.pool_id ? (pools.get(w.pool_id) ?? w.pool_id) : null;
    return {
      id: w.id,
      name: w.name,
      poolId: w.pool_id,
      pool: pool ?? 'training worker',
      kind: w.kind,
      startDay: w.start_day,
      startTime: w.start_time,
      endDay: w.end_day,
      endTime: w.end_time,
      reloadMinutes: w.reload_minutes,
      when: describeWindow(w),
      effect: pool ? `lent to training; drained first, pinned models reloaded${reload ? ` at ${reload}` : ''}` : 'the training worker\'s own GPUs',
      state: w.state,
      open: at.open,
      closing: at.closing,
      closesAt: at.closesAt,
      opensAt: at.opensAt
    };
  }

  scheduleView(sc: ScheduleRow, jobs: Map<string, string>, windows: Map<string, string>) {
    return {
      id: sc.id,
      name: sc.name,
      templateJobId: sc.template_job_id,
      template: jobs.get(sc.template_job_id) ?? null,
      cron: sc.cron,
      cronText: `${describeCron(sc.cron)} (${sc.cron})`,
      condition: sc.condition,
      conditionText: sc.condition === 'dataset-changed' ? 'only when the input dataset version changed' : 'always',
      window: sc.window_id ? (windows.get(sc.window_id) ?? null) : null,
      priority: sc.priority,
      enabled: sc.enabled,
      nextRunAt: sc.enabled ? sc.next_run_at : null,
      lastRunAt: sc.last_run_at,
      lastResult: sc.last_result,
      lastJobId: sc.last_job_id
    };
  }
}

/**
 * The signed part of a model card (Sprint 9), rebuilt from the card as it was at registration. Sprint 18 (B-906):
 * `kms:rewrap` re-signs it, and `verifyCard` checks it.
 */
export function cardManifest(j: { id: string; name: string }, card: ModelCard): Record<string, unknown> {
  return { job: j.id, name: j.name, model: card.registration.model, baseModel: card.baseModel, baseDigest: card.baseDigest, dataset: card.dataset, container: card.container, hyperparameters: card.hyperparameters, evals: card.evals.map((e) => ({ suite: e.suite, hardware: e.hardware, score: e.score, threshold: e.threshold, result: e.result })), packaging: card.packaging, approval: card.approval };
}
