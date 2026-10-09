import { ulid } from 'ulid';
import { actorFrom } from '../audit/chain.js';
import type { Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { loadPrincipal } from '../http/middleware.js';
import { badRequest, conflict, notFound } from '../http/problem.js';
import type { JobContext } from '../platform/jobs.js';
import type { Services } from '../services.js';
import { costOf } from '../tenancy/analytics.js';
import { generate } from './ai.js';
import { renderAiPrompt, type Field } from './schema.js';
import type { Actor, AppRow, AppService, EntityRow } from './service.js';

/*
 * AI fills over every row (1.6.0, B-8402). A designer fills or refreshes one AI field of an entity for every record
 * (or only the records where it is empty) as one job: an estimate first (records, tokens, and the cost when the
 * tenant has a price for the profile's model), progress as it runs, and a cancel that stops it between records.
 * Each record is filled as the single-record fill does (the profile's guardrails, the tenant's quota, metering), and
 * the fill's own token totals are kept on the fill.
 */

export type FillScope = 'empty' | 'all';
export type FillState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface FillRow {
  id: string;
  tenant_id: string;
  app_id: string;
  entity_id: string;
  field: string;
  scope: FillScope;
  state: FillState;
  total: number;
  done: number;
  failed: number;
  skipped: number;
  prompt_tokens: number;
  output_tokens: number;
  estimate: Estimate | null;
  job_id: string | null;
  started_by: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface Estimate {
  records: number;
  capped: boolean;
  promptTokens: number;
  outputTokens: number;
  model: string | null;
  currency: string | null;
  cost: number | null;
}

const num = (v: unknown) => (v == null ? null : Number(v));
const fromRow = (r: Record<string, unknown>): FillRow => ({ ...(r as unknown as FillRow), total: Number(r.total), done: Number(r.done), failed: Number(r.failed), skipped: Number(r.skipped), prompt_tokens: Number(r.prompt_tokens), output_tokens: Number(r.output_tokens), estimate: json<Estimate | null>(r.estimate, null), created_at: Number(r.created_at), started_at: num(r.started_at), finished_at: num(r.finished_at) });

export const fillView = (f: FillRow) => ({ id: f.id, field: f.field, scope: f.scope, state: f.state, total: f.total, done: f.done, failed: f.failed, skipped: f.skipped, promptTokens: f.prompt_tokens, outputTokens: f.output_tokens, estimate: f.estimate, jobId: f.job_id, startedBy: f.started_by, error: f.error, createdAt: f.created_at, startedAt: f.started_at, finishedAt: f.finished_at });

export class AppAiFills {
  constructor(
    private readonly s: () => Services,
    private readonly apps: AppService
  ) {}

  private get db() {
    return this.s().db;
  }

  registerJobs(): void {
    this.s().jobs.register('apps.ai-fill-all', (p, ctx) => this.run(String(p.fillId), ctx), { timeoutMs: 6 * 60 * 60_000 });
  }

  private aiField(entity: EntityRow, name: string): Extract<Field, { type: 'ai' }> {
    const f = entity.definition.fields.find((x) => x.name === name);
    if (!f || f.type !== 'ai') throw badRequest(`${name} is not an AI field of ${entity.name}.`);
    return f;
  }

  /** The records a fill would cover, paged by id; `empty` keeps those where the field is empty. */
  private async *candidates(entity: EntityRow, field: string, scope: FillScope, max: number) {
    let after = '';
    let n = 0;
    for (;;) {
      const rows = ((await this.db('app_records').where({ entity_id: entity.id }).andWhere('id', '>', after).orderBy('id').limit(200)) as Record<string, unknown>[]).map((r) => ({ id: String(r.id), data: String(r.data), tenant_id: String(r.tenant_id), version: Number(r.version) }));
      if (!rows.length) return;
      for (const r of rows) {
        after = r.id;
        const values = json<Record<string, unknown>>(await this.s().keys.open(r.tenant_id, r.data, `app-record:${r.id}`), {});
        if (scope === 'empty' && values[field] != null && values[field] !== '') continue;
        if (++n > max) {
          yield { id: r.id, values, over: true };
          return;
        }
        yield { id: r.id, values, over: false };
      }
    }
  }

  /** What a fill would cost (B-8402): records, tokens from a sample of rendered prompts, money when a price is set. */
  async estimate(p: Principal, app: AppRow, entity: EntityRow, field: string, scope: FillScope): Promise<Estimate> {
    const s = this.s();
    const f = this.aiField(entity, field);
    const max = s.cfg.APPS_AI_FILL_MAX_ROWS;
    let records = 0;
    let capped = false;
    let sampleChars = 0;
    let sampled = 0;
    for await (const c of this.candidates(entity, field, scope, max)) {
      if (c.over) {
        capped = true;
        break;
      }
      records++;
      if (sampled < 50) {
        sampleChars += renderAiPrompt(entity.definition, f, c.values).length;
        sampled++;
      }
    }
    const perPrompt = sampled ? Math.ceil(sampleChars / sampled / 4) + 20 : 0;
    const promptTokens = records * perPrompt;
    const outputTokens = records * Math.ceil(Math.min(f.maxLength, 600) / 4);
    let model: string | null = null;
    let currency: string | null = null;
    let cost: number | null = null;
    try {
      const r = await s.gateway.resolve(p.tenantId, f.profile);
      model = r.model.name;
      const prices = await s.analytics.prices(p.tenantId);
      const price = prices.find((x) => x.scope === 'model' && x.ref === model);
      if (price) {
        currency = price.currency;
        cost = costOf({ prompt: promptTokens, output: outputTokens, gpuMs: 0 }, price);
      }
    } catch {
      // no profile or model: the estimate still counts records and tokens
    }
    void app;
    return { records, capped, promptTokens, outputTokens, model, currency, cost };
  }

  async list(entity: EntityRow, limit = 20): Promise<FillRow[]> {
    return ((await this.db('app_ai_fills').where({ entity_id: entity.id }).orderBy('created_at', 'desc').limit(limit)) as Record<string, unknown>[]).map(fromRow);
  }

  async get(entity: EntityRow, id: string): Promise<FillRow> {
    const r = await this.db('app_ai_fills').where({ id, entity_id: entity.id }).first();
    if (!r) throw notFound('Fill');
    return fromRow(r);
  }

  async start(actor: Actor & { principal: Principal }, app: AppRow, entity: EntityRow, field: string, scope: FillScope): Promise<FillRow> {
    const p = actor.principal;
    const s = this.s();
    this.aiField(entity, field);
    const running = await this.db('app_ai_fills').where({ entity_id: entity.id, field }).whereIn('state', ['queued', 'running']).first('id');
    if (running) throw conflict(`A fill of ${field} is already running (${String(running.id)}).`);
    const estimate = await this.estimate(p, app, entity, field, scope);
    const id = ulid();
    const t = Date.now();
    await this.db('app_ai_fills').insert({ id, tenant_id: p.tenantId, app_id: app.id, entity_id: entity.id, field, scope, state: 'queued', total: estimate.records, done: 0, failed: 0, skipped: 0, prompt_tokens: 0, output_tokens: 0, estimate: JSON.stringify(estimate), job_id: null, started_by: p.userId, error: null, created_at: t, started_at: null, finished_at: null });
    const job = await s.jobs.enqueue({ tenantId: p.tenantId, type: 'apps.ai-fill-all', payload: { fillId: id }, createdBy: p.userId, maxAttempts: 1 });
    await this.db('app_ai_fills').where({ id }).update({ job_id: job.id });
    await s.audit.append({ tenantId: p.tenantId, action: 'app.ai.fill.started', kind: 'admin', actor: actorFrom(p, actor.ip ?? null), target: { app: app.id, entity: entity.id, name: entity.name, fill: id }, label: entity.label, detail: { field, scope, estimate }, traceId: actor.traceId ?? null });
    return (await this.get(entity, id))!;
  }

  async cancel(actor: Actor & { principal: Principal }, app: AppRow, entity: EntityRow, id: string): Promise<FillRow> {
    const p = actor.principal;
    const f = await this.get(entity, id);
    if (f.state !== 'queued' && f.state !== 'running') throw conflict(`The fill is ${f.state}.`);
    await this.db('app_ai_fills').where({ id }).whereIn('state', ['queued', 'running']).update({ state: 'cancelled', finished_at: Date.now() });
    if (f.job_id) await this.s().jobs.cancel(p.tenantId, f.job_id).catch(() => undefined);
    await this.s().audit.append({ tenantId: p.tenantId, action: 'app.ai.fill.cancelled', kind: 'admin', actor: actorFrom(p, actor.ip ?? null), target: { app: app.id, entity: entity.id, name: entity.name, fill: id }, label: entity.label, detail: { field: f.field, done: f.done }, traceId: actor.traceId ?? null });
    return this.get(entity, id);
  }

  private async run(fillId: string, ctx: JobContext): Promise<unknown> {
    const s = this.s();
    const raw = await this.db('app_ai_fills').where({ id: fillId }).first();
    if (!raw) return { skipped: 'gone' };
    const fill = fromRow(raw);
    if (fill.state !== 'queued') return { skipped: fill.state };
    const entity = await this.apps.entityById(fill.tenant_id, fill.entity_id);
    const app = entity ? await this.apps.appById(fill.tenant_id, entity.app_id) : undefined;
    if (!entity || !app) {
      await this.db('app_ai_fills').where({ id: fillId }).update({ state: 'failed', error: 'the entity is gone', finished_at: Date.now() });
      return { skipped: 'gone' };
    }
    const f = entity.definition.fields.find((x): x is Extract<Field, { type: 'ai' }> => x.type === 'ai' && x.name === fill.field);
    if (!f) {
      await this.db('app_ai_fills').where({ id: fillId }).update({ state: 'failed', error: `${fill.field} is no longer an AI field`, finished_at: Date.now() });
      return { skipped: 'field gone' };
    }
    await this.db('app_ai_fills').where({ id: fillId }).update({ state: 'running', started_at: Date.now() });
    const principal = fill.started_by ? await loadPrincipal(s, fill.tenant_id, fill.started_by, {}) : null;
    if (principal) principal.workspaceId = app.workspace_id;
    const usage = { prompt: 0, output: 0, gpuMs: 0, model: null as string | null };
    let done = 0;
    let failed = 0;
    let skipped = 0;
    let cancelled = false;
    let i = 0;
    const stillRunning = async () => String((await this.db('app_ai_fills').where({ id: fillId }).first('state'))?.state) === 'running';
    for await (const c of this.candidates(entity, fill.field, fill.scope, s.cfg.APPS_AI_FILL_MAX_ROWS)) {
      if (c.over) {
        skipped++;
        break;
      }
      if (ctx.signal.aborted || (i % 10 === 0 && !(await stillRunning()))) {
        cancelled = true;
        break;
      }
      i++;
      const label = String((await this.db('app_records').where({ id: c.id }).first('label'))?.label ?? entity.label) as EntityRow['label'];
      try {
        const text = (await generate(s, { tenantId: fill.tenant_id, workspaceId: app.workspace_id, profile: f.profile, prompt: renderAiPrompt(entity.definition, f, c.values), label, principal, userId: fill.started_by, usage, source: { kind: 'app-fill', id: fillId } })).trim();
        if (!text) throw new Error('the model gave an empty answer');
        if (await this.apps.writeAiField(c.id, fill.field, [...text].slice(0, f.maxLength).join(''), null)) done++;
        else skipped++;
      } catch (err) {
        failed++;
        await this.apps.writeAiField(c.id, fill.field, null, ((err as Error).message || 'the model call failed').slice(0, 200)).catch(() => undefined);
      }
      await this.db('app_ai_fills').where({ id: fillId }).update({ done, failed, skipped, prompt_tokens: usage.prompt, output_tokens: usage.output });
      await ctx.progress(fill.total ? Math.min(99, Math.round(((done + failed + skipped) * 100) / fill.total)) : 99, `${done + failed} of ${fill.total} records`);
    }
    const state: FillState = cancelled ? 'cancelled' : failed && !done ? 'failed' : 'succeeded';
    await this.db('app_ai_fills').where({ id: fillId }).whereIn('state', ['running', 'cancelled']).update({ state, done, failed, skipped, prompt_tokens: usage.prompt, output_tokens: usage.output, finished_at: Date.now(), ...(state === 'failed' ? { error: 'every record failed' } : {}) });
    await s.audit.append({ tenantId: fill.tenant_id, action: 'app.ai.fill.finished', kind: 'system', actor: { service: 'apps.ai' }, target: { app: app.id, entity: entity.id, name: entity.name, fill: fillId }, label: entity.label, detail: { state, field: fill.field, done, failed, skipped, promptTokens: usage.prompt, outputTokens: usage.output, model: usage.model } });
    return { state, done, failed, skipped };
  }
}
