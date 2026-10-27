import type { Knex } from 'knex';

/*
 * 1.9.0, Sprint 52 (B-167 to B-169): feature flags.
 *
 * - `feature_flags`: one flag, platform-wide: its key, type (`boolean`, `variant`, `number`), default value (JSON),
 *   options (the variants, or a number's bounds), description, owner, life cycle state (planned, active, deprecated,
 *   removed) and when it last changed, an optional review date, whether it is sent to the web client, whether tenants
 *   may override it, and what a percentage rollout is sticky by (user, workspace or tenant).
 * - `feature_flag_values`: a value set at one level: `platform` (scope id `*`), `plan` (a plan key), `tenant` (its id)
 *   or `workspace` (its id, with its tenant). `rollout` is the percentage (0 to 100) of people, workspaces or tenants
 *   the value reaches; null means everyone at that level.
 * - `feature_flag_proposals`: a change to a live flag's platform default or platform rollout, waiting for a second
 *   platform admin (dual control).
 *
 * Expand only: three new tables.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('feature_flags'))) {
    await knex.schema.createTable('feature_flags', (t) => {
      t.string('key', 64).primary();
      t.string('type', 16).notNullable();
      t.text('default_value').notNullable();
      t.text('options').nullable();
      t.string('description', 1000).notNullable().defaultTo('');
      t.string('owner', 200).notNullable().defaultTo('');
      t.string('state', 16).notNullable();
      t.bigInteger('state_changed_at').notNullable();
      t.bigInteger('review_at').nullable();
      t.boolean('client').notNullable().defaultTo(true);
      t.boolean('overridable').notNullable().defaultTo(true);
      t.string('rollout_by', 16).notNullable().defaultTo('user');
      t.string('created_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.string('updated_by', 26).nullable();
      t.bigInteger('updated_at').notNullable();
    });
  }
  if (!(await knex.schema.hasTable('feature_flag_values'))) {
    await knex.schema.createTable('feature_flag_values', (t) => {
      t.string('id', 26).primary();
      t.string('flag_key', 64).notNullable();
      t.string('scope', 16).notNullable();
      t.string('scope_id', 64).notNullable();
      t.string('tenant_id', 26).nullable();
      t.text('value').notNullable();
      t.integer('rollout').nullable();
      t.string('note', 500).nullable();
      t.string('updated_by', 26).nullable();
      t.bigInteger('updated_at').notNullable();
      t.unique(['flag_key', 'scope', 'scope_id']);
      t.index(['tenant_id']);
    });
  }
  if (!(await knex.schema.hasTable('feature_flag_proposals'))) {
    await knex.schema.createTable('feature_flag_proposals', (t) => {
      t.string('id', 26).primary();
      t.string('flag_key', 64).notNullable();
      t.text('change').notNullable();
      t.string('reason', 500).nullable();
      t.string('state', 16).notNullable();
      t.string('proposed_by', 26).notNullable();
      t.string('proposed_tenant', 26).notNullable();
      t.bigInteger('proposed_at').notNullable();
      t.string('decided_by', 26).nullable();
      t.bigInteger('decided_at').nullable();
      t.string('note', 500).nullable();
      t.index(['flag_key', 'state']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('feature_flag_proposals');
  await knex.schema.dropTableIfExists('feature_flag_values');
  await knex.schema.dropTableIfExists('feature_flags');
}
