import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { effectivePermissions } from '../authz/policy.js';
import { getRole, PERMISSIONS, type Permission } from '../authz/permissions.js';
import { apiKeyState } from '../identity/apikeys.js';
import { ip, noStore, parseBody, principalOf, requireAuth, setSessionCookie } from '../http/middleware.js';
import { badRequest, forbidden, notFound, unauthorized } from '../http/problem.js';
import type { Services } from '../services.js';

export function meRoutes(s: Services): Router {
  const r = Router();
  r.use(noStore);

  const active = requireAuth();
  const browser = requireAuth({ sessionOnly: true });
  // Enrolment endpoints also serve sessions that must set up a factor before anything else.
  const enrolling = requireAuth({ stages: ['active', 'enroll'], sessionOnly: true });

  const audit = (req: Request, action: string, target: Record<string, unknown> = {}) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, traceId: req.traceId });
  };

  r.get('/', active, async (req, res) => {
    const p = principalOf(req);
    const [tenant, workspaces, methods, recovery] = await Promise.all([
      s.tenants.byId(p.tenantId),
      s.tenants.workspaces(p.tenantId),
      s.mfa.methods(p.userId),
      s.mfa.remainingRecoveryCodes(p.userId)
    ]);
    res.json({
      user: { id: p.userId, username: p.username, displayName: p.displayName, clearance: p.clearance },
      roles: p.roles.map((id) => ({ id, name: getRole(id)?.name ?? id })),
      permissions: [...effectivePermissions(p)].sort(),
      tenant: tenant ? { id: tenant.id, slug: tenant.slug, name: tenant.name } : null,
      workspaces: workspaces.map((w) => ({ id: w.id, name: w.name, label: w.label_ceiling })),
      credential: p.kind,
      mfa: { verified: p.mfa, methods, recoveryCodesRemaining: recovery }
    });
  });

  // ---------- sessions ----------

  r.get('/sessions', active, async (req, res) => {
    const p = principalOf(req);
    const rows = await s.sessions.listForUser(p.userId);
    res.json(rows.map((x) => ({ id: x.id, method: x.method, ip: x.ip, userAgent: x.user_agent, stage: x.stage, createdAt: x.created_at, lastSeenAt: x.last_seen_at, current: x.id === p.sessionId })));
  });

  r.delete('/sessions/:id', active, async (req, res) => {
    const p = principalOf(req);
    const target = await s.sessions.get(p.tenantId, String(req.params.id));
    if (!target || target.user_id !== p.userId) throw notFound('Session');
    await s.sessions.revoke(p.tenantId, target.id);
    await audit(req, 'session.revoked', { session: target.id });
    res.status(204).end();
  });

  r.post('/sessions/revoke-others', browser, async (req, res) => {
    const p = principalOf(req);
    const n = await s.sessions.revokeAllForUser(p.userId, p.sessionId ?? undefined);
    await audit(req, 'session.revoked_all', { count: n, keptCurrent: true });
    res.json({ revoked: n });
  });

  // ---------- API keys ----------

  r.get('/api-keys', active, async (req, res) => {
    const rows = await s.apiKeys.listForUser(principalOf(req).userId);
    res.json(rows.map((k) => ({ id: k.id, name: k.name, prefix: `exai_k1_${k.prefix}`, scopes: k.scopes, state: apiKeyState(k), expiresAt: k.expires_at, lastUsedAt: k.last_used_at, createdAt: k.created_at })));
  });

  r.post('/api-keys', browser, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1).max(100),
        scopes: z.array(z.enum(PERMISSIONS)).min(1).max(PERMISSIONS.length),
        ttlDays: z.union([z.literal(30), z.literal(90), z.literal(180), z.literal(365)])
      }),
      req.body
    );
    const held = effectivePermissions(p);
    const extra = body.scopes.filter((sc) => !held.has(sc));
    if (extra.length) throw forbidden(`Scopes never widen a role: you do not hold ${extra.join(', ')}.`, { step: 'scope' });
    const { key, row } = await s.apiKeys.create({ tenantId: p.tenantId, userId: p.userId, name: body.name, scopes: body.scopes as Permission[], ttlDays: body.ttlDays });
    await audit(req, 'apikey.created', { key: row.id, prefix: row.prefix, scopes: row.scopes, expiresAt: row.expires_at });
    res.status(201).json({ id: row.id, key, prefix: `exai_k1_${row.prefix}`, scopes: row.scopes, expiresAt: row.expires_at, notice: 'This is the only time the key is shown.' });
  });

  r.delete('/api-keys/:id', active, async (req, res) => {
    const p = principalOf(req);
    if (!(await s.apiKeys.revoke(p.userId, String(req.params.id)))) throw notFound('API key');
    await audit(req, 'apikey.revoked', { key: req.params.id });
    res.status(204).end();
  });

  // ---------- second factors ----------

  r.get('/mfa', enrolling, async (req, res) => {
    const p = principalOf(req);
    const factors = await s.mfa.factors(p.userId);
    res.json({
      factors: factors.map((f) => ({ id: f.id, kind: f.kind, label: f.label, createdAt: f.created_at, lastUsedAt: f.last_used_at })),
      recoveryCodesRemaining: await s.mfa.remainingRecoveryCodes(p.userId)
    });
  });

  r.post('/mfa/totp', enrolling, async (req, res) => {
    const p = principalOf(req);
    const { label } = parseBody(z.object({ label: z.string().trim().min(1).max(100).default('Authenticator app') }), req.body ?? {});
    const out = await s.mfa.beginTotp(p.userId, p.username, label);
    res.status(201).json({ id: out.id, secret: out.secret, uri: out.uri });
  });

  /** Confirming the first factor of an enrolling session completes sign-in under a new session token. */
  const afterEnrol = async (req: Request, res: Response, kind: string) => {
    const p = principalOf(req);
    await audit(req, 'mfa.enrolled', { kind });
    const codes = (await s.mfa.remainingRecoveryCodes(p.userId)) === 0 ? await s.mfa.regenerateRecoveryCodes(p.userId) : null;
    let stage = req.authSession!.stage;
    if (stage === 'enroll') {
      const { token, session } = await s.sessions.rotate(req.authSession!, { stage: 'active', method: `${req.authSession!.method}, ${kind}`, mfaVerified: true });
      setSessionCookie(res, s, token, session.expires_at);
      stage = session.stage;
      res.status(201).json({ enrolled: true, stage, csrf: s.sessions.csrfFor(session.id), recoveryCodes: codes });
      return;
    }
    res.status(201).json({ enrolled: true, stage, recoveryCodes: codes });
  };

  r.post('/mfa/totp/:id/confirm', enrolling, async (req, res) => {
    const p = principalOf(req);
    const { code } = parseBody(z.object({ code: z.string().trim().regex(/^\d{6}$/) }), req.body);
    if (!(await s.mfa.confirmTotp(p.userId, String(req.params.id), code))) throw badRequest('That code did not match. Check the time on your device and try the next code.');
    await afterEnrol(req, res, 'TOTP');
  });

  r.post('/mfa/webauthn/options', enrolling, async (req, res) => {
    const p = principalOf(req);
    const options = await s.mfa.registrationOptions(p.userId, p.username, p.displayName);
    await s.sessions.setChallenge(req.authSession!.id, options.challenge);
    res.json(options);
  });

  r.post('/mfa/webauthn', enrolling, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ label: z.string().trim().min(1).max(100).default('Passkey'), response: z.looseObject({ id: z.string(), type: z.literal('public-key') }) }), req.body);
    const challenge = await s.sessions.takeChallenge(req.authSession!.id);
    if (!challenge) throw unauthorized('The passkey challenge expired. Try again.');
    const factor = await s.mfa.verifyRegistration(p.userId, challenge, body.response as never, body.label).catch(() => null);
    if (!factor) throw badRequest('The passkey could not be verified.');
    await afterEnrol(req, res, 'passkey');
  });

  r.delete('/mfa/:id', browser, async (req, res) => {
    const p = principalOf(req);
    const factors = await s.mfa.factors(p.userId);
    const user = await s.users.get(p.tenantId, p.userId);
    if (!factors.some((f) => f.id === req.params.id)) throw notFound('Factor');
    if (user?.mfa_required && factors.length <= 1) throw forbidden('Your roles require a second factor. Add another before removing this one.');
    await s.mfa.removeFactor(p.userId, String(req.params.id));
    await audit(req, 'mfa.removed', { factor: req.params.id });
    res.status(204).end();
  });

  r.post('/mfa/recovery-codes', browser, async (req, res) => {
    const p = principalOf(req);
    if (!(await s.mfa.factors(p.userId)).length) throw badRequest('Add a second factor first.');
    const codes = await s.mfa.regenerateRecoveryCodes(p.userId);
    await audit(req, 'mfa.recovery_codes.regenerated');
    res.status(201).json({ recoveryCodes: codes, notice: 'Store these now. Each works once; they replace any earlier codes.' });
  });

  return r;
}
