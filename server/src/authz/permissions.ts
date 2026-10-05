/**
 * Permission catalogue and the thirteen built-in roles from the Tenants board.
 * A permission is `resource:action`. Roles are sets of permissions; `system-admin` holds everything.
 * API keys and service accounts carry scopes, which can only narrow what the role grants ("scopes never widen a role").
 *
 * 1.5.0 (B-3302): tenants add custom roles, built only from catalogue permissions. Their current definitions are
 * kept here (`setCustomRoles`, fed by `CustomRoleService` from the database and the bus), so every function below
 * resolves a custom role id exactly as it resolves a built-in one. A custom role belongs to one tenant: the functions
 * that take a tenant id ignore another tenant's custom roles, and `isRole` and `canGrant` without a tenant id know only
 * the built-in roles (input validated without a tenant never accepts a custom role).
 */
export const PERMISSIONS = [
  // workspace
  'chat:read', 'chat:write', 'inference:invoke', 'context:read', 'context:write', 'images:generate',
  'tools:invoke', 'agents:run', 'scripts:run', 'memory:write', 'knowledge:read',
  // admin areas
  'models:read', 'models:manage', 'pools:manage', 'profiles:manage',
  'tools:manage', 'agents:manage', 'mcp:manage', 'workflows:manage',
  'guardrails:manage', 'flags:review', 'classifiers:manage',
  'knowledge:manage', 'connections:manage',
  'training:submit', 'training:manage',
  'identity:manage', 'users:manage', 'tenant:manage', 'zones:manage', 'platform:manage',
  'audit:read', 'usage:read',
  // Sprint 13: integrations
  'webhooks:manage', 'prompts:manage', 'billing:read', 'billing:manage',
  // Sprint 24 (B-17): the secrets vault. Path policies decide which secrets and keys each holder reaches.
  'secrets:read', 'secrets:write', 'secrets:admin',
  // Sprint 24: the certificate authority (issuers, profiles, issuance, revocation)
  'pki:manage',
  // 1.4.0 (Sprint 24c): plugins
  'plugins:manage',
  // 1.4.0 (Sprint 25, B-1610, B-1611): publish and withdraw signed AT-Protocol labels, and trust external labelers
  'labels:manage',
  // 1.4.0 (Sprint 26, B-1807, B-1808): bind one's own AT-Protocol DID and handle
  'atproto:link',
  // 1.4.0 (Sprint 26d, B-2401 to B-2405): the file store (read, and upload, change, share and trash)
  'files:read', 'files:write',
  // 1.4.0, Sprint 26 (B-19): moderation. check: run the moderation check on any object; report and appeal: any member;
  // review: work the routed queues, act on objects and decide appeals; sanction: warn, suspend or ban users (step-up);
  // manage: review queues, external providers and the dead-letter queue.
  'moderation:check', 'moderation:report', 'moderation:appeal', 'moderation:review', 'moderation:sanction', 'moderation:manage',
  // 1.4.0 (Sprint 26a, B-1801): invite people into the inviter's workspaces, with roles the inviter may grant
  'members:invite',
  // 1.4.0 (Sprint 27, B-1908): AT-Protocol firehose subscriptions whose posts go through the moderation check
  'firehose:manage',
  // 1.4.0 (Sprint 27, B-22): low-code apps. design: apps, entities, forms, triggers, bundles and drafts; records:read
  // and records:write: the records of the apps in one's workspaces, within one's clearance.
  'apps:design', 'records:read', 'records:write',
  // 1.4.0 (Sprint 27c, B-25): groups and events in one's workspaces. read: see groups, their content and events;
  // write: create groups, join, post, RSVP and keep calendar feeds (what a member may do in a group is its group role);
  // manage: act as owner of every group in the workspaces one may act in.
  'groups:read', 'groups:write', 'groups:manage',
  // 1.4.0 (Sprint 28a, B-23): customer-service channels. manage: channels, their settings, secrets and retention;
  // review: work customer sessions in one's workspaces (transcripts, held replies, replies as a person, CSV exports).
  'channels:manage', 'channels:review',
  // 1.4.0 (Sprint 28b, B-2606 with B-2702): social relations shared by messaging and the feed. read: one's own blocks,
  // mutes, follows, followers, lists and contact rule; write: change them; manage: see any user's relations (audited).
  'social:read', 'social:write', 'social:manage',
  // 1.4.0 (Sprint 28b, B-26): person-to-person messaging. read: one's conversations and their messages; write: start
  // conversations, send, edit, react and pin (what a member may do inside one is their conversation role).
  'messages:read', 'messages:write',
  // 1.4.0 (Sprint 28c, B-27): the workspace feed. read: the feeds, posts and comments of one's workspaces and groups,
  // trending tags and digests; write: post, comment, react, repost and bookmark; manage: remove anyone's posts and
  // comments in the workspaces one may act in, and set and run each workspace's digest.
  'feed:read', 'feed:write', 'feed:manage',
  // 1.5.0 (Sprint 29, B-33): tenant-defined roles, the role and effective-access matrices, and access reviews.
  'roles:manage',
  // 1.5.0 (Sprint 30, B-31): personal calendars (CalDAV; group events stay under groups:*) and contacts (the directory
  // as an address book within one's clearance, and personal address books). read: list and fetch; write: change them.
  'calendars:read', 'calendars:write', 'contacts:read', 'contacts:write',
  // 1.5.0 (Sprint 31, B-29): the tenant's AT-Protocol personal data server: its settings, the accounts it hosts
  // (deactivate, take down, restore), invite codes and published feed generator records. Hosting itself is switched
  // on per tenant by a platform admin (platform:manage). Members keep their own PDS account with atproto:link.
  'pds:manage'
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const isPermission = (v: string): v is Permission => (PERMISSIONS as readonly string[]).includes(v);

export interface RoleDef {
  id: string;
  name: string;
  description: string;
  permissions: readonly Permission[] | '*';
  /** Sessions holding this role must complete a second factor before any request is served. */
  requiresMfa: boolean;
  /** Only a holder of one of these roles may grant this role. */
  grantableBy: readonly string[];
}

const MEMBER: readonly Permission[] = [
  'chat:read', 'chat:write', 'inference:invoke', 'context:read', 'context:write', 'images:generate',
  'tools:invoke', 'agents:run', 'memory:write', 'knowledge:read', 'models:read',
  // Sprint 24: only the vault paths a policy grants them (none by default).
  'secrets:read',
  // Sprint 26 (B-1807): one's own AT-Protocol DID; since 1.5.0 (B-2901) also one's own account on the PDS
  'atproto:link',
  // Sprint 26d: the file store in their workspaces.
  'files:read', 'files:write',
  // Sprint 26 (B-1902, B-1903): report anything they can see, appeal what was done to their own objects.
  'moderation:report', 'moderation:appeal',
  // Sprint 27 (B-2202): the records of the apps in their workspaces.
  'records:read', 'records:write',
  // Sprint 27c (B-25): groups and events in their workspaces, with the rights of their group role.
  'groups:read', 'groups:write',
  // Sprint 28b (B-2606): their own blocks, mutes, follows, lists and contact rule.
  'social:read', 'social:write',
  // Sprint 28b (B-26): their own conversations.
  'messages:read', 'messages:write',
  // Sprint 28c (B-27): the feeds of their workspaces and groups.
  'feed:read', 'feed:write',
  // 1.5.0, Sprint 30 (B-31): their own calendars and address books, and the directory within their clearance.
  'calendars:read', 'calendars:write', 'contacts:read', 'contacts:write'
];

/** The member baseline. Any other permission is an admin permission (B-3302: a custom role holding one is under dual control). */
export const MEMBER_PERMISSIONS: readonly Permission[] = MEMBER;
export const isAdminPermission = (p: Permission): boolean => !MEMBER.includes(p);

const ADMINS = ['system-admin', 'tenant-admin'] as const;

export const ROLES: readonly RoleDef[] = [
  { id: 'system-admin', name: 'System admin', description: 'Everything, across tenants: zones, platform, baseline guardrails.', permissions: '*', requiresMfa: true, grantableBy: ['system-admin'] },
  { id: 'tenant-admin', name: 'Tenant admin', description: 'Workspaces, members, quotas and roles inside one tenant.', permissions: ['tenant:manage', 'roles:manage', 'users:manage', 'identity:manage', 'usage:read', 'audit:read', 'models:read', 'webhooks:manage', 'prompts:manage', 'billing:read', 'secrets:read', 'secrets:write', 'secrets:admin', 'pki:manage', 'plugins:manage', 'labels:manage', 'files:read', 'files:write', 'moderation:sanction', 'moderation:manage', 'members:invite', 'apps:design', 'records:read', 'records:write', 'firehose:manage', 'groups:read', 'groups:write', 'groups:manage', 'channels:manage', 'channels:review', 'social:read', 'social:write', 'social:manage', 'messages:read', 'messages:write', 'feed:read', 'feed:write', 'feed:manage', 'calendars:read', 'calendars:write', 'contacts:read', 'contacts:write', 'pds:manage'], requiresMfa: true, grantableBy: ['system-admin'] },
  { id: 'identity-admin', name: 'Identity admin', description: 'User stores, group mappings, clients, sessions and signing keys.', permissions: ['identity:manage', 'users:manage', 'pki:manage', 'members:invite'], requiresMfa: true, grantableBy: ADMINS },
  { id: 'model-admin', name: 'Model admin', description: 'Model catalogue, approvals, profiles and pool placement.', permissions: ['models:read', 'models:manage', 'pools:manage', 'profiles:manage'], requiresMfa: true, grantableBy: ADMINS },
  { id: 'guardrail-admin', name: 'Guardrail admin', description: 'Guardrail rule sets, classifiers and promotion to enforce.', permissions: ['guardrails:manage', 'classifiers:manage', 'flags:review', 'labels:manage', 'moderation:check', 'moderation:review', 'moderation:sanction', 'moderation:manage', 'firehose:manage', 'channels:review'], requiresMfa: true, grantableBy: ADMINS },
  { id: 'tool-admin', name: 'Tool admin', description: 'Registry review, MCP servers and tool approvals.', permissions: ['tools:manage', 'agents:manage', 'mcp:manage'], requiresMfa: true, grantableBy: ADMINS },
  { id: 'knowledge-curator', name: 'Knowledge curator', description: 'Knowledge bases, sources, relabelling and workspace memory.', permissions: ['knowledge:read', 'knowledge:manage', 'prompts:manage'], requiresMfa: false, grantableBy: ADMINS },
  { id: 'ml-admin', name: 'ML admin', description: 'Training jobs, datasets and approvals for confidential data.', permissions: ['training:submit', 'training:manage', 'models:read'], requiresMfa: true, grantableBy: ADMINS },
  { id: 'workflow-admin', name: 'Workflow admin', description: 'Publishes workflows and scripts as tools, and designs low-code apps.', permissions: ['workflows:manage', 'scripts:run', 'apps:design', 'records:read', 'records:write'], requiresMfa: true, grantableBy: ADMINS },
  { id: 'connection-admin', name: 'Connection admin', description: 'Data connections, credentials and schema allow-lists.', permissions: ['connections:manage', 'secrets:read', 'secrets:write'], requiresMfa: true, grantableBy: ADMINS },
  { id: 'flag-reviewer', name: 'Flag reviewer', description: 'Works the review queue within their clearance.', permissions: ['flags:review', 'moderation:review', 'channels:review'], requiresMfa: false, grantableBy: ADMINS },
  { id: 'member', name: 'Member', description: 'Chat, knowledge and tools within their clearance.', permissions: MEMBER, requiresMfa: false, grantableBy: [...ADMINS, 'identity-admin'] },
  { id: 'auditor', name: 'Auditor', description: 'Reads the audit chain and usage. Nothing else.', permissions: ['audit:read', 'usage:read'], requiresMfa: true, grantableBy: ADMINS }
];

const byId = new Map(ROLES.map((r) => [r.id, r]));

/** A tenant's custom role (B-3302), as it is in force: its current version. */
export interface CustomRoleDef extends RoleDef {
  permissions: readonly Permission[];
  tenantId: string;
  version: number;
}

/** Custom role ids: `custom-` and a lower-case ULID, so they never collide with a built-in id or another tenant's. */
export const CUSTOM_ROLE_PREFIX = 'custom-';
export const isCustomRoleId = (id: string): boolean => id.startsWith(CUSTOM_ROLE_PREFIX);

const custom = new Map<string, CustomRoleDef>();

/** Replaces the custom roles in force for one tenant (the ones not listed stop resolving at once). */
export function setCustomRoles(tenantId: string, roles: readonly CustomRoleDef[]): void {
  for (const [id, r] of custom) if (r.tenantId === tenantId) custom.delete(id);
  for (const r of roles) if (r.tenantId === tenantId && isCustomRoleId(r.id)) custom.set(r.id, r);
}

/** The custom roles in force for a tenant, by name. */
export const customRolesOf = (tenantId: string): CustomRoleDef[] => [...custom.values()].filter((r) => r.tenantId === tenantId).sort((a, b) => a.name.localeCompare(b.name));

const lookup = (id: string, tenantId?: string): RoleDef | undefined => {
  const b = byId.get(id);
  if (b) return b;
  const c = custom.get(id);
  return c && (tenantId === undefined || c.tenantId === tenantId) ? c : undefined;
};

/** A role by id: built-in, or a custom role (of `tenantId` when given). */
export const getRole = (id: string, tenantId?: string): RoleDef | undefined => lookup(id, tenantId);

/** A built-in role, or, with a tenant id, one of that tenant's custom roles in force. */
export const isRole = (id: string, tenantId?: string): boolean => byId.has(id) || (tenantId !== undefined && custom.get(id)?.tenantId === tenantId);

/** Union of the permissions granted by the given roles. `'*'` means every permission. */
export function permissionsFor(roleIds: readonly string[], tenantId?: string): Set<Permission> {
  const out = new Set<Permission>();
  for (const id of roleIds) {
    const r = lookup(id, tenantId);
    if (!r) continue;
    if (r.permissions === '*') return new Set(PERMISSIONS);
    for (const p of r.permissions) out.add(p);
  }
  return out;
}

export const rolesRequireMfa = (roleIds: readonly string[], tenantId?: string): boolean => roleIds.some((id) => lookup(id, tenantId)?.requiresMfa);

/**
 * Can someone holding `granterRoles` grant `role`? A built-in role: when they hold a role in its `grantableBy`. A
 * custom role (only with the tenant id it belongs to): the same, and they must also hold every permission it grants,
 * so a role never hands out more than its granter has.
 */
export function canGrant(granterRoles: readonly string[], role: string, tenantId?: string): boolean {
  const b = byId.get(role);
  if (b) return granterRoles.some((g) => b.grantableBy.includes(g));
  const c = tenantId === undefined ? undefined : custom.get(role);
  if (!c || c.tenantId !== tenantId) return false;
  if (!granterRoles.some((g) => c.grantableBy.includes(g))) return false;
  const held = permissionsFor(granterRoles, tenantId);
  return c.permissions.every((p) => held.has(p));
}

/** Can someone holding `granterRoles` change a user holding `targetRoles`? Only if they could grant every one of them. */
export const canManage = (granterRoles: readonly string[], targetRoles: readonly string[], tenantId?: string): boolean => targetRoles.every((r) => canGrant(granterRoles, r, tenantId));

/** The ids of the roles (built-in, and the tenant's custom ones) that grant a permission: for "who holds this" queries. */
export function rolesGranting(permission: Permission, tenantId: string): string[] {
  return [...ROLES, ...customRolesOf(tenantId)].filter((r) => r.permissions === '*' || r.permissions.includes(permission)).map((r) => r.id);
}

/**
 * The lowest `requiresMfa` a role holding these permissions may have (B-3302, "as for built-ins"): false only when
 * a built-in role without the MFA requirement grants each of them.
 */
export function mfaFloor(perms: readonly Permission[]): boolean {
  const open = new Set(ROLES.filter((r) => !r.requiresMfa && r.permissions !== '*').flatMap((r) => r.permissions as readonly Permission[]));
  return perms.some((p) => !open.has(p));
}
