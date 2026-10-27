import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parsePg } from 'pg-connection-string';
import { ulid } from 'ulid';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { connectionBudget, MANAGED_MAX_CONNECTIONS, openTarget, redact, WINDOW_KEY, withCaFile, type MoveRecord, type TargetFacts } from '../src/cloud/db-move.js';
import { caPathFor, normaliseCaBundle, postgresUrl } from '../src/cloud/data-tier.js';
import { secretBindings } from '../src/cloud/compute.js';
import type { Deployment } from '../src/cloud/graph.js';
import { deploymentSpecSchema } from '../src/cloud/spec.js';
import type { Db } from '../src/db/knex.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * 1.9.99-final, Sprint 59 (B-10302): moving an install's database (`cloud/db-move.ts`). The source is the test
 * harness's database; the target is a SQLite file standing in for the managed PostgreSQL (the real PostgreSQL run,
 * with TLS against a CA bundle, is `test/integration/cloud-db-move-pg.test.ts`), and the preflight's facts are
 * played where a server's limits or TLS are the point. Covered: the dry run; backup → restore → read-only window →
 * migrate --check → switch; the connection-limit refusal; the CA file used for verify-full TLS; rollback before and
 * after the switch; a crash between steps resumed; dual control and a recent sign-in on the routes.
 */

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let h: Harness;
let tmp: string;
let alice: Client;
let bob: Client;
let aliceId: string;
const OLD_URL = 'sqlite:/var/lib/exprsn-ai/old.sqlite';

const post = (c: Client, p: string, body: object = {}) => c.agent.post(p).set('x-csrf-token', c.csrf).send(body);

function target(name: string): { file: string; url: string } {
  const url = `sqlite:${path.join(tmp, `${name}.sqlite`)}`;
  const file = path.join(tmp, `${name}.url`);
  writeFileSync(file, `${url}\n`, { mode: 0o600 });
  return { file, url };
}

function switchFile(name: string): string {
  const f = path.join(tmp, `${name}-database-url`);
  writeFileSync(f, `${OLD_URL}\n`, { mode: 0o600 });
  return f;
}

/** A CA bundle made with openssl (null when openssl is missing: those checks are skipped, saying so). */
function makeCa(dir: string): string | null {
  try {
    const key = path.join(dir, 'ca.key');
    const crt = path.join(dir, 'ca.pem');
    // A config file, not -addext: macOS ships LibreSSL, whose `req` has no -addext (2026-10-20).
    const cfg = path.join(dir, 'ca.cnf');
    writeFileSync(cfg, '[req]\ndistinguished_name = dn\nprompt = no\n[dn]\nCN = Exprsn move test CA\n[v3_ca]\nbasicConstraints = critical,CA:TRUE\nkeyUsage = critical,keyCertSign,cRLSign\n');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-config', cfg, '-extensions', 'v3_ca'], { stdio: 'ignore' });
    return crt;
  } catch {
    return null;
  }
}

const HAS_OPENSSL = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const moves = () => h.s.cloud.dbMoves;
const count = async (db: Db, table: string) => Number((await db(table).count({ n: '*' }))[0]?.n ?? 0);

beforeAll(async () => {
  h = await harness();
  tmp = mkdtempSync(path.join(tmpdir(), 'exprsn-dbmove-'));
  aliceId = (await localUser(h, 'alice', ['system-admin'], 'restricted')).id;
  await localUser(h, 'bob', ['system-admin'], 'restricted');
  alice = await loginAdmin(h, 'alice');
  bob = await loginAdmin(h, 'bob');
  for (const title of ['Q3 review', 'Launch notes', 'Retro']) await post(alice, '/api/conversations', { title }).expect(201);
  moves().hooks = { settleMs: 0, drainMs: 0, sleep: async () => undefined };
});
afterAll(async () => {
  await h?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});
afterEach(async () => {
  // Every case leaves the install writable and with no open move.
  for (const m of await moves().list(100)) if (['running', 'failed', 'switched', 'approved', 'awaiting_approval'].includes(m.state)) await h.s.db('platform_state').where({ key: `cloud.dbmove:${m.id}` }).delete();
  await h.s.db('platform_state').where({ key: WINDOW_KEY }).delete();
  moves().window.forget();
  moves().hooks = { settleMs: 0, drainMs: 0, sleep: async () => undefined };
  vi.restoreAllMocks();
});

describe('the pure parts (B-10302)', () => {
  it('checks the connection budget: DB_POOL_MAX × instances + headroom against max_connections less the reserved slots', () => {
    expect(connectionBudget({ maxConnections: 100, reserved: 3, poolMax: 10, instances: 3, source: 'live' })).toMatchObject({ required: 35, available: 97, ok: true });
    expect(connectionBudget({ maxConnections: 30, reserved: 3, poolMax: 10, instances: 3, source: 'live' })).toMatchObject({ required: 35, available: 27, ok: false });
    // The managed sizes the presets use, as the providers document them (the live value wins).
    expect(MANAGED_MAX_CONNECTIONS['db.t4g.medium']).toBe(450);
    expect(MANAGED_MAX_CONNECTIONS['db-s-2vcpu-4gb']).toBe(97);
    expect(connectionBudget({ maxConnections: MANAGED_MAX_CONNECTIONS['db-s-1vcpu-1gb']!, reserved: 3, poolMax: 10, instances: 2, source: 'size' }).ok).toBe(false);
  });

  // openssl makes the CA bundle; without it this case is skipped (the integration run uses a real one).
  it.skipIf(!HAS_OPENSSL)('builds verify-full URLs whose sslrootcert names the CA file, and node-postgres reads that file', () => {
    const dir = mkdtempSync(path.join(tmp, 'ca-'));
    const ca = makeCa(dir);
    if (!ca) return; // openssl could not make a CA here; the integration run covers it with a real one
    const url = withCaFile('postgres://exprsn:p%40ss@db.example.internal:5432/exprsn?sslmode=require', ca);
    const u = new URL(url);
    expect(u.searchParams.get('sslmode')).toBe('verify-full');
    expect(u.searchParams.get('sslrootcert')).toBe(ca);
    const cfg = parsePg(url) as unknown as { ssl: { ca: string }; password: string };
    expect(cfg.ssl.ca).toBe(readFileSync(ca, 'utf8'));
    expect(cfg.password).toBe('p@ss');
    // The same for a provisioned deployment's app, by shape.
    expect(postgresUrl({ host: 'db.internal', port: 5432, user: 'exprsn', password: 'pw/+', database: 'postgres', caPath: '/run/secrets/database_ca.pem' })).toBe('postgres://exprsn:pw%2F%2B@db.internal:5432/postgres?sslmode=verify-full&sslrootcert=/run/secrets/database_ca.pem');
    expect(caPathFor({ compute: { shape: 'kubernetes' }, target: { provider: 'aws' } } as never)).toBe('/run/secrets/database_ca.pem');
    expect(caPathFor({ compute: { shape: 'vm' }, target: { provider: 'azure' } } as never)).toBe('/run/credentials/exprsn-ai.service/database_ca');
    expect(caPathFor({ compute: { shape: 'container' }, target: { provider: 'azure' } } as never)).toBe('/run/secrets/exprsn/database-ca');
    expect(caPathFor({ compute: { shape: 'container' }, target: { provider: 'aws' } } as never)).toBeNull();
    // The bundle is checked: PEM CA certificates only.
    expect(normaliseCaBundle(readFileSync(ca))).toContain('-----BEGIN CERTIFICATE-----');
    expect(() => normaliseCaBundle('not a certificate')).toThrow(/no PEM certificate/);
    // A driver's message never carries the password.
    expect(redact('connect failed for postgres://exprsn:s3cret@db:5432/x password=s3cret')).toBe('connect failed for postgres://exprsn:***@db:5432/x password=***');
  });
});

describe('a provisioned data tier (B-10302, B-10305)', () => {
  const deployment = (over: Record<string, unknown> = {}) =>
    ({ id: ulid(), name: 'lab', tenantId: h.tenantId, provider: 'aws', createdBy: aliceId, spec: deploymentSpecSchema.parse({ name: 'lab', target: { provider: 'aws', accountId: ulid(), region: 'eu-central-1' }, compute: { shape: 'container', size: 'small' }, frontDoor: { kind: 'byo', hostname: 'ai.example.test' }, release: { image: `ghcr.io/exprsn/exprsn-ai@sha256:${'a'.repeat(64)}` }, ...over }) }) as unknown as Deployment;

  it('generates the database password and the cache token once, into the vault, for the broker; leaves other references alone', async () => {
    const d = deployment();
    const tier = h.s.cloud.dataTier;
    const pw = await tier.intercept(d, { name: 'db_admin_password', env: 'DB_ADMIN_PASSWORD', ref: 'vault:cloud/lab#db_admin_password' });
    expect(pw).toMatch(/^[0-9a-f]{64}$/);
    expect(await tier.intercept(d, { name: 'db_admin_password', env: 'DB_ADMIN_PASSWORD', ref: 'vault:cloud/lab#db_admin_password' })).toBe(pw);
    const token = await tier.intercept(d, { name: 'cache_auth_token', env: 'REDIS_URL', ref: 'vault:cloud/lab#cache_auth_token' });
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toBe(pw);
    expect(await h.s.cloud.caches.authToken(d)).toBe(token);
    // Another deployment's reference, or one the operator wrote, is the vault's to resolve.
    expect(await tier.intercept(d, { name: 'db_admin_password', env: 'X', ref: 'vault:cloud/other#db_admin_password' })).toBeNull();
    expect(await tier.intercept(d, { name: 'session_secret', env: 'SESSION_SECRET', ref: 'vault:cloud/lab#session_secret' })).toBeNull();
    // The bindings of a provisioned tier name the CA bundle as a file too.
    expect(secretBindings(d.spec as never).map((b) => b.name)).toEqual(['session_secret', 'database_url', 'redis_url', 'database_ca', 'openbao_token']);
  });

  it('refuses to wire a provisioned database where the app gets secrets as variables only (ECS)', async () => {
    await expect(h.s.cloud.dataTier.wire(deployment(), { service: 'test' })).rejects.toMatchObject({ status: 409, extensions: { reason: 'ca_file_unsupported' } });
  });
});

describe('the preflight (B-10302)', () => {
  it('a dry run checks and estimates and changes nothing', async () => {
    const t = target('dry');
    const sw = switchFile('dry');
    const before = await count(h.s.db, 'platform_backups');
    const m = await moves().plan({ target: { kind: 'url_file', path: t.file }, switchFile: sw, dryRun: true }, { service: 'cli' });
    expect(m).toMatchObject({ state: 'planned', dryRun: true, view: { client: 'sqlite' }, window: { openedAt: null } });
    expect(m.checks.filter((c) => !c.ok)).toEqual([]);
    expect(m.checks.map((c) => c.id)).toEqual(expect.arrayContaining(['target', 'source_schema', 'switch_file', 'version', 'empty', 'connections', 'window']));
    expect(m.estimate!.windowMs).toBeLessThan(m.windowBoundMs);
    expect(await count(h.s.db, 'platform_backups')).toBe(before);
    expect(readFileSync(sw, 'utf8').trim()).toBe(OLD_URL);
    expect(await moves().window.current(0)).toBeNull();
    await expect(moves().run(m.id, { service: 'cli' })).rejects.toMatchObject({ status: 409 });
    expect(await h.s.db('audit_events').where({ action: 'cloud.db_move.dry_run' })).toHaveLength(1);
  });

  it('refuses a target whose connections cannot hold the pools, one without TLS or its CA bundle, and a target that is not empty', async () => {
    const dir = mkdtempSync(path.join(tmp, 'ca-'));
    const ca = makeCa(dir);
    const url = path.join(tmp, 'pg.url');
    writeFileSync(url, 'postgres://exprsn:not-logged@127.0.0.1:9/exprsn\n');
    const facts = (o: Partial<TargetFacts> = {}) => async (): Promise<TargetFacts> => ({ version: '17.2', ssl: true, maxConnections: 30, reserved: 3, extensions: ['vector', 'pg_trgm'], occupied: [], ...o });
    moves().hooks.facts = facts();
    const m = await moves().plan({ target: { kind: 'url_file', path: url }, caFile: ca, switchFile: switchFile('limits'), instances: 3, dryRun: false }, { service: 'cli' });
    const c = Object.fromEntries(m.checks.map((x) => [x.id, x]));
    expect(c.connections).toMatchObject({ ok: false, detail: '35 connections needed (DB_POOL_MAX 10 × 3 instances + 5), 27 available (max_connections 30 less 3 reserved): lower DB_POOL_MAX, run fewer instances, add a pooler, or choose a larger size.' });
    expect(m.budget).toMatchObject({ required: 35, available: 27, ok: false, source: 'live' });
    if (ca) expect(c.ca_file!.ok && c.tls!.ok).toBe(true);
    // The move does not start: the preflight runs again first and refuses.
    await expect(moves().run(m.id, { service: 'cli' })).rejects.toMatchObject({ status: 409, extensions: { reason: 'preflight_failed' } });
    expect(await moves().window.current(0)).toBeNull();
    expect(JSON.stringify(await moves().get(m.id))).not.toContain('not-logged');

    moves().hooks.facts = facts({ ssl: false, maxConnections: 500, occupied: [{ table: 'tenants', rows: 1 }], extensions: [] });
    const n = await moves().plan({ target: { kind: 'url_file', path: url }, caFile: null, switchFile: switchFile('notls'), dryRun: true }, { service: 'cli' });
    const d = Object.fromEntries(n.checks.map((x) => [x.id, x]));
    expect(d.tls!.ok).toBe(false);
    expect(d.ca_file).toMatchObject({ ok: false, detail: expect.stringMatching(/RDS global bundle, Azure DigiCert and Microsoft roots, DigitalOcean’s cluster CA/) });
    expect(d.empty).toMatchObject({ ok: false, detail: expect.stringMatching(/not empty \(1 tenants\)/) });
    expect(d.extensions!.ok).toBe(false);
    expect(d.connections!.ok).toBe(true);
  });
});

describe('the move (B-10302)', () => {
  it('backs up, restores, holds the read-only window, checks migrations and switches; a crash between steps resumes', async () => {
    const t = target('main');
    const sw = switchFile('main');
    const sourceConversations = await count(h.s.db, 'conversations');
    const m = await moves().plan({ target: { kind: 'url_file', path: t.file }, switchFile: sw, dryRun: false }, { service: 'cli' });
    let crashed = false;
    const inWindow: { post: number; get: number; gate: string | null }[] = [];
    moves().hooks.afterStep = async (step) => {
      if (step === 'read_only') {
        // Every change is refused while the window is open; reads and the move's own routes are not.
        const p = await post(alice, '/api/conversations', { title: 'during the window' });
        const g = await alice.agent.get('/api/conversations');
        await moves().window.current(0);
        inWindow.push({ post: p.status, get: g.status, gate: moves().window.refusal() });
        expect(p.body).toMatchObject({ reason: 'read_only_window' });
        expect(p.headers['retry-after']).toBe('60');
      }
      if (step === 'restore' && !crashed) {
        crashed = true;
        throw new Error('the process died between restore and verify');
      }
    };
    await expect(moves().run(m.id, { service: 'cli' })).rejects.toMatchObject({ status: 409 });
    expect(inWindow).toEqual([{ post: 503, get: 200, gate: 'the database is being moved (read-only window)' }]);
    const stopped = await moves().get(m.id);
    expect(stopped).toMatchObject({ state: 'failed', error: expect.stringMatching(/died between restore and verify/) });
    expect(stopped.steps.restore.state).toBe('done');
    expect(stopped.steps.verify.state).toBe('pending');
    expect(await moves().window.current(0)).toMatchObject({ moveId: m.id, phase: 'cutover' }); // still read-only while stopped
    // The crashed instance's lease ran out; another one resumes at verify.
    await h.s.db('platform_state').where({ key: `cloud.dbmove:${m.id}` }).update({ value: JSON.stringify({ ...stopped, lease: { holder: 'gone', until: Date.now() - 1 } }) });
    moves().hooks.afterStep = undefined;
    const done = await moves().run(m.id, { service: 'cli' });
    expect(done.state).toBe('switched');
    expect(Object.values(done.steps).map((x) => x.state)).toEqual(Array(8).fill('done'));
    expect(done.steps.restore.attempts).toBe(1);
    expect(done.steps.verify.detail).toMatchObject({ conversations: sourceConversations, auditChains: expect.any(Number) });
    expect(done.steps.migrate_check.detail).toMatchObject({ pending: 0 });
    // DATABASE_URL switched in its file, the old one kept beside it.
    expect(readFileSync(sw, 'utf8').trim()).toBe(t.url);
    expect(readFileSync(`${sw}.previous`, 'utf8').trim()).toBe(OLD_URL);
    expect(done.switchedAt! - done.window.openedAt!).toBeLessThan(done.windowBoundMs);
    // The old database stays read-only (the window's flag; SQLite has no database default to set).
    expect(done.oldReadOnly).toBe('flag');
    expect(await moves().window.current(0)).toMatchObject({ moveId: m.id, phase: 'switched' });
    expect((await post(alice, '/api/conversations', { title: 'after the switch, on the old database' })).status).toBe(503);
    // The new database holds everything, is not in a window, verifies, and knows the move switched.
    const db = openTarget(t.url);
    try {
      expect(await count(db, 'conversations')).toBe(sourceConversations);
      expect(await count(db, 'users')).toBe(await count(h.s.db, 'users'));
      expect(await db('platform_state').where({ key: WINDOW_KEY }).first()).toBeUndefined();
      const rec = JSON.parse((await db('platform_state').where({ key: `cloud.dbmove:${m.id}` }).first()).value) as MoveRecord;
      expect(rec.state).toBe('switched');
      // What the window held back went to the new database's audit chain; the old one took none of it.
      const actions = (await db('audit_events').where('action', 'like', 'cloud.db_move.%').select('action')).map((r: { action: string }) => r.action);
      expect(actions).toEqual(expect.arrayContaining(['cloud.db_move.started', 'cloud.db_move.switched']));
      const tenants = (await db('audit_events').distinct('tenant_id')).map((r: { tenant_id: string }) => r.tenant_id);
      for (const tid of tenants) expect((await new (await import('../src/audit/chain.js')).AuditLog(db).verify(tid)).status).toBe('verified');
    } finally {
      await db.destroy();
    }
    const sourceMoveEvents = await h.s.db('audit_events').where('action', 'like', 'cloud.db_move.%').andWhere('ts', '>=', done.window.openedAt!);
    expect(sourceMoveEvents).toHaveLength(0);

    // Rollback after the switch, the new database untouched: the URL goes back, the old database opens again.
    const back = await moves().rollback(m.id, { service: 'cli' });
    expect(back.state).toBe('rolled_back');
    expect(readFileSync(sw, 'utf8').trim()).toBe(OLD_URL);
    expect(await moves().window.current(0)).toBeNull();
    expect((await post(alice, '/api/conversations', { title: 'back on the old database' })).status).toBe(201);
    const db2 = openTarget(t.url);
    try {
      // The new database is put in a window so an instance not yet restarted changes nothing there.
      expect(JSON.parse((await db2('platform_state').where({ key: WINDOW_KEY }).first()).value)).toMatchObject({ moveId: m.id, phase: 'switched' });
    } finally {
      await db2.destroy();
    }
  });

  it('rolls back after the switch only when the new database took no writes, unless they are given up', async () => {
    const t = target('writes');
    const sw = switchFile('writes');
    const m = await moves().plan({ target: { kind: 'url_file', path: t.file }, switchFile: sw, dryRun: false }, { service: 'cli' });
    await moves().run(m.id, { service: 'cli' });
    const db = openTarget(t.url);
    try {
      const row = await db('conversations').first();
      await db('conversations').insert({ ...row, id: ulid() });
    } finally {
      await db.destroy();
    }
    await expect(moves().rollback(m.id, { service: 'cli' })).rejects.toMatchObject({ status: 409, extensions: { reason: 'writes_since_switch', changed: ['conversations (+1)'] } });
    expect(readFileSync(sw, 'utf8').trim()).toBe(t.url);
    const back = await moves().rollback(m.id, { service: 'cli' }, { discardNewWrites: true });
    expect(back.state).toBe('rolled_back');
    expect(readFileSync(sw, 'utf8').trim()).toBe(OLD_URL);
    expect(await h.s.db('audit_events').where({ action: 'cloud.db_move.rolled_back' }).orderBy('seq', 'desc').first()).toMatchObject({ action: 'cloud.db_move.rolled_back' });
  });

  it('rolls back before the switch: the window closes and the install stays on its database', async () => {
    const t = target('before');
    const sw = switchFile('before');
    const m = await moves().plan({ target: { kind: 'url_file', path: t.file }, switchFile: sw, dryRun: false }, { service: 'cli' });
    moves().hooks.afterStep = (step) => {
      if (step === 'backup') throw new Error('stopped after the backup');
    };
    await expect(moves().run(m.id, { service: 'cli' })).rejects.toBeTruthy();
    expect((await post(alice, '/api/conversations', { title: 'refused' })).status).toBe(503);
    const back = await moves().rollback(m.id, { service: 'cli' });
    expect(back).toMatchObject({ state: 'rolled_back', switchedAt: null, window: { closedAt: expect.any(Number) } });
    expect(readFileSync(sw, 'utf8').trim()).toBe(OLD_URL);
    expect(existsSync(`${sw}.previous`)).toBe(false);
    expect((await post(alice, '/api/conversations', { title: 'writable again' })).status).toBe(201);
    expect(moves().window.refusal()).toBeNull();
    // What the window held back was written to the old database's chain when it closed.
    expect(await h.s.db('audit_events').where({ action: 'cloud.db_move.started' }).andWhere('detail', 'like', `%${m.id}%`)).toHaveLength(1);
  });

  it('closes the window and resumes from a new backup when the source changed during it', async () => {
    const t = target('changed');
    const m = await moves().plan({ target: { kind: 'url_file', path: t.file }, switchFile: switchFile('changed'), dryRun: false }, { service: 'cli' });
    moves().hooks.afterStep = async (step) => {
      // A job that was still running writes a row past the window's guard.
      if (step === 'backup' && !(await moves().get(m.id)).steps.restore.attempts) {
        const row = await h.s.db('conversations').first();
        await h.s.db('conversations').insert({ ...row, id: ulid() });
      }
    };
    await expect(moves().run(m.id, { service: 'cli' })).rejects.toMatchObject({ extensions: { reason: 'writes_during_window' } });
    const r = await moves().get(m.id);
    expect(r.error).toMatch(/The source changed during the window: conversations \(\+1\)/);
    expect(r.steps.backup.state).toBe('pending');
    expect(await moves().window.current(0)).toBeNull(); // writable again until the resume
    moves().hooks.afterStep = undefined;
    // The target already holds the first restore: the resumed restore replaces it.
    expect((await moves().run(m.id, { service: 'cli' })).state).toBe('switched');
  });
});

describe('the routes: dual control and a recent sign-in (B-10302)', () => {
  const saved = process.env.DATABASE_URL_FILE;
  afterAll(() => {
    if (saved === undefined) delete process.env.DATABASE_URL_FILE;
    else process.env.DATABASE_URL_FILE = saved;
  });

  it('asks with a dry run, refuses the asker’s own approval and a stale sign-in, runs as a job, and rolls back', async () => {
    const t = target('route');
    process.env.DATABASE_URL_FILE = switchFile('route');
    await post(alice, '/api/vault/policies', { subjectKind: 'user', subject: aliceId, path: '*', capabilities: ['*'] }).expect((r) => expect([200, 201]).toContain(r.status));
    const put = await alice.agent.put('/api/vault/kv/data/ops/move').set('x-csrf-token', alice.csrf).send({ data: { url: t.url } });
    expect([200, 201]).toContain(put.status);

    const dry = await post(alice, '/api/admin/cloud/db-moves/dry-run', { target: { kind: 'vault', ref: 'vault:ops/move#url' } }).expect(201);
    expect(dry.body.move).toMatchObject({ dryRun: true, state: 'planned' });
    expect(dry.body.move).not.toHaveProperty('pendingAudit');
    const asked = await post(alice, '/api/admin/cloud/db-moves', { target: { kind: 'vault', ref: 'vault:ops/move#url' }, note: 'onto the managed database' }).expect(201);
    const id = asked.body.move.id as string;
    expect(asked.body.move).toMatchObject({ state: 'awaiting_approval', view: { client: 'sqlite' } });
    // One open move at a time.
    await post(bob, '/api/admin/cloud/db-moves', { target: { kind: 'vault', ref: 'vault:ops/move#url' } }).expect(409);
    // Never by the person who asked.
    const own = await post(alice, `/api/admin/cloud/db-moves/${id}/approve`).expect(403);
    expect(own.body.detail).toMatch(/second cloud admin/);
    // A recent sign-in.
    const spy = vi.spyOn(h.s.account, 'isRecent').mockReturnValue(false);
    await post(bob, `/api/admin/cloud/db-moves/${id}/approve`).expect(401);
    spy.mockRestore();
    const ok = await post(bob, `/api/admin/cloud/db-moves/${id}/approve`, { note: 'checked the dry run' }).expect(202);
    expect(ok.body.job.type).toBe('cloud.db.move');
    for (let i = 0; i < 5 && (await moves().get(id)).state !== 'switched'; i++) await h.s.jobs.runDue();
    const listed = await alice.agent.get('/api/admin/cloud/db-moves').expect(200);
    expect(listed.body.moves.find((x: { id: string }) => x.id === id)).toMatchObject({ state: 'switched', approvedBy: expect.any(String), requestedBy: aliceId });
    expect(listed.body.window).toMatchObject({ moveId: id, phase: 'switched' });
    expect(readFileSync(process.env.DATABASE_URL_FILE!, 'utf8').trim()).toBe(t.url);
    // The routes answer during the window; rolling back needs a recent sign-in too.
    const spy2 = vi.spyOn(h.s.account, 'isRecent').mockReturnValue(false);
    await post(alice, `/api/admin/cloud/db-moves/${id}/rollback`, {}).expect(401);
    spy2.mockRestore();
    const back = await post(alice, `/api/admin/cloud/db-moves/${id}/rollback`, {}).expect(200);
    expect(back.body.move.state).toBe('rolled_back');
    const events = (await h.s.db('audit_events').where('action', 'like', 'cloud.db_move.%').select('action')).map((r: { action: string }) => r.action);
    expect(events).toEqual(expect.arrayContaining(['cloud.db_move.requested', 'cloud.db_move.approved', 'cloud.db_move.rolled_back']));
  });

  it('needs platform:manage as well as cloud:admin', async () => {
    // A cloud admin of a tenant holds cloud:admin but not platform:manage: the platform's own database is not theirs.
    await localUser(h, 'carol', ['cloud-admin'], 'restricted');
    const carol = await loginAdmin(h, 'carol');
    await carol.agent.get('/api/admin/cloud/db-moves').expect(403);
    await post(carol, '/api/admin/cloud/db-moves/dry-run', { target: { kind: 'vault', ref: 'vault:ops/move#url' } }).expect(403);
  });
});
