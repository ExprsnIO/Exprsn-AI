/**
 * The server side of the platform load test (B-2105, `platform.ts`): the application as `src/index.ts` starts it
 * (configuration from the environment, migrations, bootstrap, the HTTP app, the job workers and the schedules),
 * in a process of its own so the load generator does not share its event loop. It seeds what the scenarios need
 * and answers the driver's control and inspection requests over the IPC channel `child_process.fork` opens.
 *
 * It is not meant to be started by hand: `platform.ts` forks it with the environment of the run.
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { loadConfig } from '../src/config/index.js';
import { createDb, migrate } from '../src/db/knex.js';
import { createApp, type AppState } from '../src/http/app.js';
import { createLogger } from '../src/observability/index.js';
import { createServices, startSchedules, type Services } from '../src/services.js';
import { bootstrap } from '../src/bootstrap.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { hashPassword } from '../src/identity/passwords.js';
import { buildCsr, toPem } from '../src/ops/der.js';
import type { PkiActor } from '../src/pki/service.js';
import type { Label } from '../src/authz/labels.js';

const PASSWORD = 'load test password, not a secret';
const POST_TYPE = 'atproto-post';

export interface Seed {
  url: string;
  tenantId: string;
  workspaceId: string;
  password: string;
  users: string[];
  app: string;
  entity: string;
  issuerPem: string;
  serials: string[];
  revoked: string[];
  db: string;
}

export type Command =
  | { cmd: 'webhooks.setup'; urls: string[]; events: string[] }
  | { cmd: 'webhooks.emit'; count: number; spreadMs: number }
  | { cmd: 'webhooks.stats' }
  | { cmd: 'webhooks.disable' }
  | { cmd: 'firehose.setup'; endpoint: string }
  | { cmd: 'firehose.view'; id: string }
  | { cmd: 'firehose.restart'; id: string }
  | { cmd: 'firehose.checks' }
  | { cmd: 'firehose.stop'; id: string }
  | { cmd: 'records.count' }
  | { cmd: 'loop' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function localUser(s: Services, tenantId: string, username: string, roles: string[], clearance: Label) {
  const local = (await s.providers.list(tenantId)).find((p) => p.kind === 'local')!;
  const user = await s.users.create(tenantId, { username, displayName: username.toUpperCase(), clearance });
  await s.users.update(tenantId, user.id, { clearance_direct: clearance });
  await s.db('local_credentials').insert({ user_id: user.id, password_hash: await hashPassword(PASSWORD), updated_at: Date.now() });
  await s.users.upsertIdentity(user.id, local.id, user.id, []);
  await s.users.setRoles(user.id, 'direct', roles);
  return user;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger(cfg.LOG_LEVEL, false);
  const db = createDb(cfg);
  await migrate(db);
  const s = createServices(cfg, db, log);
  await bootstrap(s);
  const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
  const tenantId = tenant.id;

  /* ---------------------------------------------------------------- seed */

  const ws = await s.tenants.createWorkspace(tenantId, 'Load test', 'confidential');
  const users: string[] = [];
  const nUsers = Number(process.env.LOADTEST_USERS_N ?? '32');
  for (let i = 0; i < nUsers; i++) {
    const name = `load${String(i + 1).padStart(4, '0')}`;
    const u = await localUser(s, tenantId, name, ['member'], 'internal');
    await s.tenants.addMember(ws.id, u.id);
    users.push(name);
  }
  const designer = await localUser(s, tenantId, 'loaddesigner', ['workflow-admin', 'tenant-admin', 'guardrail-admin', 'member'], 'confidential');
  await s.tenants.addMember(ws.id, designer.id);
  const principal = (await loadPrincipal(s, tenantId, designer.id, {}))!;
  principal.workspaceId = ws.id;
  const actor = { principal, source: 'api' as const, ip: '127.0.0.1' };

  // Low-code app (B-2201): indexed and unique fields, the shape the records scenario writes and queries.
  const appRow = await s.apps.create(actor, { name: 'loadtest', title: 'Load test', label: 'confidential', workspaceId: ws.id });
  await s.apps.createEntity(actor, 'loadtest', {
    name: 'ticket',
    title: 'Ticket',
    label: 'internal',
    definition: {
      fields: [
        { name: 'title', type: 'string', required: true, indexed: true, unique: true, maxLength: 120 },
        { name: 'amount', type: 'number', indexed: true, min: 0 },
        { name: 'due', type: 'date', indexed: true },
        { name: 'stage', type: 'enum', indexed: true, options: [{ value: 'Lead' }, { value: 'Open' }, { value: 'Won' }, { value: 'Lost' }] },
        { name: 'notes', type: 'string', multiline: true, maxLength: 5000 }
      ]
    } as never
  });

  // Certificate authority (B-1601 to B-1604): a root, the tenant's intermediate, a profile and some leaves.
  const by: PkiActor = { tenantId, userId: null, actor: { service: 'loadtest' } };
  await s.pki.createRoot(by, { commonName: 'Load Test Root', keyType: 'ecdsa-p256', days: 3650 });
  const inter = await s.pki.createIntermediate(by, tenantId, { keyType: 'ecdsa-p256', days: 365 });
  const profile = await s.pki.createProfile(by, { name: 'load', kind: 'server', maxDays: 30, defaultDays: 30, policy: { domains: ['*.load.test'], allowWildcard: false, ipRanges: [], emailDomains: [], uriPrefixes: [], keyTypes: ['ec-p256'] } });
  const serials: string[] = [];
  const revoked: string[] = [];
  const nCerts = Number(process.env.LOADTEST_CERTS_N ?? '40');
  for (let i = 0; i < nCerts; i++) {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const issued = await s.pki.issue(by, inter, { csrPem: toPem(buildCsr([`h${i}.load.test`], privateKey), 'CERTIFICATE REQUEST'), profileId: profile.id });
    if (i % 10 === 9) {
      await s.pki.revoke(by, issued.cert, 1, null);
      revoked.push(issued.cert.serial);
    } else serials.push(issued.cert.serial);
  }

  // Moderation for the firehose (B-1901, B-1908): a tenant rule set that flags a pattern, and the tenant's labeler.
  const set = await s.guard.sets.create(tenantId, { name: 'Load test moderation', scope: 'tenant' }, 'loadtest');
  await s.guard.sets.saveDraft(set, [{ id: 'spam-link', name: 'Spam links', checkpoint: 'user-input', type: 'pattern', mechanism: { kind: 'pattern', pattern: 'SPAMLINK' }, action: 'flag', stage: 'enforce', severity: 'medium' }] as never, 'loadtest');
  await s.guard.sets.publish(set, 'loadtest');
  if (cfg.ATPROTO_PUBLIC_URL) await s.atproto.createIdentity({ tenantId, userId: designer.id, actor: { user: designer.id, username: 'loaddesigner' } }, tenantId, { method: 'web' });

  /* ---------------------------------------------------------------- serve, as index.ts does */

  const state: AppState = { shuttingDown: false };
  const app = createApp(s, state);
  const server = createServer(app);
  server.keepAliveTimeout = 61_000;
  if (cfg.WORKERS_ENABLED) {
    s.jobs.start();
    startSchedules(s);
  }
  await new Promise<void>((resolve) => server.listen(cfg.PORT, cfg.HOST, resolve));

  /* ---------------------------------------------------------------- control */

  const hooks: { id: string; secret: string; url: string }[] = [];
  const handle = async (m: Command): Promise<unknown> => {
    switch (m.cmd) {
      case 'webhooks.setup': {
        hooks.length = 0;
        for (const [i, url] of m.urls.entries()) {
          const { row, secret } = await s.webhooks.create(tenantId, designer.id, { name: `load-${i + 1}`, url, events: m.events, maxLabel: 'internal' });
          hooks.push({ id: row.id, secret, url });
        }
        return hooks;
      }
      case 'webhooks.emit': {
        // Events as the low-code records emit them (B-2206), spread evenly over spreadMs.
        const gap = m.count > 1 ? m.spreadMs / m.count : 0;
        const t0 = Date.now();
        for (let i = 0; i < m.count; i++) {
          const wait = t0 + i * gap - Date.now();
          if (wait > 0) await sleep(wait);
          void s.webhooks.emit(tenantId, 'record.created', 'internal', `record.created:load-${t0}-${i}`, { app: appRow.id, entity: 'ticket', record: `${appRow.id.slice(0, 16)}${String(i).padStart(10, '0')}`, workspace: ws.id, actor: null });
        }
        return { emitted: m.count };
      }
      case 'webhooks.stats': {
        const rows = (await db('webhooks').where({ tenant_id: tenantId }).select('id', 'name', 'breaker', 'failures', 'opened_at')) as { id: string; name: string; breaker: string; failures: number; opened_at: number | null }[];
        const counts = (await db('webhook_deliveries').where({ tenant_id: tenantId }).groupBy('webhook_id', 'state').select('webhook_id', 'state').count({ n: '*' })) as { webhook_id: string; state: string; n: number | string }[];
        const attempts = (await db('webhook_deliveries').where({ tenant_id: tenantId }).groupBy('webhook_id').select('webhook_id').sum({ a: 'attempts' })) as { webhook_id: string; a: number | string | null }[];
        const opened = Number(((await db('audit_events').where({ tenant_id: tenantId, action: 'webhook.breaker.opened' }).count({ n: '*' }).first()) as { n: number | string }).n);
        const jobs = (await db('jobs').where({ type: 'webhook.deliver' }).groupBy('state').select('state').count({ n: '*' })) as { state: string; n: number | string }[];
        return {
          opened,
          jobs: Object.fromEntries(jobs.map((j) => [j.state, Number(j.n)])),
          hooks: rows.map((r) => ({ ...r, failures: Number(r.failures), states: Object.fromEntries(counts.filter((c) => c.webhook_id === r.id).map((c) => [c.state, Number(c.n)])), attempts: Number(attempts.find((a) => a.webhook_id === r.id)?.a ?? 0) }))
        };
      }
      case 'webhooks.disable': {
        await db('webhooks').where({ tenant_id: tenantId }).update({ state: 'disabled' });
        await db('jobs').where({ type: 'webhook.deliver', state: 'queued' }).update({ state: 'cancelled', finished_at: Date.now() });
        return { disabled: true };
      }
      case 'firehose.setup': {
        const fby = { tenantId, userId: designer.id, actor: { user: designer.id, username: 'loaddesigner' } };
        const row = await s.firehose.create(fby, 'confidential', { name: `load-${Date.now()}`, protocol: 'jetstream', endpoint: m.endpoint, workspaceId: ws.id, start: true });
        await s.firehose.tick();
        return { id: row.id };
      }
      case 'firehose.view': {
        const row = (await s.firehose.get(tenantId, m.id))!;
        return { live: s.firehose.local(m.id), cursor: row.cursor, received: row.received, checked: row.checked, flagged: row.flagged, failed: row.failed, reconnects: row.reconnects, status: row.status, lastError: row.last_error };
      }
      case 'firehose.restart': {
        // A stop and a start (what an admin or a restarted instance does): the consumer stores its cursor and gives
        // its lease back; the next one starts from the stored cursor.
        const fby = { tenantId, userId: designer.id, actor: { user: designer.id, username: 'loaddesigner' } };
        await s.firehose.setState(fby, (await s.firehose.get(tenantId, m.id))!, 'stopped');
        await s.firehose.tick();
        const stored = (await s.firehose.get(tenantId, m.id))!.cursor;
        await s.firehose.setState(fby, (await s.firehose.get(tenantId, m.id))!, 'running');
        await s.firehose.tick();
        return { stored };
      }
      case 'firehose.stop': {
        const fby = { tenantId, userId: designer.id, actor: { user: designer.id, username: 'loaddesigner' } };
        await s.firehose.setState(fby, (await s.firehose.get(tenantId, m.id))!, 'stopped');
        await s.firehose.tick();
        return { stopped: true };
      }
      case 'firehose.checks': {
        const r = (await db('moderation_objects').where({ tenant_id: tenantId, object_type: POST_TYPE }).count({ n: '*' }).sum({ total: 'checks' }).max({ most: 'checks' }).first()) as { n: number | string; total: number | string | null; most: number | string | null };
        return { objects: Number(r.n), checks: Number(r.total ?? 0), most: Number(r.most ?? 0) };
      }
      case 'records.count': {
        const r = (await db('app_records').where({ tenant_id: tenantId }).count({ n: '*' }).first()) as { n: number | string };
        return { records: Number(r.n) };
      }
      case 'loop': {
        // Event-loop responsiveness of the server process: the delay of a zero timer.
        const t = process.hrtime.bigint();
        await new Promise((r) => setImmediate(r));
        return { lagMs: Number(process.hrtime.bigint() - t) / 1e6 };
      }
    }
  };

  const debug = !!process.env.LOADTEST_DEBUG;
  process.on('message', (raw: { rid: number } & Command) => {
    const t = Date.now();
    if (debug) process.stderr.write(`[server] ${raw.cmd} #${raw.rid}\n`);
    handle(raw).finally(() => debug && process.stderr.write(`[server] ${raw.cmd} #${raw.rid} done in ${Date.now() - t} ms\n`)).then(
      (result) => process.send?.({ rid: raw.rid, result }),
      (err: Error) => process.send?.({ rid: raw.rid, error: err.stack ?? err.message })
    );
  });

  const shutdown = async () => {
    state.shuttingDown = true;
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await s.close();
    await db.destroy();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('disconnect', () => void shutdown());

  const seed: Seed = {
    url: `http://127.0.0.1:${cfg.PORT}`,
    tenantId,
    workspaceId: ws.id,
    password: PASSWORD,
    users,
    app: 'loadtest',
    entity: 'ticket',
    issuerPem: inter.certificate_pem,
    serials,
    revoked,
    db: cfg.DB_CLIENT
  };
  process.send?.({ ready: seed, fingerprint: createHash('sha256').update(inter.certificate_pem).digest('hex').slice(0, 16) });
}

main().catch((err: Error) => {
  process.stderr.write(`load-test server failed: ${err.stack ?? err.message}\n`);
  process.exit(2);
});
