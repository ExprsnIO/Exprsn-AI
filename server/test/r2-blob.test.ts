import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CloudflareProvider, type CallContext } from '../src/cloud/providers/index.js';
import { autoJurisdiction, bucketJurisdiction, isR2Endpoint, jurisdictionOfRegion, r2BlobSettings, r2Endpoint, regionOfJurisdiction } from '../src/cloud/r2.js';
import { cloudTags } from '../src/cloud/tags.js';
import type { CloudAccount } from '../src/cloud/types.js';
import { createDb, migrate } from '../src/db/knex.js';
import { createLogger, Metrics } from '../src/observability/index.js';
import { S3BlobStore } from '../src/platform/blob.js';
import { servicePolicy } from '../src/platform/egress.js';
import { createServices } from '../src/services.js';
import { FakeCloudflare } from './fake-cloudflare.js';
import { harness, testConfig } from './helpers.js';
import { FakeS3 } from './sprint23-fakes.js';

/*
 * 1.9.99-final, Sprint 61 (B-10906): R2 as an object store. Buckets are provisioned with an EU or FedRAMP
 * jurisdiction (the `cf-r2-jurisdiction` header, against `fake-cloudflare.ts`); the install keeps its blobs there
 * through `BLOB_STORE=s3` (R2's S3 API: region `auto`, path style), here the S3 fake of Sprint 23 standing in for an
 * R2 bucket; and a backup written to it restores as `backup:restore` does (from and into the configured store).
 * Nothing reaches Cloudflare: a real R2 endpoint is refused by the offline guard.
 */

const policy = servicePolicy({ SERVICE_ALLOWED_HOSTS: '127.0.0.1' });
const transport = { sleep: async () => undefined, random: () => 0.5, maxRetryWaitMs: 60_000 };

const account = (cfId: string): CloudAccount => ({ id: 'acc-r2', name: 'edge', provider: 'cloudflare', scope: 'platform', tenantId: null, providerIds: { cloudflareAccountId: cfId }, credentialMode: 'vaulted', defaultRegion: 'global', state: 'active', description: null, regions: [], validation: null, createdBy: null, createdAt: 0, updatedAt: 0 });

describe('R2 jurisdictions in provisioning', () => {
  const fake = new FakeCloudflare();
  let p: CloudflareProvider;
  let ctx: CallContext;
  const tags = cloudTags({ account: 'edge', deployment: 'main' });

  beforeAll(async () => {
    await fake.start();
    const t = fake.addToken(['Workers R2 Storage Write']);
    p = new CloudflareProvider({ policy, ...transport, endpoints: { api: fake.url } });
    ctx = { account: account(fake.accountId), cred: { kind: 'token', token: t.value } };
  });
  afterAll(() => fake.stop());

  it('maps regions and jurisdictions both ways', () => {
    expect(jurisdictionOfRegion('r2-eu')).toBe('eu');
    expect(jurisdictionOfRegion('r2-fedramp')).toBe('fedramp');
    expect(jurisdictionOfRegion('global')).toBeNull();
    expect(regionOfJurisdiction('eu')).toBe('r2-eu');
    expect(bucketJurisdiction({}, 'r2-eu')).toBe('eu');
    expect(bucketJurisdiction({ jurisdiction: 'fedramp' }, 'r2-eu')).toBe('fedramp');
    expect(bucketJurisdiction({}, null)).toBe('default');
    expect(autoJurisdiction('aws', 'eu-central-1')).toBe('eu');
    expect(autoJurisdiction('aws', 'us-east-1')).toBe('default');
    expect(autoJurisdiction('digitalocean', 'fra1')).toBe('eu');
  });

  it('creates an EU bucket with the jurisdiction header, finds it only there, and deletes it there', async () => {
    const r = await p.create(ctx, { type: 'bucket', name: 'blobs', idempotencyKey: 'b-eu', tags, props: { jurisdiction: 'eu' } });
    expect(r).toMatchObject({ done: true, resource: { providerId: 'exprsn-edge-blobs', props: { jurisdiction: 'eu' }, locator: { jurisdiction: 'eu' } } });
    expect(fake.buckets.get('exprsn-edge-blobs')).toMatchObject({ jurisdiction: 'eu' });
    const create = fake.calls(/^POST .*\/r2\/buckets$/).at(-1)!;
    expect(create.headers['cf-r2-jurisdiction']).toBe('eu');
    // Adopted on a second create (looked up in its jurisdiction), and absent from the default jurisdiction.
    expect(await p.create(ctx, { type: 'bucket', name: 'blobs', idempotencyKey: 'b-eu', tags, props: { jurisdiction: 'eu' } })).toMatchObject({ adopted: true });
    expect(await p.describe(ctx, { type: 'bucket', providerId: 'exprsn-edge-blobs' })).toBeNull();
    expect(await p.describe(ctx, { type: 'bucket', providerId: 'exprsn-edge-blobs', locator: { jurisdiction: 'eu' } })).toMatchObject({ props: { jurisdiction: 'eu' } });
    const listed = await p.list(ctx, 'bucket', { managedOnly: true });
    expect(listed.map((b) => [b.providerId, b.props.jurisdiction ?? 'default'])).toEqual([['exprsn-edge-blobs', 'eu']]);
    await p.delete(ctx, { type: 'bucket', providerId: 'exprsn-edge-blobs', locator: { jurisdiction: 'eu' } });
    expect(fake.buckets.size).toBe(0);
  });

  it('takes the FedRAMP jurisdiction from the bucket\'s region (r2-fedramp), and none for the global edge', async () => {
    await p.create({ ...ctx, region: 'r2-fedramp' }, { type: 'bucket', name: 'gov', idempotencyKey: 'b-gov', tags, region: 'r2-fedramp', props: {} });
    expect(fake.buckets.get('exprsn-edge-gov')).toMatchObject({ jurisdiction: 'fedramp' });
    await p.create(ctx, { type: 'bucket', name: 'plain', idempotencyKey: 'b-plain', tags, props: {} });
    expect(fake.buckets.get('exprsn-edge-plain')).toMatchObject({ jurisdiction: 'default' });
    expect(fake.calls(/^POST .*\/r2\/buckets$/).at(-1)!.headers['cf-r2-jurisdiction']).toBeUndefined();
  });
});

describe('R2 through BLOB_STORE=s3', () => {
  const cfId = randomBytes(16).toString('hex');
  const keyId = 'r2keyid0000000000000000000000000';
  let fake: FakeS3;

  beforeAll(async () => {
    fake = await new FakeS3('exprsn-blobs', keyId).start();
  });
  afterAll(() => fake.stop());

  it('names the account endpoint per jurisdiction, region auto and path style', () => {
    expect(r2Endpoint(cfId)).toBe(`https://${cfId}.r2.cloudflarestorage.com`);
    expect(r2Endpoint(cfId, 'eu')).toBe(`https://${cfId}.eu.r2.cloudflarestorage.com`);
    expect(r2Endpoint(cfId, 'fedramp')).toBe(`https://${cfId}.fedramp.r2.cloudflarestorage.com`);
    expect(() => r2Endpoint('not-an-id')).toThrow(/32 hexadecimal/);
    expect(isR2Endpoint(r2Endpoint(cfId, 'eu'))).toBe(true);
    expect(isR2Endpoint('https://s3.eu-west-1.amazonaws.com')).toBe(false);
    const env = r2BlobSettings(cfId, 'exprsn-blobs', 'eu');
    expect(env).toEqual({ BLOB_STORE: 's3', S3_ENDPOINT: `https://${cfId}.eu.r2.cloudflarestorage.com`, S3_REGION: 'auto', S3_BUCKET: 'exprsn-blobs', S3_FORCE_PATH_STYLE: 'true' });
    // The config accepts it as an S3 store (the secret is a file in production; inline here).
    const cfg = testConfig({ ...env, S3_ACCESS_KEY_ID: keyId, S3_SECRET_ACCESS_KEY: 'x'.repeat(64) });
    expect(cfg.BLOB_STORE).toBe('s3');
    expect(cfg.S3_REGION).toBe('auto');
  });

  it('writes, streams in parts, lists and deletes objects signed for region auto', async () => {
    const store = new S3BlobStore({ endpoint: fake.url, region: 'auto', bucket: 'exprsn-blobs', accessKeyId: keyId, secretAccessKey: 'r2-secret', pathStyle: true });
    await store.put('exports/a.json', Buffer.from('{"a":1}'), 'application/json');
    expect((await store.get('exports/a.json'))!.toString()).toBe('{"a":1}');
    const before = S3BlobStore.PART_BYTES;
    S3BlobStore.PART_BYTES = 1024;
    try {
      const big = randomBytes(3000);
      const r = await store.putStream('training/artefact.bin', (async function* () {
        yield big.subarray(0, 1500);
        yield big.subarray(1500);
      })());
      expect(r.bytes).toBe(3000);
      expect(fake.blobs.get('training/artefact.bin')!.equals(big)).toBe(true);
    } finally {
      S3BlobStore.PART_BYTES = before;
    }
    const keys: string[] = [];
    for await (const o of store.list('')) keys.push(o.key);
    expect(keys.sort()).toEqual(['exports/a.json', 'training/artefact.bin']);
    await store.delete('exports/a.json');
    expect(await store.get('exports/a.json')).toBeNull();
    expect(fake.requests.every((r) => r.region === 'auto')).toBe(true);
    expect(fake.requests.some((r) => r.path.includes('uploads'))).toBe(true);
    await store.deletePrefix('training');
  });

  it('refuses a real R2 endpoint in tests (the offline guard)', async () => {
    const store = new S3BlobStore({ endpoint: r2Endpoint(cfId, 'eu'), region: 'auto', bucket: 'exprsn-blobs', accessKeyId: keyId, secretAccessKey: 's', pathStyle: true });
    await expect(store.get('x')).rejects.toThrow(/real cloud host blocked in tests/);
  });

  it('restores a backup written to R2 with backup:restore', async () => {
    const env = { BLOB_STORE: 's3', S3_ENDPOINT: fake.url, S3_REGION: 'auto', S3_BUCKET: 'exprsn-blobs', S3_FORCE_PATH_STYLE: 'true', S3_ACCESS_KEY_ID: keyId, S3_SECRET_ACCESS_KEY: 'r2-secret' };
    const secret = randomBytes(32).toString('hex');
    const dataKey = randomBytes(32).toString('base64');
    const h = await harness({ ...env, SESSION_SECRET: secret, DATA_KEY: dataKey });
    try {
      expect(h.s.blobs.kind).toBe('s3');
      const sealed = await h.s.keys.seal(h.tenantId, 'kept in R2', 'aad:r2');
      const b = await h.s.ops.backups.createNow({ tenantId: h.tenantId, actor: { service: 'test' }, userId: null });
      expect(b.state).toBe('succeeded');
      expect([...fake.blobs.keys()].some((k) => k === `platform/backups/${b.id}.manifest.json`)).toBe(true);
      // The archive reached R2 sealed: no plain row text in it.
      const bin = fake.blobs.get(`platform/backups/${b.id}.bin`)!;
      expect(bin.includes(Buffer.from('kept in R2'))).toBe(false);

      // An empty database configured with the same R2 bucket and keys: `backup:restore --backup <id>` reads the
      // backup from the configured store and writes the blob objects back into it.
      const cfg = testConfig({ ...env, SESSION_SECRET: secret, DATA_KEY: dataKey });
      const db = createDb(cfg);
      await migrate(db);
      const t = createServices(cfg, db, createLogger('silent', false), new Metrics());
      try {
        const r = await t.ops.backups.restoreInto({ target: db, client: 'sqlite', kms: t.kms, from: t.blobs, blobsTo: t.blobs, backupId: b.id, force: false });
        expect(r.rows).toBeGreaterThan(0);
        expect(r.wiped).toBe(false);
        expect(await t.keys.open(h.tenantId, sealed, 'aad:r2')).toBe('kept in R2');
        expect(await db('tenants').where({ id: h.tenantId }).first()).toBeTruthy();
      } finally {
        await t.close();
        await db.destroy();
      }
    } finally {
      await h.close();
    }
  }, 60_000);
});
