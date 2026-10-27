import { createVerify, generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { githubAppJwt } from '../src/vault/apikey-providers.js';
import { isSecretRef, isVaultPath, parseApiKeyRef, parseVaultRef } from '../src/vault/policy.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

const send = (c: Client, method: 'post' | 'put' | 'patch' | 'delete', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Enough of GitHub's REST API for installation tokens: it checks the App's JWT and records what it issued and revoked. */
class FakeGitHub {
  server!: Server;
  url = '';
  issued: { token: string; installation: string; body: { permissions?: Record<string, string>; repositories?: string[] }; iss: string }[] = [];
  revoked: string[] = [];
  /** When set, DELETE /installation/token answers this status. */
  revokeStatus: number | null = null;
  /** Permissions the token comes back with beside those asked for. */
  extra: Record<string, string> = {};
  expiresInSeconds = 3600;
  private n = 0;

  constructor(private readonly publicKeyPem: string) {}

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? '';
        const reply = (status: number, body?: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(body === undefined ? '' : JSON.stringify(body));
        };
        const create = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(req.url ?? '');
        if (req.method === 'POST' && create) {
          const [head, payload, sig] = bearer.split('.');
          const ok = Boolean(head && payload && sig) && createVerify('RSA-SHA256').update(`${head}.${payload}`).verify(this.publicKeyPem, Buffer.from(sig!, 'base64url'));
          if (!ok) return reply(401, { message: 'A JSON web token could not be decoded' });
          const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as { iss: string; exp: number };
          if (claims.exp * 1000 < Date.now()) return reply(401, { message: 'Expired' });
          const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { permissions?: Record<string, string>; repositories?: string[] };
          const token = `ghs_fake${++this.n}${'x'.repeat(24)}`;
          this.issued.push({ token, installation: create[1]!, body, iss: claims.iss });
          return reply(201, { token, expires_at: new Date(Date.now() + this.expiresInSeconds * 1000).toISOString(), permissions: { ...(body.permissions ?? {}), ...this.extra }, repository_selection: body.repositories ? 'selected' : 'all' });
        }
        if (req.method === 'DELETE' && req.url === '/installation/token') {
          if (this.revokeStatus) return reply(this.revokeStatus, { message: 'Server Error' });
          if (!this.issued.some((i) => i.token === bearer) || this.revoked.includes(bearer)) return reply(401, { message: 'Bad credentials' });
          this.revoked.push(bearer);
          return reply(204);
        }
        reply(404, { message: 'Not Found' });
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

describe('API-key references (B-9301)', () => {
  it('keeps the lease reference apart from every KV reference', () => {
    expect(parseApiKeyRef('vault:apikey:exprsn/ci#key')).toEqual({ provider: 'exprsn', role: 'ci' });
    expect(parseVaultRef('vault:apikey:exprsn/ci#key')).toBeNull();
    expect(parseApiKeyRef('vault:apikey/exprsn/ci#key')).toBeNull(); // a KV secret named apikey/exprsn/ci
    expect(parseVaultRef('vault:apikey/exprsn/ci#key')).toEqual({ path: 'apikey/exprsn/ci', key: 'key' });
    expect(parseApiKeyRef('vault:apikey:exprsn/ci#token')).toBeNull();
    expect(isSecretRef('vault:apikey:gh/deploy#key')).toBe(true);
    expect(isSecretRef('vault:apps/db#password')).toBe(true);
    expect(isSecretRef('vault:nope')).toBe(false);
    expect(isVaultPath('apikey/exprsn/ci')).toBe(true);
  });
});

describe('Sprint 41: dynamic API-key leases (B-9301, B-9302)', () => {
  let h: Harness;
  let root: Client;
  let dev: Client;
  let rootId: string;
  let devId: string;
  let gh: FakeGitHub;
  let pem: string;

  beforeEach(async () => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    gh = await new FakeGitHub(pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()).start();
    h = await harness({ OLLAMA_POLL_MS: '600000', SERVICE_ALLOWED_HOSTS: '127.0.0.1', VAULT_APIKEY_LEASES_MAX: '4', VAULT_LEASE_CACHE_MS: '1000' });
    rootId = (await localUser(h, 'root', ['system-admin'], 'restricted')).id;
    devId = (await localUser(h, 'dev', ['member'], 'internal')).id;
    root = await loginAdmin(h, 'root');
    dev = await login(h, 'dev');
  });
  afterEach(async () => {
    await h.close();
    await gh.stop();
  });

  const withKey = (key: string) => ({
    get: (url: string) => request(h.app).get(url).set('authorization', `Bearer ${key}`),
    post: (url: string, body: object = {}) => request(h.app).post(url).set('authorization', `Bearer ${key}`).send(body)
  });
  const grant = (subject: string, path: string, capabilities: string[] = ['read']) => send(root, 'post', '/api/vault/policies', { subjectKind: 'user', subject, path, capabilities, effect: 'allow' }).expect(201);
  const role = (provider: string, name: string, body: object) => send(root, 'put', `/api/vault/apikey/providers/${provider}/roles/${name}`, body).expect(200);
  const audits = async (action: string) => h.s.audit.list(h.tenantId, { action });

  it('B-9301: a key issued from a lease carries no more than the role and its reader, and stops the moment the lease is revoked', async () => {
    // The role names more than the reader holds: knowledge:manage is not a member's.
    const saved = (await role('exprsn', 'ci', { scopes: ['chat:read', 'knowledge:manage'], ttlSeconds: 600, maxTtlSeconds: 1800 })).body;
    expect(saved).toMatchObject({ provider: 'exprsn', name: 'ci', scopes: ['chat:read', 'knowledge:manage'], ttlSeconds: 600, maxTtlSeconds: 1800, path: 'apikey/exprsn/ci', reference: 'vault:apikey:exprsn/ci#key' });
    await send(root, 'put', '/api/vault/apikey/providers/exprsn/roles/bad', { scopes: ['not:a-permission'] }).expect(400);
    await send(dev, 'put', '/api/vault/apikey/providers/exprsn/roles/mine', { scopes: ['chat:read'] }).expect(403);

    // Default deny: no grant, no lease, and the role is not listed.
    const denied = await send(dev, 'post', '/api/vault/apikey/creds/exprsn/ci', {}).expect(403);
    expect(denied.body).toMatchObject({ step: 'vault-policy', path: 'apikey/exprsn/ci', capability: 'read' });
    expect((await dev.agent.get('/api/vault/apikey/roles').expect(200)).body.roles).toEqual([]);
    await grant(devId, 'apikey/exprsn/ci');
    expect((await dev.agent.get('/api/vault/apikey/roles').expect(200)).body.roles).toEqual([expect.objectContaining({ provider: 'exprsn', name: 'ci', canIssue: true })]);

    const lease = (await send(dev, 'post', '/api/vault/apikey/creds/exprsn/ci', {}).expect(201)).body;
    expect(lease).toMatchObject({ provider: 'exprsn', role: 'ci', state: 'active', issuedTo: devId, scopes: ['chat:read'], leaseDurationSeconds: 600, renewable: true });
    expect(lease.key).toMatch(/^exai_k1_[0-9a-f]{12}_/);
    expect(lease.maxExpiresAt - lease.issuedAt).toBe(1800_000);
    const stored = await h.s.db('api_keys').where({ lease_id: lease.id }).first();
    expect(JSON.parse(stored.scopes)).toEqual(['chat:read']);
    // The key row ends with the lease's maximum (written a moment apart).
    expect(Math.abs(Number(stored.expires_at) - lease.maxExpiresAt)).toBeLessThan(1000);

    // The key works within its scopes and no further, though its owner holds chat:write.
    const k = withKey(lease.key);
    await k.get('/api/conversations').expect(200);
    await k.post('/api/conversations', {}).expect(403);
    // It is a lease, not one of the person's own keys, and the key is shown once.
    expect((await dev.agent.get('/api/me/api-keys').expect(200)).body).toEqual([]);
    const again = (await dev.agent.get(`/api/vault/apikey/leases/${lease.id}`).expect(200)).body;
    expect(again.key).toBeUndefined();
    expect(again.keyPrefix).toBe(stored.prefix);
    expect(JSON.stringify(await h.s.db('vault_leases').where({ id: lease.id }).first())).not.toContain(lease.key);
    expect(JSON.stringify(await audits('vault.apikey.lease.issued'))).not.toContain(lease.key);
    expect(await audits('vault.apikey.lease.issued')).toHaveLength(1);

    // Another member sees no lease; an admin sees every one.
    await localUser(h, 'plain', ['member'], 'internal');
    const plain = await login(h, 'plain');
    await plain.agent.get(`/api/vault/apikey/leases/${lease.id}`).expect(404);
    await plain.agent.get('/api/vault/apikey/leases?all=1').expect(403);
    expect((await root.agent.get('/api/vault/apikey/leases?all=1').expect(200)).body.leases).toEqual([expect.objectContaining({ id: lease.id })]);

    // Renewing moves the expiry, never past the maximum.
    const renewed = (await send(dev, 'post', `/api/vault/apikey/leases/${lease.id}/renew`).expect(200)).body;
    expect(renewed.renewals).toBe(1);
    expect(renewed.expiresAt).toBeLessThanOrEqual(lease.maxExpiresAt);

    // Used a moment ago (so every cache is warm), revoked, refused on the very next request.
    await k.get('/api/conversations').expect(200);
    const ended = (await send(dev, 'post', `/api/vault/apikey/leases/${lease.id}/revoke`).expect(200)).body;
    expect(ended.state).toBe('revoked');
    await k.get('/api/conversations').expect(401);
    expect((await h.s.db('api_keys').where({ lease_id: lease.id }).first()).revoked_at).not.toBeNull();
    expect(await audits('vault.lease.revoked')).toHaveLength(1);
    await send(dev, 'post', `/api/vault/apikey/leases/${lease.id}/renew`).expect(410);
  });

  it('B-9301: a lease that lapses is refused before the sweeper runs, a leased key takes no lease, and one person holds a bounded number', async () => {
    await role('exprsn', 'reader', { scopes: ['chat:read', 'secrets:read'], ttlSeconds: 600 });
    await grant(devId, 'apikey/exprsn');

    const short = (await send(dev, 'post', '/api/vault/apikey/creds/exprsn/reader', { ttlSeconds: 1 }).expect(201)).body;
    expect(short.leaseDurationSeconds).toBe(1);
    await withKey(short.key).get('/api/conversations').expect(200);
    await sleep(1300);
    // Not renewed within its period: refused, though the key row still says active.
    await withKey(short.key).get('/api/conversations').expect(401);
    expect((await h.s.db('api_keys').where({ lease_id: short.id }).first()).revoked_at).toBeNull();
    expect(await h.s.leases.sweep()).toEqual({ ended: 1, failed: 0 });
    expect((await h.s.db('api_keys').where({ lease_id: short.id }).first()).revoked_at).not.toBeNull();
    expect((await dev.agent.get(`/api/vault/apikey/leases/${short.id}`).expect(200)).body).toMatchObject({ state: 'expired', endReason: 'expired' });

    // The key of a lease holds secrets:read and the policy names its owner, yet it cannot take a lease.
    const first = (await send(dev, 'post', '/api/vault/apikey/creds/exprsn/reader', {}).expect(201)).body;
    const chained = await withKey(first.key).post('/api/vault/apikey/creds/exprsn/reader', {}).expect(403);
    expect(chained.body.step).toBe('apikey-lease-chain');

    // VAULT_APIKEY_LEASES_MAX is 4 here: one live already, three more, then refused.
    for (let i = 0; i < 3; i++) await send(dev, 'post', '/api/vault/apikey/creds/exprsn/reader', {}).expect(201);
    const over = await send(dev, 'post', '/api/vault/apikey/creds/exprsn/reader', {}).expect(429);
    expect(over.body).toMatchObject({ step: 'apikey-lease-limit', limit: 4 });
    await send(dev, 'post', `/api/vault/apikey/leases/${first.id}/revoke`).expect(200);
    await send(dev, 'post', '/api/vault/apikey/creds/exprsn/reader', {}).expect(201);

    // A role whose scopes the reader holds none of issues nothing.
    await role('exprsn', 'ops', { scopes: ['platform:manage'] });
    expect((await send(dev, 'post', '/api/vault/apikey/creds/exprsn/ops', {}).expect(409)).body.step).toBe('apikey-lease-scopes');
  });

  it('B-9301: a reference resolves to a fresh key for the person who saved it, under the same policy', async () => {
    await role('exprsn', 'ci', { scopes: ['chat:read'], ttlSeconds: 300 });
    const ref = 'vault:apikey:exprsn/ci#key';
    const devPrincipal = { via: 'workflow:test' };
    // At save: refused without the grant, accepted with it.
    const { loadPrincipal } = await import('../src/http/middleware.js');
    const p = (await loadPrincipal(h.s, h.tenantId, devId, {}))!;
    await expect(h.s.vault.assertRefsReadable(p, [ref])).rejects.toMatchObject({ status: 403 });
    await expect(h.s.vault.resolveFor(h.tenantId, devId, ref, devPrincipal)).rejects.toMatchObject({ status: 403 });
    await grant(devId, 'apikey/exprsn/ci');
    await h.s.vault.assertRefsReadable(p, [ref]);

    // At use: two reads, two keys, two leases, each the owner's.
    const a = await h.s.vault.resolveFor(h.tenantId, devId, ref, devPrincipal);
    const b = await h.s.vault.resolveFor(h.tenantId, devId, ref, devPrincipal);
    expect(a).not.toBe(b);
    await withKey(a).get('/api/conversations').expect(200);
    const leases = (await dev.agent.get('/api/vault/apikey/leases').expect(200)).body.leases as { id: string; issuedTo: string }[];
    expect(leases).toHaveLength(2);
    expect(leases.every((l) => l.issuedTo === devId)).toBe(true);
    // A reference without an owner does not resolve.
    await expect(h.s.vault.resolveFor(h.tenantId, null, ref, devPrincipal)).rejects.toMatchObject({ status: 403 });
    // Disabling the owner ends the key with them.
    await h.s.users.update(h.tenantId, devId, { state: 'disabled' });
    await withKey(a).get('/api/conversations').expect(401);
  });

  it('B-9302: nothing is configured until a provider is registered, and its calls pass the egress guard', async () => {
    const before = (await root.agent.get('/api/vault/apikey/providers').expect(200)).body;
    expect(before.providers.map((x: { name: string }) => x.name)).toEqual(['exprsn']);
    expect(before.kinds).toEqual([expect.objectContaining({ kind: 'github', defaultEndpoint: 'https://api.github.com', needs: expect.stringContaining('private key') })]);
    await dev.agent.get('/api/vault/apikey/providers').expect(403);
    expect(gh.issued).toHaveLength(0);

    await grant(rootId, 'kv', ['read', 'write', 'list']);
    await send(root, 'put', '/api/vault/kv/data/providers/github', { data: { private_key: pem } }).expect(201);
    const credentialRef = 'vault:providers/github#private_key';
    await send(root, 'post', '/api/vault/apikey/providers', { name: 'exprsn', kind: 'github', config: { appId: '1', installationId: '2' }, credentialRef }).expect(400);
    await send(root, 'post', '/api/vault/apikey/providers', { name: 'gl', kind: 'gitlab', config: {}, credentialRef }).expect(400);
    await send(root, 'post', '/api/vault/apikey/providers', { name: 'gh', kind: 'github', config: { appId: '1' }, credentialRef }).expect(400);
    // A literal credential is not a reference.
    await send(root, 'post', '/api/vault/apikey/providers', { name: 'gh', kind: 'github', config: { appId: '1', installationId: '2' }, credentialRef: pem }).expect(400);

    // A public address that is not on the tenant's list of allowed hosts is refused before anything is sent.
    await send(root, 'post', '/api/vault/apikey/providers', { name: 'outside', kind: 'github', endpoint: 'https://203.0.113.10', config: { appId: '12345', installationId: '678' }, credentialRef }).expect(201);
    await role('outside', 'deploy', { scopes: ['contents:read'] });
    await grant(devId, 'apikey');
    expect((await send(dev, 'post', '/api/vault/apikey/creds/outside/deploy', {}).expect(409)).body.step).toBe('egress');
    expect(await h.s.db('vault_leases')).toHaveLength(0);

    // A role is a scope set the provider understands.
    await send(root, 'put', '/api/vault/apikey/providers/outside/roles/odd', { scopes: ['chat:read:all'] }).expect(400);
    await send(root, 'put', '/api/vault/apikey/providers/outside/roles/odd', { scopes: ['contents:read', 'contents:write'] }).expect(400);
    await send(root, 'put', '/api/vault/apikey/providers/nowhere/roles/x', { scopes: ['contents:read'] }).expect(404);
  });

  it('B-9302: the sweeper revokes an expired lease\'s key at the provider, and a provider that fails is retried', async () => {
    await grant(rootId, 'kv', ['read', 'write', 'list']);
    await send(root, 'put', '/api/vault/kv/data/providers/github', { data: { private_key: pem } }).expect(201);
    const provider = (await send(root, 'post', '/api/vault/apikey/providers', { name: 'gh', kind: 'github', endpoint: gh.url, config: { appId: '12345', installationId: '678' }, credentialRef: 'vault:providers/github#private_key' }).expect(201)).body;
    expect(provider).toMatchObject({ name: 'gh', kind: 'github', configured: true, state: 'active', liveLeases: 0 });
    await role('gh', 'deploy', { scopes: ['deployments:write', 'contents:read'], config: { repositories: ['site'] }, ttlSeconds: 600 });
    await grant(devId, 'apikey/gh/deploy');

    const lease = (await send(dev, 'post', '/api/vault/apikey/creds/gh/deploy', { ttlSeconds: 1 }).expect(201)).body;
    expect(lease).toMatchObject({ provider: 'gh', providerKind: 'github', role: 'deploy', state: 'active', scopes: ['contents:read', 'deployments:write'], leaseDurationSeconds: 1 });
    expect(gh.issued).toHaveLength(1);
    expect(gh.issued[0]).toMatchObject({ token: lease.key, installation: '678', iss: '12345', body: { permissions: { contents: 'read', deployments: 'write' }, repositories: ['site'] } });
    // The lease never outlives the token GitHub issued (an hour), whatever the role allows.
    expect(lease.maxExpiresAt - lease.issuedAt).toBeLessThanOrEqual(3600_000);
    // The token is kept only sealed, for the revoke; it is in no view and no audit entry.
    const row = await h.s.db('vault_leases').where({ id: lease.id }).first();
    expect(JSON.stringify(row)).not.toContain(lease.key);
    expect(JSON.parse(row.data).sealed).toBeTruthy();
    expect(JSON.stringify((await dev.agent.get(`/api/vault/apikey/leases/${lease.id}`).expect(200)).body)).not.toContain('sealed');
    expect(JSON.stringify(await audits('vault.apikey.lease.issued'))).not.toContain(lease.key);
    // A provider with live leases cannot be removed: only it can revoke their keys.
    await send(root, 'delete', '/api/vault/apikey/providers/gh').expect(409);

    // Expired: the sweeper ends the lease and the fake records the revoke.
    await sleep(1300);
    expect(gh.revoked).toEqual([]);
    expect(await h.s.leases.sweep()).toEqual({ ended: 1, failed: 0 });
    expect(gh.revoked).toEqual([lease.key]);
    expect((await dev.agent.get(`/api/vault/apikey/leases/${lease.id}`).expect(200)).body).toMatchObject({ state: 'expired' });
    expect(await audits('vault.lease.expired')).toHaveLength(1);

    // A revoke the provider refuses leaves the lease in revoking; the sweeper tries again.
    const second = (await send(dev, 'post', '/api/vault/apikey/creds/gh/deploy', {}).expect(201)).body;
    gh.revokeStatus = 500;
    const failed = await send(dev, 'post', `/api/vault/apikey/leases/${second.id}/revoke`).expect(502);
    expect(failed.body.lease).toMatchObject({ state: 'revoking', attempts: 1 });
    expect(failed.body.lease.lastError).toContain('500');
    expect(gh.revoked).toEqual([lease.key]);
    gh.revokeStatus = null;
    await h.s.db('vault_leases').where({ id: second.id }).update({ next_attempt_at: Date.now() - 1 });
    expect(await h.s.leases.sweep()).toEqual({ ended: 1, failed: 0 });
    expect(gh.revoked).toEqual([lease.key, second.key]);
    expect((await root.agent.get(`/api/vault/apikey/leases/${second.id}`).expect(200)).body).toMatchObject({ state: 'revoked' });

    // A token that comes back with more than the role allows is revoked and refused.
    gh.extra = { administration: 'write' };
    const over = await send(dev, 'post', '/api/vault/apikey/creds/gh/deploy', {}).expect(502);
    expect(over.body.step).toBe('apikey-provider-scope');
    expect(gh.revoked).toHaveLength(3);
    gh.extra = {};

    // Disabled, it issues nothing; with no live lease it can be removed, and its roles go with it.
    await send(root, 'patch', '/api/vault/apikey/providers/gh', { state: 'disabled' }).expect(200);
    await send(dev, 'post', '/api/vault/apikey/creds/gh/deploy', {}).expect(409);
    await send(root, 'delete', '/api/vault/apikey/providers/gh').expect(204);
    expect(await h.s.db('vault_apikey_roles').where({ provider: 'gh' })).toHaveLength(0);
  });

  it('signs the App token GitHub expects', () => {
    const jwt = githubAppJwt('12345', pem, 1_800_000_000_000);
    const [head, payload] = jwt.split('.');
    expect(JSON.parse(Buffer.from(head!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString())).toEqual({ iat: 1_799_999_940, exp: 1_800_000_540, iss: '12345' });
    expect(() => githubAppJwt('12345', 'not a key')).toThrow(/RSA private key/);
  });
});
