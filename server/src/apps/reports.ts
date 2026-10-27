import { ulid } from 'ulid';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { clears, highest, LABELS, labelRank, type Label } from '../authz/labels.js';
import { authorize, effectivePermissions, type Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { Scheduler } from '../platform/jobs.js';
import type { ReadResult } from '../connections/saved-queries.js';
import type { Services } from '../services.js';
import { checkFilterSize, type Filter, type Sort } from './query.js';
import {
  bindReportParams,
  boundLeaves,
  boundSourceParams,
  computeReport,
  type ColumnType,
  type ParamValues,
  type ReportDefinition,
  reportDefinitionSchema,
  type ReportResult,
  type ReportSource,
  type SourceColumn
} from './report-engine.js';
import { nameSchema } from './schema.js';
import type { Actor, AppRow, EntityRow } from './service.js';
import type { ViewSettings } from './views.js';

/*
 * 1.8.0 (B-122): reports of an app (`s.appReports`). A report is a sealed definition (`report-engine.ts`), listed to
 * the app's readers at its label; designers (`apps:design`) write it. A run is always the viewer's: the rows come
 * from the records routes' own query (`AppService.query`, so the reader's row policies, field grants, masks,
 * clearance and the hidden rule apply), or from a saved query (`s.savedQueries.run`) or a REST endpoint
 * (`s.restConnections.read`) as the viewer, who then also needs `connections:query`; the result is held to the app's
 * label. Every total is computed from the rows the viewer was given, so a row they may not read never counts.
 *
 * A run is recorded in the history with its parameters (sealed). Its result is kept, sealed, only for the report's
 * `cacheMinutes` and only for the person who ran it; the sweep clears expired results and keeps the history row.
 * Audited as `app.report.created`, `.updated`, `.deleted`, `.run` and `.run.failed`.
 */

export const REPORT_PREVIEW_LINES = 200;
/** Records read per page from the records query. */
const PAGE = 500;
/** Runs of one person kept per report. */
const HISTORY_KEEP = 50;
export const REPORT_SWEEP_JOB = 'apps.report-cache.sweep';

export const reportInputSchema = z
  .object({
    name: nameSchema,
    label: z.enum(LABELS).optional(),
    definition: reportDefinitionSchema
  })
  .strict();
export const reportPatchSchema = z
  .object({
    label: z.enum(LABELS).optional(),
    definition: reportDefinitionSchema.optional(),
    /** The version the change was made from; a newer one is a 409. */
    version: z.number().int().min(1).optional()
  })
  .strict()
  .refine((v) => v.label !== undefined || v.definition !== undefined, 'nothing to change');
export const runInputSchema = z
  .object({
    params: z.record(z.string().max(63), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])).refine((o) => Object.keys(o).length <= 10, 'at most 10 parameters').optional()
  })
  .strict();

interface ReportRow {
  id: string;
  tenant_id: string;
  app_id: string;
  name: string;
  label: Label;
  source_kind: ReportSource['kind'];
  data: string;
  version: number;
  created_by: string;
  updated_by: string;
  created_at: number;
  updated_at: number;
}
const rowFrom = (r: Record<string, unknown>): ReportRow => ({ ...(r as unknown as ReportRow), version: Number(r.version), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });
const aad = (id: string) => `app-report:${id}`;
const runAad = (id: string) => `app-report-run:${id}`;
const paramsAad = (id: string) => `app-report-run:${id}:params`;

interface RunRow {
  id: string;
  tenant_id: string;
  app_id: string;
  report_id: string;
  user_id: string;
  state: 'succeeded' | 'failed';
  params: string | null;
  rows: number;
  truncated: boolean;
  ms: number;
  label: Label;
  error: string | null;
  result: string | null;
  expires_at: number | null;
  created_at: number;
}
const runFrom = (r: Record<string, unknown>): RunRow => ({ ...(r as unknown as RunRow), rows: Number(r.rows), truncated: !!r.truncated, ms: Number(r.ms), expires_at: r.expires_at == null ? null : Number(r.expires_at), created_at: Number(r.created_at) });

/** What a source gave the viewer: typed columns, rows as objects, whether more matched, the highest label read. */
export interface SourceRows {
  columns: SourceColumn[];
  rows: Record<string, unknown>[];
  truncated: boolean;
  label: Label;
}

export interface ComputeOptions {
  /** Source rows read at most (the definition's cap, or the preview's). */
  cap?: number;
  lineCap?: number;
  /** An extra filter on an entity source (the export's current filters), with the report's own. */
  filter?: Filter;
  /** The order an entity source is read in, when it has no saved view (the records export's sort). */
  sort?: Sort;
  progress?: (done: number, of: number | null) => Promise<void>;
}

/** The filter a saved view's settings mean: its conditions (and or or), and its state filter. */
export function viewFilter(s: Pick<ViewSettings, 'filters' | 'filterMode' | 'state'>): Filter | undefined {
  const leaves: Filter[] = s.filters.map((f) => ({ field: f.field, op: f.op, ...(f.value !== undefined ? { value: f.value } : {}), ...(f.where ? { where: f.where } : {}) }) as Filter);
  const conds: Filter = leaves.length === 1 ? leaves[0]! : s.filterMode === 'or' ? { or: leaves } : { and: leaves };
  const parts: Filter[] = [...(leaves.length ? [conds] : []), ...(s.state ? [{ field: 'state', op: 'eq' as const, value: s.state }] : [])];
  return parts.length === 0 ? undefined : parts.length === 1 ? parts[0] : { and: parts };
}

export const andFilters = (...fs: (Filter | undefined)[]): Filter | undefined => {
  const list = fs.filter((f): f is Filter => !!f);
  return list.length === 0 ? undefined : list.length === 1 ? list[0] : { and: list };
};

const FIELD_TYPE: Record<string, ColumnType> = { number: 'number', boolean: 'boolean' };
const fieldType = (f: EntityRow['definition']['fields'][number]): ColumnType => (f.type === 'date' ? (f.withTime ? 'datetime' : 'date') : (FIELD_TYPE[f.type] ?? 'text'));

export class AppReports {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  private get apps() {
    return this.s().apps;
  }

  registerJobs(): void {
    this.s().jobs.register(REPORT_SWEEP_JOB, async () => ({ cleared: await this.sweep() }));
  }

  /** Every ten minutes, when a cached result has expired. */
  schedule(scheduler: Scheduler): void {
    scheduler.every(REPORT_SWEEP_JOB, 10 * 60_000, async () => ((await this.db('app_report_runs').whereNotNull('result').andWhere('expires_at', '<=', Date.now()).first('id')) ? [{ tenantId: 'platform', key: 'all' }] : []));
  }

  /** Clears cached results that expired (the history rows stay). */
  async sweep(now = Date.now()): Promise<number> {
    return Number(await this.db('app_report_runs').whereNotNull('result').andWhere('expires_at', '<=', now).update({ result: null }));
  }

  private designer(p: Principal): boolean {
    return effectivePermissions(p).has('apps:design');
  }

  private async open(r: ReportRow): Promise<ReportDefinition> {
    const d = json<unknown>(await this.s().keys.open(r.tenant_id, r.data, aad(r.id)), {});
    return reportDefinitionSchema.parse(d);
  }

  private async present(p: Principal, app: AppRow, r: ReportRow) {
    const definition = await this.open(r);
    const needs = ['records:read', ...(r.source_kind === 'entity' ? [] : ['connections:query'])];
    return { id: r.id, app: app.name, name: r.name, title: definition.title, label: r.label, sourceKind: r.source_kind, definition, version: r.version, needs, canEdit: this.designer(p) && clears(p.clearance, r.label), canRun: needs.every((x) => effectivePermissions(p).has(x as never)), createdBy: r.created_by, updatedBy: r.updated_by, createdAt: r.created_at, updatedAt: r.updated_at };
  }

  private async rowOf(p: Principal, app: AppRow, ref: string): Promise<ReportRow> {
    const r = (await this.db('app_reports').where({ tenant_id: p.tenantId, app_id: app.id }).andWhere((q) => q.where({ id: ref }).orWhere({ name: ref })).first()) as Record<string, unknown> | undefined;
    if (!r || !clears(p.clearance, String(r.label) as Label)) throw notFound('Report');
    return rowFrom(r);
  }

  /** A report by id, for the export service: its app must be one the caller sees. */
  async byId(p: Principal, id: string): Promise<{ app: AppRow; row: ReportRow; definition: ReportDefinition }> {
    const r = (await this.db('app_reports').where({ tenant_id: p.tenantId, id }).first()) as Record<string, unknown> | undefined;
    if (!r || !clears(p.clearance, String(r.label) as Label)) throw notFound('Report');
    const row = rowFrom(r);
    const app = await this.apps.app(p, row.app_id);
    return { app, row, definition: await this.open(row) };
  }

  async list(p: Principal, appRef: string) {
    const app = await this.apps.app(p, appRef);
    const rows = ((await this.db('app_reports').where({ tenant_id: p.tenantId, app_id: app.id }).orderBy('name')) as Record<string, unknown>[]).map(rowFrom).filter((r) => clears(p.clearance, r.label));
    return { reports: await Promise.all(rows.map((r) => this.present(p, app, r))), canDesign: this.designer(p) && clears(p.clearance, app.label) };
  }

  async get(p: Principal, appRef: string, ref: string) {
    const app = await this.apps.app(p, appRef);
    return this.present(p, app, await this.rowOf(p, app, ref));
  }

  private label(p: Principal, app: AppRow, floor: Label, wanted: Label | undefined): Label {
    const l = wanted ?? floor;
    if (labelRank(l) < labelRank(floor)) throw badRequest(`This report reads ${floor} records; its label is ${floor} at least.`);
    if (labelRank(l) > labelRank(app.label)) throw badRequest(`The app's label is ${app.label}; a report cannot be above it.`);
    if (!clears(p.clearance, l)) throw forbidden(`Your clearance is ${p.clearance}; a ${l} report is above it.`, { step: 'clearance' });
    return l;
  }

  /** Checks a definition against the app as its designer: the source exists and they may read it, and the layout fits. */
  private async check(p: Principal, app: AppRow, def: ReportDefinition): Promise<Label> {
    const src = def.source;
    if (src.kind === 'entity') {
      const entity = await this.apps.entityOf(app, src.entity);
      if (src.view) {
        const v = (await this.apps.views.list(p, app.id, entity.id)).views.find((x) => x.id === src.view);
        if (!v) throw badRequest(`View ${src.view} is not a view of ${entity.name} you can see.`);
        if (!v.shared) throw badRequest(`View ${v.name} is private; a report reads a shared view, so every reader gets the same settings.`);
      }
      const byName = new Map(entity.definition.fields.map((f) => [f.name, f]));
      const system = new Set(['id', 'state', 'createdAt', 'updatedAt', 'createdBy']);
      for (const f of src.filters) {
        const base = f.field.endsWith('.count') ? f.field.slice(0, -'.count'.length) : f.field;
        const fd = byName.get(base);
        if (!system.has(base) && !fd) throw badRequest(`Filter: ${f.field} is not a field of ${entity.name}.`);
        if (fd && fd.type !== 'relation' && !fd.indexed && !fd.unique) throw badRequest(`Filter: ${f.field} is not indexed, so records cannot be filtered by it. A designer can mark it indexed.`);
      }
      if (src.state != null && !entity.definition.states?.states.some((x) => x.name === src.state)) throw badRequest(`State: ${src.state} is not a state of ${entity.name}.`);
      // the layout, computed columns and formatting against the entity's columns, with no rows
      computeReport({ def, columns: this.entityColumns(entity, null), rows: [], truncated: false, params: {} });
      return entity.label;
    }
    const d = authorize(p, 'connections:query', { tenantId: p.tenantId });
    if (!d.allow) throw forbidden(`A report over a ${src.kind === 'query' ? 'saved query' : 'REST endpoint'} needs connections:query: ${d.reason}.`, { step: d.step });
    if (src.kind === 'query') {
      const q = await this.s().savedQueries.get(p.tenantId, src.query).catch(() => null);
      if (!q || !clears(p.clearance, q.label)) throw badRequest(`There is no saved query ${src.query} you can read.`);
    } else {
      const c = await this.s().restConnections.get(p.tenantId, src.connection).catch(() => null);
      if (!c || !clears(p.clearance, c.label)) throw badRequest(`There is no REST connection ${src.connection} you can read.`);
      if (!(await this.s().restConnections.endpoints(c)).some((e) => e.name === src.endpoint || e.id === src.endpoint)) throw badRequest(`${src.connection} has no endpoint ${src.endpoint}.`);
    }
    return 'public';
  }

  async create(actor: Actor & { principal: Principal }, appRef: string, input: z.infer<typeof reportInputSchema>) {
    const p = actor.principal;
    const app = await this.apps.designable(p, appRef);
    const floor = await this.check(p, app, input.definition);
    const label = this.label(p, app, floor, input.label ?? (input.definition.source.kind === 'entity' ? floor : app.label));
    if (await this.db('app_reports').where({ app_id: app.id, name: input.name }).first('id')) throw conflict(`There is already a report named ${input.name} in ${app.name}.`);
    const id = ulid();
    const now = Date.now();
    const row: ReportRow = { id, tenant_id: p.tenantId, app_id: app.id, name: input.name, label, source_kind: input.definition.source.kind, data: await this.s().keys.seal(p.tenantId, JSON.stringify(input.definition), aad(id)), version: 1, created_by: p.userId, updated_by: p.userId, created_at: now, updated_at: now };
    await this.db('app_reports').insert(row);
    await this.audit(actor, 'app.report.created', { app: app.id, report: id }, label, { name: input.name, source: input.definition.source.kind, layout: input.definition.layout.kind });
    return this.present(p, app, row);
  }

  async update(actor: Actor & { principal: Principal }, appRef: string, ref: string, patch: z.infer<typeof reportPatchSchema>) {
    const p = actor.principal;
    const app = await this.apps.designable(p, appRef);
    const r = await this.rowOf(p, app, ref);
    if (patch.version !== undefined && patch.version !== r.version) throw conflict(`The report changed since version ${patch.version} (it is at ${r.version}); reload it and apply your change again.`);
    const def = patch.definition ?? (await this.open(r));
    const floor = await this.check(p, app, def);
    const label = this.label(p, app, floor, patch.label ?? r.label);
    const now = Date.now();
    const data = patch.definition ? await this.s().keys.seal(r.tenant_id, JSON.stringify(def), aad(r.id)) : r.data;
    const n = await this.db('app_reports').where({ id: r.id, version: r.version }).update({ label, data, source_kind: def.source.kind, version: r.version + 1, updated_by: p.userId, updated_at: now });
    if (!n) throw conflict('The report changed while saving; reload it and apply your change again.');
    // a changed definition makes the cached results of earlier versions stale
    if (patch.definition) await this.db('app_report_runs').where({ report_id: r.id }).update({ result: null });
    await this.audit(actor, 'app.report.updated', { app: app.id, report: r.id }, label, { changed: [...(patch.definition ? ['definition'] : []), ...(patch.label ? ['label'] : [])], version: r.version + 1 });
    return this.present(p, app, { ...r, label, data, source_kind: def.source.kind, version: r.version + 1, updated_by: p.userId, updated_at: now });
  }

  async remove(actor: Actor & { principal: Principal }, appRef: string, ref: string): Promise<void> {
    const p = actor.principal;
    const app = await this.apps.designable(p, appRef);
    const r = await this.rowOf(p, app, ref);
    await this.db.transaction(async (trx) => {
      await trx('app_report_runs').where({ report_id: r.id }).delete();
      await trx('app_reports').where({ id: r.id }).delete();
    });
    await this.audit(actor, 'app.report.deleted', { app: app.id, report: r.id }, r.label, { name: r.name });
  }

  // ---------- sources ----------

  /** An entity's columns for a reader: its fields (relations have none), then the record's own columns as extras. */
  private entityColumns(entity: EntityRow, grant: Awaited<ReturnType<Services['apps']['grantFor']>> | null): SourceColumn[] {
    const cols: SourceColumn[] = [];
    for (const f of entity.definition.fields) {
      if (f.type === 'relation') continue;
      const g = grant?.field(f.name);
      cols.push({ key: f.name, title: f.title || f.name, type: fieldType(f), ...(g && (!g.read || !g.unmasked) ? { masked: true } : {}) });
    }
    if (entity.definition.states) cols.push({ key: 'state', title: 'State', type: 'text', extra: true });
    cols.push({ key: 'id', title: 'Id', type: 'text', extra: true }, { key: 'label', title: 'Label', type: 'text', extra: true }, { key: 'createdAt', title: 'Created', type: 'datetime', extra: true }, { key: 'updatedAt', title: 'Updated', type: 'datetime', extra: true });
    return cols;
  }

  private async readEntity(p: Principal, app: AppRow, src: Extract<ReportSource, { kind: 'entity' }>, params: ParamValues, o: ComputeOptions & { cap: number }): Promise<SourceRows> {
    const entity = await this.apps.entityOf(app, src.entity);
    let fromView: Filter | undefined;
    let q = src.q;
    let sort: Sort = o.sort ?? [];
    let viewColumns: string[] | null = null;
    if (src.view) {
      const v = (await this.apps.views.list(p, app.id, entity.id)).views.find((x) => x.id === src.view);
      if (!v) throw notFound('View');
      fromView = viewFilter(v.settings);
      q = [v.settings.q, q].filter(Boolean).join(' ').trim();
      sort = v.settings.sort;
      viewColumns = v.settings.columns?.fields ?? null;
    }
    const leaves = boundLeaves(src.filters, params) as Filter[];
    const own = leaves.length === 0 ? undefined : leaves.length === 1 ? leaves[0] : src.filterMode === 'or' ? { or: leaves } : { and: leaves };
    const filter = andFilters(fromView, own, src.state ? { field: 'state', op: 'eq', value: src.state } : undefined, o.filter);
    if (filter) checkFilterSize(filter);
    const grant = await this.apps.grantFor(p, entity);
    const columns = this.entityColumns(entity, grant);
    if (viewColumns) {
      // a view's column choice orders the fields it names first
      const order = new Map(viewColumns.map((n, i) => [n, i]));
      for (const c of columns) if (!c.extra && !order.has(c.key)) c.extra = true;
      columns.sort((a, b) => (order.get(a.key) ?? 1e6) - (order.get(b.key) ?? 1e6));
    }
    const rows: Record<string, unknown>[] = [];
    let label: Label = 'public';
    let cursor: string | null = null;
    let total: number | null = null;
    let more = false;
    for (;;) {
      const page = await this.apps.query(p, app.id, entity.id, { ...(filter ? { filter } : {}), ...(q ? { q } : {}), sort, limit: Math.min(PAGE, o.cap + 1 - rows.length), ...(cursor ? { cursor, count: false } : { count: !!o.progress }) });
      if (page.total != null) total = page.total;
      for (const r of page.records) {
        if (rows.length >= o.cap) {
          more = true;
          break;
        }
        rows.push({ ...r.values, id: r.id, state: r.state, label: r.label, createdAt: new Date(r.createdAt).toISOString(), updatedAt: new Date(r.updatedAt).toISOString() });
        label = highest(label, r.label);
      }
      cursor = page.nextCursor;
      if (o.progress) await o.progress(rows.length, total);
      if (more || !cursor) break;
      if (rows.length >= o.cap) {
        more = true;
        break;
      }
    }
    return { columns, rows, truncated: more, label: highest(label, entity.label) };
  }

  private async readConnection(p: Principal, app: AppRow, src: Exclude<ReportSource, { kind: 'entity' }>, params: ParamValues, o: ComputeOptions & { cap: number }): Promise<SourceRows> {
    const d = authorize(p, 'connections:query', { tenantId: p.tenantId });
    if (!d.allow) throw forbidden(`This report reads a ${src.kind === 'query' ? 'saved query' : 'REST endpoint'}, which needs connections:query: ${d.reason}.`, { step: d.step });
    const bound = boundSourceParams(src.params, params);
    const rows: Record<string, unknown>[] = [];
    let columns: SourceColumn[] = [];
    const maskedCols = new Set<string>();
    let label: Label = 'public';
    let cursor: string | null = null;
    let truncated = false;
    for (let pages = 0; pages < 100; pages++) {
      const opts: { limit: number; cursor: string | null; ceiling: Label; via: string } = { limit: Math.min(5000, o.cap + 1 - rows.length), cursor, ceiling: app.label, via: 'app-report' };
      const r: ReadResult = src.kind === 'query' ? await this.s().savedQueries.run(p, src.query, bound, opts) : await this.s().restConnections.read(p, src.connection, src.endpoint, bound, opts);
      label = highest(label, r.label);
      for (const m of r.masked ?? []) maskedCols.add(m);
      if (!columns.length) columns = r.columns.map((c) => ({ key: c.name, title: c.name, type: c.type === 'number' ? 'number' : c.type === 'boolean' ? 'boolean' : 'text' }));
      for (const row of r.rows) {
        if (rows.length >= o.cap) {
          truncated = true;
          break;
        }
        rows.push(row);
      }
      if (o.progress) await o.progress(rows.length, null);
      cursor = r.nextCursor ?? null;
      if (truncated) break;
      if (!cursor) {
        truncated = r.truncated;
        break;
      }
      if (rows.length >= o.cap) {
        truncated = true;
        break;
      }
    }
    for (const c of columns) if (maskedCols.has(c.key)) c.masked = true;
    return { columns, rows, truncated, label };
  }

  /** The rows of a report's source as the viewer reads them. */
  async readSource(p: Principal, app: AppRow, def: ReportDefinition, params: ParamValues, o: ComputeOptions & { cap: number }): Promise<SourceRows> {
    const src = def.source;
    if (src.kind === 'entity') return this.readEntity(p, app, src, params, o);
    if (o.filter) throw badRequest('Filters apply to reports over an entity; this report reads a ' + (src.kind === 'query' ? 'saved query' : 'REST endpoint') + '.');
    return this.readConnection(p, app, src, params, o);
  }

  /** A report computed for the viewer: its rows read as them, laid out; and the highest label among them. */
  async compute(p: Principal, app: AppRow, def: ReportDefinition, rawParams: Record<string, unknown> | null | undefined, o: ComputeOptions = {}): Promise<{ result: ReportResult; label: Label }> {
    const params = bindReportParams(def.parameters, rawParams);
    const cap = Math.min(def.rowCap, o.cap ?? def.rowCap);
    const src = await this.readSource(p, app, def, params, { ...o, cap });
    const result = computeReport({ def: { ...def, rowCap: cap }, columns: src.columns, rows: src.rows, truncated: src.truncated, params, ...(o.lineCap ? { lineCap: o.lineCap } : {}) });
    return { result, label: src.label };
  }

  // ---------- runs ----------

  /** The designer's live preview: a draft definition over the first rows (at most 200), not recorded. */
  async preview(actor: Actor & { principal: Principal }, appRef: string, definition: ReportDefinition, params: Record<string, unknown> | null | undefined) {
    const p = actor.principal;
    const app = await this.apps.designable(p, appRef);
    await this.check(p, app, definition);
    const { result, label } = await this.compute(p, app, definition, params, { cap: REPORT_PREVIEW_LINES, lineCap: REPORT_PREVIEW_LINES });
    return { result, label, preview: true };
  }

  /** A run as the viewer, recorded in the history with its parameters; the result cached (sealed) for a while. */
  async run(actor: Actor & { principal: Principal }, appRef: string, ref: string, input: z.infer<typeof runInputSchema>) {
    const p = actor.principal;
    const app = await this.apps.app(p, appRef);
    const r = await this.rowOf(p, app, ref);
    const def = await this.open(r);
    const id = ulid();
    const t0 = Date.now();
    let params: ParamValues = {};
    try {
      params = bindReportParams(def.parameters, input.params);
      const { result, label } = await this.compute(p, app, def, params);
      const ms = Date.now() - t0;
      const expires = def.cacheMinutes > 0 ? Date.now() + def.cacheMinutes * 60_000 : null;
      await this.db('app_report_runs').insert({ id, tenant_id: p.tenantId, app_id: app.id, report_id: r.id, user_id: p.userId, state: 'succeeded', params: await this.s().keys.seal(p.tenantId, JSON.stringify(params), paramsAad(id)), rows: result.rowsRead, truncated: result.truncated, ms, label, error: null, result: expires ? await this.s().keys.seal(p.tenantId, JSON.stringify(result), runAad(id)) : null, expires_at: expires, created_at: t0 });
      await this.prune(p, r.id);
      await this.audit(actor, 'app.report.run', { app: app.id, report: r.id, run: id }, label, { rows: result.rowsRead, truncated: result.truncated, lines: result.lines.length, ms, params: Object.keys(params) });
      return { run: { id, reportId: r.id, state: 'succeeded' as const, params, rows: result.rowsRead, truncated: result.truncated, ms, label, cached: !!expires, expiresAt: expires, createdAt: t0 }, result };
    } catch (err) {
      const msg = err instanceof HttpProblem ? (err.detail ?? err.title) : (err as Error).message;
      await this.db('app_report_runs').insert({ id, tenant_id: p.tenantId, app_id: app.id, report_id: r.id, user_id: p.userId, state: 'failed', params: await this.s().keys.seal(p.tenantId, JSON.stringify(params), paramsAad(id)), rows: 0, truncated: false, ms: Date.now() - t0, label: r.label, error: msg.slice(0, 500), result: null, expires_at: null, created_at: t0 });
      await this.prune(p, r.id);
      await this.audit(actor, 'app.report.run.failed', { app: app.id, report: r.id, run: id }, r.label, { error: msg.slice(0, 200), status: err instanceof HttpProblem ? err.status : 500 });
      throw err;
    }
  }

  private async prune(p: Principal, reportId: string): Promise<void> {
    const old = ((await this.db('app_report_runs').where({ report_id: reportId, user_id: p.userId }).orderBy('created_at', 'desc').offset(HISTORY_KEEP).limit(1000).select('id')) as { id: string }[]).map((x) => x.id);
    if (old.length) await this.db('app_report_runs').whereIn('id', old).delete();
  }

  private async runView(x: RunRow, withParams: boolean) {
    const params = withParams && x.params ? json<ParamValues>(await this.s().keys.open(x.tenant_id, x.params, paramsAad(x.id)), {}) : null;
    return { id: x.id, reportId: x.report_id, userId: x.user_id, state: x.state, params, rows: x.rows, truncated: x.truncated, ms: x.ms, label: x.label, error: x.error, cached: !!x.result && (x.expires_at ?? 0) > Date.now(), expiresAt: x.expires_at, createdAt: x.created_at };
  }

  /** The run history: the caller's own runs, with their parameters; a designer also sees everyone's, parameters included. */
  async runs(p: Principal, appRef: string, ref: string, all = false) {
    const app = await this.apps.app(p, appRef);
    const r = await this.rowOf(p, app, ref);
    const everyone = all && this.designer(p);
    const q = this.db('app_report_runs').where({ tenant_id: p.tenantId, report_id: r.id });
    if (!everyone) q.andWhere({ user_id: p.userId });
    const rows = ((await q.orderBy('created_at', 'desc').limit(100)) as Record<string, unknown>[]).map(runFrom).filter((x) => clears(p.clearance, x.label));
    return { runs: await Promise.all(rows.map((x) => this.runView(x, true))), all: everyone };
  }

  /** A cached result, for the person who ran it, while it has not expired and their clearance clears its label. */
  async runResult(p: Principal, appRef: string, ref: string, runId: string) {
    const app = await this.apps.app(p, appRef);
    const r = await this.rowOf(p, app, ref);
    const x = (await this.db('app_report_runs').where({ tenant_id: p.tenantId, report_id: r.id, id: runId }).first()) as Record<string, unknown> | undefined;
    if (!x || x.user_id !== p.userId) throw notFound('Run');
    const run = runFrom(x);
    if (!clears(p.clearance, run.label)) throw forbidden(`The run is ${run.label}; your clearance is ${p.clearance}.`, { step: 'clearance' });
    if (!run.result || (run.expires_at ?? 0) <= Date.now()) throw new HttpProblem(410, 'Gone', 'The result of this run is no longer kept; run the report again.');
    const result = json<ReportResult>(await this.s().keys.open(p.tenantId, run.result, runAad(run.id)), {} as ReportResult);
    return { run: await this.runView(run, true), result };
  }

  private audit(actor: Actor & { principal: Principal }, action: string, target: Record<string, unknown>, label: Label, detail?: Record<string, unknown>) {
    return this.s().audit.append({ tenantId: actor.principal.tenantId, action, kind: 'admin', actor: actorFrom(actor.principal, actor.ip ?? null), target, label, ...(detail ? { detail } : {}), traceId: actor.traceId ?? null });
  }
}
