/*
 * 1.9.0, Sprint 55 (B-188): CA tokens and one-time tickets. Tokens are compact JWS signed in custody (the signer here
 * is an in-process `exprsn-ai signer` on a temporary socket), bound to a resource with permission bits, ended by
 * time, by uses (spent atomically, also under concurrent validation) or never; refreshed, introspected, revoked one
 * by one or in bulk; revoking the signing certificate revokes its tokens; only hashes are stored. Without migration
 * 128 tokens report as not configured.
 */
import { constants, createHash, createPublicKey, verify, X509Certificate } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harness, localUser, login, type Harness } from './helpers.js';
import { admin, migrate55, unmigrate55, signerFixture, type AdminClient } from './pki-sprint55-helpers.js';

const part = (t: string, i: number) => JSON.parse(Buffer.from(t.split('.')[i]!, 'base64url').toString('utf8')) as Record<string, unknown>;

describe('B-188: CA tokens and one-time tickets', () => {
  let f: Awaited<ReturnType<typeof signerFixture>>;
  let h: Harness;
  let sys: AdminClient;
  let ta: AdminClient;
  let member: Awaited<ReturnType<typeof login>>;
  let slug: string;
  let memberId: string;
  let first: { id: string; token: string; signerId: string };

  beforeAll(async () => {
    f = await signerFixture();
    h = await harness({ DATA_KEY: '', SIGNER_SOCKET: f.socketPath, SIGNER_TOKEN: f.token, PKI_PUBLIC_URL: 'http://ca.example.test' });
    sys = await admin(h, 'root', ['system-admin']);
    ta = await admin(h, 'ta', ['tenant-admin']);
    const m = await localUser(h, 'reader', ['member']);
    memberId = m.id;
    member = await login(h, 'reader');
    slug = (await h.s.tenants.byId(h.tenantId))!.slug;
  }, 120_000);
  afterAll(async () => {
    await h.close();
    await f.close();
  });

  it('without migration 128 tokens report as not configured', async () => {
    await unmigrate55(h);
    const g = await ta.get('/api/pki/tokens');
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ configured: false, tokens: [] });
    const p = await ta.post('/api/pki/tokens', { resource: { type: 'url', id: 'https://files.example.test/docs/' }, permissions: ['read'] });
    expect(p.status).toBe(409);
    expect(p.body.step).toBe('tokens-table');
    await migrate55(h);
    expect((await sys.post('/api/pki/issuers', { kind: 'root', commonName: 'Token Root' })).status).toBe(201);
    expect((await ta.post('/api/pki/issuers', { kind: 'intermediate' })).status).toBe(201);
  });

  it('a token is a JWS signed in custody, bound to a resource, and only its hash and id are kept', async () => {
    const signs = f.signer.served.sign ?? 0;
    const r = await ta.post('/api/pki/tokens', { resource: { type: 'url', id: 'https://files.example.test/docs/' }, permissions: ['read', 'append'], expiry: { kind: 'time', ttlMinutes: 30 }, subject: memberId, label: 'docs reader' });
    expect(r.status).toBe(201);
    expect((f.signer.served.sign ?? 0) - signs).toBeGreaterThanOrEqual(2); // the signer's certificate, then the token
    const token = r.body.token as string;
    first = { id: r.body.id, token, signerId: r.body.signerId };
    const header = part(token, 0);
    const payload = part(token, 1);
    expect(header).toMatchObject({ alg: 'ES256', typ: 'exprsn-ca+jwt', kid: r.body.signerId });
    expect(payload).toMatchObject({ jti: r.body.id, tid: h.tenantId, sub: memberId, res: { type: 'url', id: 'https://files.example.test/docs/' }, perm: ['read', 'append'], iss: `http://ca.example.test/pki/tokens/${slug}` });
    expect(Number(payload.exp) - Number(payload.iat)).toBe(30 * 60);
    // The published chain checks the signature offline.
    const keys = await request(h.app).get(`/pki/tokens/${slug}/keys`);
    expect(keys.status).toBe(200);
    const k = keys.body.keys.find((x: { kid: string }) => x.kid === r.body.signerId);
    const signerCert = new X509Certificate(Buffer.from(k.x5c[0], 'base64'));
    const interCert = new X509Certificate(Buffer.from(k.x5c[1], 'base64'));
    expect(signerCert.verify(interCert.publicKey)).toBe(true);
    const [hh, pp, ss] = token.split('.');
    expect(verify('sha256', Buffer.from(`${hh}.${pp}`), { key: signerCert.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(ss!, 'base64url'))).toBe(true);
    expect(k['x5t#S256']).toBe(header['x5t#S256']);
    // The signer's certificate is an ordinary certificate of the tenant (so it can be revoked there).
    const cert = (await h.s.db('pki_certificates').where({ fingerprint: createHash('sha256').update(signerCert.raw).digest('hex') }).first()) as Record<string, unknown>;
    expect(cert.state).toBe('valid');
    // Only the id and the SHA-256 of the token are stored.
    const rows = (await h.s.db('pki_tokens')) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hash).toBe(createHash('sha256').update(token).digest('hex'));
    const all = JSON.stringify(await h.s.db('pki_tokens')) + JSON.stringify(await h.s.db('pki_token_signers')) + JSON.stringify(await h.s.db('audit_events'));
    expect(all).not.toContain(token);
    expect(all).not.toContain(ss);
    expect(all).not.toMatch(/PRIVATE KEY/);
    // The list never shows the token.
    const list = await ta.get('/api/pki/tokens');
    expect(list.body.configured).toBe(true);
    expect(JSON.stringify(list.body)).not.toContain(token);
    expect(list.body.tokens[0]).toMatchObject({ id: r.body.id, permissions: ['read', 'append'], state: 'active', expiry: 'time' });
  });

  it('permission bits and the resource binding decide validation; validation needs pki:tokens', async () => {
    const v = (b: object) => ta.post('/api/pki/tokens/validate', { token: first.token, ...b });
    expect((await v({ permission: 'read', resource: { type: 'url', id: 'https://files.example.test/docs/a/b.txt' } })).body).toMatchObject({ active: true });
    expect((await v({ permission: 'append' })).body.active).toBe(true);
    expect((await v({ permission: 'write' })).body).toMatchObject({ active: false, reason: 'permission' });
    expect((await v({ permission: 'delete' })).body).toMatchObject({ active: false, reason: 'permission' });
    expect((await v({ resource: { type: 'url', id: 'https://files.example.test/other' } })).body).toMatchObject({ active: false, reason: 'resource' });
    expect((await v({ resource: { type: 'url', id: 'https://files.example.test/docsx/a' } })).body).toMatchObject({ active: false, reason: 'resource' });
    expect((await v({ resource: { type: 'did', id: 'did:plc:abc' } })).body).toMatchObject({ active: false, reason: 'resource' });
    expect(Number(((await h.s.db('pki_tokens').where({ id: first.id }).first()) as { permissions: number }).permissions)).toBe(1 | 4);
    // A tampered token is unknown (its hash is not stored); another tenant cannot see this one.
    expect((await ta.post('/api/pki/tokens/validate', { token: first.token.slice(0, -2) + 'AA' })).body).toMatchObject({ active: false, reason: 'unknown' });
    expect((await h.s.caTokens.check('01J00000000000000000000000', first.token))).toMatchObject({ active: false, reason: 'unknown' });
    expect(member.res.body.stage).toBe('active');
    expect((await member.agent.post('/api/pki/tokens/validate').set('x-csrf-token', member.csrf).send({ token: first.token })).status).toBe(403);
    // Issuing needs pki:manage; malformed resources are refused.
    expect((await ta.post('/api/pki/tokens', { resource: { type: 'did', id: 'not a did' }, permissions: ['read'] })).status).toBe(422);
    expect((await ta.post('/api/pki/tokens', { resource: { type: 'cid', id: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi' }, permissions: ['admin'], expiry: { kind: 'persistent' } })).status).toBe(201);
  });

  it('expiry by time and by uses: concurrent validations never spend more than there is', async () => {
    const t = await ta.post('/api/pki/tokens', { resource: { type: 'did', id: 'did:web:example.test' }, permissions: ['write'], expiry: { kind: 'time', ttlMinutes: 5 } });
    await h.s.db('pki_tokens').where({ id: t.body.id }).update({ expires_at: Date.now() - 1000 });
    expect((await ta.post('/api/pki/tokens/validate', { token: t.body.token })).body).toMatchObject({ active: false, reason: 'expired' });

    const u = await ta.post('/api/pki/tokens', { resource: { type: 'did', id: 'did:web:example.test' }, permissions: ['write'], expiry: { kind: 'uses', uses: 3 } });
    expect(u.status).toBe(201);
    expect(part(u.body.token, 1).uses).toBe(3);
    // Introspection does not spend.
    expect((await ta.post('/api/pki/tokens/introspect', { token: u.body.token })).body).toMatchObject({ active: true, uses_left: 3, permissions: ['write'] });
    const results = await Promise.all(Array.from({ length: 10 }, () => h.s.caTokens.validate({ tenantId: h.tenantId, userId: null, actor: { service: 'test' } }, u.body.token, { permission: 'write' })));
    expect(results.filter((r) => r.active)).toHaveLength(3);
    expect(results.filter((r) => !r.active).every((r) => r.reason === 'spent')).toBe(true);
    const row = (await h.s.db('pki_tokens').where({ id: u.body.id }).first()) as { uses_left: number; state: string };
    expect(Number(row.uses_left)).toBe(0);
    expect(row.state).toBe('spent');
    const used = (await h.s.db('audit_events').where({ action: 'pki.token.used' })) as unknown[];
    expect(used).toHaveLength(3);
  });

  it('refresh replaces the token; introspect describes it; revoke and bulk revoke end tokens', async () => {
    const r = await ta.post('/api/pki/tokens/refresh', { token: first.token });
    expect(r.status).toBe(201);
    expect(r.body.refreshedFrom).toBe(first.id);
    expect((await ta.post('/api/pki/tokens/validate', { token: first.token })).body).toMatchObject({ active: false, reason: 'replaced' });
    const i = await ta.post('/api/pki/tokens/introspect', { token: r.body.token });
    expect(i.body).toMatchObject({ active: true, jti: r.body.id, sub: memberId, token_type: 'ca-token', resource: { type: 'url', id: 'https://files.example.test/docs/' } });
    expect((await ta.post('/api/pki/tokens/refresh', { token: first.token })).status).toBe(409);
    first = { id: r.body.id, token: r.body.token, signerId: r.body.signerId };

    const one = await ta.post('/api/pki/tokens', { resource: { type: 'url', id: 'https://api.example.test/v1' }, permissions: ['read'] });
    expect((await ta.post(`/api/pki/tokens/${one.body.id}/revoke`, { reason: 'leaked' })).body).toMatchObject({ state: 'revoked', revokedReason: 'leaked' });
    expect((await ta.post('/api/pki/tokens/validate', { token: one.body.token })).body).toMatchObject({ active: false, reason: 'leaked' });
    expect((await ta.post(`/api/pki/tokens/${one.body.id}/revoke`, {})).status).toBe(409);

    const a = await ta.post('/api/pki/tokens', { resource: { type: 'url', id: 'https://api.example.test/v2/' }, permissions: ['read'], subject: memberId });
    const b = await ta.post('/api/pki/tokens', { resource: { type: 'url', id: 'https://api.example.test/v2/items' }, permissions: ['read'] });
    expect((await ta.post('/api/pki/tokens/revoke', {})).status).toBe(422);
    const byRes = await ta.post('/api/pki/tokens/revoke', { resource: { type: 'url', id: 'https://api.example.test/v2/' }, reason: 'v2 retired' });
    expect(byRes.body.revoked).toBe(2);
    for (const t of [a, b]) expect((await ta.post('/api/pki/tokens/validate', { token: t.body.token })).body.active).toBe(false);
    const bySubject = await ta.post('/api/pki/tokens/revoke', { subject: memberId });
    expect(bySubject.body.revoked).toBe(1); // the refreshed docs token
    expect((await ta.post('/api/pki/tokens/validate', { token: first.token })).body.active).toBe(false);
    expect(((await h.s.db('audit_events').where({ action: 'pki.token.revoked.bulk' })) as unknown[]).length).toBe(2);
  });

  it('one-time tickets are good for a single action', async () => {
    const t = await ta.post('/api/pki/tickets', { resource: { type: 'url', id: 'https://files.example.test/report.pdf' }, permissions: ['read'], action: 'files.download', ttlMinutes: 10 });
    expect(t.status).toBe(201);
    expect(part(t.body.token, 1)).toMatchObject({ kind: 'ticket', act: 'files.download', uses: 1 });
    expect((await ta.post('/api/pki/tickets', { resource: { type: 'url', id: 'https://files.example.test/x' }, permissions: ['read'], action: 'files.download', ttlMinutes: 5000 })).status).toBe(400);
    expect((await ta.post('/api/pki/tokens/validate', { token: t.body.token, action: 'files.delete' })).body).toMatchObject({ active: false, reason: 'action' });
    expect((await ta.post('/api/pki/tokens/validate', { token: t.body.token })).body).toMatchObject({ active: false, reason: 'action' });
    // spend: false does not keep a ticket alive.
    expect((await ta.post('/api/pki/tokens/validate', { token: t.body.token, action: 'files.download', spend: false })).body).toMatchObject({ active: true, usesLeft: 0 });
    expect((await ta.post('/api/pki/tokens/validate', { token: t.body.token, action: 'files.download' })).body).toMatchObject({ active: false, reason: 'spent' });
    expect((await ta.post('/api/pki/tokens/refresh', { token: t.body.token })).status).toBe(409);
    expect(((await h.s.db('audit_events').where({ action: 'pki.token.ticket.redeemed' })) as unknown[]).length).toBe(1);
  });

  it('revoking the signing certificate revokes its tokens; scheduled rotation keeps old tokens valid', async () => {
    const live = await ta.post('/api/pki/tokens', { resource: { type: 'did', id: 'did:plc:live' }, permissions: ['read'], expiry: { kind: 'persistent' } });
    expect((await ta.post('/api/pki/tokens/validate', { token: live.body.token })).body.active).toBe(true);
    // Rotation on the schedule: the signer is older than tokens.rotationDays.
    const before = (await h.s.db('pki_token_signers').where({ state: 'active' }).first()) as { id: string; certificate_id: string };
    await h.s.db('pki_token_signers').where({ id: before.id }).update({ created_at: Date.now() - 31 * 86_400_000 });
    expect(await h.s.caTokens.rotateDue()).toEqual({ rotated: 1 });
    const after = (await h.s.db('pki_token_signers').where({ state: 'active' }).first()) as { id: string };
    expect(after.id).not.toBe(before.id);
    expect((await ta.post('/api/pki/tokens/validate', { token: live.body.token })).body.active).toBe(true);
    const next = await ta.post('/api/pki/tokens', { resource: { type: 'did', id: 'did:plc:next' }, permissions: ['read'] });
    expect(next.body.signerId).toBe(after.id);
    // Revoke the old signer's certificate on the Certificates screen: every token it signed ends.
    const rv = await ta.post(`/api/pki/certificates/${before.certificate_id}/revoke`, { reason: 'keyCompromise' });
    expect(rv.status).toBe(200);
    expect((await ta.post('/api/pki/tokens/validate', { token: live.body.token })).body).toMatchObject({ active: false, reason: 'signer-revoked' });
    expect((await ta.post('/api/pki/tokens/validate', { token: next.body.token })).body.active).toBe(true);
    const left = (await h.s.db('pki_tokens').where({ signer_id: before.id, state: 'active' })) as unknown[];
    expect(left).toHaveLength(0);
    // The revoked signer is no longer published.
    const keys = await request(h.app).get(`/pki/tokens/${slug}/keys`);
    expect(keys.body.keys.map((k: { kid: string }) => k.kid)).not.toContain(before.id);
  });

  it('the signature and size follow the settings: RSA-PSS and a maximum size', async () => {
    expect((await ta.put('/api/pki/settings', { scope: 'tenant', values: { 'tokens.signature': 'rsa-pss' } })).status).toBe(200);
    const t = await ta.post('/api/pki/tokens', { resource: { type: 'url', id: 'https://files.example.test/pss' }, permissions: ['read'] });
    expect(t.status).toBe(201);
    expect(part(t.body.token, 0).alg).toBe('PS256');
    const sg = (await h.s.db('pki_token_signers').where({ id: t.body.signerId }).first()) as { public_key_pem: string; key_type: string };
    expect(sg.key_type).toBe('rsa-3072');
    const [hh, pp, ss] = (t.body.token as string).split('.');
    expect(verify('sha256', Buffer.from(`${hh}.${pp}`), { key: createPublicKey(sg.public_key_pem), padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.from(ss!, 'base64url'))).toBe(true);
    expect((await ta.post('/api/pki/tokens/validate', { token: t.body.token })).body.active).toBe(true);
    expect((await ta.put('/api/pki/settings', { scope: 'tenant', values: { 'tokens.maxBytes': 512 } })).status).toBe(200);
    const big = await ta.post('/api/pki/tokens', { resource: { type: 'url', id: `https://files.example.test/${'a'.repeat(400)}` }, permissions: ['read'] });
    expect(big.status).toBe(422);
    expect(big.body.step).toBe('size');
    expect((await ta.put('/api/pki/settings', { scope: 'tenant', values: { 'tokens.maxBytes': 400 } })).status).toBe(422);
    // Defaults: a token with no expiry given takes the tenant's default kind and lifetime.
    expect((await ta.put('/api/pki/settings', { scope: 'tenant', values: { 'tokens.maxBytes': 4096, 'tokens.defaultExpiry': 'uses', 'tokens.defaultUses': 2 } })).status).toBe(200);
    const d = await ta.post('/api/pki/tokens', { resource: { type: 'url', id: 'https://files.example.test/d' }, permissions: ['read'] });
    expect(d.body).toMatchObject({ expiry: 'uses', maxUses: 2, usesLeft: 2 });
  });
});
