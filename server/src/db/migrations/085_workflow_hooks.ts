import type { Knex } from 'knex';

/*
 * 1.8.0, Sprint 46 (B-130): the webhook trigger of every workflow (`workflows/hooks.ts`), on the signed hook app flows
 * already have (082). A workflow whose trigger step has source `webhook` is started by a signed POST to
 * `/hooks/workflows/<tenant>/<workflowId>`.
 *
 * - `workflow_hooks`: one row per workflow that has a hook. `enabled` (off by default), `secret` the HMAC secret
 *   sealed under the tenant key with `workflowhook:<workflow id>` as associated data, `secret_at` when it was made or
 *   rotated, `owner_id` who turned it on (the runs act as them, re-checked on every request), the counters and the
 *   times shown on the console.
 * - `workflow_hook_deliveries`: the last deliveries per workflow (accepted or refused, the status and reason, the run
 *   started), trimmed to the newest 50 as they arrive. No body and no address is kept here (the audit entry has the
 *   address).
 *
 * Replays are refused through the nonce table app flows use (`app_flow_hook_nonces`, keyed by the workflow id).
 * Both tables go with their workflow (foreign key, cascade). Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('workflow_hooks'))) {
    await knex.schema.createTable('workflow_hooks', (t) => {
      t.string('workflow_id', 26).primary().references('id').inTable('workflows').onDelete('CASCADE');
      t.string('tenant_id', 26).notNullable();
      t.boolean('enabled').notNullable().defaultTo(false);
      t.text('secret').nullable();
      t.bigInteger('secret_at').nullable();
      t.string('owner_id', 26).nullable();
      t.integer('received').notNullable().defaultTo(0);
      t.integer('refused').notNullable().defaultTo(0);
      t.bigInteger('last_received_at').nullable();
      t.bigInteger('last_refused_at').nullable();
      t.string('last_run_id', 26).nullable();
      t.string('updated_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.index(['tenant_id'], 'workflow_hooks_tenant_idx');
    });
  }
  if (!(await knex.schema.hasTable('workflow_hook_deliveries'))) {
    await knex.schema.createTable('workflow_hook_deliveries', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('workflow_id', 26).notNullable().references('id').inTable('workflows').onDelete('CASCADE');
      t.bigInteger('at').notNullable();
      t.string('outcome', 10).notNullable(); // accepted | refused
      t.integer('status').notNullable();
      t.string('reason', 80).nullable();
      t.string('run_id', 26).nullable();
      t.integer('size').notNullable().defaultTo(0);
      t.index(['workflow_id', 'at'], 'workflow_hook_deliveries_wf_idx');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('workflow_hook_deliveries');
  await knex.schema.dropTableIfExists('workflow_hooks');
}
