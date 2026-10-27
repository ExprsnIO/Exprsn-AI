import { ulid } from 'ulid';
import { clears, highest, labelRank, type Label } from '../../authz/labels.js';
import type { Principal } from '../../authz/policy.js';
import { json } from '../../db/knex.js';
import { forbidden, HttpProblem, notFound } from '../../http/problem.js';
import type { Services } from '../../services.js';
import { collect } from '../crypt.js';
import { fileView, type FileRow, type VersionRow } from '../service.js';
import { DOC_LIMITS, isSheetKind, kindOf, type Sheet, type Workbook } from './model.js';
import { columnValues, detectTypes, jsonTable, profileTable, QueryError, runQuery, sheetTable, sourceKey, sourcesOf, tableSheet, validateDefinition, type QTable, type QueryDefinition, type RunResult, type SourceRef } from './query.js';
import { FileDocuments } from './service.js';
import { sheetName } from './sheets.js';

/*
 * The table builder's service (`s.fileQueries`): reads the files a query names as the caller (so a file the caller
 * cannot read is not found, and its label counts), runs the query (`query.ts`), and keeps saved queries of a
 * workspace in `file_queries`. Loading a query writes its result as a new spreadsheet file, or as a sheet of an existing
 * one, through `FileDocuments` (so every write is a new version that is scanned like an upload); refreshing writes the
 * same place again.
 *
 * A query's label is the highest label of the versions it read. The result is written with at least that label, and
 * never into a file labelled below it.
 *
 * Decoded versions are kept in a small cache by version id (a version never changes), and only after the caller's
 * access to the file has been checked again on every read.
 */

const MAX_DEPTH = 3;
const CACHE_ENTRIES = 3;
const PREVIEW_ROWS = 200;
const JSON_TYPE = 'application/json';

export interface QueryRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  definition: string;
  output: string | null;
  label: Label;
  created_by: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
  refreshed_at: number | null;
  refreshed_rows: number | null;
  refresh_error: string | null;
}

export interface QueryOutput {
  fileId: string;
  sheet: string;
  kind: 'csv' | 'xlsx' | 'ods';
}

export type LoadTarget =
  | { mode: 'new'; name: string; kind: 'csv' | 'xlsx' | 'ods'; folderId?: string | null; sheet?: string; label?: Label }
  | { mode: 'existing'; fileId: string; sheet?: string };

type Decoded = { workbook: Workbook } | { table: QTable };

const problemOf = (err: unknown): never => {
  if (err instanceof QueryError) throw new HttpProblem(400, 'Invalid query', err.message);
  throw err;
};

export const queryView = (r: QueryRow) => ({
  id: r.id,
  workspaceId: r.workspace_id,
  name: r.name,
  description: r.description,
  definition: json<QueryDefinition | null>(r.definition, null),
  output: json<QueryOutput | null>(r.output, null),
  label: r.label,
  createdBy: r.created_by,
  updatedBy: r.updated_by,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
  refreshedAt: r.refreshed_at == null ? null : Number(r.refreshed_at),
  refreshedRows: r.refreshed_rows == null ? null : Number(r.refreshed_rows),
  refreshError: r.refresh_error
});

export class FileQueries {
  private readonly cache = new Map<string, Decoded>();
  private readonly docs: FileDocuments;

  constructor(private readonly s: () => Services) {
    this.docs = new FileDocuments(s);
  }

  private get db() {
    return this.s().db;
  }

  private get files() {
    return this.s().files;
  }

  // ---------- reading sources ----------

  private remember(versionId: string, d: Decoded): Decoded {
    this.cache.delete(versionId);
    this.cache.set(versionId, d);
    while (this.cache.size > CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
    return d;
  }

  /** A file's current version decoded, read as the caller; the version tells the label. */
  private async decodedFile(p: Principal, fileId: string): Promise<{ file: FileRow; version: VersionRow; decoded: Decoded }> {
    const { file, version } = await this.files.readyVersion(p, fileId);
    const hit = this.cache.get(version.id);
    if (hit) return { file, version, decoded: this.remember(version.id, hit) };
    const kind = kindOf(version.type, file.name);
    const isJson = version.type === JSON_TYPE;
    if (!isJson && (!kind || !isSheetKind(kind))) throw new HttpProblem(415, 'Not a table', `${file.name} is ${version.type ?? 'of an unknown type'}. Tables are read from Excel (.xlsx, .xls), OpenDocument (.ods), CSV, TSV and JSON files.`);
    if (version.size > DOC_LIMITS.maxBytes) throw new HttpProblem(413, 'Too large', `Tables are read from files of up to ${DOC_LIMITS.maxBytes.toLocaleString('en-US')} bytes.`);
    // Opened as the caller again: a version saved in between is the one decoded and cached.
    const opened = await this.files.content(p, fileId);
    const data = await collect(opened.stream, DOC_LIMITS.maxBytes);
    let decoded: Decoded;
    if (isJson) {
      try {
        decoded = { table: jsonTable(data.toString('utf8')) };
      } catch (err) {
        return problemOf(err);
      }
    } else decoded = { workbook: this.docs.decode(kindOf(opened.version.type, opened.file.name) ?? kind!, data).workbook! };
    return { file: opened.file, version: opened.version, decoded: this.remember(opened.version.id, decoded) };
  }

  /** The sheets of a file a query can start from, with their first-row names. */
  async tables(p: Principal, fileId: string) {
    const { file, version, decoded } = await this.decodedFile(p, fileId);
    const sheets = 'table' in decoded
      ? [{ name: null as string | null, rows: decoded.table.rows.length, header: true, columns: decoded.table.columns.slice(0, 200).map((c) => c.name) }]
      : decoded.workbook.sheets.map((s) => ({ name: s.name as string | null, rows: s.rows.length, header: s.header, columns: sheetTable(s, s.header).columns.slice(0, 200).map((c) => c.name) }));
    return { file: fileView(file), version: version.number, label: version.label, kind: 'table' in decoded ? 'json' : kindOf(version.type, file.name), sheets };
  }

  private pickSheet(file: FileRow, wb: Workbook, name: string | null | undefined): Sheet {
    if (!name) return wb.sheets[0]!;
    const s = wb.sheets.find((x) => x.name === name) ?? wb.sheets.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!s) throw new HttpProblem(422, 'Sheet not found', `${file.name} has no sheet named ${name}. Its sheets: ${wb.sheets.map((x) => x.name).join(', ')}.`);
    return s;
  }

  /** Every table a definition reads, loaded as the caller, and the highest label among them. */
  private async load(p: Principal, def: QueryDefinition, depth: number, visiting: Set<string>): Promise<{ tables: Map<string, QTable>; label: Label }> {
    const tables = new Map<string, QTable>();
    let label: Label = 'public';
    for (const ref of sourcesOf(def)) {
      const got = await this.table(p, ref, depth, visiting);
      tables.set(sourceKey(ref), got.table);
      label = highest(label, got.label);
    }
    return { tables, label };
  }

  private async table(p: Principal, ref: SourceRef, depth: number, visiting: Set<string>): Promise<{ table: QTable; label: Label }> {
    if (ref.kind === 'file') {
      const { file, version, decoded } = await this.decodedFile(p, ref.fileId);
      if ('table' in decoded) return { table: decoded.table, label: version.label };
      return { table: sheetTable(this.pickSheet(file, decoded.workbook, ref.sheet), ref.header), label: version.label };
    }
    if (visiting.has(ref.queryId)) throw new HttpProblem(422, 'Query loop', 'The query reads itself through the queries it references.');
    if (depth >= MAX_DEPTH) throw new HttpProblem(422, 'Too deep', `A query can reference queries up to ${MAX_DEPTH} deep.`);
    const row = await this.row(p, ref.queryId);
    const def = this.definitionOf(row);
    const next = new Set(visiting).add(row.id);
    const { tables, label } = await this.load(p, def, depth + 1, next);
    const run = runQuery(def, tables);
    if (run.error) throw new HttpProblem(422, 'Referenced query fails', `The query ${row.name} stops at step ${run.error.step + 1}: ${run.error.message}`);
    return { table: run.table, label: highest(label, row.label) };
  }

  private definitionOf(row: QueryRow): QueryDefinition {
    try {
      return validateDefinition(json<unknown>(row.definition, null));
    } catch (err) {
      return problemOf(err);
    }
  }

  private parse(input: unknown): QueryDefinition {
    try {
      return validateDefinition(input);
    } catch (err) {
      return problemOf(err);
    }
  }

  /** Runs a definition as the caller (`upto` steps when given). */
  async run(p: Principal, definition: unknown, o: { upto?: number; self?: string } = {}): Promise<RunResult & { label: Label; def: QueryDefinition }> {
    const def = this.parse(definition);
    const { tables, label } = await this.load(p, def, 0, new Set(o.self ? [o.self] : []));
    return { ...runQuery(def, tables, { upto: o.upto }), label, def };
  }

  /** The preview the editor shows: a page of rows, the row count, step errors and warnings, column quality. */
  async preview(p: Principal, input: { definition: unknown; upto?: number; offset?: number; limit?: number; self?: string }) {
    const r = await this.run(p, input.definition, input);
    const offset = Math.max(0, input.offset ?? 0);
    const limit = Math.min(1000, Math.max(1, input.limit ?? PREVIEW_ROWS));
    return {
      columns: r.table.columns,
      rows: r.table.rows.slice(offset, offset + limit),
      rowCount: r.table.rows.length,
      offset,
      applied: r.applied,
      steps: r.def.steps.length,
      error: r.error,
      warnings: r.warnings,
      label: r.label,
      profile: profileTable(r.table)
    };
  }

  async values(p: Principal, input: { definition: unknown; upto?: number; column: string; self?: string }) {
    const r = await this.run(p, input.definition, input);
    try {
      return columnValues(r.table, input.column);
    } catch (err) {
      return problemOf(err);
    }
  }

  async detect(p: Principal, input: { definition: unknown; upto?: number; self?: string }) {
    const r = await this.run(p, input.definition, input);
    return { columns: detectTypes(r.table) };
  }

  // ---------- saved queries ----------

  /** A saved query in one of the caller's workspaces that the caller is cleared for (404 otherwise). */
  async row(p: Principal, id: string): Promise<QueryRow> {
    const r = (await this.db('file_queries').where({ tenant_id: p.tenantId, id }).first()) as QueryRow | undefined;
    if (!r || !clears(p.clearance, r.label)) throw notFound('Query');
    await this.files.workspaceFor(p, r.workspace_id).catch(() => {
      throw notFound('Query');
    });
    return r;
  }

  async list(p: Principal, workspaceId?: string | null) {
    const ws = await this.files.workspaceFor(p, workspaceId);
    const rows = (await this.db('file_queries').where({ tenant_id: p.tenantId, workspace_id: ws.id }).orderBy('updated_at', 'desc')) as QueryRow[];
    return rows.filter((r) => clears(p.clearance, r.label)).map(queryView);
  }

  /** The label a definition carries now: the highest of the versions and queries it reads. */
  private async labelOf(p: Principal, def: QueryDefinition, self?: string): Promise<Label> {
    return (await this.load(p, def, 0, new Set(self ? [self] : []))).label;
  }

  async create(p: Principal, input: { name: string; description?: string | null; definition: unknown; workspaceId?: string | null }) {
    const ws = await this.files.workspaceFor(p, input.workspaceId);
    const def = this.parse(input.definition);
    const label = await this.labelOf(p, def);
    const now = Date.now();
    const row: QueryRow = { id: ulid(), tenant_id: p.tenantId, workspace_id: ws.id, name: input.name, description: input.description ?? null, definition: JSON.stringify(def), output: null, label, created_by: p.userId, updated_by: p.userId, created_at: now, updated_at: now, refreshed_at: null, refreshed_rows: null, refresh_error: null };
    await this.db('file_queries').insert(row);
    return row;
  }

  async update(p: Principal, id: string, patch: { name?: string; description?: string | null; definition?: unknown }) {
    const before = await this.row(p, id);
    const next: Partial<QueryRow> = { updated_by: p.userId, updated_at: Date.now() };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.description !== undefined) next.description = patch.description;
    if (patch.definition !== undefined) {
      const def = this.parse(patch.definition);
      next.definition = JSON.stringify(def);
      next.label = await this.labelOf(p, def, id);
    }
    await this.db('file_queries').where({ tenant_id: p.tenantId, id }).update(next);
    return { before, after: { ...before, ...next } as QueryRow };
  }

  async remove(p: Principal, id: string): Promise<QueryRow> {
    const r = await this.row(p, id);
    await this.db('file_queries').where({ tenant_id: p.tenantId, id }).delete();
    return r;
  }

  // ---------- loading results into files ----------

  /** Runs a saved query and writes its result where `target` says; the place is kept for refreshes. */
  async loadTo(p: Principal, id: string, target: LoadTarget) {
    const row = await this.row(p, id);
    const def = this.definitionOf(row);
    let r: Awaited<ReturnType<FileQueries['run']>>;
    try {
      r = await this.run(p, def, { self: row.id });
    } catch (err) {
      await this.failed(row, err);
      throw err;
    }
    if (r.error) {
      await this.failed(row, new Error(`Step ${r.error.step + 1}: ${r.error.message}`));
      throw new HttpProblem(422, 'Query fails', `The query stops at step ${r.error.step + 1}: ${r.error.message}`, { extensions: { step: r.error.step } });
    }
    let written;
    try {
      written = await this.write(p, row, r.table, r.label, target);
    } catch (err) {
      await this.failed(row, err);
      throw err;
    }
    const now = Date.now();
    const output: QueryOutput = { fileId: written.file.id, sheet: written.sheet, kind: written.kind };
    await this.db('file_queries').where({ tenant_id: p.tenantId, id: row.id }).update({ output: JSON.stringify(output), label: highest(row.label, r.label), refreshed_at: now, refreshed_rows: r.table.rows.length, refresh_error: null, updated_at: now, updated_by: p.userId });
    return { query: { ...row, output: JSON.stringify(output), label: highest(row.label, r.label), refreshed_at: now, refreshed_rows: r.table.rows.length, refresh_error: null }, ...written, rows: r.table.rows.length, warnings: r.warnings, label: r.label };
  }

  /** Writes the result again where the query was last loaded. */
  async refresh(p: Principal, id: string) {
    const row = await this.row(p, id);
    const out = json<QueryOutput | null>(row.output, null);
    if (!out) throw new HttpProblem(409, 'Not loaded yet', 'Load the query into a file first; refreshing writes the same place again.');
    return this.loadTo(p, id, { mode: 'existing', fileId: out.fileId, sheet: out.sheet });
  }

  private async failed(row: QueryRow, err: unknown): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err);
    await this.db('file_queries').where({ tenant_id: row.tenant_id, id: row.id }).update({ refresh_error: msg.slice(0, 2000), refreshed_at: Date.now() });
  }

  private async write(p: Principal, row: QueryRow, t: QTable, label: Label, target: LoadTarget) {
    if (target.mode === 'new') {
      const name = sheetName(target.sheet || row.name, new Set());
      const wb: Workbook = { sheets: [tableSheet(t, name)] };
      const { file, version } = await this.docs.create(p, { name: target.name, kind: target.kind, label: highest(label, target.label ?? 'public'), folderId: target.folderId ?? null, workspaceId: row.workspace_id, workbook: wb });
      return { file: fileView(file), version: version.number, versionState: version.state, sheet: name, kind: target.kind, created: true };
    }
    const doc = await this.docs.read(p, target.fileId);
    if (!doc.editable) throw forbidden(`${doc.file.name} cannot be written by you.`, { step: 'write' });
    if (doc.kind !== 'csv' && doc.kind !== 'xlsx' && doc.kind !== 'ods') throw new HttpProblem(415, 'Not writable here', `${doc.file.name} is ${doc.kind}; a query loads into an Excel (.xlsx), OpenDocument (.ods) or CSV file.`);
    if (labelRank(doc.label) < labelRank(label)) throw forbidden(`The query reads ${label} data; ${doc.file.name} is ${doc.label}. Load it into a file labelled ${label} or higher.`, { step: 'label' });
    const wb = doc.workbook!;
    let name: string;
    if (doc.kind === 'csv') {
      name = wb.sheets[0]?.name ?? 'Sheet1';
      wb.sheets = [tableSheet(t, name)];
    } else {
      const wanted = target.sheet || row.name;
      const at = wb.sheets.findIndex((s) => s.name.toLowerCase() === wanted.toLowerCase());
      if (at >= 0) {
        name = wb.sheets[at]!.name;
        wb.sheets[at] = tableSheet(t, name);
      } else {
        name = sheetName(wanted, new Set(wb.sheets.map((s) => s.name.toLowerCase())));
        wb.sheets.push(tableSheet(t, name));
      }
    }
    const saved = await this.docs.save(p, target.fileId, { kind: doc.kind, baseVersion: doc.version, workbook: wb, delimiter: doc.delimiter });
    return { file: saved.file, version: saved.version.number, versionState: saved.version.state, sheet: name, kind: doc.kind, created: false };
  }
}
