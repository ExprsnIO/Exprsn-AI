/**
 * Permission catalogue and the thirteen built-in roles from the Tenants board.
 * A permission is `resource:action`. Roles are sets of permissions; `system-admin` holds everything.
 * API keys and service accounts carry scopes, which can only narrow what the role grants ("scopes never widen a role").
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
  // 1.4.0 (Sprint 27c, B-25): groups and events in one's workspaces. read: see groups, their content and events;
  // write: create groups, join, post, RSVP and keep calendar feeds (what a member may do in a group is its group role);
  // manage: act as owner of every group in the workspaces one may act in.
  'groups:read', 'groups:write', 'groups:manage'
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
  // Sprint 26 (B-1807): one's own AT-Protocol DID
  'atproto:link',
  // Sprint 26d: the file store in their workspaces.
  'files:read', 'files:write',
  // Sprint 26 (B-1902, B-1903): report anything they can see, appeal what was done to their own objects.
  'moderation:report', 'moderation:appeal',
  // Sprint 27c (B-25): groups and events in their workspaces, with the rights of their group role.
  'groups:read', 'groups:write'
];

const ADMINS = ['system-admin', 'tenant-admin'] as const;

export const ROLES: readonly RoleDef[] = [
  { id: 'system-admin', name: 'System admin', description: 'Everything, across tenants: zones, platform, baseline guardrails.', permissions: '*', requiresMfa: true, grantableBy: ['system-admin'] },
  { id: 'tenant-admin', name: 'Tenant admin', description: 'Workspaces, members, quotas and roles inside one tenant.', permissions: ['tenant:manage', 'users:manage', 'identity:manage', 'usage:read', 'audit:read', 'models:read', 'webhooks:manage', 'prompts:manage', 'billing:read', 'secrets:read', 'secrets:write', 'secrets:admin', 'pki:manage', 'plugins:manage', 'labels:manage', 'files:read', 'files:write', 'moderation:sanction', 'moderation:manage', 'members:invite', 'groups:read', 'groups:write', 'groups:manage'], requiresMfa: true, grantableBy: ['system-admin'] },
  { id: 'identity-admin', name: 'Identity admin', description: 'User stores, group mappings, clients, sessions and signing keys.', permissions: ['identity:manage', 'users:manage', 'pki:manage', 'members:invite'], requiresMfa: true, grantableBy: ADMINS },
  { id: 'model-admin', name: 'Model admin', description: 'Model catalogue, approvals, profiles and pool placement.', permissions: ['models:read', 'models:manage', 'pools:manage', 'profiles:manage'], requiresMfa: true, grantableBy: ADMINS },
  { id: 'guardrail-admin', name: 'Guardrail admin', description: 'Guardrail rule sets, classifiers and promotion to enforce.', permissions: ['guardrails:manage', 'classifiers:manage', 'flags:review', 'labels:manage', 'moderation:check', 'moderation:review', 'moderation:sanction', 'moderation:manage'], requiresMfa: true, grantableBy: ADMINS },
  { id: 'tool-admin', name: 'Tool admin', description: 'Registry review, MCP servers and tool approvals.', permissions: ['tools:manage', 'agents:manage', 'mcp:manage'], requiresMfa: true, grantableBy: ADMINS },
  { id: 'knowledge-curator', name: 'Knowledge curator', description: 'Knowledge bases, sources, relabelling and workspace memory.', permissions: ['knowledge:read', 'knowledge:manage', 'prompts:manage'], requiresMfa: false, grantableBy: ADMINS },
  { id: 'ml-admin', name: 'ML admin', description: 'Training jobs, datasets and approvals for confidential data.', permissions: ['training:submit', 'training:manage', 'models:read'], requiresMfa: true, grantableBy: ADMINS },
  { id: 'workflow-admin', name: 'Workflow admin', description: 'Publishes workflows and scripts as tools.', permissions: ['workflows:manage', 'scripts:run'], requiresMfa: true, grantableBy: ADMINS },
  { id: 'connection-admin', name: 'Connection admin', description: 'Data connections, credentials and schema allow-lists.', permissions: ['connections:manage', 'secrets:read', 'secrets:write'], requiresMfa: true, grantableBy: ADMINS },
  { id: 'flag-reviewer', name: 'Flag reviewer', description: 'Works the review queue within their clearance.', permissions: ['flags:review', 'moderation:review'], requiresMfa: false, grantableBy: ADMINS },
  { id: 'member', name: 'Member', description: 'Chat, knowledge and tools within their clearance.', permissions: MEMBER, requiresMfa: false, grantableBy: [...ADMINS, 'identity-admin'] },
  { id: 'auditor', name: 'Auditor', description: 'Reads the audit chain and usage. Nothing else.', permissions: ['audit:read', 'usage:read'], requiresMfa: true, grantableBy: ADMINS }
];

const byId = new Map(ROLES.map((r) => [r.id, r]));

export const getRole = (id: string): RoleDef | undefined => byId.get(id);
export const isRole = (id: string): boolean => byId.has(id);

/** Union of the permissions granted by the given roles. `'*'` means every permission. */
export function permissionsFor(roleIds: readonly string[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const id of roleIds) {
    const r = byId.get(id);
    if (!r) continue;
    if (r.permissions === '*') return new Set(PERMISSIONS);
    for (const p of r.permissions) out.add(p);
  }
  return out;
}

export const rolesRequireMfa = (roleIds: readonly string[]): boolean => roleIds.some((id) => byId.get(id)?.requiresMfa);

/** Can someone holding `granterRoles` grant `role`? */
export function canGrant(granterRoles: readonly string[], role: string): boolean {
  const r = byId.get(role);
  if (!r) return false;
  return granterRoles.some((g) => r.grantableBy.includes(g));
}

/** Can someone holding `granterRoles` change a user holding `targetRoles`? Only if they could grant every one of them. */
export const canManage = (granterRoles: readonly string[], targetRoles: readonly string[]): boolean => targetRoles.every((r) => canGrant(granterRoles, r));
