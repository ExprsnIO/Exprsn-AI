import { ulid } from 'ulid';
import { actorFrom, isUniqueViolation } from '../audit/chain.js';
import { clears, isLabel, labelRank, type Label } from '../authz/labels.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { loadPrincipal, workspacesFor } from '../http/middleware.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { flagRef } from '../guardrails/flags.js';
import type { ModeratedObject } from '../moderation/registry.js';
import { TOPICS, type IntegrationEvent } from '../platform/bus.js';
import type { Services } from '../services.js';

/*
 * Groups (B-2501) and group posts with their moderation (B-2505). A group lives inside one workspace, and workspace
 * membership stays the outer boundary: every check starts from the workspaces the caller may act in now, so a user
 * who leaves the workspace loses its groups at once, whatever their group role. Inside it:
 *
 * - visibility: public groups are listed and readable by everyone in the workspace (joining is still needed to post);
 *   private groups are listed but their content is for members; hidden groups are known only to members, invitees
 *   and managers. A group's label is the highest label of its content: nobody below it sees the content or joins.
 * - join modes: open (join at once), request (a moderator accepts), invite (only by invitation). Requests and
 *   invitations expire (GROUP_REQUEST_DAYS, GROUP_INVITE_DAYS).
 * - roles: owner (settings, roles, delete), moderator (requests, invitations, members, posts, events, check-in, cases),
 *   member (post, RSVP). Holders of `groups:manage` act as owner on every group in the workspaces they may act in.
 */

export const GROUP_ROLES = ['owner', 'moderator', 'member'] as const;
export type GroupRole = (typeof GROUP_ROLES)[number];
export const VISIBILITIES = ['public', 'private', 'hidden'] as const;
export type Visibility = (typeof VISIBILITIES)[number];
export const JOIN_MODES = ['open', 'request', 'invite'] as const;
export type JoinMode = (typeof JOIN_MODES)[number];

/** What each role may do; a role includes the rights of those below it. */
export type GroupRight = 'read' | 'post' | 'rsvp' | 'invite' | 'decide' | 'remove-members' | 'moderate' | 'events' | 'check-in' | 'cases' | 'settings' | 'roles' | 'delete';
const RIGHTS: Record<GroupRole, readonly GroupRight[]> = {
  member: ['read', 'post', 'rsvp'],
  moderator: ['read', 'post', 'rsvp', 'invite', 'decide', 'remove-members', 'moderate', 'events', 'check-in', 'cases'],
  owner: ['read', 'post', 'rsvp', 'invite', 'decide', 'remove-members', 'moderate', 'events', 'check-in', 'cases', 'settings', 'roles', 'delete']
};
export const roleHas = (role: GroupRole | null, right: GroupRight): boolean => !!role && RIGHTS[role].includes(right);

export const GROUP_OBJECT = 'group';
export const POST_OBJECT = 'group-post';
export const EVENT_OBJECT = 'group-event';

export interface GroupRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  visibility: Visibility;
  join_mode: JoinMode;
  label: Label;
  /** 1.6.0 (B-4206): `archived` is read only: members keep reading, nothing new is posted, joined or scheduled. */
  state: 'active' | 'hidden' | 'archived' | 'deleted';
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface MemberRow {
  group_id: string;
  tenant_id: string;
  user_id: string;
  role: GroupRole;
  added_by: string | null;
  joined_at: number;
}

export interface RequestRow {
  id: string;
  tenant_id: string;
  group_id: string;
  user_id: string;
  kind: 'request' | 'invite';
  role: GroupRole;
  state: 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired';
  pending_key: string | null;
  created_by: string;
  created_at: number;
  expires_at: number;
  decided_by: string | null;
  decided_at: number | null;
}

export interface PostRow {
  id: string;
  tenant_id: string;
  group_id: string;
  workspace_id: string;
  author_id: string;
  body: string;
  label: Label;
  state: 'published' | 'hidden' | 'deleted';
  created_at: number;
  updated_at: number;
}

/** Who is acting: the principal, the address and the request's trace id (for the audit chain). */
export interface Ctx {
  p: Principal;
  ip: string | null;
  traceId?: string | null;
}

/** The caller's standing in a group, decided now. */
export interface Access {
  group: GroupRow;
  /** The caller's own membership role. */
  role: GroupRole | null;
  /** Holds `groups:manage` in the group's workspace (acts as owner). */
  manager: boolean;
  /** The role the caller acts with: their own, or owner for a manager. */
  acting: GroupRole | null;
  /** May know the group exists. */
  see: boolean;
  /** May read its content (posts, events, members). */
  read: boolean;
}

const num = (v: unknown) => Number(v);
const groupFrom = (r: Record<string, unknown>): GroupRow => ({ ...(r as unknown as GroupRow), label: isLabel(r.label) ? r.label : 'internal', created_at: num(r.created_at), updated_at: num(r.updated_at) });
const memberFrom = (r: Record<string, unknown>): MemberRow => ({ ...(r as unknown as MemberRow), joined_at: num(r.joined_at) });
const requestFrom = (r: Record<string, unknown>): RequestRow => ({ ...(r as unknown as RequestRow), created_at: num(r.created_at), expires_at: num(r.expires_at), decided_at: r.decided_at == null ? null : num(r.decided_at) });
const postFrom = (r: Record<string, unknown>): PostRow => ({ ...(r as unknown as PostRow), label: isLabel(r.label) ? r.label : 'internal', created_at: num(r.created_at), updated_at: num(r.updated_at) });

export const groupView = (g: GroupRow, description: string | null, a?: Pick<Access, 'role' | 'acting' | 'read'>, counts?: { members: number }) => ({
  id: g.id,
  workspaceId: g.workspace_id,
  name: g.name,
  description: a && !a.read ? null : description,
  visibility: g.visibility,
  joinMode: g.join_mode,
  label: g.label,
  state: g.state,
  createdBy: g.created_by,
  createdAt: g.created_at,
  updatedAt: g.updated_at,
  ...(a ? { role: a.role, actingRole: a.acting } : {}),
  ...(counts ? { members: counts.members } : {})
});

export const requestView = (r: RequestRow, extra: { groupName?: string; userName?: string | null } = {}) => ({
  id: r.id,
  groupId: r.group_id,
  userId: r.user_id,
  kind: r.kind,
  role: r.role,
  state: r.state,
  createdBy: r.created_by,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  decidedBy: r.decided_by,
  decidedAt: r.decided_at,
  ...(extra.groupName !== undefined ? { groupName: extra.groupName } : {}),
  ...(extra.userName !== undefined ? { userName: extra.userName } : {})
});

export class GroupService {
  private started = false;

  constructor(
    private readonly s: () => Services,
    private readonly o: { inviteDays: number; requestDays: number }
  ) {}

  private get db() {
    return this.s().db;
  }

  // ---------- wiring ----------

  /** Registers the group room authoriser (B-2101) and the moderated object types (B-2505). */
  init(): void {
    if (this.started) return;
    this.started = true;
    const s = this.s();
    s.rooms.register('group', async (p, id) => {
      const a = await this.accessOrNull(p, id);
      return a?.read ? { label: a.group.label, workspaceId: a.group.workspace_id } : null;
    });
    this.registerModeration();
  }

  private async audit(ctx: Ctx, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>, label?: Label): Promise<void> {
    await this.s().audit.append({ tenantId: ctx.p.tenantId, action, kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target, ...(detail ? { detail } : {}), ...(label ? { label } : {}), traceId: ctx.traceId ?? null });
  }

  /** A named catalogue event (B-2001) for webhooks and plugins on this instance. */
  event(tenantId: string, type: string, label: Label, data: Record<string, unknown>): void {
    this.s().bus.emitLocal(TOPICS.integrationEvent, { tenantId, type, label, id: `${type}:${ulid()}`, data } satisfies IntegrationEvent);
  }

  /** Publishes into the group's realtime room on every instance (event names start with `group.`). */
  room(g: Pick<GroupRow, 'tenant_id' | 'id'>, event: string, data: Record<string, unknown>, exceptUserId?: string): void {
    this.s().rooms.emit({ tenantId: g.tenant_id, kind: 'group', id: g.id, event, data, ...(exceptUserId ? { exceptUserId } : {}) });
  }

  async openDescription(g: GroupRow): Promise<string | null> {
    return g.description ? ((await this.s().keys.open(g.tenant_id, g.description, `group:${g.id}`)) ?? null) : null;
  }

  // ---------- access ----------

  async row(tenantId: string, id: string): Promise<GroupRow | null> {
    const r = await this.db('social_groups').where({ tenant_id: tenantId, id }).first();
    return r ? groupFrom(r) : null;
  }

  async member(groupId: string, userId: string): Promise<MemberRow | null> {
    const r = await this.db('group_members').where({ group_id: groupId, user_id: userId }).first();
    return r ? memberFrom(r) : null;
  }

  /** The workspaces the principal may act in now. */
  async workspaceIds(p: Principal): Promise<string[]> {
    return (await workspacesFor(this.s(), p)).map((w) => w.id);
  }

  /** The caller's standing in a group, or null when they may not know it exists (outside its workspace, deleted…). */
  async accessOrNull(p: Principal, id: string, workspaces?: string[]): Promise<Access | null> {
    const g = await this.row(p.tenantId, id);
    if (!g || g.state === 'deleted') return null;
    const ws = workspaces ?? (await this.workspaceIds(p));
    // The outer boundary: nothing of a group is visible outside its workspace.
    if (!ws.includes(g.workspace_id)) return null;
    const manager = effectivePermissions(p).has('groups:manage');
    const m = await this.member(g.id, p.userId);
    const role = m?.role ?? null;
    const acting: GroupRole | null = manager ? 'owner' : role;
    const cleared = clears(p.clearance, g.label);
    // A group hidden by moderation is known only to managers and its owners.
    if (g.state === 'hidden' && !manager && role !== 'owner') return null;
    let see = manager || !!role || (g.visibility !== 'hidden' && cleared);
    if (!see && g.visibility === 'hidden') see = !!(await this.pendingFor(g.id, p.userId, 'invite'));
    if (!see) return null;
    const read = cleared && (manager || !!role || g.visibility === 'public');
    return { group: g, role, manager, acting, see, read };
  }

  async access(p: Principal, id: string): Promise<Access> {
    const a = await this.accessOrNull(p, id);
    if (!a) throw notFound('Group');
    return a;
  }

  /**
   * Access with a right (by the acting role); a reader without it gets 403, anyone else 404. `reading` marks a call that
   * only lists what the right shows (requests, cases, invite candidates), which an archived group still answers.
   */
  async require(p: Principal, id: string, right: GroupRight, opts: { reading?: boolean } = {}): Promise<Access> {
    const a = await this.access(p, id);
    if (right === 'read') {
      if (!a.read) throw forbidden(clears(p.clearance, a.group.label) ? 'Join the group to see its content.' : `The group is labelled ${a.group.label}, above your clearance of ${p.clearance}.`, { step: clears(p.clearance, a.group.label) ? 'group' : 'clearance' });
      return a;
    }
    if (!a.read || !roleHas(a.acting, right)) throw forbidden(a.acting ? `Your role in this group (${a.acting}) does not allow this.` : 'Join the group first.', { step: 'group-role', right });
    // 1.6.0 (B-4206): an archived group is read only; its owners may still delete it.
    if (a.group.state === 'archived' && right !== 'delete' && !opts.reading) throw conflict('The group is archived; it is read only.');
    return a;
  }

  private async pendingFor(groupId: string, userId: string, kind?: RequestRow['kind']): Promise<RequestRow | null> {
    const r = await this.db('group_requests').where({ group_id: groupId, user_id: userId, state: 'pending' }).modify((q) => (kind ? q.andWhere({ kind }) : q)).first();
    if (!r) return null;
    const row = requestFrom(r);
    if (row.expires_at <= Date.now()) {
      await this.expire(row);
      return null;
    }
    return row;
  }

  private async expire(r: RequestRow): Promise<void> {
    await this.db('group_requests').where({ id: r.id, state: 'pending' }).update({ state: 'expired', pending_key: null, decided_at: Date.now() });
  }

  /** Is this user (not the caller) in the group's workspace now, and cleared for its label? */
  private async eligible(g: GroupRow, userId: string): Promise<{ ok: true } | { ok: false; why: string }> {
    const s = this.s();
    // As the user would be on their next request: active, not sanctioned, and the workspaces they may act in now.
    const p = await loadPrincipal(s, g.tenant_id, userId, {});
    if (!p) return { ok: false, why: 'There is no active user with that id in this tenant.' };
    if (!(await this.workspaceIds(p)).includes(g.workspace_id)) return { ok: false, why: 'The user is not a member of the group’s workspace.' };
    if (!clears(p.clearance, g.label)) return { ok: false, why: `The user is not cleared for ${g.label}.` };
    return { ok: true };
  }

  // ---------- groups ----------

  async list(p: Principal, q: { workspaceId?: string | null; mine?: boolean }) {
    const ws = await this.workspaceIds(p);
    const scope = q.workspaceId ? ws.filter((w) => w === q.workspaceId) : ws;
    if (!scope.length) return [];
    const manager = effectivePermissions(p).has('groups:manage');
    const memberships = new Map(((await this.db('group_members').where({ tenant_id: p.tenantId, user_id: p.userId }).select('group_id', 'role')) as { group_id: string; role: GroupRole }[]).map((m) => [m.group_id, m.role]));
    const invited = new Set(((await this.db('group_requests').where({ tenant_id: p.tenantId, user_id: p.userId, kind: 'invite', state: 'pending' }).andWhere('expires_at', '>', Date.now()).select('group_id')) as { group_id: string }[]).map((r) => r.group_id));
    const rows = ((await this.db('social_groups').where({ tenant_id: p.tenantId }).whereIn('workspace_id', scope).whereNot({ state: 'deleted' }).orderBy('name')) as Record<string, unknown>[]).map(groupFrom);
    const counts = await this.memberCounts(rows.map((g) => g.id));
    const out = [];
    for (const g of rows) {
      const role = memberships.get(g.id) ?? null;
      if (q.mine && !role) continue;
      if (g.state === 'hidden' && !manager && role !== 'owner') continue;
      const cleared = clears(p.clearance, g.label);
      const see = manager || !!role || (g.visibility !== 'hidden' && cleared) || (g.visibility === 'hidden' && invited.has(g.id));
      if (!see) continue;
      const read = cleared && (manager || !!role || g.visibility === 'public');
      out.push(groupView(g, read ? await this.openDescription(g) : null, { role, acting: manager ? 'owner' : role, read }, { members: counts.get(g.id) ?? 0 }));
    }
    return out;
  }

  private async memberCounts(ids: string[]): Promise<Map<string, number>> {
    if (!ids.length) return new Map();
    const rows = (await this.db('group_members').whereIn('group_id', ids).groupBy('group_id').select('group_id').count({ n: '*' })) as { group_id: string; n: number | string }[];
    return new Map(rows.map((r) => [r.group_id, Number(r.n)]));
  }

  async view(p: Principal, id: string) {
    const a = await this.access(p, id);
    const counts = await this.memberCounts([id]);
    return groupView(a.group, a.read ? await this.openDescription(a.group) : null, a, { members: counts.get(id) ?? 0 });
  }

  async create(ctx: Ctx, input: { workspaceId?: string | null | undefined; name: string; description?: string | null | undefined; visibility?: Visibility | undefined; joinMode?: JoinMode | undefined; label?: Label | undefined }) {
    const s = this.s();
    const p = ctx.p;
    const wsId = input.workspaceId ?? p.workspaceId ?? null;
    if (!wsId) throw new HttpProblem(422, 'No workspace', 'Name the workspace the group belongs to.');
    const w = (await workspacesFor(s, p)).find((x) => x.id === wsId);
    if (!w) throw notFound('Workspace');
    // 1.6.0 (B-4206): the workspace's group defaults and who may create groups there (Social and messaging).
    const pol = await s.socialAdmin.policy(p.tenantId, w.id);
    const perms = effectivePermissions(p);
    if (pol.groupCreate === 'admins' && !perms.has('groups:manage') && !perms.has('social:manage')) throw forbidden('In this workspace only admins create groups.', { step: 'workspace-policy' });
    input = { ...input, visibility: input.visibility ?? pol.groupVisibility, joinMode: input.joinMode ?? pol.groupJoin };
    const label = input.label ?? (labelRank(w.label_ceiling) < labelRank('internal') ? w.label_ceiling : 'internal');
    if (labelRank(label) > labelRank(w.label_ceiling)) throw new HttpProblem(422, 'Label above the workspace ceiling', `The workspace allows content up to ${w.label_ceiling}.`);
    if (!clears(p.clearance, label)) throw forbidden(`You are not cleared for ${label}.`, { step: 'clearance' });
    const id = ulid();
    const t = Date.now();
    const row: GroupRow = { id, tenant_id: p.tenantId, workspace_id: w.id, name: input.name, description: input.description ? await s.keys.seal(p.tenantId, input.description, `group:${id}`) : null, visibility: input.visibility!, join_mode: input.joinMode!, label, state: 'active', created_by: p.userId, created_at: t, updated_at: t };
    await s.db.transaction(async (trx) => {
      await trx('social_groups').insert(row);
      await trx('group_members').insert({ group_id: id, tenant_id: p.tenantId, user_id: p.userId, role: 'owner', added_by: p.userId, joined_at: t });
    });
    await this.audit(ctx, 'group.created', { group: id, workspace: w.id }, { name: row.name, visibility: row.visibility, joinMode: row.join_mode }, label);
    this.event(p.tenantId, 'group.created', label, { group: id, workspace: w.id, actor: p.userId });
    this.event(p.tenantId, 'group.member.added', label, { group: id, workspace: w.id, actor: p.userId, user: p.userId, role: 'owner' });
    return groupView(row, input.description ?? null, { role: 'owner', acting: 'owner', read: true }, { members: 1 });
  }

  async update(ctx: Ctx, id: string, patch: { name?: string | undefined; description?: string | null | undefined; visibility?: Visibility | undefined; joinMode?: JoinMode | undefined; label?: Label | undefined }) {
    const s = this.s();
    const a = await this.require(ctx.p, id, 'settings');
    const g = a.group;
    const upd: Record<string, unknown> = { updated_at: Date.now() };
    if (patch.name !== undefined) upd.name = patch.name;
    if (patch.description !== undefined) upd.description = patch.description ? await s.keys.seal(g.tenant_id, patch.description, `group:${g.id}`) : null;
    if (patch.visibility !== undefined) upd.visibility = patch.visibility;
    if (patch.joinMode !== undefined) upd.join_mode = patch.joinMode;
    if (patch.label !== undefined) {
      const w = await s.tenants.workspace(g.tenant_id, g.workspace_id);
      if (w && labelRank(patch.label) > labelRank(w.label_ceiling)) throw new HttpProblem(422, 'Label above the workspace ceiling', `The workspace allows content up to ${w.label_ceiling}.`);
      if (!clears(ctx.p.clearance, patch.label)) throw forbidden(`You are not cleared for ${patch.label}.`, { step: 'clearance' });
      // Posts carry the group's label: raising it raises theirs (never lowers what was written under a higher one).
      if (labelRank(patch.label) > labelRank(g.label)) {
        await s.db('group_posts').where({ group_id: g.id }).update({ label: patch.label });
        await s.db('group_events').where({ group_id: g.id }).update({ label: patch.label });
      }
      upd.label = patch.label;
    }
    await s.db('social_groups').where({ id: g.id }).update(upd);
    const after = (await this.row(g.tenant_id, g.id))!;
    const changed = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
    await this.audit(ctx, 'group.updated', { group: g.id, workspace: g.workspace_id }, { changed, before: { name: g.name, visibility: g.visibility, joinMode: g.join_mode, label: g.label }, after: { name: after.name, visibility: after.visibility, joinMode: after.join_mode, label: after.label } }, after.label);
    this.event(g.tenant_id, 'group.updated', after.label, { group: g.id, workspace: g.workspace_id, actor: ctx.p.userId });
    // Who may be in the room can change with the visibility or label: everyone there is checked again.
    if (patch.visibility !== undefined || patch.label !== undefined) s.rooms.accessChanged({ tenantId: g.tenant_id, kind: 'group', id: g.id, ...(patch.label ? { label: patch.label } : {}) });
    this.room(after, 'group.updated', { name: after.name, visibility: after.visibility, joinMode: after.join_mode, label: after.label });
    return groupView(after, await this.openDescription(after), a);
  }

  async remove(ctx: Ctx, id: string) {
    const s = this.s();
    const a = await this.require(ctx.p, id, 'delete');
    const g = a.group;
    await s.db('social_groups').where({ id: g.id }).update({ state: 'deleted', updated_at: Date.now() });
    await s.db('group_requests').where({ group_id: g.id, state: 'pending' }).update({ state: 'cancelled', pending_key: null, decided_by: ctx.p.userId, decided_at: Date.now() });
    const cancelled = await s.calendar.cancelRemindersForGroup(g.tenant_id, g.id);
    await this.audit(ctx, 'group.deleted', { group: g.id, workspace: g.workspace_id }, { name: g.name, remindersCancelled: cancelled }, g.label);
    this.event(g.tenant_id, 'group.deleted', g.label, { group: g.id, workspace: g.workspace_id, actor: ctx.p.userId });
    s.rooms.accessChanged({ tenantId: g.tenant_id, kind: 'group', id: g.id });
    return { id: g.id, state: 'deleted' as const };
  }

  // ---------- administration (1.6.0, B-4206: Social and messaging) ----------

  /**
   * A group as an administrator holding social:manage sees it: in a workspace they may act in, at a label they are
   * cleared for (else 404, as if it did not exist). Hidden and archived groups included; deleted ones are gone.
   */
  async adminRow(p: Principal, id: string): Promise<GroupRow> {
    const g = await this.row(p.tenantId, id);
    if (!g || g.state === 'deleted' || !clears(p.clearance, g.label) || !(await this.workspaceIds(p)).includes(g.workspace_id)) throw notFound('Group');
    return g;
  }

  /** Makes `userId` (a member) the owner; the previous owners become moderators. The members are told. */
  async transferOwnership(ctx: Ctx, id: string, userId: string) {
    const s = this.s();
    const g = await this.adminRow(ctx.p, id);
    if (g.state === 'archived') throw conflict('The group is archived; it is read only.');
    const m = await this.member(g.id, userId);
    if (!m) throw new HttpProblem(422, 'Not a member', 'The new owner must be a member of the group.', { extensions: { step: 'member' } });
    const before = ((await this.db('group_members').where({ group_id: g.id, role: 'owner' }).select('user_id')) as { user_id: string }[]).map((r) => r.user_id);
    await s.db.transaction(async (trx) => {
      await trx('group_members').where({ group_id: g.id, role: 'owner' }).whereNot({ user_id: userId }).update({ role: 'moderator' });
      await trx('group_members').where({ group_id: g.id, user_id: userId }).update({ role: 'owner' });
    });
    await this.audit(ctx, 'group.ownership.transferred', { group: g.id, workspace: g.workspace_id, user: userId }, { before, after: [userId] }, g.label);
    this.event(g.tenant_id, 'group.updated', g.label, { group: g.id, workspace: g.workspace_id, actor: ctx.p.userId });
    for (const u of [...before.filter((x) => x !== userId), userId]) this.room(g, 'group.member.role', { userId: u, role: u === userId ? 'owner' : 'moderator' });
    const members = ((await this.db('group_members').where({ group_id: g.id }).select('user_id')) as { user_id: string }[]).map((r) => r.user_id);
    const who = (await this.db('users').where({ tenant_id: g.tenant_id, id: userId }).first('display_name')) as { display_name: string } | undefined;
    await s.notifications.notify({ tenantId: g.tenant_id, userIds: members, kind: 'group', title: `${who?.display_name ?? 'A member'} now owns ${g.name}`, route: `groups?id=${g.id}`, label: g.label });
    return { id: g.id, owners: [userId], moderators: before.filter((x) => x !== userId) };
  }

  /**
   * Archives a group: read only from now on (members keep reading its posts and events; nothing is posted, joined or
   * scheduled), pending requests and invitations cancelled, reminders cancelled. Calendar feeds keep the past events.
   */
  async archive(ctx: Ctx, id: string) {
    const s = this.s();
    const g = await this.adminRow(ctx.p, id);
    if (g.state === 'archived') return { id: g.id, state: 'archived' as const };
    if (g.state !== 'active') throw conflict(`The group is ${g.state}; moderation decides on it.`);
    const n = await s.db('social_groups').where({ id: g.id, state: 'active' }).update({ state: 'archived', updated_at: Date.now() });
    if (!n) throw conflict('The group changed meanwhile.');
    const cancelledRequests = await s.db('group_requests').where({ group_id: g.id, state: 'pending' }).update({ state: 'cancelled', pending_key: null, decided_by: ctx.p.userId, decided_at: Date.now() });
    const cancelledReminders = await s.calendar.cancelRemindersForGroup(g.tenant_id, g.id);
    const members = ((await this.db('group_members').where({ group_id: g.id }).select('user_id')) as { user_id: string }[]).map((r) => r.user_id);
    await this.audit(ctx, 'group.archived', { group: g.id, workspace: g.workspace_id }, { name: g.name, members: members.length, requestsCancelled: cancelledRequests, remindersCancelled: cancelledReminders }, g.label);
    this.event(g.tenant_id, 'group.updated', g.label, { group: g.id, workspace: g.workspace_id, actor: ctx.p.userId });
    this.room(g, 'group.updated', { state: 'archived' });
    await s.notifications.notify({ tenantId: g.tenant_id, userIds: members, kind: 'group', title: `${g.name} was archived`, body: 'You can still read its posts and events; nothing new can be posted or scheduled.', route: `groups?id=${g.id}`, label: g.label });
    return { id: g.id, state: 'archived' as const, members: members.length };
  }

  // ---------- members ----------

  async members(p: Principal, id: string) {
    await this.require(p, id, 'read');
    const rows = (await this.db('group_members as m').join('users as u', 'u.id', 'm.user_id').where({ 'm.group_id': id }).select('m.user_id', 'm.role', 'm.joined_at', 'u.username', 'u.display_name').orderBy('m.joined_at')) as { user_id: string; role: GroupRole; joined_at: number; username: string; display_name: string }[];
    return rows.map((r) => ({ userId: r.user_id, username: r.username, displayName: r.display_name, role: r.role, joinedAt: Number(r.joined_at) }));
  }

  private async owners(groupId: string): Promise<number> {
    const r = (await this.db('group_members').where({ group_id: groupId, role: 'owner' }).count({ n: '*' })) as { n: number | string }[];
    return Number(r[0]?.n ?? 0);
  }

  /**
   * People a moderator may invite (Sprint 30, the console's invitation picker): active users of the group's workspace,
   * cleared for its label, not members and without a pending request or invitation. At most 50, matched on the name.
   */
  async candidates(p: Principal, id: string, q?: string) {
    const a = await this.require(p, id, 'invite', { reading: true });
    const g = a.group;
    const like = q ? `%${q.toLowerCase().replace(/[%_\\]/g, '')}%` : null;
    const rows = (await this.db('workspace_members as wm').join('users as u', 'u.id', 'wm.user_id')
      .where({ 'wm.workspace_id': g.workspace_id, 'u.tenant_id': g.tenant_id, 'u.state': 'active' })
      .whereNotIn('u.id', this.db('group_members').where({ group_id: g.id }).select('user_id'))
      .whereNotIn('u.id', this.db('group_requests').where({ group_id: g.id, state: 'pending' }).andWhere('expires_at', '>', Date.now()).select('user_id'))
      .modify((qb) => { if (like) qb.andWhere((w) => { void w.whereRaw('lower(u.username) like ?', [like]).orWhereRaw('lower(u.display_name) like ?', [like]); }); })
      .distinct('u.id', 'u.username', 'u.display_name', 'u.clearance').orderBy('u.display_name').limit(200)) as { id: string; username: string; display_name: string | null; clearance: string }[];
    return rows.filter((u) => isLabel(u.clearance) && clears(u.clearance, g.label)).slice(0, 50).map((u) => ({ userId: u.id, username: u.username, displayName: u.display_name ?? u.username }));
  }

  private async addMember(g: GroupRow, userId: string, role: GroupRole, by: string | null): Promise<boolean> {
    try {
      await this.db('group_members').insert({ group_id: g.id, tenant_id: g.tenant_id, user_id: userId, role, added_by: by, joined_at: Date.now() });
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
    this.event(g.tenant_id, 'group.member.added', g.label, { group: g.id, workspace: g.workspace_id, actor: by, user: userId, role });
    this.room(g, 'group.member.added', { userId, role });
    return true;
  }

  async setRole(ctx: Ctx, id: string, userId: string, role: GroupRole) {
    const a = await this.require(ctx.p, id, 'roles');
    const m = await this.member(id, userId);
    if (!m) throw notFound('Member');
    if (m.role === role) return { userId, role };
    if (m.role === 'owner' && (await this.owners(id)) <= 1) throw conflict('A group needs at least one owner; make someone else owner first.');
    await this.db('group_members').where({ group_id: id, user_id: userId }).update({ role });
    await this.audit(ctx, 'group.member.role', { group: id, user: userId }, { before: m.role, after: role }, a.group.label);
    this.room(a.group, 'group.member.role', { userId, role });
    return { userId, role };
  }

  /** Leaves (one's own id) or removes a member (moderators: members only; owners and managers: anyone). */
  async removeMember(ctx: Ctx, id: string, userId: string) {
    const s = this.s();
    const self = userId === ctx.p.userId;
    const a = self ? await this.access(ctx.p, id) : await this.require(ctx.p, id, 'remove-members');
    const m = await this.member(id, userId);
    if (!m) throw notFound('Member');
    if (!self && m.role !== 'member' && !roleHas(a.acting, 'roles')) throw forbidden('Only an owner removes owners and moderators.', { step: 'group-role' });
    if (m.role === 'owner' && (await this.owners(id)) <= 1) throw conflict('The last owner cannot leave; make someone else owner or delete the group.');
    await s.db('group_members').where({ group_id: id, user_id: userId }).delete();
    await this.audit(ctx, self ? 'group.member.left' : 'group.member.removed', { group: id, user: userId }, { role: m.role }, a.group.label);
    this.event(a.group.tenant_id, 'group.member.removed', a.group.label, { group: id, workspace: a.group.workspace_id, actor: ctx.p.userId, user: userId });
    // B-2101: their sockets leave the group's room at once (and stay out unless the group is public to them).
    s.rooms.accessChanged({ tenantId: a.group.tenant_id, kind: 'group', id, userIds: [userId] });
    this.room(a.group, 'group.member.removed', { userId });
    return { userId, removed: true };
  }

  // ---------- joining, requests, invitations ----------

  /** Joins an open group, asks to join a request group; invitation-only groups refuse. */
  async join(ctx: Ctx, id: string): Promise<{ joined: true; role: GroupRole } | { requested: true; request: ReturnType<typeof requestView> }> {
    const p = ctx.p;
    // accessOrNull already refuses anyone outside the group's workspace: they cannot join (B-2501).
    const a = await this.access(p, id);
    const g = a.group;
    if (a.role) throw conflict('You are already a member of this group.');
    if (!clears(p.clearance, g.label)) throw forbidden(`The group is labelled ${g.label}, above your clearance of ${p.clearance}.`, { step: 'clearance' });
    if (g.state !== 'active') throw conflict('The group is not accepting members.');
    const invite = await this.pendingFor(g.id, p.userId, 'invite');
    if (invite) {
      const out = await this.decide(ctx, invite.id, 'accept');
      return { joined: true, role: out.role };
    }
    if (g.join_mode === 'open') {
      await this.addMember(g, p.userId, 'member', p.userId);
      await this.audit(ctx, 'group.member.joined', { group: g.id, user: p.userId }, { via: 'open' }, g.label);
      return { joined: true, role: 'member' };
    }
    if (g.join_mode === 'invite') throw forbidden('This group is by invitation only.', { step: 'join-mode' });
    const existing = await this.pendingFor(g.id, p.userId, 'request');
    if (existing) return { requested: true, request: requestView(existing) };
    const r = await this.createRequest(g, p.userId, 'request', 'member', p.userId, this.o.requestDays);
    await this.audit(ctx, 'group.request.created', { group: g.id, request: r.id, user: p.userId }, { expiresAt: r.expires_at }, g.label);
    const mods = await this.moderators(g.id);
    await this.s().notifications.notify({ tenantId: g.tenant_id, userIds: mods, kind: 'group.request', title: `${p.displayName} asked to join ${g.name}`, route: `groups?id=${g.id}`, label: g.label });
    return { requested: true, request: requestView(r) };
  }

  private async moderators(groupId: string): Promise<string[]> {
    return ((await this.db('group_members').where({ group_id: groupId }).whereIn('role', ['owner', 'moderator']).select('user_id')) as { user_id: string }[]).map((r) => r.user_id);
  }

  private async createRequest(g: GroupRow, userId: string, kind: RequestRow['kind'], role: GroupRole, by: string, days: number): Promise<RequestRow> {
    const t = Date.now();
    const row: RequestRow = { id: ulid(), tenant_id: g.tenant_id, group_id: g.id, user_id: userId, kind, role, state: 'pending', pending_key: `${g.id}:${userId}`, created_by: by, created_at: t, expires_at: t + days * 86_400_000, decided_by: null, decided_at: null };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.db('group_requests').insert(row);
        return row;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // One pending request or invitation per user and group: an expired one makes room, a live one wins.
        const other = await this.db('group_requests').where({ pending_key: row.pending_key }).first();
        if (!other) continue;
        const o = requestFrom(other);
        if (o.expires_at > Date.now()) throw conflict(o.kind === 'invite' ? 'The user already has a pending invitation to this group.' : 'There is already a pending request to join for this user; decide it instead.');
        await this.expire(o);
      }
    }
    throw conflict('Try again.');
  }

  async invite(ctx: Ctx, id: string, userId: string, role: GroupRole) {
    const a = await this.require(ctx.p, id, 'invite');
    const g = a.group;
    if (role !== 'member' && !roleHas(a.acting, 'roles')) throw forbidden('Only an owner invites owners and moderators.', { step: 'group-role' });
    if (await this.member(g.id, userId)) throw conflict('The user is already a member of this group.');
    const e = await this.eligible(g, userId);
    if (!e.ok) throw new HttpProblem(422, 'Cannot invite this user', e.why, { extensions: { step: 'workspace' } });
    const r = await this.createRequest(g, userId, 'invite', role, ctx.p.userId, this.o.inviteDays);
    await this.audit(ctx, 'group.invite.created', { group: g.id, request: r.id, user: userId }, { role, expiresAt: r.expires_at }, g.label);
    await this.s().notifications.notify({ tenantId: g.tenant_id, userIds: [userId], kind: 'group.invite', title: `${ctx.p.displayName} invited you to the group ${g.name}`, route: `groups?invite=${r.id}`, label: g.label });
    return requestView(r);
  }

  private async loadRequest(tenantId: string, id: string): Promise<RequestRow> {
    const r = await this.db('group_requests').where({ tenant_id: tenantId, id }).first();
    if (!r) throw notFound('Request');
    return requestFrom(r);
  }

  /** Pending requests and invitations of a group (moderators). */
  async requests(p: Principal, id: string, state?: RequestRow['state']) {
    await this.require(p, id, 'decide', { reading: true });
    const rows = ((await this.db('group_requests as r').join('users as u', 'u.id', 'r.user_id').where({ 'r.group_id': id, 'r.state': state ?? 'pending' }).orderBy('r.created_at', 'desc').limit(500).select('r.*', 'u.display_name')) as Record<string, unknown>[]);
    const out = [];
    for (const raw of rows) {
      const r = requestFrom(raw);
      if (r.state === 'pending' && r.expires_at <= Date.now()) {
        await this.expire(r);
        if (!state || state === 'pending') continue;
      }
      out.push(requestView(r, { userName: (raw.display_name as string | null) ?? null }));
    }
    return out;
  }

  /** The caller's own pending requests and the invitations waiting for them. */
  async mine(p: Principal) {
    const rows = ((await this.db('group_requests as r').join('social_groups as g', 'g.id', 'r.group_id').where({ 'r.tenant_id': p.tenantId, 'r.user_id': p.userId, 'r.state': 'pending' }).whereNot('g.state', 'deleted').orderBy('r.created_at', 'desc').select('r.*', 'g.name as group_name', 'g.workspace_id as group_workspace')) as Record<string, unknown>[]);
    const ws = await this.workspaceIds(p);
    const out = [];
    for (const raw of rows) {
      const r = requestFrom(raw);
      if (r.expires_at <= Date.now()) {
        await this.expire(r);
        continue;
      }
      if (!ws.includes(String(raw.group_workspace))) continue;
      out.push(requestView(r, { groupName: String(raw.group_name) }));
    }
    return out;
  }

  /**
   * Accepts or declines: an invitation by its invitee, a join request by a moderator. Accepting checks the workspace
   * boundary and the label again, now: an invitation does not outlive the invitee's workspace membership.
   */
  async decide(ctx: Ctx, requestId: string, decision: 'accept' | 'decline'): Promise<{ request: ReturnType<typeof requestView>; role: GroupRole }> {
    const p = ctx.p;
    const r = await this.loadRequest(p.tenantId, requestId);
    const g = await this.row(p.tenantId, r.group_id);
    if (!g || g.state === 'deleted') throw notFound('Request');
    if (r.kind === 'invite') {
      if (r.user_id !== p.userId) {
        // Moderators see invitations but do not answer them for the invitee.
        await this.require(p, g.id, 'decide');
        throw forbidden('Only the invited user answers an invitation; withdraw it instead.', { step: 'invitee' });
      }
      if (!(await this.workspaceIds(p)).includes(g.workspace_id)) throw notFound('Request');
    } else {
      await this.require(p, g.id, 'decide');
    }
    if (r.state !== 'pending') throw conflict(`The ${r.kind === 'invite' ? 'invitation' : 'request'} is already ${r.state}.`);
    if (r.expires_at <= Date.now()) {
      await this.expire(r);
      throw new HttpProblem(410, 'Expired', `The ${r.kind === 'invite' ? 'invitation' : 'request'} expired.`);
    }
    if (decision === 'accept') {
      const e = await this.eligible(g, r.user_id);
      if (!e.ok) throw new HttpProblem(422, 'Cannot join', e.why, { extensions: { step: 'workspace' } });
    }
    const n = await this.db('group_requests').where({ id: r.id, state: 'pending' }).update({ state: decision === 'accept' ? 'accepted' : 'declined', pending_key: null, decided_by: p.userId, decided_at: Date.now() });
    if (!n) throw conflict('The request was decided meanwhile.');
    if (decision === 'accept') await this.addMember(g, r.user_id, r.role, r.kind === 'invite' ? r.created_by : p.userId);
    await this.audit(ctx, `group.${r.kind}.${decision === 'accept' ? 'accepted' : 'declined'}`, { group: g.id, request: r.id, user: r.user_id }, { role: r.role }, g.label);
    if (r.kind === 'request') await this.s().notifications.notify({ tenantId: g.tenant_id, userIds: [r.user_id], kind: 'group.request', title: decision === 'accept' ? `You joined the group ${g.name}` : `Your request to join ${g.name} was declined`, route: `groups?id=${g.id}`, label: g.label });
    const after = await this.loadRequest(p.tenantId, r.id);
    return { request: requestView(after), role: r.role };
  }

  /** Withdraws: the requester their own request, a moderator an invitation (or any request). */
  async cancel(ctx: Ctx, requestId: string) {
    const p = ctx.p;
    const r = await this.loadRequest(p.tenantId, requestId);
    const g = await this.row(p.tenantId, r.group_id);
    if (!g) throw notFound('Request');
    const own = r.kind === 'request' && r.user_id === p.userId;
    if (!own) await this.require(p, g.id, r.kind === 'invite' ? 'invite' : 'decide');
    if (r.state !== 'pending') throw conflict(`It is already ${r.state}.`);
    await this.db('group_requests').where({ id: r.id, state: 'pending' }).update({ state: 'cancelled', pending_key: null, decided_by: p.userId, decided_at: Date.now() });
    await this.audit(ctx, `group.${r.kind}.cancelled`, { group: g.id, request: r.id, user: r.user_id }, undefined, g.label);
    return requestView(await this.loadRequest(p.tenantId, r.id));
  }

  // ---------- posts (B-2505's group content) ----------

  async postView(x: PostRow, extra: { authorName?: string | null } = {}) {
    const body = x.state === 'published' ? ((await this.s().keys.open(x.tenant_id, x.body, `group-post:${x.id}`)) ?? '') : null;
    return { id: x.id, groupId: x.group_id, authorId: x.author_id, authorName: extra.authorName ?? null, body, label: x.label, state: x.state, createdAt: x.created_at, updatedAt: x.updated_at };
  }

  async posts(p: Principal, id: string, q: { before?: number | undefined; limit?: number | undefined }) {
    const a = await this.require(p, id, 'read');
    const mod = roleHas(a.acting, 'moderate');
    const rows = ((await this.db('group_posts as x').join('users as u', 'u.id', 'x.author_id').where({ 'x.group_id': id }).modify((qb) => {
      if (q.before) qb.andWhere('x.created_at', '<', q.before);
      // Moderators also see hidden posts (as hidden, without the text); deleted posts are gone for everyone.
      if (mod) qb.whereIn('x.state', ['published', 'hidden']);
      else qb.andWhere('x.state', 'published');
    }).orderBy('x.created_at', 'desc').limit(Math.min(q.limit ?? 50, 200)).select('x.*', 'u.display_name')) as Record<string, unknown>[]);
    return Promise.all(rows.map((r) => this.postView(postFrom(r), { authorName: (r.display_name as string | null) ?? null })));
  }

  async createPost(ctx: Ctx, id: string, body: string) {
    const s = this.s();
    const a = await this.require(ctx.p, id, 'post');
    const g = a.group;
    if (g.state !== 'active') throw conflict('The group is not open for posts.');
    const postId = ulid();
    // The guardrail checkpoint for what people write (as for a chat prompt).
    const d = await s.guardrails.check({ tenantId: g.tenant_id, workspaceId: g.workspace_id, checkpoint: 'user-input', text: body, label: g.label, principal: ctx.p, source: { kind: POST_OBJECT, id: postId }, meta: { objectType: POST_OBJECT, group: g.id } });
    if (d.action === 'block' || d.action === 'require-approval') throw new HttpProblem(422, 'Blocked by guardrails', d.reason ?? 'The post was blocked by a guardrail rule.', { extensions: { step: 'guardrails', action: d.action } });
    const text = d.action === 'redact' ? d.text : body;
    const t = Date.now();
    const row: PostRow = { id: postId, tenant_id: g.tenant_id, group_id: g.id, workspace_id: g.workspace_id, author_id: ctx.p.userId, body: await s.keys.seal(g.tenant_id, text, `group-post:${postId}`), label: g.label, state: 'published', created_at: t, updated_at: t };
    await s.db('group_posts').insert(row);
    await this.audit(ctx, 'group.post.created', { group: g.id, post: postId }, { length: text.length, guardrails: d.action }, g.label);
    this.event(g.tenant_id, 'group.post.created', g.label, { group: g.id, workspace: g.workspace_id, actor: ctx.p.userId, post: postId });
    this.room(g, 'group.post.created', { postId, authorId: ctx.p.userId }, ctx.p.userId);
    return this.postView(row, { authorName: ctx.p.displayName });
  }

  async deletePost(ctx: Ctx, postId: string) {
    const s = this.s();
    const r = await s.db('group_posts').where({ tenant_id: ctx.p.tenantId, id: postId }).first();
    if (!r) throw notFound('Post');
    const x = postFrom(r);
    const own = x.author_id === ctx.p.userId;
    const a = own ? await this.require(ctx.p, x.group_id, 'read') : await this.require(ctx.p, x.group_id, 'moderate');
    if (x.state === 'deleted') throw notFound('Post');
    if (x.state === 'hidden' && !roleHas(a.acting, 'moderate')) throw notFound('Post');
    const n = await s.db('group_posts').where({ id: x.id, state: x.state }).update({ state: 'deleted', updated_at: Date.now() });
    if (!n) throw conflict('The post changed meanwhile.');
    await this.audit(ctx, 'group.post.deleted', { group: x.group_id, post: x.id }, { by: own ? 'author' : 'moderator', author: x.author_id }, x.label);
    this.event(x.tenant_id, 'group.post.deleted', x.label, { group: x.group_id, workspace: x.workspace_id, actor: ctx.p.userId, post: x.id });
    this.room(a.group, 'group.post.deleted', { postId: x.id });
    return { id: x.id, state: 'deleted' as const };
  }

  /** Flags raised on the group's content (reports and moderation checks through B-19), for its moderators. */
  async cases(p: Principal, id: string, state?: string) {
    await this.require(p, id, 'cases', { reading: true });
    const s = this.s();
    const posts = s.db('group_posts').where({ group_id: id }).select('id');
    const events = s.db('group_events').where({ group_id: id }).select('id');
    const rows = (await s.db('guard_flags')
      .where({ tenant_id: p.tenantId })
      .andWhere((q) => q.where({ source_kind: GROUP_OBJECT, source_id: id }).orWhere((q2) => q2.where({ source_kind: POST_OBJECT }).whereIn('source_id', posts)).orWhere((q3) => q3.where({ source_kind: EVENT_OBJECT }).whereIn('source_id', events)))
      .modify((q) => (state ? q.andWhere({ state }) : q))
      .orderBy('created_at', 'desc')
      .limit(200)) as Record<string, unknown>[];
    return rows
      .filter((f) => clears(p.clearance, isLabel(f.label) ? f.label : 'restricted'))
      .map((f) => ({ id: String(f.id), ref: flagRef({ number: Number(f.number) }), kind: f.kind, state: f.state, severity: f.severity, objectType: f.source_kind, objectId: f.source_id, label: f.label, ruleName: f.rule_name, dueAt: Number(f.due_at), createdAt: Number(f.created_at) }));
  }

  // ---------- moderation object types (B-2505) ----------

  /** May this principal read the group's content, given the workspaces the moderation service resolved? */
  private async readsGroup(p: Principal, groupId: string, workspaces: string[]): Promise<boolean> {
    return !!(await this.accessOrNull(p, groupId, workspaces))?.read;
  }

  private registerModeration(): void {
    const s = this.s();
    const reg = s.moderation.registry;
    const db = () => this.s().db;
    const casHide = async (table: string, o: ModeratedObject, from: string[]): Promise<string | null> => {
      if (!o.state || !from.includes(o.state)) return null;
      const n = await db()(table).where({ id: o.id, tenant_id: o.tenantId, state: o.state }).update({ state: 'hidden', updated_at: Date.now() });
      return n ? o.state : null;
    };
    const casRestore = async (table: string, o: ModeratedObject, prev: string) => (await db()(table).where({ id: o.id, tenant_id: o.tenantId, state: 'hidden' }).update({ state: prev, updated_at: Date.now() })) > 0;
    const groupOf = async (tenantId: string, id: string) => this.row(tenantId, id);

    if (!reg.get(POST_OBJECT))
      reg.register({
        type: POST_OBJECT,
        description: 'A post in a group (hidden posts are shown to nobody but the group’s moderators)',
        resolve: async (tenantId, id) => {
          const r = await db()('group_posts').where({ tenant_id: tenantId, id }).first();
          if (!r) return null;
          const x = postFrom(r);
          return { type: POST_OBJECT, id: x.id, tenantId, workspaceId: x.workspace_id, label: x.label, ownerId: x.author_id, state: x.state };
        },
        canRead: async (p, o, workspaces) => {
          if (!clears(p.clearance, o.label) || o.state === 'deleted') return false;
          const r = (await db()('group_posts').where({ id: o.id }).first('group_id')) as { group_id: string } | undefined;
          return !!r && (await this.readsGroup(p, r.group_id, workspaces));
        },
        text: async (o) => {
          const r = (await db()('group_posts').where({ id: o.id }).first('body')) as { body: string } | undefined;
          return r ? ((await this.s().keys.open(o.tenantId, r.body, `group-post:${o.id}`)) ?? '') : '';
        },
        hide: (o) => casHide('group_posts', o, ['published']),
        restore: (o, prev) => casRestore('group_posts', o, prev)
      });

    if (!reg.get(GROUP_OBJECT))
      reg.register({
        type: GROUP_OBJECT,
        description: 'A group (its name and description; a hidden group is closed to everyone but managers and its owners)',
        resolve: async (tenantId, id) => {
          const g = await groupOf(tenantId, id);
          return g && g.state !== 'deleted' ? { type: GROUP_OBJECT, id: g.id, tenantId, workspaceId: g.workspace_id, label: g.label, ownerId: g.created_by, state: g.state } : null;
        },
        canRead: async (p, o, workspaces) => !!(await this.accessOrNull(p, o.id, workspaces))?.see && clears(p.clearance, o.label),
        text: async (o) => {
          const g = await groupOf(o.tenantId, o.id);
          return g ? [g.name, await this.openDescription(g)].filter(Boolean).join('\n\n') : '';
        },
        hide: async (o) => {
          const prev = await casHide('social_groups', o, ['active']);
          if (prev) this.s().rooms.accessChanged({ tenantId: o.tenantId, kind: 'group', id: o.id });
          return prev;
        },
        restore: (o, prev) => casRestore('social_groups', o, prev)
      });

    if (!reg.get(EVENT_OBJECT))
      reg.register({
        type: EVENT_OBJECT,
        description: 'An event in a group (a hidden event is left out of calendars and its reminders are not sent)',
        resolve: async (tenantId, id) => {
          const e = (await db()('group_events').where({ tenant_id: tenantId, id }).first('id', 'workspace_id', 'label', 'created_by', 'state')) as { id: string; workspace_id: string; label: string; created_by: string; state: string } | undefined;
          return e ? { type: EVENT_OBJECT, id: e.id, tenantId, workspaceId: e.workspace_id, label: isLabel(e.label) ? e.label : 'internal', ownerId: e.created_by, state: e.state } : null;
        },
        canRead: async (p, o, workspaces) => {
          if (!clears(p.clearance, o.label) || o.state === 'hidden') return false;
          const e = (await db()('group_events').where({ id: o.id }).first('group_id')) as { group_id: string } | undefined;
          return !!e && (await this.readsGroup(p, e.group_id, workspaces));
        },
        text: async (o) => this.s().calendar.moderationText(o.tenantId, o.id),
        hide: (o) => casHide('group_events', o, ['scheduled']),
        restore: (o, prev) => casRestore('group_events', o, prev)
      });
  }
}
