import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission, requireRecentAuth, setSessionCookie } from '../http/middleware.js';
import { HttpProblem, notFound, unauthorized } from '../http/problem.js';
import { PkiError, type CertRow, type PkiActor } from '../pki/service.js';
import type { MemberRow } from '../pki/members.js';
import type { Services } from '../services.js';

/*
 * 1.9.0, Sprint 55 (B-189): member certificates.
 *
 *   GET  /api/me/certificates                 the caller's member certificates (Settings)
 *   POST /api/me/certificates/:id/pickup      the key, once, as a PKCS#12 file under the caller's password (and the
 *                                             CA token, if one came with it); recent sign-in
 *   GET  /api/pki/members                     the tenant's member certificates (pki:manage)
 *   POST /api/pki/members/sweep               issue, renew and revoke now (pki:manage)
 *   POST /api/auth/certificate                sign in with the member certificate a trusted TLS proxy forwarded
 *                                             (public; the tenant must allow it)
 */

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const TITLES: Record<number, string> = { 400: 'Invalid request', 403: 'Forbidden', 404: 'Not found', 409: 'Conflict', 422: 'Refused by policy', 502: 'Key store error' };

const memberView = (m: MemberRow, c: CertRow | undefined) => ({
  id: m.id,
  userId: m.user_id,
  certificateId: m.certificate_id,
  state: m.state,
  keyWaiting: !!m.key_sealed,
  tokenWaiting: !!m.token_sealed,
  hasToken: !!m.token_id,
  pickedUpAt: m.picked_up_at,
  renewedFrom: m.renewed_from,
  createdAt: m.created_at,
  revokedAt: m.revoked_at,
  certificate: c ? { serial: c.serial, commonName: c.common_name, sans: c.sans, notBefore: c.not_before, notAfter: c.not_after, state: c.state, fingerprint: c.fingerprint, certificatePem: c.certificate_pem } : null
});

const run = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PkiError) throw new HttpProblem(err.status, TITLES[err.status] ?? 'Error', err.message, { extensions: err.extensions });
    throw err;
  }
};

const actor = (req: Request): PkiActor => {
  const p = principalOf(req);
  return { tenantId: p.tenantId, userId: p.userId, actor: actorFrom(p, ip(req)), traceId: req.traceId };
};

export function memberCertRoutes(s: Services): Router {
  const r = Router();
  const recent = requireRecentAuth(s);

  r.get('/me/certificates', noStore, requireAuth(), async (req, res) => {
    const p = principalOf(req);
    const v = await s.pki.settings(p.tenantId);
    const rows = await s.memberCerts.mine(p.tenantId, p.userId);
    res.json({ configured: await s.memberCerts.configured(), enabled: v['members.enabled'], signIn: v['members.signIn'], mtls: v['members.mtls'], certificates: rows.map((x) => memberView(x.row, x.cert)) });
  });

  r.post('/me/certificates/:id/pickup', noStore, requireAuth({ sessionOnly: true }), recent, async (req, res) => {
    const b = parseBody(z.object({ password: z.string().min(8).max(200) }).strict(), req.body);
    const id = id26.safeParse(req.params.id);
    if (!id.success) throw notFound('Certificate');
    const out = await run(() => s.memberCerts.pickup(actor(req), id.data, b.password));
    res.json({ pkcs12: out.pkcs12.toString('base64'), token: out.token, serial: out.cert.serial, notAfter: out.cert.not_after });
  });

  r.get('/pki/members', noStore, requireAuth(), requirePermission(s, 'pki:manage'), async (req, res) => {
    const t = principalOf(req).tenantId;
    if (!(await s.memberCerts.configured())) {
      res.json({ configured: false, members: [] });
      return;
    }
    const rows = (await s.db('pki_member_certificates').where({ tenant_id: t }).orderBy('created_at', 'desc').limit(500)) as Record<string, unknown>[];
    const out = [];
    for (const raw of rows) {
      const m = { ...(raw as unknown as MemberRow), created_at: Number(raw.created_at), picked_up_at: raw.picked_up_at == null ? null : Number(raw.picked_up_at), revoked_at: raw.revoked_at == null ? null : Number(raw.revoked_at), updated_at: Number(raw.updated_at) };
      out.push(memberView(m, await s.pki.certificate(t, m.certificate_id)));
    }
    res.json({ configured: true, members: out });
  });

  r.post('/pki/members/sweep', noStore, requireAuth(), requirePermission(s, 'pki:manage'), async (req, res) => {
    const out = await s.memberCerts.sweep();
    await s.audit.append({ tenantId: principalOf(req).tenantId, action: 'pki.member.sweep', kind: 'admin', actor: actorFrom(principalOf(req), ip(req)), target: { tenant: principalOf(req).tenantId }, label: 'internal', detail: out, traceId: req.traceId });
    res.json(out);
  });

  return r;
}

/** POST /api/auth/certificate, mounted under /api/auth behind the sign-in rate limit. */
export function certificateSignInRoutes(s: Services): Router {
  const r = Router();
  r.post('/certificate', noStore, async (req, res) => {
    parseBody(z.object({ tenant: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).optional() }).strict(), req.body ?? {});
    const c = s.memberCerts.clientCertificate(req);
    if (c.kind === 'none') throw unauthorized('No client certificate reached the server. Sign in with a certificate through the TLS proxy.');
    if (c.kind === 'refused') {
      // A forwarded-certificate header from anyone but a trusted proxy is ignored, and the attempt is logged.
      s.log.warn({ reason: c.reason, peer: req.socket?.remoteAddress ?? null }, 'client certificate header refused');
      throw unauthorized(c.reason === 'untrusted-proxy' ? 'The client certificate header did not come from a trusted proxy.' : c.reason === 'not-verified' ? 'The proxy did not verify the client certificate.' : 'The client certificate could not be read.');
    }
    const m = await s.memberCerts.match(c.cert, 'signIn');
    if (!m.ok) {
      if (m.tenantId) await s.audit.append({ tenantId: m.tenantId, action: 'auth.login.failed', kind: 'auth', actor: { ip: ip(req) }, target: { method: 'certificate' }, detail: { reason: m.reason }, traceId: req.traceId });
      throw unauthorized(`The certificate does not sign anyone in: ${m.reason}.`);
    }
    const { tenantId, userId, certificate } = m.match;
    const user = (await s.users.get(tenantId, userId))!;
    const roles = await s.users.roleIds(userId);
    if (req.authSession) await s.sessions.revoke(req.authSession.tenant_id, req.authSession.id);
    // The certificate is one factor: the tenant's second-factor policy still applies, as after a password.
    const next = await s.identityPolicy.signInStage(req, { tenantId, user, roles, mustChange: false });
    const { token, session } = await s.sessions.create({ userId, tenantId, stage: next.stage, method: `Client certificate${next.trustedDevice ? ', trusted device' : ''}`, providerId: null, ip: ip(req), userAgent: req.header('user-agent') ?? null, mfaVerified: next.mfaVerified });
    setSessionCookie(res, s, token, session.expires_at);
    await s.audit.append({ tenantId, action: next.stage === 'active' ? 'auth.login' : 'auth.login.pending_mfa', kind: 'auth', actor: { user: userId, username: user.username, name: user.display_name, session: session.id, roles, ip: ip(req) }, target: { method: 'certificate', certificate: certificate.id }, detail: { serial: certificate.serial, stage: next.stage }, traceId: req.traceId });
    s.metrics.logins.inc({ result: next.stage === 'active' ? 'ok' : next.stage, kind: 'certificate' });
    res.json({ authenticated: next.stage === 'active', stage: next.stage, csrf: s.sessions.csrfFor(session.id), user: { id: user.id, username: user.username, displayName: user.display_name }, expiresAt: session.expires_at });
  });
  return r;
}
