import { isIP } from 'node:net';
import { fetch, type Dispatcher } from 'undici';
import { addressProblem, guardedAgent, parseAllowList, type AllowList } from '../mcp/hosts.js';
import { classifySql, type Classification } from './classify.js';
import type { DdlPlan } from './ddl.js';
import type { ConnectionSpec, DataDriver, QueryResult, SchemaObject, TestResult } from './drivers.js';
import type { NonSqlContext } from './nonsql.js';

/*
 * 1.9.0: InfluxDB. Versions 1 and 2 read InfluxQL through `GET /query` (2 through its v1 compatibility API, with a
 * token); version 3 reads InfluxQL or SQL through `POST /api/v3/query_influxql` and `/api/v3/query_sql`. Flux is never
 * offered: it can write (`to()`).
 *
 * - The classifier reads one InfluxQL statement: SELECT without INTO, EXPLAIN SELECT, and the SHOW statements that
 *   list schema; SHOW TAG VALUES and SHOW SERIES only with FROM (they read data); writes, DDL, user and query
 *   administration are refused. Measurements come from FROM (names, `db.rp.m` with the connection's database, and
 *   regexes the allow-list can cover as a glob). SQL (version 3) goes through the SQL classifier.
 * - The query may be JSON `{"query", "params"}`: InfluxQL and v3 SQL bind `$name` parameters apart from the text, so
 *   saved-query parameters fill `params`, never the text.
 * - Every request goes through undici with the guarded dispatcher, redirects refused, answers capped at 16 MB.
 * - 2.0.x: a previewed schema plan (`applyDdl`) makes a database on the connection's separate admin account only:
 *   1.x `CREATE DATABASE "<name>" [WITH DURATION <d>]` as a POST /query with `q` in the form body (an admin user);
 *   3 `POST /api/v3/configure/database` (an admin token). 2.x makes buckets in its own API and is refused.
 *   2.0.x editing: a plan may drop a database the same way: 1.x `DROP DATABASE "<name>"` (POST /query, an admin
 *   user), 3 `DELETE /api/v3/configure/database?db=<name>` (an admin token); 2.x refused.
 */

const MAX_ANSWER = 16 * 1024 * 1024;
const MAX_MEASUREMENTS = 500;

interface Tok {
  t: 'ident' | 'qident' | 'str' | 'num' | 'regex' | 'param' | 'punct';
  v: string;
}

const REGEX_BEFORE = new Set(['FROM', 'SELECT', ',', '=~', '!~', '(']);

function lex(q: string): { toks: Tok[]; statements: number } | string {
  const toks: Tok[] = [];
  let statements = 0;
  let open = false;
  let i = 0;
  const prev = () => {
    const p = toks[toks.length - 1];
    return p ? (p.t === 'ident' ? p.v.toUpperCase() : p.t === 'punct' ? p.v : '') : 'START';
  };
  while (i < q.length) {
    const c = q[i]!;
    if (/\s/.test(c)) i++;
    else if (c === '-' && q[i + 1] === '-') {
      while (i < q.length && q[i] !== '\n') i++;
    } else if (c === '/' && q[i + 1] === '*') {
      const end = q.indexOf('*/', i + 2);
      if (end < 0) return 'an unterminated comment';
      i = end + 2;
    } else if (c === ';') {
      if (open) statements++;
      open = false;
      i++;
    } else if (c === '"' || c === "'" || (c === '/' && REGEX_BEFORE.has(prev()))) {
      let v = '';
      let j = i + 1;
      let closed = false;
      while (j < q.length) {
        if (q[j] === '\\') {
          // A regex keeps its escapes; a string or a quoted identifier drops them.
          v += c === '/' ? q.slice(j, j + 2) : (q[j + 1] ?? '');
          j += 2;
        } else if (q[j] === c) {
          closed = true;
          j++;
          break;
        } else v += q[j++];
      }
      if (!closed) return c === '/' ? 'an unterminated regex' : 'an unterminated string';
      toks.push({ t: c === '"' ? 'qident' : c === "'" ? 'str' : 'regex', v });
      open = true;
      i = j;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(q.slice(i))!;
      toks.push({ t: 'ident', v: m[0] });
      open = true;
      i += m[0].length;
    } else if (c === '$') {
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*/.exec(q.slice(i));
      if (!m) return 'a $ without a parameter name';
      toks.push({ t: 'param', v: m[0] });
      open = true;
      i += m[0].length;
    } else if (/[0-9]/.test(c)) {
      const m = /^\d+(\.\d+)?([eE][-+]?\d+)?(ns|u|µ|ms|s|m|h|d|w)?/.exec(q.slice(i))!;
      toks.push({ t: 'num', v: m[0] });
      open = true;
      i += m[0].length;
    } else {
      const two = q.slice(i, i + 2);
      if (['=~', '!~', '!=', '<>', '>=', '<=', '::'].includes(two)) {
        toks.push({ t: 'punct', v: two });
        i += 2;
      } else if ('(),.*+-/%=<>&|^:'.includes(c)) {
        toks.push({ t: 'punct', v: c });
        i++;
      } else return `the character ${JSON.stringify(c)}`;
      open = true;
    }
  }
  if (open) statements++;
  return { toks, statements };
}

const MEASUREMENT = /^[A-Za-z0-9_:-]+$/;

/** The measurements a FROM regex stands for: `^name$`, `^(a|b)$`, or `^prefix` / `^prefix.*` as the glob `prefix*`. */
export function measurementRegexObjects(re: string): string[] | null {
  const anchored = re.startsWith('^');
  const body = re.replace(/^\^/, '');
  const exact = body.endsWith('$') && !body.endsWith('\\$');
  const inner = exact ? body.slice(0, -1) : body;
  if (!anchored) return null;
  const group = /^\((.*)\)$/.exec(inner);
  const alts = (group ? group[1]! : inner).split('|');
  if (exact && alts.every((a) => MEASUREMENT.test(a))) return alts;
  const prefix = /^([A-Za-z0-9_:-]+)(\.\*)?$/.exec(inner);
  if (prefix && !exact) return [`${prefix[1]}*`];
  if (prefix && exact && prefix[2]) return [`${prefix[1]}*`];
  return null;
}

const END_FROM = new Set(['WHERE', 'GROUP', 'ORDER', 'LIMIT', 'OFFSET', 'SLIMIT', 'SOFFSET', 'FILL', 'TZ', 'INTO', 'WITH']);
const WRITE = new Set(['DELETE', 'INSERT']);
const DDL = new Set(['CREATE', 'DROP', 'ALTER', 'GRANT', 'REVOKE', 'KILL', 'SET']);
const SHOW_LISTS = new Set(['MEASUREMENTS', 'FIELD', 'RETENTION', 'DATABASES', 'TAG', 'SERIES', 'MEASUREMENT']);
const SHOW_DENIED = new Set(['USERS', 'GRANTS', 'QUERIES', 'STATS', 'DIAGNOSTICS', 'SHARDS', 'SHARD', 'SUBSCRIPTIONS', 'CONTINUOUS']);

const refuse = (kind: Classification['kind'], verb: string | null, reason: string, objects: string[] = [], denied?: string): Classification => ({ kind, verb, objects, reason, ...(denied ? { denied } : {}) });
const up = (t: Tok | undefined) => (t && t.t === 'ident' ? t.v.toUpperCase() : '');

/** One InfluxQL statement: its verb, its measurements, or a refusal. */
export function classifyInfluxQL(q: string, database: string | null): Classification {
  const lexed = lex(q);
  if (typeof lexed === 'string') return refuse('unparsed', null, `The parser does not read ${lexed}.`);
  const { toks, statements } = lexed;
  if (!toks.length) return refuse('unparsed', null, 'The query is empty.');
  if (statements > 1) return refuse('multiple', null, 'Send one statement at a time.');
  let first = 0;
  let verb = up(toks[0]);
  if (verb === 'EXPLAIN') {
    first = up(toks[1]) === 'ANALYZE' ? 2 : 1;
    if (up(toks[first]) !== 'SELECT') return refuse('unparsed', 'EXPLAIN', 'EXPLAIN reads SELECT statements only.');
    verb = 'EXPLAIN';
  }
  if (WRITE.has(verb)) return refuse('write', verb, 'The statement writes data.');
  if (DDL.has(verb)) return refuse('ddl', verb, `A ${verb} statement changes the database, its users or its queries.`);
  let needFrom = false;
  if (verb === 'SHOW') {
    const what = up(toks[1]);
    if (SHOW_DENIED.has(what)) return refuse('denied', `SHOW ${what}`, `SHOW ${what} is server administration, not data.`, [], `SHOW ${what}`);
    if (!SHOW_LISTS.has(what)) return refuse('unparsed', `SHOW ${what}`, `The parser does not know SHOW ${what}.`);
    const sub = `${what} ${up(toks[2])}`;
    // Tag values and series are data: they are read only from named measurements.
    needFrom = sub === 'TAG VALUES' || what === 'SERIES';
    verb = `SHOW ${what}${['TAG', 'FIELD', 'RETENTION', 'MEASUREMENT'].includes(what) ? ` ${up(toks[2])}` : ''}`;
  } else if (verb !== 'SELECT' && verb !== 'EXPLAIN') return refuse('unparsed', verb || null, `The parser does not know ${verb || 'this'} statements.`);
  if (toks.some((t) => up(t) === 'INTO')) return refuse('write', 'SELECT INTO', 'SELECT INTO writes the result into a measurement.');

  const objects: string[] = [];
  /** Reads the source at `j` (a measurement, `db.rp.m`, or a regex); a subquery is read as the tokens go by. */
  const source = (j: number): Classification | null => {
    const t = toks[j];
    if (!t || t.v === '(') return null;
    if (t.t === 'regex') {
      const objs = measurementRegexObjects(t.v);
      if (!objs) return refuse('denied', verb, `The measurement regex /${t.v.slice(0, 80)}/ cannot be checked against the allow-list: anchor it (^name$, ^(a|b)$ or ^prefix).`, objects, `/${t.v.slice(0, 80)}/`);
      objects.push(...objs);
      return null;
    }
    const parts = [''];
    let k = j;
    while (k < toks.length && (toks[k]!.t === 'ident' || toks[k]!.t === 'qident' || toks[k]!.v === '.')) {
      if (toks[k]!.t === 'ident' && END_FROM.has(up(toks[k])) && parts[parts.length - 1] === '' && parts.length === 1) break;
      if (toks[k]!.v === '.') parts.push('');
      else {
        if (parts[parts.length - 1]) break; // two names in a row: the second is a keyword
        parts[parts.length - 1] = toks[k]!.v;
      }
      k++;
    }
    if (parts.length > 3 || !parts[parts.length - 1]) return refuse('unparsed', verb, 'A measurement the parser does not read.');
    if (parts.length === 3 && parts[0] && parts[0] !== database) return refuse('denied', verb, `${parts[0]} is not this connection's database.`, objects, parts.join('.'));
    objects.push(parts[parts.length - 1]!);
    return null;
  };
  let depth = 0;
  const fromAt: number[] = [];
  for (let i = first; i < toks.length; i++) {
    const tk = toks[i]!;
    if (tk.v === '(') depth++;
    else if (tk.v === ')') {
      while (fromAt.length && fromAt[fromAt.length - 1]! >= depth) fromAt.pop();
      depth--;
    }
    const w = up(tk);
    if (END_FROM.has(w)) while (fromAt.length && fromAt[fromAt.length - 1] === depth) fromAt.pop();
    let at = -1;
    if (w === 'FROM') {
      fromAt.push(depth);
      at = i + 1;
    } else if (tk.v === ',' && fromAt.length && fromAt[fromAt.length - 1] === depth) at = i + 1;
    if (at >= 0) {
      const r = source(at);
      if (r) return r;
    }
  }
  const uniq = [...new Set(objects)];
  if ((verb === 'SELECT' || verb === 'EXPLAIN') && !uniq.length) return refuse('unparsed', verb, 'The query reads no measurement the parser could find.');
  if (needFrom && !uniq.length) return refuse('denied', verb, `${verb} without FROM reads every measurement: name them with FROM.`, [], verb);
  return { kind: 'read', verb, objects: uniq };
}

/**
 * InfluxDB: InfluxQL (or SQL for version 3 with `language: sql`), as text or as JSON `{"query", "params"}`. `op`
 * carries the language, the text and the bound parameters.
 */
export function classifyInflux(query: string, _object: string | null, ctx: NonSqlContext): Classification {
  let text = query.trim();
  let params: Record<string, string | number | boolean | null> | undefined;
  if (text.startsWith('{')) {
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      return refuse('unparsed', null, 'The request is neither InfluxQL nor JSON with a "query".');
    }
    const d = doc as Record<string, unknown>;
    if (!d || typeof d !== 'object' || Array.isArray(d) || typeof d.query !== 'string') return refuse('unparsed', null, 'JSON requests name the statement as "query".');
    const extra = Object.keys(d).filter((k) => k !== 'query' && k !== 'params');
    if (extra.length) return refuse('unparsed', null, `Unknown fields: ${extra.join(', ')}.`);
    if (d.params !== undefined) {
      if (!d.params || typeof d.params !== 'object' || Array.isArray(d.params)) return refuse('unparsed', null, '"params" is an object of values.');
      for (const [k, v] of Object.entries(d.params)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || (v !== null && !['string', 'number', 'boolean'].includes(typeof v))) return refuse('unparsed', null, `The parameter ${k.slice(0, 40)} is not a name with a plain value.`);
      params = d.params as Record<string, string | number | boolean | null>;
    }
    text = d.query.trim();
  }
  const sql = ctx.options.version === 'v3' && ctx.options.language === 'sql';
  if (sql) {
    const cl = classifySql(text);
    const objects = cl.objects.map((o) => o.replace(/^iox\./, ''));
    return cl.kind === 'read' ? { ...cl, objects, op: { lang: 'sql', query: text, ...(params ? { params } : {}) } } : { ...cl, objects };
  }
  const cl = classifyInfluxQL(text, ctx.database);
  return cl.kind === 'read' ? { ...cl, op: { lang: 'influxql', query: text, ...(params ? { params } : {}) } } : cl;
}

interface InfluxSeries {
  name?: string;
  tags?: Record<string, string>;
  columns?: string[];
  values?: unknown[][];
}

const isoTime = (v: unknown): unknown => (typeof v === 'number' ? new Date(v).toISOString() : v);

/** InfluxQL series as columns and rows: tags first, then the series' columns, with `measurement` when there are several. */
export function seriesRows(series: InfluxSeries[]): { columns: string[]; rows: unknown[][] } {
  const tags = new Set<string>();
  const cols: string[] = [];
  for (const s of series) {
    for (const k of Object.keys(s.tags ?? {})) tags.add(k);
    for (const c of s.columns ?? []) if (!cols.includes(c)) cols.push(c);
  }
  const several = new Set(series.map((s) => s.name)).size > 1;
  const tagCols = [...tags].sort();
  const columns = [...(several ? ['measurement'] : []), ...tagCols, ...cols];
  const rows: unknown[][] = [];
  for (const s of series) {
    const idx = (s.columns ?? []).map((c) => cols.indexOf(c));
    for (const v of s.values ?? []) {
      const row = cols.map(() => null as unknown);
      v.forEach((x, i) => {
        const at = idx[i]!;
        row[at] = cols[at] === 'time' ? isoTime(x) : x;
      });
      rows.push([...(several ? [s.name ?? null] : []), ...tagCols.map((k) => s.tags?.[k] ?? null), ...row]);
    }
  }
  return { columns, rows };
}

/** v3 JSON rows (objects) as columns and rows. */
function objectRows(items: Record<string, unknown>[]): { columns: string[]; rows: unknown[][] } {
  const columns: string[] = [];
  for (const it of items) for (const k of Object.keys(it)) if (!columns.includes(k) && columns.length < 500) columns.push(k);
  return { columns, rows: items.map((it) => columns.map((k) => it[k] ?? null)) };
}

export class InfluxDriver implements DataDriver {
  private readonly base: string;
  private dispatcher: Dispatcher | null = null;

  constructor(
    private readonly spec: ConnectionSpec,
    /** Internal hosts only, unless CONNECTIONS_ALLOWED_HOSTS names the host or its network. */
    private readonly allow: AllowList = parseAllowList('')
  ) {
    const e = spec.endpoint.trim().replace(/\/+$/, '');
    this.base = /^https?:\/\//i.test(e) ? e : `${spec.tls ? 'https' : 'http'}://${e}`;
  }

  private get version(): 'v1' | 'v2' | 'v3' {
    const v = this.spec.options?.version;
    return v === 'v1' || v === 'v3' ? v : 'v2';
  }

  private guard(timeoutMs: number): Dispatcher {
    const host = new URL(this.base).hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) {
      const problem = addressProblem(host, host, this.allow);
      if (problem) throw new Error(problem);
    }
    this.dispatcher ??= guardedAgent(this.allow, timeoutMs);
    return this.dispatcher;
  }

  private auth(): Record<string, string> {
    const v = this.version;
    if (v === 'v1') return this.spec.username ? { authorization: 'Basic ' + Buffer.from(`${this.spec.username}:${this.spec.password ?? ''}`).toString('base64') } : {};
    if (!this.spec.password) return {};
    return { authorization: v === 'v2' ? `Token ${this.spec.password}` : `Bearer ${this.spec.password}` };
  }

  private url(path: string): URL {
    const u = new URL(this.base);
    if (u.username || u.password) throw new Error('Credentials do not belong in the endpoint; give them as the connection\'s account.');
    return new URL(u.pathname.replace(/\/+$/, '') + path, u.origin);
  }

  private async send(method: 'GET' | 'POST' | 'DELETE', url: URL, body: unknown, timeoutMs: number): Promise<{ status: number; headers: Headers; text: string }> {
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'exprsn-ai', ...this.auth() };
    // A form (InfluxDB 1.x writes through POST /query take `q` in the body); anything else is sent as JSON.
    const form = body instanceof URLSearchParams;
    if (body !== undefined) headers['content-type'] = form ? 'application/x-www-form-urlencoded' : 'application/json';
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : form ? body.toString() : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), dispatcher: this.guard(timeoutMs), redirect: 'error' });
    const declared = Number(res.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > MAX_ANSWER) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`The answer is larger than ${MAX_ANSWER / 1024 / 1024} MB.`);
    }
    const text = await res.text();
    if (text.length > MAX_ANSWER) throw new Error(`The answer is larger than ${MAX_ANSWER / 1024 / 1024} MB.`);
    return { status: res.status, headers: res.headers as unknown as Headers, text };
  }

  /** One statement, as columns and rows. */
  private async run(lang: 'influxql' | 'sql', query: string, params: Record<string, unknown> | undefined, timeoutMs: number): Promise<{ columns: string[]; rows: unknown[][]; raw: unknown }> {
    const db = this.spec.database ?? '';
    if (this.version === 'v3') {
      const r = await this.send('POST', this.url(lang === 'sql' ? '/api/v3/query_sql' : '/api/v3/query_influxql'), { db, q: query, format: 'json', ...(params ? { params } : {}) }, timeoutMs);
      let doc: unknown;
      try {
        doc = r.text ? JSON.parse(r.text) : [];
      } catch {
        doc = null;
      }
      if (r.status >= 400) {
        const msg = doc && typeof doc === 'object' && !Array.isArray(doc) ? String((doc as { error?: unknown; message?: unknown }).error ?? (doc as { message?: unknown }).message ?? '') : r.text.slice(0, 200);
        throw new Error(`InfluxDB ${r.status}: ${msg}`.slice(0, 500));
      }
      const items = (Array.isArray(doc) ? doc : []) as Record<string, unknown>[];
      return { ...objectRows(items), raw: items };
    }
    const url = this.url('/query');
    url.searchParams.set('db', db);
    const rp = this.spec.options?.retentionPolicy;
    if (typeof rp === 'string' && rp) url.searchParams.set('rp', rp);
    url.searchParams.set('q', query);
    url.searchParams.set('epoch', 'ms');
    if (params) url.searchParams.set('params', JSON.stringify(params));
    const r = await this.send('GET', url, undefined, timeoutMs);
    let doc: { results?: { series?: InfluxSeries[]; error?: string }[]; error?: string } = {};
    try {
      doc = r.text ? JSON.parse(r.text) : {};
    } catch {
      // not JSON
    }
    const err = doc.error ?? doc.results?.find((x) => x.error)?.error;
    if (r.status >= 400 || err) throw new Error(`InfluxDB ${r.status}: ${err ?? (r.text.slice(0, 200) || 'error')}`.slice(0, 500));
    const series = (doc.results ?? []).flatMap((x) => x.series ?? []);
    return { ...seriesRows(series), raw: series };
  }

  async test(timeoutMs: number): Promise<TestResult> {
    const ping = await this.send('GET', this.url('/ping'), undefined, timeoutMs);
    if (ping.status >= 400) throw new Error(`InfluxDB ${ping.status}: /ping`);
    let version = ping.headers.get('x-influxdb-version') ?? '';
    if (!version) {
      try {
        version = String((JSON.parse(ping.text) as { version?: string }).version ?? '');
      } catch {
        // no body
      }
    }
    const v = this.version;
    const lang = v === 'v3' && this.spec.options?.language === 'sql' ? 'sql' : 'influxql';
    // Signs in and reads the database: a wrong token or database fails here.
    await this.run(lang, lang === 'sql' ? 'SELECT table_name FROM information_schema.tables LIMIT 1' : 'SHOW MEASUREMENTS LIMIT 1', undefined, timeoutMs);
    const name = `InfluxDB ${version || v}`;
    if (v !== 'v1') return { version: name, readOnly: true, health: 'healthy', detail: `Whether the token can write is the token's own permission: give the connection a read-only token. Only queries are sent.` };
    if (!this.spec.username) return { version: name, readOnly: true, health: 'healthy', detail: 'No authentication: anyone reaching the server can write. Only queries are sent.' };
    // An admin can list the users; anyone else cannot.
    const users = await this.run('influxql', 'SHOW USERS', undefined, timeoutMs).catch(() => null);
    if (users) return { version: name, readOnly: false, health: 'healthy', detail: `Account ${this.spec.username} is an InfluxDB admin. Reads stay reads (only SELECT and SHOW are sent); use a user with READ only.` };
    const grants = await this.run('influxql', `SHOW GRANTS FOR "${this.spec.username.replace(/"/g, '\\"')}"`, undefined, timeoutMs).catch(() => null);
    const writes = grants ? grants.rows.filter((r) => r.some((x) => typeof x === 'string' && /^(WRITE|ALL PRIVILEGES)$/i.test(x))) : [];
    if (writes.length) return { version: name, readOnly: false, health: 'healthy', detail: `Account ${this.spec.username} may write to ${writes.length} database${writes.length === 1 ? '' : 's'}. Only SELECT and SHOW are sent; use a user with READ only.` };
    return { version: name, readOnly: true, health: 'healthy', detail: `Account ${this.spec.username} is not an admin${grants ? ' and holds no WRITE grant' : '; its grants cannot be listed without admin rights'}.` };
  }

  /** 2.0.x: a schema plan's operations on the admin account (see the header). */
  async applyDdl(plan: DdlPlan, timeoutMs: number): Promise<{ applied: number; detail?: string }> {
    for (const op of plan.ops) if (op.op !== 'influx.createDatabase' && op.op !== 'influx.dropDatabase') throw new Error(`InfluxDB connections do not perform ${op.op}.`);
    if (!plan.ops.length) throw new Error('The plan has no InfluxDB operations.');
    const v = this.version;
    if (v === 'v2') throw new Error('InfluxDB 2.x makes buckets in its own UI or API with an org token; databases are made and dropped on 1.x and 3.');
    const quote = (name: string) => `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    const v3Error = (r: { status: number; text: string }, extra = '') => {
      let msg = r.text.slice(0, 300);
      try {
        const d = JSON.parse(r.text) as { error?: unknown; message?: unknown };
        msg = String(d.error ?? d.message ?? msg);
      } catch {
        // not JSON
      }
      return new Error(`InfluxDB ${r.status}: ${msg || 'error'}${extra}`.slice(0, 500));
    };
    let applied = 0;
    for (const op of plan.ops) {
      if (op.op !== 'influx.createDatabase' && op.op !== 'influx.dropDatabase') continue;
      try {
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(op.name)) throw new Error(`${op.name} is not an InfluxDB database name.`);
        if (op.op === 'influx.createDatabase' && op.duration != null && !/^(INF|\d{1,6}[hdw])$/.test(op.duration)) throw new Error(`${op.duration} is not a retention duration (such as 30d, 12h, 4w or INF).`);
        if (v === 'v1') {
          const q = op.op === 'influx.createDatabase' ? `CREATE DATABASE ${quote(op.name)}${op.duration ? ` WITH DURATION ${op.duration}` : ''}` : `DROP DATABASE ${quote(op.name)}`;
          const r = await this.send('POST', this.url('/query'), new URLSearchParams({ q }), timeoutMs);
          let doc: { results?: { error?: string }[]; error?: string } = {};
          try {
            doc = r.text ? JSON.parse(r.text) : {};
          } catch {
            // not JSON
          }
          const err = doc.error ?? doc.results?.find((x) => x.error)?.error;
          if (r.status >= 400 || err) throw new Error(`InfluxDB ${r.status}: ${err ?? (r.text.slice(0, 200) || 'error')}`.slice(0, 500));
        } else if (op.op === 'influx.createDatabase') {
          const r = await this.send('POST', this.url('/api/v3/configure/database'), { db: op.name }, timeoutMs);
          if (r.status >= 300) throw v3Error(r, r.status === 409 ? ' (the database already exists)' : '');
        } else {
          const u = this.url('/api/v3/configure/database');
          u.searchParams.set('db', op.name);
          const r = await this.send('DELETE', u, undefined, timeoutMs);
          if (r.status >= 300) throw v3Error(r, r.status === 404 ? ' (the database does not exist)' : '');
        }
      } catch (err) {
        const msg = (err as Error).message;
        throw new Error(plan.ops.length > 1 ? `${msg} (${applied} of ${plan.ops.length} operations were applied before it.)` : msg, { cause: err });
      }
      applied++;
    }
    return { applied };
  }

  async introspect(timeoutMs: number): Promise<SchemaObject[]> {
    const byName = new Map<string, SchemaObject>();
    const add = (m: string, col: string, type: string) => {
      if (!byName.has(m) && byName.size >= MAX_MEASUREMENTS) return;
      const o = byName.get(m) ?? { name: m, kind: 'measurement' as const, columns: [] };
      if (!o.columns.some((c) => c.name === col)) o.columns.push({ name: col, type });
      byName.set(m, o);
    };
    if (this.version === 'v3' && this.spec.options?.language === 'sql') {
      const r = await this.run('sql', "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'iox' ORDER BY table_name, column_name", undefined, timeoutMs);
      for (const row of r.rows) {
        const [t, c, ty] = row.map((x) => String(x ?? ''));
        add(t!, c!, /^Dictionary/.test(ty!) ? 'tag' : ty!);
      }
      return [...byName.values()];
    }
    const measurementOf = (row: Record<string, unknown> | null, series: InfluxSeries | null) => String(series?.name ?? row?.['iox::measurement'] ?? row?.measurement ?? '');
    for (const [q, kind] of [
      ['SHOW FIELD KEYS', 'field'],
      ['SHOW TAG KEYS', 'tag']
    ] as const) {
      const r = await this.run('influxql', q, undefined, timeoutMs);
      if (this.version === 'v3') {
        for (const row of r.raw as Record<string, unknown>[]) add(measurementOf(row, null), String(row.fieldKey ?? row.tagKey ?? ''), kind === 'tag' ? 'tag' : String(row.fieldType ?? 'field'));
      } else {
        for (const s of r.raw as InfluxSeries[]) {
          const ki = (s.columns ?? []).indexOf(kind === 'field' ? 'fieldKey' : 'tagKey');
          const ti = (s.columns ?? []).indexOf('fieldType');
          for (const v of s.values ?? []) add(measurementOf(null, s), String(v[ki] ?? ''), kind === 'tag' ? 'tag' : String(v[ti] ?? 'field'));
        }
      }
    }
    return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  async query(c: Classification, _text: string, opts: { limit: number; timeoutMs: number; offset?: number }): Promise<QueryResult> {
    const op = c.op as { lang: 'influxql' | 'sql'; query: string; params?: Record<string, unknown> } | undefined;
    if (!op) throw new Error('The request was not classified.');
    const r = await this.run(op.lang, op.query, op.params, opts.timeoutMs);
    const rows = r.rows.slice(opts.offset ?? 0);
    return { columns: r.columns, rows: rows.slice(0, opts.limit), capped: rows.length > opts.limit, estimate: rows.length > opts.limit ? rows.length : null };
  }

  rows(): Promise<QueryResult> {
    return Promise.reject(new Error('InfluxDB measurements are not a knowledge source.'));
  }
}
