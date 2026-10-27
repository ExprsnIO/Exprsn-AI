import { ulid } from 'ulid';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { clears, type Label } from '../authz/labels.js';
import { authorize, type Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { loadPrincipal, parseBody } from '../http/middleware.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { JobContext, Scheduler } from '../platform/jobs.js';
import type { Services } from '../services.js';
import { EXPORT_FILE_FORMATS, FILE_INFO, renderReport, type ExportFileFormat } from './export-render.js';
import { filterSchema, sortSchema, type Filter, type Sort } from './query.js';
import { reportDefinitionSchema, type ReportDefinition } from './report-engine.js';
import type { Actor, AppRow, EntityRow } from './service.js';

/*
 * 1.8.0 (B-123): exports of an app's records (with the current filters), saved views, reports and dashboards as XLSX,
 * PDF, CSV or HTML (`s.appExports`). `render` is the one function every caller shares: the routes' direct download,
 * the `apps.export-file` job, and the scheduled delivery (B-124), which calls it as the subscriber. It always reads as
 * the principal it is given, through the same paths as the screen: records through `AppService.query` (row policies,
 * field grants and masks, clearance, hidden records), reports through `s.appReports.compute`, dashboards through
 * `s.apps.dashboards.render`. Masked values are written masked.
 *
 * Small exports are answered at once (`POST /apps/:app/exports/download`, at most SYNC_ROWS rows); larger ones run as
 * the job `apps.export-file` with progress and land in a sealed file in the blob store (associated data
 * `app-export:<id>`) that only the requester downloads, while their clearance clears its label, until it expires
 * (EXPORT_DAYS). Audited as `app.export.rendered`, `.queued`, `.ready`, `.failed` and `.downloaded`.
 */

export const EXPORT_KINDS = ['records', 'view', 'report', 'dashboard'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];
/** Rows a direct download writes at most; more is a 409 that asks for the job. */
export const SYNC_ROWS = 5000;
/** Days an export's file is kept. */
export const EXPORT_DAYS = 7;
export const EXPORT_JOB = 'apps.export-file';
export const EXPORT_SWEEP_JOB = 'apps.export-file.sweep';

const recordFilters = z.object({ filter: filterSchema.optional(), q: z.string().trim().min(1).max(200).optional(), sort: sortSchema.optional() }).strict();
type RecordFilters = z.infer<typeof recordFilters>;

/**
 * The filters of an export in each spelling a caller sends: `{filter, q, sort}` (records; views and reports take only
 * `filter`), one filter, or a list of filters that all apply (scheduled delivery keeps a list). Checked here, so a bad
 * filter is a 400.
 */
export function exportFilters(kind: Exclude<ExportKind, 'dashboard'>, raw: unknown): RecordFilters {
  if (raw === undefined || raw === null) return {};
  if (Array.isArray(raw)) {
    const list = raw.map((f) => parseBody(filterSchema, f));
    return list.length === 0 ? {} : { filter: list.length === 1 ? list[0]! : { and: list } };
  }
  const o = raw as Record<string, unknown>;
  const f = typeof o === 'object' && ('filter' in o || 'q' in o || 'sort' in o || Object.keys(o).length === 0) ? parseBody(recordFilters, o) : { filter: parseBody(filterSchema, o) };
  if (kind !== 'records' && (f.q || f.sort)) throw badRequest('A view or report export takes a filter; its search and sort are its own.');
  return f;
}

export const exportInputSchema = z
  .object({
    kind: z.enum(EXPORT_KINDS),
    /** The entity (records), view, report or dashboard: its id; for records also the entity's name. */
    id: z.string().min(1).max(63),
    params: z.record(z.string().max(63), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])).refine((o) => Object.keys(o).length <= 10, 'at most 10 parameters').optional(),
    /** Records: `{filter, q, sort}`; views and reports: `{filter}` added to their own; dashboards: theirs. */
    filters: z.unknown().optional(),
    format: z.enum(EXPORT_FILE_FORMATS)
  })
  .strict();
export type ExportInput = z.infer<typeof exportInputSchema>;

export interface RenderOutput {
  filename: string;
  contentType: string;
  bytes: Buffer;
  rows: number;
  truncated: boolean;
  /** The highest label in the file. */
  label: Label;
}

export interface RenderOptions {
  /** Source rows read at most (the direct download's SYNC_ROWS); the definition's own cap otherwise. */
  cap?: number;
  progress?: (pct: number, message?: string) => Promise<void>;
}

interface ExportRow {
  id: string;
  tenant_id: string;
  app_id: string;
  user_id: string;
  kind: ExportKind;
  ref_id: string;
  format: ExportFileFormat;
  state: 'queued' | 'running' | 'ready' | 'failed' | 'expired';
  input: string | null;
  file: string | null;
  label: Label;
  blob_key: string | null;
  bytes: number | null;
  rows: number | null;
  truncated: boolean;
  error: string | null;
  job_id: string | null;
  created_at: number;
  finished_at: number | null;
  expires_at: number | null;
}
const rowFrom = (r: Record<string, unknown>): ExportRow => ({ ...(r as unknown as ExportRow), bytes: r.bytes == null ? null : Number(r.bytes), rows: r.rows == null ? null : Number(r.rows), truncated: !!r.truncated, created_at: Number(r.created_at), finished_at: r.finished_at == null ? null : Number(r.finished_at), expires_at: r.expires_at == null ? null : Number(r.expires_at) });
const aad = (id: string) => `app-export:${id}`;
const inputAad = (id: string) => `app-export:${id}:input`;

export const exportView = (e: ExportRow) => ({ id: e.id, kind: e.kind, refId: e.ref_id, format: e.format, state: e.state, file: e.file, label: e.label, bytes: e.bytes, rows: e.rows, truncated: e.truncated, error: e.error, jobId: e.job_id, createdAt: e.created_at, finishedAt: e.finished_at, expiresAt: e.expires_at });

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'export';

/** What a dashboard render gives back (Agent 1's `s.apps.dashboards.render`), as far as an export needs it. */
interface DashboardRender {
  filename?: string;
  contentType?: string;
  bytes: Buffer | Uint8Array;
  rows?: number;
  truncated?: boolean;
  label?: Label;
}
type DashboardRenderer = (p: Principal, id: string, o: { format: 'html' | 'pdf'; filters?: never }) => Promise<DashboardRender>;

export class AppExports {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  private get apps() {
    return this.s().apps;
  }

  registerJobs(): void {
    this.s().jobs.register(EXPORT_JOB, (p, ctx) => this.runJob(String(p.exportId), ctx), { timeoutMs: 60 * 60_000 });
    this.s().jobs.register(EXPORT_SWEEP_JOB, async () => ({ expired: await this.sweep() }));
  }

  /** Every half hour, when a file has expired. */
  schedule(scheduler: Scheduler): void {
    scheduler.every(EXPORT_SWEEP_JOB, 30 * 60_000, async () => ((await this.db('app_exports').where({ state: 'ready' }).andWhere('expires_at', '<=', Date.now()).first('id')) ? [{ tenantId: 'platform', key: 'all' }] : []));
  }

  /** Deletes the files of expired exports (the rows stay, as `expired`). */
  async sweep(now = Date.now()): Promise<number> {
    const rows = ((await this.db('app_exports').where({ state: 'ready' }).andWhere('expires_at', '<=', now).limit(500)) as Record<string, unknown>[]).map(rowFrom);
    for (const e of rows) {
      if (e.blob_key) await this.s().blobs.delete(e.blob_key).catch(() => undefined);
      await this.db('app_exports').where({ id: e.id }).update({ state: 'expired', blob_key: null });
    }
    return rows.length;
  }

  /** The dashboard renderer, when this server has one. */
  private dashboards(): DashboardRenderer | null {
    const d = (this.apps as unknown as { dashboards?: { render?: DashboardRenderer } }).dashboards;
    return d && typeof d.render === 'function' ? d.render.bind(d) : null;
  }

  /** The app an export target belongs to, as the caller sees it (404 when they cannot see it). */
  async appOf(p: Principal, kind: ExportKind, id: string): Promise<{ app: AppRow; refId: string; label: Label }> {
    switch (kind) {
      case 'records': {
        const e = await this.apps.entityById(p.tenantId, id);
        if (!e) throw notFound('Entity');
        return { app: await this.apps.app(p, e.app_id), refId: e.id, label: e.label };
      }
      case 'view': {
        const v = (await this.db('app_views').where({ tenant_id: p.tenantId, id }).first()) as { app_id: string; entity_id: string; label: Label } | undefined;
        if (!v || !clears(p.clearance, v.label)) throw notFound('View');
        return { app: await this.apps.app(p, v.app_id), refId: id, label: v.label };
      }
      case 'report': {
        const r = await this.s().appReports.byId(p, id);
        return { app: r.app, refId: id, label: r.row.label };
      }
      case 'dashboard': {
        if (!this.dashboards()) throw new HttpProblem(501, 'Not available', 'Dashboard export is not available on this server: dashboards are not installed.');
        // the dashboard's own table, when dashboards are installed (the renderer checks access again as it reads)
        if (await this.db.schema.hasTable('app_dashboards')) {
          const d = (await this.db('app_dashboards').where({ tenant_id: p.tenantId, id }).first()) as { app_id?: string; label?: Label } | undefined;
          if (!d?.app_id || (d.label && !clears(p.clearance, d.label))) throw notFound('Dashboard');
          return { app: await this.apps.app(p, d.app_id), refId: id, label: d.label ?? 'internal' };
        }
        throw notFound('Dashboard');
      }
    }
  }

  /**
   * The one export function (B-123; B-124 delivers through it as the subscriber): what `kind` and `id` name, read as
   * `principal` now, written in `format`.
   */
  async render(principal: Principal, input: { kind: ExportKind; id: string; params?: Record<string, unknown> | null; filters?: unknown; format: ExportFileFormat }, o: RenderOptions = {}): Promise<RenderOutput> {
    const p = principal;
    const d = authorize(p, 'records:read', { tenantId: p.tenantId });
    if (!d.allow) throw forbidden(`${p.displayName} may not read app records: ${d.reason}.`, { step: d.step });
    const info = FILE_INFO[input.format];
    if (!info) throw new HttpProblem(400, 'Invalid request', `${String(input.format)} is not an export format (xlsx, pdf, csv, html).`);
    const stamp = new Date().toISOString().slice(0, 10);
    const progress = o.progress;
    const report = async (app: AppRow, def: ReportDefinition, params: Record<string, unknown> | null | undefined, filter: Filter | undefined, sort: Sort | undefined, subtitle: string) => {
      const { result, label } = await this.s().appReports.compute(p, app, def, params, {
        ...(o.cap ? { cap: o.cap } : {}),
        ...(filter ? { filter } : {}),
        ...(sort ? { sort } : {}),
        ...(progress ? { progress: (done, of) => progress(of ? Math.min(90, Math.round((done * 90) / Math.max(1, Math.min(of, def.rowCap)))) : 50, `${done}${of ? ` of ${of}` : ''} rows read`) } : {})
      });
      const fileLabel = label;
      if (progress) await progress(95, `writing ${input.format}`);
      const bytes = renderReport(result, input.format, { label: fileLabel, by: p.username, subtitle });
      return { filename: `${slug(result.title)}-${stamp}.${info.ext}`, contentType: info.type, bytes, rows: result.rowsRead, truncated: result.truncated, label: fileLabel };
    };
    const maxRows = this.apps.o.maxExportRows;
    switch (input.kind) {
      case 'records': {
        const { app } = await this.appOf(p, 'records', input.id);
        const entity = await this.apps.entityOf(app, input.id);
        const f = exportFilters('records', input.filters);
        const def = recordsDefinition(entity, { title: entity.title || entity.name, rowCap: maxRows, q: f.q ?? '' });
        return report(app, def, null, f.filter, f.sort, `Records of ${entity.title || entity.name} in ${app.title || app.name}`);
      }
      case 'view': {
        const { app } = await this.appOf(p, 'view', input.id);
        const v = (await this.db('app_views').where({ tenant_id: p.tenantId, id: input.id }).first()) as { entity_id: string };
        const entity = await this.apps.entityOf(app, v.entity_id);
        const view = (await this.apps.views.list(p, app.id, entity.id)).views.find((x) => x.id === input.id);
        if (!view) throw notFound('View');
        const f = exportFilters('view', input.filters);
        const def = recordsDefinition(entity, { title: view.name, rowCap: maxRows, view: view.id, columns: view.settings.columns });
        return report(app, def, null, f.filter, undefined, `View ${view.name} of ${entity.title || entity.name} in ${app.title || app.name}`);
      }
      case 'report': {
        const r = await this.s().appReports.byId(p, input.id);
        const f = exportFilters('report', input.filters);
        return report(r.app, r.definition, input.params, f.filter, undefined, `Report ${r.row.name} in ${r.app.title || r.app.name}`);
      }
      case 'dashboard': {
        const render = this.dashboards();
        if (!render) throw new HttpProblem(501, 'Not available', 'Dashboard export is not available on this server: dashboards are not installed.');
        if (input.format !== 'html' && input.format !== 'pdf') throw badRequest('A dashboard exports as HTML or PDF.');
        // a dashboard's filters are its own filter values; an empty list (scheduled delivery's default) is none
        const filters = Array.isArray(input.filters) ? (input.filters.length ? input.filters[0] : undefined) : (input.filters ?? undefined);
        const out = await render(p, input.id, { format: input.format, ...(filters !== undefined ? { filters: filters as never } : {}) });
        const bytes = Buffer.isBuffer(out.bytes) ? out.bytes : Buffer.from(out.bytes);
        return { filename: out.filename ?? `dashboard-${stamp}.${info.ext}`, contentType: out.contentType ?? info.type, bytes, rows: out.rows ?? 0, truncated: !!out.truncated, label: out.label ?? 'internal' };
      }
    }
  }

  /** A direct download (at most SYNC_ROWS rows), audited. */
  async download(actor: Actor & { principal: Principal }, app: AppRow, input: ExportInput): Promise<RenderOutput> {
    const p = actor.principal;
    const refId = await this.check(p, app, input);
    const out = await this.render(p, { ...input, id: refId }, { cap: SYNC_ROWS });
    if (out.truncated && out.rows >= SYNC_ROWS) throw new HttpProblem(409, 'Too large to download directly', `More than ${SYNC_ROWS} rows: queue the export, which runs as a job and lands in a file you download.`, { extensions: { queue: true, rows: out.rows } });
    await this.audit(actor, 'app.export.rendered', { app: app.id, [input.kind]: refId }, out.label, { kind: input.kind, format: input.format, rows: out.rows, bytes: out.bytes.length, truncated: out.truncated });
    return out;
  }

  /** The target's id, checked to be in `app` and readable by the caller. */
  private async check(p: Principal, app: AppRow, input: ExportInput): Promise<string> {
    const id = input.kind === 'records' ? (await this.apps.entityOf(app, input.id)).id : input.id;
    const found = await this.appOf(p, input.kind, id);
    if (found.app.id !== app.id) throw notFound(input.kind === 'records' ? 'Entity' : input.kind[0]!.toUpperCase() + input.kind.slice(1));
    if (input.kind === 'dashboard' && !this.dashboards()) throw new HttpProblem(501, 'Not available', 'Dashboard export is not available on this server: dashboards are not installed.');
    return found.refId;
  }

  /** Queues the export as a job; the file is written as the requester, with what they may read when it runs. */
  async request(actor: Actor & { principal: Principal }, app: AppRow, input: ExportInput) {
    const p = actor.principal;
    const refId = await this.check(p, app, input);
    // a bad filter is a 400 now, not a failed job
    if (input.kind !== 'dashboard') exportFilters(input.kind, input.filters);
    else if (input.format !== 'html' && input.format !== 'pdf') throw badRequest('A dashboard exports as HTML or PDF.');
    const id = ulid();
    const row: ExportRow = { id, tenant_id: p.tenantId, app_id: app.id, user_id: p.userId, kind: input.kind, ref_id: refId, format: input.format, state: 'queued', input: await this.s().keys.seal(p.tenantId, JSON.stringify({ params: input.params ?? null, filters: input.filters ?? null }), inputAad(id)), file: null, label: app.label, blob_key: null, bytes: null, rows: null, truncated: false, error: null, job_id: null, created_at: Date.now(), finished_at: null, expires_at: null };
    await this.db('app_exports').insert(row);
    const job = await this.s().jobs.enqueue({ tenantId: p.tenantId, type: EXPORT_JOB, payload: { exportId: id }, createdBy: p.userId, maxAttempts: 2 });
    await this.db('app_exports').where({ id }).update({ job_id: job.id });
    await this.audit(actor, 'app.export.queued', { app: app.id, export: id, [input.kind]: refId }, app.label, { kind: input.kind, format: input.format });
    return exportView({ ...row, job_id: job.id });
  }

  private async runJob(id: string, ctx: JobContext): Promise<unknown> {
    const s = this.s();
    const raw = (await this.db('app_exports').where({ id }).first()) as Record<string, unknown> | undefined;
    if (!raw) return { skipped: 'gone' };
    const e = rowFrom(raw);
    if (e.state !== 'queued' && e.state !== 'running') return { skipped: e.state };
    await this.db('app_exports').where({ id }).update({ state: 'running' });
    const fail = async (msg: string) => {
      await this.db('app_exports').where({ id }).update({ state: 'failed', error: msg.slice(0, 500), finished_at: Date.now() });
      await s.audit.append({ tenantId: e.tenant_id, action: 'app.export.failed', kind: 'system', actor: { service: 'app-exports', user: e.user_id }, target: { app: e.app_id, export: id }, label: e.label, detail: { kind: e.kind, format: e.format, error: msg.slice(0, 200) } });
      return { error: msg };
    };
    // Access is checked again when the job runs, as the requester now: a right lost in between ends the export.
    const p = await loadPrincipal(s, e.tenant_id, e.user_id, {});
    const app = p ? await this.apps.appById(e.tenant_id, e.app_id) : undefined;
    if (!p || !app) return fail('The person who asked for the export can no longer read this app.');
    p.workspaceId = app.workspace_id;
    const input = e.input ? json<{ params: Record<string, unknown> | null; filters: unknown }>(await s.keys.open(e.tenant_id, e.input, inputAad(id)), { params: null, filters: null }) : { params: null, filters: null };
    try {
      const out = await this.render(p, { kind: e.kind, id: e.ref_id, params: input.params, filters: input.filters ?? undefined, format: e.format }, { progress: (pct, m) => ctx.progress(pct, m) });
      const key = `apps/${e.tenant_id}/app-exports/${id}.sealed`;
      await s.blobs.put(key, Buffer.from(await s.keys.sealBytes(e.tenant_id, out.bytes, aad(id)), 'utf8'), 'application/octet-stream');
      const expires = Date.now() + EXPORT_DAYS * 86_400_000;
      await this.db('app_exports').where({ id }).update({ state: 'ready', blob_key: key, file: out.filename.slice(0, 200), label: out.label, bytes: out.bytes.length, rows: out.rows, truncated: out.truncated, finished_at: Date.now(), expires_at: expires, input: null });
      await s.audit.append({ tenantId: e.tenant_id, action: 'app.export.ready', kind: 'system', actor: { service: 'app-exports', user: e.user_id }, target: { app: e.app_id, export: id, [e.kind]: e.ref_id }, label: out.label, detail: { kind: e.kind, format: e.format, rows: out.rows, bytes: out.bytes.length, truncated: out.truncated } });
      await ctx.progress(100, 'ready');
      return { rows: out.rows, bytes: out.bytes.length, truncated: out.truncated };
    } catch (err) {
      return fail(err instanceof HttpProblem ? (err.detail ?? err.title) : (err as Error).message);
    }
  }

  async list(p: Principal, app: AppRow) {
    const rows = ((await this.db('app_exports').where({ tenant_id: p.tenantId, app_id: app.id, user_id: p.userId }).orderBy('created_at', 'desc').limit(50)) as Record<string, unknown>[]).map(rowFrom);
    return { exports: rows.map(exportView) };
  }

  async get(p: Principal, app: AppRow, id: string) {
    const r = (await this.db('app_exports').where({ tenant_id: p.tenantId, app_id: app.id, id, user_id: p.userId }).first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('Export');
    return rowFrom(r);
  }

  /** The file, opened, for the person who asked for it, while their clearance clears its label. */
  async file(actor: Actor & { principal: Principal }, app: AppRow, id: string): Promise<{ filename: string; contentType: string; bytes: Buffer }> {
    const p = actor.principal;
    const e = await this.get(p, app, id);
    if (e.state === 'expired') throw new HttpProblem(410, 'Gone', `The export expired after ${EXPORT_DAYS} days; export again.`);
    if (e.state !== 'ready' || !e.blob_key) throw conflict(`The export is ${e.state}.`);
    if (!clears(p.clearance, e.label)) throw forbidden(`The export is ${e.label}; your clearance is ${p.clearance}.`, { step: 'clearance' });
    const sealed = await this.s().blobs.get(e.blob_key);
    if (!sealed) throw notFound('Export file');
    const bytes = await this.s().keys.openBytes(p.tenantId, sealed.toString('utf8'), aad(id));
    await this.audit(actor, 'app.export.downloaded', { app: app.id, export: id }, e.label, { bytes: bytes.length, format: e.format });
    return { filename: e.file ?? `export.${FILE_INFO[e.format].ext}`, contentType: FILE_INFO[e.format].type, bytes };
  }

  private audit(actor: Actor & { principal: Principal }, action: string, target: Record<string, unknown>, label: Label, detail?: Record<string, unknown>) {
    return this.s().audit.append({ tenantId: actor.principal.tenantId, action, kind: 'admin', actor: actorFrom(actor.principal, actor.ip ?? null), target, label, ...(detail ? { detail } : {}), traceId: actor.traceId ?? null });
  }
}

/** Records (or a saved view) as a table report: the record's own columns, then the fields (the view's choice first). */
export function recordsDefinition(entity: EntityRow, o: { title: string; rowCap: number; q?: string; view?: string; columns?: { fields: string[]; meta: string[] } | null }): ReportDefinition {
  const fields = entity.definition.fields.filter((f) => f.type !== 'relation').map((f) => f.name);
  const meta: string[] = [];
  if (o.columns) {
    if (o.columns.meta.includes('state') && entity.definition.states) meta.push('state');
    if (o.columns.meta.includes('label')) meta.push('label');
    if (o.columns.meta.includes('updated')) meta.push('updatedAt');
  } else meta.push('id', ...(entity.definition.states ? ['state'] : []), 'label', 'createdAt', 'updatedAt');
  const shown = o.columns ? o.columns.fields.filter((f) => fields.includes(f)) : fields;
  return reportDefinitionSchema.parse({
    title: o.title,
    source: { kind: 'entity', entity: entity.name, view: o.view ?? null, q: o.q ?? '' },
    columns: [...meta, ...shown].map((key) => ({ key })),
    layout: { kind: 'table' },
    // a wide table reads better across the page
    page: { size: 'a4', orientation: meta.length + shown.length > 6 ? 'landscape' : 'portrait', breakGroups: false },
    rowCap: Math.min(o.rowCap, 50_000),
    cacheMinutes: 0
  });
}
