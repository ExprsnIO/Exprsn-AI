import type { Knex } from 'knex';

/*
 * 1.8.0, Sprint 46 (B-135): run retention (`workflows/retention.ts`).
 *
 * `workflow_retention`: the tenant's policy (`scope` tenant, `scope_id` the tenant id) and a workflow's override
 * (`scope` workflow, `scope_id` the workflow id). Each of `run_days` (finished runs), `failed_days` (failed runs) and
 * `max_runs` (finished runs kept per workflow) left null falls back: a workflow's to the tenant's, the tenant's to
 * the defaults (90 days, 180 days, 1000 runs). `last_run_at` and `last_pruned` record the tenant's last prune.
 *
 * Expand only. A build from before this migration ignores the table and prunes nothing.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('workflow_retention')) return;
  await knex.schema.createTable('workflow_retention', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('scope', 20).notNullable(); // tenant | workflow
    t.string('scope_id', 26).notNullable();
    t.integer('run_days').nullable();
    t.integer('failed_days').nullable();
    t.integer('max_runs').nullable();
    t.bigInteger('last_run_at').nullable();
    t.integer('last_pruned').nullable();
    t.string('updated_by', 26).nullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'scope', 'scope_id'], { indexName: 'workflow_retention_scope_uq' });
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('workflow_retention');
}
