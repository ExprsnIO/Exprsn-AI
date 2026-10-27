import { createHash, createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { signV4 } from '../src/platform/blob.js';
import { AzureConnector, azureStringToSign } from '../src/files/locations/connectors/azure.js';
import { LocalConnector } from '../src/files/locations/connectors/local.js';
import { S3Connector } from '../src/files/locations/connectors/s3.js';
import { RemoteError, type ConnectorContext } from '../src/files/locations/model.js';

/*
 * 2.0.0, linked locations: the S3, Azure Blob and local connectors, against fakes that check SigV4 and Shared Key
 * signatures, and a temporary directory.
 */

const open: ConnectorContext = { check: () => null, timeoutMs: 10_000 };
const refuseLoopback: ConnectorContext = { check: (a) => (a === '127.0.0.1' ? '127.0.0.1 is an internal address.' : null), timeoutMs: 10_000 };

const listen = (server: Server): Promise<string> => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
const stop = async (server: Server) => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
};
const bodyOf = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
async function* chunks(b: Buffer, size = 1 << 20): AsyncGenerator<Buffer> {
  for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size);
}
async function collect(s: AsyncIterable<Buffer>): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const c of s) out.push(c);
  return Buffer.concat(out);
}
const remote = async (p: Promise<unknown>): Promise<RemoteError> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof RemoteError) return err;
    throw err;
  }
  throw new Error('expected a RemoteError');
};

// ---------- a fake S3 that checks SigV4 ----------

class SigV4Bucket {
  url = '';
  objects = new Map<string, { body: Buffer; etag: string; type: string }>();
  uploads = new Map<string, Map<number, Buffer>>();
  requests: string[] = [];
  aborted = 0;
  constructor(
    readonly bucket: string,
    readonly keyId: string,
    readonly secret: string
  ) {}

  private verify(req: IncomingMessage, body: Buffer): string | null {
    const auth = String(req.headers.authorization ?? '');
    const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]+)$/.exec(auth);
    if (!m || m[1] !== this.keyId) return 'InvalidAccessKeyId';
    const amz = String(req.headers['x-amz-date']);
    const date = new Date(`${amz.slice(0, 4)}-${amz.slice(4, 6)}-${amz.slice(6, 8)}T${amz.slice(9, 11)}:${amz.slice(11, 13)}:${amz.slice(13, 15)}Z`);
    const payload = String(req.headers['x-amz-content-sha256']);
    if (payload !== 'UNSIGNED-PAYLOAD' && payload !== sha(body)) return 'XAmzContentSHA256Mismatch';
    const headers: Record<string, string> = {};
    for (const h of m[4]!.split(';')) if (!['host', 'x-amz-date', 'x-amz-content-sha256'].includes(h)) headers[h] = String(req.headers[h]);
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const again = signV4({ method: req.method ?? 'GET', url, headers, payloadHash: payload, region: m[3]!, service: 's3', accessKeyId: this.keyId, secretAccessKey: this.secret, date });
    return again.authorization === auth ? null : 'SignatureDoesNotMatch';
  }

  private readonly server = createServer(async (req, res) => {
    const body = await bodyOf(req);
    const u = new URL(req.url ?? '/', 'http://x');
    this.requests.push(`${req.method} ${u.pathname}${u.search}`);
    const fail = (status: number, code: string) => {
      res.writeHead(status, { 'content-type': 'application/xml' });
      res.end(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>${code} message</Message></Error>`);
    };
    const bad = this.verify(req, body);
    if (bad) return fail(403, bad);
    const [, bucket, ...rest] = u.pathname.split('/');
    if (decodeURIComponent(bucket ?? '') !== this.bucket) return fail(404, 'NoSuchBucket');
    const key = rest.map(decodeURIComponent).join('/');
    const q = u.searchParams;
    if (req.method === 'GET' && q.get('list-type') === '2') {
      const prefix = q.get('prefix') ?? '';
      const delim = q.get('delimiter');
      const max = Number(q.get('max-keys') ?? 1000);
      const all = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const items: { key: string; dir: boolean }[] = [];
      const seen = new Set<string>();
      for (const k of all) {
        const restKey = k.slice(prefix.length);
        const cut = delim ? restKey.indexOf(delim) : -1;
        if (cut >= 0) {
          const p = prefix + restKey.slice(0, cut + 1);
          if (!seen.has(p)) {
            seen.add(p);
            items.push({ key: p, dir: true });
          }
        } else items.push({ key: k, dir: false });
      }
      const from = Number(q.get('continuation-token') ?? 0);
      const page = items.slice(from, from + max);
      const truncated = from + max < items.length;
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(
        `<?xml version="1.0"?><ListBucketResult>` +
          page.map((i) => (i.dir ? `<CommonPrefixes><Prefix>${esc(i.key)}</Prefix></CommonPrefixes>` : `<Contents><Key>${esc(i.key)}</Key><LastModified>2026-10-01T10:00:00.000Z</LastModified><ETag>&quot;${this.objects.get(i.key)!.etag}&quot;</ETag><Size>${this.objects.get(i.key)!.body.length}</Size></Contents>`)).join('') +
          `<IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${from + max}</NextContinuationToken>` : ''}</ListBucketResult>`
      );
      return;
    }
    if (req.method === 'POST' && q.has('uploads')) {
      const id = `up${this.uploads.size + 1}`;
      this.uploads.set(id, new Map());
      res.writeHead(200);
      res.end(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
      return;
    }
    if (req.method === 'PUT' && q.has('uploadId')) {
      const up = this.uploads.get(q.get('uploadId')!);
      if (!up) return fail(404, 'NoSuchUpload');
      up.set(Number(q.get('partNumber')), body);
      res.writeHead(200, { etag: `"${sha(body).slice(0, 16)}"` });
      res.end();
      return;
    }
    if (req.method === 'POST' && q.has('uploadId')) {
      const up = this.uploads.get(q.get('uploadId')!);
      if (!up) return fail(404, 'NoSuchUpload');
      const numbers = [...String(body).matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((x) => Number(x[1]));
      const data = Buffer.concat(numbers.map((n) => up.get(n)!));
      this.objects.set(key, { body: data, etag: `${sha(data).slice(0, 16)}-${numbers.length}`, type: 'application/octet-stream' });
      res.writeHead(200);
      res.end(`<CompleteMultipartUploadResult><ETag>&quot;${this.objects.get(key)!.etag}&quot;</ETag></CompleteMultipartUploadResult>`);
      return;
    }
    if (req.method === 'DELETE' && q.has('uploadId')) {
      this.aborted++;
      this.uploads.delete(q.get('uploadId')!);
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'PUT') {
      if (Number(req.headers['content-length']) !== body.length) return fail(400, 'IncompleteBody');
      this.objects.set(key, { body, etag: sha(body).slice(0, 16), type: String(req.headers['content-type'] ?? 'application/octet-stream') });
      res.writeHead(200, { etag: `"${sha(body).slice(0, 16)}"` });
      res.end();
      return;
    }
    const o = this.objects.get(key);
    if (!o) return fail(404, 'NoSuchKey');
    res.writeHead(200, { 'content-type': o.type, 'content-length': String(o.body.length), etag: `"${o.etag}"`, 'last-modified': 'Wed, 01 Oct 2026 10:00:00 GMT' });
    res.end(req.method === 'HEAD' ? undefined : o.body);
  });

  async start(): Promise<this> {
    this.url = await listen(this.server);
    return this;
  }
  stop = () => stop(this.server);
}

// ---------- a fake Azure Blob service that checks Shared Key and SAS ----------

const ACCOUNT = 'devstoreaccount1';
const ACCOUNT_KEY = Buffer.from('a fake account key of thirty-two bytes!!').toString('base64');

class FakeAzure {
  url = '';
  blobs = new Map<string, { body: Buffer; type: string }>();
  blocks = new Map<string, Buffer>();
  requests = 0;
  sas = 'sv=2023-11-03&sr=c&sp=rwl&sig=fake%2Bsignature';
  private readonly server = createServer(async (req, res) => {
    this.requests++;
    const body = await bodyOf(req);
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const fail = (status: number, code: string) => {
      res.writeHead(status, { 'content-type': 'application/xml', 'x-ms-error-code': code });
      res.end(`<?xml version="1.0" encoding="utf-8"?><Error><Code>${code}</Code><Message>${code} happened.\nRequestId:1</Message></Error>`);
    };
    if (url.searchParams.get('sig')) {
      if (url.searchParams.get('sig') !== 'fake+signature') return fail(403, 'AuthenticationFailed');
    } else {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(',') : String(v);
      const expected = `SharedKey ${ACCOUNT}:${createHmac('sha256', Buffer.from(ACCOUNT_KEY, 'base64')).update(azureStringToSign(ACCOUNT, req.method ?? 'GET', url, headers), 'utf8').digest('base64')}`;
      if (req.headers.authorization !== expected) return fail(403, 'AuthenticationFailed');
    }
    if (req.headers['x-ms-version'] !== '2023-11-03') return fail(400, 'InvalidHeaderValue');
    const [, account, container, ...rest] = url.pathname.split('/');
    if (account !== ACCOUNT) return fail(400, 'InvalidUri');
    if (container !== 'docs') return fail(404, 'ContainerNotFound');
    const name = rest.map(decodeURIComponent).join('/');
    const q = url.searchParams;
    if (q.get('comp') === 'list') {
      const prefix = q.get('prefix') ?? '';
      const delim = q.get('delimiter');
      const max = Number(q.get('maxresults') ?? 5000);
      const items: { name: string; dir: boolean }[] = [];
      const seen = new Set<string>();
      for (const k of [...this.blobs.keys()].filter((x) => x.startsWith(prefix)).sort()) {
        const r = k.slice(prefix.length);
        const cut = delim ? r.indexOf(delim) : -1;
        if (cut >= 0) {
          const p = prefix + r.slice(0, cut + 1);
          if (!seen.has(p)) {
            seen.add(p);
            items.push({ name: p, dir: true });
          }
        } else items.push({ name: k, dir: false });
      }
      const from = Number(q.get('marker') || 0);
      const page = items.slice(from, from + max);
      const next = from + max < items.length ? String(from + max) : '';
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(`<?xml version="1.0" encoding="utf-8"?><EnumerationResults><Blobs>${page.map((i) => (i.dir ? `<BlobPrefix><Name>${esc(i.name)}</Name></BlobPrefix>` : `<Blob><Name>${esc(i.name)}</Name><Properties><Last-Modified>Wed, 01 Oct 2026 10:00:00 GMT</Last-Modified><Etag>0x8D</Etag><Content-Length>${this.blobs.get(i.name)!.body.length}</Content-Length><Content-Type>${esc(this.blobs.get(i.name)!.type)}</Content-Type></Properties></Blob>`)).join('')}</Blobs><NextMarker>${next}</NextMarker></EnumerationResults>`);
      return;
    }
    if (req.method === 'PUT' && q.get('comp') === 'block') {
      this.blocks.set(q.get('blockid')!, body);
      res.writeHead(201);
      res.end();
      return;
    }
    if (req.method === 'PUT' && q.get('comp') === 'blocklist') {
      const ids = [...String(body).matchAll(/<Latest>([^<]+)<\/Latest>/g)].map((x) => x[1]!);
      this.blobs.set(name, { body: Buffer.concat(ids.map((i) => this.blocks.get(i)!)), type: String(req.headers['x-ms-blob-content-type'] ?? '') });
      res.writeHead(201, { etag: '"0x9"' });
      res.end();
      return;
    }
    if (req.method === 'PUT') {
      if (req.headers['x-ms-blob-type'] !== 'BlockBlob') return fail(400, 'MissingRequiredHeader');
      this.blobs.set(name, { body, type: String(req.headers['content-type'] ?? '') });
      res.writeHead(201, { etag: '"0x1"' });
      res.end();
      return;
    }
    const b = this.blobs.get(name);
    if (!b) return fail(404, 'BlobNotFound');
    res.writeHead(200, { 'content-type': b.type, 'content-length': String(b.body.length), etag: '"0x1"', 'last-modified': 'Wed, 01 Oct 2026 10:00:00 GMT' });
    res.end(req.method === 'HEAD' ? undefined : b.body);
  });
  async start(): Promise<this> {
    this.url = await listen(this.server);
    return this;
  }
  stop = () => stop(this.server);
}

describe('S3 connector', () => {
  let s3: SigV4Bucket;
  beforeEach(async () => {
    s3 = await new SigV4Bucket('reports', 'AKIDEXAMPLE', 'secret-key').start();
  });
  afterEach(async () => s3.stop());

  const conn = (o: { prefix?: string; secret?: string; ctx?: ConnectorContext; readOnly?: boolean } = {}) => new S3Connector({ endpoint: s3.url, region: 'eu-west-1', bucket: 'reports', prefix: o.prefix ?? '', pathStyle: true, flavour: 'minio' }, { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: o.secret ?? 'secret-key' }, o.ctx ?? open, { readOnly: o.readOnly });

  it('lists folders and files a level at a time, pages, reads, stats and writes with valid signatures', async () => {
    for (const k of ['team/2026/q3 plan.md', 'team/2026/q4.md', 'team/readme.txt', 'other/x.txt']) s3.objects.set(k, { body: Buffer.from(`body of ${k}`), etag: sha(k).slice(0, 8), type: 'text/plain' });
    const c = conn({ prefix: 'team' });
    expect((await c.test()).detail).toContain('reports');
    const root = await c.list('');
    expect(root.entries).toEqual([
      { path: '2026', name: '2026', dir: true, size: null, modified: null },
      expect.objectContaining({ path: 'readme.txt', name: 'readme.txt', dir: false, size: Buffer.byteLength('body of team/readme.txt'), modified: Date.parse('2026-10-01T10:00:00.000Z') })
    ]);
    const sub = await c.list('2026');
    expect(sub.entries.map((e) => e.path)).toEqual(['2026/q3 plan.md', '2026/q4.md']);
    const got = await c.read('2026/q3 plan.md');
    expect((await collect(got.stream)).toString()).toBe('body of team/2026/q3 plan.md');
    expect(got.type).toBe('text/plain');
    expect(await c.stat('2026')).toMatchObject({ dir: true });
    expect(await c.stat('2026/q4.md')).toMatchObject({ dir: false, size: Buffer.byteLength('body of team/2026/q4.md') });
    expect(await c.stat('nothing')).toBeNull();
    // Paging through continuation tokens.
    for (let i = 0; i < 503; i++) s3.objects.set(`team/many/f${String(i).padStart(4, '0')}`, { body: Buffer.from('x'), etag: 'e', type: 'text/plain' });
    const p1 = await c.list('many');
    expect(p1.entries).toHaveLength(500);
    expect(p1.next).toBe('500');
    const p2 = await c.list('many', p1.next);
    expect(p2.entries).toHaveLength(3);
    expect(p2.next).toBeNull();
    // A plain-HTTP PUT is hashed; spaces and other characters in keys sign correctly.
    const data = Buffer.from('hello, bucket');
    await c.write('out/a file (1).txt', chunks(data), data.length, 'text/plain');
    expect(s3.objects.get('team/out/a file (1).txt')?.body.toString()).toBe('hello, bucket');
    await c.close();
  });

  it('uploads large files in parts and maps errors to plain messages', async () => {
    const c = conn();
    const big = Buffer.alloc(65 * 1024 * 1024 + 123, 7);
    const out = await c.write('big.bin', chunks(big, 4 << 20), big.length, null);
    expect(out.etag).toMatch(/-5$/);
    expect(s3.objects.get('big.bin')!.body.equals(big)).toBe(true);
    expect((await remote(c.read('missing.txt'))).status).toBe(404);
    expect((await remote(conn({ secret: 'wrong' }).test())).message).toMatch(/keys were refused \(SignatureDoesNotMatch\)/);
    const wrongBucket = new S3Connector({ endpoint: s3.url, region: 'eu-west-1', bucket: 'nope', prefix: '', pathStyle: true, flavour: 'aws' }, { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret-key' }, open);
    expect((await remote(wrongBucket.test())).message).toBe('The bucket nope does not exist.');
    expect((await remote(conn({ readOnly: true }).write('x', chunks(Buffer.from('x')), 1, null))).status).toBe(403);
    await expect(c.list('../etc')).rejects.toThrow(/Not a valid path/);
    await c.close();
  });

  it('refuses an address the check refuses before any request is sent', async () => {
    const err = await remote(conn({ ctx: refuseLoopback }).test());
    expect(err.status).toBe(403);
    expect(err.message).toContain('internal address');
    expect(s3.requests).toHaveLength(0);
  });
});

describe('Azure Blob connector', () => {
  let az: FakeAzure;
  beforeEach(async () => {
    az = await new FakeAzure().start();
  });
  afterEach(async () => az.stop());

  const conn = (secret: { accountKey: string } | { sas: string } = { accountKey: ACCOUNT_KEY }, ctx = open, prefix = '') => new AzureConnector({ endpoint: `${az.url}/${ACCOUNT}`, account: ACCOUNT, container: 'docs', prefix }, secret, ctx);

  it('builds the Shared Key string to sign as the documentation describes', () => {
    const url = new URL('http://127.0.0.1:10000/devstoreaccount1/docs?restype=container&comp=list&prefix=a%20b%2F');
    const sts = azureStringToSign('devstoreaccount1', 'GET', url, { 'x-ms-date': 'Wed, 01 Oct 2026 10:00:00 GMT', 'x-ms-version': '2023-11-03', 'Content-Length': '0' });
    expect(sts).toBe('GET\n\n\n\n\n\n\n\n\n\n\n\nx-ms-date:Wed, 01 Oct 2026 10:00:00 GMT\nx-ms-version:2023-11-03\n/devstoreaccount1/devstoreaccount1/docs\ncomp:list\nprefix:a b/\nrestype:container');
  });

  it('lists, reads, stats and writes with a shared key, and with a SAS token', async () => {
    az.blobs.set('2026/plan.md', { body: Buffer.from('# Plan'), type: 'text/markdown' });
    az.blobs.set('readme.txt', { body: Buffer.from('read me'), type: 'text/plain' });
    const c = conn();
    expect((await c.test()).detail).toContain('docs');
    const root = await c.list('');
    expect(root.entries.map((e) => [e.path, e.dir])).toEqual([['2026', true], ['readme.txt', false]]);
    expect(root.entries[1]).toMatchObject({ size: 7, type: 'text/plain', modified: Date.parse('Wed, 01 Oct 2026 10:00:00 GMT') });
    expect((await collect((await c.read('2026/plan.md')).stream)).toString()).toBe('# Plan');
    expect(await c.stat('2026')).toMatchObject({ dir: true });
    expect(await c.stat('readme.txt')).toMatchObject({ size: 7 });
    expect(await c.stat('gone.txt')).toBeNull();
    await c.write('out/new file.txt', chunks(Buffer.from('fresh')), 5, 'text/plain');
    expect(az.blobs.get('out/new file.txt')?.body.toString()).toBe('fresh');
    const viaSas = conn({ sas: az.sas });
    expect((await viaSas.list('')).entries).toHaveLength(3);
    expect((await remote(conn({ sas: 'sv=1&sig=bad' }).test())).message).toMatch(/SAS token was refused/);
    expect((await remote(conn({ accountKey: Buffer.from('other key').toString('base64') }).test())).message).toMatch(/account key was refused/);
    expect((await remote(c.read('missing'))).status).toBe(404);
    await c.close();
  });

  it('pages with markers, keeps a prefix, and refuses checked addresses', async () => {
    for (let i = 0; i < 502; i++) az.blobs.set(`base/f${String(i).padStart(4, '0')}`, { body: Buffer.from('x'), type: 'text/plain' });
    const c = conn({ accountKey: ACCOUNT_KEY }, open, 'base');
    const p1 = await c.list('');
    expect(p1.entries).toHaveLength(500);
    expect(p1.entries[0]!.path).toBe('f0000');
    const p2 = await c.list('', p1.next);
    expect(p2.entries.map((e) => e.path)).toEqual(['f0500', 'f0501']);
    const before = az.requests;
    expect((await remote(conn({ accountKey: ACCOUNT_KEY }, refuseLoopback).test())).status).toBe(403);
    expect(az.requests).toBe(before);
  });
});

describe('Local connector', () => {
  let dir: string;
  let root: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'exprsn-local-'));
    root = path.join(dir, 'root');
    await mkdir(path.join(root, 'share', 'docs'), { recursive: true });
    await writeFile(path.join(root, 'share', 'docs', 'a.txt'), 'alpha');
    await writeFile(path.join(root, 'share', 'top.txt'), 'top');
    await writeFile(path.join(dir, 'secret.txt'), 'outside');
    await symlink(path.join(dir, 'secret.txt'), path.join(root, 'share', 'escape.txt'));
    await symlink(path.join(root, 'share', 'docs', 'a.txt'), path.join(root, 'share', 'alias.txt'));
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  const conn = (readOnly = false, rootReadOnly = false, sub = 'share') => new LocalConnector({ rootId: 'r1', path: sub }, { ...open, localRoot: { path: root, readOnly: rootReadOnly } }, { readOnly });

  it('lists inside its base only, reads and writes atomically', async () => {
    const c = conn();
    expect((await c.test()).detail).toContain('readable and writable');
    const l = await c.list('');
    expect(l.entries.map((e) => [e.path, e.dir])).toEqual([['docs', true], ['alias.txt', false], ['top.txt', false]]);
    expect((await collect((await c.read('docs/a.txt')).stream)).toString()).toBe('alpha');
    expect((await collect((await c.read('alias.txt')).stream)).toString()).toBe('alpha');
    expect((await remote(c.read('escape.txt'))).status).toBe(403);
    await expect(c.read('../secret.txt')).rejects.toThrow(/Not a valid path/);
    expect((await remote(c.read('docs'))).status).toBe(409);
    await c.write('new/deep/b.txt', chunks(Buffer.from('bravo')), 5, null);
    expect(await readFile(path.join(root, 'share', 'new', 'deep', 'b.txt'), 'utf8')).toBe('bravo');
    expect((await readdir(path.join(root, 'share', 'new', 'deep'))).filter((n) => n.startsWith('.exprsn-upload-'))).toEqual([]);
    expect((await remote(c.write('short.txt', chunks(Buffer.from('ab')), 5, null))).message).toMatch(/2 bytes arrived/);
    expect(await readdir(path.join(root, 'share'))).not.toContain('short.txt');
    expect((await remote(c.write('escape.txt', chunks(Buffer.from('x')), 1, null))).status).toBe(409);
    expect(await readFile(path.join(dir, 'secret.txt'), 'utf8')).toBe('outside');
    expect(await c.stat('nope.txt')).toBeNull();
    expect(await c.stat('top.txt')).toMatchObject({ dir: false, size: 3 });
  });

  it('refuses writes when read-only, a missing root, a base outside the root, and pages listings', async () => {
    expect((await remote(conn(true).write('x.txt', chunks(Buffer.from('x')), 1, null))).status).toBe(403);
    expect(conn(false, true).writable).toBe(false);
    expect((await remote(new LocalConnector({ rootId: 'r1', path: '' }, open).list(''))).status).toBe(409);
    await symlink(dir, path.join(root, 'up'));
    expect((await remote(conn(false, false, 'up').list(''))).status).toBe(403);
    await mkdir(path.join(root, 'many'));
    for (let i = 0; i < 520; i++) await writeFile(path.join(root, 'many', `f${String(i).padStart(4, '0')}`), '');
    const c = conn(false, false, 'many');
    const p1 = await c.list('');
    expect(p1.entries).toHaveLength(500);
    expect(p1.next).toBe('500');
    expect((await c.list('', p1.next)).entries).toHaveLength(20);
  });
});
