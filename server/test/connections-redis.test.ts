/*
 * 1.9.0: Redis as a read-only data connection. The classifier (the read set, writes and dangerous commands refused,
 * quoting, the JSON form, the keys each command reads, SCAN patterns under the allow-list), and the driver against an
 * in-process fake speaking RESP2, which records every command it receives, so the tests can show that only
 * classified commands (and the connection test's PING, INFO and ACL) reach the server.
 */
import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowedPattern } from '../src/connections/patterns.js';
import { classifyRedis, keyPattern, RedisDriver, splitCommandLine } from '../src/connections/redis.js';
import { loginAdmin, localUser, type Harness } from './helpers.js';
import { harnessWith } from './retrieval-seed.js';

describe('Redis classification', () => {
  it('reads commands from the read set, as a command line or JSON', () => {
    expect(classifyRedis('HGETALL user:42', null)).toMatchObject({ kind: 'read', verb: 'HGETALL', objects: ['user:42'], op: { command: 'HGETALL', args: ['user:42'] } });
    expect(classifyRedis('mget a b "c d"', null)).toMatchObject({ kind: 'read', objects: ['a', 'b', 'c d'] });
    expect(classifyRedis('{"command": "hmget", "args": ["user:1", "email", 2]}', null)).toMatchObject({ kind: 'read', objects: ['user:1'], op: { command: 'HMGET', args: ['user:1', 'email', '2'] } });
    expect(classifyRedis('XINFO STREAM events:orders', null)).toMatchObject({ kind: 'read', verb: 'XINFO STREAM', objects: ['events:orders'] });
    expect(classifyRedis('ZRANGE board 0 10 WITHSCORES', null)).toMatchObject({ kind: 'read', objects: ['board'] });
    expect(classifyRedis('JSON.GET doc:1 $.name', null)).toMatchObject({ kind: 'read', objects: ['doc:1'] });
    expect(classifyRedis('TS.RANGE temp:1 - +', null)).toMatchObject({ kind: 'read', objects: ['temp:1'] });
    // The key picked in the schema tree stands in for a missing one.
    expect(classifyRedis('HGETALL', 'user:7')).toMatchObject({ kind: 'read', objects: ['user:7'] });
  });

  it('splits command lines as redis-cli does', () => {
    expect(splitCommandLine('GET "a b\\x41\\n" \'it\\\'s\' plain')).toEqual(['GET', 'a bA\n', "it's", 'plain']);
    expect(splitCommandLine('GET ""')).toEqual(['GET', '']);
    expect(classifyRedis('GET "open', null)).toMatchObject({ kind: 'unparsed' });
    expect(classifyRedis('{"command": "GET", "args": [null]}', null)).toMatchObject({ kind: 'unparsed' });
    expect(classifyRedis('{"command": "GET", "args": ["a"], "db": 3}', null)).toMatchObject({ kind: 'unparsed' });
  });

  it('refuses writes, dangerous commands, unknown commands and bad arity', () => {
    for (const q of ['SET a 1', 'DEL user:1', 'EXPIRE a 10', 'GETDEL a', 'GETEX a EX 5', 'GETSET a b', 'LPOP l', 'BLPOP l 0', 'ZRANGESTORE d s 0 1', 'SUNIONSTORE d a b', 'XADD s * f v', 'JSON.SET d $ 1', 'TS.ADD t * 1', 'HSET h f v', 'SORT l', 'PFCOUNT h']) expect(classifyRedis(q, null).kind, q).toBe('write');
    for (const q of ['KEYS *', 'EVAL "return 1" 0', 'FCALL f 0', 'CONFIG GET *', 'DEBUG SLEEP 1', 'CLIENT LIST', 'MONITOR', 'SUBSCRIBE c', 'SELECT 1', 'MIGRATE h 1 k 0 1', 'DUMP k', 'FLUSHALL', 'ACL LIST', 'CLUSTER INFO', 'REPLICAOF h 1', 'OBJECT ENCODING k', 'MEMORY USAGE k', 'WAIT 1 0', 'MULTI', 'INFO', 'PING', 'XINFO GROUPS s', 'DBSIZE', 'RANDOMKEY']) expect(classifyRedis(q, null).kind, q).toBe('denied');
    expect(classifyRedis('KEYS *', null).reason).toMatch(/use SCAN/);
    expect(classifyRedis('GET', null)).toMatchObject({ kind: 'unparsed', reason: /takes 1 argument/ });
    expect(classifyRedis('GET a b', null)).toMatchObject({ kind: 'unparsed' });
    expect(classifyRedis('', null)).toMatchObject({ kind: 'unparsed' });
  });

  it('reads SCAN as its MATCH pattern, which must sit under an allowed prefix', () => {
    expect(classifyRedis('SCAN 0', null)).toMatchObject({ kind: 'denied', reason: /needs MATCH/ });
    expect(classifyRedis('SCAN 0 MATCH user:* COUNT 50000', null)).toMatchObject({ kind: 'read', objects: ['user:*'], op: { args: ['0', 'MATCH', 'user:*', 'COUNT', '1000'] } });
    expect(classifyRedis('SCAN', 'session:*')).toMatchObject({ kind: 'read', objects: ['session:*'] });
    expect(classifyRedis('SCAN 0 BOGUS x', null)).toMatchObject({ kind: 'unparsed' });
    const allow = ['user:*', 'config:main'];
    expect(allowedPattern('user:*', allow)).toBe(true);
    expect(allowedPattern('user:42:*', allow)).toBe(true);
    expect(allowedPattern('user:4[0-9]', allow)).toBe(true);
    expect(allowedPattern('*', allow)).toBe(false);
    expect(allowedPattern('us*', allow)).toBe(false);
    expect(allowedPattern('session:*', allow)).toBe(false);
    expect(allowedPattern('config:main', allow)).toBe(true);
    expect(allowedPattern('config:*', allow)).toBe(false);
    expect(allowedPattern('user:9', allow)).toBe(true);
  });

  it('groups keys into patterns by their last id-like segment', () => {
    expect(keyPattern('user:42')).toBe('user:*');
    expect(keyPattern('user:42:cart')).toBe('user:*:cart');
    expect(keyPattern('session:01J9ZQ3K5M8N2P4R6T8V0W2Y4A')).toBe('session:*');
    expect(keyPattern('config:main')).toBe('config:main');
  });
});

type Val = { t: 'string'; v: string } | { t: 'hash'; v: [string, string][] } | { t: 'list'; v: string[] } | { t: 'zset'; v: [string, number][] } | { t: 'stream'; v: [string, string[]][] };

/** Enough of a Redis server for the driver: RESP2 in and out, an in-memory keyspace, and a log of commands. */
class FakeRedis {
  server!: Server;
  port = 0;
  seen: string[][] = [];
  canWrite = false;
  sockets = new Set<Socket>();
  data = new Map<string, Val>();

  async start(): Promise<this> {
    this.server = createServer((sock) => this.serve(sock));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }
  async stop(): Promise<void> {
    for (const x of this.sockets) x.destroy();
    await new Promise((r) => this.server.close(r));
  }

  private serve(sock: Socket) {
    this.sockets.add(sock);
    sock.on('close', () => this.sockets.delete(sock));
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      for (;;) {
        const parsed = this.parse(buf);
        if (!parsed) break;
        buf = buf.subarray(parsed.used);
        this.seen.push(parsed.args);
        sock.write(this.reply(parsed.args));
        if (parsed.args[0]?.toUpperCase() === 'QUIT') sock.end();
      }
    });
    sock.on('error', () => undefined);
  }

  private parse(b: Buffer): { args: string[]; used: number } | null {
    const s = b.toString('latin1');
    if (!s.startsWith('*')) return null;
    let i = s.indexOf('\r\n');
    if (i < 0) return null;
    const n = Number(s.slice(1, i));
    i += 2;
    const args: string[] = [];
    for (let k = 0; k < n; k++) {
      const e = s.indexOf('\r\n', i);
      if (e < 0) return null;
      const len = Number(s.slice(i + 1, e));
      if (s.length < e + 2 + len + 2) return null;
      args.push(Buffer.from(s.slice(e + 2, e + 2 + len), 'latin1').toString('utf8'));
      i = e + 2 + len + 2;
    }
    return { args, used: Buffer.byteLength(s.slice(0, i), 'latin1') };
  }

  private enc(v: unknown): string {
    if (v === null || v === undefined) return '$-1\r\n';
    if (typeof v === 'number') return `:${v}\r\n`;
    if (Array.isArray(v)) return `*${v.length}\r\n` + v.map((x) => this.enc(x)).join('');
    if (v instanceof Error) return `-${v.message}\r\n`;
    const str = String(v);
    return `$${Buffer.byteLength(str)}\r\n${str}\r\n`;
  }

  private reply(a: string[]): string {
    const cmd = a[0]!.toUpperCase();
    const val = (k: string) => this.data.get(k);
    const glob = (p: string) => new RegExp('^' + p.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    switch (cmd) {
      case 'AUTH':
        return a[2] === 'pw' || a[1] === 'pw' ? '+OK\r\n' : '-WRONGPASS invalid username-password pair\r\n';
      case 'PING':
        return '+PONG\r\n';
      case 'SELECT':
        return '+OK\r\n';
      case 'QUIT':
        return '+OK\r\n';
      case 'INFO':
        return this.enc('# Server\r\nredis_version:7.4.1\r\n');
      case 'ACL':
        if (a[1]?.toUpperCase() === 'WHOAMI') return this.enc('reader');
        return this.enc(this.canWrite ? 'OK' : "User reader has no permissions to run the 'set' command");
      case 'GET': {
        const x = val(a[1]!);
        return this.enc(x?.t === 'string' ? x.v : null);
      }
      case 'TYPE':
        return `+${val(a[1]!)?.t ?? 'none'}\r\n`;
      case 'HGETALL': {
        const x = val(a[1]!);
        return this.enc(x?.t === 'hash' ? x.v.flat() : []);
      }
      case 'LRANGE': {
        const x = val(a[1]!);
        const list = x?.t === 'list' ? x.v : [];
        const start = Number(a[2]);
        const stop = Number(a[3]) < 0 ? list.length + Number(a[3]) : Number(a[3]);
        return this.enc(list.slice(start, stop + 1));
      }
      case 'ZRANGE': {
        const x = val(a[1]!);
        const z = x?.t === 'zset' ? x.v : [];
        const stop = Number(a[3]) < 0 ? z.length + Number(a[3]) : Number(a[3]);
        const part = z.slice(Number(a[2]), stop + 1);
        return this.enc(a.some((y) => y.toUpperCase() === 'WITHSCORES') ? part.flatMap(([m, sc]) => [m, String(sc)]) : part.map(([m]) => m));
      }
      case 'XRANGE': {
        const x = val(a[1]!);
        const count = a.findIndex((y) => y.toUpperCase() === 'COUNT');
        const entries = x?.t === 'stream' ? x.v : [];
        return this.enc(count >= 0 ? entries.slice(0, Number(a[count + 1])) : entries);
      }
      case 'SCAN': {
        const m = a.findIndex((y) => y.toUpperCase() === 'MATCH');
        const re = m >= 0 ? glob(a[m + 1]!) : /.*/;
        // Two pages: keys before and after the halfway point, as a cursor would split them.
        const keys = [...this.data.keys()].sort();
        const half = Math.ceil(keys.length / 2);
        const page = a[1] === '0' ? keys.slice(0, half) : keys.slice(half);
        return this.enc([a[1] === '0' && half < keys.length ? '7' : '0', page.filter((k) => re.test(k))]);
      }
      default:
        return `-ERR unknown command '${a[0]}'\r\n`;
    }
  }
}

describe('Redis driver', () => {
  let fake: FakeRedis;
  beforeEach(async () => {
    fake = await new FakeRedis().start();
    fake.data.set('user:1', { t: 'hash', v: [['name', 'Ana'], ['contact', 'ana@example.org']] });
    fake.data.set('user:2', { t: 'hash', v: [['name', 'Bo']] });
    fake.data.set('session:01J9ZQ3K5M8N2P4R6T8V0W2Y4A', { t: 'string', v: 'secret-token' });
    fake.data.set('queue:jobs', { t: 'list', v: Array.from({ length: 30 }, (_, i) => `job-${i}`) });
    fake.data.set('board', { t: 'zset', v: [['ana', 30], ['bo', 20], ['cy', 10]] });
    fake.data.set('events:orders', { t: 'stream', v: Array.from({ length: 8 }, (_, i) => [`1700000000000-${i}`, ['order', String(i), 'status', 'paid']]) });
  });
  afterEach(async () => fake.stop());

  const driver = (over: Record<string, unknown> = {}) => new RedisDriver({ engine: 'redis', endpoint: `127.0.0.1:${fake.port}`, database: '2', tls: false, username: 'reader', password: 'pw', options: { scanLimit: 10_000 }, ...over });
  const run = (q: string, limit = 50) => {
    const c = classifyRedis(q, null);
    return driver().query(c, q, { limit, timeoutMs: 3000 });
  };
  const commands = () => fake.seen.map((x) => x[0]!.toUpperCase());

  it('tests, introspects and reads only what was classified', async () => {
    const t = await driver().test(3000);
    expect(t).toMatchObject({ version: 'Redis 7.4.1', readOnly: true, health: 'healthy' });
    fake.canWrite = true;
    expect((await driver().test(3000)).readOnly).toBe(false);

    const schema = await driver().introspect(3000);
    expect(schema.map((o) => o.name)).toEqual(['board', 'events:orders', 'queue:jobs', 'session:*', 'user:*']);
    expect(schema.find((o) => o.name === 'user:*')).toMatchObject({ kind: 'keyspace', columns: [{ name: 'type', type: 'hash' }, { name: 'keys', type: '2' }] });

    fake.seen = [];
    expect(await run('HGETALL user:1')).toMatchObject({ columns: ['field', 'value'], rows: [['name', 'Ana'], ['contact', 'ana@example.org']], capped: false });
    expect(await run('LRANGE queue:jobs 0 -1', 5)).toMatchObject({ columns: ['index', 'value'], rows: [[0, 'job-0'], [1, 'job-1'], [2, 'job-2'], [3, 'job-3'], [4, 'job-4']], capped: true });
    expect(fake.seen.find((x) => x[0] === 'LRANGE')).toEqual(['LRANGE', 'queue:jobs', '0', '5']);
    expect(await run('ZRANGE board 0 -1 WITHSCORES')).toMatchObject({ columns: ['member', 'score'], rows: [['ana', 30], ['bo', 20], ['cy', 10]] });
    const x = await run('XRANGE events:orders - +', 3);
    expect(x).toMatchObject({ columns: ['id', 'order', 'status'], capped: true });
    expect(x.rows).toHaveLength(3);
    const scan = await run('SCAN 0 MATCH user:*');
    expect(scan).toMatchObject({ columns: ['key', 'type'], rows: [['user:1', 'hash'], ['user:2', 'hash']] });
    expect(await run('GET session:01J9ZQ3K5M8N2P4R6T8V0W2Y4A')).toMatchObject({ rows: [['session:01J9ZQ3K5M8N2P4R6T8V0W2Y4A', 'secret-token']] });
    // Connection setup is AUTH and SELECT; everything else is a classified read (and TYPE for the keys SCAN found).
    expect(new Set(commands())).toEqual(new Set(['AUTH', 'SELECT', 'HGETALL', 'LRANGE', 'ZRANGE', 'XRANGE', 'SCAN', 'TYPE', 'GET', 'QUIT']));
    expect(fake.seen.find((x) => x[0]!.toUpperCase() === 'SELECT')?.[1]).toBe('2');

    await expect(driver().query(classifyRedis('DEL user:1', null), 'DEL user:1', { limit: 5, timeoutMs: 3000 })).rejects.toThrow(/classified read/);
    await expect(driver({ database: '16' }).test(3000)).rejects.toThrow(/0 to 15/);
    await expect(driver({ endpoint: '8.8.8.8:6379' }).test(3000)).rejects.toThrow(/public address/);
  });
});

describe('Redis connections through the API', () => {
  let h: Harness;
  let fake: FakeRedis;
  beforeEach(async () => {
    fake = await new FakeRedis().start();
    fake.data.set('user:1', { t: 'hash', v: [['name', 'Ana'], ['contact', 'ana@example.org']] });
    fake.data.set('session:01J9ZQ3K5M8N2P4R6T8V0W2Y4A', { t: 'string', v: 'secret-token' });
    h = await harnessWith({}, { OLLAMA_POLL_MS: '600000' });
  });
  afterEach(async () => {
    await h.close();
    await fake.stop();
  });

  it('registers, introspects, allow-lists key patterns, masks reads and refuses writes and KEYS before they are sent', async () => {
    await localUser(h, 'connadmin', ['connection-admin', 'member'], 'confidential');
    const c = await loginAdmin(h, 'connadmin');
    const post = (p: string, b: object = {}) => c.agent.post(p).set('x-csrf-token', c.csrf).send(b);
    const conn = (await post('/api/admin/connections', { name: 'cache', engine: 'redis', endpoint: `127.0.0.1:${fake.port}`, zone: 'data', label: 'internal', username: 'reader', password: 'pw' }).expect(201)).body;
    expect(conn).toMatchObject({ engine: 'redis', engineTitle: 'Redis', family: 'keyvalue', options: { scanLimit: 10_000 } });
    expect((await post(`/api/admin/connections/${conn.id}/test`).expect(200)).body).toMatchObject({ ok: true, readOnly: true });
    expect((await post(`/api/admin/connections/${conn.id}/schema`).expect(200)).body).toMatchObject({ objects: 2 });
    await c.agent.put(`/api/admin/connections/${conn.id}/allow-list`).set('x-csrf-token', c.csrf).send({ objects: ['user:*'] }).expect(200);

    fake.seen = [];
    const r = (await post(`/api/admin/connections/${conn.id}/query`, { query: 'HGETALL user:1' }).expect(200)).body;
    expect(r.rows).toEqual([['name', 'Ana'], ['contact', '••••.org']]);
    expect(r.masked).toEqual(['value']);
    expect((await post(`/api/admin/connections/${conn.id}/query`, { query: 'GET session:01J9ZQ3K5M8N2P4R6T8V0W2Y4A' }).expect(422)).body.title).toBe('Object outside the allow-list');
    expect((await post(`/api/admin/connections/${conn.id}/query`, { query: 'SCAN 0 MATCH *' }).expect(422)).body.title).toBe('Object outside the allow-list');
    expect((await post(`/api/admin/connections/${conn.id}/query`, { query: 'DEL user:1' }).expect(422)).body.title).toBe('Write refused');
    expect((await post(`/api/admin/connections/${conn.id}/query`, { query: 'KEYS *' }).expect(422)).body.detail).toMatch(/use SCAN/);
    expect(fake.seen.map((x) => x[0]!.toUpperCase()).filter((x) => !['AUTH', 'QUIT'].includes(x))).toEqual(['HGETALL']);
  });
});
