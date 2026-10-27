import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { createDb } from '../src/db/knex.js';
import { createLogger } from '../src/observability/index.js';
import { multiProcessReasons, pidAlive, redisRequirement } from '../src/ops/redis-required.js';
import { Bus } from '../src/platform/bus.js';
import { harness, type Harness } from './helpers.js';

/*
 * 1.7.0, Sprint 41 (B-9001, decision D17): Redis is required for any install with more than one process.
 *
 * - The rule: a process configured as one of several (WORKERS_ENABLED=false, SERVER_REPLICAS above 1), or one that
 *   finds another instance's live heartbeat, has a reason; with REDIS_URL set there is nothing to refuse.
 * - A row left by a killed process of this host does not count and is removed; one from another host counts until
 *   it is stale.
 * - `/readyz` carries a `redis` check when Redis is configured and fails while it does not answer.
 * - Two real server processes on one database without Redis: the second exits with the reason; after the first is
 *   killed without a clean shutdown, a new one starts.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(here, '..');
const STALE = 95_000;

const instanceRow = (id: string, node: string, pid: number, heartbeatAt: number) => ({
  id, node, pid, role: 'api, jobs', version: '1.7.0', state: 'ready', checks: '{}', runtime: '{}', schema_state: 'current', schema_detail: null,
  jobs_claimed: 0, sockets: 0, drain: false, drained_by: null, drained_at: null, started_at: heartbeatAt - 60_000, heartbeat_at: heartbeatAt
});

describe('B-9001: Redis is required for more than one process', () => {
  let h: Harness;
  const self = () => ({ id: h.s.instances.id });

  beforeAll(async () => {
    h = await harness();
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(async () => {
    await h.s.db('platform_instances').delete();
  });

  it('lets a single process start without Redis, also beside its own row and a stale one', async () => {
    const one = { WORKERS_ENABLED: true, SERVER_REPLICAS: 1, REDIS_URL: undefined };
    expect(await redisRequirement(one, h.s.db, self(), STALE)).toBeNull();
    await h.s.instances.beat(); // this process's own heartbeat
    await h.s.db('platform_instances').insert(instanceRow('node-b:41', 'node-b', 41, Date.now() - STALE - 1000)); // gone for longer than three beats
    expect(await redisRequirement(one, h.s.db, self(), STALE)).toBeNull();
    expect(h.s.instances.staleMs).toBe(STALE);
  });

  it('names a configured split or replica count, and nothing once REDIS_URL is set', async () => {
    const worker = await redisRequirement({ WORKERS_ENABLED: false, SERVER_REPLICAS: 1, REDIS_URL: undefined }, h.s.db, self(), STALE);
    expect(worker).toMatch(/^REDIS_URL is required because WORKERS_ENABLED=false makes this an API process whose jobs another process runs\./);
    expect(worker).toContain('Set REDIS_URL');
    const replicas = await redisRequirement({ WORKERS_ENABLED: true, SERVER_REPLICAS: 3, REDIS_URL: undefined }, h.s.db, self(), STALE);
    expect(replicas).toContain('SERVER_REPLICAS=3 says the install runs more than one server process');
    const both = await multiProcessReasons({ WORKERS_ENABLED: false, SERVER_REPLICAS: 2 }, h.s.db, self(), STALE);
    expect(both).toHaveLength(2);
    expect(await redisRequirement({ WORKERS_ENABLED: false, SERVER_REPLICAS: 3, REDIS_URL: 'redis://127.0.0.1:6379' }, h.s.db, self(), STALE)).toBeNull();
    // The settings themselves.
    expect(loadConfig({ NODE_ENV: 'test', SESSION_SECRET: randomBytes(32).toString('hex'), DATA_KEY: randomBytes(32).toString('base64'), PUBLIC_URL: 'http://localhost:8080' } as NodeJS.ProcessEnv)).toMatchObject({ SERVER_REPLICAS: 1, ATPROTO_STREAM_POLL_SECONDS: 5 });
  });

  it('counts a live heartbeat of another process, but not one a killed process of this host left behind', async () => {
    const one = { WORKERS_ENABLED: true, SERVER_REPLICAS: 1, REDIS_URL: undefined };
    const now = Date.now();
    // Another host: it cannot be looked at, so it counts while its beat is fresh.
    await h.s.db('platform_instances').insert(instanceRow('node-b:917', 'node-b', 917, now - 20_000));
    const other = await redisRequirement(one, h.s.db, self(), STALE);
    expect(other).toMatch(/another server process is running on this database: node-b:917 \(heartbeat \d+ s ago\)/);
    await h.s.db('platform_instances').delete();

    // This host, a process that is running (this test's parent): it counts.
    const alivePid = process.ppid;
    expect(pidAlive(alivePid)).toBe(true);
    await h.s.db('platform_instances').insert(instanceRow(`${hostname()}:${alivePid}`, hostname(), alivePid, now - 1000));
    expect(await redisRequirement(one, h.s.db, self(), STALE)).toContain(`${hostname()}:${alivePid}`);
    await h.s.db('platform_instances').delete();

    // This host, a pid that is gone (killed without removing its row): not counted, and the row goes.
    await h.s.db('platform_instances').insert(instanceRow(`${hostname()}:999999`, hostname(), 999999, now - 1000));
    expect(await redisRequirement(one, h.s.db, self(), STALE, () => false)).toBeNull();
    expect(await h.s.db('platform_instances').where({ id: `${hostname()}:999999` }).first()).toBeUndefined();
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(-5)).toBe(false);
  });

  it('answers /readyz without a redis check when none is configured, and 503 while a configured Redis does not answer', async () => {
    const ready = await request(h.app).get('/readyz').expect(200);
    expect(ready.body.checks).not.toHaveProperty('redis');
    expect(await h.s.bus.health()).toBeNull();

    const original = h.s.bus.health.bind(h.s.bus);
    h.s.bus.health = async () => ({ ok: false, detail: 'connect ECONNREFUSED 10.20.30.40:6379' });
    try {
      const cut = await request(h.app).get('/readyz').expect(503);
      expect(cut.body).toMatchObject({ status: 'not ready', checks: { redis: 'unavailable', database: 'ok' } });
      expect(JSON.stringify(cut.body)).not.toContain('10.20.30.40'); // the endpoint is public
      // The heartbeat records the same answer, so the Overview shows the instance as not ready.
      await h.s.instances.beat();
      const row = await h.s.db('platform_instances').where({ id: h.s.instances.id }).first();
      expect(row.state).toBe('not ready');
      expect(JSON.parse(row.checks).redis).toBe('unavailable');
    } finally {
      h.s.bus.health = original;
    }
    h.s.bus.health = async () => ({ ok: true, detail: 'ok' });
    try {
      expect((await request(h.app).get('/readyz').expect(200)).body.checks.redis).toBe('ok');
    } finally {
      h.s.bus.health = original;
    }
  });

  it('reports a bus whose Redis cannot be reached as unhealthy within the timeout', async () => {
    const closed = await freePort(); // nothing listens there
    const bus = new Bus(createLogger('silent', false), `redis://127.0.0.1:${closed}`);
    try {
      const t = Date.now();
      const health = await bus.health(500);
      expect(health?.ok).toBe(false);
      expect(Date.now() - t).toBeLessThan(3000);
    } finally {
      await Promise.race([bus.close(), new Promise((r) => setTimeout(r, 1000))]);
    }
  });
});

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

describe('B-9001: a second server process on the same database, without Redis', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'exprsn-b9001-'));
  const children: ChildProcess[] = [];
  const env = (port: number): NodeJS.ProcessEnv => ({
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
    JOB_QUEUE: 'db'
  });
  const start = (port: number) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: SERVER_ROOT, env: env(port), stdio: ['ignore', 'ignore', 'pipe'] });
    children.push(child);
    let stderr = '';
    child.stderr!.on('data', (d: Buffer) => (stderr += d.toString()));
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    return { child, exited, stderr: () => stderr };
  };
  const ready = async (port: number, p: ReturnType<typeof start>, ms = 120_000): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (p.child.exitCode !== null) return false;
      try {
        if ((await fetch(`http://127.0.0.1:${port}/readyz`)).status === 200) return true;
      } catch {
        /* not listening yet */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  };

  afterAll(() => {
    for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits with the reason; a restart after a kill starts, because the dead process is not counted', async () => {
    const [p1, p2, p3] = [await freePort(), await freePort(), await freePort()];
    const first = start(p1);
    expect(await ready(p1, first), `the first process did not start: ${first.stderr()}`).toBe(true);
    // Its heartbeat is in the database.
    const db = createDb(loadConfig(env(p1)));
    try {
      let rows: { id: string; pid: number }[] = [];
      for (let i = 0; i < 80 && !rows.length; i++) {
        rows = await db('platform_instances').select('id', 'pid');
        if (!rows.length) await new Promise((r) => setTimeout(r, 250));
      }
      expect(rows.map((r) => Number(r.pid))).toEqual([first.child.pid]);

      const second = start(p2);
      expect(await second.exited).toBe(1);
      expect(second.stderr()).toMatch(/exprsn-ai failed to start: REDIS_URL is required because another server process is running on this database: \S+ \(heartbeat \d+ s ago\)\./);
      expect(second.stderr()).toContain('Set REDIS_URL');
      // The first one is untouched.
      expect((await fetch(`http://127.0.0.1:${p1}/readyz`)).status).toBe(200);
      expect(await db('platform_instances').select('id')).toHaveLength(1);

      // Killed, not stopped: its row stays, its pid is gone. The next start does not take it for a second process.
      first.child.kill('SIGKILL');
      await first.exited;
      expect(await db('platform_instances').select('id')).toHaveLength(1);
      const third = start(p3);
      expect(await ready(p3, third), `the restart did not start: ${third.stderr()}`).toBe(true);
      const after = (await db('platform_instances').select('pid')) as { pid: number }[];
      expect(after.map((r) => Number(r.pid))).toEqual([third.child.pid]);
      third.child.kill('SIGTERM');
      expect(await third.exited).toBe(0);
      expect(await db('platform_instances').select('id')).toHaveLength(0); // a clean shutdown removes its row
    } finally {
      await db.destroy();
    }
  }, 300_000);
});
