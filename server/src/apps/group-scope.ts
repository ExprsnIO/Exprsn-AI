import { effectivePermissions, type Principal } from '../authz/policy.js';
import { forbidden, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import { can } from '../groups/roles.js';

/*
 * 1.7.0, Sprint 43 (B-9805, GRP-22): a social group as the scope of a low-code app or of one of its entities.
 *
 * An app scoped to a group is visible only to the group's members (while they count as members: groups/subjects.ts);
 * an entity scoped to a group lists, reads and takes records only from them. Holders of `tenant:manage` keep seeing
 * both, to administer them; the app's designers do not, unless they are members too. Every other check (the app's
 * workspace, the records' labels against the reader's clearance, row and field policies) still applies.
 *
 * App roles follow group roles: a policy subject `group_role` matches the reader's role in the scoping group, by tier
 * (`owner`, `moderator`, `member`, ...) or by the name of their custom role (B-9705).
 *
 * Scoping, or unscoping, an app or an entity is for someone who holds the group's `roles` right (its owners) or
 * `groups:manage`: the group's owners decide who reaches data through the group.
 */
export class AppGroupScope {
  constructor(private readonly s: () => Services) {}

  /** Whether a principal is exempt from group scopes (tenant administration). */
  exempt(p: Principal): boolean {
    return effectivePermissions(p).has('tenant:manage');
  }

  /** The groups the principal counts as a member of now. */
  memberOf(p: Principal): Promise<Set<string>> {
    return this.s().groups.subjects.of(p);
  }

  /** Whether `p` passes a scope (null: no scope). */
  async admits(p: Principal, groupId: string | null | undefined, mine?: Set<string>): Promise<boolean> {
    if (!groupId || this.exempt(p)) return true;
    return (mine ?? (await this.memberOf(p))).has(groupId);
  }

  /** Checks that `p` may scope an app of `workspaceId` (null: tenant-wide) to `groupId`. Returns the group's name. */
  async check(p: Principal, groupId: string, workspaceId: string | null): Promise<string> {
    const s = this.s();
    const g = await s.groups.subjects.subject(p.tenantId, groupId);
    if (!g) throw notFound('Group');
    if (workspaceId && g.workspace_id !== workspaceId) throw forbidden(`${g.name} belongs to another workspace than the app.`, { step: 'workspace' });
    const a = await s.groups.accessOrNull(p, groupId);
    if (!a || !(a.manager || can(a, 'roles'))) throw forbidden(`Only an owner of ${g.name} (or a holder of groups:manage) scopes data to it.`, { step: 'group-role' });
    return g.name;
  }

  /** The reader's roles in the group, for `group_role` policy subjects: the tier and the custom role's name. */
  async rolesIn(groupId: string, userId: string): Promise<string[]> {
    const m = (await this.s().db('group_members as m').leftJoin('group_roles as r', 'r.id', 'm.custom_role_id').where({ 'm.group_id': groupId, 'm.user_id': userId }).first('m.role', 'r.name')) as { role: string; name: string | null } | undefined;
    return m ? [m.role, ...(m.name ? [m.name.trim().toLowerCase()] : [])] : [];
  }
}
