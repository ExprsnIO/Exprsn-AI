import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { effectivePermissions } from '../authz/policy.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission, requireRecentAuth } from '../http/middleware.js';
import { forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { AcmeAccount, EabKeyRow } from '../pki/acme.js';
import { fromPem } from '../pki/asn1.js';
import { CustodyUnavailable } from '../pki/keys.js';
import { PkiError, policySchema, PROFILE_KINDS, PROFILE_MAX_DAYS, type CertRow, type CrlRow, type IssuerRow, type PkiActor, type ProfileRow } from '../pki/service.js';
import { REASONS, reasonName } from '../pki/x509.js';
import type { Services } from '../services.js';

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const keyType = z.enum(['ecdsa-p256', 'rsa-3072']);
const reason = z.enum(Object.keys(REASONS) as [keyof typeof REASONS, ...(keyof typeof REASONS)[]]);
const san = z.object({ type: z.enum(['dns', 'ip', 'email', 'uri']), value: z.string().trim().min(1).max(500) }).strict();

const TITLES: Record<number, string> = { 400: 'Invalid request', 403: 'Forbidden', 404: 'Not found', 409: 'Conflict', 422: 'Refused by policy', 502: 'Key store error' };

export const issuerView = (i: IssuerRow, s: Services) => ({
  id: i.id,
  tenantId: i.tenant_id,
  parentId: i.parent_id,
  kind: i.kind,
  name: i.name,
  organization: i.organization,
  keyType: i.key_type,
  custody: i.custody,
  serial: i.serial,
  generation: i.generation,
  pathLen: i.path_len,
  notBefore: i.not_before,
  notAfter: i.not_after,
  state: i.state,
  revokedAt: i.revoked_at,
  revocationReason: i.revocation_reason === null ? null : reasonName(i.revocation_reason),
  crlNumber: i.crl_number,
  replacedBy: i.replaced_by,
  certificatePem: i.certificate_pem,
  urls: { crl: s.pki.crlUrl(i.id), certificate: s.pki.caUrl(i.id), ocsp: s.pki.ocspUrl() },
  createdAt: i.created_at
});

const profileView = (p: ProfileRow) => ({ id: p.id, name: p.name, kind: p.kind, policy: p.policy, maxDays: p.max_days, defaultDays: p.default_days, state: p.state, createdAt: p.created_at, updatedAt: p.updated_at });

const certView = (c: CertRow, withPem = false) => ({
  id: c.id,
  issuerId: c.issuer_id,
  profileId: c.profile_id,
  serial: c.serial,
  commonName: c.common_name,
  sans: c.sans,
  keyType: c.key_type,
  notBefore: c.not_before,
  notAfter: c.not_after,
  fingerprint: c.fingerprint,
  state: c.state,
  revokedAt: c.revoked_at,
  revocationReason: c.revocation_reason === null ? null : reasonName(c.revocation_reason),
  invalidityDate: c.invalidity_date,
  requestedBy: c.requested_by,
  renewedFrom: c.renewed_from ?? null,
  acmeAccountId: c.acme_account_id ?? null,
  createdAt: c.created_at,
  ...(withPem ? { certificatePem: c.certificate_pem } : {})
});

const crlView = (c: CrlRow) => ({ number: c.number, thisUpdate: c.this_update, nextUpdate: c.next_update, entries: c.entries, createdAt: c.created_at });

/**
 * The certificate authority's admin API (Sprint 24, B-1601 to B-1603), under `/api/pki` with `pki:manage`. The root
 * is the platform's (creating, rotating or re-issuing it also needs `platform:manage` and a recent sign-in); each
 * tenant manages its own intermediate, profiles and certificates. Public CRL, OCSP and CA routes are in `pki-public.ts`.
 */
export function pkiRoutes(s: Services): Router {
  const r = Router();
  r.use('/pki', noStore, requireAuth(), requirePermission(s, 'pki:manage'));
  const recent = requireRecentAuth(s);

  const by = (req: Request): PkiActor => {
    const p = principalOf(req);
    return { tenantId: p.tenantId, userId: p.userId, actor: actorFrom(p, ip(req)), traceId: req.traceId };
  };
  const platform = (req: Request): boolean => effectivePermissions(principalOf(req)).has('platform:manage');

  /** Runs a service call, turning its refusals into problem details. */
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof PkiError) throw new HttpProblem(err.status, TITLES[err.status] ?? 'Error', err.message, { extensions: err.extensions });
      if (err instanceof CustodyUnavailable) throw new HttpProblem(409, 'Conflict', err.message, { extensions: { step: 'custody' } });
      throw err;
    }
  };

  /** An issuer the caller may see: a root, or an intermediate of their tenant (any, with platform:manage). */
  const visible = async (req: Request): Promise<IssuerRow> => {
    const id = id26.safeParse(req.params.id);
    if (!id.success) throw notFound('Issuer');
    const i = await s.pki.issuer(id.data);
    if (!i || (i.kind === 'intermediate' && i.tenant_id !== principalOf(req).tenantId && !platform(req))) throw notFound('Issuer');
    return i;
  };

  /** An issuer the caller may change: the root needs platform:manage; an intermediate must be the caller's tenant's. */
  const changeable = async (req: Request): Promise<IssuerRow> => {
    const i = await visible(req);
    if (i.kind === 'root' && !platform(req)) throw forbidden('Only a platform administrator manages the root.', { step: 'permission' });
    if (i.kind === 'intermediate' && i.tenant_id !== principalOf(req).tenantId) throw forbidden("Another tenant's intermediate is managed by that tenant.", { step: 'tenant' });
    return i;
  };

  r.get('/pki', async (_req, res) => {
    res.json({ ...s.pki.info(), profileMaxDays: PROFILE_MAX_DAYS, reasons: Object.keys(REASONS) });
  });

  // ---------- issuers (B-1601) ----------

  r.get('/pki/issuers', async (req, res) => {
    const q = parseBody(z.object({ all: z.enum(['true', 'false']).optional() }).strict(), req.query);
    const all = q.all === 'true' && platform(req);
    res.json({ issuers: (await s.pki.issuers(principalOf(req).tenantId, all)).map((i) => issuerView(i, s)) });
  });

  r.post('/pki/issuers', async (req, res) => {
    const b = parseBody(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('root'), commonName: z.string().trim().min(1).max(64), organization: z.string().trim().min(1).max(64).nullable().optional(), keyType: keyType.default('ecdsa-p256'), days: z.number().int().min(30).max(9125).default(3650) }).strict(),
        z.object({ kind: z.literal('intermediate'), commonName: z.string().trim().min(1).max(64).nullable().optional(), organization: z.string().trim().min(1).max(64).nullable().optional(), keyType: keyType.default('ecdsa-p256'), days: z.number().int().min(7).max(3650).default(1825) }).strict()
      ]),
      req.body
    );
    if (b.kind === 'root') {
      if (!platform(req)) throw forbidden('Only a platform administrator creates the root.', { step: 'permission' });
      // A root needs a recent sign-in (requireRecentAuth throws when the session is not fresh).
      recent(req, res, () => undefined);
      const row = await run(() => s.pki.createRoot(by(req), { commonName: b.commonName, organization: b.organization ?? null, keyType: b.keyType, days: b.days }));
      res.status(201).json(issuerView(row, s));
      return;
    }
    const row = await run(() => s.pki.createIntermediate(by(req), principalOf(req).tenantId, { commonName: b.commonName ?? null, organization: b.organization ?? null, keyType: b.keyType, days: b.days }));
    res.status(201).json(issuerView(row, s));
  });

  r.get('/pki/issuers/:id', async (req, res) => {
    const i = await visible(req);
    res.json({ ...issuerView(i, s), chain: (await s.pki.chain(i)).map((x) => x.certificate_pem), crls: (await s.pki.crls(i.id, 5)).map(crlView) });
  });

  const days = z.object({ days: z.number().int().min(7).max(9125).optional() }).strict();

  r.post('/pki/issuers/:id/rotate', recent, async (req, res) => {
    const b = parseBody(days, req.body ?? {});
    const i = await changeable(req);
    const next = await run(() => s.pki.rotate(by(req), i, b.days ?? (i.kind === 'root' ? 3650 : 1825)));
    res.status(201).json(issuerView(next, s));
  });

  r.post('/pki/issuers/:id/reissue', recent, async (req, res) => {
    const b = parseBody(days, req.body ?? {});
    const i = await changeable(req);
    const next = await run(() => s.pki.reissue(by(req), i, b.days ?? (i.kind === 'root' ? 3650 : 1825)));
    res.json(issuerView(next, s));
  });

  r.post('/pki/issuers/:id/revoke', recent, async (req, res) => {
    const b = parseBody(z.object({ reason: reason.default('unspecified') }).strict(), req.body ?? {});
    const i = await changeable(req);
    const out = await run(() => s.pki.revokeIssuer(by(req), i, REASONS[b.reason]));
    res.json(issuerView(out, s));
  });

  // ---------- issuance (B-1602) ----------

  r.post('/pki/issuers/:id/issue', async (req, res) => {
    const b = parseBody(
      z
        .object({
          csr: z.string().min(100).max(20_000).optional(),
          // Sprint 25 (B-1606): no CSR; a key made here and returned once in a PKCS#12 file under this password.
          generateKey: z.object({ keyType: z.enum(['ec-p256', 'ec-p384', 'rsa-2048', 'rsa-3072', 'rsa-4096']).default('ec-p256'), password: z.string().min(8).max(200) }).strict().optional(),
          commonName: z.string().trim().min(1).max(64).optional(),
          profileId: id26,
          days: z.number().int().min(1).max(1185).optional(),
          sans: z.array(san).min(1).max(100).optional()
        })
        .strict()
        .refine((x) => !!x.csr !== !!x.generateKey, 'Send a csr, or generateKey to have the key made here.')
        .refine((x) => !x.generateKey || x.sans || x.commonName, 'With generateKey, name the certificate with sans or commonName.')
        .refine((x) => !x.csr || x.commonName === undefined, 'commonName comes from the CSR.'),
      req.body
    );
    const i = await visible(req);
    if (b.generateKey) {
      const g = b.generateKey;
      const out = await run(() => s.pki.issueGenerated(by(req), i, { profileId: b.profileId, keyType: g.keyType, sans: b.sans ?? [], commonName: b.commonName ?? null, days: b.days, password: g.password }));
      res.status(201).json({ ...certView(out.cert, true), chainPem: out.chain, clamped: out.clamped, pkcs12: out.pkcs12.toString('base64') });
      return;
    }
    const out = await run(() => s.pki.issue(by(req), i, { csrPem: b.csr!, profileId: b.profileId, days: b.days, sans: b.sans }));
    res.status(201).json({ ...certView(out.cert, true), chainPem: out.chain, clamped: out.clamped });
  });

  // ---------- revocation and CRLs (B-1603) ----------

  r.post('/pki/issuers/:id/crl', async (req, res) => {
    const i = await visible(req);
    if (i.kind === 'root' && !platform(req)) throw forbidden('Only a platform administrator signs the root CRL on demand.', { step: 'permission' });
    if (i.kind === 'intermediate' && i.tenant_id !== principalOf(req).tenantId) throw notFound('Issuer');
    const job = await s.pki.enqueueCrl(i.id, principalOf(req).userId);
    await s.audit.append({ tenantId: principalOf(req).tenantId, action: 'pki.crl.requested', kind: 'admin', actor: actorFrom(principalOf(req), ip(req)), target: { issuer: i.id }, label: 'internal', detail: { job }, traceId: req.traceId });
    res.status(202).json({ jobId: job });
  });

  r.get('/pki/issuers/:id/crls', async (req, res) => {
    const i = await visible(req);
    res.json({ crls: (await s.pki.crls(i.id, 50)).map(crlView), url: s.pki.crlUrl(i.id) });
  });

  r.get('/pki/certificates', async (req, res) => {
    const q = parseBody(z.object({ issuerId: id26.optional(), state: z.enum(['valid', 'revoked']).optional(), limit: z.coerce.number().int().min(1).max(500).default(100), before: z.coerce.number().int().min(0).optional() }).strict(), req.query);
    const rows = await s.pki.certificates(principalOf(req).tenantId, q);
    res.json({ certificates: rows.map((c) => certView(c)) });
  });

  r.get('/pki/certificates/:id', async (req, res) => {
    const id = id26.safeParse(req.params.id);
    const c = id.success ? await s.pki.certificate(principalOf(req).tenantId, id.data) : undefined;
    if (!c) throw notFound('Certificate');
    const issuer = await s.pki.issuer(c.issuer_id);
    res.json({ ...certView(c, true), chainPem: issuer ? (await s.pki.chain(issuer)).map((x) => x.certificate_pem) : [] });
  });

  r.post('/pki/certificates/:id/revoke', async (req, res) => {
    const b = parseBody(z.object({ reason: reason.default('unspecified'), invalidityDate: z.number().int().min(0).optional() }).strict(), req.body ?? {});
    const id = id26.safeParse(req.params.id);
    const c = id.success ? await s.pki.certificate(principalOf(req).tenantId, id.data) : undefined;
    if (!c) throw notFound('Certificate');
    if (b.invalidityDate !== undefined && b.invalidityDate > Date.now()) throw new HttpProblem(400, 'Invalid request', 'The invalidity date cannot be in the future.');
    const out = await run(() => s.pki.revoke(by(req), c, REASONS[b.reason], b.invalidityDate ?? null));
    res.json(certView(out));
  });

  // ---------- export and renewal (Sprint 25, B-1606) ----------

  const certOf = async (req: Request): Promise<CertRow> => {
    const id = id26.safeParse(req.params.id);
    const c = id.success ? await s.pki.certificate(principalOf(req).tenantId, id.data) : undefined;
    if (!c) throw notFound('Certificate');
    return c;
  };
  const fileName = (c: CertRow) => (c.common_name ?? c.serial).replace(/^\*\./, 'wildcard.').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);

  r.get('/pki/certificates/:id/export', async (req, res) => {
    const q = parseBody(z.object({ format: z.enum(['pem', 'der', 'chain']).default('pem') }).strict(), req.query);
    const c = await certOf(req);
    if (q.format === 'der') {
      res.setHeader('Content-Disposition', `attachment; filename="${fileName(c)}.der"`);
      res.type('application/pkix-cert').send(fromPem(c.certificate_pem, 'CERTIFICATE'));
      return;
    }
    const body = q.format === 'chain' ? (await s.pki.chainOf(c)).join('') : c.certificate_pem;
    res.setHeader('Content-Disposition', `attachment; filename="${fileName(c)}${q.format === 'chain' ? '-chain' : ''}.pem"`);
    res.type(q.format === 'chain' ? 'application/pem-certificate-chain' : 'application/x-pem-file').send(body);
  });

  r.post('/pki/certificates/:id/pkcs12', async (req, res) => {
    const b = parseBody(z.object({ password: z.string().min(8).max(200) }).strict(), req.body);
    const c = await certOf(req);
    const p12 = await s.pki.pkcs12(c, b.password);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName(c)}.p12"`);
    res.type('application/x-pkcs12').send(p12);
  });

  r.post('/pki/certificates/:id/renew', async (req, res) => {
    const b = parseBody(z.object({ csr: z.string().min(100).max(20_000).optional(), days: z.number().int().min(1).max(1185).optional(), revokeOld: z.boolean().default(false) }).strict(), req.body ?? {});
    const c = await certOf(req);
    const out = await run(() => s.pki.renew(by(req), c, { csrPem: b.csr, days: b.days, revokeOld: b.revokeOld }));
    res.status(201).json({ ...certView(out.cert, true), chainPem: out.chain, clamped: out.clamped, revokedOld: out.revokedOld });
  });

  // ---------- ACME server settings (Sprint 25, B-1605) ----------

  const acmeView = async (req: Request) => {
    const t = principalOf(req).tenantId;
    const st = await s.pki.acme.settings(t);
    const tenant = await s.tenants.byId(t);
    return { enabled: st.enabled, profileId: st.profile_id, eabRequired: st.eab_required, challenges: st.challenges, directoryUrl: tenant ? s.pki.acme.urls(tenant.slug).directory : null, updatedAt: st.updated_at || null };
  };

  r.get('/pki/acme', async (req, res) => {
    res.json(await acmeView(req));
  });

  r.put('/pki/acme', async (req, res) => {
    const b = parseBody(z.object({ enabled: z.boolean().optional(), profileId: id26.nullable().optional(), eabRequired: z.boolean().optional(), challenges: z.array(z.enum(['http-01', 'dns-01'])).min(1).max(2).optional() }).strict(), req.body);
    await run(() => s.pki.acme.updateSettings(by(req), { enabled: b.enabled, profileId: b.profileId, eabRequired: b.eabRequired, challenges: b.challenges ? [...new Set(b.challenges)] : undefined }));
    res.json(await acmeView(req));
  });

  const eabView = (k: EabKeyRow) => ({ id: k.id, name: k.name, state: k.state, accountId: k.account_id, createdAt: k.created_at, boundAt: k.bound_at });

  r.get('/pki/acme/eab-keys', async (req, res) => {
    res.json({ keys: (await s.pki.acme.eabKeys(principalOf(req).tenantId)).map(eabView) });
  });

  r.post('/pki/acme/eab-keys', async (req, res) => {
    const b = parseBody(z.object({ name: z.string().trim().min(1).max(100) }).strict(), req.body);
    const out = await run(() => s.pki.acme.createEabKey(by(req), b.name));
    // The MAC key is shown once; the client sends the id as its kid (RFC 8555 7.3.4).
    res.status(201).json({ ...eabView(out.key), kid: out.key.id, hmacKey: out.hmacKey });
  });

  r.post('/pki/acme/eab-keys/:id/revoke', async (req, res) => {
    const id = id26.safeParse(req.params.id);
    if (!id.success) throw notFound('Key');
    res.json(eabView(await run(() => s.pki.acme.revokeEabKey(by(req), id.data))));
  });

  const accountView = (a: AcmeAccount) => ({ id: a.id, thumbprint: a.thumbprint, keyType: String(a.jwk.kty ?? ''), contact: a.contact, status: a.status, eabKeyId: a.eab_key_id, createdAt: a.created_at, updatedAt: a.updated_at });

  r.get('/pki/acme/accounts', async (req, res) => {
    res.json({ accounts: (await s.pki.acme.accounts(principalOf(req).tenantId)).map(accountView) });
  });

  r.post('/pki/acme/accounts/:id/revoke', async (req, res) => {
    const id = id26.safeParse(req.params.id);
    if (!id.success) throw notFound('Account');
    res.json(accountView(await run(() => s.pki.acme.revokeAccount(by(req), id.data))));
  });

  r.get('/pki/acme/orders', async (req, res) => {
    const q = parseBody(z.object({ accountId: id26.optional(), status: z.enum(['pending', 'ready', 'processing', 'valid', 'invalid']).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).strict(), req.query);
    const rows = await s.pki.acme.orders(principalOf(req).tenantId, q);
    res.json({ orders: rows.map((o) => ({ id: o.id, accountId: o.account_id, status: o.status, identifiers: o.identifiers.map((x) => x.value), profileId: o.profile_id, expiresAt: o.expires_at, error: o.error, certificateId: o.certificate_id, createdAt: o.created_at, updatedAt: o.updated_at })) });
  });

  // ---------- profiles (B-1602) ----------

  r.get('/pki/profiles', async (req, res) => {
    res.json({ profiles: (await s.pki.profiles(principalOf(req).tenantId)).map(profileView), kinds: PROFILE_KINDS, maxDays: PROFILE_MAX_DAYS });
  });

  r.post('/pki/profiles', async (req, res) => {
    const b = parseBody(z.object({ name: z.string().trim().min(1).max(100), kind: z.enum(PROFILE_KINDS), policy: policySchema.default(policySchema.parse({})), maxDays: z.number().int().min(1).max(1185), defaultDays: z.number().int().min(1).max(1185).optional() }).strict(), req.body);
    const row = await run(() => s.pki.createProfile(by(req), { name: b.name, kind: b.kind, policy: b.policy, maxDays: b.maxDays, defaultDays: b.defaultDays ?? b.maxDays }));
    res.status(201).json(profileView(row));
  });

  const profileOf = async (req: Request): Promise<ProfileRow> => {
    const id = id26.safeParse(req.params.id);
    const p = id.success ? await s.pki.profile(principalOf(req).tenantId, id.data) : undefined;
    if (!p) throw notFound('Profile');
    return p;
  };

  r.patch('/pki/profiles/:id', async (req, res) => {
    const b = parseBody(z.object({ policy: policySchema.optional(), maxDays: z.number().int().min(1).max(1185).optional(), defaultDays: z.number().int().min(1).max(1185).optional(), state: z.enum(['active', 'disabled']).optional() }).strict(), req.body);
    const p = await profileOf(req);
    res.json(profileView(await run(() => s.pki.updateProfile(by(req), p, b))));
  });

  r.delete('/pki/profiles/:id', async (req, res) => {
    const p = await profileOf(req);
    await run(() => s.pki.deleteProfile(by(req), p));
    res.status(204).end();
  });

  return r;
}
