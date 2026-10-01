import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom, isUniqueViolation } from '../../audit/chain.js';
import { canGrant, canManage, permissionsFor, rolesRequireMfa } from '../../authz/permissions.js';
import { resolveMappings } from '../../repos/users.js';
import { slugify } from '../../repos/tenants.js';
import { isFederatedKind, parseProviderConfig, secretRef, type OidcUpstreamConfig, type SamlUpstreamConfig, type Step } from '../../identity/providers/types.js';
import type { ProviderRow } from '../../repos/providers.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../../http/middleware.js';
import { badRequest, conflict, forbidden, notFound } from '../../http/problem.js';
import { CLIENT_TYPES, clientJwks, DEVICE_GRANT, EXCHANGE_GRANT, OAuthError, isConfidential, type ClientRow, type Grant, type TenantCtx } from '../../federation/oidc.js';
import { certInfo, NAMEID_FORMATS, parseSpMetadata, type SpRow } from '../../federation/saml.js';
import { isKnownScope, SCOPE_GROUPS } from '../../federation/scopes.js';
import { parseIdpMetadata } from '../../federation/upstream.js';
import { idpSnapshot, spSnapshot, type MetadataSourceRow } from '../../federation/metadata.js';
import type { FederationProposalRow, ProposalActor } from '../../federation/proposals.js';
import { signJwtWith, verifyJwt } from '../../federation/jose.js';
import type { KeyRow } from '../../federation/keys.js';
import { XmlError } from '../../federation/xml.js';
import type { Services } from '../../services.js';

const TYPE_LABEL: Record<ClientRow['type'], string> = { first_party: 'confidential, BFF', public: 'public', service: 'service account', third_party: 'third party' };
const GRANT_ALIASES: Record<string, Grant> = { authorization_code: 'authorization_code', refresh_token: 'refresh_token', client_credentials: 'client_credentials', device_code: DEVICE_GRANT, token_exchange: EXCHANGE_GRANT, [DEVICE_GRANT]: DEVICE_GRANT, [EXCHANGE_GRANT]: EXCHANGE_GRANT };

/** Exact redirect URIs: https, http on a loopback address, or a private-use scheme (reverse domain) for native apps. No wildcards or fragments. */
const redirectUri = z
  .string()
  .trim()
  .max(2000)
  .refine((u) => {
    if (u.includes('*') || u.includes('#')) return false;
    try {
      const x = new URL(u);
      if (x.protocol === 'https:') return true;
      if (x.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname);
      return /^[a-z][a-z0-9+-]*\.[a-z0-9+.-]+:$/.test(x.protocol);
    } catch {
      return false;
    }
  }, 'Use an exact https URL, http on a loopback address, or a private-use scheme. Wildcards are refused.');

/** Logout URIs (front- and back-channel): https, or http on a loopback address; no fragment. */
const logoutUri = z
  .string()
  .trim()
  .max(2000)
  .refine((u) => {
    if (u.includes('#')) return false;
    try {
      const x = new URL(u);
      return x.protocol === 'https:' || (x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname));
    } catch {
      return false;
    }
  }, 'Use an https URL (http only on a loopback address).');

/** A client's public key set for signed request objects (RFC 9101). */
const jwksInput = z.unknown().transform((v, ctx) => {
  if (v === null) return null;
  try {
    return clientJwks(v);
  } catch (err) {
    ctx.addIssue({ code: 'custom', message: (err as Error).message });
    return z.NEVER;
  }
});

const clientExtras = {
  postLogoutRedirectUris: z.array(redirectUri).max(20).optional(),
  frontchannelLogoutUri: logoutUri.nullable().optional(),
  backchannelLogoutUri: logoutUri.nullable().optional(),
  jwks: jwksInput.optional(),
  parRequired: z.boolean().optional(),
  dpopRequired: z.boolean().optional()
};

const scopeList = z.array(z.string().trim().refine(isKnownScope, 'Unknown scope')).max(50);
const grantList = z.array(z.string().refine((g) => g in GRANT_ALIASES, 'Unknown grant type')).max(6).transform((gs) => [...new Set(gs.map((g) => GRANT_ALIASES[g]!))]);
const typeSchema = z.union([z.enum(CLIENT_TYPES), z.enum(['confidential, BFF', 'service account', 'third party'])]).transform((t) => (({ 'confidential, BFF': 'first_party', 'service account': 'service', 'third party': 'third_party' }) as Record<string, ClientRow['type']>)[t] ?? (t as ClientRow['type']));
const ttl = z.number().int().refine((n) => [300, 600, 1800].includes(n), 'Access tokens live 5, 10 or 30 minutes.');

const clientCreate = z.object({
  name: z.string().trim().min(1).max(100),
  type: typeSchema,
  redirectUris: z.array(redirectUri).max(20).default([]),
  scopes: scopeList.min(1),
  grants: grantList,
  pkceRequired: z.boolean().default(true),
  accessTtl: ttl.default(600),
  models: z.string().trim().max(500).nullable().default(null),
  ...clientExtras
});

const clientPatch = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  redirectUris: z.array(redirectUri).max(20).optional(),
  scopes: scopeList.min(1).optional(),
  pkceRequired: z.boolean().optional(),
  accessTtl: ttl.optional(),
  models: z.string().trim().max(500).nullable().optional(),
  ...clientExtras
});

const keyView = (k: KeyRow, rotatesAt: number | null) => ({
  kid: k.kid,
  alg: k.alg,
  state: k.state === 'next' ? 'next, published' : k.state === 'signing' ? 'signing' : 'verify only, overlap',
  createdAt: k.created_at,
  activatesAt: k.activates_at,
  retiresAt: k.state === 'signing' ? rotatesAt : k.retires_at,
  removesAt: k.removes_at,
  jwk: k.public_jwk
});

const spView = (sp: SpRow) => ({
  id: sp.id,
  name: sp.name,
  entityId: sp.entity_id,
  acsUrls: sp.acs_urls,
  nameIdFormat: sp.nameid_format,
  cert: certInfo(sp.certificate),
  signedRequests: sp.signed_requests,
  attributeMap: sp.attribute_map,
  sloUrl: sp.slo_url,
  sloBinding: sp.slo_binding,
  encryptionCert: certInfo(sp.encryption_certificate),
  encryptAssertions: sp.encrypt_assertions,
  signResponse: sp.sign_response,
  status: sp.status,
  lastUsedAt: sp.last_used_at,
  createdAt: sp.created_at
});

/** Identity: OIDC provider keys and clients, SAML IdP, upstream federation, Kerberos and device flow settings (Sprint 9). */
export function federationAdminRoutes(s: Services): Router {
  const r = Router();
  // Scoped to this router's paths: the /admin mount is shared with other admin routers.
  r.use('/federation', noStore, requireAuth(), requirePermission(s, 'identity:manage'));
  const fed = () => s.federation;

  const audit = (req: Request, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, ...(detail ? { detail } : {}), traceId: req.traceId });
  };

  const tenantOf = async (req: Request): Promise<TenantCtx> => (await fed().tenantById(principalOf(req).tenantId))!;

  const clientView = async (c: ClientRow) => {
    const settings = await fed().settings(c.tenant_id);
    const consents = await fed().oidc.consentCount(c.tenant_id, c.client_id);
    const firstParty = c.type === 'first_party' || c.type === 'service';
    return {
      id: c.id,
      clientId: c.client_id,
      name: c.name,
      type: c.type,
      typeLabel: TYPE_LABEL[c.type],
      grants: c.grants,
      scopes: c.scopes,
      redirectUris: c.redirect_uris,
      pkceRequired: c.pkce_required,
      status: c.status,
      accessTtl: c.access_ttl,
      refreshTtl: c.grants.includes('refresh_token') ? c.refresh_ttl : null,
      models: c.models,
      postLogoutRedirectUris: c.post_logout_redirect_uris,
      frontchannelLogoutUri: c.frontchannel_logout_uri,
      backchannelLogoutUri: c.backchannel_logout_uri,
      jwks: c.jwks.map((k) => ({ kid: k.kid ?? null, kty: k.kty })),
      parRequired: c.par_required,
      dpopRequired: c.dpop_required,
      introspect: c.introspect,
      introspectPending: !!(await fed().proposals.pendingFor(c.tenant_id, 'client.introspect', c.id)),
      confidential: isConfidential(c),
      secretCreatedAt: c.secret_created_at,
      serviceUserId: c.service_user_id,
      lastUsedAt: c.last_used_at,
      createdAt: c.created_at,
      consent: c.type === 'service' ? 'not applicable' : c.grants.length === 1 && c.grants[0] === DEVICE_GRANT ? 'user approves the device code' : firstParty && settings.consent.firstPartyPreconsented ? 'first party, pre-consented' : `user consent on first use, ${consents} granted`
    };
  };

  const loadClient = async (req: Request) => {
    const c = await fed().oidc.getClient(principalOf(req).tenantId, String(req.params.id));
    if (!c) throw notFound('Client');
    return c;
  };

  // ---------- overview, keys, settings, scopes ----------

  r.get('/federation', async (req, res) => {
    const t = await tenantOf(req);
    const [keys, rotatesAt, settings, kerberos, idpCert] = await Promise.all([fed().keys.list(t.id).then(async (k) => (k.length ? k : [await fed().keys.advance(t.id)])), fed().keys.rotatesAt(t.id), fed().settings(t.id), s.kerberos.status(), fed().saml.certificate(t)]);
    res.json({
      issuer: t.issuer,
      discoveryUrl: `${t.issuer}/.well-known/openid-configuration`,
      jwksUrl: `${t.issuer}/.well-known/jwks.json`,
      rotation: { days: s.cfg.OIDC_KEY_ROTATION_DAYS, overlapDays: s.cfg.OIDC_KEY_OVERLAP_DAYS, rotatesAt },
      keyStore: s.kms.kind === 'openbao' ? 'OpenBao transit' : s.kms.heldKeys ? 'signer process' : 'local KMS',
      signingInKms: typeof s.kms.sign === 'function' || !!s.kms.heldKeys,
      keys: keys.map((k) => keyView(k, rotatesAt)),
      idp: { entityId: fed().saml.entityId(t), metadataUrl: `${t.issuer}/saml/metadata`, ssoUrl: `${t.issuer}/saml/sso`, sloUrl: `${t.issuer}/saml/slo`, assertionMinutes: s.cfg.SAML_ASSERTION_MINUTES, certificate: { kid: idpCert.kid, ...certInfo(idpCert.certificate) } },
      upstream: { redirectUri: fed().upstream.redirectUri(t), acsUrl: fed().upstream.acsUrl(t), sloUrl: fed().upstream.sloUrl(t), allowList: s.cfg.FEDERATION_ALLOWED_HOSTS || null },
      device: { verificationUri: `${t.issuer}/device`, minutes: s.cfg.DEVICE_CODE_MINUTES, interval: s.cfg.DEVICE_POLL_SECONDS },
      kerberos: { ...kerberos, enabled: settings.kerberos.enabled, realms: settings.kerberos.realms },
      settings
    });
  });

  r.get('/federation/keys', async (req, res) => {
    const t = await tenantOf(req);
    await fed().keys.advance(t.id);
    const rotatesAt = await fed().keys.rotatesAt(t.id);
    res.json({ keys: (await fed().keys.list(t.id)).map((k) => keyView(k, rotatesAt)), jwks: await fed().keys.jwks(t.id), rotatesAt });
  });

  r.post('/federation/keys/rotate', async (req, res) => {
    const t = await tenantOf(req);
    const body = parseBody(z.object({ immediate: z.boolean().default(false) }), req.body ?? {});
    const out = await fed().keys.rotate(t.id, body);
    await audit(req, 'federation.key.rotated', { kid: out.next.kid, previous: out.current?.kid ?? null }, { immediate: body.immediate, activatesAt: out.next.activates_at });
    const rotatesAt = await fed().keys.rotatesAt(t.id);
    res.status(201).json({ next: keyView(out.next, rotatesAt), previous: out.current ? out.current.kid : null, keys: (await fed().keys.list(t.id)).map((k) => keyView(k, rotatesAt)) });
  });

  r.get('/federation/scopes', (_req, res) => {
    res.json(SCOPE_GROUPS);
  });

  r.get('/federation/settings', async (req, res) => {
    res.json(await fed().settings(principalOf(req).tenantId));
  });

  r.patch('/federation/settings', async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(
      z.object({
        consent: z.object({ firstPartyPreconsented: z.boolean().optional(), thirdPartyAsk: z.boolean().optional(), remember: z.boolean().optional() }).strict().optional(),
        kerberos: z.object({ enabled: z.boolean().optional(), realms: z.array(z.string().trim().toUpperCase().regex(/^[A-Z0-9.-]{1,255}$/)).max(20).optional() }).strict().optional()
      }).strict(),
      req.body
    );
    const before = await fed().settings(p.tenantId);
    const after = await fed().updateSettings(p.tenantId, body);
    await audit(req, 'federation.settings.updated', { tenant: p.tenantId }, { before, after });
    res.json(after);
  });

  // ---------- OIDC clients ----------

  r.get('/federation/oidc/clients', async (req, res) => {
    const list = await fed().oidc.listClients(principalOf(req).tenantId);
    res.json(await Promise.all(list.map(clientView)));
  });

  r.get('/federation/oidc/clients/:id', async (req, res) => {
    res.json(await clientView(await loadClient(req)));
  });

  r.post('/federation/oidc/clients', async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(clientCreate, req.body);
    const grants = body.grants;
    if (!grants.length) throw badRequest('Choose at least one grant type.');
    if (grants.includes('authorization_code') && !body.redirectUris.length) throw badRequest('The authorization code grant needs at least one redirect URI.');
    if (body.type === 'public' && (grants.includes('client_credentials') || grants.includes(EXCHANGE_GRANT))) throw badRequest('Public clients cannot use client credentials or token exchange; they have no secret.');
    if (body.type === 'service' && grants.some((g) => g !== 'client_credentials' && g !== EXCHANGE_GRANT)) throw badRequest('Service accounts use client credentials (and token exchange) only.');
    if (grants.includes('client_credentials') && body.type !== 'service') throw badRequest('Client credentials are for service accounts. Choose the service account type.');
    let serviceUserId: string | null = null;
    if (body.type === 'service') {
      // A service account is a user with no password: it holds roles, and its tokens' scopes narrow them.
      if (!canGrant(p.roles, 'member')) throw forbidden('Your roles cannot create a service account.', { step: 'role' });
      const base = `svc-${slugify(body.name)}`.slice(0, 60);
      let username = base;
      for (let i = 2; await s.users.byUsername(p.tenantId, username); i++) username = `${base}-${i}`;
      const user = await s.users.create(p.tenantId, { username, displayName: body.name, clearance: 'internal' });
      await s.users.setRoles(user.id, 'direct', ['member']);
      serviceUserId = user.id;
      await audit(req, 'user.created', { user: user.id, username }, { serviceAccount: true, roles: ['member'] });
    }
    try {
      const { client, secret } = await fed().oidc.createClient(p.tenantId, { name: body.name, type: body.type, redirectUris: body.redirectUris, grants, scopes: body.scopes, pkceRequired: body.pkceRequired, accessTtl: body.accessTtl, refreshTtl: grants.includes(DEVICE_GRANT) ? 24 * 3600 : 8 * 3600, models: body.models, serviceUserId, postLogoutRedirectUris: body.postLogoutRedirectUris, frontchannelLogoutUri: body.frontchannelLogoutUri, backchannelLogoutUri: body.backchannelLogoutUri, jwks: body.jwks, parRequired: body.parRequired, dpopRequired: body.dpopRequired }, p.userId);
      await audit(req, 'federation.client.created', { client: client.client_id, name: client.name, type: client.type }, { grants, scopes: body.scopes, redirectUris: body.redirectUris, postLogoutRedirectUris: body.postLogoutRedirectUris ?? [], frontchannelLogoutUri: body.frontchannelLogoutUri ?? null, backchannelLogoutUri: body.backchannelLogoutUri ?? null, jwksKeys: body.jwks?.length ?? 0, parRequired: !!body.parRequired, dpopRequired: !!body.dpopRequired });
      // The secret is returned once, here; only its digest is stored.
      res.status(201).json({ client: await clientView(client), secret });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('A client with that name exists.');
      throw err;
    }
  });

  r.patch('/federation/oidc/clients/:id', async (req, res) => {
    const c = await loadClient(req);
    const body = parseBody(clientPatch, req.body);
    if (body.pkceRequired === false && c.type === 'public') throw conflict('Public clients always require PKCE.');
    if (body.redirectUris && !body.redirectUris.length && c.grants.includes('authorization_code')) throw badRequest('The authorization code grant needs at least one redirect URI.');
    const row = await fed().oidc.updateClient(c.tenant_id, c.id, body);
    await audit(req, 'federation.client.updated', { client: c.client_id, name: c.name }, { before: { scopes: c.scopes, redirectUris: c.redirect_uris, pkceRequired: c.pkce_required, accessTtl: c.access_ttl, models: c.models, postLogoutRedirectUris: c.post_logout_redirect_uris, frontchannelLogoutUri: c.frontchannel_logout_uri, backchannelLogoutUri: c.backchannel_logout_uri, jwksKeys: c.jwks.length, parRequired: c.par_required, dpopRequired: c.dpop_required }, after: { ...body, jwks: body.jwks === undefined ? undefined : (body.jwks?.length ?? 0) } });
    res.json(await clientView(row!));
  });

  r.post('/federation/oidc/clients/:id/secret', async (req, res) => {
    const c = await loadClient(req);
    if (!isConfidential(c)) throw conflict('Public clients have no secret.');
    const secret = await fed().oidc.rotateSecret(c.tenant_id, c.id);
    await audit(req, 'federation.client.secret_rotated', { client: c.client_id, name: c.name });
    res.status(201).json({ client: await clientView((await fed().oidc.getClient(c.tenant_id, c.id))!), secret });
  });

  r.post('/federation/oidc/clients/:id/disable', async (req, res) => {
    const c = await loadClient(req);
    const { revoked } = await fed().oidc.setStatus(c.tenant_id, c.id, 'disabled');
    await audit(req, 'federation.client.disabled', { client: c.client_id, name: c.name }, { refreshTokensRevoked: revoked });
    res.json({ client: await clientView((await fed().oidc.getClient(c.tenant_id, c.id))!), revoked });
  });

  r.post('/federation/oidc/clients/:id/enable', async (req, res) => {
    const c = await loadClient(req);
    await fed().oidc.setStatus(c.tenant_id, c.id, 'active');
    await audit(req, 'federation.client.enabled', { client: c.client_id, name: c.name });
    res.json({ client: await clientView((await fed().oidc.getClient(c.tenant_id, c.id))!) });
  });

  /**
   * B-806: who a client may introspect for. Narrowing to its own tokens applies at once; letting it introspect every
   * client's access tokens (a resource server) is a proposal that a second identity admin approves.
   */
  r.post('/federation/oidc/clients/:id/introspect', async (req, res) => {
    const p = principalOf(req);
    const c = await loadClient(req);
    const body = parseBody(z.object({ mode: z.enum(['own', 'any']), reason: z.string().trim().max(500).optional() }).strict(), req.body);
    if (body.mode === 'own') {
      await fed().oidc.setIntrospect(c.tenant_id, c.id, 'own');
      const pending = await fed().proposals.pendingFor(c.tenant_id, 'client.introspect', c.id);
      if (pending) await s.db('federation_proposals').where({ id: pending.id, state: 'pending' }).update({ state: 'superseded', decided_by: p.userId, decided_at: Date.now(), note: 'Narrowed to own tokens.' });
      await audit(req, 'federation.client.introspect_changed', { client: c.client_id, name: c.name }, { before: c.introspect, after: 'own' });
      return void res.json({ client: await clientView((await fed().oidc.getClient(c.tenant_id, c.id))!), proposal: null });
    }
    if (!isConfidential(c)) throw conflict('Public clients cannot introspect tokens.');
    if (c.introspect === 'any') throw conflict('This client already introspects every client\'s tokens.');
    const proposal = await fed().proposals.propose(c.tenant_id, { kind: 'client.introspect', targetId: c.id, name: c.name, payload: { mode: 'any' }, summary: `Let ${c.name} (${c.client_id}) introspect access tokens issued to every client in this tenant.${body.reason ? ` Reason: ${body.reason}` : ''}` }, { tenantId: p.tenantId, userId: p.userId, username: p.username, ip: ip(req), traceId: req.traceId });
    res.status(202).json({ client: await clientView(c), proposal: proposalView(proposal) });
  });

  // ---------- proposals (introspection rights, fetched metadata) ----------

  const proposalView = (x: FederationProposalRow) => ({ id: x.id, kind: x.kind, targetId: x.target_id, name: x.name, summary: x.summary, state: x.state, proposedBy: x.proposed_by, proposedAt: x.proposed_at, decidedBy: x.decided_by, decidedAt: x.decided_at, note: x.note });
  const actorOf = (req: Request): ProposalActor => {
    const p = principalOf(req);
    return { tenantId: p.tenantId, userId: p.userId, username: p.username, ip: ip(req), traceId: req.traceId };
  };

  r.get('/federation/proposals', async (req, res) => {
    const q = parseBody(z.object({ state: z.enum(['pending', 'approved', 'rejected', 'withdrawn', 'superseded']).optional() }), req.query);
    const p = principalOf(req);
    res.json((await fed().proposals.list(p.tenantId, q.state ? { state: q.state } : {})).map((x) => ({ ...proposalView(x), mine: x.proposed_by === p.userId })));
  });

  const decision = z.object({ note: z.string().trim().max(500).optional() });
  r.post('/federation/proposals/:id/approve', async (req, res) => {
    const body = parseBody(decision, req.body ?? {});
    res.json(proposalView(await fed().proposals.approve(actorOf(req), String(req.params.id), body.note ?? null)));
  });
  r.post('/federation/proposals/:id/reject', async (req, res) => {
    const body = parseBody(decision, req.body ?? {});
    res.json(proposalView(await fed().proposals.reject(actorOf(req), String(req.params.id), body.note ?? null)));
  });
  r.post('/federation/proposals/:id/withdraw', async (req, res) => {
    res.json(proposalView(await fed().proposals.withdraw(actorOf(req), String(req.params.id))));
  });

  // ---------- fetched SAML metadata (B-807) ----------

  const sourceView = (x: MetadataSourceRow) => ({ id: x.id, kind: x.kind, url: x.url, fetchedAt: x.fetched_at, error: x.error });

  r.get('/federation/metadata', async (req, res) => {
    res.json((await fed().metadata.sources(principalOf(req).tenantId)).map(sourceView));
  });

  /** Fetches a source now; a changed certificate or endpoint becomes a proposal. */
  r.post('/federation/metadata/:id/refresh', async (req, res) => {
    const p = principalOf(req);
    if (!(await fed().metadata.source(p.tenantId, String(req.params.id)))) throw notFound('Metadata source');
    const out = await fed().metadata.refresh(p.tenantId, String(req.params.id));
    await audit(req, 'federation.metadata.refreshed', { target: String(req.params.id) }, { state: out.state, proposal: out.proposal?.id ?? null, error: out.error ?? null });
    res.json({ state: out.state, error: out.error ?? null, proposal: out.proposal ? proposalView(out.proposal) : null, source: sourceView((await fed().metadata.source(p.tenantId, String(req.params.id)))!) });
  });

  /**
   * Starts (or changes) fetching the metadata of a registered SP or upstream SAML IdP from a URL. The URL must serve
   * metadata for the same entity; if its certificates or endpoints differ from what is in force, the difference is
   * proposed for approval rather than applied.
   */
  r.put('/federation/metadata/:id', async (req, res) => {
    const p = principalOf(req);
    const id = String(req.params.id);
    const body = parseBody(z.object({ url: z.url().max(2000) }).strict(), req.body);
    const sp = await fed().saml.get(p.tenantId, id);
    const idp = sp ? undefined : await s.providers.get(p.tenantId, id);
    if (!sp && (!idp || idp.kind !== 'saml')) throw notFound('Service provider or SAML identity provider');
    let xml: string;
    try {
      xml = await fed().metadata.fetch(body.url);
    } catch (err) {
      throw badRequest(`The metadata could not be fetched: ${(err as Error).message}`);
    }
    let entity: string;
    try {
      entity = sp ? parseSpMetadata(xml).entityId : parseIdpMetadata(xml).entityId;
    } catch (err) {
      throw badRequest(`The metadata could not be read: ${(err as Error).message}`);
    }
    const current = sp ? sp.entity_id : (idp!.config as unknown as SamlUpstreamConfig).entityId;
    if (entity !== current) throw badRequest(`That URL serves metadata for ${entity}, not ${current}.`);
    await fed().metadata.register(p.tenantId, sp ? 'sp' : 'idp', id, body.url, sp ? spSnapshot(sp) : idpSnapshot(idp!.config as unknown as SamlUpstreamConfig));
    const out = await fed().metadata.refresh(p.tenantId, id);
    await audit(req, 'federation.metadata.source_set', { target: id, kind: sp ? 'sp' : 'idp' }, { url: body.url, state: out.state, proposal: out.proposal?.id ?? null });
    res.json({ state: out.state, proposal: out.proposal ? proposalView(out.proposal) : null, source: sourceView((await fed().metadata.source(p.tenantId, id))!) });
  });

  r.delete('/federation/metadata/:id', async (req, res) => {
    const p = principalOf(req);
    const src = await fed().metadata.source(p.tenantId, String(req.params.id));
    if (!src) throw notFound('Metadata source');
    await fed().metadata.forget(p.tenantId, src.id);
    await audit(req, 'federation.metadata.source_removed', { target: src.id, kind: src.kind }, { url: src.url });
    res.status(204).end();
  });

  // ---------- SAML service providers ----------

  r.get('/federation/saml/sps', async (req, res) => {
    res.json((await fed().saml.list(principalOf(req).tenantId)).map(spView));
  });

  const parseMeta = (xml: string) => {
    try {
      return parseSpMetadata(xml);
    } catch (err) {
      if (err instanceof XmlError) throw badRequest(`The metadata could not be read: ${err.message}`);
      throw err;
    }
  };

  r.post('/federation/saml/parse', async (req, res) => {
    const { xml } = parseBody(z.object({ xml: z.string().min(1).max(512 * 1024) }), req.body);
    res.json(parseMeta(xml));
  });

  r.post('/federation/saml/sps', async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1).max(100),
        xml: z.string().min(1).max(512 * 1024).optional(),
        /** B-807: fetch the metadata from a URL instead (checked like upstream providers; refreshed daily). */
        metadataUrl: z.url().max(2000).optional(),
        nameIdFormat: z.enum(Object.keys(NAMEID_FORMATS) as [keyof typeof NAMEID_FORMATS]).optional(),
        attributeMap: z.record(z.enum(['username', 'email', 'displayName', 'groups', 'roles', 'clearance']), z.string().trim().max(300)).optional(),
        encryptAssertions: z.boolean().optional(),
        signResponse: z.boolean().optional()
      }).refine((b) => !!b.xml !== !!b.metadataUrl, 'Give the metadata XML or its URL.'),
      req.body
    );
    let xml = body.xml ?? '';
    if (body.metadataUrl) {
      try {
        xml = await fed().metadata.fetch(body.metadataUrl);
      } catch (err) {
        throw badRequest(`The metadata could not be fetched: ${(err as Error).message}`);
      }
    }
    const meta = parseMeta(xml);
    if (await fed().saml.byEntity(p.tenantId, meta.entityId)) throw conflict('A service provider with that entity ID is registered.');
    if (meta.signedRequests && !meta.certificate) throw badRequest('The metadata asks for signed requests but has no signing certificate.');
    try {
      // Assertions are encrypted for an SP that publishes an encryption certificate (still valid), unless turned off.
      const encrypt = body.encryptAssertions ?? (!!meta.encryptionCertificate && !meta.encryptionCert?.expired);
      if (encrypt && (!meta.encryptionCertificate || meta.encryptionCert?.expired)) throw badRequest('The metadata has no valid encryption certificate, so assertions cannot be encrypted for it.');
      const sp = await fed().saml.create(p.tenantId, { name: body.name, entityId: meta.entityId, acsUrls: meta.acsUrls, nameIdFormat: body.nameIdFormat ?? meta.nameIdFormat, certificate: meta.certificate, signedRequests: meta.signedRequests && !meta.cert?.expired, attributeMap: body.attributeMap ?? {}, sloUrl: meta.sloUrl, sloBinding: meta.sloBinding, encryptionCertificate: meta.encryptionCertificate, encryptAssertions: encrypt, signResponse: !!body.signResponse });
      if (body.metadataUrl) await fed().metadata.register(p.tenantId, 'sp', sp.id, body.metadataUrl, spSnapshot(meta));
      await audit(req, 'federation.saml_sp.created', { sp: sp.id, name: sp.name, entity: sp.entity_id }, { acs: meta.acsUrls.map((a) => a.url), cert: meta.cert?.fingerprint ?? null, slo: meta.sloUrl, encryptionCert: meta.encryptionCert?.fingerprint ?? null, encryptAssertions: encrypt, signResponse: !!body.signResponse, metadataUrl: body.metadataUrl ?? null });
      res.status(201).json(spView(sp));
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('A service provider with that name exists.');
      throw err;
    }
  });

  r.patch('/federation/saml/sps/:id', async (req, res) => {
    const p = principalOf(req);
    const sp = await fed().saml.get(p.tenantId, String(req.params.id));
    if (!sp) throw notFound('Service provider');
    const body = parseBody(z.object({ status: z.enum(['active', 'disabled']).optional(), signedRequests: z.boolean().optional(), nameIdFormat: z.enum(Object.keys(NAMEID_FORMATS) as [keyof typeof NAMEID_FORMATS]).optional(), encryptAssertions: z.boolean().optional(), signResponse: z.boolean().optional() }).strict(), req.body);
    if (body.encryptAssertions && (!sp.encryption_certificate || certInfo(sp.encryption_certificate)?.expired)) throw conflict('This service provider has no valid encryption certificate. Upload fresh metadata first.');
    const signed = body.signedRequests ?? sp.signed_requests;
    const expired = certInfo(sp.certificate)?.expired ?? true;
    if (body.status === 'active' && signed && expired) throw conflict('Its signing certificate has expired. Upload fresh metadata, or enable it with signed requests off.');
    if (body.signedRequests && !sp.certificate) throw conflict('This service provider has no certificate to verify signed requests.');
    const row = await fed().saml.update(p.tenantId, sp.id, body);
    await audit(req, 'federation.saml_sp.updated', { sp: sp.id, name: sp.name }, { before: { status: sp.status, signedRequests: sp.signed_requests, nameIdFormat: sp.nameid_format, encryptAssertions: sp.encrypt_assertions, signResponse: sp.sign_response }, after: body });
    res.json(spView(row!));
  });

  r.delete('/federation/saml/sps/:id', async (req, res) => {
    const p = principalOf(req);
    const sp = await fed().saml.get(p.tenantId, String(req.params.id));
    if (!sp) throw notFound('Service provider');
    await fed().saml.remove(p.tenantId, sp.id);
    await fed().metadata.forget(p.tenantId, sp.id);
    await audit(req, 'federation.saml_sp.deleted', { sp: sp.id, name: sp.name, entity: sp.entity_id });
    res.status(204).end();
  });

  // ---------- upstream federation ----------

  const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> => Promise.race([p.catch(() => fallback), new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms).unref())]);

  const upstreamView = async (t: TenantCtx, row: ProviderRow) => {
    const url = row.kind === 'oidc' ? (row.config as unknown as OidcUpstreamConfig).issuer : (row.config as unknown as SamlUpstreamConfig).ssoUrl;
    const reach = await withTimeout(fed().upstream.reachOf(url), 2000, null);
    const linked = (await s.db('user_identities').where({ provider_id: row.id }).count({ n: '*' }).first()) as { n: number | string } | undefined;
    const users = Number(linked?.n ?? 0);
    return {
      id: row.id,
      name: row.name,
      protocol: row.kind,
      protocolLabel: row.kind === 'oidc' ? 'OIDC (we are RP)' : 'SAML 2.0 (we are SP)',
      source: url,
      reach: reach ?? 'unreachable',
      status: !row.enabled ? 'disabled' : reach ? 'connected' : 'unreachable',
      usedBy: users ? `${users} user${users === 1 ? '' : 's'}` : 'not yet',
      spEntityId: row.kind === 'saml' ? fed().upstream.spEntityId(t, row) : null,
      startUrl: `${t.slug === s.cfg.DEFAULT_TENANT ? '' : `/t/${t.slug}`}/federation/${row.kind}/start?provider=${row.id}`
    };
  };

  r.get('/federation/upstream', async (req, res) => {
    const t = await tenantOf(req);
    const rows = (await s.providers.list(t.id)).filter((p) => isFederatedKind(p.kind));
    res.json(await Promise.all(rows.map((row) => upstreamView(t, row))));
  });

  const upstreamInput = z.object({ protocol: z.enum(['oidc', 'saml']), source: z.string().trim().min(1).max(512 * 1024) });

  r.post('/federation/upstream/check', async (req, res) => {
    const body = parseBody(upstreamInput, req.body);
    if (body.protocol === 'oidc' && !/^https?:\/\//.test(body.source)) throw badRequest('Enter the issuer URL of the OIDC provider.');
    const out = await fed().upstream.check(body.protocol, body.source);
    await audit(req, 'federation.upstream.checked', { protocol: body.protocol, source: body.source.slice(0, 200) }, { ok: out.ok, reach: out.reach });
    res.json(out);
  });

  r.post('/federation/upstream', async (req, res) => {
    const p = principalOf(req);
    const t = await tenantOf(req);
    const body = parseBody(upstreamInput.extend({ name: z.string().trim().min(1).max(100), clientId: z.string().trim().min(1).max(200).optional(), clientSecret: secretRef.optional() }), req.body);
    let config: Record<string, unknown>;
    if (body.protocol === 'oidc') {
      if (!body.clientId) throw badRequest('Enter the client ID registered at the provider.');
      const check = await fed().upstream.check('oidc', body.source);
      if (!check.ok) throw badRequest('The provider is not reachable from here, or its discovery document is invalid. Check reachability first.', { steps: check.steps });
      config = { issuer: body.source, clientId: body.clientId, ...(body.clientSecret ? { clientSecret: body.clientSecret } : {}) };
    } else {
      const check = await fed().upstream.check('saml', body.source);
      if (!check.ok || !check.parsed) throw badRequest('The metadata could not be read, or its certificate has expired.', { steps: check.steps });
      const meta = check.parsed as ReturnType<typeof parseIdpMetadata>;
      config = { entityId: meta.entityId, ssoUrl: meta.ssoUrl, ...(meta.sloUrl ? { sloUrl: meta.sloUrl } : {}), certificates: meta.certificates };
    }
    try {
      parseProviderConfig(body.protocol, config);
    } catch (err) {
      throw badRequest(`The provider configuration did not validate: ${(err as Error).message}`);
    }
    const position = Math.max(0, ...(await s.providers.list(p.tenantId)).map((x) => x.position)) + 10;
    try {
      const row = await s.providers.create(p.tenantId, { name: body.name, kind: body.protocol, position: Math.min(position, 10000), enabled: true, config });
      // B-807: SAML metadata given as a URL is fetched again on a schedule; changes wait for approval.
      if (body.protocol === 'saml' && /^https?:\/\//.test(body.source)) await fed().metadata.register(p.tenantId, 'idp', row.id, body.source, idpSnapshot(config as unknown as SamlUpstreamConfig));
      await audit(req, 'identity.provider.created', { provider: row.id, name: row.name, kind: row.kind }, { config: row.config });
      res.status(201).json(await upstreamView(t, row));
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('A user store with that name exists.');
      throw err;
    }
  });

  // ---------- sessions ----------

  r.get('/federation/sessions', async (req, res) => {
    const p = principalOf(req);
    const [sessions, grants, clients] = await Promise.all([s.sessions.listForTenant(p.tenantId), fed().oidc.grants(p.tenantId), fed().oidc.listClients(p.tenantId)]);
    const names = new Map<string, { username: string; displayName: string }>();
    for (const g of grants) {
      if (!names.has(g.userId)) {
        const u = await s.users.get(p.tenantId, g.userId);
        names.set(g.userId, { username: u?.username ?? 'removed user', displayName: u?.display_name ?? 'removed user' });
      }
    }
    const clientName = (id: string) => clients.find((c) => c.client_id === id)?.name ?? id;
    const serviceTokens = clients.filter((c) => c.type === 'service' && c.status === 'active' && c.last_used_at && Date.now() - c.last_used_at < 24 * 3600_000);
    res.json([
      ...sessions.filter((x) => x.stage === 'active').map((x) => ({ kind: 'session', id: x.id, user: x.display_name, username: x.username, signedInAt: x.created_at, method: x.method, client: 'Exprsn-AI console' })),
      ...grants.map((g) => ({ kind: 'grant', id: g.familyId, user: names.get(g.userId)!.displayName, username: names.get(g.userId)!.username, signedInAt: g.createdAt, method: g.method, client: clientName(g.clientId) })),
      ...serviceTokens.map((c) => ({ kind: 'service', id: c.id, user: c.name, username: c.client_id, signedInAt: c.last_used_at, method: 'client credentials', client: c.name }))
    ]);
  });

  r.post('/federation/sessions/revoke', async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ kind: z.enum(['session', 'grant', 'service']), id: z.string().min(1).max(64) }), req.body);
    let revoked: number;
    // As on the Users screen: only someone who could grant all of the owner's roles may end their session or grant.
    const mayRevoke = async (userId: string) => {
      if (userId !== p.userId && !canManage(p.roles, await s.users.roleIds(userId))) throw forbidden('This belongs to someone holding roles you cannot grant, so you cannot revoke it.', { step: 'role' });
    };
    if (body.kind === 'session') {
      const target = await s.sessions.get(p.tenantId, body.id);
      if (!target) throw notFound('Session');
      await mayRevoke(target.user_id);
      await s.sessions.revoke(p.tenantId, target.id);
      revoked = 1 + (await fed().oidc.revokeForSession(p.tenantId, target.id));
      await audit(req, 'session.revoked', { session: target.id, user: target.user_id }, { refreshTokensRevoked: revoked - 1 });
    } else if (body.kind === 'grant') {
      const owner = (await s.db('oidc_refresh_tokens').where({ tenant_id: p.tenantId, family_id: body.id }).first('user_id')) as { user_id: string } | undefined;
      if (!owner) throw notFound('Grant');
      await mayRevoke(owner.user_id);
      revoked = await fed().oidc.revokeFamily(p.tenantId, body.id);
      if (!revoked) throw notFound('Grant');
      await audit(req, 'oidc.grant.revoked', { family: body.id });
    } else {
      // A service account's tokens are access tokens only; rotating its secret stops new ones, disabling ends the live ones.
      const c = await fed().oidc.getClient(p.tenantId, body.id);
      if (!c) throw notFound('Client');
      await fed().oidc.setStatus(p.tenantId, c.id, 'disabled');
      revoked = 1;
      await audit(req, 'federation.client.disabled', { client: c.client_id, name: c.name }, { from: 'sessions' });
    }
    res.json({ revoked });
  });

  // ---------- test a login ----------

  /**
   * Runs the real sign-in pieces for a user without creating a session: Kerberos availability and realm policy,
   * the directory lookup, group mappings, the user's second factors, and a token signed with the current key and
   * verified against the published JWKS (test audience). "Device code" issues a real device code for a client
   * that allows the grant, for the user to approve at the verification page.
   */
  r.post('/federation/test-login', async (req, res) => {
    const t = await tenantOf(req);
    const body = parseBody(z.object({ method: z.enum(['kerberos', 'password', 'device']), username: z.string().trim().max(190).default('') }), req.body);
    const steps: Step[] = [];
    const timed = async <T>(title: string, fn: () => Promise<T>, detail: (v: T) => string, ok: (v: T) => boolean = () => true): Promise<T | null> => {
      const t0 = performance.now();
      try {
        const v = await fn();
        steps.push({ title, ok: ok(v), detail: detail(v), ms: Math.round(performance.now() - t0) });
        return v;
      } catch (err) {
        steps.push({ title, ok: false, detail: (err as Error).message, ms: Math.round(performance.now() - t0) });
        return null;
      }
    };
    if (body.method === 'device') {
      const client = (await fed().oidc.listClients(t.id)).find((c) => c.status === 'active' && c.grants.includes(DEVICE_GRANT));
      if (!client) steps.push({ title: 'Find a client that allows the device grant', ok: false, detail: 'No active client allows the device authorization grant. Create one first.' });
      else {
        const out = await timed('Issue a device code', () => fed().oidc.issueDeviceCode(t, client, ['openid']), (o) => `Device code ${String(o.user_code)} issued for ${client.name}, expires in ${s.cfg.DEVICE_CODE_MINUTES} min`);
        if (out) steps.push({ title: `Waiting for the user to approve at ${String(out.verification_uri)}`, ok: true, detail: 'The code works once; the device polls the token endpoint until it is approved.' });
      }
      await audit(req, 'federation.test_login', { method: body.method }, { ok: steps.every((x) => x.ok) });
      return void res.json({ ok: steps.every((x) => x.ok), steps, pending: steps.length === 2 });
    }
    if (!body.username) throw badRequest('Enter a username.');
    if (body.method === 'kerberos') {
      const settings = await fed().settings(t.id);
      await timed('Kerberos SPNEGO for this tenant', async () => settings.kerberos.enabled, (on) => (on ? `enabled${settings.kerberos.realms.length ? `, realms ${settings.kerberos.realms.join(', ')}` : ', any realm'}` : 'turned off in the tenant settings'), (on) => on);
      await timed('Service keytab and GSSAPI library', () => s.kerberos.status(), (st) => st.detail, (st) => st.available);
    }
    let found: { row: ProviderRow; ext: { username: string; groups: string[]; externalId: string } } | null = null;
    for (const row of (await s.providers.list(t.id)).filter((x) => x.enabled && !isFederatedKind(x.kind))) {
      const ext = await timed(`Look up ${body.username} in ${row.name} (${row.kind})`, () => s.chain.build(row).lookup(body.username.toLowerCase()), (e) => (e ? `found, ${e.groups.length} group${e.groups.length === 1 ? '' : 's'}` : 'not found'), () => true);
      if (ext) {
        found = { row, ext };
        break;
      }
    }
    if (!found) steps.push({ title: 'User stores', ok: false, detail: `${body.username} is not in any enabled user store.` });
    else {
      let mapping = resolveMappings(await s.users.mappings(t.id), found.row.id, found.ext.groups);
      if (!mapping.roles.length) {
        const cfg = parseProviderConfig(found.row.kind, found.row.config);
        mapping = { roles: cfg.defaultRoles, clearance: cfg.defaultRoles.length ? cfg.defaultClearance : null, workspaces: [] };
      }
      const existing = await s.users.byUsername(t.id, found.ext.username);
      const direct = existing ? (await s.users.roles(existing.id)).filter((x) => x.source === 'direct').map((x) => x.role) : [];
      const roles = [...new Set([...mapping.roles, ...direct])];
      steps.push({ title: 'Group mappings', ok: roles.length > 0, detail: roles.length ? `roles ${roles.join(', ')}; clearance ${mapping.clearance ?? existing?.clearance ?? 'internal'}` : 'no mapped group: sign-in would be refused' });
      const factors = existing ? await s.mfa.methods(existing.id) : [];
      const needs = rolesRequireMfa(roles);
      steps.push({ title: 'Second factor', ok: !needs || factors.length > 0, detail: factors.length ? `enrolled: ${factors.join(', ')}` : needs ? 'required by the roles; the user enrols at first sign-in' : 'not required by the roles' });
      await timed(
        'Test token signed and verified against the JWKS',
        async () => {
          const signer = await fed().keys.signer(t.id);
          const now = Math.floor(Date.now() / 1000);
          const token = await signJwtWith({ iss: t.issuer, sub: existing?.id ?? 'test', aud: 'urn:exprsn:test-login', iat: now, exp: now + 60, scope: [...permissionsFor(roles)].slice(0, 5).join(' ') }, signer);
          verifyJwt(token, (await fed().keys.jwks(t.id)).keys, { issuer: t.issuer, audience: 'urn:exprsn:test-login', algs: ['ES256'] });
          return `${signer.kid}${signer.remote ? ' in the KMS' : ''}`;
        },
        (kid) => `signed with ${kid}, test audience; no session was created`
      );
    }
    await audit(req, 'federation.test_login', { method: body.method, username: body.username.toLowerCase() }, { ok: steps.every((x) => x.ok) });
    res.json({ ok: steps.every((x) => x.ok), steps });
  });

  // OAuth errors from shared helpers surface as problems here.
  r.use('/federation', (err: unknown, _req: Request, _res: unknown, next: (e?: unknown) => void) => next(err instanceof OAuthError ? badRequest(err.message) : err));

  return r;
}
