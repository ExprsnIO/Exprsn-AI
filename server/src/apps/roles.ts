import { ulid } from 'ulid';
import { z } from 'zod';
import { actorFrom, isUniqueViolation } from '../audit/chain.js';
import type { Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import type { Subject } from './policies.js';
import type { Actor, AppRow, AppService } from './service.js';

/*
 * 1.8.0, Sprint 48 (B-143): app-local roles.
 *
 * Each app keeps its own role catalogue (Clerk, Approver, Viewer...): a name unique per app (without regard to case)
 * and an optional description. Row and field policies name a role with the subject `{ kind: 'app_role', value }`, and
 * `AppPolicies.grantFor` matches it against the roles the reader holds in the app:
 *
 * - directly (`user`), through a social group they count as a member of now (`group`, the answer of
 *   `s.groups.subjects`: no banned, suspended or departed member, within their clearance), or as a member of a
 *   workspace (`workspace`, the default role of everyone in it).
 *
 * An app role is only ever a policy subject. It grants nothing on its own: it widens nothing outside its app, does not
 * make the app visible to anyone (its workspace and group scope still decide that), and never passes the tenant's
 * permissions (`records:read`, `records:write` are still asked by the routes) or the reader's clearance (labels apply
 * before any policy). An entity without policies is open to every reader whatever roles they hold.
 *
 * The catalogue and the assignments are the app's designers' (`apps:design`, with the app's label within their
 * clearance, as for policies): no tenant administrator is needed, because what a role can do is bounded by the
 * policies the same designers write. Packages and promotions carry the catalogue, never the assignments, which belong
 * to each environment. Every change is audited `app.role.*`.
 */

export const ROLE_MEMBER_KINDS = ['user', 'group', 'workspace'] as const;
export type RoleMemberKind = (typeof ROLE_MEMBER_KINDS)[number];

export const roleNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u, 'letters, digits, spaces, _ . -, starting with a letter or digit');
export const roleInputSchema = z.object({ name: roleNameSchema, description: z.string().trim().max(500).nullable().optional() }).strict();
export const rolePatchSchema = z.object({ name: roleNameSchema.optional(), description: z.string().trim().max(500).nullable().optional() }).strict();
export const memberInputSchema = z
  .object({ kind: z.enum(ROLE_MEMBER_KINDS), id: z.string().length(26).optional(), username: z.string().trim().min(1).max(100).optional() })
  .strict()
  .refine((m) => m.id || (m.kind === 'user' && m.username), 'id (or, for a user, username)');
/** A role as a package carries it. */
export const rolePartSchema = z.object({ name: roleNameSchema, description: z.string().max(500).nullable() }).strict();

/** How a role is compared: the policy subject's value and the catalogue's name alike. */
export const roleKey = (name: string): string => name.trim().toLowerCase();

export interface AppRoleRow {
  id: string;
  tenant_id: string;
  app_id: string;
  name: string;
  name_key: string;
  description: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface RoleMemberRow {
  id: string;
  tenant_id: string;
  app_id: string;
  role_id: string;
  subject_kind: RoleMemberKind;
  subject_id: string;
  created_by: string | null;
  created_at: number;
}

/** A role the reader holds, and how. */
export interface HeldRole {
  key: string;
  name: string;
  via: { kind: RoleMemberKind; id: string }[];
}

const roleFrom = (r: Record<string, unknown>): AppRoleRow => ({ ...(r as unknown as AppRoleRow), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });
const memberFrom = (r: Record<string, unknown>): RoleMemberRow => ({ ...(r as unknown as RoleMemberRow), created_at: Number(r.created_at) });

/** Whether a policy's subjects name the role. */
export const namesRole = (subjects: Subject[], key: string): boolean => subjects.some((s) => s.kind === 'app_role' && !!s.value && roleKey(s.value) === key);

export class AppRoles {
  constructor(
    private readonly s: () => Services,
    private readonly apps: AppService
  ) {}

  private get db() {
    return this.s().db;
  }

  private audit(actor: Actor & { principal: Principal }, app: AppRow, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>) {
    return this.s().audit.append({ tenantId: app.tenant_id, action, kind: 'admin', actor: actorFrom(actor.principal, actor.ip ?? null), target: { app: app.id, ...target }, label: app.label, ...(detail ? { detail } : {}), traceId: actor.traceId ?? null });
  }

  // ---------- reading ----------

  async list(app: Pick<AppRow, 'id' | 'tenant_id'>): Promise<AppRoleRow[]> {
    return ((await this.db('app_roles').where({ tenant_id: app.tenant_id, app_id: app.id }).orderBy('name_key')) as Record<string, unknown>[]).map(roleFrom);
  }

  async get(app: Pick<AppRow, 'id' | 'tenant_id'>, id: string): Promise<AppRoleRow> {
    const r = (await this.db('app_roles').where({ tenant_id: app.tenant_id, app_id: app.id, id }).first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('App role');
    return roleFrom(r);
  }

  /** The role keys of an app's catalogue (for policy checks). */
  async keys(app: Pick<AppRow, 'id' | 'tenant_id'>): Promise<Set<string>> {
    return new Set(((await this.db('app_roles').where({ tenant_id: app.tenant_id, app_id: app.id }).select('name_key')) as { name_key: string }[]).map((r) => r.name_key));
  }

  async members(app: Pick<AppRow, 'id' | 'tenant_id'>, roleId?: string): Promise<RoleMemberRow[]> {
    const q = this.db('app_role_members').where({ tenant_id: app.tenant_id, app_id: app.id });
    if (roleId) q.andWhere({ role_id: roleId });
    return ((await q.orderBy('created_at')) as Record<string, unknown>[]).map(memberFrom);
  }

  /**
   * The roles a reader holds in an app: directly, through a social group they count as a member of now, or as a
   * member of a workspace. One query; the groups and workspaces come from the reader's policy facts.
   */
  async heldBy(app: Pick<AppRow, 'id' | 'tenant_id'>, who: { id: string; socialGroups?: string[]; workspaces: string[] }): Promise<HeldRole[]> {
    const groups = who.socialGroups ?? [];
    const rows = (await this.db('app_role_members as m')
      .join('app_roles as r', 'r.id', 'm.role_id')
      .where({ 'm.tenant_id': app.tenant_id, 'm.app_id': app.id })
      .andWhere((w) => {
        w.where((x) => x.where('m.subject_kind', 'user').andWhere('m.subject_id', who.id));
        if (groups.length) w.orWhere((x) => x.where('m.subject_kind', 'group').whereIn('m.subject_id', groups));
        if (who.workspaces.length) w.orWhere((x) => x.where('m.subject_kind', 'workspace').whereIn('m.subject_id', who.workspaces));
      })
      .select('r.name', 'r.name_key', 'm.subject_kind', 'm.subject_id')) as { name: string; name_key: string; subject_kind: RoleMemberKind; subject_id: string }[];
    const out = new Map<string, HeldRole>();
    for (const r of rows) {
      const h = out.get(r.name_key) ?? { key: r.name_key, name: r.name, via: [] };
      h.via.push({ kind: r.subject_kind, id: r.subject_id });
      out.set(r.name_key, h);
    }
    return [...out.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  }

  /** Names for the subjects of assignments (people, groups, workspaces), for lists and explain. */
  async subjectNames(tenantId: string, members: { subject_kind: RoleMemberKind; subject_id: string }[]): Promise<Map<string, string>> {
    const ids = (k: RoleMemberKind) => [...new Set(members.filter((m) => m.subject_kind === k).map((m) => m.subject_id))];
    const out = new Map<string, string>();
    const users = ids('user');
    if (users.length) for (const u of (await this.db('users').where({ tenant_id: tenantId }).whereIn('id', users).select('id', 'username', 'display_name')) as { id: string; username: string; display_name: string | null }[]) out.set(`user:${u.id}`, u.display_name ? `${u.display_name} (${u.username})` : u.username);
    const groups = ids('group');
    if (groups.length) for (const [id, name] of await this.s().groups.subjects.names(tenantId, groups)) out.set(`group:${id}`, name);
    const spaces = ids('workspace');
    if (spaces.length) for (const w of (await this.db('workspaces').where({ tenant_id: tenantId }).whereIn('id', spaces).select('id', 'name')) as { id: string; name: string }[]) out.set(`workspace:${w.id}`, w.name);
    return out;
  }

  /** "What can this role do": the policies naming it, each with its entity, rows and field grants. */
  async summary(app: AppRow, role: Pick<AppRoleRow, 'name_key'>) {
    return (await this.apps.policies.list(app))
      .filter(({ policy }) => namesRole(policy.subjects, role.name_key))
      .map(({ policy, entityName }) => ({ id: policy.id, name: policy.name, enabled: policy.enabled, entity: entityName, rows: policy.rows, fields: policy.fields, otherFields: policy.other_fields }));
  }

  /** The catalogue with each role's assignments (named) and what its policies let it do. */
  async view(app: AppRow) {
    const roles = await this.list(app);
    const members = await this.members(app);
    const names = await this.subjectNames(app.tenant_id, members);
    const out = [];
    for (const r of roles) {
      out.push({
        id: r.id,
        name: r.name,
        description: r.description,
        members: members.filter((m) => m.role_id === r.id).map((m) => ({ id: m.id, kind: m.subject_kind, subjectId: m.subject_id, name: names.get(`${m.subject_kind}:${m.subject_id}`) ?? null, createdBy: m.created_by, createdAt: m.created_at })),
        policies: await this.summary(app, r),
        createdBy: r.created_by,
        updatedBy: r.updated_by,
        createdAt: r.created_at,
        updatedAt: r.updated_at
      });
    }
    return out;
  }

  // ---------- the catalogue ----------

  async create(actor: Actor & { principal: Principal }, app: AppRow, input: z.infer<typeof roleInputSchema>): Promise<AppRoleRow> {
    const count = Number(((await this.db('app_roles').where({ app_id: app.id }).count({ n: '*' })) as Record<string, unknown>[])[0]?.n ?? 0);
    if (count >= 100) throw conflict('An app has at most 100 roles.');
    const t = Date.now();
    const row = { id: ulid(), tenant_id: app.tenant_id, app_id: app.id, name: input.name, name_key: roleKey(input.name), description: input.description ?? null, created_by: actor.principal.userId, updated_by: actor.principal.userId, created_at: t, updated_at: t };
    try {
      await this.db('app_roles').insert(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`The app already has a role named ${input.name}.`);
      throw err;
    }
    await this.audit(actor, app, 'app.role.created', { role: row.id }, { name: row.name });
    return row;
  }

  /** Renames or redescribes a role; a rename also renames it in the policies that name it, in one transaction. */
  async update(actor: Actor & { principal: Principal }, app: AppRow, id: string, patch: z.infer<typeof rolePatchSchema>): Promise<AppRoleRow> {
    const before = await this.get(app, id);
    const name = patch.name ?? before.name;
    const key = roleKey(name);
    const renamed = key !== before.name_key || name !== before.name;
    let policies = 0;
    try {
      await this.db.transaction(async (trx) => {
        await trx('app_roles').where({ id }).update({ name, name_key: key, ...(patch.description !== undefined ? { description: patch.description } : {}), updated_by: actor.principal.userId, updated_at: Date.now() });
        if (!renamed) return;
        const rows = (await trx('app_policies').where({ tenant_id: app.tenant_id, app_id: app.id }).select('id', 'subjects')) as { id: string; subjects: unknown }[];
        for (const r of rows) {
          const subjects = json<Subject[]>(r.subjects, []);
          if (!namesRole(subjects, before.name_key)) continue;
          const next = subjects.map((s) => (s.kind === 'app_role' && s.value && roleKey(s.value) === before.name_key ? { kind: 'app_role' as const, value: name } : s));
          await trx('app_policies').where({ id: r.id }).update({ subjects: JSON.stringify(next), updated_by: actor.principal.userId, updated_at: Date.now() });
          policies++;
        }
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`The app already has a role named ${name}.`);
      throw err;
    }
    await this.audit(actor, app, 'app.role.updated', { role: id }, { name, ...(renamed ? { from: before.name, policies } : {}), description: patch.description !== undefined });
    return this.get(app, id);
  }

  /** Deletes a role and its assignments. Refused while a policy names it: change the policy first. */
  async remove(actor: Actor & { principal: Principal }, app: AppRow, id: string): Promise<AppRoleRow> {
    const role = await this.get(app, id);
    const naming = (await this.summary(app, role)).map((p) => p.name);
    if (naming.length) throw new HttpProblem(409, 'Role in use', `The policies ${naming.join(', ')} name ${role.name}; take it out of them first.`, { extensions: { policies: naming } });
    let members = 0;
    await this.db.transaction(async (trx) => {
      members = Number(await trx('app_role_members').where({ role_id: id }).delete());
      await trx('app_roles').where({ id }).delete();
    });
    await this.audit(actor, app, 'app.role.deleted', { role: id }, { name: role.name, members });
    return role;
  }

  // ---------- assignments ----------

  /**
   * Gives a role to a person, a social group or a workspace's members. A person is a user of the tenant; a group one
   * the designer can see, in the app's workspace when the app has one; a workspace the app's own (a tenant-wide app:
   * any workspace of the tenant).
   */
  async assign(actor: Actor & { principal: Principal }, app: AppRow, roleId: string, input: z.infer<typeof memberInputSchema>): Promise<RoleMemberRow> {
    const p = actor.principal;
    const role = await this.get(app, roleId);
    const s = this.s();
    let subjectId: string;
    let subjectName: string;
    if (input.kind === 'user') {
      const u = input.id ? await s.users.get(app.tenant_id, input.id) : await s.users.byUsername(app.tenant_id, input.username!);
      if (!u) throw new HttpProblem(422, 'Unknown user', 'No user of this tenant has that id or username.', { extensions: { subject: input } });
      subjectId = u.id;
      subjectName = u.username;
    } else if (input.kind === 'group') {
      const g = await s.groups.subjects.subject(app.tenant_id, input.id!);
      const a = g ? await s.groups.accessOrNull(p, g.id) : null;
      if (!g || !a?.see) throw new HttpProblem(422, 'Unknown group', 'No group you can see has that id.', { extensions: { subject: input } });
      if (app.workspace_id && g.workspace_id !== app.workspace_id) throw forbidden(`${g.name} belongs to another workspace than the app.`, { step: 'workspace' });
      subjectId = g.id;
      subjectName = g.name;
    } else {
      const w = await s.tenants.workspace(app.tenant_id, input.id!);
      if (!w) throw new HttpProblem(422, 'Unknown workspace', 'No workspace of this tenant has that id.', { extensions: { subject: input } });
      if (app.workspace_id && w.id !== app.workspace_id) throw forbidden('A workspace app gives a default role only to its own workspace.', { step: 'workspace' });
      subjectId = w.id;
      subjectName = w.name;
    }
    const row: RoleMemberRow = { id: ulid(), tenant_id: app.tenant_id, app_id: app.id, role_id: role.id, subject_kind: input.kind, subject_id: subjectId, created_by: p.userId, created_at: Date.now() };
    try {
      await this.db('app_role_members').insert(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`${subjectName} already holds ${role.name}.`);
      throw err;
    }
    await this.audit(actor, app, 'app.role.assigned', { role: role.id, member: row.id, [input.kind]: subjectId }, { role: role.name, kind: input.kind, subject: subjectName });
    return row;
  }

  async unassign(actor: Actor & { principal: Principal }, app: AppRow, roleId: string, memberId: string): Promise<void> {
    const role = await this.get(app, roleId);
    const r = (await this.db('app_role_members').where({ tenant_id: app.tenant_id, app_id: app.id, role_id: role.id, id: memberId }).first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('Assignment');
    const m = memberFrom(r);
    await this.db('app_role_members').where({ id: m.id }).delete();
    await this.audit(actor, app, 'app.role.unassigned', { role: role.id, member: m.id, [m.subject_kind]: m.subject_id }, { role: role.name, kind: m.subject_kind });
  }

  /** People a designer may assign: active users of the app's workspace (of the tenant, for a tenant-wide app). */
  async candidates(app: AppRow, q: string | null, limit = 20): Promise<{ id: string; username: string; displayName: string }[]> {
    // `!` escapes the wildcards: one escape character every dialect reads the same (MySQL treats a backslash in a literal).
    const like = q ? `%${q.toLowerCase().replace(/[!%_]/g, (c) => `!${c}`)}%` : null;
    const query = this.db('users as u').where({ 'u.tenant_id': app.tenant_id, 'u.state': 'active' });
    if (app.workspace_id) query.whereIn('u.id', this.db('workspace_members').where({ workspace_id: app.workspace_id }).select('user_id'));
    if (like) query.andWhere((w) => w.whereRaw("lower(u.username) like ? escape '!'", [like]).orWhereRaw("lower(u.display_name) like ? escape '!'", [like]));
    const rows = (await query.orderBy('u.username').limit(limit).select('u.id', 'u.username', 'u.display_name')) as { id: string; username: string; display_name: string | null }[];
    return rows.map((r) => ({ id: r.id, username: r.username, displayName: r.display_name ?? r.username }));
  }

  // ---------- packages ----------

  /** The catalogue as a package carries it: names and descriptions, never who holds them. */
  async part(app: AppRow): Promise<z.infer<typeof rolePartSchema>[]> {
    return (await this.list(app)).map((r) => ({ name: r.name, description: r.description }));
  }

  /**
   * Makes the catalogue hold the package's roles: missing ones created, descriptions brought in line. Roles the package
   * no longer has are removed by `prune` once the policies were replaced (their assignments go with them).
   */
  async reconcile(actor: Actor & { principal: Principal }, app: AppRow, roles: z.infer<typeof rolePartSchema>[]): Promise<{ created: string[]; updated: string[] }> {
    const have = new Map((await this.list(app)).map((r) => [r.name_key, r]));
    const out = { created: [] as string[], updated: [] as string[] };
    for (const r of roles) {
      const cur = have.get(roleKey(r.name));
      if (!cur) {
        await this.create(actor, app, { name: r.name, description: r.description });
        out.created.push(r.name);
      } else if (cur.description !== r.description || cur.name !== r.name) {
        await this.update(actor, app, cur.id, { name: r.name, description: r.description });
        out.updated.push(r.name);
      }
    }
    return out;
  }

  async prune(actor: Actor & { principal: Principal }, app: AppRow, keep: z.infer<typeof rolePartSchema>[]): Promise<string[]> {
    const keys = new Set(keep.map((r) => roleKey(r.name)));
    const removed: string[] = [];
    for (const r of await this.list(app)) {
      if (keys.has(r.name_key)) continue;
      await this.remove(actor, app, r.id);
      removed.push(r.name);
    }
    return removed;
  }
}
