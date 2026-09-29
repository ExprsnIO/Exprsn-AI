import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { z } from 'zod';
import { json, type Db } from '../db/knex.js';
import type { Label } from '../authz/labels.js';
import { isUniqueViolation } from '../audit/chain.js';
import { conflict, HttpProblem, notFound } from '../http/problem.js';
import type { Gateway } from '../gateway/gateway.js';
import type { DataKeys } from '../platform/datakeys.js';
import type { JobContext, JobQueue } from '../platform/jobs.js';
import { detectPii, detectSecrets, PII_KINDS, SECRET_KINDS, type Detection } from './detectors.js';
import { scoreLinear, trainLinear, type LinearHead } from './linear.js';
import { complete, GUARD_CATEGORIES, guardMessages, parseGuardVerdict } from './model.js';

export const ENGINES = ['deterministic', 'linear', 'guard', 'llm'] as const;
export type Engine = (typeof ENGINES)[number];

/** Below this many labelled cases per label, precision and recall are not reliable and a classifier cannot publish. */
export const MIN_SAMPLES = 200;

export interface ClassifierConfig {
  labels: { label: string; threshold: number }[];
  /** deterministic: which detector family. */
  family?: 'pii' | 'secrets';
  /** guard and llm: the tenant profile that routes to the model. */
  profile?: string;
  /** llm: extra instructions in the prompt. */
  instructions?: string;
  /** linear: the trained head. */
  head?: LinearHead | null;
}

export interface LabelMetrics {
  precision: number | null;
  recall: number | null;
  n: number;
  tp: number;
  fp: number;
  fn: number;
}

export interface ClassifierMetrics {
  at: number;
  dataset: string;
  samples: number;
  perLabel: Record<string, LabelMetrics>;
  /** Per label, `[score, 1 if the case carries that label else 0]`, so a threshold can be previewed exactly. */
  points: Record<string, [number, number][]>;
  /** Top label per case. */
  distribution: Record<string, number>;
  errors: number;
  /** A trained head is scored on the held-out fifth of the dataset only. */
  heldOut: boolean;
}

export interface ClassifierRow {
  id: string;
  tenant_id: string | null;
  slug: string;
  name: string;
  engine: Engine;
  description: string | null;
  status: 'draft' | 'published';
  version: number;
  owner: string | null;
  dataset: string | null;
  config: ClassifierConfig;
  /** The caller's tenant's last evaluation (filled in by list and get). */
  metrics: ClassifierMetrics | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

const fromRow = (r: Record<string, unknown>): ClassifierRow => ({
  ...(r as unknown as ClassifierRow),
  version: Number(r.version),
  config: json<ClassifierConfig>(r.config, { labels: [] }),
  metrics: null,
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at)
});

export const classifierView = (c: ClassifierRow, sampleCounts?: Record<string, number>) => ({
  id: c.id,
  slug: c.slug,
  name: c.name,
  engine: c.engine,
  description: c.description,
  status: c.status,
  version: c.version,
  owner: c.owner,
  dataset: c.dataset,
  platform: c.tenant_id === null,
  labels: c.config.labels,
  family: c.config.family ?? null,
  profile: c.config.profile ?? null,
  instructions: c.config.instructions ?? null,
  trained: c.config.head ? { at: c.config.head.trainedAt, samples: c.config.head.samples } : null,
  metrics: c.metrics,
  samples: sampleCounts ?? null,
  createdAt: c.created_at,
  updatedAt: c.updated_at
});

const BUILTIN_IDS = { pii: '0000000000000000000CLSPII0', secrets: '000000000000000000CLSSECR0', safety: '000000000000000000CLSSAFE0' } as const;

const BUILTINS: Omit<ClassifierRow, 'created_at' | 'updated_at' | 'created_by'>[] = [
  { id: BUILTIN_IDS.pii, tenant_id: null, slug: 'pii', name: 'PII detector', engine: 'deterministic', description: 'Patterns and checksums for personal data: email addresses, phone numbers, IBANs (mod-97), payment cards (Luhn) and national identifiers (check digits).', status: 'published', version: 1, owner: 'Platform', dataset: 'pii-eval', config: { family: 'pii', labels: PII_KINDS.map((label) => ({ label, threshold: 0.5 })) }, metrics: null },
  { id: BUILTIN_IDS.secrets, tenant_id: null, slug: 'secrets', name: 'Secrets and keys', engine: 'deterministic', description: 'Private key headers, cloud access keys, bearer tokens and high-entropy strings.', status: 'published', version: 1, owner: 'Platform', dataset: 'secrets-eval', config: { family: 'secrets', labels: SECRET_KINDS.map((label) => ({ label, threshold: label === 'high_entropy' ? 0.6 : 0.5 })) }, metrics: null },
  { id: BUILTIN_IDS.safety, tenant_id: null, slug: 'safety', name: 'Safety categories', engine: 'guard', description: 'A Llama Guard style guard model through the gateway, answering safe or unsafe with hazard categories S1 to S14. Uses the tenant profile named llama-guard.', status: 'published', version: 1, owner: 'Platform', dataset: 'safety-eval', config: { profile: 'llama-guard', labels: Object.keys(GUARD_CATEGORIES).map((label) => ({ label, threshold: 0.5 })) }, metrics: null }
];

export interface ScoreResult {
  scores: Record<string, number>;
  spans: Detection[];
  top: { label: string; score: number } | null;
  /** Labels at or above their threshold. */
  hits: string[];
  engine: Engine;
  ms: number;
}

export const newClassifierSchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).optional(),
  engine: z.enum(['linear', 'guard', 'llm']),
  labels: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
  profile: z.string().trim().min(1).max(63).optional(),
  instructions: z.string().trim().max(2000).optional(),
  dataset: z.string().trim().regex(/^[\w.-]{1,100}$/).optional(),
  description: z.string().trim().max(1000).optional()
});

/**
 * The classifier registry. Four engines behind one interface: deterministic detectors, a trained linear head, a
 * guard model and a general model answering in JSON (both through the gateway). Platform classifiers (tenant null)
 * are shared; tenants add their own. Eval datasets are named sets of labelled cases (`eval_cases`, sealed), fed by
 * confirmed flags and by hand; evaluation and training run as jobs.
 */
export class ClassifierService {
  private seeded: Promise<void> | null = null;

  constructor(
    private readonly db: Db,
    private readonly keys: DataKeys,
    private readonly gateway: Gateway,
    jobs: JobQueue
  ) {
    jobs.register('classifier.evaluate', (p, ctx) => this.evaluateJob(String(p.tenantId ?? ctx.job.tenant_id), String(p.classifierId), ctx), { timeoutMs: 60 * 60_000 });
    jobs.register('classifier.train', (p, ctx) => this.trainJob(String(p.tenantId ?? ctx.job.tenant_id), String(p.classifierId), ctx), { timeoutMs: 60 * 60_000 });
  }

  /** Inserts the platform classifiers once (fixed ids, so several instances cannot duplicate them). */
  ensureBuiltins(): Promise<void> {
    this.seeded ??= (async () => {
      const have = new Set(((await this.db('classifiers').whereIn('id', Object.values(BUILTIN_IDS)).select('id')) as { id: string }[]).map((r) => r.id));
      const t = Date.now();
      for (const b of BUILTINS.filter((x) => !have.has(x.id))) {
        try {
          const { metrics: _none, ...row } = b;
          await this.db('classifiers').insert({ ...row, config: JSON.stringify(b.config), created_by: null, created_at: t, updated_at: t });
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
        }
      }
    })().catch((err) => {
      this.seeded = null;
      throw err;
    });
    return this.seeded;
  }

  async list(tenantId: string): Promise<ClassifierRow[]> {
    await this.ensureBuiltins();
    const rows = (await this.db('classifiers').where((q) => q.whereNull('tenant_id').orWhere({ tenant_id: tenantId })).orderBy([{ column: 'tenant_id', order: 'asc' }, { column: 'name' }])).map(fromRow);
    const m = new Map(((await this.db('classifier_metrics').where({ tenant_id: tenantId })) as { classifier_id: string; metrics: string }[]).map((x) => [x.classifier_id, json<ClassifierMetrics | null>(x.metrics, null)]));
    return rows.map((c) => ({ ...c, metrics: m.get(c.id) ?? null }));
  }

  /** By id or slug; a tenant's own classifier and the platform's are both visible. */
  async get(tenantId: string, ref: string): Promise<ClassifierRow | undefined> {
    await this.ensureBuiltins();
    const r = await this.db('classifiers').where((q) => q.whereNull('tenant_id').orWhere({ tenant_id: tenantId })).andWhere((q) => q.where({ id: ref }).orWhere({ slug: ref })).first();
    if (!r) return undefined;
    const m = (await this.db('classifier_metrics').where({ classifier_id: r.id, tenant_id: tenantId }).first()) as { metrics: string } | undefined;
    return { ...fromRow(r), metrics: m ? json<ClassifierMetrics | null>(m.metrics, null) : null };
  }

  async create(tenantId: string, input: z.infer<typeof newClassifierSchema>, by: { userId: string; name: string }): Promise<ClassifierRow> {
    const slug = input.slug ?? input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 63);
    if (!slug) throw new HttpProblem(422, 'Invalid classifier', 'The name needs letters or digits.');
    if (await this.get(tenantId, slug)) throw conflict(`A classifier named ${slug} exists.`);
    if ((input.engine === 'guard' || input.engine === 'llm') && !input.profile) throw new HttpProblem(422, 'Invalid classifier', 'A model-based classifier needs the profile that routes to its model.');
    const labels = [...new Set(input.labels)].map((label) => ({ label, threshold: 0.5 }));
    const t = Date.now();
    const row: ClassifierRow = {
      id: ulid(),
      tenant_id: tenantId,
      slug,
      name: input.name,
      engine: input.engine,
      description: input.description ?? null,
      status: 'draft',
      version: 1,
      owner: by.name,
      dataset: input.dataset ?? `${slug}-eval`,
      config: { labels, ...(input.profile ? { profile: input.profile } : {}), ...(input.instructions ? { instructions: input.instructions } : {}), ...(input.engine === 'linear' ? { head: null } : {}) },
      metrics: null,
      created_by: by.userId,
      created_at: t,
      updated_at: t
    };
    const { metrics: _none, ...insert } = row;
    await this.db('classifiers').insert({ ...insert, config: JSON.stringify(row.config) });
    await this.snapshot(row, 'created', by.userId);
    return row;
  }

  private async snapshot(c: ClassifierRow, note: string, by: string | null): Promise<void> {
    await this.db('classifier_versions').insert({ id: ulid(), classifier_id: c.id, tenant_id: c.tenant_id, version: c.version, config: JSON.stringify({ ...c.config, head: c.config.head ? { trainedAt: c.config.head.trainedAt, samples: c.config.head.samples } : c.config.head }), note, created_by: by, created_at: Date.now() });
  }

  async versions(c: ClassifierRow) {
    const rows = (await this.db('classifier_versions').where({ classifier_id: c.id }).orderBy('version', 'desc').limit(50)) as Record<string, unknown>[];
    return rows.map((r) => ({ version: Number(r.version), note: r.note, createdBy: r.created_by, createdAt: Number(r.created_at), labels: json<ClassifierConfig>(r.config, { labels: [] }).labels }));
  }

  /** Thresholds, profile or instructions: every change is a new version. */
  async update(c: ClassifierRow, patch: { thresholds?: Record<string, number>; profile?: string; instructions?: string; dataset?: string; description?: string }, by: string): Promise<ClassifierRow> {
    const config: ClassifierConfig = { ...c.config, labels: c.config.labels.map((l) => ({ ...l })) };
    for (const [label, thr] of Object.entries(patch.thresholds ?? {})) {
      const l = config.labels.find((x) => x.label === label);
      if (!l) throw new HttpProblem(422, 'Invalid threshold', `${c.name} has no label ${label}.`);
      l.threshold = Math.round(thr * 100) / 100;
    }
    if (patch.profile !== undefined) {
      if (c.engine !== 'guard' && c.engine !== 'llm') throw conflict('Only model-based classifiers route through a profile.');
      config.profile = patch.profile;
    }
    if (patch.instructions !== undefined) config.instructions = patch.instructions;
    const next: ClassifierRow = { ...c, config, version: c.version + 1, dataset: patch.dataset ?? c.dataset, description: patch.description ?? c.description, updated_at: Date.now() };
    await this.db('classifiers').where({ id: c.id }).update({ config: JSON.stringify(config), version: next.version, dataset: next.dataset, description: next.description, updated_at: next.updated_at });
    const changed = Object.keys(patch.thresholds ?? {});
    await this.snapshot(next, changed.length ? `threshold ${changed.join(', ')}` : 'settings', by);
    return next;
  }

  async publish(c: ClassifierRow): Promise<ClassifierRow> {
    if (c.status === 'published') return c;
    const counts = await this.sampleCounts(c.tenant_id!, c);
    const short = c.config.labels.filter((l) => (counts[l.label] ?? 0) < MIN_SAMPLES);
    if (short.length) {
      throw new HttpProblem(409, 'Eval set too small', `${short.map((l) => `${l.label} has ${counts[l.label] ?? 0}`).join(', ')} samples. A classifier publishes only after an evaluation with at least ${MIN_SAMPLES} samples per label.`, { extensions: { counts, minimum: MIN_SAMPLES } });
    }
    if (!c.metrics || c.metrics.at < c.updated_at) throw conflict('Run an evaluation of this version before publishing it.');
    if (c.engine === 'linear' && !c.config.head) throw conflict('Train the classifier before publishing it.');
    await this.db('classifiers').where({ id: c.id }).update({ status: 'published', updated_at: Date.now() });
    return { ...c, status: 'published' };
  }

  // ---------- scoring ----------

  async score(tenantId: string, c: ClassifierRow, text: string, label: Label): Promise<ScoreResult> {
    const t0 = performance.now();
    let scores: Record<string, number> = {};
    let spans: Detection[] = [];
    const labels = c.config.labels.map((l) => l.label);
    if (c.engine === 'deterministic') {
      spans = c.config.family === 'secrets' ? detectSecrets(text, labels) : detectPii(text, labels);
      for (const l of labels) scores[l] = spans.filter((d) => d.kind === l).reduce((a, d) => Math.max(a, d.score), 0);
    } else if (c.engine === 'linear') {
      if (!c.config.head) throw new Error(`${c.name} has not been trained yet`);
      scores = scoreLinear(c.config.head, text);
    } else if (c.engine === 'guard') {
      const out = await complete(this.gateway, tenantId, c.config.profile ?? 'llama-guard', label, guardMessages(text, false));
      const v = parseGuardVerdict(out.text);
      for (const l of labels) scores[l] = v.categories.includes(l) ? 1 : 0;
    } else {
      const prompt = `Classify the text into exactly one of these labels: ${labels.join(', ')}.${c.config.instructions ? ` ${c.config.instructions}` : ''} Answer with JSON only, in the form {"label": "<one of the labels>", "confidence": <a number from 0 to 1>}.`;
      const out = await complete(this.gateway, tenantId, c.config.profile ?? '', label, [{ role: 'system', content: prompt }, { role: 'user', content: text }]);
      const m = /\{[\s\S]*\}/.exec(out.text);
      let parsed: { label?: unknown; confidence?: unknown } = {};
      try {
        parsed = m ? (JSON.parse(m[0]) as typeof parsed) : {};
      } catch {
        parsed = {};
      }
      if (typeof parsed.label !== 'string' || !labels.includes(parsed.label)) throw new Error(`The model did not answer with one of the labels: "${out.text.trim().slice(0, 60)}"`);
      const conf = typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 1;
      for (const l of labels) scores[l] = l === parsed.label ? conf : 0;
    }
    const thr = new Map(c.config.labels.map((l) => [l.label, l.threshold]));
    const hits = labels.filter((l) => (scores[l] ?? 0) >= (thr.get(l) ?? 0.5) && (scores[l] ?? 0) > 0);
    const top = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    return { scores, spans, top: top ? { label: top[0], score: top[1] } : null, hits, engine: c.engine, ms: Math.round((performance.now() - t0) * 10) / 10 };
  }

  // ---------- datasets ----------

  async sampleCounts(tenantId: string, c: ClassifierRow): Promise<Record<string, number>> {
    if (!c.dataset) return {};
    const rows = (await this.db('eval_cases').where({ tenant_id: tenantId, eval_set: c.dataset }).groupBy('expected').select('expected').count({ n: '*' })) as { expected: string; n: number | string }[];
    return Object.fromEntries(rows.map((r) => [r.expected, Number(r.n)]));
  }

  async addCases(tenantId: string, evalSet: string, items: { text: string; expected: string; label?: Label; flagId?: string; ruleId?: string }[], by: string | null): Promise<number> {
    const t = Date.now();
    for (const it of items) {
      const id = ulid();
      await this.db('eval_cases').insert({ id, tenant_id: tenantId, eval_set: evalSet, expected: it.expected, text: await this.keys.seal(tenantId, it.text, `eval:${id}`), label: it.label ?? 'internal', flag_id: it.flagId ?? null, rule_id: it.ruleId ?? null, created_by: by, created_at: t });
    }
    return items.length;
  }

  async evalSets(tenantId: string): Promise<{ name: string; cases: number }[]> {
    const rows = (await this.db('eval_cases').where({ tenant_id: tenantId }).groupBy('eval_set').select('eval_set').count({ n: '*' })) as { eval_set: string; n: number | string }[];
    return rows.map((r) => ({ name: r.eval_set, cases: Number(r.n) })).sort((a, b) => a.name.localeCompare(b.name));
  }

  private async cases(tenantId: string, evalSet: string): Promise<{ id: string; text: string; expected: string; label: Label }[]> {
    const rows = (await this.db('eval_cases').where({ tenant_id: tenantId, eval_set: evalSet }).orderBy('id').limit(20_000)) as { id: string; text: string; expected: string; label: Label }[];
    return Promise.all(rows.map(async (r) => ({ id: r.id, expected: r.expected, label: r.label, text: await this.keys.open(tenantId, r.text, `eval:${r.id}`) })));
  }

  // ---------- jobs ----------

  /** Scores every case in the dataset and computes precision and recall per label at the current thresholds. */
  private async evaluateJob(tenantId: string, id: string, ctx: JobContext): Promise<unknown> {
    const c = await this.get(tenantId, id);
    if (!c) throw new Error('Classifier not found');
    const all = await this.cases(tenantId, c.dataset ?? `${c.slug}-eval`);
    if (!all.length) throw new Error(`The dataset ${c.dataset} has no labelled cases yet`);
    // A trained head is measured on the cases it was not trained on.
    const held = c.engine === 'linear' ? all.filter((x) => heldOut(x.id)) : [];
    const cases = held.length ? held : all;
    const labels = c.config.labels.map((l) => l.label);
    const thr = new Map(c.config.labels.map((l) => [l.label, l.threshold]));
    const points: Record<string, [number, number][]> = Object.fromEntries(labels.map((l) => [l, []]));
    const distribution: Record<string, number> = {};
    let errors = 0;
    for (const [i, cs] of cases.entries()) {
      if (ctx.signal.aborted) throw new Error('cancelled');
      try {
        const r = await this.score(tenantId, c, cs.text, cs.label);
        for (const l of labels) points[l]!.push([r.scores[l] ?? 0, cs.expected === l ? 1 : 0]);
        const top = r.hits.length ? r.hits.sort((a, b) => (r.scores[b] ?? 0) - (r.scores[a] ?? 0))[0]! : 'none';
        distribution[top] = (distribution[top] ?? 0) + 1;
      } catch {
        errors++;
      }
      if ((i + 1) % 25 === 0 || i === cases.length - 1) {
        const dist = Object.entries(distribution).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
        await ctx.progress(((i + 1) / cases.length) * 100, `${i + 1} of ${cases.length} classified: ${dist}`);
      }
    }
    const perLabel: Record<string, LabelMetrics> = {};
    for (const l of labels) {
      const t = thr.get(l) ?? 0.5;
      const pts = points[l]!;
      const tp = pts.filter(([s, y]) => y && s >= t && s > 0).length;
      const fp = pts.filter(([s, y]) => !y && s >= t && s > 0).length;
      const fn = pts.filter(([s, y]) => y && !(s >= t && s > 0)).length;
      perLabel[l] = { precision: tp + fp ? round(tp / (tp + fp)) : null, recall: tp + fn ? round(tp / (tp + fn)) : null, n: pts.filter(([, y]) => y).length, tp, fp, fn };
      points[l] = pts.slice(0, 5000).map(([s, y]) => [round(s), y]);
    }
    const metrics: ClassifierMetrics = { at: Date.now(), dataset: c.dataset ?? '', samples: cases.length, heldOut: held.length > 0, perLabel, points, distribution, errors };
    const n = await this.db('classifier_metrics').where({ classifier_id: c.id, tenant_id: tenantId }).update({ metrics: JSON.stringify(metrics), updated_at: metrics.at });
    if (!n) await this.db('classifier_metrics').insert({ classifier_id: c.id, tenant_id: tenantId, metrics: JSON.stringify(metrics), updated_at: metrics.at });
    return { samples: cases.length, perLabel, distribution, errors };
  }

  /** Trains the linear head on four fifths of the dataset (a fixed split by case id) and evaluates it on the rest. */
  private async trainJob(tenantId: string, id: string, ctx: JobContext): Promise<unknown> {
    const c = await this.get(tenantId, id);
    if (!c) throw new Error('Classifier not found');
    if (c.engine !== 'linear') throw new Error('Only the linear engine is trained here');
    const cases = await this.cases(tenantId, c.dataset ?? `${c.slug}-eval`);
    if (cases.length < 2) throw new Error('Training needs labelled cases in the dataset');
    await ctx.progress(5, `Training on ${cases.length} cases`);
    const train = cases.filter((x) => !heldOut(x.id));
    const head = trainLinear((train.length ? train : cases).map((x) => ({ text: x.text, expected: x.expected })), c.config.labels.map((l) => l.label));
    const next = { ...c.config, head };
    await this.db('classifiers').where({ id: c.id }).update({ config: JSON.stringify(next), version: c.version + 1, updated_at: Date.now() });
    await this.snapshot({ ...c, config: next, version: c.version + 1 }, `trained on ${cases.length} cases`, ctx.job.created_by);
    await ctx.progress(60, 'Evaluating');
    return { trained: cases.length, evaluation: await this.evaluateJob(tenantId, id, ctx) };
  }

  async requireOwn(tenantId: string, ref: string): Promise<ClassifierRow> {
    const c = await this.get(tenantId, ref);
    if (!c) throw notFound('Classifier');
    return c;
  }
}

const round = (v: number) => Math.round(v * 1000) / 1000;
/** One case in five, fixed by its id, is held out of training. */
const heldOut = (id: string) => createHash('sha256').update(id).digest()[0]! % 5 === 0;
