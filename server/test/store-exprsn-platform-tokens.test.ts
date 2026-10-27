/*
 * 1.9.0 (B-184, last part): the Exprsn platform's CA tokens as API bearer credentials, against a local fake of the
 * platform CA (its token object and RSA-PSS signature as exprsn-platform `services/ca/services/token.js` makes them,
 * and its `POST /api/tokens/validate` with service credentials). The live platform is never called.
 */
import { constants, createSign, generateKeyPairSync, randomBytes, randomUUID, sign, X509Certificate, type KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildCertificate, distinguishedName, KU, newSerial, spkiOf } from '../src/pki/x509.js';
import { decodePlatformToken, platformSigningInput, platformSigningInputV2, resourceMatches, scopesFor } from '../src/federation/platform-tokens.js';
import { canonicalJson } from '../src/federation/canonical-json.js';
import { exprsnPlatformConfigSchema } from '../src/identity/providers/types.js';
import { formFor, storeKind } from '../src/identity/providers/kinds.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';

const DOMAIN = 'ca.platform.test';
const AUDIENCE = 'http://localhost:8080/api';
const toPem = (der: Buffer) => `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
const ecSign = (key: KeyObject) => async (tbs: Buffer) => createSign('SHA256').update(tbs).sign({ key, dsaEncoding: 'der' });

interface Held {
  userId: string;
  permissions: Record<string, boolean>;
  resource: string;
  expiresAt: number;
  revoked: boolean;
  sigVersion: 1 | 2;
  /** Minted from an MFA-verified platform login (the CA's signed mfa claim, 2026-10-21). */
  mfa?: boolean;
  /** The CA's own answer for this row, e.g. SIGNATURE_SCHEME_RETIRED once v1 is off at the platform. */
  error?: string;
}

/** The platform CA: a root, an RSA token-signing certificate it issued, its token rows and the validation endpoint. */
class FakePlatformCa {
  url = '';
  readonly serviceId = 'exprsn-ai';
  readonly serviceToken = 'svc-' + randomBytes(16).toString('hex');
  readonly tokens = new Map<string, Held>();
  validations = 0;
  down = false;
  caPem = '';
  signerPem = '';
  signerSerial = '';
  signerKey!: KeyObject;
  /** A signing certificate from another CA, for the bad-signature case. */
  rogueKey!: KeyObject;
  private server: Server | null = null;

  async start(): Promise<this> {
    const now = Date.now();
    const ca = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const caName = distinguishedName('Platform Root CA', 'Exprsn');
    const caSpki = spkiOf(ca.publicKey);
    this.caPem = toPem(await buildCertificate({ serial: newSerial(), issuerName: caName, subjectName: caName, spki: caSpki, issuerSpki: caSpki, notBefore: now - 60_000, notAfter: now + 86_400_000, keyType: 'ecdsa-p256', ca: { pathLen: 0 }, keyUsage: KU.keyCertSign | KU.cRLSign }, ecSign(ca.privateKey)));
    const leaf = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.signerKey = leaf.privateKey;
    this.signerPem = toPem(await buildCertificate({ serial: newSerial(), issuerName: caName, subjectName: distinguishedName('Platform token signing', 'Exprsn'), spki: spkiOf(leaf.publicKey), issuerSpki: caSpki, notBefore: now - 60_000, notAfter: now + 3_600_000, keyType: 'ecdsa-p256', keyUsage: KU.digitalSignature }, ecSign(ca.privateKey)));
    this.signerSerial = new X509Certificate(this.signerPem).serialNumber;
    this.rogueKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const app = express();
    app.post('/api/tokens/validate', express.json(), (req, res) => {
      this.validations++;
      if (this.down) return void res.status(500).json({ error: 'VALIDATION_ERROR' });
      if (req.header('x-service-id') !== this.serviceId || req.header('x-service-token') !== this.serviceToken) return void res.status(401).json({ success: false, error: 'AUTHENTICATION_REQUIRED' });
      const id = String(req.body.tokenId ?? '');
      const t = this.tokens.get(id);
      const no = (error: string) => res.status(401).json({ success: false, valid: false, error, message: error });
      if (!t) return void no('TOKEN_NOT_FOUND');
      if (t.revoked) return void no('TOKEN_REVOKED');
      if (t.error) return void no(t.error);
      if (Date.now() >= t.expiresAt) return void no('TOKEN_EXPIRED');
      const want = typeof req.body.resource === 'string' ? req.body.resource : null;
      if (want && !resourceMatches(want, t.resource)) return void no('RESOURCE_MISMATCH');
      const token = { id, version: '1.1', sigVersion: t.sigVersion, permissions: t.permissions, resource: { url: t.resource }, expiryType: 'time', expiresAt: t.expiresAt, data: { userId: t.userId }, mfa: t.mfa === true };
      res.json({ success: true, valid: true, token, tokenData: token.data, userId: t.userId, permissions: t.permissions });
    });
    await new Promise<void>((r) => (this.server = app.listen(0, '127.0.0.1', () => r())));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    return this;
  }

  /** Mints a token as the platform does and returns the bearer: the full signed object as base64url JSON. */
  mint(o: { sub: string; bits?: string[]; resource?: string; ttlMs?: number; notBeforeMs?: number; key?: KeyObject; expiryType?: 'time' | 'persistent'; sigVersion?: 2; mfa?: boolean; tamper?: (t: Record<string, unknown>) => void }): { bearer: string; id: string } {
    const now = Date.now();
    const id = randomUUID();
    const bits = new Set(o.bits ?? ['read']);
    const permissions = { read: bits.has('read'), write: bits.has('write'), append: bits.has('append'), update: bits.has('update'), delete: bits.has('delete') };
    const expiresAt = o.expiryType === 'persistent' ? null : now + (o.ttlMs ?? 3_600_000);
    const t: Record<string, unknown> = { id, version: '1.1', issuer: { domain: DOMAIN, certificateSerial: this.signerSerial }, permissions, resource: { url: o.resource ?? 'http://localhost:8080/' }, data: { userId: o.sub, email: `${o.sub}@platform.test` }, issuedAt: now, notBefore: now + (o.notBeforeMs ?? 0), expiresAt, expiryType: o.expiryType ?? 'time' };
    // v2 (the platform's QA-1 fix): sigVersion and the holder's platform account are fields, and the canonical JSON of
    // every field is signed. v1: the platform's old form, whose replacer array applies at every depth.
    if (o.sigVersion === 2) Object.assign(t, { sigVersion: 2, userId: 'owner-' + o.sub });
    // The platform stamps mfa (signed, v2 only) on tokens minted from a login verified with a second factor.
    if (o.sigVersion === 2 && o.mfa) t.mfa = true;
    const input = o.sigVersion === 2 ? canonicalJson(t) : JSON.stringify(t, Object.keys(t).sort());
    const signature = sign('sha256', Buffer.from(input, 'utf8'), { key: o.key ?? this.signerKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).toString('base64');
    this.tokens.set(id, { userId: o.sub, permissions, resource: (t.resource as { url: string }).url, expiresAt: expiresAt ?? Number.MAX_SAFE_INTEGER, revoked: false, sigVersion: o.sigVersion ?? 1, mfa: o.sigVersion === 2 && o.mfa === true });
    const presented = { ...t, checksum: 'ignored', signature };
    o.tamper?.(presented);
    return { bearer: Buffer.from(JSON.stringify(presented)).toString('base64url'), id };
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}

const send = (c: Client, method: 'post' | 'put' | 'patch', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);

describe('B-184: Exprsn platform CA tokens on the API', () => {
  let h: Harness;
  let root: Client;
  let ca: FakePlatformCa;
  let storeA: string;
  let storeB: string;
  let betaId: string;
  let defaultSlug: string;
  let baseConfig: Record<string, unknown>;
  let pat: { id: string };
  let bob: { id: string };
  let rootId: string;

  const bearer = (token: string, tenant?: string) => {
    const r = request(h.app);
    return { get: (url: string) => (tenant ? r.get(url).set('x-exprsn-tenant', tenant) : r.get(url)).set('authorization', `Bearer ${token}`), post: (url: string, body: object = {}) => (tenant ? r.post(url).set('x-exprsn-tenant', tenant) : r.post(url)).set('authorization', `Bearer ${token}`).send(body) };
  };
  const refusals = async (tenantId: string) => (await h.s.audit.list(tenantId, { action: 'identity.platform_token.refused' })) as unknown as { detail: { reason: string } | null; target: Record<string, unknown> }[];

  beforeAll(async () => {
    ca = await new FakePlatformCa().start();
    h = await harness();
    defaultSlug = h.s.cfg.DEFAULT_TENANT;
    rootId = (await localUser(h, 'root', ['system-admin', 'tenant-admin'], 'restricted')).id;
    root = await loginAdmin(h, 'root');
    await send(root, 'post', '/api/vault/policies', { subjectKind: 'user', subject: rootId, path: '*', capabilities: ['*'] }).expect(201);
    await send(root, 'put', '/api/vault/kv/data/identity/exprsn-platform', { data: { serviceToken: ca.serviceToken } }).expect(201);
    baseConfig = {
      platformUrl: ca.url,
      clientId: 'exprsn-ai',
      tokenIssuer: DOMAIN,
      tokenTrustAnchor: ca.caPem + ca.signerPem,
      tokenValidateUrl: `${ca.url}/api/tokens/validate`,
      tokenServiceId: ca.serviceId,
      tokenServiceToken: 'vault:identity/exprsn-platform#serviceToken',
      apiAudience: AUDIENCE,
      scopeMap: ['read=chat:read', 'write=chat:write']
    };
    // Not opted in yet: the default.
    const created = await send(root, 'post', '/api/admin/identity-providers', { name: 'Exprsn platform', kind: 'exprsn-platform', config: baseConfig });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    storeA = created.body.id;
    pat = await localUser(h, 'pat', ['member']);
    await h.s.users.upsertIdentity(pat.id, storeA, 'plat-pat', []);

    // A second tenant whose platform store trusts the same CA.
    const beta = await h.s.tenants.create({ slug: 'beta', name: 'Beta' });
    betaId = beta.id;
    const betaAdmin = await h.s.users.create(beta.id, { username: 'beta-admin', displayName: 'Beta admin', clearance: 'restricted' });
    await h.s.users.setRoles(betaAdmin.id, 'direct', ['tenant-admin']);
    const c = await h.s.vault.callerForUser(beta.id, betaAdmin.id, { via: 'test' });
    await h.s.vault.createGrant(c, { subjectKind: 'user', subject: betaAdmin.id, path: '*', capabilities: ['*'], effect: 'allow' });
    await h.s.vault.write(c, 'identity/exprsn-platform', { serviceToken: ca.serviceToken });
    storeB = (await h.s.providers.create(beta.id, { name: 'Exprsn platform', kind: 'exprsn-platform', position: 0, enabled: true, config: { ...baseConfig, acceptApiTokens: true }, vaultOwner: betaAdmin.id })).id;
    bob = await h.s.users.create(beta.id, { username: 'bob', displayName: 'Bob', clearance: 'internal' });
    await h.s.users.setRoles(bob.id, 'direct', ['member']);
    await h.s.users.upsertIdentity(bob.id, storeB, 'plat-bob', []);
    await h.s.users.upsertIdentity(bob.id, storeB, 'plat-both', []);
  });
  afterAll(async () => {
    await h.close();
    await ca.stop();
  });
  // Each case starts with a clean failed-credential count (the address would otherwise get 429 after 20 refusals).
  beforeEach(() => (h.s.counters as unknown as { windows: Map<string, unknown> }).windows.clear());

  it('reads the token as the platform makes it, and the store form shows the new settings', () => {
    const { bearer: b } = ca.mint({ sub: 'plat-pat' });
    expect(b.startsWith('eyJ')).toBe(true);
    expect(b).not.toContain('.');
    const t = decodePlatformToken(b)!;
    // The platform's signature covers the top-level fields only: nested objects are signed as {}.
    expect(platformSigningInput(t)).toContain('"issuer":{}');
    expect(platformSigningInput(t)).toContain('"data":{}');
    expect(decodePlatformToken('eyJhbGciOiJFUzI1NiJ9.e30.sig')).toBeNull();
    expect(scopesFor(new Set(['read', 'delete']), ['read=chat:read files:read', 'write=chat:write', 'delete=not:a-permission'])).toEqual(['chat:read', 'files:read']);
    const keys = formFor(storeKind('exprsn-platform')!).flatMap((s) => s.fields.map((f) => [f.key, f.type, f.multiline] as const));
    expect(keys).toEqual(expect.arrayContaining([['acceptApiTokens', 'boolean', undefined], ['tokenServiceToken', 'secret', undefined], ['tokenTrustAnchor', 'text', true], ['scopeMap', 'list', undefined]]));
    expect(exprsnPlatformConfigSchema.parse({ platformUrl: ca.url, clientId: 'x' }).acceptApiTokens).toBe(false);
    // Opting in needs the trust settings; the service token is a vault reference; scopes must name permissions.
    expect(exprsnPlatformConfigSchema.safeParse({ platformUrl: ca.url, clientId: 'x', acceptApiTokens: true }).success).toBe(false);
    expect(exprsnPlatformConfigSchema.safeParse({ ...baseConfig, acceptApiTokens: true, tokenServiceToken: 'env:SERVICE_TOKEN' }).success).toBe(false);
    expect(exprsnPlatformConfigSchema.safeParse({ ...baseConfig, scopeMap: ['read=nope:nothing'] }).success).toBe(false);
    expect(exprsnPlatformConfigSchema.safeParse({ ...baseConfig, tokenTrustAnchor: ca.signerPem }).success).toBe(false); // no CA certificate
    expect(exprsnPlatformConfigSchema.safeParse({ ...baseConfig, acceptApiTokens: true }).success).toBe(true);
  });

  it('is refused while the store has not opted in, and nothing is audited', async () => {
    const { bearer: b } = ca.mint({ sub: 'plat-pat' });
    const r = await bearer(b, defaultSlug).get('/api/conversations');
    expect(r.status).toBe(401);
    expect(r.headers['content-type']).toContain('application/problem+json');
    expect(await refusals(h.tenantId)).toHaveLength(0);
  });

  it('opting in is a store change, audited with the setting', async () => {
    await send(root, 'patch', `/api/admin/identity-providers/${storeA}`, { config: { ...baseConfig, acceptApiTokens: true } }).expect(200);
    const updated = (await h.s.audit.list(h.tenantId, { action: 'identity.provider.updated' })) as unknown as { detail: { after: { config: { acceptApiTokens?: boolean } } } }[];
    expect(updated.at(-1)!.detail.after.config.acceptApiTokens).toBe(true);
  });

  it('accepts a token for a linked account, takes the tenant from the store, needs no CSRF token', async () => {
    const before = ca.validations;
    const { bearer: b } = ca.mint({ sub: 'plat-pat', bits: ['read', 'write'] });
    // pat is linked only in the default tenant, but both tenants accept the CA: the request names the tenant.
    const list = await bearer(b, defaultSlug).get('/api/conversations');
    expect(list.status, list.text).toBe(200);
    // An unsafe method without a CSRF token: an API credential, not a cookie session.
    const made = await bearer(b, defaultSlug).post('/api/conversations', { title: 'From the platform' });
    expect(made.status, made.text).toBe(201);
    const conv = (await h.s.db('conversations').where({ id: made.body.id }).first()) as { tenant_id: string; user_id: string };
    expect(conv.tenant_id).toBe(h.tenantId);
    expect(conv.user_id).toBe(pat.id);
    // The validation answer is cached briefly: two requests, one call to the CA.
    expect(ca.validations - before).toBe(1);
    // Acceptances are not audited.
    expect(await refusals(h.tenantId)).toHaveLength(0);
  });

  it('refuses an ambiguous tenant, and the header resolves it', async () => {
    const { bearer: b } = ca.mint({ sub: 'plat-bob' });
    const amb = await bearer(b).get('/api/conversations');
    expect(amb.status).toBe(401);
    expect(amb.body.error).toBe('tenant_ambiguous');
    expect(amb.headers['content-type']).toContain('application/problem+json');
    expect(amb.text).not.toContain('beta'); // the tenants are not named
    const ok = await bearer(b, 'beta').get('/api/conversations');
    expect(ok.status, ok.text).toBe(200);
    // bob exists only in beta: naming the default tenant finds no link there.
    const wrong = await bearer(b, defaultSlug).get('/api/conversations');
    expect(wrong.status).toBe(401);
    expect(wrong.body.reason).toBe('unlinked');
    const unknown = await bearer(b, 'nowhere').get('/api/conversations');
    expect(unknown.body.reason).toBe('tenant_mismatch');
    expect((await refusals(betaId)).map((e) => e.detail?.reason)).toContain('tenant_ambiguous');
  });

  it('narrows the account\'s roles to the mapped bits', async () => {
    const { bearer: readOnly } = ca.mint({ sub: 'plat-pat', bits: ['read'] });
    expect((await bearer(readOnly, defaultSlug).get('/api/conversations')).status).toBe(200);
    const denied = await bearer(readOnly, defaultSlug).post('/api/conversations', { title: 'x' });
    expect(denied.status).toBe(403);
    expect(denied.body.step).toBe('scope');
    // A bit with no line in the table grants nothing.
    const { bearer: deleteOnly } = ca.mint({ sub: 'plat-pat', bits: ['delete'] });
    expect((await bearer(deleteOnly, defaultSlug).get('/api/conversations')).status).toBe(403);
  });

  it('refuses step-up and browser-only routes', async () => {
    const { bearer: b } = ca.mint({ sub: 'plat-pat', bits: ['read', 'write'] });
    const r = await bearer(b, defaultSlug).post('/api/me/api-keys', { name: 'k', scopes: ['chat:read'] });
    expect(r.status).toBe(403);
    expect(r.body.step).toBe('credential');
  });

  it('refuses: unlinked, disabled, wrong audience, expired, not yet valid, persistent, bad signature, revoked, forged account, platform down', async () => {
    const reason = async (b: string, tenant = defaultSlug) => {
      const r = await bearer(b, tenant).get('/api/conversations');
      return [r.status, r.body.reason] as const;
    };
    expect(await reason(ca.mint({ sub: 'plat-nobody' }).bearer)).toEqual([401, 'unlinked']);
    const dora = await localUser(h, 'dora', ['member']);
    await h.s.users.upsertIdentity(dora.id, storeA, 'plat-dora', []);
    await h.s.users.update(h.tenantId, dora.id, { state: 'disabled' });
    expect(await reason(ca.mint({ sub: 'plat-dora' }).bearer)).toEqual([401, 'account_disabled']);
    expect(await reason(ca.mint({ sub: 'plat-pat', resource: '/' }).bearer)).toEqual([401, 'wrong_audience']);
    expect(await reason(ca.mint({ sub: 'plat-pat', resource: 'https://other.example/api' }).bearer)).toEqual([401, 'wrong_audience']);
    expect(await reason(ca.mint({ sub: 'plat-pat', ttlMs: -120_000 }).bearer)).toEqual([401, 'expired']);
    expect(await reason(ca.mint({ sub: 'plat-pat', notBeforeMs: 600_000 }).bearer)).toEqual([401, 'not_yet_valid']);
    expect(await reason(ca.mint({ sub: 'plat-pat', expiryType: 'persistent' }).bearer)).toEqual([401, 'no_expiry']);
    expect(await reason(ca.mint({ sub: 'plat-pat', key: ca.rogueKey }).bearer)).toEqual([401, 'bad_signature']);
    // A changed signed field breaks the signature.
    expect(await reason(ca.mint({ sub: 'plat-pat', tamper: (t) => (t.expiresAt = Number(t.expiresAt) + 86_400_000) }).bearer)).toEqual([401, 'bad_signature']);
    // The account id is not covered by the platform's signature: a forged one is caught by the CA's answer.
    expect(await reason(ca.mint({ sub: 'plat-dora', tamper: (t) => (t.data = { userId: 'plat-pat' }) }).bearer)).toEqual([401, 'claims_mismatch']);
    const revoked = ca.mint({ sub: 'plat-pat' });
    ca.tokens.get(revoked.id)!.revoked = true;
    expect(await reason(revoked.bearer)).toEqual([401, 'revoked']);
    ca.down = true;
    expect(await reason(ca.mint({ sub: 'plat-pat' }).bearer)).toEqual([503, 'platform_unavailable']);
    ca.down = false;
    // DPoP is for OAuth access tokens only.
    expect((await request(h.app).get('/api/conversations').set('authorization', `DPoP ${ca.mint({ sub: 'plat-pat' }).bearer}`)).status).toBe(401);
    // Refusals are audited once per reason (rate-limited), with the reason and no token text.
    const events = await refusals(h.tenantId);
    const reasons = events.map((e) => e.detail?.reason);
    for (const r of ['unlinked', 'account_disabled', 'wrong_audience', 'expired', 'bad_signature', 'revoked', 'claims_mismatch']) expect(reasons).toContain(r);
    expect(reasons.filter((r) => r === 'wrong_audience')).toHaveLength(1);
    const text = JSON.stringify(events);
    expect(text).not.toContain('eyJ');
    expect(text).not.toContain(revoked.id); // the token id is the platform's own bearer: never recorded
  });

  it('QA-1: verifies v2 tokens over every presented field, nested ones included', async () => {
    const reason = async (b: string, tenant = defaultSlug) => {
      const r = await bearer(b, tenant).get('/api/conversations');
      return [r.status, r.body.reason] as const;
    };
    const v2 = ca.mint({ sub: 'plat-pat', bits: ['read', 'write'], sigVersion: 2 });
    const t = decodePlatformToken(v2.bearer)!;
    expect(t.sigVersion).toBe(2);
    // The v2 input is the canonical JSON of the whole object but signature and checksum: nested fields are in it.
    expect(platformSigningInputV2(t)).toContain('"permissions":{"append":false,"delete":false,"read":true,"update":false,"write":true}');
    expect(platformSigningInputV2(t)).toContain('"sigVersion":2');
    expect(platformSigningInputV2(t)).not.toContain('signature');
    expect((await bearer(v2.bearer, defaultSlug).get('/api/conversations')).status).toBe(200);
    expect((await bearer(v2.bearer, defaultSlug).post('/api/conversations', { title: 'v2' })).status).toBe(201);
    // Each nested field is covered: changing it breaks the signature, from a signing certificate the store trusts.
    expect(await reason(ca.mint({ sub: 'plat-pat', sigVersion: 2, tamper: (x) => ((x.permissions as Record<string, boolean>).delete = true) }).bearer)).toEqual([401, 'signature_invalid']);
    expect(await reason(ca.mint({ sub: 'plat-dora', sigVersion: 2, tamper: (x) => (x.data = { userId: 'plat-pat' }) }).bearer)).toEqual([401, 'signature_invalid']);
    expect(await reason(ca.mint({ sub: 'plat-pat', sigVersion: 2, resource: 'https://other.example/', tamper: (x) => (x.resource = { url: 'http://localhost:8080/' }) }).bearer)).toEqual([401, 'signature_invalid']);
    expect(await reason(ca.mint({ sub: 'plat-pat', sigVersion: 2, tamper: (x) => ((x.issuer as Record<string, string>).domain = DOMAIN + '.') }).bearer)).toEqual([401, 'malformed']); // no store for that CA
    expect(await reason(ca.mint({ sub: 'plat-pat', sigVersion: 2, tamper: (x) => (x.userId = 'owner-plat-dora') }).bearer)).toEqual([401, 'signature_invalid']);
    expect(await reason(ca.mint({ sub: 'plat-pat', sigVersion: 2, tamper: (x) => (x.extra = 'added') }).bearer)).toEqual([401, 'signature_invalid']);
    // Claiming v1 (dropping sigVersion) does not dodge the check: the v2 signature does not verify over v1 bytes.
    expect(await reason(ca.mint({ sub: 'plat-pat', sigVersion: 2, tamper: (x) => delete x.sigVersion }).bearer)).toEqual([401, 'bad_signature']);
    expect(await reason(ca.mint({ sub: 'plat-pat', sigVersion: 2, tamper: (x) => (x.sigVersion = 1) }).bearer)).toEqual([401, 'bad_signature']);
    // Named as a trusted certificate but signed by another key: the signature does not cover what is presented.
    expect(await reason(ca.mint({ sub: 'plat-pat', sigVersion: 2, key: ca.rogueKey }).bearer)).toEqual([401, 'signature_invalid']);
    // The signed claims must be what the platform holds for the token.
    const drifted = ca.mint({ sub: 'plat-pat', bits: ['read'], sigVersion: 2 });
    ca.tokens.get(drifted.id)!.permissions = { read: true, write: true, append: false, update: false, delete: false };
    expect(await reason(drifted.bearer)).toEqual([401, 'claims_mismatch']);
    const moved = ca.mint({ sub: 'plat-pat', sigVersion: 2 });
    ca.tokens.get(moved.id)!.resource = 'http://localhost:8080/api';
    expect(await reason(moved.bearer)).toEqual([401, 'claims_mismatch']);
    const relabelled = ca.mint({ sub: 'plat-pat', sigVersion: 2 });
    ca.tokens.get(relabelled.id)!.sigVersion = 1;
    expect(await reason(relabelled.bearer)).toEqual([401, 'claims_mismatch']);
    // Revocation is still the CA's answer.
    const revoked = ca.mint({ sub: 'plat-pat', sigVersion: 2 });
    ca.tokens.get(revoked.id)!.revoked = true;
    expect(await reason(revoked.bearer)).toEqual([401, 'revoked']);
    expect((await refusals(h.tenantId)).map((e) => e.detail?.reason)).toContain('signature_invalid');
  });

  it('QA-1: v1 tokens are unchanged until a store requires signed claims', async () => {
    const reason = async (b: string) => {
      const r = await bearer(b, defaultSlug).get('/api/conversations');
      return [r.status, r.body.reason] as const;
    };
    const v1 = ca.mint({ sub: 'plat-pat' });
    expect(decodePlatformToken(v1.bearer)!.sigVersion).toBeUndefined();
    expect(platformSigningInput(decodePlatformToken(v1.bearer)!)).toContain('"permissions":{}');
    expect((await bearer(v1.bearer, defaultSlug).get('/api/conversations')).status).toBe(200);
    // The platform has retired v1: its answer refuses.
    const retired = ca.mint({ sub: 'plat-pat' });
    ca.tokens.get(retired.id)!.error = 'SIGNATURE_SCHEME_RETIRED';
    expect(await reason(retired.bearer)).toEqual([401, 'unsigned_claims']);
    // requireSignedClaims: v1 refused here without asking the CA, v2 still accepted.
    expect(exprsnPlatformConfigSchema.parse({ platformUrl: ca.url, clientId: 'x' }).requireSignedClaims).toBe(false);
    await send(root, 'patch', `/api/admin/identity-providers/${storeA}`, { config: { ...baseConfig, acceptApiTokens: true, requireSignedClaims: true } }).expect(200);
    const before = ca.validations;
    expect(await reason(ca.mint({ sub: 'plat-pat' }).bearer)).toEqual([401, 'unsigned_claims']);
    expect(ca.validations).toBe(before);
    expect((await bearer(ca.mint({ sub: 'plat-pat', sigVersion: 2 }).bearer, defaultSlug).get('/api/conversations')).status).toBe(200);
    expect((await refusals(h.tenantId)).map((e) => e.detail?.reason)).toContain('unsigned_claims');
    await send(root, 'patch', `/api/admin/identity-providers/${storeA}`, { config: { ...baseConfig, acceptApiTokens: true } }).expect(200);
  });

  it('admin roles need the CA\'s signed mfa claim, unless the store waives it (2026-10-21)', async () => {
    await h.s.users.upsertIdentity(rootId, storeA, 'plat-root', []);
    const get = (b: string) => bearer(b, defaultSlug).get('/api/conversations');
    // No claim: the admin's roles stay unusable, as before.
    const plain = await get(ca.mint({ sub: 'plat-root', sigVersion: 2 }).bearer);
    expect(plain.status).toBe(403);
    expect(plain.body.step).toBe('mfa');
    // Minted from an MFA-verified platform login: accepted.
    expect((await get(ca.mint({ sub: 'plat-root', sigVersion: 2, mfa: true }).bearer)).status).toBe(200);
    // Adding the claim to a token breaks its v2 signature.
    const added = await get(ca.mint({ sub: 'plat-root', sigVersion: 2, tamper: (x) => (x.mfa = true) }).bearer);
    expect([added.status, added.body.reason]).toEqual([401, 'signature_invalid']);
    // The CA's answer must agree with the signed claim.
    const disagree = ca.mint({ sub: 'plat-root', sigVersion: 2, mfa: true });
    ca.tokens.get(disagree.id)!.mfa = false;
    const mismatch = await get(disagree.bearer);
    expect([mismatch.status, mismatch.body.reason]).toEqual([401, 'claims_mismatch']);
    // A v1 token cannot carry it: its signature leaves top-level additions unsigned, so it is ignored.
    const v1 = await get(ca.mint({ sub: 'plat-root', tamper: (x) => (x.mfa = true) }).bearer);
    expect([v1.status, v1.body.step]).toEqual([403, 'mfa']);
    // A member's token works with or without the claim.
    expect((await get(ca.mint({ sub: 'plat-pat', sigVersion: 2 }).bearer)).status).toBe(200);
    // The waiver: off by default, and when on an admin's token without the claim is accepted.
    expect(exprsnPlatformConfigSchema.parse({ platformUrl: ca.url, clientId: 'x' }).adminTokensWithoutMfa).toBe(false);
    await send(root, 'patch', `/api/admin/identity-providers/${storeA}`, { config: { ...baseConfig, acceptApiTokens: true, adminTokensWithoutMfa: true } }).expect(200);
    expect((await get(ca.mint({ sub: 'plat-root', sigVersion: 2 }).bearer)).status).toBe(200);
    await send(root, 'patch', `/api/admin/identity-providers/${storeA}`, { config: { ...baseConfig, acceptApiTokens: true } }).expect(200);
    expect((await get(ca.mint({ sub: 'plat-root', sigVersion: 2 }).bearer)).body.step).toBe('mfa');
  });

  it('an archived or disabled store accepts nothing', async () => {
    await h.s.db('identity_providers').where({ id: storeB }).update({ state: 'archived', enabled: false });
    const { bearer: b } = ca.mint({ sub: 'plat-both' });
    // Only the default tenant's store is left: no header needed, and bob is not linked there.
    const r = await bearer(b).get('/api/conversations');
    expect(r.status).toBe(401);
    expect(r.body.reason).toBe('unlinked');
    expect((await bearer(b, 'beta').get('/api/conversations')).body.reason).toBe('tenant_mismatch');
    await send(root, 'patch', `/api/admin/identity-providers/${storeA}`, { enabled: false }).expect(200);
    const off = await bearer(ca.mint({ sub: 'plat-pat' }).bearer, defaultSlug).get('/api/conversations');
    expect(off.status).toBe(401);
    expect(off.body.reason).toBe('malformed'); // no store accepts it: the answer for any unknown token
  });
});
