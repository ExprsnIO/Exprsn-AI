import { createHmac, createSign, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import request from 'supertest';
import { ulid } from 'ulid';
import { buildCertificate, distinguishedName, KU, newSerial, spkiOf } from '../src/pki/x509.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

/* 1.6.0, Sprint 39d: fixtures shared by the entity API, schema API and embed tests. */

export async function setupApp() {
  const h = await harness();
  const wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Sales', 'confidential')).id;
  const wrap = async (c: { agent: Client['agent']; csrf: string }) => {
    const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
    await send('put', '/api/me/workspace', { workspaceId: wsId }).expect(200);
    return { ...c, post: (p: string, b?: object) => send('post', p, b), put: (p: string, b?: object) => send('put', p, b), patch: (p: string, b?: object) => send('patch', p, b), del: (p: string) => send('delete', p), get: (p: string) => c.agent.get(p) };
  };
  const member = async (name: string, attributes: Record<string, string> | null = null, email: string | null = null) => {
    const u = await localUser(h, name, ['member'], 'confidential');
    await h.s.tenants.addMember(wsId, u.id);
    if (attributes) await h.s.users.update(h.tenantId, u.id, { attributes: JSON.stringify(attributes) });
    if (email) await h.s.users.update(h.tenantId, u.id, { email });
    return { user: u, ...(await wrap(await login(h, name))) };
  };
  const designer = async (name = 'dee') => {
    const u = await localUser(h, name, ['workflow-admin', 'member'], 'confidential');
    await h.s.tenants.addMember(wsId, u.id);
    return { user: u, ...(await wrap(await loginAdmin(h, name))) };
  };
  const dee = await designer();
  await dee.post('/api/apps', { name: 'crm', title: 'CRM', label: 'confidential', workspaceId: wsId }).expect(201);
  await dee.post('/api/apps/crm/entities', { name: 'company', title: 'Company', label: 'internal', definition: { fields: [{ name: 'name', type: 'string', required: true, indexed: true, unique: true, maxLength: 120 }] } }).expect(201);
  await dee
    .post('/api/apps/crm/entities', {
      name: 'deal',
      title: 'Deal',
      label: 'internal',
      definition: {
        fields: [
          { name: 'title', type: 'string', required: true, indexed: true, unique: true, maxLength: 120 },
          { name: 'amount', type: 'number', indexed: true, min: 0 },
          { name: 'region', type: 'string', indexed: true, maxLength: 20 },
          { name: 'ssn', type: 'string', maxLength: 20 },
          { name: 'company', type: 'reference', entity: 'company' },
          { name: 'notes', type: 'string', multiline: true, maxLength: 500 }
        ],
        states: { initial: 'open', states: [{ name: 'open' }, { name: 'won' }, { name: 'lost' }], transitions: [{ from: ['open'], to: 'won' }, { from: ['open'], to: 'lost' }] }
      }
    })
    .expect(201);
  const contoso = (await dee.post('/api/apps/crm/entities/company/records', { values: { name: 'Contoso Ltd' } }).expect(201)).body as { id: string };
  const rec = async (values: Record<string, unknown>) => (await dee.post('/api/apps/crm/entities/deal/records', { values }).expect(201)).body as { id: string; version: number };
  const emea1 = await rec({ title: 'Contoso', amount: 100, region: 'emea', ssn: '123-45-6789', company: contoso.id, notes: 'first' });
  const emea2 = await rec({ title: 'Fabrikam', amount: 250, region: 'emea', ssn: '987-65-4321' });
  const apac = await rec({ title: 'Tailspin', amount: 400, region: 'apac', ssn: '555-66-7777' });
  const bearer = (token: string) => ({
    get: (p: string) => request(h.app).get(p).set('authorization', `Bearer ${token}`),
    post: (p: string, b: object = {}) => request(h.app).post(p).set('authorization', `Bearer ${token}`).send(b),
    patch: (p: string, b: object = {}) => request(h.app).patch(p).set('authorization', `Bearer ${token}`).send(b),
    del: (p: string) => request(h.app).delete(p).set('authorization', `Bearer ${token}`)
  });
  return { h, wsId, dee, member, designer, contoso, emea1, emea2, apac, bearer };
}
export type AppFixture = Awaited<ReturnType<typeof setupApp>>;
export type { Harness };

export const titles = (body: { records: { values: { title: string } }[] }) => body.records.map((r) => r.values.title).sort();

// ---------- tokens the host site would sign ----------

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

export function jwt(header: Record<string, unknown>, claims: Record<string, unknown>, signer: (data: Buffer) => Buffer): string {
  const head = `${b64({ typ: 'JWT', ...header })}.${b64(claims)}`;
  return `${head}.${signer(Buffer.from(head)).toString('base64url')}`;
}

export const es256 = (key: KeyObject) => (data: Buffer) => createSign('SHA256').update(data).sign({ key, dsaEncoding: 'ieee-p1363' });
export const rs256 = (key: KeyObject) => (data: Buffer) => createSign('SHA256').update(data).sign(key);
export const eddsa = (key: KeyObject) => (data: Buffer) => cryptoSign(null, data, key);
export const hs256 = (secret: string) => (data: Buffer) => createHmac('sha256', Buffer.from(secret, 'base64url')).update(data).digest();

export const pem = (key: KeyObject) => key.export({ type: 'spki', format: 'pem' }).toString();
export const ecPair = () => generateKeyPairSync('ec', { namedCurve: 'P-256' });
export const edPair = () => generateKeyPairSync('ed25519');

/** Claims for an app: the audience, a minute of life, a fresh jti. */
export const claimsFor = (audience: string, sub: string, extra: Record<string, unknown> = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return { iss: 'https://host.example.com', aud: audience, sub, iat: now, exp: now + 60, jti: ulid(), ...extra };
};

// ---------- a tenant CA without the signer: an intermediate row with a self-signed certificate ----------

/** Makes a CA certificate and a leaf it issued (EC P-256), and registers the CA as the tenant's active intermediate. */
export async function testCa(h: Harness, tenantId: string) {
  const ca = ecPair();
  const caName = distinguishedName('Test Tenant CA', 'Exprsn');
  const caSpki = spkiOf(ca.publicKey);
  const sign = (key: KeyObject) => async (tbs: Buffer) => createSign('SHA256').update(tbs).sign({ key, dsaEncoding: 'der' });
  const now = Date.now();
  const caDer = await buildCertificate({ serial: newSerial(), issuerName: caName, subjectName: caName, spki: caSpki, issuerSpki: caSpki, notBefore: now - 60_000, notAfter: now + 86_400_000, keyType: 'ecdsa-p256', ca: { pathLen: 0 }, keyUsage: KU.keyCertSign | KU.cRLSign | KU.digitalSignature }, sign(ca.privateKey));
  const toPem = (der: Buffer, label: string) => `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----\n`;
  const caPem = toPem(caDer, 'CERTIFICATE');
  await h.s.db('pki_issuers').insert({ id: ulid(), tenant_id: tenantId, parent_id: null, kind: 'intermediate', name: 'Test Tenant CA', organization: 'Exprsn', key_type: 'ecdsa-p256', custody: 'signer', key_name: 'test-ca', key_wrapped: null, public_key_pem: pem(ca.publicKey), subject_der: caName.toString('base64'), serial: 'ab', certificate_pem: caPem, generation: 1, path_len: 0, not_before: now - 60_000, not_after: now + 86_400_000, state: 'active', revoked_at: null, revocation_reason: null, crl_number: 0, replaced_by: null, created_by: null, created_at: now, updated_at: now });
  const issue = async (name: string, signer: KeyObject = ca.privateKey, issuerSpki: Buffer = caSpki, issuerName: Buffer = caName) => {
    const leaf = ecPair();
    const der = await buildCertificate({ serial: newSerial(), issuerName, subjectName: distinguishedName(name), spki: spkiOf(leaf.publicKey), issuerSpki, notBefore: now - 60_000, notAfter: now + 3_600_000, keyType: 'ecdsa-p256', keyUsage: KU.digitalSignature }, sign(signer));
    return { key: leaf.privateKey, x5c: der.toString('base64') };
  };
  return { ca, caPem, issue };
}
