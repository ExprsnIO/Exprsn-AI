import { X509Certificate } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AZURE_SCOPES } from '../src/cloud/azure-calls.js';
import type { CloudCredentials, ProviderCredential } from '../src/cloud/credentials.js';
import { AWS_AUDIENCE } from '../src/cloud/issuer.js';
import { decodeJwt, verifySignature } from '../src/federation/jose.js';
import { policySchema } from '../src/pki/service.js';
import { clock, installCloud, seedAccount, signerFixture } from './cloud-credentials-helpers.js';
import { FakeAws } from './fake-aws.js';
import { FakeAzure } from './fake-azure.js';
import { harness, localUser, loginAdmin, type Harness } from './helpers.js';

/*
 * 1.9.99-final, Sprint 56 (B-10006, and `for()` of B-10003/B-10004): vaulted cloud credentials. Values go into the
 * vault's platform scope, sealed, and no route ever answers with one; AWS keys rotate automatically (create, verify,
 * switch, delete after the overlap) and the new key is in use at once; Azure client secrets through Graph
 * addPassword/removePassword; DigitalOcean and Cloudflare tokens by a person after a notice; `for()` by mode and
 * purpose. The fakes stand in for IAM, STS, Entra and Graph; no real cloud is contacted.
 */

const AZ_TENANT = '11111111-2222-3333-4444-555555555555';
const AZ_SUB = '99999999-8888-7777-6666-555555555555';
const CF_ACCOUNT = '0123456789abcdef0123456789abcdef';
const DO_TEAM = '0f0f0f0f-0000-4000-8000-000000000001';

describe('cloud credentials (B-10006)', () => {
  let h: Harness;
  let aws: FakeAws;
  let az: FakeAzure;
  let signer: Awaited<ReturnType<typeof signerFixture>>;
  let c: CloudCredentials;
  let adminId: string;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;

  beforeAll(async () => {
    aws = await new FakeAws().start();
    az = await new FakeAzure().start();
    signer = await signerFixture();
    h = await harness({ ...signer.env, CLOUD_AWS_STS_URL: aws.url, CLOUD_AWS_IAM_URL: aws.url, CLOUD_AZURE_AUTHORITY: az.url, CLOUD_AZURE_GRAPH_URL: az.url, CLOUD_AWS_KEY_OVERLAP_MINUTES: '10' });
    c = await installCloud(h);
    adminId = (await localUser(h, 'cloudroot', ['system-admin'], 'restricted')).id;
    admin = await loginAdmin(h, 'cloudroot');
  }, 60_000);

  afterAll(async () => {
    await h?.close();
    await signer?.close();
    await aws?.stop();
    await az?.stop();
  });

  const post = (p: string, b: object) => admin.agent.post(p).set('x-csrf-token', admin.csrf).send(b);
  const put = (p: string, b: object) => admin.agent.put(p).set('x-csrf-token', admin.csrf).send(b);

  it('stores values sealed in the vault and never returns them from any route', async () => {
    const user = aws.addUser({ userName: 'exprsn-vaulted-1' });
    const res = await post('/api/admin/cloud/secrets', { scope: 'platform', provider: 'aws', values: { accessKeyId: user.accessKeyId, secretAccessKey: user.secretAccessKey } }).expect(201);
    expect(res.body.refs.accessKeyId).toMatch(/^vault:cloud\/secrets\/platform\/[0-9a-z]{26}#accessKeyId$/);
    expect(JSON.stringify(res.body)).not.toContain(user.secretAccessKey);
    // Sealed at rest: the version row holds no plaintext.
    const rows = await h.s.db('vault_secret_versions as v').join('vault_secrets as s', 's.id', 'v.secret_id').where('s.path', 'like', 'cloud/secrets/platform/%').select('v.value_sealed', 's.tenant_id', 's.label');
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(String(r.value_sealed)).not.toContain(user.secretAccessKey);
      expect(r.tenant_id).toBe('platform');
      expect(r.label).toBe('restricted');
    }
    const acct = await seedAccount(h, { provider: 'aws', mode: 'vaulted', providerIds: { awsAccountId: aws.account }, refs: res.body.refs, createdBy: adminId });
    const cred = (await c.for(acct, 'deploy')) as Extract<ProviderCredential, { kind: 'aws' }>;
    expect(cred).toMatchObject({ kind: 'aws', accessKeyId: user.accessKeyId, expiresAt: null });
    expect(cred.sessionToken).toBeUndefined();
    for (const path of [`/api/admin/cloud/accounts/${acct.id}`, `/api/admin/cloud/accounts/${acct.id}/credential`, `/api/admin/cloud/accounts`, '/api/admin/cloud/issuer']) {
      const r = await admin.agent.get(path);
      expect(JSON.stringify(r.body)).not.toContain(user.secretAccessKey);
    }
    const desc = (await admin.agent.get(`/api/admin/cloud/accounts/${acct.id}/credential`).expect(200)).body;
    expect(desc).toMatchObject({ mode: 'vaulted', kind: 'aws-keys', secrets: ['accessKeyId', 'secretAccessKey'], lastUsedPurpose: 'deploy' });
    expect(desc.lastUsedAt).toBeGreaterThan(0);
    // A tenant's own vault routes never reach the platform scope's cloud secrets.
    const list = await admin.agent.get('/api/vault/kv?prefix=cloud');
    expect(JSON.stringify(list.body)).not.toContain('cloud/secrets/platform');
    // A reference staged for another scope does not resolve for this account.
    const foreign = await c.store({ scope: 'tenant', tenantId: h.tenantId, values: { accessKeyId: user.accessKeyId, secretAccessKey: user.secretAccessKey }, by: adminId });
    const other = await seedAccount(h, { provider: 'aws', mode: 'vaulted', providerIds: { awsAccountId: aws.account }, refs: { accessKeyId: res.body.refs.accessKeyId, secretAccessKey: foreign.refs.secretAccessKey! } });
    await expect(c.for(other, 'read')).rejects.toMatchObject({ status: 403 });
  });

  it('rotates a vaulted AWS key: new key in use at once, old key deleted after the overlap', async () => {
    const user = aws.addUser({ userName: 'exprsn-rotating' });
    const stored = await c.store({ scope: 'platform', tenantId: null, values: { accessKeyId: user.accessKeyId, secretAccessKey: user.secretAccessKey }, by: adminId });
    const acct = await seedAccount(h, { provider: 'aws', mode: 'vaulted', providerIds: { awsAccountId: aws.account }, refs: stored.refs, createdBy: adminId });
    expect(((await c.for(acct, 'read')) as { accessKeyId: string }).accessKeyId).toBe(user.accessKeyId);
    const res = await post(`/api/admin/cloud/accounts/${acct.id}/rotate`, {}).expect(200);
    expect(res.body.rotated).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/secretAccessKey"\s*:\s*"/);
    const now = (await c.for(acct, 'read')) as { accessKeyId: string; secretAccessKey: string };
    expect(now.accessKeyId).not.toBe(user.accessKeyId);
    expect(aws.keys.get(now.accessKeyId)?.userName).toBe('exprsn-rotating');
    expect(aws.calls('sts:GetCallerIdentity').some((r) => r.headers.authorization?.includes(now.accessKeyId))).toBe(true); // verified before the switch
    expect(aws.keys.has(user.accessKeyId)).toBe(true); // still there during the overlap
    expect((await c.state(acct.id))!.rotation_state).toBe('overlap');
    const t = clock();
    try {
      t.advance(11 * 60_000);
      const out = await c.sweep();
      expect(out.finished).toBeGreaterThanOrEqual(1);
      expect(aws.keys.has(user.accessKeyId)).toBe(false);
      expect((await c.state(acct.id))!.rotation_state).toBe('idle');
      // Due again by age (CLOUD_AWS_KEY_ROTATION_DAYS): the sweep rotates it by itself.
      t.advance((h.s.cfg.CLOUD_AWS_KEY_ROTATION_DAYS + 1) * 86_400_000);
      const before = ((await c.for(acct, 'read')) as { accessKeyId: string }).accessKeyId;
      expect((await c.sweep()).rotated).toBeGreaterThanOrEqual(1);
      expect(((await c.for(acct, 'read')) as { accessKeyId: string }).accessKeyId).not.toBe(before);
    } finally {
      t.restore();
    }
    // The rotation is audited without the key values.
    const entries = await h.s.db('audit_events').where({ action: 'cloud.credential.rotated' });
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(entries)).not.toContain(now.secretAccessKey);
  });

  it('rotates an Azure client secret through Graph addPassword and removes the old one after the overlap', async () => {
    const app = az.addApp({ tenantId: AZ_TENANT, secret: true });
    const oldKeyId = [...app.secrets.keys()][0]!;
    const stored = await c.store({ scope: 'platform', tenantId: null, values: { clientSecret: app.secret! }, by: adminId });
    const acct = await seedAccount(h, { provider: 'azure', mode: 'vaulted', providerIds: { azureTenantId: AZ_TENANT, azureSubscriptionId: AZ_SUB }, params: { clientId: app.clientId }, refs: stored.refs, createdBy: adminId });
    const cred = await c.for(acct, 'read');
    if (cred.kind !== 'azure') throw new Error('expected azure');
    expect((await cred.getToken(AZURE_SCOPES.arm)).token).toBeTruthy();
    const res = await post(`/api/admin/cloud/accounts/${acct.id}/rotate`, {}).expect(200);
    expect(res.body.rotated).toBe(true);
    expect(app.secrets.size).toBe(2);
    expect(az.calls(/addPassword/)).toHaveLength(1);
    const fresh = await c.for(acct, 'read');
    if (fresh.kind !== 'azure') throw new Error('expected azure');
    const tok = await fresh.getToken(AZURE_SCOPES.arm);
    const used = az.calls('entra:token').at(-1)!;
    expect(new URLSearchParams(used.body).get('client_secret')).not.toBe(app.secret);
    expect(tok.token).toBeTruthy();
    const t = clock();
    try {
      t.advance(11 * 60_000);
      await c.sweep();
    } finally {
      t.restore();
    }
    expect(app.secrets.has(oldKeyId)).toBe(false);
    expect(app.secrets.size).toBe(1);
    const st = await c.state(acct.id);
    expect(st!.rotation_state).toBe('idle');
    expect(st!.expires_at).toBeGreaterThan(Date.now() + 100 * 86_400_000);
  });

  it('reminds before a DigitalOcean or Cloudflare token expires, once per stage, and takes a guided replace', async () => {
    const cfStored = await c.store({ scope: 'platform', tenantId: null, values: { token: 'cf-token-value-1' }, by: adminId });
    const cf = await seedAccount(h, { provider: 'cloudflare', mode: 'vaulted', providerIds: { cloudflareAccountId: CF_ACCOUNT }, refs: cfStored.refs, createdBy: adminId });
    // The expiry is given with a guided replace (or when the secret is stored).
    await put(`/api/admin/cloud/accounts/${cf.id}/secret`, { values: { token: 'cf-token-value-2' }, expiresAt: Date.now() + 5 * 86_400_000 }).expect(200);
    expect(await c.for(cf, 'read')).toEqual({ kind: 'token', token: 'cf-token-value-2', accountId: CF_ACCOUNT });
    const count = async () => (await h.s.db('notifications').where({ user_id: adminId, kind: 'vault' }).where('title', 'like', `%${cf.name}%`)).length;
    await c.sweep();
    expect(await count()).toBe(1);
    await c.sweep();
    expect(await count()).toBe(1);
    const t = clock();
    try {
      t.advance(6 * 86_400_000);
      await c.sweep();
      expect(await count()).toBe(2);
    } finally {
      t.restore();
    }
    expect((await h.s.db('notifications').where({ user_id: adminId, kind: 'vault' }).where('title', 'like', `%${cf.name}%`)).map((n) => String(n.title)).join(' ')).not.toContain('cf-token-value');
    await post(`/api/admin/cloud/accounts/${cf.id}/rotate`, {}).expect(409);
    const doStored = await c.store({ scope: 'platform', tenantId: null, values: { token: 'do-token-value' }, by: adminId });
    const dig = await seedAccount(h, { provider: 'digitalocean', mode: 'vaulted', providerIds: { doTeamId: DO_TEAM }, refs: doStored.refs, createdBy: adminId });
    expect(await c.for(dig, 'deploy')).toEqual({ kind: 'token', token: 'do-token-value', accountId: DO_TEAM });
  });

  it('chooses the credential by mode and purpose, and refuses pending and disabled accounts', async () => {
    const roles = { read: aws.addRole({ name: 'p-read', aud: AWS_AUDIENCE }), deploy: aws.addRole({ name: 'p-deploy', aud: AWS_AUDIENCE }), billing: aws.addRole({ name: 'p-billing', aud: AWS_AUDIENCE }) };
    const fed = await seedAccount(h, { provider: 'aws', mode: 'federated', providerIds: { awsAccountId: aws.account }, params: { roleArn: roles.read.arn, readRoleArn: roles.read.arn, deployRoleArn: roles.deploy.arn, billingRoleArn: roles.billing.arn } });
    // Federated with no published issuer: the fake accepts on aud and sub.
    for (const r of Object.values(roles)) r.sub = `cloud-account:${fed.id}`;
    const got: Record<string, ProviderCredential> = {};
    for (const purpose of ['read', 'deploy', 'billing'] as const) {
      got[purpose] = await c.for(fed, purpose);
      expect(got[purpose]!.kind).toBe('aws');
      expect(aws.webIdentityTokens.at(-1)!.roleArn).toBe(roles[purpose].arn);
    }
    // Validation uses the read role: the same cached session.
    expect(await c.for(fed, 'validate')).toEqual(got.read);
    const pending = await seedAccount(h, { provider: 'aws', mode: 'federated', providerIds: { awsAccountId: aws.account }, params: { roleArn: roles.read.arn }, state: 'pending' });
    roles.read.sub = undefined;
    await expect(c.for(pending, 'deploy')).rejects.toMatchObject({ status: 409 });
    expect((await c.for(pending, 'validate')).kind).toBe('aws');
    const disabled = await seedAccount(h, { provider: 'aws', mode: 'federated', providerIds: { awsAccountId: aws.account }, params: { roleArn: roles.read.arn }, state: 'disabled' });
    await expect(c.for(disabled, 'validate')).rejects.toMatchObject({ status: 409 });
  });

  it('issues an Azure client certificate from the CA with its key in the signer, and signs assertions with it', async () => {
    const by = { tenantId: h.tenantId, userId: adminId, actor: { user: adminId } };
    await h.s.pki.createRoot(by, { commonName: 'Exprsn Test Root' });
    await h.s.pki.createIntermediate(by, h.tenantId, { commonName: 'Exprsn Test Issuing' });
    await h.s.pki.createProfile(by, { name: 'cloud-clients', kind: 'client', policy: policySchema.parse({ keyTypes: ['rsa-2048'] }), maxDays: 365, defaultDays: 90 });
    const app = az.addApp({ tenantId: AZ_TENANT });
    const acct = await seedAccount(h, { provider: 'azure', mode: 'vaulted', providerIds: { azureTenantId: AZ_TENANT, azureSubscriptionId: AZ_SUB }, params: { clientId: app.clientId }, createdBy: adminId });
    const res = await post(`/api/admin/cloud/accounts/${acct.id}/azure-certificate`, {}).expect(201);
    expect(res.body.ref).toMatch(/^vault:cloud\/accounts\/.+\/certificate#certificate$/);
    expect(res.body.certificatePem).toMatch(/BEGIN CERTIFICATE/);
    expect(JSON.stringify(res.body)).not.toMatch(/PRIVATE KEY|wrapped/);
    await h.s.db('cloud_credentials').where({ account_id: acct.id }).update({ refs: JSON.stringify({ certificate: res.body.ref }) });
    // The fake knows federated records only: a certificate assertion is iss = sub = client id, aud the token endpoint.
    app.federated.push({ issuer: app.clientId, subject: app.clientId, audience: `${az.url}/${AZ_TENANT}/oauth2/v2.0/token` });
    const pub = new X509Certificate(res.body.certificatePem).publicKey;
    az.validateAssertion = (assertion) => {
      const d = decodeJwt(assertion);
      return d.header.alg === 'RS256' && (d.header as unknown as Record<string, unknown>)['x5t#S256'] && verifySignature('RS256', d.signingInput, d.signature, pub) ? null : 'bad certificate signature';
    };
    try {
      const cred = await c.for(acct, 'read');
      if (cred.kind !== 'azure') throw new Error('expected azure');
      expect((await cred.getToken(AZURE_SCOPES.arm)).token).toBeTruthy();
    } finally {
      az.validateAssertion = null;
    }
    expect((await c.describe(acct)).kind).toBe('azure-certificate');
  });
});
