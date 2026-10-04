/*
 * Sprint 26a (1.4.0) against real databases. Each block runs when its variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 028_identity; a sign-up refused outside the domain list and accepted
 *                                  inside it; a verification link that works once; an invitation accepted with a new
 *                                  account; a trusted device forgotten when the sessions are revoked; a CSV dry run
 *                                  that changes nothing, then the real run
 */
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { migrateCheck } from '../../src/db/schema.js';
import { loadPrincipal } from '../../src/http/middleware.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import { FakeMail } from '../fake-account.js';
import { testConfig } from '../helpers.js';

const STRONG = 'a much longer passphrase for sign-up 26';
const tokenOf = (text: string, param: string) => new RegExp(`[#&?]${param}=([A-Za-z0-9_-]{43})`).exec(text)![1]!;

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`identity gaps on ${d.name}`, () => {
    it('migrates 028_identity and runs sign-up, verification, invitations, trusted devices and imports', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url! });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const mail = new FakeMail();
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics(), { mail });
      try {
        const names = await migrationSource.getMigrations([]);
        expect(names).toContain('028_identity');
        expect(await migrateCheck(db)).toMatchObject({ state: 'current', pending: [], database: names.at(-1), destructive: [] });
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;

        // B-1801 and B-1802: a domain list, then a verified sign-up
        await s.identityPolicy.setSignup(tenant.id, { mode: 'open', domains: ['example.com'], requireEmailVerification: true, roles: ['member'], clearance: 'internal', workspaceId: null }, null);
        await expect(s.signup.register(tenant, { username: 'outsider', displayName: 'Out', email: 'o@elsewhere.net', password: STRONG }, { ip: null })).rejects.toMatchObject({ status: 403 });
        const r = await s.signup.register(tenant, { username: 'insider', displayName: 'In', email: 'in@example.com', password: STRONG }, { ip: null });
        expect(r).toMatchObject({ state: 'active', verification: 'sent' });
        const user = (await s.users.byUsername(tenant.id, 'insider'))!;
        const policy = await s.identityPolicy.get(tenant.id);
        expect(await s.signup.needsVerification(policy, user)).toBe(true);
        const token = tokenOf((await mail.next('in@example.com')).text, 'verify');
        await s.signup.verify(token);
        await expect(s.signup.verify(token)).rejects.toMatchObject({ status: 400 });
        expect(await s.signup.needsVerification(policy, user)).toBe(false);

        // B-1801: an invitation accepted with a new account
        const admin = await s.users.create(tenant.id, { username: 'boss', displayName: 'Boss', clearance: 'confidential' });
        await s.users.setRoles(admin.id, 'direct', ['tenant-admin']);
        const p = (await loadPrincipal(s, tenant.id, admin.id, {}))!;
        const ws = await s.tenants.createWorkspace(tenant.id, 'Research', 'internal');
        const inv = await s.signup.invite(p, { email: 'guest@partner.test', workspaceId: ws.id, roles: ['knowledge-curator'], clearance: 'internal' }, { ip: null });
        expect(inv.sent).toBe(true);
        const invToken = tokenOf((await mail.next('guest@partner.test')).text, 'invitation');
        const accepted = await s.signup.acceptNew(invToken, { username: 'guest', displayName: 'Guest', password: STRONG }, { ip: null });
        expect(await s.users.roleIds(accepted.user.id)).toEqual(['knowledge-curator']);
        expect(await s.users.workspaceIds(accepted.user.id)).toEqual([ws.id]);
        await expect(s.signup.preview(invToken)).rejects.toMatchObject({ status: 400 });

        // B-1803: a trusted device row goes with the user's sessions
        await db('trusted_devices').insert({ id: 'd'.repeat(64), tenant_id: tenant.id, user_id: user.id, session_id: null, browser: 'test', created_at: Date.now(), expires_at: Date.now() + 3600_000 });
        await s.sessions.revokeAllForUser(user.id);
        expect(await db('trusted_devices').where({ user_id: user.id }).first()).toBeUndefined();

        // B-1805: a dry run changes nothing; the real run applies
        const csv = 'kind,username,display_name,email,roles,clearance,workspace\nuser,ada,Ada,ada@example.com,member,internal,\nuser,insider,In,,member,internal,\nmembership,ada,,,,,research\n';
        const before = (await db('users').count({ n: '*' }).first()) as { n: number | string };
        const dry = await s.userImports.run({ kind: 'cli', tenantId: tenant.id }, csv, { dryRun: true, sendInvites: false });
        expect(dry.summary).toMatchObject({ create: 2, applied: 0 });
        expect(((await db('users').count({ n: '*' }).first()) as { n: number | string }).n).toEqual(before.n);
        const real = await s.userImports.run({ kind: 'cli', tenantId: tenant.id }, csv, { dryRun: false, sendInvites: false });
        expect(real.summary.applied).toBe(2);
        const ada = (await s.users.byUsername(tenant.id, 'ada'))!;
        expect(await s.users.workspaceIds(ada.id)).toEqual([ws.id]);
      } finally {
        await s.close();
        await db.destroy();
      }
    }, 120_000);
  });
}
