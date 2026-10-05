import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { escapeFilterValue, LdapProvider, renderFilter } from '../src/identity/providers/ldap.js';
import { SqlProvider, parseGroups } from '../src/identity/providers/sql.js';
import { ldapConfigSchema, sqlConfigSchema, type Step } from '../src/identity/providers/types.js';
import { hashPassword } from '../src/identity/passwords.js';
import { provision } from '../src/identity/provisioning.js';
import { configureSecretPolicy, secretPolicy } from '../src/identity/secrets.js';
import { SERVER_ENV_NAMES } from '../src/config/index.js';
import { parseAllowList } from '../src/mcp/hosts.js';
import { harness, localUser, PASSWORD, type Harness } from './helpers.js';

// These suites build providers without a server, so they set the secret policy the server would.
configureSecretPolicy(secretPolicy({ envAllow: 'LDAP_*,HR_*,NOT_SET_ANYWHERE', dirs: '', serverEnvNames: SERVER_ENV_NAMES, serverSecretFiles: [] }));

describe('LDAP filter escaping (RFC 4515)', () => {
  it('escapes filter metacharacters', () => {
    expect(escapeFilterValue('a*b(c)d\\e\0')).toBe('a\\2ab\\28c\\29d\\5ce\\00');
  });

  it('cannot be used to widen the user filter', () => {
    expect(renderFilter('(&(objectClass=inetOrgPerson)(uid={{username}}))', { username: '*)(uid=*' })).toBe('(&(objectClass=inetOrgPerson)(uid=\\2a\\29\\28uid=\\2a))');
  });
});

describe('LDAP provider', () => {
  const base = { url: 'ldap://ldap.internal:389', bindDN: 'cn=svc,dc=corp', bindPassword: 'env:LDAP_PW', userBase: 'ou=people,dc=corp', groupBase: 'ou=groups,dc=corp' };

  it('refuses ldap:// without StartTLS', () => {
    expect(() => new LdapProvider('p', 'dir', ldapConfigSchema.parse(base), false)).toThrow(/refused/);
  });

  it('allows ldap:// for development only when asked', () => {
    const cfg = ldapConfigSchema.parse({ ...base, allowInsecure: true });
    expect(() => new LdapProvider('p', 'dir', cfg, false)).not.toThrow();
    expect(() => new LdapProvider('p', 'dir', cfg, true)).toThrow(/refused/);
  });

  it('rejects an empty password without contacting the server (unauthenticated bind)', async () => {
    const p = new LdapProvider('p', 'dir', ldapConfigSchema.parse({ ...base, url: 'ldaps://127.0.0.1:1' }), true);
    expect(await p.authenticate('mokafor', '')).toEqual({ status: 'invalid' });
  });

  it('reports an unreachable server as an error, not a wrong password', async () => {
    process.env.LDAP_PW = 'x';
    const p = new LdapProvider('p', 'dir', ldapConfigSchema.parse({ ...base, url: 'ldaps://127.0.0.1:1', timeoutMs: 500 }), true);
    const res = await p.authenticate('mokafor', 'pw');
    expect(res.status).toBe('error');
  });

  it('requires secret references rather than inline secrets', () => {
    expect(() => ldapConfigSchema.parse({ ...base, bindPassword: 'hunter2' })).toThrow();
  });

  it('refuses references to the server\'s own secrets and to variables the operator has not listed', () => {
    expect(() => ldapConfigSchema.parse({ ...base, bindPassword: 'env:DATA_KEY' })).toThrow(/server's own settings/);
    expect(() => ldapConfigSchema.parse({ ...base, bindPassword: 'env:HOME' })).toThrow(/SECRET_REF_ENV/);
    expect(() => ldapConfigSchema.parse({ ...base, bindPassword: 'file:/etc/passwd' })).toThrow(/SECRET_REF_DIRS/);
  });

  it('never binds to a public directory host, before the bind password leaves the server', async () => {
    process.env.LDAP_PW = 'x';
    const p = new LdapProvider('p', 'dir', ldapConfigSchema.parse({ ...base, url: 'ldaps://8.8.8.8:636', timeoutMs: 500 }), true);
    const steps: Step[] = [];
    expect((await p.authenticate('mokafor', 'pw', steps)).status).toBe('error');
    expect(steps[0]).toMatchObject({ title: 'Check the directory host', ok: false });
    expect(steps[0]!.detail).toMatch(/public address/);
    expect(steps.some((x) => x.title.startsWith('Service bind'))).toBe(false);
    const allowed = new LdapProvider('p', 'dir', ldapConfigSchema.parse({ ...base, url: 'ldaps://127.0.0.1:1', timeoutMs: 500 }), true, parseAllowList('8.8.8.8'));
    expect((await allowed.authenticate('mokafor', 'pw')).status).toBe('error');
  });
});

describe('SQL user-table provider (SQLite)', () => {
  let dir: string;
  let file: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'exprsn-sql-'));
    file = path.join(dir, 'hr.sqlite');
    const db = new Database(file);
    db.exec(`CREATE TABLE staff (id INTEGER PRIMARY KEY, login TEXT, pw TEXT, full_name TEXT, mail TEXT, inactive INTEGER, grp TEXT, boss TEXT);
             CREATE TABLE staff_groups (staff_id INTEGER, grp TEXT);`);
    const ins = db.prepare('INSERT INTO staff (login, pw, full_name, mail, inactive, grp) VALUES (?, ?, ?, ?, ?, ?)');
    ins.run('jdoe', bcrypt.hashSync(PASSWORD, 10), 'Jane Doe', 'jdoe@example.test', 0, 'finance-ops,people');
    ins.run('argon', await hashPassword(PASSWORD), 'Argon User', null, 0, '["a","b"]');
    ins.run('plain', PASSWORD, 'Plain Text', null, 0, null);
    ins.run('gone', bcrypt.hashSync(PASSWORD, 10), 'Gone', null, 1, null);
    db.prepare('INSERT INTO staff_groups VALUES (1, ?)').run('cn=ai-admins');
    db.prepare("UPDATE staff SET boss = '2' WHERE login = 'jdoe'").run();
    db.close();
    process.env.HR_DB = file;
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const provider = () =>
    new SqlProvider(
      'p1',
      'HR SQLite',
      sqlConfigSchema.parse({
        dialect: 'sqlite',
        connection: 'env:HR_DB',
        table: 'staff',
        columns: { id: 'id', username: 'login', passwordHash: 'pw', displayName: 'full_name', email: 'mail', disabled: 'inactive', groups: 'grp' },
        groupTable: { table: 'staff_groups', userColumn: 'staff_id', groupColumn: 'grp' }
      })
    );

  it('authenticates bcrypt rows and reads both group sources', async () => {
    const p = provider();
    const steps: Step[] = [];
    const r = await p.authenticate('JDoe', PASSWORD, steps);
    expect(r).toEqual({ status: 'ok', user: { externalId: '1', username: 'jdoe', displayName: 'Jane Doe', email: 'jdoe@example.test', groups: ['finance-ops', 'people', 'cn=ai-admins'] } });
    expect(steps.map((s) => s.title)).toContain('Verify bcrypt hash');
    await p.close();
  });

  it('authenticates argon2 rows and JSON group lists', async () => {
    const p = provider();
    const r = await p.authenticate('argon', PASSWORD);
    expect(r.status === 'ok' && r.user.groups).toEqual(['a', 'b']);
    await p.close();
  });

  it('never accepts plain-text or unknown hash formats', async () => {
    const p = provider();
    expect(await p.authenticate('plain', PASSWORD)).toEqual({ status: 'invalid' });
    await p.close();
  });

  it('distinguishes wrong password, disabled and unknown user', async () => {
    const p = provider();
    expect(await p.authenticate('jdoe', 'wrong password here')).toEqual({ status: 'invalid' });
    expect(await p.authenticate('gone', PASSWORD)).toEqual({ status: 'disabled' });
    expect(await p.authenticate('nobody', PASSWORD)).toEqual({ status: 'not_found' });
    await p.close();
  });

  it('binds usernames as parameters', async () => {
    const p = provider();
    expect(await p.authenticate("x' OR '1'='1", PASSWORD)).toEqual({ status: 'not_found' });
    await p.close();
  });

  it('refuses identifiers that are not plain SQL names', () => {
    expect(() => sqlConfigSchema.parse({ dialect: 'pg', connection: 'env:X', table: 'users; drop table users', columns: { username: 'u', passwordHash: 'p' } })).toThrow();
  });

  it('parses group columns', () => {
    expect(parseGroups('a, b,,c')).toEqual(['a', 'b', 'c']);
    expect(parseGroups('["x"]')).toEqual(['x']);
    expect(parseGroups(null)).toEqual([]);
  });

  describe('in the chain', () => {
    let h: Harness;
    beforeEach(async () => {
      h = await harness();
    });
    afterEach(() => h.close());

    const addSql = (position: number, name = 'HR SQLite') =>
      h.s.providers.create(h.tenantId, {
        name,
        kind: 'sql',
        position,
        enabled: true,
        config: { dialect: 'sqlite', connection: 'env:HR_DB', table: 'staff', columns: { id: 'id', username: 'login', passwordHash: 'pw', groups: 'grp' } }
      });

    it('moves past stores that do not know the user', async () => {
      await addSql(10);
      const r = await h.s.chain.authenticate(h.tenantId, 'jdoe', PASSWORD);
      expect(r.status).toBe('ok');
      expect(r.status === 'ok' && r.provider.kind).toBe('sql');
    });

    it('stops at the store that owns the username when the password is wrong', async () => {
      await localUser(h, 'jdoe', ['member']);
      await addSql(2000); // after the local store
      const r = await h.s.chain.authenticate(h.tenantId, 'jdoe', 'not the local password');
      expect(r).toMatchObject({ status: 'invalid' });
      expect(r.status === 'invalid' && r.provider.kind).toBe('local');
    });

    it('skips a broken store and reports it', async () => {
      await h.s.providers.create(h.tenantId, { name: 'Broken', kind: 'sql', position: 1, enabled: true, config: { dialect: 'sqlite', connection: 'env:NOT_SET_ANYWHERE', table: 'staff', columns: { username: 'login', passwordHash: 'pw' } } });
      await addSql(10);
      const r = await h.s.chain.authenticate(h.tenantId, 'jdoe', PASSWORD);
      expect(r.status).toBe('ok');
    });

    it('provisions from group mappings and refuses unmapped users', async () => {
      const store = await addSql(10);
      const ok = await h.s.chain.authenticate(h.tenantId, 'jdoe', PASSWORD);
      if (ok.status !== 'ok') throw new Error('expected ok');
      expect(await provision(h.s.users, h.tenantId, store, ok.user)).toMatchObject({ status: 'refused', reason: 'no_mapped_group' });

      await h.s.users.addMapping(h.tenantId, { providerId: null, group: 'finance-ops', role: 'member', clearance: 'confidential' });
      await h.s.users.addMapping(h.tenantId, { providerId: store.id, group: 'people', role: 'flag-reviewer', clearance: 'internal' });
      const p = await provision(h.s.users, h.tenantId, store, ok.user);
      expect(p).toMatchObject({ status: 'ok', roles: ['flag-reviewer', 'member'], created: true });
      expect(p.status === 'ok' && p.user.clearance).toBe('confidential');
    });

    it('keeps the manager a store names, from sign-in and directory sync, for access reviews (B-3305)', async () => {
      const store = await h.s.providers.create(h.tenantId, { name: 'HR with managers', kind: 'sql', position: 10, enabled: true, config: { dialect: 'sqlite', connection: 'env:HR_DB', table: 'staff', columns: { id: 'id', username: 'login', passwordHash: 'pw', groups: 'grp', manager: 'boss' } } });
      await h.s.users.addMapping(h.tenantId, { providerId: null, group: 'finance-ops', role: 'member', clearance: 'internal' });
      await h.s.users.addMapping(h.tenantId, { providerId: null, group: 'a', role: 'member', clearance: 'internal' });
      const signIn = async (username: string) => {
        const ok = await h.s.chain.authenticate(h.tenantId, username, PASSWORD);
        if (ok.status !== 'ok') throw new Error('expected ok');
        const p = await provision(h.s.users, h.tenantId, store, ok.user);
        if (p.status !== 'ok') throw new Error('expected ok');
        return { ext: ok.user, user: p.user };
      };
      const jdoe = await signIn('jdoe');
      expect(jdoe.ext.manager).toBe('2');
      // The manager is not a user yet: nobody is assigned.
      expect(await h.s.users.managerOf(h.tenantId, jdoe.user.id)).toBeNull();
      const argon = await signIn('argon');
      expect(argon.ext.manager).toBeNull();
      expect(await h.s.users.managerOf(h.tenantId, jdoe.user.id)).toBe(argon.user.id);
      expect(await h.s.users.managerOf(h.tenantId, argon.user.id)).toBeNull();
      // Directory sync follows a change in the store.
      const db = new Database(process.env.HR_DB!);
      db.prepare("UPDATE staff SET boss = NULL WHERE login = 'jdoe'").run();
      db.close();
      await h.s.sync.syncProvider(store);
      expect(await h.s.users.managerOf(h.tenantId, jdoe.user.id)).toBeNull();
      const db2 = new Database(process.env.HR_DB!);
      db2.prepare("UPDATE staff SET boss = '2' WHERE login = 'jdoe'").run();
      db2.close();
      await h.s.sync.syncProvider(store);
      expect(await h.s.users.managerOf(h.tenantId, jdoe.user.id)).toBe(argon.user.id);
    });

    it('refuses to merge a username that belongs to another store', async () => {
      await localUser(h, 'jdoe', ['member']);
      const store = await addSql(10);
      const ok = await h.s.chain.authenticate(h.tenantId, 'jdoe', PASSWORD);
      if (ok.status !== 'ok') throw new Error('expected ok');
      expect(await provision(h.s.users, h.tenantId, store, ok.user)).toMatchObject({ status: 'refused', reason: 'identity_conflict' });
    });
  });
});

describe('SQL user-table provider targets', () => {
  const cols = { username: 'login', passwordHash: 'pw' };

  it('refuses a database on a public host before connecting', async () => {
    process.env.HR_PUBLIC = 'postgres://reader:pw@8.8.8.8:5432/hr';
    const p = new SqlProvider('p', 'HR', sqlConfigSchema.parse({ dialect: 'pg', connection: 'env:HR_PUBLIC', table: 'staff', columns: cols, timeoutMs: 500 }));
    const steps: Step[] = [];
    expect(await p.test(steps)).toBe(false);
    expect(steps[0]).toMatchObject({ title: 'Check the database host', ok: false });
    expect(steps[0]!.detail).toMatch(/public address/);
    expect((await p.authenticate('jdoe', PASSWORD)).status).toBe('error');
    await p.close();
  });

  it('refuses a connection that is not a URL', async () => {
    process.env.HR_KV = 'host=10.0.0.1 user=reader';
    const p = new SqlProvider('p', 'HR', sqlConfigSchema.parse({ dialect: 'pg', connection: 'env:HR_KV', table: 'staff', columns: cols }));
    const steps: Step[] = [];
    expect(await p.test(steps)).toBe(false);
    expect(steps[0]!.detail).toMatch(/must be a URL/);
  });

  it('refuses the application\'s own SQLite database', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'exprsn-appdb-'));
    const appDb = path.join(dir, 'exprsn-ai.sqlite');
    new Database(appDb).close();
    process.env.HR_APPDB = appDb;
    const p = new SqlProvider('p', 'HR', sqlConfigSchema.parse({ dialect: 'sqlite', connection: 'env:HR_APPDB', table: 'local_credentials', columns: cols }), { allow: parseAllowList(''), refusedSqliteFiles: [appDb] });
    const steps: Step[] = [];
    expect(await p.test(steps)).toBe(false);
    expect(steps[0]!.detail).toMatch(/application's own database/);
    await p.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
