import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ConnectionSpec, DataDriver } from '../src/connections/drivers.js';
import { hashPassword } from '../src/identity/passwords.js';
import { resolveSecretRef, secretRefProblem, vaultRefsIn } from '../src/identity/secrets.js';
import { LEASE_USER, leasePassword, leaseUsername, mysqlIdent, mysqlStatements, mysqlString, pgIdent, pgLiteral, pgStatements, type DbAdmin, type EngineTarget, type LeaseGrant } from '../src/vault/db-engines.js';
import { isGrantPath } from '../src/vault/policy.js';
import { headerVaultRef } from '../src/workflows/graph.js';
import type { WfGraph } from '../src/workflows/graph.js';
import { FakeMcp } from './fake-mcp.js';
import { harness, localUser, login, loginAdmin, PASSWORD, type Client, type Harness } from './helpers.js';

const send = (c: Client, method: 'post' | 'put' | 'patch' | 'delete', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A database server stand-in for the lease engines: accounts in memory, every admin login recorded. */
class FakeDb {
  users = new Map<string, { password: string; validUntil: Date; grant: LeaseGrant }>();
  logins: { username: string; password: string }[] = [];
  failDrop = false;
  canCreate = true;

  admins = (t: EngineTarget): DbAdmin => {
    const login = () => this.logins.push({ username: t.adminUsername, password: t.adminPassword });
    return {
      test: async () => {
        login();
        return { version: 'FakeSQL 1.0', canCreate: this.canCreate, detail: this.canCreate ? 'can create' : 'cannot create' };
      },
      createUser: async (u, pw, validUntil, grant) => {
        login();
        if (!LEASE_USER.test(u)) throw new Error('bad user');
        this.users.set(u, { password: pw, validUntil, grant });
      },
      extend: async (u, validUntil) => {
        login();
        this.users.get(u)!.validUntil = validUntil;
      },
      dropUser: async (u) => {
        login();
        if (this.failDrop) throw new Error(`permission denied to drop role (password=${t.adminPassword})`);
        this.users.delete(u);
      },
      exists: async (u) => this.users.has(u)
    };
  };
}

// ---------- B-1704: statements, names and quoting ----------

describe('sprint 25c: lease statements (B-1704)', () => {
  const grant: LeaseGrant = { privileges: 'read', schemas: ['public', 'sales'] };

  it('generates user names that fit MySQL and passwords with every character class', () => {
    const u = leaseUsername('readonly_reporting');
    expect(u).toMatch(LEASE_USER);
    expect(u.length).toBeLessThanOrEqual(32);
    expect(leaseUsername('readonly')).not.toBe(leaseUsername('readonly'));
    const pw = leasePassword();
    expect(pw.length).toBeGreaterThanOrEqual(32);
    expect(pw).toMatch(/[a-z]/);
    expect(pw).toMatch(/[A-Z]/);
    expect(pw).toMatch(/[0-9]/);
    expect(pw).not.toMatch(/['"\\]/);
  });

  it('quotes identifiers and literals per dialect', () => {
    expect(pgIdent('we"ird')).toBe('"we""ird"');
    expect(pgLiteral("o'clock")).toBe("'o''clock'");
    expect(() => pgLiteral('a\\b')).toThrow();
    expect(() => pgLiteral('a\nb')).toThrow();
    expect(mysqlIdent('we`ird')).toBe('`we``ird`');
    expect(mysqlString("it's")).toBe("'it''s'");
    expect(() => mysqlString('x\\')).toThrow();
  });

  it('builds PostgreSQL statements from the fixed set only', () => {
    const until = new Date('2026-10-04T12:00:00.000Z');
    const create = pgStatements.create('exai_readonly_0123456789ab', 'pw-1', until, 'shop', grant);
    expect(create[0]).toBe(`CREATE ROLE "exai_readonly_0123456789ab" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT PASSWORD 'pw-1' VALID UNTIL '2026-10-04T12:00:00.000Z'`);
    expect(create).toContain('GRANT CONNECT ON DATABASE "shop" TO "exai_readonly_0123456789ab"');
    expect(create).toContain('GRANT SELECT ON ALL TABLES IN SCHEMA "sales" TO "exai_readonly_0123456789ab"');
    expect(create.some((s) => s.includes('SEQUENCES'))).toBe(false);
    const rw = pgStatements.create('exai_rw_0123456789ab', 'pw', until, null, { privileges: 'readwrite', schemas: ['public'] });
    expect(rw).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "public" TO "exai_rw_0123456789ab"');
    expect(rw).toContain('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "public" TO "exai_rw_0123456789ab"');
    expect(pgStatements.extend('exai_rw_0123456789ab', until)).toEqual([`ALTER ROLE "exai_rw_0123456789ab" VALID UNTIL '2026-10-04T12:00:00.000Z'`]);
    expect(pgStatements.drop('exai_rw_0123456789ab')).toEqual(['DROP ROLE IF EXISTS "exai_rw_0123456789ab"']);
    // Only names this engine generated, and only schema names in the safe pattern, are ever spliced in.
    expect(() => pgStatements.drop('postgres')).toThrow(/did not generate/);
    expect(() => pgStatements.create('exai_x_0123456789ab', 'pw', until, null, { privileges: 'read', schemas: ['public"; DROP TABLE x; --'] })).toThrow(/schema/);
  });

  it('builds MySQL statements from the fixed set only', () => {
    expect(mysqlStatements.create('exai_readonly_0123456789ab', 'pw-1', '%', { privileges: 'read', schemas: ['shop'] })).toEqual(["CREATE USER 'exai_readonly_0123456789ab'@'%' IDENTIFIED BY 'pw-1'", "GRANT SELECT ON `shop`.* TO 'exai_readonly_0123456789ab'@'%'"]);
    expect(mysqlStatements.drop('exai_readonly_0123456789ab', '10.%')).toEqual(["DROP USER IF EXISTS 'exai_readonly_0123456789ab'@'10.%'"]);
    expect(() => mysqlStatements.drop("root'@'%", '%')).toThrow();
  });

  it('accepts database paths in vault policies', () => {
    expect(isGrantPath('database')).toBe(true);
    expect(isGrantPath('database/orders/readonly')).toBe(true);
    expect(isGrantPath('database/Orders')).toBe(false);
  });
});

// ---------- B-1704: engines, leases, renewal, revocation and the sweeper ----------

describe('sprint 25c: database leases (B-1704)', () => {
  let h: Harness;
  let fake: FakeDb;
  let root: Client & { totpSecret: string };
  let dev: Client;
  let devId: string;
  let rootId: string;

  beforeAll(async () => {
    fake = new FakeDb();
    h = await harness({ CONNECTIONS_ALLOWED_HOSTS: 'db.data.internal' }, { dbAdmins: fake.admins });
    rootId = (await localUser(h, 'root', ['system-admin'], 'restricted')).id;
    devId = (await localUser(h, 'dev', ['member'], 'internal')).id;
    await localUser(h, 'plain', ['member'], 'internal');
    root = await loginAdmin(h, 'root');
    dev = await login(h, 'dev');
  });
  afterAll(() => h.close());

  const engine = { name: 'orders', dialect: 'postgres', endpoint: 'db.data.internal:5432', database: 'shop', zone: 'data', label: 'internal', adminUsername: 'lease_admin', adminPassword: 'admin-secret-1', defaultTtlSeconds: 600, maxTtlSeconds: 3600 };

  it('only connections:manage registers an engine, only in a zone whose ceiling covers its label', async () => {
    await send(dev, 'post', '/api/vault/database/engines', engine).expect(403);
    await send(root, 'post', '/api/admin/zones/seed').expect(201);
    const above = await send(root, 'post', '/api/vault/database/engines', { ...engine, name: 'hr', zone: 'sandbox', label: 'restricted' }).expect(403);
    expect(above.body).toMatchObject({ step: 'zone', zoneCeiling: 'confidential' });
    await send(root, 'post', '/api/vault/database/engines', { ...engine, name: 'nowhere', zone: 'nowhere' }).expect(422);
    expect((await h.s.audit.list(h.tenantId, { action: 'vault.database.engine.refused' })).length).toBe(2);
    // An admin login that cannot create accounts is refused before anything is saved.
    fake.canCreate = false;
    await send(root, 'post', '/api/vault/database/engines', engine).expect(422);
    fake.canCreate = true;
    const created = await send(root, 'post', '/api/vault/database/engines', engine).expect(201);
    expect(created.body).toMatchObject({ name: 'orders', dialect: 'postgres', adminPasswordFrom: 'sealed', state: 'active', check: { canCreate: true } });
    expect(JSON.stringify(created.body)).not.toContain('admin-secret-1');
    const stored = await h.s.db('vault_db_engines').where({ name: 'orders' }).first();
    expect(String(stored.admin_password_sealed)).not.toContain('admin-secret-1');
    expect(fake.logins.at(-1)).toEqual({ username: 'lease_admin', password: 'admin-secret-1' });
    await send(root, 'post', '/api/vault/database/engines', engine).expect(409);
  });

  it('roles take a privilege template and safe schema names', async () => {
    await send(root, 'put', '/api/vault/database/engines/orders/roles/readonly', { privileges: 'read', schemas: ['public', 'sales'], maxTtlSeconds: 1800 }).expect(200);
    await send(root, 'put', '/api/vault/database/engines/orders/roles/bad', { privileges: 'read', schemas: ['public"; drop table x; --'] }).expect(400);
    await send(root, 'put', '/api/vault/database/engines/orders/roles/admin', { privileges: 'superuser' }).expect(400);
    await send(root, 'put', '/api/vault/database/engines/orders/roles/long', { privileges: 'read', maxTtlSeconds: 7200 }).expect(400);
    const view = (await root.agent.get('/api/vault/database/engines/orders').expect(200)).body;
    expect(view.roles).toEqual([expect.objectContaining({ name: 'readonly', privileges: 'read', schemas: ['public', 'sales'], defaultTtlSeconds: 600, maxTtlSeconds: 1800, policyPath: 'database/orders/readonly' })]);
  });

  it('issues a lease only when the vault policy grants read on the role, and shows the password once', async () => {
    const denied = await send(dev, 'post', '/api/vault/database/creds/orders/readonly', {}).expect(403);
    expect(denied.body).toMatchObject({ step: 'vault-policy', path: 'database/orders/readonly', capability: 'read' });
    expect((await h.s.audit.list(h.tenantId, { action: 'vault.denied' })).length).toBeGreaterThan(0);
    expect((await dev.agent.get('/api/vault/database/roles').expect(200)).body.roles).toEqual([]);

    await send(root, 'post', '/api/vault/policies', { subjectKind: 'user', subject: devId, path: 'database/orders/readonly', capabilities: ['read'], effect: 'allow' }).expect(201);
    expect((await dev.agent.get('/api/vault/database/roles').expect(200)).body.roles).toEqual([expect.objectContaining({ engine: 'orders', name: 'readonly', canIssue: true })]);

    const lease = (await send(dev, 'post', '/api/vault/database/creds/orders/readonly', { ttlSeconds: 120 }).expect(201)).body;
    expect(lease).toMatchObject({ engine: 'orders', role: 'readonly', state: 'active', issuedTo: devId, leaseDurationSeconds: 120, renewable: true, connection: { dialect: 'postgres', endpoint: 'db.data.internal:5432', database: 'shop' } });
    expect(lease.username).toMatch(LEASE_USER);
    const account = fake.users.get(lease.username)!;
    expect(account.password).toBe(lease.password);
    expect(account.grant).toEqual({ privileges: 'read', schemas: ['public', 'sales'] });
    expect(account.validUntil.getTime()).toBe(lease.expiresAt);

    // Never again: not in the lease view, the list, the stored row or the audit chain.
    const again = (await dev.agent.get(`/api/vault/database/leases/${lease.id}`).expect(200)).body;
    expect(again.password).toBeUndefined();
    const row = await h.s.db('vault_db_leases').where({ id: lease.id }).first();
    expect(JSON.stringify(row)).not.toContain(lease.password);
    const issued = await h.s.audit.list(h.tenantId, { action: 'vault.database.lease.issued' });
    expect(issued).toHaveLength(1);
    expect(JSON.stringify(issued)).not.toContain(lease.password);

    // A TTL above the role's maximum is cut to it.
    const long = (await send(dev, 'post', '/api/vault/database/creds/orders/readonly', { ttlSeconds: 99999 }).expect(201)).body;
    expect(long.leaseDurationSeconds).toBe(1800);
    // Another member sees neither lease.
    const plain = await login(h, 'plain');
    await plain.agent.get(`/api/vault/database/leases/${lease.id}`).expect(404);
    await plain.agent.get('/api/vault/database/leases?all=1').expect(403);
    expect((await dev.agent.get('/api/vault/database/leases').expect(200)).body.leases).toHaveLength(2);
    expect((await root.agent.get('/api/vault/database/leases?all=1').expect(200)).body.leases.length).toBeGreaterThanOrEqual(2);
  });

  it('renews up to the lease maximum and revokes by dropping the account', async () => {
    const lease = (await send(dev, 'post', '/api/vault/database/creds/orders/readonly', { ttlSeconds: 60 }).expect(201)).body;
    const renewed = (await send(dev, 'post', `/api/vault/database/leases/${lease.id}/renew`, { incrementSeconds: 600 }).expect(200)).body;
    expect(renewed.expiresAt).toBeGreaterThan(lease.expiresAt);
    expect(renewed).toMatchObject({ renewals: 1, capped: false });
    expect(fake.users.get(lease.username)!.validUntil.getTime()).toBe(renewed.expiresAt);
    const capped = (await send(dev, 'post', `/api/vault/database/leases/${lease.id}/renew`, { incrementSeconds: 100000 }).expect(200)).body;
    expect(capped).toMatchObject({ capped: true, expiresAt: lease.maxExpiresAt });

    const revoked = (await send(dev, 'post', `/api/vault/database/leases/${lease.id}/revoke`).expect(200)).body;
    expect(revoked).toMatchObject({ state: 'revoked', endReason: 'revoked' });
    expect(fake.users.has(lease.username)).toBe(false);
    await send(dev, 'post', `/api/vault/database/leases/${lease.id}/renew`, {}).expect(410);
    expect(await h.s.audit.list(h.tenantId, { action: 'vault.database.lease.revoked' })).toHaveLength(1);
  });

  it('the sweeper drops an expired lease, and retries a drop the database refused', async () => {
    const lease = (await send(dev, 'post', '/api/vault/database/creds/orders/readonly', { ttlSeconds: 1 }).expect(201)).body;
    expect(fake.users.has(lease.username)).toBe(true);
    await sleep(1100);
    expect(await h.s.dbLeases.sweep(h.tenantId)).toEqual({ ended: 1, failed: 0 });
    expect(fake.users.has(lease.username)).toBe(false);
    expect((await dev.agent.get(`/api/vault/database/leases/${lease.id}`).expect(200)).body).toMatchObject({ state: 'expired', endReason: 'expired' });
    await send(dev, 'post', `/api/vault/database/leases/${lease.id}/renew`, {}).expect(410);
    expect(await h.s.audit.list(h.tenantId, { action: 'vault.database.lease.expired' })).toHaveLength(1);

    // The database refuses the drop: the lease waits, the admins are told, the admin password is never shown.
    const stuck = (await send(dev, 'post', '/api/vault/database/creds/orders/readonly', { ttlSeconds: 1 }).expect(201)).body;
    await sleep(1100);
    fake.failDrop = true;
    expect(await h.s.dbLeases.sweep(h.tenantId)).toEqual({ ended: 0, failed: 1 });
    const waiting = (await root.agent.get(`/api/vault/database/leases/${stuck.id}`).expect(200)).body;
    expect(waiting).toMatchObject({ state: 'revoking', endReason: 'expired', attempts: 1 });
    expect(waiting.lastError).toMatch(/permission denied/);
    expect(waiting.lastError).not.toContain('admin-secret-1');
    const notes = await h.s.db('notifications').where({ user_id: rootId, kind: 'vault' });
    expect(notes.some((n: { title: string }) => n.title.includes(stuck.username))).toBe(true);
    // Not due again until its back-off passes.
    expect(await h.s.dbLeases.sweep(h.tenantId)).toEqual({ ended: 0, failed: 0 });
    fake.failDrop = false;
    await h.s.db('vault_db_leases').where({ id: stuck.id }).update({ next_attempt_at: Date.now() - 1 });
    expect(await h.s.dbLeases.sweep(h.tenantId)).toEqual({ ended: 1, failed: 0 });
    expect(fake.users.has(stuck.username)).toBe(false);
    expect((await root.agent.get(`/api/vault/database/leases/${stuck.id}`).expect(200)).body.state).toBe('expired');
    // The schedule's job runs the same sweep.
    expect((await send(root, 'post', '/api/vault/database/sweep').expect(202)).body.jobId).toBeTruthy();
    await send(dev, 'post', '/api/vault/database/sweep').expect(403);
  });

  it('an engine admin login can be a vault reference, read as the user who registered the engine', async () => {
    await send(root, 'post', '/api/vault/policies', { subjectKind: 'user', subject: rootId, path: 'kv', capabilities: ['write', 'list'], effect: 'allow' }).expect(201);
    await send(root, 'put', '/api/vault/kv/data/db/reports-admin', { data: { password: 'from-the-vault' } }).expect(201);
    const ref = { ...engine, name: 'reports', adminPassword: undefined, adminPasswordRef: 'vault:db/reports-admin#password' };
    // Refused at save: the registering admin's policy does not grant read on the secret.
    const refused = await send(root, 'post', '/api/vault/database/engines', ref).expect(403);
    expect(refused.body).toMatchObject({ step: 'vault-policy', path: 'kv/db/reports-admin' });
    const grant = (await send(root, 'post', '/api/vault/policies', { subjectKind: 'user', subject: rootId, path: 'kv/db', capabilities: ['read'], effect: 'allow' }).expect(201)).body;
    const created = (await send(root, 'post', '/api/vault/database/engines', ref).expect(201)).body;
    expect(created).toMatchObject({ adminPasswordFrom: 'vault', adminPasswordRef: 'vault:db/reports-admin#password' });
    expect(fake.logins.at(-1)).toEqual({ username: 'lease_admin', password: 'from-the-vault' });
    await send(root, 'put', '/api/vault/database/engines/reports/roles/reader', { privileges: 'read' }).expect(200);
    await send(root, 'post', '/api/vault/policies', { subjectKind: 'user', subject: devId, path: 'database/reports', capabilities: ['read'], effect: 'allow' }).expect(201);
    const lease = (await send(dev, 'post', '/api/vault/database/creds/reports/reader', {}).expect(201)).body;
    expect(fake.users.get(lease.username)!.grant.schemas).toEqual(['public']);
    // Refused at use: once the owner's grant is gone, the engine cannot log in.
    await send(root, 'delete', `/api/vault/policies/${grant.id}`).expect(204);
    const atUse = await send(dev, 'post', '/api/vault/database/creds/reports/reader', {}).expect(403);
    expect(atUse.body.step).toBe('vault-policy');
    // Removing the engine revokes its live leases first (here the owner's login is gone, so it is refused).
    await send(root, 'delete', '/api/vault/database/engines/reports').expect(409);
    await send(root, 'post', '/api/vault/policies', { subjectKind: 'user', subject: rootId, path: 'kv/db', capabilities: ['read'], effect: 'allow' }).expect(201);
    await h.s.db('vault_db_leases').where({ engine_name: 'reports' }).update({ next_attempt_at: null });
    await send(root, 'delete', '/api/vault/database/engines/reports').expect(204);
    expect(fake.users.has(lease.username)).toBe(false);
  });
});

// ---------- B-1705: vault references in stores, connections, MCP and workflow HTTP steps ----------

describe('sprint 25c: vault references (B-1705)', () => {
  it('parses references and keeps env: and file: as they were', async () => {
    expect(secretRefProblem('vault:apps/hr#url')).toBeNull();
    expect(secretRefProblem('vault:Apps/HR#url')).toMatch(/Vault references/);
    expect(secretRefProblem('vault:apps/hr')).toMatch(/Vault references/);
    expect(secretRefProblem('env:SOMETHING_ELSE')).toMatch(/SECRET_REF_ENV/);
    expect(vaultRefsIn({ a: 'vault:x#y', b: ['env:Z', { c: 'vault:q/r#s' }], n: 1 })).toEqual(['vault:x#y', 'vault:q/r#s']);
    expect(await resolveSecretRef('vault:x#y', async (r) => `value of ${r}`)).toBe('value of vault:x#y');
    await expect(resolveSecretRef('vault:x#y', null)).rejects.toThrow(/no owner/);
    expect(headerVaultRef('Bearer vault:apps/crm#token')).toEqual({ prefix: 'Bearer ', ref: 'vault:apps/crm#token' });
    expect(headerVaultRef('Bearer abc')).toBeNull();
  });

  let h: Harness;
  let root: Client;
  let rootId: string;
  let dir: string;
  let hook: Server;
  let hookUrl: string;
  let hookAuth: (string | undefined)[];
  let mcp: FakeMcp;

  beforeEach(async () => {
    h = await harness({ WORKFLOW_HTTP_ALLOW_LOOPBACK: 'true', CONNECTIONS_ALLOWED_HOSTS: 'db.data.internal', MCP_ALLOWED_HOSTS: '127.0.0.1' }, { drivers: { postgres: (spec) => new SpecDriver(spec) } });
    rootId = (await localUser(h, 'root', ['system-admin'], 'restricted')).id;
    root = await loginAdmin(h, 'root');
    // Write access everywhere, read nowhere yet: each test grants the read it needs.
    await send(root, 'post', '/api/vault/policies', { subjectKind: 'user', subject: rootId, path: 'kv', capabilities: ['write', 'list'], effect: 'allow' }).expect(201);
    SpecDriver.specs = [];
    hookAuth = [];
    hook = createServer((req, res) => {
      hookAuth.push(req.headers.authorization);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r));
    hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    hook.close();
    await mcp?.stop?.();
    await h.close();
  });

  const grantRead = async (p: string) => (await send(root, 'post', '/api/vault/policies', { subjectKind: 'user', subject: rootId, path: p, capabilities: ['read'], effect: 'allow' }).expect(201)).body as { id: string };

  it('user stores: refused at save without read, resolved as the saving admin at sign-in, refused once the grant goes', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'exprsn-vref-'));
    try {
      const file = path.join(dir, 'hr.sqlite');
      const db = new Database(file);
      db.exec('CREATE TABLE staff (id INTEGER PRIMARY KEY, login TEXT, pw TEXT)');
      db.prepare('INSERT INTO staff (login, pw) VALUES (?, ?)').run('hruser', await hashPassword(PASSWORD));
      db.close();
      await send(root, 'put', '/api/vault/kv/data/stores/hr', { data: { file } }).expect(201);
      const store = { name: 'HR vault', kind: 'sql', position: 5, enabled: true, config: { dialect: 'sqlite', connection: 'vault:stores/hr#file', table: 'staff', columns: { id: 'id', username: 'login', passwordHash: 'pw' } } };
      const refused = await send(root, 'post', '/api/admin/identity-providers', store).expect(403);
      expect(refused.body).toMatchObject({ step: 'vault-policy', path: 'kv/stores/hr', capability: 'read' });
      const grant = await grantRead('kv/stores');
      const created = (await send(root, 'post', '/api/admin/identity-providers', store).expect(201)).body;
      expect((await h.s.providers.get(h.tenantId, created.id))!.vault_owner).toBe(rootId);
      const ok = await send(root, 'post', '/api/admin/test-login', { username: 'hruser', password: PASSWORD }).expect(200);
      expect(ok.body).toMatchObject({ result: 'ok', provider: { id: created.id } });
      const reads = await h.s.audit.list(h.tenantId, { action: 'vault.secret.read' });
      expect(reads[0]).toMatchObject({ target: { path: 'stores/hr' }, actor: { user: rootId, via: `identity-provider:${created.id}` } });
      // The owner loses read: the store no longer resolves its database.
      await send(root, 'delete', `/api/vault/policies/${grant.id}`).expect(204);
      await h.s.providers.update(h.tenantId, created.id, { position: 6 }); // a new row version rebuilds the provider
      const r = await h.s.chain.authenticate(h.tenantId, 'hruser', PASSWORD);
      expect(r.status).toBe('not_found');
      expect(r.status === 'not_found' && r.errors.map((e) => e.message).join(' ')).toMatch(/could not be read from the vault/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('data connections: a vault password is refused at save without read and at use once the grant goes', async () => {
    await send(root, 'put', '/api/vault/kv/data/apps/db', { data: { password: 'conn-pw-from-vault' } }).expect(201);
    const body = { name: 'orders', engine: 'postgres', endpoint: 'db.data.internal:5432', database: 'shop', zone: 'data', label: 'internal', username: 'reader', password: 'vault:apps/db#password' };
    await send(root, 'post', '/api/admin/connections', body).expect(403);
    const grant = await grantRead('kv/apps');
    const conn = (await send(root, 'post', '/api/admin/connections', body).expect(201)).body;
    expect(conn).toMatchObject({ passwordFromVault: true, hasCredential: true });
    expect((await send(root, 'post', `/api/admin/connections/${conn.id}/test`).expect(200)).body.ok).toBe(true);
    expect(SpecDriver.specs.at(-1)).toMatchObject({ username: 'reader', password: 'conn-pw-from-vault' });
    await send(root, 'post', `/api/admin/connections/${conn.id}/schema`).expect(200);
    await send(root, 'put', `/api/admin/connections/${conn.id}/allow-list`, { objects: ['orders'], piiColumns: [] }).expect(200);
    await send(root, 'post', `/api/admin/connections/${conn.id}/query`, { query: 'SELECT id FROM orders' }).expect(200);
    await send(root, 'delete', `/api/vault/policies/${grant.id}`).expect(204);
    const atUse = await send(root, 'post', `/api/admin/connections/${conn.id}/query`, { query: 'SELECT id FROM orders' }).expect(403);
    expect(atUse.body).toMatchObject({ step: 'vault-policy' });
    expect((await h.s.audit.list(h.tenantId, { action: 'connection.query.refused' })).length).toBe(1);
    // Rotating to a reference checks it at save as well.
    await send(root, 'put', `/api/admin/connections/${conn.id}/credential`, { username: 'reader', password: 'vault:apps/db#password' }).expect(403);
  });

  it('MCP servers: a vault service token is refused at save without read and sent as the bearer token with it', async () => {
    mcp = await new FakeMcp().start();
    mcp.token = 'mcp-token-from-vault';
    mcp.tools = [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }];
    await send(root, 'put', '/api/vault/kv/data/apps/mcp', { data: { token: 'mcp-token-from-vault' } }).expect(201);
    const body = { name: 'tools', url: mcp.url, zone: 'sandbox', auth: 'service', credential: 'vault:apps/mcp#token' };
    await send(root, 'post', '/api/admin/mcp-servers', body).expect(403);
    const grant = await grantRead('kv/apps/mcp');
    const srv = (await send(root, 'post', '/api/admin/mcp-servers', body).expect(201)).body;
    expect(srv.health).toBe('healthy');
    expect((await h.s.db('mcp_servers').where({ id: srv.id }).first()).vault_owner).toBe(rootId);
    // At use: without the grant the token is not read, so the handshake is never authorised.
    await send(root, 'delete', `/api/vault/policies/${grant.id}`).expect(204);
    const check = (await send(root, 'post', `/api/admin/mcp-servers/${srv.id}/check`).expect(200)).body;
    expect(JSON.stringify(check)).toMatch(/vault-policy|No vault policy grants read/);
    await send(root, 'put', `/api/admin/mcp-servers/${srv.id}/credential`, { secret: 'vault:apps/mcp#token' }).expect(403);
  });

  it('workflow HTTP steps: Authorization takes only a vault reference, checked at save and resolved per run', async () => {
    await send(root, 'put', '/api/vault/kv/data/apps/crm', { data: { token: 'crm-token-1' } }).expect(201);
    const w = (await send(root, 'post', '/api/workflows', { name: 'crm-sync', label: 'internal' }).expect(201)).body;
    const graph = (auth: string): WfGraph => ({
      nodes: [
        { id: 'trigger', kind: 'trigger', title: 'Trigger', x: 0, y: 0, config: {} },
        { id: 'call', kind: 'http', title: 'Call CRM', x: 0, y: 0, config: { method: 'GET', url: `${hookUrl}/crm`, headers: { Authorization: auth } } }
      ],
      edges: [{ from: 'trigger', to: 'call' }],
      limits: {}
    });
    await send(root, 'put', `/api/workflows/${w.id}/draft`, { graph: graph('Bearer literal-token') }).expect(400);
    await send(root, 'put', `/api/workflows/${w.id}/draft`, { graph: graph('Bearer vault:apps/crm#token') }).expect(403);
    const grant = await grantRead('kv/apps/crm');
    await send(root, 'put', `/api/workflows/${w.id}/draft`, { graph: graph('Bearer vault:apps/crm#token') }).expect(200);
    const draft = await h.s.db('workflows').where({ id: w.id }).first();
    expect(String(draft.draft)).not.toContain('crm-token-1');
    await send(root, 'post', `/api/workflows/${w.id}/publish`).expect(200);
    const run = (await send(root, 'post', `/api/workflows/${w.id}/runs`, { input: {} }).expect(202)).body;
    await h.s.jobs.runDue();
    const done = (await root.agent.get(`/api/workflow-runs/${run.id}`).expect(200)).body;
    expect(done.state).toBe('succeeded');
    expect(hookAuth).toEqual(['Bearer crm-token-1']);
    expect(JSON.stringify(done)).not.toContain('crm-token-1');
    // At use: the runner's grant is gone, the step fails and the call is never made.
    await send(root, 'delete', `/api/vault/policies/${grant.id}`).expect(204);
    const run2 = (await send(root, 'post', `/api/workflows/${w.id}/runs`, { input: {} }).expect(202)).body;
    await h.s.jobs.runDue();
    const failed = (await root.agent.get(`/api/workflow-runs/${run2.id}`).expect(200)).body;
    expect(failed.state).toBe('failed');
    expect(failed.steps.find((s: { nodeId: string }) => s.nodeId === 'call').error).toMatch(/could not be read from the vault/);
    expect(hookAuth).toHaveLength(1);
  });
});

/** A PostgreSQL driver stand-in that records the spec it was given (the resolved credential). */
class SpecDriver implements DataDriver {
  static specs: ConnectionSpec[] = [];
  constructor(spec: ConnectionSpec) {
    SpecDriver.specs.push(spec);
  }
  async test() {
    return { version: 'PostgreSQL 17', readOnly: true, detail: 'ok', health: 'healthy' as const };
  }
  async introspect() {
    return [{ name: 'orders', kind: 'table' as const, columns: [{ name: 'id', type: 'int' }] }];
  }
  async query() {
    return { columns: ['id'], rows: [[1]], capped: false, estimate: null };
  }
  async rows() {
    return { columns: ['id'], rows: [[1]], capped: false, estimate: null };
  }
}

// ---------- B-1706: rotation schedules and notices ----------

describe('sprint 25c: rotation schedules (B-1706)', () => {
  let h: Harness;
  let root: Client;
  let rootId: string;
  let otherId: string;

  beforeAll(async () => {
    h = await harness({ VAULT_ROTATION_NOTICE_DAYS: '7' });
    rootId = (await localUser(h, 'root', ['system-admin'], 'restricted')).id;
    otherId = (await localUser(h, 'keeper', ['member'], 'internal')).id;
    root = await loginAdmin(h, 'root');
    await send(root, 'post', '/api/vault/policies', { subjectKind: 'user', subject: rootId, path: '*', capabilities: ['*'], effect: 'allow' }).expect(201);
  });
  afterAll(() => h.close());

  const DAY = 86_400_000;
  const notes = async (userId: string) => (await h.s.db('notifications').where({ user_id: userId, kind: 'vault' }).orderBy('created_at', 'asc')) as { title: string; body: string }[];

  it('a secret past its rotation period notifies its owner, once per stage and version', async () => {
    await send(root, 'put', '/api/vault/kv/data/apps/api', { data: { key: 'v1' } }).expect(201);
    const meta = (await send(root, 'patch', '/api/vault/kv/metadata/apps/api', { rotationPeriodDays: 30 }).expect(200)).body;
    expect(meta).toMatchObject({ rotationPeriodDays: 30, owner: rootId });
    expect(meta.rotationDueAt - meta.rotatedAt).toBe(30 * DAY);
    const now = Date.now();
    expect(await h.s.rotation.check(h.tenantId, now)).toMatchObject({ checked: 1, notices: 0 });
    expect(await h.s.rotation.check(h.tenantId, now + 25 * DAY)).toMatchObject({ notices: 1 });
    expect(await h.s.rotation.check(h.tenantId, now + 26 * DAY)).toMatchObject({ notices: 0 });
    expect(await h.s.rotation.check(h.tenantId, now + 31 * DAY)).toMatchObject({ notices: 1 });
    expect(await h.s.rotation.check(h.tenantId, now + 40 * DAY)).toMatchObject({ notices: 0 });
    const got = await notes(rootId);
    expect(got.map((n) => n.title)).toEqual(['Rotate secret apps/api within 5 days', 'Rotate secret apps/api: it is past its rotation period']);
    expect(JSON.stringify(got)).not.toContain('v1');
    expect(await h.s.audit.list(h.tenantId, { action: 'vault.rotation.overdue' })).toHaveLength(1);
    // A new version starts the schedule again.
    await send(root, 'put', '/api/vault/kv/data/apps/api', { data: { key: 'v2' } }).expect(200);
    expect(await h.s.rotation.check(h.tenantId, now + 40 * DAY)).toMatchObject({ notices: 1 });
    // Notices go to the owner when one is set.
    await send(root, 'patch', '/api/vault/kv/metadata/apps/api', { owner: otherId }).expect(200);
    await send(root, 'put', '/api/vault/kv/data/apps/api', { data: { key: 'v3' } }).expect(200);
    expect(await h.s.rotation.check(h.tenantId, now + 40 * DAY)).toMatchObject({ notices: 1 });
    expect((await notes(otherId)).map((n) => n.title)).toEqual(['Rotate secret apps/api: it is past its rotation period']);
    // Clearing the schedule stops the notices.
    await send(root, 'patch', '/api/vault/kv/metadata/apps/api', { rotationPeriodDays: null }).expect(200);
    expect(await h.s.rotation.check(h.tenantId, now + 400 * DAY)).toMatchObject({ checked: 0 });
  });

  it('transit keys get notices, or are rotated on schedule with autoRotate', async () => {
    await send(root, 'post', '/api/vault/transit/keys', { name: 'payments' }).expect(201);
    await send(root, 'post', '/api/vault/transit/keys', { name: 'tokens' }).expect(201);
    await send(root, 'patch', '/api/vault/transit/keys/payments', { rotationPeriodDays: 90 }).expect(200);
    const auto = (await send(root, 'patch', '/api/vault/transit/keys/tokens', { rotationPeriodDays: 90, autoRotate: true }).expect(200)).body;
    expect(auto).toMatchObject({ rotationPeriodDays: 90, autoRotate: true, latestVersion: 1 });
    const out = await h.s.rotation.check(h.tenantId, Date.now() + 91 * DAY);
    expect(out).toMatchObject({ rotated: 1 });
    expect((await root.agent.get('/api/vault/transit/keys/tokens').expect(200)).body.latestVersion).toBe(2);
    expect((await root.agent.get('/api/vault/transit/keys/payments').expect(200)).body.latestVersion).toBe(1);
    const titles = (await notes(rootId)).map((n) => n.title);
    expect(titles).toContain('Rotate transit key payments: it is past its rotation period');
    expect(titles).toContain('Transit key tokens was rotated on schedule');
    const rotated = await h.s.audit.list(h.tenantId, { action: 'vault.transit.key.rotated' });
    expect(rotated[0]).toMatchObject({ actor: { service: 'vault.rotation' }, detail: { scheduled: true, from: 1, to: 2 } });
  });
});
