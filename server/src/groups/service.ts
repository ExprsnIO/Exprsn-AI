import { ulid } from 'ulid';
import { actorFrom, isUniqueViolation } from '../audit/chain.js';
import { clears, isLabel, labelRank, type Label } from '../authz/labels.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { loadPrincipal, workspacesFor } from '../http/middleware.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { GuardDecision } from '../guardrails/types.js';
import { holdReason, refusal, type HeldRow } from '../moderation/held.js';
import { withSpamHold } from '../spam/service.js';
import type { ModeratedObject } from '../moderation/registry.js';
import { TOPICS, type IntegrationEvent } from '../platform/bus.js';
import type { Services } from '../services.js';
import { GroupBans, standingView, type BanRow } from './bans.js';
import { GroupCases } from './cases.js';
import { GroupConversations } from './conversations.js';
import { GroupDepth } from './depth.js';
import { GroupOwnership } from './ownership.js';
import { GroupSubjects } from './subjects.js';
import { GroupInvites } from './invites.js';
import { byText, decodeCursor, encodeCursor, likeOf, paged, pageSize, type Page, type PageQuery } from './paging.js';
import { GroupProfile } from './profile.js';
import { ALL_RIGHTS, can, covers, GroupRoles, isStaff, NO_RIGHTS, ownsGroup, tierRights, type GroupRight, type GroupRole, type Rights } from './roles.js';
import { distanceKm, narrow, validPoint, type Near } from './geo.js';
import { groupOfPrincipal } from './service-principal.js';

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
 * - roles: owner (settings, roles, delete), moderator (requests, invitations, members, posts, events, check-in, cases,
 *   channels), member (post, RSVP). Holders of `groups:manage` act as owner on every group in the workspaces they may act in.
 *   1.7.0 (B-9705): two more tiers, admin and guest, and the group's own custom roles. What a membership may do is
 *   decided from its rights in groups/roles.ts (`can`, `covers`, `ownsGroup`, `isStaff`), never from the tier's name.
 * - channels (1.6.0, B-4401): a group may hold channels, groups one level down (`parent_id`) with their own members,
 *   roles and posts. The group is a channel's outer boundary as the workspace is a group's: only those who read the
 *   group see its channels, only its members join them, and leaving the group leaves its channels. The group's owners
 *   act as owners of its channels. A channel's label is never below its group's (the floor); raising the group's
 *   label raises its channels'.
 */

export { can, GROUP_ROLES, type GroupRight, type GroupRole } from './roles.js';
export const VISIBILITIES = ['public', 'private', 'hidden'] as const;
export type Visibility = (typeof VISIBILITIES)[number];
export const JOIN_MODES = ['open', 'request', 'invite'] as const;
export type JoinMode = (typeof JOIN_MODES)[number];


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
  /** 1.6.0 (B-4401): the group a channel belongs to; null for a group. */
  parent_id: string | null;
  /** 1.6.0 (B-4405): the tenant's category, or null (uncategorised). */
  category_id: string | null;
  /** 1.6.0 (B-4403): the place name (sealed) and the point, all optional. */
  location: string | null;
  lat: number | null;
  lon: number | null;
  /** 1.7.0 (B-9703): profile fields and the member limit (groups/profile.ts). */
  tags: string | null;
  website: string | null;
  member_limit: number | null;
  avatar_file_id: string | null;
  avatar_version: number | null;
  banner_file_id: string | null;
  banner_version: number | null;
  /** 1.7.0 (B-9801): when a sweep first found the group without an active owner; null while it has one. */
  ownerless_at?: number | null;
}

export interface MemberRow {
  group_id: string;
  tenant_id: string;
  user_id: string;
  role: GroupRole;
  /** 1.7.0 (B-9705): the group's custom role this member holds; its rights then stand in for the tier's. */
  custom_role_id?: string | null;
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
  /** 1.7.0 (B-9702): what the requester or the inviter wrote, sealed as `group-request:<id>`. */
  message?: string | null;
}

export interface PostRow {
  id: string;
  tenant_id: string;
  group_id: string;
  workspace_id: string;
  author_id: string;
  body: string;
  label: Label;
  /** 1.7.0 (B-9402): `held` and `rejected` are read by the post's author only. */
  state: 'published' | 'hidden' | 'deleted' | 'held' | 'rejected';
  created_at: number;
  updated_at: number;
}

/** A group's place as given (B-4403): a name, a point, or both. */
export interface LocationInput {
  name?: string | null | undefined;
  lat?: number | null | undefined;
  lon?: number | null | undefined;
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
  /** The role the caller acts with: their own, or owner for a manager. A name for display: decisions read `rights`. */
  acting: GroupRole | null;
  /** 1.7.0 (B-9705): what the caller may do in the group now (groups/roles.ts). Empty for a suspended membership. */
  rights: Rights;
  /** The custom role the caller's membership names, when its rights are the ones in effect. */
  customRole?: { id: string; name: string } | null;
  /** May know the group exists. */
  see: boolean;
  /** May read its content (posts, events, members). */
  read: boolean;
  /** For a channel: the caller's standing in its group. */
  parent?: Access | null;
  /** 1.7.0 (B-9701): the suspension that takes the caller's membership out of effect now (in the group or its parent). */
  barred?: BanRow | null;
}

const num = (v: unknown) => Number(v);
const numOrNull = (v: unknown) => (v == null ? null : Number(v));
export const groupFrom = (r: Record<string, unknown>): GroupRow => ({
  ...(r as unknown as GroupRow),
  label: isLabel(r.label) ? r.label : 'internal',
  created_at: num(r.created_at),
  updated_at: num(r.updated_at),
  parent_id: (r.parent_id as string | null | undefined) ?? null,
  category_id: (r.category_id as string | null | undefined) ?? null,
  location: (r.location as string | null | undefined) ?? null,
  lat: numOrNull(r.lat),
  lon: numOrNull(r.lon),
  tags: (r.tags as string | null | undefined) ?? null,
  website: (r.website as string | null | undefined) ?? null,
  member_limit: numOrNull(r.member_limit),
  avatar_file_id: (r.avatar_file_id as string | null | undefined) ?? null,
  avatar_version: numOrNull(r.avatar_version),
  banner_file_id: (r.banner_file_id as string | null | undefined) ?? null,
  banner_version: numOrNull(r.banner_version)
});
/** The profile columns of a new group or channel. */
const NO_PROFILE = { tags: null, website: null, member_limit: null, avatar_file_id: null, avatar_version: null, banner_file_id: null, banner_version: null } as const;
const memberFrom = (r: Record<string, unknown>): MemberRow => ({ ...(r as unknown as MemberRow), joined_at: num(r.joined_at) });
const requestFrom = (r: Record<string, unknown>): RequestRow => ({ ...(r as unknown as RequestRow), created_at: num(r.created_at), expires_at: num(r.expires_at), decided_at: r.decided_at == null ? null : num(r.decided_at) });
const postFrom = (r: Record<string, unknown>): PostRow => ({ ...(r as unknown as PostRow), label: isLabel(r.label) ? r.label : 'internal', created_at: num(r.created_at), updated_at: num(r.updated_at) });

/** What a reader sees of a group's place (B-4403): the name and point, only for readers of its content. */
export interface PlaceView {
  name: string | null;
  lat: number | null;
  lon: number | null;
}

export const groupView = (g: GroupRow, description: string | null, a?: Pick<Access, 'role' | 'acting' | 'read'>, counts?: { members: number; channels?: number }, place?: PlaceView | null) => ({
  id: g.id,
  workspaceId: g.workspace_id,
  parentId: g.parent_id,
  name: g.name,
  description: a && !a.read ? null : description,
  visibility: g.visibility,
  joinMode: g.join_mode,
  label: g.label,
  state: g.state,
  categoryId: g.category_id,
  // B-4403: a group's place is shown to the readers of its content, like its description.
  location: a && !a.read ? null : place ?? null,
  createdBy: g.created_by,
  createdAt: g.created_at,
  updatedAt: g.updated_at,
  ...(a ? { role: a.role, actingRole: a.acting } : {}),
  ...(counts ? { members: counts.members, ...(counts.channels !== undefined ? { channels: counts.channels } : {}) } : {})
});

export interface MemberView {
  userId: string;
  username: string;
  displayName: string;
  role: GroupRole;
  /** 1.7.0 (B-9705): the member's custom role, when they hold one. */
  customRole?: { id: string; name: string } | null;
  joinedAt: number;
  /** 1.7.0 (B-9801): set only in a manager's list with `departed`: the account is no longer active. */
  departed?: boolean;
}

export const requestView = (r: RequestRow, extra: { groupName?: string; userName?: string | null; message?: string | null } = {}) => ({
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
  // 1.7.0 (B-9702): the message written with it, for the group's moderators and the person it concerns.
  message: extra.message ?? null,
  ...(extra.groupName !== undefined ? { groupName: extra.groupName } : {}),
  ...(extra.userName !== undefined ? { userName: extra.userName } : {})
});

export class GroupService {
  private started = false;
  /** 1.6.0 (B-4402, B-4404, B-4405): discovery, trending groups and the tenant's categories. */
  readonly depth: GroupDepth;
  /** 1.7.0 (B-9801): groups whose owners have all left. */
  readonly ownership: GroupOwnership;
  /** 1.7.0 (B-98): which groups a person counts as a member of, for grants to a group in files, vault, knowledge and apps. */
  readonly subjects: GroupSubjects;
  /** 1.7.0 (B-9703): tags, website, avatar, banner and the member limit. */
  readonly profile: GroupProfile;
  /** 1.7.0 (B-9705): the tiers' rights, the group's custom roles and whose rights are what. */
  readonly roles: GroupRoles;
  /** 1.7.0 (B-9701): bans and suspensions. */
  readonly bans: GroupBans;
  /** 1.7.0 (B-9702): invite links and the message on a request or an invitation. */
  readonly invites: GroupInvites;
  /** 1.7.0 (B-9706): the group's moderators acting on the cases about its content. */
  readonly caseWork: GroupCases;
  /** 1.7.0 (B-9709): the group's linked conversation, whose members follow the group's. */
  readonly conversations: GroupConversations;

  constructor(
    private readonly s: () => Services,
    private readonly o: { inviteDays: number; requestDays: number }
  ) {
    this.depth = new GroupDepth(s);
    this.ownership = new GroupOwnership(s);
    this.subjects = new GroupSubjects(s);
    this.profile = new GroupProfile(s);
    this.roles = new GroupRoles(s);
    this.bans = new GroupBans(s);
    this.invites = new GroupInvites(s, { inviteDays: o.inviteDays });
    this.caseWork = new GroupCases(s);
    this.conversations = new GroupConversations(s);
  }

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
    this.registerHeld();
    this.depth.registerJobs();
    this.ownership.registerJobs();
    this.caseWork.init();
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

  /** The group's place for a reader (B-4403), or null when it has none. */
  async place(g: GroupRow): Promise<PlaceView | null> {
    const name = g.location ? ((await this.s().keys.open(g.tenant_id, g.location, `group-location:${g.id}`)) ?? null) : null;
    if (!name && g.lat == null) return null;
    return { name, lat: g.lat, lon: g.lon };
  }

  /** The full view of a group for a caller with this access (description and place for readers). */
  async present(g: GroupRow, a: Pick<Access, 'role' | 'acting' | 'read'>, counts?: { members: number; channels?: number }, viewer?: Pick<Principal, 'clearance'> | null) {
    return { ...groupView(g, a.read ? await this.openDescription(g) : null, a, counts, a.read ? await this.place(g) : null), ...(await this.profile.view(g, viewer ?? null, counts?.members)) };
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
  async accessOrNull(p: Principal, id: string, workspaces?: string[], row?: GroupRow): Promise<Access | null> {
    const g = row ?? (await this.row(p.tenantId, id));
    if (!g || g.state === 'deleted') return null;
    // 1.9.0 (B-176): a group carrying out its own decision stands as an owner of that group, and of no other.
    if (groupOfPrincipal(p) === g.id && !g.parent_id) return { group: g, role: 'owner', manager: false, acting: 'owner', rights: tierRights('owner'), see: true, read: true };
    const ws = workspaces ?? (await this.workspaceIds(p));
    // The outer boundary: nothing of a group is visible outside its workspace.
    if (!ws.includes(g.workspace_id)) return null;
    // B-4401: a channel's outer boundary is its group: nothing of it is visible to those who do not read the group.
    let parent: Access | null = null;
    if (g.parent_id) {
      parent = await this.accessOrNull(p, g.parent_id, ws);
      if (!parent?.read) return null;
    }
    // The group's owners (and groups:manage) act as owners of its channels.
    const manager = effectivePermissions(p).has('groups:manage') || ownsGroup(parent?.rights);
    const m = await this.member(g.id, p.userId);
    // 1.7.0 (B-9701): a suspension (here or in the channel's group) leaves the membership without effect for its time.
    const barred = m ? await this.bans.barred(g, p.userId) : null;
    const role = barred ? null : (m?.role ?? null);
    const acting: GroupRole | null = manager ? 'owner' : role;
    // 1.7.0 (B-9705): the rights in effect: every one for a manager, the custom role's or the tier's for a member.
    const custom = m?.custom_role_id && !barred ? await this.roles.row(g.id, m.custom_role_id) : null;
    const rights: Rights = manager ? ALL_RIGHTS : m && !barred ? this.roles.rightsFrom(m, custom) : NO_RIGHTS;
    const cleared = clears(p.clearance, g.label);
    // A group hidden by moderation is known only to managers and its owners.
    if (g.state === 'hidden' && !ownsGroup(rights)) return null;
    let see = manager || !!role || (g.visibility !== 'hidden' && cleared);
    if (!see && g.visibility === 'hidden') see = !!(await this.pendingFor(g.id, p.userId, 'invite'));
    if (!see) return null;
    const read = cleared && (manager || !!role || g.visibility === 'public');
    return { group: g, role, manager, acting, rights, see, read, ...(custom && !manager ? { customRole: { id: custom.id, name: custom.name } } : {}), ...(g.parent_id ? { parent } : {}), ...(barred ? { barred } : {}) };
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
    if (a.barred && !a.rights.size) throw forbidden(`You are suspended from this group${a.barred.expires_at ? ` until ${new Date(a.barred.expires_at).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''}.`, { step: 'ban', kind: a.barred.kind, until: a.barred.expires_at });
    if (!a.read || !can(a, right)) throw forbidden(a.acting ? `Your role in this group (${a.customRole?.name ?? a.acting}) does not allow this.` : 'Join the group first.', { step: 'group-role', right });
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
  async eligible(g: GroupRow, userId: string): Promise<{ ok: true } | { ok: false; why: string }> {
    const s = this.s();
    // As the user would be on their next request: active, not sanctioned, and the workspaces they may act in now.
    const p = await loadPrincipal(s, g.tenant_id, userId, {});
    if (!p) return { ok: false, why: 'There is no active user with that id in this tenant.' };
    if (!(await this.workspaceIds(p)).includes(g.workspace_id)) return { ok: false, why: 'The user is not a member of the group’s workspace.' };
    if (!clears(p.clearance, g.label)) return { ok: false, why: `The user is not cleared for ${g.label}.` };
    // B-4401: only members of the group join its channels.
    if (g.parent_id && !(await this.member(g.parent_id, userId))) return { ok: false, why: 'The user is not a member of the channel’s group.' };
    return { ok: true };
  }

  // ---------- groups ----------

  /**
   * The groups the caller may know of. Groups only, unless `parentId` names a group (its channels) or `includeChannels`
   * is set (the caller's own calendars over DAV). 1.6.0: `category` (an id, or `none` for uncategorised) and `near` (a
   * distance filter, B-4403: only groups whose place the caller may read, nearest first, with `distanceKm`).
   */
  async list(p: Principal, q: { workspaceId?: string | null; mine?: boolean; parentId?: string | null; includeChannels?: boolean; category?: string | null; near?: Near | null; search?: string | undefined }) {
    const ws = await this.workspaceIds(p);
    const scope = q.workspaceId ? ws.filter((w) => w === q.workspaceId) : ws;
    if (!scope.length) return [];
    if (q.parentId) {
      const pa = await this.require(p, q.parentId, 'read', { reading: true });
      if (pa.group.parent_id) return [];
    }
    const manager = effectivePermissions(p).has('groups:manage');
    const memberships = new Map(((await this.db('group_members').where({ tenant_id: p.tenantId, user_id: p.userId }).select('group_id', 'role')) as { group_id: string; role: GroupRole }[]).map((m) => [m.group_id, m.role]));
    // 1.7.0 (B-9701): a suspended membership counts for nothing while the suspension stands.
    for (const gid of await this.bans.groupsBarred(p.tenantId, p.userId)) memberships.delete(gid);
    const invited = new Set(((await this.db('group_requests').where({ tenant_id: p.tenantId, user_id: p.userId, kind: 'invite', state: 'pending' }).andWhere('expires_at', '>', Date.now()).select('group_id')) as { group_id: string }[]).map((r) => r.group_id));
    const qb = this.db('social_groups as g').where({ 'g.tenant_id': p.tenantId }).whereIn('g.workspace_id', scope).whereNot({ 'g.state': 'deleted' });
    if (q.parentId) qb.andWhere({ 'g.parent_id': q.parentId });
    else if (!q.includeChannels) qb.whereNull('g.parent_id');
    if (q.category === 'none') qb.whereNull('g.category_id');
    else if (q.category) qb.andWhere({ 'g.category_id': q.category });
    if (q.near) await narrow(this.db, qb, 'g', q.near);
    // 1.7.0 (B-9704): a search matches the name and the tags, both kept in the clear.
    const like = likeOf(q.search);
    if (like) qb.andWhere((w) => { void w.whereRaw('lower(g.name) like ?', [like]).orWhereRaw('lower(g.tags) like ?', [like]); });
    const rows = ((await qb.orderBy('g.name').orderBy('g.id').select('g.*')) as Record<string, unknown>[]).map(groupFrom);
    const ids = rows.map((g) => g.id);
    const counts = await this.memberCounts(ids);
    const channels = q.parentId ? new Map<string, number>() : await this.channelCounts(ids);
    const out = [];
    const parents = new Map<string, Access | null>();
    for (const g of rows) {
      let a: Pick<Access, 'role' | 'acting' | 'read'> | null;
      if (g.parent_id) {
        // A channel: decided against its group's standing (cached per group).
        if (!parents.has(g.parent_id)) parents.set(g.parent_id, await this.accessOrNull(p, g.parent_id, ws));
        const pa = parents.get(g.parent_id);
        a = pa?.read ? await this.accessOrNull(p, g.id, ws, g) : null;
        if (a && q.mine && !a.role) a = null;
      } else {
        const role = memberships.get(g.id) ?? null;
        if (q.mine && !role) continue;
        if (g.state === 'hidden' && !manager && !ownsGroup(tierRights(role))) continue;
        const cleared = clears(p.clearance, g.label);
        const see = manager || !!role || (g.visibility !== 'hidden' && cleared) || (g.visibility === 'hidden' && invited.has(g.id));
        a = see ? { role, acting: manager ? 'owner' : role, read: cleared && (manager || !!role || g.visibility === 'public') } : null;
      }
      if (!a) continue;
      let distance: number | null = null;
      if (q.near) {
        // The place is the readers' (B-4403): a group whose place the caller may not read never matches a distance.
        if (!a.read || g.lat == null || g.lon == null) continue;
        distance = distanceKm(q.near, { lat: g.lat, lon: g.lon });
        if (distance > q.near.km) continue;
      }
      const base = await this.present(g, a, { members: counts.get(g.id) ?? 0, ...(g.parent_id ? {} : { channels: channels.get(g.id) ?? 0 }) }, p);
      // A channel names its group (and the label floor it keeps).
      const pg = g.parent_id ? parents.get(g.parent_id)?.group : null;
      const view = pg ? { ...base, parentName: pg.name, parentLabel: pg.label } : base;
      out.push(distance == null ? view : { ...view, distanceKm: Math.round(distance * 1000) / 1000 });
    }
    if (q.near) out.sort((x, y) => ((x as { distanceKm?: number }).distanceKm ?? 0) - ((y as { distanceKm?: number }).distanceKm ?? 0) || x.name.localeCompare(y.name));
    return out;
  }

  /**
   * 1.7.0 (B-9704): one page of `list`. The order is the name by code point and then the id (with `near`, the
   * distance and then the id), decided here so that it is the same on every database; the cursor names the last row.
   */
  async listPage(p: Principal, q: Parameters<GroupService['list']>[1] & PageQuery): Promise<Page<Awaited<ReturnType<GroupService['list']>>[number]>> {
    const all = await this.list(p, { ...q, search: q.q });
    const dist = (x: object) => (x as { distanceKm?: number }).distanceKm ?? 0;
    const near = !!q.near;
    all.sort((x, y) => (near ? dist(x) - dist(y) : byText(x.name, y.name)) || byText(x.id, y.id));
    let from = 0;
    if (q.cursor) {
      if (near) {
        const [d, id] = decodeCursor(q.cursor, ['number', 'string'] as const);
        from = all.findIndex((x) => dist(x) > d || (dist(x) === d && x.id > id));
      } else {
        const [name, id] = decodeCursor(q.cursor, ['string', 'string'] as const);
        from = all.findIndex((x) => byText(x.name, name) > 0 || (x.name === name && x.id > id));
      }
      if (from < 0) from = all.length;
    }
    const size = pageSize(q);
    const items = all.slice(from, from + size);
    const last = items[items.length - 1];
    return { items, next: last && from + size < all.length ? encodeCursor(near ? [dist(last), last.id] : [last.name, last.id]) : null, total: all.length };
  }

  /** How many live channels each group holds. */
  private async channelCounts(ids: string[]): Promise<Map<string, number>> {
    const m = new Map<string, number>();
    for (let i = 0; i < ids.length; i += 500) {
      const rows = (await this.db('social_groups').whereIn('parent_id', ids.slice(i, i + 500)).whereNot({ state: 'deleted' }).groupBy('parent_id').select('parent_id').count({ n: '*' })) as { parent_id: string; n: number | string }[];
      for (const r of rows) m.set(r.parent_id, Number(r.n));
    }
    return m;
  }

  async memberCounts(ids: string[]): Promise<Map<string, number>> {
    const m = new Map<string, number>();
    for (let i = 0; i < ids.length; i += 500) {
      const rows = (await this.db('group_members').whereIn('group_id', ids.slice(i, i + 500)).groupBy('group_id').select('group_id').count({ n: '*' })) as { group_id: string; n: number | string }[];
      for (const r of rows) m.set(r.group_id, Number(r.n));
    }
    return m;
  }

  async view(p: Principal, id: string) {
    const a = await this.access(p, id);
    const counts = await this.memberCounts([id]);
    // A group shows how many of its channels the caller may know of; a channel names its group.
    const channels = a.group.parent_id ? undefined : a.read ? (await this.list(p, { parentId: id })).length : 0;
    // 1.7.0 (B-9701): the caller is told when a ban or suspension stands against them, and until when; never why.
    const standing = standingView(a.barred ?? (a.role ? null : await this.bans.barred(a.group, p.userId)));
    // 1.7.0 (B-9705): what the caller may do here, and the custom role they hold.
    // 1.7.0 (B-9801): a manager sees whether the group has an owner whose account is active, and may take it over when not.
    const ownerless = a.manager && !a.group.parent_id ? (await this.ownership.activeOwners(id)) === 0 : undefined;
    const view = { ...(await this.present(a.group, a, { members: counts.get(id) ?? 0, ...(channels !== undefined ? { channels } : {}) }, p)), standing, rights: [...a.rights], customRole: a.customRole ?? null, manager: a.manager, ...(ownerless !== undefined ? { ownerless } : {}) };
    return a.group.parent_id && a.parent ? { ...view, parentName: a.parent.group.name, parentLabel: a.parent.group.label } : view;
  }

  async create(ctx: Ctx, input: { workspaceId?: string | null | undefined; name: string; description?: string | null | undefined; visibility?: Visibility | undefined; joinMode?: JoinMode | undefined; label?: Label | undefined; categoryId?: string | null | undefined; location?: LocationInput | null | undefined; tags?: string[] | undefined; website?: string | null | undefined; memberLimit?: number | null | undefined }) {
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
    if (input.categoryId) await this.depth.category(p.tenantId, input.categoryId);
    const id = ulid();
    const t = Date.now();
    const row: GroupRow = { id, tenant_id: p.tenantId, workspace_id: w.id, name: input.name, description: input.description ? await s.keys.seal(p.tenantId, input.description, `group:${id}`) : null, visibility: input.visibility!, join_mode: input.joinMode!, label, state: 'active', created_by: p.userId, created_at: t, updated_at: t, parent_id: null, category_id: input.categoryId ?? null, ...(await this.locationColumns(p.tenantId, id, input.location ?? null)), ...NO_PROFILE, ...(await this.profile.columns(p, { id, tenant_id: p.tenantId, workspace_id: w.id, label }, input)) };
    await s.db.transaction(async (trx) => {
      await trx('social_groups').insert(row);
      await trx('group_members').insert({ group_id: id, tenant_id: p.tenantId, user_id: p.userId, role: 'owner', added_by: p.userId, joined_at: t });
    });
    await this.audit(ctx, 'group.created', { group: id, workspace: w.id }, { name: row.name, visibility: row.visibility, joinMode: row.join_mode, ...(row.category_id ? { category: row.category_id } : {}), ...(row.lat != null ? { located: true } : {}) }, label);
    this.event(p.tenantId, 'group.created', label, { group: id, workspace: w.id, actor: p.userId });
    this.event(p.tenantId, 'group.member.added', label, { group: id, workspace: w.id, actor: p.userId, user: p.userId, role: 'owner' });
    return this.present(row, { role: 'owner', acting: 'owner', read: true }, { members: 1, channels: 0 }, p);
  }

  /** The sealed place name and the point of a group (B-4403); a point needs both coordinates. */
  private async locationColumns(tenantId: string, id: string, loc: LocationInput | null): Promise<Pick<GroupRow, 'location' | 'lat' | 'lon'>> {
    if (!loc) return { location: null, lat: null, lon: null };
    const point = loc.lat != null || loc.lon != null ? { lat: loc.lat ?? null, lon: loc.lon ?? null } : null;
    if (point && !validPoint(point)) throw new HttpProblem(422, 'Not a place', 'Give both a latitude (−90 to 90) and a longitude (−180 to 180), or neither.', { extensions: { step: 'location' } });
    if (!point && !loc.name) return { location: null, lat: null, lon: null };
    return { location: loc.name ? await this.s().keys.seal(tenantId, loc.name, `group-location:${id}`) : null, lat: point?.lat ?? null, lon: point?.lon ?? null };
  }

  /**
   * A channel inside a group (B-4401): its own members (the creator becomes its owner), roles and posts. Its label is
   * at least the group's (the floor) and at most the workspace ceiling; a public channel is read by everyone who reads
   * the group, a private one by its members, a hidden one is known only to them. Channels do not nest.
   */
  async createChannel(ctx: Ctx, parentId: string, input: { name: string; description?: string | null | undefined; visibility?: Visibility | undefined; joinMode?: JoinMode | undefined; label?: Label | undefined }) {
    const s = this.s();
    const p = ctx.p;
    const pa = await this.require(p, parentId, 'channels');
    const parent = pa.group;
    if (parent.parent_id) throw new HttpProblem(422, 'Channels do not nest', 'A channel belongs to a group, not to another channel.', { extensions: { step: 'parent' } });
    if (parent.state !== 'active') throw conflict('The group is not active.');
    const label = input.label ?? parent.label;
    if (labelRank(label) < labelRank(parent.label)) throw new HttpProblem(422, 'Label below the group’s', `A channel of ${parent.name} is labelled at least ${parent.label}.`, { extensions: { step: 'label-floor' } });
    const w = await s.tenants.workspace(parent.tenant_id, parent.workspace_id);
    if (w && labelRank(label) > labelRank(w.label_ceiling)) throw new HttpProblem(422, 'Label above the workspace ceiling', `The workspace allows content up to ${w.label_ceiling}.`);
    if (!clears(p.clearance, label)) throw forbidden(`You are not cleared for ${label}.`, { step: 'clearance' });
    const id = ulid();
    const t = Date.now();
    const row: GroupRow = { id, tenant_id: parent.tenant_id, workspace_id: parent.workspace_id, name: input.name, description: input.description ? await s.keys.seal(parent.tenant_id, input.description, `group:${id}`) : null, visibility: input.visibility ?? 'public', join_mode: input.joinMode ?? 'open', label, state: 'active', created_by: p.userId, created_at: t, updated_at: t, parent_id: parent.id, category_id: null, location: null, lat: null, lon: null, ...NO_PROFILE };
    await s.db.transaction(async (trx) => {
      await trx('social_groups').insert(row);
      await trx('group_members').insert({ group_id: id, tenant_id: parent.tenant_id, user_id: p.userId, role: 'owner', added_by: p.userId, joined_at: t });
    });
    await this.audit(ctx, 'group.channel.created', { group: parent.id, channel: id, workspace: parent.workspace_id }, { name: row.name, visibility: row.visibility, joinMode: row.join_mode }, label);
    this.event(parent.tenant_id, 'group.created', label, { group: id, workspace: parent.workspace_id, actor: p.userId });
    this.event(parent.tenant_id, 'group.member.added', label, { group: id, workspace: parent.workspace_id, actor: p.userId, user: p.userId, role: 'owner' });
    this.room(parent, 'group.channel.created', { channelId: id });
    return { ...(await this.present(row, { role: 'owner', acting: 'owner', read: true }, { members: 1 }, p)), parentName: parent.name, parentLabel: parent.label };
  }

  /** The live channels of a group (ids), for cascades. */
  private async channelIds(groupId: string): Promise<string[]> {
    return ((await this.db('social_groups').where({ parent_id: groupId }).whereNot({ state: 'deleted' }).select('id')) as { id: string }[]).map((r) => r.id);
  }

  async update(ctx: Ctx, id: string, patch: { name?: string | undefined; description?: string | null | undefined; visibility?: Visibility | undefined; joinMode?: JoinMode | undefined; label?: Label | undefined; categoryId?: string | null | undefined; location?: LocationInput | null | undefined; tags?: string[] | undefined; website?: string | null | undefined; memberLimit?: number | null | undefined }) {
    const s = this.s();
    const a = await this.require(ctx.p, id, 'settings');
    const g = a.group;
    if (g.parent_id && (patch.categoryId !== undefined || patch.location !== undefined)) throw new HttpProblem(422, 'Not for a channel', 'Categories and places belong to the group, not to its channels.', { extensions: { step: 'parent' } });
    // B-4401: a channel's label is never below its group's.
    if (g.parent_id && patch.label !== undefined && a.parent && labelRank(patch.label) < labelRank(a.parent.group.label)) throw new HttpProblem(422, 'Label below the group’s', `A channel of ${a.parent.group.name} is labelled at least ${a.parent.group.label}.`, { extensions: { step: 'label-floor' } });
    if (patch.categoryId) await this.depth.category(g.tenant_id, patch.categoryId);
    const upd: Record<string, unknown> = { updated_at: Date.now() };
    if (patch.name !== undefined) upd.name = patch.name;
    if (patch.description !== undefined) upd.description = patch.description ? await s.keys.seal(g.tenant_id, patch.description, `group:${g.id}`) : null;
    if (patch.visibility !== undefined) upd.visibility = patch.visibility;
    if (patch.joinMode !== undefined) upd.join_mode = patch.joinMode;
    if (patch.categoryId !== undefined) upd.category_id = patch.categoryId;
    if (patch.location !== undefined) Object.assign(upd, await this.locationColumns(g.tenant_id, g.id, patch.location));
    // 1.7.0 (B-9703): tags and the website pass the guardrail; lowering the limit below the count removes nobody.
    Object.assign(upd, await this.profile.columns(ctx.p, g, patch));
    let raisedChannels: string[] = [];
    if (patch.label !== undefined) {
      const w = await s.tenants.workspace(g.tenant_id, g.workspace_id);
      if (w && labelRank(patch.label) > labelRank(w.label_ceiling)) throw new HttpProblem(422, 'Label above the workspace ceiling', `The workspace allows content up to ${w.label_ceiling}.`);
      if (!clears(ctx.p.clearance, patch.label)) throw forbidden(`You are not cleared for ${patch.label}.`, { step: 'clearance' });
      // 1.7.0 (B-9709): a linked conversation is never labelled below its group (nor below a channel that rises with it).
      if (labelRank(patch.label) > labelRank(g.label)) {
        await this.conversations.assertLabel(g, patch.label);
        for (const c of g.parent_id ? [] : await this.channelIds(g.id)) await this.conversations.assertLabel({ id: c, tenant_id: g.tenant_id }, patch.label);
      }
      // Posts carry the group's label: raising it raises theirs (never lowers what was written under a higher one).
      if (labelRank(patch.label) > labelRank(g.label)) {
        await s.db('group_posts').where({ group_id: g.id }).update({ label: patch.label });
        await s.db('group_events').where({ group_id: g.id }).update({ label: patch.label });
        // B-4401: the group's label is its channels' floor: those below it rise with it (with their posts and events).
        if (!g.parent_id) {
          const below = (await s.db('social_groups').where({ parent_id: g.id }).whereNot({ state: 'deleted' }).select('id', 'label')) as { id: string; label: string }[];
          raisedChannels = below.filter((c) => labelRank(isLabel(c.label) ? c.label : 'internal') < labelRank(patch.label!)).map((c) => c.id);
          if (raisedChannels.length) {
            await s.db('social_groups').whereIn('id', raisedChannels).update({ label: patch.label, updated_at: Date.now() });
            await s.db('group_posts').whereIn('group_id', raisedChannels).update({ label: patch.label });
            await s.db('group_events').whereIn('group_id', raisedChannels).update({ label: patch.label });
          }
        }
      }
      upd.label = patch.label;
    }
    await s.db('social_groups').where({ id: g.id }).update(upd);
    const after = (await this.row(g.tenant_id, g.id))!;
    const changed = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
    await this.audit(ctx, 'group.updated', { group: g.id, workspace: g.workspace_id }, { changed, before: { name: g.name, visibility: g.visibility, joinMode: g.join_mode, label: g.label, category: g.category_id, memberLimit: g.member_limit }, after: { name: after.name, visibility: after.visibility, joinMode: after.join_mode, label: after.label, category: after.category_id, memberLimit: after.member_limit }, ...(raisedChannels.length ? { channelsRaised: raisedChannels } : {}) }, after.label);
    this.event(g.tenant_id, 'group.updated', after.label, { group: g.id, workspace: g.workspace_id, actor: ctx.p.userId });
    // Who may be in the room can change with the visibility or label: everyone there is checked again.
    if (patch.visibility !== undefined || patch.label !== undefined) {
      s.rooms.accessChanged({ tenantId: g.tenant_id, kind: 'group', id: g.id, ...(patch.label ? { label: patch.label } : {}) });
      // Who reads a group decides who reads its channels: their rooms are checked again too.
      for (const c of g.parent_id ? [] : await this.channelIds(g.id)) s.rooms.accessChanged({ tenantId: g.tenant_id, kind: 'group', id: c, ...(raisedChannels.includes(c) && patch.label ? { label: patch.label } : {}) });
    }
    this.room(after, 'group.updated', { name: after.name, visibility: after.visibility, joinMode: after.join_mode, label: after.label });
    return this.present(after, a, { members: (await this.memberCounts([after.id])).get(after.id) ?? 0 }, ctx.p);
  }

  async remove(ctx: Ctx, id: string) {
    const s = this.s();
    const a = await this.require(ctx.p, id, 'delete');
    const g = a.group;
    // B-4401: a group's channels go with it.
    const channels = g.parent_id ? [] : await this.channelIds(g.id);
    const all = [g.id, ...channels];
    await s.db('social_groups').whereIn('id', all).update({ state: 'deleted', updated_at: Date.now() });
    await s.db('group_requests').whereIn('group_id', all).andWhere({ state: 'pending' }).update({ state: 'cancelled', pending_key: null, decided_by: ctx.p.userId, decided_at: Date.now() });
    let cancelled = 0;
    for (const x of all) cancelled += await s.calendar.cancelRemindersForGroup(g.tenant_id, x);
    // 1.7.0 (B-9709): a linked conversation is left to the people in it, as an ordinary one.
    for (const x of all) await this.conversations.groupDeleted(ctx, { id: x, tenant_id: g.tenant_id, workspace_id: g.workspace_id, label: g.label });
    await this.audit(ctx, g.parent_id ? 'group.channel.deleted' : 'group.deleted', { group: g.parent_id ?? g.id, ...(g.parent_id ? { channel: g.id } : {}), workspace: g.workspace_id }, { name: g.name, remindersCancelled: cancelled, ...(channels.length ? { channels: channels.length } : {}) }, g.label);
    for (const x of all) this.event(g.tenant_id, 'group.deleted', g.label, { group: x, workspace: g.workspace_id, actor: ctx.p.userId });
    for (const x of all) s.rooms.accessChanged({ tenantId: g.tenant_id, kind: 'group', id: x });
    return { id: g.id, state: 'deleted' as const, ...(channels.length ? { channels: channels.length } : {}) };
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
      await trx('group_members').where({ group_id: g.id, user_id: userId }).update({ role: 'owner', custom_role_id: null });
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
    // B-4401: its channels are archived with it.
    const channels = g.parent_id ? [] : await this.channelIds(g.id);
    if (channels.length) await s.db('social_groups').whereIn('id', channels).andWhere({ state: 'active' }).update({ state: 'archived', updated_at: Date.now() });
    const cancelledRequests = await s.db('group_requests').whereIn('group_id', [g.id, ...channels]).andWhere({ state: 'pending' }).update({ state: 'cancelled', pending_key: null, decided_by: ctx.p.userId, decided_at: Date.now() });
    let cancelledReminders = 0;
    for (const x of [g.id, ...channels]) cancelledReminders += await s.calendar.cancelRemindersForGroup(g.tenant_id, x);
    const members = ((await this.db('group_members').where({ group_id: g.id }).select('user_id')) as { user_id: string }[]).map((r) => r.user_id);
    await this.audit(ctx, 'group.archived', { group: g.id, workspace: g.workspace_id }, { name: g.name, members: members.length, requestsCancelled: cancelledRequests, remindersCancelled: cancelledReminders }, g.label);
    this.event(g.tenant_id, 'group.updated', g.label, { group: g.id, workspace: g.workspace_id, actor: ctx.p.userId });
    this.room(g, 'group.updated', { state: 'archived' });
    await s.notifications.notify({ tenantId: g.tenant_id, userIds: members, kind: 'group', title: `${g.name} was archived`, body: 'You can still read its posts and events; nothing new can be posted or scheduled.', route: `groups?id=${g.id}`, label: g.label });
    return { id: g.id, state: 'archived' as const, members: members.length };
  }

  // ---------- members ----------

  /**
   * A group's members, oldest membership first. 1.7.0 (B-9704): `q` matches the user name or the display name, `role`
   * keeps one role, and with `limit` or `cursor` the answer is a page cut by keyset on (joined, user id), which no
   * join or leave between two requests disturbs.
   */
  async members(p: Principal, id: string, q?: undefined): Promise<MemberView[]>;
  async members(p: Principal, id: string, q: PageQuery & { role?: GroupRole | undefined; departed?: boolean | undefined }): Promise<MemberView[] | Page<MemberView>>;
  async members(p: Principal, id: string, q: PageQuery & { role?: GroupRole | undefined; departed?: boolean | undefined } = {}): Promise<MemberView[] | Page<MemberView>> {
    const a = await this.require(p, id, 'read');
    // 1.7.0 (B-9801): members whose account is no longer active are left out, unless a manager asks to see them.
    const departed = !!q.departed && a.manager;
    const like = likeOf(q.q);
    const base = () => this.db('group_members as m').join('users as u', 'u.id', 'm.user_id').where({ 'm.group_id': id }).modify((qb) => {
      if (!departed) qb.andWhere({ 'u.state': 'active' });
      if (q.role) qb.andWhere({ 'm.role': q.role });
      if (like) qb.andWhere((w) => { void w.whereRaw('lower(u.username) like ?', [like]).orWhereRaw('lower(u.display_name) like ?', [like]); });
    });
    const custom = await this.roles.forGroup(id);
    const view = (r: { user_id: string; role: GroupRole; custom_role_id: string | null; joined_at: number; username: string; display_name: string; state: string }): MemberView => {
      const c = r.custom_role_id ? custom.get(r.custom_role_id) : null;
      return { userId: r.user_id, username: r.username, displayName: r.display_name, role: r.role, customRole: c ? { id: c.id, name: c.name } : null, joinedAt: Number(r.joined_at), ...(departed && r.state !== 'active' ? { departed: true } : {}) };
    };
    const select = ['m.user_id', 'm.role', 'm.custom_role_id', 'm.joined_at', 'u.username', 'u.display_name', 'u.state'];
    if (!paged(q)) return ((await base().select(select).orderBy('m.joined_at').orderBy('m.user_id')) as Parameters<typeof view>[0][]).map(view);
    const size = pageSize(q);
    const rows = (await base().modify((qb) => {
      if (!q.cursor) return;
      const [t, uid] = decodeCursor(q.cursor, ['number', 'string'] as const);
      qb.andWhere((w) => { void w.where('m.joined_at', '>', t).orWhere((o) => { void o.where('m.joined_at', t).andWhere('m.user_id', '>', uid); }); });
    }).select(select).orderBy('m.joined_at').orderBy('m.user_id').limit(size + 1)) as Parameters<typeof view>[0][];
    const total = Number(((await base().count({ n: '*' })) as { n: number | string }[])[0]?.n ?? 0);
    const items = rows.slice(0, size).map(view);
    const last = items[items.length - 1];
    return { items, next: last && rows.length > size ? encodeCursor([last.joinedAt, last.userId]) : null, total };
  }

  /**
   * The members of a group who would be let in now, decided in one query: active, in the group's workspace by
   * membership, and cleared for its label (B-9708: who a notice about the group goes to). It is narrower than the
   * request-time check (someone who reaches the workspace by a role alone is left out), never wider. With `right`,
   * only the members who hold it (B-9705).
   */
  async membersWithAccess(g: Pick<GroupRow, 'id' | 'tenant_id' | 'workspace_id' | 'label'>, right?: GroupRight): Promise<string[]> {
    const holders = right ? new Set(await this.roles.holders(g.id, right)) : null;
    const rows = (await this.db('group_members as m').join('users as u', 'u.id', 'm.user_id').join('workspace_members as wm', (j) => { j.on('wm.user_id', 'm.user_id').andOnVal('wm.workspace_id', g.workspace_id); })
      .where({ 'm.group_id': g.id, 'u.tenant_id': g.tenant_id, 'u.state': 'active' })
      .distinct('m.user_id', 'u.clearance')) as { user_id: string; clearance: string }[];
    // 1.7.0 (B-9701): a suspended member is told nothing of the group until the suspension ends.
    const barred = await this.bans.usersBarred(g.id, rows.map((r) => r.user_id));
    return rows.filter((r) => isLabel(r.clearance) && clears(r.clearance, g.label) && !barred.has(r.user_id) && (!holders || holders.has(r.user_id))).map((r) => r.user_id);
  }

  /** B-9708: tells the group's owners and moderators (those still let in), never the person who acted. */
  private async tellModerators(g: GroupRow, exceptUserId: string | null, title: string): Promise<void> {
    // Whoever decides who joins (owners, admins, moderators, a custom role with the right) hears who came and went.
    const to = (await this.membersWithAccess(g, 'decide')).filter((u) => u !== exceptUserId);
    if (to.length) await this.s().notifications.notify({ tenantId: g.tenant_id, userIds: to, kind: 'group.member', title, route: `groups?id=${g.id}`, label: g.label });
  }

  private async nameOf(tenantId: string, userId: string): Promise<string> {
    const u = (await this.db('users').where({ tenant_id: tenantId, id: userId }).first('display_name', 'username')) as { display_name: string | null; username: string } | undefined;
    return u?.display_name || u?.username || 'A member';
  }

  /** 1.7.0 (B-9801): owners whose account is active; a disabled or departed owner does not keep a group owned. */
  private async owners(groupId: string): Promise<number> {
    return this.ownership.activeOwners(groupId);
  }

  /** 1.7.0 (B-9801): a holder of groups:manage takes ownership of a group with no active owner. */
  async claimOwnership(ctx: Ctx, id: string) {
    const a = await this.access(ctx.p, id);
    const out = await this.ownership.claim(ctx, id, a.manager, async (g, userId) => { await this.addMember(g, userId, 'owner', userId); });
    await this.conversations.sync(id);
    this.event(a.group.tenant_id, 'group.updated', a.group.label, { group: id, workspace: a.group.workspace_id, actor: ctx.p.userId });
    this.room(a.group, 'group.member.role', { userId: ctx.p.userId, role: 'owner' });
    return out;
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
      // 1.7.0 (B-9701): nobody a ban or suspension keeps out is offered.
      .whereNotIn('u.id', this.bans.barredUsersQuery(g))
      .modify((qb) => { if (g.parent_id) qb.whereIn('u.id', this.db('group_members').where({ group_id: g.parent_id }).select('user_id')); })
      .modify((qb) => { if (like) qb.andWhere((w) => { void w.whereRaw('lower(u.username) like ?', [like]).orWhereRaw('lower(u.display_name) like ?', [like]); }); })
      .distinct('u.id', 'u.username', 'u.display_name', 'u.clearance').orderBy('u.display_name').limit(200)) as { id: string; username: string; display_name: string | null; clearance: string }[];
    return rows.filter((u) => isLabel(u.clearance) && clears(u.clearance, g.label)).slice(0, 50).map((u) => ({ userId: u.id, username: u.username, displayName: u.display_name ?? u.username }));
  }

  /** Adds a member; with `limited`, only while the group is below its member limit (B-9703), else 409. */
  private async addMember(g: GroupRow, userId: string, role: GroupRole, by: string | null, limited = false): Promise<boolean> {
    try {
      const row = { group_id: g.id, tenant_id: g.tenant_id, user_id: userId, role, custom_role_id: null, added_by: by, joined_at: Date.now() };
      // 1.7.0 (B-9701): whichever way in this is, a standing ban or suspension refuses it here.
      if (limited) await this.db.transaction(async (trx) => {
        await this.bans.assertNone(g, userId, 'other', trx);
        await this.profile.assertRoom(g, trx);
        await trx('group_members').insert(row);
      });
      else {
        await this.bans.assertNone(g, userId, 'other');
        await this.db('group_members').insert(row);
      }
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
    this.event(g.tenant_id, 'group.member.added', g.label, { group: g.id, workspace: g.workspace_id, actor: by, user: userId, role });
    this.room(g, 'group.member.added', { userId, role });
    // 1.7.0 (B-9709): the group's conversation takes the new member.
    await this.conversations.sync(g.id);
    return true;
  }

  /**
   * Gives a member a tier, or one of the group's custom roles (B-9705). The rule is `covers`, both ways: nobody changes
   * the role of a member who holds a right they do not, and nobody gives rights they do not hold. A person changes
   * their own role only to fewer rights. The last owner stays one.
   */
  async setRole(ctx: Ctx, id: string, userId: string, role: GroupRole, customRoleId: string | null = null) {
    const a = await this.require(ctx.p, id, 'roles');
    const m = await this.member(id, userId);
    if (!m) throw notFound('Member');
    const custom = customRoleId ? await this.roles.row(id, customRoleId) : null;
    if (customRoleId && !custom) throw notFound('Role');
    // A custom role is held with the tier `member`: its rights are the whole of what the member may do.
    const tier: GroupRole = custom ? 'member' : role;
    if (m.role === tier && (m.custom_role_id ?? null) === (custom?.id ?? null)) return { userId, role: tier, customRole: custom ? { id: custom.id, name: custom.name } : null };
    const before = await this.roles.rightsOf(id, m);
    const after = this.roles.rightsFrom({ role: tier, custom_role_id: custom?.id ?? null }, custom);
    if (userId === ctx.p.userId && !covers(before, after)) throw forbidden('You cannot give yourself rights you do not hold; someone else changes your role.', { step: 'self-grant' });
    if (!covers(a.rights, before)) throw forbidden('This member holds rights you do not; you cannot change their role.', { step: 'group-role' });
    if (!covers(a.rights, after)) throw forbidden('You cannot give a role that carries rights you do not hold yourself.', { step: 'group-role', rights: [...after].filter((r) => !a.rights.has(r)) });
    if (ownsGroup(before) && !ownsGroup(after) && (await this.owners(id)) <= 1) throw conflict('A group needs at least one owner; make someone else owner first.');
    await this.db('group_members').where({ group_id: id, user_id: userId }).update({ role: tier, custom_role_id: custom?.id ?? null });
    const name = custom?.name ?? tier;
    await this.audit(ctx, 'group.member.role', { group: id, user: userId }, { before: m.role, after: tier, beforeCustomRole: m.custom_role_id ?? null, afterCustomRole: custom?.id ?? null, rightsBefore: [...before], rightsAfter: [...after] }, a.group.label);
    this.room(a.group, 'group.member.role', { userId, role: tier, customRoleId: custom?.id ?? null });
    // What they may see in the room can change with the role; the linked conversation reads it on the next request.
    this.s().rooms.accessChanged({ tenantId: a.group.tenant_id, kind: 'group', id, userIds: [userId] });
    // 1.7.0 (B-9708): the member is told of their new role (not when they changed it themselves).
    if (userId !== ctx.p.userId && (await this.membersWithAccess(a.group)).includes(userId)) await this.s().notifications.notify({ tenantId: a.group.tenant_id, userIds: [userId], kind: 'group.role', title: `Your role in ${a.group.name} is now ${name}`, route: `groups?id=${id}`, label: a.group.label });
    return { userId, role: tier, customRole: custom ? { id: custom.id, name: custom.name } : null };
  }

  /** Leaves (one's own id) or removes a member (moderators: members only; owners and managers: anyone). */
  async removeMember(ctx: Ctx, id: string, userId: string) {
    const s = this.s();
    const self = userId === ctx.p.userId;
    const a = self ? await this.access(ctx.p, id) : await this.require(ctx.p, id, 'remove-members');
    const m = await this.member(id, userId);
    if (!m) throw notFound('Member');
    // B-9705: removing someone who holds more than a member takes the right `roles`, and never reaches above oneself.
    const held = await this.roles.rightsOf(id, m);
    if (!self && isStaff(held) && (!can(a, 'roles') || !covers(a.rights, held))) throw forbidden('Only an owner removes owners and moderators.', { step: 'group-role' });
    if (ownsGroup(held) && (await this.owners(id)) <= 1) throw conflict('The last owner cannot leave; make someone else owner or delete the group.');
    // B-4401: leaving a group leaves its channels.
    const channels = a.group.parent_id ? [] : ((await s.db('group_members as m').join('social_groups as c', 'c.id', 'm.group_id').where({ 'c.parent_id': id, 'm.user_id': userId }).select('m.group_id')) as { group_id: string }[]).map((r) => r.group_id);
    await s.db.transaction(async (trx) => {
      await trx('group_members').where({ group_id: id, user_id: userId }).delete();
      if (channels.length) await trx('group_members').whereIn('group_id', channels).andWhere({ user_id: userId }).delete();
    });
    // 1.7.0 (B-9709): they leave the conversations of the group and of those channels with it.
    for (const x of [id, ...channels]) await this.conversations.sync(x);
    await this.audit(ctx, self ? 'group.member.left' : 'group.member.removed', { group: id, user: userId }, { role: m.role, ...(channels.length ? { channels: channels.length } : {}) }, a.group.label);
    this.event(a.group.tenant_id, 'group.member.removed', a.group.label, { group: id, workspace: a.group.workspace_id, actor: ctx.p.userId, user: userId });
    for (const c of channels) this.event(a.group.tenant_id, 'group.member.removed', a.group.label, { group: c, workspace: a.group.workspace_id, actor: ctx.p.userId, user: userId });
    // B-2101: their sockets leave the group's room at once (and stay out unless the group is public to them).
    s.rooms.accessChanged({ tenantId: a.group.tenant_id, kind: 'group', id, userIds: [userId] });
    for (const c of await this.channelIds(id)) s.rooms.accessChanged({ tenantId: a.group.tenant_id, kind: 'group', id: c, userIds: [userId] });
    this.room(a.group, 'group.member.removed', { userId });
    // 1.7.0 (B-9708): a removed member is told; the owners and moderators hear of someone leaving.
    if (self) await this.tellModerators(a.group, userId, `${await this.nameOf(a.group.tenant_id, userId)} left ${a.group.name}`);
    else if ((await this.eligible(a.group, userId)).ok) await s.notifications.notify({ tenantId: a.group.tenant_id, userIds: [userId], kind: 'group.member', title: `You were removed from ${a.group.name}`, route: 'groups', label: a.group.label });
    return { userId, removed: true, ...(channels.length ? { channels: channels.length } : {}) };
  }

  // ---------- joining, requests, invitations ----------

  /** Joins an open group, asks to join a request group; invitation-only groups refuse. */
  async join(ctx: Ctx, id: string, opts: { message?: string | null | undefined } = {}): Promise<{ joined: true; role: GroupRole } | { requested: true; request: ReturnType<typeof requestView> }> {
    const p = ctx.p;
    // accessOrNull already refuses anyone outside the group's workspace: they cannot join (B-2501).
    const a = await this.access(p, id);
    const g = a.group;
    // 1.7.0 (B-9701): a ban or suspension, here or in the channel's group, refuses every way in.
    await this.bans.assertNone(g, p.userId, 'self');
    if (a.role) throw conflict('You are already a member of this group.');
    if (!clears(p.clearance, g.label)) throw forbidden(`The group is labelled ${g.label}, above your clearance of ${p.clearance}.`, { step: 'clearance' });
    if (g.state !== 'active') throw conflict('The group is not accepting members.');
    // B-4401: only the group's members join its channels (a manager acting as owner is not a member).
    if (g.parent_id && !a.parent?.role) throw forbidden('Join the group first; its channels are for its members.', { step: 'parent' });
    const invite = await this.pendingFor(g.id, p.userId, 'invite');
    if (invite) {
      const out = await this.decide(ctx, invite.id, 'accept');
      return { joined: true, role: out.role };
    }
    if (g.join_mode === 'open') {
      // 1.7.0 (B-9703): the last place is taken under a lock on the group's row.
      await this.addMember(g, p.userId, 'member', p.userId, true);
      await this.audit(ctx, 'group.member.joined', { group: g.id, user: p.userId }, { via: 'open' }, g.label);
      await this.tellModerators(g, p.userId, `${p.displayName} joined ${g.name}`);
      return { joined: true, role: 'member' };
    }
    if (g.join_mode === 'invite') throw forbidden('This group is by invitation only.', { step: 'join-mode' });
    const existing = await this.pendingFor(g.id, p.userId, 'request');
    if (existing) return { requested: true, request: requestView(existing, { message: await this.openMessage(existing) }) };
    // A full group takes no request either (B-9703).
    await this.profile.assertRoom(g);
    // 1.7.0 (B-9702): what the person wrote with the request, screened before anything is kept.
    const message = await this.invites.screenMessage(p, g, 'request', opts.message);
    const r = await this.createRequest(g, p.userId, 'request', 'member', p.userId, this.o.requestDays, message);
    await this.audit(ctx, 'group.request.created', { group: g.id, request: r.id, user: p.userId }, { expiresAt: r.expires_at, ...(message ? { message: true } : {}) }, g.label);
    const mods = await this.moderators(g.id);
    await this.s().notifications.notify({ tenantId: g.tenant_id, userIds: mods, kind: 'group.request', title: `${p.displayName} asked to join ${g.name}`, route: `groups?id=${g.id}`, label: g.label });
    return { requested: true, request: requestView(r, { message }) };
  }

  /** B-9702: the message of a request or an invitation, opened for someone who may read it. */
  private async openMessage(r: RequestRow): Promise<string | null> {
    return r.message ? ((await this.s().keys.open(r.tenant_id, r.message, `group-request:${r.id}`)) ?? null) : null;
  }

  /** B-9702: admits the caller by an invite link whose place they have taken; false when they were a member already. */
  async admitByLink(ctx: Ctx, g: GroupRow, linkId: string, invitedBy: string): Promise<boolean> {
    const p = ctx.p;
    const joined = await this.addMember(g, p.userId, 'member', invitedBy, true);
    if (!joined) return false;
    await this.audit(ctx, 'group.member.joined', { group: g.id, user: p.userId }, { via: 'invite-link', link: linkId }, g.label);
    await this.tellModerators(g, p.userId, `${p.displayName} joined ${g.name}`);
    return true;
  }

  /** Who decides the group's requests to join. */
  private async moderators(groupId: string): Promise<string[]> {
    return this.roles.holders(groupId, 'decide');
  }

  private async createRequest(g: GroupRow, userId: string, kind: RequestRow['kind'], role: GroupRole, by: string, days: number, message: string | null = null): Promise<RequestRow> {
    const t = Date.now();
    const id = ulid();
    const row: RequestRow = { id, tenant_id: g.tenant_id, group_id: g.id, user_id: userId, kind, role, state: 'pending', pending_key: `${g.id}:${userId}`, created_by: by, created_at: t, expires_at: t + days * 86_400_000, decided_by: null, decided_at: null, message: message ? await this.s().keys.seal(g.tenant_id, message, `group-request:${id}`) : null };
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

  async invite(ctx: Ctx, id: string, userId: string, role: GroupRole, text?: string | null) {
    const a = await this.require(ctx.p, id, 'invite');
    const g = a.group;
    // B-9705: an invitation to more than a member's rights takes the right `roles`, and never carries more than the inviter holds.
    const offered = tierRights(role);
    if (isStaff(offered) && (!can(a, 'roles') || !covers(a.rights, offered))) throw forbidden('Only an owner invites owners and moderators.', { step: 'group-role' });
    // 1.7.0 (B-9701): nobody is invited back while a ban or suspension stands (a suspended member is one still).
    await this.bans.assertNone(g, userId, 'other');
    if (await this.member(g.id, userId)) throw conflict('The user is already a member of this group.');
    // 1.9.0 (B-159 to B-161): invitations are counted for the spam checks; an enforcing policy may slow or limit them.
    await this.s().spam.gate(ctx.p, 'invite');
    this.s().spam.record({ tenantId: g.tenant_id, surface: 'invite', userId: ctx.p.userId, ip: ctx.ip, recipient: userId });
    await this.profile.assertRoom(g);
    const e = await this.eligible(g, userId);
    if (!e.ok) throw new HttpProblem(422, 'Cannot invite this user', e.why, { extensions: { step: 'workspace' } });
    const message = await this.invites.screenMessage(ctx.p, g, 'invite', text);
    const r = await this.createRequest(g, userId, 'invite', role, ctx.p.userId, this.o.inviteDays, message);
    await this.audit(ctx, 'group.invite.created', { group: g.id, request: r.id, user: userId }, { role, expiresAt: r.expires_at, ...(message ? { message: true } : {}) }, g.label);
    await this.s().notifications.notify({ tenantId: g.tenant_id, userIds: [userId], kind: 'group.invite', title: `${ctx.p.displayName} invited you to the group ${g.name}`, route: `groups?invite=${r.id}`, label: g.label });
    return requestView(r, { message });
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
      out.push(requestView(r, { userName: (raw.display_name as string | null) ?? null, message: await this.openMessage(r) }));
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
      out.push(requestView(r, { groupName: String(raw.group_name), message: await this.openMessage(r) }));
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
      // 1.7.0 (B-9701): nothing pending is accepted while a ban or suspension stands.
      await this.bans.assertNone(g, r.user_id, r.kind === 'invite' ? 'self' : 'other');
      // B-9703: a full group accepts nobody; the request or invitation stays pending until there is room or it expires.
      await this.profile.assertRoom(g);
    }
    const n = await this.db('group_requests').where({ id: r.id, state: 'pending' }).update({ state: decision === 'accept' ? 'accepted' : 'declined', pending_key: null, decided_by: p.userId, decided_at: Date.now() });
    if (!n) throw conflict('The request was decided meanwhile.');
    if (decision === 'accept') {
      try {
        await this.addMember(g, r.user_id, r.role, r.kind === 'invite' ? r.created_by : p.userId, true);
      } catch (err) {
        // The last place went to someone else meanwhile: the request is pending again.
        await this.db('group_requests').where({ id: r.id, state: 'accepted' }).update({ state: 'pending', pending_key: r.pending_key ?? `${g.id}:${r.user_id}`, decided_by: null, decided_at: null });
        throw err;
      }
      if (r.kind === 'invite') await this.tellModerators(g, r.user_id, `${await this.nameOf(g.tenant_id, r.user_id)} joined ${g.name}`);
    }
    await this.audit(ctx, `group.${r.kind}.${decision === 'accept' ? 'accepted' : 'declined'}`, { group: g.id, request: r.id, user: r.user_id }, { role: r.role }, g.label);
    if (r.kind === 'request') await this.s().notifications.notify({ tenantId: g.tenant_id, userIds: [r.user_id], kind: 'group.request', title: decision === 'accept' ? `You joined the group ${g.name}` : `Your request to join ${g.name} was declined`, route: `groups?id=${g.id}`, label: g.label });
    const after = await this.loadRequest(p.tenantId, r.id);
    return { request: requestView(after, { message: await this.openMessage(after) }), role: r.role };
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

  /** A post as its reader sees it. One held for review, or rejected, reaches only its author (`posts` reads it so). */
  async postView(x: PostRow, extra: { authorName?: string | null; held?: HeldRow | undefined } = {}) {
    const waits = x.state === 'held' || x.state === 'rejected';
    const body = x.state === 'published' || waits ? ((await this.s().keys.open(x.tenant_id, x.body, `group-post:${x.id}`)) ?? '') : null;
    const held = waits ? (extra.held ? this.s().held.senderView(extra.held) : { id: null, kind: 'group-post', state: x.state, reason: 'review', note: null, since: x.created_at }) : null;
    return { id: x.id, groupId: x.group_id, authorId: x.author_id, authorName: extra.authorName ?? null, body, label: x.label, state: x.state, held, createdAt: x.created_at, updatedAt: x.updated_at };
  }

  async posts(p: Principal, id: string, q: { before?: number | undefined; limit?: number | undefined }) {
    const a = await this.require(p, id, 'read');
    const mod = can(a, 'moderate');
    const rows = ((await this.db('group_posts as x').join('users as u', 'u.id', 'x.author_id').where({ 'x.group_id': id }).modify((qb) => {
      if (q.before) qb.andWhere('x.created_at', '<', q.before);
      // Moderators also see hidden posts (as hidden, without the text); deleted posts are gone for everyone. What waits
      // for review, or was rejected, is in its author's list only (B-9402), moderators included.
      qb.andWhere((w) => w.whereIn('x.state', mod ? ['published', 'hidden'] : ['published']).orWhere((o) => o.where('x.author_id', p.userId).whereIn('x.state', ['held', 'rejected'])));
    }).orderBy('x.created_at', 'desc').limit(Math.min(q.limit ?? 50, 200)).select('x.*', 'u.display_name')) as Record<string, unknown>[]);
    const own = rows.map(postFrom).filter((x) => x.state === 'held' || x.state === 'rejected').map((x) => x.id);
    const waiting = own.length ? await this.s().held.waiting(p.tenantId, own) : new Map<string, HeldRow>();
    return Promise.all(rows.map((r) => this.postView(postFrom(r), { authorName: (r.display_name as string | null) ?? null, held: waiting.get(String(r.id)) })));
  }

  private checkPost(p: Principal, g: Pick<GroupRow, 'tenant_id' | 'workspace_id' | 'label' | 'id'>, postId: string, text: string): Promise<GuardDecision> {
    return this.s().guardrails.check({ tenantId: g.tenant_id, workspaceId: g.workspace_id, checkpoint: 'user-input', text, label: g.label, principal: p, source: { kind: POST_OBJECT, id: postId }, meta: { objectType: POST_OBJECT, group: g.id } });
  }

  async createPost(ctx: Ctx, id: string, body: string) {
    const s = this.s();
    const a = await this.require(ctx.p, id, 'post');
    const g = a.group;
    if (g.state !== 'active') throw conflict('The group is not open for posts.');
    const postId = ulid();
    // The guardrail checkpoint for what people write (as for a chat prompt). 1.7.0 (B-9402, B-9403): a block refuses;
    // a hold waits, seen by its author only, for a reviewer or for the check that could not run.
    // 1.9.0 (B-159 to B-161): counted for the spam checks; an enforcing policy may slow, limit (429) or hold it.
    const spam = await s.spam.gate(ctx.p, 'post');
    s.spam.record({ tenantId: g.tenant_id, surface: 'post', userId: ctx.p.userId, ip: ctx.ip, text: body, recipient: g.id });
    const d = withSpamHold(await this.checkPost(ctx.p, g, postId, body), spam.hold);
    if (d.action === 'block') throw refusal(d, 'post');
    const hold = d.action === 'require-approval' ? holdReason(d) : null;
    if (d.action === 'require-approval' && !hold) throw refusal(d, 'post');
    const text = d.action === 'redact' || hold ? d.text : body;
    const t = Date.now();
    if (hold) {
      const held: PostRow = { id: postId, tenant_id: g.tenant_id, group_id: g.id, workspace_id: g.workspace_id, author_id: ctx.p.userId, body: await s.keys.seal(g.tenant_id, text, `group-post:${postId}`), label: g.label, state: 'held', created_at: t, updated_at: t };
      await s.db('group_posts').insert(held);
      try {
        const h = await s.held.hold({ p: ctx.p, ip: ctx.ip, traceId: ctx.traceId, kind: 'group-post', objectId: postId, scopeId: g.id, workspaceId: g.workspace_id, label: g.label, text, storeText: false, decision: d, via: 'groups' });
        await this.audit(ctx, 'group.post.held', { group: g.id, post: postId, held: h.id }, { length: text.length, reason: h.reason }, g.label);
        return await this.postView(held, { authorName: ctx.p.displayName, held: h });
      } catch (err) {
        await s.db('group_posts').where({ id: postId, state: 'held' }).delete();
        throw err;
      }
    }
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
    if (x.state === 'held' || x.state === 'rejected') {
      // Its author takes back what waits for review (the flag is closed) or clears a rejected post; to anyone else it
      // does not exist.
      if (!own) throw notFound('Post');
      if (x.state === 'held' && !(await s.held.withdrawFor(ctx, x.id, 'group-post'))) await s.db('group_posts').where({ id: x.id, state: 'held' }).delete();
      if (x.state === 'rejected') await s.db('group_posts').where({ id: x.id, state: 'rejected' }).delete();
      return { id: x.id, state: 'deleted' as const };
    }
    const a = own ? await this.require(ctx.p, x.group_id, 'read') : await this.require(ctx.p, x.group_id, 'moderate');
    if (x.state === 'deleted') throw notFound('Post');
    if (x.state === 'hidden' && !can(a, 'moderate')) throw notFound('Post');
    const n = await s.db('group_posts').where({ id: x.id, state: x.state }).update({ state: 'deleted', updated_at: Date.now() });
    if (!n) throw conflict('The post changed meanwhile.');
    await this.audit(ctx, 'group.post.deleted', { group: x.group_id, post: x.id }, { by: own ? 'author' : 'moderator', author: x.author_id }, x.label);
    this.event(x.tenant_id, 'group.post.deleted', x.label, { group: x.group_id, workspace: x.workspace_id, actor: ctx.p.userId, post: x.id });
    this.room(a.group, 'group.post.deleted', { postId: x.id });
    return { id: x.id, state: 'deleted' as const };
  }

  // The cases about the group's content, and what its moderators do with them, are `caseWork` (cases.ts, B-9706).

  // ---------- moderation object types (B-2505) ----------

  /** May this principal read the group's content, given the workspaces the moderation service resolved? */
  private async readsGroup(p: Principal, groupId: string, workspaces: string[]): Promise<boolean> {
    return !!(await this.accessOrNull(p, groupId, workspaces))?.read;
  }

  // ---------- held group posts (B-9402, B-9403) ----------

  private registerHeld(): void {
    const s = this.s();
    const db = () => this.s().db;
    const post = async (h: HeldRow): Promise<PostRow | null> => {
      const r = await db()('group_posts').where({ tenant_id: h.tenant_id, id: h.object_id }).first();
      return r ? postFrom(r) : null;
    };
    s.held.register({
      kinds: ['group-post'],
      text: async (h) => {
        const x = await post(h);
        return x && x.state === 'held' ? ((await s.keys.open(x.tenant_id, x.body, `group-post:${x.id}`)) ?? '') : null;
      },
      deliver: async (h, text) => {
        const x = await post(h);
        const g = x ? await this.row(h.tenant_id, x.group_id) : null;
        if (!x || x.state !== 'held' || !g || g.state !== 'active') return false;
        const n = await db()('group_posts').where({ id: x.id, state: 'held' }).update({ state: 'published', updated_at: Date.now(), ...(text != null ? { body: await s.keys.seal(h.tenant_id, text, `group-post:${x.id}`) } : {}) });
        if (!n) return false;
        await s.audit.append({ tenantId: h.tenant_id, action: 'group.post.created', kind: 'system', actor: { service: 'moderation.held' }, target: { group: g.id, post: x.id, held: h.id }, label: g.label, detail: { author: x.author_id, afterHold: h.reason } });
        this.event(g.tenant_id, 'group.post.created', g.label, { group: g.id, workspace: g.workspace_id, actor: x.author_id, post: x.id });
        // To everyone in the group, the author too: their own view of it changes from held to published.
        this.room(g, 'group.post.created', { postId: x.id, authorId: x.author_id, released: true });
        return true;
      },
      discard: async (h, why) => {
        if (why === 'rejected') await db()('group_posts').where({ id: h.object_id, state: 'held' }).update({ state: 'rejected', updated_at: Date.now() });
        else await db()('group_posts').where({ id: h.object_id }).whereIn('state', ['held', 'rejected']).delete();
      },
      rescreen: async (h, author, text) => {
        const a = await this.accessOrNull(author, h.scope_id).catch(() => null);
        if (!a || a.group.state !== 'active' || !can(a, 'post')) return null;
        return this.checkPost(author, a.group, h.object_id, text);
      },
      context: async (h) => {
        const g = await this.row(h.tenant_id, h.scope_id);
        const route = `groups?id=${h.scope_id}`;
        if (!g) return { place: 'A group that no longer exists', route, items: [] };
        const rows = (await db()('group_posts as x').join('users as u', 'u.id', 'x.author_id').where({ 'x.group_id': g.id, 'x.state': 'published' }).andWhere('x.created_at', '<', h.created_at).orderBy('x.created_at', 'desc').limit(3).select('x.*', 'u.display_name')) as Record<string, unknown>[];
        const items = [];
        for (const r of rows.reverse()) {
          const x = postFrom(r);
          items.push({ id: x.id, authorId: x.author_id, authorName: (r.display_name as string | null) ?? null, text: (await s.keys.open(x.tenant_id, x.body, `group-post:${x.id}`)) ?? '', label: x.label, createdAt: x.created_at });
        }
        return { place: `The group ${g.name}`, route, items };
      }
    });
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
          // 1.7.0 (B-9402): a post that waits for review, or was rejected, exists for its author only.
          if ((o.state === 'held' || o.state === 'rejected') && o.ownerId !== p.userId) return false;
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
