import { createHash, createSign } from 'node:crypto';
import { isIP } from 'node:net';
import { ulid } from 'ulid';
import { fetch, type Dispatcher } from 'undici';
import { addressProblem, guardedAgent, parseAllowList, type AllowList } from '../mcp/hosts.js';
import type { Classification } from './classify.js';
import type { AdminOp, DdlPlan } from './ddl.js';
import type { DescribedIndex, DescribeKind, ObjectDescription, RoutineDescription, TableDescription } from './ddl-edit-types.js';
import { parseType } from './ddl-types.js';
import { classifyDefault, emptyRoutine, emptyTable, splitQualified } from './describe-sql.js';
import { runStatements, type ConnectionSpec, type DataDriver, type QueryResult, type SchemaObject, type TestResult } from './drivers.js';

/*
 * 1.9.0: BigQuery over its REST API (jobs.query, getQueryResults, datasets.list), signed in as a service account.
 *
 * - The credential is the service account's JSON key (`spec.password`); `spec.username`, when given, must be its
 *   client_email. An access token comes from the key's token_uri by the RFC 7523 JWT bearer grant (RS256, one hour
 *   at most) and is kept in this process until shortly before it expires.
 * - Every request, the token request included, goes through undici with the guarded dispatcher (each address checked
 *   at dial time against internal hosts plus CONNECTIONS_ALLOWED_HOSTS), no redirects, and the connection's timeout.
 *   bigquery.googleapis.com and oauth2.googleapis.com must be on the operator's list.
 * - There is no read-only transaction: reads are held read-only by the classifier (classify-bigquery.ts) and by the
 *   account's roles (BigQuery Data Viewer and Job User only). `maximumBytesBilled` caps what a query may bill.
 * - A query that is not done by the timeout is cancelled.
 */

/** For tests only: a plain-HTTP base URL (and token URL) instead of https://<endpoint>. */
export interface BigQueryTesting {
  baseUrl?: string;
  allowHttp?: boolean;
}

interface ServiceKey {
  client_email: string;
  private_key: string;
  token_uri: string;
}

interface Field {
  name: string;
  type: string;
  mode?: string;
  fields?: Field[];
}

interface QueryAnswer {
  jobComplete?: boolean;
  jobReference?: { jobId?: string; location?: string };
  schema?: { fields?: Field[] };
  rows?: { f: { v: unknown }[] }[];
  pageToken?: string;
  totalRows?: string;
  totalBytesProcessed?: string;
}

const SCOPE = 'https://www.googleapis.com/auth/bigquery';
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const PART = /^[^`\\\n\r]{1,1024}$/;

/** An error answer of the REST API, with its status (409: the dataset or routine already exists). */
export class BigQueryApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/** Access tokens by service account, key and token URL, until 60 s before they expire. Process-local. */
const tokens = new Map<string, { token: string; until: number }>();

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** Backtick-quotes a dotted name, one part at a time. */
export function quoteBigQuery(name: string): string {
  const parts = name.split('.');
  if (parts.some((p) => !PART.test(p))) throw new Error(`${name.slice(0, 100)} is not a name BigQuery quoting can hold.`);
  return parts.map((p) => '`' + p + '`').join('.');
}

/** A JS value as a positional query parameter. */
export function bigQueryParam(v: unknown): Record<string, unknown> {
  const scalar = (x: unknown): { type: string; value?: string } => {
    if (x === null || x === undefined) return { type: 'STRING' };
    if (typeof x === 'boolean') return { type: 'BOOL', value: String(x) };
    if (typeof x === 'bigint') return { type: 'INT64', value: x.toString() };
    if (typeof x === 'number') return Number.isInteger(x) ? { type: 'INT64', value: String(x) } : { type: 'FLOAT64', value: String(x) };
    if (x instanceof Date) return { type: 'TIMESTAMP', value: x.toISOString() };
    if (typeof x === 'object') return { type: 'STRING', value: JSON.stringify(x) };
    return { type: 'STRING', value: String(x) };
  };
  if (Array.isArray(v)) {
    const items = v.map(scalar);
    return { parameterType: { type: 'ARRAY', arrayType: { type: items.find((i) => i.value !== undefined)?.type ?? 'STRING' } }, parameterValue: { arrayValues: items.map((i) => (i.value === undefined ? {} : { value: i.value })) } };
  }
  const s = scalar(v);
  return { parameterType: { type: s.type }, parameterValue: s.value === undefined ? {} : { value: s.value } };
}

/** One cell of a getQueryResults row, in the field's type. */
export function decodeBigQuery(field: Field, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (field.mode === 'REPEATED') return Array.isArray(v) ? v.map((x) => decodeBigQuery({ ...field, mode: 'NULLABLE' }, (x as { v: unknown }).v)) : null;
  switch (field.type) {
    case 'RECORD':
    case 'STRUCT': {
      const cells = (v as { f?: { v: unknown }[] }).f ?? [];
      return Object.fromEntries((field.fields ?? []).map((f, i) => [f.name, decodeBigQuery(f, cells[i]?.v)]));
    }
    case 'INTEGER':
    case 'INT64': {
      const n = Number(v);
      return Number.isSafeInteger(n) ? n : String(v);
    }
    case 'FLOAT':
    case 'FLOAT64': {
      const n = Number(v);
      return Number.isFinite(n) ? n : String(v);
    }
    case 'NUMERIC':
    case 'BIGNUMERIC': {
      const n = Number(v);
      return Number.isFinite(n) && String(n) === String(v) ? n : String(v);
    }
    case 'BOOLEAN':
    case 'BOOL':
      return v === true || v === 'true';
    case 'TIMESTAMP': {
      const n = Number(v);
      return Number.isFinite(n) ? new Date(Math.round(n * 1000)).toISOString() : String(v);
    }
    default:
      return String(v);
  }
}

/** The parameter type a watermark value is compared as, from the column's data type. */
const WATERMARK_TYPES: Record<string, string> = { TIMESTAMP: 'TIMESTAMP', DATETIME: 'DATETIME', DATE: 'DATE', TIME: 'TIME', INT64: 'INT64', NUMERIC: 'NUMERIC', BIGNUMERIC: 'BIGNUMERIC', FLOAT64: 'FLOAT64', STRING: 'STRING', BOOL: 'BOOL' };

export class BigQueryDriver implements DataDriver {
  private dispatcher: Dispatcher | null = null;
  private readonly base: string;
  private readonly project: string;

  constructor(
    private readonly spec: ConnectionSpec,
    /** Internal hosts only, unless CONNECTIONS_ALLOWED_HOSTS names the host or its network. */
    private readonly allow: AllowList = parseAllowList(''),
    private readonly testing: BigQueryTesting = {}
  ) {
    const host = (spec.endpoint || 'bigquery.googleapis.com').replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    this.base = (testing.baseUrl ?? `https://${host}`).replace(/\/+$/, '') + '/bigquery/v2';
    this.project = spec.database ?? '';
  }

  private get options() {
    return this.spec.options ?? {};
  }

  private key(): ServiceKey {
    let k: Partial<ServiceKey>;
    try {
      k = JSON.parse(this.spec.password ?? '') as Partial<ServiceKey>;
    } catch {
      throw new Error('The credential is not a service account JSON key.');
    }
    if (!k || typeof k.client_email !== 'string' || typeof k.private_key !== 'string') throw new Error('The service account key has no client_email or private_key.');
    if (this.spec.username && this.spec.username.toLowerCase() !== k.client_email.toLowerCase()) throw new Error(`The key belongs to ${k.client_email}, not to ${this.spec.username}.`);
    const tokenUri = typeof k.token_uri === 'string' && k.token_uri ? k.token_uri : 'https://oauth2.googleapis.com/token';
    return { client_email: k.client_email, private_key: k.private_key, token_uri: tokenUri };
  }

  /** The guarded dispatcher, after refusing an address literal that is not allowed (names are checked at dial time). */
  private guard(url: URL, timeoutMs: number): Dispatcher {
    if (url.protocol !== 'https:' && !(this.testing.allowHttp && url.protocol === 'http:')) throw new Error(`${url.origin} is not https.`);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) {
      const problem = addressProblem(host, host, this.allow);
      if (problem) throw new Error(problem);
    }
    this.dispatcher ??= guardedAgent(this.allow, timeoutMs);
    return this.dispatcher;
  }

  private async token(timeoutMs: number): Promise<string> {
    const k = this.key();
    const cacheKey = `${k.client_email}:${createHash('sha256').update(k.private_key).digest('hex').slice(0, 24)}:${k.token_uri}`;
    const hit = tokens.get(cacheKey);
    if (hit && hit.until > Date.now()) return hit.token;
    const url = new URL(k.token_uri);
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({ iss: k.client_email, sub: k.client_email, aud: k.token_uri, scope: SCOPE, iat: now, exp: now + 3600 }));
    let signature: string;
    try {
      signature = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(k.private_key, 'base64url');
    } catch {
      throw new Error('The service account key\'s private_key could not sign: it is not an RSA private key in PEM.');
    }
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${signature}` }).toString();
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body, signal: AbortSignal.timeout(timeoutMs), dispatcher: this.guard(url, timeoutMs), redirect: 'error' });
    const text = await res.text();
    let doc: { access_token?: string; expires_in?: number; error?: string; error_description?: string } = {};
    try {
      doc = JSON.parse(text) as typeof doc;
    } catch {
      // not JSON
    }
    if (!res.ok || !doc.access_token) throw new Error(`The token request to ${url.host} failed (${res.status}): ${String(doc.error_description ?? doc.error ?? 'no access_token').slice(0, 200)}`);
    if (tokens.size > 500) tokens.clear();
    tokens.set(cacheKey, { token: doc.access_token, until: Date.now() + Math.max(0, (Number(doc.expires_in) || 3600) - 60) * 1000 });
    return doc.access_token;
  }

  private async call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body: unknown, timeoutMs: number): Promise<T> {
    const url = new URL(this.base + path);
    const dispatcher = this.guard(url, timeoutMs);
    const token = await this.token(timeoutMs);
    const headers: Record<string, string> = { accept: 'application/json', authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), dispatcher, redirect: 'error' });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      // not JSON
    }
    if (!res.ok) {
      const err = data.error as { message?: string; status?: string } | undefined;
      throw new BigQueryApiError(`BigQuery ${res.status}${err?.status ? ` ${err.status}` : ''}: ${String(err?.message ?? text.slice(0, 200)).slice(0, 400)}`, res.status);
    }
    return data as T;
  }

  private projectPath(): string {
    if (!PROJECT.test(this.project)) throw new Error('The connection names no valid project id.');
    return `/projects/${encodeURIComponent(this.project)}`;
  }

  /**
   * Runs one query and reads up to `maxRows` rows: jobs.query, getQueryResults while the job runs (cancelled at the
   * deadline), then the next pages.
   */
  async runQuery(sql: string, params: unknown[], maxRows: number, timeoutMs: number, extra: Record<string, unknown> = {}): Promise<{ columns: string[]; rows: unknown[][]; totalRows: number | null; bytes: number | null }> {
    const deadline = Date.now() + timeoutMs;
    const left = () => Math.max(1, deadline - Date.now());
    const location = this.options.location as string | undefined;
    const body: Record<string, unknown> = {
      query: sql,
      useLegacySql: false,
      maxResults: Math.max(1, Math.min(maxRows, 10_000)),
      timeoutMs: Math.min(timeoutMs, 60_000),
      requestId: ulid(),
      labels: { client: 'exprsn-ai' },
      ...(location ? { location } : {}),
      ...(this.options.maximumBytesBilled ? { maximumBytesBilled: String(this.options.maximumBytesBilled) } : {}),
      ...(params.length ? { parameterMode: 'POSITIONAL', queryParameters: params.map(bigQueryParam) } : {}),
      ...extra
    };
    let r = await this.call<QueryAnswer>('POST', `${this.projectPath()}/queries`, body, left());
    if (extra.dryRun) return { columns: [], rows: [], totalRows: null, bytes: r.totalBytesProcessed ? Number(r.totalBytesProcessed) : null };
    const jobId = r.jobReference?.jobId;
    const jobLocation = r.jobReference?.location ?? location;
    const resultsPath = (q: Record<string, string>) => `${this.projectPath()}/queries/${encodeURIComponent(jobId ?? '')}?${new URLSearchParams({ ...(jobLocation ? { location: jobLocation } : {}), ...q }).toString()}`;
    let wait = 200;
    while (!r.jobComplete) {
      if (!jobId) throw new Error('BigQuery answered without a job reference.');
      if (Date.now() + wait >= deadline) {
        await this.call('POST', `${this.projectPath()}/jobs/${encodeURIComponent(jobId)}/cancel${jobLocation ? `?location=${encodeURIComponent(jobLocation)}` : ''}`, undefined, 5000).catch(() => undefined);
        throw new Error(`No answer within ${Math.round(timeoutMs / 1000)} s; the query job was cancelled.`);
      }
      await new Promise((res) => setTimeout(res, wait));
      wait = Math.min(wait * 2, 1000);
      r = await this.call<QueryAnswer>('GET', resultsPath({ maxResults: String(body.maxResults), timeoutMs: String(Math.min(left(), 10_000)) }), undefined, left());
    }
    const fields = r.schema?.fields ?? [];
    const rows: unknown[][] = [];
    const take = (a: QueryAnswer) => {
      for (const row of a.rows ?? []) {
        if (rows.length >= maxRows) break;
        rows.push(fields.map((f, i) => decodeBigQuery(f, row.f[i]?.v)));
      }
    };
    take(r);
    let token = r.pageToken;
    while (token && rows.length < maxRows && jobId) {
      const page = await this.call<QueryAnswer>('GET', resultsPath({ pageToken: token, maxResults: String(Math.min(maxRows - rows.length, 10_000)) }), undefined, left());
      take(page);
      token = page.pageToken;
    }
    return { columns: fields.map((f) => f.name), rows, totalRows: r.totalRows != null ? Number(r.totalRows) : null, bytes: r.totalBytesProcessed ? Number(r.totalBytesProcessed) : null };
  }

  async test(timeoutMs: number): Promise<TestResult> {
    const k = this.key();
    const dry = await this.runQuery('SELECT 1', [], 1, timeoutMs, { dryRun: true });
    const location = this.options.location as string | undefined;
    return {
      version: `BigQuery (project ${this.project})`,
      readOnly: true,
      health: 'healthy',
      detail: `Service account ${k.client_email} can run queries in ${this.project}${location ? ` (${location})` : ''}; a dry run passed${dry.bytes != null ? ` (${dry.bytes} bytes)` : ''}. BigQuery has no read-only transaction: reads stay read-only through the classifier and the account's roles. Grant BigQuery Data Viewer and Job User only.`
    };
  }

  async introspect(timeoutMs: number): Promise<SchemaObject[]> {
    this.projectPath(); // checks the project id
    const p = '`' + this.project + '`';
    const cols = (from: string) => `SELECT c.table_schema AS s, c.table_name AS n, c.column_name AS c, c.data_type AS t, t.table_type AS k FROM ${from}.INFORMATION_SCHEMA.COLUMNS AS c JOIN ${from}.INFORMATION_SCHEMA.TABLES AS t USING (table_schema, table_name) ORDER BY c.table_schema, c.table_name, c.ordinal_position`;
    const location = this.options.location as string | undefined;
    const sources: string[] = [];
    if (location) sources.push(`${p}.\`region-${location.toLowerCase()}\``);
    else {
      const ds = await this.call<{ datasets?: { datasetReference?: { datasetId?: string } }[] }>('GET', `${this.projectPath()}/datasets?maxResults=50`, undefined, timeoutMs);
      for (const d of (ds.datasets ?? []).slice(0, 50)) {
        const id = d.datasetReference?.datasetId;
        if (id && /^[A-Za-z0-9_]{1,1024}$/.test(id)) sources.push(`${p}.\`${id}\``);
      }
    }
    const byName = new Map<string, SchemaObject>();
    const deadline = Date.now() + timeoutMs;
    for (const from of sources) {
      if (byName.size >= 2000) break;
      const r = await this.runQuery(cols(from), [], 200_000, Math.max(1000, deadline - Date.now()));
      for (const [s, n, c, t, k] of r.rows as [string, string, string, string, string][]) {
        const name = `${s}.${n}`;
        let o = byName.get(name);
        if (!o) {
          if (byName.size >= 2000) continue;
          o = { name, kind: /VIEW/i.test(k) ? 'view' : 'table', columns: [] };
          byName.set(name, o);
        }
        o.columns.push({ name: c, type: t });
      }
    }
    return [...byName.values()];
  }

  async query(_c: Classification, text: string, opts: { limit: number; timeoutMs: number; params?: unknown[]; offset?: number }): Promise<QueryResult> {
    const inner = text.trim().replace(/;\s*$/, '');
    const offset = opts.offset && opts.offset > 0 ? ` OFFSET ${Math.floor(opts.offset)}` : '';
    const r = await this.runQuery(`SELECT * FROM (${inner}\n) AS exprsn_q LIMIT ${opts.limit + 1}${offset}`, opts.params ?? [], opts.limit + 1, opts.timeoutMs);
    const capped = r.rows.length > opts.limit;
    return { columns: r.columns, rows: r.rows.slice(0, opts.limit), capped, estimate: null };
  }

  async rows(object: string, opts: { watermarkColumn: string | null; after: string | null; limit: number; timeoutMs: number; fields?: string[] | null }): Promise<QueryResult> {
    const parts = object.split('.');
    if (parts.length < 2 || parts.length > 3) throw new Error(`${object} is not a dataset.table name.`);
    const table = quoteBigQuery(object);
    const wm = opts.watermarkColumn ? quoteBigQuery(opts.watermarkColumn) : null;
    const select = opts.fields?.length ? opts.fields.map(quoteBigQuery).join(', ') : '*';
    const params: unknown[] = [];
    let where = '';
    if (wm && opts.after != null) {
      // A watermark compares in its column's type: the parameter takes the type INFORMATION_SCHEMA gives the column.
      const ds = quoteBigQuery(parts.slice(0, -1).join('.'));
      const t = await this.runQuery(`SELECT data_type FROM ${ds}.INFORMATION_SCHEMA.COLUMNS WHERE table_name = ? AND column_name = ?`, [parts[parts.length - 1], opts.watermarkColumn], 1, opts.timeoutMs);
      const type = WATERMARK_TYPES[String(t.rows[0]?.[0] ?? 'STRING').toUpperCase()] ?? 'STRING';
      where = ` WHERE ${wm} > CAST(? AS ${type})`;
      params.push(String(opts.after));
    }
    const r = await this.runQuery(`SELECT ${select} FROM ${table}${where}${wm ? ` ORDER BY ${wm}` : ''} LIMIT ${opts.limit + 1}`, params, opts.limit + 1, opts.timeoutMs);
    return { columns: r.columns, rows: r.rows.slice(0, opts.limit), capped: r.rows.length > opts.limit, estimate: null };
  }

  /**
   * 2.0.x: a schema change on the admin service account. Tables and search indexes are statements, each run alone as
   * a query job (BigQuery commits each DDL statement on its own; in order, stopping at the first failure). Datasets
   * and routines are the plan's operations, sent to datasets.insert and routines.insert, so a routine's body travels
   * as a field and never inside other text.
   */
  async applyDdl(plan: DdlPlan, timeoutMs: number): Promise<{ applied: number; detail?: string }> {
    if (!plan.ops.length) return { applied: await runStatements(plan.statements, (sql) => this.runQuery(sql, [], 1, timeoutMs)) };
    const notes: string[] = [];
    let applied = 0;
    for (const op of plan.ops) {
      try {
        const note = await this.perform(op, timeoutMs);
        if (note) notes.push(note);
      } catch (err) {
        throw new Error(`Operation ${applied + 1} of ${plan.ops.length} failed after ${applied} applied: ${(err as Error).message}`, { cause: err });
      }
      applied++;
    }
    return notes.length ? { applied, detail: notes.join(' ') } : { applied };
  }

  /** One operation; returns a note when it found the object already there. */
  private async perform(op: AdminOp, timeoutMs: number): Promise<string | null> {
    const exists = (err: unknown) => err instanceof BigQueryApiError && err.status === 409;
    const datasetPath = (id: string) => `${this.projectPath()}/datasets/${encodeURIComponent(id)}`;
    if (op.op === 'bigquery.insertDataset') {
      // Without a location the dataset goes where the connection's queries run, as CREATE SCHEMA in a job there would.
      const location = op.location ?? (this.options.location as string | undefined) ?? null;
      const body = {
        datasetReference: { projectId: this.project, datasetId: op.datasetId },
        ...(location ? { location } : {}),
        ...(op.description ? { description: op.description } : {}),
        ...(op.defaultTableExpirationMs ? { defaultTableExpirationMs: String(op.defaultTableExpirationMs) } : {}),
        labels: { client: 'exprsn-ai' }
      };
      try {
        await this.call('POST', `${this.projectPath()}/datasets`, body, timeoutMs);
      } catch (err) {
        if (op.ifNotExists && exists(err)) return `Dataset ${op.datasetId} already exists; it was left as it is.`;
        throw err;
      }
      return null;
    }
    if (op.op === 'bigquery.insertRoutine') {
      const body = {
        routineReference: { projectId: this.project, datasetId: op.datasetId, routineId: op.routineId },
        routineType: op.routineType,
        language: op.language,
        arguments: op.arguments,
        ...(op.returnType ? { returnType: op.returnType } : {}),
        definitionBody: op.definitionBody
      };
      try {
        await this.call('POST', `${datasetPath(op.datasetId)}/routines`, body, timeoutMs);
      } catch (err) {
        if (!(op.replace && exists(err))) throw err;
        // CREATE OR REPLACE: routines.update replaces the whole routine.
        await this.call('PUT', `${datasetPath(op.datasetId)}/routines/${encodeURIComponent(op.routineId)}`, body, timeoutMs);
        return `Routine ${op.datasetId}.${op.routineId} existed and was replaced.`;
      }
      return null;
    }
    if (op.op === 'bigquery.deleteDataset') {
      try {
        await this.call('DELETE', `${datasetPath(op.datasetId)}?deleteContents=${op.deleteContents ? 'true' : 'false'}`, undefined, timeoutMs);
      } catch (err) {
        if (err instanceof BigQueryApiError && err.status === 404) throw new Error(`Dataset ${op.datasetId} does not exist.`, { cause: err });
        throw err;
      }
      return null;
    }
    if (op.op === 'bigquery.deleteRoutine') {
      try {
        await this.call('DELETE', `${datasetPath(op.datasetId)}/routines/${encodeURIComponent(op.routineId)}`, undefined, timeoutMs);
      } catch (err) {
        if (err instanceof BigQueryApiError && err.status === 404) throw new Error(`Routine ${op.datasetId}.${op.routineId} does not exist.`, { cause: err });
        throw err;
      }
      return null;
    }
    throw new Error(`BigQuery does not perform ${op.op}.`);
  }

  /**
   * 2.0.x editing: a table or view from tables.get (schema with descriptions, defaults and parameterised types,
   * partitioning, clustering, primary and foreign keys) and its search indexes from INFORMATION_SCHEMA; a routine from
   * routines.get. Null when it does not exist (404).
   */
  async describe(object: string, kind: DescribeKind, timeoutMs: number): Promise<ObjectDescription | null> {
    if (kind !== 'table' && kind !== 'view' && kind !== 'procedure' && kind !== 'function') throw new Error(`BigQuery has no ${kind} to describe.`);
    const [dataset, id] = splitQualified(object);
    if (!dataset) throw new Error(`${object} is not a dataset.table name.`);
    const missing = (err: unknown) => err instanceof BigQueryApiError && err.status === 404;
    try {
      return kind === 'table' || kind === 'view' ? await this.describeTable(dataset, id, timeoutMs) : await this.describeRoutine(dataset, id, kind, timeoutMs);
    } catch (err) {
      if (missing(err)) return null;
      throw err;
    }
  }

  private async describeTable(dataset: string, id: string, timeoutMs: number): Promise<TableDescription | null> {
    interface ApiField { name: string; type: string; mode?: string; description?: string; defaultValueExpression?: string; maxLength?: string; precision?: string; scale?: string; fields?: ApiField[] }
    const t = await this.call<{
      type?: string;
      description?: string;
      schema?: { fields?: ApiField[] };
      view?: { query?: string };
      materializedView?: { query?: string };
      timePartitioning?: { type?: string; field?: string };
      rangePartitioning?: { field?: string };
      clustering?: { fields?: string[] };
      tableConstraints?: { primaryKey?: { columns?: string[] }; foreignKeys?: { name?: string; referencedTable?: { datasetId?: string; tableId?: string }; columnReferences?: { referencingColumn: string; referencedColumn: string }[] }[] };
    }>('GET', `${this.projectPath()}/datasets/${encodeURIComponent(dataset)}/tables/${encodeURIComponent(id)}`, undefined, timeoutMs);
    const view = t.type === 'VIEW' || t.type === 'MATERIALIZED_VIEW';
    const out = emptyTable(view ? 'view' : 'table', `${dataset}.${id}`);
    out.comment = t.description ?? null;
    const typeText = (f: ApiField): string => {
      const base = f.type === 'RECORD' || f.type === 'STRUCT' ? `STRUCT<${(f.fields ?? []).map((x) => `${x.name} ${typeText(x)}`).join(', ')}>` : f.maxLength ? `${f.type}(${f.maxLength})` : f.precision ? `${f.type}(${f.precision}${f.scale ? `, ${f.scale}` : ''})` : f.type;
      return f.mode === 'REPEATED' ? `ARRAY<${base}>` : base;
    };
    for (const f of t.schema?.fields ?? []) {
      const raw = typeText(f);
      out.columns.push({ name: f.name, type: parseType('bigquery', raw), rawType: raw, nullable: f.mode !== 'REQUIRED' && f.mode !== 'REPEATED', default: classifyDefault(f.defaultValueExpression ?? null), identity: false, comment: f.description ?? null });
    }
    if (view) {
      out.definition = (t.view?.query ?? t.materializedView?.query ?? '').trim() || null;
      return out;
    }
    const pk = t.tableConstraints?.primaryKey?.columns;
    if (pk?.length) out.primaryKey = { name: null, columns: pk };
    for (const fk of t.tableConstraints?.foreignKeys ?? []) {
      const refs = fk.columnReferences ?? [];
      out.foreignKeys.push({ name: fk.name ?? '', columns: refs.map((r) => r.referencingColumn), refTable: `${fk.referencedTable?.datasetId ?? dataset}.${fk.referencedTable?.tableId ?? ''}`, refColumns: refs.map((r) => r.referencedColumn), onDelete: null, onUpdate: null });
    }
    const field = t.timePartitioning?.field ?? t.rangePartitioning?.field;
    if (field) out.options.partitionBy = field;
    else if (t.timePartitioning) out.options.partitionBy = '_PARTITIONTIME';
    if (t.timePartitioning?.type) out.options.partitionGranularity = t.timePartitioning.type;
    if (t.clustering?.fields?.length) out.options.clusterBy = t.clustering.fields;
    // Search indexes; a dataset without any (or a region without the view) has none.
    const ds = `\`${this.project}\`.${quoteBigQuery(dataset)}`;
    const idx = await this.runQuery(`SELECT i.index_name, c.index_column_name FROM ${ds}.INFORMATION_SCHEMA.SEARCH_INDEXES AS i LEFT JOIN ${ds}.INFORMATION_SCHEMA.SEARCH_INDEX_COLUMNS AS c ON c.index_name = i.index_name AND c.table_name = i.table_name WHERE i.table_name = ? ORDER BY i.index_name, c.index_column_name`, [id], 10_000, timeoutMs).catch(() => ({ rows: [] as unknown[][] }));
    const byName = new Map<string, DescribedIndex>();
    for (const [name, col] of idx.rows as [string, string | null][]) {
      let e = byName.get(name);
      if (!e) byName.set(name, (e = { name, columns: [], unique: false, method: 'search', where: null, include: [], constraint: false }));
      if (col) e.columns.push({ name: col });
    }
    out.indexes = [...byName.values()];
    return out;
  }

  private async describeRoutine(dataset: string, id: string, kind: 'procedure' | 'function', timeoutMs: number): Promise<RoutineDescription | null> {
    const typeOf = (t: { typeKind?: string } | undefined): string => (t?.typeKind ?? '').toUpperCase();
    const r = await this.call<{ routineType?: string; language?: string; arguments?: { name?: string; dataType?: { typeKind?: string }; mode?: string }[]; returnType?: { typeKind?: string }; definitionBody?: string; description?: string; determinismLevel?: string }>(
      'GET',
      `${this.projectPath()}/datasets/${encodeURIComponent(dataset)}/routines/${encodeURIComponent(id)}`,
      undefined,
      timeoutMs
    );
    const isProc = r.routineType === 'PROCEDURE';
    if (isProc !== (kind === 'procedure')) return null;
    const out = emptyRoutine(kind, `${dataset}.${id}`);
    out.params = (r.arguments ?? []).map((a) => ({ name: a.name ?? '', type: parseType('bigquery', typeOf(a.dataType)), rawType: typeOf(a.dataType), mode: a.mode === 'OUT' ? 'out' : a.mode === 'INOUT' ? 'inout' : 'in' }));
    out.returns = r.returnType ? { type: parseType('bigquery', typeOf(r.returnType)), rawType: typeOf(r.returnType) } : null;
    out.language = (r.language ?? 'SQL').toLowerCase();
    out.body = r.definitionBody ?? '';
    out.deterministic = r.determinismLevel === 'DETERMINISTIC' ? true : r.determinismLevel === 'NOT_DETERMINISTIC' ? false : null;
    out.comment = r.description ?? null;
    return out;
  }

  /** 2.0.x editing: the routines of the project's datasets (the first 50 datasets, as introspection reads them). */
  async routines(timeoutMs: number): Promise<{ name: string; kind: 'procedure' | 'function'; signature?: string | null }[]> {
    const deadline = Date.now() + timeoutMs;
    const left = () => Math.max(1000, deadline - Date.now());
    const ds = await this.call<{ datasets?: { datasetReference?: { datasetId?: string } }[] }>('GET', `${this.projectPath()}/datasets?maxResults=50`, undefined, left());
    const out: { name: string; kind: 'procedure' | 'function' }[] = [];
    for (const d of (ds.datasets ?? []).slice(0, 50)) {
      const id = d.datasetReference?.datasetId;
      if (!id) continue;
      let token: string | undefined;
      do {
        const page = await this.call<{ routines?: { routineReference?: { routineId?: string }; routineType?: string }[]; nextPageToken?: string }>('GET', `${this.projectPath()}/datasets/${encodeURIComponent(id)}/routines?maxResults=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`, undefined, left());
        for (const r of page.routines ?? []) if (r.routineReference?.routineId) out.push({ name: `${id}.${r.routineReference.routineId}`, kind: r.routineType === 'PROCEDURE' ? 'procedure' : 'function' });
        token = page.nextPageToken;
      } while (token && out.length < 2000);
      if (out.length >= 2000) break;
    }
    return out;
  }
}
