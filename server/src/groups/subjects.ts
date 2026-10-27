import { clears, isLabel, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import type { Services } from '../services.js';

/*
 * 1.7.0, Sprint 43 (B-98, decision D14): a social group as an access subject for files and folders, vault paths,
 * knowledge bases and low-code apps.
 *
 * Every one of those asks this one question: which groups does a person count as a member of right now? A group
 * counts when the person has a member row, the account is active, the group (or its parent, for a channel) is not
 * deleted, no ban or suspension of theirs stands in it or its parent, they are cleared for its label, and they belong
 * to its workspace. It is read on every decision, so leaving a group, being removed, banned or suspended, or losing
 * the workspace ends what the group was granted at once; nothing is cached.
 *
 * A grant to a group never lifts a member above their own clearance or the object's label: each domain still checks
 * the object's label against the person's clearance after the grant matched.
 */
export class GroupSubjects {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  /** The groups `userId` counts as a member of, by id. Empty for an account that is not active. */
  async ofUser(tenantId: string, userId: string, clearance?: Label): Promise<Set<string>> {
    const u = (await this.db('users').where({ tenant_id: tenantId, id: userId }).first('state', 'clearance')) as { state: string; clearance: string } | undefined;
    if (!u || u.state !== 'active') return new Set();
    const cl = clearance ?? (isLabel(u.clearance) ? u.clearance : null);
    if (!cl) return new Set();
    const rows = (await this.db('group_members as m')
      .join('social_groups as g', 'g.id', 'm.group_id')
      .leftJoin('social_groups as parent', 'parent.id', 'g.parent_id')
      .join('workspace_members as wm', (j) => { j.on('wm.workspace_id', 'g.workspace_id').andOn('wm.user_id', 'm.user_id'); })
      .where({ 'm.tenant_id': tenantId, 'm.user_id': userId, 'g.tenant_id': tenantId })
      .whereNot('g.state', 'deleted')
      .andWhere((w) => { void w.whereNull('g.parent_id').orWhereNot('parent.state', 'deleted'); })
      .distinct('g.id', 'g.label')) as { id: string; label: string }[];
    if (!rows.length) return new Set();
    const barred = await this.s().groups.bans.groupsBarred(tenantId, userId);
    return new Set(rows.filter((r) => isLabel(r.label) && clears(cl, r.label) && !barred.has(r.id)).map((r) => r.id));
  }

  /** The same for a signed-in principal, at the principal's clearance. */
  async of(p: Principal): Promise<Set<string>> {
    if (!p.userId) return new Set();
    return this.ofUser(p.tenantId, p.userId, p.clearance);
  }

  /** A live group of the tenant that may be named as a subject: not deleted. Returns its row or null. */
  async subject(tenantId: string, groupId: string): Promise<{ id: string; name: string; workspace_id: string; label: Label } | null> {
    const g = (await this.db('social_groups').where({ tenant_id: tenantId, id: groupId }).whereNot({ state: 'deleted' }).first('id', 'name', 'workspace_id', 'label')) as { id: string; name: string; workspace_id: string; label: string } | undefined;
    return g && isLabel(g.label) ? { ...g, label: g.label } : null;
  }

  /** Display names of groups, by id (for grant lists and explain). */
  async names(tenantId: string, ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const rows = (await this.db('social_groups').where({ tenant_id: tenantId }).whereIn('id', ids).select('id', 'name')) as { id: string; name: string }[];
    return new Map(rows.map((r) => [r.id, r.name]));
  }
}
