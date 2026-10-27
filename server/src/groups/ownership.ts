import { actorFrom } from '../audit/chain.js';
import { clears, isLabel } from '../authz/labels.js';
import { rolesGranting } from '../authz/permissions.js';
import { conflict, forbidden } from '../http/problem.js';
import type { Scheduler } from '../platform/jobs.js';
import type { Services } from '../services.js';
import type { Ctx, GroupRow } from './service.js';

/*
 * 1.7.0, Sprint 43 (B-9801, GRP-6): groups whose owners have all left the tenant.
 *
 * An owner is counted only while their account is active, so a group whose last owner was disabled, deprovisioned by
 * SCIM or directory sync, or offboarded has no owner: the last-owner rules (the last owner cannot leave or step down)
 * count active owners. Holders of `groups:manage` already act as owner on every group of their workspaces; the sweep
 * tells them, once per group, that a group of theirs has no active owner, and `claim` makes one of them its owner.
 * Departed members are left out of member lists (unless a manager asks for them) and of every notice, which goes
 * through `GroupService.membersWithAccess`.
 *
 * The sweep runs every `GROUPS_OWNERLESS_MINUTES` whichever way the owner departed, rather than hooking each path
 * that disables an account; `social_groups.ownerless_at` records the first sweep that found the group ownerless and is
 * cleared when it has an active owner again.
 */

export const GROUP_OWNERLESS_JOB = 'groups.ownerless';

export class GroupOwnership {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  /** How many owners of the group have an active account. */
  async activeOwners(groupId: string): Promise<number> {
    const r = (await this.db('group_members as m').join('users as u', 'u.id', 'm.user_id').where({ 'm.group_id': groupId, 'm.role': 'owner', 'u.state': 'active' }).count({ n: '*' })) as { n: number | string }[];
    return Number(r[0]?.n ?? 0);
  }

  /** The top-level, live groups of a tenant with no owner whose account is active. */
  private async ownerless(tenantId: string): Promise<GroupRow[]> {
    const owned = this.db('group_members as m').join('users as u', 'u.id', 'm.user_id').where({ 'm.role': 'owner', 'u.state': 'active' }).select('m.group_id');
    return (await this.db('social_groups').where({ tenant_id: tenantId }).whereNull('parent_id').whereNot({ state: 'deleted' }).whereNotIn('id', owned)) as GroupRow[];
  }

  /** The holders of `groups:manage` who may act in the group's workspace, active and cleared for its label. */
  private async managers(g: GroupRow): Promise<string[]> {
    const ids = await this.s().notifications.usersWithRoles(g.tenant_id, rolesGranting('groups:manage', g.tenant_id));
    if (!ids.length) return [];
    const rows = (await this.db('users as u').join('workspace_members as wm', (j) => { j.on('wm.user_id', 'u.id').andOnVal('wm.workspace_id', g.workspace_id); })
      .whereIn('u.id', ids).where({ 'u.state': 'active' }).distinct('u.id', 'u.clearance')) as { id: string; clearance: string }[];
    return rows.filter((r) => isLabel(r.clearance) && clears(r.clearance, g.label)).map((r) => r.id);
  }

  /** One pass over a tenant: tells the managers of each newly ownerless group, and forgets groups that have an owner again. */
  async sweep(tenantId: string): Promise<{ notified: string[]; cleared: number }> {
    const s = this.s();
    const now = Date.now();
    const found = await this.ownerless(tenantId);
    const ids = found.map((g) => g.id);
    const cleared = await this.db('social_groups').where({ tenant_id: tenantId }).whereNotNull('ownerless_at').modify((q) => { if (ids.length) void q.whereNotIn('id', ids); }).update({ ownerless_at: null });
    const notified: string[] = [];
    for (const g of found.filter((x) => x.ownerless_at == null)) {
      const n = await this.db('social_groups').where({ id: g.id }).whereNull('ownerless_at').update({ ownerless_at: now });
      if (!n) continue; // another instance took it
      const to = await this.managers(g);
      if (to.length) await s.notifications.notify({ tenantId, userIds: to, kind: 'group', title: `${g.name} has no active owner`, body: 'Its owners have left. Take ownership from the group, or make one of its members owner.', route: `groups?id=${g.id}`, label: g.label });
      await s.audit.append({ tenantId, action: 'group.ownerless', kind: 'system', actor: { service: 'groups' }, target: { group: g.id, workspace: g.workspace_id }, detail: { told: to.length }, label: g.label });
      notified.push(g.id);
    }
    return { notified, cleared: Number(cleared) };
  }

  /**
   * A manager becomes owner of a group with no active owner (joining it if they are not a member). Refused while the
   * group has an active owner: ownership then changes hands through the owners, or `transferOwnership`.
   */
  async claim(ctx: Ctx, id: string, manager: boolean, add: (g: GroupRow, userId: string) => Promise<void>) {
    const s = this.s();
    if (!manager) throw forbidden('Only a holder of groups:manage takes ownership of a group.', { step: 'permission', action: 'groups:manage' });
    const g = (await this.db('social_groups').where({ tenant_id: ctx.p.tenantId, id }).first()) as GroupRow | undefined;
    if (!g || g.state === 'deleted') throw conflict('The group no longer exists.');
    if (g.parent_id) throw conflict('A channel is owned by its group\'s owners; take ownership of the group.');
    if ((await this.activeOwners(id)) > 0) throw conflict('The group has an active owner; ownership changes through them.');
    const was = await this.db('group_members').where({ group_id: id, user_id: ctx.p.userId }).first('role');
    if (was) await this.db('group_members').where({ group_id: id, user_id: ctx.p.userId }).update({ role: 'owner', custom_role_id: null });
    else await add(g, ctx.p.userId);
    await this.db('social_groups').where({ id }).update({ ownerless_at: null });
    await s.audit.append({ tenantId: g.tenant_id, action: 'group.ownership.claimed', kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target: { group: id, workspace: g.workspace_id, user: ctx.p.userId }, detail: { wasMember: !!was, previousRole: was?.role ?? null }, label: g.label, traceId: ctx.traceId ?? null });
    return { id, owner: ctx.p.userId, joined: !was };
  }

  registerJobs(): void {
    this.s().jobs.register(GROUP_OWNERLESS_JOB, async (p, ctx) => this.sweep(String(p.tenantId ?? ctx.job.tenant_id)));
  }

  schedule(scheduler: Scheduler, targets: () => Promise<{ tenantId: string; payload?: Record<string, unknown> }[]>): void {
    const minutes = this.s().cfg.GROUPS_OWNERLESS_MINUTES;
    if (minutes > 0) scheduler.every(GROUP_OWNERLESS_JOB, minutes * 60_000, targets);
  }
}
