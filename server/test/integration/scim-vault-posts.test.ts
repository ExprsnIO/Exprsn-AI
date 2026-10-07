/*
 * 1.6.0, Sprint 37c against real databases. Each block runs when its variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 039c_scim_vault_posts; B-7201/B-7202: SCIM users and groups (the
 *                                  case-insensitive userName key, filters asked of the database and evaluated in
 *                                  memory, paging, group membership mapped to roles, deactivation ending sessions,
 *                                  delete); B-4801: a share as a policy grant with an expiry, a deny that wins; B-4901:
 *                                  an unlisted post out of every feed query, a quote embedding its original.
 */
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { loadPrincipal } from '../../src/http/middleware.js';
import { ENTERPRISE_SCHEMA, USER_SCHEMA } from '../../src/identity/scim/filter.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import { testConfig } from '../helpers.js';

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`Sprint 37c on ${d.name}`, () => {
    it('migrates 039c_scim_vault_posts and provisions over SCIM, shares a secret and keeps unlisted posts out of feeds', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url! });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      try {
        for (const t of ['scim_tokens', 'scim_users', 'scim_groups', 'scim_group_members']) expect(await db.schema.hasTable(t), t).toBe(true);
        for (const [t, c] of [['vault_policies', 'share_secret_id'], ['vault_policies', 'expires_at'], ['feed_posts', 'visibility'], ['feed_posts', 'quote_of']] as const) expect(await db.schema.hasColumn(t, c), `${t}.${c}`).toBe(true);
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const ws = await s.tenants.createWorkspace(tenant.id, 'Finance', 'confidential');
        const person = async (username: string, roles: string[]) => {
          const u = await s.users.create(tenant.id, { username, displayName: username.toUpperCase(), clearance: 'confidential' });
          await s.users.update(tenant.id, u.id, { clearance_direct: 'confidential' });
          await s.users.setRoles(u.id, 'direct', roles);
          await s.tenants.addMember(ws.id, u.id);
          const p = (await loadPrincipal(s, tenant.id, u.id, {}))!;
          p.workspaceId = ws.id;
          return { u, p };
        };
        const root = await person('root', ['tenant-admin']);

        // ---- B-7201, B-7202: SCIM ----
        const store = await s.providers.create(tenant.id, { name: 'Entra ID', kind: 'scim', position: 50, enabled: true, config: { defaultRoles: [] }, vaultOwner: null });
        await s.users.addMapping(tenant.id, { providerId: store.id, group: 'Finance Analysts', role: 'knowledge-curator', clearance: 'confidential', workspaceId: ws.id });
        const { token } = await s.scim.createToken(root.p, store.id, { name: 'it' }, {});
        const c = await s.scim.authenticate(`Bearer ${token}`, '127.0.0.1', null);
        const mk = (userName: string, ext: string) => ({ schemas: [USER_SCHEMA, ENTERPRISE_SCHEMA], userName, externalId: ext, displayName: userName, emails: [{ type: 'work', value: userName, primary: true }], [ENTERPRISE_SCHEMA]: { department: 'Treasury' } });
        const a = (await s.scim.createUser(c, mk('Ann.Lee@Contoso.com', 'E-1'))).resource;
        const b = (await s.scim.createUser(c, mk('bo@contoso.com', 'E-2'))).resource;
        await expect(s.scim.createUser(c, mk('ann.lee@contoso.COM', 'E-3'))).rejects.toMatchObject({ status: 409, scimType: 'uniqueness' });
        expect((await s.scim.listUsers(c, { filter: 'userName eq "ANN.LEE@contoso.com"' })).totalResults).toBe(1);
        expect((await s.scim.listUsers(c, { filter: 'externalId eq "E-2"' })).Resources.map((r) => r.id)).toEqual([b.id]);
        expect((await s.scim.listUsers(c, { filter: `${ENTERPRISE_SCHEMA}:department eq "treasury" and emails[value ew "contoso.com"]` })).totalResults).toBe(2);
        expect((await s.scim.listUsers(c, { startIndex: 2, count: 1 })).Resources.map((r) => r.id)).toEqual([b.id]);
        const g = (await s.scim.createGroup(c, { displayName: 'Finance Analysts', members: [{ value: a.id as string }] })).resource;
        expect(await s.users.roleIds(a.id as string)).toEqual(['knowledge-curator']);
        expect(await s.users.workspaceIds(a.id as string)).toContain(ws.id);
        await s.scim.patchGroup(c, g.id as string, { Operations: [{ op: 'Add', path: 'members', value: [{ value: b.id }] }, { op: 'Remove', path: 'members', value: [{ value: a.id }] }] });
        expect(await s.users.roleIds(a.id as string)).toEqual([]);
        expect(await s.users.roleIds(b.id as string)).toEqual(['knowledge-curator']);
        expect((await s.scim.listGroups(c, { filter: 'displayName eq "finance analysts"', excludedAttributes: 'members' })).Resources[0]).not.toHaveProperty('members');
        const sess = await s.sessions.create({ userId: b.id as string, tenantId: tenant.id, stage: 'active', method: 'test', providerId: null, ip: null, userAgent: null, mfaVerified: false });
        await s.scim.patchUser(c, b.id as string, { Operations: [{ op: 'Replace', path: 'active', value: 'False' }] });
        expect((await s.sessions.get(tenant.id, sess.session.id))!.revoked_at).not.toBeNull();
        expect((await s.users.get(tenant.id, b.id as string))!.state).toBe('disabled');
        await s.scim.deleteUser(c, a.id as string);
        await expect(s.scim.getUser(c, a.id as string)).rejects.toMatchObject({ status: 404 });

        // ---- B-4801: a share is a grant; a deny wins; an expired share stops applying ----
        const mel = await person('mel', ['member']);
        const bob = await person('bob', ['member']);
        const rc = await s.vault.callerFor(root.p);
        await s.vault.createGrant(rc, { subjectKind: 'user', subject: root.u.id, path: '*', capabilities: ['*'], effect: 'allow' });
        await s.vault.write(rc, 'apps/stripe', { key: 'sk' }, { label: 'confidential' });
        const share = await s.vaultShares.share(rc, 'apps/stripe', { subjectKind: 'workspace', subject: ws.id, expiresInDays: 1 });
        await s.vault.createGrant(rc, { subjectKind: 'user', subject: bob.u.id, path: 'kv/apps', capabilities: ['read'], effect: 'deny' });
        expect((await s.vault.read(await s.vault.callerFor(mel.p), 'apps/stripe')).data).toEqual({ key: 'sk' });
        await expect(s.vault.read(await s.vault.callerFor(bob.p), 'apps/stripe')).rejects.toMatchObject({ status: 403 });
        await db('vault_policies').where({ id: share.id }).update({ expires_at: Date.now() - 1 });
        await expect(s.vault.read(await s.vault.callerFor(mel.p), 'apps/stripe')).rejects.toMatchObject({ status: 403 });
        expect(await s.vaultShares.expire()).toBe(1);

        // ---- B-4901: unlisted posts and quotes ----
        const ctx = (p: typeof mel.p) => ({ p, ip: null });
        const listed = await s.feed.createPost(ctx(mel.p), { workspaceId: ws.id, body: 'Plan #q4' });
        const hidden = await s.feed.createPost(ctx(mel.p), { workspaceId: ws.id, body: 'By link #q4', visibility: 'unlisted' });
        const feed = (await s.feed.workspace(root.p, ws.id, {})).items.map((x) => x.id);
        expect(feed).toContain(listed.id);
        expect(feed).not.toContain(hidden.id);
        expect((await s.feed.tag(root.p, 'q4', null, {})).items.map((x) => x.id)).toEqual([listed.id]);
        expect((await s.feed.view(root.p, hidden.id)).visibility).toBe('unlisted');
        const q = await s.feed.quote(ctx(root.p), listed.id, { body: 'Read this' });
        expect(q).toMatchObject({ quoteOf: listed.id, quoted: expect.objectContaining({ id: listed.id }) });
        expect((await s.feed.view(root.p, listed.id)).counts.quotes).toBe(1);
      } finally {
        await s.close();
        await db.destroy();
      }
    }, 120_000);
  });
}
