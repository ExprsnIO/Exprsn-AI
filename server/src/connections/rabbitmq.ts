import { isIP } from 'node:net';
import { fetch, type Dispatcher } from 'undici';
import { addressProblem, guardedAgent, parseAllowList, type AllowList } from '../mcp/hosts.js';
import type { Classification } from './classify.js';
import type { DdlPlan } from './ddl.js';
import type { DescribeKind, DocumentDescription } from './ddl-edit-types.js';
import type { ConnectionSpec, DataDriver, QueueInfo, QueryResult, SchemaObject, TestResult } from './drivers.js';
import type { NonSqlContext } from './nonsql.js';
import { globRegExp, hasGlob } from './patterns.js';

/*
 * 1.9.0: RabbitMQ through its management HTTP API, read-only.
 *
 * Objects are queues, named `<vhost>/<queue>` with the vhost decoded: the default vhost `/` makes `//orders`, vhost
 * `shop` makes `shop/orders`. Allow-list entries use that spelling, with globs (`//orders.*`, `shop/*`). In a query a
 * queue may also be written `%2F/orders`, `/orders` (the default vhost) or `orders` (the connection's vhost, `/` when
 * none is set); they are read into the canonical form before the allow-list is asked.
 *
 * Commands (text, or JSON `{"command", "vhost", "queue", "pattern", "count"}` so saved queries can bind parameters):
 * `overview`, `queues [pattern]` (only queues the pattern matches, and the pattern must sit inside an allow-list entry;
 * with none, `<vhost>/*`), `queue <q>`, `exchanges` (exchange names and types are metadata: no allow-list),
 * `bindings <q>`, `consumers <q>`, and `peek <q> [count ≤ 50]`, which is refused unless the connection's `peek` option is
 * `on`: peeking fetches messages and requeues them at once, which marks them redelivered and can reorder the queue.
 * Everything else (publish, purge, delete, declare, move, shovels, policies, definitions, users, permissions, any raw
 * API path) is refused. The driver only ever sends GET, and the POST of a peek, for the query box and the Queues tab.
 *
 * 2.0.x: the Queues tab (`queues`) lists the queues the read user can see, with `columns=` and paging, filtered to the
 * allow-list. Declaring a queue or an exchange and binding (PUT /api/queues, PUT /api/exchanges, POST /api/bindings)
 * happen only through a previewed schema plan (`applyDdl`), on the connection's separate admin account; that user
 * needs `configure` permission on the vhost (and `write` on the queue and `read` on the exchange to bind), and the
 * management tag to use the API. The read user needs none of that.
 *
 * 2.0.x editing: a plan may also delete a queue (`DELETE /api/queues/<vh>/<q>`, with `if-empty` and `if-unused` so a
 * queue that still has messages or consumers is kept), an exchange (`DELETE /api/exchanges/<vh>/<x>?if-unused=true`)
 * or a binding (`DELETE /api/bindings/<vh>/e/<source>/<q|e>/<destination>/<properties key>`); the admin user needs
 * `configure` on the vhost for deletes (and `write`/`read` as for binding to unbind). `describe` reads one queue or
 * exchange (`GET /api/queues/<vh>/<q>`, `GET /api/exchanges/<vh>/<x>`) on the read user: GET only, never a peek.
 */

const READS = ['overview', 'queues', 'queue', 'exchanges', 'bindings', 'consumers', 'peek'] as const;
type Command = (typeof READS)[number];
const WRITES = new Set(['publish', 'purge', 'delete', 'declare', 'create', 'move', 'shovel', 'put', 'post', 'patch', 'set', 'bind', 'unbind', 'close', 'import', 'reset', 'ack', 'reject', 'nack', 'get']);
const MAX_PEEK = 50;
const MAX_BYTES = 8 * 1024 * 1024;

export interface RabbitOp extends Record<string, unknown> {
  command: Command;
  vhost: string | null;
  queue: string | null;
  pattern: string | null;
  count: number;
}

/** A queue reference read into vhost and queue; `fallback` is the connection's vhost. */
export function parseQueueRef(raw: string, fallback: string | null): { vhost: string; queue: string } {
  const s = raw.trim().replace(/%2F/gi, '/');
  if (s.startsWith('//')) return { vhost: '/', queue: s.slice(2) };
  if (s.startsWith('/')) return { vhost: '/', queue: s.slice(1) };
  const at = s.indexOf('/');
  if (at > 0) return { vhost: s.slice(0, at), queue: s.slice(at + 1) };
  return { vhost: fallback ?? '/', queue: s };
}

export const queueName = (vhost: string, queue: string): string => `${vhost}/${queue}`;

const refuse = (kind: 'write' | 'denied' | 'unparsed', verb: string | null, reason: string, denied?: string): Classification => ({ kind, verb, objects: [], reason, ...(denied ? { denied } : {}) });

export function classifyRabbit(query: string, _object: string | null, ctx: NonSqlContext): Classification {
  const text = query.trim();
  if (!text) return refuse('unparsed', null, 'The query is empty.');
  const home = ctx.database ? ctx.database.replace(/%2F/gi, '/') : null;
  let command: string;
  let arg: string | null = null;
  let count = 1;
  if (text.startsWith('{')) {
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return refuse('unparsed', null, 'The request is not valid JSON.');
    }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return refuse('unparsed', null, 'The request is not a JSON object.');
    const extra = Object.keys(j).filter((k) => !['command', 'vhost', 'queue', 'pattern', 'count'].includes(k));
    if (extra.length) return refuse('denied', String(j.command ?? ''), `Unknown fields: ${extra.join(', ')}.`, extra[0]);
    command = String(j.command ?? '').toLowerCase();
    const q = j.queue ?? j.pattern;
    if (q != null) {
      if (typeof q !== 'string') return refuse('unparsed', command, 'queue and pattern are strings.');
      arg = j.vhost != null ? queueName(String(j.vhost).replace(/%2F/gi, '/'), q) : q.includes('/') ? q : queueName(home ?? '/', q);
    } else if (j.vhost != null) arg = queueName(String(j.vhost).replace(/%2F/gi, '/'), '*');
    if (j.count != null) count = Number(j.count);
  } else {
    if (/^(GET|POST|PUT|DELETE|PATCH|HEAD)\s/i.test(text) || text.startsWith('/api')) return refuse('denied', text.split(/\s+/)[0]!.toUpperCase(), 'Raw management API requests are not sent; use one of the read commands.', text.split(/\s+/)[0]);
    const parts = text.split(/\s+/);
    if (parts.length > 3) return refuse('unparsed', parts[0]!.toLowerCase(), 'Too many arguments.');
    command = parts[0]!.toLowerCase();
    arg = parts[1] ?? null;
    if (parts[2] != null) count = Number(parts[2]);
  }
  if (WRITES.has(command)) return refuse('write', command, `${command} changes the broker or its messages; a connection only reads.`);
  if (!(READS as readonly string[]).includes(command)) return refuse('denied', command || null, `${command || 'That'} is not a read command. Use overview, queues, queue, exchanges, bindings, consumers or peek.`, command || undefined);
  const cmd = command as Command;
  const op: RabbitOp = { command: cmd, vhost: null, queue: null, pattern: null, count: 1 };
  if (cmd === 'overview' || cmd === 'exchanges') {
    if (arg) return refuse('unparsed', cmd, `${cmd} takes no argument.`);
    op.vhost = home;
    return { kind: 'read', verb: cmd, objects: [], op };
  }
  if (cmd === 'queues') {
    const pattern = arg ? (arg.replace(/%2F/gi, '/').includes('/') ? arg.replace(/%2F/gi, '/').replace(/^\/(?!\/)/, '//') : queueName(home ?? '/', arg)) : queueName(home ?? '/', '*');
    op.pattern = pattern;
    return { kind: 'read', verb: cmd, objects: [pattern], op };
  }
  if (!arg) return refuse('unparsed', cmd, `${cmd} names a queue: ${cmd} <vhost>/<queue>.`);
  const ref = parseQueueRef(arg, home);
  if (!ref.queue) return refuse('unparsed', cmd, 'The queue name is empty.');
  if (hasGlob(ref.queue) || hasGlob(ref.vhost)) return refuse('unparsed', cmd, `${cmd} reads one queue; a pattern is for queues.`);
  op.vhost = ref.vhost;
  op.queue = ref.queue;
  if (cmd === 'peek') {
    if (!Number.isInteger(count) || count < 1 || count > MAX_PEEK) return refuse('unparsed', cmd, `peek takes a count from 1 to ${MAX_PEEK}.`);
    op.count = count;
    if (ctx.options.peek !== 'on') return { kind: 'denied', verb: cmd, objects: [queueName(ref.vhost, ref.queue)], denied: 'peek', reason: 'Peeking is off for this connection: it fetches messages and requeues them at once, which marks them redelivered and can reorder the queue. A connections manager turns it on in the connection\'s settings.' };
  }
  return { kind: 'read', verb: cmd, objects: [queueName(ref.vhost, ref.queue)], op };
}

const QUEUE_COLUMNS: [string, string, (q: Record<string, unknown>) => unknown][] = [
  ['name', 'string', (q) => q.name],
  ['vhost', 'string', (q) => q.vhost],
  ['state', 'string', (q) => q.state ?? null],
  ['messages', 'number', (q) => q.messages ?? null],
  ['messages_ready', 'number', (q) => q.messages_ready ?? null],
  ['messages_unacknowledged', 'number', (q) => q.messages_unacknowledged ?? null],
  ['consumers', 'number', (q) => q.consumers ?? null],
  ['publish_rate', 'number', (q) => rate(q, 'publish_details')],
  ['deliver_rate', 'number', (q) => rate(q, 'deliver_get_details')],
  ['idle_since', 'string', (q) => q.idle_since ?? null]
];

function rate(q: Record<string, unknown>, key: string): number | null {
  const ms = q.message_stats as Record<string, { rate?: number }> | undefined;
  const r = ms?.[key]?.rate;
  return typeof r === 'number' ? r : null;
}

const enc = (vhost: string) => encodeURIComponent(vhost);

/** Queue arguments as the broker names them and as the designer's queue form does (ddl.ts rabbitQueueSpec). */
const RABBIT_QUEUE_ARGS: [string, string][] = [
  ['x-message-ttl', 'messageTtl'],
  ['x-expires', 'expires'],
  ['x-max-length', 'maxLength'],
  ['x-max-length-bytes', 'maxLengthBytes'],
  ['x-overflow', 'overflow'],
  ['x-dead-letter-exchange', 'deadLetterExchange'],
  ['x-dead-letter-routing-key', 'deadLetterRoutingKey'],
  ['x-dead-letter-strategy', 'deadLetterStrategy'],
  ['x-single-active-consumer', 'singleActiveConsumer'],
  ['x-max-priority', 'maxPriority'],
  ['x-delivery-limit', 'deliveryLimit'],
  ['x-quorum-initial-group-size', 'initialGroupSize'],
  ['x-max-age', 'maxAge'],
  ['x-stream-max-segment-size-bytes', 'streamMaxSegmentSizeBytes']
];

/** The management API with basic authentication; GET only, plus the POST of a peek. */
export class RabbitDriver implements DataDriver {
  private readonly base: string;
  private dispatcher: Dispatcher | null = null;
  /** Every request sent (method and path), for tests and audits of what reached the broker. */
  readonly sent: { method: string; path: string }[] = [];

  constructor(
    private readonly spec: ConnectionSpec,
    private readonly allow: AllowList = parseAllowList('')
  ) {
    const e = spec.endpoint.replace(/\/+$/, '');
    this.base = /^https?:\/\//.test(e) ? e : `${spec.tls ? 'https' : 'http'}://${e}`;
  }

  private get home(): string | null {
    return this.spec.database ? this.spec.database.replace(/%2F/gi, '/') : null;
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

  private async call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.spec.username) headers.authorization = 'Basic ' + Buffer.from(`${this.spec.username}:${this.spec.password ?? ''}`).toString('base64');
    const dispatcher = this.guard(timeoutMs);
    this.sent.push({ method, path });
    const res = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), dispatcher, redirect: 'error' });
    const chunks: Buffer[] = [];
    let size = 0;
    if (res.body) {
      for await (const chunk of res.body) {
        const b = Buffer.from(chunk as Uint8Array);
        size += b.length;
        if (size > MAX_BYTES) {
          await res.body.cancel().catch(() => undefined);
          throw new Error(`RabbitMQ answered more than ${MAX_BYTES / 1024 / 1024} MB.`);
        }
        chunks.push(b);
      }
    }
    const text = Buffer.concat(chunks).toString('utf8');
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // not JSON
    }
    if (!res.ok) {
      const d = data as { reason?: string; error?: string } | null;
      throw new Error(`RabbitMQ ${res.status}: ${d?.reason ?? d?.error ?? text.slice(0, 200)}`);
    }
    return data;
  }

  private async queuesOf(vhost: string | null, timeoutMs: number): Promise<Record<string, unknown>[]> {
    const r = await this.call('GET', vhost ? `/api/queues/${enc(vhost)}` : '/api/queues', undefined, timeoutMs);
    return Array.isArray(r) ? (r as Record<string, unknown>[]) : [];
  }

  async test(timeoutMs: number): Promise<TestResult> {
    const who = (await this.call('GET', '/api/whoami', undefined, timeoutMs)) as { name?: string; tags?: string | string[] } | null;
    const ov = (await this.call('GET', '/api/overview', undefined, timeoutMs)) as { rabbitmq_version?: string; cluster_name?: string } | null;
    const tags = (Array.isArray(who?.tags) ? who!.tags : String(who?.tags ?? '').split(',')).map((t) => t.trim()).filter(Boolean);
    const user = who?.name ?? this.spec.username ?? '';
    const problems: string[] = [];
    const strong = tags.filter((t) => t === 'administrator' || t === 'policymaker');
    if (strong.length) problems.push(`is tagged ${strong.join(' and ')}`);
    const vhost = this.home ?? '/';
    const perm = (await this.call('GET', `/api/permissions/${enc(vhost)}/${encodeURIComponent(user)}`, undefined, timeoutMs).catch(() => null)) as { configure?: string; write?: string } | null;
    const open = (p: string | undefined) => p != null && p !== '' && p !== '^$';
    if (perm && (open(perm.configure) || open(perm.write))) problems.push(`holds ${[open(perm.configure) ? 'configure' : '', open(perm.write) ? 'write' : ''].filter(Boolean).join(' and ')} permission on ${vhost}`);
    const readOnly = problems.length === 0;
    return {
      version: `RabbitMQ ${ov?.rabbitmq_version ?? 'unknown'}`,
      readOnly,
      health: 'healthy',
      detail: readOnly ? `User ${user} has no management or write rights${perm ? '' : ' (its permissions could not be read)'}. Only GET requests are sent${'peek' in (this.spec.options ?? {}) && this.spec.options?.peek === 'on' ? ', and the POST of a peek' : ''}.` : `User ${user} ${problems.join(', ')}: the user can publish or change queues. Reads still only GET, but use a read-only user.`
    };
  }

  async introspect(timeoutMs: number): Promise<SchemaObject[]> {
    const qs = await this.queuesOf(this.home, timeoutMs);
    return qs.slice(0, 2000).map((q) => ({ name: queueName(String(q.vhost), String(q.name)), kind: 'queue' as const, columns: QUEUE_COLUMNS.map(([name, type]) => ({ name, type })) }));
  }

  async query(c: Classification, _text: string, opts: { limit: number; timeoutMs: number; offset?: number }): Promise<QueryResult> {
    const op = c.op as RabbitOp | undefined;
    if (!op || c.kind !== 'read') throw new Error('The request was not classified as a read.');
    const t = opts.timeoutMs;
    const out = (columns: string[], all: unknown[][]): QueryResult => {
      const from = Math.max(0, Math.floor(opts.offset ?? 0));
      const rows = all.slice(from, from + opts.limit);
      return { columns, rows, capped: all.length > from + opts.limit, estimate: all.length > from + opts.limit ? all.length : null };
    };
    switch (op.command) {
      case 'overview': {
        const o = ((await this.call('GET', '/api/overview', undefined, t)) ?? {}) as Record<string, Record<string, unknown> | string | undefined>;
        const tot = (o.object_totals ?? {}) as Record<string, unknown>;
        const qt = (o.queue_totals ?? {}) as Record<string, unknown>;
        const cols = ['rabbitmq_version', 'cluster_name', 'queues', 'exchanges', 'connections', 'channels', 'consumers', 'messages', 'messages_ready', 'messages_unacknowledged', 'publish_rate', 'deliver_rate'];
        return out(cols, [[o.rabbitmq_version ?? null, o.cluster_name ?? null, tot.queues ?? null, tot.exchanges ?? null, tot.connections ?? null, tot.channels ?? null, tot.consumers ?? null, qt.messages ?? null, qt.messages_ready ?? null, qt.messages_unacknowledged ?? null, rate(o as Record<string, unknown>, 'publish_details'), rate(o as Record<string, unknown>, 'deliver_get_details')]]);
      }
      case 'queues': {
        const pattern = op.pattern ?? queueName(this.home ?? '/', '*');
        const at = pattern.indexOf('/', pattern.startsWith('//') ? 1 : 0);
        const vhost = pattern.startsWith('//') ? '/' : at > 0 ? pattern.slice(0, at) : null;
        const re = globRegExp(pattern);
        // Only queues the pattern matches leave the driver: the service checked that the pattern sits inside the allow-list.
        const qs = (await this.queuesOf(vhost && !hasGlob(vhost) ? vhost : null, t)).filter((q) => re.test(queueName(String(q.vhost), String(q.name))));
        return out(QUEUE_COLUMNS.map((x) => x[0]), qs.map((q) => QUEUE_COLUMNS.map(([, , f]) => f(q))));
      }
      case 'queue': {
        const q = ((await this.call('GET', `/api/queues/${enc(op.vhost!)}/${encodeURIComponent(op.queue!)}`, undefined, t)) ?? {}) as Record<string, unknown>;
        const cols = [...QUEUE_COLUMNS.map((x) => x[0]), 'type', 'durable', 'auto_delete', 'node', 'memory', 'arguments'];
        return out(cols, [[...QUEUE_COLUMNS.map(([, , f]) => f(q)), q.type ?? null, q.durable ?? null, q.auto_delete ?? null, q.node ?? null, q.memory ?? null, q.arguments ?? null]]);
      }
      case 'exchanges': {
        const r = (await this.call('GET', op.vhost ? `/api/exchanges/${enc(op.vhost)}` : '/api/exchanges', undefined, t)) as Record<string, unknown>[] | null;
        return out(['name', 'vhost', 'type', 'durable', 'auto_delete', 'internal'], (r ?? []).map((x) => [x.name, x.vhost, x.type ?? null, x.durable ?? null, x.auto_delete ?? null, x.internal ?? null]));
      }
      case 'bindings': {
        const r = (await this.call('GET', `/api/queues/${enc(op.vhost!)}/${encodeURIComponent(op.queue!)}/bindings`, undefined, t)) as Record<string, unknown>[] | null;
        return out(['source', 'destination', 'destination_type', 'routing_key', 'arguments'], (r ?? []).map((x) => [x.source ?? null, x.destination ?? null, x.destination_type ?? null, x.routing_key ?? null, x.arguments ?? null]));
      }
      case 'consumers': {
        const r = (await this.call('GET', `/api/consumers/${enc(op.vhost!)}`, undefined, t)) as Record<string, unknown>[] | null;
        const mine = (r ?? []).filter((x) => (x.queue as { name?: string } | undefined)?.name === op.queue);
        return out(['consumer_tag', 'channel', 'ack_required', 'prefetch_count', 'active', 'exclusive'], mine.map((x) => [x.consumer_tag ?? null, (x.channel_details as { name?: string } | undefined)?.name ?? null, x.ack_required ?? null, x.prefetch_count ?? null, x.active ?? null, x.exclusive ?? null]));
      }
      case 'peek': {
        // Checked twice: the classifier refuses a peek while the option is off, and so does the driver.
        if (this.spec.options?.peek !== 'on') throw new Error('Peeking is off for this connection.');
        const count = Math.min(MAX_PEEK, Math.max(1, Math.floor(op.count)), opts.limit);
        const r = (await this.call('POST', `/api/queues/${enc(op.vhost!)}/${encodeURIComponent(op.queue!)}/get`, { count, ackmode: 'ack_requeue_true', encoding: 'auto', truncate: 50_000 }, t)) as Record<string, unknown>[] | null;
        return out(['routing_key', 'exchange', 'redelivered', 'payload', 'payload_encoding', 'properties', 'message_count'], (r ?? []).map((m) => [m.routing_key ?? null, m.exchange ?? null, m.redelivered ?? null, m.payload ?? null, m.payload_encoding ?? null, m.properties ?? null, m.message_count ?? null]));
      }
    }
  }

  rows(): Promise<QueryResult> {
    return Promise.reject(new Error('RabbitMQ queues are not a knowledge source.'));
  }

  /**
   * 2.0.x: a schema plan's operations on the admin account: declare a queue or an exchange, or bind. A 2xx is
   * success; a 4xx carries the management API's reason (a queue that exists with other arguments is a 400
   * PRECONDITION_FAILED, said as such).
   */
  async applyDdl(plan: DdlPlan, timeoutMs: number): Promise<{ applied: number; detail?: string }> {
    const known = new Set(['rabbit.declareQueue', 'rabbit.declareExchange', 'rabbit.bind', 'rabbit.deleteQueue', 'rabbit.deleteExchange', 'rabbit.unbind']);
    for (const op of plan.ops) if (!known.has(op.op)) throw new Error(`RabbitMQ connections do not perform ${op.op}.`);
    if (!plan.ops.length) throw new Error('The plan has no RabbitMQ operations.');
    let applied = 0;
    const done: string[] = [];
    const query = (flags: [string, boolean][]) => {
      const q = flags.filter(([, on]) => on).map(([k]) => `${k}=true`);
      return q.length ? `?${q.join('&')}` : '';
    };
    for (const op of plan.ops) {
      let what = 'It';
      try {
        if (op.op === 'rabbit.declareQueue') {
          await this.call('PUT', `/api/queues/${enc(op.vhost)}/${encodeURIComponent(op.name)}`, op.body, timeoutMs);
          done.push(`declared queue ${queueName(op.vhost, op.name)}`);
        } else if (op.op === 'rabbit.declareExchange') {
          await this.call('PUT', `/api/exchanges/${enc(op.vhost)}/${encodeURIComponent(op.name)}`, op.body, timeoutMs);
          done.push(`declared exchange ${queueName(op.vhost, op.name)}`);
        } else if (op.op === 'rabbit.bind') {
          await this.call('POST', `/api/bindings/${enc(op.vhost)}/e/${encodeURIComponent(op.source)}/${op.destinationType === 'e' ? 'e' : 'q'}/${encodeURIComponent(op.destination)}`, op.body, timeoutMs);
          done.push(`bound ${op.source} → ${op.destination}`);
        } else if (op.op === 'rabbit.deleteQueue') {
          what = `The queue ${queueName(op.vhost, op.name)}`;
          if (!op.name) throw new Error('The queue name is empty.');
          await this.call('DELETE', `/api/queues/${enc(op.vhost)}/${encodeURIComponent(op.name)}${query([['if-empty', op.ifEmpty], ['if-unused', op.ifUnused]])}`, undefined, timeoutMs);
          done.push(`deleted queue ${queueName(op.vhost, op.name)}`);
        } else if (op.op === 'rabbit.deleteExchange') {
          what = `The exchange ${queueName(op.vhost, op.name)}`;
          if (!op.name) throw new Error('The default exchange cannot be deleted.');
          if (/^amq\./.test(op.name)) throw new Error(`${op.name} is one of RabbitMQ's own exchanges and is not deleted.`);
          await this.call('DELETE', `/api/exchanges/${enc(op.vhost)}/${encodeURIComponent(op.name)}${query([['if-unused', op.ifUnused]])}`, undefined, timeoutMs);
          done.push(`deleted exchange ${queueName(op.vhost, op.name)}`);
        } else if (op.op === 'rabbit.unbind') {
          what = `The binding ${op.source} → ${op.destination}`;
          if (!op.source) throw new Error('Bindings of the default exchange cannot be removed.');
          if (!op.propertiesKey) throw new Error('A binding is removed by its properties key (the routing key, or ~ for an empty one).');
          await this.call('DELETE', `/api/bindings/${enc(op.vhost)}/e/${encodeURIComponent(op.source)}/${op.destinationType === 'e' ? 'e' : 'q'}/${encodeURIComponent(op.destination)}/${encodeURIComponent(op.propertiesKey)}`, undefined, timeoutMs);
          done.push(`removed binding ${op.source} → ${op.destination}`);
        }
      } catch (err) {
        let msg = (err as Error).message;
        if (op.op === 'rabbit.declareQueue' && /PRECONDITION_FAILED|inequivalent arg/i.test(msg)) msg = `The queue ${queueName(op.vhost, op.name)} already exists with different settings (RabbitMQ PRECONDITION_FAILED); it was left as it is. ${msg}`;
        else if (op.op === 'rabbit.declareExchange' && /PRECONDITION_FAILED|inequivalent arg/i.test(msg)) msg = `The exchange ${queueName(op.vhost, op.name)} already exists with different settings (RabbitMQ PRECONDITION_FAILED); it was left as it is. ${msg}`;
        else if ((op.op === 'rabbit.deleteQueue' || op.op === 'rabbit.deleteExchange' || op.op === 'rabbit.unbind') && /^RabbitMQ 404/.test(msg)) msg = `${what} does not exist. ${msg}`;
        else if (op.op === 'rabbit.deleteQueue' && /^RabbitMQ 400/.test(msg) && (op.ifEmpty || op.ifUnused)) msg = `The queue ${queueName(op.vhost, op.name)} was kept: it still has ${op.ifEmpty && op.ifUnused ? 'messages or consumers' : op.ifEmpty ? 'messages' : 'consumers'}. Empty it or stop its consumers first, or delete it without the ${op.ifEmpty ? 'if-empty' : 'if-unused'} guard. ${msg}`;
        else if (op.op === 'rabbit.deleteExchange' && /^RabbitMQ 400/.test(msg) && op.ifUnused) msg = `The exchange ${queueName(op.vhost, op.name)} was kept: it still has bindings. Remove them first. ${msg}`;
        else if (/RabbitMQ 401/.test(msg)) msg = `The admin account was refused (401): it needs the management tag and a valid password. ${msg}`;
        else if (/RabbitMQ 403|access_refused|not_authorised/i.test(msg)) msg = `The admin account lacks permission (it needs configure on the vhost). ${msg}`;
        throw new Error(plan.ops.length > 1 ? `${msg} (${applied} of ${plan.ops.length} operations were applied before it.)` : msg, { cause: err });
      }
      applied++;
    }
    const text = done.join(', ');
    return { applied, detail: `${text.charAt(0).toUpperCase()}${text.slice(1)}.` };
  }

  /**
   * 2.0.x editing: one queue or exchange (`<vhost>/<name>`, or a name in the connection's vhost) as the create form
   * takes it (rabbitQueueSpec, rabbitExchangeSpec); one GET on the read user; null when there is none.
   */
  async describe(object: string, kind: DescribeKind, timeoutMs: number): Promise<DocumentDescription | null> {
    if (kind !== 'queue' && kind !== 'exchange') throw new Error(`RabbitMQ connections describe queues and exchanges, not ${kind}.`);
    const ref = parseQueueRef(object, this.home);
    if (!ref.queue) throw new Error(`Name the ${kind}.`);
    let x: Record<string, unknown>;
    try {
      x = ((await this.call('GET', `/api/${kind === 'queue' ? 'queues' : 'exchanges'}/${enc(ref.vhost)}/${encodeURIComponent(ref.queue)}`, undefined, timeoutMs)) ?? {}) as Record<string, unknown>;
    } catch (err) {
      if (/^RabbitMQ 404/.test((err as Error).message)) return null;
      throw err;
    }
    const args = (x.arguments && typeof x.arguments === 'object' && !Array.isArray(x.arguments) ? x.arguments : {}) as Record<string, unknown>;
    const name = queueName(ref.vhost, ref.queue);
    if (kind === 'exchange') {
      const alt = args['alternate-exchange'];
      return { kind: 'exchange', name, definition: { vhost: ref.vhost, name: ref.queue, type: String(x.type ?? 'direct'), durable: x.durable !== false, autoDelete: !!x.auto_delete, internal: !!x.internal, ...(typeof alt === 'string' && alt ? { alternateExchange: alt } : {}) } };
    }
    const spec: Record<string, unknown> = {};
    for (const [arg, key] of RABBIT_QUEUE_ARGS) if (args[arg] !== undefined) spec[key] = args[arg];
    const type = String(x.type ?? args['x-queue-type'] ?? 'classic');
    return { kind: 'queue', name, definition: { vhost: ref.vhost, name: ref.queue, type: type === 'quorum' || type === 'stream' ? type : 'classic', durable: x.durable !== false, autoDelete: !!x.auto_delete, arguments: spec } };
  }

  /** 2.0.x: the queues the read user sees, `<vhost>/<queue>`, filtered to the allow-list; GET only, paged. */
  async queues(opts: { allowed: (name: string) => boolean; patterns: string[]; limit: number; timeoutMs: number }): Promise<{ queues: QueueInfo[]; outside: number; capped: boolean }> {
    const limit = Math.max(1, opts.limit);
    const columns = 'name,vhost,type,state,durable,auto_delete,arguments,policy,effective_policy_definition,messages_ready,messages_unacknowledged,consumers,consumer_utilisation,message_stats.publish_details.rate,message_stats.deliver_get_details.rate,idle_since';
    const base = this.home ? `/api/queues/${enc(this.home)}` : '/api/queues';
    const pageSize = 500;
    const maxPages = 40;
    const deadline = Date.now() + opts.timeoutMs;
    const out: QueueInfo[] = [];
    let outside = 0;
    let capped = false;
    for (let page = 1; ; page++) {
      const left = Math.max(1000, deadline - Date.now());
      const r = (await this.call('GET', `${base}?page=${page}&page_size=${pageSize}&columns=${encodeURIComponent(columns)}`, undefined, left)) as { items?: Record<string, unknown>[]; page_count?: number } | Record<string, unknown>[] | null;
      // Paging answers {items, page_count, ...}; a broker that ignores it answers the whole array.
      const items = Array.isArray(r) ? r : (r?.items ?? []);
      const pageCount = Array.isArray(r) ? 1 : Number(r?.page_count ?? 1);
      for (const q of items) {
        const name = queueName(String(q.vhost ?? this.home ?? '/'), String(q.name ?? ''));
        if (!opts.allowed(name)) {
          outside++;
          continue;
        }
        if (out.length >= limit) {
          capped = true;
          continue;
        }
        out.push(rabbitQueueInfo(name, q));
      }
      if (page >= pageCount) break;
      if (page >= maxPages || Date.now() > deadline) {
        capped = true;
        break;
      }
    }
    return { queues: out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)), outside, capped };
  }
}

/** One management API queue as the Queues tab shows it. */
export function rabbitQueueInfo(name: string, q: Record<string, unknown>): QueueInfo {
  const args = (q.arguments && typeof q.arguments === 'object' ? q.arguments : {}) as Record<string, unknown>;
  const eff = (q.effective_policy_definition && typeof q.effective_policy_definition === 'object' && !Array.isArray(q.effective_policy_definition) ? q.effective_policy_definition : {}) as Record<string, unknown>;
  const type = String(q.type ?? args['x-queue-type'] ?? 'classic');
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  // An argument set on the queue wins over the policy, as RabbitMQ applies them.
  const dlx = args['x-dead-letter-exchange'] ?? eff['dead-letter-exchange'] ?? null;
  return {
    name,
    kind: type === 'quorum' ? 'quorum' : type === 'stream' ? 'stream-queue' : 'classic',
    depth: num(q.messages_ready),
    inFlight: num(q.messages_unacknowledged),
    consumers: num(q.consumers),
    state: q.state == null ? null : String(q.state),
    rateIn: rate(q, 'publish_details'),
    rateOut: rate(q, 'deliver_get_details'),
    details: {
      durable: q.durable ?? null,
      autoDelete: q.auto_delete ?? null,
      arguments: args,
      policy: q.policy || null,
      deadLetterExchange: dlx,
      deadLetterRoutingKey: args['x-dead-letter-routing-key'] ?? eff['dead-letter-routing-key'] ?? null,
      consumerUtilisation: num(q.consumer_utilisation),
      idleSince: q.idle_since ?? null
    }
  };
}
