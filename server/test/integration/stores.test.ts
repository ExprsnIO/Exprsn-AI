/*
 * Contract tests against real servers. Each block runs when its connection variable is set, and CI sets all of them
 * (see .github/workflows/ci.yml; locally: docker compose -f deploy/docker/compose.dev.yml up -d).
 *
 *   TEST_PG_URL      postgres://exprsn:exprsn@localhost:5432/exprsn_test      app database + SQL user table
 *   TEST_MYSQL_URL   mysql://exprsn:exprsn@localhost:3306/exprsn_test         app database + SQL user table
 *   TEST_LDAP_URL    ldap://localhost:389 (StartTLS) or ldaps://localhost:636 with the dev OpenLDAP seed
 */
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import knexFactory, { type Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, migrate } from '../../src/db/knex.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices, type Services } from '../../src/services.js';
import { bootstrap } from '../../src/bootstrap.js';
import { LdapProvider } from '../../src/identity/providers/ldap.js';
import { configureSecretPolicy, secretPolicy } from '../../src/identity/secrets.js';
import { SqlProvider } from '../../src/identity/providers/sql.js';
import { ldapConfigSchema, sqlConfigSchema } from '../../src/identity/providers/types.js';
import { provision } from '../../src/identity/provisioning.js';
import { testConfig } from '../helpers.js';

const PASSWORD = 'correct horse battery staple';

const dialects = [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
];

for (const d of dialects) {
  describe.skipIf(!d.url)(`${d.name}`, () => {
    let s: Services;
    let raw: Knex;
    const table = `hr_staff_${randomBytes(3).toString('hex')}`;

    beforeAll(async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url! });
      const db = createDb(cfg);
      // Start from an empty schema so the migration itself is exercised on this dialect.
      await db.migrate.rollback({ migrationSource: (await import('../../src/db/migrations/index.js')).migrationSource }, true).catch(() => undefined);
      await migrate(db);
      s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      await bootstrap(s);

      raw = knexFactory({ client: d.client === 'pg' ? 'pg' : 'mysql2', connection: d.url });
      await raw.schema.createTable(table, (t) => {
        t.increments('id');
        t.string('login', 100);
        t.string('pw', 255);
        t.string('full_name', 200);
        t.boolean('inactive').defaultTo(false);
        t.string('grp', 500);
      });
      await raw(table).insert([
        { login: 'JDoe', pw: bcrypt.hashSync(PASSWORD, 10), full_name: 'Jane Doe', inactive: false, grp: 'finance-ops' },
        { login: 'gone', pw: bcrypt.hashSync(PASSWORD, 10), full_name: 'Gone', inactive: true, grp: '' }
      ]);
      process.env[`HR_${d.client.toUpperCase()}_URL`] = d.url;
    });

    afterAll(async () => {
      await raw?.schema.dropTableIfExists(table);
      await raw?.destroy();
      await s?.chain.close();
      await s?.db.destroy();
    });

    it('runs the core migration and the audit chain', async () => {
      const t = await s.tenants.bySlug('default');
      for (let i = 0; i < 5; i++) await s.audit.append({ tenantId: t!.id, action: `test.${i}`, kind: 'system', actor: { service: 'test' }, detail: { n: i, nested: { a: [1, 2] } } });
      expect(await s.audit.verify(t!.id)).toMatchObject({ status: 'verified' });
    });

    it('authenticates against a user table in this engine and provisions the user', async () => {
      const cfg = sqlConfigSchema.parse({ dialect: d.client, connection: `env:HR_${d.client.toUpperCase()}_URL`, table, columns: { id: 'id', username: 'login', passwordHash: 'pw', displayName: 'full_name', disabled: 'inactive', groups: 'grp' } });
      const p = new SqlProvider('x', 'HR', cfg);
      expect(await p.test([])).toBe(true);
      const ok = await p.authenticate('jdoe', PASSWORD);
      expect(ok).toMatchObject({ status: 'ok', user: { username: 'JDoe', groups: ['finance-ops'] } });
      expect(await p.authenticate('jdoe', 'nope nope nope')).toEqual({ status: 'invalid' });
      expect(await p.authenticate('gone', PASSWORD)).toEqual({ status: 'disabled' });
      await p.close();

      const t = (await s.tenants.bySlug('default'))!;
      const row = await s.providers.create(t.id, { name: `HR ${table}`, kind: 'sql', position: 5, enabled: true, config: cfg });
      await s.users.addMapping(t.id, { providerId: row.id, group: 'finance-ops', role: 'member', clearance: 'confidential' });
      const res = await s.chain.authenticate(t.id, 'jdoe', PASSWORD);
      if (res.status !== 'ok') throw new Error(res.status);
      expect(await provision(s.users, t.id, row, res.user)).toMatchObject({ status: 'ok', roles: ['member'] });
    });
  });
}

describe.skipIf(!process.env.TEST_LDAP_URL)('OpenLDAP', () => {
  // These tests build the provider directly, without services, so they set the secret-reference policy themselves:
  // only the bind password variable may be referenced (the server refuses every reference until a policy exists).
  beforeAll(() => configureSecretPolicy(secretPolicy({ envAllow: 'TEST_LDAP_BIND_PW', dirs: '', serverEnvNames: new Set(), serverSecretFiles: [] })));

  // Matches deploy/docker/ldap/seed.ldif
  const cfg = () =>
    ldapConfigSchema.parse({
      url: process.env.TEST_LDAP_URL,
      startTLS: process.env.TEST_LDAP_STARTTLS === 'true',
      allowInsecure: process.env.TEST_LDAP_INSECURE === 'true',
      caFile: process.env.TEST_LDAP_CA,
      bindDN: 'cn=admin,dc=northwind,dc=local',
      bindPassword: 'env:TEST_LDAP_BIND_PW',
      userBase: 'ou=people,dc=northwind,dc=local',
      groupBase: 'ou=groups,dc=northwind,dc=local'
    });

  it('binds, finds the user, verifies the password and reads groups', async () => {
    const p = new LdapProvider('l', 'OpenLDAP', cfg(), false);
    expect(await p.test([])).toBe(true);
    const r = await p.authenticate('mokafor', 'Northwind-Dev-Password-1');
    expect(r).toMatchObject({ status: 'ok', user: { externalId: 'uid=mokafor,ou=people,dc=northwind,dc=local', displayName: 'Mara Okafor' } });
    expect(r.status === 'ok' && r.user.groups).toContain('cn=finance-ops,ou=groups,dc=northwind,dc=local');
  });

  it('distinguishes a wrong password from an unknown user', async () => {
    const p = new LdapProvider('l', 'OpenLDAP', cfg(), false);
    expect(await p.authenticate('mokafor', 'wrong')).toEqual({ status: 'invalid' });
    expect(await p.authenticate('nobody', 'wrong')).toEqual({ status: 'not_found' });
    expect(await p.authenticate('*', 'wrong')).toEqual({ status: 'not_found' });
  });
});
