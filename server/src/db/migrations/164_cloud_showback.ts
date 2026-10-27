import type { Knex } from 'knex';

/*
 * 1.9.99-final, Sprint 61 (B-10604): showback (`cloud/showback.ts`).
 *
 * - `cloud_allocation_rules`: the platform's rule per cost type (`gpu`, `model`, `compute`, `database`, `storage`,
 *   `network`, `other`): the basis shared costs of that type are split by (`gpu_time`, `tokens`, `model_cost`,
 *   `requests`, `storage`, `even`, `unallocated`). A type without a row uses the built-in default.
 * - `cloud_showback`: the monthly showback rows, one per month (`YYYY-MM`, UTC), tenant (null: unallocated), workspace
 *   (null: the tenant's usage outside any workspace, or unallocated), currency (never converted, open decision 17),
 *   cost type and method (`tag`, `pool`, `tenant`, `shared`, `unallocated`): the amount (a decimal as text) and when it
 *   was computed. A recompute replaces the month's rows; a month's rows add up to its ingested `cloud_costs` total
 *   per currency.
 * - `cloud_showback_settings`: per tenant, whether the B-13 statement carries the showback as informational lines
 *   (default off: a tenant without a row sees its statements exactly as before).
 *
 * Expand only: three new tables. While they are missing, showback is computed on request with the default rules and
 * nothing is stored, the rule and setting changes answer 503 `migration_pending`, and statements carry no showback.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('cloud_allocation_rules'))) {
    await knex.schema.createTable('cloud_allocation_rules', (t) => {
      t.string('cost_type', 20).primary();
      t.string('basis', 20).notNullable();
      t.string('updated_by', 26).nullable();
      t.bigInteger('updated_at').notNullable();
    });
  }
  if (!(await knex.schema.hasTable('cloud_showback'))) {
    await knex.schema.createTable('cloud_showback', (t) => {
      t.string('id', 26).primary();
      t.string('month', 7).notNullable(); // YYYY-MM (UTC)
      t.string('tenant_id', 26).nullable(); // null: unallocated
      t.string('workspace_id', 26).nullable();
      t.string('currency', 3).notNullable();
      t.string('cost_type', 20).notNullable();
      t.string('method', 20).notNullable();
      t.string('amount', 32).notNullable();
      t.bigInteger('computed_at').notNullable();
      t.index(['month', 'tenant_id']);
      t.index(['month', 'workspace_id']);
    });
  }
  if (!(await knex.schema.hasTable('cloud_showback_settings'))) {
    await knex.schema.createTable('cloud_showback_settings', (t) => {
      t.string('tenant_id', 26).primary();
      t.boolean('statement_lines').notNullable().defaultTo(false);
      t.string('updated_by', 26).nullable();
      t.bigInteger('updated_at').notNullable();
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('cloud_showback_settings');
  await knex.schema.dropTableIfExists('cloud_showback');
  await knex.schema.dropTableIfExists('cloud_allocation_rules');
}
