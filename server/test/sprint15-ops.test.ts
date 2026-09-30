import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { createSocket, type Socket } from 'node:dgram';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { authenticator } from 'otplib';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb, migrate, type Db } from '../src/db/knex.js';
import { createApp } from '../src/http/app.js';
import { createLogger, Metrics } from '../src/observability/index.js';
import { createServices, type Services } from '../src/services.js';
import { bootstrap } from '../src/bootstrap.js';
import { LocalKms } from '../src/platform/kms.js';
import { rewrapAll } from '../src/platform/rewrap.js';
import { FsBlobStore, S3BlobStore } from '../src/platform/blob.js';
import { entryHeader, TAR_END, tarPadding, writeTar } from '../src/ops/tar.js';
import { keyFingerprint } from '../src/ops/bundles.js';
import { buildTxtUpdate, parseMessage, signTsig, txtValue, verifyTsig, verifyWebhookSignature, Rfc2136DnsProvider, type TsigKey } from '../src/ops/dns.js';
import { acmeChallengeRoutes } from '../src/routes/admin/platform.js';
import { harness, localUser, loginAdmin, PASSWORD, testConfig, type Client } from './helpers.js';
import { harnessWith } from './retrieval-seed.js';
import { startFakeAcme, type FakeAcme } from './fake-acme.js';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), p));
const by = (tenantId: string) => ({ tenantId, actor: { service: 'test' }, userId: null });

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c().catch(() => undefined);
  cleanup = [];
});

/** Services on a SQLite file, so a second set can open the same database with other keys. */
async function servicesOn(env: Record<string, string>): Promise<{ s: Services; db: Db; tenantId: string; close: () => Promise<void> }> {
  const cfg = testConfig(env);
  const db = createDb(cfg);
  await migrate(db);
  const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
  await bootstrap(s);
  const tenantId = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!.id;
  const close = async () => {
    await s.close();
    await db.destroy();
  };
  return { s, db, tenantId, close };
}

describe('B-407: key-encryption-key re-wrap', () => {
  it('re-wraps every data key under a new DATA_KEY; afterwards everything reads without the old key', async () => {
    const dir = tmp('exprsn-rewrap-');
    const oldKey = randomBytes(32).toString('base64');
    const newKey = randomBytes(32).toString('base64');
    const common = { SQLITE_FILENAME: path.join(dir, 'db.sqlite'), BLOB_DIR: path.join(dir, 'blobs'), SESSION_SECRET: randomBytes(32).toString('hex') };

    const a = await servicesOn({ ...common, DATA_KEY: oldKey });
    const sealed = await a.s.keys.seal(a.tenantId, 'tenant secret', 'aad:1');
    await a.s.keys.rotate(a.tenantId);
    const sealed2 = await a.s.keys.seal(a.tenantId, 'after rotation', 'aad:2');
    const platform = await a.s.keys.seal('platform', 'platform secret', 'aad:p');
    await a.s.audit.append({ tenantId: a.tenantId, action: 'test.event', kind: 'admin', actor: { service: 'test' } });
    expect(await a.s.checkpoints.create(a.tenantId, 'test')).not.toBeNull();
    const backup = await a.s.ops.backups.createNow(by(a.tenantId));
    await a.close();

    // New key in place, old key as the previous one: reads fall back until the re-wrap is done.
    const b = await servicesOn({ ...common, DATA_KEY: newKey, DATA_KEY_PREVIOUS: oldKey });
    expect(await b.s.keys.open(b.tenantId, sealed, 'aad:1')).toBe('tenant secret');
    expect((await b.s.checkpoints.verify(b.tenantId)).status).toBe('verified');
    const r = await rewrapAll({ db: b.db, blobs: b.s.blobs, target: new LocalKms(newKey), previous: new LocalKms(oldKey), kekName: (scope) => b.s.keys.kekName(scope) });
    expect(r.verified).toBe(true);
    expect(r.dataKeys).toMatchObject({ total: 3, rewrapped: 3, failed: [] });
    expect(r.checkpoints).toMatchObject({ total: 1, resigned: 1, failed: [] });
    expect(r.backups).toMatchObject({ total: 1, rewrapped: 1, failed: [] });
    // Idempotent: a second run finds nothing to do.
    const again = await rewrapAll({ db: b.db, blobs: b.s.blobs, target: new LocalKms(newKey), previous: new LocalKms(oldKey), kekName: (scope) => b.s.keys.kekName(scope) });
    expect(again).toMatchObject({ verified: true, dataKeys: { rewrapped: 0, already: 3 }, checkpoints: { resigned: 0, already: 1 }, backups: { rewrapped: 0, already: 1 } });
    await b.close();

    // The old key removed: everything still opens, verifies and restores.
    const c = await servicesOn({ ...common, DATA_KEY: newKey });
    expect(await c.s.keys.open(c.tenantId, sealed, 'aad:1')).toBe('tenant secret');
    expect(await c.s.keys.open(c.tenantId, sealed2, 'aad:2')).toBe('after rotation');
    expect(await c.s.keys.open('platform', platform, 'aad:p')).toBe('platform secret');
    expect((await c.s.checkpoints.verify(c.tenantId)).status).toBe('verified');
    const drill = await c.s.ops.backups.drillNow(by(c.tenantId), backup.id);
    expect(drill.error).toBeNull();
    expect(drill.state).toBe('passed');
    await c.close();

    // Without the re-wrap the new key alone could not open anything (the test would be vacuous otherwise).
    const d = await servicesOn({ ...common, SQLITE_FILENAME: path.join(tmp('exprsn-rewrap2-'), 'db.sqlite'), DATA_KEY: oldKey });
    const s2 = await d.s.keys.seal(d.tenantId, 'x', 'aad');
    await d.close();
    const e = await servicesOn({ ...common, SQLITE_FILENAME: d.s.cfg.SQLITE_FILENAME, DATA_KEY: newKey });
    await expect(e.s.keys.open(e.tenantId, s2, 'aad')).rejects.toThrow();
    await e.close();
  });
});

/** Bundle tar as a stream: the manifest and signature first, then files, one of them `bigBytes` of a repeating pattern. */
function bundleParts(o: { id: string; key: KeyObject; bigBytes: number; small: { path: string; mirror: string; data: Buffer }[] }) {
  const chunk = Buffer.alloc(1024 * 1024, 7);
  const bigHash = createHash('sha256');
  for (let left = o.bigBytes; left > 0; left -= chunk.length) bigHash.update(left >= chunk.length ? chunk : chunk.subarray(0, left));
  const files = [{ path: 'models/big.gguf', mirror: 'models', sha256: bigHash.digest('hex'), size: o.bigBytes }, ...o.small.map((f) => ({ path: f.path, mirror: f.mirror, sha256: sha(f.data), size: f.data.length }))];
  const manifest = Buffer.from(JSON.stringify({ format: 'exprsn-bundle/1', id: o.id, files, sbom: { bomFormat: 'CycloneDX', specVersion: '1.5', components: [{ name: 'big-model', licenses: [{ license: { id: 'Apache-2.0' } }] }] } }));
  const sig = Buffer.from(JSON.stringify({ algorithm: 'ed25519', key: keyFingerprint(o.key), signature: sign(null, manifest, o.key).toString('base64') }));
  const stream = async function* () {
    for (const [p, d] of [['manifest.json', manifest], ['manifest.sig', sig]] as const) {
      yield entryHeader(p, d.length);
      yield d;
      yield tarPadding(d.length);
    }
    yield entryHeader('files/models/big.gguf', o.bigBytes);
    for (let left = o.bigBytes; left > 0; left -= chunk.length) yield left >= chunk.length ? chunk : chunk.subarray(0, left);
    yield tarPadding(o.bigBytes);
    for (const f of o.small) {
      yield entryHeader(`files/${f.path}`, f.data.length);
      yield f.data;
      yield tarPadding(f.data.length);
    }
    yield TAR_END;
  };
  return { stream, files };
}

describe('B-411: streaming blob path', () => {
  // TEST_BIG_BUNDLE=1 runs the 3 GiB case from the backlog; the default size still proves memory stays flat.
  const BIG = process.env.TEST_BIG_BUNDLE ? 3 * 1024 ** 3 : 256 * 1024 ** 2;

  it(`verifies and promotes a ${BIG >= 1024 ** 3 ? '3 GiB' : '256 MiB'} bundle with flat memory`, async () => {
    const h = await harness({ PLATFORM_BUNDLE_MAX_BYTES: String(4 * 1024 ** 3) });
    cleanup.push(() => h.close(), () => rm(h.s.cfg.BLOB_DIR, { recursive: true, force: true }));
    const signer = generateKeyPairSync('ed25519');
    await h.s.ops.bundles.addKey(by(h.tenantId), { name: 'offline', publicKeyPem: signer.publicKey.export({ type: 'spki', format: 'pem' }).toString() });
    const { stream, files } = bundleParts({ id: 'big-model', key: signer.privateKey, bigBytes: BIG, small: [{ path: 'npm/x.tgz', mirror: 'npm', data: Buffer.from('small') }] });
    const b = await h.s.ops.bundles.create(by(h.tenantId), { name: 'big-model', transfer: 'diode', expedited: false });
    global.gc?.();
    const base = process.memoryUsage();
    let peak = 0;
    const sample = setInterval(() => {
      const m = process.memoryUsage();
      peak = Math.max(peak, m.heapUsed + m.arrayBuffers - base.heapUsed - base.arrayBuffers);
    }, 5);
    try {
      await h.s.ops.bundles.receive(by(h.tenantId), b.id, stream());
      await h.s.jobs.runDue();
      const v = await h.s.ops.bundles.get(b.id);
      expect(v.state).toBe('ready to promote');
      expect(v.size).toBeGreaterThan(BIG);
      await h.s.ops.bundles.promote(by(h.tenantId), b.id);
      await h.s.jobs.runDue();
      expect((await h.s.ops.bundles.get(b.id)).state).toBe('in production');
    } finally {
      clearInterval(sample);
    }
    const stored = await h.s.blobs.getStream(`mirrors/models/sha256/${files[0]!.sha256}`);
    expect(stored?.size).toBe(BIG);
    stored?.stream.destroy();
    // Far below the bundle's size: nothing held it in memory.
    expect(peak).toBeLessThan(96 * 1024 ** 2);
  }, 30 * 60_000);

  it('uploads to S3 in signed multipart parts and streams it back', async () => {
    const objects = new Map<string, Buffer>();
    const uploads = new Map<string, Buffer[]>();
    const seen: string[] = [];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const u = new URL(req.url!, 'http://x');
        const auth = String(req.headers.authorization ?? '');
        if (!auth.startsWith('AWS4-HMAC-SHA256 Credential=AK/') || req.headers['x-amz-content-sha256'] !== sha(body)) {
          res.statusCode = 403;
          return res.end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
        }
        const key = decodeURIComponent(u.pathname.replace(/^\/bucket\/?/, ''));
        seen.push(`${req.method} ${u.search ? [...u.searchParams.keys()].join('&') : ''}`);
        if (req.method === 'POST' && u.searchParams.has('uploads')) {
          uploads.set('up1', []);
          return res.end('<InitiateMultipartUploadResult><UploadId>up1</UploadId></InitiateMultipartUploadResult>');
        }
        if (req.method === 'PUT' && u.searchParams.has('partNumber')) {
          uploads.get(u.searchParams.get('uploadId')!)![Number(u.searchParams.get('partNumber')) - 1] = body;
          res.setHeader('etag', `"etag${u.searchParams.get('partNumber')}"`);
          return res.end();
        }
        if (req.method === 'POST' && u.searchParams.has('uploadId')) {
          expect(body.toString()).toMatch(/<Part><PartNumber>1<\/PartNumber><ETag>"etag1"<\/ETag><\/Part>/);
          objects.set(key, Buffer.concat(uploads.get(u.searchParams.get('uploadId')!)!));
          return res.end('<CompleteMultipartUploadResult/>');
        }
        if (req.method === 'PUT') {
          objects.set(key, body);
          return res.end();
        }
        if (req.method === 'GET' && u.searchParams.get('list-type') === '2') {
          return res.end(`<ListBucketResult>${[...objects.entries()].map(([k, v]) => `<Contents><Key>${k}</Key><Size>${v.length}</Size></Contents>`).join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`);
        }
        if (req.method === 'GET') {
          const o = objects.get(key);
          if (!o) {
            res.statusCode = 404;
            return res.end();
          }
          res.setHeader('content-length', String(o.length));
          return res.end(o);
        }
        res.statusCode = 400;
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanup.push(() => new Promise((r) => server.close(() => r())));
    const s3 = new S3BlobStore({ endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, region: 'us-east-1', bucket: 'bucket', accessKeyId: 'AK', secretAccessKey: 'SK', pathStyle: true });
    const saved = S3BlobStore.PART_BYTES;
    S3BlobStore.PART_BYTES = 64 * 1024;
    try {
      const data = randomBytes(200 * 1024 + 17);
      const gen = async function* () {
        for (let i = 0; i < data.length; i += 10_000) yield data.subarray(i, i + 10_000);
      };
      expect(await s3.putStream('platform/bundles/x/transfer.tar', gen())).toEqual({ bytes: data.length });
      expect(seen.filter((x) => x.startsWith('PUT partNumber'))).toHaveLength(4);
      const back = await s3.getStream('platform/bundles/x/transfer.tar');
      expect(back?.size).toBe(data.length);
      const parts: Buffer[] = [];
      for await (const c of back!.stream) parts.push(c as Buffer);
      expect(Buffer.concat(parts).equals(data)).toBe(true);
      // Small objects go up in one PUT.
      await s3.putStream('small.txt', (async function* () { yield Buffer.from('hi'); })());
      expect(objects.get('small.txt')?.toString()).toBe('hi');
      const listed = [];
      for await (const o of s3.list('')) listed.push(o);
      expect(listed.map((o) => o.key).sort()).toEqual(['platform/bundles/x/transfer.tar', 'small.txt']);
      expect(await s3.getStream('missing')).toBeNull();
    } finally {
      S3BlobStore.PART_BYTES = saved;
    }
  });
});

describe('B-410: backups of the blob store, streamed, and restore into an empty database', () => {
  it('restores a backup into an empty database and blob store, and the app starts on it', async () => {
    const secret = randomBytes(32).toString('hex');
    const key = randomBytes(32).toString('base64');
    const srcDir = tmp('exprsn-src-');
    const h = await harness({ SESSION_SECRET: secret, DATA_KEY: key, BLOB_DIR: srcDir });
    cleanup.push(() => h.close());
    await localUser(h, 'root', ['system-admin'], 'restricted');
    const admin = await loginAdmin(h, 'root');
    const sealed = await h.s.keys.seal(h.tenantId, 'survives the restore', 'aad:r');
    await h.s.blobs.put(`attachments/${h.tenantId}/a1`, Buffer.from(await h.s.keys.seal(h.tenantId, 'attachment body', 'attachment:a1')));
    await h.s.checkpoints.create(h.tenantId, 'test');
    const b = await h.s.ops.backups.createNow(by(h.tenantId));
    const manifest = JSON.parse((await h.s.blobs.get(`platform/backups/${b.id}.manifest.json`))!.toString()).manifest;
    expect(manifest.blobs).toMatchObject({ objects: expect.any(Number), cipher: 'aes-256-gcm' });
    expect(manifest.blobs.objects).toBeGreaterThanOrEqual(2); // the attachment and the checkpoint copy
    // Nothing plain in the stored archives.
    expect(readFileSync(path.join(srcDir, 'platform/backups', `${b.id}.bin`)).includes(Buffer.from('root'))).toBe(false);

    // An empty database and an empty blob store, same keys.
    const dir = tmp('exprsn-restore-');
    const cfgEnv = { SESSION_SECRET: secret, DATA_KEY: key, SQLITE_FILENAME: path.join(dir, 'db.sqlite'), BLOB_DIR: path.join(dir, 'blobs') };
    const cfg = testConfig(cfgEnv);
    const db = createDb(cfg);
    await migrate(db);
    const t = createServices(cfg, db, createLogger('silent', false), new Metrics());
    cleanup.push(async () => {
      await t.close();
      await db.destroy();
    });
    const from = new FsBlobStore(srcDir);
    const r = await t.ops.backups.restoreInto({ target: db, client: 'sqlite', kms: t.kms, from, blobsTo: t.blobs, backupId: b.id, force: false });
    expect(r.rows).toBe(manifest.totalRows);
    expect(r.blobs?.objects).toBe(manifest.blobs.objects);
    expect(r.wiped).toBe(false);

    // The app starts on it: the admin signs in with their password and second factor, data opens, the chain verifies.
    await bootstrap(t);
    const app = createApp(t);
    await request(app).get('/readyz').expect(200);
    const agent = request.agent(app);
    const first = await agent.post('/api/auth/login').send({ username: 'root', password: PASSWORD }).expect(200);
    expect(first.body.stage).toBe('mfa');
    const step = await agent.post('/api/auth/mfa/totp').set('x-csrf-token', first.body.csrf).send({ code: authenticator.clone({ epoch: Date.now() + 30_000 }).generate(admin.totpSecret) });
    expect([200, 201]).toContain(step.status);
    await agent.get('/api/admin/platform/summary').expect(200);
    expect(await t.keys.open(h.tenantId, sealed, 'aad:r')).toBe('survives the restore');
    expect(await t.keys.open(h.tenantId, (await t.blobs.get(`attachments/${h.tenantId}/a1`))!.toString(), 'attachment:a1')).toBe('attachment body');
    expect((await t.checkpoints.verify(h.tenantId)).status).toBe('verified');

    // The guard: a database with data is refused, unless forced.
    await expect(t.ops.backups.restoreInto({ target: db, client: 'sqlite', kms: t.kms, from, blobsTo: null, backupId: b.id, force: false })).rejects.toThrow(/not empty/);
    const forced = await t.ops.backups.restoreInto({ target: db, client: 'sqlite', kms: t.kms, from, blobsTo: null, backupId: b.id, force: true });
    expect(forced).toMatchObject({ wiped: true, rows: manifest.totalRows, blobs: null });
  });

  it('refuses a changed archive before writing anything', async () => {
    const secret = randomBytes(32).toString('hex');
    const key = randomBytes(32).toString('base64');
    const srcDir = tmp('exprsn-src-');
    const h = await harness({ SESSION_SECRET: secret, DATA_KEY: key, BLOB_DIR: srcDir, PLATFORM_BACKUP_BLOBS: 'false' });
    cleanup.push(() => h.close());
    const b = await h.s.ops.backups.createNow(by(h.tenantId));
    const bin = path.join(srcDir, 'platform/backups', `${b.id}.bin`);
    const bytes = readFileSync(bin);
    const mid = Math.floor(bytes.length / 2);
    bytes[mid] = bytes[mid]! ^ 0xff;
    writeFileSync(bin, bytes);
    const cfg = testConfig({ SESSION_SECRET: secret, DATA_KEY: key, BLOB_DIR: tmp('exprsn-empty-') });
    const db = createDb(cfg);
    await migrate(db);
    const t = createServices(cfg, db, createLogger('silent', false), new Metrics());
    cleanup.push(async () => {
      await t.close();
      await db.destroy();
    });
    await expect(t.ops.backups.restoreInto({ target: db, client: 'sqlite', kms: t.kms, from: new FsBlobStore(srcDir), blobsTo: null, backupId: b.id, force: false })).rejects.toThrow(/does not authenticate|digest|header|incorrect/i);
    expect(await db('tenants').count({ n: '*' })).toEqual([{ n: 0 }]);
    // The drill notices too.
    const d = await h.s.ops.backups.drillNow(by(h.tenantId), b.id);
    expect(d.state).toBe('failed');
  });
});

/** TXT records by name, as a DNS server would hold them. */
type Zone = Map<string, string[]>;

async function fakeDnsServer(key: TsigKey, zone: Zone): Promise<{ port: number; socket: Socket; updates: number }> {
  const socket = createSocket('udp4');
  const state = { port: 0, socket, updates: 0 };
  socket.on('message', (msg, rinfo) => {
    const req = parseMessage(msg);
    const tsig = verifyTsig(msg, key);
    const reqMac = (() => {
      const t = req.additional[req.additional.length - 1];
      if (!t) return undefined;
      const alg = t.rdata.indexOf(0) + 1;
      const macLen = t.rdata.readUInt16BE(alg + 8);
      return t.rdata.subarray(alg + 10, alg + 10 + macLen);
    })();
    let rcode = 0;
    if (!tsig.ok) rcode = 9; // NOTAUTH
    else if (req.opcode !== 5) rcode = 4;
    else {
      state.updates++;
      for (const u of req.updates) {
        const list = zone.get(u.name) ?? [];
        const v = txtValue(u.rdata);
        if (u.cls === 1) zone.set(u.name, [...list, v]);
        else if (u.cls === 254) zone.set(u.name, list.filter((x) => x !== v));
      }
    }
    const header = Buffer.alloc(12);
    header.writeUInt16BE(req.id, 0);
    header.writeUInt16BE(0x8000 | (5 << 11) | rcode, 2);
    const signed = signTsig(header, key, Date.now(), 300, reqMac).signed;
    socket.send(tsig.ok ? signed : header, rinfo.port, rinfo.address);
  });
  await new Promise<void>((r) => socket.bind(0, '127.0.0.1', r));
  state.port = (socket.address() as AddressInfo).port;
  return state;
}

describe('B-409: ACME dns-01, the DNS providers and the certificate sink', () => {
  let acme: FakeAcme;
  const zone: Zone = new Map();

  async function withAcme(env: Record<string, string>) {
    zone.clear();
    acme = await startFakeAcme(async () => null, { resolveTxt: async (name) => zone.get(name) ?? [] });
    cleanup.push(() => acme.close());
    const h = await harnessWith({}, { ACME_DIRECTORY_URL: acme.directory, ACME_POLL_MS: '10', ACME_CHALLENGE: 'dns-01', ACME_DNS_WAIT_SECONDS: '0', ...env });
    cleanup.push(() => h.close());
    await localUser(h, 'root', ['system-admin'], 'restricted');
    const a = await loginAdmin(h, 'root');
    return { h, a };
  }

  const waitFor = async (f: () => boolean) => {
    for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(f()).toBe(true);
  };

  it('completes a dns-01 order through the signed webhook, wildcards included, and writes the PEMs to the sink', async () => {
    const secret = randomBytes(24).toString('hex');
    const calls: { action: string; fqdn: string; value: string }[] = [];
    const hook = express();
    hook.use(express.text({ type: '*/*' }));
    hook.post('/dns', (req, res) => {
      if (!verifyWebhookSignature(secret, String(req.headers['x-exprsn-signature']), req.body as string)) return res.status(401).send('bad signature');
      const b = JSON.parse(req.body as string) as { action: string; fqdn: string; value: string };
      calls.push(b);
      const list = zone.get(b.fqdn) ?? [];
      zone.set(b.fqdn, b.action === 'present' ? [...list, b.value] : list.filter((x) => x !== b.value));
      res.status(204).end();
    });
    const server = hook.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    cleanup.push(() => new Promise((r) => server.close(() => r())));
    const certDir = tmp('exprsn-certs-');
    const { h, a } = await withAcme({ ACME_DNS_PROVIDER: 'webhook', ACME_DNS_WEBHOOK_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/dns`, ACME_DNS_WEBHOOK_SECRET: secret, PLATFORM_ALLOWED_HOSTS: '127.0.0.1', ACME_CERT_DIR: certDir });
    const post = (u: string, body: object = {}) => a.agent.post(u).set('x-csrf-token', a.csrf).send(body);
    const sum = (await a.agent.get('/api/admin/platform/summary').expect(200)).body;
    expect(sum.acme).toMatchObject({ challenge: 'dns-01', dnsProvider: expect.stringMatching(/^webhook at 127\.0\.0\.1/), certDir });
    await post('/api/admin/platform/certificates', { domains: ['*.apps.internal', 'apps.internal'], use: 'TLS' }).expect(202);
    await h.s.jobs.runDue();
    const cert = (await a.agent.get('/api/admin/platform/certificates').expect(200)).body[0];
    expect(cert).toMatchObject({ status: 'valid', domains: ['*.apps.internal', 'apps.internal'] });
    expect(calls.filter((c) => c.action === 'present').map((c) => c.fqdn)).toEqual(['_acme-challenge.apps.internal', '_acme-challenge.apps.internal']);
    expect(calls.filter((c) => c.action === 'cleanup')).toHaveLength(2);
    expect(zone.get('_acme-challenge.apps.internal')).toEqual([]);
    // Every instance's sink writes the files on the bus event.
    const out = path.join(certDir, '_wildcard.apps.internal');
    await waitFor(() => existsSync(path.join(out, 'privkey.pem')));
    expect(readFileSync(path.join(out, 'fullchain.pem'), 'utf8')).toContain(acme.caPem.trim().split('\n')[1]!);
    expect(readFileSync(path.join(out, 'cert.pem'), 'utf8').match(/BEGIN CERTIFICATE/g)).toHaveLength(1);
    expect(statSync(path.join(out, 'privkey.pem')).mode & 0o777).toBe(0o600);
    const before = readFileSync(path.join(out, 'cert.pem'), 'utf8');
    await post(`/api/admin/platform/certificates/${cert.id}/renew`).expect(202);
    await h.s.jobs.runDue();
    await waitFor(() => readFileSync(path.join(out, 'cert.pem'), 'utf8') !== before);
    const audit = (await h.s.audit.list(h.tenantId, { action: 'platform.cert.issued' }))[0]!;
    expect(audit.detail).toMatchObject({ challenge: 'dns-01' });
  });

  it('completes a dns-01 order by RFC 2136 dynamic update signed with TSIG', async () => {
    const key: TsigKey = { name: 'acme-update.', algorithm: 'hmac-sha256', secret: randomBytes(32).toString('base64') };
    const dns = await fakeDnsServer(key, zone);
    cleanup.push(async () => void dns.socket.close());
    const { h, a } = await withAcme({ ACME_DNS_PROVIDER: 'rfc2136', ACME_DNS_RFC2136_SERVER: `127.0.0.1:${dns.port}`, ACME_DNS_RFC2136_ZONE: 'corp.internal', ACME_DNS_TSIG_NAME: key.name, ACME_DNS_TSIG_SECRET: key.secret });
    await a.agent.post('/api/admin/platform/certificates').set('x-csrf-token', a.csrf).send({ domains: ['gw.corp.internal'] }).expect(202);
    await h.s.jobs.runDue();
    const cert = (await a.agent.get('/api/admin/platform/certificates').expect(200)).body[0];
    expect(cert.status).toBe('valid');
    expect(dns.updates).toBe(2); // present and cleanup
    expect(zone.get('_acme-challenge.gw.corp.internal')).toEqual([]);
    // A wrong key is refused by the server, and a name outside the zone never leaves this process.
    const wrong = new Rfc2136DnsProvider(`127.0.0.1:${dns.port}`, 'corp.internal', { ...key, secret: randomBytes(32).toString('base64') }, 1000);
    await expect(wrong.present('x.corp.internal', 'v')).rejects.toThrow(/NOTAUTH/);
    await expect(wrong.present('x.elsewhere.internal', 'v')).rejects.toThrow(/not inside the zone/);
    // The update message itself: one zone, one TXT record, class NONE to delete.
    const m = parseMessage(buildTxtUpdate({ id: 7, zone: 'corp.internal', name: '_acme-challenge.gw.corp.internal', value: 'abc', ttl: 60, remove: true }));
    expect(m).toMatchObject({ opcode: 5, zone: [{ name: 'corp.internal', type: 6 }], updates: [{ name: '_acme-challenge.gw.corp.internal', type: 16, cls: 254, ttl: 0 }] });
  });

  it('keeps http-01 as the default and refuses wildcards without dns-01', async () => {
    acme = await startFakeAcme(async () => null);
    cleanup.push(() => acme.close());
    const h = await harnessWith({}, { ACME_DIRECTORY_URL: acme.directory });
    cleanup.push(() => h.close());
    const app = express();
    app.use(acmeChallengeRoutes(h.s));
    await localUser(h, 'root', ['system-admin'], 'restricted');
    const a = await loginAdmin(h, 'root');
    const r = await a.agent.post('/api/admin/platform/certificates').set('x-csrf-token', a.csrf).send({ domains: ['*.apps.internal'] }).expect(400);
    expect(r.body.detail).toMatch(/wildcards need dns-01/);
  });
});

describe('B-412: required bundle checks and dual control for signer keys', () => {
  function buildBundle(id: string, key: KeyObject): Buffer {
    const data = Buffer.from('left-pad tarball');
    const manifest = Buffer.from(JSON.stringify({ format: 'exprsn-bundle/1', id, files: [{ path: 'npm/left-pad.tgz', sha256: sha(data), size: data.length, mirror: 'npm' }], sbom: { bomFormat: 'CycloneDX', specVersion: '1.5', components: [{ name: 'left-pad', licenses: [{ license: { id: 'MIT' } }] }] } }));
    const sig = Buffer.from(JSON.stringify({ algorithm: 'ed25519', key: keyFingerprint(key), signature: sign(null, manifest, key).toString('base64') }));
    return writeTar([{ path: 'manifest.json', data: manifest }, { path: 'manifest.sig', data: sig }, { path: 'files/npm/left-pad.tgz', data }]);
  }

  async function setup(env: Record<string, string> = {}) {
    const h = await harness(env);
    cleanup.push(() => h.close());
    await localUser(h, 'root', ['system-admin'], 'restricted');
    await localUser(h, 'root2', ['system-admin'], 'restricted');
    const a = await loginAdmin(h, 'root');
    const b = await loginAdmin(h, 'root2');
    return { h, a, b };
  }

  const post = (c: Client, u: string, body: object = {}) => c.agent.post(u).set('x-csrf-token', c.csrf).send(body);
  const pem = (k: KeyObject) => k.export({ type: 'spki', format: 'pem' }).toString();

  it('needs a second platform admin to add or revoke a signer key (after the first)', async () => {
    const { h, a, b } = await setup();
    const k1 = generateKeyPairSync('ed25519');
    const k2 = generateKeyPairSync('ed25519');
    const first = await post(a, '/api/admin/platform/signers', { name: 'first', publicKeyPem: pem(k1.publicKey) }).expect(201);
    expect(first.body.state).toBe('active');
    const prop = (await post(a, '/api/admin/platform/signers', { name: 'second', publicKeyPem: pem(k2.publicKey) }).expect(202)).body.proposal;
    expect(prop).toMatchObject({ action: 'add', state: 'pending', name: 'second', proposedByName: 'ROOT' });
    await post(a, '/api/admin/platform/signers', { name: 'again', publicKeyPem: pem(k2.publicKey) }).expect(409);
    expect((await a.agent.get('/api/admin/platform/signers').expect(200)).body).toHaveLength(1);
    const own = await post(a, `/api/admin/platform/signers/proposals/${prop.id}/approve`).expect(403);
    expect(own.body.step).toBe('dual-control');
    const list = (await a.agent.get('/api/admin/platform/signers/proposals').expect(200)).body;
    expect(list[0]).toMatchObject({ id: prop.id, mine: true });
    const ok = (await post(b, `/api/admin/platform/signers/proposals/${prop.id}/approve`, { note: 'checked the fingerprint' }).expect(200)).body;
    expect(ok).toMatchObject({ proposal: { state: 'approved', decidedByName: 'ROOT2' }, key: { name: 'second', state: 'active' } });
    await post(b, `/api/admin/platform/signers/proposals/${prop.id}/approve`).expect(409);

    const rev = (await post(b, `/api/admin/platform/signers/${first.body.id}/revoke`, { reason: 'rotated out' }).expect(202)).body.proposal;
    await post(b, `/api/admin/platform/signers/proposals/${rev.id}/reject`).expect(409);
    await post(a, `/api/admin/platform/signers/proposals/${rev.id}/withdraw`).expect(403);
    await post(a, `/api/admin/platform/signers/proposals/${rev.id}/reject`, { note: 'not yet' }).expect(200);
    const rev2 = (await post(b, `/api/admin/platform/signers/${first.body.id}/revoke`, { reason: 'rotated out' }).expect(202)).body.proposal;
    await post(b, `/api/admin/platform/signers/proposals/${rev2.id}/withdraw`).expect(200);
    const rev3 = (await post(b, `/api/admin/platform/signers/${first.body.id}/revoke`, { reason: 'rotated out' }).expect(202)).body.proposal;
    await post(a, `/api/admin/platform/signers/proposals/${rev3.id}/approve`).expect(200);
    const keys = (await a.agent.get('/api/admin/platform/signers').expect(200)).body;
    expect(keys.find((k: { name: string }) => k.name === 'first')).toMatchObject({ state: 'revoked', revokeReason: 'rotated out' });
    const actions = (await h.s.audit.list(h.tenantId, { action: 'platform.signer', limit: 50 })).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['platform.signer.added', 'platform.signer.proposed', 'platform.signer.approved', 'platform.signer.rejected', 'platform.signer.withdrawn', 'platform.signer.revoked']));
    expect((await a.agent.get('/api/admin/platform/summary').expect(200)).body.signerProposals).toBe(0);
  });

  it('with PLATFORM_BUNDLE_REQUIRE_CHECKS, a bundle whose scan or staging did not run cannot be promoted', async () => {
    const { h, a } = await setup({ PLATFORM_BUNDLE_REQUIRE_CHECKS: 'true' });
    const k = generateKeyPairSync('ed25519');
    await post(a, '/api/admin/platform/signers', { name: 'offline', publicKeyPem: pem(k.publicKey) }).expect(201);
    const imp = async (name: string) => {
      const b = (await post(a, '/api/admin/platform/bundles', { name, transfer: 'diode' }).expect(201)).body;
      await a.agent.put(`/api/admin/platform/bundles/${b.id}/transfer`).set('x-csrf-token', a.csrf).set('content-type', 'application/octet-stream').send(buildBundle(name, k.privateKey)).expect(202);
      await h.s.jobs.runDue();
      return (await a.agent.get(`/api/admin/platform/bundles/${b.id}`).expect(200)).body;
    };
    const noScan = await imp('no-scan');
    expect(noScan.state).toBe('rejected');
    expect(noScan.steps[3]).toMatchObject({ state: 'failed', detail: expect.stringMatching(/required \(PLATFORM_BUNDLE_REQUIRE_CHECKS\)/) });
    await post(a, `/api/admin/platform/bundles/${noScan.id}/promote`).expect(409);
    h.s.ops.bundles.scanner = { name: 'fake-trivy', scan: async () => ({ findings: [] }) };
    const noStaging = await imp('no-staging');
    expect(noStaging.steps[5]).toMatchObject({ state: 'failed', detail: expect.stringMatching(/staging deploy is required/) });
    h.s.ops.bundles.staging = { name: 'fake staging', deploy: async () => ({ ok: true, detail: 'deployed' }) };
    const good = await imp('good');
    expect(good.state).toBe('ready to promote');
    await post(a, `/api/admin/platform/bundles/${good.id}/promote`).expect(202);
    await h.s.jobs.runDue();
    expect((await a.agent.get(`/api/admin/platform/bundles/${good.id}`).expect(200)).body.state).toBe('in production');

    // Verified while the checks were optional (skipped), then the setting turned on: promotion is refused.
    h.s.cfg.PLATFORM_BUNDLE_REQUIRE_CHECKS = false;
    h.s.ops.bundles.scanner = null;
    const lax = await imp('lax');
    expect(lax.steps[3].state).toBe('skipped');
    h.s.cfg.PLATFORM_BUNDLE_REQUIRE_CHECKS = true;
    const r = await post(a, `/api/admin/platform/bundles/${lax.id}/promote`).expect(409);
    expect(r.body.detail).toMatch(/SBOM and vulnerability scan/);
    expect((await a.agent.get('/api/admin/platform/summary').expect(200)).body.bundleRequireChecks).toBe(true);
  });
});
