import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import { hostname } from 'node:os';
import { ulid } from 'ulid';
import { fetch } from 'undici';
import { hmac, randomToken, safeEqual, sha256 } from '../crypto/index.js';
import { contentDigest, signMessage } from '../crypto/httpsig.js';
import { json } from '../db/knex.js';
import { labelRank, type Label } from '../authz/labels.js';
import { isUniqueViolation, rowToEvent, type AuditEvent } from '../audit/chain.js';
import { conflict, forbidden, notFound } from '../http/problem.js';
import { checkUrl, guardedAgent, HostRefused, parseAllowList, type AllowList } from '../mcp/hosts.js';
import { tenantHostProblem } from '../integrations/hosts.js';
import { TOPICS, type IntegrationEvent } from '../platform/bus.js';
import type { JobProgressEvent } from '../platform/jobs.js';
import type { Services } from '../services.js';
import { EVENT_GROUPS } from '../events/catalogue.js';

/*
 * Outbound webhooks (B-302). A tenant subscribes an endpoint to event types: audit actions (every append to the
 * tenant's chain, by action name), job states (`job.succeeded`, `job.failed`, `job.cancelled`), flags (`flag.created`,
 * `flag.confirmed`…) and approvals (`approval.requested`). Each matching event becomes a delivery row and a
 * `webhook.deliver` job; the job signs the body with HMAC-SHA256 over `<timestamp>.<body>`, posts it through a
 * dispatcher that only dials allowed addresses, and on failure schedules the next attempt with exponential backoff.
 * Consecutive failures open the endpoint's circuit breaker: deliveries then wait for the cool-down, and the first
 * one after it is the trial that closes or reopens it.
 *
 * Ordered webhooks (B-1004, and B-1504 across instances): each delivery takes the next position from the endpoint's
 * counter row (`webhook_order`) in the transaction that inserts it, only the head (the lowest pending position) is
 * scheduled, and it is sent only by the instance holding the endpoint's lease in the same row.
 */

/** The groups a webhook subscribes to; since 1.4.0 the event catalogue's groups (B-2001, `events/catalogue.ts`). */
export const WEBHOOK_EVENT_GROUPS: { pattern: string; description: string }[] = EVENT_GROUPS;

const PATTERN = /^(\*|[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*(\.\*)?)$/;
export const isEventPattern = (p: string): boolean => PATTERN.test(p);

export const matchesEvent = (patterns: readonly string[], type: string): boolean =>
  patterns.some((p) => p === '*' || p === type || (p.endsWith('.*') && type.startsWith(p.slice(0, -1))));

/** The signature header value for a body sent at `timestamp` (seconds). */
export const signBody = (secret: string, timestamp: number, body: string): string => `sha256=${hmac(secret, `${timestamp}.${body}`)}`;

/**
 * Receiver-side check of an Ed25519 signature (B-1004): `x-exprsn-signature-ed25519` is the base64 signature over
 * `<timestamp>.<body>` by the key named in `x-exprsn-key-id`, published at `/webhooks/keys/<tenant>` (JWKS). The
 * public key is given as the JWK `x` (base64url of the raw 32 bytes) or a KeyObject.
 */
export function verifyEd25519(publicKey: string | KeyObject, timestamp: string | undefined, signature: string | undefined, body: string, toleranceSeconds = 300, now = Date.now()): boolean {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > toleranceSeconds) return false;
  try {
    const key = typeof publicKey === 'string' ? createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' }) : publicKey;
    return edVerify(null, Buffer.from(`${timestamp}.${body}`), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

/** Receiver-side check, also used by the tests: signature over `<timestamp>.<body>` and a timestamp within tolerance. */
export function verifySignature(secret: string, timestamp: string | undefined, signature: string | undefined, body: string, toleranceSeconds = 300, now = Date.now()): boolean {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > toleranceSeconds) return false;
  return safeEqual(signature, signBody(secret, Number(timestamp), body));
}

export interface WebhookRow {
  id: string;
  tenant_id: string;
  name: string;
  url: string;
  events: string[];
  max_label: Label;
  secret_sealed: string;
  state: 'active' | 'disabled';
  /** B-1004: deliveries go out one at a time, in the order events were queued. */
  ordered: boolean;
  /** B-1004: HMAC with the shared secret, or Ed25519 with the tenant's published key. */
  signing: 'hmac' | 'ed25519';
  /** Sprint 20 (B-1203): also sign with RFC 9421 HTTP Message Signatures (the same key or secret). */
  message_signatures: boolean;
  breaker: 'closed' | 'open';
  failures: number;
  opened_at: number | null;
  last_delivery_at: number | null;
  last_status: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface DeliveryRow {
  id: string;
  tenant_id: string;
  webhook_id: string;
  event: string;
  event_id: string;
  label: Label;
  payload: string;
  state: 'pending' | 'succeeded' | 'failed';
  attempts: number;
  status_code: number | null;
  error: string | null;
  next_attempt_at: number | null;
  duration_ms: number | null;
  replay_of: string | null;
  job_id: string | null;
  dedupe_key: string;
  /** Position in the webhook's order (ordered webhooks only). */
  seq: number | null;
  created_at: number;
  delivered_at: number | null;
}

export interface SigningKeyRow {
  id: string;
  tenant_id: string;
  public_key: string;
  private_sealed: string;
  state: 'active' | 'retired';
  created_by: string | null;
  created_at: number;
  retired_at: number | null;
}

/** Sprint 20 (B-1202): `private_sealed` of a key in OpenBao transit (`kms:<name>`) or held by the signer (`signer:<blob>`). */
const KMS_REF = 'kms:';
const SIGNER_REF = 'signer:';

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const hookFromRow = (r: Record<string, unknown>): WebhookRow => ({ ...(r as unknown as WebhookRow), ordered: !!r.ordered, message_signatures: !!r.message_signatures, signing: r.signing === 'ed25519' ? 'ed25519' : 'hmac', events: json<string[]>(r.events, []), failures: Number(r.failures ?? 0), opened_at: num(r.opened_at), last_delivery_at: num(r.last_delivery_at), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });
const deliveryFromRow = (r: Record<string, unknown>): DeliveryRow => ({ ...(r as unknown as DeliveryRow), seq: num(r.seq), attempts: Number(r.attempts ?? 0), status_code: num(r.status_code), next_attempt_at: num(r.next_attempt_at), duration_ms: num(r.duration_ms), created_at: Number(r.created_at), delivered_at: num(r.delivered_at) });

export interface WebhookOptions {
  allowedHosts: string;
  timeoutMs: number;
  maxAttempts: number;
  retryBaseMs: number;
  breakerThreshold: number;
  breakerCooldownMs: number;
}

export const webhookView = (w: WebhookRow, cooldownMs: number) => ({
  id: w.id,
  name: w.name,
  url: w.url,
  events: w.events,
  maxLabel: w.max_label,
  state: w.state,
  ordered: w.ordered,
  signing: w.signing,
  messageSignatures: w.message_signatures,
  breaker: w.breaker,
  failures: w.failures,
  openedAt: w.opened_at,
  retryAt: w.breaker === 'open' && w.opened_at ? w.opened_at + cooldownMs : null,
  lastDeliveryAt: w.last_delivery_at,
  lastStatus: w.last_status,
  createdAt: w.created_at,
  updatedAt: w.updated_at
});

export const deliveryView = (d: DeliveryRow) => ({
  id: d.id,
  webhookId: d.webhook_id,
  event: d.event,
  eventId: d.event_id,
  label: d.label,
  state: d.state,
  attempts: d.attempts,
  statusCode: d.status_code,
  error: d.error,
  nextAttemptAt: d.next_attempt_at,
  durationMs: d.duration_ms,
  replayOf: d.replay_of,
  seq: d.seq,
  createdAt: d.created_at,
  deliveredAt: d.delivered_at
});

/** The data of an audit-action event: the audit entry, as the catalogue's audit schema describes it (B-2001). */
export const auditData = (e: AuditEvent): Record<string, unknown> => ({
  seq: e.seq,
  action: e.action,
  kind: e.kind,
  actor: { user: e.actor.user ?? null, username: e.actor.username ?? null, service: e.actor.service ?? null },
  target: e.target,
  detail: e.detail,
  decision: e.decision,
  traceId: e.trace_id,
  hash: e.hash
});

export interface ReplayFilter {
  /** Events at or after this time (ms). */
  since?: number;
  /** Events before this time (ms). */
  until?: number;
  /** Event patterns (a name, a prefix ending in `.*`, or `*`); the webhook's own subscription still applies. */
  types?: string[];
  /** Deliveries only: replay those in this state. */
  state?: 'pending' | 'succeeded' | 'failed';
  limit?: number;
  dryRun?: boolean;
}

export class WebhookService {
  private readonly operatorAllow: AllowList;
  /** Active subscriptions per tenant, for a few seconds, so an audit append does not always query the table. */
  private readonly cache = new Map<string, { at: number; hooks: WebhookRow[] }>();
  private readonly offs: (() => void)[] = [];
  /** Emits per tenant, one after another, so deliveries are queued in the order events happened on this instance. */
  private readonly lanes = new Map<string, Promise<unknown>>();
  /** This instance, as the holder of ordered endpoints' delivery leases (B-1504). */
  readonly instance = `${hostname().slice(0, 30)}:${process.pid}:${randomBytes(4).toString('hex')}`;

  constructor(private readonly s: () => Services, readonly o: WebhookOptions) {
    this.operatorAllow = parseAllowList(o.allowedHosts);
  }

  registerJobs(): void {
    this.s().jobs.register('webhook.deliver', (p) => this.deliver(String(p.deliveryId)), { timeoutMs: this.o.timeoutMs + 30_000 });
  }

  /** Subscribes to the event sources on this instance: each source fires once, where the event happens. */
  listen(): void {
    const s = this.s();
    this.offs.push(
      s.audit.onAppend((e) => void this.fromAudit(e).catch((err: unknown) => s.log.warn({ err }, 'webhook fan-out failed'))),
      s.bus.on<JobProgressEvent>(TOPICS.jobProgress, (e) => this.fromJob(e)),
      s.bus.on<IntegrationEvent>(TOPICS.integrationEvent, (e) => this.emit(e.tenantId, e.type, e.label, e.id, e.data))
    );
  }

  close(): void {
    for (const off of this.offs.splice(0)) off();
  }

  private async fromAudit(e: AuditEvent): Promise<void> {
    await this.emit(e.tenant_id, e.action, e.label, `audit:${e.id}`, auditData(e));
  }

  private async fromJob(e: JobProgressEvent): Promise<void> {
    if (!['succeeded', 'failed', 'cancelled'].includes(e.state)) return;
    // Webhook deliveries are jobs too; announcing them would feed back into themselves.
    if (e.type.startsWith('webhook.')) return;
    await this.emit(e.tenantId, `job.${e.state}`, 'internal', `job:${e.id}:${e.state}`, { id: e.id, type: e.type, state: e.state, error: e.error });
  }

  private async active(tenantId: string): Promise<WebhookRow[]> {
    const hit = this.cache.get(tenantId);
    if (hit && Date.now() - hit.at < 5000) return hit.hooks;
    const hooks = ((await this.s().db('webhooks').where({ tenant_id: tenantId, state: 'active' })) as Record<string, unknown>[]).map(hookFromRow);
    this.cache.set(tenantId, { at: Date.now(), hooks });
    return hooks;
  }

  private forget(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  /** Queues a delivery to every active subscription of the tenant that wants this event at this label. */
  emit(tenantId: string, type: string, label: Label, eventId: string, data: Record<string, unknown>): Promise<number> {
    if (tenantId === 'platform') return Promise.resolve(0);
    // The lane is taken when emit is called (listeners are called in event order), not after the first await.
    const prev = this.lanes.get(tenantId) ?? Promise.resolve();
    // B-2001: every event is checked against its catalogue schema (counted and logged, never dropped).
    this.s().events.check({ id: eventId, type, tenant: tenantId, label, createdAt: new Date().toISOString(), data });
    const run = prev.catch(() => undefined).then(async () => {
      const hooks = (await this.active(tenantId)).filter((w) => matchesEvent(w.events, type) && labelRank(label) <= labelRank(w.max_label));
      let n = 0;
      for (const w of hooks) if (await this.queue(w, type, label, eventId, data, null)) n++;
      return n;
    });
    this.lanes.set(tenantId, run);
    void run.finally(() => {
      if (this.lanes.get(tenantId) === run) this.lanes.delete(tenantId);
    }).catch(() => undefined);
    return run;
  }

  private async queue(w: WebhookRow, type: string, label: Label, eventId: string, data: Record<string, unknown>, replayOf: string | null, body?: string): Promise<DeliveryRow | null> {
    const s = this.s();
    const id = ulid();
    const t = Date.now();
    const payload = body ?? JSON.stringify({ id: eventId, type, tenant: w.tenant_id, label, createdAt: new Date(t).toISOString(), data });
    const row: DeliveryRow = {
      id,
      tenant_id: w.tenant_id,
      webhook_id: w.id,
      event: type.slice(0, 120),
      event_id: eventId.slice(0, 120),
      label,
      payload: await s.keys.seal(w.tenant_id, payload, `webhook-delivery:${id}`),
      state: 'pending',
      attempts: 0,
      status_code: null,
      error: null,
      next_attempt_at: t,
      duration_ms: null,
      replay_of: replayOf,
      job_id: null,
      dedupe_key: replayOf ? `${w.id}:replay:${id}` : `${w.id}:${eventId}`.slice(0, 200),
      seq: null,
      created_at: t,
      delivered_at: null
    };
    try {
      if (w.ordered) {
        // B-1504: the position comes from the endpoint's counter in the database and the row is inserted in the
        // same transaction, which holds the counter's row lock until it commits. Every instance therefore takes
        // positions in turn, and a position is never visible before the ones below it. Later deliveries wait for
        // their turn (next_attempt_at null).
        await this.ensureOrder(w);
        await s.db.transaction(async (trx) => {
          await trx('webhook_order').where({ webhook_id: w.id }).increment('next_seq', 1);
          const o = (await trx('webhook_order').where({ webhook_id: w.id }).first('next_seq')) as { next_seq: number | string };
          row.seq = Number(o.next_seq) - 1;
          await trx('webhook_deliveries').insert({ ...row, next_attempt_at: null });
        });
        row.next_attempt_at = null;
      } else await s.db('webhook_deliveries').insert(row);
    } catch (err) {
      // Another instance (or an earlier call) already queued this event for this subscription.
      if (isUniqueViolation(err)) return null;
      throw err;
    }
    if (w.ordered) await this.kick(w.id, w.tenant_id);
    else await this.schedule(row, t);
    return row;
  }

  /**
   * The order row of an ordered webhook (B-1504), created on first use with the next position after any delivery
   * already numbered (deliveries ordered before the row existed keep their place).
   */
  private async ensureOrder(w: Pick<WebhookRow, 'id' | 'tenant_id'>): Promise<void> {
    const db = this.s().db;
    if (await db('webhook_order').where({ webhook_id: w.id }).first('webhook_id')) return;
    const max = (await db('webhook_deliveries').where({ webhook_id: w.id }).max({ m: 'seq' }).first()) as { m: number | string | null } | undefined;
    try {
      await db('webhook_order').insert({ webhook_id: w.id, tenant_id: w.tenant_id, next_seq: Number(max?.m ?? 0) + 1, holder: null, delivery_id: null, lease_until: null, updated_at: Date.now() });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err; // another instance created it
    }
  }

  /**
   * Takes the endpoint's delivery lease for one delivery (B-1504): only the holder sends, so two instances never
   * have deliveries of one ordered endpoint in flight at once. A lease outlives a crashed holder by the delivery
   * timeout plus a margin. Returns the time the current holder's lease ends when it is taken elsewhere.
   */
  private async takeLease(w: WebhookRow, d: DeliveryRow): Promise<{ ok: true } | { ok: false; until: number }> {
    const db = this.s().db;
    await this.ensureOrder(w);
    const now = Date.now();
    const n = await db('webhook_order')
      .where({ webhook_id: w.id })
      .andWhere((q) => q.whereNull('holder').orWhere('lease_until', '<', now).orWhere({ holder: this.instance, delivery_id: d.id }))
      .update({ holder: this.instance, delivery_id: d.id, lease_until: now + this.o.timeoutMs + 30_000, updated_at: now });
    if (n === 1) return { ok: true };
    const o = (await db('webhook_order').where({ webhook_id: w.id }).first('lease_until')) as { lease_until: number | string | null } | undefined;
    return { ok: false, until: Number(o?.lease_until ?? now) };
  }

  private async releaseLease(webhookId: string, deliveryId: string): Promise<void> {
    await this.s().db('webhook_order').where({ webhook_id: webhookId, holder: this.instance, delivery_id: deliveryId }).update({ holder: null, delivery_id: null, lease_until: null, updated_at: Date.now() });
  }

  /** The oldest pending delivery of an ordered webhook: the only one that may be sent. */
  private async head(webhookId: string): Promise<DeliveryRow | null> {
    const r = await this.s().db('webhook_deliveries').where({ webhook_id: webhookId, state: 'pending' }).whereNotNull('seq').orderBy('seq', 'asc').orderBy('id', 'asc').first();
    return r ? deliveryFromRow(r) : null;
  }

  /**
   * Schedules the head of an ordered webhook when it is waiting for its turn. The claim (next_attempt_at from null)
   * is atomic, so the head gets exactly one job however many callers kick at once.
   */
  private async kick(webhookId: string, tenantId: string): Promise<void> {
    const h = await this.head(webhookId);
    if (!h || h.next_attempt_at != null) return;
    const now = Date.now();
    const claimed = await this.s().db('webhook_deliveries').where({ id: h.id, tenant_id: tenantId, state: 'pending' }).whereNull('next_attempt_at').update({ next_attempt_at: now });
    if (claimed === 1) await this.schedule(h, now);
  }

  private async schedule(d: DeliveryRow, runAt: number): Promise<void> {
    const job = await this.s().jobs.enqueue({ tenantId: d.tenant_id, type: 'webhook.deliver', payload: { deliveryId: d.id }, runAt, maxAttempts: 1 });
    await this.s().db('webhook_deliveries').where({ id: d.id }).update({ job_id: job.id, next_attempt_at: runAt });
  }

  private backoff(attempt: number): number {
    return Math.min(this.o.retryBaseMs * 2 ** Math.max(0, attempt - 1), 6 * 3_600_000);
  }

  /** The `webhook.deliver` job: one attempt, then the next one scheduled, the breaker updated, or the delivery closed. */
  async deliver(deliveryId: string): Promise<unknown> {
    const s = this.s();
    const raw = await s.db('webhook_deliveries').where({ id: deliveryId }).first();
    if (!raw) return { skipped: 'delivery removed' };
    const d = deliveryFromRow(raw);
    if (d.state !== 'pending') return { skipped: `delivery is ${d.state}` };
    const hr = await s.db('webhooks').where({ id: d.webhook_id, tenant_id: d.tenant_id }).first();
    if (!hr) {
      await s.db('webhook_deliveries').where({ id: d.id }).update({ state: 'failed', error: 'The webhook was removed.', next_attempt_at: null });
      return { failed: 'webhook removed' };
    }
    const w = hookFromRow(hr);
    if (w.state !== 'active') {
      await s.db('webhook_deliveries').where({ id: d.id }).update({ state: 'failed', error: 'The webhook is disabled.', next_attempt_at: null });
      return { failed: 'webhook disabled' };
    }
    if (w.ordered && d.seq != null) {
      const head = await this.head(w.id);
      if (head && head.id !== d.id) {
        // Not its turn: wait without a job; the delivery before it kicks it when it is done.
        await s.db('webhook_deliveries').where({ id: d.id, state: 'pending' }).update({ next_attempt_at: null, job_id: null });
        await this.kick(w.id, w.tenant_id);
        return { waiting: head.id };
      }
    }
    const now = Date.now();
    if (w.breaker === 'open' && w.opened_at != null && now < w.opened_at + this.o.breakerCooldownMs) {
      // The breaker is open: wait for the cool-down; the first delivery after it is the trial.
      await this.schedule(d, w.opened_at + this.o.breakerCooldownMs + Math.floor(Math.random() * 1000));
      return { deferred: 'circuit open' };
    }

    if (w.ordered && d.seq != null) {
      const lease = await this.takeLease(w, d);
      if (!lease.ok) {
        // Another instance is sending this endpoint's head: look again shortly (or when its lease runs out).
        await this.schedule(d, Math.min(lease.until, now + 1000) + Math.floor(Math.random() * 100));
        return { deferred: 'lease held by another instance' };
      }
      try {
        // Another job for the same delivery may have sent it while this one waited for the lease.
        const fresh = await s.db('webhook_deliveries').where({ id: d.id }).first();
        if (!fresh || fresh.state !== 'pending') return { skipped: 'delivery already handled' };
        return await this.attempt(w, deliveryFromRow(fresh));
      } finally {
        await this.releaseLease(w.id, d.id);
        await this.kick(w.id, w.tenant_id);
      }
    }
    return this.attempt(w, d);
  }

  /** One attempt at a delivery, its outcome recorded and the next attempt scheduled. */
  private async attempt(w: WebhookRow, d: DeliveryRow): Promise<unknown> {
    const s = this.s();
    const body = await s.keys.open(d.tenant_id, d.payload, `webhook-delivery:${d.id}`);
    const secret = await s.keys.open(w.tenant_id, w.secret_sealed, `webhook:${w.id}`);
    const tenantAllow = await s.integrations.allowList(w.tenant_id);
    const attempt = d.attempts + 1;
    const started = Date.now();
    let status: number | null = null;
    let error: string | null = null;
    let permanent = false;
    const agent = guardedAgent(this.operatorAllow, this.o.timeoutMs, (host, addrs) => tenantHostProblem(host, addrs, tenantAllow));
    try {
      // Names are checked again in the dispatcher's lookup; an address literal never reaches it, so check it here.
      const checked = await checkUrl(w.url, this.operatorAllow);
      const refused = tenantHostProblem(checked.host, checked.addresses, tenantAllow);
      if (refused) throw new HostRefused(refused);
      const ts = Math.floor(Date.now() / 1000);
      const signature: Record<string, string> = w.signing === 'ed25519' ? await this.edHeaders(w.tenant_id, ts, body) : { 'x-exprsn-signature': signBody(secret, ts, body) };
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'user-agent': 'exprsn-ai-webhooks',
        'x-exprsn-event': d.event,
        'x-exprsn-timestamp': String(ts),
        ...signature,
        'x-exprsn-delivery-id': d.id,
        ...(d.seq != null ? { 'x-exprsn-sequence': String(d.seq) } : {})
      };
      // Sprint 20 (B-1203): RFC 9421 signatures as well, over the method, target, body digest and delivery id.
      if (w.message_signatures) Object.assign(headers, await this.messageSignature(w, secret, headers, body, ts));
      const res = await fetch(w.url, {
        method: 'POST',
        body,
        headers,
        dispatcher: agent,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.o.timeoutMs)
      });
      status = res.status;
      await res.body?.cancel().catch(() => undefined);
      if (status < 200 || status >= 300) error = `The endpoint answered ${status}.`;
    } catch (err) {
      const e = err as Error & { cause?: Error };
      const refusal = e instanceof HostRefused ? e : e.cause instanceof HostRefused ? e.cause : null;
      if (refusal) {
        error = `Refused: ${refusal.message}`;
        permanent = true;
      } else error = e.name === 'TimeoutError' ? `No answer within ${this.o.timeoutMs} ms.` : `The request failed: ${(e.cause ?? e).message}`;
    } finally {
      await agent.close().catch(() => undefined);
    }
    const duration = Date.now() - started;
    const ok = error == null;
    const t = Date.now();

    if (ok) {
      await s.db('webhook_deliveries').where({ id: d.id }).update({ state: 'succeeded', attempts: attempt, status_code: status, error: null, next_attempt_at: null, duration_ms: duration, delivered_at: t });
      await s.db('webhooks').where({ id: w.id }).update({ failures: 0, breaker: 'closed', opened_at: null, last_delivery_at: t, last_status: String(status) });
      if (w.breaker === 'open') await this.breakerAudit(w, 'webhook.breaker.closed', { after: w.failures });
      this.forget(w.tenant_id);
      if (w.ordered && d.seq == null) await this.kick(w.id, w.tenant_id);
      return { delivered: status, attempt };
    }

    const failures = w.failures + 1;
    // A trial after the cool-down that fails reopens the breaker at once; otherwise it opens at the threshold.
    const open = w.breaker === 'open' || failures >= this.o.breakerThreshold;
    await s.db('webhooks').where({ id: w.id }).update({ failures, breaker: open ? 'open' : 'closed', opened_at: open ? t : null, last_delivery_at: t, last_status: status ? String(status) : 'error' });
    if (open && w.breaker !== 'open') await this.breakerAudit(w, 'webhook.breaker.opened', { failures, error });
    this.forget(w.tenant_id);
    const retry = !permanent && attempt < this.o.maxAttempts;
    const next = retry ? t + this.backoff(attempt) : null;
    await s.db('webhook_deliveries').where({ id: d.id }).update({ state: retry ? 'pending' : 'failed', attempts: attempt, status_code: status, error: (error ?? '').slice(0, 1000), next_attempt_at: next, duration_ms: duration });
    if (retry) await this.schedule({ ...d, attempts: attempt }, next!);
    // An ordered webhook moves on once the head has given up (it keeps its place while it retries); the caller
    // kicks after releasing the lease.
    else if (w.ordered && d.seq == null) await this.kick(w.id, w.tenant_id);
    return { failed: error, attempt, retryAt: next };
  }

  private async breakerAudit(w: WebhookRow, action: string, detail: Record<string, unknown>): Promise<void> {
    const s = this.s();
    await s.audit.append({ tenantId: w.tenant_id, action, kind: 'system', actor: { service: 'webhooks' }, target: { webhook: w.id, name: w.name }, detail });
    if (action === 'webhook.breaker.opened') {
      const admins = await s.notifications.usersWithRoles(w.tenant_id, ['tenant-admin']);
      await s.notifications.notify({ tenantId: w.tenant_id, userIds: admins, kind: 'webhook', title: `Webhook ${w.name} stopped delivering`, body: `${String(detail.failures)} failed attempts in a row; deliveries resume after the cool-down.`, route: 'tenants?ttab=webhooks', label: 'internal' }).catch(() => undefined);
    }
  }

  // ---------- Ed25519 signing keys (B-1004) ----------

  private async edHeaders(tenantId: string, ts: number, body: string): Promise<Record<string, string>> {
    const { signature, kid } = await this.edSign(tenantId, Buffer.from(`${ts}.${body}`));
    return { 'x-exprsn-signature-ed25519': signature.toString('base64'), 'x-exprsn-key-id': kid };
  }

  /**
   * RFC 9421 headers for a delivery: `Content-Digest`, `Signature-Input` and `Signature` (label `exprsn`), with
   * ed25519 and the tenant's key id for Ed25519 webhooks, or hmac-sha256 and the webhook id for HMAC ones.
   */
  private async messageSignature(w: WebhookRow, secret: string, headers: Record<string, string>, body: string, ts: number): Promise<Record<string, string>> {
    const digest = contentDigest(body);
    const msg = { method: 'POST', url: w.url, headers: { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), 'content-digest': digest } };
    const components = ['@method', '@target-uri', 'content-type', 'content-digest', 'x-exprsn-delivery-id'];
    let sig: { 'signature-input': string; signature: string };
    if (w.signing === 'ed25519') {
      const k = await this.currentKey(w.tenant_id);
      sig = await signMessage(msg, { label: 'exprsn', components, keyid: k.id, alg: 'ed25519', created: ts, signer: (base) => this.signWith(k, base) });
    } else sig = await signMessage(msg, { label: 'exprsn', components, keyid: w.id, alg: 'hmac-sha256', key: secret, created: ts });
    return { 'content-digest': digest, ...sig };
  }

  /** Where a key's private half lives (Sprint 20, B-1202): the signer, OpenBao transit, or sealed in the database. */
  private keyHome(): 'signer' | 'kms' | 'sealed' {
    const kms = this.s().kms;
    if (kms.heldKeys) return 'signer';
    return typeof kms.createSigningKey === 'function' && typeof kms.sign === 'function' ? 'kms' : 'sealed';
  }

  private static homeOf(k: Pick<SigningKeyRow, 'private_sealed'>): 'signer' | 'kms' | 'sealed' {
    return k.private_sealed.startsWith(SIGNER_REF) ? 'signer' : k.private_sealed.startsWith(KMS_REF) ? 'kms' : 'sealed';
  }

  /**
   * Signs with the tenant's active Ed25519 key, wherever it is held. With OpenBao the signature is made in transit and
   * with the signer in the signer, so the private key is never in this process; a key sealed here before either was
   * configured is retired (it stays in the JWKS) and replaced by one held there.
   */
  async edSign(tenantId: string, data: Buffer): Promise<{ signature: Buffer; kid: string }> {
    const k = await this.currentKey(tenantId);
    return { signature: await this.signWith(k, data), kid: k.id };
  }

  /** The active key, created (or moved to the KMS or the signer) first when needed. */
  private async currentKey(tenantId: string): Promise<SigningKeyRow> {
    const k = await this.activeKey(tenantId);
    const home = this.keyHome();
    if (k && WebhookService.homeOf(k) === home) return k;
    const made = await this.createKey(tenantId, null);
    if (k) await this.s().audit.append({ tenantId, action: 'webhook.signing-key.created', kind: 'system', actor: { service: 'webhooks' }, target: { key: made.row.id }, detail: { retired: k.id, reason: `moved to ${home === 'kms' ? 'the KMS' : 'the signer'}` } });
    return made.row;
  }

  private async signWith(k: SigningKeyRow, data: Buffer): Promise<Buffer> {
    const kms = this.s().kms;
    const home = WebhookService.homeOf(k);
    if (home === 'signer') {
      if (!kms.heldKeys) throw new Error('The webhook signing key is held by the signer, which is not configured (SIGNER_SOCKET).');
      return kms.heldKeys.sign(`webhook:${k.tenant_id}:${k.id}`, 'ed25519', k.private_sealed.slice(SIGNER_REF.length), data);
    }
    if (home === 'kms') {
      if (!kms.sign) throw new Error('The webhook signing key is held in a KMS that is no longer configured.');
      return kms.sign(k.private_sealed.slice(KMS_REF.length), 'ed25519', data);
    }
    const der = Buffer.from(await this.s().keys.open(k.tenant_id, k.private_sealed, `webhook-signing-key:${k.id}`), 'base64');
    return edSign(null, data, createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }));
  }

  async activeKey(tenantId: string): Promise<SigningKeyRow | null> {
    return ((await this.s().db('webhook_signing_keys').where({ tenant_id: tenantId, state: 'active' }).orderBy('created_at', 'desc').first()) as SigningKeyRow | undefined) ?? null;
  }

  /** Every published key of a tenant: the active one and the retired ones (kept so late deliveries still verify). */
  async signingKeys(tenantId: string): Promise<SigningKeyRow[]> {
    return (await this.s().db('webhook_signing_keys').where({ tenant_id: tenantId }).orderBy('created_at', 'desc')) as SigningKeyRow[];
  }

  /**
   * A new Ed25519 key pair. Sprint 20 (B-1202): created in OpenBao transit (not exportable) or in the signer when
   * either is configured; otherwise the private key is sealed with the tenant key. It never leaves the server.
   */
  async createKey(tenantId: string, by: string | null): Promise<{ row: SigningKeyRow; retired: string | null }> {
    const s = this.s();
    const id = ulid();
    let x: string;
    let sealed: string;
    const home = this.keyHome();
    if (home === 'signer') {
      const r = await s.kms.heldKeys!.create(`webhook:${tenantId}:${id}`, 'ed25519');
      x = String(createPublicKey(r.publicKey).export({ format: 'jwk' }).x);
      sealed = `${SIGNER_REF}${r.wrapped}`;
    } else if (home === 'kms') {
      const name = `${s.cfg.OPENBAO_KEY_PREFIX}webhook-${id}`.toLowerCase();
      x = String(createPublicKey(await s.kms.createSigningKey!(name, 'ed25519')).export({ format: 'jwk' }).x);
      sealed = `${KMS_REF}${name}`;
    } else {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      x = String(publicKey.export({ format: 'jwk' }).x);
      // Sealed before the transaction: sealing may read the tenant's data key from the database.
      sealed = await s.keys.seal(tenantId, privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), `webhook-signing-key:${id}`);
    }
    const prev = await this.activeKey(tenantId);
    const t = Date.now();
    await s.db.transaction(async (trx) => {
      await trx('webhook_signing_keys').where({ tenant_id: tenantId, state: 'active' }).update({ state: 'retired', retired_at: t });
      await trx('webhook_signing_keys').insert({ id, tenant_id: tenantId, public_key: x, private_sealed: sealed, state: 'active', created_by: by, created_at: t, retired_at: null });
    });
    return { row: (await s.db('webhook_signing_keys').where({ id }).first()) as SigningKeyRow, retired: prev?.id ?? null };
  }

  /** Where the tenant's active key is held, for the console. */
  async keyStore(tenantId: string): Promise<'signer' | 'kms' | 'sealed' | null> {
    const k = await this.activeKey(tenantId);
    return k ? WebhookService.homeOf(k) : null;
  }

  /** The JWKS a receiver fetches to verify Ed25519 signatures. */
  async jwks(tenantId: string) {
    return { keys: (await this.signingKeys(tenantId)).map((k) => ({ kty: 'OKP', crv: 'Ed25519', x: k.public_key, kid: k.id, use: 'sig', alg: 'EdDSA', status: k.state })) };
  }

  // ---------- management ----------

  async list(tenantId: string): Promise<WebhookRow[]> {
    return ((await this.s().db('webhooks').where({ tenant_id: tenantId }).orderBy('created_at', 'asc')) as Record<string, unknown>[]).map(hookFromRow);
  }

  async get(tenantId: string, id: string): Promise<WebhookRow> {
    const r = await this.s().db('webhooks').where({ tenant_id: tenantId, id }).first();
    if (!r) throw notFound('Webhook');
    return hookFromRow(r);
  }

  /** Checks an endpoint against the operator's and the tenant's rules; throws HostRefused with the reason. */
  async checkEndpoint(tenantId: string, url: string): Promise<void> {
    const checked = await checkUrl(url, this.operatorAllow);
    const refused = tenantHostProblem(checked.host, checked.addresses, await this.s().integrations.allowList(tenantId));
    if (refused) throw new HostRefused(refused);
  }

  async create(tenantId: string, by: string, input: { name: string; url: string; events: string[]; maxLabel: Label; ordered?: boolean; signing?: 'hmac' | 'ed25519'; messageSignatures?: boolean }): Promise<{ row: WebhookRow; secret: string }> {
    const s = this.s();
    await this.checkEndpoint(tenantId, input.url);
    const id = ulid();
    const secret = `whsec_${randomToken(32)}`;
    const t = Date.now();
    try {
      await s.db('webhooks').insert({ id, tenant_id: tenantId, name: input.name, url: input.url, events: JSON.stringify(input.events), max_label: input.maxLabel, secret_sealed: await s.keys.seal(tenantId, secret, `webhook:${id}`), state: 'active', ordered: !!input.ordered, signing: input.signing ?? 'hmac', message_signatures: !!input.messageSignatures, breaker: 'closed', failures: 0, created_by: by, created_at: t, updated_at: t });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`A webhook named ${input.name} already exists.`);
      throw err;
    }
    this.forget(tenantId);
    return { row: await this.get(tenantId, id), secret };
  }

  async update(tenantId: string, id: string, patch: { name?: string; url?: string; events?: string[]; maxLabel?: Label; state?: 'active' | 'disabled'; ordered?: boolean; signing?: 'hmac' | 'ed25519'; messageSignatures?: boolean }): Promise<{ before: WebhookRow; after: WebhookRow }> {
    const before = await this.get(tenantId, id);
    if (patch.url !== undefined && patch.url !== before.url) await this.checkEndpoint(tenantId, patch.url);
    const upd: Record<string, unknown> = { updated_at: Date.now() };
    if (patch.name !== undefined) upd.name = patch.name;
    if (patch.url !== undefined) upd.url = patch.url;
    if (patch.events !== undefined) upd.events = JSON.stringify(patch.events);
    if (patch.maxLabel !== undefined) upd.max_label = patch.maxLabel;
    if (patch.state !== undefined) upd.state = patch.state;
    if (patch.ordered !== undefined) upd.ordered = patch.ordered;
    if (patch.signing !== undefined) upd.signing = patch.signing;
    if (patch.messageSignatures !== undefined) upd.message_signatures = patch.messageSignatures;
    // Re-enabling, or pointing the webhook elsewhere, starts the breaker afresh.
    if ((patch.state === 'active' && before.state !== 'active') || (patch.url !== undefined && patch.url !== before.url)) Object.assign(upd, { breaker: 'closed', failures: 0, opened_at: null });
    try {
      await this.s().db('webhooks').where({ tenant_id: tenantId, id }).update(upd);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`A webhook named ${patch.name ?? ''} already exists.`);
      throw err;
    }
    this.forget(tenantId);
    const after = await this.get(tenantId, id);
    if (before.ordered && !after.ordered) {
      // Deliveries waiting for their turn go out now, unordered.
      const waiting = ((await this.s().db('webhook_deliveries').where({ webhook_id: id, state: 'pending' }).whereNull('next_attempt_at')) as Record<string, unknown>[]).map(deliveryFromRow);
      for (const d of waiting) await this.schedule(d, Date.now());
    } else if (after.ordered && after.state === 'active') await this.kick(id, tenantId);
    return { before, after };
  }

  async rotateSecret(tenantId: string, id: string): Promise<string> {
    const w = await this.get(tenantId, id);
    const secret = `whsec_${randomToken(32)}`;
    await this.s().db('webhooks').where({ id: w.id }).update({ secret_sealed: await this.s().keys.seal(tenantId, secret, `webhook:${w.id}`), updated_at: Date.now() });
    return secret;
  }

  async remove(tenantId: string, id: string): Promise<WebhookRow> {
    const w = await this.get(tenantId, id);
    await this.s().db('webhook_deliveries').where({ tenant_id: tenantId, webhook_id: w.id }).delete();
    await this.s().db('webhook_order').where({ webhook_id: w.id }).delete();
    await this.s().db('webhooks').where({ id: w.id }).delete();
    this.forget(tenantId);
    return w;
  }

  async deliveries(tenantId: string, webhookId: string, opts: { limit?: number; state?: string } = {}): Promise<DeliveryRow[]> {
    const q = this.s().db('webhook_deliveries').where({ tenant_id: tenantId, webhook_id: webhookId });
    if (opts.state) q.andWhere({ state: opts.state });
    return ((await q.orderBy('created_at', 'desc').limit(Math.min(opts.limit ?? 50, 200))) as Record<string, unknown>[]).map(deliveryFromRow);
  }

  /** Sends a delivery's exact body again, as a new delivery (with a fresh timestamp and signature). */
  async replay(tenantId: string, webhookId: string, deliveryId: string, clearance: Label): Promise<DeliveryRow> {
    const w = await this.get(tenantId, webhookId);
    const raw = await this.s().db('webhook_deliveries').where({ tenant_id: tenantId, webhook_id: w.id, id: deliveryId }).first();
    if (!raw) throw notFound('Delivery');
    const d = deliveryFromRow(raw);
    if (labelRank(d.label) > labelRank(clearance)) throw forbidden('That delivery is above your clearance.', { step: 'clearance' });
    const body = await this.s().keys.open(tenantId, d.payload, `webhook-delivery:${d.id}`);
    const row = await this.queue(w, d.event, d.label, d.event_id, {}, d.id, body);
    return row!;
  }

  /**
   * B-2103 (`exprsn-ai events replay`): sends past deliveries of a webhook again, oldest first, each as a new delivery
   * of its exact body (as the console's replay does one at a time). Replays of replays are not replayed again.
   */
  async replayDeliveries(tenantId: string, webhookId: string, f: ReplayFilter): Promise<{ matched: number; queued: number; events: string[] }> {
    const w = await this.get(tenantId, webhookId);
    const q = this.s().db('webhook_deliveries').where({ tenant_id: tenantId, webhook_id: w.id }).whereNull('replay_of');
    if (f.since != null) q.andWhere('created_at', '>=', f.since);
    if (f.until != null) q.andWhere('created_at', '<', f.until);
    if (f.state) q.andWhere({ state: f.state });
    const rows = (((await q.orderBy('created_at', 'asc').orderBy('id', 'asc').limit(Math.min(f.limit ?? 1000, 10_000))) as Record<string, unknown>[]).map(deliveryFromRow)).filter((d) => !f.types?.length || matchesEvent(f.types, d.event));
    let queued = 0;
    if (!f.dryRun) {
      for (const d of rows) {
        const body = await this.s().keys.open(tenantId, d.payload, `webhook-delivery:${d.id}`);
        if (await this.queue(w, d.event, d.label, d.event_id, {}, d.id, body)) queued++;
      }
    }
    return { matched: rows.length, queued, events: rows.map((d) => d.event_id) };
  }

  /**
   * B-2103: backfills audit-action events from the tenant's audit chain that this webhook never received (one it
   * subscribed to later, or that was disabled), oldest first, within its event list and label. An event it already
   * has a delivery for is skipped (replay those from the delivery log instead).
   */
  async backfillAudit(tenantId: string, webhookId: string, f: ReplayFilter): Promise<{ matched: number; queued: number; skipped: number }> {
    const w = await this.get(tenantId, webhookId);
    const q = this.s().db('audit_events').where({ tenant_id: tenantId });
    if (f.since != null) q.andWhere('ts', '>=', f.since);
    if (f.until != null) q.andWhere('ts', '<', f.until);
    const events = ((await q.orderBy('seq', 'asc').limit(Math.min(f.limit ?? 1000, 10_000))) as Record<string, unknown>[])
      .map(rowToEvent)
      .filter((e) => matchesEvent(w.events, e.action) && labelRank(e.label) <= labelRank(w.max_label) && (!f.types?.length || matchesEvent(f.types, e.action)));
    let queued = 0;
    let skipped = 0;
    if (!f.dryRun) {
      for (const e of events) {
        if (await this.queue(w, e.action, e.label, `audit:${e.id}`, auditData(e), null)) queued++;
        else skipped++;
      }
    }
    return { matched: events.length, queued, skipped };
  }

  // ---------- plugin deliveries (1.4.0, B-2003) ----------

  /** The name of the webhook a plugin's deliveries to `url` go through. */
  static pluginHookName(pluginKey: string, url: string): string {
    return `plugin:${pluginKey}:${sha256(url).slice(0, 8)}`;
  }

  /**
   * B-2003: the webhook a plugin's webhook action delivers through, one per plugin and endpoint, created on first use.
   * It subscribes to nothing (only the plugin queues to it), signs with the tenant's Ed25519 key (receivers verify
   * with the published JWKS, so no secret is handed out), and is checked against the operator's and the tenant's
   * outbound host rules here and again at every attempt. Its deliveries, retries and breaker are the webhook path's.
   */
  async managed(tenantId: string, pluginKey: string, url: string, maxLabel: Label): Promise<WebhookRow> {
    await this.checkEndpoint(tenantId, url);
    const name = WebhookService.pluginHookName(pluginKey, url);
    const s = this.s();
    const existing = await s.db('webhooks').where({ tenant_id: tenantId, name }).first();
    if (existing) {
      const w = hookFromRow(existing);
      if (w.max_label !== maxLabel) {
        await s.db('webhooks').where({ id: w.id }).update({ max_label: maxLabel, updated_at: Date.now() });
        this.forget(tenantId);
        return { ...w, max_label: maxLabel };
      }
      return w;
    }
    const id = ulid();
    const t = Date.now();
    try {
      await s.db('webhooks').insert({ id, tenant_id: tenantId, name, url, events: '[]', max_label: maxLabel, secret_sealed: await s.keys.seal(tenantId, `whsec_${randomToken(32)}`, `webhook:${id}`), state: 'active', ordered: false, signing: 'ed25519', message_signatures: false, breaker: 'closed', failures: 0, created_by: null, created_at: t, updated_at: t });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
    this.forget(tenantId);
    return hookFromRow((await s.db('webhooks').where({ tenant_id: tenantId, name }).first()) as Record<string, unknown>);
  }

  /** B-2003: queues one delivery to a plugin's webhook (deduplicated by event id, like every delivery). */
  async sendTo(w: WebhookRow, type: string, label: Label, eventId: string, data: Record<string, unknown>): Promise<DeliveryRow | null> {
    return this.queue(w, type, label, eventId, data, null);
  }

  /** Removes the webhooks a plugin delivered through (when the plugin is removed). */
  async removeManaged(tenantId: string, pluginKey: string): Promise<number> {
    const rows = (await this.s().db('webhooks').where({ tenant_id: tenantId }).andWhere('name', 'like', `plugin:${pluginKey}:%`).select('id')) as { id: string }[];
    for (const r of rows) await this.remove(tenantId, r.id);
    return rows.length;
  }

  /** A `webhook.ping` delivery to one subscription, whatever its event list. */
  async ping(tenantId: string, webhookId: string, by: string): Promise<DeliveryRow> {
    const w = await this.get(tenantId, webhookId);
    const row = await this.queue(w, 'webhook.ping', 'public', `ping:${ulid()}`, { webhook: w.id, name: w.name, by }, null);
    return row!;
  }
}
