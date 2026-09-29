import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalKms, OpenBaoKms } from '../src/platform/kms.js';
import { DataKeys, KeyDestroyedError } from '../src/platform/datakeys.js';
import { checkKey, FsBlobStore, signV4 } from '../src/platform/blob.js';
import { TOPICS } from '../src/platform/bus.js';
import type { JobProgressEvent } from '../src/platform/jobs.js';
import { csvField } from '../src/audit/exports.js';
import { harness, type Harness } from './helpers.js';

describe('local KMS', () => {
  const kms = new LocalKms(randomBytes(32).toString('base64'));

  it('wraps and unwraps bound to the key name and context', async () => {
    const dek = randomBytes(32);
    const w = await kms.wrap('tenant-a', dek, 'ctx');
    expect(await kms.unwrap('tenant-a', w, 'ctx')).toEqual(dek);
    await expect(kms.unwrap('tenant-b', w, 'ctx')).rejects.toThrow();
    await expect(kms.unwrap('tenant-a', w, 'other')).rejects.toThrow();
  });

  it('signs and verifies HMACs per key', async () => {
    const mac = await kms.hmac('audit', 'payload');
    expect(await kms.verifyHmac('audit', 'payload', mac)).toBe(true);
    expect(await kms.verifyHmac('audit', 'payload!', mac)).toBe(false);
    expect(await kms.verifyHmac('other', 'payload', mac)).toBe(false);
  });
});

/** A minimal OpenBao transit engine: enough of its HTTP API to exercise the adapter. */
function fakeOpenBao(token: string) {
  const keys = new Map<string, Buffer>();
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (status: number, data?: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(data === undefined ? '' : JSON.stringify(data));
      };
      if (req.headers['x-vault-token'] !== token && req.url !== '/v1/sys/health') return send(403, { errors: ['permission denied'] });
      const m = /^\/v1\/transit\/(keys|encrypt|decrypt|hmac|verify)\/([^/]+)(?:\/(config|sha2-256))?$/.exec(req.url ?? '');
      if (req.url === '/v1/sys/health') return send(200, { initialized: true, sealed: false });
      if (!m) return send(404, { errors: ['no handler'] });
      const [, op, name] = m;
      const b = body ? JSON.parse(body) : {};
      const key = keys.get(name!);
      switch (op) {
        case 'keys':
          if (req.method === 'DELETE') {
            keys.delete(name!);
            return send(204);
          }
          if (!key && !m[3]) keys.set(name!, randomBytes(32));
          return send(204);
        case 'encrypt':
          if (!key) return send(400, { errors: ['no key'] });
          return send(200, { data: { ciphertext: 'vault:v1:' + Buffer.concat([key.subarray(0, 4), Buffer.from(b.plaintext, 'base64')]).toString('base64') } });
        case 'decrypt': {
          if (!key) return send(400, { errors: ['no key'] });
          const raw = Buffer.from(String(b.ciphertext).slice(9), 'base64');
          if (!raw.subarray(0, 4).equals(key.subarray(0, 4))) return send(400, { errors: ['bad ciphertext'] });
          return send(200, { data: { plaintext: raw.subarray(4).toString('base64') } });
        }
        case 'hmac':
          return send(200, { data: { hmac: 'vault:v1:' + Buffer.from(name + b.input).toString('base64') } });
        case 'verify':
          return send(200, { data: { valid: b.hmac === 'vault:v1:' + Buffer.from(name + b.input).toString('base64') } });
      }
    });
  });
  return { server, keys };
}

describe('OpenBao transit KMS', () => {
  let srv: ReturnType<typeof fakeOpenBao>;
  let addr: string;
  beforeEach(async () => {
    srv = fakeOpenBao('root-token');
    await new Promise<void>((r) => srv.server.listen(0, '127.0.0.1', r));
    addr = `http://127.0.0.1:${(srv.server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise((r) => srv.server.close(r));
  });

  it('creates keys, wraps, unwraps, signs, and destroys', async () => {
    const kms = new OpenBaoKms(addr, () => 'root-token');
    const dek = randomBytes(32);
    const w = await kms.wrap('exprsn-tenant-a', dek, 'dek:a:1');
    expect(w).toMatch(/^vault:v1:/);
    expect(await kms.unwrap('exprsn-tenant-a', w, 'dek:a:1')).toEqual(dek);
    await expect(kms.unwrap('exprsn-tenant-a', w, 'dek:b:1')).rejects.toThrow(/context/);
    const mac = await kms.hmac('exprsn-audit', 'x');
    expect(await kms.verifyHmac('exprsn-audit', 'x', mac)).toBe(true);
    expect((await kms.health()).ok).toBe(true);
    await kms.destroyKey('exprsn-tenant-a');
    expect(srv.keys.has('exprsn-tenant-a')).toBe(false);
    await expect(kms.unwrap('exprsn-tenant-a', w, 'dek:a:1')).rejects.toThrow();
  });

  it('fails closed with a bad token', async () => {
    const kms = new OpenBaoKms(addr, () => 'wrong');
    await expect(kms.wrap('k', randomBytes(32), 'a')).rejects.toThrow(/403/);
  });
});

describe('per-tenant data keys', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => h.close());

  it('seals per tenant, keeps old versions readable after rotation, and crypto-shreds on destroy', async () => {
    const keys = h.s.keys;
    const a1 = await keys.seal('tenant-a', 'hello', 'row-1');
    expect(a1).toMatch(/^v2\./);
    expect(await keys.open('tenant-a', a1, 'row-1')).toBe('hello');
    await expect(keys.open('tenant-a', a1, 'row-2')).rejects.toThrow();
    await expect(keys.open('tenant-b', a1, 'row-1')).rejects.toThrow();

    expect((await keys.rotate('tenant-a')).version).toBe(2);
    const a2 = await keys.seal('tenant-a', 'world', 'row-2');
    expect(a2.split('.')[1]).not.toBe(a1.split('.')[1]);
    // a fresh instance (no cache) still opens both
    const fresh = new DataKeys(h.s.db, h.s.kms, h.s.cfg.OPENBAO_KEY_PREFIX, undefined, h.s.bus);
    expect(await fresh.open('tenant-a', a1, 'row-1')).toBe('hello');
    expect(await fresh.open('tenant-a', a2, 'row-2')).toBe('world');

    await keys.destroy('tenant-a');
    await expect(fresh.open('tenant-a', a1, 'row-1')).rejects.toBeInstanceOf(KeyDestroyedError);
    await expect(keys.seal('tenant-a', 'again', 'x')).rejects.toBeInstanceOf(KeyDestroyedError);
  });

  it('still opens TOTP seeds sealed with DATA_KEY before the KMS', async () => {
    const { SecretBox } = await import('../src/crypto/index.js');
    const legacy = new SecretBox(h.s.cfg.DATA_KEY!).seal('seed', 'totp:1');
    expect(await h.s.keys.open('platform', legacy, 'totp:1')).toBe('seed');
  });
});

describe('blob store', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'exprsn-blob-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('stores, reads, and deletes by prefix', async () => {
    const b = new FsBlobStore(dir);
    await b.put('exports/t1/a.csv', Buffer.from('a'));
    await b.put('exports/t1/sub/b.csv', Buffer.from('b'));
    await b.put('exports/t2/c.csv', Buffer.from('c'));
    expect((await b.get('exports/t1/a.csv'))?.toString()).toBe('a');
    expect(await b.get('exports/t1/none')).toBeNull();
    expect(await b.deletePrefix('exports/t1')).toBe(2);
    expect(await b.get('exports/t1/a.csv')).toBeNull();
    expect((await b.get('exports/t2/c.csv'))?.toString()).toBe('c');
  });

  it('refuses keys that escape the store', () => {
    for (const k of ['../etc/passwd', 'a/../../b', '/abs', 'a//b', '']) expect(() => checkKey(k)).toThrow();
  });

  it('signs S3 requests with SigV4 (AWS documented example)', () => {
    // "Example: GET Object" from the AWS Signature Version 4 documentation.
    const h = signV4({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { range: 'bytes=0-9' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      region: 'us-east-1',
      service: 's3',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      date: new Date('2013-05-24T00:00:00Z')
    });
    expect(h.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'
    );
  });
});

describe('job queue (database mode)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => h.close());

  it('runs a job, reports progress, and records the result', async () => {
    const seen: JobProgressEvent[] = [];
    h.s.bus.on<JobProgressEvent>(TOPICS.jobProgress, (e) => seen.push({ ...e }));
    h.s.jobs.register('test.ok', async (p, ctx) => {
      await ctx.progress(50, 'half');
      return { doubled: Number(p.n) * 2 };
    });
    const job = await h.s.jobs.enqueue({ tenantId: h.tenantId, type: 'test.ok', payload: { n: 21 }, createdBy: 'u1' });
    expect(await h.s.jobs.runDue()).toBe(1);
    const done = await h.s.jobs.get(h.tenantId, job.id);
    expect(done).toMatchObject({ state: 'succeeded', progress: 100, result: { doubled: 42 }, attempts: 1 });
    expect(seen.map((e) => e.state)).toEqual(['queued', 'running', 'running', 'succeeded']);
    expect(seen[2]).toMatchObject({ progress: 50, message: 'half', createdBy: 'u1' });
  });

  it('retries with backoff, then fails', async () => {
    let calls = 0;
    h.s.jobs.register('test.fail', async () => {
      calls++;
      throw new Error('boom');
    });
    const job = await h.s.jobs.enqueue({ tenantId: h.tenantId, type: 'test.fail', maxAttempts: 2 });
    await h.s.jobs.runDue();
    let row = await h.s.jobs.get(h.tenantId, job.id);
    expect(row).toMatchObject({ state: 'queued', attempts: 1, error: 'boom' });
    expect(row!.run_at).toBeGreaterThan(Date.now());
    await h.s.db('jobs').where({ id: job.id }).update({ run_at: Date.now() });
    await h.s.jobs.runDue();
    row = await h.s.jobs.get(h.tenantId, job.id);
    expect(row).toMatchObject({ state: 'failed', attempts: 2 });
    expect(calls).toBe(2);
  });

  it('deduplicates by key and cancels queued jobs', async () => {
    h.s.jobs.register('test.noop', async () => null);
    const a = await h.s.jobs.enqueue({ tenantId: h.tenantId, type: 'test.noop', dedupeKey: 'k1' });
    const b = await h.s.jobs.enqueue({ tenantId: h.tenantId, type: 'test.noop', dedupeKey: 'k1' });
    expect(b.id).toBe(a.id);
    const c = await h.s.jobs.cancel(h.tenantId, a.id);
    expect(c?.state).toBe('cancelled');
    expect(await h.s.jobs.runDue()).toBe(0);
  });

  it('cancels a running job through its abort signal', async () => {
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    h.s.jobs.register('test.long', (_p, ctx) => {
      started();
      return new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    });
    const job = await h.s.jobs.enqueue({ tenantId: h.tenantId, type: 'test.long' });
    const run = h.s.jobs.runDue();
    await running;
    await h.s.jobs.cancel(h.tenantId, job.id);
    await run;
    expect((await h.s.jobs.get(h.tenantId, job.id))?.state).toBe('cancelled');
  });
});

describe('CSV fields', () => {
  it('quotes and defuses spreadsheet formulas', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvField({ a: 1 })).toBe('"{""a"":1}"');
    expect(csvField(null)).toBe('');
  });
});
