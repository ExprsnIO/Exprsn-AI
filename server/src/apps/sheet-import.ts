import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { z } from 'zod';
import { actorFrom, isUniqueViolation, PLATFORM_TENANT } from '../audit/chain.js';
import { clears, highest, LABELS, labelRank, type Label } from '../authz/labels.js';
import { authorize, effectivePermissions, type Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { loadPrincipal } from '../http/middleware.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { profile } from '../imports/tabular.js';
import type { JobContext, Scheduler } from '../platform/jobs.js';
import type { Services } from '../services.js';
import { describeCron, nextCron, parseCron } from '../training/calendar.js';
import { definitionOf, inferEntity, type Proposal } from './import-infer.js';
import { colLetters, readOptionsSchema, readTable, ReadError, tableOf, type Table } from './import-read.js';
import { applyTransforms, COLUMN_NAME, TransformError, transformsSchema, type Row, type Transform, type Transformed } from './import-transforms.js';
import { AppPolicies } from './policies.js';
import { checkValue, fieldSchema, isComputed, nameSchema, uniqueKeys, type Field, type Values } from './schema.js';
import { csvCell, type Actor, type AppRow, type AppService, type EntityRow } from './service.js';

/*
 * Sprint 45 (B-127, B-129): imports into an app entity from a spreadsheet or a connection, beside the CSV import of
 * B-2202 (which stays as it was). One pipeline for every source:
 *
 *   source → table (columns, numbered rows) → transformations (`import-transforms.ts`) → mapping to fields
 *   → each row created, updated (upsert by a unique field, or by the source's row key), skipped or failed
 *
 * Sources: a file in the file store or a chat attachment (both through quarantine, type sniffing and the scan before
 * anything here reads them), pasted text, an allow-listed table or collection of a data connection (read through
 * `ConnectionService.readRows`, masked, after the `db-query` guardrail; an OpenSearch index through
 * `ConnectionService.run`), a saved connection query, or a REST connection's endpoint (`s.savedQueries.run` and
 * `s.restConnections.read`, when the server has them).
 *
 * The import runs as the job `apps.import` (payload `spec: 2`), the dry run first as before: every row is validated
 * through the record service's own `prepare`, the policies' write check and the unique keys, and nothing is written.
 * A real run writes through `createRecord` and `updateRecord`, so policies, validation, audit, labels, triggers,
 * AI-fill queueing and the outside-source push all apply. The job re-checks its starter (records:write, clearance,
 * the connection right) and reports per row (created, updated, skipped, failed, with reasons); failed rows are kept as
 * a sealed CSV with their reasons for the starter to download. A connection import may also be scheduled (cron, the
 * apps tick claims each due time once across instances) and runs as the person who set it up, re-checked each time.
 *
 * Records are at least the source's label (a file version's, the connection's), and an import whose source is above
 * the app's label or the importer's clearance is refused.
 */

const id26 = z.string().length(26);
const params = z.record(z.string().max(63), z.unknown()).refine((v) => Object.keys(v).length <= 50, 'at most 50 parameters').default({});

export const importSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), fileId: id26, ...readOptionsSchema }).strict(),
  z.object({ kind: z.literal('attachment'), attachmentId: id26, ...readOptionsSchema }).strict(),
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(250_000), name: z.string().max(255).optional(), ...readOptionsSchema }).strict(),
  /** A table, view or collection on the connection's allow-list; `keyColumn` pages by it and keys the rows. */
  z.object({ kind: z.literal('connection'), connectionId: id26, object: z.string().trim().min(1).max(200), keyColumn: z.string().trim().min(1).max(200).optional() }).strict(),
  z.object({ kind: z.literal('saved-query'), queryId: z.string().min(1).max(64), params }).strict(),
  z.object({ kind: z.literal('rest'), connectionId: z.string().min(1).max(64), endpoint: z.string().trim().min(1).max(100), params }).strict()
]);
export type ImportSource = z.infer<typeof importSourceSchema>;
const CONNECTED = new Set<ImportSource['kind']>(['connection', 'saved-query', 'rest']);

export const mappingSchema = z.array(z.object({ column: COLUMN_NAME, field: z.union([nameSchema, z.literal('label')]) }).strict()).min(1).max(200);

export const importSpecSchema = z
  .object({
    source: importSourceSchema,
    transforms: transformsSchema,
    mapping: mappingSchema,
    /** Update the record whose unique `field` has the row's value; `update-only` skips rows that match none. */
    upsert: z.object({ field: nameSchema, mode: z.enum(['upsert', 'update-only']).default('upsert') }).strict().optional(),
    /** The source column whose value keys the row: a re-import updates the record that row made (idempotent). */
    sourceKey: COLUMN_NAME.optional()
  })
  .strict();
export type ImportSpec = z.infer<typeof importSpecSchema>;

export const previewSchema = z
  .object({
    source: importSourceSchema,
    transforms: transformsSchema,
    /** With an entity and a mapping, the previewed rows are also checked as records. */
    entity: z.string().min(1).max(63).optional(),
    mapping: z.array(z.object({ column: COLUMN_NAME, field: z.union([nameSchema, z.literal('label')]) }).strict()).max(200).optional()
  })
  .strict();

export const newEntitySchema = z
  .object({
    source: importSourceSchema,
    transforms: transformsSchema,
    entity: z
      .object({
        name: nameSchema,
        title: z.string().trim().min(1).max(200).optional(),
        label: z.enum(LABELS).optional(),
        /** The kept columns: each its field (as the proposal, renamed, retyped). */
        columns: z.array(z.object({ column: COLUMN_NAME, field: fieldSchema }).strict()).min(1).max(200),
        titleField: nameSchema.nullable().optional()
      })
      .strict(),
    upsert: importSpecSchema.shape.upsert,
    sourceKey: COLUMN_NAME.optional(),
    dryRun: z.boolean().default(false)
  })
  .strict();

export const scheduleInputSchema = z
  .object({
    spec: importSpecSchema,
    cron: z.string().trim().min(9).max(100),
    enabled: z.boolean().default(true)
  })
  .strict();

const PREVIEW_ROWS = 20;
const CONNECTION_PREVIEW_ROWS = 500;
const REPORT_MAX = 1000;
const errorsAad = (id: string) => `app-import-errors:${id}`;
const specAad = (id: string) => `app-transfer:${id}`;
const scheduleAad = (id: string) => `app-import-schedule:${id}`;

export type Outcome = 'created' | 'updated' | 'skipped' | 'failed';
export interface ReportRow {
  row: number;
  outcome: Outcome;
  problem?: string;
  record?: string;
}

interface SourceRead {
  table: Table;
  /** The label the source's data carries. */
  label: Label;
  /** A stable name of the source for the row keys (a digest; never shown). */
  ref: string;
  truncated: boolean;
  /** The file version read, pinned for the job. */
  version?: number;
  name?: string | null;
}

const text = (v: unknown): string => (v == null ? '' : typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v));
const blank = (v: unknown) => v == null || (typeof v === 'string' && v === '');
const messageOf = (err: unknown): string => (err instanceof HttpProblem ? (err.detail ?? err.title) : err instanceof Error ? err.message : String(err));

/** A cell turned into what its field stores, as far as the cell allows; the record service validates the rest. */
export function cellValue(f: Field, v: unknown): unknown {
  if (v == null || (typeof v === 'string' && v === '')) return null;
  switch (f.type) {
    case 'string':
      return text(v);
    case 'number':
      if (typeof v === 'number') return v;
      return typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v.trim())) ? Number(v.trim()) : v;
    case 'boolean': {
      if (typeof v === 'boolean') return v;
      if (v === 1 || v === 0) return v === 1;
      const t = text(v).trim().toLowerCase();
      if (['true', 'yes', 'y', '1'].includes(t)) return true;
      if (['false', 'no', 'n', '0'].includes(t)) return false;
      return v;
    }
    case 'date': {
      if (typeof v !== 'string') return text(v);
      const s = v.trim();
      if (!f.withTime && /^\d{4}-\d{2}-\d{2}[T ]00:00(:00(\.0+)?)?Z?$/.test(s)) return s.slice(0, 10);
      if (f.withTime && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/.test(s)) return `${s.replace(' ', 'T')}Z`;
      return s.replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T');
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
    default:
      return text(v);
  }
}

export class AppSheetImport {
  constructor(
    private readonly s: () => Services,
    private readonly apps: AppService
  ) {}

  private get db() {
    return this.s().db;
  }

  registerJobs(): void {
    this.s().jobs.register('apps.import-schedules', async () => this.tick(), { timeoutMs: 10 * 60_000 });
  }

  schedule(scheduler: Scheduler, everyMs: number): void {
    scheduler.every('apps.import-schedules', everyMs, async () => [{ tenantId: PLATFORM_TENANT, key: 'all' }]);
  }

  private limits(maxRows?: number) {
    const cfg = this.s().cfg;
    return { maxBytes: cfg.IMPORT_ARCHIVE_MAX_BYTES, unpackedBytes: cfg.IMPORT_ARCHIVE_MAX_UNPACKED_BYTES, maxRows: maxRows ?? this.apps.o.maxImportRows };
  }

  private audit(actor: Actor, tenantId: string, action: string, target: Record<string, unknown>, label: Label, detail?: Record<string, unknown>) {
    return this.s().audit.append({ tenantId, action, kind: actor.principal ? 'admin' : 'system', actor: actor.principal ? actorFrom(actor.principal, actor.ip ?? null) : { service: actor.service ?? 'apps.import' }, target, label, ...(detail ? { detail } : {}), traceId: actor.traceId ?? null });
  }

  // ---------- reading a source ----------

  private refOf(src: ImportSource): string {
    const d = src.kind === 'connection' ? `connection:${src.connectionId}:${src.object.toLowerCase()}` : src.kind === 'saved-query' ? `query:${src.queryId}` : src.kind === 'rest' ? `rest:${src.connectionId}:${src.endpoint}` : src.kind === 'file' ? `file:${src.fileId}` : src.kind === 'attachment' ? `attachment:${src.attachmentId}` : 'text';
    return createHash('sha256').update(d).digest('hex');
  }

  private async collect(stream: AsyncIterable<Buffer | Uint8Array>, max: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    let n = 0;
    for await (const c of stream) {
      n += c.length;
      if (n > max) throw new ReadError(`The file is larger than the ${max.toLocaleString('en-US')} bytes an import reads (IMPORT_ARCHIVE_MAX_BYTES).`, 413);
      parts.push(Buffer.from(c));
    }
    return Buffer.concat(parts);
  }

  /** Reads the source as `p`: the file store's and the connection's own checks, then the readers' limits. */
  async read(actor: Actor & { principal: Principal }, src: ImportSource, o: { maxRows?: number; preview?: boolean; pinned?: number | null } = {}): Promise<SourceRead> {
    const p = actor.principal;
    const s = this.s();
    const limits = this.limits(o.maxRows);
    const ref = this.refOf(src);
    try {
      if (src.kind === 'file') {
        const f = await s.files.readable(p, src.fileId);
        if (f.file.current_version != null && f.file.size > limits.maxBytes) throw new ReadError(`The file is ${Number(f.file.size).toLocaleString('en-US')} bytes; an import reads at most ${limits.maxBytes.toLocaleString('en-US')} (IMPORT_ARCHIVE_MAX_BYTES).`, 413);
        const got = await s.files.content(p, src.fileId);
        if (o.pinned != null && got.version.number !== o.pinned) throw conflict(`The file has a newer version (${got.version.number}) than the one checked (${o.pinned}); check the import again.`);
        const bytes = await this.collect(got.stream, limits.maxBytes);
        return { table: await readTable(bytes, got.file.name, src, limits), label: got.version.label, ref, truncated: false, version: got.version.number, name: got.file.name };
      }
      if (src.kind === 'attachment') {
        const a = await s.attachments.get(p.tenantId, src.attachmentId);
        if (!a || a.user_id !== p.userId) throw notFound('Attachment');
        if (a.state !== 'ready') throw conflict(`The attachment is ${a.state}; it can be imported once its scan has passed.`);
        if (!clears(p.clearance, a.label)) throw forbidden(`The attachment is ${a.label}; your clearance is ${p.clearance}.`, { step: 'clearance' });
        if (a.size > limits.maxBytes) throw new ReadError(`The attachment is ${a.size.toLocaleString('en-US')} bytes; an import reads at most ${limits.maxBytes.toLocaleString('en-US')}.`, 413);
        return { table: await readTable(await s.attachments.content(a), a.name, src, limits), label: a.label, ref, truncated: false, name: a.name };
      }
      if (src.kind === 'text') return { table: await readTable(Buffer.from(src.text, 'utf8'), src.name ?? null, src, limits), label: 'public', ref, truncated: false, name: src.name ?? null };
      return await this.readConnected(actor, src, o.preview ? Math.min(limits.maxRows, CONNECTION_PREVIEW_ROWS) : limits.maxRows, ref);
    } catch (err) {
      if (err instanceof ReadError) throw new HttpProblem(err.status, err.status === 413 ? 'Too large' : err.status === 400 ? 'Invalid request' : 'Unreadable file', err.message);
      throw err;
    }
  }

  private async readConnected(actor: Actor & { principal: Principal }, src: Extract<ImportSource, { kind: 'connection' | 'saved-query' | 'rest' }>, maxRows: number, ref: string): Promise<SourceRead> {
    const p = actor.principal;
    const s = this.s();
    if (src.kind === 'connection') {
      if (!authorize(p, 'connections:manage').allow) throw forbidden('Importing from a connection needs connections:manage, the right to read it.', { step: 'permission', permission: 'connections:manage' });
      const c = await s.connections.get(p.tenantId, src.connectionId);
      if (!clears(p.clearance, c.label)) throw forbidden(`The connection is labelled ${c.label} and your clearance is ${p.clearance}.`, { step: 'clearance' });
      if (c.engine === 'opensearch') {
        if (!/^[A-Za-z0-9._*-]{1,200}$/.test(src.object)) throw badRequest('The index name is not valid.');
        const size = Math.min(maxRows, c.row_limit);
        const r = await s.connections.run({ principal: p, ip: actor.ip ?? null, traceId: actor.traceId ?? '' }, c.id, { query: `POST /${src.object}/_search\n${JSON.stringify({ size, query: { match_all: {} } })}`, object: src.object });
        return { table: { format: 'json', ...tableOf(r.columns, r.rows) }, label: c.label, ref, truncated: r.capped || r.rows.length >= size };
      }
      // The same checkpoint every query on a connection passes; the read itself is the allow-listed, masked row read.
      const guard = await s.guardrails.check({ tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, checkpoint: 'db-query', text: `SELECT * FROM ${src.object}`, label: c.label, principal: p, source: { kind: 'connection', id: c.id }, meta: { engine: c.engine, kind: 'read', objects: [src.object], via: 'apps.import' } });
      if (guard.action === 'block' || guard.action === 'require-approval') throw new HttpProblem(403, 'Blocked by a guardrail', guard.reason ?? 'A guardrail rule refused this read.', { extensions: { step: 'guardrail', checkpoint: 'db-query' } });
      let columns: string[] = [];
      const rows: unknown[][] = [];
      let after: string | null = null;
      let capped = false;
      for (;;) {
        const limit = Math.min(1000, maxRows - rows.length);
        if (limit <= 0) break;
        const r = await s.connections.readRows(p.tenantId, c.id, src.object, { watermarkColumn: src.keyColumn ?? null, after, limit });
        if (!columns.length) columns = r.columns;
        rows.push(...r.rows);
        capped = r.capped;
        if (!r.capped || !src.keyColumn || !r.rows.length) break;
        const at = r.columns.indexOf(src.keyColumn);
        if (at < 0) throw badRequest(`${src.object} has no column ${src.keyColumn}.`);
        after = text(r.rows[r.rows.length - 1]![at]);
      }
      return { table: { format: 'json', ...tableOf(columns, rows) }, label: c.label, ref, truncated: capped };
    }
    // B-125, B-126: the read API of saved queries and REST endpoints (their own permission, clearance, guardrails and audit).
    let columns: string[] = [];
    const items: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    let truncated: boolean;
    let label: Label | null = null;
    for (;;) {
      const limit = Math.min(1000, maxRows - items.length);
      if (limit <= 0) {
        truncated = true;
        break;
      }
      const o = { limit, ...(cursor ? { cursor } : {}), via: 'apps.import', ip: actor.ip ?? null, traceId: actor.traceId ?? null };
      const r = src.kind === 'saved-query' ? await s.savedQueries.run(p, src.queryId, src.params, o) : await s.restConnections.read(p, src.connectionId, src.endpoint, src.params, o);
      if (!columns.length) columns = r.columns.map((c) => c.name);
      label = label ? highest(label, r.label) : r.label;
      items.push(...r.rows);
      truncated = r.truncated;
      if (!r.nextCursor || !r.rows.length) break;
      cursor = r.nextCursor;
    }
    label ??= 'internal';
    if (!clears(p.clearance, label)) throw forbidden(`The data is labelled ${label} and your clearance is ${p.clearance}.`, { step: 'clearance' });
    for (const it of items) for (const k of Object.keys(it)) if (!columns.includes(k) && columns.length < 500) columns.push(k);
    return { table: { format: 'json', ...tableOf(columns, items.map((it) => columns.map((c) => it[c] ?? null))) }, label, ref, truncated };
  }

  private transform(table: Table, list: Transform[]): Transformed {
    try {
      return applyTransforms(table.columns, table.rows, list);
    } catch (err) {
      if (err instanceof TransformError) throw badRequest(err.message);
      throw err;
    }
  }

  /** The source's label must fit the app and the importer: records are at least it. */
  private checkSourceLabel(p: Principal, app: AppRow, label: Label): void {
    if (!clears(p.clearance, label)) throw forbidden(`The source is ${label}; your clearance is ${p.clearance}.`, { step: 'clearance' });
    if (labelRank(label) > labelRank(app.label)) throw forbidden(`The source is ${label}; the app holds records up to ${app.label}.`, { step: 'clearance' });
  }

  // ---------- preview and inference ----------

  private sourceView(r: SourceRead) {
    return { format: r.table.format, sheets: r.table.sheets ?? null, sheet: r.table.sheet ?? null, headerRow: r.table.headerRow ?? null, columns: r.table.columns, letters: r.table.columns.map((_, i) => colLetters(i)), rows: r.table.rows.length, truncated: r.truncated, label: r.label, version: r.version ?? null, name: r.name ?? null };
  }

  private async auditRead(actor: Actor & { principal: Principal }, app: AppRow, src: ImportSource, r: SourceRead, action: string): Promise<void> {
    if (!CONNECTED.has(src.kind)) return;
    const target = src.kind === 'connection' ? { connection: src.connectionId, object: src.object } : src.kind === 'saved-query' ? { query: src.queryId } : src.kind === 'rest' ? { connection: src.connectionId, endpoint: src.endpoint } : {};
    await this.audit(actor, actor.principal.tenantId, action, { app: app.id, ...target }, r.label, { rows: r.table.rows.length, truncated: r.truncated });
  }

  /** The first rows after the transformations, their profile (types, PII flags) and, with a mapping, the checks. */
  async preview(actor: Actor & { principal: Principal }, appRef: string, input: z.infer<typeof previewSchema>) {
    const app = await this.apps.app(actor.principal, appRef);
    const r = await this.read(actor, input.source, { preview: true });
    await this.auditRead(actor, app, input.source, r, 'app.import.source.previewed');
    const t = this.transform(r.table, input.transforms);
    const shown = t.rows.slice(0, PREVIEW_ROWS);
    let checks: { row: number; outcome: Outcome; problem?: string }[] | null = null;
    if (input.entity && input.mapping?.length) {
      const entity = await this.apps.entityOf(app, input.entity);
      const cols = this.checkMapping(entity, { mapping: input.mapping, transforms: input.transforms, source: input.source }, t.columns);
      const grant = await this.apps.grantFor(actor.principal, entity);
      checks = [];
      for (const row of shown) {
        const failed = t.failed.get(row.n);
        if (failed) {
          checks.push({ row: row.n, outcome: 'failed', problem: failed });
          continue;
        }
        try {
          const { values } = this.mapRow(cols, row, r.label, entity);
          AppPolicies.checkWrite(grant, values, 'create');
          await this.apps.prepare(actor, app, entity, ulid(), values, null);
          checks.push({ row: row.n, outcome: 'created' });
        } catch (err) {
          checks.push({ row: row.n, outcome: 'failed', problem: messageOf(err).slice(0, 300) });
        }
      }
    }
    return {
      source: this.sourceView(r),
      columns: t.columns,
      rows: shown.map((x) => ({ row: x.n, values: x.values, ...(t.failed.has(x.n) ? { problem: t.failed.get(x.n) } : {}) })),
      total: t.rows.length,
      skipped: { count: t.skipped.length, rows: t.skipped.slice(0, PREVIEW_ROWS) },
      failed: { count: t.failed.size, rows: [...t.failed.entries()].slice(0, PREVIEW_ROWS).map(([row, problem]) => ({ row, problem })) },
      profile: profile(t.rows.slice(0, 1000).map((x) => x.values)),
      checks
    };
  }

  /** "New entity from file": the proposed fields, from the transformed rows. Nothing is created. */
  async infer(actor: Actor & { principal: Principal }, appRef: string, input: { source: ImportSource; transforms: Transform[] }): Promise<Proposal & { source: ReturnType<AppSheetImport['sourceView']>; total: number }> {
    const p = actor.principal;
    const app = await this.apps.designable(p, appRef);
    const r = await this.read(actor, input.source, { preview: true });
    await this.auditRead(actor, app, input.source, r, 'app.import.source.previewed');
    const t = this.transform(r.table, input.transforms);
    const ceiling = labelRank(app.label) < labelRank(p.clearance) ? app.label : p.clearance;
    return { ...inferEntity(t.columns, t.rows, { sourceLabel: r.label, ceiling }), source: this.sourceView(r), total: t.rows.length };
  }

  // ---------- mapping ----------

  /** The mapped columns' fields, checked against the entity and the transformed columns. */
  private checkMapping(entity: EntityRow, spec: Pick<ImportSpec, 'mapping' | 'upsert' | 'sourceKey' | 'transforms' | 'source'>, columns: string[] | null): { column: string; field: Field | 'label' }[] {
    const byName = new Map(entity.definition.fields.map((f) => [f.name, f]));
    const seen = new Set<string>();
    const out: { column: string; field: Field | 'label' }[] = [];
    for (const m of spec.mapping) {
      if (columns && !columns.includes(m.column)) throw badRequest(`The mapping reads a column ${m.column} the source does not have (after the transformations).`);
      if (seen.has(m.field)) throw badRequest(`Two columns are mapped to ${m.field}; keep one.`);
      seen.add(m.field);
      if (m.field === 'label') {
        out.push({ column: m.column, field: 'label' });
        continue;
      }
      const f = byName.get(m.field);
      if (!f) throw badRequest(`${m.field} is not a field of ${entity.name}.`);
      if (isComputed(f)) throw badRequest(`${m.field} is computed and cannot be imported.`);
      out.push({ column: m.column, field: f });
    }
    if (spec.upsert) {
      const f = byName.get(spec.upsert.field);
      if (!f || !f.unique) throw badRequest(`Upsert matches on a unique field; ${spec.upsert.field} is not one of ${entity.name}.`);
      if (!out.some((m) => m.field !== 'label' && m.field.name === f.name)) throw badRequest(`Upsert by ${f.name} needs a column mapped to it.`);
    }
    if (spec.sourceKey && columns && !columns.includes(spec.sourceKey)) throw badRequest(`The source has no column ${spec.sourceKey} to key its rows.`);
    return out;
  }

  private mapRow(cols: { column: string; field: Field | 'label' }[], row: Row, sourceLabel: Label, entity: EntityRow): { values: Values; label: Label } {
    const values: Values = {};
    let label: Label = highest(entity.label, sourceLabel);
    for (const c of cols) {
      const v = row.values[c.column];
      if (c.field === 'label') {
        if (blank(v)) continue;
        const l = text(v).trim().toLowerCase() as Label;
        if (!LABELS.includes(l)) throw badRequest(`${text(v).slice(0, 40)} is not a label.`);
        label = highest(label, l);
      } else {
        const out = cellValue(c.field, v);
        if (out !== null) values[c.field.name] = out;
      }
    }
    return { values, label };
  }

  // ---------- submitting ----------

  /** Checks the spec against the entity and the source now, and queues the job. */
  async submit(actor: Actor & { principal: Principal }, app: AppRow, entity: EntityRow, spec: ImportSpec, o: { dryRun: boolean; scheduleId?: string | null }): Promise<{ id: string; jobId: string; rows: number }> {
    const p = actor.principal;
    if (!clears(p.clearance, entity.label)) throw forbidden(`Records of ${entity.name} are ${entity.label}; your clearance is ${p.clearance}.`, { step: 'clearance' });
    const r = await this.read(actor, spec.source);
    this.checkSourceLabel(p, app, r.label);
    const t = this.transform(r.table, spec.transforms);
    this.checkMapping(entity, spec, t.columns);
    if (!t.rows.length && !t.skipped.length) throw badRequest('The source has no data rows.');
    const id = ulid();
    const stored = { spec, pinned: r.version ?? null, scheduleId: o.scheduleId ?? null };
    await this.db('app_transfers').insert({ id, tenant_id: p.tenantId, app_id: app.id, entity_id: entity.id, kind: 'import', state: 'queued', dry_run: o.dryRun, input: await this.s().keys.seal(p.tenantId, JSON.stringify(stored), specAad(id)), blob_key: null, summary: null, report: null, error: null, job_id: null, created_by: p.userId, created_at: Date.now(), finished_at: null });
    const job = await this.s().jobs.enqueue({ tenantId: p.tenantId, type: 'apps.import', payload: { transferId: id, spec: 2 }, createdBy: p.userId, maxAttempts: 1 });
    await this.db('app_transfers').where({ id }).update({ job_id: job.id });
    await this.audit(actor, p.tenantId, 'app.import.queued', { app: app.id, entity: entity.id, transfer: id }, highest(entity.label, r.label), { source: spec.source.kind, format: r.table.format, rows: t.rows.length + t.skipped.length, transforms: spec.transforms.map((x) => x.kind), upsert: spec.upsert ?? null, sourceKey: spec.sourceKey ?? null, dryRun: o.dryRun, ...(o.scheduleId ? { schedule: o.scheduleId } : {}) });
    return { id, jobId: job.id, rows: t.rows.length + t.skipped.length };
  }

  /** "New entity from file": the entity through the design path (createEntity: checks, schema history, audit), then the import. */
  async createWithImport(actor: Actor & { principal: Principal }, appRef: string, input: z.infer<typeof newEntitySchema>) {
    const p = actor.principal;
    const app = await this.apps.designable(p, appRef);
    if (!authorize(p, 'records:write').allow) throw forbidden('Importing records needs records:write.', { step: 'permission', permission: 'records:write' });
    const r = await this.read(actor, input.source);
    this.checkSourceLabel(p, app, r.label);
    const label = input.entity.label ?? highest(app.label === 'public' ? 'public' : 'internal', r.label);
    if (labelRank(label) < labelRank(r.label)) throw badRequest(`The source is ${r.label}; the entity's records are at least that, so its label is ${r.label} or above.`);
    const fields = input.entity.columns.map((c) => c.field);
    const definition = definitionOf(fields, input.entity.titleField ?? null);
    const { entity } = await this.apps.createEntity(actor, app.id, { name: input.entity.name, ...(input.entity.title ? { title: input.entity.title } : {}), label, definition });
    const spec: ImportSpec = { source: input.source, transforms: input.transforms, mapping: input.entity.columns.map((c) => ({ column: c.column, field: c.field.name })), ...(input.upsert ? { upsert: input.upsert } : {}), ...(input.sourceKey ? { sourceKey: input.sourceKey } : {}) };
    await this.audit(actor, p.tenantId, 'app.import.entity-created', { app: app.id, entity: entity.id, name: entity.name }, label, { source: input.source.kind, fields: fields.length, format: r.table.format });
    const transfer = await this.submit(actor, app, entity, spec, { dryRun: input.dryRun });
    return { entity, transfer };
  }

  // ---------- the job ----------

  private async finish(id: string, patch: Record<string, unknown>): Promise<void> {
    await this.db('app_transfers').where({ id }).update({ ...patch, finished_at: Date.now() });
  }

  private async existingByKey(entity: EntityRow, field: Field, value: unknown): Promise<string | null> {
    let checked: unknown;
    try {
      checked = checkValue(field, value);
    } catch {
      return null;
    }
    const k = uniqueKeys(entity.id, { fields: [field] }, { [field.name]: checked })[0];
    if (!k) return null;
    const hit = (await this.db('app_unique_values').where({ entity_id: entity.id, field: field.name, value_hash: k.hash }).first('record_id')) as { record_id: string } | undefined;
    return hit?.record_id ?? null;
  }

  private async linked(entity: EntityRow, ref: string, key: string): Promise<string | null> {
    const r = (await this.db('app_import_keys').where({ entity_id: entity.id, source_ref: ref, row_key: key }).first('record_id')) as { record_id: string } | undefined;
    if (!r) return null;
    const rec = await this.db('app_records').where({ id: r.record_id, entity_id: entity.id }).first('id');
    return rec ? r.record_id : null;
  }

  private async link(entity: EntityRow, ref: string, key: string, recordId: string): Promise<void> {
    const t = Date.now();
    const n = await this.db('app_import_keys').where({ entity_id: entity.id, source_ref: ref, row_key: key }).update({ record_id: recordId, updated_at: t });
    if (n) return;
    try {
      await this.db('app_import_keys').insert({ entity_id: entity.id, tenant_id: entity.tenant_id, source_ref: ref, row_key: key, record_id: recordId, created_at: t, updated_at: t });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      await this.db('app_import_keys').where({ entity_id: entity.id, source_ref: ref, row_key: key }).update({ record_id: recordId, updated_at: t });
    }
  }

  /** The import job (`apps.import` with `spec: 2`): the same pipeline as the preview, row by row, as the starter. */
  async run(transferId: string, ctx: JobContext): Promise<unknown> {
    const s = this.s();
    const t = (await this.db('app_transfers').where({ id: transferId }).first()) as Record<string, unknown> | undefined;
    if (!t || t.state !== 'queued') return { skipped: t?.state ?? 'gone' };
    await this.db('app_transfers').where({ id: transferId }).update({ state: 'running' });
    const tenantId = String(t.tenant_id);
    const fail = async (error: string) => {
      await this.finish(transferId, { state: 'failed', error: error.slice(0, 500), input: null });
      await s.audit.append({ tenantId, action: 'app.import.failed', kind: 'system', actor: { service: 'apps.import', user: String(t.created_by) }, target: { app: String(t.app_id), entity: String(t.entity_id), transfer: transferId }, label: 'internal', detail: { error: error.slice(0, 300) } });
      return { error };
    };
    const p = await loadPrincipal(s, tenantId, String(t.created_by), {});
    if (!p || !authorize(p, 'records:write').allow) return fail('The person who started the import can no longer write records.');
    const app = await this.apps.appById(tenantId, String(t.app_id));
    const entity = await this.apps.entityById(tenantId, String(t.entity_id));
    if (!app || !entity) return fail('The app or entity is gone.');
    p.workspaceId = app.workspace_id;
    if (!clears(p.clearance, entity.label)) return fail(`Records of ${entity.name} are ${entity.label}; the starter's clearance is ${p.clearance}.`);
    const stored = json<{ spec: unknown; pinned: number | null }>(await s.keys.open(tenantId, String(t.input), specAad(transferId)), { spec: null, pinned: null });
    const parsed = importSpecSchema.safeParse(stored.spec);
    if (!parsed.success) return fail('The import settings could not be read.');
    const spec = parsed.data;
    const dry = !!t.dry_run;
    const actor: Actor & { principal: Principal } = { principal: p, source: 'import', service: 'apps.import' };
    let r: SourceRead;
    let tr: Transformed;
    let cols: { column: string; field: Field | 'label' }[];
    try {
      r = await this.read(actor, spec.source, { pinned: stored.pinned });
      this.checkSourceLabel(p, app, r.label);
      tr = this.transform(r.table, spec.transforms);
      cols = this.checkMapping(entity, spec, tr.columns);
    } catch (err) {
      return fail(messageOf(err));
    }
    const report: ReportRow[] = [];
    const counts = { created: 0, updated: 0, skipped: 0, failed: 0 };
    const errors: { row: Row; reason: string }[] = [];
    const add = (row: number, outcome: Outcome, extra: { problem?: string; record?: string } = {}) => {
      counts[outcome]++;
      if (report.length < REPORT_MAX) report.push({ row, outcome, ...(extra.problem ? { problem: extra.problem.slice(0, 300) } : {}), ...(extra.record ? { record: extra.record } : {}) });
    };
    const original = new Map(r.table.rows.map((x) => [x.n, x]));
    for (const sk of tr.skipped) add(sk.n, 'skipped', { problem: sk.reason });
    const upsertField = spec.upsert ? entity.definition.fields.find((f) => f.name === spec.upsert!.field)! : null;
    const grant = await this.apps.grantFor(p, entity);
    const seen = new Map<string, number>();
    const seenKeys = new Set<string>();
    const total = tr.rows.length;
    let cancelled = false;
    for (const [i, row] of tr.rows.entries()) {
      if (ctx.signal.aborted) {
        cancelled = true;
        break;
      }
      const failed = tr.failed.get(row.n);
      const reject = (reason: string) => {
        add(row.n, 'failed', { problem: reason });
        errors.push({ row: original.get(row.n) ?? row, reason });
      };
      if (failed) {
        reject(failed);
        continue;
      }
      try {
        const { values, label } = this.mapRow(cols, row, r.label, entity);
        if (labelRank(label) > labelRank(app.label)) throw forbidden(`The row would be ${label}; the app holds records up to ${app.label}.`);
        if (!clears(p.clearance, label)) throw forbidden(`The row would be ${label}; your clearance is ${p.clearance}.`);
        const rowKey = spec.sourceKey ? text(row.values[spec.sourceKey]).slice(0, 255) : '';
        if (spec.sourceKey && !rowKey) throw badRequest(`The key column ${spec.sourceKey} is empty.`);
        let existing: string | null = null;
        let keyText = '';
        if (upsertField) {
          if (values[upsertField.name] == null) throw badRequest(`The key field ${upsertField.name} is empty.`);
          keyText = `${upsertField.name}:${text(values[upsertField.name]).normalize('NFC').toLowerCase()}`;
          existing = await this.existingByKey(entity, upsertField, values[upsertField.name]);
        } else if (spec.sourceKey) {
          keyText = `key:${rowKey}`;
          existing = await this.linked(entity, r.ref, rowKey);
        }
        if (dry) {
          // Validation, policies and unique keys, as the real run would meet them; nothing is written.
          if (existing || (keyText && seenKeys.has(keyText))) {
            AppPolicies.checkWrite(grant, values, 'update');
            if (existing) {
              const rec = await this.apps.readable(p, entity, existing, grant);
              await this.apps.prepare(actor, app, entity, rec.id, values, await this.apps.open(rec));
            }
            add(row.n, 'updated', existing ? { record: existing } : {});
          } else if (spec.upsert?.mode === 'update-only') {
            add(row.n, 'skipped', { problem: `no record has this ${upsertField!.name}` });
          } else {
            if (labelRank(label) < labelRank(entity.label)) throw badRequest(`Records of ${entity.name} are at least ${entity.label}.`);
            AppPolicies.checkWrite(grant, values, 'create');
            const prep = await this.apps.prepare(actor, app, entity, ulid(), values, null);
            for (const k of prep.keys) {
              const key = `${k.field}:${k.hash}`;
              const dup = seen.get(key) ?? ((await this.db('app_unique_values').where({ entity_id: entity.id, field: k.field, value_hash: k.hash }).first('record_id')) ? 0 : undefined);
              if (dup !== undefined) throw conflict(`${k.field} duplicates ${dup ? `row ${dup}` : 'an existing record'}; it is unique.`);
              seen.set(key, row.n);
            }
            add(row.n, 'created');
          }
          if (keyText) seenKeys.add(keyText);
        } else if (existing) {
          const rec = await this.apps.readable(p, entity, existing, grant);
          const before = await this.apps.open(rec);
          const prep = await this.apps.prepare(actor, app, entity, rec.id, values, before);
          const changed = Object.keys(values).some((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(prep.values[k] ?? null));
          if (!changed) add(row.n, 'skipped', { problem: 'unchanged', record: rec.id });
          else {
            await this.apps.updateRecord(actor, app, entity, rec.id, { values });
            add(row.n, 'updated', { record: rec.id });
          }
          if (spec.sourceKey) await this.link(entity, r.ref, rowKey, rec.id);
        } else if (spec.upsert?.mode === 'update-only') {
          add(row.n, 'skipped', { problem: `no record has this ${upsertField!.name}` });
        } else {
          const out = await this.apps.createRecord(actor, app, entity, { values, label });
          add(row.n, 'created', { record: out.id });
          if (spec.sourceKey) await this.link(entity, r.ref, rowKey, out.id);
        }
      } catch (err) {
        reject(messageOf(err));
      }
      if (i % 50 === 0) await ctx.progress(Math.min(99, Math.round(((i + 1) * 100) / Math.max(1, total))), `${i + 1} of ${total} rows`);
    }
    report.sort((a, b) => a.row - b.row);
    const summary = { rows: total + tr.skipped.length, ...counts, created: dry ? 0 : counts.created, updated: dry ? 0 : counts.updated, valid: counts.created + counts.updated, wouldCreate: dry ? counts.created : undefined, wouldUpdate: dry ? counts.updated : undefined, dryRun: dry, source: spec.source.kind, format: r.table.format, truncated: r.truncated, ...(cancelled ? { cancelled: true } : {}), errors: errors.length };
    let blobKey: string | null = null;
    if (errors.length) {
      const header = ['row', 'reason', ...r.table.columns];
      const lines = [header.map(csvCell).join(','), ...errors.map((e) => [e.row.n, e.reason, ...r.table.columns.map((c) => e.row.values[c])].map(csvCell).join(','))];
      const body = Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8');
      blobKey = `apps/${tenantId}/imports/${transferId}-errors.csv.sealed`;
      await s.blobs.put(blobKey, Buffer.from(await s.keys.sealBytes(tenantId, body, errorsAad(transferId)), 'utf8'), 'application/octet-stream');
    }
    const label = highest(entity.label, r.label);
    await this.finish(transferId, { state: cancelled ? 'cancelled' : 'succeeded', summary: JSON.stringify({ ...summary, label }), report: JSON.stringify(report), input: null, blob_key: blobKey });
    await this.audit(actor, tenantId, cancelled ? 'app.import.cancelled' : dry ? 'app.import.checked' : 'app.import.completed', { app: app.id, entity: entity.id, transfer: transferId }, label, summary);
    if (cancelled) throw (ctx.signal.reason as Error) ?? new Error('cancelled');
    return summary;
  }

  /** The failed rows of an import with their reasons, as CSV, for the person who started it (audited). */
  async errorReport(actor: Actor & { principal: Principal }, id: string): Promise<{ name: string; body: Buffer }> {
    const p = actor.principal;
    const t = (await this.db('app_transfers').where({ tenant_id: p.tenantId, id, kind: 'import' }).first()) as Record<string, unknown> | undefined;
    if (!t || t.created_by !== p.userId) throw notFound('Import');
    if (!t.blob_key) throw conflict(t.state === 'queued' || t.state === 'running' ? `The import is ${String(t.state)}.` : 'The import has no failed rows.');
    const summary = json<{ label?: Label }>(t.summary, {});
    const label = summary.label ?? 'internal';
    if (!clears(p.clearance, label)) throw forbidden(`The report is ${label}; your clearance is ${p.clearance}.`, { step: 'clearance' });
    const sealed = await this.s().blobs.get(String(t.blob_key));
    if (!sealed) throw notFound('Error report');
    const body = await this.s().keys.openBytes(p.tenantId, sealed.toString('utf8'), errorsAad(id));
    const entity = await this.apps.entityById(p.tenantId, String(t.entity_id));
    await this.audit(actor, p.tenantId, 'app.import.errors.downloaded', { transfer: id, entity: String(t.entity_id) }, label, { bytes: body.length });
    return { name: `${entity?.name ?? 'import'}-${id}-errors.csv`, body };
  }

  /** Cancels a queued or running import: the job stops between rows and the rows written so far stay. */
  async cancel(actor: Actor & { principal: Principal }, id: string) {
    const p = actor.principal;
    const t = (await this.db('app_transfers').where({ tenant_id: p.tenantId, id, kind: 'import' }).first()) as Record<string, unknown> | undefined;
    if (!t || (t.created_by !== p.userId && !effectivePermissions(p).has('apps:design'))) throw notFound('Import');
    if (t.state !== 'queued' && t.state !== 'running') throw conflict(`The import is ${String(t.state)}.`);
    if (t.state === 'queued') await this.db('app_transfers').where({ id, state: 'queued' }).update({ state: 'cancelled', input: null, finished_at: Date.now(), summary: JSON.stringify({ cancelled: true }) });
    if (t.job_id) await this.s().jobs.cancel(p.tenantId, String(t.job_id));
    await this.audit(actor, p.tenantId, 'app.import.cancel-requested', { transfer: id, entity: String(t.entity_id) }, 'internal', { state: t.state });
    return this.apps.transfer(p, id);
  }

  // ---------- schedules (B-129) ----------

  private scheduleView(r: Record<string, unknown>, spec: ImportSpec | null) {
    return { id: String(r.id), entity: String(r.entity_id), cron: String(r.cron), schedule: describeCron(String(r.cron)), enabled: !!r.enabled, nextRunAt: r.next_run_at == null ? null : Number(r.next_run_at), lastRunAt: r.last_run_at == null ? null : Number(r.last_run_at), lastTransfer: (r.last_transfer_id as string | null) ?? null, lastResult: (r.last_result as string | null) ?? null, owner: String(r.owner_id), source: spec ? spec.source : null, mapping: spec?.mapping ?? null, transforms: spec?.transforms ?? null, upsert: spec?.upsert ?? null, sourceKey: spec?.sourceKey ?? null, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) };
  }

  private checkCron(expr: string): void {
    try {
      parseCron(expr);
    } catch (err) {
      throw badRequest(`The schedule is not a valid cron expression: ${(err as Error).message}`);
    }
    if (nextCron(expr, Date.now()) == null) throw badRequest('This cron expression never matches within a year.');
  }

  private async openSpec(r: Record<string, unknown>): Promise<ImportSpec | null> {
    const parsed = importSpecSchema.safeParse(json(await this.s().keys.open(String(r.tenant_id), String(r.spec), scheduleAad(String(r.id))), null));
    return parsed.success ? parsed.data : null;
  }

  async schedules(p: Principal, app: AppRow, entity: EntityRow) {
    const rows = (await this.db('app_import_schedules').where({ tenant_id: p.tenantId, app_id: app.id, entity_id: entity.id }).orderBy('created_at')) as Record<string, unknown>[];
    const design = effectivePermissions(p).has('apps:design');
    const out = [];
    for (const r of rows) if (design || r.owner_id === p.userId) out.push(this.scheduleView(r, await this.openSpec(r)));
    return out;
  }

  /** A scheduled re-import from a connection, run as its owner: checked now as a dry run would be (no job). */
  async createSchedule(actor: Actor & { principal: Principal }, app: AppRow, entity: EntityRow, input: z.infer<typeof scheduleInputSchema>) {
    const p = actor.principal;
    if (!CONNECTED.has(input.spec.source.kind)) throw badRequest('A scheduled import reads a connection, a saved query or a REST endpoint; a file is imported once.');
    this.checkCron(input.cron);
    const r = await this.read(actor, input.spec.source, { preview: true });
    this.checkSourceLabel(p, app, r.label);
    this.checkMapping(entity, input.spec, this.transform(r.table, input.spec.transforms).columns);
    const id = ulid();
    const t = Date.now();
    const row = { id, tenant_id: p.tenantId, app_id: app.id, entity_id: entity.id, owner_id: p.userId, cron: input.cron, spec: await this.s().keys.seal(p.tenantId, JSON.stringify(input.spec), scheduleAad(id)), enabled: input.enabled, next_run_at: input.enabled ? nextCron(input.cron, t) : null, last_run_at: null, last_transfer_id: null, last_result: null, created_at: t, updated_at: t };
    await this.db('app_import_schedules').insert(row);
    await this.audit(actor, p.tenantId, 'app.import.schedule.created', { app: app.id, entity: entity.id, schedule: id }, highest(entity.label, r.label), { cron: input.cron, source: input.spec.source.kind, enabled: input.enabled });
    return this.scheduleView(row, input.spec);
  }

  private async ownSchedule(p: Principal, app: AppRow, id: string): Promise<Record<string, unknown>> {
    const r = (await this.db('app_import_schedules').where({ tenant_id: p.tenantId, app_id: app.id, id }).first()) as Record<string, unknown> | undefined;
    if (!r || (r.owner_id !== p.userId && !effectivePermissions(p).has('apps:design'))) throw notFound('Import schedule');
    return r;
  }

  async updateSchedule(actor: Actor & { principal: Principal }, app: AppRow, id: string, patch: { cron?: string; enabled?: boolean }) {
    const p = actor.principal;
    const r = await this.ownSchedule(p, app, id);
    if (patch.cron) this.checkCron(patch.cron);
    const cron = patch.cron ?? String(r.cron);
    const enabled = patch.enabled ?? !!r.enabled;
    const t = Date.now();
    const upd = { cron, enabled, next_run_at: enabled ? nextCron(cron, t) : null, updated_at: t };
    await this.db('app_import_schedules').where({ id }).update(upd);
    await this.audit(actor, p.tenantId, 'app.import.schedule.updated', { app: app.id, entity: String(r.entity_id), schedule: id }, 'internal', { cron, enabled });
    return this.scheduleView({ ...r, ...upd }, await this.openSpec(r));
  }

  async removeSchedule(actor: Actor & { principal: Principal }, app: AppRow, id: string): Promise<void> {
    const p = actor.principal;
    const r = await this.ownSchedule(p, app, id);
    await this.db('app_import_schedules').where({ id }).delete();
    await this.audit(actor, p.tenantId, 'app.import.schedule.deleted', { app: app.id, entity: String(r.entity_id), schedule: id }, 'internal');
  }

  /** Runs a schedule now, outside its times (the owner's own check, as at every run). */
  async runSchedule(actor: Actor & { principal: Principal }, app: AppRow, id: string) {
    const r = await this.ownSchedule(actor.principal, app, id);
    return this.fire(r, Date.now());
  }

  /** Due schedules; each due time is claimed with one conditional update, so one instance runs it. */
  async tick(now = Date.now()): Promise<{ queued: number; skipped: number }> {
    const due = (await this.db('app_import_schedules').where({ enabled: true }).whereNotNull('next_run_at').andWhere('next_run_at', '<=', now).orderBy('next_run_at').limit(200)) as Record<string, unknown>[];
    let queued = 0;
    let skipped = 0;
    for (const r of due) {
      const claimed = await this.db('app_import_schedules').where({ id: r.id, next_run_at: r.next_run_at, enabled: true }).update({ next_run_at: nextCron(String(r.cron), now), last_run_at: now });
      if (!claimed) continue;
      const out = await this.fire(r, now);
      if ('transfer' in out) queued++;
      else skipped++;
    }
    return { queued, skipped };
  }

  /** One run of a schedule as its owner, re-checked: records:write, the connection right, clearance. */
  private async fire(r: Record<string, unknown>, now: number): Promise<{ transfer: string; jobId: string } | { skipped: string }> {
    const s = this.s();
    const tenantId = String(r.tenant_id);
    const done = async (patch: Record<string, unknown>) => {
      await this.db('app_import_schedules').where({ id: r.id }).update({ ...patch, last_run_at: now });
    };
    const skip = async (why: string) => {
      await done({ last_result: why.slice(0, 300) });
      await s.audit.append({ tenantId, action: 'app.import.schedule.skipped', kind: 'system', actor: { service: 'apps.import', user: String(r.owner_id) }, target: { schedule: String(r.id), app: String(r.app_id), entity: String(r.entity_id) }, label: 'internal', detail: { reason: why.slice(0, 300) } });
      return { skipped: why };
    };
    const p = await loadPrincipal(s, tenantId, String(r.owner_id), {});
    if (!p) return skip('The owner of the schedule is no longer active.');
    if (!authorize(p, 'records:write').allow) return skip('The owner can no longer write records.');
    const app = await this.apps.appById(tenantId, String(r.app_id));
    const entity = await this.apps.entityById(tenantId, String(r.entity_id));
    if (!app || !entity) return skip('The app or entity is gone.');
    p.workspaceId = app.workspace_id;
    const spec = await this.openSpec(r);
    if (!spec) return skip('The import settings could not be read.');
    try {
      const out = await this.submit({ principal: p, source: 'import', service: 'apps.import' }, app, entity, spec, { dryRun: false, scheduleId: String(r.id) });
      await done({ last_transfer_id: out.id, last_result: `queued ${out.rows} rows` });
      return { transfer: out.id, jobId: out.jobId };
    } catch (err) {
      return skip(messageOf(err));
    }
  }
}
