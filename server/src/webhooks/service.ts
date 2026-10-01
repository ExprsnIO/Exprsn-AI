import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import { ulid } from 'ulid';
import { fetch } from 'undici';
import { hmac, randomToken, safeEqual } from '../crypto/index.js';
import { json } from '../db/knex.js';
import { labelRank, type Label } from '../authz/labels.js';
import { isUniqueViolation, type AuditEvent } from '../audit/chain.js';
import { conflict, forbidden, notFound } from '../http/problem.js';
import { checkUrl, guardedAgent, HostRefused, parseAllowList, type AllowList } from '../mcp/hosts.js';
import { tenantHostProblem } from '../integrations/hosts.js';
import { TOPICS, type IntegrationEvent } from '../platform/bus.js';
import type { JobProgressEvent } from '../platform/jobs.js';
import type { Services } from '../services.js';

/*
 * Outbound webhooks (B-302). A tenant subscribes an endpoint to event types: audit actions (every append to the
 * tenant's chain, by action name), job states (`job.succeeded`, `job.failed`, `job.cancelled`), flags (`flag.created`,
 * `flag.confirmed`…) and approvals (`approval.requested`). Each matching event becomes a delivery row and a
 * `webhook.deliver` job; the job signs the body with HMAC-SHA256 over `<timestamp>.<body>`, posts it through a
 * dispatcher that only dials allowed addresses, and on failure schedules the next attempt with exponential backoff.
 * Consecutive failures open the endpoint's circuit breaker: deliveries then wait for the cool-down, and the first
 * one after it is the trial that closes or reopens it.
 */

export const WEBHOOK_EVENT_GROUPS: { pattern: string; description: string }[] = [
  { pattern: '*', description: 'Every event below' },
  { pattern: 'job.*', description: 'Job states: job.succeeded, job.failed, job.cancelled' },
  { pattern: 'flag.*', description: 'Guardrail flags: created, confirmed, dismissed, escalated, reassigned, breached' },
  { pattern: 'approval.*', description: 'Approvals requested by agent runs and workflows' },
  { pattern: 'workflow.*', description: 'Workflow runs and approvals (audit actions)' },
  { pattern: 'agent.*', description: 'Agent runs and tool-call approvals (audit actions)' },
  { pattern: 'user.*', description: 'Accounts created, synced and disabled (audit actions)' },
  { pattern: 'auth.*', description: 'Sign-ins and second factors (audit actions)' },
  { pattern: 'authz.*', description: 'Authorisation denials (audit actions)' },
  { pattern: 'chat.*', description: 'Chat failures and shares (audit actions)' },
  { pattern: 'conversation.*', description: 'Conversation shares, exports and deletions (audit actions)' },
  { pattern: 'billing.*', description: 'Statements and price books (audit actions)' },
  { pattern: 'webhook.*', description: 'Changes to webhooks themselves (audit actions)' }
];

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

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const hookFromRow = (r: Record<string, unknown>): WebhookRow => ({ ...(r as unknown as WebhookRow), ordered: !!r.ordered, signing: r.signing === 'ed25519' ? 'ed25519' : 'hmac', events: json<string[]>(r.events, []), failures: Number(r.failures ?? 0), opened_at: num(r.opened_at), last_delivery_at: num(r.last_delivery_at), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });
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

export class WebhookService {
  private readonly operatorAllow: AllowList;
  /** Active subscriptions per tenant, for a few seconds, so an audit append does not always query the table. */
  private readonly cache = new Map<string, { at: number; hooks: WebhookRow[] }>();
  private readonly offs: (() => void)[] = [];
  /** Emits per tenant, one after another, so deliveries are queued in the order events happened on this instance. */
  private readonly lanes = new Map<string, Promise<unknown>>();

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
    await this.emit(e.tenant_id, e.action, e.label, `audit:${e.id}`, {
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
    if (w.ordered) {
      // The next position in the webhook's order (queued one at a time through the tenant's lane).
      const max = (await s.db('webhook_deliveries').where({ webhook_id: w.id }).max({ m: 'seq' }).first()) as { m: number | string | null } | undefined;
      row.seq = Number(max?.m ?? 0) + 1;
    }
    try {
      await s.db('webhook_deliveries').insert(row);
    } catch (err) {
      // Another instance (or an earlier call) already queued this event for this subscription.
      if (isUniqueViolation(err)) return null;
      throw err;
    }
    // An ordered webhook sends only its head: later deliveries wait for their turn (next_attempt_at null).
    if (w.ordered) {
      await s.db('webhook_deliveries').where({ id: row.id }).update({ next_attempt_at: null });
      await this.kick(w.id, w.tenant_id);
    } else await this.schedule(row, t);
    return row;
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
      const res = await fetch(w.url, {
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'exprsn-ai-webhooks',
          'x-exprsn-event': d.event,
          'x-exprsn-timestamp': String(ts),
          ...signature,
          'x-exprsn-delivery-id': d.id,
          ...(d.seq != null ? { 'x-exprsn-sequence': String(d.seq) } : {})
        },
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
      if (w.ordered) await this.kick(w.id, w.tenant_id);
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
    // An ordered webhook moves on once the head has given up (it keeps its place while it retries).
    else if (w.ordered) await this.kick(w.id, w.tenant_id);
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
    const k = (await this.activeKey(tenantId)) ?? (await this.createKey(tenantId, null)).row;
    const der = Buffer.from(await this.s().keys.open(tenantId, k.private_sealed, `webhook-signing-key:${k.id}`), 'base64');
    const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    return { 'x-exprsn-signature-ed25519': edSign(null, Buffer.from(`${ts}.${body}`), key).toString('base64'), 'x-exprsn-key-id': k.id };
  }

  async activeKey(tenantId: string): Promise<SigningKeyRow | null> {
    return ((await this.s().db('webhook_signing_keys').where({ tenant_id: tenantId, state: 'active' }).orderBy('created_at', 'desc').first()) as SigningKeyRow | undefined) ?? null;
  }

  /** Every published key of a tenant: the active one and the retired ones (kept so late deliveries still verify). */
  async signingKeys(tenantId: string): Promise<SigningKeyRow[]> {
    return (await this.s().db('webhook_signing_keys').where({ tenant_id: tenantId }).orderBy('created_at', 'desc')) as SigningKeyRow[];
  }

  /** A new Ed25519 key pair; the private key is sealed with the tenant key and never leaves the server. */
  async createKey(tenantId: string, by: string | null): Promise<{ row: SigningKeyRow; retired: string | null }> {
    const s = this.s();
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const id = ulid();
    const x = String(publicKey.export({ format: 'jwk' }).x);
    const der = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    const prev = await this.activeKey(tenantId);
    const t = Date.now();
    // Sealed before the transaction: sealing may read the tenant's data key from the database.
    const sealed = await s.keys.seal(tenantId, der, `webhook-signing-key:${id}`);
    await s.db.transaction(async (trx) => {
      await trx('webhook_signing_keys').where({ tenant_id: tenantId, state: 'active' }).update({ state: 'retired', retired_at: t });
      await trx('webhook_signing_keys').insert({ id, tenant_id: tenantId, public_key: x, private_sealed: sealed, state: 'active', created_by: by, created_at: t, retired_at: null });
    });
    return { row: (await s.db('webhook_signing_keys').where({ id }).first()) as SigningKeyRow, retired: prev?.id ?? null };
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

  async create(tenantId: string, by: string, input: { name: string; url: string; events: string[]; maxLabel: Label; ordered?: boolean; signing?: 'hmac' | 'ed25519' }): Promise<{ row: WebhookRow; secret: string }> {
    const s = this.s();
    await this.checkEndpoint(tenantId, input.url);
    const id = ulid();
    const secret = `whsec_${randomToken(32)}`;
    const t = Date.now();
    try {
      await s.db('webhooks').insert({ id, tenant_id: tenantId, name: input.name, url: input.url, events: JSON.stringify(input.events), max_label: input.maxLabel, secret_sealed: await s.keys.seal(tenantId, secret, `webhook:${id}`), state: 'active', ordered: !!input.ordered, signing: input.signing ?? 'hmac', breaker: 'closed', failures: 0, created_by: by, created_at: t, updated_at: t });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`A webhook named ${input.name} already exists.`);
      throw err;
    }
    this.forget(tenantId);
    return { row: await this.get(tenantId, id), secret };
  }

  async update(tenantId: string, id: string, patch: { name?: string; url?: string; events?: string[]; maxLabel?: Label; state?: 'active' | 'disabled'; ordered?: boolean; signing?: 'hmac' | 'ed25519' }): Promise<{ before: WebhookRow; after: WebhookRow }> {
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

  /** A `webhook.ping` delivery to one subscription, whatever its event list. */
  async ping(tenantId: string, webhookId: string, by: string): Promise<DeliveryRow> {
    const w = await this.get(tenantId, webhookId);
    const row = await this.queue(w, 'webhook.ping', 'public', `ping:${ulid()}`, { webhook: w.id, name: w.name, by }, null);
    return row!;
  }
}
