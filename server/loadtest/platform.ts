/**
 * Load test of the 1.4.0 event and data paths (B-2105): webhook fan-out, low-code record writes, the OCSP responder
 * and firehose ingest. See docs/loadtest.md for the reference setup, the targets and the measured results.
 *
 * The application runs in a process of its own (`platform-server.ts`, started as `src/index.ts` starts the server,
 * with the job workers and schedules), next to a signer process (`exprsn-ai signer`) that holds the CA and labeler
 * keys. This process is the load generator and the outside world: a webhook receiver, a Jetstream that pushes
 * posts faster than they are consumed, OCSP relying parties and the users of a low-code app.
 *
 *   npx tsx server/loadtest/platform.ts                                    # every scenario, in-memory SQLite
 *   npx tsx server/loadtest/platform.ts --db postgres://u:p@127.0.0.1:5432/load --port 55471
 *   npx tsx server/loadtest/platform.ts --scenarios ocsp,firehose --duration 10
 *
 * Exit codes: 0 when every target holds, 1 when one is missed, 2 on a setup failure.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { WebSocketServer, type WebSocket } from 'ws';
import { children, int, nul, octets, oid, parse, seq, tagged } from '../src/pki/asn1.js';
import { OCSP_OIDS } from '../src/pki/ocsp.js';
import { certificateParts, spkiKeyBits } from '../src/pki/x509.js';
import { verifySignature } from '../src/webhooks/service.js';
import type { Command, Seed } from './platform-server.js';

/* ------------------------------------------------------------------ options */

const SCENARIOS = ['webhooks', 'records', 'ocsp', 'firehose'] as const;
type Scenario = (typeof SCENARIOS)[number];

const { values: opt } = parseArgs({
  options: {
    scenarios: { type: 'string', default: SCENARIOS.join(',') },
    db: { type: 'string', default: 'sqlite' },
    port: { type: 'string', default: '0' },
    duration: { type: 'string', default: '15' },
    concurrency: { type: 'string', default: '16' },
    users: { type: 'string', default: '128' },
    targets: { type: 'string', default: 'reference' },
    // webhooks
    endpoints: { type: 'string', default: '10' },
    'events-per-s': { type: 'string', default: '10' },
    'slow-ms': { type: 'string', default: '3000' },
    'webhook-timeout-ms': { type: 'string', default: '1000' },
    'job-concurrency': { type: 'string' },
    'job-poll-ms': { type: 'string' },
    // firehose
    posts: { type: 'string', default: '20000' },
    'queue-max': { type: 'string', default: '1000' },
    'log-level': { type: 'string', default: 'error' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false }
  }
});

const USAGE = `Usage: npx tsx server/loadtest/platform.ts [options]

  --scenarios <list>       Any of ${SCENARIOS.join(', ')} (default: all, in that order)
  --db <sqlite|url>        sqlite (in memory, the default) or a postgres:// or mysql:// URL of an empty database
  --port <n>               Port for the application (default: a free one)
  --duration <s>           Seconds of load in each measured phase (default 15)
  --concurrency <n>        Concurrent clients for records and OCSP (default 16)
  --users <n>              Signed-in users the record clients rotate through (default 128; each has the API limit)
  --targets <set>          reference (docs/loadtest.md) or ci (looser, for shared runners) (default reference)

  Webhooks:
  --endpoints <n>          Endpoints subscribed to every event (default 10; the last is made slow in phase 2)
  --events-per-s <n>       Events emitted per second (default 10)
  --slow-ms <ms>           How long the slow endpoint takes to answer (default 3000)
  --webhook-timeout-ms <ms>  WEBHOOK_TIMEOUT_MS of the application (default 1000)
  --job-concurrency <n>, --job-poll-ms <ms>   JOB_CONCURRENCY and JOB_POLL_MS (default: the application's defaults)

  Firehose:
  --posts <n>              Posts the fake Jetstream holds and pushes (default 20000)
  --queue-max <n>          FIREHOSE_QUEUE_MAX (default 1000)

  --log-level <level>      LOG_LEVEL of the application (default error)
  --json                   Print the results as JSON
`;

const num = (v: string | undefined, name: string): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a non-negative number`);
  return n;
};

const DURATION_MS = num(opt.duration, 'duration') * 1000;
const CONCURRENCY = Math.max(1, Math.floor(num(opt.concurrency, 'concurrency')));
const out = (line = '') => {
  if (!opt.json) process.stdout.write(line + '\n');
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ measurement */

function pct(values: number[], p: number): number | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))]!;
}

interface Stats {
  n: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

const stats = (values: number[]): Stats => ({ n: values.length, p50: pct(values, 50), p95: pct(values, 95), p99: pct(values, 99), max: values.length ? values.reduce((a, b) => Math.max(a, b), 0) : null });
const f1 = (v: number | null) => (v === null ? '-' : v.toFixed(1));

interface Check {
  scenario: Scenario;
  name: string;
  value: number | null;
  target: number;
  dir: 'max' | 'min';
  ok: boolean;
}

const TARGETS: Record<string, Record<string, number>> = {
  // docs/loadtest.md, "Targets for 1.4.0". ci multiplies latencies by 3 and divides rates by 3 (shared runners).
  reference: {
    'webhooks.healthy-p95-ms': 500,
    'webhooks.isolated-p95-ms': 2000,
    'webhooks.deliveries-per-s': 90,
    'webhooks.lost': 0,
    'webhooks.slow-attempts': 8,
    'records.create-p95-ms': 100,
    'records.update-p95-ms': 100,
    'records.query-p95-ms': 250,
    'records.writes-per-s': 300,
    'records.errors': 0,
    'ocsp.signed-per-s': 1000,
    'ocsp.signed-p95-ms': 50,
    'ocsp.cached-per-s': 3000,
    'ocsp.errors': 0,
    'firehose.posts-per-s': 300,
    'firehose.lost': 0,
    'firehose.duplicates': 0,
    'firehose.queue-over-max': 250
  }
};
TARGETS.ci = Object.fromEntries(Object.entries(TARGETS.reference!).map(([k, v]) => [k, /-ms$/.test(k) ? v * 3 : /per-s$/.test(k) ? v / 3 : v]));

const checks: Check[] = [];
function check(scenario: Scenario, name: string, value: number | null, dir: 'max' | 'min'): void {
  const target = TARGETS[String(opt.targets)]?.[`${scenario}.${name}`];
  if (target === undefined) return;
  checks.push({ scenario, name, value, target, dir, ok: value !== null && (dir === 'max' ? value <= target : value >= target) });
}

/* ------------------------------------------------------------------ the application */

interface App {
  seed: Seed;
  call<T = unknown>(c: Command): Promise<T>;
  close(): Promise<void>;
}

const here = path.dirname(fileURLToPath(import.meta.url));

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  await new Promise((r) => srv.close(r));
  return port;
}

function waitExit(c: ChildProcess, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (c.exitCode !== null || c.signalCode !== null) return resolve();
    const t = setTimeout(() => {
      c.kill('SIGKILL');
      resolve();
    }, ms);
    c.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

async function startApp(extraEnv: Record<string, string>): Promise<App> {
  const dir = mkdtempSync(path.join(tmpdir(), 'exl-'));
  const token = randomBytes(24).toString('base64url') + 'x'.repeat(8);
  const keyFile = path.join(dir, 'signer.key');
  const tokenFile = path.join(dir, 'signer.token');
  writeFileSync(keyFile, randomBytes(32).toString('base64'));
  writeFileSync(tokenFile, token);
  chmodSync(keyFile, 0o600);
  chmodSync(tokenFile, 0o600);
  const socketPath = path.join(dir, 'run', 'signer.sock');
  const execArgv = ['--import', 'tsx'];
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DATA_KEY|DATABASE_URL|DB_CLIENT|SIGNER_|PORT$|LOG_LEVEL$)/.test(k))) as NodeJS.ProcessEnv;

  // The signer (B-1201) as its own process, as deployed: the CA and labeler keys live there.
  const signer = fork(path.join(here, '..', 'src', 'cli.ts'), ['signer', '--socket', socketPath, '--key-file', keyFile, '--token-file', tokenFile], { execArgv, env: baseEnv, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const signerErr: string[] = [];
  signer.stderr?.on('data', (d: Buffer) => signerErr.push(d.toString()));
  for (let i = 0; i < 200 && !signerErr.join('').includes('listening'); i++) {
    if (signer.exitCode !== null) throw new Error(`the signer stopped: ${signerErr.join('')}`);
    await sleep(100);
  }

  const port = num(opt.port, 'port') || (await freePort());
  const dbUrl = String(opt.db);
  const dbEnv: Record<string, string> = dbUrl === 'sqlite' ? { DB_CLIENT: 'sqlite', SQLITE_FILENAME: ':memory:' } : { DB_CLIENT: /^mysql/.test(dbUrl) ? 'mysql' : 'pg', DATABASE_URL: dbUrl };
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    NODE_ENV: 'development',
    LOG_LEVEL: String(opt['log-level']),
    HOST: '127.0.0.1',
    PORT: String(port),
    PUBLIC_URL: `http://127.0.0.1:${port}`,
    SESSION_SECRET: randomBytes(32).toString('hex'),
    SIGNER_SOCKET: socketPath,
    SIGNER_TOKEN: token,
    BLOB_DIR: path.join(dir, 'blobs'),
    WEB_ROOT: '/nonexistent',
    JOB_QUEUE: 'db',
    ATPROTO_PUBLIC_URL: 'https://load.example.test',
    MODERATION_SWEEP_SECONDS: '0',
    LOADTEST_USERS_N: String(Math.max(1, Math.floor(num(opt.users, 'users')))),
    ...dbEnv,
    ...extraEnv
  };
  const child = fork(path.join(here, 'platform-server.ts'), [], { execArgv, env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let next = 1;
  const seed = await new Promise<Seed>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the application did not start within 300 s')), 300_000);
    child.on('message', (m: { ready?: Seed; rid?: number; result?: unknown; error?: string }) => {
      if (m.ready) {
        clearTimeout(timer);
        resolve(m.ready);
      } else if (m.rid !== undefined) {
        const p = pending.get(m.rid);
        pending.delete(m.rid);
        if (m.error) p?.reject(new Error(m.error));
        else p?.resolve(m.result);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the application exited (${code}) before it was ready`));
      for (const p of pending.values()) p.reject(new Error('the application exited'));
    });
  });
  return {
    seed,
    call: <T>(c: Command) =>
      new Promise<T>((resolve, reject) => {
        const id = next++;
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        child.send({ rid: id, ...c });
      }),
    close: async () => {
      child.kill('SIGTERM');
      await waitExit(child, 15_000);
      signer.kill('SIGTERM');
      await waitExit(signer, 5_000);
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/* ------------------------------------------------------------------ HTTP clients */

interface Session {
  cookie: string;
  csrf: string;
  ip: string;
}

const mergeCookies = (prev: string, res: Response) => {
  const jar = new Map(prev ? prev.split('; ').map((c) => [c.split('=')[0]!, c] as const) : []);
  for (const c of res.headers.getSetCookie()) jar.set(c.split('=')[0]!, c.split(';')[0]!);
  return [...jar.values()].join('; ');
};

/** A documentation address (198.18.0.0/15) per simulated client; the application trusts X-Forwarded-For on loopback. */
const clientIp = (i: number) => `198.18.${Math.floor(i / 250) % 256}.${(i % 250) + 1}`;

async function signIn(url: string, username: string, password: string, ip: string): Promise<Session> {
  const res = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ username, password }) });
  const body = (await res.json().catch(() => ({}))) as { stage?: string; csrf?: string; detail?: string };
  if (!res.ok || body.stage !== 'active') throw new Error(`sign-in ${username}: ${res.status} ${body.stage ?? ''} ${body.detail ?? ''}`);
  return { cookie: mergeCookies('', res), csrf: String(body.csrf), ip };
}

async function api(url: string, s: Session, method: string, p: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url + p, { method, headers: { 'content-type': 'application/json', cookie: s.cookie, 'x-csrf-token': s.csrf, 'x-forwarded-for': s.ip }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** Runs `worker` on `n` concurrent loops until `ms` has passed; returns the wall time in seconds. */
async function closedLoop(n: number, ms: number, worker: (i: number) => Promise<void>): Promise<number> {
  const start = performance.now();
  const end = start + ms;
  await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      while (performance.now() < end) await worker(i);
    })
  );
  return (performance.now() - start) / 1000;
}

/* ------------------------------------------------------------------ scenario: webhook fan-out */

async function webhooks(app: App): Promise<Record<string, unknown>> {
  const endpoints = Math.max(2, Math.floor(num(opt.endpoints, 'endpoints')));
  const rate = num(opt['events-per-s'], 'events-per-s');
  const slowMs = num(opt['slow-ms'], 'slow-ms');
  const slowIndex = endpoints - 1;
  let slow = false;
  let phase = 0;
  const secrets: string[] = [];
  const received: { phase: number; hook: number; event: string; latency: number }[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  let badSignatures = 0;
  let slowHits = 0;

  const receiver = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const at = Date.now();
      const hook = Number(/^\/hook\/(\d+)$/.exec(req.url ?? '')?.[1] ?? -1);
      const body = Buffer.concat(chunks).toString('utf8');
      if (hook === slowIndex && slow) {
        slowHits++;
        setTimeout(() => {
          if (!res.writableEnded && !res.destroyed) res.writeHead(204).end();
        }, slowMs);
        return;
      }
      if (!verifySignature(secrets[hook] ?? '', req.headers['x-exprsn-timestamp'] as string | undefined, req.headers['x-exprsn-signature'] as string | undefined, body)) badSignatures++;
      const e = JSON.parse(body) as { id: string; createdAt: string };
      const key = `${hook}:${e.id}`;
      if (seen.has(key)) duplicates++;
      else {
        seen.add(key);
        received.push({ phase, hook, event: e.id, latency: at - Date.parse(e.createdAt) });
      }
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;

  try {
    const hooks = await app.call<{ id: string; secret: string }[]>({ cmd: 'webhooks.setup', urls: Array.from({ length: endpoints }, (_, i) => `${base}/hook/${i}`), events: ['record.*'] });
    for (const h of hooks) secrets.push(h.secret);
    const count = Math.max(1, Math.round((rate * DURATION_MS) / 1000));
    const phases: Record<string, unknown>[] = [];

    for (const p of [1, 2]) {
      phase = p;
      slow = p === 2;
      const healthy = endpoints - (slow ? 1 : 0);
      const want = count * healthy;
      const started = performance.now();
      await app.call({ cmd: 'webhooks.emit', count, spreadMs: DURATION_MS });
      // Wait for the healthy endpoints' deliveries (they are the ones that must not be held up).
      const deadline = performance.now() + DURATION_MS + 120_000;
      const got = () => received.filter((r) => r.phase === p && !(slow && r.hook === slowIndex)).length;
      for (let tick = 1; got() < want && performance.now() < deadline; tick++) {
        await sleep(100);
        if (tick % 100 === 0) process.stderr.write(`  webhooks phase ${p}: ${got()}/${want} delivered after ${((performance.now() - started) / 1000).toFixed(0)} s\n`);
      }
      const wall = (performance.now() - started) / 1000;
      const lat = received.filter((r) => r.phase === p && !(slow && r.hook === slowIndex)).map((r) => r.latency);
      const st = await app.call<{ opened: number; hooks: { name: string; breaker: string; failures: number; attempts: number; states: Record<string, number> }[] }>({ cmd: 'webhooks.stats' });
      const slowHook = st.hooks.find((h) => h.name === `load-${slowIndex + 1}`);
      phases.push({ phase: p, slowEndpoint: slow, events: count, expected: want, delivered: got(), lost: want - got(), wallSeconds: wall, deliveriesPerSecond: got() / wall, latencyMs: stats(lat), breakerOpened: st.opened, slowAttempts: slow ? slowHits : 0, slowBreaker: slow ? slowHook?.breaker : null });
    }
    await app.call({ cmd: 'webhooks.disable' });

    const [p1, p2] = phases as { lost: number; deliveriesPerSecond: number; latencyMs: Stats; breakerOpened: number; slowAttempts: number }[];
    check('webhooks', 'healthy-p95-ms', p1!.latencyMs.p95, 'max');
    check('webhooks', 'isolated-p95-ms', p2!.latencyMs.p95, 'max');
    check('webhooks', 'deliveries-per-s', p1!.deliveriesPerSecond, 'min');
    check('webhooks', 'lost', p1!.lost + p2!.lost, 'max');
    check('webhooks', 'slow-attempts', p2!.slowAttempts, 'max');
    const result = { endpoints, eventsPerSecond: rate, slowMs, phases, duplicates, badSignatures };

    out('Webhook fan-out');
    out(`  ${endpoints} endpoints, ${rate} events/s for ${DURATION_MS / 1000} s; phase 2 makes endpoint ${slowIndex + 1} answer after ${slowMs} ms`);
    for (const ph of phases as { phase: number; delivered: number; expected: number; deliveriesPerSecond: number; latencyMs: Stats; breakerOpened: number; slowAttempts: number; slowBreaker: string | null }[]) {
      out(`  phase ${ph.phase}: delivered ${ph.delivered}/${ph.expected} to healthy endpoints, ${ph.deliveriesPerSecond.toFixed(1)}/s, latency p50 ${f1(ph.latencyMs.p50)} p95 ${f1(ph.latencyMs.p95)} p99 ${f1(ph.latencyMs.p99)} max ${f1(ph.latencyMs.max)} ms` + (ph.phase === 2 ? `; slow endpoint: ${ph.slowAttempts} attempts, breaker ${ph.slowBreaker}, opened ${ph.breakerOpened} time(s)` : ''));
    }
    out(`  duplicates ${duplicates}, bad signatures ${badSignatures}`);
    out();
    return result;
  } finally {
    receiver.closeAllConnections();
    await new Promise((r) => receiver.close(r));
  }
}

/* ------------------------------------------------------------------ scenario: low-code record writes */

async function records(app: App): Promise<Record<string, unknown>> {
  const { url, seed } = { url: app.seed.url, seed: app.seed };
  const sessions: Session[] = [];
  for (const [i, u] of seed.users.entries()) {
    const s = await signIn(url, u, seed.password, clientIp(i));
    const w = await api(url, s, 'PUT', '/api/me/workspace', { workspaceId: seed.workspaceId });
    if (w.status !== 200) throw new Error(`workspace switch: ${w.status}`);
    s.csrf = String(w.body.csrf ?? s.csrf);
    sessions.push(s);
  }
  const base = `/api/apps/${seed.app}/entities/${seed.entity}/records`;
  const stages = ['Lead', 'Open', 'Won', 'Lost'];
  let turn = 0;
  const session = () => sessions[turn++ % sessions.length]!;
  const errors = new Map<string, number>();
  const err = (k: string) => errors.set(k, (errors.get(k) ?? 0) + 1);
  const ids: string[] = [];
  const titles: string[] = [];
  let duplicatesRefused = 0;
  let duplicatesAccepted = 0;

  // Phase 1: creates, with about one in 25 reusing an existing title in another case (refused, B-2201).
  const createLat: number[] = [];
  let n = 0;
  const createWall = await closedLoop(CONCURRENCY, DURATION_MS, async (w) => {
    const i = n++;
    const dup = titles.length > 10 && i % 25 === 0;
    const title = dup ? titles[(i * 7) % titles.length]!.toUpperCase() : `Ticket ${w}-${i}`;
    const t = performance.now();
    const r = await api(url, session(), 'POST', base, { values: { title, amount: (i * 37) % 1000, due: `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`, stage: stages[i % 4], notes: `Load test record ${i}. ${'x'.repeat(200)}` } });
    if (dup) {
      if (r.status === 409) duplicatesRefused++;
      else if (r.status === 201) duplicatesAccepted++;
      else err(`create duplicate: HTTP ${r.status}`);
      return;
    }
    if (r.status === 201) {
      createLat.push(performance.now() - t);
      ids.push(String(r.body.id));
      titles.push(title);
    } else err(`create: HTTP ${r.status} ${String(r.body.title ?? '')}`);
  });

  // Phase 2: updates of indexed fields (amount and stage are re-indexed; the unique title is unchanged).
  const updateLat: number[] = [];
  n = 0;
  const updateWall = await closedLoop(CONCURRENCY, DURATION_MS, async () => {
    const i = n++;
    const id = ids[(i * 7919) % ids.length]!;
    const t = performance.now();
    const r = await api(url, session(), 'PATCH', `${base}/${id}`, { values: { amount: (i * 13) % 1000, stage: stages[(i + 1) % 4] } });
    if (r.status === 200) updateLat.push(performance.now() - t);
    else err(`update: HTTP ${r.status} ${String(r.body.title ?? '')}`);
  });

  // Phase 3: filtered, sorted, paged queries on the indexed fields.
  const queryLat: number[] = [];
  const bodyLat: number[][] = [[], [], []];
  let rows = 0;
  n = 0;
  const queryWall = await closedLoop(CONCURRENCY, DURATION_MS, async () => {
    const i = n++;
    const bodies = [
      { filter: { and: [{ field: 'stage', op: 'eq', value: stages[i % 4] }, { field: 'amount', op: 'gte', value: (i * 31) % 900 }] }, sort: [{ field: 'amount', dir: 'desc' }], limit: 50 },
      { filter: { field: 'title', op: 'startsWith', value: `Ticket ${i % CONCURRENCY}-` }, sort: [{ field: 'title', dir: 'asc' }], limit: 25 },
      { filter: { and: [{ field: 'due', op: 'gte', value: '2026-03-01' }, { field: 'due', op: 'lt', value: '2026-06-01' }] }, sort: [{ field: 'due', dir: 'asc' }], limit: 50, offset: (i % 5) * 50 }
    ];
    const t = performance.now();
    const r = await api(url, session(), 'POST', `${base}/query`, bodies[i % bodies.length]);
    if (r.status === 200) {
      queryLat.push(performance.now() - t);
      bodyLat[i % bodies.length]!.push(performance.now() - t);
      rows += (r.body.records as unknown[] | undefined)?.length ?? 0;
    } else err(`query: HTTP ${r.status} ${String(r.body.title ?? '')}`);
  });

  const stored = (await app.call<{ records: number }>({ cmd: 'records.count' })).records;
  const errorCount = [...errors.values()].reduce((a, b) => a + b, 0) + duplicatesAccepted + (stored === ids.length ? 0 : 1);
  const result = {
    users: sessions.length,
    concurrency: CONCURRENCY,
    create: { n: createLat.length, perSecond: createLat.length / createWall, latencyMs: stats(createLat) },
    update: { n: updateLat.length, perSecond: updateLat.length / updateWall, latencyMs: stats(updateLat) },
    query: { n: queryLat.length, perSecond: queryLat.length / queryWall, latencyMs: stats(queryLat), rowsPerQuery: queryLat.length ? rows / queryLat.length : 0, byBody: bodyLat.map(stats) },
    duplicatesRefused,
    duplicatesAccepted,
    stored,
    errors: Object.fromEntries(errors)
  };
  check('records', 'create-p95-ms', result.create.latencyMs.p95, 'max');
  check('records', 'update-p95-ms', result.update.latencyMs.p95, 'max');
  check('records', 'query-p95-ms', result.query.latencyMs.p95, 'max');
  check('records', 'writes-per-s', Math.min(result.create.perSecond, result.update.perSecond), 'min');
  check('records', 'errors', errorCount, 'max');

  out('Low-code record writes');
  out(`  ${CONCURRENCY} clients over ${sessions.length} users, ${DURATION_MS / 1000} s per phase`);
  for (const [k, v] of [['create', result.create], ['update', result.update], ['query', result.query]] as const) out(`  ${k.padEnd(7)} ${String(v.n).padStart(6)} at ${v.perSecond.toFixed(1)}/s, p50 ${f1(v.latencyMs.p50)} p95 ${f1(v.latencyMs.p95)} p99 ${f1(v.latencyMs.p99)} max ${f1(v.latencyMs.max)} ms`);
  out(`  query p95 by body: and(stage eq, amount gte) by amount desc ${f1(result.query.byBody[0]!.p95)}, title startsWith by title ${f1(result.query.byBody[1]!.p95)}, due range by due with offset ${f1(result.query.byBody[2]!.p95)} ms`);
  out(`  ${result.query.rowsPerQuery.toFixed(1)} rows per query; duplicate titles refused ${duplicatesRefused}, accepted ${duplicatesAccepted}; ${stored} records stored for ${ids.length} created`);
  if (errors.size) for (const [k, v] of errors) out(`  error ${v} x ${k}`);
  out();
  return result;
}

/* ------------------------------------------------------------------ scenario: OCSP */

const derOfPem = (p: string) => Buffer.from(p.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');

function ocspRequest(issuerPem: string, serialHex: string, nonce: Buffer | null): Buffer {
  const parts = certificateParts(derOfPem(issuerPem));
  const h = (b: Buffer) => createHash('sha1').update(b).digest();
  const certId = seq(seq(oid(OCSP_OIDS.sha1), nul()), octets(h(parts.subject)), octets(h(spkiKeyBits(parts.spki))), int(Buffer.from(serialHex, 'hex')));
  const ext = nonce ? [tagged(2, true, seq(seq(oid(OCSP_OIDS.nonce), octets(octets(nonce)))))] : [];
  return seq(seq(seq(seq(certId)), ...ext));
}

/** The response status and the first certStatus tag (0x80 good, 0xa1 revoked, 0x82 unknown). */
function ocspStatus(der: Buffer): { status: number; cert: number | null } {
  const top = children(parse(der));
  const status = top[0]!.value[0]!;
  if (status !== 0) return { status, cert: null };
  const basic = children(parse(children(children(top[1]!)[0]!)[1]!.value));
  const single = children(children(children(basic[0]!)[2]!)[0]!);
  return { status, cert: single[1]!.tag };
}

async function ocsp(app: App): Promise<Record<string, unknown>> {
  const { url, issuerPem, serials, revoked } = app.seed;
  const targets = [...serials.map((s) => ({ serial: s, want: 0x80 })), ...revoked.map((s) => ({ serial: s, want: 0xa1 }))];
  const plain = targets.map((t) => ({ ...t, der: ocspRequest(issuerPem, t.serial, null) }));
  const phases: Record<string, unknown>[] = [];
  let errorTotal = 0;
  let ipTurn = 0;
  for (const mode of ['signed', 'cached'] as const) {
    const lat: number[] = [];
    const errors = new Map<string, number>();
    let i = 0;
    const wall = await closedLoop(CONCURRENCY, DURATION_MS, async () => {
      const t0 = targets[i++ % targets.length]!;
      // With a nonce every answer is signed for the request; without one, the responder's cache answers.
      const body = mode === 'signed' ? ocspRequest(issuerPem, t0.serial, randomBytes(16)) : plain[(i - 1) % plain.length]!.der;
      const t = performance.now();
      const res = await fetch(`${url}/pki/ocsp`, { method: 'POST', headers: { 'content-type': 'application/ocsp-request', 'x-forwarded-for': clientIp(ipTurn++ % 2000) }, body });
      const der = Buffer.from(await res.arrayBuffer());
      const ms = performance.now() - t;
      if (res.status !== 200) {
        errors.set(`HTTP ${res.status}`, (errors.get(`HTTP ${res.status}`) ?? 0) + 1);
        return;
      }
      const st = ocspStatus(der);
      if (st.status !== 0 || st.cert !== t0.want) errors.set(`status ${st.status}/${st.cert}`, (errors.get(`status ${st.status}/${st.cert}`) ?? 0) + 1);
      else lat.push(ms);
    });
    const errs = [...errors.values()].reduce((a, b) => a + b, 0);
    errorTotal += errs;
    phases.push({ mode, n: lat.length, perSecond: lat.length / wall, latencyMs: stats(lat), errors: Object.fromEntries(errors) });
  }
  const [signed, cached] = phases as { mode: string; n: number; perSecond: number; latencyMs: Stats; errors: Record<string, number> }[];
  check('ocsp', 'signed-per-s', signed!.perSecond, 'min');
  check('ocsp', 'signed-p95-ms', signed!.latencyMs.p95, 'max');
  check('ocsp', 'cached-per-s', cached!.perSecond, 'min');
  check('ocsp', 'errors', errorTotal, 'max');
  out('OCSP responder (a tenant intermediate, P-256, delegated responder in the signer)');
  out(`  ${CONCURRENCY} relying parties, ${targets.length} certificates (${revoked.length} revoked), ${DURATION_MS / 1000} s per phase`);
  for (const p of [signed!, cached!]) out(`  ${p.mode.padEnd(7)} ${String(p.n).padStart(6)} at ${p.perSecond.toFixed(1)}/s, p50 ${f1(p.latencyMs.p50)} p95 ${f1(p.latencyMs.p95)} p99 ${f1(p.latencyMs.p99)} max ${f1(p.latencyMs.max)} ms${Object.keys(p.errors).length ? `, errors ${JSON.stringify(p.errors)}` : ''}`);
  out();
  return { certificates: targets.length, revoked: revoked.length, concurrency: CONCURRENCY, signed, cached };
}

/* ------------------------------------------------------------------ scenario: firehose */

async function firehose(app: App): Promise<Record<string, unknown>> {
  const total = Math.max(10, Math.floor(num(opt.posts, 'posts')));
  const queueMax = Math.floor(num(opt['queue-max'], 'queue-max'));
  const baseUs = Date.now() * 1000;
  const dids = Array.from({ length: 50 }, (_, i) => `did:plc:load${String(i).padStart(20, 'a')}`);
  const timeOf = (i: number) => baseUs + i * 10;
  const message = (i: number) => JSON.stringify({ did: dids[i % dids.length], time_us: timeOf(i), kind: 'commit', commit: { rev: `rev${i}`, operation: 'create', collection: 'app.bsky.feed.post', rkey: `p${i}`, record: { $type: 'app.bsky.feed.post', text: i % 10 === 3 ? `post ${i}: buy at SPAMLINK now` : `post ${i}: the load test says hello`, createdAt: new Date().toISOString() }, cid: `bafyload${i}` } });

  // The fake Jetstream: replays from the cursor (inclusive, as Jetstream does) and sends as fast as the socket takes
  // it, waiting only when its own send buffer passes 1 MiB (the consumer's paused socket pushes back through TCP).
  const HIGH = 1 << 20;
  let sent = 0;
  let maxBuffered = 0;
  let firstConnect: number | null = null;
  const connections: { ws: WebSocket; cursor: number | null }[] = [];
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    firstConnect ??= performance.now();
    const cursor = new URL(req.url ?? '/', 'ws://x').searchParams.get('cursor');
    connections.push({ ws, cursor: cursor === null ? null : Number(cursor) });
    let i = cursor === null ? 0 : Math.max(0, Math.ceil((Number(cursor) - baseUs) / 10));
    const pump = () => {
      while (i < total && ws.readyState === ws.OPEN) {
        if (ws.bufferedAmount > HIGH) {
          maxBuffered = Math.max(maxBuffered, ws.bufferedAmount);
          setTimeout(pump, 5);
          return;
        }
        ws.send(message(i++));
        sent++;
        maxBuffered = Math.max(maxBuffered, ws.bufferedAmount);
      }
    };
    pump();
  });
  const endpoint = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;

  interface View {
    live: { connected: boolean; paused: boolean; queue: number; pauses: number; cursor: number | null } | null;
    cursor: number | null;
    received: number;
    checked: number;
    failed: number;
    reconnects: number;
    status: string;
    lastError: string | null;
  }
  try {
    const { id } = await app.call<{ id: string }>({ cmd: 'firehose.setup', endpoint });
    const last = timeOf(total - 1);
    let maxQueue = 0;
    let pauses = 0;
    let dropped = false;
    let restarted: number | null = null;
    let lastView: View | null = null;
    const deadline = performance.now() + Math.max(120_000, total * 50);
    for (let tick = 1; ; tick++) {
      const v = await app.call<View>({ cmd: 'firehose.view', id });
      if (tick % 40 === 0) process.stderr.write(`  firehose: ${v.status}, cursor at post ${v.live?.cursor != null ? Math.round((v.live.cursor - baseUs) / 10) + 1 : '-'} of ${total}, queue ${v.live?.queue ?? '-'}${v.live?.paused ? ' (paused)' : ''}, sent ${sent}${v.lastError ? `, last error: ${v.lastError}` : ''}\n`);
      lastView = v;
      if (v.live) {
        maxQueue = Math.max(maxQueue, v.live.queue);
        pauses = Math.max(pauses, v.live.pauses);
      }
      const done = (v.live?.cursor ?? v.cursor ?? 0) >= last;
      if (done) break;
      const handled = v.live?.cursor != null ? Math.round((v.live.cursor - baseUs) / 10) + 1 : 0;
      // A third of the way: the relay drops the connection (as one does to a slow consumer); the consumer reconnects
      // from the last message it took. Two thirds: a stop and a start, which resume from the stored cursor.
      if (!dropped && handled >= total / 3) {
        dropped = true;
        connections.at(-1)?.ws.terminate();
      }
      if (restarted === null && connections.length >= 2 && handled >= (2 * total) / 3) restarted = (await app.call<{ stored: number | null }>({ cmd: 'firehose.restart', id })).stored;
      if (performance.now() > deadline) break;
      await sleep(50);
    }
    const doneAt = performance.now();
    const final = await app.call<View>({ cmd: 'firehose.view', id });
    await app.call({ cmd: 'firehose.stop', id });
    const c = await app.call<{ objects: number; checks: number; most: number }>({ cmd: 'firehose.checks' });
    const seconds = firstConnect === null ? 0 : (doneAt - firstConnect) / 1000;
    const result = {
      posts: total,
      queueMax,
      sentIncludingReplays: sent,
      connections: connections.length,
      resumedWithCursor: connections.slice(1).every((x) => x.cursor !== null),
      restartStoredCursor: restarted,
      maxQueue,
      pauses,
      producerMaxBufferedBytes: maxBuffered,
      checked: c.objects,
      lost: total - c.objects,
      duplicates: c.checks - c.objects,
      seconds,
      postsPerSecond: seconds ? c.objects / seconds : 0,
      status: final.status,
      lastError: final.lastError ?? lastView?.lastError ?? null
    };
    check('firehose', 'posts-per-s', result.postsPerSecond, 'min');
    check('firehose', 'lost', result.lost, 'max');
    check('firehose', 'duplicates', result.duplicates, 'max');
    // Pausing stops reading the socket; the messages of the read already under way still arrive (one read is at most
    // 64 KiB, about 200 of these posts), so the bound is FIREHOSE_QUEUE_MAX plus one read.
    check('firehose', 'queue-over-max', Math.max(0, maxQueue - queueMax), 'max');
    out('Firehose ingest (Jetstream, every post through the moderation check)');
    out(`  ${total} posts pushed as fast as the socket takes them; FIREHOSE_QUEUE_MAX ${queueMax}`);
    out(`  checked ${c.objects}/${total} (lost ${result.lost}, duplicates ${result.duplicates}) in ${seconds.toFixed(1)} s, ${result.postsPerSecond.toFixed(1)} posts/s`);
    out(`  queue max ${maxQueue}, socket paused ${pauses} time(s), producer send buffer max ${(maxBuffered / 1024).toFixed(0)} KiB`);
    out(`  ${connections.length} connections; every reconnection resumed from a cursor: ${result.resumedWithCursor ? 'yes' : 'no'}; restart resumed from stored cursor ${restarted ?? '-'}`);
    out();
    return result;
  } finally {
    for (const c of connections) c.ws.terminate();
    await new Promise((r) => wss.close(r));
  }
}

/* ------------------------------------------------------------------ main */

async function main(): Promise<number> {
  if (opt.help) {
    out(USAGE);
    return 0;
  }
  const wanted = String(opt.scenarios)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  for (const w of wanted) if (!(SCENARIOS as readonly string[]).includes(w)) throw new Error(`unknown scenario ${w}`);
  if (!TARGETS[String(opt.targets)]) throw new Error(`--targets is reference or ci`);
  const extra: Record<string, string> = {
    WEBHOOK_TIMEOUT_MS: String(num(opt['webhook-timeout-ms'], 'webhook-timeout-ms')),
    WEBHOOK_RETRY_BASE_MS: '1000',
    WEBHOOK_BREAKER_COOLDOWN_MS: String(DURATION_MS * 4),
    FIREHOSE_TICK_MS: '1000',
    FIREHOSE_CHECKPOINT_MS: '1000',
    FIREHOSE_BACKOFF_MAX_MS: '1000',
    FIREHOSE_QUEUE_MAX: String(Math.floor(num(opt['queue-max'], 'queue-max'))),
    ...(opt['job-concurrency'] ? { JOB_CONCURRENCY: String(num(opt['job-concurrency'], 'job-concurrency')) } : {}),
    ...(opt['job-poll-ms'] ? { JOB_POLL_MS: String(num(opt['job-poll-ms'], 'job-poll-ms')) } : {})
  };

  let app: App;
  const t0 = performance.now();
  try {
    app = await startApp(extra);
  } catch (err) {
    process.stderr.write(`setup failed: ${(err as Error).message}\n`);
    return 2;
  }
  out(`Application on ${app.seed.url} (${app.seed.db}), seeded in ${((performance.now() - t0) / 1000).toFixed(1)} s.`);
  out();
  const results: Record<string, unknown> = {};
  try {
    const run: Record<Scenario, (a: App) => Promise<Record<string, unknown>>> = { webhooks, records, ocsp, firehose };
    for (const sc of SCENARIOS) if (wanted.includes(sc)) results[sc] = await run[sc](app);
  } finally {
    await app.close();
  }
  const failed = checks.filter((c) => !c.ok);
  if (opt.json) process.stdout.write(JSON.stringify({ db: app.seed.db, durationSeconds: DURATION_MS / 1000, results, checks }, null, 2) + '\n');
  else {
    out(`Targets (${String(opt.targets)}):`);
    for (const c of checks) out(`  ${c.ok ? 'met ' : 'MISS'}  ${`${c.scenario}.${c.name}`.padEnd(34)} ${c.value === null ? '-' : Number(c.value.toFixed(1))} ${c.dir === 'max' ? '<=' : '>='} ${c.target}`);
    out(failed.length ? `${failed.length} target(s) missed.` : 'All targets met.');
  }
  return failed.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err: Error) => {
    process.stderr.write(`load test failed: ${err.stack ?? err.message}\n`);
    process.exit(2);
  }
);
