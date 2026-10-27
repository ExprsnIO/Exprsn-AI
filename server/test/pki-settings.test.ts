/*
 * 1.9.0, Sprint 55 (B-187, B-195): the certificate authority's settings. Effective values with their source (tenant,
 * platform, environment, default), ranges and floors refused, dual control for the root and intermediates, the new
 * values taken by the next CRL, OCSP answer, ACME directory and public route, and no silent re-key: an approved
 * change waits for the next rotation or re-issue. Without migration 127 the environment values apply and saving
 * answers 409. The signer is an in-process `exprsn-ai signer` on a temporary socket (pki-sprint55-helpers.ts).
 */
import { verify, X509Certificate } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pkiSettingsCommand } from '../src/cli/pki-settings.js';
import { children, parse, readBits } from '../src/pki/asn1.js';
import { isPrivateName } from '../src/pki/acme.js';
import { harness, type Harness } from './helpers.js';
import { admin, binary, csrPem, migrate55, unmigrate55, ocspPost, ocspRequest, signerFixture, type AdminClient } from './pki-sprint55-helpers.js';

const HOUR = 3_600_000;
const time = (b: Buffer) => {
  const t = b.toString('ascii');
  return Date.UTC(Number(t.slice(0, 4)), Number(t.slice(4, 6)) - 1, Number(t.slice(6, 8)), Number(t.slice(8, 10)), Number(t.slice(10, 12)), Number(t.slice(12, 14)));
};

/** Status, the first answer's thisUpdate and nextUpdate, how many certificates came along, and the signed bytes. */
function readOcsp(der: Buffer) {
  const top = children(parse(der));
  const status = top[0]!.value[0]!;
  if (status !== 0) return { status };
  const basic = children(parse(children(children(top[1]!)[0]!)[1]!.value));
  const tbs = basic[0]!;
  const rd = children(tbs);
  const single = children(children(rd[2]!)[0]!);
  const thisUpdate = time(single[2]!.value);
  const nextUpdate = time(children(single[3]!)[0]!.value);
  const certs = basic[3] ? children(children(basic[3])[0]!).map((c) => new X509Certificate(c.raw)) : [];
  return { status, thisUpdate, nextUpdate, certs, tbs: tbs.raw, signature: readBits(basic[2]) };
}

describe('B-187: certificate authority settings', () => {
  let f: Awaited<ReturnType<typeof signerFixture>>;
  let h: Harness;
  let sys: AdminClient;
  let sys2: AdminClient;
  let ta: AdminClient;
  let root: { id: string; certificatePem: string };
  let inter: { id: string; certificatePem: string };
  let profileId: string;
  let leaf: { serial: string };

  const setting = (body: { platform: { key: string }[]; tenant: { key: string }[] }, scope: 'platform' | 'tenant', key: string) => (body[scope] as { key: string; value: unknown; source: string; floor: unknown; dual: boolean }[]).find((x) => x.key === key)!;

  beforeAll(async () => {
    f = await signerFixture();
    h = await harness({ DATA_KEY: '', SIGNER_SOCKET: f.socketPath, SIGNER_TOKEN: f.token, PKI_PUBLIC_URL: 'http://ca.example.test', PKI_OCSP_VALIDITY_MINUTES: '30' });
    sys = await admin(h, 'root1', ['system-admin']);
    sys2 = await admin(h, 'root2', ['system-admin']);
    ta = await admin(h, 'ta', ['tenant-admin']);
  }, 120_000);
  afterAll(async () => {
    await h.close();
    await f.close();
  });

  it('without migration 127 the environment values apply, with their source, and saving answers 409', async () => {
    await unmigrate55(h);
    const g = await ta.get('/api/pki/settings');
    expect(g.status).toBe(200);
    expect(g.body.configured).toBe(false);
    expect(setting(g.body, 'tenant', 'ocsp.validityMinutes')).toMatchObject({ value: 30, source: 'environment' });
    expect(setting(g.body, 'tenant', 'crl.validityHours')).toMatchObject({ value: 24, source: 'default' });
    const put = await ta.put('/api/pki/settings', { scope: 'tenant', values: { 'crl.validityHours': 12 } });
    expect(put.status).toBe(409);
    expect(put.body.step).toBe('settings-table');
    expect(await h.s.pki.settings(h.tenantId)).toMatchObject({ 'ocsp.validityMinutes': 30, 'root.keyType': 'ecdsa-p256', publicUrl: 'http://ca.example.test' });
  });

  it('a root and an intermediate exist before any setting changes (made from the settings in force)', async () => {
    await migrate55(h, { settings: true, tokens: false });
    const r = await sys.post('/api/pki/issuers', { kind: 'root', commonName: 'Sprint 55 Root' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ keyType: 'ecdsa-p256', pathLen: null });
    root = r.body;
    const i = await ta.post('/api/pki/issuers', { kind: 'intermediate' });
    expect(i.status).toBe(201);
    expect(i.body).toMatchObject({ keyType: 'ecdsa-p256', pathLen: 0 });
    inter = i.body;
    const p = await ta.post('/api/pki/profiles', { name: 'web', kind: 'server', maxDays: 90, defaultDays: 30, policy: { domains: ['*.example.test'], keyTypes: ['ec-p256'] } });
    profileId = p.body.id;
    const c = await ta.post(`/api/pki/issuers/${inter.id}/issue`, { csr: csrPem(['a.example.test']), profileId });
    expect(c.status).toBe(201);
    leaf = c.body;
  });

  it('effective values carry their source, floor and range; scopes are enforced', async () => {
    const g = await sys.get('/api/pki/settings');
    expect(g.body.configured).toBe(true);
    expect(g.body.canPlatform).toBe(true);
    const ov = setting(g.body, 'platform', 'ocsp.validityMinutes');
    expect(ov).toMatchObject({ value: 30, source: 'environment', floor: { value: 30, source: 'environment' } });
    expect(setting(g.body, 'platform', 'root.keyType')).toMatchObject({ value: 'ecdsa-p256', source: 'default', dual: true });
    expect(setting(g.body, 'platform', 'publicUrl')).toMatchObject({ value: 'http://ca.example.test', source: 'environment' });
    expect(g.body.tenant.some((x: { key: string }) => x.key === 'root.keyType')).toBe(false);
    expect(g.body.issuers.root).toMatchObject({ id: root.id, keyType: 'ecdsa-p256' });
    // A tenant admin cannot touch the platform scope.
    expect((await ta.put('/api/pki/settings', { scope: 'platform', values: { 'crl.validityHours': 12 } })).status).toBe(403);
  });

  it('values out of range, weaker than the environment, or in the wrong scope are refused (422)', async () => {
    const bad = async (scope: 'platform' | 'tenant', values: object, who = sys) => {
      const r = await who.put('/api/pki/settings', { scope, values });
      expect(r.status, JSON.stringify(values)).toBe(422);
      return r.body;
    };
    expect((await bad('platform', { 'ocsp.validityMinutes': 0 })).key).toBe('ocsp.validityMinutes');
    expect((await bad('platform', { 'root.keyType': 'rsa-1024' })).key).toBe('root.keyType');
    expect((await bad('platform', { 'crl.intervalMinutes': 99_999 })).key).toBe('crl.intervalMinutes');
    expect((await bad('platform', { 'root.subject': { C: 'USA' } })).key).toBe('root.subject');
    expect((await bad('platform', { 'not.a.setting': 1 })).key).toBe('not.a.setting');
    // The environment's 30 minutes is a floor: shorter is fine, longer is weaker.
    expect((await bad('platform', { 'ocsp.validityMinutes': 45 })).detail).toMatch(/never weaker/);
    // A platform-only setting cannot be overridden by a tenant, and the other way round.
    expect((await bad('tenant', { 'ocsp.delegated': false }, ta)).key).toBe('ocsp.delegated');
    expect((await bad('platform', { 'members.enabled': true })).key).toBe('members.enabled');
    // Rules between settings: the CRL validity must outlast the interval.
    expect((await bad('tenant', { 'crl.validityHours': 1 }, ta)).key).toBe('crl.validityHours');
    // Nothing above was saved.
    const audit = (await h.s.db('audit_events').where({ action: 'pki.settings.updated' })) as unknown[];
    expect(audit).toHaveLength(0);

    const ok = await sys.put('/api/pki/settings', { scope: 'platform', values: { 'ocsp.validityMinutes': 20 } });
    expect(ok.status).toBe(200);
    expect(ok.body.applied).toEqual(['ocsp.validityMinutes']);
    // For a tenant the platform's value is now the floor.
    expect((await bad('tenant', { 'ocsp.validityMinutes': 25 }, ta)).detail).toMatch(/platform/);
    const t = await ta.put('/api/pki/settings', { scope: 'tenant', values: { 'ocsp.validityMinutes': 10, 'leaf.subject': { O: 'Example Ltd', C: 'gb' } } });
    expect(t.status).toBe(200);
    expect(setting(t.body.settings, 'tenant', 'ocsp.validityMinutes')).toMatchObject({ value: 10, source: 'tenant', floor: { value: 20, source: 'platform' } });
    expect(setting(t.body.settings, 'tenant', 'leaf.subject')).toMatchObject({ value: { O: 'Example Ltd', C: 'GB' }, source: 'tenant' });
    const ev = (await h.s.db('audit_events').where({ action: 'pki.settings.updated' })) as { detail: string }[];
    expect(ev).toHaveLength(2);
  });

  it('dual control: root and intermediate changes wait for a second platform admin, never the proposer', async () => {
    const before = (await h.s.db('pki_issuers').orderBy('created_at')) as Record<string, unknown>[];
    const r = await sys.put('/api/pki/settings', { scope: 'platform', values: { 'root.keyType': 'ecdsa-p384', 'root.pathLen': 2, 'intermediate.keyType': 'rsa-2048', 'intermediate.pathLen': 1, 'intermediate.subject': { C: 'US', O: 'Exprsn', OU: 'PKI' }, 'crl.validityHours': 48 }, reason: 'stronger root' });
    expect(r.status).toBe(200);
    // The CRL setting applies at once; the tier settings become one proposal.
    expect(r.body.applied).toEqual(['crl.validityHours']);
    expect(r.body.proposal).toMatchObject({ state: 'pending', changes: { 'root.keyType': 'ecdsa-p384', 'intermediate.keyType': 'rsa-2048' } });
    const id = r.body.proposal.id;
    expect((await h.s.pki.settings(null))['root.keyType']).toBe('ecdsa-p256');
    // Tenant admins do not see or decide platform proposals.
    expect((await ta.get('/api/pki/settings')).body.proposals).toEqual([]);
    expect((await ta.post(`/api/pki/settings/proposals/${id}/approve`, {})).status).toBe(403);
    const own = await sys.post(`/api/pki/settings/proposals/${id}/approve`, {});
    expect(own.status).toBe(403);
    expect(own.body.step).toBe('dual-control');
    const list = await sys2.get('/api/pki/settings');
    expect(list.body.proposals.map((p: { id: string }) => p.id)).toContain(id);
    const ok = await sys2.post(`/api/pki/settings/proposals/${id}/approve`, { note: 'agreed' });
    expect(ok.status).toBe(200);
    expect(ok.body.state).toBe('applied');
    expect((await sys2.post(`/api/pki/settings/proposals/${id}/approve`, {})).status).toBe(409);
    const v = await h.s.pki.settings(null);
    expect(v).toMatchObject({ 'root.keyType': 'ecdsa-p384', 'root.pathLen': 2, 'intermediate.keyType': 'rsa-2048', 'intermediate.pathLen': 1 });
    const actions = ((await h.s.db('audit_events').whereIn('action', ['pki.settings.proposed', 'pki.settings.approved'])) as { action: string }[]).map((e) => e.action).sort();
    expect(actions).toEqual(['pki.settings.approved', 'pki.settings.proposed']);
    // A rejected proposal changes nothing; its proposer withdraws instead of rejecting.
    const p2 = (await sys.put('/api/pki/settings', { scope: 'platform', values: { 'root.days': 5000 } })).body.proposal;
    expect((await sys.post(`/api/pki/settings/proposals/${p2.id}/reject`, {})).body.state).toBe('withdrawn');
    expect((await h.s.pki.settings(null))['root.days']).toBe(3650);

    // No silent re-key: approving changed no issuer, key or certificate.
    const after = (await h.s.db('pki_issuers').orderBy('created_at')) as Record<string, unknown>[];
    expect(after).toEqual(before);
  });

  it('the approved values apply at the next rotation and re-issue only', async () => {
    const signs = f.signer.served.keygen ?? 0;
    // Re-issue: the same key, the new path length; the subject and algorithm stay.
    const ri = await sys.post(`/api/pki/issuers/${root.id}/reissue`, {});
    expect(ri.status).toBe(200);
    expect(ri.body).toMatchObject({ id: root.id, keyType: 'ecdsa-p256', pathLen: 2 });
    expect(new X509Certificate(ri.body.certificatePem).publicKey.export({ format: 'der', type: 'spki' })).toEqual(new X509Certificate(root.certificatePem).publicKey.export({ format: 'der', type: 'spki' }));
    expect(f.signer.served.keygen ?? 0).toBe(signs);
    // Rotation: a new key of the new algorithm.
    const rr = await sys.post(`/api/pki/issuers/${root.id}/rotate`, {});
    expect(rr.status).toBe(201);
    expect(rr.body).toMatchObject({ keyType: 'ecdsa-p384', pathLen: 2, generation: 2 });
    const rc = new X509Certificate(rr.body.certificatePem);
    expect(rc.publicKey.asymmetricKeyDetails?.namedCurve).toBe('secp384r1');
    expect(rc.verify(rc.publicKey)).toBe(true);
    const ir = await ta.post(`/api/pki/issuers/${inter.id}/rotate`, {});
    expect(ir.status).toBe(201);
    expect(ir.body).toMatchObject({ keyType: 'rsa-2048', pathLen: 1, parentId: rr.body.id });
    const ic = new X509Certificate(ir.body.certificatePem);
    expect(ic.verify(rc.publicKey)).toBe(true);
    expect(ic.subject).toMatch(/C=US/);
    expect(ic.subject).toMatch(/OU=PKI/);
    expect(ic.subject).toMatch(/O=Exprsn/);
    expect(ic.publicKey.asymmetricKeyDetails?.modulusLength).toBe(2048);
    inter = ir.body;
    // A certificate from the new intermediate carries the tenant's subject attributes.
    const c = await ta.post(`/api/pki/issuers/${inter.id}/issue`, { csr: csrPem(['b.example.test']), profileId });
    expect(c.status).toBe(201);
    const lc = new X509Certificate(c.body.certificatePem);
    expect(lc.subject).toMatch(/O=Example Ltd/);
    expect(lc.subject).toMatch(/C=GB/);
    expect(lc.verify(ic.publicKey)).toBe(true);
    leaf = c.body;
  });

  it('the next CRL takes the new validity and next update', async () => {
    let crl = (await h.s.pki.generateCrl(inter.id))!;
    // crl.validityHours 48 on the platform, no next-update days: nextUpdate is 48 hours on.
    expect(crl.next_update - crl.this_update).toBe(48 * HOUR);
    expect((await ta.put('/api/pki/settings', { scope: 'tenant', values: { 'crl.validityHours': 12, 'crl.nextUpdateDays': 2 } })).status).toBe(200);
    crl = (await h.s.pki.generateCrl(inter.id))!;
    expect(crl.next_update - crl.this_update).toBe(2 * 24 * HOUR);
    // The served CRL is renewed once it is older than the validity, even before its next update.
    await h.s.db('pki_crls').where({ id: crl.id }).update({ this_update: Date.now() - 13 * HOUR });
    const served = await h.s.pki.currentCrl(inter.id);
    expect(served!.number).toBe(crl.number + 1);
  });

  it('the next OCSP answer takes the new validity, batching and responder choice', async () => {
    let r = await ocspPost(h, ocspRequest(inter.certificatePem, [leaf.serial]));
    let o = readOcsp(r.body as Buffer);
    expect(o.status).toBe(0);
    // The tenant's 10 minutes, below the platform's 20 and the environment's 30.
    expect(o.nextUpdate! - o.thisUpdate!).toBe(10 * 60_000);
    expect(o.certs).toHaveLength(2); // the delegated responder and the intermediate
    // Batch requests off: two certificates in one request are refused.
    expect((await sys.put('/api/pki/settings', { scope: 'platform', values: { 'ocsp.batch': false } })).status).toBe(200);
    r = await ocspPost(h, ocspRequest(inter.certificatePem, [leaf.serial, leaf.serial.replace(/.$/, '0')]));
    expect(readOcsp(r.body as Buffer).status).toBe(1);
    // No delegated responder: the intermediate's own key signs, and no certificate comes along.
    expect((await sys.put('/api/pki/settings', { scope: 'platform', values: { 'ocsp.delegated': false, 'ocsp.batch': true } })).status).toBe(200);
    r = await ocspPost(h, ocspRequest(inter.certificatePem, [leaf.serial]));
    o = readOcsp(r.body as Buffer);
    expect(o.status).toBe(0);
    expect(o.certs).toHaveLength(0);
    expect(verify('sha256', o.tbs!, new X509Certificate(inter.certificatePem).publicKey, o.signature!)).toBe(true);
  });

  it('ACME takes the terms of service and private-name rule; the public URL and rate apply at once', async () => {
    const sp = await ta.post('/api/pki/profiles', { name: 'acme', kind: 'server', maxDays: 90, defaultDays: 60, policy: { domains: ['*.example.test'] } });
    expect((await ta.put('/api/pki/acme', { enabled: true, profileId: sp.body.id })).status).toBe(200);
    const slug = (await h.s.tenants.byId(h.tenantId))!.slug;
    let d = await request(h.app).get(`/pki/acme/${slug}/directory`);
    expect(d.status).toBe(200);
    expect(d.body.meta.termsOfService).toBeUndefined();
    expect((await ta.put('/api/pki/settings', { scope: 'tenant', values: { 'acme.termsUrl': 'https://example.test/terms', 'acme.certDays': 30, 'acme.privateIdentifiers': false } })).status).toBe(200);
    d = await request(h.app).get(`/pki/acme/${slug}/directory`);
    expect(d.body.meta.termsOfService).toBe('https://example.test/terms');
    expect(isPrivateName('printer.local')).toBe(true);
    expect(isPrivateName('host.internal')).toBe(true);
    expect(isPrivateName('www.example.com')).toBe(false);
    // The issuing intermediate must be the tenant's own.
    expect((await ta.put('/api/pki/settings', { scope: 'tenant', values: { 'acme.issuerId': root.id } })).status).toBe(422);

    expect((await sys.put('/api/pki/settings', { scope: 'platform', values: { publicUrl: 'https://pki.example.test' } })).status).toBe(200);
    expect(h.s.pki.crlUrl(inter.id)).toBe(`https://pki.example.test/pki/crl/${inter.id}.crl`);
    const c = await ta.post(`/api/pki/issuers/${inter.id}/issue`, { csr: csrPem(['c.example.test']), profileId });
    expect(new X509Certificate(c.body.certificatePem).infoAccess).toContain('https://pki.example.test/pki/ocsp');

    expect((await sys.put('/api/pki/settings', { scope: 'platform', values: { ratePerMinute: 3 } })).status).toBe(200);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await binary(request(h.app).get(`/pki/ca/${inter.id}.crt`))).status);
    expect(codes).toContain(429);
    expect((await sys.put('/api/pki/settings', { scope: 'platform', reset: ['ratePerMinute'] })).status).toBe(200);
  });

  it('pki:settings shows the effective values and saves through the same checks', async () => {
    let text = '';
    const out = (t: string) => void (text += t);
    expect(await pkiSettingsCommand(h.s, ['show', '--tenant', (await h.s.tenants.byId(h.tenantId))!.slug], out)).toBe(0);
    expect(text).toMatch(/ocsp\.validityMinutes\s+10\s+tenant/);
    text = '';
    expect(await pkiSettingsCommand(h.s, ['set', 'ocsp.cacheSeconds=999999', '--platform'], out)).toBe(1);
    expect(text).toMatch(/error: /);
    text = '';
    expect(await pkiSettingsCommand(h.s, ['set', 'intermediate.days=1000', '--platform'], out)).toBe(0);
    expect(text).toMatch(/Proposed/);
    text = '';
    expect(await pkiSettingsCommand(h.s, ['proposals'], out)).toBe(0);
    expect(text).toMatch(/intermediate\.days=1000/);
    // The operator cannot approve: a platform admin in the console does.
    const pending = (await sys.get('/api/pki/settings')).body.proposals as { id: string; proposedBy: string | null }[];
    const p = pending.find((x) => x.proposedBy === null)!;
    expect((await sys.post(`/api/pki/settings/proposals/${p.id}/approve`, {})).status).toBe(200);
    expect((await h.s.pki.settings(null))['intermediate.days']).toBe(1000);
  });
});
