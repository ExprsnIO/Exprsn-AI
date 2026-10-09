import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { Knex } from 'knex';
import type { Logger } from 'pino';

/*
 * B-1401: OpenTelemetry tracing without the OpenTelemetry SDK.
 *
 * A small span model, context carried in AsyncLocalStorage, and a batch exporter that posts OTLP/HTTP JSON
 * (`/v1/traces`) to OTEL_EXPORTER_OTLP_ENDPOINT through a bounded queue. Trace ids are the W3C ids the server
 * already uses for `X-Trace-Id` and problem details, so a trace id from a log line or an error report finds the trace.
 *
 * Why not @opentelemetry/*: the SDK, the OTLP exporter and the HTTP, Express and Knex instrumentations are a dozen
 * packages that patch modules at load time (require hooks do not see ESM without a loader flag), while the wire
 * format is a documented JSON document. Owning the few hundred lines here keeps the attribute policy below enforceable
 * in one place: only attribute keys on ALLOWED_ATTRIBUTES are recorded, values are short scalars, and nothing that
 * carries tenant content (message text, prompts, SQL text, URLs with query strings, tokens) has a key on the list.
 */

export type AttrValue = string | number | boolean;
export type Attributes = Record<string, AttrValue>;

/** OTLP span kinds. */
export const SpanKind = { INTERNAL: 1, SERVER: 2, CLIENT: 3, PRODUCER: 4, CONSUMER: 5 } as const;
export type SpanKindValue = (typeof SpanKind)[keyof typeof SpanKind];

/**
 * The only attribute keys a span may carry. Each is metadata about the operation (method, route template, table,
 * job type, checkpoint and its outcome), never the data it handled. Anything else is dropped and counted.
 */
export const ALLOWED_ATTRIBUTES: ReadonlySet<string> = new Set([
  'http.request.method',
  'http.route',
  'http.response.status_code',
  'url.scheme',
  'server.address',
  'server.port',
  'url.path', // only for calls to internal services whose paths are fixed API names (Ollama's /api/chat)
  'db.system',
  'db.operation.name',
  'db.collection.name',
  'exprsn.job.type',
  'exprsn.job.id',
  'exprsn.job.attempt',
  'exprsn.job.outcome',
  'exprsn.guardrails.checkpoint',
  'exprsn.guardrails.action',
  'exprsn.guardrails.findings',
  'exprsn.label',
  'gen_ai.operation.name',
  'gen_ai.request.model',
  // 1.6.0, Sprint 38a (B-7403): the GenAI semantic conventions' usage and response attributes on model spans, so
  // token counts travel with the trace to Grafana and other backends. Never the prompt or the answer.
  'gen_ai.provider.name',
  'gen_ai.response.model',
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  'error.type'
]);

const MAX_VALUE = 128;

export interface SpanData {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: SpanKindValue;
  startNs: bigint;
  endNs: bigint;
  attributes: Attributes;
  status: { code: 0 | 1 | 2; message?: string };
}

export class Span {
  readonly spanId = randomBytes(8).toString('hex');
  readonly attributes: Attributes = {};
  private status: SpanData['status'] = { code: 0 };
  private readonly startNs: bigint;
  private ended = false;

  constructor(
    readonly tracer: Tracer,
    readonly traceId: string,
    readonly parentSpanId: string | null,
    public name: string,
    readonly kind: SpanKindValue,
    attributes: Attributes = {}
  ) {
    this.startNs = tracer.nowNs();
    this.setAttributes(attributes);
  }

  /** The W3C traceparent naming this span as the parent (always sampled: unsampled traces have no spans). */
  get traceparent(): string {
    return `00-${this.traceId}-${this.spanId}-01`;
  }

  setAttribute(key: string, value: AttrValue | null | undefined): this {
    if (value == null) return this;
    if (!ALLOWED_ATTRIBUTES.has(key)) {
      this.tracer.rejected(key);
      return this;
    }
    this.attributes[key] = typeof value === 'string' ? value.slice(0, MAX_VALUE) : value;
    return this;
  }

  setAttributes(attrs: Record<string, AttrValue | null | undefined>): this {
    for (const [k, v] of Object.entries(attrs)) this.setAttribute(k, v);
    return this;
  }

  /** Marks the span failed. The message is the error's class or a fixed phrase, never an error text from a backend. */
  fail(kind: string): this {
    this.status = { code: 2, message: kind.slice(0, MAX_VALUE) };
    this.setAttribute('error.type', kind);
    return this;
  }

  ok(): this {
    if (this.status.code !== 2) this.status = { code: 1 };
    return this;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.tracer.record({ traceId: this.traceId, spanId: this.spanId, parentSpanId: this.parentSpanId, name: this.name, kind: this.kind, startNs: this.startNs, endNs: this.tracer.nowNs(), attributes: this.attributes, status: this.status });
  }
}

const context = new AsyncLocalStorage<Span>();

/** The span the current code runs in, if a sampled trace is active. */
export function activeSpan(): Span | undefined {
  return context.getStore();
}

/** Runs `fn` with `span` as the active span (a no-op wrapper when there is none). */
export function runInSpan<T>(span: Span | undefined, fn: () => T): T {
  return span ? context.run(span, fn) : fn();
}

/**
 * A child of the active span around `fn`, ended when `fn` settles (failed when it throws). Without an active span
 * (tracing off, or an unsampled trace) `fn` runs as it is, so call sites cost nothing when tracing is off.
 */
export function withSpan<T>(name: string, kind: SpanKindValue, attrs: Attributes, fn: (span: Span | undefined) => Promise<T>): Promise<T> {
  const parent = context.getStore();
  if (!parent) return fn(undefined);
  const span = new Span(parent.tracer, parent.traceId, parent.spanId, name, kind, attrs);
  return context.run(span, async () => {
    try {
      const out = await fn(span);
      span.ok();
      return out;
    } catch (err) {
      span.fail(errorKind(err));
      throw err;
    } finally {
      span.end();
    }
  });
}

/** A child of the active span that the caller ends (for work that outlives one call, such as a stream). */
export function startChild(name: string, kind: SpanKindValue, attrs: Attributes = {}): Span | undefined {
  const parent = context.getStore();
  return parent ? new Span(parent.tracer, parent.traceId, parent.spanId, name, kind, attrs) : undefined;
}

/** An error's class name, or a fixed word: error messages can quote data, class names cannot. */
export function errorKind(err: unknown): string {
  if (err && typeof err === 'object') {
    const name = (err as { name?: unknown }).name;
    const ctor = (err as { constructor?: { name?: string } }).constructor?.name;
    if (typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(name) && name !== 'Error') return name;
    if (ctor && /^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(ctor)) return ctor;
  }
  return 'Error';
}

const TRACEPARENT = /^([\da-f]{2})-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/;

export function parseTraceparent(header: string | null | undefined): { traceId: string; parentId: string; sampled: boolean } | null {
  const m = header ? TRACEPARENT.exec(header.trim()) : null;
  if (!m || m[1] === 'ff' || /^0+$/.test(m[2]!) || /^0+$/.test(m[3]!)) return null;
  return { traceId: m[2]!, parentId: m[3]!, sampled: (parseInt(m[4]!, 16) & 1) === 1 };
}

export interface TracerOptions {
  /** OTLP/HTTP traces URL (…/v1/traces); tracing is off without it. */
  url: string | null;
  serviceName: string;
  serviceVersion?: string;
  /** Extra request headers (OTEL_EXPORTER_OTLP_HEADERS), e.g. a collector's API key. */
  headers?: Record<string, string>;
  /** Fraction of new traces recorded (a parent's sampled flag wins). */
  ratio?: number;
  maxQueue?: number;
  maxBatch?: number;
  delayMs?: number;
  timeoutMs?: number;
}

export interface TracerStats {
  exported: number;
  dropped: number;
  failed: number;
  rejectedAttributes: number;
  queued: number;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * Creates root spans (an HTTP request, a job) and exports finished spans in batches. The queue is bounded: when the
 * collector is slow or down, new spans are dropped and counted rather than held in memory.
 */
export class Tracer {
  readonly enabled: boolean;
  readonly stats: TracerStats = { exported: 0, dropped: 0, failed: 0, rejectedAttributes: 0, queued: 0 };
  private queue: SpanData[] = [];
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;
  private lastWarn = 0;
  private readonly baseNs = BigInt(Date.now()) * 1_000_000n - process.hrtime.bigint();
  private readonly o: Required<Omit<TracerOptions, 'url' | 'serviceVersion'>> & { url: string | null; serviceVersion: string };

  constructor(
    opts: TracerOptions,
    private readonly log?: Pick<Logger, 'warn'>,
    private readonly doFetch: FetchLike = fetch as unknown as FetchLike
  ) {
    this.o = { headers: {}, ratio: 1, maxQueue: 2048, maxBatch: 512, delayMs: 5000, timeoutMs: 10_000, serviceVersion: '', ...opts };
    this.enabled = !!opts.url;
  }

  nowNs(): bigint {
    return this.baseNs + process.hrtime.bigint();
  }

  rejected(_key: string): void {
    this.stats.rejectedAttributes++;
  }

  /**
   * A root span for work that starts here: an incoming request (with the caller's traceparent, if any) or a job
   * (with the traceparent stored when it was queued). `traceId` is the id to use when there is no valid parent, so
   * the trace matches the request's X-Trace-Id. Undefined when tracing is off or the trace is not sampled.
   */
  startRoot(name: string, kind: SpanKindValue, o: { traceparent?: string | null; traceId?: string; attributes?: Attributes } = {}): Span | undefined {
    if (!this.enabled) return undefined;
    const parent = parseTraceparent(o.traceparent);
    const traceId = parent?.traceId ?? (o.traceId && /^[\da-f]{32}$/.test(o.traceId) ? o.traceId : randomBytes(16).toString('hex'));
    const sampled = parent ? parent.sampled : this.o.ratio >= 1 || parseInt(traceId.slice(-8), 16) / 0xffffffff < this.o.ratio;
    if (!sampled) return undefined;
    return new Span(this, traceId, parent?.parentId ?? null, name, kind, o.attributes ?? {});
  }

  /** Runs `fn` in `span` (as it is when undefined). */
  run<T>(span: Span | undefined, fn: () => T): T {
    return runInSpan(span, fn);
  }

  record(span: SpanData): void {
    if (!this.enabled) return;
    if (this.queue.length >= this.o.maxQueue) {
      this.stats.dropped++;
      return;
    }
    this.queue.push(span);
    this.stats.queued = this.queue.length;
    if (this.queue.length >= this.o.maxBatch) void this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.o.delayMs);
      this.timer.unref();
    }
  }

  /** Sends everything queued, one batch at a time. Resolves when the queue is empty or a send failed. */
  async flush(): Promise<void> {
    while (this.inflight) await this.inflight;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.queue.length) {
      const batch = this.queue.splice(0, this.o.maxBatch);
      this.stats.queued = this.queue.length;
      this.inflight = this.send(batch);
      const ok = await this.inflight.then(() => true, () => false);
      this.inflight = null;
      if (!ok) break;
    }
  }

  private async send(batch: SpanData[]): Promise<void> {
    try {
      const res = await this.doFetch(this.o.url!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.o.headers },
        body: JSON.stringify(otlpBody(batch, this.o.serviceName, this.o.serviceVersion)),
        signal: AbortSignal.timeout(this.o.timeoutMs)
      });
      if (!res.ok) throw new Error(`collector answered ${res.status}`);
      await res.text().catch(() => '');
      this.stats.exported += batch.length;
    } catch (err) {
      this.stats.failed += batch.length;
      if (Date.now() - this.lastWarn > 60_000) {
        this.lastWarn = Date.now();
        this.log?.warn({ err: (err as Error).message, spans: batch.length }, 'trace export failed; spans dropped');
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.flush().catch(() => undefined);
  }
}

const attr = (key: string, v: AttrValue) => ({ key, value: typeof v === 'string' ? { stringValue: v } : typeof v === 'boolean' ? { boolValue: v } : Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v } });

/** The OTLP/HTTP JSON body (ExportTraceServiceRequest) for some spans; ids are hex strings, times nanosecond strings. */
export function otlpBody(spans: SpanData[], serviceName: string, serviceVersion = ''): Record<string, unknown> {
  return {
    resourceSpans: [
      {
        resource: { attributes: [attr('service.name', serviceName), ...(serviceVersion ? [attr('service.version', serviceVersion)] : [])] },
        scopeSpans: [
          {
            scope: { name: 'exprsn-ai', version: serviceVersion },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: s.kind,
              startTimeUnixNano: s.startNs.toString(),
              endTimeUnixNano: s.endNs.toString(),
              attributes: Object.entries(s.attributes).map(([k, v]) => attr(k, v)),
              status: s.status
            }))
          }
        ]
      }
    ]
  };
}

/** `OTEL_EXPORTER_OTLP_HEADERS`: `name=value,name2=value2` with percent-encoded values. */
export function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (raw ?? '').split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    if (!/^[A-Za-z0-9-]+$/.test(k)) continue;
    try {
      out[k] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[k] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

/** The traces URL from OTEL_EXPORTER_OTLP_TRACES_ENDPOINT (as given) or OTEL_EXPORTER_OTLP_ENDPOINT (+ /v1/traces). */
export function tracesUrl(cfg: { OTEL_EXPORTER_OTLP_ENDPOINT?: string | undefined; OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?: string | undefined }): string | null {
  if (cfg.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) return cfg.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (cfg.OTEL_EXPORTER_OTLP_ENDPOINT) return cfg.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/+$/, '') + '/v1/traces';
  return null;
}

// ---------- database queries ----------

interface KnexQueryEvent {
  __knexQueryUid?: string;
  method?: string;
  sql?: string;
}

const OPS = new Set(['select', 'insert', 'update', 'delete', 'del', 'first', 'pluck', 'count', 'raw', 'truncate', 'columnInfo', 'upsert']);

/** The statement's verb and first table from SQL text; the text itself (and its literals) is never kept. */
export function describeQuery(q: KnexQueryEvent): { op: string; table: string | null } {
  const sql = String(q.sql ?? '');
  const verb = /^\s*(\w+)/.exec(sql)?.[1]?.toLowerCase() ?? '';
  const op = q.method && OPS.has(q.method) && q.method !== 'raw' ? (q.method === 'del' ? 'delete' : q.method === 'first' || q.method === 'pluck' || q.method === 'count' ? 'select' : q.method) : /^(select|insert|update|delete|with|pragma|begin|commit|rollback|savepoint|release|create|alter|drop|set|show)$/.test(verb) ? verb : 'other';
  const t = /\b(?:from|into|update|join|table)\s+[`"[]?([A-Za-z_][A-Za-z0-9_]{0,62})[`"\]]?/i.exec(sql)?.[1] ?? null;
  return { op, table: t };
}

/**
 * Spans for database queries made inside a trace, from Knex's query events (`query`, `query-response`,
 * `query-error`). The SQL text is not recorded: only the operation, the first table and the database system.
 */
const instrumented = new WeakSet<Knex>();

export function instrumentKnex(db: Knex, system: 'postgresql' | 'mysql' | 'sqlite'): void {
  if (instrumented.has(db)) return;
  instrumented.add(db);
  const open = new Map<string, Span>();
  const finish = (q: KnexQueryEvent, failed: unknown) => {
    const uid = q?.__knexQueryUid;
    const span = uid ? open.get(uid) : undefined;
    if (!span || !uid) return;
    open.delete(uid);
    if (failed) span.fail(errorKind(failed));
    else span.ok();
    span.end();
  };
  db.on('query', (q: KnexQueryEvent) => {
    const parent = context.getStore();
    if (!parent || !q?.__knexQueryUid) return;
    if (open.size > 10_000) open.clear(); // a driver that never reported back: drop rather than grow
    const { op, table } = describeQuery(q);
    open.set(q.__knexQueryUid, new Span(parent.tracer, parent.traceId, parent.spanId, table ? `${op} ${table}` : op, SpanKind.CLIENT, { 'db.system': system, 'db.operation.name': op, ...(table ? { 'db.collection.name': table } : {}) }));
  });
  db.on('query-response', (_r: unknown, q: KnexQueryEvent) => finish(q, null));
  db.on('query-error', (err: unknown, q: KnexQueryEvent) => finish(q, err ?? new Error('query failed')));
}
