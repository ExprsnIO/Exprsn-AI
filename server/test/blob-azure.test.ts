/*
 * 1.9.99-final, Sprint 58 (B-10208): BLOB_STORE=azure against the fake Azure Blob service (`fake-azure-data.ts`):
 * the `BlobStore` contract (put, get, delete, streams, list, prefix delete), block uploads and ranged reads, Shared
 * Key and Entra authorisation, errors, the egress guard and the configuration. Never the real Azure.
 */
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { AzureBlobStore } from '../src/platform/blob-azure.js';
import { createBlobStore, type BlobStore } from '../src/platform/blob.js';
import { SwitchableBlobStore } from '../src/platform/blob-switch.js';
import { installTransport } from '../src/platform/cloud-identity.js';
import { FakeAzure } from './fake-azure.js';
import { testConfig } from './helpers.js';

const TENANT = '11111111-2222-3333-4444-555555555555';
const CONTAINER = 'exprsn-blobs';
let fake: FakeAzure;
let app: { clientId: string; secret?: string };

beforeAll(async () => {
  fake = await new FakeAzure().start();
  app = fake.addApp({ tenantId: TENANT, secret: true });
  fake.blobs.createContainer(CONTAINER);
});
afterAll(async () => fake.stop());

const CHUNK = AzureBlobStore.CHUNK_BYTES;
const PAGE = AzureBlobStore.LIST_PAGE;
afterEach(() => {
  AzureBlobStore.CHUNK_BYTES = CHUNK;
  AzureBlobStore.LIST_PAGE = PAGE;
});

const endpoint = () => `${fake.url}/${fake.blobs.account}`;
const entraEnv = () => ({ SERVICE_ALLOWED_HOSTS: '127.0.0.1', CLOUD_AZURE_AUTHORITY: fake.url, BLOB_STORE: 'azure', BLOB_AZURE_ENDPOINT: endpoint(), BLOB_AZURE_CONTAINER: CONTAINER, AZURE_IDENTITY_TENANT_ID: TENANT, AZURE_IDENTITY_CLIENT_ID: app.clientId, AZURE_IDENTITY_CLIENT_SECRET: app.secret! });
const keyEnv = () => ({ SERVICE_ALLOWED_HOSTS: '127.0.0.1', BLOB_STORE: 'azure', BLOB_AZURE_ENDPOINT: endpoint(), BLOB_AZURE_CONTAINER: CONTAINER, BLOB_AZURE_ACCOUNT: fake.blobs.account, BLOB_AZURE_ACCOUNT_KEY: fake.blobs.accountKey });
const entraStore = () => createBlobStore(testConfig(entraEnv()));
const keyStore = () => createBlobStore(testConfig(keyEnv()));

const collect = async (s: Readable) => {
  const parts: Buffer[] = [];
  for await (const c of s) parts.push(c as Buffer);
  return Buffer.concat(parts);
};
async function* pieces(b: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let i = 0; i < b.length; i += size) yield b.subarray(i, Math.min(b.length, i + size));
}
const keysOf = async (s: BlobStore, prefix: string) => {
  const out: string[] = [];
  for await (const o of s.list(prefix)) out.push(o.key);
  return out.sort();
};

describe.each([
  ['an Entra token (the install identity)', entraStore],
  ['Shared Key (the account key)', keyStore]
])('B-10208: the BlobStore contract on Azure Blob, by %s', (_label, make) => {
  it('puts, gets, replaces and deletes objects; a missing one is null', async () => {
    const s = make();
    expect(s.kind).toBe('azure');
    const k = `contract/${randomBytes(4).toString('hex')}/a.json`;
    expect(await s.get(k)).toBeNull();
    expect(await s.getStream(k)).toBeNull();
    await s.put(k, Buffer.from('{"a":1}'), 'application/json');
    expect((await s.get(k))!.toString()).toBe('{"a":1}');
    const stored = fake.blobs.containers.get(CONTAINER)!.get(k)!;
    expect(stored.contentType).toBe('application/json');
    await s.put(k, Buffer.from('second'));
    expect((await s.get(k))!.toString()).toBe('second');
    await s.delete(k);
    expect(await s.get(k)).toBeNull();
    await s.delete(k); // deleting what is gone is not an error
    expect((await s.health()).ok).toBe(true);
  });

  it('keeps binary bytes and empty objects intact', async () => {
    const s = make();
    const bin = randomBytes(4096);
    await s.put('contract/bin.dat', bin);
    expect((await s.get('contract/bin.dat'))!.equals(bin)).toBe(true);
    await s.put('contract/empty.txt', Buffer.alloc(0));
    expect((await s.get('contract/empty.txt'))!.length).toBe(0);
    const st = await s.getStream('contract/empty.txt');
    expect(st!.size).toBe(0);
    expect((await collect(st!.stream)).length).toBe(0);
  });

  it('refuses keys that are not safe relative paths', async () => {
    const s = make();
    await expect(s.put('../escape', Buffer.from('x'))).rejects.toThrow(/Invalid blob key/);
    await expect(s.get('a//b')).rejects.toThrow(/Invalid blob key/);
  });
});

describe('B-10208: Azure Blob streaming', () => {
  it('uploads a stream as staged blocks and one block list, and reads it back in ranges', async () => {
    AzureBlobStore.CHUNK_BYTES = 1024;
    const s = entraStore();
    const data = randomBytes(5 * 1024 + 300);
    const before = fake.requests.length;
    const r = await s.putStream('stream/big.bin', pieces(data, 700), 'application/x-test');
    expect(r.bytes).toBe(data.length);
    const calls = fake.requests.slice(before);
    expect(calls.filter((c) => c.op === 'blob:PUT blob:block')).toHaveLength(6);
    expect(calls.filter((c) => c.op === 'blob:PUT blob:blocklist')).toHaveLength(1);
    expect(fake.blobs.containers.get(CONTAINER)!.get('stream/big.bin')!.contentType).toBe('application/x-test');

    const mark = fake.requests.length;
    const st = await s.getStream('stream/big.bin');
    expect(st!.size).toBe(data.length);
    expect((await collect(st!.stream)).equals(data)).toBe(true);
    const reads = fake.requests.slice(mark).filter((c) => c.op === 'blob:GET blob');
    expect(reads).toHaveLength(6);
    expect(reads.every((c) => /^bytes=\d+-\d+$/.test(c.headers['x-ms-range'] ?? ''))).toBe(true);
    // Every read after the first is pinned to the first one's ETag.
    expect(reads.slice(1).every((c) => !!c.headers['if-match'])).toBe(true);
    expect((await s.get('stream/big.bin'))!.equals(data)).toBe(true);
  });

  it('sends a stream of at most one chunk as a single Put Blob; put of a large buffer uses blocks', async () => {
    AzureBlobStore.CHUNK_BYTES = 1024;
    const s = entraStore();
    const before = fake.requests.length;
    await s.putStream('stream/one.bin', pieces(randomBytes(1024), 100));
    const calls = fake.requests.slice(before);
    expect(calls.filter((c) => c.op === 'blob:PUT blob')).toHaveLength(1);
    expect(calls.some((c) => c.op === 'blob:PUT blob:block')).toBe(false);
    const big = randomBytes(3000);
    await s.put('stream/buffer.bin', big);
    expect((await s.get('stream/buffer.bin'))!.equals(big)).toBe(true);
    expect(fake.requests.slice(before).filter((c) => c.op === 'blob:PUT blob:block').length).toBe(3);
  });

  it('a failed upload leaves no object behind', async () => {
    AzureBlobStore.CHUNK_BYTES = 1024;
    const s = entraStore();
    const failing = async function* () {
      yield randomBytes(1500);
      throw new Error('source broke');
    };
    await expect(s.putStream('stream/broken.bin', failing())).rejects.toThrow(/source broke/);
    expect(await s.get('stream/broken.bin')).toBeNull();
  });

  it('a read fails rather than mixing two versions when the object is replaced meanwhile', async () => {
    AzureBlobStore.CHUNK_BYTES = 1024;
    const s = entraStore();
    await s.put('stream/changing.bin', randomBytes(1000));
    await s.putStream('stream/changing.bin', Readable.from([randomBytes(4000)]));
    const st = await s.getStream('stream/changing.bin');
    await s.put('stream/changing.bin', randomBytes(10));
    await expect(collect(st!.stream)).rejects.toThrow(/changed while it was read/);
  });
});

describe('B-10208: Azure Blob listing and prefix delete', () => {
  it('lists by prefix across pages, with sizes and times, and deletes a prefix only', async () => {
    AzureBlobStore.LIST_PAGE = 2;
    const s = keyStore();
    for (const k of ['t/x/1', 't/x/2', 't/x/3', 't/x/sub/4', 't/y/1', 't/xx/1']) await s.put(k, Buffer.from(k));
    expect(await keysOf(s, 't/x')).toEqual(['t/x/1', 't/x/2', 't/x/3', 't/x/sub/4']);
    expect(await keysOf(s, 't/x/')).toEqual(['t/x/1', 't/x/2', 't/x/3', 't/x/sub/4']);
    const one = (await (async () => {
      for await (const o of s.list('t/y')) return o;
      return null;
    })())!;
    expect(one).toMatchObject({ key: 't/y/1', size: 5 });
    expect(one.modified).toBeGreaterThan(Date.now() - 60_000);
    const pages = fake.calls('blob:GET container:list').filter((c) => c.query.get('prefix') === 't/x/');
    expect(pages.some((c) => !!c.query.get('marker'))).toBe(true);
    expect(await s.deletePrefix('t/x')).toBe(4);
    expect(await keysOf(s, 't/x')).toEqual([]);
    expect(await keysOf(s, 't/xx')).toEqual(['t/xx/1']);
    expect(await keysOf(s, 't/y')).toEqual(['t/y/1']);
    expect((await keysOf(s, '')).length).toBeGreaterThanOrEqual(2);
  });

  it('works behind the switchable store, which reports the azure kind', async () => {
    const sw = new SwitchableBlobStore(entraStore());
    expect(sw.kind).toBe('azure');
    await sw.put('switch/a', Buffer.from('a'));
    expect((await sw.get('switch/a'))!.toString()).toBe('a');
  });
});

describe('B-10208: Azure Blob errors and guards', () => {
  it('names the service error: a missing container, a wrong account key, a refused identity', async () => {
    const missing = createBlobStore(testConfig({ ...entraEnv(), BLOB_AZURE_CONTAINER: 'not-there' }));
    await expect(missing.put('a', Buffer.from('x'))).rejects.toThrow(/404 ContainerNotFound/);
    expect((await missing.health()).ok).toBe(false);

    const badKey = createBlobStore(testConfig({ ...keyEnv(), BLOB_AZURE_ACCOUNT_KEY: randomBytes(64).toString('base64') }));
    const bad = fake.blobs.badSignatures;
    await expect(badKey.get('a')).rejects.toThrow(/403 AuthenticationFailed/);
    expect(fake.blobs.badSignatures).toBe(bad + 1);

    const refused = createBlobStore(testConfig({ ...entraEnv(), AZURE_IDENTITY_CLIENT_SECRET: 'not-the-secret' }));
    await expect(refused.get('a')).rejects.toThrow(/Entra refused the token request/);
  });

  it('never calls a metadata address, and calls a host outside the provider list only when it is allowed', async () => {
    const meta = new AzureBlobStore({ endpoint: 'http://169.254.169.254/acct', container: CONTAINER, accountKey: fake.blobs.accountKey, account: 'acct', transport: installTransport(testConfig({ SERVICE_ALLOWED_HOSTS: '169.254.169.254' }), 'azure') });
    await expect(meta.get('a')).rejects.toThrow(/metadata address/);
    const unlisted = createBlobStore(testConfig({ ...keyEnv(), SERVICE_ALLOWED_HOSTS: '' }));
    await expect(unlisted.get('a')).rejects.toThrow(/refused/);
  });

  it('every call goes through the cloud transport (the rate limiter and breaker see it)', async () => {
    const t = installTransport(testConfig({ SERVICE_ALLOWED_HOSTS: '127.0.0.1' }), 'azure');
    const s = new AzureBlobStore({ endpoint: endpoint(), container: CONTAINER, account: fake.blobs.account, accountKey: fake.blobs.accountKey, transport: t });
    await s.put('transport/a', Buffer.from('a'));
    await s.get('transport/a');
    expect(t.stats.calls).toBe(2);
  });
});

describe('B-10208: the Azure blob store configuration', () => {
  const base = { NODE_ENV: 'test', SESSION_SECRET: randomBytes(32).toString('hex'), DATA_KEY: randomBytes(32).toString('base64'), BLOB_STORE: 'azure' };
  it('needs the endpoint, the container and a credential', () => {
    expect(() => loadConfig({ ...base } as NodeJS.ProcessEnv)).toThrow(/BLOB_AZURE_ENDPOINT and BLOB_AZURE_CONTAINER/);
    expect(() => loadConfig({ ...base, BLOB_AZURE_ENDPOINT: 'https://acct.blob.core.windows.net', BLOB_AZURE_CONTAINER: 'cont1' } as NodeJS.ProcessEnv)).toThrow(/BLOB_AZURE_ACCOUNT_KEY_FILE, or the install's Azure identity/);
    expect(loadConfig({ ...base, BLOB_AZURE_ENDPOINT: 'https://acct.blob.core.windows.net', BLOB_AZURE_CONTAINER: 'cont1', BLOB_AZURE_ACCOUNT_KEY: 'a2V5' } as NodeJS.ProcessEnv).BLOB_STORE).toBe('azure');
    expect(() => loadConfig({ ...base, BLOB_AZURE_ENDPOINT: 'https://10.0.0.5', BLOB_AZURE_CONTAINER: 'cont1', BLOB_AZURE_ACCOUNT_KEY: 'a2V5' } as NodeJS.ProcessEnv)).toThrow(/BLOB_AZURE_ACCOUNT/);
  });
  it('production refuses the account key inline (only BLOB_AZURE_ACCOUNT_KEY_FILE)', () => {
    const prod = { ...base, NODE_ENV: 'production', PUBLIC_URL: 'https://ai.example.com', BLOB_AZURE_ENDPOINT: 'https://acct.blob.core.windows.net', BLOB_AZURE_CONTAINER: 'cont1', BLOB_AZURE_ACCOUNT_KEY: 'a2V5' };
    delete (prod as Record<string, string>).DATA_KEY;
    expect(() => loadConfig(prod as NodeJS.ProcessEnv)).toThrow(/BLOB_AZURE_ACCOUNT_KEY: production refuses cloud credentials/);
  });
});
