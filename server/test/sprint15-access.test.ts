import { createSocket, type Socket } from 'node:dgram';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { Limiter, MemoryCounterStore, RedisCounterStore } from '../src/platform/ratelimit.js';
import { readTimestamp, sntpQuery, writeTimestamp } from '../src/platform/ntp.js';
import { DenialAudit } from '../src/audit/denials.js';
import type { AuditInput, AuditLog } from '../src/audit/chain.js';
import { signMediaToken, verifyMediaToken } from '../src/media/origin.js';
import { allowedMysql, classifyMysql } from '../src/connections/classify.js';
import { DynamicCredentials } from '../src/connections/dynamic.js';
import type { ConnectionSpec, DataDriver } from '../src/connections/drivers.js';
import { harness, localUser, login, loginAdmin, type Harness } from './helpers.js';
import { harnessWith } from './retrieval-seed.js';
import { FakeMediaRunner, FakeSafety, fakeMp4, harness8 } from './sprint8-fakes.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('B-111 and B-406: failed credentials and shared rate limits', () => {
  it('answers 429 to the 21st bad bearer token a minute from one address, and then refuses even a valid key', async () => {
    h = await harness();
    await localUser(h, 'keyowner', ['member']);
    const m = await login(h, 'keyowner');
    const secret = String((await m.agent.post('/api/me/api-keys').set('x-csrf-token', m.csrf).send({ name: 'ci', scopes: ['chat:read'], ttlDays: 30 }).expect(201)).body.key);
    await request(h.app).get('/api/me').set('authorization', `Bearer ${secret}`).expect(200);
    for (let i = 0; i < 20; i++) {
      const r = await request(h.app).get('/api/me').set('authorization', `Bearer exai_${i}notakey`);
      expect(r.status).toBe(401);
    }
    const r = await request(h.app).get('/api/me').set('authorization', 'Bearer exai_onemore').expect(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    // Blocked before the credential is looked at: guessing right does not help while the address is held.
    await request(h.app).get('/api/me').set('authorization', `Bearer ${secret}`).expect(429);
    // OAuth-looking tokens count too; malformed headers count too.
    await request(h.app).get('/api/me').set('authorization', 'Bearer eyJhbGciOi.x.y').expect(429);
  });

  it('shares one counter between limiters on the same store (two instances, one limit)', async () => {
    const store = new MemoryCounterStore();
    const a = new Limiter(store, 'api', 3, 60_000);
    const b = new Limiter(store, 'api', 3, 60_000);
    expect((await a.consume('u1')).allowed).toBe(true);
    expect((await b.consume('u1')).allowed).toBe(true);
    expect((await a.consume('u1')).allowed).toBe(true);
    const over = await b.consume('u1');
    expect(over).toMatchObject({ allowed: false, count: 4 });
    expect(over.resetMs).toBeGreaterThan(0);
    expect((await a.blocked('u1')).blocked).toBe(true);
    expect((await a.consume('u2')).allowed).toBe(true);
  });

  it('falls back to counting in memory when Redis is down, so the limit still holds (fails closed, not open)', async () => {
    const warnings: string[] = [];
    const store = new RedisCounterStore('redis://127.0.0.1:1', { warn: (_o: unknown, msg?: string) => void warnings.push(String(msg)) } as never);
    try {
      const l = new Limiter(store, 'auth', 2, 60_000);
      expect((await l.consume('ip')).allowed).toBe(true);
      expect((await l.consume('ip')).allowed).toBe(true);
      expect((await l.consume('ip')).allowed).toBe(false);
      expect(warnings.length).toBe(1);
    } finally {
      await store.close();
    }
  });

  it('caps full denial entries across instances that share the counter store', async () => {
    const written: AuditInput[] = [];
    const audit = { append: async (i: AuditInput) => void written.push(i) } as unknown as AuditLog;
    const store = new MemoryCounterStore();
    const one = new DenialAudit(audit, 5, 60_000, store);
    const two = new DenialAudit(audit, 5, 60_000, store);
    const input = { tenantId: 't', action: 'authz.denied', kind: 'decision' as const, actor: { user: 'u' }, target: { method: 'GET', path: '/x' } };
    for (let i = 0; i < 6; i++) {
      await one.record('t:u', input);
      await two.record('t:u', input);
    }
    expect(written.filter((w) => w.action === 'authz.denied')).toHaveLength(5);
    await one.flushAll();
    await two.flushAll();
    const summaries = written.filter((w) => w.action === 'authz.denied.suppressed');
    expect(summaries.reduce((a, w) => a + Number((w.detail as { count: number }).count), 0)).toBe(7);
  });
});

/** A UDP NTP server whose clock runs `offsetMs` ahead, answering as stratum 2 (or a kiss-o'-death). */
async function fakeNtp(offsetMs: number, kiss = false): Promise<{ port: number; socket: Socket }> {
  const socket = createSocket('udp4');
  socket.on('message', (msg, rinfo) => {
    const now = Date.now() + offsetMs;
    const res = Buffer.alloc(48);
    res[0] = (0 << 6) | (4 << 3) | 4;
    res[1] = kiss ? 0 : 2;
    if (kiss) res.write('RATE', 12, 'ascii');
    else Buffer.from([10, 0, 0, 1]).copy(res, 12);
    msg.copy(res, 24, 40, 48); // originate = the client's transmit
    writeTimestamp(res, 32, now);
    writeTimestamp(res, 40, now + 1);
    socket.send(res, rinfo.port, rinfo.address);
  });
  await new Promise<void>((r) => socket.bind(0, '127.0.0.1', r));
  return { port: (socket.address() as AddressInfo).port, socket };
}

describe('B-414: clock skew against NTP', () => {
  it('measures the offset by SNTP and refuses a kiss-o-death', async () => {
    const ntp = await fakeNtp(1500);
    const kod = await fakeNtp(0, true);
    try {
      const r = await sntpQuery(`127.0.0.1:${ntp.port}`, 1000);
      expect(r.offsetMs).toBeGreaterThan(1400);
      expect(r.offsetMs).toBeLessThan(1600);
      expect(r).toMatchObject({ stratum: 2, refId: '10.0.0.1' });
      await expect(sntpQuery(`127.0.0.1:${kod.port}`, 1000)).rejects.toThrow(/refused the query \(kiss code RATE\)/);
      const buf = Buffer.alloc(8);
      writeTimestamp(buf, 0, 1_790_000_000_123);
      expect(Math.round(readTimestamp(buf, 0))).toBe(1_790_000_000_123);
    } finally {
      ntp.socket.close();
      kod.socket.close();
    }
  });

  it('shows NTP skew on the platform status', async () => {
    const ntp = await fakeNtp(-2500);
    try {
      h = await harness({ NTP_SERVER: `127.0.0.1:${ntp.port}`, NTP_TIMEOUT_MS: '1000' });
      await localUser(h, 'root', ['system-admin'], 'restricted');
      const a = await loginAdmin(h, 'root');
      const sum = (await a.agent.get('/api/admin/platform/summary').expect(200)).body;
      expect(sum.clock.ntp).toMatchObject({ server: `127.0.0.1:${ntp.port}`, stratum: 2, error: null });
      expect(sum.clock.ntp.offsetMs).toBeLessThan(-2400);
      expect(sum.clock.ntp.skewMs).toBeGreaterThan(2400);
      expect(sum.clock.skewMs).not.toBeUndefined();
    } finally {
      ntp.socket.close();
    }
  });
});

describe('B-413: sandboxed media', () => {
  const bytes = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
    const b: Buffer[] = [];
    res.on('data', (c: Buffer) => b.push(c));
    res.on('end', () => cb(null, Buffer.concat(b)));
  };

  it('serves media and previews with a sandbox CSP and nosniff, and from a separate origin through signed URLs', async () => {
    h = await harness8({ MEDIA_ENCODER: 'auto', MEDIA_ORIGIN: 'http://media.localhost:8081' }, { mediaRunner: new FakeMediaRunner(), imageSafety: new FakeSafety() });
    await localUser(h, 'mem', ['member']);
    const m = await login(h, 'mem');
    const a = (await m.agent.put('/api/media/assets?name=clip.mp4&label=internal').set('x-csrf-token', m.csrf).set('content-type', 'application/octet-stream').send(fakeMp4({ durationMs: 60_000 })).expect(202)).body;
    await h.s.jobs.runDue();
    const redirect = await m.agent.get(`/api/media/assets/${a.id}/content`).redirects(0).expect(302);
    const url = new URL(redirect.headers.location as string);
    expect(url.origin).toBe('http://media.localhost:8081');
    expect(url.pathname).toMatch(/^\/media-content\//);
    // The media origin answers without the console's cookie, on its own host only.
    const media = await request(h.app).get(url.pathname).set('host', 'media.localhost:8081').buffer(true).parse(bytes).expect(200);
    expect(media.headers['content-security-policy']).toMatch(/^sandbox/);
    expect(media.headers['x-content-type-options']).toBe('nosniff');
    expect((media.body as Buffer).toString('latin1')).toContain('FAKEMEDIA');
    const pv = await m.agent.get(`/api/media/assets/${a.id}/previews/0`).redirects(0).expect(302);
    const pvRes = await request(h.app).get(new URL(pv.headers.location as string).pathname).set('host', 'media.localhost:8081').expect(200);
    expect(pvRes.headers['content-security-policy']).toMatch(/^sandbox/);
    // Nothing else answers on the media host.
    await request(h.app).get('/api/me').set('host', 'media.localhost:8081').expect(404);
    // A tampered or expired token is refused.
    const token = url.pathname.split('/').pop()!;
    await request(h.app).get(`/media-content/${token.slice(0, -2)}xx`).set('host', 'media.localhost:8081').expect(404);
    const expired = signMediaToken(h.s.cfg.SESSION_SECRET, { r: { kind: 'asset', id: a.id }, t: h.tenantId, u: a.userId ?? 'x', w: null, exp: Date.now() - 1 });
    expect(verifyMediaToken(h.s.cfg.SESSION_SECRET, expired)).toBeNull();
    // The console's CSP allows the media origin for images and media only.
    const page = await request(h.app).get('/healthz');
    expect(page.headers['content-security-policy']).toMatch(/media-src 'self' http:\/\/media\.localhost:8081/);
  });

  it('sandboxes media on the application origin when no media origin is set', async () => {
    h = await harness8({ MEDIA_ENCODER: 'auto' }, { mediaRunner: new FakeMediaRunner(), imageSafety: new FakeSafety() });
    await localUser(h, 'mem', ['member']);
    const m = await login(h, 'mem');
    const a = (await m.agent.put('/api/media/assets?name=clip.mp4&label=internal').set('x-csrf-token', m.csrf).set('content-type', 'application/octet-stream').send(fakeMp4({ durationMs: 60_000 })).expect(202)).body;
    await h.s.jobs.runDue();
    const pv = await m.agent.get(`/api/media/assets/${a.id}/previews/0`).expect(200);
    expect(pv.headers['content-security-policy']).toMatch(/^sandbox/);
    expect(pv.headers['x-content-type-options']).toBe('nosniff');
    const c = await m.agent.get(`/api/media/assets/${a.id}/content`).buffer(true).parse(bytes).expect(200);
    expect(c.headers['content-security-policy']).toMatch(/^sandbox/);
  });
});

/** A driver that records its spec (to see which account was used) and answers a fixed row. */
class RecordingDriver implements DataDriver {
  static specs: ConnectionSpec[] = [];
  constructor(readonly spec: ConnectionSpec) {
    RecordingDriver.specs.push(spec);
  }
  async test() {
    return { version: 'MySQL 8.4.2', readOnly: true, health: 'healthy' as const, detail: `Account ${this.spec.username} is read-only; no write grants.` };
  }
  async introspect() {
    return [{ name: 'shop.orders', kind: 'table' as const, columns: [{ name: 'id', type: 'int' }, { name: 'total', type: 'decimal' }] }];
  }
  async query() {
    return { columns: ['id', 'total'], rows: [[1, '9.99']], capped: false, estimate: null };
  }
  async rows() {
    return { columns: [], rows: [], capped: false, estimate: null };
  }
}

/** An OpenBao stand-in: the database engine's creds endpoint and the lease renew and revoke endpoints. */
async function fakeBao(): Promise<{ url: string; server: Server; issued: string[]; renewed: string[]; revoked: string[]; ttl: number }> {
  const state = { url: '', server: null as unknown as Server, issued: [] as string[], renewed: [] as string[], revoked: [] as string[], ttl: 3600 };
  let n = 0;
  state.server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.headers['x-vault-token'] !== 'bao-token') {
        res.statusCode = 403;
        return res.end(JSON.stringify({ errors: ['permission denied'] }));
      }
      if (req.method === 'GET' && req.url === '/v1/database/creds/shop-readonly') {
        const lease = `database/creds/shop-readonly/lease${++n}`;
        state.issued.push(lease);
        return res.end(JSON.stringify({ lease_id: lease, lease_duration: state.ttl, renewable: true, data: { username: `v-shop-${n}`, password: `pw-${n}` } }));
      }
      const body = raw ? (JSON.parse(raw) as { lease_id: string }) : { lease_id: '' };
      if (req.method === 'PUT' && req.url === '/v1/sys/leases/renew') {
        state.renewed.push(body.lease_id);
        return res.end(JSON.stringify({ lease_id: body.lease_id, lease_duration: state.ttl, renewable: true }));
      }
      if (req.method === 'PUT' && req.url === '/v1/sys/leases/revoke') {
        state.revoked.push(body.lease_id);
        res.statusCode = 204;
        return res.end();
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ errors: ['no handler'] }));
    });
  });
  await new Promise<void>((r) => state.server.listen(0, '127.0.0.1', r));
  state.url = `http://127.0.0.1:${(state.server.address() as AddressInfo).port}`;
  return state;
}

describe('B-416: MySQL connections and OpenBao dynamic credentials', () => {
  it('reads MySQL SQL the way MySQL lexes it', () => {
    expect(classifyMysql('SELECT `id`, total FROM `shop`.`orders` WHERE note = "x" LIMIT 5')).toMatchObject({ kind: 'read', objects: ['shop.orders'] });
    expect(classifyMysql("SELECT 'it\\'s' AS a, b FROM t2")).toMatchObject({ kind: 'read', objects: ['t2'] });
    // A backslash-escaped quote cannot hide a table from the parser.
    expect(classifyMysql("SELECT 'a\\' , (SELECT secret FROM vault) , ' FROM t")).toMatchObject({ kind: 'read', objects: ['t'] });
    expect(classifyMysql('SELECT 1 /*!, (SELECT secret FROM vault) */ FROM t')).toMatchObject({ kind: 'denied' });
    expect(classifyMysql('SELECT 1 --1, secret FROM vault')).toMatchObject({ kind: 'unparsed' });
    expect(classifyMysql('SELECT 1 FROM t # trailing comment')).toMatchObject({ kind: 'read', objects: ['t'] });
    expect(classifyMysql("SELECT LOAD_FILE('/etc/passwd') FROM t")).toMatchObject({ kind: 'denied', denied: 'load_file()' });
    expect(classifyMysql('SELECT SLEEP(10) FROM t')).toMatchObject({ kind: 'denied' });
    expect(classifyMysql("SELECT * FROM t INTO OUTFILE '/tmp/x'")).toMatchObject({ kind: 'write' });
    expect(classifyMysql('REPLACE INTO t VALUES (1)')).toMatchObject({ kind: 'write' });
    expect(classifyMysql('SELECT * FROM t LOCK IN SHARE MODE')).toMatchObject({ kind: 'write' });
    expect(classifyMysql('SHOW TABLES')).toMatchObject({ kind: 'unparsed' });
    expect(classifyMysql('UPDATE t SET a = 1')).toMatchObject({ kind: 'write' });
    expect(allowedMysql('orders', ['shop.orders'], 'shop')).toBe(true);
    expect(allowedMysql('shop.orders', ['orders'], 'shop')).toBe(true);
    expect(allowedMysql('other.orders', ['shop.orders'], 'shop')).toBe(false);
  });

  it('renews a lease while it runs, takes a new account when renewal is cut short, and revokes what it drops', async () => {
    const bao = await fakeBao();
    try {
      const d = new DynamicCredentials(bao.url, () => 'bao-token');
      const a = await d.get('shop-readonly', 'conn1');
      expect(a).toMatchObject({ username: 'v-shop-1', password: 'pw-1', renewable: true });
      expect(await d.get('shop-readonly', 'conn1')).toBe(a);
      // A third of the lease left: renewed, same account.
      const cached = (d as unknown as { cache: Map<string, { expiresAt: number }> }).cache.get('conn1')!;
      cached.expiresAt = Date.now() + 1000 * 1000;
      const b = await d.get('shop-readonly', 'conn1');
      expect(b.username).toBe('v-shop-1');
      expect(bao.renewed).toEqual([a.leaseId]);
      // The role's max TTL cuts the renewal short: a new account, the old lease revoked.
      bao.ttl = 60;
      (d as unknown as { cache: Map<string, { expiresAt: number }> }).cache.get('conn1')!.expiresAt = Date.now() + 1000 * 1000;
      const c = await d.get('shop-readonly', 'conn1');
      expect(c.username).toBe('v-shop-2');
      expect(bao.revoked).toEqual([a.leaseId]);
      await d.close();
      expect(bao.revoked).toEqual([a.leaseId, c.leaseId]);
      await expect(new DynamicCredentials(bao.url, () => 'wrong').get('shop-readonly', 'x')).rejects.toThrow(/403 permission denied/);
    } finally {
      bao.server.close();
    }
  });

  it('registers a MySQL connection that queries read-only with an OpenBao account, and refuses writes', async () => {
    const bao = await fakeBao();
    RecordingDriver.specs = [];
    try {
      h = await harnessWith({ drivers: { mysql: (spec) => new RecordingDriver(spec) } }, { OPENBAO_ADDR: bao.url, OPENBAO_TOKEN: 'bao-token', CONNECTIONS_ALLOWED_HOSTS: 'mysql.data.internal' });
      await localUser(h, 'connadmin', ['connection-admin', 'member'], 'confidential');
      const c = await loginAdmin(h, 'connadmin');
      const post = (p: string, b: object) => c.agent.post(p).set('x-csrf-token', c.csrf).send(b);
      const conn = (await post('/api/admin/connections', { name: 'shop', engine: 'mysql', endpoint: 'mysql.data.internal:3306', database: 'shop', zone: 'data', label: 'internal', baoRole: 'shop-readonly' }).expect(201)).body;
      expect(conn).toMatchObject({ engine: 'mysql', credentialSource: 'openbao', baoRole: 'shop-readonly', hasCredential: true, account: null });
      const test = (await post(`/api/admin/connections/${conn.id}/test`, {}).expect(200)).body;
      expect(test).toMatchObject({ ok: true, readOnly: true });
      expect(RecordingDriver.specs[0]).toMatchObject({ engine: 'mysql', username: 'v-shop-1', password: 'pw-1', database: 'shop' });
      await post(`/api/admin/connections/${conn.id}/schema`, {}).expect(200);
      await c.agent.put(`/api/admin/connections/${conn.id}/allow-list`).set('x-csrf-token', c.csrf).send({ objects: ['shop.orders'], piiColumns: [] }).expect(200);
      const q = await post(`/api/admin/connections/${conn.id}/query`, { query: 'SELECT id, total FROM `orders`' });
      expect(q.status).toBe(200);
      expect(q.body).toMatchObject({ columns: ['id', 'total'], rows: [[1, '9.99']] });
      const w = await post(`/api/admin/connections/${conn.id}/query`, { query: 'UPDATE orders SET total = 0' });
      expect(w.status).toBe(422);
      const view = (await c.agent.get(`/api/admin/connections/${conn.id}`).expect(200)).body;
      expect(view.lease).toMatchObject({ username: 'v-shop-1', renewable: true });
      // Switching to a static account drops (and revokes) the OpenBao lease.
      await c.agent.put(`/api/admin/connections/${conn.id}/credential`).set('x-csrf-token', c.csrf).send({ username: 'reader', password: 'x' }).expect(200);
      expect(bao.revoked).toEqual([bao.issued[0]]);
    } finally {
      bao.server.close();
    }
  });
});

describe('B-415: zones on MCP servers and connections', () => {
  it('refuses registration in an undefined zone or above the zone ceiling once zones are defined', async () => {
    h = await harnessWith({ drivers: { mysql: (spec) => new RecordingDriver(spec) } }, { CONNECTIONS_ALLOWED_HOSTS: 'mysql.data.internal', MCP_ALLOWED_HOSTS: '127.0.0.1' });
    await localUser(h, 'root', ['system-admin'], 'restricted');
    const a = await loginAdmin(h, 'root');
    const post = (p: string, b: object) => a.agent.post(p).set('x-csrf-token', a.csrf).send(b);
    // Before zones exist nothing is refused on zone grounds.
    await post('/api/admin/connections', { name: 'before', engine: 'mysql', endpoint: 'mysql.data.internal', zone: 'nowhere', label: 'internal' }).expect(201);
    await post('/api/admin/zones/seed', {}).expect(201);
    const undef = await post('/api/admin/connections', { name: 'c1', engine: 'mysql', endpoint: 'mysql.data.internal', zone: 'nowhere', label: 'internal' }).expect(422);
    expect(undef.body.step).toBe('zone');
    const ceilings = (await a.agent.get('/api/admin/zones').expect(200)).body.zones as { id: string; spec: { maxLabel: string } }[];
    const sandbox = ceilings.find((z) => z.id === 'sandbox')!;
    expect(sandbox.spec.maxLabel).toBe('confidential');
    const above = await post('/api/admin/connections', { name: 'c2', engine: 'mysql', endpoint: 'mysql.data.internal', zone: 'sandbox', label: 'restricted' }).expect(403);
    expect(above.body).toMatchObject({ step: 'zone', zoneCeiling: 'confidential' });
    await post('/api/admin/connections', { name: 'c3', engine: 'mysql', endpoint: 'mysql.data.internal', zone: 'data', label: 'confidential' }).expect(201);
    const conn = (await a.agent.get('/api/admin/connections').expect(200)).body.find((x: { name: string }) => x.name === 'c3');
    await a.agent.patch(`/api/admin/connections/${conn.id}`).set('x-csrf-token', a.csrf).send({ zone: 'nowhere' }).expect(422);
    expect((await h.s.audit.list(h.tenantId, { action: 'connection.register.refused' })).length).toBe(2);
    const mcp = await post('/api/admin/mcp-servers', { name: 'tools', url: 'http://127.0.0.1:9/mcp', zone: 'nowhere' }).expect(422);
    expect(mcp.body.step).toBe('zone');
    expect((await h.s.audit.list(h.tenantId, { action: 'mcp.register.refused' })).length).toBe(1);
    await post('/api/admin/mcp-servers', { name: 'tools2', url: 'http://127.0.0.1:9/mcp', zone: 'external' }).expect(403);
  });
});
