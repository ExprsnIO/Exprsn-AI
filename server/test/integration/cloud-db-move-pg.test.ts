/*
 * 1.9.99-final, Sprint 59 (B-10302): an install moved onto a real PostgreSQL, standing in for the managed one, over
 * TLS verified against a CA bundle file. Runs when TEST_MOVE_PG_URL is set: an admin URL of a throwaway PostgreSQL
 * with pgvector and TLS on (e.g. `postgres://postgres:<pw>@localhost:<port>/postgres`), with TEST_MOVE_PG_CA the CA
 * bundle its server certificate chains to (for a name the URL's host matches). Each run makes its own empty database
 * and drops it; the harness's SQLite database is the install being moved.
 *
 * What it shows: the preflight reads the live server (TLS in use and verified with sslrootcert, max_connections and
 * the reserved slots against DB_POOL_MAX × instances, pgvector available, the target empty); then backup:create,
 * restore into PostgreSQL, the read-only window, verify (every row, every conversation, audit:verify per tenant),
 * migrate --check and the switch of DATABASE_URL in its file; the switched URL opens with TLS verified; a rollback
 * after the switch goes back. The sandbox run against RDS (open decision 18) is the owner's step: docs/runbooks/db-move.md.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import knexFactory from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/chain.js';
import { withCaFile } from '../../src/cloud/db-move.js';
import { migrateCheck } from '../../src/db/schema.js';
import { harness, localUser, loginAdmin, type Harness } from '../helpers.js';

const ADMIN = process.env.TEST_MOVE_PG_URL;
const CA = process.env.TEST_MOVE_PG_CA;

describe.skipIf(!ADMIN || !CA)('db:move onto a real PostgreSQL with TLS (B-10302)', () => {
  let h: Harness;
  let tmp: string;
  let dbName: string;
  let targetUrl: string;
  const admin = () => knexFactory({ client: 'pg', connection: withCaFile(ADMIN!, CA!), pool: { min: 0, max: 1 } });

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'exprsn-dbmove-pg-'));
    dbName = `move_${randomBytes(4).toString('hex')}`;
    const a = admin();
    try {
      await a.raw(`CREATE DATABASE ${dbName}`);
    } finally {
      await a.destroy();
    }
    const u = new URL(ADMIN!);
    u.pathname = `/${dbName}`;
    u.search = '';
    targetUrl = u.toString();
    h = await harness();
    await localUser(h, 'mover', ['system-admin'], 'restricted');
    const c = await loginAdmin(h, 'mover');
    for (const title of ['One', 'Two', 'Three', 'Four']) await c.agent.post('/api/conversations').set('x-csrf-token', c.csrf).send({ title }).expect(201);
    h.s.cloud.dbMoves.hooks = { settleMs: 0, drainMs: 0, sleep: async () => undefined };
  });

  afterAll(async () => {
    await h?.close();
    const a = admin();
    try {
      await a.raw(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    } finally {
      await a.destroy();
    }
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('refuses a budget the live max_connections cannot hold', async () => {
    const urlFile = path.join(tmp, 'target.url');
    writeFileSync(urlFile, `${targetUrl}\n`, { mode: 0o600 });
    const m = await h.s.cloud.dbMoves.plan({ target: { kind: 'url_file', path: urlFile }, caFile: CA!, switchFile: path.join(tmp, 'unused-url'), instances: 1000, dryRun: true }, { service: 'cli' });
    const c = Object.fromEntries(m.checks.map((x) => [x.id, x]));
    expect(c.connections!.ok).toBe(false);
    expect(m.budget).toMatchObject({ source: 'live', instances: 1000 });
    expect(m.budget!.maxConnections).toBeGreaterThan(0);
    expect(c.tls).toMatchObject({ ok: true, detail: expect.stringMatching(/TLS in use, verified against/) });
    expect(c.extensions!.ok).toBe(true);
  });

  it('moves the install, verifies it on PostgreSQL, switches DATABASE_URL, and rolls back', async () => {
    const s = h.s;
    const urlFile = path.join(tmp, 'target.url');
    writeFileSync(urlFile, `${targetUrl}\n`, { mode: 0o600 });
    const switchFile = path.join(tmp, 'database-url');
    writeFileSync(switchFile, 'sqlite:/old/install.sqlite\n', { mode: 0o600 });
    const conversations = Number((await s.db('conversations').count({ n: '*' }))[0]!.n);
    const m = await s.cloud.dbMoves.plan({ target: { kind: 'url_file', path: urlFile }, caFile: CA!, switchFile, dryRun: false }, { service: 'cli' });
    expect(m.checks.filter((c) => !c.ok)).toEqual([]);
    expect(m.budget).toMatchObject({ ok: true, source: 'live' });
    const done = await s.cloud.dbMoves.run(m.id, { service: 'cli' });
    expect(done.state).toBe('switched');
    const windowMs = done.switchedAt! - done.window.openedAt!;
    expect(windowMs).toBeLessThan(done.windowBoundMs);
    const switched = readFileSync(switchFile, 'utf8').trim();
    expect(new URL(switched).searchParams.get('sslmode')).toBe('verify-full');
    expect(new URL(switched).searchParams.get('sslrootcert')).toBe(CA);
    // The switched URL opens, with TLS verified against the CA file, and holds the install.
    const db = knexFactory({ client: 'pg', connection: switched, pool: { min: 0, max: 1 } });
    try {
      const ssl = (await db.raw('select ssl, version from pg_stat_ssl where pid = pg_backend_pid()')).rows[0];
      expect(ssl.ssl).toBe(true);
      expect(Number((await db('conversations').count({ n: '*' }))[0]!.n)).toBe(conversations);
      expect((await migrateCheck(db)).state).toBe('current');
      const tenants = (await db('audit_events').distinct('tenant_id')).map((r: { tenant_id: string }) => r.tenant_id);
      expect(tenants.length).toBeGreaterThan(0);
      for (const t of tenants) expect((await new AuditLog(db).verify(t)).status).toBe('verified');
      expect(await db('platform_state').where({ key: 'cloud.dbmove.window' }).first()).toBeUndefined();
    } finally {
      await db.destroy();
    }
    process.stdout.write(`db:move window: ${windowMs} ms for ${done.steps.verify.detail?.rows} rows\n`);
    // A PostgreSQL source (TEST_HARNESS_DB=pg) is kept read-only by its own default for new sessions.
    const fresh = () => knexFactory({ client: 'pg', connection: s.cfg.DATABASE_URL!, pool: { min: 0, max: 1 } });
    if (s.cfg.DB_CLIENT === 'pg') {
      expect(done.oldReadOnly).toBe('database');
      const o = fresh();
      try {
        expect((await o.raw('show default_transaction_read_only')).rows[0].default_transaction_read_only).toBe('on');
      } finally {
        await o.destroy();
      }
    } else expect(done.oldReadOnly).toBe('flag');
    const back = await s.cloud.dbMoves.rollback(m.id, { service: 'cli' });
    expect(back.state).toBe('rolled_back');
    expect(readFileSync(switchFile, 'utf8').trim()).toBe('sqlite:/old/install.sqlite');
    if (s.cfg.DB_CLIENT === 'pg') {
      const o = fresh();
      try {
        expect((await o.raw('show default_transaction_read_only')).rows[0].default_transaction_read_only).toBe('off');
      } finally {
        await o.destroy();
      }
    }
  });
});
