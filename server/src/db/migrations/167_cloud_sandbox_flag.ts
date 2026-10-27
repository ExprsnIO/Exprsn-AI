import type { Knex } from 'knex';

/*
 * 1.9.99-final, Sprint 62 (B-10804): the nightly sandbox job (`cloud/sandbox-run.ts`, `exprsn-ai cloud:sandbox-run`).
 *
 * - `cloud_accounts.sandbox`: true only on the dedicated sandbox accounts (open decision 18). The job and its sweeper
 *   refuse every account without it; nothing else reads it. Default false, so every existing account is refused.
 * - `cloud_sandbox_runs`: one row per account per run: the stages, what the sweeper deleted and kept, what was left
 *   in the account afterwards (JSON, ids and states only, never a credential), so "seven consecutive nightly runs
 *   passed with nothing left" can be read back (`cloud:sandbox-run --history`).
 * - `cloud_sandbox_seen`: when the sweeper first saw a tagged resource whose age the provider does not report, so it
 *   is deleted once it is older than a day and never sooner.
 *
 * Expand only: one nullable-free column with a default and two new tables. A build from before this migration ignores
 * them; without it the job refuses every account (`sandbox_flag_missing`).
 */
export async function up(knex: Knex): Promise<void> {
  if ((await knex.schema.hasTable('cloud_accounts')) && !(await knex.schema.hasColumn('cloud_accounts', 'sandbox'))) {
    await knex.schema.alterTable('cloud_accounts', (t) => {
      t.boolean('sandbox').notNullable().defaultTo(false);
    });
  }
  if (!(await knex.schema.hasTable('cloud_sandbox_runs'))) {
    await knex.schema.createTable('cloud_sandbox_runs', (t) => {
      t.string('id', 26).primary();
      t.string('run_id', 26).notNullable(); // one nightly run over several accounts
      t.string('account_id', 26).notNullable();
      t.string('status', 12).notNullable(); // passed | failed | refused | dry_run
      t.boolean('dry_run').notNullable().defaultTo(false);
      t.text('report', 'mediumtext').notNullable(); // JSON, ids and states only
      t.integer('leftovers').notNullable().defaultTo(0);
      t.bigInteger('started_at').notNullable();
      t.bigInteger('finished_at').notNullable();
      t.index(['account_id', 'started_at']);
    });
  }
  if (!(await knex.schema.hasTable('cloud_sandbox_seen'))) {
    await knex.schema.createTable('cloud_sandbox_seen', (t) => {
      t.string('account_id', 26).notNullable();
      t.string('resource_type', 32).notNullable();
      t.string('provider_id', 400).notNullable();
      t.bigInteger('first_seen').notNullable();
      t.primary(['account_id', 'resource_type', 'provider_id']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('cloud_sandbox_seen');
  await knex.schema.dropTableIfExists('cloud_sandbox_runs');
  if ((await knex.schema.hasTable('cloud_accounts')) && (await knex.schema.hasColumn('cloud_accounts', 'sandbox'))) {
    await knex.schema.alterTable('cloud_accounts', (t) => {
      t.dropColumn('sandbox');
    });
  }
}
