import { isIP } from 'node:net';
import { fetch, type Dispatcher } from 'undici';
import { addressProblem, guardedAgent, parseAllowList, type AllowList } from '../mcp/hosts.js';
import type { Classification } from './classify.js';
import type { ConnectionSpec, DataDriver, QueryResult, SchemaObject, TestResult } from './drivers.js';
import type { NonSqlContext } from './nonsql.js';

/*
 * 1.9.0: Prometheus over its HTTP query API (`/api/v1/query`, `/api/v1/query_range`).
 *
 * - The query is PromQL (an instant query at now), or JSON `{"query", "start", "end", "step", "time"}` for a range or a
 *   chosen instant; saved-query parameters fill those fields, never the inside of the PromQL text.
 * - The classifier reads every vector selector: each must name its metric (a name, or `__name__` equal to a name, or a
 *   regex that is a list of names or `prefix.*`), and every metric must be on the allow-list. A selector without a
 *   metric is refused, as are ranges and subqueries over 31 days and queries over 10,000 characters.
 * - Only the query, label and metadata APIs are called; the admin and write APIs never are. Requests go through
 *   undici with the guarded dispatcher (CONNECTIONS_ALLOWED_HOSTS), redirects refused, answers capped.
 */

const MAX_QUERY = 10_000;
const MAX_RANGE_MS = 31 * 24 * 3600_000;
const MAX_ANSWER = 16 * 1024 * 1024;

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3600_000, d: 86_400_000, w: 7 * 86_400_000, y: 365 * 86_400_000 };

/** A Prometheus duration (`5m`, `1h30m`, `500ms`) in milliseconds; null when it is not one. */
export function promDuration(x: string): number | null {
  if (!/^(\d+(ms|s|m|h|d|w|y))+$/.test(x)) return null;
  let ms = 0;
  for (const m of x.matchAll(/(\d+)(ms|s|m|h|d|w|y)/g)) ms += Number(m[1]) * UNIT_MS[m[2]!]!;
  return ms;
}

/** A time as the API takes it: RFC 3339, unix seconds, `now` or `now-<duration>`; milliseconds since the epoch, or null. */
export function promTime(x: unknown, now = Date.now()): number | null {
  if (typeof x === 'number' && Number.isFinite(x)) return x * 1000;
  if (typeof x !== 'string' || !x.trim()) return null;
  const s = x.trim();
  if (s === 'now') return now;
  const rel = /^now\s*-\s*(\S+)$/.exec(s);
  if (rel) {
    const d = promDuration(rel[1]!);
    return d == null ? null : now - d;
  }
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s) * 1000;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

interface Tok {
  t: 'ident' | 'str' | 'num' | 'dur' | 'punct';
  v: string;
}

function lex(q: string): Tok[] | string {
  const out: Tok[] = [];
  let i = 0;
  while (i < q.length) {
    const c = q[i]!;
    if (/\s/.test(c)) i++;
    else if (c === '#') {
      while (i < q.length && q[i] !== '\n') i++;
    } else if (c === '"' || c === "'" || c === '`') {
      let v = '';
      let j = i + 1;
      let closed = false;
      while (j < q.length) {
        if (c !== '`' && q[j] === '\\') {
          v += q[j + 1] ?? '';
          j += 2;
        } else if (q[j] === c) {
          closed = true;
          j++;
          break;
        } else v += q[j++];
      }
      if (!closed) return 'an unterminated string';
      out.push({ t: 'str', v });
      i = j;
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(q[i + 1] ?? ''))) {
      const m = /^(\d+(ms|s|m|h|d|w|y))+/.exec(q.slice(i));
      if (m && !/[A-Za-z0-9_]/.test(q[i + m[0].length] ?? '')) {
        out.push({ t: 'dur', v: m[0] });
        i += m[0].length;
      } else {
        const n = /^(0x[0-9a-fA-F]+|\d*\.?\d+([eE][-+]?\d+)?)/.exec(q.slice(i));
        if (!n) return `the number at ${i}`;
        out.push({ t: 'num', v: n[0] });
        i += n[0].length;
      }
    } else if (/[A-Za-z_:]/.test(c)) {
      const m = /^[A-Za-z_:][A-Za-z0-9_:]*/.exec(q.slice(i))!;
      out.push({ t: 'ident', v: m[0] });
      i += m[0].length;
    } else {
      const two = q.slice(i, i + 2);
      if (['=~', '!~', '!=', '==', '>=', '<='].includes(two)) {
        out.push({ t: 'punct', v: two });
        i += 2;
      } else if ('{}()[],=<>+-*/%^@:'.includes(c)) {
        out.push({ t: 'punct', v: c });
        i++;
      } else return `the character ${JSON.stringify(c)}`;
    }
  }
  return out;
}

/** Words that take a label list in parentheses after them. */
const LABEL_LIST = new Set(['by', 'without', 'on', 'ignoring', 'group_left', 'group_right']);
const KEYWORDS = new Set(['offset', 'bool', 'group_left', 'group_right', 'and', 'or', 'unless', 'atan2', 'start', 'end', 'inf', 'nan']);
const NAME = /^[A-Za-z_:][A-Za-z0-9_:]*$/;
const AGGREGATIONS = new Set(['sum', 'avg', 'count', 'min', 'max', 'group', 'stddev', 'stdvar', 'topk', 'bottomk', 'quantile', 'count_values', 'limitk', 'limit_ratio']);

/** The metric names a `__name__=~` regex stands for: a list of literal names, or `prefix.*` as the glob `prefix*`. */
export function nameRegexObjects(re: string): string[] | null {
  const body = re.replace(/^\^/, '').replace(/\$$/, '');
  const group = /^\((.*)\)$/.exec(body);
  const alts = (group ? group[1]! : body).split('|');
  if (alts.length && alts.every((a) => NAME.test(a))) return alts;
  const prefix = /^([A-Za-z_:][A-Za-z0-9_:]*)\.\*$/.exec(body);
  return prefix ? [`${prefix[1]}*`] : null;
}

const refuse = (kind: Classification['kind'], reason: string, objects: string[] = [], denied?: string): Classification => ({ kind, verb: null, objects, reason, ...(denied ? { denied } : {}) });

/** The metrics a PromQL expression reads, or a refusal. */
export function promqlObjects(q: string): { objects: string[] } | Classification {
  if (q.length > MAX_QUERY) return refuse('denied', `The query is longer than ${MAX_QUERY} characters.`, [], 'length');
  const toks = lex(q);
  if (typeof toks === 'string') return refuse('unparsed', `The parser does not read ${toks}.`);
  if (!toks.length) return refuse('unparsed', 'The query is empty.');
  const objects: string[] = [];
  /** Reads the matchers from the `{` at `i`; returns the index after `}` and what it found. */
  const matchers = (i: number): { next: number; names: string[]; problem?: Classification } => {
    const names: string[] = [];
    let j = i + 1;
    while (j < toks.length && toks[j]!.v !== '}') {
      const label = toks[j]!;
      if (label.t === 'str' && (toks[j + 1]?.v === ',' || toks[j + 1]?.v === '}')) {
        // Prometheus 3: a quoted metric name alone in the braces.
        names.push(label.v);
        j += toks[j + 1]?.v === ',' ? 2 : 1;
        continue;
      }
      const op = toks[j + 1];
      const val = toks[j + 2];
      if ((label.t !== 'ident' && label.t !== 'str') || !op || !['=', '!=', '=~', '!~'].includes(op.v) || !val || val.t !== 'str') return { next: j, names, problem: refuse('unparsed', 'A label matcher the parser does not read.') };
      if (label.v === '__name__') {
        if (op.v === '=') names.push(val.v);
        else if (op.v === '=~') {
          const objs = nameRegexObjects(val.v);
          if (!objs) return { next: j, names, problem: refuse('denied', `The metric regex ${val.v.slice(0, 80)} cannot be checked against the allow-list: list the names (a|b) or use prefix.*.`, [], `__name__=~${val.v.slice(0, 80)}`) };
          names.push(...objs);
        }
      }
      j += 3;
      if (toks[j]?.v === ',') j++;
    }
    if (toks[j]?.v !== '}') return { next: j, names, problem: refuse('unparsed', 'An unclosed label matcher.') };
    return { next: j + 1, names };
  };
  let depth = 0;
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i]!;
    if (tk.v === '(') depth++;
    else if (tk.v === ')') depth--;
    if (tk.t === 'ident') {
      const lower = tk.v.toLowerCase();
      if (LABEL_LIST.has(lower) && toks[i + 1]?.v === '(') {
        // A label list: skip to its closing parenthesis.
        let j = i + 2;
        while (j < toks.length && toks[j]!.v !== ')') j++;
        i = j;
        continue;
      }
      if (KEYWORDS.has(lower) && !(toks[i + 1]?.v === '{')) continue;
      if (toks[i + 1]?.v === '(') continue; // a function or an aggregation
      // An aggregation with its grouping first: `sum by (job) (…)`.
      if (AGGREGATIONS.has(lower) && ['by', 'without'].includes(toks[i + 1]?.v.toLowerCase() ?? '')) continue;
      // A metric name, with or without matchers.
      if (toks[i + 1]?.v === '{') {
        const m = matchers(i + 1);
        if (m.problem) return m.problem;
        objects.push(tk.v, ...m.names);
        i = m.next - 1;
      } else objects.push(tk.v);
    } else if (tk.v === '{') {
      const m = matchers(i);
      if (m.problem) return m.problem;
      if (!m.names.length) return refuse('denied', 'A selector without a metric reads every metric that has the label: name the metric.', [], '{…}');
      objects.push(...m.names);
      i = m.next - 1;
    } else if (tk.v === '[') {
      // A range [5m] or a subquery [1h:1m]: each duration within the cap.
      let j = i + 1;
      while (j < toks.length && toks[j]!.v !== ']') {
        if (toks[j]!.t === 'dur') {
          const ms = promDuration(toks[j]!.v)!;
          if (ms > MAX_RANGE_MS) return refuse('denied', `The range ${toks[j]!.v} is longer than 31 days.`, [], toks[j]!.v);
        }
        j++;
      }
      i = j;
    }
  }
  if (depth !== 0) return refuse('unparsed', 'The parentheses do not balance.');
  const uniq = [...new Set(objects)];
  if (!uniq.length) return refuse('unparsed', 'The query reads no metric the parser could find.');
  return { objects: uniq };
}

/**
 * Prometheus: PromQL text, or JSON with the query and its times. Reads only; every metric named and allow-listed by
 * the service. `op` carries what the driver sends: an instant or a range query with the times as given.
 */
export function classifyPrometheus(query: string, _object: string | null, ctx: NonSqlContext): Classification {
  const text = query.trim();
  let promql = text;
  let op: Record<string, unknown> = { kind: 'instant', query: text };
  let parsed: unknown = undefined;
  if (text.startsWith('{')) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // PromQL that starts with a selector, such as {__name__="up"}
    }
  }
  if (parsed !== undefined) {
    const doc = parsed as Record<string, unknown>;
    if (!doc || typeof doc !== 'object' || Array.isArray(doc) || typeof doc.query !== 'string') return refuse('unparsed', 'JSON requests name the PromQL as "query".');
    const extra = Object.keys(doc).filter((k) => !['query', 'start', 'end', 'step', 'time'].includes(k));
    if (extra.length) return refuse('unparsed', `Unknown fields: ${extra.join(', ')}.`);
    promql = doc.query.trim();
    const now = Date.now();
    if (doc.start !== undefined || doc.end !== undefined || doc.step !== undefined) {
      const end = doc.end === undefined ? now : promTime(doc.end, now);
      const range = promDuration(String(ctx.options.defaultRange ?? '1h')) ?? 3600_000;
      const start = doc.start === undefined ? (end == null ? null : end - range) : promTime(doc.start, now);
      if (start == null || end == null) return refuse('unparsed', 'start and end are RFC 3339 times, unix seconds, or now-<duration>.');
      if (end <= start) return refuse('unparsed', 'end comes before start.');
      if (end - start > MAX_RANGE_MS) return refuse('denied', 'The range is longer than 31 days.', [], 'range');
      if (doc.step !== undefined && (typeof doc.step === 'number' ? !(doc.step > 0) : promDuration(String(doc.step)) == null)) return refuse('unparsed', 'step is a duration (30s, 5m) or seconds.');
      op = { kind: 'range', query: promql, start: doc.start ?? null, end: doc.end ?? null, step: doc.step ?? null };
    } else {
      if (doc.time !== undefined && promTime(doc.time, now) == null) return refuse('unparsed', 'time is an RFC 3339 time, unix seconds, or now-<duration>.');
      op = { kind: 'instant', query: promql, time: doc.time ?? null };
    }
  }
  const r = promqlObjects(promql);
  if ('kind' in r) return r;
  return { kind: 'read', verb: op.kind === 'range' ? 'QUERY_RANGE' : 'QUERY', objects: r.objects, op };
}

interface PromAnswer {
  status?: string;
  errorType?: string;
  error?: string;
  data?: unknown;
}

const promValue = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
};
const iso = (sec: unknown): string | null => (typeof sec === 'number' ? new Date(sec * 1000).toISOString() : null);

/** A query answer as columns and rows: labels (metric name first), the time and the value. */
export function promRows(data: { resultType?: string; result?: unknown }): { columns: string[]; rows: unknown[][]; total: number } {
  const type = data.resultType;
  if (type === 'scalar' || type === 'string') {
    const [t, v] = (data.result as [number, string]) ?? [];
    return { columns: ['time', 'value'], rows: [[iso(t), promValue(v)]], total: 1 };
  }
  const series = (Array.isArray(data.result) ? data.result : []) as { metric?: Record<string, string>; value?: [number, string]; values?: [number, string][] }[];
  const labels = new Set<string>();
  for (const s of series) for (const k of Object.keys(s.metric ?? {})) labels.add(k);
  const names = [...labels].sort((a, b) => (a === '__name__' ? -1 : b === '__name__' ? 1 : a < b ? -1 : 1));
  const columns = [...names, 'time', 'value'];
  const rows: unknown[][] = [];
  for (const s of series) {
    const head = names.map((k) => s.metric?.[k] ?? null);
    if (type === 'matrix') for (const [t, v] of s.values ?? []) rows.push([...head, iso(t), promValue(v)]);
    else if (s.value) rows.push([...head, iso(s.value[0]), promValue(s.value[1])]);
  }
  return { columns, rows, total: rows.length };
}

export class PrometheusDriver implements DataDriver {
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

  private get options(): Record<string, unknown> {
    return this.spec.options ?? {};
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
    if (this.spec.username) return { authorization: 'Basic ' + Buffer.from(`${this.spec.username}:${this.spec.password ?? ''}`).toString('base64') };
    if (this.spec.password) return { authorization: `Bearer ${this.spec.password}` };
    return {};
  }

  private async get(path: string, params: Record<string, string>, timeoutMs: number): Promise<unknown> {
    const u = new URL(this.base);
    if (u.username || u.password) throw new Error('Credentials do not belong in the endpoint; give them as the connection\'s account.');
    const url = new URL(u.pathname.replace(/\/+$/, '') + path, u.origin);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, { method: 'GET', headers: { accept: 'application/json', 'user-agent': 'exprsn-ai', ...this.auth() }, signal: AbortSignal.timeout(timeoutMs), dispatcher: this.guard(timeoutMs), redirect: 'error' });
    const declared = Number(res.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > MAX_ANSWER) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`The answer is larger than ${MAX_ANSWER / 1024 / 1024} MB.`);
    }
    const text = await res.text();
    if (text.length > MAX_ANSWER) throw new Error(`The answer is larger than ${MAX_ANSWER / 1024 / 1024} MB.`);
    let doc: PromAnswer = {};
    try {
      doc = text ? (JSON.parse(text) as PromAnswer) : {};
    } catch {
      // not JSON
    }
    if (res.status >= 400 || doc.status === 'error') throw new Error(`Prometheus ${res.status}: ${doc.error ? `${doc.errorType ? `${doc.errorType}: ` : ''}${doc.error}` : text.slice(0, 200) || res.statusText}`.slice(0, 500));
    return doc.data;
  }

  async test(timeoutMs: number): Promise<TestResult> {
    let version: string;
    try {
      const b = (await this.get('/api/v1/status/buildinfo', {}, timeoutMs)) as { version?: string } | undefined;
      version = `Prometheus ${b?.version ?? 'unknown'}`;
    } catch {
      // Some compatible servers do not offer buildinfo: an instant query proves the query API answers.
      await this.get('/api/v1/query', { query: 'vector(1)' }, timeoutMs);
      version = 'Prometheus-compatible API';
    }
    return { version, readOnly: true, health: 'healthy', detail: 'Only the query, label and metadata APIs are called; the admin and write APIs never are.' };
  }

  async introspect(timeoutMs: number): Promise<SchemaObject[]> {
    const names = ((await this.get('/api/v1/label/__name__/values', {}, timeoutMs)) as string[] | undefined) ?? [];
    const meta = ((await this.get('/api/v1/metadata', {}, timeoutMs).catch(() => ({}))) ?? {}) as Record<string, { type?: string; unit?: string }[]>;
    return names.slice(0, 5000).map((name) => {
      const m = meta[name]?.[0];
      return { name, kind: 'metric' as const, columns: [{ name: 'value', type: m?.type ?? 'untyped' }, ...(m?.unit ? [{ name: 'unit', type: m.unit }] : [])] };
    });
  }

  async query(c: Classification, _text: string, opts: { limit: number; timeoutMs: number; offset?: number }): Promise<QueryResult> {
    const op = c.op as { kind: 'instant' | 'range'; query: string; time?: unknown; start?: unknown; end?: unknown; step?: unknown } | undefined;
    if (!op) throw new Error('The request was not classified.');
    const timeout = `${Math.max(1, Math.floor(opts.timeoutMs / 1000))}s`;
    const now = Date.now();
    let data: unknown;
    if (op.kind === 'range') {
      const end = op.end == null ? now : promTime(op.end, now)!;
      const range = promDuration(String(this.options.defaultRange ?? '1h')) ?? 3600_000;
      const start = op.start == null ? end - range : promTime(op.start, now)!;
      const maxPoints = Number(this.options.maxPoints ?? 1000);
      let step = op.step == null ? 0 : typeof op.step === 'number' ? op.step : promDuration(String(op.step))! / 1000;
      step = Math.max(step, Math.ceil((end - start) / 1000 / maxPoints), 1);
      data = await this.get('/api/v1/query_range', { query: op.query, start: String(start / 1000), end: String(end / 1000), step: String(step), timeout }, opts.timeoutMs);
    } else {
      const t = op.time == null ? null : promTime(op.time, now);
      data = await this.get('/api/v1/query', { query: op.query, ...(t != null ? { time: String(t / 1000) } : {}), timeout }, opts.timeoutMs);
    }
    const r = promRows((data ?? {}) as { resultType?: string; result?: unknown });
    const rows = r.rows.slice(opts.offset ?? 0);
    return { columns: r.columns, rows: rows.slice(0, opts.limit), capped: rows.length > opts.limit, estimate: rows.length > opts.limit ? rows.length : null };
  }

  rows(): Promise<QueryResult> {
    return Promise.reject(new Error('Prometheus metrics are not a knowledge source.'));
  }
}
