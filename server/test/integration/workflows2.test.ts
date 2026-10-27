/*
 * Sprint 32a (1.5.0), the chain context and Workflows 2 steps, against real databases. Each block runs when its
 * variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 034_workflows2; concurrent charges to one root add up exactly; a
 *                                  retried begin finds its node; a parent run with a sub-workflow that waits on an
 *                                  approval resumes with the child's output; a map's items are checkpointed
 */
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { loadPrincipal } from '../../src/http/middleware.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import type { WfGraph } from '../../src/workflows/graph.js';
import { testConfig } from '../helpers.js';

const TOPIC = { type: 'object' as const, properties: { topic: { type: 'string' as const } }, required: ['topic'] };

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`chains and Workflows 2 on ${d.name}`, () => {
    it('migrates 034_workflows2 and runs chained sub-workflows and maps', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url!, OLLAMA_POLL_MS: '600000' });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      try {
        for (const t of ['chains', 'chain_nodes', 'workflow_items']) expect(await db.schema.hasTable(t)).toBe(true);
        expect(await db.schema.hasColumn('workflow_runs', 'chain_node')).toBe(true);
        expect(await db.schema.hasColumn('agent_runs', 'caller_node')).toBe(true);
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;

        // Charges from many places at once add up exactly at the root; a retried begin finds its node.
        const root = await s.chains.begin(tenant.id, { kind: 'workflow-run', ref: 'ROOTRUN', principal: 'U1', label: 'internal', budgets: { tokens: 1_000_000 } });
        const kids = await Promise.all(Array.from({ length: 10 }, () => s.chains.begin(tenant.id, { kind: 'tool-call', principal: 'U1', label: 'internal', parent: root })));
        await Promise.all(kids.flatMap((k) => [s.chains.charge(k, { tokens: 7, steps: 1 }), s.chains.charge(k, { tokens: 3 })]));
        const v = (await s.chains.view(tenant.id, root.chain))!;
        expect(v.used).toMatchObject({ tokens: 100, steps: 10 });
        expect(v.nodes).toHaveLength(11);
        expect((await s.chains.begin(tenant.id, { kind: 'workflow-run', ref: 'ROOTRUN', principal: 'U1', label: 'internal' })).node).toBe(root.node);
        await s.chains.raise(kids[0]!, 'confidential');
        expect(await s.chains.label(root)).toBe('confidential');

        const user = await s.users.create(tenant.id, { username: 'wadmin', displayName: 'WADMIN', clearance: 'confidential' });
        await s.users.update(tenant.id, user.id, { clearance_direct: 'confidential' });
        await s.users.setRoles(user.id, 'direct', ['member', 'workflow-admin']);
        const p = (await loadPrincipal(s, tenant.id, user.id, {}))!;
        const make = async (name: string, g: WfGraph) => {
          const w = await s.workflows.create(p, { name, label: 'internal', graph: g });
          await s.workflows.publish(p, w.id, null);
          return w;
        };
        await make('child', { nodes: [{ id: 'trigger', kind: 'trigger', title: 'T', x: 20, y: 20, config: { source: 'api' }, output: TOPIC }, { id: 'ok', kind: 'approval', title: 'OK', x: 20, y: 20, config: { role: 'workflow-admin' } }, { id: 'out', kind: 'transform', title: 'Out', x: 20, y: 20, config: { fields: { summary: 'notes on {{input.topic}}' } } }], edges: [{ from: 'trigger', to: 'ok' }, { from: 'ok', to: 'out' }], limits: {} });
        const parent = await make('parent', {
          nodes: [
            { id: 'trigger', kind: 'trigger', title: 'T', x: 20, y: 20, config: { source: 'api' }, output: TOPIC },
            { id: 'sub', kind: 'sub', title: 'Sub', x: 20, y: 20, config: { workflow: 'child', input: { topic: '{{input.topic}}' } } },
            { id: 'each', kind: 'map', title: 'Each', x: 20, y: 20, config: { over: '{{input.items}}', tool: 'calculate', args: { expression: '{{item}} * 2' }, maxParallel: 2 } }
          ],
          edges: [{ from: 'trigger', to: 'sub' }, { from: 'sub', to: 'each' }],
          limits: {}
        });
        const run = await s.workflows.start(p, parent.id, { input: { topic: 'x', items: [1, 2, 3] }, dry: false });
        while (await s.jobs.runDue());
        expect((await db('workflow_runs').where({ id: run.id }).first()).state).toBe('waiting');
        const [a] = await s.workflows.pendingApprovals(p);
        await s.workflows.decide(p, a!.id, { decision: 'approve' });
        while (await s.jobs.runDue());
        const after = await s.workflows.runView(p, run.id);
        expect(after.state).toBe('succeeded');
        expect(after.steps.find((x) => x.nodeId === 'sub')).toMatchObject({ state: 'passed', output: { output: { summary: 'notes on x' } } });
        expect((after.steps.find((x) => x.nodeId === 'each')!.output as unknown as { results: { decimal: string }[] }).results.map((r) => r.decimal)).toEqual(['2', '4', '6']);
        expect(after.items).toHaveLength(3);
        const chain = (await s.chains.view(tenant.id, after.chain!.id))!;
        expect(chain.nodes.map((n) => [n.kind, n.depth])).toEqual([['workflow-run', 0], ['workflow-run', 1], ['tool-call', 1], ['tool-call', 1], ['tool-call', 1]]);
        expect(chain.used.steps).toBeGreaterThanOrEqual(8);
      } finally {
        await s.close();
        await db.destroy();
      }
    }, 60_000);
  });
}
