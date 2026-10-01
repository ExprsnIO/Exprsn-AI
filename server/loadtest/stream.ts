/**
 * Load test of the chat streaming path: POST /api/chat, then chat.status / chat.chunk / chat.done over Socket.io.
 *
 * Two modes (see docs/loadtest.md):
 *
 *   In-process (default): builds the server on in-memory SQLite (as server/test/helpers.ts does), starts the fake
 *   Ollama from server/test/fake-ollama.ts, seeds a pool, a model and a published profile, creates the users and runs
 *   the load against that. No external services are needed.
 *
 *     npx tsx server/loadtest/stream.ts --users 50 --messages 5
 *
 *   Against a running stack: signs in the given accounts over HTTP and drives the named profile. Use `--fake-ollama`
 *   to start only the fake Ollama and register its URL as a pool instance in the console first.
 *
 *     npx tsx server/loadtest/stream.ts --fake-ollama 11500 --delay-ms 20
 *     LOADTEST_USERS='jlee:pw,apatel:pw' npx tsx server/loadtest/stream.ts --url http://localhost:8080 --profile general
 *
 * Exit codes: 0 when every threshold holds, 1 when a threshold is exceeded, 2 on a setup failure.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { authenticator } from 'otplib';
import { io as ioClient, type Socket } from 'socket.io-client';

/* ------------------------------------------------------------------ options */

const { values: opt } = parseArgs({
  options: {
    url: { type: 'string' },
    users: { type: 'string', default: '20' },
    messages: { type: 'string', default: '5' },
    'think-ms': { type: 'string', default: '0' },
    'ramp-ms': { type: 'string', default: '2000' },
    profile: { type: 'string', default: 'general' },
    prompt: { type: 'string', default: 'Summarise the attached incident report in three sentences.' },
    tenant: { type: 'string' },
    timeout: { type: 'string', default: '120000' },
    // in-process and fake-Ollama tuning
    'reply-words': { type: 'string', default: '64' },
    'delay-ms': { type: 'string', default: '10' },
    parallel: { type: 'string', default: '8' },
    instances: { type: 'string', default: '1' },
    'fake-ollama': { type: 'string' },
    'guard-model': { type: 'boolean', default: false },
    holdback: { type: 'string' },
    'sentence-words': { type: 'string', default: '0' },
    // thresholds
    'max-error-rate': { type: 'string', default: '0.01' },
    'max-p95-ttft-ms': { type: 'string' },
    'max-p99-ttft-ms': { type: 'string' },
    'max-p95-total-ms': { type: 'string' },
    'min-tokens-per-s': { type: 'string' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false }
  }
});

const USAGE = `Usage: npx tsx server/loadtest/stream.ts [options]

  --url <http://host:port>   Target a running server (default: build one in-process on SQLite and the fake Ollama)
  --users <n>                Concurrent users, each with its own session and socket (default 20)
  --messages <n>             Messages each user sends, one after another (default 5)
  --think-ms <ms>            Pause between a user's messages (default 0)
  --ramp-ms <ms>             Spread user start times over this window (default 2000)
  --profile <name>           Chat profile to use (default general)
  --prompt <text>            Message text
  --tenant <slug>            Tenant to sign in to (default: the server's DEFAULT_TENANT)
  --timeout <ms>             Give up on one answer after this long (default 120000)

  In-process and fake Ollama:
  --reply-words <n>          Words (tokens) in each fake answer (default 64)
  --delay-ms <ms>            Delay between streamed tokens (default 10)
  --parallel <n>             Parallel requests per fake instance (default 8)
  --instances <n>            Fake Ollama instances in the pool (default 1)
  --fake-ollama <port>       Only start a fake Ollama on this port (for a pool instance in a running stack) and wait
  --sentence-words <n>       End a sentence every n words of the fake answer (default 0: no sentence ends)
  --guard-model              Also publish a guard-model rule at model-output, so answers are screened while they
                             stream (Sprint 16); the fake guard model answers "safe"
  --holdback <n>             CHAT_GUARD_HOLDBACK_SENTENCES for the in-process server

  Thresholds (exit 1 when exceeded):
  --max-error-rate <0..1>    default 0.01
  --max-p95-ttft-ms <ms>, --max-p99-ttft-ms <ms>, --max-p95-total-ms <ms>, --min-tokens-per-s <n>

  --json                     Print the summary as JSON

  With --url, accounts come from LOADTEST_USERS as a comma-separated list of user:password[:totp-secret]. The list is
  reused round-robin when --users is larger. Accounts need the chat permission on the profile.
`;

const num = (v: string | undefined, name: string): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a non-negative number`);
  return n;
};
const optNum = (v: string | undefined, name: string): number | null => (v === undefined ? null : num(v, name));

/* ------------------------------------------------------------------ fake Ollama */

const WORDS = 'the gateway leases a slot on an instance streams tokens back and meters the answer when it ends'.split(' ');
const replyText = (n: number) => {
  const every = num(opt['sentence-words'], 'sentence-words');
  return Array.from({ length: n }, (_, i) => WORDS[i % WORDS.length] + (every && (i + 1) % every === 0 ? '.' : '')).join(' ');
};

async function startFakeOllama(port = 0) {
  const { FakeOllama } = await import('../test/fake-ollama.js');
  const f = new FakeOllama();
  f.chatDelayMs = num(opt['delay-ms'], 'delay-ms');
  const words = num(opt['reply-words'], 'reply-words');
  f.reply = () => ({ content: replyText(words) });
  const model = { name: 'llama3.1:8b', size: 5_000_000_000, capabilities: ['completion', 'tools'] };
  f.addAvailable(model);
  // Also in the fake registry, so a pull started from the console succeeds.
  f.registry.set(model.name, model);
  // The request log grows without bound under load; keep only the last few entries.
  const push = f.requests.push.bind(f.requests);
  f.requests.push = (...items) => {
    if (f.requests.length > 100) f.requests.splice(0, f.requests.length - 100);
    return push(...items);
  };
  if (port) {
    await new Promise<void>((r) => f.server.listen(port, '0.0.0.0', r));
    f.url = `http://127.0.0.1:${(f.server.address() as AddressInfo).port}`;
    return f;
  }
  return f.start();
}

/* ------------------------------------------------------------------ in-process target */

interface Target {
  url: string;
  accounts: { username: string; password: string; totp?: string; forwardedFor?: string }[];
  close(): Promise<void>;
}

async function inProcessTarget(users: number): Promise<Target> {
  const { harness, localUser, PASSWORD } = await import('../test/helpers.js');
  const { attachRealtime } = await import('../src/realtime/socket.js');
  const h = await harness({ OLLAMA_POLL_MS: '600000', OLLAMA_QUEUE_TIMEOUT_MS: String(num(opt.timeout, 'timeout')), ...(opt.holdback != null ? { CHAT_GUARD_HOLDBACK_SENTENCES: String(num(opt.holdback, 'holdback')) } : {}) });
  const fakes: Awaited<ReturnType<typeof startFakeOllama>>[] = [];
  for (let i = 0; i < Math.max(1, num(opt.instances, 'instances')); i++) fakes.push(await startFakeOllama());

  const repo = h.s.gateway.repo;
  const pool = await repo.createPool({ name: 'loadtest', accelerator: 'cuda', zone: 'inference', labelCeiling: 'confidential' });
  for (const [i, f] of fakes.entries()) {
    await repo.createInstance({ poolId: pool.id, name: `fake-${i + 1}`, url: f.url, deploy: 'docker', settings: { parallel: num(opt.parallel, 'parallel') } });
  }
  const model = await repo.createModel({ name: 'llama3.1:8b', source: 'Ollama library', expectedDigest: null, license: { name: 'test' }, label: 'confidential', notes: null, requestedBy: 'loadtest', requestedTenant: h.tenantId });
  await repo.updateModel(model.id, { state: 'approved', import_state: 'pulled', capabilities: ['completion'], size_bytes: 5_000_000_000 });
  await repo.place(model.id, pool.id, 'warm', 'loadtest');
  const t = Date.now();
  await repo.createProfile({ id: 'LOADTEST000000000000000000', tenant_id: h.tenantId, name: String(opt.profile), display_name: 'Load test', description: null, alias_of: null, model_id: model.id, pool_id: pool.id, num_ctx: 8192, temperature: 0.2, think_default: 'off', think_ceiling: 'off', system_prompt: 'Be brief.', fallback: null, canary: null, tools: [], label: 'internal', status: 'published', version: 1, updated_by: null, created_at: t, updated_at: t });
  if (opt['guard-model']) {
    // Sprint 16: a guard model on the same pool, and a published tenant rule that uses it at model-output.
    for (const f of fakes) f.addAvailable({ name: 'llama-guard3:8b', size: 5_000_000_000, capabilities: ['completion'] });
    const guard = await repo.createModel({ name: 'llama-guard3:8b', source: 'Ollama library', expectedDigest: null, license: { name: 'test' }, label: 'confidential', notes: null, requestedBy: 'loadtest', requestedTenant: h.tenantId });
    await repo.updateModel(guard.id, { state: 'approved', import_state: 'pulled', capabilities: ['completion'], size_bytes: 5_000_000_000 });
    await repo.place(guard.id, pool.id, 'warm', 'loadtest');
    await repo.createProfile({ id: 'LOADTESTGUARD0000000000000', tenant_id: h.tenantId, name: 'llama-guard', display_name: 'Guard', description: null, alias_of: null, model_id: guard.id, pool_id: pool.id, num_ctx: 8192, temperature: 0, think_default: 'off', think_ceiling: 'off', system_prompt: null, fallback: null, canary: null, tools: [], label: 'confidential', status: 'published', version: 1, updated_by: null, created_at: t, updated_at: t });
    const set = await h.s.guard.sets.create(h.tenantId, { name: 'Load test guard', scope: 'tenant' }, 'loadtest');
    await h.s.guard.sets.saveDraft(set, [{ id: 'safety', name: 'Safety', checkpoint: 'model-output', type: 'guard model', mechanism: { kind: 'guard-model', profile: 'llama-guard' }, action: 'block', stage: 'enforce' }], 'loadtest');
    await h.s.guard.sets.publish(set, 'loadtest');
  }
  await h.s.gateway.pollAll();

  const accounts: Target['accounts'] = [];
  for (let i = 0; i < users; i++) {
    const username = `load${String(i + 1).padStart(4, '0')}`;
    await localUser(h, username, ['member']);
    // The sign-in limiter allows 30 attempts a minute per address. In-process the proxy is trusted on loopback, so
    // each simulated user signs in from its own documentation address instead of queueing behind the limiter.
    accounts.push({ username, password: PASSWORD, forwardedFor: `198.18.${Math.floor(i / 250)}.${(i % 250) + 1}` });
  }

  const server: Server = createServer(h.app);
  const rt = attachRealtime(server, h.s);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    accounts,
    close: async () => {
      await rt.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await h.close();
      for (const f of fakes) await f.stop();
    }
  };
}

function remoteTarget(url: string, users: number): Target {
  const list = (process.env.LOADTEST_USERS ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const [username, password, totp] = x.split(':');
      if (!username || !password) throw new Error('LOADTEST_USERS entries are user:password[:totp-secret]');
      return { username, password, ...(totp ? { totp } : {}) };
    });
  if (!list.length) throw new Error('--url needs LOADTEST_USERS=user:password[:totp-secret],...');
  return { url: url.replace(/\/$/, ''), accounts: Array.from({ length: users }, (_, i) => list[i % list.length]!), close: async () => undefined };
}

/* ------------------------------------------------------------------ client */

interface Session {
  cookie: string;
  csrf: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mergeCookies = (prev: string, res: Response) => {
  const jar = new Map(prev ? prev.split('; ').map((c) => [c.split('=')[0]!, c] as const) : []);
  for (const c of res.headers.getSetCookie()) jar.set(c.split('=')[0]!, c.split(';')[0]!);
  return [...jar.values()].join('; ');
};

async function post(url: string, path: string, body: unknown, s: Session | null, extra: Record<string, string> = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(s ? { cookie: s.cookie, 'x-csrf-token': s.csrf } : {}), ...extra },
      body: JSON.stringify(body)
    });
    // Honour Retry-After on 429 during sign-in (the per-address limiter) a few times before giving up.
    if (res.status === 429 && path.startsWith('/api/auth/') && attempt < 5) {
      await sleep(Number(res.headers.get('retry-after') ?? '5') * 1000);
      continue;
    }
    return res;
  }
}

async function signIn(url: string, a: Target['accounts'][number], tenant: string | undefined): Promise<Session> {
  const extra: Record<string, string> = a.forwardedFor ? { 'x-forwarded-for': a.forwardedFor } : {};
  const res = await post(url, '/api/auth/login', { username: a.username, password: a.password, ...(tenant ? { tenant } : {}) }, null, extra);
  const body = (await res.json().catch(() => ({}))) as { stage?: string; csrf?: string; detail?: string };
  if (!res.ok) throw new Error(`sign-in ${a.username}: ${res.status} ${body.detail ?? ''}`);
  let s: Session = { cookie: mergeCookies('', res), csrf: String(body.csrf) };
  if (body.stage === 'mfa') {
    if (!a.totp) throw new Error(`sign-in ${a.username}: a second factor is required; add :<totp-secret> in LOADTEST_USERS`);
    const r2 = await post(url, '/api/auth/mfa/totp', { code: authenticator.generate(a.totp) }, s, extra);
    const b2 = (await r2.json().catch(() => ({}))) as { stage?: string; csrf?: string; detail?: string };
    if (!r2.ok) throw new Error(`second factor ${a.username}: ${r2.status} ${b2.detail ?? ''}`);
    s = { cookie: mergeCookies(s.cookie, r2), csrf: String(b2.csrf) };
    body.stage = b2.stage;
  }
  if (body.stage !== 'active') throw new Error(`sign-in ${a.username}: stage ${body.stage} (enrol a second factor first)`);
  return s;
}

function connect(url: string, s: Session): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = ioClient(url, { path: '/socket.io', transports: ['websocket'], reconnection: false, extraHeaders: { cookie: s.cookie } });
    const timer = setTimeout(() => reject(new Error('socket did not become ready in 10 s')), 10_000);
    sock.once('ready', () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/* ------------------------------------------------------------------ measurement */

interface Sample {
  accept: number; // POST /api/chat round trip
  ttft: number | null; // POST sent to first chat.chunk
  total: number | null; // POST sent to chat.done
  tokens: number;
  tokensPerS: number | null; // output tokens over first chunk to done
  queued: boolean;
  error: string | null;
}

interface Pending {
  sent: number;
  first: number | null;
  onDone: (d: { state: string; usage?: { outputTokens?: number } | null; error?: unknown; seq?: number }) => void;
}

async function runUser(url: string, s: Session, sock: Socket, n: number, samples: Sample[], tenantOpts: { profile: string; prompt: string; thinkMs: number; timeout: number }) {
  // Chunks can arrive before the POST answers, so events are keyed by message id and buffered until it is known.
  const pending = new Map<string, Pending>();
  const early = new Map<string, { first: number | null; done: Parameters<Pending['onDone']>[0] | null; queued: boolean }>();
  const queuedIds = new Set<string>();
  const noteEarly = (id: string) => early.get(id) ?? (early.set(id, { first: null, done: null, queued: false }), early.get(id)!);
  sock.on('chat.status', (d: { messageId: string; state: string }) => {
    if (d.state === 'queued' && (d as { position?: number }).position !== undefined) {
      queuedIds.add(d.messageId);
      if (!pending.has(d.messageId)) noteEarly(d.messageId).queued = true;
    }
  });
  sock.on('chat.chunk', (d: { messageId: string }) => {
    const now = performance.now();
    const p = pending.get(d.messageId);
    if (p) p.first ??= now;
    else noteEarly(d.messageId).first ??= now;
  });
  sock.on('chat.done', (d: { messageId: string } & Parameters<Pending['onDone']>[0]) => {
    const p = pending.get(d.messageId);
    if (p) p.onDone(d);
    else noteEarly(d.messageId).done = d;
  });

  for (let i = 0; i < n; i++) {
    const sent = performance.now();
    let res: Response;
    try {
      res = await post(url, '/api/chat', { content: `${tenantOpts.prompt} (#${i + 1})`, profile: tenantOpts.profile }, s);
    } catch (err) {
      samples.push({ accept: performance.now() - sent, ttft: null, total: null, tokens: 0, tokensPerS: null, queued: false, error: `request: ${(err as Error).message}` });
      continue;
    }
    const accept = performance.now() - sent;
    const body = (await res.json().catch(() => ({}))) as { messageId?: string; detail?: string };
    if (res.status !== 202 || !body.messageId) {
      samples.push({ accept, ttft: null, total: null, tokens: 0, tokensPerS: null, queued: false, error: `HTTP ${res.status}${body.detail ? `: ${body.detail}` : ''}` });
      continue;
    }
    const id = body.messageId;
    const sample = await new Promise<Sample>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ accept, ttft: null, total: null, tokens: 0, tokensPerS: null, queued: queuedIds.has(id), error: 'timeout' });
      }, tenantOpts.timeout);
      const finish: Pending['onDone'] = (d) => {
        clearTimeout(timer);
        const p = pending.get(id)!;
        pending.delete(id);
        const end = performance.now();
        const tokens = d.usage?.outputTokens ?? 0;
        const streamS = p.first !== null ? (end - p.first) / 1000 : 0;
        resolve({
          accept,
          ttft: p.first !== null ? p.first - sent : null,
          total: end - sent,
          tokens,
          tokensPerS: streamS > 0 && tokens > 1 ? (tokens - 1) / streamS : null,
          queued: queuedIds.has(id),
          error: d.state === 'complete' ? null : `state ${d.state}${d.error ? `: ${typeof d.error === 'string' ? d.error : JSON.stringify(d.error)}` : ''}`
        });
      };
      const p: Pending = { sent, first: null, onDone: finish };
      pending.set(id, p);
      const e = early.get(id);
      if (e) {
        early.delete(id);
        p.first = e.first;
        if (e.done) finish(e.done);
      }
    });
    queuedIds.delete(id);
    samples.push(sample);
    if (tenantOpts.thinkMs) await sleep(tenantOpts.thinkMs);
  }
}

function pct(values: number[], p: number): number | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))]!;
}

function stats(values: number[]) {
  return { n: values.length, p50: pct(values, 50), p95: pct(values, 95), p99: pct(values, 99), max: values.length ? Math.max(...values) : null, mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null };
}

/* ------------------------------------------------------------------ main */

const out = (line = '') => process.stdout.write(line + '\n');

async function main(): Promise<number> {
  if (opt.help) {
    out(USAGE);
    return 0;
  }
  if (opt['fake-ollama'] !== undefined) {
    const f = await startFakeOllama(num(opt['fake-ollama'], 'fake-ollama'));
    out(`Fake Ollama listening on ${f.url} (model llama3.1:8b, ${opt['reply-words']} words per answer, ${opt['delay-ms']} ms per token).`);
    out('Register it as an instance of a pool, approve and place llama3.1:8b, and publish a profile on it. Ctrl C stops it.');
    await new Promise<void>((resolve) => process.once('SIGINT', () => resolve()));
    await f.stop();
    return 0;
  }

  const users = Math.max(1, Math.floor(num(opt.users, 'users')));
  const messages = Math.max(1, Math.floor(num(opt.messages, 'messages')));
  const rampMs = num(opt['ramp-ms'], 'ramp-ms');
  const run = { profile: String(opt.profile), prompt: String(opt.prompt), thinkMs: num(opt['think-ms'], 'think-ms'), timeout: num(opt.timeout, 'timeout') };

  let target: Target;
  try {
    target = opt.url ? remoteTarget(opt.url, users) : await inProcessTarget(users);
  } catch (err) {
    process.stderr.write(`setup failed: ${(err as Error).message}\n`);
    return 2;
  }

  const sockets: Socket[] = [];
  const samples: Sample[] = [];
  let setupErrors = 0;
  let wall: number;
  try {
    // Sign in and connect every user first, so the measured window is only the streaming load.
    const sessions: { s: Session; sock: Socket }[] = [];
    const t0 = performance.now();
    for (const a of target.accounts) {
      try {
        const s = await signIn(target.url, a, opt.tenant);
        const sock = await connect(target.url, s);
        sockets.push(sock);
        sessions.push({ s, sock });
      } catch (err) {
        setupErrors++;
        process.stderr.write(`${(err as Error).message}\n`);
      }
    }
    if (!opt.json) out(`Signed in and connected ${sessions.length} of ${target.accounts.length} users in ${((performance.now() - t0) / 1000).toFixed(1)} s against ${target.url}.`);
    if (!sessions.length) return 2;

    const started = performance.now();
    await Promise.all(
      sessions.map(async ({ s, sock }, i) => {
        await sleep((rampMs * i) / sessions.length);
        await runUser(target.url, s, sock, messages, samples, run);
      })
    );
    wall = (performance.now() - started) / 1000;
  } finally {
    for (const sock of sockets) sock.close();
    await target.close();
  }

  const ok = samples.filter((x) => !x.error);
  const errors = samples.length - ok.length;
  const errorRate = samples.length ? errors / samples.length : 1;
  const tokens = ok.reduce((a, x) => a + x.tokens, 0);
  const byError = new Map<string, number>();
  for (const x of samples) if (x.error) byError.set(x.error, (byError.get(x.error) ?? 0) + 1);
  const summary = {
    target: opt.url ?? 'in-process',
    users: sockets.length,
    setupErrors,
    messages: samples.length,
    completed: ok.length,
    errors,
    errorRate,
    queued: samples.filter((x) => x.queued).length,
    wallSeconds: wall,
    answersPerSecond: wall ? ok.length / wall : 0,
    tokensPerSecond: wall ? tokens / wall : 0,
    acceptMs: stats(samples.map((x) => x.accept)),
    ttftMs: stats(ok.flatMap((x) => (x.ttft === null ? [] : [x.ttft]))),
    totalMs: stats(ok.flatMap((x) => (x.total === null ? [] : [x.total]))),
    streamTokensPerSecond: stats(ok.flatMap((x) => (x.tokensPerS === null ? [] : [x.tokensPerS]))),
    errorKinds: Object.fromEntries(byError)
  };

  const failures: string[] = [];
  const check = (label: string, value: number | null, limit: number | null, dir: 'max' | 'min') => {
    if (limit === null) return;
    if (value === null || (dir === 'max' ? value > limit : value < limit)) failures.push(`${label} ${value === null ? 'n/a' : value.toFixed(2)} ${dir === 'max' ? '>' : '<'} ${limit}`);
  };
  check('error rate', errorRate, optNum(opt['max-error-rate'], 'max-error-rate'), 'max');
  check('p95 time to first token (ms)', summary.ttftMs.p95, optNum(opt['max-p95-ttft-ms'], 'max-p95-ttft-ms'), 'max');
  check('p99 time to first token (ms)', summary.ttftMs.p99, optNum(opt['max-p99-ttft-ms'], 'max-p99-ttft-ms'), 'max');
  check('p95 answer time (ms)', summary.totalMs.p95, optNum(opt['max-p95-total-ms'], 'max-p95-total-ms'), 'max');
  check('p50 stream tokens/s', summary.streamTokensPerSecond.p50, optNum(opt['min-tokens-per-s'], 'min-tokens-per-s'), 'min');

  if (opt.json) {
    out(JSON.stringify({ ...summary, failures }, null, 2));
  } else {
    const f = (v: number | null) => (v === null ? '-' : v.toFixed(1).padStart(9));
    const row = (label: string, st: ReturnType<typeof stats>) => out(`  ${label.padEnd(26)}${f(st.p50)}${f(st.p95)}${f(st.p99)}${f(st.max)}`);
    out();
    out(`Messages ${summary.messages}, completed ${summary.completed}, errors ${errors} (${(errorRate * 100).toFixed(2)} %), queued for a slot ${summary.queued}`);
    out(`Wall time ${wall.toFixed(1)} s, ${summary.answersPerSecond.toFixed(2)} answers/s, ${summary.tokensPerSecond.toFixed(1)} tokens/s aggregate`);
    out();
    out(`  ${''.padEnd(26)}${'p50'.padStart(9)}${'p95'.padStart(9)}${'p99'.padStart(9)}${'max'.padStart(9)}`);
    row('POST /api/chat (ms)', summary.acceptMs);
    row('time to first token (ms)', summary.ttftMs);
    row('answer complete (ms)', summary.totalMs);
    row('stream tokens/s', summary.streamTokensPerSecond);
    if (byError.size) {
      out();
      out('Errors:');
      for (const [k, v] of byError) out(`  ${String(v).padStart(5)}  ${k}`);
    }
    out();
    out(failures.length ? `Thresholds exceeded:\n  ${failures.join('\n  ')}` : 'All thresholds hold.');
  }
  return failures.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err: Error) => {
    process.stderr.write(`load test failed: ${err.stack ?? err.message}\n`);
    process.exit(2);
  }
);
