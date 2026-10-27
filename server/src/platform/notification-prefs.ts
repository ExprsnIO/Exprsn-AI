import { ulid } from 'ulid';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { highest, isLabel, labelRank, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { isTimeZone, wallTime, zonedToUtc } from '../groups/time.js';
import { HttpProblem } from '../http/problem.js';
import type { Services } from '../services.js';
import { NotificationTemplates } from './notification-templates.js';
import { builtInChoice, CHANNELS, DIGEST_KIND, isKindId, kindById, kindOf, NOTIFICATION_KINDS, TIMINGS, type Channel, type ChannelChoice, type DigestPeriod, type NotificationKind } from './notification-kinds.js';

/*
 * 1.9.0, Sprint 49 (B-153): notification preferences (migration `116_notification_preferences`).
 *
 * `decide(tenantId, userId, kind, channel, { urgent, at })` is the one answer every delivery path asks: in-app and
 * email in `Notifications.notify`, push and WebSocket in the delivery job (B-152). In order:
 *   1. the raw kind maps to its catalogue entry (`kindOf`);
 *   2. a mandatory kind (locked in the catalogue, or marked mandatory by the tenant) goes out now, always;
 *   3. the person's choice for the kind and channel, else the tenant default, else the built-in default
 *      (`builtInChoice`: in-app and email on and instant, push and WebSocket on for people's own matters);
 *      off → `suppressed` (nothing is kept);
 *   4. quiet hours (push, WebSocket and email; not the in-app inbox, which interrupts nobody): in the window, an urgent
 *      notification passes when the person lets urgent ones through, else it is held for a digest due when the
 *      window ends;
 *   5. a digest timing (hourly, daily at the digest hour, weekly on the digest weekday) → `digest`, due at the next
 *      period in the person's time zone, moved past quiet hours;
 *   6. else `now`.
 * With no row anywhere every answer is `now`, so today's behaviour is unchanged.
 *
 * Fast and cacheable: the tenant's defaults and each person's preferences are cached in memory for 30 seconds and
 * dropped on every instance when they change (bus topic `notification.prefs`); `decideMany` answers a fan-out with one
 * query for the people not cached. A held notification is a row of `notification_digest_items` (`collect`), its title
 * sealed with the tenant key; the `notifications.digest` job sends what is due, per person: one in-app summary
 * (kind `notification.digest`) for in-app, push and WebSocket items, and one email for email items, through the
 * existing `Notifications` paths. Like the weekly feed digest (`feed/digest.ts`), it is a scheduled job per tenant
 * that is idempotent (an item is marked sent once) and fails soft.
 */

export const PREFS_TOPIC = 'notification.prefs';
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export interface QuietWindow {
  start: string;
  end: string;
}
export type QuietHours = Partial<Record<Weekday, QuietWindow | null>>;

export type DecisionReason = 'mandatory' | 'instant' | 'urgent' | 'quiet_hours' | 'digest' | 'off' | 'digest_summary';
export interface Decision {
  deliver: 'now' | 'digest' | 'suppressed';
  reason: DecisionReason;
  /** The catalogue entry the raw kind maps to. */
  kind: string;
  /** For `digest`: the period it waits for (`quiet`: the end of quiet hours) and when it is due. */
  digest?: { period: DigestPeriod | 'quiet'; dueAt: number };
}
export interface DecideOptions {
  urgent?: boolean;
  at?: number;
}

type ChannelMap = Partial<Record<Channel, ChannelChoice>>;
export interface PersonPrefs {
  timeZone: string | null;
  quiet: QuietHours;
  quietUrgent: boolean;
  digestHour: number;
  digestWeekday: number;
  rules: Map<string, ChannelMap>;
  saved: boolean;
}
export interface TenantDefaults {
  kinds: Map<string, { mandatory: boolean; channels: ChannelMap }>;
}

const EMPTY_PERSON: PersonPrefs = { timeZone: null, quiet: {}, quietUrgent: true, digestHour: 8, digestWeekday: 0, rules: new Map(), saved: false };
const QUIET_CHANNELS: readonly Channel[] = ['push', 'websocket', 'email'];
const TTL_MS = 30_000;
const MAX_CACHED = 10_000;
const HOUR = 3_600_000;
const SENT_KEEP_MS = 7 * 24 * HOUR;

// ---------- time ----------

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const tzOf = (p: PersonPrefs) => (p.timeZone && isTimeZone(p.timeZone) ? p.timeZone : 'UTC');

/** The instant of a wall-clock time `dayOffset` days after the local date of `at`, in `tz`. */
function localInstant(at: number, tz: string, dayOffset: number, minutes: number): number {
  const w = wallTime(at, tz);
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day + dayOffset));
  return zonedToUtc({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: Math.floor(minutes / 60), minute: minutes % 60, second: 0 }, tz);
}

/** Monday 0 … Sunday 6, of the local date of `at`. */
function weekdayOf(at: number, tz: string): number {
  const w = wallTime(at, tz);
  return (new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay() + 6) % 7;
}

/**
 * Whether `at` is in the person's quiet hours, and when that window ends. A day's window whose end is before its start
 * runs past midnight into the next day; the previous day's window is checked too.
 */
export function quietAt(at: number, tz: string, quiet: QuietHours): { quiet: boolean; endsAt: number | null } {
  const w = wallTime(at, tz);
  const m = w.hour * 60 + w.minute;
  const dow = weekdayOf(at, tz);
  const today = quiet[WEEKDAYS[dow]!];
  if (today) {
    const s = minutesOf(today.start), e = minutesOf(today.end);
    if (s < e && m >= s && m < e) return { quiet: true, endsAt: localInstant(at, tz, 0, e) };
    if (s > e && m >= s) return { quiet: true, endsAt: localInstant(at, tz, 1, e) };
  }
  const prev = quiet[WEEKDAYS[(dow + 6) % 7]!];
  if (prev) {
    const s = minutesOf(prev.start), e = minutesOf(prev.end);
    if (s > e && m < e) return { quiet: true, endsAt: localInstant(at, tz, 0, e) };
  }
  return { quiet: false, endsAt: null };
}

/** When the next digest of `period` is due after `at`, in `tz` (daily at `hour`, weekly on `weekday` at `hour`). */
export function nextDigestAt(period: DigestPeriod, at: number, tz: string, hour: number, weekday: number): number {
  const w = wallTime(at, tz);
  if (period === 'hourly') {
    let t = localInstant(at, tz, 0, (w.hour + 1) * 60);
    if (t <= at) t = at + HOUR;
    return t;
  }
  if (period === 'daily') {
    const t = localInstant(at, tz, 0, hour * 60);
    return t > at ? t : localInstant(at, tz, 1, hour * 60);
  }
  const ahead = (weekday - weekdayOf(at, tz) + 7) % 7;
  const t = localInstant(at, tz, ahead, hour * 60);
  return t > at ? t : localInstant(at, tz, ahead + 7, hour * 60);
}

/** Moves `t` past quiet hours (a window can only be followed by another one a day later, so twice is enough). */
function pastQuiet(t: number, tz: string, quiet: QuietHours): number {
  for (let i = 0; i < 3; i++) {
    const q = quietAt(t, tz, quiet);
    if (!q.quiet || q.endsAt == null || q.endsAt <= t) return t;
    t = q.endsAt;
  }
  return t;
}

// ---------- the decision ----------

/** The choice in force for a kind and channel, and where it comes from. */
export function choiceFor(entry: NotificationKind, channel: Channel, tenant: TenantDefaults, person: PersonPrefs): ChannelChoice & { source: 'mandatory' | 'you' | 'tenant' | 'default'; mandatory: boolean; lockedBy: 'platform' | 'tenant' | null } {
  const td = tenant.kinds.get(entry.id);
  if (entry.locked || td?.mandatory) return { enabled: true, timing: 'instant', source: 'mandatory', mandatory: true, lockedBy: entry.locked ? 'platform' : 'tenant' };
  const mine = person.rules.get(entry.id)?.[channel];
  if (mine) return { ...mine, source: 'you', mandatory: false, lockedBy: null };
  const t = td?.channels[channel];
  if (t) return { ...t, source: 'tenant', mandatory: false, lockedBy: null };
  return { ...builtInChoice(entry, channel), source: 'default', mandatory: false, lockedBy: null };
}

/** The pure decision (see the header), for one person whose preferences and tenant defaults are loaded. */
export function decideWith(rawKind: string, channel: Channel, tenant: TenantDefaults, person: PersonPrefs, o: DecideOptions = {}): Decision {
  const at = o.at ?? Date.now();
  if (rawKind === DIGEST_KIND) return { deliver: 'now', reason: 'digest_summary', kind: DIGEST_KIND };
  const entry = kindOf(rawKind);
  const c = choiceFor(entry, channel, tenant, person);
  if (c.mandatory) return { deliver: 'now', reason: 'mandatory', kind: entry.id };
  if (!c.enabled) return { deliver: 'suppressed', reason: 'off', kind: entry.id };
  const tz = tzOf(person);
  const quietApplies = QUIET_CHANNELS.includes(channel);
  if (quietApplies) {
    const q = quietAt(at, tz, person.quiet);
    if (q.quiet) {
      if (o.urgent && person.quietUrgent) return { deliver: 'now', reason: 'urgent', kind: entry.id };
      if (c.timing === 'instant') return { deliver: 'digest', reason: 'quiet_hours', kind: entry.id, digest: { period: 'quiet', dueAt: q.endsAt ?? at } };
    }
  }
  if (c.timing !== 'instant') {
    const due = nextDigestAt(c.timing, at, tz, person.digestHour, person.digestWeekday);
    return { deliver: 'digest', reason: 'digest', kind: entry.id, digest: { period: c.timing, dueAt: quietApplies ? pastQuiet(due, tz, person.quiet) : due } };
  }
  return { deliver: 'now', reason: 'instant', kind: entry.id };
}

// ---------- input ----------

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 00:00 to 23:59');
const windowSchema = z.object({ start: hhmm, end: hhmm }).strict().refine((w) => w.start !== w.end, 'the window starts and ends at different times');
const choiceSchema = z.object({ enabled: z.boolean(), timing: z.enum(TIMINGS) }).strict();
const channelsSchema = z.object(Object.fromEntries(CHANNELS.map((c) => [c, choiceSchema.nullable().optional()])) as Record<Channel, z.ZodOptional<z.ZodNullable<typeof choiceSchema>>>).strict();
const kindKey = z.string().max(64).refine(isKindId, 'a notification kind of the catalogue');

export const prefsBody = z
  .object({
    timeZone: z.string().max(64).refine(isTimeZone, 'an IANA time zone such as Europe/London').nullable().optional(),
    quietHours: z.object(Object.fromEntries(WEEKDAYS.map((d) => [d, windowSchema.nullable().optional()])) as Record<Weekday, z.ZodOptional<z.ZodNullable<typeof windowSchema>>>).strict().optional(),
    urgentPassesQuiet: z.boolean().optional(),
    digestHour: z.number().int().min(0).max(23).optional(),
    digestWeekday: z.number().int().min(0).max(6).optional(),
    kinds: z.record(kindKey, channelsSchema.nullable()).optional()
  })
  .strict();
export type PrefsInput = z.infer<typeof prefsBody>;

export const defaultsBody = z
  .object({
    kinds: z.record(kindKey, z.object({ mandatory: z.boolean().optional(), channels: channelsSchema.optional() }).strict().nullable())
  })
  .strict();
export type DefaultsInput = z.infer<typeof defaultsBody>;

export interface DigestItemInput {
  tenantId: string;
  userId: string;
  kind: string;
  channel: Channel;
  title: string;
  route?: string | null;
  label?: Label;
}

interface Ctx {
  ip?: string | null;
  traceId?: string | null;
}

export const mandatoryRefused = (ids: string[], why: string) =>
  new HttpProblem(409, 'Conflict', `${ids.map((id) => kindById(id)?.title ?? id).join(', ')} ${ids.length === 1 ? 'is' : 'are'} mandatory: ${why}`, { extensions: { kinds: ids } });

export class NotificationPrefs {
  private readonly tenants = new Map<string, { at: number; v: TenantDefaults }>();
  private readonly people = new Map<string, { at: number; v: PersonPrefs }>();
  /** Named preference sets a tenant admin applies to people (migration 132; `notification-templates.ts`). */
  readonly templates: NotificationTemplates;

  constructor(private readonly s: () => Services) {
    this.templates = new NotificationTemplates(s, this);
  }

  private get db() {
    return this.s().db;
  }

  /** Drops cached preferences on every instance when they change anywhere. */
  listen(): void {
    this.s().bus.on<{ tenantId: string; userId?: string }>(PREFS_TOPIC, (e) => this.drop(e.tenantId, e.userId));
    // A tenant's default template reaches its new members (every account creation goes through UserRepo.create).
    this.s().users.createdListeners.push((u) => this.templates.onUserCreated(u));
  }

  /** Drops cached preferences here and on every instance (templates write people's rows directly). */
  invalidate(tenantId: string, userId?: string): void {
    this.changed(tenantId, userId);
  }

  private drop(tenantId: string, userId?: string): void {
    if (userId) this.people.delete(`${tenantId}:${userId}`);
    else {
      this.tenants.delete(tenantId);
      for (const k of this.people.keys()) if (k.startsWith(tenantId + ':')) this.people.delete(k);
    }
  }

  private changed(tenantId: string, userId?: string): void {
    this.drop(tenantId, userId);
    this.s().bus.publish(PREFS_TOPIC, { tenantId, ...(userId ? { userId } : {}) });
  }

  async tenantDefaults(tenantId: string): Promise<TenantDefaults> {
    const hit = this.tenants.get(tenantId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.v;
    const rows = (await this.db('notification_tenant_defaults').where({ tenant_id: tenantId })) as { kind: string; mandatory: unknown; channels: string }[];
    const v: TenantDefaults = { kinds: new Map(rows.map((r) => [r.kind, { mandatory: !!r.mandatory, channels: json<ChannelMap>(r.channels, {}) }])) };
    this.tenants.set(tenantId, { at: Date.now(), v });
    return v;
  }

  /** Preferences of several people, from the cache or one query each table. */
  async personPrefs(tenantId: string, userIds: string[]): Promise<Map<string, PersonPrefs>> {
    const out = new Map<string, PersonPrefs>();
    const missing: string[] = [];
    const t = Date.now();
    for (const u of userIds) {
      const hit = this.people.get(`${tenantId}:${u}`);
      if (hit && t - hit.at < TTL_MS) out.set(u, hit.v);
      else missing.push(u);
    }
    for (let i = 0; i < missing.length; i += 500) {
      const batch = missing.slice(i, i + 500);
      const [settings, rules] = await Promise.all([
        this.db('notification_prefs').where({ tenant_id: tenantId }).whereIn('user_id', batch) as Promise<Record<string, unknown>[]>,
        this.db('notification_pref_rules').where({ tenant_id: tenantId }).whereIn('user_id', batch) as Promise<{ user_id: string; kind: string; channels: string }[]>
      ]);
      const byUser = new Map(settings.map((r) => [String(r.user_id), r]));
      for (const u of batch) {
        const r = byUser.get(u);
        const mine = rules.filter((x) => x.user_id === u);
        const v: PersonPrefs = r || mine.length
          ? { timeZone: (r?.time_zone as string | null) ?? null, quiet: json<QuietHours>(r?.quiet ?? null, {}), quietUrgent: r ? !!r.quiet_urgent : true, digestHour: r ? Number(r.digest_hour) : 8, digestWeekday: r ? Number(r.digest_weekday) : 0, rules: new Map(mine.map((x) => [x.kind, json<ChannelMap>(x.channels, {})])), saved: true }
          : EMPTY_PERSON;
        out.set(u, v);
        if (this.people.size >= MAX_CACHED) this.people.delete(this.people.keys().next().value!);
        this.people.set(`${tenantId}:${u}`, { at: t, v });
      }
    }
    return out;
  }

  /** For delivery (B-152) and the existing paths: what to do with one notification on one channel. */
  async decide(tenantId: string, userId: string, kind: string, channel: Channel, o: DecideOptions = {}): Promise<Decision> {
    return (await this.decideMany(tenantId, [userId], kind, channel, o)).get(userId)!;
  }

  async decideMany(tenantId: string, userIds: string[], kind: string, channel: Channel, o: DecideOptions = {}): Promise<Map<string, Decision>> {
    const [tenant, people] = await Promise.all([this.tenantDefaults(tenantId), this.personPrefs(tenantId, userIds)]);
    const at = o.at ?? Date.now();
    return new Map(userIds.map((u) => [u, decideWith(kind, channel, tenant, people.get(u) ?? EMPTY_PERSON, { ...o, at })]));
  }

  /** Holds a notification the decision sent to a digest; nothing for another decision. */
  async collect(item: DigestItemInput, decision: Decision): Promise<string | null> {
    if (decision.deliver !== 'digest' || !decision.digest) return null;
    const id = ulid();
    const label: Label = item.label && isLabel(item.label) ? item.label : 'internal';
    await this.db('notification_digest_items').insert({
      id,
      tenant_id: item.tenantId,
      user_id: item.userId,
      kind: item.kind.slice(0, 120),
      channel: item.channel,
      period: decision.digest.period,
      label,
      title_sealed: await this.s().keys.seal(item.tenantId, item.title.slice(0, 200), `notification-digest:${id}`),
      route: item.route?.slice(0, 300) ?? null,
      due_at: decision.digest.dueAt,
      created_at: Date.now(),
      sent_at: null
    });
    return id;
  }

  // ---------- the person's view ----------

  async view(p: Principal) {
    const [tenant, people] = await Promise.all([this.tenantDefaults(p.tenantId), this.personPrefs(p.tenantId, [p.userId])]);
    const me = people.get(p.userId) ?? EMPTY_PERSON;
    const template = await this.templates.originFor(p.tenantId, p.userId, me.rules).catch(() => null);
    return {
      saved: me.saved,
      template,
      timeZone: me.timeZone,
      quietHours: Object.fromEntries(WEEKDAYS.map((d) => [d, me.quiet[d] ?? null])),
      urgentPassesQuiet: me.quietUrgent,
      digestHour: me.digestHour,
      digestWeekday: me.digestWeekday,
      channels: CHANNELS,
      timings: TIMINGS,
      kinds: NOTIFICATION_KINDS.map((k) => {
        const chans = Object.fromEntries(CHANNELS.map((c) => { const x = choiceFor(k, c, tenant, me); return [c, { enabled: x.enabled, timing: x.timing, source: x.source }]; }));
        const first = choiceFor(k, 'in_app', tenant, me);
        return { id: k.id, title: k.title, description: k.description, group: k.group, mandatory: first.mandatory, lockedBy: first.lockedBy, lockedReason: first.lockedBy === 'platform' ? (k.lockedReason ?? 'Always sent.') : first.lockedBy === 'tenant' ? 'Your organisation made this kind mandatory, so it always reaches you. A tenant admin can change that.' : null, channels: chans };
      })
    };
  }

  async update(p: Principal, input: PrefsInput, ctx: Ctx = {}) {
    const tenant = await this.tenantDefaults(p.tenantId);
    const kinds = input.kinds ?? {};
    const locked = Object.entries(kinds).filter(([id, ch]) => {
      const entry = kindById(id)!;
      if (!entry.locked && !tenant.kinds.get(id)?.mandatory) return false;
      return !!ch && Object.values(ch).some((c) => c && (!c.enabled || c.timing !== 'instant'));
    }).map(([id]) => id);
    if (locked.length) throw mandatoryRefused(locked, 'they cannot be turned off or held for a digest.');
    const t = Date.now();
    const current = (await this.personPrefs(p.tenantId, [p.userId])).get(p.userId) ?? EMPTY_PERSON;
    const settings: string[] = [];
    await this.db.transaction(async (trx) => {
      const row = (await trx('notification_prefs').where({ tenant_id: p.tenantId, user_id: p.userId }).first()) as Record<string, unknown> | undefined;
      const quiet: QuietHours = { ...current.quiet };
      if (input.quietHours) for (const d of WEEKDAYS) if (d in input.quietHours) { if (input.quietHours[d]) quiet[d] = input.quietHours[d]!; else delete quiet[d]; }
      const next = {
        time_zone: input.timeZone !== undefined ? input.timeZone : current.timeZone,
        quiet: JSON.stringify(quiet),
        quiet_urgent: input.urgentPassesQuiet ?? current.quietUrgent,
        digest_hour: input.digestHour ?? current.digestHour,
        digest_weekday: input.digestWeekday ?? current.digestWeekday,
        updated_at: t
      };
      for (const k of ['timeZone', 'quietHours', 'urgentPassesQuiet', 'digestHour', 'digestWeekday'] as const) if (input[k] !== undefined) settings.push(k);
      if (row) await trx('notification_prefs').where({ tenant_id: p.tenantId, user_id: p.userId }).update(next);
      else await trx('notification_prefs').insert({ tenant_id: p.tenantId, user_id: p.userId, ...next });
      for (const [id, ch] of Object.entries(kinds)) {
        const merged: ChannelMap = ch === null ? {} : { ...(current.rules.get(id) ?? {}) };
        if (ch) for (const c of CHANNELS) if (c in ch) { const v = ch[c]; if (v) merged[c] = { enabled: v.enabled, timing: v.timing }; else delete merged[c]; }
        await trx('notification_pref_rules').where({ tenant_id: p.tenantId, user_id: p.userId, kind: id }).delete();
        if (Object.keys(merged).length) await trx('notification_pref_rules').insert({ tenant_id: p.tenantId, user_id: p.userId, kind: id, channels: JSON.stringify(merged), updated_at: t });
      }
    });
    this.changed(p.tenantId, p.userId);
    await this.s().audit.append({ tenantId: p.tenantId, action: 'notification.prefs.updated', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { user: p.userId }, label: 'internal', detail: { settings, kinds: Object.keys(kinds) }, ...(ctx.traceId ? { traceId: ctx.traceId } : {}) });
    return this.view(p);
  }

  /** Back to the tenant defaults: every personal choice, quiet hours and the time zone are removed. */
  async reset(p: Principal, ctx: Ctx = {}) {
    const n = Number(await this.db('notification_prefs').where({ tenant_id: p.tenantId, user_id: p.userId }).delete()) + Number(await this.db('notification_pref_rules').where({ tenant_id: p.tenantId, user_id: p.userId }).delete());
    await this.templates.forget(p.tenantId, p.userId);
    this.changed(p.tenantId, p.userId);
    if (n) await this.s().audit.append({ tenantId: p.tenantId, action: 'notification.prefs.reset', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { user: p.userId }, label: 'internal', detail: {}, ...(ctx.traceId ? { traceId: ctx.traceId } : {}) });
    return this.view(p);
  }

  // ---------- tenant defaults ----------

  async tenantView(tenantId: string) {
    const tenant = await this.tenantDefaults(tenantId);
    return {
      channels: CHANNELS,
      timings: TIMINGS,
      kinds: NOTIFICATION_KINDS.map((k) => {
        const td = tenant.kinds.get(k.id);
        return {
          id: k.id, title: k.title, description: k.description, group: k.group,
          locked: !!k.locked, lockedReason: k.locked ? (k.lockedReason ?? null) : null,
          mandatory: !!k.locked || !!td?.mandatory,
          channels: Object.fromEntries(CHANNELS.map((c) => { const v = td?.channels[c]; return [c, v ? { ...v, source: 'tenant' } : { ...builtInChoice(k, c), source: 'default' }]; }))
        };
      })
    };
  }

  async updateTenant(admin: Principal, input: DefaultsInput, ctx: Ctx = {}) {
    const lockedOff = Object.entries(input.kinds).filter(([id, v]) => kindById(id)!.locked && (v === null || v.mandatory === false)).map(([id]) => id);
    if (lockedOff.length) throw mandatoryRefused(lockedOff, 'every tenant sends them; they cannot be made optional.');
    const tenant = await this.tenantDefaults(admin.tenantId);
    const t = Date.now();
    const mandatory: Record<string, boolean> = {};
    await this.db.transaction(async (trx) => {
      for (const [id, v] of Object.entries(input.kinds)) {
        const cur = tenant.kinds.get(id);
        await trx('notification_tenant_defaults').where({ tenant_id: admin.tenantId, kind: id }).delete();
        if (v === null) continue;
        const channels: ChannelMap = { ...(cur?.channels ?? {}) };
        if (v.channels) for (const c of CHANNELS) if (c in v.channels) { const x = v.channels[c]; if (x) channels[c] = { enabled: x.enabled, timing: x.timing }; else delete channels[c]; }
        const m = v.mandatory ?? cur?.mandatory ?? false;
        if (v.mandatory !== undefined) mandatory[id] = m;
        if (!m && !Object.keys(channels).length) continue;
        await trx('notification_tenant_defaults').insert({ tenant_id: admin.tenantId, kind: id, mandatory: m, channels: JSON.stringify(channels), updated_at: t, updated_by: admin.userId });
      }
    });
    this.changed(admin.tenantId);
    await this.s().audit.append({ tenantId: admin.tenantId, action: 'notification.defaults.updated', kind: 'admin', actor: actorFrom(admin, ctx.ip ?? null), target: { tenant: admin.tenantId }, label: 'internal', detail: { kinds: Object.keys(input.kinds), mandatory }, ...(ctx.traceId ? { traceId: ctx.traceId } : {}) });
    return this.tenantView(admin.tenantId);
  }

  // ---------- digests ----------

  registerJobs(): void {
    this.s().jobs.register('notifications.digest', async (p, ctx) => this.sendDue(String(p.tenantId ?? ctx.job.tenant_id)));
  }

  /** Sends every held notification that is due, per person; removes items sent more than a week ago. */
  async sendDue(tenantId: string, now = Date.now()): Promise<{ people: number; items: number; emails: number }> {
    const s = this.s();
    const rows = (await this.db('notification_digest_items').where({ tenant_id: tenantId }).whereNull('sent_at').andWhere('due_at', '<=', now).orderBy('created_at').limit(5000)) as { id: string; user_id: string; kind: string; channel: Channel; label: string; title_sealed: string; route: string | null; created_at: number | string }[];
    const byUser = new Map<string, typeof rows>();
    for (const r of rows) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r]);
    let emails = 0;
    const users = byUser.size ? ((await this.db('users').where({ tenant_id: tenantId }).whereIn('id', [...byUser.keys()]).select('id', 'email', 'username', 'display_name', 'state')) as { id: string; email: string | null; username: string; display_name: string; state: string }[]) : [];
    const userById = new Map(users.map((u) => [u.id, u]));
    for (const [userId, items] of byUser) {
      const opened: { title: string; label: Label; route: string | null; channel: Channel; since: number }[] = [];
      for (const r of items) {
        try {
          opened.push({ title: await s.keys.open(tenantId, r.title_sealed, `notification-digest:${r.id}`), label: isLabel(r.label) ? r.label : 'restricted', route: r.route, channel: r.channel, since: Number(r.created_at) });
        } catch (err) {
          s.log.warn({ err: (err as Error).message, item: r.id }, 'digest item could not be opened');
        }
      }
      const u = userById.get(userId);
      if (u && u.state === 'active' && opened.length) {
        const inbox = opened.filter((o) => o.channel !== 'email');
        const mail = opened.filter((o) => o.channel === 'email');
        if (inbox.length) {
          const lines = inbox.slice(0, 10).map((o) => `• ${o.title}`);
          if (inbox.length > 10) lines.push(`and ${inbox.length - 10} more`);
          await s.notifications.notify({ tenantId, userIds: [userId], kind: DIGEST_KIND, title: `${inbox.length} notification${inbox.length === 1 ? '' : 's'} held for you`, body: lines.join('\n'), route: inbox.length === 1 ? inbox[0]!.route ?? undefined : undefined, label: highest(...inbox.map((o) => o.label)), skipPreferences: true });
        }
        if (mail.length && u.email && s.notifications.emailEnabled) {
          // Email carries titles only, and not even those of notifications labelled above internal.
          const titles = mail.slice(0, 20).map((o) => (labelRank(o.label) <= labelRank('internal') ? o.title : `a notification labelled ${o.label}`));
          const ok = await s.notifications.sendTemplate(u.email, 'notification-digest', { name: u.display_name, username: u.username, count: mail.length, items: titles.join('; ') + (mail.length > 20 ? `; and ${mail.length - 20} more` : ''), since: new Date(Math.min(...mail.map((o) => o.since))).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC'), link: s.notifications.consoleUrl('settings') });
          if (ok) emails++;
        }
      }
      const ids = items.map((r) => r.id);
      for (let i = 0; i < ids.length; i += 500) await this.db('notification_digest_items').whereIn('id', ids.slice(i, i + 500)).update({ sent_at: now });
    }
    await this.db('notification_digest_items').where({ tenant_id: tenantId }).whereNotNull('sent_at').andWhere('sent_at', '<', now - SENT_KEEP_MS).delete();
    return { people: byUser.size, items: rows.length, emails };
  }
}
