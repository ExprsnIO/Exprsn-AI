import { randomToken } from '../crypto/index.js';
import { LABELS, type Label } from '../authz/labels.js';
import { isRole } from '../authz/permissions.js';
import type { Services } from '../services.js';
import type { UserRow } from '../repos/users.js';
import { checkPasswordPolicy, hashPassword } from './passwords.js';

export interface AdminCreateInput {
  username: string;
  displayName: string;
  email?: string | null;
  tenant?: string;
  roles?: string[];
  clearance?: string;
  /** The password, or null for a single-use enrolment link (B-810): no password is usable until the link sets one. */
  password: string | null;
}

export interface AdminCreated {
  user: UserRow;
  tenantSlug: string;
  roles: string[];
  /** With an enrolment link: the link and how many hours it works. */
  enrol: { link: string; hours: number } | null;
}

/**
 * `admin:create`: a local account for the bootstrap administrator or break-glass access. Admin accounts must have a
 * second factor. With an enrolment link the account gets a random password nobody knows; the link (single use,
 * `PASSWORD_INVITE_HOURS`) sets the password and opens a session that can only enrol the second factor, so the
 * account is never usable with a password alone.
 */
export async function createAdmin(s: Services, input: AdminCreateInput): Promise<AdminCreated> {
  const username = input.username.trim().toLowerCase();
  const displayName = input.displayName.trim();
  if (!username || !displayName) throw new Error('--username and --display-name are required');
  const roles = input.roles?.length ? input.roles : ['system-admin'];
  for (const r of roles) if (!isRole(r)) throw new Error(`Unknown role ${r}`);
  const clearance = (input.clearance ?? 'restricted') as Label;
  if (!(LABELS as readonly string[]).includes(clearance)) throw new Error(`Unknown clearance ${clearance}`);

  const tenant = await s.tenants.bySlug(input.tenant ?? s.cfg.DEFAULT_TENANT);
  if (!tenant) throw new Error('Unknown tenant');
  const local = (await s.providers.list(tenant.id)).find((p) => p.kind === 'local');
  if (!local) throw new Error('Tenant has no local user store');
  if (await s.users.byUsername(tenant.id, username)) throw new Error('A user with that username exists');

  if (input.password !== null) {
    const policy = checkPasswordPolicy(input.password, username);
    if (!policy.ok) throw new Error(policy.reason);
  }
  const passwordHash = await hashPassword(input.password ?? randomToken(32));
  const user = await s.db.transaction(async (trx) => {
    const users = s.users.within(trx);
    const u = await users.create(tenant.id, { username, displayName, email: input.email ?? null, clearance, mfaRequired: true });
    await users.update(tenant.id, u.id, { clearance_direct: clearance });
    await trx('local_credentials').insert({ user_id: u.id, password_hash: passwordHash, updated_at: Date.now() });
    await users.upsertIdentity(u.id, local.id, u.id, []);
    await users.setRoles(u.id, 'direct', roles);
    return u;
  });
  const enrolLink = input.password === null;
  await s.audit.append({ tenantId: tenant.id, action: 'user.created', kind: 'admin', actor: { service: 'cli' }, target: { user: user.id, username }, detail: { roles, clearance, store: local.name, enrolLink } });
  if (!enrolLink) return { user, tenantSlug: tenant.slug, roles, enrol: null };
  const hours = s.cfg.PASSWORD_INVITE_HOURS;
  const { token } = await s.account.issueToken({ tenantId: tenant.id, userId: user.id, kind: 'enrol', ttlMs: hours * 3600_000 });
  await s.audit.append({ tenantId: tenant.id, action: 'user.enrol_link.issued', kind: 'admin', actor: { service: 'cli' }, target: { user: user.id, username }, detail: { hours } });
  return { user, tenantSlug: tenant.slug, roles, enrol: { link: s.account.resetLink(token, tenant.slug), hours } };
}
