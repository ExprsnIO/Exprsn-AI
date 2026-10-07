/*
 * Sprint 34a (1.5.0), chaining across kinds against real databases. Each block runs when its variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 036_chains; a call held two levels down in a chain of workflows is
 *                                  listed with its path and decided from the chain; the tree's totals equal what the
 *                                  chain metered; the audit target filter; a cycle of sub-workflows is refused at
 *                                  publish; "used by" and the retire guard; a skill's closure
 */
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { chainTree, decideHeld } from '../../src/chain/view.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { loadPrincipal } from '../../src/http/middleware.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { skillClosure } from '../../src/registry/skills.js';
import { createServices } from '../../src/services.js';
import type { WfGraph, WfNode } from '../../src/workflows/graph.js';
import { testConfig } from '../helpers.js';

const TOPIC = { type: 'object' as const, properties: { topic: { type: 'string' as const } }, required: ['topic'] };
const trigger: WfNode = { id: 'trigger', kind: 'trigger', title: 'T', x: 20, y: 20, config: { source: 'api' }, output: TOPIC };
const step = (id: string, kind: string, config: Record<string, unknown>): WfNode => ({ id, kind: kind as WfNode['kind'], title: id, x: 20, y: 20, config });
const line = (nodes: WfNode[]): WfGraph => ({ nodes, edges: nodes.slice(1).map((n, i) => ({ from: nodes[i]!.id, to: n.id })), limits: {} });

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`chaining across kinds on ${d.name}`, () => {
    it('migrates 036_chains, decides a held call from the chain and checks references at publish', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url!, OLLAMA_POLL_MS: '600000' });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      try {
        expect(await db.schema.hasColumn('chain_nodes', 'decision')).toBe(true);
        expect(await db.schema.hasColumn('chain_nodes', 'error_type')).toBe(true);
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const mk = async (username: string, roles: string[]) => {
          const u = await s.users.create(tenant.id, { username, displayName: username.toUpperCase(), clearance: 'confidential' });
          await s.users.update(tenant.id, u.id, { clearance_direct: 'confidential' });
          await s.users.setRoles(u.id, 'direct', roles);
          return (await loadPrincipal(s, tenant.id, u.id, {}))!;
        };
        const p = await mk('wadmin', ['member', 'workflow-admin', 'tool-admin']);
        const reviewer = await mk('reviewer', ['member', 'tool-admin']);
        const make = async (name: string, g: WfGraph) => {
          const w = await s.workflows.create(p, { name, label: 'internal', graph: g });
          await s.workflows.publish(p, w.id, null);
          return w;
        };

        // gate (approval) ← middle (sub) ← top (sub): the approval is held two levels below the root.
        const gate = await make('gate', line([trigger, step('ok', 'approval', { role: 'workflow-admin' }), step('out', 'transform', { fields: { summary: 'approved {{input.topic}}' } })]));
        const middle = await make('middle', line([trigger, step('g', 'sub', { workflow: 'gate', input: { topic: '{{input.topic}}' } })]));
        const top = await make('top', line([trigger, step('m', 'sub', { workflow: 'middle', input: { topic: '{{input.topic}}' } })]));
        const run = await s.workflows.start(p, top.id, { input: { topic: 'close' }, dry: false });
        while (await s.jobs.runDue());
        const view = await chainTree(s, p, run.chain_id!);
        expect(view.held).toHaveLength(1);
        expect(view.held[0]!.path.map((x) => x.name)).toEqual(['top', 'middle', 'gate']);
        expect(view.held[0]).toMatchObject({ at: { kind: 'workflow-run', step: 'ok' }, canDecide: true });
        await decideHeld(s, p, run.chain_id!, view.held[0]!.node, { decision: 'approve', note: null }, null);
        while (await s.jobs.runDue());
        const done = await s.workflows.runView(p, run.id);
        expect(done.state).toBe('succeeded');
        const after = await chainTree(s, p, run.chain_id!);
        expect(after.held).toEqual([]);
        expect(after.totals).toEqual(after.used);
        expect(after.root!.subtree.nodes).toBe(3);
        const gateRun = after.root!.children[0]!.children[0]!;
        expect(gateRun).toMatchObject({ kind: 'workflow-run', name: 'gate', state: 'succeeded' });
        // The audit target filter finds the entries naming the run (LIKE on the canonical JSON target).
        expect((await s.audit.list(tenant.id, { target: String(gateRun.ref) })).map((e) => e.action)).toContain('workflow.run.started');

        // A cycle of sub-workflows cannot terminate: refused at publish, with the path.
        await s.workflows.saveDraft(p, gate.id, { graph: line([trigger, step('t', 'sub', { workflow: 'top', input: { topic: '{{input.topic}}' } })]) });
        const err = (await s.workflows.publish(p, gate.id, null).catch((e: unknown) => e)) as { status: number; extensions: { errors: { code: string; path?: string[] }[] } };
        expect(err.status).toBe(422);
        expect(err.extensions.errors.find((e) => e.code === 'chain')!.path).toEqual([`workflow:${gate.id}`, `workflow:${top.id}`, `workflow:${middle.id}`, `workflow:${gate.id}`]);
        expect((await s.workflows.usedBy(middle)).map((u) => [u.kind, u.name, u.via, u.live])).toEqual([['workflow', 'top', 'sub-workflow', true]]);

        // Skills compose; a skill a published agent uses does not retire.
        const publish = async (input: Parameters<typeof s.registry.create>[1]) => {
          const e = await s.registry.create(p, input);
          return s.registry.review(reviewer, await s.registry.submit(e), { decision: 'approve' });
        };
        const desc = 'Instructions for the monthly close checklist, step by step.';
        await publish({ kind: 'skill', name: 'basics', version: '1.0.0', description: desc, impl: 'archive', sideEffect: null, label: 'confidential', inputSchema: null, outputSchema: null, definition: { instructions: 'Basics.', tools: ['calculate'] } });
        const close = await publish({ kind: 'skill', name: 'close', version: '1.0.0', description: desc, impl: 'archive', sideEffect: null, label: 'confidential', inputSchema: null, outputSchema: null, definition: { instructions: 'Close.', tools: [], skills: ['basics'] } });
        const closure = await skillClosure(s.registry, p, ['close']);
        expect(closure.skills.map((x) => x.name)).toEqual(['basics', 'close']);
        expect(closure.tools).toEqual(['calculate']);
        await publish({ kind: 'agent', name: 'Closer', version: '1.0.0', description: 'Runs the monthly close with the checklist skills.', impl: 'agent', sideEffect: null, label: 'confidential', inputSchema: null, outputSchema: null, definition: { profile: 'general', tools: [], skills: ['close'], budgets: { steps: 5, tokens: 1000, wallSeconds: 60, toolCalls: 2 } } });
        const dep = await s.registry.lifecycle(close, 'deprecated');
        const refused = (await s.registry.lifecycle(dep, 'retired').catch((e: unknown) => e)) as { status: number; detail: string };
        expect(refused.status).toBe(409);
        expect(refused.detail).toMatch(/close is used by agent Closer 1\.0\.0/);
      } finally {
        await s.close();
        await db.destroy();
      }
    }, 60_000);
  });
}
