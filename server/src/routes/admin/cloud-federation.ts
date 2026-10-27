import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../../audit/chain.js';
import { issuerTargetPath } from '../../cloud/cloud-vault.js';
import { cloudCredentials } from '../../cloud/credentials.js';
import { DISCOVERY_NAME, JWKS_NAME } from '../../cloud/issuer.js';
import { targetSchema, type IssuerTarget } from '../../cloud/issuer-publishers.js';
import { setupGuide } from '../../cloud/setup.js';
import { PROVIDERS, type CloudAccount, type Provider } from '../../cloud/types.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission, requireRecentAuth } from '../../http/middleware.js';
import { badRequest, forbidden } from '../../http/problem.js';
import { platformTenant } from '../../ops/common.js';
import type { Services } from '../../services.js';

/*
 * 1.9.99-final, Sprint 56 (B-10003 to B-10006): the federation issuer and the accounts' credentials. Every route needs
 * `cloud:admin`; the issuer is the platform's, so changing it also needs `platform:manage`, and an account's
 * credential follows the account's own rule (a platform account also needs `platform:manage`). No route ever answers
 * with a key, a secret or a token: values go in, references and states come out.
 *
 *   GET  /admin/cloud/issuer                         status: issuer URL, keys (kids, custody, states), publication, check
 *   PUT  /admin/cloud/issuer/target                  { target, secrets? } where the documents are published (recent sign-in)
 *   POST /admin/cloud/issuer/publish                 publish now
 *   POST /admin/cloud/issuer/check                   compare the published JWKS with the issuer's keys now
 *   POST /admin/cloud/issuer/rotate                  { alg?, immediate? } a new signing key (recent sign-in)
 *   POST /admin/cloud/secrets                        { scope, provider, values, expiresAt? } → vault references
 *   GET  /admin/cloud/accounts/:id/credential        mode, kind, last use, rotation, expiry
 *   GET  /admin/cloud/accounts/:id/setup             the IAM / Entra setup helper for a federated account
 *   PUT  /admin/cloud/accounts/:id/secret            { values, expiresAt? } a guided replace (recent sign-in)
 *   POST /admin/cloud/accounts/:id/rotate            an automatic rotation now: AWS keys, Azure secret (recent sign-in)
 *   POST /admin/cloud/accounts/:id/azure-certificate { days? } a client certificate from the CA, key in custody
 */

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');
const secretValue = z.string().min(1).max(4000);
const VALUE_FIELDS: Record<Provider, string[]> = { aws: ['accessKeyId', 'secretAccessKey'], azure: ['clientSecret'], digitalocean: ['token'], cloudflare: ['token'] };
const valuesFor = (provider: Provider, values: Record<string, string>, partial = false): Record<string, string> => {
  const allowed = VALUE_FIELDS[provider];
  for (const k of Object.keys(values)) if (!allowed.includes(k)) throw badRequest(`A ${provider} credential has no secret ${k}; it takes ${allowed.join(' and ')}.`);
  if (!partial) for (const k of allowed) if (!values[k]) throw badRequest(`A ${provider} credential needs ${k}.`);
  if (values.accessKeyId && !/^AKIA[A-Z0-9]{12,124}$/.test(values.accessKeyId)) throw badRequest('accessKeyId must be a long-lived IAM access key id (AKIA...).');
  return values;
};
const expiresAt = z.number().int().min(0).max(8_000_000_000_000).nullable().optional();

export function cloudFederationRoutes(s: Services): Router {
  const r = Router();
  const admin = [noStore, requireAuth(), requirePermission(s, 'cloud:admin')];
  const fresh = [noStore, requireAuth({ sessionOnly: true }), requirePermission(s, 'cloud:admin'), requireRecentAuth(s)];
  const creds = () => cloudCredentials(s);
  const platformOnly = (req: Request) => {
    if (!s.cloud.accounts.isPlatformAdmin(principalOf(req))) throw forbidden('The federation issuer is the platform\'s; changing it also needs platform:manage.', { step: 'role', action: 'platform:manage' });
  };
  const account = async (req: Request, change: boolean): Promise<CloudAccount> => {
    const p = principalOf(req);
    const a = await s.cloud.accounts.getFor(p, id26.parse(String(req.params.id)));
    if (change) s.cloud.accounts.assertCanChange(p, a);
    return a;
  };
  const audit = async (req: Request, action: string, target: Record<string, unknown>, detail: Record<string, unknown>) => {
    const tenantId = (await platformTenant(s)) ?? principalOf(req).tenantId;
    await s.audit.append({ tenantId, action, kind: 'admin', actor: actorFrom(principalOf(req), ip(req)), target, label: 'restricted', detail, traceId: req.traceId });
  };

  // ---- the issuer (B-10005) ----

  r.get('/cloud/issuer', ...admin, async (_req, res) => {
    res.json(await creds().issuer.status());
  });

  r.put('/cloud/issuer/target', ...fresh, async (req, res) => {
    platformOnly(req);
    const b = parseBody(z.object({ target: z.record(z.string(), z.unknown()), secrets: z.object({ accessKeyId: secretValue, secretAccessKey: secretValue }).strict().optional() }).strict(), req.body);
    let target = { ...b.target } as Record<string, unknown>;
    if (b.secrets) {
      const kind = String(target.kind ?? '');
      if (!['s3', 'spaces', 'r2'].includes(kind)) throw badRequest('Only an S3, Spaces or R2 target takes a key pair.');
      const out = await creds().vault.write(issuerTargetPath(kind), b.secrets);
      target = { ...target, accessKeyRef: out.refs.accessKeyId, secretKeyRef: out.refs.secretAccessKey };
    }
    const parsed = targetSchema.safeParse(target);
    if (!parsed.success) throw badRequest(`The target is not valid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    const t: IssuerTarget = parsed.data;
    if ('accountId' in t && t.accountId) await s.cloud.accounts.getFor(principalOf(req), t.accountId);
    await creds().issuer.setTarget(t, principalOf(req).userId);
    await audit(req, 'cloud.issuer.target-set', { issuer: creds().issuer.url() }, { kind: t.kind, secrets: b.secrets ? ['accessKeyId', 'secretAccessKey'] : [] });
    let publish: unknown;
    try {
      publish = await creds().issuer.publish('target set');
    } catch (err) {
      publish = { published: false, error: (err as Error).message };
    }
    res.json({ ...(await creds().issuer.status()), publish });
  });

  r.post('/cloud/issuer/publish', ...admin, async (req, res) => {
    platformOnly(req);
    parseBody(z.object({}).strict(), req.body ?? {});
    const out = await creds().issuer.publish('by an admin');
    res.json({ ...out, status: await creds().issuer.status() });
  });

  r.post('/cloud/issuer/check', ...admin, async (req, res) => {
    platformOnly(req);
    parseBody(z.object({}).strict(), req.body ?? {});
    res.json(await creds().issuer.check());
  });

  r.post('/cloud/issuer/rotate', ...fresh, async (req, res) => {
    platformOnly(req);
    const b = parseBody(z.object({ alg: z.enum(['ES256', 'RS256']).optional(), immediate: z.boolean().optional() }).strict(), req.body ?? {});
    if (b.alg === 'RS256' && !creds().issuer.algs().includes('RS256')) throw badRequest('The RS256 key is used only with CLOUD_AZURE_SIGNING_ALG=RS256.');
    const out = await creds().issuer.rotate({ ...(b.alg ? { alg: b.alg } : {}), immediate: !!b.immediate, by: principalOf(req).userId });
    res.json({ next: { kid: out.next.kid, alg: out.next.alg, state: out.next.state, activatesAt: out.next.activates_at }, previous: out.previous, published: out.published, publishError: out.publishError });
  });

  // ---- vaulted credentials (B-10006) ----

  r.post('/cloud/secrets', ...admin, async (req, res) => {
    const b = parseBody(z.object({ scope: z.enum(['platform', 'tenant']), provider: z.enum(PROVIDERS), values: z.record(z.string().max(40), secretValue), expiresAt }).strict(), req.body);
    const p = principalOf(req);
    if (b.scope === 'platform' && !s.cloud.accounts.isPlatformAdmin(p)) throw forbidden('A platform account\'s secret is stored by a platform admin (platform:manage).', { step: 'role', action: 'platform:manage' });
    const out = await creds().store({ scope: b.scope, tenantId: b.scope === 'platform' ? null : p.tenantId, values: valuesFor(b.provider, b.values), by: p.userId, expiresAt: b.expiresAt ?? null });
    res.status(201).json({ refs: out.refs, version: out.version, note: 'Name these references in the account\'s credential. The values are not shown again.' });
  });

  r.get('/cloud/accounts/:id/credential', ...admin, async (req, res) => {
    res.json(await creds().describe(await account(req, false)));
  });

  r.get('/cloud/accounts/:id/setup', ...admin, async (req, res) => {
    const a = await account(req, false);
    const issuer = creds().issuer;
    const documents = (await issuer.installed()) && a.credentialMode === 'federated' ? { [DISCOVERY_NAME]: issuer.discovery(), [JWKS_NAME]: await issuer.jwks() } : undefined;
    res.json(setupGuide({ issuer: issuer.url(), account: a, cred: await s.cloud.accounts.credentialRef(a.id), azureAlg: s.cfg.CLOUD_AZURE_SIGNING_ALG, ...(documents ? { documents: { discovery: documents[DISCOVERY_NAME], jwks: documents[JWKS_NAME] } } : {}) }));
  });

  r.put('/cloud/accounts/:id/secret', ...fresh, async (req, res) => {
    const a = await account(req, true);
    const b = parseBody(z.object({ values: z.record(z.string().max(40), secretValue), expiresAt }).strict(), req.body);
    const out = await creds().replace(a, valuesFor(a.provider, b.values, a.provider === 'aws' ? false : true), principalOf(req).userId, b.expiresAt ?? null);
    res.json({ version: out.version, refs: out.refs, refsChanged: out.refsChanged, credential: await creds().describe(a) });
  });

  r.post('/cloud/accounts/:id/rotate', ...fresh, async (req, res) => {
    const a = await account(req, true);
    parseBody(z.object({}).strict(), req.body ?? {});
    const out = await creds().rotate(a, principalOf(req).userId);
    res.json({ ...out, credential: await creds().describe(a) });
  });

  r.post('/cloud/accounts/:id/azure-certificate', ...fresh, async (req, res) => {
    const a = await account(req, true);
    const b = parseBody(z.object({ days: z.number().int().min(1).max(825).optional() }).strict(), req.body ?? {});
    const p = principalOf(req);
    const out = await creds().issueAzureCertificate(a, { tenantId: p.tenantId, userId: p.userId, actor: actorFrom(p, ip(req)), traceId: req.traceId ?? null }, b.days);
    res.status(201).json({ ...out, note: 'Upload the certificate to the app registration (az ad app credential reset --id <client-id> --cert @cert.pem --append), then name the reference as the account\'s certificate.' });
  });

  return r;
}
