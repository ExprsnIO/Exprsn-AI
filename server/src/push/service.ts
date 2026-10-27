import { ulid } from 'ulid';
import { actorFrom, type AuditActor } from '../audit/chain.js';
import { clears, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { platformTenant } from '../ops/common.js';
import { ServiceUrlRefused, servicePolicy } from '../platform/egress.js';
import type { NotificationRow, NotifyInput } from '../platform/notifications.js';
import type { Scheduler } from '../platform/jobs.js';
import type { Services } from '../services.js';
import { SYS_SCOPE } from '../vault/policy.js';
import { H2Pool } from './h2-pool.js';
import { ApnsTokens, OAuthTokens, type Clock } from './jwt.js';
import { appIdOf, configProblems, configRefs, parseConfig, PLATFORM_REF_PREFIX, PUSH_SERVICE, pushAddressProblem, type Priority, type ProviderConfig, type ProviderRow, type PushKind, type PushMessage, type PushScope, type SendResult, type WebPushConfig, type WebSocketConfig } from './model.js';
import { ALLOW_ALL, NO_DEVICES, type DeliveryDevice, type NotificationPrefsPort, type PushDevicesPort } from './ports.js';
import { Senders, type SendContext } from './senders.js';
import { generateVapidKeys } from './webpush.js';

/*
 * 1.9.0, Sprint 49 (B-151, B-152, B-154): push providers and delivery (`s.push`).
 *
 * Delivery, for each notification `Notifications.notify` stores (its `pushHook`), only when some provider is enabled
 * for the tenant (its own or a platform default; with none, nothing changes):
 *
 *   1. `push.deliver` (one job per notification): when a Socket.IO provider is enabled, the person's preferences allow
 *      the `websocket` channel and the person is online (presence), the notification goes to their sockets as
 *      `push.notification` and a `push.fallback` job waits `ackTimeoutMs` (default 5 s). A client's acknowledgement
 *      marks it sent and nothing is pushed. Otherwise, or without an acknowledgement in time, the `push` channel is
 *      asked (preferences: now, digest or suppressed) and one `push.send` job is queued per active device.
 *   2. `push.send` (one job per notification and device): the device's provider is the tenant's enabled one of its
 *      kind and app id, else the platform's; the sender answers sent, retry, gone or failed. A retry is a new job at
 *      Retry-After or an exponential backoff (at most `MAX_ATTEMPTS`, never past the message's time to live); gone
 *      calls `pushDevices.markGone`.
 *
 * The delivery log (`push_deliveries`) keeps per attempt the channel, provider, outcome, status, reason and latency:
 * never the token, a credential or the notification's text. The sweep keeps 30 days.
 *
 * Content follows labels (Backlog A): a provider sends a notification's title and body only when its label is within
 * the provider's `contentLabel` (`public` by default, at most `internal`); otherwise a neutral title, and the app
 * fetches the rest after sign-in. The console's own socket carries the full notification, as the in-app bell does.
 */

export const PUSH_LOG_DAYS = 30;
export const MAX_ATTEMPTS = 5;
export const DEFAULT_TTL_SECONDS = 86_400;
export const SOCKET_TOPIC = 'push.socket';
export const ACK_TOPIC = 'push.ack';
const PROVIDER_TOPIC = 'push.provider.changed';
const CRED_TTL_MS = 5 * 60_000;

export interface PushOverrides {
  clock?: Clock;
  /** Tests: fake APNs, FCM and Google token origins, and their certificate authority. */
  endpoints?: { apns?: string; apnsSandbox?: string; fcm?: string; googleToken?: string };
  ca?: string;
  idleMs?: number;
  /** Backoff base for retries without Retry-After (default 2 s). */
  backoffMs?: number;
}

export interface SocketPush {
  deliveryId: string;
  tenantId: string;
  userId: string;
  notification: { id: string; kind: string; title: string; body: string | null; route: string | null; label: Label; createdAt: number };
}

type Outcome = 'sent' | 'failed' | 'dropped' | 'suppressed' | 'retrying' | 'waiting';

export interface DeliveryFilters {
  providerId?: string;
  outcome?: Outcome;
  channel?: 'push' | 'websocket';
  userId?: string;
  since?: number;
  before?: number;
  limit?: number;
}

export interface MessageOptions {
  collapseId?: string | null;
  ttlSeconds?: number;
  priority?: Priority;
}

interface Ctx {
  ip?: string | null;
  traceId?: string | null;
}

const bool = (v: unknown): boolean => v === true || v === 1 || v === '1';
const num = (v: unknown): number | null => (v == null ? null : Number(v));

export function providerView(r: ProviderRow) {
  const config = JSON.parse(r.config) as Record<string, unknown>;
  return {
    id: r.id,
    scope: r.scope,
    kind: r.kind,
    name: r.name,
    appId: r.app_id,
    enabled: bool(r.enabled),
    // References are shown as saved (they name a vault path, not a value); no secret is ever stored here.
    config,
    lastCheck: r.last_check_at ? { at: Number(r.last_check_at), ok: bool(r.last_check_ok), detail: r.last_check_detail } : null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at)
  };
}

const deliveryView = (r: Record<string, unknown>) => ({
  id: r.id as string,
  tenantId: r.tenant_id as string,
  userId: r.user_id as string,
  notificationId: (r.notification_id as string | null) ?? null,
  deviceId: (r.device_id as string | null) ?? null,
  providerId: (r.provider_id as string | null) ?? null,
  providerKind: (r.provider_kind as string | null) ?? null,
  channel: r.channel as string,
  kind: r.kind as string,
  outcome: r.outcome as Outcome,
  status: num(r.status),
  reason: (r.reason as string | null) ?? null,
  latencyMs: num(r.latency_ms),
  attempt: Number(r.attempt ?? 1),
  test: bool(r.test),
  createdAt: Number(r.created_at)
});

export class PushService {
  readonly pool: H2Pool;
  readonly apnsTokens: ApnsTokens;
  readonly oauth: OAuthTokens;
  readonly senders: Senders;
  private readonly clock: Clock;
  private readonly creds = new Map<string, { at: number; stamp: number; values: Map<string, string> }>();
  /** Every finished send (ops-metrics.ts turns it into counters and a latency histogram). */
  onSend: ((e: { kind: PushKind; providerId: string; outcome: Outcome; latencyMs: number }) => void) | null = null;
  private offs: (() => void)[] = [];

  constructor(
    private readonly s: () => Services,
    private readonly o: PushOverrides = {}
  ) {
    this.clock = o.clock ?? Date.now;
    this.pool = new H2Pool({ idleMs: o.idleMs ?? 60_000, connectTimeoutMs: 10_000 });
    this.apnsTokens = new ApnsTokens(this.clock);
    this.oauth = new OAuthTokens(this.clock);
    this.senders = new Senders({ pool: this.pool, clock: this.clock, apnsTokens: this.apnsTokens, oauth: this.oauth, endpoints: o.endpoints ?? {}, ...(o.ca ? { ca: o.ca } : {}), timeoutMs: 10_000, maxResponseBytes: 64 * 1024 });
  }

  /** B-150's devices and B-153's preferences when they exist, else the stand-ins (ports.ts). */
  get devices(): PushDevicesPort {
    return (this.s() as unknown as { pushDevices?: PushDevicesPort }).pushDevices ?? NO_DEVICES;
  }

  get prefs(): NotificationPrefsPort {
    return (this.s() as unknown as { notificationPrefs?: NotificationPrefsPort }).notificationPrefs ?? ALLOW_ALL;
  }

  // ---------------- providers ----------------

  private where(scope: PushScope, tenantId: string | null) {
    return scope === 'platform' ? { scope: 'platform' } : { scope: 'tenant', tenant_id: tenantId };
  }

  async list(scope: PushScope, tenantId: string | null) {
    const rows = (await this.s().db('push_providers').where(this.where(scope, tenantId)).orderBy('kind').orderBy('name')) as ProviderRow[];
    return rows.map(providerView);
  }

  private async row(scope: PushScope, tenantId: string | null, id: string): Promise<ProviderRow> {
    const r = (await this.s().db('push_providers').where({ id, ...this.where(scope, tenantId) }).first()) as ProviderRow | undefined;
    if (!r) throw notFound('Push provider');
    return r;
  }

  async get(scope: PushScope, tenantId: string | null, id: string) {
    return providerView(await this.row(scope, tenantId, id));
  }

  private async auditTenant(scope: PushScope, p: Principal): Promise<string> {
    return scope === 'platform' ? ((await platformTenant(this.s())) ?? p.tenantId) : p.tenantId;
  }

  private async audit(p: Principal | null, scope: PushScope, tenantId: string, action: string, target: Record<string, unknown>, detail: Record<string, unknown>, ctx: Ctx, actor?: AuditActor) {
    await this.s().audit.append({ tenantId, action, kind: 'admin', actor: actor ?? actorFrom(p, ctx.ip ?? null), target: { ...target, scope }, label: 'internal', detail, traceId: ctx.traceId ?? null });
  }

  /**
   * Validates a config: its schema, literals and placeholders, and its references: a tenant admin must be able to read
   * each now (secrets:read and the path policy); a platform provider's references sit under `push/` in the platform
   * scope, which the `push` service is granted to read.
   */
  private async validated(p: Principal, scope: PushScope, kind: PushKind, raw: unknown, ctx: Ctx): Promise<ProviderConfig> {
    let config: ProviderConfig;
    try {
      config = parseConfig(kind, raw);
    } catch (err) {
      throw badRequest(`The ${kind} settings are not valid: ${(err as Error).message}`);
    }
    const problems = configProblems(kind, config, scope);
    if (problems.length) throw badRequest(problems.join(' '), { problems });
    const refs = configRefs(config as Record<string, unknown>);
    if (scope === 'tenant') await this.s().vault.assertRefsReadable(p, refs, ctx);
    else if (refs.length) await this.ensurePlatformGrant(p, ctx);
    return config;
  }

  /** The platform scope's grant that lets the `push` service read `sys/kv/push`, made once (audited by the vault). */
  private async ensurePlatformGrant(p: Principal, ctx: Ctx): Promise<void> {
    const grants = await this.s().vault.listGrants(SYS_SCOPE);
    const path = `sys/kv/${PLATFORM_REF_PREFIX.replace(/\/$/, '')}`;
    if ((grants as { subjectKind: string; subject: string; path: string; effect: string }[]).some((g) => g.subjectKind === 'service' && g.subject === PUSH_SERVICE && g.path === path && g.effect === 'allow')) return;
    await this.s().vault.createGrant(this.s().vault.rootCaller(p, ctx), { subjectKind: 'service', subject: PUSH_SERVICE, path, capabilities: ['read'], effect: 'allow', description: 'Platform push providers read their credentials here (B-151).' });
    await this.s().sysKeys.policiesChanged().catch(() => undefined);
  }

  async create(p: Principal, scope: PushScope, input: { kind: PushKind; name: string; enabled?: boolean; config: unknown }, ctx: Ctx = {}) {
    const config = await this.validated(p, scope, input.kind, input.config, ctx);
    const tenantId = scope === 'tenant' ? p.tenantId : null;
    const dup = await this.s().db('push_providers').where({ ...this.where(scope, tenantId), name: input.name }).first('id');
    if (dup) throw conflict(`A push provider named ${input.name} exists already.`);
    const now = Date.now();
    const row: ProviderRow = { id: ulid(), scope, tenant_id: tenantId, kind: input.kind, name: input.name, app_id: appIdOf(input.kind, config), enabled: input.enabled ?? true, config: JSON.stringify(config), owner_id: p.userId, last_check_at: null, last_check_ok: null, last_check_detail: null, created_by: p.userId, created_at: now, updated_at: now };
    await this.s().db('push_providers').insert(row);
    this.changed(row.id);
    await this.audit(p, scope, await this.auditTenant(scope, p), 'push.provider.created', { pushProvider: row.id, name: row.name }, { kind: row.kind, enabled: bool(row.enabled), appId: row.app_id, refs: configRefs(config as Record<string, unknown>).length }, ctx);
    return providerView(row);
  }

  async update(p: Principal, scope: PushScope, id: string, patch: { name?: string; enabled?: boolean; config?: unknown }, ctx: Ctx = {}) {
    const r = await this.row(scope, scope === 'tenant' ? p.tenantId : null, id);
    const config = patch.config !== undefined ? await this.validated(p, scope, r.kind, patch.config, ctx) : (JSON.parse(r.config) as ProviderConfig);
    if (patch.name && patch.name !== r.name && (await this.s().db('push_providers').where({ ...this.where(scope, r.tenant_id), name: patch.name }).whereNot({ id }).first('id'))) throw conflict(`A push provider named ${patch.name} exists already.`);
    const next = { name: patch.name ?? r.name, enabled: patch.enabled ?? bool(r.enabled), config: JSON.stringify(config), app_id: appIdOf(r.kind, config), updated_at: Date.now(), ...(patch.config !== undefined ? { owner_id: p.userId, last_check_at: null, last_check_ok: null, last_check_detail: null } : {}) };
    await this.s().db('push_providers').where({ id }).update(next);
    this.changed(id);
    await this.audit(p, scope, await this.auditTenant(scope, p), 'push.provider.updated', { pushProvider: id, name: next.name }, { kind: r.kind, changed: Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined), enabled: next.enabled }, ctx);
    return this.get(scope, r.tenant_id, id);
  }

  async remove(p: Principal, scope: PushScope, id: string, ctx: Ctx = {}) {
    const r = await this.row(scope, scope === 'tenant' ? p.tenantId : null, id);
    await this.s().db('push_providers').where({ id }).delete();
    this.changed(id);
    await this.audit(p, scope, await this.auditTenant(scope, p), 'push.provider.deleted', { pushProvider: id, name: r.name }, { kind: r.kind }, ctx);
  }

  /** A provider changed on some instance: its cached credentials and sessions go everywhere. */
  private changed(id: string): void {
    this.forget(id);
    this.s().bus.publish(PROVIDER_TOPIC, { id });
  }

  private forget(id: string): void {
    this.enabledCache.clear();
    this.creds.delete(id);
    void this.pool.close(id);
  }

  /** The egress check for one provider: its kind's hosts, then the tenant's or the operator's allowed hosts. */
  private async checkFor(r: ProviderRow, tenantId: string | null): Promise<(a: string, h: string) => string | null> {
    const policy = servicePolicy(this.s().cfg);
    const allowed = r.scope === 'tenant' && tenantId ? await this.s().integrations.allowList(tenantId) : policy.allow.empty ? null : policy.allow;
    return (a, h) => pushAddressProblem(a, h, r.kind, policy, allowed);
  }

  /** Reads one of a provider's references: as its saving admin (tenant) or as the `push` service (platform). Cached briefly. */
  private secretReader(r: ProviderRow): (ref: string) => Promise<string> {
    return async (ref) => {
      const stamp = Number(r.updated_at);
      let c = this.creds.get(r.id);
      if (!c || c.stamp !== stamp || this.clock() - c.at > CRED_TTL_MS || Date.now() - c.at > CRED_TTL_MS) this.creds.set(r.id, (c = { at: Date.now(), stamp, values: new Map() }));
      const hit = c.values.get(ref);
      if (hit !== undefined) return hit;
      const via = `push:${r.id}`;
      const v = r.scope === 'platform' ? await this.s().vault.readValue({ ...this.s().vault.serviceCaller(PUSH_SERVICE), actor: { service: PUSH_SERVICE, via } }, ref) : await this.s().vault.resolveFor(r.tenant_id!, r.owner_id, ref, { via });
      c.values.set(ref, v);
      return v;
    };
  }

  private async sendContext(r: ProviderRow, tenantId: string | null): Promise<SendContext> {
    return { providerId: r.id, check: await this.checkFor(r, tenantId), secret: this.secretReader(r) };
  }

  /** Validates credentials without sending a notification. Audited `push.provider.checked`. */
  async check(p: Principal, scope: PushScope, id: string, ctx: Ctx = {}) {
    const r = await this.row(scope, scope === 'tenant' ? p.tenantId : null, id);
    this.creds.delete(r.id);
    const config = JSON.parse(r.config) as ProviderConfig;
    const sc = await this.sendContext(r, scope === 'tenant' ? p.tenantId : null);
    let ok = true;
    let detail: string;
    try {
      detail = await this.checkWith(r.kind, sc, config);
    } catch (err) {
      ok = false;
      detail = err instanceof HttpProblem ? err.detail ?? err.message : (err as Error).message;
    }
    detail = detail.slice(0, 500);
    const at = Date.now();
    await this.s().db('push_providers').where({ id }).update({ last_check_at: at, last_check_ok: ok, last_check_detail: detail });
    await this.audit(p, scope, await this.auditTenant(scope, p), 'push.provider.checked', { pushProvider: id, name: r.name }, { kind: r.kind, ok }, ctx);
    return { ok, detail, at };
  }

  private async checkWith(kind: PushKind, sc: SendContext, config: ProviderConfig): Promise<string> {
    switch (kind) {
      case 'apns':
        return this.senders.checkApns(sc, config as Parameters<Senders['checkApns']>[1]);
      case 'fcm':
        return this.senders.checkFcm(sc, config as Parameters<Senders['checkFcm']>[1]);
      case 'webpush':
        return this.senders.checkWebpush(sc, config as WebPushConfig);
      case 'http': {
        const c = config as Extract<ProviderConfig, { body: string; method: string }>;
        return this.senders.checkEndpoint(sc, c.url, c.auth, c.headers);
      }
      case 'websocket': {
        const w = config as WebSocketConfig;
        if (w.mode === 'socketio') return `Delivered over the console's own socket; push waits ${w.ackTimeoutMs} ms for an acknowledgement.`;
        return this.senders.checkEndpoint(sc, w.url, w.auth, w.headers);
      }
    }
  }

  /**
   * A new VAPID key pair: the private key is written to the vault at `path` (as the caller, or in the platform scope
   * as root for a platform provider) and never returned; the answer is the public key and the reference to save.
   */
  async generateVapid(p: Principal, scope: PushScope, path: string, ctx: Ctx = {}) {
    const keys = generateVapidKeys();
    const clean = path.replace(/^vault:/, '').replace(/#.*$/, '').replace(/^\/+|\/+$/g, '');
    if (scope === 'platform' && !clean.startsWith(PLATFORM_REF_PREFIX)) throw badRequest(`A platform key goes under ${PLATFORM_REF_PREFIX} in the platform scope (for example push/vapid).`);
    const caller = scope === 'platform' ? this.s().vault.rootCaller(p, ctx) : await this.s().vault.callerFor(p, ctx);
    await this.s().vault.write(caller, clean, { private_key: keys.privatePem }, scope === 'platform' ? { label: 'restricted' } : {});
    if (scope === 'platform') await this.ensurePlatformGrant(p, ctx);
    return { publicKey: keys.publicKey, privateKeyRef: `vault:${clean}#private_key` };
  }

  /**
   * Stores credentials for a provider (an APNs .p8 key, a service account JSON, a vendor's key) and answers the
   * references to put in its config. A tenant's go through the tenant's vault as the caller (their path policy
   * decides); a platform provider's into the platform scope under `push/`. Values are never returned or logged.
   */
  async storeSecret(p: Principal, scope: PushScope, path: string, data: Record<string, string>, ctx: Ctx = {}) {
    const clean = path.replace(/^vault:/, '').replace(/#.*$/, '').replace(/^\/+|\/+$/g, '');
    if (scope === 'platform' && !clean.startsWith(PLATFORM_REF_PREFIX)) throw badRequest(`A platform credential goes under ${PLATFORM_REF_PREFIX} in the platform scope (for example push/apns).`);
    const caller = scope === 'platform' ? this.s().vault.rootCaller(p, ctx) : await this.s().vault.callerFor(p, ctx);
    const r = await this.s().vault.write(caller, clean, data, scope === 'platform' ? { label: 'restricted' } : {});
    if (scope === 'platform') await this.ensurePlatformGrant(p, ctx);
    return { path: clean, version: (r as { version?: number }).version ?? null, refs: Object.fromEntries(Object.keys(data).map((k) => [k, `vault:${clean}#${k}`])) };
  }

  /** The VAPID public key a browser subscribes with: the tenant's Web Push provider, else the platform's. */
  async webConfig(tenantId: string): Promise<{ publicKey: string; providerId: string } | null> {
    const r = await this.providerFor(tenantId, 'webpush', null);
    return r ? { publicKey: (JSON.parse(r.config) as WebPushConfig).publicKey, providerId: r.id } : null;
  }

  /** The provider for a device: the tenant's enabled one of the kind (and app id) first, then the platform's. */
  async providerFor(tenantId: string, kind: PushKind, appId: string | null): Promise<ProviderRow | null> {
    const rows = (await this.s()
      .db('push_providers')
      .where({ kind, enabled: true })
      .andWhere((q) => q.where({ scope: 'tenant', tenant_id: tenantId }).orWhere({ scope: 'platform' }))
      .orderBy('created_at')) as ProviderRow[];
    const pick = (scope: PushScope) => {
      const mine = rows.filter((r) => r.scope === scope && (kind !== 'websocket' || (JSON.parse(r.config) as WebSocketConfig).mode === 'external'));
      return mine.find((r) => appId != null && r.app_id === appId) ?? mine.find((r) => r.app_id == null) ?? (appId == null ? mine[0] : undefined) ?? null;
    };
    return pick('tenant') ?? pick('platform');
  }

  /** The enabled Socket.IO provider for the tenant (its own, else the platform's), if any. */
  private async socketProvider(tenantId: string): Promise<{ row: ProviderRow; ackMs: number } | null> {
    const rows = (await this.s().db('push_providers').where({ kind: 'websocket', enabled: true }).andWhere((q) => q.where({ scope: 'tenant', tenant_id: tenantId }).orWhere({ scope: 'platform' }))) as ProviderRow[];
    const sock = (scope: PushScope) => rows.find((r) => r.scope === scope && (JSON.parse(r.config) as WebSocketConfig).mode === 'socketio');
    const r = sock('tenant') ?? sock('platform');
    return r ? { row: r, ackMs: (JSON.parse(r.config) as Extract<WebSocketConfig, { mode: 'socketio' }>).ackTimeoutMs } : null;
  }

  private readonly enabledCache = new Map<string, { at: number; v: boolean }>();

  /** Whether any provider serves the tenant; remembered for 10 s (a provider change on any instance forgets it). */
  private async anyEnabled(tenantId: string): Promise<boolean> {
    const hit = this.enabledCache.get(tenantId);
    if (hit && Date.now() - hit.at < 10_000) return hit.v;
    const v = await this.anyEnabledNow(tenantId);
    this.enabledCache.set(tenantId, { at: Date.now(), v });
    return v;
  }

  private async anyEnabledNow(tenantId: string): Promise<boolean> {
    return !!(await this.s().db('push_providers').where({ enabled: true }).andWhere((q) => q.where({ scope: 'tenant', tenant_id: tenantId }).orWhere({ scope: 'platform' })).first('id'));
  }

  // ---------------- delivery ----------------

  /** `Notifications.pushHook`: queues one `push.deliver` job per stored notification. Nothing when no provider is enabled. */
  async enqueue(rows: NotificationRow[], input: NotifyInput & { urgent?: boolean; push?: MessageOptions }): Promise<void> {
    if (!rows.length || !(await this.anyEnabled(input.tenantId))) return;
    const opts = { urgent: !!input.urgent, collapseId: input.push?.collapseId ?? null, ttlSeconds: input.push?.ttlSeconds ?? DEFAULT_TTL_SECONDS, priority: input.push?.priority ?? (input.urgent ? 'high' : 'normal') };
    for (const r of rows) await this.s().jobs.enqueue({ tenantId: r.tenant_id, type: 'push.deliver', payload: { notificationId: r.id, ...opts }, dedupeKey: `push.deliver:${r.id}`, maxAttempts: 3 });
  }

  private async notification(tenantId: string, id: string): Promise<NotificationRow | null> {
    return ((await this.s().db('notifications').where({ id, tenant_id: tenantId }).first()) as NotificationRow | undefined) ?? null;
  }

  private async log(row: { tenantId: string; userId: string; notificationId: string | null; deviceId?: string | null; provider?: ProviderRow | null; providerKind?: string | null; channel: 'push' | 'websocket'; kind: string; outcome: Outcome; status?: number | null; reason?: string | null; latencyMs?: number | null; attempt?: number; test?: boolean }): Promise<string> {
    const id = ulid();
    const now = Date.now();
    await this.s().db('push_deliveries').insert({ id, tenant_id: row.tenantId, user_id: row.userId, notification_id: row.notificationId, device_id: row.deviceId ?? null, provider_id: row.provider?.id ?? null, provider_kind: row.provider?.kind ?? row.providerKind ?? null, provider_scope: row.provider?.scope ?? null, channel: row.channel, kind: row.kind.slice(0, 100), outcome: row.outcome, status: row.status ?? null, reason: row.reason?.slice(0, 200) ?? null, latency_ms: row.latencyMs ?? null, attempt: row.attempt ?? 1, test: !!row.test, created_at: now, updated_at: now });
    if (row.provider && row.outcome !== 'waiting' && row.outcome !== 'suppressed') this.onSend?.({ kind: row.provider.kind, providerId: row.provider.id, outcome: row.outcome, latencyMs: row.latencyMs ?? 0 });
    return id;
  }

  private async online(tenantId: string, userId: string): Promise<boolean> {
    try {
      return (await this.s().presence.effective(tenantId, [userId])).get(userId) !== 'offline';
    } catch {
      return false;
    }
  }

  private socketPayload(n: NotificationRow, deliveryId: string): SocketPush {
    return { deliveryId, tenantId: n.tenant_id, userId: n.user_id, notification: { id: n.id, kind: n.kind, title: n.title, body: n.body, route: n.route, label: n.label, createdAt: Number(n.created_at) } };
  }

  /** Step 1 of a delivery (the `push.deliver` job). */
  async deliver(tenantId: string, p: { notificationId: string; urgent?: boolean; collapseId?: string | null; ttlSeconds?: number; priority?: Priority }): Promise<{ via: 'websocket' | 'push' | 'none'; devices?: number }> {
    const n = await this.notification(tenantId, p.notificationId);
    if (!n) return { via: 'none' };
    const urgent = !!p.urgent;
    const sock = await this.socketProvider(tenantId);
    if (sock) {
      const d = await this.prefs.decide(tenantId, n.user_id, n.kind, 'websocket', { urgent });
      if (d.deliver !== 'now') await this.log({ tenantId, userId: n.user_id, notificationId: n.id, provider: sock.row, channel: 'websocket', kind: n.kind, outcome: 'suppressed', reason: `${d.deliver}: ${d.reason}` });
      else if (await this.online(tenantId, n.user_id)) {
        const deliveryId = await this.log({ tenantId, userId: n.user_id, notificationId: n.id, provider: sock.row, channel: 'websocket', kind: n.kind, outcome: 'waiting' });
        this.s().bus.publish(SOCKET_TOPIC, this.socketPayload(n, deliveryId));
        await this.s().jobs.enqueue({ tenantId, type: 'push.fallback', payload: { deliveryId, ...p }, runAt: Date.now() + sock.ackMs, dedupeKey: `push.fallback:${deliveryId}`, maxAttempts: 3 });
        return { via: 'websocket' };
      }
    }
    return { via: 'push', devices: await this.fanOut(n, p) };
  }

  /** A client acknowledged a socket delivery (from realtime/push.ts, on any instance through the bus). */
  async acknowledged(deliveryId: string, userId: string): Promise<boolean> {
    const r = (await this.s().db('push_deliveries').where({ id: deliveryId, user_id: userId, outcome: 'waiting' }).first()) as Record<string, unknown> | undefined;
    if (!r) return false;
    const latency = Date.now() - Number(r.created_at);
    const n = await this.s().db('push_deliveries').where({ id: deliveryId, outcome: 'waiting' }).update({ outcome: 'sent', reason: 'acknowledged', latency_ms: latency, updated_at: Date.now() });
    if (n && r.provider_id) this.onSend?.({ kind: 'websocket', providerId: String(r.provider_id), outcome: 'sent', latencyMs: latency });
    return n > 0;
  }

  /** The `push.fallback` job: no acknowledgement in time means the push channel. */
  async fallback(tenantId: string, p: { deliveryId: string; notificationId: string; urgent?: boolean; collapseId?: string | null; ttlSeconds?: number; priority?: Priority }): Promise<{ pushed: boolean; devices?: number }> {
    const n = await this.s().db('push_deliveries').where({ id: p.deliveryId, tenant_id: tenantId, outcome: 'waiting' }).update({ outcome: 'failed', reason: 'not acknowledged in time', updated_at: Date.now() });
    if (!n) return { pushed: false };
    const row = (await this.s().db('push_deliveries').where({ id: p.deliveryId }).first('provider_id', 'created_at')) as { provider_id: string | null; created_at: number };
    if (row.provider_id) this.onSend?.({ kind: 'websocket', providerId: row.provider_id, outcome: 'failed', latencyMs: Date.now() - Number(row.created_at) });
    const note = await this.notification(tenantId, p.notificationId);
    if (!note) return { pushed: false };
    return { pushed: true, devices: await this.fanOut(note, p) };
  }

  /** Asks the push channel's preference and queues one `push.send` per device. */
  private async fanOut(n: NotificationRow, p: { urgent?: boolean; collapseId?: string | null; ttlSeconds?: number; priority?: Priority }): Promise<number> {
    const d = await this.prefs.decide(n.tenant_id, n.user_id, n.kind, 'push', { urgent: !!p.urgent });
    if (d.deliver !== 'now') {
      // A digest keeps the item for the person's summary (B-153), when the preferences service collects them.
      const collect = (this.prefs as { collect?: (item: Record<string, unknown>, d: unknown) => Promise<unknown> }).collect;
      if (d.deliver === 'digest' && collect) await collect.call(this.prefs, { tenantId: n.tenant_id, userId: n.user_id, kind: n.kind, channel: 'push', title: n.title, route: n.route, label: n.label }, d).catch((err: unknown) => this.s().log.warn({ err }, 'push digest item not kept'));
      await this.log({ tenantId: n.tenant_id, userId: n.user_id, notificationId: n.id, channel: 'push', kind: n.kind, outcome: 'suppressed', reason: `${d.deliver}: ${d.reason}` });
      return 0;
    }
    const devices = (await this.devices.forDelivery(n.tenant_id, n.user_id)).filter((x) => !(x.provider === 'websocket' && !x.token));
    for (const dev of devices) {
      await this.s().jobs.enqueue({ tenantId: n.tenant_id, type: 'push.send', payload: { notificationId: n.id, deviceId: dev.id, attempt: 1, collapseId: p.collapseId ?? null, ttlSeconds: p.ttlSeconds ?? DEFAULT_TTL_SECONDS, priority: p.priority ?? 'normal' }, dedupeKey: `push.send:${n.id}:${dev.id}:1`, maxAttempts: 1 });
    }
    return devices.length;
  }

  private async contentFor(r: ProviderRow, n: { tenant_id: string; title: string; body: string | null; label: Label }): Promise<{ title: string; body: string | null }> {
    const bar = ((JSON.parse(r.config) as { contentLabel?: Label }).contentLabel ?? 'public') as Label;
    if (clears(bar === 'internal' ? 'internal' : 'public', n.label)) return { title: n.title, body: n.body };
    const tenant = (await this.s().db('tenants').where({ id: n.tenant_id }).first('name')) as { name?: string } | undefined;
    return { title: tenant?.name ? `You have a new notification in ${tenant.name}` : 'You have a new notification', body: 'Sign in to read it.' };
  }

  private message(n: { kind: string; route: string | null }, content: { title: string; body: string | null }, o: { collapseId?: string | null; ttlSeconds?: number; priority?: Priority }): PushMessage {
    return { title: content.title, body: content.body, route: n.route, link: this.s().notifications.consoleUrl(n.route), kind: n.kind, data: {}, collapseId: o.collapseId ?? null, ttlSeconds: Math.max(0, Math.min(o.ttlSeconds ?? DEFAULT_TTL_SECONDS, 28 * 86_400)), priority: o.priority ?? 'normal' };
  }

  /** Sends to one device with its provider; logs the attempt. */
  private async sendOne(tenantId: string, userId: string, dev: DeliveryDevice, provider: ProviderRow, m: PushMessage, meta: { notificationId: string | null; attempt: number; test?: boolean }): Promise<SendResult & { latencyMs: number; logId: string }> {
    const t0 = Date.now();
    let r: SendResult;
    try {
      const sc = await this.sendContext(provider, provider.scope === 'tenant' ? tenantId : null);
      const token = dev.token ?? (dev.subscription ? JSON.stringify(dev.subscription) : '');
      r = await this.senders.send(provider.kind, sc, JSON.parse(provider.config), token, m);
    } catch (err) {
      // A credential that does not resolve or parse: a failure the provider's owner must fix, not worth retrying.
      r = { outcome: 'failed', status: null, reason: (err instanceof ServiceUrlRefused ? 'egress refused' : err instanceof HttpProblem ? `vault: ${err.status}` : 'credentials').slice(0, 80) };
    }
    const latencyMs = Date.now() - t0;
    const outcome: Outcome = r.outcome === 'sent' ? 'sent' : r.outcome === 'gone' ? 'dropped' : r.outcome === 'retry' ? (meta.attempt < MAX_ATTEMPTS && !meta.test ? 'retrying' : 'failed') : 'failed';
    const logId = await this.log({ tenantId, userId, notificationId: meta.notificationId, deviceId: dev.id, provider, channel: 'push', kind: m.kind, outcome, status: r.status, reason: r.reason, latencyMs, attempt: meta.attempt, ...(meta.test ? { test: true } : {}) });
    if (r.outcome === 'gone') await this.devices.markGone(dev.id, `${provider.kind}: ${r.reason ?? 'token gone'}`);
    return { ...r, latencyMs, logId };
  }

  /** The `push.send` job: one notification to one device, retried as a new job when the provider asks. */
  async sendJob(tenantId: string, p: { notificationId: string; deviceId: string; attempt: number; collapseId?: string | null; ttlSeconds?: number; priority?: Priority }): Promise<{ outcome: string; retryAt?: number }> {
    const n = await this.notification(tenantId, p.notificationId);
    if (!n) return { outcome: 'none' };
    const dev = (await this.devices.forDelivery(tenantId, n.user_id)).find((d) => d.id === p.deviceId);
    if (!dev) {
      await this.log({ tenantId, userId: n.user_id, notificationId: n.id, deviceId: p.deviceId, channel: 'push', kind: n.kind, outcome: 'dropped', reason: 'device no longer active', attempt: p.attempt });
      return { outcome: 'dropped' };
    }
    const provider = await this.providerFor(tenantId, dev.provider, dev.appId);
    if (!provider) {
      await this.log({ tenantId, userId: n.user_id, notificationId: n.id, deviceId: dev.id, providerKind: dev.provider, channel: 'push', kind: n.kind, outcome: 'dropped', reason: 'no provider for this device', attempt: p.attempt });
      return { outcome: 'dropped' };
    }
    const ttl = p.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const age = Math.floor((Date.now() - Number(n.created_at)) / 1000);
    if (age > ttl) {
      await this.log({ tenantId, userId: n.user_id, notificationId: n.id, deviceId: dev.id, provider, channel: 'push', kind: n.kind, outcome: 'dropped', reason: 'time to live passed', attempt: p.attempt });
      return { outcome: 'dropped' };
    }
    const m = this.message(n, await this.contentFor(provider, n), { ...p, ttlSeconds: ttl - age });
    const r = await this.sendOne(tenantId, n.user_id, dev, provider, m, { notificationId: n.id, attempt: p.attempt });
    if (r.outcome !== 'retry' || p.attempt >= MAX_ATTEMPTS) return { outcome: r.outcome };
    const base = this.o.backoffMs ?? 2000;
    const delay = r.retryAfterMs ?? Math.min(base * 2 ** (p.attempt - 1), 10 * 60_000) + Math.floor(Math.random() * base);
    const retryAt = Date.now() + delay;
    if ((retryAt - Number(n.created_at)) / 1000 > ttl) return { outcome: 'retry-abandoned' };
    await this.s().jobs.enqueue({ tenantId, type: 'push.send', payload: { ...p, attempt: p.attempt + 1 }, runAt: retryAt, dedupeKey: `push.send:${n.id}:${dev.id}:${p.attempt + 1}`, maxAttempts: 1 });
    return { outcome: 'retry', retryAt };
  }

  // ---------------- test sends (B-154) ----------------

  /**
   * A test notification to the caller's own devices through one provider (console), sent at once and logged with
   * `test`. Audited `push.test.sent`. A Socket.IO provider goes to the caller's open consoles and waits for one to
   * acknowledge.
   */
  async testProvider(p: Principal, scope: PushScope, providerId: string, o: { deviceId?: string } = {}, ctx: Ctx = {}) {
    const r = await this.row(scope, scope === 'tenant' ? p.tenantId : null, providerId);
    let results: { deviceId: string | null; name: string | null; outcome: string; status: number | null; reason: string | null; latencyMs: number }[];
    if (r.kind === 'websocket' && (JSON.parse(r.config) as WebSocketConfig).mode === 'socketio') results = [await this.testSocket(p, r)];
    else {
      const devices = (await this.devices.forDelivery(p.tenantId, p.userId)).filter((d) => d.provider === r.kind && (!o.deviceId || d.id === o.deviceId) && (r.app_id == null || d.appId == null || d.appId === r.app_id));
      if (o.deviceId && !devices.length) throw notFound('Device of yours for this provider');
      results = [];
      for (const d of devices) {
        const res = await this.sendOne(p.tenantId, p.userId, d, r, this.testMessage(), { notificationId: null, attempt: 1, test: true });
        results.push({ deviceId: d.id, name: d.name ?? null, outcome: res.outcome, status: res.status, reason: res.reason, latencyMs: res.latencyMs });
      }
    }
    await this.audit(p, scope, await this.auditTenant(scope, p), 'push.test.sent', { pushProvider: r.id, name: r.name }, { kind: r.kind, devices: results.length, outcomes: results.map((x) => x.outcome) }, ctx);
    return { provider: r.id, results };
  }

  private testMessage(): PushMessage {
    return this.message({ kind: 'push.test', route: 'settings?tab=devices' }, { title: 'Test notification', body: 'Sent from Exprsn-AI to check this device.' }, { ttlSeconds: 300, priority: 'normal' });
  }

  private async testSocket(p: Principal, r: ProviderRow) {
    const ackMs = (JSON.parse(r.config) as Extract<WebSocketConfig, { mode: 'socketio' }>).ackTimeoutMs;
    const at = Date.now();
    const fake: NotificationRow = { id: ulid(), tenant_id: p.tenantId, user_id: p.userId, kind: 'push.test', title: 'Test notification', body: 'Sent from Exprsn-AI over this console.', route: null, label: 'public', created_at: at, read_at: null };
    const deliveryId = await this.log({ tenantId: p.tenantId, userId: p.userId, notificationId: null, provider: r, channel: 'websocket', kind: 'push.test', outcome: 'waiting', test: true });
    this.s().bus.publish(SOCKET_TOPIC, this.socketPayload(fake, deliveryId));
    const until = Date.now() + ackMs;
    while (Date.now() < until) {
      const row = (await this.s().db('push_deliveries').where({ id: deliveryId }).first('outcome', 'latency_ms')) as { outcome: string; latency_ms: number | null };
      if (row.outcome === 'sent') return { deviceId: null, name: 'Open consoles', outcome: 'sent', status: null, reason: 'acknowledged', latencyMs: Number(row.latency_ms ?? 0) };
      await new Promise((res) => setTimeout(res, 100));
    }
    await this.s().db('push_deliveries').where({ id: deliveryId, outcome: 'waiting' }).update({ outcome: 'failed', reason: 'not acknowledged in time', updated_at: Date.now() });
    return { deviceId: null, name: 'Open consoles', outcome: 'failed', status: null, reason: 'not acknowledged in time', latencyMs: ackMs };
  }

  /** CLI `push:test`: a test notification to a person's devices, each through the provider it would use. */
  async testUser(tenantId: string, userId: string, o: { kind?: PushKind } = {}) {
    const devices = (await this.devices.forDelivery(tenantId, userId)).filter((d) => !o.kind || d.provider === o.kind);
    const results: { deviceId: string; name: string | null; provider: string | null; outcome: string; status: number | null; reason: string | null; latencyMs: number }[] = [];
    for (const d of devices) {
      const r = await this.providerFor(tenantId, d.provider, d.appId);
      if (!r) {
        await this.log({ tenantId, userId, notificationId: null, deviceId: d.id, providerKind: d.provider, channel: 'push', kind: 'push.test', outcome: 'dropped', reason: 'no provider for this device', test: true });
        results.push({ deviceId: d.id, name: d.name ?? null, provider: null, outcome: 'dropped', status: null, reason: 'no provider for this device', latencyMs: 0 });
        continue;
      }
      const res = await this.sendOne(tenantId, userId, d, r, this.testMessage(), { notificationId: null, attempt: 1, test: true });
      results.push({ deviceId: d.id, name: d.name ?? null, provider: r.name, outcome: res.outcome, status: res.status, reason: res.reason, latencyMs: res.latencyMs });
    }
    await this.s().audit.append({ tenantId, action: 'push.test.sent', kind: 'admin', actor: { service: 'cli' }, target: { user: userId, scope: 'cli' }, label: 'internal', detail: { kind: o.kind ?? null, devices: results.length, outcomes: results.map((x) => x.outcome) } });
    return { results };
  }

  // ---------------- the log ----------------

  async deliveries(scope: PushScope, tenantId: string | null, f: DeliveryFilters = {}) {
    const q = this.s().db('push_deliveries').orderBy('created_at', 'desc').orderBy('id', 'desc').limit(Math.min(Math.max(f.limit ?? 100, 1), 500));
    if (scope === 'tenant') q.where({ tenant_id: tenantId });
    else q.where({ provider_scope: 'platform' });
    if (f.providerId) q.where({ provider_id: f.providerId });
    if (f.outcome) q.where({ outcome: f.outcome });
    if (f.channel) q.where({ channel: f.channel });
    if (f.userId) q.where({ user_id: f.userId });
    if (f.since) q.where('created_at', '>=', f.since);
    if (f.before) q.where('created_at', '<', f.before);
    const rows = ((await q) as Record<string, unknown>[]).map(deliveryView);
    const ids = [...new Set(rows.map((r) => r.userId))];
    const users = ids.length ? ((await this.s().db('users').whereIn('id', ids).select('id', 'username', 'display_name')) as { id: string; username: string; display_name: string }[]) : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    return { deliveries: rows.map((r) => ({ ...r, user: byId.get(r.userId) ? { username: byId.get(r.userId)!.username, name: byId.get(r.userId)!.display_name } : null })), keepDays: PUSH_LOG_DAYS };
  }

  /** The 30-day sweep (the `push.deliveries.sweep` job). */
  async sweep(now = Date.now()): Promise<{ removed: number }> {
    const removed = await this.s().db('push_deliveries').where('created_at', '<', now - PUSH_LOG_DAYS * 86_400_000).delete();
    return { removed: Number(removed) };
  }

  // ---------------- wiring ----------------

  registerJobs(): void {
    const j = this.s().jobs;
    j.register('push.deliver', async (p, ctx) => this.deliver(ctx.job.tenant_id, p as Parameters<PushService['deliver']>[1]));
    j.register('push.fallback', async (p, ctx) => this.fallback(ctx.job.tenant_id, p as Parameters<PushService['fallback']>[1]));
    j.register('push.send', async (p, ctx) => this.sendJob(ctx.job.tenant_id, p as Parameters<PushService['sendJob']>[1]), { timeoutMs: 60_000 });
    j.register('push.deliveries.sweep', async () => this.sweep());
  }

  schedule(scheduler: Scheduler): void {
    scheduler.every('push.deliveries.sweep', 60 * 60_000, async () => {
      const t = await platformTenant(this.s());
      return t ? [{ tenantId: t, key: 'platform' }] : [];
    });
  }

  /** Listens for acknowledgements and provider changes from every instance. */
  listen(): void {
    this.offs.push(
      this.s().bus.on<{ deliveryId: string; userId: string }>(ACK_TOPIC, (e) => {
        if (e?.deliveryId && e.userId) void this.acknowledged(e.deliveryId, e.userId).catch((err: unknown) => this.s().log.warn({ err }, 'push acknowledgement not recorded'));
      }),
      this.s().bus.on<{ id: string }>(PROVIDER_TOPIC, (e) => e?.id && this.forget(e.id))
    );
  }

  async close(): Promise<void> {
    for (const off of this.offs) off();
    this.offs = [];
    await this.pool.close();
  }

  /** For routes: refuses a principal acting on a scope it may not (the routes' permissions decide; this is a second check). */
  static assertScope(scope: PushScope, perms: Set<string>): void {
    if (scope === 'platform' && !perms.has('platform:manage')) throw forbidden('Platform push providers need platform:manage.', { step: 'role', action: 'platform:manage' });
    if (scope === 'tenant' && !perms.has('tenant:manage')) throw forbidden('Tenant push providers need tenant:manage.', { step: 'role', action: 'tenant:manage' });
  }
}
