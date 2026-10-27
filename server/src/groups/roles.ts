import { ulid } from 'ulid';
import { actorFrom, isUniqueViolation } from '../audit/chain.js';
import { json } from '../db/knex.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { DmRole } from '../messaging/service.js';
import type { Services } from '../services.js';
import type { Access, Ctx, MemberRow } from './service.js';

/*
 * 1.7.0 (B-9705): what a member of a group may do, in one place.
 *
 * A membership has a tier (`group_members.role`): owner, admin, moderator, member or guest. Each tier carries a fixed
 * set of rights (`TIER_RIGHTS`); owner, moderator and member carry exactly what they carried before 1.7.0. A group may
 * also define custom roles (`group_roles`): a name and the rights it carries. A member who holds one
 * (`group_members.custom_role_id`, with the tier `member`) has that role's rights and `read`, nothing else: a custom
 * role with `events` and without `post` schedules events and cannot post.
 *
 * Every decision about a group reads the rights (`can`, `covers`, `ownsGroup`, `isStaff`), never the tier's name:
 *
 * - `can(access, right)`: the caller holds the right now (a suspended membership holds none; a holder of
 *   `groups:manage` and the owners of a channel's group hold all of them).
 * - `covers(holder, wanted)`: the rule for giving and taking. Nobody gives a role, an invitation or a custom role that
 *   carries a right they do not hold, and nobody changes, removes, bans or suspends a member who holds a right they do
 *   not. So nothing a person grants exceeds what they have, and nothing exceeds owner, which has every right.
 * - `ownsGroup(rights)`: the right `delete`, which only the owner tier carries (a custom role cannot).
 * - `isStaff(rights)`: more than a member's rights. Acting on staff takes the right `roles`, as acting on a moderator
 *   took an owner before.
 */

export const GROUP_ROLES = ['owner', 'admin', 'moderator', 'member', 'guest'] as const;
export type GroupRole = (typeof GROUP_ROLES)[number];

export const GROUP_RIGHTS = ['read', 'post', 'rsvp', 'invite', 'decide', 'remove-members', 'moderate', 'events', 'check-in', 'cases', 'channels', 'settings', 'roles', 'delete'] as const;
export type GroupRight = (typeof GROUP_RIGHTS)[number];
export type Rights = ReadonlySet<GroupRight>;

/** What each tier carries. owner, moderator and member are as they were before 1.7.0 (a test holds them to it). */
export const TIER_RIGHTS: Record<GroupRole, readonly GroupRight[]> = {
  guest: ['read', 'rsvp'],
  member: ['read', 'post', 'rsvp'],
  moderator: ['read', 'post', 'rsvp', 'invite', 'decide', 'remove-members', 'moderate', 'events', 'check-in', 'cases', 'channels'],
  admin: ['read', 'post', 'rsvp', 'invite', 'decide', 'remove-members', 'moderate', 'events', 'check-in', 'cases', 'channels', 'settings', 'roles'],
  owner: ['read', 'post', 'rsvp', 'invite', 'decide', 'remove-members', 'moderate', 'events', 'check-in', 'cases', 'channels', 'settings', 'roles', 'delete']
};

/** The rights a custom role may carry: every one but `read` (every member reads) and `delete` (the owners'). */
export const CUSTOM_RIGHTS = GROUP_RIGHTS.filter((r) => r !== 'read' && r !== 'delete');
export const MAX_CUSTOM_ROLES = 20;

/** What each right lets its holder do, for the console and the API's role list. */
export const RIGHT_LABELS: Record<GroupRight, string> = {
  read: 'Read the group',
  post: 'Post',
  rsvp: 'Answer events',
  invite: 'Invite people and make invite links',
  decide: 'Decide requests to join',
  'remove-members': 'Remove, suspend and ban members',
  moderate: 'Hide and delete posts',
  events: 'Create, change and cancel events, and write to attendees',
  'check-in': 'Check attendees in',
  cases: 'Work the group’s moderation cases',
  channels: 'Create channels',
  settings: 'Change the group’s settings',
  roles: 'Give roles and define custom roles',
  delete: 'Delete the group'
};

export const ALL_RIGHTS: Rights = new Set(GROUP_RIGHTS);
export const NO_RIGHTS: Rights = new Set<GroupRight>();
const MEMBER_RIGHTS: Rights = new Set(TIER_RIGHTS.member);

export const tierRights = (role: GroupRole | null | undefined): Rights => (role && TIER_RIGHTS[role] ? new Set(TIER_RIGHTS[role]) : NO_RIGHTS);
/** The caller holds the right in the group now. */
export const can = (a: Pick<Access, 'rights'> | null | undefined, right: GroupRight): boolean => !!a?.rights.has(right);
/** `holder` has every right in `wanted`. */
export const covers = (holder: Rights, wanted: Iterable<GroupRight>): boolean => [...wanted].every((r) => holder.has(r));
/** Owns the group: the one right only the owner tier carries. */
export const ownsGroup = (rights: Rights | null | undefined): boolean => !!rights?.has('delete');
/** Holds more than a member does. */
export const isStaff = (rights: Rights): boolean => [...rights].some((r) => !MEMBER_RIGHTS.has(r));
/** A member's role in the group's linked conversation (B-9709): owners own it, whoever moderates the group administers it. */
export const linkRole = (rights: Rights): DmRole => (ownsGroup(rights) ? 'owner' : rights.has('moderate') ? 'admin' : 'member');

export interface CustomRoleRow {
  id: string;
  tenant_id: string;
  group_id: string;
  name: string;
  name_key: string;
  rights: GroupRight[];
  created_by: string;
  created_at: number;
  updated_at: number;
}

const roleFrom = (r: Record<string, unknown>): CustomRoleRow => ({
  ...(r as unknown as CustomRoleRow),
  rights: json<string[]>(r.rights, []).filter((x): x is GroupRight => (CUSTOM_RIGHTS as readonly string[]).includes(x)),
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at)
});

/** A custom role's rights: what it names, and `read`. */
export const customRights = (role: Pick<CustomRoleRow, 'rights'>): Rights => new Set<GroupRight>(['read', ...role.rights]);

const roleView = (r: CustomRoleRow, members?: number) => ({ id: r.id, groupId: r.group_id, name: r.name, rights: [...customRights(r)], createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at, ...(members !== undefined ? { members } : {}) });

type Member = Pick<MemberRow, 'role' | 'custom_role_id'>;

export class GroupRoles {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  private async audit(ctx: Ctx, action: string, target: Record<string, unknown>, detail: Record<string, unknown>, label: Access['group']['label']): Promise<void> {
    await this.s().audit.append({ tenantId: ctx.p.tenantId, action, kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target, detail, label, traceId: ctx.traceId ?? null });
  }

  async row(groupId: string, id: string): Promise<CustomRoleRow | null> {
    const r = await this.db('group_roles').where({ group_id: groupId, id }).first();
    return r ? roleFrom(r) : null;
  }

  async forGroup(groupId: string): Promise<Map<string, CustomRoleRow>> {
    return new Map(((await this.db('group_roles').where({ group_id: groupId }).orderBy('name_key')) as Record<string, unknown>[]).map(roleFrom).map((r) => [r.id, r]));
  }

  /**
   * A membership's rights: its custom role's when it names one that exists, else its tier's. A custom role that is
   * gone leaves the tier (`member`), never more.
   */
  rightsFrom(m: Member, custom: Map<string, CustomRoleRow> | CustomRoleRow | null): Rights {
    const role = m.custom_role_id ? (custom instanceof Map ? custom.get(m.custom_role_id) : custom) : null;
    return role ? customRights(role) : tierRights(m.role);
  }

  async rightsOf(groupId: string, m: Member): Promise<Rights> {
    return this.rightsFrom(m, m.custom_role_id ? await this.row(groupId, m.custom_role_id) : null);
  }

  /** The rights of each of a group's members (suspensions are the caller's to apply). */
  async rightsOfAll(groupId: string): Promise<Map<string, Rights>> {
    const custom = await this.forGroup(groupId);
    const rows = (await this.db('group_members').where({ group_id: groupId }).select('user_id', 'role', 'custom_role_id')) as (Member & { user_id: string })[];
    return new Map(rows.map((m) => [m.user_id, this.rightsFrom(m, custom)]));
  }

  /** The members of a group who hold a right (suspensions and access are the caller's to apply). */
  async holders(groupId: string, right: GroupRight): Promise<string[]> {
    return [...(await this.rightsOfAll(groupId))].filter(([, r]) => r.has(right)).map(([u]) => u);
  }

  // ---------- the group's roles ----------

  /** The tiers and the group's custom roles, for whoever reads the group. */
  async list(a: Access) {
    const custom = [...(await this.forGroup(a.group.id)).values()];
    const counts = new Map(((await this.db('group_members').where({ group_id: a.group.id }).whereNotNull('custom_role_id').groupBy('custom_role_id').select('custom_role_id').count({ n: '*' })) as { custom_role_id: string; n: number | string }[]).map((r) => [r.custom_role_id, Number(r.n)]));
    return {
      tiers: GROUP_ROLES.map((role) => ({ role, rights: TIER_RIGHTS[role] })),
      rights: GROUP_RIGHTS.map((right) => ({ right, label: RIGHT_LABELS[right], custom: (CUSTOM_RIGHTS as readonly string[]).includes(right) })),
      custom: custom.map((r) => roleView(r, counts.get(r.id) ?? 0)),
      // What the caller may give: the rights they hold themselves.
      mine: [...a.rights],
      canManage: can(a, 'roles')
    };
  }

  private checkRights(a: Access, rights: readonly GroupRight[]): GroupRight[] {
    const wanted = [...new Set(rights)].filter((r) => r !== 'read');
    const bad = wanted.filter((r) => !(CUSTOM_RIGHTS as readonly string[]).includes(r));
    if (bad.length) throw new HttpProblem(422, 'Not a right of a custom role', `A custom role cannot carry ${bad.join(', ')}: deleting the group stays with its owners.`, { extensions: { step: 'rights', rights: bad } });
    const beyond = wanted.filter((r) => !a.rights.has(r));
    if (beyond.length) throw forbidden(`You cannot give a role rights you do not hold yourself (${beyond.join(', ')}).`, { step: 'group-role', rights: beyond });
    return GROUP_RIGHTS.filter((r) => (wanted as readonly string[]).includes(r));
  }

  async create(ctx: Ctx, a: Access, input: { name: string; rights: GroupRight[] }) {
    const g = a.group;
    const rights = this.checkRights(a, input.rights);
    const n = Number(((await this.db('group_roles').where({ group_id: g.id }).count({ n: '*' })) as { n: number | string }[])[0]?.n ?? 0);
    if (n >= MAX_CUSTOM_ROLES) throw conflict(`A group has at most ${MAX_CUSTOM_ROLES} custom roles.`);
    const name = input.name.trim();
    if ((GROUP_ROLES as readonly string[]).includes(name.toLowerCase())) throw conflict(`${name} is the name of a built-in role.`);
    const t = Date.now();
    const row: CustomRoleRow = { id: ulid(), tenant_id: g.tenant_id, group_id: g.id, name, name_key: name.toLowerCase(), rights, created_by: ctx.p.userId, created_at: t, updated_at: t };
    try {
      await this.db('group_roles').insert({ ...row, rights: JSON.stringify(rights) });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`This group already has a role named ${name}.`);
      throw err;
    }
    await this.audit(ctx, 'group.role.created', { group: g.id, role: row.id }, { name, rights }, g.label);
    return roleView(row, 0);
  }

  private async load(a: Access, roleId: string): Promise<CustomRoleRow> {
    const r = await this.row(a.group.id, roleId);
    if (!r) throw notFound('Role');
    return r;
  }

  /** The caller's own custom role in the group, if any: a role is never changed by someone who holds it. */
  private async held(a: Access, userId: string): Promise<string | null> {
    const m = (await this.db('group_members').where({ group_id: a.group.id, user_id: userId }).first('custom_role_id')) as { custom_role_id: string | null } | undefined;
    return m?.custom_role_id ?? null;
  }

  async update(ctx: Ctx, a: Access, roleId: string, patch: { name?: string | undefined; rights?: GroupRight[] | undefined }) {
    const g = a.group;
    const r = await this.load(a, roleId);
    if ((await this.held(a, ctx.p.userId)) === r.id) throw forbidden('You hold this role: someone else changes it.', { step: 'self-grant' });
    // Nobody takes rights from, or adds rights to, a role that carries more than they hold.
    if (!covers(a.rights, customRights(r))) throw forbidden('This role carries rights you do not hold; you cannot change it.', { step: 'group-role' });
    const rights = patch.rights !== undefined ? this.checkRights(a, patch.rights) : r.rights;
    const name = patch.name !== undefined ? patch.name.trim() : r.name;
    if ((GROUP_ROLES as readonly string[]).includes(name.toLowerCase())) throw conflict(`${name} is the name of a built-in role.`);
    try {
      await this.db('group_roles').where({ id: r.id }).update({ name, name_key: name.toLowerCase(), rights: JSON.stringify(rights), updated_at: Date.now() });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`This group already has a role named ${name}.`);
      throw err;
    }
    const after = (await this.row(g.id, r.id))!;
    const members = ((await this.db('group_members').where({ group_id: g.id, custom_role_id: r.id }).select('user_id')) as { user_id: string }[]).map((m) => m.user_id);
    await this.audit(ctx, 'group.role.updated', { group: g.id, role: r.id }, { before: { name: r.name, rights: r.rights }, after: { name: after.name, rights: after.rights }, members: members.length }, g.label);
    // What its holders may see or do in the room and in the linked conversation follows at once.
    if (members.length) this.s().rooms.accessChanged({ tenantId: g.tenant_id, kind: 'group', id: g.id, userIds: members });
    this.s().groups.room(g, 'group.role.updated', { roleId: r.id });
    return roleView(after, members.length);
  }

  /** Removes a custom role; its holders stay in the group as members. */
  async remove(ctx: Ctx, a: Access, roleId: string) {
    const g = a.group;
    const r = await this.load(a, roleId);
    if (!covers(a.rights, customRights(r))) throw forbidden('This role carries rights you do not hold; you cannot remove it.', { step: 'group-role' });
    const members = ((await this.db('group_members').where({ group_id: g.id, custom_role_id: r.id }).select('user_id')) as { user_id: string }[]).map((m) => m.user_id);
    await this.db.transaction(async (trx) => {
      await trx('group_members').where({ group_id: g.id, custom_role_id: r.id }).update({ custom_role_id: null, role: 'member' });
      await trx('group_roles').where({ id: r.id }).delete();
    });
    await this.audit(ctx, 'group.role.removed', { group: g.id, role: r.id }, { name: r.name, rights: r.rights, members: members.length, membersNow: 'member' }, g.label);
    if (members.length) this.s().rooms.accessChanged({ tenantId: g.tenant_id, kind: 'group', id: g.id, userIds: members });
    this.s().groups.room(g, 'group.role.updated', { roleId: r.id, removed: true });
    return { id: r.id, removed: true as const, members: members.length };
  }
}
