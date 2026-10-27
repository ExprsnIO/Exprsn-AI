/*
 * 1.9.99-final, Sprint 58 (B-10208): KMS_PROVIDER=aws-kms and azure-keyvault against the fakes (`fake-aws-kms.ts`,
 * `fake-azure-data.ts`): per-tenant keys, wrap and unwrap bound to their associated data, checkpoint signing and
 * verification (ES256 in the KMS, verified with the public key, across a signing-key rotation), destruction, the
 * install's credential (web identity, workload identity, vaulted keys; never the metadata service), the
 * configuration (production refuses cloud secrets inline), and the done-when: `kms:rewrap` moves a tenant from
 * `local` to `aws-kms` and `audit:verify` still passes. Never the real AWS or Azure.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap } from '../src/bootstrap.js';
import { loadConfig } from '../src/config/index.js';
import { createDb, migrate, type Db } from '../src/db/knex.js';
import { createLogger, Metrics } from '../src/observability/index.js';
import { awsInstallCredential, installTransport } from '../src/platform/cloud-identity.js';
import { createKms, LocalKms } from '../src/platform/kms.js';
import { AwsKms, type AzureKeyVaultKms } from '../src/platform/kms-cloud.js';
import { createPreviousKms, rewrapAll } from '../src/platform/rewrap.js';
import { createServices, type Services } from '../src/services.js';
import { FakeAws } from './fake-aws.js';
import { FakeAzure } from './fake-azure.js';
import { testConfig } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), p));
const by = (tenantId: string) => ({ tenantId, actor: { service: 'test' }, userId: null });
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims: Record<string, unknown>) => `${b64u({ alg: 'RS256', typ: 'JWT' })}.${b64u(claims)}.${randomBytes(32).toString('base64url')}`;

const AZ_TENANT = '99999999-8888-7777-6666-555555555555';
const AZ_ISSUER = 'https://oidc.prod-aks.azure.com/fake-cluster/';
const AZ_SUBJECT = 'system:serviceaccount:exprsn:exprsn-ai';

let aws: FakeAws;
let azure: FakeAzure;
let roleArn: string;
let awsTokenFile: string;
let azApp: { clientId: string };
let azTokenFile: string;

beforeAll(async () => {
  aws = await new FakeAws().start();
  azure = await new FakeAzure().start();
  roleArn = aws.addRole({ name: 'exprsn-ai-kms', aud: 'sts.amazonaws.com', sub: 'system:serviceaccount:exprsn:exprsn-ai' }).arn;
  const dir = tmp('exprsn-kms-tokens-');
  awsTokenFile = path.join(dir, 'aws-token');
  writeFileSync(awsTokenFile, jwt({ iss: 'https://oidc.eks.eu-central-1.amazonaws.com/id/FAKE', sub: 'system:serviceaccount:exprsn:exprsn-ai', aud: 'sts.amazonaws.com', exp: Math.floor(Date.now() / 1000) + 3600 }), { mode: 0o600 });
  azApp = azure.addApp({ tenantId: AZ_TENANT, federated: [{ issuer: AZ_ISSUER, subject: AZ_SUBJECT, audience: 'api://AzureADTokenExchange' }] });
  azTokenFile = path.join(dir, 'azure-token');
  writeFileSync(azTokenFile, jwt({ iss: AZ_ISSUER, sub: AZ_SUBJECT, aud: 'api://AzureADTokenExchange', exp: Math.floor(Date.now() / 1000) + 3600 }), { mode: 0o600 });
});
afterAll(async () => {
  await aws.stop();
  await azure.stop();
});

const awsEnv = (): Record<string, string> => ({ SERVICE_ALLOWED_HOSTS: '127.0.0.1', KMS_PROVIDER: 'aws-kms', KMS_AWS_REGION: 'eu-central-1', KMS_AWS_ENDPOINT: aws.url, KMS_AWS_STS_URL: aws.url, KMS_AWS_ROLE_ARN: roleArn, KMS_AWS_WEB_IDENTITY_TOKEN_FILE: awsTokenFile });
const azureEnv = (): Record<string, string> => ({ SERVICE_ALLOWED_HOSTS: '127.0.0.1', KMS_PROVIDER: 'azure-keyvault', KMS_AZURE_VAULT_URL: azure.url, CLOUD_AZURE_AUTHORITY: azure.url, AZURE_IDENTITY_TENANT_ID: AZ_TENANT, AZURE_IDENTITY_CLIENT_ID: azApp.clientId, AZURE_IDENTITY_FEDERATED_TOKEN_FILE: azTokenFile });

describe('B-10208: AWS KMS (aws-kms)', () => {
  it('keeps a key per tenant, wraps a data key bound to its context, and refuses another key or context', async () => {
    const kms = createKms(testConfig(awsEnv())) as AwsKms;
    expect(kms.kind).toBe('aws-kms');
    const stsBefore = aws.calls('sts:AssumeRoleWithWebIdentity').length;
    const dek = randomBytes(32);
    const a = await kms.wrap('exprsn-tenant-a', dek, 'dek:A:1');
    const b = await kms.wrap('exprsn-tenant-b', dek, 'dek:B:1');
    expect(a).toMatch(/^aws-kms:v1:/);
    expect((await kms.unwrap('exprsn-tenant-a', a, 'dek:A:1')).equals(dek)).toBe(true);
    await expect(kms.unwrap('exprsn-tenant-a', a, 'dek:A:2')).rejects.toThrow(/InvalidCiphertextException/);
    await expect(kms.unwrap('exprsn-tenant-a', b, 'dek:B:1')).rejects.toThrow(/IncorrectKeyException/);
    const keyA = aws.kms.aliases.get('alias/exprsn-tenant-a')!;
    const keyB = aws.kms.aliases.get('alias/exprsn-tenant-b')!;
    expect(keyA).toBeTruthy();
    expect(keyA).not.toBe(keyB);
    expect(aws.kms.keys.get(keyA)).toMatchObject({ KeySpec: 'SYMMETRIC_DEFAULT', KeyUsage: 'ENCRYPT_DECRYPT', rotation: true, tags: { 'exprsn:key-name': 'exprsn-tenant-a', 'exprsn:purpose': 'wrap' } });
    expect(aws.kms.log.find((l) => l.action === 'Encrypt' && l.keyId === keyA)!.context).toEqual({ exprsn: 'dek:A:1' });
    // ensureKey is idempotent and a second wrap reuses the key; one web identity session serves every call.
    await kms.ensureKey('exprsn-tenant-a');
    expect(aws.kms.aliases.get('alias/exprsn-tenant-a')).toBe(keyA);
    expect(aws.calls('sts:AssumeRoleWithWebIdentity').length - stsBefore).toBe(1);
    const presented = aws.webIdentityTokens.at(-1)!;
    expect(presented.roleArn).toBe(roleArn);
    expect(presented.claims!.sub).toBe('system:serviceaccount:exprsn:exprsn-ai');
    // Every KMS call is signed with the session, not a long-lived key.
    const kmsCalls = aws.requests.filter((r) => r.op.startsWith('kms:'));
    expect(kmsCalls.every((r) => /Credential=ASIA/.test(r.headers.authorization ?? '') && !!r.headers['x-amz-security-token'])).toBe(true);
    expect((await kms.health()).ok).toBe(true);
  });

  it('signs in the KMS (ES256) and verifies with the public key; a rotation keeps old signatures valid', async () => {
    const kms = createKms(testConfig(awsEnv())) as AwsKms;
    const mac = await kms.hmac('exprsn-audit-checkpoints', '{"seq":1}');
    expect(mac).toMatch(/^aws-kms:v1:[0-9a-f-]{36}:[A-Za-z0-9_-]+$/);
    expect(mac.length).toBeLessThan(300); // audit_checkpoints.signature is 300 characters
    expect(await kms.verifyHmac('exprsn-audit-checkpoints', '{"seq":1}', mac)).toBe(true);
    expect(await kms.verifyHmac('exprsn-audit-checkpoints', '{"seq":2}', mac)).toBe(false);
    expect(await kms.verifyHmac('exprsn-other', '{"seq":1}', mac)).toBe(false);
    expect(await kms.verifyHmac('exprsn-audit-checkpoints', '{"seq":1}', 'local:v1:abc')).toBe(false);
    const signer = aws.kms.keys.get(aws.kms.aliases.get('alias/exprsn-audit-checkpoints-mac')!)!;
    expect(signer).toMatchObject({ KeySpec: 'ECC_NIST_P256', KeyUsage: 'SIGN_VERIFY' });
    const newKey = await kms.rotateSigningKey('exprsn-audit-checkpoints');
    const after = await kms.hmac('exprsn-audit-checkpoints', '{"seq":3}');
    expect(after).toContain(`:${newKey}:`);
    expect(after.split(':')[2]).not.toBe(mac.split(':')[2]);
    // A fresh instance (no cached public keys) verifies both, the old one by the key it names.
    const fresh = createKms(testConfig(awsEnv()));
    expect(await fresh.verifyHmac('exprsn-audit-checkpoints', '{"seq":1}', mac)).toBe(true);
    expect(await fresh.verifyHmac('exprsn-audit-checkpoints', '{"seq":3}', after)).toBe(true);
  });

  it('destroys a tenant key: scheduled for deletion, alias removed, the wrapped key no longer opens', async () => {
    const kms = createKms(testConfig({ ...awsEnv(), KMS_AWS_DELETION_DAYS: '10' }));
    const w = await kms.wrap('exprsn-tenant-gone', randomBytes(32), 'dek:G:1');
    const id = aws.kms.aliases.get('alias/exprsn-tenant-gone')!;
    await kms.destroyKey('exprsn-tenant-gone');
    expect(aws.kms.keys.get(id)).toMatchObject({ KeyState: 'PendingDeletion', deletionDays: 10 });
    expect(aws.kms.aliases.has('alias/exprsn-tenant-gone')).toBe(false);
    await expect(kms.unwrap('exprsn-tenant-gone', w, 'dek:G:1')).rejects.toThrow(/NotFoundException/);
    await kms.destroyKey('exprsn-tenant-gone'); // again: nothing left, no error
  });

  it('uses vaulted keys when given instead of web identity, and has no other way to a credential', async () => {
    const user = aws.addUser({ userName: 'exprsn-kms-user' });
    const kms = createKms(testConfig({ ...awsEnv(), KMS_AWS_ROLE_ARN: '', KMS_AWS_WEB_IDENTITY_TOKEN_FILE: '', KMS_AWS_ACCESS_KEY_ID: user.accessKeyId, KMS_AWS_SECRET_ACCESS_KEY: user.secretAccessKey }));
    await kms.wrap('exprsn-tenant-keys', randomBytes(32), 'x');
    expect(aws.requests.at(-1)!.headers.authorization).toContain(`Credential=${user.accessKeyId}/`);
    // With neither, the credential function refuses rather than falling back to an SDK chain or the metadata service.
    const none = { ...testConfig(), KMS_AWS_ROLE_ARN: undefined, KMS_AWS_ACCESS_KEY_ID: undefined } as ReturnType<typeof testConfig>;
    await expect(awsInstallCredential(none)()).rejects.toThrow(/No AWS credential for the KMS/);
    // An endpoint at a metadata address is refused by the egress guard even when named.
    const meta = new AwsKms({ region: 'eu-central-1', endpoint: 'http://169.254.169.254/', credential: async () => ({ kind: 'aws', accessKeyId: 'AKIAFAKE', secretAccessKey: 'x', expiresAt: null }), transport: installTransport(testConfig({ SERVICE_ALLOWED_HOSTS: '169.254.169.254' }), 'aws') });
    await expect(meta.wrap('n', randomBytes(32), 'a')).rejects.toThrow(/metadata address/);
  });
});

describe('B-10208: Azure Key Vault (azure-keyvault)', () => {
  it('keeps an RSA key per tenant, wraps with the context bound in, and signs ES256 across a rotation', async () => {
    const kms = createKms(testConfig(azureEnv())) as AzureKeyVaultKms;
    expect(kms.kind).toBe('azure-keyvault');
    const dek = randomBytes(32);
    const w = await kms.wrap('exprsn-tenant-a', dek, 'dek:A:1');
    expect(w).toMatch(/^azure-kv:v1:[0-9a-f]{32}:/);
    expect((await kms.unwrap('exprsn-tenant-a', w, 'dek:A:1')).equals(dek)).toBe(true);
    await expect(kms.unwrap('exprsn-tenant-a', w, 'dek:A:2')).rejects.toThrow(/does not belong to this context/);
    await expect(kms.unwrap('exprsn-tenant-b', w, 'dek:A:1')).rejects.toThrow();
    const key = azure.keyVault.keys.get('exprsn-tenant-a')!;
    expect(key.versions[0]!.kty).toBe('RSA');
    expect(key.versions[0]!.ops).toEqual(['wrapKey', 'unwrapKey']);
    // The token came by workload identity (the federated token file as the client assertion).
    expect(azure.assertions.at(-1)!.claims!.sub).toBe(AZ_SUBJECT);

    const mac = await kms.hmac('exprsn-audit-checkpoints', 'payload');
    expect(mac.length).toBeLessThan(300);
    expect(await kms.verifyHmac('exprsn-audit-checkpoints', 'payload', mac)).toBe(true);
    expect(await kms.verifyHmac('exprsn-audit-checkpoints', 'other', mac)).toBe(false);
    await kms.rotateSigningKey('exprsn-audit-checkpoints');
    const mac2 = await kms.hmac('exprsn-audit-checkpoints', 'payload');
    expect(mac2.split(':')[2]).not.toBe(mac.split(':')[2]);
    const fresh = createKms(testConfig(azureEnv()));
    expect(await fresh.verifyHmac('exprsn-audit-checkpoints', 'payload', mac)).toBe(true);
    expect(await fresh.verifyHmac('exprsn-audit-checkpoints', 'payload', mac2)).toBe(true);
    expect((await kms.health()).ok).toBe(true);
  });

  it('asks for HSM keys when told to, and destroys (deletes and purges) a tenant key', async () => {
    const kms = createKms(testConfig({ ...azureEnv(), KMS_AZURE_HSM: 'true' }));
    const w = await kms.wrap('exprsn-tenant-hsm', randomBytes(32), 'a');
    expect(azure.keyVault.keys.get('exprsn-tenant-hsm')!.versions[0]!.kty).toBe('RSA-HSM');
    await kms.destroyKey('exprsn-tenant-hsm');
    expect(azure.keyVault.keys.has('exprsn-tenant-hsm')).toBe(false);
    expect(azure.keyVault.log.filter((l) => l.name === 'exprsn-tenant-hsm').map((l) => l.op)).toEqual(['create', 'wrapkey', 'delete', 'purge']);
    await expect(kms.unwrap('exprsn-tenant-hsm', w, 'a')).rejects.toThrow(/KeyNotFound/);
  });
});

describe('B-10208: configuration of the cloud KMSes', () => {
  const base = { NODE_ENV: 'test', SESSION_SECRET: randomBytes(32).toString('hex') };
  it('names what each provider needs, and refuses moving from a cloud KMS to itself', () => {
    expect(() => loadConfig({ ...base, KMS_PROVIDER: 'aws-kms' } as NodeJS.ProcessEnv)).toThrow(/KMS_AWS_REGION[\s\S]*needs a credential/);
    expect(() => loadConfig({ ...base, KMS_PROVIDER: 'aws-kms', KMS_AWS_REGION: 'eu-central-1', KMS_AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/x' } as NodeJS.ProcessEnv)).toThrow(/go together/);
    expect(() => loadConfig({ ...base, KMS_PROVIDER: 'aws-kms', KMS_AWS_REGION: 'eu-central-1', KMS_AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/x', KMS_AWS_WEB_IDENTITY_TOKEN_FILE: '/t', KMS_AWS_ACCESS_KEY_ID: 'AKIA', KMS_AWS_SECRET_ACCESS_KEY: 's' } as NodeJS.ProcessEnv)).toThrow(/not both/);
    expect(loadConfig({ ...base, KMS_PROVIDER: 'aws-kms', KMS_AWS_REGION: 'eu-central-1', KMS_AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/x', KMS_AWS_WEB_IDENTITY_TOKEN_FILE: '/t' } as NodeJS.ProcessEnv).KMS_PROVIDER).toBe('aws-kms');
    expect(() => loadConfig({ ...base, KMS_PROVIDER: 'azure-keyvault' } as NodeJS.ProcessEnv)).toThrow(/KMS_AZURE_VAULT_URL[\s\S]*AZURE_IDENTITY_TENANT_ID/);
    expect(() => loadConfig({ ...base, KMS_PROVIDER: 'aws-kms', KMS_PREVIOUS_PROVIDER: 'aws-kms', KMS_AWS_REGION: 'eu-central-1', KMS_AWS_ACCESS_KEY_ID: 'AKIA', KMS_AWS_SECRET_ACCESS_KEY: 's' } as NodeJS.ProcessEnv)).toThrow(/KMS_PREVIOUS_PROVIDER cannot be aws-kms/);
    // Without DATA_KEY: the cloud KMS needs none.
    expect(loadConfig({ ...base, ...awsEnv() } as NodeJS.ProcessEnv).DATA_KEY).toBeUndefined();
  });

  it('production refuses the cloud secrets inline in the environment and accepts their _FILE forms', () => {
    const dir = tmp('exprsn-kms-secret-');
    const file = path.join(dir, 's');
    writeFileSync(file, 'secret-from-a-file', { mode: 0o600 });
    const prod = { ...base, NODE_ENV: 'production', PUBLIC_URL: 'https://ai.example.com', KMS_PROVIDER: 'aws-kms', KMS_AWS_REGION: 'eu-central-1', KMS_AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE' };
    expect(() => loadConfig({ ...prod, KMS_AWS_SECRET_ACCESS_KEY: 'inline' } as NodeJS.ProcessEnv)).toThrow(/KMS_AWS_SECRET_ACCESS_KEY: production refuses cloud credentials given inline/);
    expect(loadConfig({ ...prod, KMS_AWS_SECRET_ACCESS_KEY_FILE: file } as NodeJS.ProcessEnv).KMS_AWS_SECRET_ACCESS_KEY).toBe('secret-from-a-file');
    const az = { ...base, NODE_ENV: 'production', PUBLIC_URL: 'https://ai.example.com', KMS_PROVIDER: 'azure-keyvault', KMS_AZURE_VAULT_URL: 'https://v.vault.azure.net', AZURE_IDENTITY_TENANT_ID: AZ_TENANT, AZURE_IDENTITY_CLIENT_ID: AZ_TENANT };
    expect(() => loadConfig({ ...az, AZURE_IDENTITY_CLIENT_SECRET: 'inline' } as NodeJS.ProcessEnv)).toThrow(/AZURE_IDENTITY_CLIENT_SECRET: production refuses/);
    expect(loadConfig({ ...az, AZURE_IDENTITY_CLIENT_SECRET_FILE: file } as NodeJS.ProcessEnv).KMS_PROVIDER).toBe('azure-keyvault');
    // A federated identity has no secret at all and is accepted as it is.
    expect(loadConfig({ ...az, AZURE_IDENTITY_FEDERATED_TOKEN_FILE: azTokenFile } as NodeJS.ProcessEnv).KMS_PROVIDER).toBe('azure-keyvault');
    // Production also refuses a plain-http KMS endpoint when backend TLS is required.
    expect(() => loadConfig({ ...prod, KMS_AWS_SECRET_ACCESS_KEY_FILE: file, KMS_AWS_ENDPOINT: 'http://kms.internal', REQUIRE_BACKEND_TLS: 'true' } as NodeJS.ProcessEnv)).toThrow(/AWS KMS endpoint without TLS/);
  });

  it('leaves local and OpenBao as they were', () => {
    expect(createKms(testConfig()).kind).toBe('local');
    const cfg = testConfig({ KMS_PROVIDER: 'aws-kms', KMS_PREVIOUS_PROVIDER: 'local', KMS_AWS_REGION: 'eu-central-1', KMS_AWS_ACCESS_KEY_ID: 'AKIA', KMS_AWS_SECRET_ACCESS_KEY: 's' });
    // Moving off local with no DATA_KEY_PREVIOUS: DATA_KEY itself is the previous key, as for OpenBao.
    expect(createPreviousKms(cfg)).toBeInstanceOf(LocalKms);
    expect(createPreviousKms(testConfig())).toBeNull();
  });
});

/** Services on a SQLite file, so a second set can open the same database with another KMS. */
async function servicesOn(env: Record<string, string>): Promise<{ s: Services; db: Db; tenantId: string; close: () => Promise<void> }> {
  const cfg = testConfig(env);
  const db = createDb(cfg);
  await migrate(db);
  const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
  await bootstrap(s);
  const tenantId = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!.id;
  return {
    s,
    db,
    tenantId,
    close: async () => {
      await s.close();
      await db.destroy();
    }
  };
}

/** Runs the real CLI (`exprsn-ai <cmd>`) in a child process with only the given environment. */
function cli(args: string[], env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  const tsx = path.resolve(here, '../../node_modules/.bin/tsx');
  return new Promise((resolve, reject) => {
    const child = spawn(tsx, [path.resolve(here, '../src/cli.ts'), ...args], { cwd: path.resolve(here, '..'), env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TMPDIR: tmpdir(), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (err += String(d)));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, out, err }));
  });
}

describe('B-10208 done when: kms:rewrap moves a tenant from local to aws-kms and audit:verify still passes', () => {
  it('re-wraps every data key and re-signs every checkpoint into AWS KMS; afterwards nothing needs the local key', async () => {
    const dir = tmp('exprsn-kms-cloud-');
    const oldKey = randomBytes(32).toString('base64');
    const common = { SQLITE_FILENAME: path.join(dir, 'db.sqlite'), BLOB_DIR: path.join(dir, 'blobs'), SESSION_SECRET: randomBytes(32).toString('hex') };

    // 1. A local install: sealed values, a rotated key, audit events, a signed checkpoint and a backup.
    const a = await servicesOn({ ...common, DATA_KEY: oldKey });
    const sealed = await a.s.keys.seal(a.tenantId, 'tenant secret', 'aad:1');
    await a.s.keys.rotate(a.tenantId);
    const sealed2 = await a.s.keys.seal(a.tenantId, 'after rotation', 'aad:2');
    const platform = await a.s.keys.seal('platform', 'platform secret', 'aad:p');
    await a.s.audit.append({ tenantId: a.tenantId, action: 'test.event', kind: 'admin', actor: { service: 'test' } });
    const cp1 = (await a.s.checkpoints.create(a.tenantId, 'test'))!;
    expect(cp1.signature).toMatch(/^local:v1:/);
    const backup = await a.s.ops.backups.createNow(by(a.tenantId));
    await a.close();

    // 2. Switched to AWS KMS with the local key as the previous one: reads fall back until the re-wrap is done.
    const moving = { ...common, ...awsEnv(), KMS_PREVIOUS_PROVIDER: 'local', DATA_KEY_PREVIOUS: oldKey };
    const b = await servicesOn(moving);
    expect(await b.s.keys.open(b.tenantId, sealed, 'aad:1')).toBe('tenant secret');
    expect((await b.s.checkpoints.verify(b.tenantId)).status).toBe('verified');
    await b.close();

    // 3. The real CLI: kms:rewrap, then audit:verify, each in its own process with only this environment.
    const env = { NODE_ENV: 'test', LOG_LEVEL: 'silent', DB_CLIENT: 'sqlite', PUBLIC_URL: 'http://localhost:8080', WEB_ROOT: '/nonexistent', JOB_QUEUE: 'db', ...moving };
    const rewrap = await cli(['kms:rewrap'], env);
    expect(rewrap.err.split('\n').filter((l) => l.startsWith('error:'))).toEqual([]);
    expect(rewrap.code).toBe(0);
    const report = JSON.parse(rewrap.out.slice(rewrap.out.indexOf('{'), rewrap.out.lastIndexOf('}') + 1)) as { target: string; verified: boolean; dataKeys: { total: number; rewrapped: number; failed: unknown[] }; checkpoints: { total: number; resigned: number }; backups: { rewrapped: number } };
    expect(report).toMatchObject({ target: 'aws-kms', verified: true, dataKeys: { total: 3, rewrapped: 3, failed: [] }, checkpoints: { total: 1, resigned: 1 }, backups: { rewrapped: 1 } });
    expect(rewrap.out).toContain('Every data key opens with the new key-encryption key');
    const verify = await cli(['audit:verify'], { ...env, KMS_PREVIOUS_PROVIDER: '', DATA_KEY_PREVIOUS: '' });
    expect(verify.code).toBe(0);
    expect(JSON.parse(verify.out)).toMatchObject({ status: 'verified', checkpoints: { failed: [] } });

    // 4. The local key removed (DATA_KEY is a fresh random key): everything opens and verifies from AWS KMS alone.
    const c = await servicesOn({ ...common, ...awsEnv() });
    expect(await c.s.keys.open(c.tenantId, sealed, 'aad:1')).toBe('tenant secret');
    expect(await c.s.keys.open(c.tenantId, sealed2, 'aad:2')).toBe('after rotation');
    expect(await c.s.keys.open('platform', platform, 'aad:p')).toBe('platform secret');
    const rows = (await c.db('tenant_keys').select('kms', 'key_name', 'wrapped')) as { kms: string; key_name: string; wrapped: string }[];
    expect(rows.every((r) => r.kms === 'aws-kms' && r.wrapped.startsWith('aws-kms:v1:'))).toBe(true);
    expect(aws.kms.aliases.has(`alias/${c.s.keys.kekName(c.tenantId)}`)).toBe(true);
    const resigned = (await c.db('audit_checkpoints').where({ id: cp1.id }).first()) as { signature: string };
    expect(resigned.signature).toMatch(/^aws-kms:v1:/);
    expect(resigned.signature.length).toBeLessThan(300);
    // The blob copy of the checkpoint carries the new signature too.
    const copy = JSON.parse((await c.s.blobs.get(cp1.blob_key!))!.toString('utf8')) as { signature: string };
    expect(copy.signature).toBe(resigned.signature);
    expect((await c.s.checkpoints.verify(c.tenantId)).status).toBe('verified');
    const drill = await c.s.ops.backups.drillNow(by(c.tenantId), backup.id);
    expect(drill.error).toBeNull();
    expect(drill.state).toBe('passed');

    // 5. The signing key rotated in AWS KMS: the checkpoint signed before verifies with the key it names, the next
    // checkpoint is signed with the new key, and audit:verify passes over both.
    await (createKms(testConfig(awsEnv())) as AwsKms).rotateSigningKey(`exprsn-audit-checkpoints`);
    await c.close();
    const d = await servicesOn({ ...common, ...awsEnv() });
    await d.s.audit.append({ tenantId: d.tenantId, action: 'test.after-rotation', kind: 'admin', actor: { service: 'test' } });
    const cp2 = (await d.s.checkpoints.create(d.tenantId, 'test'))!;
    expect(cp2.signature.split(':')[2]).not.toBe(resigned.signature.split(':')[2]);
    const v = await d.s.checkpoints.verify(d.tenantId);
    expect(v).toMatchObject({ status: 'verified', checkpoints: { checked: 2, failed: [] } });
    await d.close();

    // Without the re-wrap the local key could not have been dropped (the test would be vacuous otherwise).
    const e = await servicesOn({ ...common, SQLITE_FILENAME: path.join(tmp('exprsn-kms-cloud2-'), 'db.sqlite'), DATA_KEY: oldKey });
    const s2 = await e.s.keys.seal(e.tenantId, 'x', 'aad');
    await e.close();
    const f = await servicesOn({ ...common, SQLITE_FILENAME: e.s.cfg.SQLITE_FILENAME, ...awsEnv() });
    await expect(f.s.keys.open(f.tenantId, s2, 'aad')).rejects.toThrow();
    await f.close();
  }, 300_000);

  it('moves a tenant from local to Azure Key Vault the same way', async () => {
    const dir = tmp('exprsn-kms-azure-');
    const oldKey = randomBytes(32).toString('base64');
    const common = { SQLITE_FILENAME: path.join(dir, 'db.sqlite'), BLOB_DIR: path.join(dir, 'blobs'), SESSION_SECRET: randomBytes(32).toString('hex') };
    const a = await servicesOn({ ...common, DATA_KEY: oldKey });
    const sealed = await a.s.keys.seal(a.tenantId, 'tenant secret', 'aad:1');
    await a.s.audit.append({ tenantId: a.tenantId, action: 'test.event', kind: 'admin', actor: { service: 'test' } });
    await a.s.checkpoints.create(a.tenantId, 'test');
    await a.close();
    const b = await servicesOn({ ...common, ...azureEnv(), KMS_PREVIOUS_PROVIDER: 'local', DATA_KEY_PREVIOUS: oldKey });
    const r = await rewrapAll({ db: b.db, blobs: b.s.blobs, target: createKms(b.s.cfg), previous: createPreviousKms(b.s.cfg)!, kekName: (scope) => b.s.keys.kekName(scope), keys: b.s.keys });
    expect(r).toMatchObject({ target: 'azure-keyvault', verified: true, checkpoints: { resigned: 1, failed: [] } });
    await b.close();
    const c = await servicesOn({ ...common, ...azureEnv() });
    expect(await c.s.keys.open(c.tenantId, sealed, 'aad:1')).toBe('tenant secret');
    expect((await c.s.checkpoints.verify(c.tenantId)).status).toBe('verified');
    await c.close();
  }, 300_000);
});
