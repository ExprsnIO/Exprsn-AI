import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { signJwtWith, verifyJwt, type Jwk } from '../src/federation/jose.js';
import { startSigner } from '../src/signer/server.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * 1.7.0, Sprint 42 (B-9207): the other domains' signing keys registered with the vault by reference, rotation of
 * the OIDC key from the vault, and transit signing keys held by the signer process.
 */

const send = (c: Client, method: 'post' | 'put' | 'delete', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);
const jwks = async (h: Harness): Promise<Jwk[]> => (await request(h.app).get('/.well-known/jwks.json')).body.keys;
const audited = async (h: Harness, action: string) => (await h.s.db('audit_events').where({ tenant_id: h.tenantId, action })) as Record<string, unknown>[];

async function signerFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'exs-'));
  const socketPath = path.join(dir, 'run', 'signer.sock');
  const token = randomBytes(24).toString('base64url') + 'x'.repeat(8);
  const signer = await startSigner({ socketPath, key: randomBytes(32).toString('base64'), token });
  return { socketPath, token, signer, close: async () => {
    await signer.close();
    rmSync(dir, { recursive: true, force: true });
  } };
}

describe('B-9207: signing keys as vault keys', () => {
  let h: Harness;
  let f: Awaited<ReturnType<typeof signerFixture>> | null = null;
  afterEach(async () => {
    await h?.close();
    await f?.close();
    f = null;
  });

  it('rotating the OIDC signing key from the vault publishes the new key, and tokens signed before still verify', async () => {
    h = await harness();
    const rootId = (await localUser(h, 'root', ['system-admin'], 'restricted')).id;
    const root = await loginAdmin(h, 'root');
    const first = await h.s.federation.keys.advance(h.tenantId);
    const issuer = 'http://localhost:8080';
    const before = await signJwtWith({ iss: issuer, sub: 'someone', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 }, await h.s.federation.keys.signer(h.tenantId));
    const sealedBefore = ((await h.s.db('federation_keys').where({ kid: first.kid }).first()) as { private_sealed: string }).private_sealed;

    // Nothing is registered by the migration, and what is not registered is only counted.
    const empty = (await root.agent.get('/api/vault/signing-keys').expect(200)).body;
    expect(empty).toMatchObject({ keys: [], unregistered: { oidc: 1 } });

    // Registering writes a row that points at the key: its domain, where its private half is, its path. No material.
    const reg = (await send(root, 'post', '/api/vault/signing-keys/register').expect(200)).body;
    expect(reg.registered).toBe(1);
    const row = (await h.s.db('vault_signing_keys').where({ tenant_id: h.tenantId }).first()) as Record<string, unknown>;
    expect(row).toMatchObject({ domain: 'oidc', source_id: first.kid, path: `transit/signing/oidc/${first.kid}`, backend: 'sealed', key_type: 'ES256', registered_by: rootId });
    expect(JSON.stringify(row)).not.toContain(sealedBefore.slice(0, 24));
    expect(((await h.s.db('federation_keys').where({ kid: first.kid }).first()) as { private_sealed: string; state: string })).toMatchObject({ private_sealed: sealedBefore, state: 'signing' });
    expect(await audited(h, 'vault.signing-key.registered')).toHaveLength(1);
    expect((await send(root, 'post', '/api/vault/signing-keys/register').expect(200)).body.registered).toBe(0);

    // The vault's path policy decides who lists and who rotates: without a grant, neither.
    expect((await root.agent.get('/api/vault/signing-keys').expect(200)).body.keys).toEqual([]);
    const id = String(row.id);
    await send(root, 'post', `/api/vault/signing-keys/${id}/rotate`, { immediate: true }).expect(403);
    await send(root, 'post', '/api/vault/policies', { subjectKind: 'user', subject: rootId, path: 'transit/signing', capabilities: ['list', 'manage'], effect: 'allow' }).expect(201);
    const listed = (await root.agent.get('/api/vault/signing-keys').expect(200)).body.keys;
    expect(listed).toEqual([expect.objectContaining({ id, domain: 'oidc', name: first.kid, backend: 'sealed', isolated: false, state: 'signing', rotatable: true })]);

    // Rotating from the vault: the new key is in the JWKS and signs, the old one stays published, and the token
    // signed before verifies against the published set.
    const out = (await send(root, 'post', `/api/vault/signing-keys/${id}/rotate`, { immediate: true }).expect(201)).body;
    const kids = (await jwks(h)).map((k) => k.kid);
    expect(out.next).toMatchObject({ domain: 'oidc', state: 'signing' });
    expect(kids).toEqual(expect.arrayContaining([first.kid, out.next.name]));
    expect(out.next.name).not.toBe(first.kid);
    expect(verifyJwt(before, await jwks(h), { issuer, algs: ['ES256'] })).toMatchObject({ sub: 'someone' });
    const after = await signJwtWith({ iss: issuer, sub: 'later', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 }, await h.s.federation.keys.signer(h.tenantId));
    expect(JSON.parse(Buffer.from(after.split('.')[0]!, 'base64url').toString()).kid).toBe(out.next.name);
    expect(verifyJwt(after, await jwks(h), { issuer, algs: ['ES256'] })).toMatchObject({ sub: 'later' });
    // The new key was registered with the rotation; the old one is still registered, as retired, and not rotated again.
    expect(out.keys.map((k: { state: string }) => k.state).sort()).toEqual(['retired', 'signing']);
    expect(await audited(h, 'vault.signing-key.rotated')).toHaveLength(1);
    await send(root, 'post', `/api/vault/signing-keys/${id}/rotate`, {}).expect(409);
    // The old key's row was not touched by any of it but its state.
    expect(((await h.s.db('federation_keys').where({ kid: first.kid }).first()) as { private_sealed: string }).private_sealed).toBe(sealedBefore);

    // Removing a registration removes the row and nothing else: the key is still published.
    await send(root, 'delete', `/api/vault/signing-keys/${id}`).expect(204);
    expect(await h.s.db('vault_signing_keys').where({ id }).first()).toBeUndefined();
    expect((await jwks(h)).map((k) => k.kid)).toContain(first.kid);
    expect(await audited(h, 'vault.signing-key.unregistered')).toHaveLength(1);
    expect((await root.agent.get('/api/vault/signing-keys').expect(200)).body.unregistered).toEqual({ oidc: 1 });

    // A member reads nothing of it; the platform scope is the platform admin's and is empty here.
    await localUser(h, 'plain', ['member']);
    const plain = await request.agent(h.app);
    const lr = await plain.post('/api/auth/login').send({ username: 'plain', password: 'correct horse battery staple' });
    await plain.post('/api/vault/signing-keys/register').set('x-csrf-token', lr.body.csrf).send({}).expect(403);
    expect((await root.agent.get('/api/admin/platform/vault/signing-keys').expect(200)).body).toMatchObject({ scope: 'sys', keys: [] });
  });

  it('with the signer, keys are registered where they are, and a held transit key signs without leaving it', async () => {
    f = await signerFixture();
    h = await harness({ SIGNER_SOCKET: f.socketPath, SIGNER_TOKEN: f.token });
    const rootId = (await localUser(h, 'root', ['system-admin'], 'restricted')).id;
    const root = await loginAdmin(h, 'root');
    await send(root, 'post', '/api/vault/policies', { subjectKind: 'user', subject: rootId, path: 'transit', capabilities: ['*'], effect: 'allow' }).expect(201);

    // The OIDC key was made in the signer: registered as held there, by reference.
    const first = await h.s.federation.keys.advance(h.tenantId);
    await send(root, 'post', '/api/vault/signing-keys/register', { domains: ['oidc'] }).expect(200);
    const list = (await root.agent.get('/api/vault/signing-keys').expect(200)).body;
    expect(list.custody).toBe('signer');
    expect(list.keys).toEqual([expect.objectContaining({ name: first.kid, backend: 'signer', isolated: true })]);
    const signs = f.signer.served.sign ?? 0;
    const out = (await send(root, 'post', `/api/vault/signing-keys/${list.keys[0].id}/rotate`, { immediate: true }).expect(201)).body;
    expect(out.next).toMatchObject({ backend: 'signer', isolated: true, state: 'signing' });
    expect(((await h.s.db('federation_keys').where({ kid: out.next.name }).first()) as { private_sealed: string }).private_sealed.startsWith('signer:')).toBe(true);

    // A transit signing key held by the signer: the version row is a reference, signing is a call to the signer,
    // and verification needs only the public half.
    const made = (await send(root, 'post', '/api/vault/transit/keys', { name: 'release', type: 'ecdsa-p256', custody: 'held' }).expect(201)).body;
    expect(made).toMatchObject({ name: 'release', custody: 'signer', latestVersion: 1 });
    const v1 = (await h.s.db('vault_transit_versions').where({ tenant_id: h.tenantId }).first()) as { material_sealed: string; public_key: string };
    expect(v1.material_sealed.startsWith('signer:')).toBe(true);
    expect(v1.public_key).toContain('BEGIN PUBLIC KEY');
    const input = Buffer.from('a release manifest').toString('base64');
    const sig = (await send(root, 'post', '/api/vault/transit/sign/release', { input }).expect(200)).body.signature as string;
    expect(f.signer.served.sign ?? 0).toBeGreaterThan(signs);
    expect((await send(root, 'post', '/api/vault/transit/verify/release', { input, signature: sig }).expect(200)).body.valid).toBe(true);
    expect((await send(root, 'post', '/api/vault/transit/verify/release', { input: Buffer.from('another').toString('base64'), signature: sig }).expect(200)).body.valid).toBe(false);
    // Rotation makes the next version in the signer too; the earlier signature still verifies.
    expect((await send(root, 'post', '/api/vault/transit/keys/release/rotate').expect(200)).body).toMatchObject({ latestVersion: 2, custody: 'signer' });
    const sig2 = (await send(root, 'post', '/api/vault/transit/sign/release', { input }).expect(200)).body.signature as string;
    expect(sig2.startsWith('exai:v2:')).toBe(true);
    expect((await send(root, 'post', '/api/vault/transit/verify/release', { input, signature: sig }).expect(200)).body.valid).toBe(true);
    expect((await send(root, 'post', '/api/vault/transit/verify/release', { input, signature: sig2 }).expect(200)).body.valid).toBe(true);
    // An Ed25519 one, and what cannot be held.
    await send(root, 'post', '/api/vault/transit/keys', { name: 'notes', type: 'ed25519', custody: 'held' }).expect(201);
    const s3 = (await send(root, 'post', '/api/vault/transit/sign/notes', { input }).expect(200)).body.signature as string;
    expect((await send(root, 'post', '/api/vault/transit/verify/notes', { input, signature: s3 }).expect(200)).body.valid).toBe(true);
    await send(root, 'post', '/api/vault/transit/keys', { name: 'bulk', type: 'aes256-gcm96', custody: 'held' }).expect(400);
    // A sealed key is still made as before, beside them.
    expect((await send(root, 'post', '/api/vault/transit/keys', { name: 'plain', type: 'ed25519' }).expect(201)).body.custody).toBe('sealed');
  });

  it('refuses a held key when neither the signer nor OpenBao is there', async () => {
    h = await harness();
    const rootId = (await localUser(h, 'root', ['system-admin'], 'restricted')).id;
    const root = await loginAdmin(h, 'root');
    await send(root, 'post', '/api/vault/policies', { subjectKind: 'user', subject: rootId, path: 'transit', capabilities: ['*'], effect: 'allow' }).expect(201);
    const res = await send(root, 'post', '/api/vault/transit/keys', { name: 'release', type: 'ecdsa-p256', custody: 'held' }).expect(409);
    expect(res.body.step).toBe('key-custody');
    expect((await root.agent.get('/api/vault/signing-keys').expect(200)).body.custody).toBeNull();
  });
});
