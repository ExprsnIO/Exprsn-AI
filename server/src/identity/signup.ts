import { ulid } from 'ulid';
import { actorFrom, isUniqueViolation, type AuditActor } from '../audit/chain.js';
import { clears, highest, type Label } from '../authz/labels.js';
import { canGrant, rolesRequireMfa } from '../authz/permissions.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { randomToken, sha256 } from '../crypto/index.js';
import { json } from '../db/knex.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { Tenant } from '../repos/tenants.js';
import type { UserRow } from '../repos/users.js';
import type { Services } from '../services.js';
import { hashPassword } from './passwords.js';
import { domainAllowed, type IdentityPolicyRow } from './policy.js';

/*
 * Sprint 26a: self-registration (B-1801), email verification (B-1802) and invitations by workspace admins (B-1801),
 * ported in design from exprsn-platform's signup policy and invite services. Tokens (verification links and
 * invitations) are 256-bit random values: only their SHA-256 is stored, each works once, expires, and is refused with
 * the same answer whether it is unknown, used, revoked or expired. Links carry the token in the URL fragment of the
 * console sign-in page, like reset links, so it never reaches a server log.
 */

const HOUR = 3600_000;

export const USERNAME = /^[a-z0-9][a-z0-9._@-]{0,189}$/;

export interface InvitationRow {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  email: string;
  roles: string[];
  clearance: Label;
  invited_by: string | null;
  state: 'pending' | 'accepted' | 'revoked';
  created_at: number;
  expires_at: number;
  accepted_by: string | null;
  accepted_at: number | null;
  revoked_at: number | null;
}

const invitationFrom = (r: Record<string, unknown>): InvitationRow => ({
  ...(r as unknown as InvitationRow),
  roles: json<string[]>(r.roles as string, []),
  created_at: Number(r.created_at),
  expires_at: Number(r.expires_at),
  accepted_at: r.accepted_at == null ? null : Number(r.accepted_at),
  revoked_at: r.revoked_at == null ? null : Number(r.revoked_at)
});

export const invitationView = (i: InvitationRow) => ({
  id: i.id,
  email: i.email,
  workspaceId: i.workspace_id,
  roles: i.roles,
  clearance: i.clearance,
  invitedBy: i.invited_by,
  state: i.state === 'pending' && i.expires_at <= Date.now() ? 'expired' : i.state,
  createdAt: i.created_at,
  expiresAt: i.expires_at,
  acceptedBy: i.accepted_by,
  acceptedAt: i.accepted_at,
  revokedAt: i.revoked_at
});

const invalidLink = () => new HttpProblem(400, 'Invalid link', 'This link is invalid, has expired or was already used. Ask for a new one.');

export class SignupService {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  /** The console link for a token (the sign-in page, token in the fragment). */
  private link(param: 'verify' | 'invitation', token: string, tenantSlug: string): string {
    const cfg = this.s().cfg;
    const tenant = tenantSlug === cfg.DEFAULT_TENANT ? '' : `&tenant=${encodeURIComponent(tenantSlug)}`;
    return `${cfg.PUBLIC_URL.replace(/\/$/, '')}/#/signin?${param}=${token}${tenant}`;
  }

  // ---------- email verification (B-1802) ----------

  async emailVerifiedAt(userId: string): Promise<number | null> {
    const r = (await this.db('users').where({ id: userId }).first('email_verified_at')) as { email_verified_at: number | null } | undefined;
    return r?.email_verified_at == null ? null : Number(r.email_verified_at);
  }

  /** True when the tenant requires verified addresses and this local account has an address it has not proven. */
  async needsVerification(policy: IdentityPolicyRow, user: UserRow): Promise<boolean> {
    if (!policy.signup.requireEmailVerification || !user.email) return false;
    if (!(await this.s().account.localCredential(user.id))) return false; // directory accounts: the directory owns the address
    return (await this.emailVerifiedAt(user.id)) == null;
  }

  /**
   * Sends a verification link to the account's current address (earlier links stop working). Throttled per account
   * (three an hour, silently). Returns whether an email went out.
   */
  async sendVerification(tenant: Pick<Tenant, 'id' | 'slug' | 'name'>, user: UserRow): Promise<boolean> {
    const s = this.s();
    if (!user.email || !s.notifications.emailEnabled) return false;
    if (!(await s.account.hit(`verify:user:${user.id}`, 3, HOUR))) return false;
    const token = randomToken(32);
    const t = Date.now();
    await this.db('email_verifications').where({ user_id: user.id, used_at: null }).update({ used_at: t });
    await this.db('email_verifications').insert({ id: sha256(token), tenant_id: tenant.id, user_id: user.id, email: user.email.toLowerCase(), created_at: t, expires_at: t + s.cfg.EMAIL_VERIFY_HOURS * HOUR, used_at: null });
    return s.notifications.sendTemplate(user.email, 'verify-email', { name: user.display_name, username: user.username, email: user.email, tenant: tenant.name, hours: s.cfg.EMAIL_VERIFY_HOURS, link: this.link('verify', token, tenant.slug) });
  }

  /** Redeems a verification link (once). The address must still be the account's current one. */
  async verify(token: string, ctx: { ip?: string | null; traceId?: string } = {}): Promise<{ user: UserRow; tenantSlug: string }> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalidLink();
    const id = sha256(token);
    const row = (await this.db('email_verifications').where({ id }).first()) as { tenant_id: string; user_id: string; email: string; expires_at: number; used_at: number | null } | undefined;
    if (!row || row.used_at != null || Number(row.expires_at) <= Date.now()) throw invalidLink();
    const user = await this.s().users.get(row.tenant_id, row.user_id);
    if (!user || (user.email ?? '').toLowerCase() !== row.email) throw invalidLink();
    if (!(await this.db('email_verifications').where({ id, used_at: null }).update({ used_at: Date.now() }))) throw invalidLink();
    await this.db('users').where({ id: user.id }).update({ email_verified_at: Date.now(), updated_at: Date.now() });
    await this.s().audit.append({ tenantId: user.tenant_id, action: 'user.email.verified', kind: 'auth', actor: { user: user.id, username: user.username, ip: ctx.ip ?? null }, target: { user: user.id, username: user.username }, ...(ctx.traceId ? { traceId: ctx.traceId } : {}) });
    const tenant = await this.s().tenants.byId(user.tenant_id);
    return { user, tenantSlug: tenant?.slug ?? this.s().cfg.DEFAULT_TENANT };
  }

  // ---------- self-registration (B-1801) ----------

  /** An account with this address (case-insensitive) in the tenant, if any. */
  private async byEmail(tenantId: string, email: string): Promise<{ id: string } | undefined> {
    return (await this.db('users').where({ tenant_id: tenantId }).whereRaw('LOWER(email) = ?', [email.toLowerCase()]).first('id')) as { id: string } | undefined;
  }

  /** Users who decide sign-ups: tenant and identity admins of the tenant. */
  private async approvers(tenantId: string): Promise<string[]> {
    const rows = (await this.db('user_roles as r').join('users as u', 'u.id', 'r.user_id').where({ 'u.tenant_id': tenantId, 'u.state': 'active' }).whereIn('r.role', ['tenant-admin', 'identity-admin']).distinct('u.id')) as { id: string }[];
    return rows.map((r) => r.id);
  }

  /**
   * Creates a local account under the tenant's signup policy. Refused (403) while sign-up is closed or for an email
   * domain outside the list; with `approval` the account is created disabled until an admin approves it; with email
   * verification required, a verification link is sent and the account cannot sign in until it is used.
   */
  async register(tenant: Tenant, input: { username: string; displayName: string; email: string; password: string }, ctx: { ip: string | null; traceId?: string }): Promise<{ userId: string; state: 'active' | 'pending'; verification: 'sent' | 'not_required' }> {
    const s = this.s();
    const policy = await s.identityPolicy.get(tenant.id);
    const p = policy.signup;
    const refuse = async (reason: string, detail: string) => {
      await s.audit.append({ tenantId: tenant.id, action: 'user.signup.refused', kind: 'auth', actor: { username: input.username, ip: ctx.ip }, target: { domain: input.email.split('@').pop()!.toLowerCase() }, detail: { reason }, ...(ctx.traceId ? { traceId: ctx.traceId } : {}) });
      throw forbidden(detail, { reason });
    };
    if (p.mode === 'closed') await refuse('closed', 'Sign-up is closed for this organisation. Ask an admin for an invitation.');
    if (!domainAllowed(p.domains, input.email)) await refuse('domain', 'Sign-up is not open to this email domain. Use your organisation address, or ask an admin for an invitation.');
    if (p.requireEmailVerification && !s.notifications.emailEnabled) throw new HttpProblem(503, 'Email not configured', 'Sign-up needs email to confirm addresses, and email is not configured here. Ask an admin.');
    const local = (await s.providers.list(tenant.id)).find((x) => x.kind === 'local' && x.enabled);
    if (!local) throw conflict('This organisation has no local user store, so accounts cannot be created here.');
    const taken = () => conflict('That username or email address cannot be used. Choose another, or reset the password of your existing account.');
    if ((await s.users.byUsername(tenant.id, input.username)) || (await this.byEmail(tenant.id, input.email))) throw taken();
    await s.account.checkNewPassword({ tenantId: tenant.id, username: input.username, password: input.password, ip: ctx.ip, ...(ctx.traceId ? { traceId: ctx.traceId } : {}) });
    const workspace = p.workspaceId ? await s.tenants.workspace(tenant.id, p.workspaceId) : undefined;
    const pending = p.mode === 'approval';
    const passwordHash = await hashPassword(input.password);
    let user: UserRow;
    try {
      user = await this.db.transaction(async (trx) => {
        const users = s.users.within(trx);
        const u = await users.create(tenant.id, { username: input.username, displayName: input.displayName, email: input.email, clearance: p.clearance });
        await users.update(tenant.id, u.id, { clearance_direct: p.clearance, ...(pending ? { state: 'disabled', disabled_reason: 'Sign-up awaiting approval' } : {}) });
        await trx('local_credentials').insert({ user_id: u.id, password_hash: passwordHash, must_change: false, updated_at: Date.now() });
        await users.upsertIdentity(u.id, local.id, u.id, []);
        await users.setRoles(u.id, 'direct', p.roles);
        if (workspace && workspace.state === 'active') await trx('workspace_members').insert({ workspace_id: workspace.id, user_id: u.id, source: 'direct', created_at: Date.now() });
        await trx('account_signups').insert({ user_id: u.id, tenant_id: tenant.id, state: pending ? 'pending' : 'active', email_domain: input.email.split('@').pop()!.toLowerCase().slice(0, 255), ip: ctx.ip?.slice(0, 64) ?? null, created_at: Date.now() });
        return u;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw taken();
      throw err;
    }
    await s.audit.append({ tenantId: tenant.id, action: 'user.signup.created', kind: 'auth', actor: { user: user.id, username: user.username, ip: ctx.ip }, target: { user: user.id, username: user.username }, detail: { mode: p.mode, roles: p.roles, clearance: p.clearance, workspace: workspace?.id ?? null, verification: p.requireEmailVerification }, ...(ctx.traceId ? { traceId: ctx.traceId } : {}) });
    let verification: 'sent' | 'not_required' = 'not_required';
    if (p.requireEmailVerification) {
      await this.sendVerification(tenant, { ...user, email: input.email });
      verification = 'sent';
    }
    if (pending) {
      const ids = await this.approvers(tenant.id);
      if (ids.length) await s.notifications.notify({ tenantId: tenant.id, userIds: ids, kind: 'signup', title: `${user.display_name} (${user.username}) signed up and waits for approval`, route: 'users' });
    }
    return { userId: user.id, state: pending ? 'pending' : 'active', verification };
  }

  /** The sign-up waiting on an account, if any (for a clearer refusal at sign-in). */
  async signupState(userId: string): Promise<string | null> {
    const r = (await this.db('account_signups').where({ user_id: userId }).first('state')) as { state: string } | undefined;
    return r?.state ?? null;
  }

  async listSignups(tenantId: string, state?: string) {
    const q = this.db('account_signups as a').join('users as u', 'u.id', 'a.user_id').where({ 'a.tenant_id': tenantId });
    if (state) q.andWhere('a.state', state);
    const rows = (await q.orderBy('a.created_at', 'desc').limit(500).select('a.*', 'u.username', 'u.display_name', 'u.email', 'u.email_verified_at')) as Record<string, unknown>[];
    return rows.map((r) => ({
      userId: String(r.user_id),
      username: String(r.username),
      displayName: String(r.display_name),
      email: (r.email as string | null) ?? null,
      emailVerified: r.email_verified_at != null,
      domain: String(r.email_domain),
      state: String(r.state),
      createdAt: Number(r.created_at),
      decidedBy: (r.decided_by as string | null) ?? null,
      decidedAt: r.decided_at == null ? null : Number(r.decided_at),
      reason: (r.reason as string | null) ?? null
    }));
  }

  /** Approves (the account becomes active) or rejects (it stays disabled) a pending sign-up. */
  async decide(p: Principal, userId: string, approve: boolean, reason: string | null, ctx: { ip: string | null; traceId?: string }): Promise<void> {
    const s = this.s();
    const row = (await this.db('account_signups').where({ tenant_id: p.tenantId, user_id: userId }).first()) as { state: string } | undefined;
    const user = row ? await s.users.get(p.tenantId, userId) : undefined;
    if (!row || !user) throw notFound('Sign-up');
    if (row.state !== 'pending') throw conflict(`This sign-up was already ${row.state === 'active' ? 'active without approval' : row.state}.`);
    const t = Date.now();
    const n = await this.db('account_signups').where({ user_id: userId, state: 'pending' }).update({ state: approve ? 'approved' : 'rejected', decided_by: p.userId, decided_at: t, reason: reason?.slice(0, 300) ?? null });
    if (!n) throw conflict('This sign-up was decided by someone else just now.');
    if (approve) await s.users.update(p.tenantId, userId, { state: 'active', disabled_reason: null });
    else await s.users.update(p.tenantId, userId, { disabled_reason: 'Sign-up rejected' });
    await s.audit.append({ tenantId: p.tenantId, action: approve ? 'user.signup.approved' : 'user.signup.rejected', kind: 'admin', actor: actorFrom(p, ctx.ip), target: { user: userId, username: user.username }, ...(reason ? { detail: { reason } } : {}), ...(ctx.traceId ? { traceId: ctx.traceId } : {}) });
    const tenant = await s.tenants.byId(p.tenantId);
    if (user.email) {
      void s.notifications.sendTemplate(user.email, 'notification', { title: approve ? `Your account ${user.username} on ${tenant?.name ?? 'Exprsn-AI'} was approved. You can sign in now.` : `Your sign-up as ${user.username} on ${tenant?.name ?? 'Exprsn-AI'} was not approved.`, link: s.notifications.consoleUrl('signin') });
    }
  }

  // ---------- invitations by workspace admins (B-1801) ----------

  /**
   * Invites an address into the tenant (and a workspace) with roles and a clearance the inviter may grant. Without
   * `tenant:manage`, the workspace must be one the inviter belongs to. A newer invitation for the same address and
   * workspace replaces a pending one.
   */
  async invite(p: Principal, input: { email: string; workspaceId: string | null; roles: string[]; clearance: Label }, ctx: { ip: string | null; traceId?: string }): Promise<{ invitation: InvitationRow; sent: boolean }> {
    const s = this.s();
    const denied = input.roles.filter((r) => !canGrant(p.roles, r, p.tenantId));
    if (denied.length) throw forbidden(`Your roles cannot grant ${denied.join(', ')}.`, { step: 'role' });
    if (!clears(p.clearance, input.clearance)) throw forbidden('You cannot grant a clearance above your own.', { step: 'clearance' });
    let workspaceName = '';
    if (input.workspaceId) {
      const w = await s.tenants.workspace(p.tenantId, input.workspaceId);
      if (!w || w.state !== 'active') throw notFound('Workspace');
      if (!effectivePermissions(p).has('tenant:manage') && !(await s.users.workspaceIds(p.userId)).includes(w.id)) throw forbidden('You can invite people only into workspaces you belong to.', { step: 'workspace' });
      workspaceName = w.name;
    }
    if (!s.notifications.emailEnabled) throw conflict('Email is not configured (SMTP_URL), so an invitation cannot be sent.');
    const email = input.email.trim().toLowerCase();
    const token = randomToken(32);
    const t = Date.now();
    const q = this.db('invitations').where({ tenant_id: p.tenantId, email, state: 'pending' });
    await (input.workspaceId ? q.andWhere({ workspace_id: input.workspaceId }) : q.whereNull('workspace_id')).update({ state: 'revoked', revoked_at: t });
    const row = { id: ulid(), tenant_id: p.tenantId, workspace_id: input.workspaceId, email, roles: JSON.stringify([...new Set(input.roles)]), clearance: input.clearance, token_hash: sha256(token), invited_by: p.userId, state: 'pending', created_at: t, expires_at: t + s.cfg.INVITATION_DAYS * 24 * HOUR, accepted_by: null, accepted_at: null, revoked_at: null };
    await this.db('invitations').insert(row);
    const tenant = await s.tenants.byId(p.tenantId);
    const sent = await s.notifications.sendTemplate(email, 'workspace-invite', { actor: p.displayName, email, tenant: tenant?.name ?? p.tenantSlug, workspace: workspaceName ? `, in the workspace ${workspaceName}` : '', days: s.cfg.INVITATION_DAYS, link: this.link('invitation', token, p.tenantSlug) });
    const invitation = invitationFrom(row as unknown as Record<string, unknown>);
    await s.audit.append({ tenantId: p.tenantId, action: 'user.invitation.created', kind: 'admin', actor: actorFrom(p, ctx.ip), target: { invitation: row.id, email, workspace: input.workspaceId }, detail: { roles: invitation.roles, clearance: input.clearance, sent, expiresAt: row.expires_at }, ...(ctx.traceId ? { traceId: ctx.traceId } : {}) });
    return { invitation, sent };
  }

  async listInvitations(tenantId: string, opts: { invitedBy?: string; state?: string } = {}): Promise<InvitationRow[]> {
    const q = this.db('invitations').where({ tenant_id: tenantId });
    if (opts.invitedBy) q.andWhere({ invited_by: opts.invitedBy });
    if (opts.state) q.andWhere({ state: opts.state });
    return ((await q.orderBy('created_at', 'desc').limit(500)) as Record<string, unknown>[]).map(invitationFrom);
  }

  async getInvitation(tenantId: string, id: string): Promise<InvitationRow | null> {
    const r = (await this.db('invitations').where({ tenant_id: tenantId, id }).first()) as Record<string, unknown> | undefined;
    return r ? invitationFrom(r) : null;
  }

  async revokeInvitation(p: Principal, id: string, ctx: { ip: string | null; traceId?: string }): Promise<void> {
    const inv = await this.getInvitation(p.tenantId, id);
    if (!inv) throw notFound('Invitation');
    if (inv.invited_by !== p.userId && !effectivePermissions(p).has('tenant:manage')) throw forbidden('Only the inviter or a tenant admin can withdraw this invitation.', { step: 'owner' });
    if (inv.state !== 'pending') throw conflict(`This invitation was already ${inv.state}.`);
    await this.db('invitations').where({ id, state: 'pending' }).update({ state: 'revoked', revoked_at: Date.now() });
    await this.s().audit.append({ tenantId: p.tenantId, action: 'user.invitation.revoked', kind: 'admin', actor: actorFrom(p, ctx.ip), target: { invitation: id, email: inv.email }, ...(ctx.traceId ? { traceId: ctx.traceId } : {}) });
  }

  /** The live invitation behind a token (unused, unrevoked, unexpired), or a 400 that says nothing more. */
  private async live(token: string): Promise<InvitationRow> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalidLink();
    const r = (await this.db('invitations').where({ token_hash: sha256(token) }).first()) as Record<string, unknown> | undefined;
    const inv = r ? invitationFrom(r) : null;
    if (!inv || inv.state !== 'pending' || inv.expires_at <= Date.now()) throw invalidLink();
    const tenant = await this.s().tenants.byId(inv.tenant_id);
    if (!tenant || tenant.state !== 'active') throw invalidLink();
    return inv;
  }

  /** What an invitation link offers, for the page that accepts it. */
  async preview(token: string) {
    const inv = await this.live(token);
    const s = this.s();
    const [tenant, workspace, inviter] = await Promise.all([s.tenants.byId(inv.tenant_id), inv.workspace_id ? s.tenants.workspace(inv.tenant_id, inv.workspace_id) : undefined, inv.invited_by ? s.users.get(inv.tenant_id, inv.invited_by) : undefined]);
    return { tenant: { slug: tenant!.slug, name: tenant!.name }, workspace: workspace ? { id: workspace.id, name: workspace.name } : null, invitedBy: inviter?.display_name ?? null, email: inv.email, roles: inv.roles, clearance: inv.clearance, expiresAt: inv.expires_at };
  }

  /** Claims an invitation (once) for `userId`. */
  private async claim(inv: InvitationRow, userId: string): Promise<void> {
    const n = await this.db('invitations').where({ id: inv.id, state: 'pending' }).update({ state: 'accepted', accepted_by: userId, accepted_at: Date.now() });
    if (!n) throw invalidLink();
  }

  private async grant(inv: InvitationRow, user: UserRow, created: boolean): Promise<void> {
    const s = this.s();
    if (!created) {
      const direct = (await s.users.roles(user.id)).filter((r) => r.source === 'direct').map((r) => r.role);
      await s.users.setRoles(user.id, 'direct', [...new Set([...direct, ...inv.roles])]);
      const clearance = user.clearance_direct ? highest(user.clearance_direct, inv.clearance) : inv.clearance;
      const roles = await s.users.roleIds(user.id);
      await s.users.update(user.tenant_id, user.id, { clearance_direct: clearance, clearance: highest(user.clearance, clearance), mfa_required: user.mfa_required || rolesRequireMfa(roles) });
    }
    if (inv.workspace_id) await s.tenants.addMember(inv.workspace_id, user.id);
  }

  /**
   * Accepts an invitation with a new local account. The invited address becomes the account's address, verified by
   * the link itself. Refused when an account with that address exists (accept as that account instead).
   */
  async acceptNew(token: string, input: { username: string; displayName: string; password: string }, ctx: { ip: string | null; traceId?: string }): Promise<{ user: UserRow; tenantSlug: string }> {
    const s = this.s();
    const inv = await this.live(token);
    const tenant = (await s.tenants.byId(inv.tenant_id))!;
    if (await this.byEmail(inv.tenant_id, inv.email)) throw conflict('An account with this address exists. Sign in as that account and accept the invitation there.');
    if (await s.users.byUsername(inv.tenant_id, input.username)) throw conflict('That username is taken. Choose another.');
    const local = (await s.providers.list(inv.tenant_id)).find((x) => x.kind === 'local' && x.enabled);
    if (!local) throw conflict('This organisation has no local user store, so accounts cannot be created here.');
    await s.account.checkNewPassword({ tenantId: inv.tenant_id, username: input.username, password: input.password, ip: ctx.ip, ...(ctx.traceId ? { traceId: ctx.traceId } : {}) });
    const passwordHash = await hashPassword(input.password);
    let user: UserRow;
    try {
      user = await this.db.transaction(async (trx) => {
        const users = s.users.within(trx);
        const u = await users.create(inv.tenant_id, { username: input.username, displayName: input.displayName, email: inv.email, clearance: inv.clearance, mfaRequired: rolesRequireMfa(inv.roles) });
        await users.update(inv.tenant_id, u.id, { clearance_direct: inv.clearance });
        await trx('users').where({ id: u.id }).update({ email_verified_at: Date.now() });
        await trx('local_credentials').insert({ user_id: u.id, password_hash: passwordHash, must_change: false, updated_at: Date.now() });
        await users.upsertIdentity(u.id, local.id, u.id, []);
        await users.setRoles(u.id, 'direct', inv.roles);
        const n = await trx('invitations').where({ id: inv.id, state: 'pending' }).update({ state: 'accepted', accepted_by: u.id, accepted_at: Date.now() });
        if (!n) throw invalidLink();
        return u;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('That username is taken. Choose another.');
      throw err;
    }
    await this.grant(inv, user, true);
    const actor: AuditActor = { user: user.id, username: user.username, ip: ctx.ip };
    await s.audit.append({ tenantId: inv.tenant_id, action: 'user.created', kind: 'auth', actor, target: { user: user.id, username: user.username }, detail: { via: 'invitation', invitation: inv.id, roles: inv.roles, clearance: inv.clearance, store: local.name } });
    await s.audit.append({ tenantId: inv.tenant_id, action: 'user.invitation.accepted', kind: 'auth', actor, target: { invitation: inv.id, email: inv.email, workspace: inv.workspace_id }, detail: { newAccount: true, roles: inv.roles }, ...(ctx.traceId ? { traceId: ctx.traceId } : {}) });
    return { user, tenantSlug: tenant.slug };
  }

  /** Accepts an invitation as the signed-in account, whose address must be the invited one. */
  async acceptExisting(p: Principal, token: string, ctx: { ip: string | null; traceId?: string }): Promise<InvitationRow> {
    const s = this.s();
    const inv = await this.live(token);
    if (inv.tenant_id !== p.tenantId) throw invalidLink();
    const user = await s.users.get(p.tenantId, p.userId);
    if (!user || (user.email ?? '').toLowerCase() !== inv.email) throw forbidden('This invitation is for another email address. Sign in as the invited account, or ask for an invitation to your address.', { step: 'email' });
    await this.claim(inv, user.id);
    await this.grant(inv, user, false);
    // The invitation reached the address: it is proven.
    if ((await this.emailVerifiedAt(user.id)) == null) await this.db('users').where({ id: user.id }).update({ email_verified_at: Date.now() });
    await s.audit.append({ tenantId: p.tenantId, action: 'user.invitation.accepted', kind: 'auth', actor: actorFrom(p, ctx.ip), target: { invitation: inv.id, email: inv.email, workspace: inv.workspace_id }, detail: { newAccount: false, roles: inv.roles, clearance: inv.clearance }, ...(ctx.traceId ? { traceId: ctx.traceId } : {}) });
    return inv;
  }
}
