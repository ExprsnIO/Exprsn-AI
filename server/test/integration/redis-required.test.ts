/*
 * 1.7.0, Sprint 41 (B-9001) against a real Redis. Runs when TEST_REDIS_URL is set (a plain redis:// URL):
 *
 *   - a replica cut off from Redis turns unready and turns ready again when Redis answers: the server reaches Redis
 *     through a TCP proxy in this file, which is closed and reopened;
 *   - with REDIS_URL two server processes start on one database, one of them without job workers, and a third
 *     without REDIS_URL exits with the reason.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { harness } from '../helpers.js';

const REDIS = process.env.TEST_REDIS_URL;
const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(here, '../..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/** A TCP proxy to Redis that can be cut (every connection dropped, new ones refused) and restored on the same port. */
class Proxy {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  port = 0;
  constructor(private readonly host: string, private readonly upstreamPort: number) {}

  async open(): Promise<void> {
    this.server = createServer((client) => {
      const up = connect(this.upstreamPort, this.host);
      for (const s of [client, up]) {
        this.sockets.add(s);
        s.on('error', () => undefined);
        s.on('close', () => this.sockets.delete(s));
      }
      client.pipe(up);
      up.pipe(client);
      client.on('close', () => up.destroy());
      up.on('close', () => client.destroy());
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.on('error', reject);
      this.server!.listen(this.port, '127.0.0.1', () => resolve());
    });
    this.port = (this.server.address() as { port: number }).port;
  }

  async cut(): Promise<void> {
    const srv = this.server;
    this.server = null;
    for (const s of this.sockets) s.destroy();
    if (srv) await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
}

describe.skipIf(!REDIS || !REDIS.startsWith('redis://'))('B-9001 with a real Redis', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'exprsn-b9001-redis-'));
  const children: ChildProcess[] = [];

  afterAll(() => {
    for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  });

  it('a replica cut off from Redis turns unready, and ready again when Redis answers', async () => {
    const u = new URL(REDIS!);
    const proxy = new Proxy(u.hostname, Number(u.port || 6379));
    await proxy.open();
    const through = new URL(REDIS!);
    through.hostname = '127.0.0.1';
    through.port = String(proxy.port);
    const h = await harness({ REDIS_URL: through.toString(), JOB_QUEUE: 'db', CACHE_STORE: 'memory' });
    const readyz = async (want: number, ms: number) => {
      const end = Date.now() + ms;
      let last = { status: 0, body: {} as { checks?: Record<string, string> } };
      while (Date.now() < end) {
        const r = await request(h.app).get('/readyz');
        last = { status: r.status, body: r.body };
        if (r.status === want) return last;
        await sleep(200);
      }
      return last;
    };
    try {
      const up = await readyz(200, 10_000);
      expect(up.status).toBe(200);
      expect(up.body.checks?.redis).toBe('ok');

      await proxy.cut();
      const cut = await readyz(503, 10_000);
      expect(cut.status).toBe(503);
      expect(cut.body.checks).toMatchObject({ redis: 'unavailable', database: 'ok', kms: 'ok', blobs: 'ok' });
      // The heartbeat says the same, so the Overview shows it.
      await h.s.instances.beat();
      expect((await h.s.db('platform_instances').where({ id: h.s.instances.id }).first()).state).toBe('not ready');

      await proxy.open(); // the same port: the clients reconnect by themselves
      const back = await readyz(200, 30_000);
      expect(back.status).toBe(200);
      expect(back.body.checks?.redis).toBe('ok');
    } finally {
      await proxy.cut();
      await h.close();
    }
  }, 90_000);

  it('with Redis two processes share a database; a third without it exits with the reason', async () => {
    const base = (port: number): NodeJS.ProcessEnv => ({
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      HOST: '127.0.0.1',
      PORT: String(port),
      PUBLIC_URL: `http://127.0.0.1:${port}`,
      DB_CLIENT: 'sqlite',
      SQLITE_FILENAME: path.join(dir, 'app.sqlite'),
      SESSION_SECRET: 'b9001-session-secret-b9001-session-secret-b9001',
      DATA_KEY: Buffer.alloc(32, 7).toString('base64'),
      WEB_ROOT: '/nonexistent',
      BLOB_DIR: path.join(dir, 'blobs'),
      JOB_QUEUE: 'db',
      CACHE_STORE: 'memory'
    });
    const start = (env: NodeJS.ProcessEnv) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: SERVER_ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
      children.push(child);
      let stderr = '';
      child.stderr!.on('data', (d: Buffer) => (stderr += d.toString()));
      const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
      return { child, exited, stderr: () => stderr };
    };
    const ready = async (port: number, p: ReturnType<typeof start>) => {
      const end = Date.now() + 120_000;
      while (Date.now() < end && p.child.exitCode === null) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/readyz`);
          if (r.status === 200) return (await r.json()) as { checks: Record<string, string> };
        } catch {
          /* not listening yet */
        }
        await sleep(250);
      }
      return null;
    };
    const [p1, p2, p3] = [await freePort(), await freePort(), await freePort()];
    const first = start({ ...base(p1), REDIS_URL: REDIS });
    const r1 = await ready(p1, first);
    expect(r1, first.stderr()).not.toBeNull();
    expect(r1!.checks.redis).toBe('ok');
    // A web-only process beside it: allowed, because Redis carries the bus between them.
    const second = start({ ...base(p2), REDIS_URL: REDIS, WORKERS_ENABLED: 'false' });
    expect(await ready(p2, second), second.stderr()).not.toBeNull();
    // The same without Redis: refused, and both reasons are named.
    const third = start({ ...base(p3), WORKERS_ENABLED: 'false' });
    expect(await third.exited).toBe(1);
    expect(third.stderr()).toContain('REDIS_URL is required because WORKERS_ENABLED=false makes this an API process whose jobs another process runs');
    expect(third.stderr()).toContain('another server process is running on this database');
    for (const p of [second, first]) {
      p.child.kill('SIGTERM');
      expect(await p.exited).toBe(0);
    }
  }, 300_000);
});
