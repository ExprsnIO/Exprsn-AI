import { isPermission, PERMISSIONS, type Permission } from '../authz/permissions.js';

/** Identity scopes: claims about the user, pre-consented for first-party clients. */
export const IDENTITY_SCOPES = ['openid', 'profile', 'email', 'groups', 'offline_access'] as const;

const WORKSPACE: Permission[] = ['chat:read', 'chat:write', 'inference:invoke', 'context:read', 'context:write', 'images:generate', 'tools:invoke', 'agents:run', 'scripts:run', 'memory:write', 'knowledge:read', 'models:read'];

/** The scope catalogue shown on the Identity screen: every permission is a scope, grouped by who may consent. */
export const SCOPE_GROUPS: { scopes: string[]; grants: string; consent: string }[] = [
  { scopes: ['openid', 'profile', 'email', 'groups'], grants: 'Identity claims: name, username, email, groups, roles and clearance', consent: 'pre-consented' },
  { scopes: ['chat:read', 'chat:write'], grants: 'Own conversations', consent: 'user consent' },
  { scopes: ['inference:invoke[:profile]'], grants: 'Direct model calls, optionally bound to one profile', consent: 'user consent' },
  { scopes: ['context:read', 'context:write', 'knowledge:read'], grants: 'Knowledge bases and documents', consent: 'user consent' },
  { scopes: ['images:generate'], grants: 'Image jobs', consent: 'user consent' },
  { scopes: ['tools:invoke', 'agents:run', 'scripts:run', 'memory:write'], grants: 'Tool calls, agent runs, scripts and memory', consent: 'user consent, with per-call confirmation for writes' },
  { scopes: ['models:read', 'models:manage', 'pools:manage', 'profiles:manage'], grants: 'Model registry, pulls, approvals', consent: 'admin only' },
  { scopes: ['tools:manage', 'agents:manage', 'mcp:manage', 'workflows:manage'], grants: 'Tool, agent and workflow registry', consent: 'admin only' },
  { scopes: ['guardrails:manage', 'classifiers:manage', 'flags:review'], grants: 'Guardrail rule sets, classifiers and flags', consent: 'admin only' },
  { scopes: ['training:submit', 'training:manage'], grants: 'Datasets and fine-tune jobs', consent: 'admin only' },
  { scopes: ['tenant:manage', 'users:manage', 'identity:manage', 'zones:manage', 'platform:manage', 'connections:manage', 'knowledge:manage', 'audit:read', 'usage:read'], grants: 'Administration and audit', consent: 'admin only' }
];

export const isWorkspaceScope = (p: string): boolean => WORKSPACE.includes(p as Permission);

/** Validates a scope string an admin allows on a client: identity scopes, permissions, `resource:*`, `inference:invoke:<profile>`. */
export function isKnownScope(s: string): boolean {
  if ((IDENTITY_SCOPES as readonly string[]).includes(s)) return true;
  if (isPermission(s)) return true;
  if (/^[a-z]+:\*$/.test(s)) return PERMISSIONS.some((p) => p.startsWith(s.slice(0, -1)));
  return /^inference:invoke:[a-z0-9][a-z0-9._-]{0,62}$/.test(s);
}

/** Does the client's allow-list permit `scope`? */
export function clientAllows(allowed: string[], scope: string): boolean {
  if (allowed.includes(scope)) return true;
  const perm = scope.startsWith('inference:invoke:') ? 'inference:invoke' : scope;
  if (perm !== scope && allowed.includes(perm)) return true;
  const resource = perm.split(':')[0];
  return !(IDENTITY_SCOPES as readonly string[]).includes(scope) && allowed.includes(`${resource}:*`);
}

/** The permission a scope stands for, or null for identity scopes. */
export const permissionOf = (scope: string): Permission | null => {
  const p = scope.startsWith('inference:invoke:') ? 'inference:invoke' : scope;
  return isPermission(p) ? p : null;
};

/**
 * Grants = requested ∩ client allow-list ∩ (identity scopes ∪ the user's permissions). Scopes never widen a role:
 * a scope for a permission the user does not hold is dropped.
 */
export function grantScopes(requested: string[], clientAllowed: string[], userPermissions: Set<Permission> | null): string[] {
  const out: string[] = [];
  for (const s of requested) {
    if (!isKnownScope(s) || s.endsWith(':*') || !clientAllows(clientAllowed, s)) continue;
    const perm = permissionOf(s);
    if (perm && userPermissions && !userPermissions.has(perm)) continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/** Expands a client allow-list into concrete scopes (for client credentials, where nothing is requested). */
export function expandAllowed(allowed: string[]): string[] {
  const out = new Set<string>();
  for (const a of allowed) {
    if (!a.endsWith(':*')) {
      out.add(a);
      continue;
    }
    for (const p of PERMISSIONS) if (p.startsWith(a.slice(0, -1))) out.add(p);
  }
  return [...out];
}

export const parseScope = (s: unknown): string[] => (typeof s === 'string' ? s.split(/\s+/).filter(Boolean).slice(0, 50) : []);
