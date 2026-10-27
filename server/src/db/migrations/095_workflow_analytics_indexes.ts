import type { Knex } from 'knex';

/*
 * 1.8.0, Sprint 47 (B-139): indexes for workflow analytics (`workflows/analytics.ts`).
 *
 * - `workflow_runs (tenant_id, created_at)`: the tenant-wide summary over a date range (the existing
 *   `(tenant_id, workflow_id, created_at)` serves one workflow's metrics and trends).
 * - `workflow_runs (tenant_id, state)`: the "running now" board (queued, running and waiting runs).
 * - `workflow_steps (tenant_id, run_id)` is not needed: steps are read by `run_id`, covered by the unique
 *   `(run_id, node_id)`.
 *
 * Expand only; a build from before this migration does not notice the indexes.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('workflow_runs', (t) => {
    t.index(['tenant_id', 'created_at'], 'workflow_runs_tenant_created_idx');
    t.index(['tenant_id', 'state'], 'workflow_runs_tenant_state_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('workflow_runs', (t) => {
    t.dropIndex(['tenant_id', 'created_at'], 'workflow_runs_tenant_created_idx');
    t.dropIndex(['tenant_id', 'state'], 'workflow_runs_tenant_state_idx');
  });
}
