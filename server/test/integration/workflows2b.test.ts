/*
 * Sprint 32b (1.5.0), workflow triggers, failure handling and bundles, against real databases. Each block runs when
 * its variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 034b_workflow_triggers; an event trigger fired once per event (the
 *                                  unique firing on a second offer); a cron due time claimed by one of two instances
 *                                  ticking at once; a failure edge taken, a retry that waits durably, a dead letter
 *                                  redriven once; a bundle round-trip and a tampered bundle refused
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { loadPrincipal } from '../../src/http/middleware.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import type { WfGraph } from '../../src/workflows/graph.js';
import { testConfig } from '../helpers.js';

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`workflow triggers on ${d.name}`, () => {
    it('migrates 034b_workflow_triggers and runs triggers, retries, dead letters and bundles', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url!, WORKFLOW_HTTP_ALLOW_LOOPBACK: 'true', WORKFLOW_SCHEDULE_TICK_SECONDS: '0' });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      const s2 = createServices(cfg, db, createLogger('silent', false), new Metrics());
      let failing = true;
      const hook = createServer((req, res) => {
        const fail = req.url?.startsWith('/fail') && failing;
        res.writeHead(fail ? 500 : 200, { 'content-type': 'application/json' });
        res.end('{}');
      });
      await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r));
      const hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}`;
      const drain = async () => {
        for (let i = 0; i < 30; i++) if (!(await s.jobs.runDue())) return;
      };
      const forward = async () => {
        const now = Date.now();
        await db('jobs').where('run_at', '>', now).update({ run_at: now - 1 });
        await db('workflow_steps').where({ state: 'waiting' }).whereNotNull('resume_at').update({ resume_at: now - 1 });
      };
      try {
        for (const t of ['workflow_triggers', 'workflow_trigger_firings', 'workflow_dead_letters']) expect(await db.schema.hasTable(t)).toBe(true);
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const u = await s.users.create(tenant.id, { username: 'wadmin', displayName: 'W', clearance: 'confidential' });
        await s.users.update(tenant.id, u.id, { clearance_direct: 'confidential' });
        await s.users.setRoles(u.id, 'direct', ['workflow-admin', 'member']);
        const p = (await loadPrincipal(s, tenant.id, u.id, {}))!;
        const publish = async (name: string, graph: WfGraph) => {
          const w = await s.workflows.create(p, { name, label: 'internal', graph });
          await s.workflows.publish(p, w.id, null);
          return w.id;
        };
        const trigger = (config: Record<string, unknown>) => ({ id: 'trigger', kind: 'trigger' as const, title: 'Trigger', x: 20, y: 20, config });
        const shape = (id: string, fields: Record<string, string>) => ({ id, kind: 'transform' as const, title: id, x: 200, y: 20, config: { fields } });

        // an event trigger: one firing per event, even when two instances offer it
        const onRecord = await publish('on-record', { nodes: [trigger({ source: 'event', event: 'record.created' }), shape('shape', { record: '{{input.event.data.record}}' })], edges: [{ from: 'trigger', to: 'shape' }], limits: {} });
        const ev = { record: 'R1', workspace: null };
        const offered = await Promise.all([s.workflowTriggers.offer(tenant.id, 'record.created', 'internal', 'record.created:1', ev), s2.workflowTriggers.offer(tenant.id, 'record.created', 'internal', 'record.created:1', ev)]);
        expect(offered[0] + offered[1]).toBe(1);
        await drain();
        const runs = (await db('workflow_runs').where({ workflow_id: onRecord })) as { state: string; trigger: string }[];
        expect(runs).toHaveLength(1);
        expect(runs[0]!.state).toBe('succeeded');
        expect(runs[0]!.trigger).toMatch(/^event:/);

        // a cron due time claimed by one of two instances
        const nightly = await publish('nightly', { nodes: [trigger({ source: 'schedule', cron: '30 4 * * *' }), shape('shape', { at: '{{input.dueAt}}' })], edges: [{ from: 'trigger', to: 'shape' }], limits: {} });
        const due = Number((await db('workflow_triggers').where({ workflow_id: nightly }).first()).next_run_at);
        const ticks = await Promise.all([s.workflowTriggers.tick(due + 1), s2.workflowTriggers.tick(due + 1)]);
        expect(ticks[0].fired + ticks[1].fired).toBe(1);
        await drain();
        expect(((await db('workflow_runs').where({ workflow_id: nightly })) as { state: string }[]).map((r) => r.state)).toEqual(['succeeded']);

        // a failure edge; a retry that waits; a dead letter redriven once
        const handled = await publish('handled', { nodes: [trigger({}), { id: 'call', kind: 'http', title: 'Call', x: 0, y: 0, config: { url: `${hookUrl}/fail` } }, shape('recover', { e: '{{steps.call.error}}' })], edges: [{ from: 'trigger', to: 'call' }, { from: 'call', to: 'recover', branch: 'failure' }], limits: {} });
        await s.workflows.start(p, handled, { input: {}, dry: false });
        const doomed = await publish('doomed', { nodes: [trigger({}), { id: 'call', kind: 'http', title: 'Call', x: 0, y: 0, config: { url: `${hookUrl}/fail` }, retry: { max: 1, delayMs: 1000, backoff: 'fixed' } }], edges: [{ from: 'trigger', to: 'call' }], limits: {} });
        const r = await s.workflows.start(p, doomed, { input: {}, dry: false });
        await drain();
        expect((await db('workflow_runs').where({ workflow_id: handled }).first()).state).toBe('succeeded');
        expect((await db('workflow_runs').where({ id: r.id }).first()).state).toBe('waiting');
        await forward();
        await drain();
        expect((await db('workflow_runs').where({ id: r.id }).first()).state).toBe('failed');
        const [dl] = await s.workflowDeadLetters.list(p, { state: 'open' });
        expect(dl).toMatchObject({ runId: r.id, nodeId: 'call', workflow: 'doomed' });
        failing = false;
        const results = await Promise.allSettled([s.workflowDeadLetters.redrive(p, dl!.id), s2.workflowDeadLetters.redrive(p, dl!.id)]);
        expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
        await drain();
        const again = (await db('workflow_runs').where({ replay_of: r.id })) as { state: string }[];
        expect(again.map((x) => x.state)).toEqual(['succeeded']);

        // bundles
        const bundle = await s.workflowBundles.export(p, 'handled');
        const imported = await s.workflowBundles.import(p, bundle, { name: 'handled-copy' });
        expect(imported.workflow.draft.nodes.map((n) => n.id)).toEqual(['trigger', 'call', 'recover']);
        const tampered = { ...bundle, workflow: { ...bundle.workflow, label: 'public' as const } };
        await expect(s.workflowBundles.import(p, tampered, { name: 'evil' })).rejects.toMatchObject({ status: 422, title: 'Bundle refused' });
      } finally {
        hook.closeAllConnections();
        await new Promise((res) => hook.close(res));
        s2.workflowTriggers.close();
        s2.pluginRuntime.close();
        await s.close();
        await db.destroy();
      }
    }, 120_000);
  });
}
