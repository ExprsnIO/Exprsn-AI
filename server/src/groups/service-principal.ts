import type { Principal } from '../authz/policy.js';
import type { GroupRow } from './service.js';

/*
 * 1.9.0, Sprint 53 (B-176): the principal a group acts as when it carries out one of its own decisions.
 *
 * It holds no tenant role and no scope, so no permission check outside the group passes for it. Inside the one group
 * it was made for, `GroupService.accessOrNull` gives it exactly an owner's standing (the owner tier's rights, never
 * `groups:manage`), and nothing in any other group. Its user id is the group's id, so the audit entries and the rows
 * the group's services write (`decided_by`, `created_by`) name the group. It is recognised by identity, not by any
 * field a request could carry: only `groupPrincipal` makes one, and a principal built from a session never is one.
 */

const MADE = new WeakMap<Principal, string>();

export function groupPrincipal(g: Pick<GroupRow, 'id' | 'tenant_id' | 'workspace_id' | 'label' | 'name'>): Principal {
  const p: Principal = {
    kind: 'user',
    userId: g.id,
    tenantId: g.tenant_id,
    tenantSlug: '',
    username: 'group-decision',
    displayName: `${g.name} (by decision)`,
    roles: [],
    clearance: g.label,
    scopes: [],
    sessionId: null,
    apiKeyId: null,
    mfa: false,
    workspaceId: g.workspace_id
  };
  MADE.set(p, g.id);
  return p;
}

/** The group a principal acts for, when it is a group's own decision principal; null for everyone else. */
export const groupOfPrincipal = (p: Principal): string | null => MADE.get(p) ?? null;
