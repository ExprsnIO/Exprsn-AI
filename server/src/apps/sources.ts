import { z } from 'zod';
import { actorFrom, PLATFORM_TENANT } from '../audit/chain.js';
import { labelRank } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import type { RowMutation } from '../connections/drivers.js';
import { allowed } from '../connections/service.js';
import { json } from '../db/knex.js';
import { badRequest, conflict, HttpProblem, notFound } from '../http/problem.js';
import type { JobContext, Scheduler } from '../platform/jobs.js';
import type { Services } from '../services.js';
import { nameSchema, type EntityDefinition, type Field, type Values } from './schema.js';
import type { Actor, AppRow, AppService, EntityRow, RecordRow } from './service.js';

/*
 * Outside tables as entities (1.6.0, B-8501). An entity can be backed by a table (or view) in an outside PostgreSQL
 * or MySQL database reached through a data connection: a pull reads the allow-listed table and writes its rows as the
 * entity's records (keyed by the table's key column, kept in `app_records.external_key`), so the records are
 * searched, filtered, policed, labelled and sealed like any other; with writes on, a record written in the app
 * reaches the table at once (insert, update, delete, and the state when a state column is mapped) before the
 * local write, so a refused outside write changes nothing here. Pulls run as the job `apps.source-pull`, on demand
 * or every `pullMinutes` from the apps schedule tick; rows missing from the table remove their records when
 * `deleteMissing` is on. Only designers who also manage connections attach a table (it reads the table unmasked), and
 * the entity's label must cover the connection's.
 */

export interface SourceRow {
  entity_id: string;
  tenant_id: string;
  app_id: string;
  connection_id: string;
  object: string;
  key_column: string;
  key_field: string | null;
  columns: Record<string, string>;
  state_column: string | null;
  writes: boolean;
  delete_missing: boolean;
  pull_minutes: number | null;
  enabled: boolean;
  next_pull_at: number | null;
  last_pull_at: number | null;
  last_pull_result: PullResult | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface PullResult {
  rows: number;
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  failed: number;
  capped: boolean;
  ms: number;
  error?: string;
  problems?: string[];
}

const COLUMN = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const columnName = z.string().regex(COLUMN, 'a plain column name');

export const sourceInputSchema = z
  .object({
    connectionId: z.string().length(26),
    object: z.string().trim().min(1).max(200),
    keyColumn: columnName,
    /** The field the key column maps to; empty when the key is the record id (then the key column must take text). */
    keyField: nameSchema.nullable().default(null),
    /** Field to column; a field not named maps to the column of the same name. */
    columns: z.record(nameSchema, columnName).default({}),
    stateColumn: columnName.nullable().default(null),
    writes: z.boolean().default(false),
    deleteMissing: z.boolean().default(true),
    pullMinutes: z.number().int().min(1).max(10_080).nullable().default(null),
    enabled: z.boolean().default(true)
  })
  .strict();
export type SourceInput = z.infer<typeof sourceInputSchema>;

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const fromRow = (r: Record<string, unknown>): SourceRow => ({
  ...(r as unknown as SourceRow),
  columns: json<Record<string, string>>(r.columns, {}),
  writes: !!r.writes,
  delete_missing: !!r.delete_missing,
  enabled: !!r.enabled,
  pull_minutes: num(r.pull_minutes),
  next_pull_at: num(r.next_pull_at),
  last_pull_at: num(r.last_pull_at),
  last_pull_result: json<PullResult | null>(r.last_pull_result, null),
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at)
});

export const sourceView = (x: SourceRow, entity: string, connection: { name: string; engine: string } | null) => ({
  entity,
  connectionId: x.connection_id,
  connection: connection?.name ?? null,
  engine: connection?.engine ?? null,
  object: x.object,
  keyColumn: x.key_column,
  keyField: x.key_field,
  columns: x.columns,
  stateColumn: x.state_column,
  writes: x.writes,
  deleteMissing: x.delete_missing,
  pullMinutes: x.pull_minutes,
  enabled: x.enabled,
  nextPullAt: x.next_pull_at,
  lastPullAt: x.last_pull_at,
  lastPull: x.last_pull_result,
  updatedAt: x.updated_at
});

/** Turns an outside value into what a field of this type stores. */
export function fromColumn(f: Field, v: unknown): unknown {
  if (v == null) return null;
  switch (f.type) {
    case 'number': {
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : null;
    }
    case 'boolean':
      return typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : /^(1|true|t|yes|y)$/i.test(String(v));
    case 'date': {
      const d = v instanceof Date ? v : new Date(String(v));
      if (Number.isNaN(d.getTime())) return typeof v === 'string' ? v : null;
      return f.withTime ? d.toISOString() : d.toISOString().slice(0, 10);
    }
    case 'json':
      if (typeof v === 'string') {
        try {
          return JSON.parse(v) as unknown;
        } catch {
          return v;
        }
      }
      return v;
    case 'formula':
    case 'ai':
      return undefined;
    default:
      return typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
}

/** Turns a field's value into what the outside column takes. */
export function toColumn(f: Field | undefined, v: unknown): unknown {
  if (v == null) return null;
  if (f?.type === 'json') return JSON.stringify(v);
  if (f?.type === 'date' && !f.withTime && typeof v === 'string') return v.slice(0, 10);
  if (typeof v === 'object' && !(v instanceof Date)) return JSON.stringify(v);
  return v;
}

export class AppSources {
  constructor(
    private readonly s: () => Services,
    private readonly apps: AppService
  ) {}

  private get db() {
    return this.s().db;
  }

  registerJobs(): void {
    const jobs = this.s().jobs;
    jobs.register('apps.source-pull', (p, ctx) => this.pull(String(p.entityId), ctx), { timeoutMs: 60 * 60_000 });
    jobs.register('apps.source-schedules', async () => this.tick(), { timeoutMs: 10 * 60_000 });
  }

  schedule(scheduler: Scheduler, everyMs: number): void {
    scheduler.every('apps.source-schedules', everyMs, async () => [{ tenantId: PLATFORM_TENANT, key: 'all' }]);
  }

  // ---------- design ----------

  async of(entity: Pick<EntityRow, 'id'>): Promise<SourceRow | null> {
    const r = await this.db('app_entity_sources').where({ entity_id: entity.id }).first();
    return r ? fromRow(r) : null;
  }

  async list(app: AppRow): Promise<SourceRow[]> {
    return ((await this.db('app_entity_sources').where({ app_id: app.id })) as Record<string, unknown>[]).map(fromRow);
  }

  private async connectionOf(tenantId: string, id: string) {
    return this.s()
      .connections.get(tenantId, id)
      .catch(() => null);
  }

  async view(x: SourceRow, entityName: string) {
    const c = await this.connectionOf(x.tenant_id, x.connection_id);
    return sourceView(x, entityName, c ? { name: c.name, engine: c.engine } : null);
  }

  /** Checks the mapping against the entity: the key field is a plain text field, mapped fields exist and are plain. */
  static check(def: EntityDefinition, input: SourceInput): void {
    const byName = new Map(def.fields.map((f) => [f.name, f]));
    if (input.keyField) {
      const f = byName.get(input.keyField);
      if (!f) throw badRequest(`There is no field ${input.keyField} for the key column.`);
      if (!['string', 'number'].includes(f.type)) throw badRequest(`The key field ${input.keyField} must be a string or number field.`);
    }
    for (const [field, col] of Object.entries(input.columns)) {
      const f = byName.get(field);
      if (!f) throw badRequest(`There is no field ${field} to map to the column ${col}.`);
      if (f.type === 'formula' || f.type === 'ai') throw badRequest(`${field} is computed; it cannot map to a column.`);
    }
    if (input.stateColumn && !def.states) throw badRequest('The entity has no state machine for a state column.');
  }

  async set(actor: Actor & { principal: Principal }, app: AppRow, entity: EntityRow, input: SourceInput): Promise<SourceRow> {
    const p = actor.principal;
    const s = this.s();
    AppSources.check(entity.definition, input);
    const c = await s.connections.get(p.tenantId, input.connectionId);
    if (c.engine !== 'postgres' && c.engine !== 'mysql') throw conflict('Only a PostgreSQL or MySQL table can back an entity.');
    if (!allowed(c, input.object)) throw conflict(`${input.object} is not on the schema allow-list for ${c.name}.`);
    if (labelRank(entity.label) < labelRank(c.label)) throw conflict(`The connection is labelled ${c.label}; the entity's label (${entity.label}) must cover it.`);
    const existing = await this.of(entity);
    const t = Date.now();
    const row = {
      entity_id: entity.id,
      tenant_id: p.tenantId,
      app_id: app.id,
      connection_id: c.id,
      object: input.object,
      key_column: input.keyColumn,
      key_field: input.keyField,
      columns: JSON.stringify(input.columns),
      state_column: input.stateColumn,
      writes: input.writes,
      delete_missing: input.deleteMissing,
      pull_minutes: input.pullMinutes,
      enabled: input.enabled,
      next_pull_at: input.enabled && input.pullMinutes ? t + input.pullMinutes * 60_000 : null,
      updated_by: p.userId,
      updated_at: t
    };
    if (existing) await this.db('app_entity_sources').where({ entity_id: entity.id }).update(row);
    else await this.db('app_entity_sources').insert({ ...row, last_pull_at: null, last_pull_result: null, created_by: p.userId, created_at: t });
    await s.audit.append({ tenantId: p.tenantId, action: existing ? 'app.entity.source.updated' : 'app.entity.source.set', kind: 'admin', actor: actorFrom(p, actor.ip ?? null), target: { app: app.id, entity: entity.id, name: entity.name, connection: c.id }, label: entity.label, detail: { object: input.object, keyColumn: input.keyColumn, writes: input.writes, pullMinutes: input.pullMinutes, deleteMissing: input.deleteMissing }, traceId: actor.traceId ?? null });
    return (await this.of(entity))!;
  }

  async remove(actor: Actor & { principal: Principal }, app: AppRow, entity: EntityRow): Promise<void> {
    const p = actor.principal;
    const existing = await this.of(entity);
    if (!existing) throw notFound('Source');
    await this.db('app_entity_sources').where({ entity_id: entity.id }).delete();
    await this.s().audit.append({ tenantId: p.tenantId, action: 'app.entity.source.removed', kind: 'admin', actor: actorFrom(p, actor.ip ?? null), target: { app: app.id, entity: entity.id, name: entity.name, connection: existing.connection_id }, label: entity.label, detail: { object: existing.object }, traceId: actor.traceId ?? null });
  }

  /** Queues a pull now; returns the job. */
  async pullNow(actor: Actor & { principal: Principal }, app: AppRow, entity: EntityRow) {
    const src = await this.of(entity);
    if (!src) throw notFound('Source');
    const job = await this.s().jobs.enqueue({ tenantId: app.tenant_id, type: 'apps.source-pull', payload: { entityId: entity.id }, createdBy: actor.principal.userId, maxAttempts: 1, dedupeKey: `apps.source-pull:${entity.id}:${Date.now()}` });
    return { jobId: job.id };
  }

  // ---------- writes through to the table ----------

  /** The entity's source when the write must reach the table; null for an unsourced entity; 409 when writes are off. */
  async writable(entity: EntityRow, op: 'create' | 'update' | 'delete'): Promise<SourceRow | null> {
    const src = await this.of(entity);
    if (!src) return null;
    if (!src.writes) throw conflict(`${entity.name} is pulled from an outside table; writes through to it are off, so records cannot be ${op === 'create' ? 'created' : op === 'update' ? 'changed' : 'deleted'} here.`);
    return src;
  }

  /** The values with the key field set to the record id when the designer mapped a key field and none was given. */
  withKey(src: SourceRow, id: string, values: Values): Values {
    if (src.key_field && (values[src.key_field] == null || values[src.key_field] === '')) return { ...values, [src.key_field]: id };
    return values;
  }

  checkKeyUnchanged(src: SourceRow, r: RecordRow, values: Values): void {
    if (src.key_field && src.key_field in values && r.external_key != null && String(values[src.key_field]) !== r.external_key) throw conflict(`${src.key_field} is the outside table's key; it cannot change.`);
  }

  private columnOf(src: SourceRow, field: string): string {
    return src.columns[field] ?? field;
  }

  /** Writes one record's change to the table; returns the outside key (for inserts, the key written). */
  async push(app: AppRow, entity: EntityRow, src: SourceRow, w: { kind: 'insert' | 'update' | 'delete'; id: string; key?: string | null; values: Values; state: string | null }): Promise<string> {
    const s = this.s();
    const byName = new Map(entity.definition.fields.map((f) => [f.name, f]));
    const key = w.kind === 'insert' ? (src.key_field ? String(w.values[src.key_field] ?? w.id) : w.id) : w.key;
    if (key == null) throw conflict(`The record ${w.id} has no outside key; pull the table again.`);
    const values: Record<string, unknown> = {};
    for (const [field, v] of Object.entries(w.values)) {
      const f = byName.get(field);
      if (!f || f.type === 'formula' || f.type === 'ai') continue;
      const col = this.columnOf(src, field);
      if (col === src.key_column) continue;
      values[col] = toColumn(f, v);
    }
    if (src.state_column && w.state != null && (w.kind === 'insert' || w.kind === 'update')) values[src.state_column] = w.state;
    if (w.kind === 'update' && !Object.keys(values).length) return key;
    const op: RowMutation = { kind: w.kind, keyColumn: src.key_column, key: this.keyValue(src, byName, key), values };
    const r = await s.connections.mutateRow(app.tenant_id, src.connection_id, src.object, op);
    if (w.kind !== 'insert' && r.affected === 0) throw new HttpProblem(409, 'Row missing outside', `The outside table ${src.object} has no row with ${src.key_column} = ${key}; pull the table again.`);
    return key;
  }

  private keyValue(src: SourceRow, byName: Map<string, Field>, key: string): unknown {
    const f = src.key_field ? byName.get(src.key_field) : undefined;
    return f?.type === 'number' && Number.isFinite(Number(key)) ? Number(key) : key;
  }

  // ---------- pulls ----------

  /** Queues the pulls that are due (the apps schedule tick). */
  async tick(now = Date.now()): Promise<{ queued: number }> {
    const due = ((await this.db('app_entity_sources').where({ enabled: true }).whereNotNull('pull_minutes').andWhere('next_pull_at', '<=', now)) as Record<string, unknown>[]).map(fromRow);
    let queued = 0;
    for (const src of due) {
      const bucket = Math.floor(now / 60_000);
      await this.s().jobs.enqueue({ tenantId: src.tenant_id, type: 'apps.source-pull', payload: { entityId: src.entity_id }, maxAttempts: 1, dedupeKey: `apps.source-pull:${src.entity_id}:${bucket}` });
      await this.db('app_entity_sources').where({ entity_id: src.entity_id }).update({ next_pull_at: now + (src.pull_minutes ?? 60) * 60_000 });
      queued++;
    }
    return { queued };
  }

  async pull(entityId: string, ctx?: JobContext): Promise<PullResult | { skipped: string }> {
    const s = this.s();
    const src = await this.of({ id: entityId });
    if (!src) return { skipped: 'no source' };
    const entity = await this.apps.entityById(src.tenant_id, entityId);
    const app = entity ? await this.apps.appById(src.tenant_id, entity.app_id) : undefined;
    if (!entity || !app) return { skipped: 'gone' };
    const t0 = Date.now();
    const result: PullResult = { rows: 0, created: 0, updated: 0, deleted: 0, unchanged: 0, failed: 0, capped: false, ms: 0 };
    const problems: string[] = [];
    const actor: Actor = { principal: null, source: 'import', service: 'apps.source' };
    try {
      const r = await s.connections.readRowsForApp(src.tenant_id, src.connection_id, src.object, { limit: s.cfg.APPS_SOURCE_PULL_MAX_ROWS });
      result.rows = r.rows.length;
      result.capped = r.capped;
      const at = (col: string) => r.columns.indexOf(col);
      const keyAt = at(src.key_column);
      if (keyAt < 0) throw conflict(`The table has no column ${src.key_column}.`);
      const mapped = entity.definition.fields.filter((f) => f.type !== 'formula' && f.type !== 'ai').map((f) => ({ f, at: at(this.columnOf(src, f.name)) })).filter((m) => m.at >= 0);
      const stateAt = src.state_column ? at(src.state_column) : -1;
      const existing = await this.apps.recordsByExternalKey(entity);
      const seen = new Set<string>();
      let i = 0;
      for (const row of r.rows) {
        if (ctx?.signal.aborted) throw new Error('cancelled');
        const key = row[keyAt] == null ? null : String(row[keyAt]);
        if (key == null) {
          result.failed++;
          continue;
        }
        seen.add(key);
        const values: Values = {};
        for (const m of mapped) {
          const v = fromColumn(m.f, row[m.at]);
          if (v !== undefined) values[m.f.name] = v;
        }
        if (src.key_field && values[src.key_field] == null) values[src.key_field] = key;
        const state = stateAt >= 0 && row[stateAt] != null ? String(row[stateAt]) : null;
        try {
          const out = await this.apps.upsertFromSource(actor, app, entity, key, values, existing.get(key) ?? null, state);
          result[out]++;
        } catch (err) {
          result.failed++;
          if (problems.length < 20) problems.push(`${key}: ${err instanceof HttpProblem ? (err.detail ?? err.title) : (err as Error).message}`.slice(0, 200));
        }
        if (ctx && ++i % 50 === 0) await ctx.progress(Math.min(99, Math.round((i * 100) / r.rows.length)), `${i} of ${r.rows.length} rows`);
      }
      if (src.delete_missing && !r.capped) {
        for (const [key, rec] of existing) {
          if (seen.has(key)) continue;
          await this.apps.deleteFromSource(actor, app, entity, rec);
          result.deleted++;
        }
      }
    } catch (err) {
      result.error = (err instanceof HttpProblem ? (err.detail ?? err.title) : (err as Error).message).slice(0, 300);
    }
    result.ms = Date.now() - t0;
    if (problems.length) result.problems = problems;
    const now = Date.now();
    await this.db('app_entity_sources').where({ entity_id: entityId }).update({ last_pull_at: now, last_pull_result: JSON.stringify(result), ...(src.enabled && src.pull_minutes ? { next_pull_at: now + src.pull_minutes * 60_000 } : {}) });
    await s.audit.append({ tenantId: src.tenant_id, action: result.error ? 'app.entity.source.pull_failed' : 'app.entity.source.pulled', kind: 'system', actor: { service: 'apps.source' }, target: { app: app.id, entity: entity.id, name: entity.name, connection: src.connection_id }, label: entity.label, detail: { ...result, problems: undefined } });
    if (result.error) throw new Error(result.error);
    return result;
  }
}
