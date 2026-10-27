/*
 * 1.9.0, Sprint 53 (B-174 to B-176) on PostgreSQL and MySQL: migrations 133 and 134 (applied here until they are
 * registered), a proposal sealed and opened, public and secret ballots (the ballots' unique key with null voters,
 * the row lock while voting), the close claimed once by two instances on one database, the tally, the published
 * commitments, and a spend carried out once from a budget whose balance is locked.
 */
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { down as down133, up as up133 } from '../../src/db/migrations/133_group_proposals.js';
import { down as down134, up as up134 } from '../../src/db/migrations/134_group_votes.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import type { Ctx } from '../../src/groups/service.js';
import { loadPrincipal } from '../../src/http/middleware.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import { testConfig } from '../helpers.js';

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`group governance on ${d.name}`, () => {
    it('proposes, votes in public and in secret, closes once and carries out once', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url! });
      const db = createDb(cfg);
      await down134(db).catch(() => undefined);
      await down133(db).catch(() => undefined);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      await up133(db);
      await up134(db);
      const one = createServices(cfg, db, createLogger('silent', false), new Metrics());
      const two = createServices(cfg, db, createLogger('silent', false), new Metrics());
      try {
        await bootstrap(one);
        const tenant = (await one.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const ws = await one.tenants.createWorkspace(tenant.id, 'Commons', 'internal');
        const person = async (username: string): Promise<Ctx> => {
          const u = await one.users.create(tenant.id, { username, displayName: username.toUpperCase(), clearance: 'internal' });
          await one.users.update(tenant.id, u.id, { clearance_direct: 'internal' });
          await one.users.setRoles(u.id, 'direct', ['member']);
          await one.tenants.addMember(ws.id, u.id);
          const p = (await loadPrincipal(one, tenant.id, u.id, {}))!;
          p.workspaceId = ws.id;
          return { p, ip: null };
        };
        const [alice, bob, carol] = [await person('alice'), await person('bob'), await person('carol')];
        const g = await one.groups.create(alice, { workspaceId: ws.id, name: 'Garden club', joinMode: 'open', visibility: 'public' });
        for (const x of [bob, carol]) await one.groups.join(x, g.id);
        const gov = one.groupGovernance;

        // a public majority vote, changed once
        const pub = await gov.create(bob, g.id, { kind: 'free', title: 'Thursdays' });
        await gov.open(bob, pub.id, {});
        await gov.vote(alice, pub.id, { choice: 'no' });
        await gov.vote(alice, pub.id, { choice: 'yes' });
        await gov.vote(bob, pub.id, { choice: 'yes' });
        await gov.vote(carol, pub.id, { choice: 'no' });
        expect(await db('group_ballots').where({ proposal_id: pub.id })).toHaveLength(3);

        // a secret ranked vote: three ballots with a null voter under the unique key
        const sec = await gov.create(bob, g.id, { kind: 'free', title: 'Colour', method: 'ranked', options: ['Red', 'Green', 'Blue'], secret: true });
        await gov.open(bob, sec.id, {});
        const r1 = (await gov.vote(alice, sec.id, { choice: ['o1', 'o2'] })) as { receipt: { ballotId: string; token: string; commitment: string } };
        await gov.vote(bob, sec.id, { choice: ['o2'] });
        await gov.vote(carol, sec.id, { choice: ['o3', 'o2'] });
        const changed = (await gov.vote(alice, sec.id, { choice: ['o2'], ballotId: r1.receipt.ballotId, token: r1.receipt.token })) as { receipt: { commitment: string } };
        const ballots = (await db('group_ballots').where({ proposal_id: sec.id })) as { voter_id: string | null }[];
        expect(ballots).toHaveLength(3);
        expect(ballots.every((b) => b.voter_id === null)).toBe(true);

        // a spend from a budget
        await gov.budget.setCurrency(alice, g.id, 'EUR');
        await gov.budget.record(alice, g.id, { amountMinor: 1000 });
        const spend = await gov.create(bob, g.id, { kind: 'spend', title: 'Seeds', action: { amountMinor: 400 } });
        await gov.open(bob, spend.id, {});
        for (const x of [alice, bob]) await gov.vote(x, spend.id, { choice: 'yes' });

        await db('group_proposals').whereIn('id', [pub.id, sec.id, spend.id]).update({ closes_at: Date.now() - 1 });
        // two instances close at once: each proposal is closed and carried out once
        const [t1, t2] = await Promise.all([one.groupGovernance.tick(tenant.id), two.groupGovernance.tick(tenant.id)]);
        expect(t1.closed + t2.closed).toBe(3);
        expect(await db('audit_events').where({ tenant_id: tenant.id, action: 'group.proposal.closed' })).toHaveLength(3);
        expect(await db('audit_events').where({ tenant_id: tenant.id, action: 'group.decision.applied' })).toHaveLength(1);

        const p1 = await gov.get(alice.p, pub.id);
        expect(p1.result).toMatchObject({ outcome: 'passed', counts: { yes: 2, no: 1, abstain: 0 } });
        const p2 = await gov.get(alice.p, sec.id);
        expect(p2.result).toMatchObject({ outcome: 'passed', winner: 'o2' });
        expect(p2.commitments).toHaveLength(3);
        expect(p2.commitments).toContainEqual({ commitment: changed.receipt.commitment, choice: ['o2'] });
        expect((await gov.verifyReceipt(alice.p, sec.id, { commitment: changed.receipt.commitment, choice: ['o2'] })).counted).toBe(true);
        expect((await gov.get(alice.p, spend.id)).state).toBe('carried_out');
        expect(await two.groupGovernance.carryOut(tenant.id, spend.id, null)).toBe('skipped');
        expect(Number((await db('group_budgets').where({ group_id: g.id }).first()).balance_minor)).toBe(600);
        expect(await db('group_budget_entries').where({ proposal_id: spend.id })).toHaveLength(1);
      } finally {
        await one.close();
        await two.close();
        await down134(db).catch(() => undefined);
        await down133(db).catch(() => undefined);
        await db.destroy();
      }
    });
  });
}
