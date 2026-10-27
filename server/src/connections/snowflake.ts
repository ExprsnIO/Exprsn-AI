import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, type KeyObject } from 'node:crypto';
import { isIP } from 'node:net';
import { fetch, type Dispatcher } from 'undici';
import { addressProblem, guardedAgent, parseAllowList, type AllowList } from '../mcp/hosts.js';
import type { Classification } from './classify.js';
import type { DdlPlan } from './ddl.js';
import type { DescribeKind, ObjectDescription, RoutineDescription, TableDescription } from './ddl-edit-types.js';
import { parseType } from './ddl-types.js';
import { classifyDefault, emptyRoutine, emptyTable, fkAction, snowflakeTypeText, splitQualified, splitTopLevel, trimBody, unquoteIdent } from './describe-sql.js';
import { refuseOps, runStatements, type ConnectionSpec, type DataDriver, type QueryResult, type SchemaObject, type TestResult } from './drivers.js';

/*
 * 1.9.0: Snowflake over the SQL API v2 (`POST https://<account host>/api/v2/statements`).
 *
 * - Every request goes through undici with the guarded dispatcher (the host's addresses checked at dial time against
 *   the internal networks plus CONNECTIONS_ALLOWED_HOSTS), redirects refused, over HTTPS only.
 * - Authentication: a key-pair JWT (RS256, `iss` = ACCOUNT.USER.SHA256:<public key fingerprint>), minted per
 *   connection and renewed before it expires, or a programmatic access token. The secret never appears in a message.
 * - One statement per request (MULTI_STATEMENT_COUNT 1), bound values sent apart as positional bindings, the
 *   statement timeout from the connection. An answer still running (202) is polled until the timeout, then cancelled.
 * - The SQL API has no read-only transaction: what keeps reads read-only is the classifier and the role's grants,
 *   which `test` reads (SHOW GRANTS, following granted roles a few levels down).
 */

/** Bytes of one answer read at most. */
const MAX_ANSWER = 32 * 1024 * 1024;
const WRITE_PRIVILEGE = /^(INSERT|UPDATE|DELETE|TRUNCATE|OWNERSHIP|MODIFY|ALL|ALL PRIVILEGES|CREATE\b.*|APPLY\b.*|EXECUTE TASK|IMPORT SHARE|MANAGE GRANTS)$/i;

interface RowType {
  name: string;
  type: string;
  scale?: number | null;
}

interface StatementAnswer {
  code?: string;
  message?: string;
  sqlState?: string;
  statementHandle?: string;
  resultSetMetaData?: { numRows?: number; rowType?: RowType[]; partitionInfo?: { rowCount?: number }[] };
  data?: (string | null)[][];
}

export class SnowflakeError extends Error {}

/** The account identifier a key-pair JWT names, from the account host (ORGNAME-ACCT, or a legacy locator XY12345). */
export function snowflakeAccount(host: string): string {
  const h = host.toLowerCase().replace(/\.snowflakecomputing\.(com|cn)$/, '').replace(/\.privatelink$/, '');
  return (h.split('.')[0] ?? h).toUpperCase();
}

/** The `SHA256:<base64>` fingerprint of a private key's public half, as Snowflake stores RSA_PUBLIC_KEY_FP. */
export function publicKeyFingerprint(key: KeyObject): string {
  const der = createPublicKey(key).export({ type: 'spki', format: 'der' });
  return `SHA256:${createHash('sha256').update(der).digest('base64')}`;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** A KEYPAIR_JWT for `user` at `account`, valid for `seconds` (at most an hour). */
export function snowflakeJwt(account: string, user: string, key: KeyObject, now = Date.now(), seconds = 3600): string {
  const sub = `${account}.${user.toUpperCase()}`;
  const iat = Math.floor(now / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: `${sub}.${publicKeyFingerprint(key)}`, sub, iat, exp: iat + Math.min(seconds, 3600) }));
  return `${head}.${body}.${b64url(sign('sha256', Buffer.from(`${head}.${body}`), key))}`;
}

/** Positional bindings for `?` placeholders: values travel as strings with their Snowflake type. */
export function snowflakeBindings(params: readonly unknown[]): Record<string, { type: string; value: string | null }> {
  const out: Record<string, { type: string; value: string | null }> = {};
  params.forEach((v, i) => {
    const k = String(i + 1);
    if (v === null || v === undefined) out[k] = { type: 'TEXT', value: null };
    else if (typeof v === 'number') out[k] = Number.isInteger(v) ? { type: 'FIXED', value: String(v) } : { type: 'REAL', value: String(v) };
    else if (typeof v === 'bigint') out[k] = { type: 'FIXED', value: v.toString() };
    else if (typeof v === 'boolean') out[k] = { type: 'BOOLEAN', value: v ? 'true' : 'false' };
    else if (v instanceof Date) out[k] = { type: 'TEXT', value: v.toISOString() };
    else if (typeof v === 'object') out[k] = { type: 'TEXT', value: JSON.stringify(v) };
    else out[k] = { type: 'TEXT', value: String(v) };
  });
  return out;
}

/** A value of the answer in its column's type: integers and reals as numbers (when exact), booleans, the rest text. */
export function snowflakeValue(t: RowType, v: string | null): unknown {
  if (v === null) return null;
  const type = t.type.toLowerCase();
  if (type === 'fixed' && !t.scale) {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : v;
  }
  if (type === 'real') {
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  }
  if (type === 'boolean') return v === 'true' || v === '1' ? true : v === 'false' || v === '0' ? false : v;
  return v;
}

/** A Snowflake identifier: a plain name as written (folded by Snowflake), anything else quoted exactly. */
export const snowflakeIdent = (name: string): string =>
  name
    .split('.')
    .map((p) => '"' + p.replace(/"/g, '""') + '"')
    .join('.');
const plainOrQuoted = (name: string): string => (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) ? name : snowflakeIdent(name));

export interface SnowflakeDriverOptions {
  /**
   * Tests only: allow an `http://` endpoint (the in-process fake API). Production endpoints are always HTTPS; the
   * driver refuses `http://` without this.
   */
  allowHttp?: boolean;
  /** Tests only: the poll interval for a statement still running. */
  pollMs?: number;
}

export class SnowflakeDriver implements DataDriver {
  private readonly base: string;
  private dispatcher: Dispatcher | null = null;
  private jwt: { token: string; until: number } | null = null;

  constructor(
    private readonly spec: ConnectionSpec,
    /** Internal hosts only, unless CONNECTIONS_ALLOWED_HOSTS names the host or its network. */
    private readonly allow: AllowList = parseAllowList(''),
    private readonly opts: SnowflakeDriverOptions = {}
  ) {
    const e = spec.endpoint.trim().replace(/\/+$/, '');
    this.base = /^[a-z]+:\/\//i.test(e) ? e : `https://${e}`;
  }

  private get options(): Record<string, unknown> {
    return this.spec.options ?? {};
  }

  private url(path: string): URL {
    const u = new URL(this.base);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && this.opts.allowHttp)) throw new SnowflakeError('A Snowflake endpoint is reached over https:// only.');
    if (u.username || u.password || u.search) throw new SnowflakeError('The Snowflake endpoint is a host name, without credentials or a query string.');
    return new URL(path, `${u.origin}/`);
  }

  private guard(timeoutMs: number): Dispatcher {
    const host = new URL(this.base).hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) {
      const problem = addressProblem(host, host, this.allow);
      if (problem) throw new SnowflakeError(problem);
    }
    this.dispatcher ??= guardedAgent(this.allow, timeoutMs);
    return this.dispatcher;
  }

  /** The Authorization headers: a key-pair JWT (cached until five minutes before it expires) or a token. */
  private authHeaders(): Record<string, string> {
    const secret = this.spec.password ?? '';
    if (!secret) throw new SnowflakeError('The connection has no private key or token.');
    if (this.options.auth === 'pat') return { authorization: `Bearer ${secret}`, 'x-snowflake-authorization-token-type': 'PROGRAMMATIC_ACCESS_TOKEN' };
    if (!this.spec.username) throw new SnowflakeError('Key-pair authentication names the Snowflake user.');
    if (!this.jwt || this.jwt.until < Date.now()) {
      let key: KeyObject;
      try {
        key = createPrivateKey({ key: secret, format: 'pem' });
      } catch {
        throw new SnowflakeError('The private key is not an unencrypted PEM key (PKCS#8, BEGIN PRIVATE KEY).');
      }
      if (key.asymmetricKeyType !== 'rsa') throw new SnowflakeError('Snowflake key-pair authentication takes an RSA key.');
      const host = new URL(this.base).hostname;
      this.jwt = { token: snowflakeJwt(snowflakeAccount(host), this.spec.username, key), until: Date.now() + 55 * 60_000 };
    }
    return { authorization: `Bearer ${this.jwt.token}`, 'x-snowflake-authorization-token-type': 'KEYPAIR_JWT' };
  }

  private async call(method: 'GET' | 'POST', path: string, body: unknown, deadline: number): Promise<{ status: number; doc: StatementAnswer }> {
    const left = deadline - Date.now();
    if (left <= 0) throw new SnowflakeError('No answer within the timeout.');
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'exprsn-ai', ...this.authHeaders() };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(this.url(path), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(left), dispatcher: this.guard(left), redirect: 'error' });
    const declared = Number(res.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > MAX_ANSWER) {
      await res.body?.cancel().catch(() => undefined);
      throw new SnowflakeError(`The answer is larger than ${MAX_ANSWER / 1024 / 1024} MB.`);
    }
    const text = await res.text();
    if (text.length > MAX_ANSWER) throw new SnowflakeError(`The answer is larger than ${MAX_ANSWER / 1024 / 1024} MB.`);
    let doc: StatementAnswer = {};
    try {
      doc = text ? (JSON.parse(text) as StatementAnswer) : {};
    } catch {
      // not JSON
    }
    if (res.status >= 400 || (res.status !== 200 && res.status !== 202)) {
      const what = doc.message ? `${doc.code ? `${doc.code}: ` : ''}${doc.message}` : text.slice(0, 200) || res.statusText;
      throw new SnowflakeError(`Snowflake ${res.status}: ${what}`.slice(0, 500));
    }
    return { status: res.status, doc };
  }

  /** Runs one statement and reads up to `max` rows of its result. */
  private async execute(statement: string, bindings: readonly unknown[], timeoutMs: number, max: number): Promise<{ columns: string[]; rows: unknown[][]; total: number | null }> {
    const deadline = Date.now() + Math.max(1000, timeoutMs);
    const o = this.options;
    const body = {
      statement,
      timeout: Math.max(1, Math.ceil(timeoutMs / 1000)),
      ...(this.spec.database ? { database: this.spec.database } : {}),
      ...(o.schema ? { schema: String(o.schema) } : {}),
      ...(o.warehouse ? { warehouse: String(o.warehouse) } : {}),
      ...(o.role ? { role: String(o.role) } : {}),
      ...(bindings.length ? { bindings: snowflakeBindings(bindings) } : {}),
      parameters: { MULTI_STATEMENT_COUNT: '1', QUERY_TAG: 'exprsn-ai' }
    };
    let { status, doc } = await this.call('POST', `/api/v2/statements?requestId=${randomUUID()}`, body, deadline);
    const handle = doc.statementHandle;
    let wait = this.opts.pollMs ?? 500;
    while (status === 202) {
      if (!handle) throw new SnowflakeError('Snowflake answered 202 without a statement handle.');
      if (Date.now() + wait >= deadline) {
        await this.call('POST', `/api/v2/statements/${encodeURIComponent(handle)}/cancel`, {}, Date.now() + 5000).catch(() => undefined);
        throw new SnowflakeError(`The statement did not finish within ${Math.ceil(timeoutMs / 1000)} s; it was cancelled.`);
      }
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, 2000);
      ({ status, doc } = await this.call('GET', `/api/v2/statements/${encodeURIComponent(handle)}`, undefined, deadline));
    }
    const meta = doc.resultSetMetaData ?? {};
    const types = meta.rowType ?? [];
    const conv = (row: (string | null)[]) => types.map((t, i) => snowflakeValue(t, row[i] ?? null));
    const rows: unknown[][] = (doc.data ?? []).slice(0, max).map(conv);
    const parts = meta.partitionInfo?.length ?? 1;
    for (let p = 1; p < parts && rows.length < max; p++) {
      if (!handle) break;
      const next = await this.call('GET', `/api/v2/statements/${encodeURIComponent(handle)}?partition=${p}`, undefined, deadline);
      for (const r of next.doc.data ?? []) {
        if (rows.length >= max) break;
        rows.push(conv(r));
      }
    }
    return { columns: types.map((t) => t.name), rows, total: meta.numRows ?? null };
  }

  /** The role's privileges, following granted roles a few levels down (bounded). */
  private async writeGrants(role: string, timeoutMs: number): Promise<string[]> {
    const seen = new Set<string>();
    const writes: string[] = [];
    const queue: { role: string; depth: number }[] = [{ role, depth: 0 }];
    while (queue.length && seen.size < 20) {
      const { role: r, depth } = queue.shift()!;
      if (seen.has(r.toUpperCase())) continue;
      seen.add(r.toUpperCase());
      const g = await this.execute(`SHOW GRANTS TO ROLE ${plainOrQuoted(r)}`, [], timeoutMs, 5000);
      const col = (n: string) => g.columns.findIndex((c) => c.toLowerCase() === n);
      const [priv, on, name] = [col('privilege'), col('granted_on'), col('name')];
      for (const row of g.rows) {
        const p = String(row[priv] ?? '');
        const target = String(row[on] ?? '');
        if (target.toUpperCase() === 'ROLE' && p.toUpperCase() === 'USAGE' && depth < 3) queue.push({ role: String(row[name] ?? ''), depth: depth + 1 });
        else if (WRITE_PRIVILEGE.test(p)) writes.push(`${p} on ${target.toLowerCase()} ${String(row[name] ?? '')}`.trim());
      }
    }
    return writes;
  }

  async test(timeoutMs: number): Promise<TestResult> {
    const who = await this.execute('SELECT CURRENT_VERSION() AS VERSION, CURRENT_USER() AS USER_NAME, CURRENT_ROLE() AS ROLE_NAME, CURRENT_WAREHOUSE() AS WAREHOUSE, CURRENT_DATABASE() AS DATABASE_NAME', [], timeoutMs, 1);
    const row = who.rows[0] ?? [];
    const [version, user, role, warehouse, database] = row.map((v) => (v == null ? null : String(v)));
    const writes = role ? await this.writeGrants(role, timeoutMs) : ['no current role'];
    const readOnly = writes.length === 0;
    const where = `${user ?? 'the user'} with role ${role ?? 'none'}${warehouse ? ` on warehouse ${warehouse}` : ', no warehouse'}${database ? `, database ${database}` : ''}`;
    const tail = 'The SQL API has no read-only transaction: the classifier and the role\'s grants keep reads read-only.';
    return {
      version: `Snowflake ${version ?? 'unknown'}`,
      readOnly,
      health: warehouse ? 'healthy' : 'degraded',
      detail: (readOnly ? `${where} holds no write privileges. ${tail}` : `${where} holds ${writes.length} write privilege${writes.length === 1 ? '' : 's'} (${writes.slice(0, 3).join('; ')}). ${tail} Use a role with SELECT only.`) + (warehouse ? '' : ' Name a warehouse: queries need one.')
    };
  }

  async introspect(timeoutMs: number): Promise<SchemaObject[]> {
    if (!this.spec.database) throw new SnowflakeError('Name the database the connection reads.');
    const db = plainOrQuoted(this.spec.database);
    const t = await this.execute(`SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM ${db}.INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA <> 'INFORMATION_SCHEMA' ORDER BY 1, 2 LIMIT 2000`, [], timeoutMs, 2000);
    const cols = await this.execute(`SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM ${db}.INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA <> 'INFORMATION_SCHEMA' ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION LIMIT 100000`, [], timeoutMs, 100_000);
    const byName = new Map<string, SchemaObject>();
    for (const [s, n, k] of t.rows) byName.set(`${String(s)}.${String(n)}`, { name: `${String(s)}.${String(n)}`, kind: /VIEW/i.test(String(k)) ? 'view' : 'table', columns: [] });
    for (const [s, n, c, ty] of cols.rows) byName.get(`${String(s)}.${String(n)}`)?.columns.push({ name: String(c), type: String(ty).toLowerCase() });
    return [...byName.values()];
  }

  async query(_c: Classification, text: string, opts: { limit: number; timeoutMs: number; params?: unknown[]; offset?: number }): Promise<QueryResult> {
    const inner = text.trim().replace(/;\s*$/, '');
    const offset = opts.offset && opts.offset > 0 ? ` OFFSET ${Math.floor(opts.offset)}` : '';
    const r = await this.execute(`SELECT * FROM (${inner}\n) AS exprsn_q LIMIT ${opts.limit + 1}${offset}`, opts.params ?? [], opts.timeoutMs, opts.limit + 1);
    return { columns: r.columns, rows: r.rows.slice(0, opts.limit), capped: r.rows.length > opts.limit, estimate: null };
  }

  async rows(object: string, opts: { watermarkColumn: string | null; after: string | null; limit: number; timeoutMs: number; fields?: string[] | null }): Promise<QueryResult> {
    const wm = opts.watermarkColumn ? snowflakeIdent(opts.watermarkColumn) : null;
    const where = wm && opts.after != null ? ` WHERE ${wm} > ?` : '';
    const sql = `SELECT * FROM ${snowflakeIdent(object)}${where}${wm ? ` ORDER BY ${wm}` : ''} LIMIT ${opts.limit + 1}`;
    const r = await this.execute(sql, where ? [opts.after] : [], opts.timeoutMs, opts.limit + 1);
    return { columns: r.columns, rows: r.rows.slice(0, opts.limit), capped: r.rows.length > opts.limit, estimate: null };
  }

  /**
   * 2.0.x: a schema change on the admin account (its role from the connection's settings). Snowflake commits each
   * DDL statement on its own, so each goes in its own request (MULTI_STATEMENT_COUNT 1, as for reads) with the
   * statement timeout, in order, stopping at the first failure.
   */
  async applyDdl(plan: DdlPlan, timeoutMs: number): Promise<{ applied: number }> {
    refuseOps(plan, 'Snowflake');
    return { applied: await runStatements(plan.statements, (sql) => this.execute(sql, [], timeoutMs, 0)) };
  }

  /** Rows of a result as objects keyed by lower-case column name. */
  private async records(sql: string, binds: unknown[], timeoutMs: number, max = 10_000): Promise<Record<string, unknown>[]> {
    const r = await this.execute(sql, binds, timeoutMs, max);
    const names = r.columns.map((c) => c.toLowerCase());
    return r.rows.map((row) => Object.fromEntries(names.map((n, i) => [n, row[i]])));
  }

  private home(given: string | null): string {
    return given ?? (this.options.schema ? String(this.options.schema) : 'PUBLIC');
  }

  /**
   * 2.0.x editing: a table, view or routine read back from the database's INFORMATION_SCHEMA and SHOW … KEYS (keys
   * are not in INFORMATION_SCHEMA). Snowflake standard tables have no indexes and no CHECK constraints.
   */
  async describe(object: string, kind: DescribeKind, timeoutMs: number): Promise<ObjectDescription | null> {
    if (kind !== 'table' && kind !== 'view' && kind !== 'procedure' && kind !== 'function') throw new SnowflakeError(`Snowflake has no ${kind} to describe.`);
    if (!this.spec.database) throw new SnowflakeError('Name the database the connection reads.');
    return kind === 'table' || kind === 'view' ? this.describeTable(object, timeoutMs) : this.describeRoutine(object, kind, timeoutMs);
  }

  private async describeTable(object: string, timeoutMs: number): Promise<TableDescription | null> {
    const db = plainOrQuoted(this.spec.database!);
    const [given, table] = splitQualified(object);
    const schema = this.home(given);
    const t = (await this.records(`SELECT TABLE_TYPE, IS_TRANSIENT, CLUSTERING_KEY, COMMENT FROM ${db}.INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`, [schema, table], timeoutMs, 1))[0];
    if (!t) return null;
    const view = /VIEW/i.test(String(t.table_type));
    const out = emptyTable(view ? 'view' : 'table', `${schema}.${table}`);
    out.comment = t.comment == null || t.comment === '' ? null : String(t.comment);
    const n = (v: unknown) => (v == null || v === '' ? null : Number(v));
    const cols = await this.records(
      `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, DATETIME_PRECISION, IS_NULLABLE, COLUMN_DEFAULT, IS_IDENTITY, COMMENT FROM ${db}.INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [schema, table],
      timeoutMs
    );
    for (const c of cols) {
      const raw = snowflakeTypeText({ dataType: String(c.data_type), length: n(c.character_maximum_length), precision: n(c.numeric_precision), scale: n(c.numeric_scale), datetimePrecision: n(c.datetime_precision) });
      const identity = c.is_identity === 'YES' || /\.NEXTVAL$/i.test(String(c.column_default ?? ''));
      out.columns.push({ name: String(c.column_name), type: parseType('snowflake', raw), rawType: raw, nullable: c.is_nullable === 'YES', default: identity ? null : classifyDefault(c.column_default == null ? null : String(c.column_default)), identity, comment: c.comment == null || c.comment === '' ? null : String(c.comment) });
    }
    if (view) {
      const v = (await this.records(`SELECT VIEW_DEFINITION FROM ${db}.INFORMATION_SCHEMA.VIEWS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`, [schema, table], timeoutMs, 1))[0];
      out.definition = v?.view_definition == null ? null : String(v.view_definition).trim();
      return out;
    }
    if (t.is_transient === 'YES') out.options.transient = true;
    const ck = t.clustering_key == null ? '' : String(t.clustering_key);
    const lin = /^\s*LINEAR\s*\(([\s\S]*)\)\s*$/i.exec(ck);
    if (ck) out.options.clusterBy = splitTopLevel(lin ? lin[1]! : ck).map(unquoteIdent);
    const full = `${db}.${plainOrQuoted(schema)}.${plainOrQuoted(table)}`;
    const group = (rows: Record<string, unknown>[], nameKey: string) => {
      const m = new Map<string, Record<string, unknown>[]>();
      for (const r of rows) {
        const k = String(r[nameKey] ?? '');
        m.set(k, [...(m.get(k) ?? []), r]);
      }
      for (const v of m.values()) v.sort((a, b) => Number(a.key_sequence) - Number(b.key_sequence));
      return m;
    };
    const pk = group(await this.records(`SHOW PRIMARY KEYS IN TABLE ${full}`, [], timeoutMs), 'constraint_name');
    for (const [name, rows] of pk) out.primaryKey = { name, columns: rows.map((r) => String(r.column_name)) };
    const uq = group(await this.records(`SHOW UNIQUE KEYS IN TABLE ${full}`, [], timeoutMs), 'constraint_name');
    for (const [name, rows] of uq) out.uniques.push({ name, columns: rows.map((r) => String(r.column_name)) });
    const fk = group(await this.records(`SHOW IMPORTED KEYS IN TABLE ${full}`, [], timeoutMs), 'fk_name');
    for (const [name, rows] of fk) {
      const r0 = rows[0]!;
      out.foreignKeys.push({ name, columns: rows.map((r) => String(r.fk_column_name)), refTable: `${String(r0.pk_schema_name)}.${String(r0.pk_table_name)}`, refColumns: rows.map((r) => String(r.pk_column_name)), onDelete: fkAction(r0.delete_rule as string | null), onUpdate: fkAction(r0.update_rule as string | null) });
    }
    return out;
  }

  private async describeRoutine(object: string, kind: 'procedure' | 'function', timeoutMs: number): Promise<RoutineDescription | null> {
    const db = plainOrQuoted(this.spec.database!);
    const [given, name] = splitQualified(object);
    const schema = this.home(given);
    const P = kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION';
    const r = (await this.records(`SELECT ARGUMENT_SIGNATURE, DATA_TYPE, ${P}_LANGUAGE AS LANG, ${P}_DEFINITION AS DEF, COMMENT FROM ${db}.INFORMATION_SCHEMA.${P}S WHERE ${P}_SCHEMA = ? AND ${P}_NAME = ? ORDER BY ARGUMENT_SIGNATURE`, [schema, name], timeoutMs, 1))[0];
    if (!r) return null;
    const out = emptyRoutine(kind, `${schema}.${name}`);
    const sig = String(r.argument_signature ?? '()').trim().replace(/^\(|\)$/g, '');
    out.params = splitTopLevel(sig).map((p) => {
      const m = /^("(?:[^"]|"")+"|\S+)\s+([\s\S]+)$/.exec(p.trim());
      const rawType = (m?.[2] ?? p).trim();
      return { name: unquoteIdent(m?.[1] ?? ''), type: parseType('snowflake', rawType), rawType, mode: 'in' as const };
    });
    out.signature = out.params.map((p) => p.rawType).join(', ');
    const ret = r.data_type == null ? '' : String(r.data_type).trim();
    out.returns = ret ? { type: parseType('snowflake', ret), rawType: ret } : null;
    out.language = r.lang == null ? null : String(r.lang).toLowerCase();
    out.body = r.def == null ? '' : trimBody(String(r.def));
    out.comment = r.comment == null || r.comment === '' ? null : String(r.comment);
    return out;
  }

  /** 2.0.x editing: the database's procedures and functions (user-defined), with their argument types. */
  async routines(timeoutMs: number): Promise<{ name: string; kind: 'procedure' | 'function'; signature?: string | null }[]> {
    if (!this.spec.database) throw new SnowflakeError('Name the database the connection reads.');
    const db = plainOrQuoted(this.spec.database);
    const out: { name: string; kind: 'procedure' | 'function'; signature: string | null }[] = [];
    for (const P of ['PROCEDURE', 'FUNCTION'] as const) {
      const rows = await this.records(`SELECT ${P}_SCHEMA AS S, ${P}_NAME AS N, ARGUMENT_SIGNATURE AS SIG FROM ${db}.INFORMATION_SCHEMA.${P}S WHERE ${P}_SCHEMA <> 'INFORMATION_SCHEMA' ORDER BY 1, 2 LIMIT 2000`, [], timeoutMs, 2000);
      for (const r of rows) {
        const types = splitTopLevel(String(r.sig ?? '()').trim().replace(/^\(|\)$/g, '')).map((p) => p.trim().replace(/^("(?:[^"]|"")+"|\S+)\s+/, ''));
        out.push({ name: `${String(r.s)}.${String(r.n)}`, kind: P === 'PROCEDURE' ? 'procedure' : 'function', signature: types.join(', ') });
      }
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
}
