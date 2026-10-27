import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { z } from 'zod';
import { actorFrom, type AuditActor } from '../audit/chain.js';
import type { Principal } from '../authz/policy.js';
import { conflict, notFound } from '../http/problem.js';
import type { Services } from '../services.js';

/*
 * 1.9.0, Sprint 49 (B-150): each person's push devices (migration `115_push_devices`).
 *
 * - A device is an endpoint a person registered: the platform, the provider kind, the app or bundle id, a name, and
 *   the token or Web Push subscription, sealed with the tenant key (associated data `push-device:<id>`). The token is
 *   never returned in an HTTP answer; the console shows a fingerprint (12 hex digits of a digest of the token or the
 *   subscription's endpoint). Registering the same token again (same tenant, provider and app id) updates its row:
 *   the session, the name if given, the sealed value, `last_seen_at`; an ended device becomes active again. Another
 *   person registering a token moves the device to them (a shared or handed-on phone). Only a change is audited, so an
 *   app that registers at every launch does not fill the chain.
 * - Ending: the person or an admin revokes a device; a provider reports a token gone (`markGone`, called by delivery);
 *   the sweep `push.devices.prune` deletes devices not seen for PUSH_DEVICE_IDLE_DAYS (0 turns it off) and removes
 *   ended rows 30 days after they ended. An ended device keeps no token (the sealed value is cleared).
 * - With the person's sessions (`SessionService.devices`, installed in `services.ts`): signing out everywhere else
 *   (and every other `revokeAllForUser`: password change or reset, an admin disabling the account or changing its
 *   access, SCIM or directory deactivation, a moderation sanction) revokes the person's devices except those
 *   registered from the session that is kept; revoking one session revokes the devices registered from it (signing
 *   out of a browser ends its Web Push subscription); disabling or offboarding a tenant revokes all of its devices,
 *   and the offboarding purge deletes the rows. A rotated session takes its devices along.
 * - `forDelivery` hands the delivery job the active devices with their opened tokens. Never put its result in an HTTP
 *   answer or a log line.
 *
 * Audit: `push.device.registered`, `.renamed`, `.revoked`, `.gone`, `.pruned`.
 */

export const PLATFORMS = ['ios', 'android', 'web', 'desktop'] as const;
export type PushPlatform = (typeof PLATFORMS)[number];
/** The provider kinds B-151 builds; a closed list (a new kind is a reviewed change here and in the providers). */
export const PROVIDER_KINDS = ['apns', 'fcm', 'webpush', 'http', 'websocket'] as const;
export type PushProviderKind = (typeof PROVIDER_KINDS)[number];

/** Which platforms a provider kind serves (APNs: Apple devices; Web Push: browsers and desktop shells). */
const PLATFORMS_OF: Record<PushProviderKind, readonly PushPlatform[]> = {
  apns: ['ios', 'desktop'],
  fcm: ['android', 'ios', 'web'],
  webpush: ['web', 'desktop'],
  http: PLATFORMS,
  websocket: PLATFORMS
};

export const MAX_ACTIVE_DEVICES = 50;
const ENDED_KEEP_MS = 30 * 24 * 3_600_000;
const DAY = 24 * 3_600_000;

const b64url = /^[A-Za-z0-9_-]+$/;
const printable = /^[\x21-\x7e]+$/;

const subscriptionSchema = z
  .object({
    endpoint: z.string().max(2048).url(),
    keys: z
      .object({
        p256dh: z.string().regex(b64url, 'base64url').max(100).refine((v) => { const b = Buffer.from(v, 'base64url'); return b.length === 65 && b[0] === 4; }, 'an uncompressed P-256 public key (65 bytes)'),
        auth: z.string().regex(b64url, 'base64url').max(32).refine((v) => Buffer.from(v, 'base64url').length === 16, '16 bytes')
      })
      .strict(),
    expirationTime: z.number().int().nullable().optional()
  })
  .strict();
export type WebPushSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };

export const registerBody = z
  .object({
    platform: z.enum(PLATFORMS),
    provider: z.enum(PROVIDER_KINDS),
    appId: z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9._:/-]+$/, 'letters, digits and . _ : / -').nullable().optional(),
    name: z.string().trim().min(1).max(100).optional(),
    token: z.string().min(8).max(4096).regex(printable, 'printable ASCII without spaces').optional(),
    subscription: subscriptionSchema.optional()
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.provider === 'webpush') {
      if (!b.subscription) ctx.addIssue({ code: 'custom', path: ['subscription'], message: 'Web Push needs the subscription (endpoint and keys)' });
      if (b.token) ctx.addIssue({ code: 'custom', path: ['token'], message: 'Web Push takes a subscription, not a token' });
      if (b.subscription && !b.subscription.endpoint.startsWith('https://')) ctx.addIssue({ code: 'custom', path: ['subscription', 'endpoint'], message: 'an https endpoint' });
    } else {
      if (!b.token) ctx.addIssue({ code: 'custom', path: ['token'], message: 'the device token' });
      if (b.subscription) ctx.addIssue({ code: 'custom', path: ['subscription'], message: 'only Web Push takes a subscription' });
    }
    if (!PLATFORMS_OF[b.provider].includes(b.platform)) ctx.addIssue({ code: 'custom', path: ['platform'], message: `${b.provider} does not serve ${b.platform} (${PLATFORMS_OF[b.provider].join(', ')})` });
  });
export type RegisterInput = z.infer<typeof registerBody>;

export const renameBody = z.object({ name: z.string().trim().min(1).max(100) }).strict();

interface DeviceRow {
  id: string;
  tenant_id: string;
  user_id: string;
  session_id: string | null;
  platform: PushPlatform;
  provider: PushProviderKind;
  app_id: string | null;
  name: string;
  token_digest: string;
  token_sealed: string | null;
  fingerprint: string;
  state: 'active' | 'revoked' | 'gone';
  state_reason: string | null;
  created_at: number;
  last_seen_at: number;
  updated_at: number;
  ended_at: number | null;
}

/** What the console and the admin routes see: never the token. */
export interface DeviceView {
  id: string;
  platform: PushPlatform;
  provider: PushProviderKind;
  appId: string | null;
  name: string;
  fingerprint: string;
  state: DeviceRow['state'];
  reason: string | null;
  createdAt: number;
  lastSeenAt: number;
  endedAt: number | null;
  /** Registered from the session making the request. */
  current: boolean;
}

/** For the delivery job only (B-152): the opened token, or the Web Push subscription. */
export interface DeliveryDevice {
  id: string;
  tenantId: string;
  userId: string;
  platform: PushPlatform;
  provider: PushProviderKind;
  appId: string | null;
  name: string;
  /** The device token (APNs, FCM, the HTTP vendor's subscriber id, the WebSocket client id); null for Web Push. */
  token: string | null;
  /** The Web Push subscription; null for the other kinds. */
  subscription: WebPushSubscription | null;
  lastSeenAt: number;
}

export interface AuditCtx {
  ip?: string | null;
  traceId?: string | null;
}

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const aad = (id: string) => `push-device:${id}`;
const num = (v: unknown) => (v == null ? null : Number(v));
const fromRow = (r: Record<string, unknown>): DeviceRow => ({
  ...(r as unknown as DeviceRow),
  created_at: Number(r.created_at),
  last_seen_at: Number(r.last_seen_at),
  updated_at: Number(r.updated_at),
  ended_at: num(r.ended_at)
});

const DEFAULT_NAMES: Record<PushPlatform, string> = { ios: 'iPhone or iPad', android: 'Android device', web: 'Web browser', desktop: 'Desktop app' };

/** `ab12:cd34:ef56`: what a person compares with the app's own settings screen. */
export function fingerprintOf(identity: string): string {
  const h = sha256(`push-fingerprint\n${identity}`).slice(0, 12);
  return `${h.slice(0, 4)}:${h.slice(4, 8)}:${h.slice(8, 12)}`;
}

export class PushDevices {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  private view(r: DeviceRow, sessionId: string | null): DeviceView {
    return { id: r.id, platform: r.platform, provider: r.provider, appId: r.app_id, name: r.name, fingerprint: r.fingerprint, state: r.state, reason: r.state_reason, createdAt: r.created_at, lastSeenAt: r.last_seen_at, endedAt: r.ended_at, current: !!sessionId && r.session_id === sessionId };
  }

  private audit(tenantId: string, action: string, actor: AuditActor, target: Record<string, unknown>, detail: Record<string, unknown>, ctx: AuditCtx = {}, kind: 'admin' | 'system' = 'admin') {
    return this.s().audit.append({ tenantId, action, kind, actor, target, label: 'internal', detail, ...(ctx.traceId ? { traceId: ctx.traceId } : {}) });
  }

  /** A person's devices, active first, then those ended in the last 30 days. */
  async list(tenantId: string, userId: string, sessionId: string | null = null): Promise<DeviceView[]> {
    const rows = ((await this.db('push_devices').where({ tenant_id: tenantId, user_id: userId }).orderBy('last_seen_at', 'desc')) as Record<string, unknown>[]).map(fromRow);
    return rows.sort((a, b) => Number(b.state === 'active') - Number(a.state === 'active')).map((r) => this.view(r, sessionId));
  }

  private async own(tenantId: string, userId: string, id: string): Promise<DeviceRow> {
    const r = (await this.db('push_devices').where({ tenant_id: tenantId, user_id: userId, id }).first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('Device');
    return fromRow(r);
  }

  /** Registers a device for the caller, or updates the one with the same token. */
  async register(p: Principal, input: RegisterInput, ctx: AuditCtx = {}): Promise<{ device: DeviceView; created: boolean }> {
    const sub = input.subscription ? { endpoint: input.subscription.endpoint, keys: { p256dh: input.subscription.keys.p256dh, auth: input.subscription.keys.auth } } : null;
    const identity = sub ? sub.endpoint : input.token!;
    const secret = sub ? JSON.stringify(sub) : input.token!;
    const appId = input.appId ?? null;
    const digest = sha256(`${p.tenantId}\n${input.provider}\n${appId ?? ''}\n${identity}`);
    const fingerprint = fingerprintOf(identity);
    const actor = actorFrom(p, ctx.ip ?? null);
    const t = Date.now();

    const update = async (existing: DeviceRow) => {
      const movedFrom = existing.user_id !== p.userId ? existing.user_id : null;
      if (movedFrom || existing.state !== 'active') await this.assertRoom(p.tenantId, p.userId);
      const name = input.name ?? (movedFrom ? DEFAULT_NAMES[input.platform] : existing.name);
      const patch = { user_id: p.userId, session_id: p.sessionId ?? null, platform: input.platform, name, token_sealed: await this.s().keys.seal(p.tenantId, secret, aad(existing.id)), state: 'active', state_reason: null, ended_at: null, last_seen_at: t, updated_at: t };
      await this.db('push_devices').where({ id: existing.id }).update(patch);
      const changed = movedFrom || existing.state !== 'active' || existing.platform !== input.platform || existing.name !== name;
      if (changed) {
        await this.audit(p.tenantId, 'push.device.registered', actor, { user: p.userId, device: existing.id }, { platform: input.platform, provider: input.provider, appId, fingerprint, reregistered: true, ...(existing.state !== 'active' ? { reactivated: existing.state } : {}), ...(movedFrom ? { movedFrom } : {}) }, ctx);
      }
      return { device: this.view({ ...existing, ...patch, state: 'active' } as DeviceRow, p.sessionId), created: false };
    };

    const found = (await this.db('push_devices').where({ tenant_id: p.tenantId, token_digest: digest }).first()) as Record<string, unknown> | undefined;
    if (found) return update(fromRow(found));
    await this.assertRoom(p.tenantId, p.userId);
    const id = ulid();
    const row: DeviceRow = { id, tenant_id: p.tenantId, user_id: p.userId, session_id: p.sessionId ?? null, platform: input.platform, provider: input.provider, app_id: appId, name: input.name ?? DEFAULT_NAMES[input.platform], token_digest: digest, token_sealed: await this.s().keys.seal(p.tenantId, secret, aad(id)), fingerprint, state: 'active', state_reason: null, created_at: t, last_seen_at: t, updated_at: t, ended_at: null };
    try {
      await this.db('push_devices').insert(row);
    } catch (err) {
      // Two registrations of one token at once: the other one won; update its row.
      const again = (await this.db('push_devices').where({ tenant_id: p.tenantId, token_digest: digest }).first()) as Record<string, unknown> | undefined;
      if (!again) throw err;
      return update(fromRow(again));
    }
    await this.audit(p.tenantId, 'push.device.registered', actor, { user: p.userId, device: id }, { platform: input.platform, provider: input.provider, appId, fingerprint, reregistered: false }, ctx);
    return { device: this.view(row, p.sessionId), created: true };
  }

  private async assertRoom(tenantId: string, userId: string): Promise<void> {
    const r = (await this.db('push_devices').where({ tenant_id: tenantId, user_id: userId, state: 'active' }).count({ n: '*' }).first()) as { n: number | string } | undefined;
    if (Number(r?.n ?? 0) >= MAX_ACTIVE_DEVICES) throw conflict(`You have ${MAX_ACTIVE_DEVICES} active devices. Revoke one you no longer use first.`);
  }

  async rename(p: Principal, id: string, name: string, ctx: AuditCtx = {}): Promise<DeviceView> {
    const d = await this.own(p.tenantId, p.userId, id);
    if (d.name === name) return this.view(d, p.sessionId);
    const t = Date.now();
    await this.db('push_devices').where({ id: d.id }).update({ name, updated_at: t });
    await this.audit(p.tenantId, 'push.device.renamed', actorFrom(p, ctx.ip ?? null), { user: p.userId, device: d.id }, { before: d.name, after: name }, ctx);
    return this.view({ ...d, name, updated_at: t }, p.sessionId);
  }

  /** Revokes one of the caller's devices. */
  async revokeOwn(p: Principal, id: string, ctx: AuditCtx = {}): Promise<DeviceView> {
    const d = await this.own(p.tenantId, p.userId, id);
    return this.view(await this.end(d, 'revoked', 'by you', actorFrom(p, ctx.ip ?? null), ctx), p.sessionId);
  }

  /** An admin's view of a person's devices (users:manage, checked by the route; the person is in the admin's tenant). */
  async listFor(admin: Principal, userId: string): Promise<DeviceView[]> {
    if (!(await this.s().users.get(admin.tenantId, userId))) throw notFound('User');
    return this.list(admin.tenantId, userId, null);
  }

  async revokeFor(admin: Principal, userId: string, id: string, ctx: AuditCtx = {}): Promise<DeviceView> {
    if (!(await this.s().users.get(admin.tenantId, userId))) throw notFound('User');
    const d = await this.own(admin.tenantId, userId, id);
    return this.view(await this.end(d, 'revoked', `by an administrator (${admin.username})`, actorFrom(admin, ctx.ip ?? null), ctx), null);
  }

  private async end(d: DeviceRow, state: 'revoked' | 'gone', reason: string, actor: AuditActor, ctx: AuditCtx = {}, kind: 'admin' | 'system' = 'admin'): Promise<DeviceRow> {
    if (d.state !== 'active') return d;
    const t = Date.now();
    const n = await this.db('push_devices').where({ id: d.id, state: 'active' }).update({ state, state_reason: reason.slice(0, 200), token_sealed: null, ended_at: t, updated_at: t });
    if (n) await this.audit(d.tenant_id, state === 'gone' ? 'push.device.gone' : 'push.device.revoked', actor, { user: d.user_id, device: d.id }, { reason, platform: d.platform, provider: d.provider, fingerprint: d.fingerprint }, ctx, kind);
    return { ...d, state, state_reason: reason, token_sealed: null, ended_at: t, updated_at: t };
  }

  /**
   * For delivery (B-152): the provider said this token no longer exists (APNs 410, FCM `UNREGISTERED`, a Web Push 404
   * or 410, the vendor mapping's "gone"). True when an active device was ended.
   */
  async markGone(deviceId: string, reason: string): Promise<boolean> {
    const r = (await this.db('push_devices').where({ id: deviceId }).first()) as Record<string, unknown> | undefined;
    if (!r) return false;
    const d = fromRow(r);
    if (d.state !== 'active') return false;
    await this.end(d, 'gone', (reason || 'reported gone by the provider').slice(0, 200), { service: 'push' }, {}, 'system');
    return true;
  }

  /**
   * For delivery (B-152) only: the person's active devices with their opened tokens. A device whose token cannot be
   * opened (its tenant key destroyed) is left out. Never return this in an HTTP answer or write it to a log.
   */
  async forDelivery(tenantId: string, userId: string): Promise<DeliveryDevice[]> {
    const rows = ((await this.db('push_devices').where({ tenant_id: tenantId, user_id: userId, state: 'active' }).whereNotNull('token_sealed').orderBy('last_seen_at', 'desc')) as Record<string, unknown>[]).map(fromRow);
    const out: DeliveryDevice[] = [];
    for (const r of rows) {
      let secret: string;
      try {
        secret = await this.s().keys.open(tenantId, r.token_sealed!, aad(r.id));
      } catch (err) {
        this.s().log.warn({ err: (err as Error).message, device: r.id }, 'push device token could not be opened');
        continue;
      }
      const sub = r.provider === 'webpush' ? (JSON.parse(secret) as WebPushSubscription) : null;
      out.push({ id: r.id, tenantId: r.tenant_id, userId: r.user_id, platform: r.platform, provider: r.provider, appId: r.app_id, name: r.name, token: sub ? null : secret, subscription: sub, lastSeenAt: r.last_seen_at });
    }
    return out;
  }

  /**
   * With the person's sessions (`SessionService.devices.end`): `{ userId, exceptSessionId? }` (every session of a
   * person, keeping one), `{ sessionId }` (one session) or `{ tenantId }` (the tenant disabled or offboarded). One
   * audit entry per tenant. Returns how many devices were revoked.
   */
  async endWithSessions(scope: { userId?: string; exceptSessionId?: string; sessionId?: string; tenantId?: string }): Promise<number> {
    const q = this.db('push_devices').where({ state: 'active' });
    let reason: string;
    if (scope.tenantId) {
      q.andWhere({ tenant_id: scope.tenantId });
      reason = 'with every session of the tenant';
    } else if (scope.userId) {
      q.andWhere({ user_id: scope.userId });
      if (scope.exceptSessionId) q.andWhere((w) => w.whereNull('session_id').orWhereNot({ session_id: scope.exceptSessionId }));
      reason = scope.exceptSessionId ? 'with your other sessions' : 'with your sessions';
    } else if (scope.sessionId) {
      q.andWhere({ session_id: scope.sessionId });
      reason = 'with the session it was registered from';
    } else return 0;
    const rows = ((await q.select('id', 'tenant_id', 'user_id')) as { id: string; tenant_id: string; user_id: string }[]);
    if (!rows.length) return 0;
    const t = Date.now();
    const ids = rows.map((r) => r.id);
    for (let i = 0; i < ids.length; i += 500) await this.db('push_devices').whereIn('id', ids.slice(i, i + 500)).andWhere({ state: 'active' }).update({ state: 'revoked', state_reason: reason, token_sealed: null, ended_at: t, updated_at: t });
    const byTenant = new Map<string, typeof rows>();
    for (const r of rows) byTenant.set(r.tenant_id, [...(byTenant.get(r.tenant_id) ?? []), r]);
    for (const [tenantId, list] of byTenant) {
      await this.audit(tenantId, 'push.device.revoked', { service: 'sessions' }, { ...(scope.userId ? { user: scope.userId } : {}), ...(scope.sessionId ? { session: scope.sessionId } : {}) }, { reason, count: list.length, devices: list.slice(0, 100).map((r) => r.id), users: [...new Set(list.map((r) => r.user_id))].slice(0, 100) }, {}, 'system');
    }
    return rows.length;
  }

  /** A rotated session keeps its devices (`SessionService.devices.moved`). */
  async sessionMoved(from: string, to: string): Promise<void> {
    await this.db('push_devices').where({ session_id: from }).update({ session_id: to });
  }

  registerJobs(): void {
    this.s().jobs.register('push.devices.prune', async (p, ctx) => this.prune(String(p.tenantId ?? ctx.job.tenant_id)));
  }

  /**
   * The sweep: deletes the tenant's devices not seen for PUSH_DEVICE_IDLE_DAYS (audited `push.device.pruned`, with
   * their ids) and the rows of devices that ended more than 30 days ago (they hold no token).
   */
  async prune(tenantId: string, now = Date.now()): Promise<{ pruned: number; endedRemoved: number }> {
    const days = this.s().cfg.PUSH_DEVICE_IDLE_DAYS;
    let pruned = 0;
    if (days > 0) {
      const idle = (await this.db('push_devices').where({ tenant_id: tenantId, state: 'active' }).andWhere('last_seen_at', '<', now - days * DAY).select('id', 'user_id')) as { id: string; user_id: string }[];
      for (let i = 0; i < idle.length; i += 500) pruned += Number(await this.db('push_devices').whereIn('id', idle.slice(i, i + 500).map((r) => r.id)).delete());
      if (idle.length) await this.audit(tenantId, 'push.device.pruned', { service: 'push' }, {}, { idleDays: days, count: idle.length, devices: idle.slice(0, 100).map((r) => r.id), users: [...new Set(idle.map((r) => r.user_id))].slice(0, 100) }, {}, 'system');
    }
    const endedRemoved = Number(await this.db('push_devices').where({ tenant_id: tenantId }).whereNot({ state: 'active' }).andWhere('ended_at', '<', now - ENDED_KEEP_MS).delete());
    return { pruned, endedRemoved };
  }
}
