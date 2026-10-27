/*
 * Sprint 29 (1.5.0), permission matrices, custom roles and access reviews, against real databases. Each block runs
 * when its variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 031_access; a custom role under dual control (proposed, refused to its
 *                                  proposer, approved by a second admin, versioned with a diff), granted and resolved
 *                                  through the policy; the effective-access matrix agreeing with policy.explain; who
 *                                  can; an access review opened, its revoke removing the grant for the next principal,
 *                                  closed with its counts (grouped counts come back as strings on PostgreSQL) and the
 *                                  next round scheduled; the overdue sweep escalating once
 */
import { describe, expect, it } from 'vitest';
import { explain, type Principal } from '../../src/authz/policy.js';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { loadPrincipal } from '../../src/http/middleware.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import { testConfig } from '../helpers.js';

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`access on ${d.name}`, () => {
    it('migrates 031_access and runs custom roles, the access matrix and access reviews', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url! });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      try {
        for (const t of ['custom_roles', 'custom_role_versions', 'access_reviews', 'access_review_items']) expect(await db.schema.hasTable(t)).toBe(true);
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const ws = await s.tenants.createWorkspace(tenant.id, 'Ledger', 'confidential');
        const person = async (username: string, roles: string[], clearance: 'internal' | 'confidential' | 'restricted' = 'internal') => {
          const u = await s.users.create(tenant.id, { username, displayName: username.toUpperCase(), clearance });
          await s.users.update(tenant.id, u.id, { clearance_direct: clearance });
          await s.users.setRoles(u.id, 'direct', roles);
          return u;
        };
        const admin = async (username: string) => {
          const u = await person(username, ['tenant-admin'], 'restricted');
          return { u, ctx: { p: (await loadPrincipal(s, tenant.id, u.id, {}))!, ip: null } };
        };
        const ann = await admin('ann');
        const bo = await admin('bo');

        // B-3302: dual control, versions and the diff.
        await expect(s.customRoles.create(ann.ctx, { name: 'Platform', description: '', permissions: ['platform:manage'], requiresMfa: true, grantableBy: ['tenant-admin'] })).rejects.toMatchObject({ status: 403 });
        const { role } = await s.customRoles.create(ann.ctx, { name: 'Usage desk', description: 'Usage', permissions: ['usage:read', 'files:read'], requiresMfa: true, grantableBy: ['tenant-admin'] });
        expect(role.state).toBe('pending');
        await expect(s.customRoles.approve(ann.ctx, role.id, 1, null)).rejects.toMatchObject({ status: 403 });
        expect((await s.customRoles.approve(bo.ctx, role.id, 1, 'ok')).state).toBe('active');
        await s.customRoles.update(ann.ctx, role.id, { permissions: ['usage:read', 'files:read', 'audit:read'] });
        await s.customRoles.approve(bo.ctx, role.id, 2, null);
        expect(await s.customRoles.diff(tenant.id, role.id, 1, 2)).toMatchObject({ permissions: { added: ['audit:read'], removed: [] } });
        expect((await s.customRoles.versions(tenant.id, role.id)).map((v) => v.state)).toEqual(['applied', 'superseded']);

        const cy = await person('cy', [role.id, 'member'], 'internal');
        await s.users.setWorkspaceMemberships(cy.id, 'direct', [ws.id]);
        const cyP = (await loadPrincipal(s, tenant.id, cy.id, {}))!;
        expect(explain(cyP, 'audit:read', { tenantId: tenant.id }).decision.allow).toBe(true);

        // B-3303: every cell is policy.explain's decision.
        const m = await s.access.matrix(ann.ctx.p, { limit: 50, offset: 0, permissions: ['audit:read', 'files:read', 'usage:read', 'chat:read'] });
        expect(m.total).toBe(3);
        for (const row of m.rows) {
          const p = (await loadPrincipal(s, tenant.id, row.subject.userId, {})) as Principal;
          const cell = row.cells[ws.id]!;
          for (const perm of m.permissions) {
            const want = explain(p, perm, { tenantId: tenant.id, label: 'confidential' }).decision;
            expect(cell.allow.includes(perm)).toBe(want.allow);
            if (!want.allow) expect(cell.deny[perm]).toBe(want.step);
          }
        }
        expect(m.rows.find((r) => r.subject.username === 'cy')!.cells[ws.id]).toMatchObject({ member: true, deny: { 'audit:read': 'clearance' } });
        const who = await s.access.whoCan(ann.ctx.p, { permission: 'audit:read', limit: 50, offset: 0 });
        expect(who.users.map((u) => u.username).sort()).toEqual(['ann', 'bo', 'cy']);

        // B-3305: a review, a revoke and the next round.
        const reviewer = await person('dee', ['member']);
        const r = await s.accessReviews.create(ann.ctx.p, { name: 'Quarterly', kinds: ['role', 'workspace'], roles: [role.id], reviewerIds: [reviewer.id], dueDays: 1, everyDays: 90 }, null);
        expect(r.state).toBe('open');
        const deeP = (await loadPrincipal(s, tenant.id, reviewer.id, {}))!;
        const items = await s.accessReviews.items(r, { limit: 100, offset: 0 });
        const roleItem = items.find((i) => i.kind === 'role')!;
        expect(roleItem).toMatchObject({ user: { username: 'cy' }, grant: { id: role.id, name: 'Usage desk' } });
        const decided = await s.accessReviews.decide(deeP, r.id, roleItem.id, 'revoke', 'moved teams', null);
        expect(decided).toMatchObject({ decision: 'revoked', removed: true });
        expect((await loadPrincipal(s, tenant.id, cy.id, {}))!.roles).toEqual(['member']);
        expect(await s.accessReviews.sweep(tenant.id, Date.now() + 2 * 86_400_000)).toEqual({ opened: 0, escalated: 1 });
        for (const i of items.filter((x) => x.id !== roleItem.id)) await s.accessReviews.decide(deeP, r.id, i.id, 'confirm', null, null);
        const closed = await s.accessReviews.get(tenant.id, r.id);
        expect(closed).toMatchObject({ state: 'closed', items_decided: items.length });
        const next = await s.accessReviews.get(tenant.id, closed.next_id!);
        expect(next).toMatchObject({ state: 'scheduled', every_days: 90 });
        const audit = (await db('audit_events').where({ tenant_id: tenant.id, action: 'authz.review.closed' }).first()) as { detail: string | Record<string, unknown> };
        const detail = typeof audit.detail === 'string' ? JSON.parse(audit.detail) : audit.detail;
        expect(detail.decisions).toEqual({ revoked: 1, confirmed: items.length - 1 });
        expect((await s.audit.verify(tenant.id)).status).toBe('verified');
      } finally {
        await s.close();
        await db.destroy();
      }
    });
  });
}
