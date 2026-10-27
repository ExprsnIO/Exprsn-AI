import { hostname } from 'node:os';
import { ulid } from 'ulid';
import { actorFrom } from '../audit/chain.js';
import type { Principal } from '../authz/policy.js';
import { workspacesFor } from '../http/middleware.js';
import { TOPICS } from '../platform/bus.js';
import type { Services } from '../services.js';

/*
 * Presence status (B-5802): available, away, busy or offline.
 *
 * - A person chooses a status, or leaves it on `auto`. Chosen `offline` ("appear offline") always reads offline; a
 *   person with no connected socket reads offline whatever they chose; otherwise a chosen status stands, and `auto`
 *   reads `away` when every socket they hold reports idle (the console reports idle after five minutes without input
 *   or while hidden) and `available` otherwise.
 * - Connections are counted per instance in `presence_connections`, refreshed by a heartbeat; a row older than the
 *   lease is from an instance that went away and is swept. The effective status last published is kept in
 *   `user_presence.last_status`, so a change is published once (`TOPICS.presence`) and relayed by every instance to
 *   the sockets watching that person.
 * - Who sees it: people who share a workspace with the person, decided when they ask (REST) or start watching (the
 *   socket's `presence.watch`). Someone in a block with the person (either way) sees nothing: no status in answers,
 *   no watch, and every change is published with them left out (`exceptUserIds`), as messaging does (B-2603).
 */

export const PRESENCE = ['available', 'away', 'busy', 'offline'] as const;
export type Presence = (typeof PRESENCE)[number];
export const CHOSEN = ['auto', ...PRESENCE] as const;
export type Chosen = (typeof CHOSEN)[number];

/** Published on `TOPICS.presence` when someone's effective status changes. */
export interface PresenceEvent {
  tenantId: string;
  userId: string;
  status: Presence;
  at: number;
  /** People in a block with `userId`: never told. */
  exceptUserIds?: string[];
}

export interface PresenceOptions {
  /** How often this instance refreshes its connection rows. */
  heartbeatMs: number;
  /** A connection row not refreshed for this long is from an instance that went away. */
  leaseMs: number;
}

export interface Ctx {
  p: Principal;
  ip: string | null;
  traceId?: string | null;
}

const key = (tenantId: string, userId: string) => `${tenantId}:${userId}`;
export const MAX_WATCH = 200;

export class PresenceService {
  readonly instanceId = `${hostname()}:${process.pid}:${ulid().slice(-8)}`;
  /** Sockets this instance holds, per user: socket id to idle. */
  private readonly local = new Map<string, Map<string, boolean>>();
  private timer: NodeJS.Timeout | null = null;
  /** Per user, the last sync, so connection changes for one person are applied in order. */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly s: () => Services,
    private readonly o: PresenceOptions
  ) {}

  private get db() {
    return this.s().db;
  }

  start(): void {
    if (this.timer || this.o.heartbeatMs <= 0) return;
    this.timer = setInterval(() => void this.heartbeat().catch((err: unknown) => this.s().log.warn({ err }, 'presence heartbeat failed')), this.o.heartbeatMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.all([...this.chains.values()]);
    await this.db('presence_connections').where({ instance_id: this.instanceId }).delete().catch(() => undefined);
  }

  // ---------- connections (from the socket layer) ----------

  connected(tenantId: string, userId: string, socketId: string): Promise<void> {
    const k = key(tenantId, userId);
    const m = this.local.get(k) ?? new Map<string, boolean>();
    m.set(socketId, false);
    this.local.set(k, m);
    return this.sync(tenantId, userId);
  }

  disconnected(tenantId: string, userId: string, socketId: string): Promise<void> {
    const k = key(tenantId, userId);
    const m = this.local.get(k);
    if (!m?.delete(socketId)) return Promise.resolve();
    if (!m.size) this.local.delete(k);
    return this.sync(tenantId, userId);
  }

  /** A socket reports its person idle (no input for a while, or the page hidden) or active again. */
  activity(tenantId: string, userId: string, socketId: string, idle: boolean): Promise<void> {
    const m = this.local.get(key(tenantId, userId));
    if (!m?.has(socketId) || m.get(socketId) === idle) return Promise.resolve();
    m.set(socketId, idle);
    return this.sync(tenantId, userId);
  }

  private sync(tenantId: string, userId: string): Promise<void> {
    return this.serial(tenantId, userId, async () => {
      await this.writeRow(tenantId, userId);
      await this.publishIfChanged(tenantId, userId);
    }).then(
      () => undefined,
      (err: unknown) => this.s().log.warn({ err }, 'presence not updated')
    );
  }

  /** Runs `fn` after the previous work for this person on this instance, so their changes publish in order. */
  private serial<T>(tenantId: string, userId: string, fn: () => Promise<T>): Promise<T> {
    const k = key(tenantId, userId);
    const run = (this.chains.get(k) ?? Promise.resolve()).catch(() => undefined).then(fn);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.chains.set(k, tail);
    void tail.then(() => {
      if (this.chains.get(k) === tail) this.chains.delete(k);
    });
    return run;
  }

  private async writeRow(tenantId: string, userId: string): Promise<void> {
    const m = this.local.get(key(tenantId, userId));
    const where = { tenant_id: tenantId, user_id: userId, instance_id: this.instanceId };
    if (!m?.size) {
      await this.db('presence_connections').where(where).delete();
      return;
    }
    const values = { sockets: m.size, idle: [...m.values()].every(Boolean), seen_at: Date.now() };
    const n = await this.db('presence_connections').where(where).update(values);
    if (!n) {
      try {
        await this.db('presence_connections').insert({ ...where, ...values });
      } catch {
        await this.db('presence_connections').where(where).update(values);
      }
    }
  }

  /** Refreshes this instance's rows and sweeps the rows of instances that went away. */
  async heartbeat(): Promise<void> {
    const now = Date.now();
    await this.db('presence_connections').where({ instance_id: this.instanceId }).update({ seen_at: now });
    const stale = (await this.db('presence_connections').where('seen_at', '<', now - this.o.leaseMs).select('tenant_id', 'user_id', 'instance_id')) as { tenant_id: string; user_id: string; instance_id: string }[];
    // Instances race to publish a change; one that lost a race in between is set right here, within a heartbeat.
    for (const k of [...this.local.keys()]) {
      const [tenantId, userId] = k.split(':') as [string, string];
      await this.serial(tenantId, userId, () => this.publishIfChanged(tenantId, userId)).catch(() => undefined);
    }
    if (!stale.length) return;
    for (const r of stale) await this.db('presence_connections').where({ tenant_id: r.tenant_id, user_id: r.user_id, instance_id: r.instance_id }).andWhere('seen_at', '<', now - this.o.leaseMs).delete();
    const seen = new Set<string>();
    for (const r of stale) {
      const k = key(r.tenant_id, r.user_id);
      if (seen.has(k)) continue;
      seen.add(k);
      await this.serial(r.tenant_id, r.user_id, () => this.publishIfChanged(r.tenant_id, r.user_id));
    }
  }

  // ---------- statuses ----------

  private async chosen(tenantId: string, userIds: string[]): Promise<Map<string, { status: Chosen; last: Presence | null }>> {
    const out = new Map<string, { status: Chosen; last: Presence | null }>();
    for (let i = 0; i < userIds.length; i += 500) {
      const rows = (await this.db('user_presence').where({ tenant_id: tenantId }).whereIn('user_id', userIds.slice(i, i + 500)).select('user_id', 'status', 'last_status')) as { user_id: string; status: Chosen; last_status: Presence | null }[];
      for (const r of rows) out.set(r.user_id, { status: r.status, last: r.last_status });
    }
    return out;
  }

  /** The effective status of each of `userIds` (no visibility check: callers decide who may know). */
  async effective(tenantId: string, userIds: string[]): Promise<Map<string, Presence>> {
    const ids = [...new Set(userIds)];
    const chosen = await this.chosen(tenantId, ids);
    const since = Date.now() - this.o.leaseMs;
    const conns = new Map<string, { sockets: number; idle: boolean }[]>();
    for (let i = 0; i < ids.length; i += 500) {
      const rows = (await this.db('presence_connections').where({ tenant_id: tenantId }).whereIn('user_id', ids.slice(i, i + 500)).andWhere('seen_at', '>=', since).select('user_id', 'sockets', 'idle')) as { user_id: string; sockets: number | string; idle: boolean | number }[];
      for (const r of rows) conns.set(r.user_id, [...(conns.get(r.user_id) ?? []), { sockets: Number(r.sockets), idle: !!r.idle }]);
    }
    const out = new Map<string, Presence>();
    for (const id of ids) {
      const c = chosen.get(id)?.status ?? 'auto';
      const mine = (conns.get(id) ?? []).filter((x) => x.sockets > 0);
      if (c === 'offline' || !mine.length) out.set(id, 'offline');
      else if (c !== 'auto') out.set(id, c);
      else out.set(id, mine.every((x) => x.idle) ? 'away' : 'available');
    }
    return out;
  }

  /** Publishes the person's effective status when it differs from the one last published. */
  async publishIfChanged(tenantId: string, userId: string): Promise<Presence> {
    const status = (await this.effective(tenantId, [userId])).get(userId)!;
    const before = (await this.chosen(tenantId, [userId])).get(userId);
    if (before?.last === status) return status;
    const t = Date.now();
    if (!before) {
      try {
        await this.db('user_presence').insert({ tenant_id: tenantId, user_id: userId, status: 'auto', last_status: status, updated_at: t });
      } catch {
        // Another instance made the row first; fall through to the conditional update.
        const n = await this.db('user_presence').where({ tenant_id: tenantId, user_id: userId }).andWhere((q) => q.whereNull('last_status').orWhereNot('last_status', status)).update({ last_status: status });
        if (!n) return status;
      }
    } else {
      // Only one instance wins the change, so it is published once.
      const q = this.db('user_presence').where({ tenant_id: tenantId, user_id: userId });
      const n = await (before.last == null ? q.whereNull('last_status') : q.where({ last_status: before.last })).update({ last_status: status });
      if (!n) return status;
    }
    const blocked = await this.s().social.blockedWith(tenantId, userId);
    this.s().bus.publish(TOPICS.presence, { tenantId, userId, status, at: t, ...(blocked.size ? { exceptUserIds: [...blocked] } : {}) } satisfies PresenceEvent);
    return status;
  }

  /** The caller's own chosen and effective status. */
  async mine(p: Principal): Promise<{ status: Chosen; effective: Presence }> {
    const c = (await this.chosen(p.tenantId, [p.userId])).get(p.userId)?.status ?? 'auto';
    return { status: c, effective: (await this.effective(p.tenantId, [p.userId])).get(p.userId)! };
  }

  async setStatus(ctx: Ctx, status: Chosen): Promise<{ status: Chosen; effective: Presence }> {
    const p = ctx.p;
    const before = (await this.chosen(p.tenantId, [p.userId])).get(p.userId);
    const t = Date.now();
    if (!before) {
      try {
        await this.db('user_presence').insert({ tenant_id: p.tenantId, user_id: p.userId, status, last_status: null, updated_at: t });
      } catch {
        await this.db('user_presence').where({ tenant_id: p.tenantId, user_id: p.userId }).update({ status, updated_at: t });
      }
    } else await this.db('user_presence').where({ tenant_id: p.tenantId, user_id: p.userId }).update({ status, updated_at: t });
    if ((before?.status ?? 'auto') !== status) await this.s().audit.append({ tenantId: p.tenantId, action: 'presence.status.updated', kind: 'admin', actor: actorFrom(p, ctx.ip), target: { user: p.userId }, detail: { before: before?.status ?? 'auto', after: status }, label: 'internal', traceId: ctx.traceId ?? null });
    const effective = await this.serial(p.tenantId, p.userId, () => this.publishIfChanged(p.tenantId, p.userId));
    return { status, effective };
  }

  // ---------- who may know ----------

  /**
   * Of `userIds`, those the caller may see the presence of: active people of the tenant who share a workspace with
   * the caller and are in no block with them. The caller themselves is included.
   */
  async visibleAmong(p: Principal, userIds: string[]): Promise<Set<string>> {
    const s = this.s();
    const ids = [...new Set(userIds)];
    const out = new Set<string>();
    if (ids.includes(p.userId)) out.add(p.userId);
    const others = ids.filter((u) => u !== p.userId);
    if (!others.length) return out;
    const mine = await workspacesFor(s, p);
    if (!mine.length) return out;
    // A workspace open to the whole tenant is shared with everyone in it.
    const everyone = mine.some((w) => w.visibility === 'tenant');
    const candidates = new Set<string>();
    for (let i = 0; i < others.length; i += 500) {
      const chunk = others.slice(i, i + 500);
      const active = (await this.db('users').where({ tenant_id: p.tenantId, state: 'active' }).whereIn('id', chunk).select('id')) as { id: string }[];
      if (everyone) for (const r of active) candidates.add(r.id);
      else {
        const activeIds = active.map((r) => r.id);
        if (!activeIds.length) continue;
        const rows = (await this.db('workspace_members').whereIn('workspace_id', mine.map((w) => w.id)).whereIn('user_id', activeIds).distinct('user_id')) as { user_id: string }[];
        for (const r of rows) candidates.add(r.user_id);
      }
    }
    const blocked = await s.social.blockedAmong(p.tenantId, p.userId, [...candidates]);
    for (const u of candidates) if (!blocked.has(u)) out.add(u);
    return out;
  }

  /** The statuses of those of `userIds` the caller may see; the others are left out entirely. */
  async statuses(p: Principal, userIds: string[]): Promise<Record<string, Presence>> {
    const visible = await this.visibleAmong(p, userIds);
    const eff = await this.effective(p.tenantId, [...visible]);
    const out: Record<string, Presence> = {};
    for (const [u, st] of eff) out[u] = st;
    return out;
  }
}
