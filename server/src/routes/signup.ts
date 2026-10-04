import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { clears, LABELS } from '../authz/labels.js';
import { isRole } from '../authz/permissions.js';
import { effectivePermissions } from '../authz/policy.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { badRequest, forbidden, notFound, tooManyRequests } from '../http/problem.js';
import { mfaPolicySchema, signupPolicySchema } from '../identity/policy.js';
import { invitationView, USERNAME } from '../identity/signup.js';
import type { Services } from '../services.js';

/*
 * Sprint 26a (B-1801 to B-1803, B-1805) routes:
 *
 * - `signupPublicRoutes`, mounted at /api/auth beside the sign-in routes (no session needed, throttled): sign-up,
 *   email verification links, and invitation links (preview and accept with a new account).
 * - `identityPolicyRoutes`, mounted on /api: invitations by workspace admins (`members:invite`), the account's own
 *   trusted devices and verification link, accepting an invitation as the signed-in account, the tenant's signup and
 *   MFA policies (`identity:manage`), pending sign-ups and CSV imports (`users:manage`).
 */

const tenantSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const token = z.string().min(1).max(200);
const HOUR = 3600_000;

export function signupPublicRoutes(s: Services): Router {
  const r = Router();
  r.use(['/register', '/email', '/invitations'], noStore);

  const activeTenant = async (slug: string | undefined) => {
    const t = await s.tenants.bySlug(slug ?? s.cfg.DEFAULT_TENANT);
    return t && t.state === 'active' ? t : null;
  };

  /** B-1801: self-registration under the tenant's signup policy. */
  r.post('/register', async (req, res) => {
    const body = parseBody(
      z.object({
        tenant: tenantSlug.optional(),
        username: z.string().trim().toLowerCase().regex(USERNAME, 'Letters, digits, dot, dash, underscore and @, starting with a letter or digit'),
        displayName: z.string().trim().min(1).max(200),
        email: z.email().max(320).transform((e) => e.toLowerCase()),
        password: z.string().min(1).max(1024)
      }),
      req.body
    );
    const per = s.cfg.SIGNUP_PER_HOUR;
    const okAddr = await s.account.hit(`signup:ip:${ip(req) ?? 'unknown'}`, per, HOUR);
    const okMail = await s.account.hit(`signup:email:${body.email}`, 3, HOUR);
    if (!okAddr || !okMail) throw tooManyRequests('Too many sign-ups from here. Try again in an hour.', 3600);
    const tenant = await activeTenant(body.tenant);
    if (!tenant) throw notFound('Organisation');
    const out = await s.signup.register(tenant, { username: body.username, displayName: body.displayName, email: body.email, password: body.password }, { ip: ip(req), traceId: req.traceId });
    const detail =
      out.verification === 'sent'
        ? `We sent a link to ${body.email}. Open it within ${s.cfg.EMAIL_VERIFY_HOURS} hours to confirm the address${out.state === 'pending' ? '; an admin then approves the account' : ', then sign in'}.`
        : out.state === 'pending'
          ? 'An admin approves new accounts. You will get an email when yours is approved.'
          : 'Your account is ready. Sign in.';
    res.status(201).json({ username: body.username, tenant: tenant.slug, state: out.state, verification: out.verification, detail });
  });

  /** B-1802: redeems a verification link (once). */
  r.post('/email/verify', async (req, res) => {
    const body = parseBody(z.object({ token }), req.body);
    if (!(await s.account.hit(`verify:ip:${ip(req) ?? 'unknown'}`, 60, HOUR))) throw tooManyRequests('Too many attempts. Try again later.', 3600);
    const out = await s.signup.verify(body.token, { ip: ip(req), traceId: req.traceId });
    res.json({ verified: true, username: out.user.username, tenant: out.tenantSlug });
  });

  /** B-1802: asks for a new verification link. The same answer whether or not the account exists or needs one. */
  r.post('/email/resend', async (req, res) => {
    const body = parseBody(z.object({ tenant: tenantSlug.optional(), identifier: z.string().trim().min(1).max(320) }), req.body);
    const okAddr = await s.account.hit(`verify-resend:ip:${ip(req) ?? 'unknown'}`, s.cfg.PASSWORD_RESET_PER_HOUR * 4, HOUR);
    const okId = await s.account.hit(`verify-resend:id:${body.tenant ?? s.cfg.DEFAULT_TENANT}:${body.identifier.toLowerCase()}`, s.cfg.PASSWORD_RESET_PER_HOUR, HOUR);
    if (!okAddr || !okId) throw tooManyRequests('Too many requests. Try again in an hour.', 3600);
    const tenant = await activeTenant(body.tenant);
    if (tenant) {
      const id = body.identifier.toLowerCase();
      const user = (await s.users.byUsername(tenant.id, id)) ?? (id.includes('@') ? await s.db('users').where({ tenant_id: tenant.id }).whereRaw('LOWER(email) = ?', [id]).first('id').then((r: { id: string } | undefined) => (r ? s.users.get(tenant.id, r.id) : undefined)) : undefined);
      const policy = await s.identityPolicy.get(tenant.id);
      // Whether or not the tenant requires it, an unproven address of a local account may ask for a link.
      if (user && user.state === 'active' && (await s.signup.needsVerification({ ...policy, signup: { ...policy.signup, requireEmailVerification: true } }, user))) {
        const sent = await s.signup.sendVerification(tenant, user);
        await s.audit.append({ tenantId: tenant.id, action: 'user.email.verification_sent', kind: 'auth', actor: { ip: ip(req) }, target: { user: user.id, username: user.username }, detail: { sent }, traceId: req.traceId });
      }
    }
    res.status(202).json({ accepted: true, detail: `If an account here needs to confirm its address, a new link is on its way. It works once, for ${s.cfg.EMAIL_VERIFY_HOURS} hours.` });
  });

  /** B-1801: what an invitation link offers (the token stays in the body, never in a URL). */
  r.post('/invitations/preview', async (req, res) => {
    const body = parseBody(z.object({ token }), req.body);
    if (!(await s.account.hit(`invite:ip:${ip(req) ?? 'unknown'}`, 120, HOUR))) throw tooManyRequests('Too many attempts. Try again later.', 3600);
    res.json(await s.signup.preview(body.token));
  });

  /** B-1801: accepts an invitation with a new local account (the invited address, verified by the link). */
  r.post('/invitations/accept', async (req, res) => {
    const body = parseBody(
      z.object({
        token,
        username: z.string().trim().toLowerCase().regex(USERNAME, 'Letters, digits, dot, dash, underscore and @, starting with a letter or digit'),
        displayName: z.string().trim().min(1).max(200),
        password: z.string().min(1).max(1024)
      }),
      req.body
    );
    if (!(await s.account.hit(`invite:ip:${ip(req) ?? 'unknown'}`, 120, HOUR))) throw tooManyRequests('Too many attempts. Try again later.', 3600);
    const out = await s.signup.acceptNew(body.token, { username: body.username, displayName: body.displayName, password: body.password }, { ip: ip(req), traceId: req.traceId });
    res.status(201).json({ username: out.user.username, tenant: out.tenantSlug, detail: 'Your account is ready. Sign in with your new username and password.' });
  });

  return r;
}

export function identityPolicyRoutes(s: Services): Router {
  const r = Router();
  r.use(['/invitations', '/me/invitations', '/me/trusted-devices', '/me/email', '/admin/identity-policy', '/admin/signups', '/admin/user-imports'], noStore, requireAuth());

  const audit = (req: Request, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>, kind: 'admin' | 'auth' = 'admin') => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind, actor: actorFrom(p, ip(req)), target, ...(detail ? { detail } : {}), traceId: req.traceId });
  };

  // ---------- invitations by workspace admins (B-1801) ----------

  const invite = requirePermission(s, 'members:invite');

  r.get('/invitations', invite, async (req, res) => {
    const p = principalOf(req);
    const q = parseBody(z.object({ state: z.enum(['pending', 'accepted', 'revoked']).optional() }), req.query);
    // Tenant admins see every invitation; other inviters their own.
    const rows = await s.signup.listInvitations(p.tenantId, { ...(effectivePermissions(p).has('tenant:manage') ? {} : { invitedBy: p.userId }), ...(q.state ? { state: q.state } : {}) });
    res.json(rows.filter((i) => clears(p.clearance, i.clearance)).map(invitationView));
  });

  r.post('/invitations', invite, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(
      z.object({
        email: z.email().max(320),
        workspaceId: z.string().length(26).nullable().default(null),
        roles: z.array(z.string().refine(isRole, 'Unknown role')).min(1).max(13),
        clearance: z.enum(LABELS).default('internal')
      }),
      req.body
    );
    const out = await s.signup.invite(p, body, { ip: ip(req), traceId: req.traceId });
    res.status(201).json({ ...invitationView(out.invitation), sent: out.sent });
  });

  r.delete('/invitations/:id', invite, async (req, res) => {
    await s.signup.revokeInvitation(principalOf(req), String(req.params.id), { ip: ip(req), traceId: req.traceId });
    res.status(204).end();
  });

  /** Accepts an invitation as the signed-in account (its address must be the invited one). */
  r.post('/me/invitations/accept', requireAuth({ sessionOnly: true }), async (req, res) => {
    const body = parseBody(z.object({ token }), req.body);
    const inv = await s.signup.acceptExisting(principalOf(req), body.token, { ip: ip(req), traceId: req.traceId });
    res.json({ accepted: true, roles: inv.roles, workspaceId: inv.workspace_id });
  });

  // ---------- the account's own verification link and trusted devices (B-1802, B-1803) ----------

  r.post('/me/email/verify', requireAuth({ sessionOnly: true }), async (req, res) => {
    const p = principalOf(req);
    const user = await s.users.get(p.tenantId, p.userId);
    if (!user?.email) throw forbidden('Your account has no email address to confirm.', { step: 'email' });
    if ((await s.signup.emailVerifiedAt(user.id)) != null) return void res.json({ verified: true, sent: false });
    if (!(await s.account.localCredential(user.id))) throw forbidden('Your address comes from your directory, which keeps it.', { step: 'email' });
    const tenant = (await s.tenants.byId(p.tenantId))!;
    const sent = await s.signup.sendVerification(tenant, user);
    await audit(req, 'user.email.verification_sent', { user: user.id, username: user.username }, { sent }, 'auth');
    res.status(202).json({ verified: false, sent });
  });

  r.get('/me/trusted-devices', async (req, res) => {
    const p = principalOf(req);
    const policy = await s.identityPolicy.get(p.tenantId);
    res.json({ periodDays: policy.mfa.trustedDeviceDays, devices: await s.identityPolicy.trustedDevices(p.userId), thisDevice: req.authSession ? await s.identityPolicy.isTrusted(req, p.tenantId, p.userId, policy) : false });
  });

  r.delete('/me/trusted-devices', requireAuth({ sessionOnly: true }), async (req, res) => {
    const p = principalOf(req);
    const n = await s.identityPolicy.forgetUser(p.userId);
    await audit(req, 'auth.trusted_device.removed', { user: p.userId }, { count: n }, 'auth');
    res.json({ removed: n });
  });

  // ---------- tenant policies (B-1801, B-1803) ----------

  const identity = requirePermission(s, 'identity:manage');

  r.get('/admin/identity-policy', identity, async (req, res) => {
    const pol = await s.identityPolicy.get(principalOf(req).tenantId);
    res.json({ signup: pol.signup, mfa: { ...pol.mfa, effectiveAt: pol.mfaEffectiveAt }, updatedBy: pol.updatedBy, updatedAt: pol.updatedAt });
  });

  r.put('/admin/identity-policy/signup', identity, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(signupPolicySchema, req.body);
    if (!clears(p.clearance, body.clearance)) throw forbidden('You cannot give new accounts a clearance above your own.', { step: 'clearance' });
    if (body.workspaceId && !(await s.tenants.workspace(p.tenantId, body.workspaceId))) throw notFound('Workspace');
    const before = (await s.identityPolicy.get(p.tenantId)).signup;
    await s.identityPolicy.setSignup(p.tenantId, body, p.userId);
    await audit(req, 'identity.signup_policy.updated', { tenant: p.tenantId }, { before, after: body });
    res.json(body);
  });

  r.put('/admin/identity-policy/mfa', identity, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(mfaPolicySchema, req.body);
    const before = (await s.identityPolicy.get(p.tenantId)).mfa;
    const out = await s.identityPolicy.setMfa(p.tenantId, body, p.userId);
    await audit(req, 'identity.mfa_policy.updated', { tenant: p.tenantId }, { before, after: body, graceRestarted: out.widened });
    const pol = await s.identityPolicy.get(p.tenantId);
    res.json({ ...pol.mfa, effectiveAt: pol.mfaEffectiveAt });
  });

  // ---------- sign-ups waiting for approval (B-1801) ----------

  const users = requirePermission(s, 'users:manage');

  r.get('/admin/signups', users, async (req, res) => {
    const q = parseBody(z.object({ state: z.enum(['pending', 'approved', 'rejected', 'active']).optional() }), req.query);
    res.json(await s.signup.listSignups(principalOf(req).tenantId, q.state));
  });

  for (const decision of ['approve', 'reject'] as const) {
    r.post(`/admin/signups/:userId/${decision}`, users, async (req, res) => {
      const body = parseBody(z.object({ reason: z.string().trim().max(300).optional() }), req.body ?? {});
      await s.signup.decide(principalOf(req), String(req.params.userId), decision === 'approve', body.reason ?? null, { ip: ip(req), traceId: req.traceId });
      res.json({ userId: String(req.params.userId), state: decision === 'approve' ? 'approved' : 'rejected' });
    });
  }

  // ---------- CSV imports (B-1805) ----------

  const csvBody = express.text({ type: ['text/csv', 'text/plain', 'application/csv'], limit: s.cfg.USER_IMPORT_MAX_BYTES });

  /** Queues an import of users, memberships and group mappings. `dryRun=true` reports the plan and changes nothing. */
  r.post('/admin/user-imports', users, csvBody, async (req, res) => {
    const q = parseBody(z.object({ dryRun: z.enum(['true', 'false']).default('false'), sendInvites: z.enum(['true', 'false']).default('false') }), req.query);
    if (typeof req.body !== 'string' || !req.body.trim()) throw badRequest('Send the CSV as the request body with Content-Type text/csv.');
    const out = await s.userImports.submit(principalOf(req), req.body, { dryRun: q.dryRun === 'true', sendInvites: q.sendInvites === 'true' }, { ip: ip(req), traceId: req.traceId });
    res.status(202).json({ id: out.id, jobId: out.jobId, dryRun: q.dryRun === 'true' });
  });

  r.get('/admin/user-imports', users, async (req, res) => {
    res.json(await s.userImports.list(principalOf(req).tenantId));
  });

  r.get('/admin/user-imports/:id', users, async (req, res) => {
    res.json(await s.userImports.get(principalOf(req).tenantId, String(req.params.id)));
  });

  return r;
}
