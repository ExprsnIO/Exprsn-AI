import { describe, expect, it } from 'vitest';
import { authorize, effectivePermissions, type Principal } from '../src/authz/policy.js';
import { canGrant, canManage, permissionsFor, PERMISSIONS, rolesRequireMfa, ROLES } from '../src/authz/permissions.js';
import { clears, highest } from '../src/authz/labels.js';

const principal = (over: Partial<Principal> = {}): Principal => ({
  kind: 'user',
  userId: 'u1',
  tenantId: 't1',
  tenantSlug: 'northwind',
  username: 'mokafor',
  displayName: 'Mara Okafor',
  roles: ['member'],
  clearance: 'confidential',
  scopes: null,
  sessionId: 's1',
  apiKeyId: null,
  mfa: true,
  ...over
});

describe('labels', () => {
  it('orders public < internal < confidential < restricted', () => {
    expect(highest('internal', 'restricted', 'public')).toBe('restricted');
    expect(clears('confidential', 'internal')).toBe(true);
    expect(clears('internal', 'confidential')).toBe(false);
  });
});

describe('roles', () => {
  it('has the fourteen built-in roles', () => {
    expect(ROLES).toHaveLength(14);
  });

  it('gives system admin every permission', () => {
    expect(permissionsFor(['system-admin']).size).toBe(PERMISSIONS.length);
  });

  it('keeps auditors to audit and usage', () => {
    expect([...permissionsFor(['auditor'])].sort()).toEqual(['audit:read', 'usage:read']);
  });

  it('requires MFA for admin roles only', () => {
    expect(rolesRequireMfa(['member'])).toBe(false);
    expect(rolesRequireMfa(['member', 'model-admin'])).toBe(true);
  });

  it('only lets system admins grant system admin', () => {
    expect(canGrant(['tenant-admin'], 'system-admin')).toBe(false);
    expect(canGrant(['system-admin'], 'system-admin')).toBe(true);
    expect(canGrant(['identity-admin'], 'member')).toBe(true);
    expect(canGrant(['identity-admin'], 'model-admin')).toBe(false);
  });

  it('only lets admins manage users whose every role they could grant', () => {
    expect(canManage(['tenant-admin'], ['member', 'model-admin'])).toBe(true);
    expect(canManage(['tenant-admin'], ['member', 'system-admin'])).toBe(false);
  });
});

describe('authorize', () => {
  it('allows what a role grants', () => {
    expect(authorize(principal(), 'chat:write').allow).toBe(true);
  });

  it('fails at the role step', () => {
    const d = authorize(principal(), 'models:manage');
    expect(d).toMatchObject({ allow: false, step: 'role' });
  });

  it('never widens a role with scopes', () => {
    const p = principal({ scopes: ['chat:read', 'models:manage'] });
    expect(effectivePermissions(p).has('models:manage')).toBe(false);
    expect(authorize(p, 'chat:write')).toMatchObject({ allow: false, step: 'scope' });
    expect(authorize(p, 'chat:read').allow).toBe(true);
  });

  it('keeps tenants apart except for system admins', () => {
    expect(authorize(principal(), 'chat:read', { tenantId: 't2' })).toMatchObject({ allow: false, step: 'tenant' });
    expect(authorize(principal({ roles: ['system-admin'] }), 'chat:read', { tenantId: 't2' }).allow).toBe(true);
  });

  it('checks clearance against the data label', () => {
    expect(authorize(principal({ clearance: 'internal' }), 'chat:read', { label: 'confidential' })).toMatchObject({ allow: false, step: 'clearance' });
  });

  it('checks the zone ceiling against the data label', () => {
    expect(authorize(principal({ clearance: 'restricted' }), 'chat:read', { label: 'restricted', zoneCeiling: 'confidential' })).toMatchObject({ allow: false, step: 'zone' });
  });
});

describe('profile-bound credentials', () => {
  it('lets an inference:invoke:<profile> token use only that profile, by name or alias', () => {
    const p = principal({ roles: ['member'], scopes: ['inference:invoke', 'chat:read'], profiles: ['analyst'] });
    expect(authorize(p, 'inference:invoke', { profiles: ['analyst', 'analyst'] }).allow).toBe(true);
    expect(authorize(p, 'inference:invoke', { profiles: ['fast', 'analyst'] }).allow).toBe(true);
    const other = authorize(p, 'inference:invoke', { profiles: ['general', 'general'] });
    expect(other).toMatchObject({ allow: false, step: 'scope' });
    // Unbound credentials and requests without a profile are unaffected.
    expect(authorize(principal({ roles: ['member'] }), 'inference:invoke', { profiles: ['general'] }).allow).toBe(true);
    expect(authorize(p, 'chat:read').allow).toBe(true);
  });
});
