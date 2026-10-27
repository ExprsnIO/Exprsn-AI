import { ulid } from 'ulid';
import { z } from 'zod';
import { actorFrom, type AuditActor } from '../audit/chain.js';
import type { Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { badRequest, conflict, HttpProblem, notFound } from '../http/problem.js';
import type { UserRow } from '../repos/users.js';
import type { Services } from '../services.js';
import { CHANNELS, isKindId, kindById, NOTIFICATION_KINDS, TIMINGS, type Channel, type ChannelChoice } from './notification-kinds.js';
// Only types and `mandatoryRefused` (used at call time) from notification-prefs.ts, which imports this module: no
// value of it may be read while the modules load.
import { mandatoryRefused, type NotificationPrefs, type QuietHours, type TenantDefaults, type Weekday } from './notification-prefs.js';

const WEEKDAYS: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/*
 * 1.9.0: notification templates (migration `132_notification_templates`).
 *
 * A template is a named, versioned preference set of one tenant: a choice per kind and channel (enabled, and the
 * timing: at once or an hourly, daily or weekly digest), optional quiet hours with "urgent passes", the digest hour and
 * weekday, and a description. Tenant admins manage them under `tenant:manage`, the permission of the tenant's
 * notification defaults. Applying one writes its choices as the person's own preferences (rows of
 * `notification_pref_rules` and `notification_prefs`, exactly what Settings › Notifications saves), so the person
 * customises afterwards as usual:
 *   - `replace`: the person's kind choices are removed first, then the template's are written; their quiet hours,
 *     "urgent passes" and digest times become the template's (or the built-in ones where it sets none). Their time
 *     zone is theirs and is kept.
 *   - `fill`: only the kinds the person has not chosen are set, and the settings only when they have none saved.
 * Mandatory kinds (locked in the catalogue, or made mandatory by the tenant) are never turned off or delayed by a
 * template: saving one that would is refused (409 naming the kinds), and applying skips them (a tenant may make a
 * kind mandatory after the template was saved).
 *
 * Each application records, per person, the template, its version and the person's kind choices right after it
 * (`notification_pref_origins`), so Settings says "Based on template X" and how many kinds they changed since. One
 * template may be the default for new members: `UserRepo.create` (every way an account comes into a tenant: sign-up,
 * invitation, JIT provisioning, SCIM, import, the admin screens) tells `onUserCreated`, which fills the new person's
 * preferences from it once the account's transaction has committed.
 *
 * Without the migration's tables, `list` answers `available: false`, the other calls 503, the view shows no origin
 * and new members get nothing: today's behaviour. Audited `notification.template.created`, `.updated`, `.deleted`
 * and `.applied`.
 */

type ChannelMap = Partial<Record<Channel, ChannelChoice>>;
export type TemplateMode = 'replace' | 'fill';

export interface TemplateBody {
  kinds: Record<string, ChannelMap>;
  quietHours: QuietHours | null;
  urgentPassesQuiet: boolean | null;
  digestHour: number | null;
  digestWeekday: number | null;
}

interface TemplateRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  version: number | string;
  body: string;
  default_for_new: unknown;
  created_by: string | null;
  updated_by: string | null;
  created_at: number | string;
  updated_at: number | string;
}

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 00:00 to 23:59');
const windowSchema = z.object({ start: hhmm, end: hhmm }).strict().refine((w) => w.start !== w.end, 'the window starts and ends at different times');
const choiceSchema = z.object({ enabled: z.boolean(), timing: z.enum(TIMINGS) }).strict();
const channelsSchema = z.object(Object.fromEntries(CHANNELS.map((c) => [c, choiceSchema.optional()])) as Record<Channel, z.ZodOptional<typeof choiceSchema>>).strict();
const kindKey = z.string().max(64).refine(isKindId, 'a notification kind of the catalogue');
const quietSchema = z.object(Object.fromEntries(WEEKDAYS.map((d) => [d, windowSchema.nullable().optional()])) as Record<Weekday, z.ZodOptional<z.ZodNullable<typeof windowSchema>>>).strict();

const fields = {
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).nullable().optional(),
  kinds: z.record(kindKey, channelsSchema),
  quietHours: quietSchema.nullable().optional(),
  urgentPassesQuiet: z.boolean().nullable().optional(),
  digestHour: z.number().int().min(0).max(23).nullable().optional(),
  digestWeekday: z.number().int().min(0).max(6).nullable().optional(),
  defaultForNewMembers: z.boolean().optional()
};
export const templateCreateBody = z.object(fields).strict();
export const templateUpdateBody = z.object({ ...fields, name: fields.name.optional(), kinds: fields.kinds.optional() }).strict()
  .refine((b) => Object.keys(b).length > 0, 'nothing to change');
export type TemplateCreateInput = z.infer<typeof templateCreateBody>;
export type TemplateUpdateInput = z.infer<typeof templateUpdateBody>;

const ulidish = z.string().min(1).max(64);
export const templateApplyBody = z
  .object({
    mode: z.enum(['replace', 'fill']),
    target: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('users'), userIds: z.array(ulidish).max(1000).optional(), usernames: z.array(z.string().trim().min(1).max(200)).max(1000).optional() }).strict()
        .refine((t) => (t.userIds?.length ?? 0) + (t.usernames?.length ?? 0) > 0, 'name at least one person'),
      z.object({ kind: z.literal('role'), role: z.string().min(1).max(64) }).strict(),
      z.object({ kind: z.literal('group'), groupId: ulidish }).strict(),
      z.object({ kind: z.literal('everyone') }).strict()
    ]),
    /** Counts what would change, writes nothing. */
    dryRun: z.boolean().optional()
  })
  .strict();
export type TemplateApplyInput = z.infer<typeof templateApplyBody>;

interface Ctx {
  ip?: string | null;
  traceId?: string | null;
}

const SCHEMA_RECHECK_MS = 30_000;
const DEFAULT_TTL_MS = 30_000;
const BATCH = 500;

const notInstalled = () => new HttpProblem(503, 'Not installed', 'Notification templates need the database migration 132_notification_templates, which has not been applied.', { extensions: { reason: 'migration_pending' } });

/** One channel choice as a short comparable string; `-` when the kind follows the default on that channel. */
const sig = (m: ChannelMap | undefined) => CHANNELS.map((c) => (m?.[c] ? `${m[c]!.enabled ? 1 : 0}${m[c]!.timing}` : '-')).join('|');
const clean = (m: ChannelMap | undefined): ChannelMap => {
  const out: ChannelMap = {};
  if (m) for (const c of CHANNELS) if (m[c]) out[c] = { enabled: m[c]!.enabled, timing: m[c]!.timing };
  return out;
};
const sameQuiet = (a: QuietHours, b: QuietHours) => WEEKDAYS.every((d) => JSON.stringify(a[d] ?? null) === JSON.stringify(b[d] ?? null));
const quietOf = (q: QuietHours | null | undefined): QuietHours => {
  const out: QuietHours = {};
  if (q) for (const d of WEEKDAYS) if (q[d]) out[d] = { start: q[d]!.start, end: q[d]!.end };
  return out;
};

/** Kinds whose choices in `kinds` would turn a mandatory kind off or delay it. */
function lockedViolations(kinds: Record<string, ChannelMap>, tenant: TenantDefaults): string[] {
  return Object.entries(kinds)
    .filter(([id, ch]) => (kindById(id)?.locked || tenant.kinds.get(id)?.mandatory) && Object.values(ch).some((c) => c && (!c.enabled || c.timing !== 'instant')))
    .map(([id]) => id);
}

export class NotificationTemplates {
  private schema: { ok: boolean; at: number } | null = null;
  private readonly defaults = new Map<string, { at: number; id: string | null }>();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly s: () => Services, private readonly prefs: NotificationPrefs) {}

  private get db() {
    return this.s().db;
  }

  /** Whether migration 132 is applied; a negative answer is re-checked every 30 s, so applying it needs no restart. */
  async installed(): Promise<boolean> {
    const t = Date.now();
    if (this.schema && (this.schema.ok || t - this.schema.at < SCHEMA_RECHECK_MS)) return this.schema.ok;
    let ok: boolean;
    try {
      ok = (await this.db.schema.hasTable('notification_templates')) && (await this.db.schema.hasTable('notification_template_versions')) && (await this.db.schema.hasTable('notification_pref_origins'));
    } catch {
      ok = false;
    }
    this.schema = { ok, at: t };
    return ok;
  }

  /** Forgets the cached schema answer (tests apply the migration by hand). */
  resetSchemaCache(): void {
    this.schema = null;
    this.defaults.clear();
  }

  private async need(): Promise<void> {
    if (!(await this.installed())) throw notInstalled();
  }

  private bodyOf(r: { body: string }): TemplateBody {
    const b = json<Partial<TemplateBody>>(r.body, {});
    return { kinds: b.kinds ?? {}, quietHours: b.quietHours ?? null, urgentPassesQuiet: b.urgentPassesQuiet ?? null, digestHour: b.digestHour ?? null, digestWeekday: b.digestWeekday ?? null };
  }

  private out(r: TemplateRow) {
    const body = this.bodyOf(r);
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      version: Number(r.version),
      defaultForNewMembers: !!r.default_for_new,
      kinds: body.kinds,
      quietHours: body.quietHours,
      urgentPassesQuiet: body.urgentPassesQuiet,
      digestHour: body.digestHour,
      digestWeekday: body.digestWeekday,
      createdBy: r.created_by,
      updatedBy: r.updated_by,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at)
    };
  }

  private async row(tenantId: string, id: string): Promise<TemplateRow> {
    const r = (await this.db('notification_templates').where({ tenant_id: tenantId, id }).first()) as TemplateRow | undefined;
    if (!r) throw notFound('Notification template');
    return r;
  }

  /** The tenant's templates, and what a template can be applied to (the roles held and the groups in the tenant). */
  async list(tenantId: string) {
    if (!(await this.installed())) return { available: false, templates: [], targets: { roles: [], groups: [] } };
    const rows = (await this.db('notification_templates').where({ tenant_id: tenantId }).orderBy('name')) as TemplateRow[];
    const counts = (await this.db('notification_pref_origins').where({ tenant_id: tenantId }).groupBy('template_id').select('template_id').count({ n: '*' })) as { template_id: string; n: number | string }[];
    const people = new Map(counts.map((c) => [c.template_id, Number(c.n)]));
    const roles = ((await this.db('user_roles').join('users', 'users.id', 'user_roles.user_id').where('users.tenant_id', tenantId).distinct('user_roles.role').orderBy('user_roles.role')) as { role: string }[]).map((r) => r.role);
    let groups: { id: string; name: string }[];
    try {
      groups = (await this.db('social_groups').where({ tenant_id: tenantId }).whereNot('state', 'deleted').orderBy('name').limit(500).select('id', 'name')) as { id: string; name: string }[];
    } catch {
      groups = [];
    }
    return { available: true, templates: rows.map((r) => ({ ...this.out(r), people: people.get(r.id) ?? 0 })), targets: { roles, groups } };
  }

  async get(tenantId: string, id: string) {
    await this.need();
    const r = await this.row(tenantId, id);
    const versions = (await this.db('notification_template_versions').where({ tenant_id: tenantId, template_id: id }).orderBy('version', 'desc').select('version', 'name', 'created_by', 'created_at')) as { version: number; name: string; created_by: string | null; created_at: number | string }[];
    const people = Number(((await this.db('notification_pref_origins').where({ tenant_id: tenantId, template_id: id }).count({ n: '*' }).first()) as { n?: number | string } | undefined)?.n ?? 0);
    return { ...this.out(r), people, versions: versions.map((v) => ({ version: Number(v.version), name: v.name, createdBy: v.created_by, createdAt: Number(v.created_at) })) };
  }

  private async checkLocked(tenantId: string, kinds: Record<string, ChannelMap>): Promise<void> {
    const bad = lockedViolations(kinds, await this.prefs.tenantDefaults(tenantId));
    if (bad.length) throw mandatoryRefused(bad, 'a template cannot turn them off or hold them for a digest.');
  }

  private bodyFrom(input: { kinds?: Record<string, ChannelMap>; quietHours?: QuietHours | null; urgentPassesQuiet?: boolean | null; digestHour?: number | null; digestWeekday?: number | null }, base?: TemplateBody): TemplateBody {
    const kinds: Record<string, ChannelMap> = {};
    for (const [id, ch] of Object.entries(input.kinds ?? base?.kinds ?? {})) { const m = clean(ch); if (Object.keys(m).length) kinds[id] = m; }
    const quiet = input.quietHours !== undefined ? (input.quietHours ? quietOf(input.quietHours) : null) : (base?.quietHours ?? null);
    return {
      kinds,
      quietHours: quiet && Object.keys(quiet).length ? quiet : null,
      urgentPassesQuiet: input.urgentPassesQuiet !== undefined ? input.urgentPassesQuiet : (base?.urgentPassesQuiet ?? null),
      digestHour: input.digestHour !== undefined ? input.digestHour : (base?.digestHour ?? null),
      digestWeekday: input.digestWeekday !== undefined ? input.digestWeekday : (base?.digestWeekday ?? null)
    };
  }

  async create(admin: Principal, input: TemplateCreateInput, ctx: Ctx = {}) {
    await this.need();
    await this.checkLocked(admin.tenantId, input.kinds);
    const tenantId = admin.tenantId;
    if (await this.db('notification_templates').where({ tenant_id: tenantId, name: input.name }).first('id')) throw conflict(`A notification template named "${input.name}" already exists.`);
    const id = ulid();
    const t = Date.now();
    const body = this.bodyFrom(input);
    await this.db.transaction(async (trx) => {
      if (input.defaultForNewMembers) await trx('notification_templates').where({ tenant_id: tenantId }).update({ default_for_new: false });
      await trx('notification_templates').insert({ id, tenant_id: tenantId, name: input.name, description: input.description ?? null, version: 1, body: JSON.stringify(body), default_for_new: !!input.defaultForNewMembers, created_by: admin.userId, updated_by: admin.userId, created_at: t, updated_at: t });
      await trx('notification_template_versions').insert({ template_id: id, version: 1, tenant_id: tenantId, name: input.name, description: input.description ?? null, body: JSON.stringify(body), created_by: admin.userId, created_at: t });
    });
    this.defaults.delete(tenantId);
    await this.audit(tenantId, 'notification.template.created', actorFrom(admin, ctx.ip ?? null), id, { name: input.name, version: 1, kinds: Object.keys(body.kinds).length, defaultForNewMembers: !!input.defaultForNewMembers }, ctx);
    return this.get(tenantId, id);
  }

  async update(admin: Principal, id: string, input: TemplateUpdateInput, ctx: Ctx = {}) {
    await this.need();
    const tenantId = admin.tenantId;
    const cur = await this.row(tenantId, id);
    if (input.kinds) await this.checkLocked(tenantId, input.kinds);
    const name = input.name ?? cur.name;
    if (name !== cur.name && (await this.db('notification_templates').where({ tenant_id: tenantId, name }).whereNot({ id }).first('id'))) throw conflict(`A notification template named "${name}" already exists.`);
    const base = this.bodyOf(cur);
    const body = this.bodyFrom(input, base);
    const description = input.description !== undefined ? input.description : cur.description;
    const contentChanged = JSON.stringify(body) !== JSON.stringify(base) || name !== cur.name || (description ?? null) !== (cur.description ?? null);
    const version = Number(cur.version) + (contentChanged ? 1 : 0);
    const t = Date.now();
    await this.db.transaction(async (trx) => {
      if (input.defaultForNewMembers) await trx('notification_templates').where({ tenant_id: tenantId }).whereNot({ id }).update({ default_for_new: false });
      await trx('notification_templates').where({ tenant_id: tenantId, id }).update({ name, description: description ?? null, version, body: JSON.stringify(body), ...(input.defaultForNewMembers !== undefined ? { default_for_new: input.defaultForNewMembers } : {}), updated_by: admin.userId, updated_at: t });
      if (contentChanged) await trx('notification_template_versions').insert({ template_id: id, version, tenant_id: tenantId, name, description: description ?? null, body: JSON.stringify(body), created_by: admin.userId, created_at: t });
    });
    this.defaults.delete(tenantId);
    await this.audit(tenantId, 'notification.template.updated', actorFrom(admin, ctx.ip ?? null), id, { name, version, previousVersion: Number(cur.version), changed: Object.keys(input), ...(input.defaultForNewMembers !== undefined ? { defaultForNewMembers: input.defaultForNewMembers } : {}) }, ctx);
    return this.get(tenantId, id);
  }

  /** Deletes the template and its versions. People keep the preferences it wrote; their origin names it no more. */
  async remove(admin: Principal, id: string, ctx: Ctx = {}) {
    await this.need();
    const tenantId = admin.tenantId;
    const cur = await this.row(tenantId, id);
    let people = 0;
    await this.db.transaction(async (trx) => {
      await trx('notification_template_versions').where({ tenant_id: tenantId, template_id: id }).delete();
      people = Number(await trx('notification_pref_origins').where({ tenant_id: tenantId, template_id: id }).delete());
      await trx('notification_templates').where({ tenant_id: tenantId, id }).delete();
    });
    this.defaults.delete(tenantId);
    if (people) this.prefs.invalidate(tenantId);
    await this.audit(tenantId, 'notification.template.deleted', actorFrom(admin, ctx.ip ?? null), id, { name: cur.name, version: Number(cur.version), people }, ctx);
    return { deleted: true, id };
  }

  // ---------- applying ----------

  /** The people a target names, in the tenant only; unknown names are reported, never an error alone. */
  private async resolve(tenantId: string, target: TemplateApplyInput['target']): Promise<{ ids: string[]; unknown: string[] }> {
    if (target.kind === 'users') {
      const byId = target.userIds?.length ? ((await this.db('users').where({ tenant_id: tenantId }).whereIn('id', target.userIds).select('id')) as { id: string }[]).map((r) => r.id) : [];
      const names = (target.usernames ?? []).map((u) => u.toLowerCase());
      const byName = names.length ? ((await this.db('users').where({ tenant_id: tenantId }).whereIn('username', names).select('id', 'username')) as { id: string; username: string }[]) : [];
      const found = new Set([...byId, ...byName.map((r) => r.id)]);
      const unknown = [...(target.userIds ?? []).filter((x) => !byId.includes(x)), ...names.filter((n) => !byName.some((r) => r.username === n))];
      if (!found.size) throw badRequest('None of these people are in this tenant.', { unknown });
      return { ids: [...found], unknown };
    }
    if (target.kind === 'role') {
      const rows = (await this.db('user_roles').join('users', 'users.id', 'user_roles.user_id').where('users.tenant_id', tenantId).andWhere('users.state', 'active').andWhere('user_roles.role', target.role).distinct('users.id as id')) as { id: string }[];
      return { ids: rows.map((r) => r.id), unknown: [] };
    }
    if (target.kind === 'group') {
      const g = await this.db('social_groups').where({ tenant_id: tenantId, id: target.groupId }).whereNot('state', 'deleted').first('id');
      if (!g) throw notFound('Group');
      const rows = (await this.db('group_members').join('users', 'users.id', 'group_members.user_id').where({ 'group_members.tenant_id': tenantId, 'group_members.group_id': target.groupId }).andWhere('users.state', 'active').distinct('users.id as id')) as { id: string }[];
      return { ids: rows.map((r) => r.id), unknown: [] };
    }
    const rows = (await this.db('users').where({ tenant_id: tenantId, state: 'active' }).select('id')) as { id: string }[];
    return { ids: rows.map((r) => r.id), unknown: [] };
  }

  /**
   * Writes the template's choices as these people's own preferences (see the header for the two modes). Returns how
   * many people it reached, how many of them changed and how many kind choices changed in all.
   */
  private async write(tenantId: string, tpl: TemplateRow, userIds: string[], mode: TemplateMode, appliedBy: string | null, dryRun: boolean) {
    const body = this.bodyOf(tpl);
    const tenant = await this.prefs.tenantDefaults(tenantId);
    const skipped = Object.keys(body.kinds).filter((id) => kindById(id)?.locked || tenant.kinds.get(id)?.mandatory);
    const kinds = Object.fromEntries(Object.entries(body.kinds).filter(([id]) => !skipped.includes(id) && isKindId(id)));
    let changedPeople = 0;
    let changedKinds = 0;
    const t = Date.now();
    for (let i = 0; i < userIds.length; i += BATCH) {
      const batch = userIds.slice(i, i + BATCH);
      const [settings, rules] = await Promise.all([
        this.db('notification_prefs').where({ tenant_id: tenantId }).whereIn('user_id', batch) as Promise<Record<string, unknown>[]>,
        this.db('notification_pref_rules').where({ tenant_id: tenantId }).whereIn('user_id', batch) as Promise<{ user_id: string; kind: string; channels: string }[]>
      ]);
      const settingsOf = new Map(settings.map((r) => [String(r.user_id), r]));
      const plans: { userId: string; rules: Map<string, ChannelMap>; prefs: Record<string, unknown>; hadRow: boolean; writeRules: boolean; writePrefs: boolean }[] = [];
      for (const userId of batch) {
        const before = new Map<string, ChannelMap>(rules.filter((r) => r.user_id === userId).map((r) => [r.kind, clean(json<ChannelMap>(r.channels, {}))]));
        const row = settingsOf.get(userId);
        const curQuiet = quietOf(json<QuietHours>(row?.quiet ?? null, {}));
        const cur = { time_zone: (row?.time_zone as string | null) ?? null, quiet: curQuiet, quiet_urgent: row ? !!row.quiet_urgent : true, digest_hour: row ? Number(row.digest_hour) : 8, digest_weekday: row ? Number(row.digest_weekday) : 0 };
        const after = new Map<string, ChannelMap>(mode === 'fill' ? before : []);
        for (const [id, ch] of Object.entries(kinds)) if (mode === 'replace' || !before.has(id)) after.set(id, clean(ch));
        const next = { ...cur };
        if (mode === 'replace') {
          next.quiet = quietOf(body.quietHours);
          next.quiet_urgent = body.urgentPassesQuiet ?? true;
          next.digest_hour = body.digestHour ?? 8;
          next.digest_weekday = body.digestWeekday ?? 0;
        } else {
          if (!row) {
            if (body.urgentPassesQuiet != null) next.quiet_urgent = body.urgentPassesQuiet;
            if (body.digestHour != null) next.digest_hour = body.digestHour;
            if (body.digestWeekday != null) next.digest_weekday = body.digestWeekday;
          }
          if (!Object.keys(curQuiet).length && body.quietHours) next.quiet = quietOf(body.quietHours);
        }
        let kindsChanged = 0;
        for (const id of new Set([...before.keys(), ...after.keys()])) if (sig(before.get(id)) !== sig(after.get(id))) kindsChanged++;
        const prefsChanged = !sameQuiet(cur.quiet, next.quiet) || cur.quiet_urgent !== next.quiet_urgent || cur.digest_hour !== next.digest_hour || cur.digest_weekday !== next.digest_weekday;
        if (kindsChanged || prefsChanged) changedPeople++;
        changedKinds += kindsChanged;
        plans.push({ userId, rules: after, prefs: { time_zone: next.time_zone, quiet: JSON.stringify(next.quiet), quiet_urgent: next.quiet_urgent, digest_hour: next.digest_hour, digest_weekday: next.digest_weekday, updated_at: t }, hadRow: !!row, writeRules: kindsChanged > 0, writePrefs: prefsChanged || !row });
      }
      if (dryRun) continue;
      await this.db.transaction(async (trx) => {
        for (const p of plans) {
          if (p.writeRules) {
            await trx('notification_pref_rules').where({ tenant_id: tenantId, user_id: p.userId }).delete();
            const ins = [...p.rules].filter(([, m]) => Object.keys(m).length).map(([kind, m]) => ({ tenant_id: tenantId, user_id: p.userId, kind, channels: JSON.stringify(m), updated_at: t }));
            for (let j = 0; j < ins.length; j += 100) await trx('notification_pref_rules').insert(ins.slice(j, j + 100));
          }
          if (p.writePrefs) {
            if (p.hadRow) await trx('notification_prefs').where({ tenant_id: tenantId, user_id: p.userId }).update(p.prefs);
            else await trx('notification_prefs').insert({ tenant_id: tenantId, user_id: p.userId, ...p.prefs });
          }
          const snapshot = JSON.stringify(Object.fromEntries([...p.rules].filter(([, m]) => Object.keys(m).length)));
          const origin = { template_id: tpl.id, template_name: tpl.name, template_version: Number(tpl.version), mode, snapshot, applied_by: appliedBy, applied_at: t };
          const had = await trx('notification_pref_origins').where({ tenant_id: tenantId, user_id: p.userId }).first('user_id');
          if (had) await trx('notification_pref_origins').where({ tenant_id: tenantId, user_id: p.userId }).update(origin);
          else await trx('notification_pref_origins').insert({ tenant_id: tenantId, user_id: p.userId, ...origin });
        }
      });
    }
    if (!dryRun && userIds.length) this.prefs.invalidate(tenantId);
    return { people: userIds.length, changedPeople, changedKinds, skippedKinds: skipped };
  }

  async apply(admin: Principal, id: string, input: TemplateApplyInput, ctx: Ctx = {}) {
    await this.need();
    const tenantId = admin.tenantId;
    const tpl = await this.row(tenantId, id);
    const { ids, unknown } = await this.resolve(tenantId, input.target);
    const r = await this.write(tenantId, tpl, ids, input.mode, admin.userId, !!input.dryRun);
    const result = { template: { id: tpl.id, name: tpl.name, version: Number(tpl.version) }, mode: input.mode, dryRun: !!input.dryRun, target: input.target.kind, people: r.people, changedPeople: r.changedPeople, changedKinds: r.changedKinds, skippedKinds: r.skippedKinds, unknown };
    if (!input.dryRun) await this.audit(tenantId, 'notification.template.applied', actorFrom(admin, ctx.ip ?? null), id, { name: tpl.name, version: Number(tpl.version), mode: input.mode, target: input.target.kind, ...(input.target.kind === 'role' ? { role: input.target.role } : input.target.kind === 'group' ? { group: input.target.groupId } : {}), people: r.people, changedPeople: r.changedPeople, changedKinds: r.changedKinds, skippedKinds: r.skippedKinds, unknown: unknown.length }, ctx);
    return result;
  }

  // ---------- new members ----------

  private async defaultId(tenantId: string): Promise<string | null> {
    const hit = this.defaults.get(tenantId);
    if (hit && Date.now() - hit.at < DEFAULT_TTL_MS) return hit.id;
    if (!(await this.installed())) return null;
    const r = (await this.db('notification_templates').where({ tenant_id: tenantId }).andWhere('default_for_new', true).first('id')) as { id: string } | undefined;
    this.defaults.set(tenantId, { at: Date.now(), id: r?.id ?? null });
    return r?.id ?? null;
  }

  /** Called by `UserRepo.create` (after the transaction, if any, committed); fails soft and never delays sign-up. */
  onUserCreated(user: Pick<UserRow, 'id' | 'tenant_id'>): void {
    const p = this.applyDefault(user.tenant_id, user.id).catch((err: Error) => this.s().log.warn({ err: err.message, user: user.id }, 'default notification template not applied'));
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  async applyDefault(tenantId: string, userId: string): Promise<boolean> {
    const id = await this.defaultId(tenantId);
    if (!id) return false;
    const tpl = (await this.db('notification_templates').where({ tenant_id: tenantId, id }).first()) as TemplateRow | undefined;
    if (!tpl) return false;
    const r = await this.write(tenantId, tpl, [userId], 'fill', null, false);
    await this.audit(tenantId, 'notification.template.applied', { service: 'notification-templates' }, id, { name: tpl.name, version: Number(tpl.version), mode: 'fill', target: 'new-member', user: userId, people: 1, changedPeople: r.changedPeople, changedKinds: r.changedKinds, skippedKinds: r.skippedKinds }, {});
    return true;
  }

  /** Settles every default template being applied to a new member (tests, and shutdown). */
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  // ---------- the person's side ----------

  /** Where a person's preferences came from, and how many kinds they changed since; null without one. */
  async originFor(tenantId: string, userId: string, current: Map<string, ChannelMap>) {
    if (!(await this.installed())) return null;
    const r = (await this.db('notification_pref_origins').where({ tenant_id: tenantId, user_id: userId }).first()) as { template_id: string; template_name: string; template_version: number | string; mode: string; applied_at: number | string } & { snapshot: string } | undefined;
    if (!r) return null;
    const snap = json<Record<string, ChannelMap>>(r.snapshot, {});
    let changed = 0;
    for (const id of new Set([...Object.keys(snap), ...current.keys()])) if (NOTIFICATION_KINDS.some((k) => k.id === id) && sig(clean(snap[id])) !== sig(clean(current.get(id)))) changed++;
    const live = (await this.db('notification_templates').where({ tenant_id: tenantId, id: r.template_id }).first('version', 'name')) as { version: number | string; name: string } | undefined;
    return { id: r.template_id, name: r.template_name, version: Number(r.template_version), currentVersion: live ? Number(live.version) : null, mode: r.mode, appliedAt: Number(r.applied_at), changedKinds: changed };
  }

  /** A person going back to the defaults is no longer based on a template. */
  async forget(tenantId: string, userId: string): Promise<void> {
    if (!(await this.installed())) return;
    await this.db('notification_pref_origins').where({ tenant_id: tenantId, user_id: userId }).delete();
  }

  private async audit(tenantId: string, action: string, actor: AuditActor, id: string, detail: Record<string, unknown>, ctx: Ctx): Promise<void> {
    await this.s().audit.append({ tenantId, action, kind: actor.service ? 'system' : 'admin', actor, target: { notificationTemplate: id }, label: 'internal', detail, ...(ctx.traceId ? { traceId: ctx.traceId } : {}) });
  }
}
