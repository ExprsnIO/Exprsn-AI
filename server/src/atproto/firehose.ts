import { randomBytes } from 'node:crypto';
import client from 'prom-client';
import { ulid } from 'ulid';
import { WebSocket } from 'ws';
import type { AuditActor } from '../audit/chain.js';
import { isUniqueViolation } from '../audit/chain.js';
import { clears, type Label } from '../authz/labels.js';
import { json } from '../db/knex.js';
import { conflict, forbidden, HttpProblem } from '../http/problem.js';
import { checkServiceUrl, literalProblem, serviceLookup, servicePolicy, ServiceUrlRefused } from '../platform/egress.js';
import type { Services } from '../services.js';
import { CommitVerifier, type CommitCheck, type CommitProof } from './commit.js';
import { DidResolver } from './did.js';
import { collectionAllowed, parseJetstream, parseRepoFrame, recordText, sampled, type FirehoseMessage, type FirehoseProtocol, type Parsed } from './firehose-frames.js';

/*
 * AT-Protocol firehose ingest (B-1908). A tenant admin subscribes to a Jetstream or to a relay's
 * com.atproto.sync.subscribeRepos; each post that passes the filters (collections, authors, a deterministic sample)
 * goes through the moderation check (B-1901) as an `atproto-post` object, and the verdict labels the post's at:// URI
 * through the tenant's labeler (B-1610) and raises the object's one flag in the chosen workspace's queue.
 *
 * One instance at a time. Every worker instance runs a manager whose tick (FIREHOSE_TICK_MS, and at once when a
 * subscription changes, over the bus) claims or renews a lease on each running subscription (`holder`, `lease_until`,
 * as knowledge replication does); only the holder connects. A holder that dies stops renewing, and another instance
 * takes over once the lease has run out; one that stops gives its leases back at once.
 *
 * The cursor. Messages are handled in order from a bounded queue; the cursor is the last message handled, not the
 * last received. It is stored every FIREHOSE_CHECKPOINT_MS and when the consumer stops (shutdown, a stop, a lost
 * lease), with the holder in the condition so a consumer that lost its lease cannot write over its successor. A
 * restart connects with `?cursor=<stored>` and skips messages at or before it (Jetstream replays from the cursor's
 * time inclusive), so nothing handled is checked twice and nothing received but unhandled is lost.
 *
 * Backpressure. When the queue holds FIREHOSE_QUEUE_MAX messages the socket is paused (nothing more is read, and TCP
 * pushes back on the sender) until it drains to half. A relay that finds the consumer too slow may drop it; the
 * consumer reconnects from its cursor with exponential backoff up to FIREHOSE_BACKOFF_MAX_MS, as it does after any
 * disconnect or FIREHOSE_IDLE_MS without a message.
 *
 * The endpoint is an operator-chosen service URL: checked when saved and at every connection (B-901, `egress.ts`).
 *
 * Relay commits (B-3604). A subscribeRepos `#commit` is believed only when its signature verifies against the repo's
 * `#atproto` key and every operation used is proven against the signed tree (`commit.ts`). One that fails is dropped
 * whole (its posts are neither checked nor indexed, the cursor still moves past it), counted in `rejected` and audited
 * as `atproto.firehose.commit.rejected`, at most FIREHOSE_REJECT_AUDITS a minute per subscription, with the rest
 * summed in the next audit. Jetstream messages carry no signatures (Jetstream re-encodes the relay's commits as JSON):
 * a Jetstream endpoint is trusted as the operator's choice.
 *
 * Feeds (B-3002). Each post that passed the moderation check, and each delete, goes on to the tenant's feed generators
 * (`feeds.ts`), which index the ones their rules take.
 */

export const FIREHOSE_TOPIC = 'atproto.firehose.changed';
/** The moderation object type of an ingested record (unregistered: the check is given the text). */
export const POST_TYPE = 'atproto-post';
export const DEFAULT_COLLECTIONS = ['app.bsky.feed.post'];

export interface FirehoseOptions {
  tickMs: number;
  checkpointMs: number;
  queueMax: number;
  backoffMaxMs: number;
  idleMs: number;
  maxPerTenant: number;
  /** B-3604: the most `atproto.firehose.commit.rejected` audits a subscription writes in a minute. */
  rejectAudits?: number;
}

export interface SubscriptionRow {
  id: string;
  tenant_id: string;
  name: string;
  protocol: FirehoseProtocol;
  endpoint: string;
  collections: string[];
  dids: string[] | null;
  sample_ppm: number;
  workspace_id: string | null;
  label: Label;
  state: 'running' | 'stopped';
  rev: number;
  status: 'idle' | 'connecting' | 'streaming' | 'backoff' | 'error';
  holder: string | null;
  lease_until: number | null;
  cursor: number | null;
  cursor_at: number | null;
  last_event_at: number | null;
  last_error: string | null;
  received: number;
  checked: number;
  flagged: number;
  labelled: number;
  failed: number;
  reconnects: number;
  rejected: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface FirehoseActor {
  tenantId: string;
  userId: string | null;
  actor: AuditActor;
  traceId?: string | null;
}

export interface SubscriptionInput {
  name: string;
  protocol: FirehoseProtocol;
  endpoint: string;
  collections?: string[] | undefined;
  dids?: string[] | null | undefined;
  sampleRate?: number | undefined;
  workspaceId?: string | null | undefined;
  label?: Label | undefined;
}

export type SubscriptionPatch = { [K in keyof SubscriptionInput]?: SubscriptionInput[K] | undefined } & { cursor?: null | undefined };

interface Counts {
  received: number;
  checked: number;
  flagged: number;
  labelled: number;
  failed: number;
  reconnects: number;
  rejected: number;
}

const num = (v: unknown): number => Number(v ?? 0);
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const subFrom = (r: Record<string, unknown>): SubscriptionRow => ({
  ...(r as unknown as SubscriptionRow),
  collections: json<string[]>(r.collections, DEFAULT_COLLECTIONS),
  dids: json<string[] | null>(r.dids, null),
  sample_ppm: num(r.sample_ppm),
  rev: num(r.rev),
  lease_until: numOrNull(r.lease_until),
  cursor: numOrNull(r.cursor),
  cursor_at: numOrNull(r.cursor_at),
  last_event_at: numOrNull(r.last_event_at),
  received: num(r.received),
  checked: num(r.checked),
  flagged: num(r.flagged),
  labelled: num(r.labelled),
  failed: num(r.failed),
  reconnects: num(r.reconnects),
  rejected: num(r.rejected),
  created_at: num(r.created_at),
  updated_at: num(r.updated_at)
});

/** The URL a consumer dials: the endpoint as ws(s), the protocol's path, the filters (Jetstream) and the cursor. */
export function streamUrl(row: Pick<SubscriptionRow, 'protocol' | 'endpoint' | 'collections' | 'dids'>, cursor: number | null): URL {
  const url = new URL(row.endpoint);
  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
  url.search = '';
  if (row.protocol === 'jetstream') {
    if (url.pathname === '/' || url.pathname === '') url.pathname = '/subscribe';
    for (const c of row.collections) url.searchParams.append('wantedCollections', c);
    for (const d of row.dids ?? []) url.searchParams.append('wantedDids', d);
  } else if (!url.pathname.endsWith('/xrpc/com.atproto.sync.subscribeRepos')) {
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/xrpc/com.atproto.sync.subscribeRepos`;
  }
  if (cursor !== null) url.searchParams.set('cursor', String(cursor));
  return url;
}

export interface Post {
  uri: string;
  cid: string | null;
  text: string;
  did: string;
  collection: string;
}

interface Item {
  cursor: number;
  posts: Post[];
  /** Deleted records' URIs (taken out of the feed indexes). */
  deletes: string[];
  /** subscribeRepos: the commit to verify first, narrowed to the operations used (B-3604). */
  proof?: CommitProof;
}

interface FirehoseMetrics {
  events: client.Counter<'result'>;
  reconnects: client.Counter<string>;
  pauses: client.Counter<string>;
  queue: client.Gauge<'subscription'>;
  connected: client.Gauge<'subscription'>;
  paused: client.Gauge<'subscription'>;
  lag: client.Gauge<'subscription'>;
}

/** The consumer of one subscription on the instance that holds its lease. */
class Consumer {
  readonly queue: Item[] = [];
  cursor: number | null;
  private lastEnqueued: number | null;
  private ws: WebSocket | null = null;
  paused = false;
  connected = false;
  pauses = 0;
  private stopped = false;
  private failures = 0;
  private status: SubscriptionRow['status'] = 'connecting';
  private lastError: string | null = null;
  private lastEventAt: number | null = null;
  private readonly pending: Counts = { received: 0, checked: 0, flagged: 0, labelled: 0, failed: 0, reconnects: 0, rejected: 0 };
  /** B-3604: rejection audits written in the current minute, and the ones left out of it. */
  private rejectWindow = { start: 0, written: 0, skipped: 0 };
  private working: Promise<void> | null = null;
  private saving: Promise<boolean> = Promise.resolve(true);
  private idle: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private readonly checkpointTimer: NodeJS.Timeout;
  private readonly didSet: Set<string> | null;

  constructor(
    private readonly m: FirehoseService,
    readonly row: SubscriptionRow
  ) {
    this.cursor = row.cursor;
    this.lastEnqueued = row.cursor;
    this.didSet = row.dids ? new Set(row.dids) : null;
    this.checkpointTimer = setInterval(() => void this.checkpoint(), m.o.checkpointMs);
    this.checkpointTimer.unref();
  }

  private get s(): Services {
    return this.m.services;
  }

  private gauge(g: client.Gauge<'subscription'>, v: number): void {
    g.set({ subscription: this.row.id }, v);
  }

  start(): void {
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    const policy = servicePolicy(this.s.cfg);
    let url: URL;
    try {
      url = streamUrl(this.row, this.lastEnqueued);
    } catch (err) {
      return this.broken(`The endpoint is not a URL: ${(err as Error).message}`);
    }
    const refused = literalProblem(url.toString(), policy);
    if (refused) return this.broken(refused);
    this.status = 'connecting';
    const ws = new WebSocket(url, { lookup: serviceLookup(policy) as never, handshakeTimeout: 10_000, maxPayload: 8 * 1024 * 1024, followRedirects: false, perMessageDeflate: false });
    this.ws = ws;
    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.connected = true;
      this.failures = 0;
      this.status = 'streaming';
      this.gauge(this.m.metrics.connected, 1);
      this.armIdle();
      void this.checkpoint();
    });
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (this.ws !== ws) return;
      this.armIdle();
      this.onMessage(data, isBinary);
    });
    ws.on('error', (err) => {
      if (this.ws === ws) this.lastError = err.message.slice(0, 500);
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.connected = false;
      this.paused = false;
      this.gauge(this.m.metrics.connected, 0);
      this.gauge(this.m.metrics.paused, 0);
      if (this.idle) clearTimeout(this.idle);
      this.scheduleReconnect();
    });
  }

  /** The endpoint cannot be dialled at all: wait and try again (the setting may change, DNS may recover). */
  private broken(problem: string): void {
    this.lastError = problem.slice(0, 500);
    this.status = 'error';
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.failures++;
    this.pending.reconnects++;
    this.m.metrics.reconnects.inc();
    if (this.status !== 'error') this.status = 'backoff';
    // 500 ms doubling, with jitter, up to the cap.
    const base = Math.min(this.m.o.backoffMaxMs, 500 * 2 ** Math.min(this.failures - 1, 20));
    const delay = Math.round(base * (0.5 + Math.random() * 0.5));
    void this.checkpoint();
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect();
    }, delay);
    this.retry.unref();
  }

  private armIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    if (this.paused) return; // a paused socket reads nothing; quiet is expected
    this.idle = setTimeout(() => {
      this.lastError = `No message for ${Math.round(this.m.o.idleMs / 1000)} s; reconnecting.`;
      this.ws?.terminate();
    }, this.m.o.idleMs);
    this.idle.unref();
  }

  private onMessage(data: Buffer, isBinary: boolean): void {
    const ev = this.m.metrics.events;
    let parsed: Parsed;
    if (this.row.protocol === 'jetstream') parsed = isBinary ? { skip: 'binary message' } : parseJetstream(data.toString('utf8'));
    else parsed = isBinary ? parseRepoFrame(data) : { skip: 'text message' };
    if ('error' in parsed) {
      this.lastError = parsed.error.slice(0, 500);
      ev.inc({ result: 'error' });
      // An error frame ends the stream (the relay closes too) and is retried from the cursor; an unusable message is
      // skipped (it would come back on every replay otherwise), and the cursor moves past it with the next one.
      if (parsed.fatal) {
        this.status = 'error';
        this.ws?.terminate();
      }
      return;
    }
    if ('skip' in parsed) return;
    this.enqueue(parsed.message);
  }

  private enqueue(msg: FirehoseMessage): void {
    const ev = this.m.metrics.events;
    // At or before what was already taken (a replay after reconnecting, Jetstream's inclusive cursor): drop.
    if (this.lastEnqueued !== null && msg.cursor <= this.lastEnqueued) return;
    this.lastEnqueued = msg.cursor;
    this.pending.received++;
    ev.inc({ result: 'received' });
    this.lastEventAt = Date.now();
    if (msg.time !== null) this.gauge(this.m.metrics.lag, Math.max(0, (Date.now() - msg.time) / 1000));
    const posts: Post[] = [];
    const deletes: string[] = [];
    const used = new Set<string>();
    for (const op of msg.ops) {
      const uri = `at://${op.did}/${op.collection}/${op.rkey}`;
      const wanted = collectionAllowed(op.collection, this.row.collections) && (!this.didSet || this.didSet.has(op.did)) && sampled(uri, this.row.sample_ppm);
      if (wanted && op.action === 'delete') {
        deletes.push(uri);
        used.add(`${op.collection}/${op.rkey}`);
        continue;
      }
      const text = op.action === 'delete' ? '' : recordText(op.record);
      if (!text || !wanted) {
        ev.inc({ result: 'skipped' });
        continue;
      }
      posts.push({ uri, cid: op.cid, text, did: op.did, collection: op.collection });
      used.add(`${op.collection}/${op.rkey}`);
    }
    // Nothing to check and nothing ahead of it: the cursor moves at once.
    if (!posts.length && !deletes.length && !this.queue.length && !this.working) {
      this.cursor = msg.cursor;
      return;
    }
    // Only the operations used need proving (B-3604); the signature covers the whole commit either way.
    const proof = msg.proof && (posts.length || deletes.length) ? { ...msg.proof, ops: msg.proof.ops.filter((o) => used.has(o.path)) } : undefined;
    this.queue.push({ cursor: msg.cursor, posts, deletes, ...(proof ? { proof } : {}) });
    this.gauge(this.m.metrics.queue, this.queue.length);
    if (this.queue.length >= this.m.o.queueMax && !this.paused && this.ws) {
      this.ws.pause();
      this.paused = true;
      this.pauses++;
      this.m.metrics.pauses.inc();
      this.gauge(this.m.metrics.paused, 1);
      if (this.idle) clearTimeout(this.idle);
    }
    this.kick();
  }

  private kick(): void {
    if (this.working || this.stopped) return;
    this.working = this.drain()
      .catch((err: unknown) => this.s.log.warn({ err, subscription: this.row.id }, 'firehose: handling messages failed'))
      .finally(() => {
        this.working = null;
        if (this.queue.length && !this.stopped) this.kick();
      });
  }

  private async drain(): Promise<void> {
    while (!this.stopped && this.queue.length) {
      const item = this.queue[0]!;
      // Deletes matter only to feeds: without any, they need neither proof nor work.
      let { proof, deletes } = item;
      if (deletes.length && !(await this.m.feeds()?.hasActive(this.row.tenant_id))) {
        deletes = [];
        if (proof) proof = { ...proof, ops: proof.ops.filter((o) => o.action !== 'delete') };
      }
      if (item.posts.length || deletes.length) {
        const verdict = proof ? await this.m.verifier.verify(proof) : null;
        if (this.stopped) return;
        if (verdict && !verdict.ok) await this.reject(item, verdict);
        else {
          for (const p of item.posts) if (!(await this.checkPost(p))) return; // stopped: the item is taken again next time
          for (const uri of deletes) await this.m.feeds()?.forget(this.row.tenant_id, uri).catch((err: unknown) => this.s.log.warn({ err, subscription: this.row.id }, 'firehose: removing a deleted post from the feeds failed'));
        }
      }
      this.queue.shift();
      this.cursor = item.cursor;
      this.gauge(this.m.metrics.queue, this.queue.length);
      if (this.paused && this.queue.length <= Math.floor(this.m.o.queueMax / 2)) {
        this.paused = false;
        this.gauge(this.m.metrics.paused, 0);
        this.ws?.resume();
        this.armIdle();
      }
    }
  }

  /** One post through the moderation check; false only when the consumer stopped meanwhile. */
  private async checkPost(p: Post): Promise<boolean> {
    const ev = this.m.metrics.events;
    const ctx = { tenantId: this.row.tenant_id, principal: null, actor: { service: 'atproto-firehose' }, traceId: null };
    for (let attempt = 1; ; attempt++) {
      if (this.stopped) return false;
      try {
        const r = await this.s.moderation.check(ctx, { type: POST_TYPE, id: p.uri, text: p.text, workspaceId: this.row.workspace_id, label: this.row.label, checkpoint: 'user-input', subject: p.uri, apply: false });
        this.pending.checked++;
        ev.inc({ result: 'checked' });
        if (r.flag) {
          this.pending.flagged++;
          ev.inc({ result: 'flagged' });
        }
        if (r.labels.length) {
          this.pending.labelled++;
          ev.inc({ result: 'labelled' });
        }
        if (r.labelError) this.lastError = `Labelling ${p.uri.slice(0, 200)} failed: ${r.labelError}`.slice(0, 500);
        // B-3002: the feed generators index what their rules take (a failure there does not undo the check).
        await this.m
          .feeds()
          ?.ingest(this.row, p, { action: r.verdict.action, labels: r.labels })
          .catch((err: unknown) => {
            this.lastError = `Indexing ${p.uri.slice(0, 200)} for the feeds failed: ${(err as Error).message}`.slice(0, 500);
          });
        return true;
      } catch (err) {
        // A refusal about the object itself will not change; anything else (the database, a lock) is tried again.
        if (err instanceof HttpProblem || attempt >= 3 || this.stopped) {
          this.pending.failed++;
          ev.inc({ result: 'failed' });
          this.lastError = `Checking ${p.uri.slice(0, 200)} failed: ${(err as Error).message}`.slice(0, 500);
          this.s.log.warn({ err: (err as Error).message, subscription: this.row.id }, 'firehose: a post could not be checked');
          return !this.stopped;
        }
        await sleep(250 * attempt);
      }
    }
  }

  /** B-3604: a commit that did not verify. Its posts are dropped; it is counted and audited (rate-limited). */
  private async reject(item: Item, v: Extract<CommitCheck, { ok: false }>): Promise<void> {
    this.pending.rejected++;
    this.m.metrics.events.inc({ result: 'rejected' });
    const repo = item.proof?.repo ?? '';
    this.lastError = `A commit from ${repo.slice(0, 200)} was dropped (${v.reason}): ${v.detail}`.slice(0, 500);
    const now = Date.now();
    const w = this.rejectWindow;
    if (now - w.start >= 60_000) {
      w.start = now;
      w.written = 0;
    }
    if (w.written >= (this.m.o.rejectAudits ?? 20)) {
      w.skipped++;
      return;
    }
    w.written++;
    const more = w.skipped;
    w.skipped = 0;
    await this.s.audit
      .append({ tenantId: this.row.tenant_id, action: 'atproto.firehose.commit.rejected', kind: 'system', actor: { service: 'atproto-firehose' }, target: { subscription: this.row.id, did: repo.slice(0, 300) }, label: 'internal', detail: { reason: v.reason, detail: v.detail, seq: item.cursor, posts: item.posts.length, deletes: item.deletes.length, ...(more ? { more } : {}) }, traceId: null })
      .catch((err: unknown) => this.s.log.warn({ err, subscription: this.row.id }, 'firehose: auditing a rejected commit failed'));
  }

  /**
   * Stores the cursor, the counts since the last checkpoint and the status, only while this instance holds the
   * lease. Returns false when it no longer does (the manager then stops this consumer).
   */
  checkpoint(): Promise<boolean> {
    this.saving = this.saving.then(async () => {
      const d = { ...this.pending };
      for (const k of Object.keys(this.pending) as (keyof Counts)[]) this.pending[k] = 0;
      const db = this.s.db;
      const now = Date.now();
      try {
        const n = await db('firehose_subscriptions')
          .where({ id: this.row.id, holder: this.m.instance })
          .update({
            cursor: this.cursor,
            cursor_at: now,
            status: this.stopped ? 'idle' : this.status,
            last_error: this.lastError,
            ...(this.lastEventAt ? { last_event_at: this.lastEventAt } : {}),
            received: db.raw('received + ?', [d.received]),
            checked: db.raw('checked + ?', [d.checked]),
            flagged: db.raw('flagged + ?', [d.flagged]),
            labelled: db.raw('labelled + ?', [d.labelled]),
            failed: db.raw('failed + ?', [d.failed]),
            reconnects: db.raw('reconnects + ?', [d.reconnects]),
            rejected: db.raw('rejected + ?', [d.rejected])
          });
        return n === 1;
      } catch (err) {
        for (const k of Object.keys(d) as (keyof Counts)[]) this.pending[k] += d[k];
        this.s.log.warn({ err, subscription: this.row.id }, 'firehose: storing the cursor failed');
        return true;
      }
    });
    return this.saving;
  }

  /** Stops reading, lets the post being checked finish, and stores the cursor. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.checkpointTimer);
    if (this.idle) clearTimeout(this.idle);
    if (this.retry) clearTimeout(this.retry);
    const ws = this.ws;
    this.ws = null;
    ws?.terminate();
    await this.working?.catch(() => undefined);
    await this.checkpoint();
    for (const g of [this.m.metrics.queue, this.m.metrics.connected, this.m.metrics.paused, this.m.metrics.lag]) g.remove({ subscription: this.row.id });
  }

  view() {
    return { connected: this.connected, paused: this.paused, queue: this.queue.length, pauses: this.pauses, cursor: this.cursor };
  }
}

/** Subscriptions (the admin side) and the manager that runs their consumers (the worker side). */
export class FirehoseService {
  readonly instance = randomBytes(8).toString('hex');
  private readonly consumers = new Map<string, Consumer>();
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private again = false;
  private closed = false;
  private offBus: (() => void) | null = null;
  private m: FirehoseMetrics | null = null;
  private v: CommitVerifier | null = null;

  constructor(
    private readonly s: () => Services,
    readonly o: FirehoseOptions
  ) {}

  /**
   * B-3604: the commit verifier. Repo DIDs are resolved through the AT-Protocol service's guarded fetch (the service
   * URL checks, B-901) with their own cache, larger than the labelers' since a relay carries many repos.
   */
  get verifier(): CommitVerifier {
    if (this.v) return this.v;
    const s = this.s();
    this.v = new CommitVerifier(new DidResolver(s.atproto.http, () => s.cfg.ATPROTO_PLC_URL, 5 * 60_000, 50_000));
    return this.v;
  }

  /** B-3002: the feed generators, when the services carry them. */
  feeds(): Services['feedGenerators'] | null {
    return this.s().feedGenerators ?? null;
  }

  get services(): Services {
    return this.s();
  }

  get metrics(): FirehoseMetrics {
    if (this.m) return this.m;
    const reg = this.s().metrics.registry;
    const counter = <T extends string>(name: string, help: string, labelNames: T[]) => (reg.getSingleMetric(name) as client.Counter<T> | undefined) ?? new client.Counter({ name, help, labelNames, registers: [reg] });
    const gauge = (name: string, help: string) => (reg.getSingleMetric(name) as client.Gauge<'subscription'> | undefined) ?? new client.Gauge({ name, help, labelNames: ['subscription'], registers: [reg] });
    this.m = {
      events: counter('exprsn_firehose_events_total', 'Firehose messages and posts by outcome: received, skipped, checked, flagged, labelled, failed, error, rejected (a relay commit that did not verify)', ['result']),
      reconnects: counter<string>('exprsn_firehose_reconnects_total', 'Firehose reconnections (after a disconnect, an error or silence)', []),
      pauses: counter<string>('exprsn_firehose_pauses_total', 'Times a firehose socket was paused because its queue was full', []),
      queue: gauge('exprsn_firehose_queue_depth', 'Messages waiting in a firehose consumer queue'),
      connected: gauge('exprsn_firehose_connected', 'Whether a firehose consumer on this instance is connected (1) or not (0)'),
      paused: gauge('exprsn_firehose_paused', 'Whether a firehose consumer socket is paused by backpressure'),
      lag: gauge('exprsn_firehose_lag_seconds', 'Age of the newest firehose event received, by its upstream time')
    };
    return this.m;
  }

  private get db() {
    return this.s().db;
  }

  private audit(by: FirehoseActor, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>) {
    return this.s().audit.append({ tenantId: by.tenantId, action, kind: by.userId ? 'admin' : 'system', actor: by.actor, target, label: 'internal', ...(detail ? { detail } : {}), traceId: by.traceId ?? null });
  }

  private changed(): void {
    this.s().bus.publish(FIREHOSE_TOPIC, {});
  }

  // ---------- subscriptions ----------

  async list(tenantId: string): Promise<SubscriptionRow[]> {
    return ((await this.db('firehose_subscriptions').where({ tenant_id: tenantId }).orderBy('created_at', 'asc')) as Record<string, unknown>[]).map(subFrom);
  }

  async get(tenantId: string, id: string): Promise<SubscriptionRow | undefined> {
    const r = (await this.db('firehose_subscriptions').where({ tenant_id: tenantId, id }).first()) as Record<string, unknown> | undefined;
    return r ? subFrom(r) : undefined;
  }

  private async checkEndpoint(endpoint: string): Promise<void> {
    try {
      await checkServiceUrl(endpoint, servicePolicy(this.s().cfg), { protocols: ['wss:', 'ws:', 'https:', 'http:'] });
    } catch (err) {
      if (err instanceof ServiceUrlRefused) throw new HttpProblem(400, 'Endpoint refused', err.message, { extensions: { step: 'endpoint' } });
      throw err;
    }
  }

  private async checkWorkspace(tenantId: string, workspaceId: string | null | undefined): Promise<void> {
    if (workspaceId && !(await this.s().tenants.workspace(tenantId, workspaceId))) throw new HttpProblem(400, 'Invalid request', 'The workspace is not in this tenant.');
  }

  async create(by: FirehoseActor, clearance: Label, input: SubscriptionInput & { start?: boolean | undefined }): Promise<SubscriptionRow> {
    const tenantId = by.tenantId;
    const label = input.label ?? 'public';
    if (!clears(clearance, label)) throw forbidden(`Posts labelled ${label} are above your clearance.`, { step: 'clearance' });
    if ((await this.list(tenantId)).length >= this.o.maxPerTenant) throw conflict(`A tenant has at most ${this.o.maxPerTenant} firehose subscriptions (FIREHOSE_MAX_PER_TENANT).`);
    await this.checkEndpoint(input.endpoint);
    await this.checkWorkspace(tenantId, input.workspaceId);
    const id = ulid();
    const now = Date.now();
    const collections = input.collections ?? DEFAULT_COLLECTIONS;
    const samplePpm = Math.round((input.sampleRate ?? 1) * 1_000_000);
    try {
      await this.db('firehose_subscriptions').insert({
        id,
        tenant_id: tenantId,
        name: input.name,
        protocol: input.protocol,
        endpoint: input.endpoint,
        collections: JSON.stringify(collections),
        dids: input.dids ? JSON.stringify(input.dids) : null,
        sample_ppm: samplePpm,
        workspace_id: input.workspaceId ?? null,
        label,
        state: input.start ? 'running' : 'stopped',
        rev: 1,
        status: 'idle',
        holder: null,
        lease_until: null,
        cursor: null,
        cursor_at: null,
        last_event_at: null,
        last_error: null,
        received: 0,
        checked: 0,
        flagged: 0,
        labelled: 0,
        failed: 0,
        reconnects: 0,
        rejected: 0,
        created_by: by.userId,
        created_at: now,
        updated_at: now
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`A firehose subscription named ${input.name} exists.`);
      throw err;
    }
    await this.audit(by, 'atproto.firehose.created', { subscription: id, name: input.name }, { protocol: input.protocol, endpoint: input.endpoint, collections, authors: input.dids?.length ?? null, sampleRate: samplePpm / 1_000_000, workspace: input.workspaceId ?? null, label, state: input.start ? 'running' : 'stopped' });
    if (input.start) this.changed();
    return (await this.get(tenantId, id))!;
  }

  /** Changes the configuration; a running consumer restarts with it. `cursor: null` starts again from live. */
  async update(by: FirehoseActor, clearance: Label, row: SubscriptionRow, patch: SubscriptionPatch): Promise<SubscriptionRow> {
    const set: Record<string, unknown> = {};
    const detail: Record<string, unknown> = {};
    if (patch.name !== undefined && patch.name !== row.name) set.name = detail.name = patch.name;
    if (patch.protocol !== undefined && patch.protocol !== row.protocol) set.protocol = detail.protocol = patch.protocol;
    if (patch.endpoint !== undefined && patch.endpoint !== row.endpoint) {
      await this.checkEndpoint(patch.endpoint);
      set.endpoint = detail.endpoint = patch.endpoint;
    }
    if (patch.collections !== undefined) {
      set.collections = JSON.stringify(patch.collections);
      detail.collections = patch.collections;
    }
    if (patch.dids !== undefined) {
      set.dids = patch.dids ? JSON.stringify(patch.dids) : null;
      detail.authors = patch.dids?.length ?? null;
    }
    if (patch.sampleRate !== undefined) {
      set.sample_ppm = Math.round(patch.sampleRate * 1_000_000);
      detail.sampleRate = patch.sampleRate;
    }
    if (patch.workspaceId !== undefined) {
      await this.checkWorkspace(row.tenant_id, patch.workspaceId);
      set.workspace_id = detail.workspace = patch.workspaceId;
    }
    if (patch.label !== undefined) {
      if (!clears(clearance, patch.label)) throw forbidden(`Posts labelled ${patch.label} are above your clearance.`, { step: 'clearance' });
      set.label = detail.label = patch.label;
    }
    if (patch.cursor === null) {
      // The cursor belongs to the consumer while one runs: it would store its own over the reset when it stops.
      if (row.state === 'running' || (row.holder && (row.lease_until ?? 0) > Date.now())) throw conflict('Stop the subscription (and let it finish stopping) before resetting its cursor.');
      set.cursor = null;
      set.cursor_at = Date.now();
      detail.cursorReset = { from: row.cursor };
    }
    if (!Object.keys(set).length) return row;
    if (patch.protocol !== undefined && patch.protocol !== row.protocol && patch.cursor !== null && row.cursor !== null) throw conflict('A cursor from one protocol means nothing to the other: reset the cursor (cursor: null) when changing the protocol.');
    try {
      await this.db('firehose_subscriptions')
        .where({ id: row.id })
        .update({ ...set, rev: row.rev + 1, updated_at: Date.now() });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`A firehose subscription named ${String(patch.name)} exists.`);
      throw err;
    }
    await this.audit(by, 'atproto.firehose.updated', { subscription: row.id, name: row.name }, detail);
    this.changed();
    return (await this.get(row.tenant_id, row.id))!;
  }

  async remove(by: FirehoseActor, row: SubscriptionRow): Promise<void> {
    await this.db('firehose_subscriptions').where({ id: row.id }).delete();
    await this.audit(by, 'atproto.firehose.deleted', { subscription: row.id, name: row.name }, { cursor: row.cursor, checked: row.checked, flagged: row.flagged });
    this.changed();
  }

  /** Start or stop (what an admin asks for; the instance holding the lease acts on it at its next tick). */
  async setState(by: FirehoseActor, row: SubscriptionRow, state: 'running' | 'stopped'): Promise<SubscriptionRow> {
    if (row.state !== state) {
      await this.db('firehose_subscriptions')
        .where({ id: row.id })
        .update({ state, ...(state === 'running' ? { last_error: null } : {}), updated_at: Date.now() });
      await this.audit(by, state === 'running' ? 'atproto.firehose.started' : 'atproto.firehose.stopped', { subscription: row.id, name: row.name }, { cursor: row.cursor });
      this.changed();
    }
    return (await this.get(row.tenant_id, row.id))!;
  }

  /** The admin view: the row, whether some instance holds it now, and this instance's live state when it is the one. */
  view(row: SubscriptionRow) {
    const held = !!row.holder && (row.lease_until ?? 0) > Date.now();
    const local = this.consumers.get(row.id);
    return {
      id: row.id,
      name: row.name,
      protocol: row.protocol,
      endpoint: row.endpoint,
      collections: row.collections,
      dids: row.dids,
      sampleRate: row.sample_ppm / 1_000_000,
      workspaceId: row.workspace_id,
      label: row.label,
      state: row.state,
      status: held ? row.status : row.state === 'running' ? 'waiting' : 'idle',
      held,
      cursor: row.cursor,
      cursorAt: row.cursor_at,
      lastEventAt: row.last_event_at,
      lastError: row.last_error,
      counts: { received: row.received, checked: row.checked, flagged: row.flagged, labelled: row.labelled, failed: row.failed, rejected: row.rejected },
      reconnects: row.reconnects,
      rev: row.rev,
      live: local ? local.view() : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  // ---------- the manager (worker instances) ----------

  /** Starts the tick on this instance (workers only; index.ts through startSchedules). */
  start(): void {
    if (this.timer || this.closed) return;
    this.offBus = this.s().bus.on(FIREHOSE_TOPIC, () => void this.tick().catch(() => undefined));
    this.timer = setInterval(() => void this.tick().catch((err: unknown) => this.s().log.warn({ err }, 'firehose tick failed')), this.o.tickMs);
    this.timer.unref();
    void this.tick().catch((err: unknown) => this.s().log.warn({ err }, 'firehose tick failed'));
  }

  /** The consumer this instance runs for a subscription, if any (tests and the view). */
  local(id: string): ReturnType<Consumer['view']> | null {
    return this.consumers.get(id)?.view() ?? null;
  }

  /** Stores every local consumer's cursor now (tests; the timer does it every FIREHOSE_CHECKPOINT_MS). */
  async checkpointAll(): Promise<void> {
    await Promise.all([...this.consumers.values()].map((c) => c.checkpoint()));
  }

  /** One pass: claim or renew leases, start what this instance holds, stop what it lost or what was stopped. */
  tick(): Promise<void> {
    if (this.ticking) {
      this.again = true;
      return this.ticking;
    }
    this.ticking = (async () => {
      do {
        this.again = false;
        await this.pass();
      } while (this.again && !this.closed);
    })().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async pass(): Promise<void> {
    if (this.closed) return;
    // B-1403: an instance older than the schema takes no work; it gives back what it holds.
    if (this.s().schema.refusal()) {
      await Promise.all([...this.consumers.keys()].map((id) => this.stopLocal(id, true)));
      return;
    }
    const db = this.db;
    const rows = ((await db('firehose_subscriptions').where({ state: 'running' })) as Record<string, unknown>[]).map(subFrom);
    const wanted = new Set(rows.map((r) => r.id));
    for (const id of [...this.consumers.keys()]) if (!wanted.has(id)) await this.stopLocal(id, true);
    for (const r of rows) {
      if (this.closed) return;
      const now = Date.now();
      const claimed = await db('firehose_subscriptions')
        .where({ id: r.id, state: 'running' })
        .andWhere((q) => q.whereNull('holder').orWhere({ holder: this.instance }).orWhere('lease_until', '<', now))
        .update({ holder: this.instance, lease_until: now + this.o.tickMs * 3 });
      if (claimed !== 1) {
        // Another instance holds it: make sure this one is not consuming too.
        if (this.consumers.has(r.id)) await this.stopLocal(r.id, false);
        continue;
      }
      const cur = this.consumers.get(r.id);
      if (cur && cur.row.rev === r.rev) continue;
      if (cur) await this.stopLocal(r.id, false); // the configuration changed: start again with it
      const fresh = await this.db('firehose_subscriptions').where({ id: r.id }).first();
      if (!fresh || this.closed) continue;
      const c = new Consumer(this, subFrom(fresh as Record<string, unknown>));
      this.consumers.set(r.id, c);
      c.start();
    }
  }

  private async stopLocal(id: string, release: boolean): Promise<void> {
    const c = this.consumers.get(id);
    this.consumers.delete(id);
    await c?.stop();
    // Give the lease back so another instance (or this one, after a restart) can take over at once.
    if (release) await this.db('firehose_subscriptions').where({ id, holder: this.instance }).update({ holder: null, lease_until: null, status: 'idle' }).catch(() => undefined);
  }

  /** Shutdown: every consumer stores its cursor and gives its lease back. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.offBus?.();
    this.offBus = null;
    await this.ticking?.catch(() => undefined);
    await Promise.all([...this.consumers.keys()].map((id) => this.stopLocal(id, true)));
  }
}
