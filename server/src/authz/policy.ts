import { clears, labelRank, type Label } from './labels.js';
import { getRole, permissionsFor, type Permission } from './permissions.js';

export const POLICY_VERSION = 'baseline-v1';

export interface Principal {
  kind: 'user' | 'api_key';
  userId: string;
  tenantId: string;
  tenantSlug: string;
  username: string;
  displayName: string;
  roles: string[];
  clearance: Label;
  /** Scopes carried by the credential (API key). `null` means "whatever the roles grant". */
  scopes: Permission[] | null;
  sessionId: string | null;
  apiKeyId: string | null;
  mfa: boolean;
  /** The workspace the request acts in (the session's current one, or X-Workspace for API keys). */
  workspaceId?: string | null;
  /** Profiles an OAuth token is bound to (`inference:invoke:<profile>` scopes); absent or null means any profile. */
  profiles?: string[] | null;
}

export interface Resource {
  tenantId?: string;
  label?: Label;
  /** Label ceiling of the zone the request would be routed to. */
  zoneCeiling?: Label;
  /** For `inference:invoke`: the profile names the request resolves to (the name asked for and the profile it resolved to). */
  profiles?: string[];
}

export type DecisionStep = 'role' | 'scope' | 'tenant' | 'clearance' | 'zone';

export interface Decision {
  allow: boolean;
  /** The step that failed, when denied. */
  step: DecisionStep | null;
  reason: string;
  action: Permission;
  policy: string;
}

/** Permissions the principal actually holds: role permissions, narrowed by credential scopes. */
export function effectivePermissions(p: Pick<Principal, 'roles' | 'scopes'> & { tenantId?: string }): Set<Permission> {
  const fromRoles = permissionsFor(p.roles, p.tenantId);
  if (!p.scopes) return fromRoles;
  return new Set(p.scopes.filter((s) => fromRoles.has(s)));
}

/**
 * The single authorisation pipeline every request goes through, in the order the Tenants board shows:
 * role → credential scopes → tenant boundary → clearance ≥ data label → zone ceiling ≥ data label.
 */
export function authorize(p: Principal, action: Permission, resource: Resource = {}): Decision {
  const deny = (step: DecisionStep, reason: string): Decision => ({ allow: false, step, reason, action, policy: POLICY_VERSION });

  if (!permissionsFor(p.roles, p.tenantId).has(action)) return deny('role', `No role held grants ${action}`);
  if (p.scopes && !p.scopes.includes(action)) return deny('scope', `Credential scopes do not include ${action}`);
  if (action === 'inference:invoke' && p.profiles && resource.profiles && !resource.profiles.some((x) => p.profiles!.includes(x))) {
    return deny('scope', `Credential scopes allow only the profiles ${p.profiles.join(', ')}`);
  }
  if (resource.tenantId && resource.tenantId !== p.tenantId && !p.roles.includes('system-admin')) {
    return deny('tenant', 'Resource belongs to another tenant');
  }
  if (resource.label && !clears(p.clearance, resource.label)) {
    return deny('clearance', `Clearance ${p.clearance} is below the data label ${resource.label}`);
  }
  if (resource.label && resource.zoneCeiling && labelRank(resource.label) > labelRank(resource.zoneCeiling)) {
    return deny('zone', `Zone ceiling ${resource.zoneCeiling} is below the data label ${resource.label}`);
  }
  return { allow: true, step: null, reason: 'allowed', action, policy: POLICY_VERSION };
}

/**
 * The zone step on its own, for routing decisions made without a principal (the gateway choosing a pool): data may
 * enter a zone only when the zone's ceiling is at or above its label. No ceiling means no zone step applies.
 */
export function zoneAdmits(label: Label | undefined, zoneCeiling: Label | null | undefined): boolean {
  return !label || !zoneCeiling || labelRank(label) <= labelRank(zoneCeiling);
}

export interface ExplainedStep {
  step: DecisionStep;
  ok: boolean;
  detail: string;
}

/**
 * Every step of the pipeline for one request, evaluated in order and reported even after a failure, for the
 * "effective permission" panel. The decision itself is authorize()'s: the first failing step.
 */
export function explain(p: Principal, action: Permission, resource: Resource = {}): { decision: Decision; steps: ExplainedStep[] } {
  const perms = permissionsFor(p.roles, p.tenantId);
  // 1.5.0 (B-3303): the step names the roles that grant the action, built-in or custom.
  const granting = perms.has(action) ? p.roles.filter((id) => permissionsFor([id], p.tenantId).has(action)).map((id) => getRole(id, p.tenantId)?.name ?? id) : [];
  const steps: ExplainedStep[] = [
    { step: 'role', ok: perms.has(action), detail: perms.has(action) ? `A role held grants ${action} (${granting.join(', ')})` : `No role held grants ${action}` },
    { step: 'scope', ok: !p.scopes || p.scopes.includes(action), detail: !p.scopes ? 'Session credential: no scope narrowing' : p.scopes.includes(action) ? `Credential scopes include ${action}` : `Credential scopes do not include ${action}` },
    {
      step: 'tenant',
      ok: !resource.tenantId || resource.tenantId === p.tenantId || p.roles.includes('system-admin'),
      detail: !resource.tenantId || resource.tenantId === p.tenantId ? 'Same tenant' : p.roles.includes('system-admin') ? 'Another tenant; system admin' : 'Resource belongs to another tenant'
    },
    {
      step: 'clearance',
      ok: !resource.label || clears(p.clearance, resource.label),
      detail: resource.label ? `Clearance ${p.clearance}, data ${resource.label}` : 'No data label'
    },
    {
      step: 'zone',
      ok: !resource.label || !resource.zoneCeiling || labelRank(resource.label) <= labelRank(resource.zoneCeiling),
      detail: resource.zoneCeiling ? `Zone ceiling ${resource.zoneCeiling}, data ${resource.label ?? 'unlabelled'}` : 'No zone ceiling applies'
    }
  ];
  return { decision: authorize(p, action, resource), steps };
}
