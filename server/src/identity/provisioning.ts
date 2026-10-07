import { highest, type Label } from '../authz/labels.js';
import { rolesRequireMfa } from '../authz/permissions.js';
import type { ProviderRow } from '../repos/providers.js';
import { resolveMappings, type UserRepo, type UserRow } from '../repos/users.js';
import { parseProviderConfig, scimConfigSchema, type ExternalUser } from './providers/types.js';

export type ProvisionResult =
  | { status: 'ok'; user: UserRow; roles: string[]; created: boolean }
  | { status: 'refused'; reason: 'disabled' | 'no_mapped_group' | 'identity_conflict'; user?: UserRow };

/**
 * Just-in-time provisioning. The link between a store account and our user is (provider, external id);
 * a username already linked to a different store is refused rather than merged, so an account in one store
 * can never take over a same-named account from another.
 * Roles are the union of mapped roles and directly granted roles; clearance is the highest of the two.
 *
 * 1.6.0 (B-7201): a user a SCIM store provisioned signs in through the upstream stores that SCIM store names
 * (`signInStores`): such a sign-in links to the SCIM user instead of being refused, and the roles, workspaces and
 * clearance come from the user's SCIM groups (the SCIM store governs them), not from the upstream store's groups. The
 * upstream store never changes such a user's name, address or manager.
 */
export async function provision(users: UserRepo, tenantId: string, provider: ProviderRow, ext: ExternalUser): Promise<ProvisionResult> {
  const cfg = parseProviderConfig(provider.kind, provider.config);

  let user: UserRow | undefined;
  let created = false;
  const link = await users.identity(provider.id, ext.externalId);
  if (link) {
    user = await users.get(tenantId, link.user_id);
  } else {
    user = await users.byUsername(tenantId, ext.username);
    if (user) {
      const links = await users.identitiesFor(user.id);
      const others = links.filter((l) => l.provider_id !== provider.id);
      if (others.length) {
        const scim = await users.scimLinks(user.id);
        const allowed = others.every((l) => scim.some((x) => x.providerId === l.provider_id && signsInThrough(x.config, provider.id)));
        if (!allowed) return { status: 'refused', reason: 'identity_conflict', user };
      }
    }
  }

  // The SCIM store that governs this user, when the sign-in comes through one of the stores it names.
  const governing = user ? (await users.scimLinks(user.id)).find((x) => signsInThrough(x.config, provider.id)) : undefined;
  const mappings = await users.mappings(tenantId);
  let mappedRoles: string[];
  let mappedClearance: Label;
  let mappedWorkspaces: string[];
  if (governing) {
    const scimCfg = scimConfigSchema.parse(governing.config ?? {});
    const m = resolveMappings(mappings, governing.providerId, governing.groups);
    mappedRoles = m.roles.length ? m.roles : scimCfg.defaultRoles;
    mappedClearance = m.clearance ?? scimCfg.defaultClearance;
    mappedWorkspaces = m.workspaces;
  } else {
    const m = resolveMappings(mappings, provider.id, ext.groups);
    mappedRoles = m.roles.length ? m.roles : cfg.defaultRoles;
    mappedClearance = m.clearance ?? cfg.defaultClearance;
    mappedWorkspaces = m.workspaces;
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
  await users.upsertIdentity(user.id, provider.id, ext.externalId, ext.groups, governing ? undefined : ext.manager);
  await users.setRoles(user.id, 'mapping', mappedRoles);
  await users.setWorkspaceMemberships(user.id, 'mapping', mappedWorkspaces);
  const base = { clearance, last_login_at: Date.now(), mfa_required: user.mfa_required || rolesRequireMfa(roles) };
  const patch = governing ? base : { display_name: ext.displayName, email: ext.email, ...base };
  await users.update(tenantId, user.id, patch);
  return { status: 'ok', user: { ...user, ...patch }, roles, created };
}

/** Does a SCIM store's configuration let its users sign in through this store? */
function signsInThrough(config: Record<string, unknown>, providerId: string): boolean {
  const list = (config as { signInStores?: unknown }).signInStores;
  return Array.isArray(list) && list.includes(providerId);
}
