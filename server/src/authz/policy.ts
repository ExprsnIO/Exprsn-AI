import { clears, labelRank, type Label } from './labels.js';
import { permissionsFor, type Permission } from './permissions.js';

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
}

export interface Resource {
  tenantId?: string;
  label?: Label;
  /** Label ceiling of the zone the request would be routed to. */
  zoneCeiling?: Label;
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
export function effectivePermissions(p: Pick<Principal, 'roles' | 'scopes'>): Set<Permission> {
  const fromRoles = permissionsFor(p.roles);
  if (!p.scopes) return fromRoles;
  return new Set(p.scopes.filter((s) => fromRoles.has(s)));
}

/**
 * The single authorisation pipeline every request goes through, in the order the Tenants board shows:
 * role → credential scopes → tenant boundary → clearance ≥ data label → zone ceiling ≥ data label.
 */
export function authorize(p: Principal, action: Permission, resource: Resource = {}): Decision {
  const deny = (step: DecisionStep, reason: string): Decision => ({ allow: false, step, reason, action, policy: POLICY_VERSION });

  if (!permissionsFor(p.roles).has(action)) return deny('role', `No role held grants ${action}`);
  if (p.scopes && !p.scopes.includes(action)) return deny('scope', `Credential scopes do not include ${action}`);
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
  const perms = permissionsFor(p.roles);
  const steps: ExplainedStep[] = [
    { step: 'role', ok: perms.has(action), detail: perms.has(action) ? `A role held grants ${action}` : `No role held grants ${action}` },
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
