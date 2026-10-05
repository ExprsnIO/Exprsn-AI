import { highest, type Label } from '../authz/labels.js';
import { rolesRequireMfa } from '../authz/permissions.js';
import type { ProviderRow } from '../repos/providers.js';
import { resolveMappings, type UserRepo, type UserRow } from '../repos/users.js';
import { parseProviderConfig, type ExternalUser } from './providers/types.js';

export type ProvisionResult =
  | { status: 'ok'; user: UserRow; roles: string[]; created: boolean }
  | { status: 'refused'; reason: 'disabled' | 'no_mapped_group' | 'identity_conflict'; user?: UserRow };

/**
 * Just-in-time provisioning. The link between a store account and our user is (provider, external id);
 * a username already linked to a different store is refused rather than merged, so an account in one store
 * can never take over a same-named account from another.
 * Roles are the union of mapped roles and directly granted roles; clearance is the highest of the two.
 */
export async function provision(users: UserRepo, tenantId: string, provider: ProviderRow, ext: ExternalUser): Promise<ProvisionResult> {
  const cfg = parseProviderConfig(provider.kind, provider.config);
  const mapped = resolveMappings(await users.mappings(tenantId), provider.id, ext.groups);
  const mappedRoles = mapped.roles.length ? mapped.roles : cfg.defaultRoles;
  const mappedClearance: Label = mapped.clearance ?? cfg.defaultClearance;

  let user: UserRow | undefined;
  let created = false;
  const link = await users.identity(provider.id, ext.externalId);
  if (link) {
    user = await users.get(tenantId, link.user_id);
  } else {
    user = await users.byUsername(tenantId, ext.username);
    if (user) {
      const links = await users.identitiesFor(user.id);
      if (links.some((l) => l.provider_id !== provider.id)) return { status: 'refused', reason: 'identity_conflict', user };
    }
  }

  const directRoles = user ? (await users.roles(user.id)).filter((r) => r.source === 'direct').map((r) => r.role) : [];
  const roles = [...new Set([...mappedRoles, ...directRoles])].sort();
  if (!roles.length) return user ? { status: 'refused', reason: 'no_mapped_group', user } : { status: 'refused', reason: 'no_mapped_group' };

  if (!user) {
    user = await users.create(tenantId, { username: ext.username, displayName: ext.displayName, email: ext.email, clearance: mappedClearance });
    created = true;
  }
  if (user.state !== 'active') return { status: 'refused', reason: 'disabled', user };

  const clearance = user.clearance_direct ? highest(mappedClearance, user.clearance_direct) : mappedClearance;
  await users.upsertIdentity(user.id, provider.id, ext.externalId, ext.groups, ext.manager);
  await users.setRoles(user.id, 'mapping', mappedRoles);
  await users.setWorkspaceMemberships(user.id, 'mapping', mapped.workspaces);
  const patch = { display_name: ext.displayName, email: ext.email, clearance, last_login_at: Date.now(), mfa_required: user.mfa_required || rolesRequireMfa(roles) };
  await users.update(tenantId, user.id, patch);
  return { status: 'ok', user: { ...user, ...patch }, roles, created };
}
