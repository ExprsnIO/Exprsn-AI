import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { backendTlsProblems, loadConfig } from '../src/config/index.js';
import { canonicalJson } from '../src/crypto/index.js';
import { createDb, migrate } from '../src/db/knex.js';
import { createLogger, Metrics } from '../src/observability/index.js';
import { createServices } from '../src/services.js';
import { parseIdentityFile } from '../src/bootstrap.js';
import { OllamaClient } from '../src/gateway/ollama.js';
import { readText } from '../src/images/png.js';
import { rulesFromYaml } from '../src/guardrails/rules.js';
import { isNeverAddress } from '../src/mcp/hosts.js';
import { scrubSecrets } from '../src/platform/diagnostics.js';
import { serviceAddressProblem, servicePolicy } from '../src/platform/egress.js';
import { FsBlobStore } from '../src/platform/blob.js';
import { LocalKms } from '../src/platform/kms.js';
import { rewrapAll } from '../src/platform/rewrap.js';
import { parseYamlSafely } from '../src/platform/yaml.js';
import { buildQuery, parseMessage, signTsig, tcpFrame, txtValue, verifyTsig, verifyWebhookSignature, Rfc2136DnsProvider, DNS_TYPE_SOA, type TsigKey } from '../src/ops/dns.js';
import { keyFingerprint } from '../src/ops/bundles.js';
import { writeTar } from '../src/ops/tar.js';
import { npmManifest, pythonDist } from '../src/ops/push.js';
import { acmeChallengeRoutes } from '../src/routes/admin/platform.js';
import { cardManifest } from '../src/training/service.js';
import { probe } from '../src/zones/service.js';
import type { ConnectionSpec, DataDriver } from '../src/connections/drivers.js';
import { harness, localUser, login, loginAdmin, testConfig, type Client } from './helpers.js';
import { drain, harnessWith } from './retrieval-seed.js';
import { startFakeAcme, type FakeAcme } from './fake-acme.js';
import { FakeTrainer } from './fake-trainer.js';
import { FakeImageBackend, FakeSafety, harness8 } from './sprint8-fakes.js';
import { startFakeDevpi, startFakeHarbor, startFakeVerdaccio } from './sprint18-fakes.js';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), p));

let cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c().catch(() => undefined);
  cleanup = [];
});

const poster = (c: Client) => ({
  post: (u: string, b: object = {}) => c.agent.post(u).set('x-csrf-token', c.csrf).send(b),
  put: (u: string, b: object = {}) => c.agent.put(u).set('x-csrf-token', c.csrf).send(b),
  patch: (u: string, b: object = {}) => c.agent.patch(u).set('x-csrf-token', c.csrf).send(b),
  get: (u: string) => c.agent.get(u)
});

// ---------------------------------------------------------------------------------------------------------------

/** A DATA_KEY_FILE for production configurations (B-1205 refuses DATA_KEY inline in production). */
const dataKeyFile = () => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), 'exprsn-dk-')), 'data_key');
  writeFileSync(f, randomBytes(32).toString('base64'), { mode: 0o600 });
  return f;
};

describe('B-901: operator-chosen service URLs', () => {
  it('refuses metadata, link-local and unspecified addresses; loopback and private stay allowed', () => {
    const p = servicePolicy();
    for (const ip of ['169.254.169.254', 'fd00:ec2::254', '100.100.100.200', '192.0.0.192', '169.254.10.1', 'fe80::1', '0.0.0.0', '::', '::ffff:169.254.169.254']) expect(serviceAddressProblem(ip, ip, p), ip).not.toBeNull();
    for (const ip of ['127.0.0.1', '::1', '10.1.2.3', '172.20.0.5', '192.168.1.10', '100.64.1.1', 'fd12::5', '8.8.8.8']) expect(serviceAddressProblem(ip, ip, p), ip).toBeNull();
    // Public addresses need the allow-list once SERVICE_INTERNAL_ONLY is on.
    const internal = servicePolicy({ SERVICE_INTERNAL_ONLY: true, SERVICE_ALLOWED_HOSTS: '203.0.113.0/24' });
    expect(serviceAddressProblem('8.8.8.8', '8.8.8.8', internal)).toMatch(/public/);
    expect(serviceAddressProblem('203.0.113.9', '203.0.113.9', internal)).toBeNull();
    // An allow-list admits a link-local service network, never the metadata address itself.
    const ll = servicePolicy({ SERVICE_ALLOWED_HOSTS: '169.254.20.0/24,169.254.169.254' });
    expect(serviceAddressProblem('169.254.20.10', '169.254.20.10', ll)).toBeNull();
    expect(serviceAddressProblem('169.254.169.254', '169.254.169.254', ll)).toMatch(/metadata/);
    // The MCP, webhook and connection checks refuse the metadata addresses outside link-local too.
    expect(isNeverAddress('100.100.100.200')).toBe(true);
    expect(isNeverAddress('fd00:ec2::254')).toBe(true);
  });

  it('a pool instance pointing at 169.254.169.254 is refused; a local one is accepted', async () => {
    const h = await harness();
    cleanup.push(() => h.close());
    await localUser(h, 'root', ['system-admin'], 'restricted');
    const a = poster(await loginAdmin(h, 'root'));
    const pool = (await a.post('/api/admin/pools', { name: 'gpu', accelerator: 'cuda' }).expect(201)).body;
    const refused = await a.post(`/api/admin/pools/${pool.id}/instances`, { name: 'imds', url: 'http://169.254.169.254/latest', deploy: 'docker' }).expect(400);
    expect(refused.body.detail).toMatch(/metadata address/);
    await a.post(`/api/admin/pools/${pool.id}/instances`, { name: 'imds6', url: 'http://[fd00:ec2::254]:11434', deploy: 'docker' }).expect(400);
    await a.post(`/api/admin/pools/${pool.id}/instances`, { name: 'local', url: 'http://127.0.0.1:1', deploy: 'docker' }).expect(201);
    const inst = (await h.s.gateway.repo.instances(pool.id))[0]!;
    await a.patch(`/api/admin/instances/${inst.id}`, { url: 'http://169.254.169.254:11434' }).expect(400);
    expect((await h.s.gateway.repo.instance(inst.id))!.url).toBe('http://127.0.0.1:1');

    // Zone endpoints too.
    await a.post('/api/admin/zones/seed').expect(201);
    const ep = await a.post('/api/admin/zones/data/endpoints', { name: 'imds', address: '169.254.169.254:80' }).expect(400);
    expect(ep.body.detail).toMatch(/metadata/);
  });

  it('checks again when connecting: clients and probes refuse a metadata address', async () => {
    await expect(new OllamaClient('http://169.254.169.254', null, 1000).version()).rejects.toThrow(/refused/);
    expect((await probe('http://169.254.169.254/latest/meta-data', 500)).detail).toMatch(/^Refused/);
    expect((await probe('[fd00:ec2::254]:80', 500)).detail).toMatch(/^Refused/);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('B-902: TLS to the backing services in production', () => {
  const prod = (env: Record<string, string>) => ({
    NODE_ENV: 'production',
    PUBLIC_URL: 'https://ai.example.internal',
    SESSION_SECRET: randomBytes(32).toString('hex'),
    // Sprint 20 (B-1205): production takes the key from a file only.
    DATA_KEY_FILE: dataKeyFile(),
    ...env
  });

  it('production with sslmode=disable refuses to start with REQUIRE_BACKEND_TLS on', () => {
    const pg = { DB_CLIENT: 'pg', DATABASE_URL: 'postgres://app:pw@db.internal/app?sslmode=disable' };
    expect(() => loadConfig(prod({ ...pg, REQUIRE_BACKEND_TLS: 'true' }))).toThrow(/DATABASE_URL: PostgreSQL link without TLS/);
    // Off (the default), or a link exempted, or TLS asked for: it starts.
    expect(() => loadConfig(prod(pg))).not.toThrow();
    expect(() => loadConfig(prod({ ...pg, REQUIRE_BACKEND_TLS: 'true', BACKEND_TLS_EXEMPT: 'database' }))).not.toThrow();
    expect(() => loadConfig(prod({ DB_CLIENT: 'pg', DATABASE_URL: 'postgres://app:pw@db.internal/app?sslmode=verify-full', REQUIRE_BACKEND_TLS: 'true' }))).not.toThrow();
    // Only in production.
    expect(() => loadConfig({ ...prod({ ...pg, REQUIRE_BACKEND_TLS: 'true' }), NODE_ENV: 'development' })).not.toThrow();
  });

  it('checks MySQL, Redis, S3 and OpenBao links; SQLite is exempt', () => {
    const c = { DB_CLIENT: 'sqlite', BLOB_STORE: 'fs', BACKEND_TLS_EXEMPT: '' };
    expect(backendTlsProblems(c)).toEqual([]);
    expect(backendTlsProblems({ ...c, DB_CLIENT: 'mysql', DATABASE_URL: 'mysql://u:p@db/app' }).map((p) => p.path)).toEqual(['DATABASE_URL']);
    expect(backendTlsProblems({ ...c, DB_CLIENT: 'mysql', DATABASE_URL: 'mysql://u:p@db/app?ssl={"rejectUnauthorized":true}' })).toEqual([]);
    expect(backendTlsProblems({ ...c, REDIS_URL: 'redis://cache:6379', BLOB_STORE: 's3', S3_ENDPOINT: 'http://minio:9000', OPENBAO_ADDR: 'http://bao:8200' }).map((p) => p.path)).toEqual(['REDIS_URL', 'S3_ENDPOINT', 'OPENBAO_ADDR']);
    expect(backendTlsProblems({ ...c, REDIS_URL: 'rediss://cache:6380', BLOB_STORE: 's3', S3_ENDPOINT: 'https://minio:9000', OPENBAO_ADDR: 'https://bao:8200' })).toEqual([]);
    expect(backendTlsProblems({ ...c, REDIS_URL: 'redis://127.0.0.1:6379', BACKEND_TLS_EXEMPT: 'redis' })).toEqual([]);
    expect(() => loadConfig(prod({ REQUIRE_BACKEND_TLS: 'true', REDIS_URL: 'redis://cache:6379' }))).toThrow(/REDIS_URL/);
    expect(() => loadConfig(prod({ BACKEND_TLS_EXEMPT: 'postgres' }))).toThrow(/BACKEND_TLS_EXEMPT/);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('B-903: point-in-time consistent backups', () => {
  it('a blob written during a backup is neither missing nor orphaned after restore', async () => {
    const dir = tmp('exprsn-b903-');
    const secret = randomBytes(32).toString('hex');
    const key = randomBytes(32).toString('base64');
    const env = { SESSION_SECRET: secret, DATA_KEY: key, SQLITE_FILENAME: path.join(dir, 'db.sqlite'), BLOB_DIR: path.join(dir, 'blobs') };
    const h = await harness(env);
    cleanup.push(() => h.close());
    const root = await localUser(h, 'root', ['system-admin'], 'restricted');
    const attach = async (id: string) => {
      const k = `attachments/${h.tenantId}/${id}`;
      await h.s.blobs.put(k, Buffer.from(`body of ${id}`));
      await h.s.db('attachments').insert({ id, tenant_id: h.tenantId, user_id: root.id, name: `${id}.txt`, type: 'text/plain', size: 10, sha256: 'x'.repeat(64), state: 'ready', label: 'internal', blob_key: k, created_at: Date.now() });
      return k;
    };
    const before = await attach('before');
    // An object with no row (a write that never committed its row) is not archived.
    await h.s.blobs.put(`attachments/${h.tenantId}/orphan`, Buffer.from('no row'));
    // Written while the dump runs: after the snapshot, so neither its row nor its object belongs to this backup.
    let during = '';
    h.s.ops.backups.onSnapshot = async () => {
      during = await attach('during');
    };
    const b = await h.s.ops.backups.createNow({ tenantId: h.tenantId, actor: { service: 'test' }, userId: null });
    h.s.ops.backups.onSnapshot = null;
    expect(during).not.toBe('');
    expect(await h.s.db('attachments').where({ id: 'during' }).first()).toBeTruthy();
    const manifest = JSON.parse((await h.s.blobs.get(`platform/backups/${b.id}.manifest.json`))!.toString()).manifest;
    expect(manifest.blobs).toMatchObject({ selection: 'snapshot' });

    const rdir = tmp('exprsn-b903r-');
    const cfg = testConfig({ SESSION_SECRET: secret, DATA_KEY: key, SQLITE_FILENAME: path.join(rdir, 'db.sqlite'), BLOB_DIR: path.join(rdir, 'blobs') });
    const db = createDb(cfg);
    await migrate(db);
    const t = createServices(cfg, db, createLogger('silent', false), new Metrics());
    cleanup.push(async () => {
      await t.close();
      await db.destroy();
    });
    await t.ops.backups.restoreInto({ target: db, client: 'sqlite', kms: t.kms, from: new FsBlobStore(path.join(dir, 'blobs')), blobsTo: t.blobs, backupId: b.id, force: false });
    // The row from before the snapshot has its object; the one written during the dump has neither.
    expect(await db('attachments').where({ id: 'before' }).first()).toBeTruthy();
    expect((await t.blobs.get(before))!.toString()).toBe('body of before');
    expect(await db('attachments').where({ id: 'during' }).first()).toBeUndefined();
    expect(await t.blobs.get(during)).toBeNull();
    expect(await t.blobs.get(`attachments/${h.tenantId}/orphan`)).toBeNull();
    // Every row that names an object has it.
    for (const r of (await db('attachments').whereNotNull('blob_key')) as { blob_key: string }[]) expect(await t.blobs.get(r.blob_key)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('B-904: ACME external account binding, RFC 2136 over TCP, certificate push hooks', () => {
  async function withAcme(env: Record<string, string>, eab?: { kid: string; key: Buffer }) {
    const challengeApp = express();
    const acme: FakeAcme = await startFakeAcme(async (_domain, token) => {
      const r = await request(challengeApp).get(`/.well-known/acme-challenge/${token}`);
      return r.status === 200 ? r.text : null;
    }, eab ? { eab } : {});
    cleanup.push(() => acme.close());
    const h = await harnessWith({}, { ACME_DIRECTORY_URL: acme.directory, ACME_POLL_MS: '10', ...env });
    cleanup.push(() => h.close());
    challengeApp.use(acmeChallengeRoutes(h.s));
    await localUser(h, 'root', ['system-admin'], 'restricted');
    const a = poster(await loginAdmin(h, 'root'));
    return { h, a, acme };
  }

  it('an EAB order completes against the fake ACME; without the binding the CA refuses', async () => {
    const eab = { kid: 'kid-2026-internal', key: randomBytes(32) };
    const ok = await withAcme({ ACME_EAB_KID: eab.kid, ACME_EAB_HMAC_KEY: eab.key.toString('base64url') }, eab);
    await ok.a.post('/api/admin/platform/certificates', { domains: ['gw.app.internal'] }).expect(202);
    await ok.h.s.jobs.runDue();
    const cert = (await ok.a.get('/api/admin/platform/certificates').expect(200)).body[0];
    expect(cert.status).toBe('valid');
    expect(ok.acme.eabBound).toEqual([eab.kid]);

    const missing = await withAcme({}, eab);
    await missing.a.post('/api/admin/platform/certificates', { domains: ['gw.app.internal'] }).expect(202);
    await missing.h.s.jobs.runDue();
    const failed = (await missing.a.get('/api/admin/platform/certificates').expect(200)).body[0];
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/external account binding/);
    expect(() => loadConfig({ ...process.env, NODE_ENV: 'test', SESSION_SECRET: 'x'.repeat(40), DATA_KEY: randomBytes(32).toString('base64'), ACME_EAB_KID: 'k' } as NodeJS.ProcessEnv)).toThrow(/go together/);
  });

  it('a renewal calls the hooks: a signed webhook and a named reload command', async () => {
    const received: { headers: Record<string, string>; body: string }[] = [];
    const hook = express();
    hook.use(express.text({ type: '*/*' }));
    hook.post('/reload', (req, res) => {
      received.push({ headers: req.headers as Record<string, string>, body: req.body as string });
      res.status(204).end();
    });
    const server = hook.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    cleanup.push(() => new Promise((r) => server.close(() => r(null))));
    const marker = path.join(tmp('exprsn-hook-'), 'reloaded');
    const cmds = { touch: [process.execPath, '-e', 'require("fs").writeFileSync(process.argv[1], process.env.CERT_NAME + " " + process.env.CERT_SERIAL)', marker] };
    const { h, a } = await withAcme({ ACME_RELOAD_COMMANDS: JSON.stringify(cmds) });
    await a.post('/api/admin/platform/certificates', { domains: ['proxy.app.internal'] }).expect(202);
    await h.s.jobs.runDue();
    const cert = (await a.get('/api/admin/platform/certificates').expect(200)).body[0];
    // Hooks: an unknown command is refused; the webhook secret is shown once.
    await a.post(`/api/admin/platform/certificates/${cert.id}/hooks`, { kind: 'command', command: 'rm-rf' }).expect(400);
    await a.post(`/api/admin/platform/certificates/${cert.id}/hooks`, { kind: 'webhook', url: 'http://169.254.169.254/x' }).expect(400);
    const wh = (await a.post(`/api/admin/platform/certificates/${cert.id}/hooks`, { kind: 'webhook', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/reload` }).expect(201)).body;
    expect(wh.secret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    await a.post(`/api/admin/platform/certificates/${cert.id}/hooks`, { kind: 'command', command: 'touch' }).expect(201);
    const listed = (await a.get(`/api/admin/platform/certificates/${cert.id}/hooks`).expect(200)).body;
    expect(listed.commands).toEqual(['touch']);
    expect(JSON.stringify(listed)).not.toContain(wh.secret);
    const row = await h.s.db('platform_cert_hooks').where({ id: wh.id }).first();
    expect(row.secret_sealed).toMatch(/^v2\./);

    await a.post(`/api/admin/platform/certificates/${cert.id}/renew`).expect(202);
    await h.s.jobs.runDue();
    for (let i = 0; i < 100 && (!received.length || !existsSync(marker)); i++) await new Promise((r) => setTimeout(r, 20));
    expect(received).toHaveLength(1);
    expect(received[0]!.headers['x-exprsn-event']).toBe('certificate.renewed');
    expect(verifyWebhookSignature(wh.secret, received[0]!.headers['x-exprsn-signature']!, received[0]!.body)).toBe(true);
    const payload = JSON.parse(received[0]!.body);
    expect(payload.certificate).toMatchObject({ id: cert.id, name: 'proxy.app.internal' });
    expect(payload.chainPem).toContain('BEGIN CERTIFICATE');
    expect(received[0]!.body).not.toMatch(/PRIVATE KEY/);
    expect(readFileSync(marker, 'utf8')).toMatch(/^proxy\.app\.internal [0-9A-F]+/i);
    for (let i = 0; i < 50 && (await h.s.audit.list(h.tenantId, { action: 'platform.cert.hook.ran' })).length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    expect((await h.s.audit.list(h.tenantId, { action: 'platform.cert.hook.ran' })).length).toBe(2);
    const after = (await a.get(`/api/admin/platform/certificates/${cert.id}/hooks`).expect(200)).body.hooks;
    expect(after.map((x: { lastState: string }) => x.lastState)).toEqual(['ok', 'ok']);
  });

  it('RFC 2136: finds the zone from the SOA and falls back to TCP when the UDP answer is truncated', async () => {
    const key: TsigKey = { name: 'acme-update.', algorithm: 'hmac-sha256', secret: randomBytes(32).toString('base64') };
    const zone = new Map<string, string[]>();
    const seen = { udpUpdates: 0, tcpUpdates: 0, soa: 0 };
    const u16 = (n: number) => Buffer.from([n >> 8, n & 0xff]);
    const answer = (msg: Buffer, via: 'udp' | 'tcp'): Buffer => {
      const req = parseMessage(msg);
      const header = (flags: number, qd = 0, an = 0, ns = 0) => Buffer.concat([u16(req.id), u16(flags), u16(qd), u16(an), u16(ns), u16(0)]);
      if (req.opcode === 0) {
        // A query for the SOA of _acme-challenge.<name>: an authoritative NXDOMAIN with the zone's SOA as authority.
        seen.soa++;
        const q = Buffer.concat([...req.zone[0]!.name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0]), u16(DNS_TYPE_SOA), u16(1)]);
        const owner = Buffer.concat(['apps', 'internal'].map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])).concat([Buffer.from([0])]));
        const rdata = Buffer.concat([owner, owner, Buffer.alloc(20)]);
        return Buffer.concat([header(0x8403, 1, 0, 1), q, owner, u16(DNS_TYPE_SOA), u16(1), Buffer.from([0, 0, 0, 60]), u16(rdata.length), rdata]);
      }
      if (via === 'udp') {
        seen.udpUpdates++;
        return header(0x8000 | (5 << 11) | 0x0200); // TC: ask again over TCP
      }
      seen.tcpUpdates++;
      const ok = verifyTsig(msg, key).ok && req.zone[0]!.name === 'apps.internal';
      if (ok) for (const u of req.updates) zone.set(u.name, u.cls === 1 ? [...(zone.get(u.name) ?? []), txtValue(u.rdata)] : (zone.get(u.name) ?? []).filter((x) => x !== txtValue(u.rdata)));
      const t = req.additional[req.additional.length - 1]!;
      const alg = t.rdata.indexOf(0) + 1;
      const reqMac = t.rdata.subarray(alg + 10, alg + 10 + t.rdata.readUInt16BE(alg + 8));
      return signTsig(header(0x8000 | (5 << 11) | (ok ? 0 : 9)), key, Date.now(), 300, reqMac).signed;
    };
    const tcp: TcpServer = createTcpServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.on('data', (c: Buffer) => {
        buf = Buffer.concat([buf, c]);
        if (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) sock.end(tcpFrame(answer(buf.subarray(2, 2 + buf.readUInt16BE(0)), 'tcp')));
      });
    });
    await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r));
    const port = (tcp.address() as AddressInfo).port;
    const udp = createSocket('udp4');
    udp.on('message', (m, rinfo) => udp.send(answer(m, 'udp'), rinfo.port, rinfo.address));
    await new Promise<void>((r) => udp.bind(port, '127.0.0.1', r));
    cleanup.push(() => new Promise((r) => tcp.close(() => r(null))), async () => udp.close());

    const dns = new Rfc2136DnsProvider(`127.0.0.1:${port}`, null, key, 2000, 60, 'auto');
    expect(dns.name).toMatch(/zone from SOA, UDP with TCP fallback/);
    expect(await dns.zoneFor('_acme-challenge.gw.apps.internal')).toBe('apps.internal');
    await dns.present('gw.apps.internal', 'token-value');
    expect(zone.get('_acme-challenge.gw.apps.internal')).toEqual(['token-value']);
    await dns.cleanup('gw.apps.internal', 'token-value');
    expect(zone.get('_acme-challenge.gw.apps.internal')).toEqual([]);
    expect(seen).toMatchObject({ udpUpdates: 2, tcpUpdates: 2, soa: 1 });
    // TCP only skips UDP.
    const tcpOnly = new Rfc2136DnsProvider(`127.0.0.1:${port}`, 'apps.internal', key, 2000, 60, 'tcp');
    await tcpOnly.present('x.apps.internal', 'v');
    expect(seen.udpUpdates).toBe(2);
    expect(buildQuery({ id: 1, name: 'a.b', type: DNS_TYPE_SOA }).length).toBe(12 + 5 + 4);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('B-905: training data protection (worker contract 2)', () => {
  const BASE = 'llama3.1:8b-q5_K_M';
  const ROWS = [
    { prompt: 'What is the refund window?', completion: 'Thirty days. Contact billing@northwind.example for exceptions.' },
    { prompt: 'Card on file?', completion: 'The card 4111 1111 1111 1111 was charged.' },
    { prompt: 'Quarter close?', completion: 'Done, the ledger is closed.' }
  ];

  async function setup(trainer: FakeTrainer, env: Record<string, string> = {}) {
    const h = await harnessWith({ trainer }, env);
    cleanup.push(() => h.close());
    trainer.useApp(h.app);
    const m = await h.s.gateway.repo.createModel({ name: BASE, source: 'Ollama library', expectedDigest: null, license: { name: 'Llama 3.1 Community' }, label: 'internal', notes: null, requestedBy: 'x', requestedTenant: h.tenantId });
    await h.s.gateway.repo.updateModel(m.id, { state: 'approved', import_state: 'pulled', digest: 'sha256:7d21e6b0', family: 'llama', parameter_size: '8B', capabilities: ['completion'] });
    await localUser(h, 'mara', ['ml-admin'], 'confidential');
    const a = poster(await loginAdmin(h, 'mara'));
    await a.post('/api/training/windows', { name: 'dedicated', kind: 'always' }).expect(201);
    const d = await a.post('/api/training/datasets', { name: 'support', label: 'internal', source: 'tickets', rows: ROWS }).expect(202);
    await drain(h);
    const j = (await a.post('/api/training/jobs', { name: 'support-lora', baseModel: BASE, datasetId: d.body.id, method: { kind: 'lora', rank: 16, alpha: 32, epochs: 2, seed: 1 }, hardware: { accelerator: 'cuda', gpus: 1, memoryGb: 80 }, steps: 1000, checkpointEvery: 250 }).expect(201)).body;
    return { h, a, j };
  }

  it('the submit request carries no plaintext rows; the key is released once; artefacts come back sealed', async () => {
    const trainer = new FakeTrainer();
    trainer.preemptAt = 250;
    const { h, a, j } = await setup(trainer);
    await drain(h);
    await h.s.training.tick();
    await drain(h);
    expect(trainer.requests.length).toBeGreaterThanOrEqual(1);
    const sent = trainer.requests[0]!;
    for (const plain of ['refund window', 'Card on file', 'ledger is closed', '[EMAIL]']) expect(sent).not.toContain(plain);
    const body = JSON.parse(sent) as { contract: number; sealed: { cipher: string; ciphertext: string; key: { url: string; token: string }; artifacts: { url: string } } };
    expect(body).toMatchObject({ contract: 2, sealed: { cipher: 'aes-256-gcm' } });
    // The worker decrypted what it was sent: the scrubbed rows.
    expect(trainer.submits[0]!.data).toContain('refund window');
    expect(trainer.submits[0]!.data).toContain('[EMAIL]');
    expect(trainer.submits[0]!.data).not.toContain('billing@northwind');
    // Released once: a second fetch, or a wrong token, is refused and audited.
    const keyPath = new URL(body.sealed.key.url).pathname;
    await request(h.app).post(keyPath).set('authorization', `Bearer ${body.sealed.key.token}`).expect(410);
    await request(h.app).post(keyPath).set('authorization', `Bearer ${'x'.repeat(43)}`).expect(401);
    expect((await h.s.audit.list(h.tenantId, { action: 'training.worker.key.released' })).length).toBe(1);
    expect((await h.s.audit.list(h.tenantId, { action: 'training.worker.key.refused' })).length).toBe(2);
    const grant = await h.s.db('training_worker_grants').where({ kind: 'key' }).first();
    expect(grant.key_sealed).toBeNull();
    expect(grant.token_hash).toMatch(/^[0-9a-f]{64}$/);

    // The preempted run's checkpoint is in the platform's blob store, sealed under the tenant key.
    for (let i = 0; i < 5 && trainer.submits.length < 2; i++) {
      await h.s.training.tick();
      await drain(h);
    }
    const art = await h.s.db('training_artifacts').where({ job_id: j.id, name: 'step-250.safetensors' }).first();
    expect(art).toMatchObject({ kind: 'checkpoint', blob_key: `training/${h.tenantId}/jobs/${j.id}/artifacts/step-250.safetensors` });
    expect(art.key_sealed).toMatch(/^v2\./);
    expect((await h.s.blobs.get(art.blob_key))!.toString('latin1')).not.toContain('WEIGHTS');
    // Resuming reads it back through the new run's grant.
    expect(trainer.submits).toHaveLength(2);
    expect(trainer.submits[1]!.spec.resumeFrom).toMatchObject({ step: 250, ref: 'exprsn-artifact:step-250.safetensors' });
    expect([...trainer.resumedFrom.values()]).toEqual([`WEIGHTS job=${j.id} step=250`]);
    expect((await a.get(`/api/training/jobs/${j.id}`).expect(200)).body.checkpoint).toMatchObject({ step: 250 });
    // The first run's artefact grant was replaced by the second's.
    await request(h.app).get(`${new URL(body.sealed.artifacts.url).pathname}/step-250.safetensors`).set('authorization', 'Bearer nope-nope-nope-nope-nope').expect(401);
  });

  it('a contract-1 worker is refused unless the plaintext fallback is set', async () => {
    const t1 = new FakeTrainer();
    t1.contract = 1;
    const { h, a, j } = await setup(t1);
    await drain(h);
    await h.s.training.tick();
    await drain(h);
    expect(t1.submits).toHaveLength(0);
    expect((await a.get(`/api/training/jobs/${j.id}`).expect(200)).body.waitReason).toMatch(/contract 1/);

    const t2 = new FakeTrainer();
    t2.contract = 1;
    const second = await setup(t2, { TRAINER_PLAINTEXT_FALLBACK: 'true' });
    await drain(second.h);
    await second.h.s.training.tick();
    await drain(second.h);
    expect(t2.submits).toHaveLength(1);
    expect(JSON.parse(t2.requests[0]!).data).toContain('refund window');
  });

  it('requires the worker certificate when TRAINER_CLIENT_CERT_SHA256 is set', async () => {
    const fp = sha('worker cert').toUpperCase().match(/../g)!.join(':');
    const trainer = new FakeTrainer();
    const { h } = await setup(trainer, { TRAINER_CLIENT_CERT_SHA256: fp });
    await drain(h);
    await h.s.training.tick();
    await drain(h);
    // The fake presents no certificate, so its key fetch is refused and the run does not start.
    expect(trainer.submits).toHaveLength(0);
    expect((await h.s.audit.list(h.tenantId, { action: 'training.worker.key.refused' }))[0]).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('B-906: kms:rewrap re-signs image provenance and training model cards', () => {
  it('after a re-wrap, old images still verify', async () => {
    const dir = tmp('exprsn-b906-');
    const oldKey = randomBytes(32).toString('base64');
    const newKey = randomBytes(32).toString('base64');
    const common = { SQLITE_FILENAME: path.join(dir, 'db.sqlite'), BLOB_DIR: path.join(dir, 'blobs'), SESSION_SECRET: randomBytes(32).toString('hex') };
    const backend = new FakeImageBackend();
    const h1 = await harness8({ ...common, DATA_KEY: oldKey }, { imageBackends: [backend], imageSafety: new FakeSafety() });
    await localUser(h1, 'mem', ['member']);
    const m1 = await login(h1, 'mem');
    await m1.agent.post('/api/images').set('x-csrf-token', m1.csrf).send({ backend: 'fake-sdxl', width: 1024, height: 768, prompt: 'A loading bay', count: 1, seed: 7 }).expect(202);
    await h1.s.jobs.runDue();
    const img = (await m1.agent.get('/api/images').expect(200)).body[0];
    expect((await m1.agent.get(`/api/images/${img.id}/provenance`).expect(200)).body.verified).toBe(true);
    // A registered model card, signed with the old key.
    const card = { baseModel: 'b', baseDigest: 'sha256:1', dataset: { id: 'd', name: 'ds', version: 1, hash: 'sha256:2', label: 'internal', rows: 3 }, trainer: 'trl', container: null, hyperparameters: 'LoRA', method: {}, hardware: {}, approval: null, evals: [], packaging: { requested: 'Q4_K_M', quantization: 'Q4_K_M', tool: 'llama.cpp', artifact: 'x', digest: 'sha256:3', sizeBytes: 1 }, registration: { state: 'registered', reason: null, modelId: 'm', model: 'tuned:8b' }, manifest: null as null | { signature: string; key: string; signedAt: number } };
    const cardKey = 'exprsn-training-manifests';
    card.manifest = { signature: await h1.s.kms.hmac(cardKey, canonicalJson(cardManifest({ id: 'JOB1', name: 'tuned' }, card as never))), key: cardKey, signedAt: Date.now() };
    await h1.s.db('training_jobs').insert({ id: 'JOB1', tenant_id: h1.tenantId, name: 'tuned', base_model: 'b', dataset_id: 'd', method: '{}', trainer: 'trl', hardware: '{}', max_hours: 1, priority: 'normal', packaging: 'Q4_K_M', label: 'internal', state: 'succeeded', steps: 1, epochs: 1, card: JSON.stringify(card), created_by: 'u', created_at: Date.now(), updated_at: Date.now() });
    expect(await h1.s.training.verifyCard(h1.tenantId, 'JOB1')).toBe(true);
    await h1.close();

    // Re-wrap to the new key with the old one as previous; then the old key is gone.
    const h2 = await harness8({ ...common, DATA_KEY: newKey, DATA_KEY_PREVIOUS: oldKey }, { imageBackends: [backend] });
    const r = await rewrapAll({ db: h2.s.db, blobs: h2.s.blobs, target: new LocalKms(newKey), previous: new LocalKms(oldKey), kekName: (scope) => h2.s.keys.kekName(scope), keys: h2.s.keys });
    expect(r.verified).toBe(true);
    expect(r.images).toMatchObject({ total: 1, resigned: 1, failed: [] });
    expect(r.modelCards).toMatchObject({ total: 1, resigned: 1, failed: [] });
    const again = await rewrapAll({ db: h2.s.db, blobs: h2.s.blobs, target: new LocalKms(newKey), previous: new LocalKms(oldKey), kekName: (scope) => h2.s.keys.kekName(scope), keys: h2.s.keys });
    expect(again.images).toMatchObject({ already: 1, resigned: 0 });
    await h2.close();

    const h3 = await harness8({ ...common, DATA_KEY: newKey }, { imageBackends: [backend] });
    cleanup.push(() => h3.close());
    const m3 = await login(h3, 'mem');
    const v = (await m3.agent.get(`/api/images/${img.id}/provenance`).expect(200)).body;
    expect(v).toMatchObject({ verified: true, signature: true, bytesMatch: true, embedded: true });
    // The copy embedded in the PNG carries the new signature too.
    const row = await h3.s.db('image_jobs').where({ id: img.id }).first();
    const png = await h3.s.keys.openBytes(row.tenant_id, (await h3.s.blobs.get(row.blob_key))!.toString(), `image:${img.id}`);
    expect(JSON.parse(readText(png)['exprsn-provenance']!).signature).toBe(JSON.parse(row.provenance).signature);
    expect(await h3.s.training.verifyCard(h3.tenantId, 'JOB1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('B-907: YAML caps and scrubbed diagnostics', () => {
  const LOL = ['a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]', 'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]', 'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]', 'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]', 'e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]', 'f: [*e,*e,*e,*e,*e,*e,*e,*e,*e]'].join('\n');

  it('a billion-laughs YAML is refused, for guardrail rules and for the identity file', () => {
    expect(() => rulesFromYaml(LOL)).toThrow(/aliases/);
    expect(() => parseIdentityFile(`tenants: []\nx: ${LOL.replace(/\n/g, '\n  ')}`)).toThrow();
    expect(() => parseYamlSafely(LOL, { maxAliases: 50 })).toThrow(/alias/i);
    const deep = `${'['.repeat(200)}1${']'.repeat(200)}`;
    expect(() => rulesFromYaml(deep)).toThrow(/nested deeper/);
    expect(() => parseYamlSafely('a:\n' + Array.from({ length: 40 }, (_, i) => `${'  '.repeat(i + 1)}k${i}:`).join('\n') + ' 1')).toThrow(/nested deeper/);
    expect(() => parseYamlSafely('x'.repeat(2048), { maxBytes: 1024 })).toThrow(/larger than/);
    // Ordinary files still parse, and a few anchors are fine in the identity file.
    expect(parseYamlSafely('a: &x [1, 2]\nb: *x', { maxAliases: 5 })).toEqual({ a: [1, 2], b: [1, 2] });
    expect(rulesFromYaml('- id: r1\n  name: Rule\n')).toEqual([{ id: 'r1', name: 'Rule' }]);
  });

  it('a driver message with a password shows it masked', async () => {
    const PW = 'Sup3r-S3cret-pw';
    class FailingDriver implements DataDriver {
      constructor(readonly spec: ConnectionSpec) {}
      private fail(): never {
        throw new Error(`connect to postgres://app:${this.spec.password}@db.data.internal/ledger failed: password authentication failed for user "app" (password=${this.spec.password})`);
      }
      async test(): Promise<never> {
        this.fail();
      }
      async introspect(): Promise<never> {
        this.fail();
      }
      async query(): Promise<never> {
        this.fail();
      }
      async rows(): Promise<never> {
        this.fail();
      }
    }
    const h = await harnessWith({ drivers: { postgres: (spec) => new FailingDriver(spec) } }, { CONNECTIONS_ALLOWED_HOSTS: 'db.data.internal' });
    cleanup.push(() => h.close());
    await localUser(h, 'conn', ['connection-admin', 'member'], 'confidential');
    const a = poster(await loginAdmin(h, 'conn'));
    const c = (await a.post('/api/admin/connections', { name: 'ledger', engine: 'postgres', endpoint: 'db.data.internal:5432', database: 'ledger', label: 'internal', username: 'app', password: PW }).expect(201)).body;
    const test = (await a.post(`/api/admin/connections/${c.id}/test`).expect(200)).body;
    expect(test.ok).toBe(false);
    expect(test.detail).not.toContain(PW);
    expect(test.detail).toContain('postgres://app:********@db.data.internal');
    const intro = await a.post(`/api/admin/connections/${c.id}/schema/refresh`);
    expect(JSON.stringify(intro.body)).not.toContain(PW);
    const stored = await h.s.db('data_connections').where({ id: c.id }).first();
    expect(stored.health_detail).not.toContain(PW);
    // The same scrub applies to any problem detail the API returns.
    expect(scrubSecrets('token=abc123def and Authorization: Bearer abcdefghijklmnopqrstu')).toBe('token=******** and Authorization: Bearer ********');
    expect(scrubSecrets('Invalid token: the code expired')).toBe('Invalid token: the code expired');
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('B-908: zones re-check members registered before them', () => {
  class OkDriver implements DataDriver {
    constructor(readonly spec: ConnectionSpec) {}
    async test() {
      return { version: 'MySQL 8.4', readOnly: true, health: 'healthy' as const, detail: 'ok' };
    }
    async introspect() {
      return [];
    }
    async query() {
      return { columns: [], rows: [], capped: false, estimate: null };
    }
    async rows() {
      return { columns: [], rows: [], capped: false, estimate: null };
    }
  }

  it('pre-existing members outside their zone are listed with a one-click proposal to move', async () => {
    const h = await harnessWith({ drivers: { mysql: (spec) => new OkDriver(spec) } }, { CONNECTIONS_ALLOWED_HOSTS: 'mysql.data.internal', MCP_ALLOWED_HOSTS: '127.0.0.1' });
    cleanup.push(() => h.close());
    await localUser(h, 'root', ['system-admin'], 'restricted');
    await localUser(h, 'root2', ['system-admin'], 'restricted');
    const a = poster(await loginAdmin(h, 'root'));
    const b = poster(await loginAdmin(h, 'root2'));
    // Registered before any zone exists: nothing is checked yet.
    const c1 = (await a.post('/api/admin/connections', { name: 'legacy', engine: 'mysql', endpoint: 'mysql.data.internal', zone: 'nowhere', label: 'internal' }).expect(201)).body;
    const c2 = (await a.post('/api/admin/connections', { name: 'hr', engine: 'mysql', endpoint: 'mysql.data.internal', zone: 'sandbox', label: 'restricted' }).expect(201)).body;
    const mcp = await a.post('/api/admin/mcp-servers', { name: 'tools', url: 'http://127.0.0.1:9/mcp', zone: 'nowhere' });
    expect([201, 202]).toContain(mcp.status);
    expect((await a.get('/api/admin/zones/misplaced').expect(200)).body.misplaced).toEqual([]);

    // The first zones appear: the members are re-checked, audited and admins told.
    const seeded = (await a.post('/api/admin/zones/seed').expect(201)).body;
    // Seeding raises a default ceiling to what a zone already holds (sandbox keeps hr), so hr fits; the others do not.
    expect(seeded.misplaced).toBe(2);
    expect((await h.s.audit.list(h.tenantId, { action: 'zone.members.rechecked' })).length).toBe(1);
    const list = (await a.get('/api/admin/zones/misplaced').expect(200)).body.misplaced as { kind: string; id: string; name: string; reason: string; suggestion: string | null; pending: string | null }[];
    expect(list.map((m) => [m.kind, m.name, m.suggestion])).toEqual([
      ['connection', 'legacy', 'data'],
      ['mcp', 'tools', 'app']
    ]);
    expect(list.find((m) => m.name === 'legacy')!.reason).toMatch(/not defined/);
    expect((await a.get('/api/admin/zones').expect(200)).body.misplaced).toHaveLength(2);

    // One click: a proposal that moves the member into the suggested zone, under dual control.
    const moves = list.filter((m) => m.suggestion === 'data').map((m) => ({ kind: m.kind, id: m.id }));
    await a.post('/api/admin/zones/data/proposals', { moveMembers: moves, reason: 'Registered before zones' }).expect(201);
    expect((await a.get('/api/admin/zones/misplaced').expect(200)).body.misplaced.filter((m: { pending: string | null }) => m.pending === 'data')).toHaveLength(1);
    await a.post('/api/admin/zones/data/draft/approve', {}).expect(403);
    const ok = (await b.post('/api/admin/zones/data/draft/approve', {}).expect(200)).body;
    expect(ok.movedMembers.map((m: { name: string }) => m.name)).toEqual(['legacy']);
    expect((await h.s.db('data_connections').where({ id: c1.id }).first()).zone).toBe('data');
    expect((await h.s.db('data_connections').where({ id: c2.id }).first()).zone).toBe('sandbox');
    expect((await a.get('/api/admin/zones/misplaced').expect(200)).body.misplaced.map((m: { name: string }) => m.name)).toEqual(['tools']);
    // A move into a zone that cannot hold the member is refused.
    const low = (await a.post('/api/admin/connections', { name: 'low', engine: 'mysql', endpoint: 'mysql.data.internal', zone: 'data', label: 'restricted' }).expect(201)).body;
    await a.post('/api/admin/zones/inference/proposals', { moveMembers: [{ kind: 'connection', id: low.id }] }).expect(422);
    await a.post('/api/admin/zones/external/proposals', { moveMembers: [{ kind: 'mcp', id: list.find((m) => m.kind === 'mcp')!.id }] }).expect(403);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('B-909: promoted artefacts pushed to Harbor, Verdaccio and devpi', () => {
  function bundleOf(id: string, files: { path: string; mirror: string; data: Buffer }[], key: KeyObject): Buffer {
    const manifest = { format: 'exprsn-bundle/1', id, created: '2026-09-30T10:00:00Z', files: files.map((f) => ({ path: f.path, sha256: sha(f.data), size: f.data.length, mirror: f.mirror })), sbom: { bomFormat: 'CycloneDX', specVersion: '1.5', components: [{ name: 'left-pad', version: '1.3.0', licenses: [{ license: { id: 'MIT' } }] }] } };
    const bytes = Buffer.from(JSON.stringify(manifest));
    const sig = Buffer.from(JSON.stringify({ algorithm: 'ed25519', key: keyFingerprint(key), signature: sign(null, bytes, key).toString('base64') }));
    return writeTar([{ path: 'manifest.json', data: bytes }, { path: 'manifest.sig', data: sig }, ...files.map((f) => ({ path: `files/${f.path}`, data: f.data }))]);
  }

  const npmTgz = (name: string, version: string) => gzipSync(writeTar([{ path: 'package/package.json', data: Buffer.from(JSON.stringify({ name, version, description: 'Pads left', license: 'MIT' })) }, { path: 'package/index.js', data: Buffer.from('module.exports = (s, n) => s.padStart(n);\n') }]));

  function ociLayout(): Buffer {
    const layer = gzipSync(writeTar([{ path: 'hello.txt', data: Buffer.from('hello\n') }]));
    const config = Buffer.from(JSON.stringify({ architecture: 'amd64', os: 'linux', rootfs: { type: 'layers', diff_ids: [] } }));
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: `sha256:${sha(config)}`, size: config.length }, layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: `sha256:${sha(layer)}`, size: layer.length }] }));
    const index = Buffer.from(JSON.stringify({ schemaVersion: 2, manifests: [{ mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: `sha256:${sha(manifest)}`, size: manifest.length, annotations: { 'io.containerd.image.name': 'registry.example/library/demo:1.0', 'org.opencontainers.image.ref.name': '1.0' } }] }));
    return writeTar([{ path: 'oci-layout', data: Buffer.from('{"imageLayoutVersion":"1.0.0"}') }, { path: 'index.json', data: index }, ...[config, layer, manifest].map((b) => ({ path: `blobs/sha256/${sha(b)}`, data: b }))]);
  }

  it('a promoted npm package appears in a fake Verdaccio; wheels reach devpi and images reach Harbor', async () => {
    const token = randomBytes(16).toString('hex');
    const verdaccio = await startFakeVerdaccio(token);
    const devpi = await startFakeDevpi('root', 'devpi-pw');
    const harbor = await startFakeHarbor('robot$push', 'harbor-pw');
    cleanup.push(() => verdaccio.close(), () => devpi.close(), () => harbor.close());
    const h = await harness();
    cleanup.push(() => h.close());
    await localUser(h, 'root', ['system-admin'], 'restricted');
    const a = poster(await loginAdmin(h, 'root'));
    const signer = generateKeyPairSync('ed25519');
    await a.post('/api/admin/platform/signers', { name: 'import', publicKeyPem: signer.publicKey.export({ type: 'spki', format: 'pem' }).toString() }).expect(201);
    const npm = (await a.post('/api/admin/platform/mirrors', { name: 'npm', kind: 'npm', store: 'Verdaccio', url: `${verdaccio.url}/` }).expect(201)).body;
    const pypi = (await a.post('/api/admin/platform/mirrors', { name: 'pypi', kind: 'pypi', store: 'devpi', url: `${devpi.url}/` }).expect(201)).body;
    const images = (await a.post('/api/admin/platform/mirrors', { name: 'images', kind: 'images', store: 'Harbor', url: `${harbor.url}/` }).expect(201)).body;
    const trivy = (await a.post('/api/admin/platform/mirrors', { name: 'trivy', kind: 'trivy', store: 'Trivy', url: `${harbor.url}/` }).expect(201)).body;
    await a.put(`/api/admin/platform/mirrors/${trivy.id}/push-target`, { url: harbor.url }).expect(400);
    await a.put(`/api/admin/platform/mirrors/${npm.id}/push-target`, { url: 'http://169.254.169.254/' }).expect(400);
    const t = (await a.put(`/api/admin/platform/mirrors/${npm.id}/push-target`, { url: verdaccio.url, secret: token }).expect(200)).body;
    expect(t).toMatchObject({ kind: 'npm', hasSecret: true, state: 'active' });
    expect(JSON.stringify(t)).not.toContain(token);
    await a.put(`/api/admin/platform/mirrors/${pypi.id}/push-target`, { url: devpi.url, repository: 'root/prod', username: 'root', secret: 'devpi-pw' }).expect(200);
    await a.put(`/api/admin/platform/mirrors/${images.id}/push-target`, { url: harbor.url, repository: 'platform', username: 'robot$push', secret: 'harbor-pw' }).expect(200);
    const stored = await h.s.db('platform_push_targets').where({ mirror_id: npm.id }).first();
    expect(stored.secret_sealed).toMatch(/^v2\./);

    const tgz = npmTgz('left-pad', '1.3.0');
    const wheel = Buffer.from('PK wheel bytes');
    const image = ociLayout();
    const files = [
      { path: 'npm/left-pad-1.3.0.tgz', mirror: 'npm', data: tgz },
      { path: 'wheels/requests-2.32.3-py3-none-any.whl', mirror: 'pypi', data: wheel },
      { path: 'images/demo-1.0.tar', mirror: 'images', data: image }
    ];
    const b = (await a.post('/api/admin/platform/bundles', { name: '2026-40-weekly', transfer: 'diode' }).expect(201)).body;
    await h.s.ops.bundles.receive({ tenantId: h.tenantId, actor: { service: 'test' }, userId: null }, b.id, bundleOf('2026-40-weekly', files, signer.privateKey));
    await h.s.jobs.runDue();
    expect((await a.get(`/api/admin/platform/bundles/${b.id}`).expect(200)).body.state).toBe('ready to promote');
    await a.post(`/api/admin/platform/bundles/${b.id}/promote`).expect(202);
    await h.s.jobs.runDue(); // promotes, then queues the push
    await h.s.jobs.runDue(); // pushes

    const pkg = verdaccio.packages.get('left-pad');
    expect(pkg).toBeTruthy();
    expect(Object.keys(pkg!.versions)).toEqual(['1.3.0']);
    expect(pkg!['dist-tags'].latest).toBe('1.3.0');
    expect(pkg!.tarballs['left-pad-1.3.0.tgz']).toEqual(tgz);
    expect(devpi.uploads).toEqual([expect.objectContaining({ index: 'root/prod', name: 'requests', version: '2.32.3', filetype: 'bdist_wheel', sha256: sha(wheel) })]);
    expect(harbor.tokens).toBeGreaterThanOrEqual(1);
    expect(harbor.manifests.has('platform/demo@1.0')).toBe(true);
    const pushes = (await a.get(`/api/admin/platform/bundles/${b.id}/pushes`).expect(200)).body;
    expect(pushes.map((p: { state: string; artefact: string }) => [p.state, p.artefact]).sort()).toEqual([['pushed', 'left-pad@1.3.0'], ['pushed', 'platform/demo:1.0'], ['pushed', 'requests==2.32.3 (requests-2.32.3-py3-none-any.whl)']]);
    expect((await h.s.audit.list(h.tenantId, { action: 'platform.bundle.pushed' })).length).toBe(1);

    // Pushing again finds everything in place.
    await a.post(`/api/admin/platform/bundles/${b.id}/push`).expect(202);
    await h.s.jobs.runDue();
    const again = (await a.get(`/api/admin/platform/bundles/${b.id}/pushes`).expect(200)).body.slice(3);
    expect(again.map((p: { state: string }) => p.state).sort()).toEqual(['exists', 'exists', 'exists']);
    expect(verdaccio.publishes).toBe(1);
  });

  it('reads npm and Python names and versions from the files', async () => {
    expect(await npmManifest(npmTgz('@acme/util', '2.0.1'))).toMatchObject({ name: '@acme/util', version: '2.0.1' });
    expect(pythonDist('wheels/numpy-2.1.0-cp312-cp312-manylinux_2_17_x86_64.whl')).toEqual({ name: 'numpy', version: '2.1.0', filetype: 'bdist_wheel', pyversion: 'cp312' });
    expect(pythonDist('sdist/requests-2.32.3.tar.gz')).toMatchObject({ name: 'requests', version: '2.32.3', filetype: 'sdist' });
    expect(() => pythonDist('x.bin')).toThrow();
  });
});
