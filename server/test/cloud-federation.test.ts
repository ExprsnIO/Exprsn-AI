import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { decodeJwt, verifyJwt, type Jwk } from '../src/federation/jose.js';
import { AZURE_SCOPES } from '../src/cloud/azure-calls.js';
import type { CloudCredentials, ProviderCredential } from '../src/cloud/credentials.js';
import { AWS_AUDIENCE, AZURE_AUDIENCE } from '../src/cloud/issuer.js';
import { clock, installCloud, seedAccount, signerFixture } from './cloud-credentials-helpers.js';
import { FakeAws } from './fake-aws.js';
import { FakeAzure } from './fake-azure.js';
import { harness, localUser, loginAdmin, type Harness } from './helpers.js';

/*
 * 1.9.99-final, Sprint 56 (B-10003 to B-10005): the federation issuer and the exchanges it serves. Issuer keys are held
 * by a signer process (never in this process); tokens carry `sub` cloud-account:<id> and the cloud's audience; STS
 * sessions are cached and refreshed at two thirds; Entra tokens per scope; the RS256 key for the Azure audience
 * only; publication to an S3 bucket (the AWS fake), republished on rotation with the old key kept; the check job's
 * mismatch alert. The fakes check each token's signature against the JWKS as published in the bucket, as AWS and
 * Entra would. No real cloud is contacted.
 */

const AZ_TENANT = '11111111-2222-3333-4444-555555555555';
const AZ_SUB = '99999999-8888-7777-6666-555555555555';
const BUCKET = 'exprsn-issuer';

describe('cloud federation (B-10003 to B-10005)', () => {
  let h: Harness;
  let aws: FakeAws;
  let az: FakeAzure;
  let signer: Awaited<ReturnType<typeof signerFixture>>;
  let c: CloudCredentials;
  let issuer: string;

  /** The JWKS as the bucket holds it now (what a cloud would fetch). */
  const publishedJwks = (): Jwk[] => JSON.parse(aws.objects.get(`${BUCKET}/jwks.json`)?.body ?? '{"keys":[]}').keys as Jwk[];
  const checkAgainstBucket = (token: string, audience: string): string | null => {
    try {
      verifyJwt(token, publishedJwks(), { issuer, audience, algs: ['ES256', 'RS256'] });
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  };

  beforeAll(async () => {
    aws = await new FakeAws().start();
    az = await new FakeAzure().start();
    signer = await signerFixture();
    issuer = `${aws.url}/${BUCKET}`;
    h = await harness({ ...signer.env, CLOUD_ISSUER_URL: issuer, CLOUD_AWS_STS_URL: aws.url, CLOUD_AWS_IAM_URL: aws.url, CLOUD_AZURE_AUTHORITY: az.url, CLOUD_AZURE_GRAPH_URL: az.url, CLOUD_ISSUER_PUBLISH_LEAD_MINUTES: '5' });
    c = await installCloud(h);
    aws.buckets.set(BUCKET, { Name: BUCKET, Region: 'eu-central-1', Tags: null, CreatedAt: Date.now(), PublicAccessBlock: false });
    const writer = aws.addUser({ userName: 'issuer-publisher' });
    const stored = await c.vault.write('cloud/issuer/s3', { accessKeyId: writer.accessKeyId, secretAccessKey: writer.secretAccessKey });
    await c.issuer.setTarget({ kind: 's3', bucket: BUCKET, region: 'eu-central-1', prefix: '', endpoint: aws.url, accessKeyRef: stored.refs.accessKeyId, secretKeyRef: stored.refs.secretAccessKey }, null);
    await c.issuer.publish('test');
    aws.validateWebIdentity = (token) => checkAgainstBucket(token, AWS_AUDIENCE);
    az.validateAssertion = (token) => checkAgainstBucket(token, AZURE_AUDIENCE);
  }, 60_000);

  afterAll(async () => {
    await h?.close();
    await signer?.close();
    await aws?.stop();
    await az?.stop();
  });

  afterEach(() => {
    h.s.cfg.CLOUD_AZURE_SIGNING_ALG = 'ES256';
  });

  it('mints a short-lived token for the account, signed by an issuer key the signer holds', async () => {
    const acct = await seedAccount(h, { provider: 'aws', mode: 'federated', providerIds: { awsAccountId: aws.account }, params: { roleArn: `arn:aws:iam::${aws.account}:role/x` } });
    const m = await c.issuer.mint(acct.id, AWS_AUDIENCE);
    const { header, claims } = decodeJwt(m.token);
    expect(header.alg).toBe('ES256');
    expect(claims).toMatchObject({ iss: issuer, sub: `cloud-account:${acct.id}`, aud: AWS_AUDIENCE });
    expect(Number(claims.exp) - Number(claims.iat)).toBe(h.s.cfg.CLOUD_ISSUER_TOKEN_SECONDS);
    expect(issuer).not.toBe(h.s.cfg.PUBLIC_URL);
    // Verifies against the issuer's JWKS and against the copy in the bucket.
    const keys = (await c.issuer.jwks()).keys;
    expect(() => verifyJwt(m.token, keys, { issuer, audience: AWS_AUDIENCE, algs: ['ES256'] })).not.toThrow();
    expect(checkAgainstBucket(m.token, AWS_AUDIENCE)).toBeNull();
    const status = await c.issuer.status();
    expect(status.custody).toBe('signer');
    expect(status.keys.every((k) => k.custody === 'signer')).toBe(true);
    expect((c.issuer as unknown as { cache: Map<string, unknown> }).cache.size).toBe(0);
    expect(status.consoleIssuer).not.toBe(status.issuer);
    // The private reference is the signer's wrapped blob, never a PEM.
    const row = await h.s.db('cloud_issuer_keys').first('private_ref');
    expect(String(row.private_ref)).toMatch(/^signer:/);
    expect(String(row.private_ref)).not.toMatch(/PRIVATE KEY/);
  });

  it('buys STS sessions, cached per role and refreshed at two thirds of their life; another sub is refused', async () => {
    const role = aws.addRole({ name: 'exprsn-read', aud: AWS_AUDIENCE });
    const deploy = aws.addRole({ name: 'exprsn-deploy', aud: AWS_AUDIENCE });
    const acct = await seedAccount(h, { provider: 'aws', mode: 'federated', providerIds: { awsAccountId: aws.account }, params: { roleArn: role.arn, deployRoleArn: deploy.arn } });
    role.sub = `cloud-account:${acct.id}`;
    deploy.sub = `cloud-account:${acct.id}`;
    const before = aws.calls('sts:AssumeRoleWithWebIdentity').length;
    const first = (await c.for(acct, 'read')) as Extract<ProviderCredential, { kind: 'aws' }>;
    expect(first.kind).toBe('aws');
    expect(first.sessionToken).toBeTruthy();
    expect(first.expiresAt! - Date.now()).toBeGreaterThan(3500_000);
    const again = await c.for(acct, 'read');
    expect(again).toEqual(first);
    expect(aws.calls('sts:AssumeRoleWithWebIdentity').length).toBe(before + 1);
    // The deploy purpose assumes its own role.
    await c.for(acct, 'deploy');
    expect(aws.webIdentityTokens.at(-1)!.roleArn).toBe(deploy.arn);
    expect(aws.webIdentityTokens.at(-1)!.claims).toMatchObject({ sub: `cloud-account:${acct.id}`, aud: AWS_AUDIENCE });
    const t = clock();
    try {
      t.advance(2300_000); // under two thirds of an hour: still cached
      expect(await c.for(acct, 'read')).toEqual(first);
      t.advance(200_000); // past 2400 s
      const fresh = (await c.for(acct, 'read')) as Extract<ProviderCredential, { kind: 'aws' }>;
      expect(fresh.accessKeyId).not.toBe(first.accessKeyId);
    } finally {
      t.restore();
    }
    // A role whose trust policy names another subject refuses this account.
    const other = aws.addRole({ name: 'someone-else', aud: AWS_AUDIENCE, sub: 'cloud-account:01HZZZZZZZZZZZZZZZZZZZZZZZ' });
    const wrong = await seedAccount(h, { provider: 'aws', mode: 'federated', providerIds: { awsAccountId: aws.account }, params: { roleArn: other.arn } });
    await expect(c.for(wrong, 'read')).rejects.toMatchObject({ status: 403 });
    // No long-lived key for a federated account anywhere: nothing in the vault, no IAM user key made.
    expect(await h.s.db('vault_secrets').where('path', 'like', `cloud/accounts/${acct.id.toLowerCase()}%`).first()).toBeUndefined();
    expect(aws.calls('iam:CreateAccessKey')).toHaveLength(0);
  });

  it('buys Entra tokens with a client assertion, per scope and cached; a purpose only gets its scopes', async () => {
    const app = az.addApp({ tenantId: AZ_TENANT });
    const acct = await seedAccount(h, { provider: 'azure', mode: 'federated', providerIds: { azureTenantId: AZ_TENANT, azureSubscriptionId: AZ_SUB }, params: { clientId: app.clientId } });
    app.federated.push({ issuer, subject: `cloud-account:${acct.id}`, audience: AZURE_AUDIENCE });
    const cred = await c.for(acct, 'deploy');
    if (cred.kind !== 'azure') throw new Error('expected an azure credential');
    expect(cred.tenantId).toBe(AZ_TENANT);
    const arm = await cred.getToken(AZURE_SCOPES.arm);
    const cog = await cred.getToken(AZURE_SCOPES.cognitive);
    expect(arm.token).not.toBe(cog.token);
    expect(az.tokens.get(arm.token)!.scope).toBe('https://management.azure.com');
    const calls = az.calls('entra:token').length;
    expect((await cred.getToken(AZURE_SCOPES.arm)).token).toBe(arm.token);
    expect(az.calls('entra:token').length).toBe(calls);
    expect(decodeJwt(az.calls('entra:token').map((r) => new URLSearchParams(r.body).get('client_assertion')).filter(Boolean).at(-1)!).header.alg).toBe('ES256');
    const billing = await c.for(acct, 'billing');
    if (billing.kind !== 'azure') throw new Error('expected an azure credential');
    await expect(billing.getToken(AZURE_SCOPES.cognitive)).rejects.toMatchObject({ status: 403 });
    // No client secret is stored for a federated Azure account.
    expect(await h.s.db('vault_secrets').where('path', 'like', `cloud/accounts/${acct.id.toLowerCase()}%`).first()).toBeUndefined();
  });

  it('signs for the Azure audience with an RSA key only when CLOUD_AZURE_SIGNING_ALG=RS256 (open decision 3)', async () => {
    h.s.cfg.CLOUD_AZURE_SIGNING_ALG = 'RS256';
    const app = az.addApp({ tenantId: AZ_TENANT });
    const acct = await seedAccount(h, { provider: 'azure', mode: 'federated', providerIds: { azureTenantId: AZ_TENANT, azureSubscriptionId: AZ_SUB }, params: { clientId: app.clientId } });
    app.federated.push({ issuer, subject: `cloud-account:${acct.id}`, audience: AZURE_AUDIENCE });
    await c.issuer.publish('rs256 on'); // the RSA key is published before it is used
    const az1 = await c.issuer.mint(acct.id, AZURE_AUDIENCE);
    const aws1 = await c.issuer.mint(acct.id, AWS_AUDIENCE);
    expect(az1.alg).toBe('RS256');
    expect(aws1.alg).toBe('ES256');
    expect(publishedJwks().some((k) => k.kty === 'RSA' && k.kid === az1.kid)).toBe(true);
    expect((c.issuer.discovery().id_token_signing_alg_values_supported as string[]).sort()).toEqual(['ES256', 'RS256']);
    const cred = await c.for(acct, 'read');
    if (cred.kind !== 'azure') throw new Error('expected an azure credential');
    await cred.getToken(AZURE_SCOPES.arm);
    expect((await c.issuer.status()).keys.find((k) => k.kid === az1.kid)!.custody).toBe('signer');
  });

  it('publishes on rotation, signs with the new key only once the bucket holds it, and keeps the old key', async () => {
    const role = aws.addRole({ name: 'exprsn-rotate', aud: AWS_AUDIENCE });
    const acct = await seedAccount(h, { provider: 'aws', mode: 'federated', providerIds: { awsAccountId: aws.account }, params: { roleArn: role.arn } });
    role.sub = `cloud-account:${acct.id}`;
    const old = (await c.issuer.signer('ES256')).kid;
    // A publication that fails leaves the next key waiting, however long.
    aws.fail(503, '<Error><Code>SlowDown</Code></Error>', { op: /^s3:PUT/, times: 1 });
    const rot = await c.issuer.rotate({ alg: 'ES256' });
    expect(rot.published).toBe(false);
    expect(rot.next.state).toBe('next');
    const t = clock();
    try {
      t.advance(10 * 60_000);
      expect((await c.issuer.signer('ES256')).kid).toBe(old);
      await c.issuer.publish('retry');
      const kids = publishedJwks().map((k) => k.kid);
      expect(kids).toEqual(expect.arrayContaining([old, rot.next.kid]));
      expect((await c.issuer.signer('ES256')).kid).toBe(rot.next.kid);
      // A session bought now verifies against the bucket, and the old key is still published for sessions it bought.
      c.drop(acct.id);
      expect((await c.for(acct, 'read')).kind).toBe('aws');
      expect(publishedJwks().map((k) => k.kid)).toContain(old);
      const retired = (await c.issuer.status()).keys.find((k) => k.kid === old)!;
      expect(retired.state).toBe('retired');
      expect(retired.removesAt! - retired.retiresAt!).toBeGreaterThanOrEqual(h.s.cfg.CLOUD_SESSION_SECONDS * 1000);
      // After the window, the old key leaves the JWKS and the next check republishes without it.
      t.advance(h.s.cfg.CLOUD_SESSION_SECONDS * 1000 + 3600_000);
      const check = await c.issuer.check();
      expect(check.state).toBe('ok');
      expect(publishedJwks().map((k) => k.kid)).not.toContain(old);
    } finally {
      t.restore();
    }
  });

  it('raises an alert when the published JWKS no longer matches the issuer, once, and clears on publication', async () => {
    const sys = await localUser(h, 'cloudroot', ['system-admin'], 'restricted');
    expect((await c.issuer.check()).state).toBe('ok');
    const doc = JSON.parse(aws.objects.get(`${BUCKET}/jwks.json`)!.body) as { keys: Jwk[] };
    aws.objects.set(`${BUCKET}/jwks.json`, { body: JSON.stringify({ keys: doc.keys.slice(1) }), contentType: 'application/json' });
    const bad = await c.issuer.check();
    expect(bad.state).toBe('mismatch');
    expect(bad.missing).toHaveLength(1);
    expect(await h.s.db('notifications').where({ user_id: sys.id, kind: 'security' }).first()).toBeTruthy();
    const audits = await h.s.db('audit_events').where({ action: 'cloud.issuer.mismatch' });
    expect(audits).toHaveLength(1);
    await c.issuer.check(); // the same mismatch is not alerted twice
    expect(await h.s.db('audit_events').where({ action: 'cloud.issuer.mismatch' })).toHaveLength(1);
    await c.issuer.publish('fix');
    expect((await c.issuer.check()).state).toBe('ok');
  });

  it('serves the issuer status, the setup helper, and the console target, with no key material', async () => {
    await localUser(h, 'cloudops', ['system-admin'], 'restricted');
    const admin = await loginAdmin(h, 'cloudops');
    const acct = await seedAccount(h, { provider: 'aws', mode: 'federated', providerIds: { awsAccountId: aws.account }, params: { roleArn: `arn:aws:iam::${aws.account}:role/exprsn-ai` } });
    const st = await admin.agent.get('/api/admin/cloud/issuer').expect(200);
    expect(st.body.issuer).toBe(issuer);
    expect(JSON.stringify(st.body)).not.toMatch(/signer:|PRIVATE|"d":/);
    const setup = await admin.agent.get(`/api/admin/cloud/accounts/${acct.id}/setup`).expect(200);
    expect(setup.body.subject).toBe(`cloud-account:${acct.id}`);
    const trust = setup.body.steps.find((x: { file?: { name: string } }) => x.file?.name === 'exprsn-trust.json').file.json;
    const hp = issuer.replace(/^https?:\/\//, '');
    expect(trust.Statement[0].Condition.StringEquals).toEqual({ [`${hp}:aud`]: AWS_AUDIENCE, [`${hp}:sub`]: `cloud-account:${acct.id}` });
    const policies = setup.body.steps.find((x: { file?: { name: string } }) => x.file?.name === 'exprsn-policies.json').file.json;
    expect(JSON.stringify(policies.deploy)).toContain('aws:ResourceTag/exprsn:managed');
    expect(setup.body.steps.some((x: { commands?: string[] }) => x.commands?.some((l) => l.includes('create-open-id-connect-provider')))).toBe(true);
    const doAcct = await seedAccount(h, { provider: 'digitalocean', mode: 'vaulted', providerIds: { doTeamId: '0f0f0f0f-0000-4000-8000-000000000001' }, refs: { token: 'vault:cloud/x#token' } });
    expect((await admin.agent.get(`/api/admin/cloud/accounts/${doAcct.id}/setup`).expect(200)).body.available).toBe(false);
    // The public documents are on the console only with the console target.
    const base = '/cloud-issuer';
    await admin.agent.get(`${base}/jwks.json`).expect(404);
    await c.issuer.setTarget({ kind: 'console' }, null);
    try {
      const jwks = await admin.agent.get(`${base}/jwks.json`).expect(200);
      expect(JSON.parse(jwks.text).keys.length).toBeGreaterThan(0);
      expect(JSON.parse(jwks.text).keys.every((k: Jwk) => !('d' in k))).toBe(true);
      expect((await admin.agent.get(`${base}/.well-known/openid-configuration`).expect(200)).body.issuer).toBe(issuer);
    } finally {
      const writer = aws.addUser({ userName: 'issuer-publisher-2' });
      const stored = await c.vault.write('cloud/issuer/s3', { accessKeyId: writer.accessKeyId, secretAccessKey: writer.secretAccessKey });
      await c.issuer.setTarget({ kind: 's3', bucket: BUCKET, region: 'eu-central-1', prefix: '', endpoint: aws.url, accessKeyRef: stored.refs.accessKeyId, secretKeyRef: stored.refs.secretAccessKey }, null);
      await c.issuer.publish('back');
    }
  });
});
