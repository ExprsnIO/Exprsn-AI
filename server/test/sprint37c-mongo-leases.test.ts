import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEASE_USER, mongoCommands, type DbAdmin, type EngineTarget, type LeaseGrant } from '../src/vault/db-engines.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * 1.6.0, Sprint 37c (B-4802): the MongoDB engine for database leases, beside PostgreSQL and MySQL (B-1704). The
 * commands are checked here and the lease lifecycle runs against an in-memory stand-in; the real server is in
 * test/integration/mongo-leases.test.ts (TEST_MONGODB_URL).
 */

const send = (c: Client, method: 'post' | 'put' | 'patch' | 'delete', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);

class FakeMongo {
  users = new Map<string, { db: string; password: string; validUntil: Date; grant: LeaseGrant }>();
  targets: EngineTarget[] = [];
  admins = (t: EngineTarget): DbAdmin => {
    this.targets.push(t);
    return {
      test: async () => ({ version: 'MongoDB 8.0.17', canCreate: true, detail: 'can create' }),
      createUser: async (u, pw, validUntil, grant) => {
        if (!LEASE_USER.test(u)) throw new Error('bad user');
        this.users.set(u, { db: t.database ?? 'admin', password: pw, validUntil, grant });
      },
      extend: async (u, validUntil) => {
        this.users.get(u)!.validUntil = validUntil;
      },
      dropUser: async (u) => {
        this.users.delete(u);
      },
      exists: async (u) => this.users.has(u)
    };
  };
}

describe('B-4802: MongoDB commands', () => {
  it('builds createUser, updateUser, killAllSessionsByPattern and dropUser documents from generated names only', () => {
    const until = new Date('2026-10-07T12:00:00.000Z');
    expect(mongoCommands.create('exai_reports_0123456789ab', 'pw-1', until, { privileges: 'read', schemas: ['shop', 'events'] })).toEqual({
      createUser: 'exai_reports_0123456789ab',
      pwd: 'pw-1',
      roles: [{ role: 'read', db: 'shop' }, { role: 'read', db: 'events' }],
      customData: { exprsnLease: true, validUntil: '2026-10-07T12:00:00.000Z' },
      mechanisms: ['SCRAM-SHA-256']
    });
    expect(mongoCommands.create('exai_rw_0123456789ab', 'pw', until, { privileges: 'readwrite', schemas: ['shop'] }).roles).toEqual([{ role: 'readWrite', db: 'shop' }]);
    expect(mongoCommands.extend('exai_rw_0123456789ab', until)).toEqual({ updateUser: 'exai_rw_0123456789ab', customData: { exprsnLease: true, validUntil: until.toISOString() } });
    expect(mongoCommands.killSessions('exai_rw_0123456789ab', 'admin')).toEqual({ killAllSessionsByPattern: [{ users: [{ user: 'exai_rw_0123456789ab', db: 'admin' }] }] });
    expect(mongoCommands.drop('exai_rw_0123456789ab')).toEqual({ dropUser: 'exai_rw_0123456789ab' });
    expect(() => mongoCommands.drop('root')).toThrow(/did not generate/);
    for (const db of ['admin', 'local', 'config', 'a$b']) expect(() => mongoCommands.create('exai_x_0123456789ab', 'pw', until, { privileges: 'read', schemas: [db] }), db).toThrow();
  });
});

describe('B-4802: MongoDB leases', () => {
  let h: Harness;
  let fake: FakeMongo;
  let root: Client;
  let dev: Client;
  let devId: string;

  beforeAll(async () => {
    fake = new FakeMongo();
    h = await harness({ CONNECTIONS_ALLOWED_HOSTS: 'mongo.data.internal' }, { dbAdmins: fake.admins });
    await localUser(h, 'root', ['system-admin'], 'restricted');
    devId = (await localUser(h, 'dev', ['member'], 'internal')).id;
    root = await loginAdmin(h, 'root');
    const l = await login(h, 'dev');
    dev = { agent: l.agent, csrf: l.csrf, cookie: l.cookie };
  });
  afterAll(() => h.close());

  it('registers a MongoDB engine, issues a lease, and an expired lease\'s user no longer exists', async () => {
    const engine = (await send(root, 'post', '/api/vault/database/engines', { name: 'events', dialect: 'mongodb', endpoint: 'mongo.data.internal:27017', zone: 'data', label: 'internal', adminUsername: 'admin/lease_admin', adminPassword: 'admin-secret-9', defaultTtlSeconds: 600, maxTtlSeconds: 3600 }).expect(201)).body;
    expect(engine).toMatchObject({ dialect: 'mongodb', database: 'admin', check: { version: 'MongoDB 8.0.17', canCreate: true } });
    // A role on an engine whose users live in admin names its databases, never admin, local or config.
    await send(root, 'put', '/api/vault/database/engines/events/roles/reader', { privileges: 'read' }).expect(400);
    await send(root, 'put', '/api/vault/database/engines/events/roles/reader', { privileges: 'read', schemas: ['admin'] }).expect(400);
    expect((await send(root, 'put', '/api/vault/database/engines/events/roles/reader', { privileges: 'read', schemas: ['shop', 'events'] }).expect(200)).body).toMatchObject({ privileges: 'read', schemas: ['shop', 'events'], policyPath: 'database/events/reader' });

    await send(dev, 'post', '/api/vault/database/creds/events/reader', {}).expect(403);
    await send(root, 'post', '/api/vault/policies', { subjectKind: 'user', subject: devId, path: 'database/events', capabilities: ['read', 'list'] }).expect(201);
    const lease = (await send(dev, 'post', '/api/vault/database/creds/events/reader', { ttlSeconds: 120 }).expect(201)).body;
    expect(lease).toMatchObject({ engine: 'events', role: 'reader', state: 'active', connection: { dialect: 'mongodb', endpoint: 'mongo.data.internal:27017', database: 'admin' } });
    expect(fake.users.get(lease.username)).toMatchObject({ db: 'admin', password: lease.password, grant: { privileges: 'read', schemas: ['shop', 'events'] } });
    expect(fake.targets.at(-1)).toMatchObject({ dialect: 'mongodb', adminUsername: 'admin/lease_admin', adminPassword: 'admin-secret-9' });

    // Renewal moves the expiry recorded on the account.
    await send(dev, 'post', `/api/vault/database/leases/${lease.id}/renew`, { incrementSeconds: 300 }).expect(200);
    expect(fake.users.get(lease.username)!.validUntil.getTime()).toBeGreaterThan(lease.expiresAt);

    // Past its expiry, the sweeper drops the account.
    await h.s.db('vault_db_leases').where({ id: lease.id }).update({ expires_at: Date.now() - 1000 });
    expect(await h.s.dbLeases.sweep(h.tenantId)).toEqual({ ended: 1, failed: 0 });
    expect(fake.users.has(lease.username)).toBe(false);
    expect((await dev.agent.get(`/api/vault/database/leases/${lease.id}`).expect(200)).body).toMatchObject({ state: 'expired', endReason: 'expired' });
    expect(await h.s.db('audit_events').where({ action: 'vault.database.lease.expired' })).toHaveLength(1);
  });
});
