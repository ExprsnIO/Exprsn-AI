/*
 * 1.9.0, Sprint 55 (B-189): member certificates. Off by default; once a tenant turns them on, a member gets a client
 * certificate (and a CA token) when they join, picks the key up once, has it renewed before expiry with the same key,
 * and loses it when they leave or the tenant is offboarded. Certificate sign-in and mTLS for the API read the
 * certificate a trusted proxy forwarded: the header is believed from a trusted peer address only, never from a client,
 * whatever X-Forwarded-For says.
 */
import { X509Certificate } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MEMBER_URI } from '../src/pki/members.js';
import { harness, login, type Harness } from './helpers.js';
import { admin, drain, migrate55, signerFixture, type AdminClient } from './pki-sprint55-helpers.js';

const PW = 'umbrella ferry lantern 7';
const header = (pem: string) => ({ 'x-ssl-client-cert': encodeURIComponent(pem), 'x-ssl-client-verify': 'SUCCESS' });

describe('B-189: member certificates', () => {
  let f: Awaited<ReturnType<typeof signerFixture>>;
  let h: Harness;
  let sys: AdminClient;
  let ta: AdminClient;
  let slug: string;
  let profileId: string;
  let alice: { id: string };
  let aliceCert: string;

  const newMember = async (username: string) => {
    const r = await ta.post('/api/admin/users', { username, displayName: username, email: `${username}@example.test`, password: PW, mustChange: false, roles: ['member'] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as { id: string };
  };
  const membersOf = async (userId: string) => ((await ta.get('/api/pki/members')).body.members as { userId: string; state: string; keyWaiting: boolean; hasToken: boolean; certificate: { certificatePem: string; sans: { type: string; value: string }[]; notAfter: number; serial: string } }[]).filter((m) => m.userId === userId);

  beforeAll(async () => {
    f = await signerFixture();
    // The tests' requests come from loopback: that is the trusted proxy here.
    h = await harness({ DATA_KEY: '', SIGNER_SOCKET: f.socketPath, SIGNER_TOKEN: f.token, PKI_PUBLIC_URL: 'http://ca.example.test', PKI_CLIENT_CERT_PROXIES: '127.0.0.1,::1' });
    sys = await admin(h, 'root', ['system-admin']);
    ta = await admin(h, 'ta', ['tenant-admin']);
    slug = (await h.s.tenants.byId(h.tenantId))!.slug;
    await migrate55(h);
    expect((await sys.post('/api/pki/issuers', { kind: 'root', commonName: 'Member Root' })).status).toBe(201);
    expect((await ta.post('/api/pki/issuers', { kind: 'intermediate' })).status).toBe(201);
  }, 120_000);
  afterAll(async () => {
    await h.close();
    await f.close();
  });

  it('is off by default: joining issues nothing', async () => {
    const u = await newMember('early');
    await drain(h);
    expect(await membersOf(u.id)).toEqual([]);
    expect((await h.s.pki.settings(h.tenantId))['members.enabled']).toBe(false);
  });

  it('turning it on needs an active client profile that allows the member URI', async () => {
    const wrong = await ta.post('/api/pki/profiles', { name: 'clients-narrow', kind: 'client', maxDays: 365, defaultDays: 90, policy: { uriPrefixes: ['spiffe://example.test/'] } });
    expect((await ta.put('/api/pki/settings', { scope: 'tenant', values: { 'members.enabled': true, 'members.profileId': wrong.body.id } })).status).toBe(422);
    const p = await ta.post('/api/pki/profiles', { name: 'members', kind: 'client', maxDays: 365, defaultDays: 90, policy: { uriPrefixes: [`exprsn-member://${slug}/`], emailDomains: ['example.test'] } });
    profileId = p.body.id;
    expect((await ta.put('/api/pki/settings', { scope: 'tenant', values: { 'members.signIn': true, 'members.enabled': false } })).status).toBe(422);
    const ok = await ta.put('/api/pki/settings', { scope: 'tenant', values: { 'members.enabled': true, 'members.profileId': profileId, 'members.withToken': true, 'members.signIn': true, 'members.mtls': true } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('a member who joins gets a client certificate and a CA token, picked up once', async () => {
    alice = await newMember('alice');
    await drain(h);
    const [m] = await membersOf(alice.id);
    expect(m).toMatchObject({ state: 'active', keyWaiting: true, hasToken: true });
    expect(m!.certificate.sans).toEqual([{ type: 'uri', value: MEMBER_URI(slug, alice.id) }]);
    const c = new X509Certificate(m!.certificate.certificatePem);
    expect(c.subjectAltName).toBe(`URI:${MEMBER_URI(slug, alice.id)}`);
    expect(c.keyUsage ?? []).toContain('1.3.6.1.5.5.7.3.2');
    aliceCert = m!.certificate.certificatePem;
    // The key waits sealed, never in the clear.
    const row = (await h.s.db('pki_member_certificates').where({ user_id: alice.id }).first()) as Record<string, string>;
    expect(row.key_sealed).toBeTruthy();
    expect(JSON.stringify(row)).not.toMatch(/PRIVATE KEY/);
    expect(((await h.s.db('audit_events').where({ action: 'pki.member.issued' })) as unknown[]).length).toBe(1);

    const me = await login(h, 'alice', PW);
    expect(me.res.body.stage).toBe('active');
    const list = await me.agent.get('/api/me/certificates');
    expect(list.body).toMatchObject({ enabled: true, signIn: true });
    const id = list.body.certificates[0].id;
    const pick = await me.agent.post(`/api/me/certificates/${id}/pickup`).set('x-csrf-token', me.csrf).send({ password: 'pkcs12 password' });
    expect(pick.status, JSON.stringify(pick.body)).toBe(200);
    expect(pick.body.pkcs12.length).toBeGreaterThan(500);
    expect(pick.body.token).toMatch(/^eyJ/);
    expect((await ta.post('/api/pki/tokens/validate', { token: pick.body.token, permission: 'read' })).body).toMatchObject({ active: true, token: { subject: alice.id } });
    // Once only.
    expect((await me.agent.post(`/api/me/certificates/${id}/pickup`).set('x-csrf-token', me.csrf).send({ password: 'pkcs12 password' })).status).toBe(409);
    expect(((await h.s.db('pki_member_certificates').where({ id }).first()) as { key_sealed: string | null }).key_sealed).toBeNull();
  });

  it('signs in with the certificate through a trusted proxy, and refuses the header from anyone else', async () => {
    const r = await request(h.app).post('/api/auth/certificate').set(header(aliceCert)).send({});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ authenticated: true, stage: 'active', user: { id: alice.id, username: 'alice' } });
    const cookie = (r.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    expect((await request(h.app).get('/api/me').set('cookie', cookie)).status).toBe(200);
    const ev = (await h.s.db('audit_events').where({ action: 'auth.login' }).orderBy('seq', 'desc').first()) as { target: string };
    expect(JSON.parse(ev.target)).toMatchObject({ method: 'certificate' });

    // mTLS for the API: the same certificate authenticates a call that asks for it.
    const api = await request(h.app).get('/api/me').set(header(aliceCert)).set('x-client-cert-auth', '1');
    expect(api.status, JSON.stringify(api.body)).toBe(200);
    expect(JSON.stringify(api.body)).toContain('alice');
    expect((await request(h.app).get('/api/me').set(header(aliceCert))).status).toBe(401);
    // Not verified by the proxy: refused.
    expect((await request(h.app).post('/api/auth/certificate').set({ ...header(aliceCert), 'x-ssl-client-verify': 'FAILED:unable to verify' }).send({})).status).toBe(401);

    // From an address that is not a trusted proxy, the header is never believed, whatever X-Forwarded-For says.
    const saved = h.s.cfg.PKI_CLIENT_CERT_PROXIES;
    h.s.cfg.PKI_CLIENT_CERT_PROXIES = '10.20.30.40';
    try {
      const x = await request(h.app).post('/api/auth/certificate').set(header(aliceCert)).set('x-forwarded-for', '10.20.30.40').send({});
      expect(x.status).toBe(401);
      expect(x.body.detail).toMatch(/trusted proxy/);
      expect((await request(h.app).get('/api/me').set(header(aliceCert)).set('x-client-cert-auth', '1').set('x-forwarded-for', '10.20.30.40')).status).toBe(401);
    } finally {
      h.s.cfg.PKI_CLIENT_CERT_PROXIES = saved;
    }
    // With sign-in off, the certificate signs nobody in.
    expect((await ta.put('/api/pki/settings', { scope: 'tenant', values: { 'members.signIn': false } })).status).toBe(200);
    expect((await request(h.app).post('/api/auth/certificate').set(header(aliceCert)).send({})).status).toBe(401);
    expect((await ta.put('/api/pki/settings', { scope: 'tenant', values: { 'members.signIn': true } })).status).toBe(200);
  });

  it('is renewed before expiry with the same key, and the old one stays valid', async () => {
    const [m] = await membersOf(alice.id);
    await h.s.db('pki_certificates').where({ serial: m!.certificate.serial }).update({ not_after: Date.now() + 5 * 86_400_000 });
    const out = await h.s.memberCerts.sweep();
    expect(out.renewed).toBe(1);
    const rows = await membersOf(alice.id);
    const active = rows.find((x) => x.state === 'active')!;
    expect(rows.find((x) => x.state === 'replaced')).toBeTruthy();
    expect(active.certificate.serial).not.toBe(m!.certificate.serial);
    const a = new X509Certificate(active.certificate.certificatePem);
    const b = new X509Certificate(aliceCert);
    expect(a.publicKey.export({ format: 'der', type: 'spki' })).toEqual(b.publicKey.export({ format: 'der', type: 'spki' }));
    expect(((await h.s.db('audit_events').where({ action: 'pki.member.renewed' })) as unknown[]).length).toBe(1);
    // The renewed certificate signs in too.
    expect((await request(h.app).post('/api/auth/certificate').set(header(active.certificate.certificatePem)).send({})).status).toBe(200);
    aliceCert = active.certificate.certificatePem;
  });

  it('is revoked when the member leaves, with their CA token', async () => {
    const tokenRows = (await h.s.db('pki_tokens').where({ subject: alice.id, state: 'active' })) as unknown[];
    expect(tokenRows).toHaveLength(1);
    const r = await ta.patch(`/api/admin/users/${alice.id}`, { state: 'disabled' });
    expect(r.status).toBe(200);
    await drain(h);
    const rows = await membersOf(alice.id);
    expect(rows.every((x) => x.state === 'revoked')).toBe(true);
    const certs = (await h.s.db('pki_certificates').whereIn('serial', rows.map((x) => x.certificate.serial))) as { state: string; revocation_reason: number }[];
    expect(certs.every((c) => c.state === 'revoked' && Number(c.revocation_reason) === 3)).toBe(true); // affiliationChanged
    expect((await h.s.db('pki_tokens').where({ subject: alice.id, state: 'active' })) as unknown[]).toHaveLength(0);
    expect((await request(h.app).post('/api/auth/certificate').set(header(aliceCert)).send({})).status).toBe(401);
  });

  it('a member the join missed is issued by the sweep; offboarding the tenant revokes every member certificate', async () => {
    // "early" joined while the option was off; the sweep (it ran with the renewal above) caught up.
    await h.s.memberCerts.sweep();
    const early = (await h.s.users.byUsername(h.tenantId, 'early'))!;
    expect((await membersOf(early.id))[0]).toMatchObject({ state: 'active' });
    const issued = ((await h.s.db('audit_events').where({ action: 'pki.member.issued' })) as { target: string; detail: string }[]).find((e) => JSON.parse(e.target).user === early.id)!;
    expect(JSON.parse(issued.detail).reason).toBe('sweep');
    const bob = await newMember('bob');
    await drain(h);
    expect((await membersOf(bob.id))[0]).toMatchObject({ state: 'active' });
    const live = (await h.s.db('pki_member_certificates').where({ tenant_id: h.tenantId, state: 'active' })) as { certificate_id: string }[];
    expect(live.length).toBeGreaterThanOrEqual(2);
    const root = (await h.s.users.byUsername(h.tenantId, 'root'))!;
    await h.s.offboarding.start(h.tenantId, root.id);
    const after = (await h.s.db('pki_member_certificates').where({ tenant_id: h.tenantId }).whereIn('state', ['active', 'replaced'])) as unknown[];
    expect(after).toHaveLength(0);
    const certs = (await h.s.db('pki_certificates').whereIn('id', live.map((x) => x.certificate_id))) as { state: string; revocation_reason: number }[];
    expect(certs.every((c) => c.state === 'revoked' && Number(c.revocation_reason) === 5)).toBe(true); // cessationOfOperation
    expect(((await h.s.db('audit_events').where({ action: 'pki.member.revoked' })) as unknown[]).length).toBeGreaterThanOrEqual(4);
  });
});
