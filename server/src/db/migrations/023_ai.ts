import type { Knex } from 'knex';

/*
 * Sprint 21: AI. Held `/v1` requests (B-1301): the request sealed while a reviewer decides, then the answer sealed
 * for the client to fetch. Evaluations (B-1303): eval sets per profile, runs per profile version (with the hash of
 * the settings that shape an answer) and dual-control overrides of the publish gate. Scheduled agent runs (B-1306):
 * cron schedules owned by a user, and their history (runs started and skips).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('api_holds', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).nullable();
    t.string('user_id', 26).notNullable();
    t.string('api_key_id', 26).nullable();
    t.string('api', 40).notNullable(); // chat.completions | responses
    t.string('label', 20).notNullable();
    t.text('request', 'mediumtext').notNullable(); // sealed: body, extensions, credential scopes
    t.string('state', 20).notNullable(); // held | running | completed | failed | rejected
    t.text('result', 'mediumtext').nullable(); // sealed: the answer in the API's own shape
    t.string('error', 500).nullable();
    t.string('flag_id', 26).nullable();
    t.string('job_id', 26).nullable();
    t.string('decided_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('decided_at').nullable();
    t.bigInteger('completed_at').nullable();
    t.index(['tenant_id', 'user_id', 'created_at']);
  });

  await knex.schema.createTable('eval_sets', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('profile_id', 26).notNullable();
    t.string('name', 120).notNullable();
    t.string('description', 500).nullable();
    t.string('label', 20).notNullable();
    t.float('threshold').notNullable(); // 0..1, the share of cases that must pass
    t.boolean('gate').notNullable().defaultTo(true); // when true, publishing needs a passing run
    t.string('judge_profile', 63).nullable();
    t.text('cases', 'mediumtext').notNullable(); // sealed JSON
    t.integer('revision').notNullable().defaultTo(1);
    t.string('created_by', 26).nullable();
    t.string('updated_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'profile_id', 'name']);
  });

  await knex.schema.createTable('eval_runs', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('set_id', 26).notNullable();
    t.string('profile_id', 26).notNullable();
    t.integer('profile_version').notNullable();
    t.string('config_hash', 64).notNullable();
    t.integer('set_revision').notNullable();
    t.string('state', 20).notNullable(); // queued | running | passed | failed | error
    t.float('score').nullable();
    t.float('threshold').notNullable();
    t.integer('passed').nullable();
    t.integer('total').nullable();
    t.text('results', 'mediumtext').nullable(); // sealed JSON: per case outcome and output
    t.string('error', 500).nullable();
    t.string('trigger', 20).notNullable(); // manual | publish
    t.string('job_id', 26).nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('finished_at').nullable();
    t.index(['tenant_id', 'profile_id', 'created_at']);
    t.index(['set_id', 'config_hash']);
  });

  await knex.schema.createTable('eval_overrides', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('profile_id', 26).notNullable();
    t.string('config_hash', 64).notNullable();
    t.integer('profile_version').notNullable();
    t.string('reason', 500).notNullable();
    t.string('state', 20).notNullable(); // pending | approved | rejected
    t.string('requested_by', 26).notNullable();
    t.bigInteger('requested_at').notNullable();
    t.string('decided_by', 26).nullable();
    t.bigInteger('decided_at').nullable();
    t.index(['tenant_id', 'profile_id']);
  });

  await knex.schema.createTable('agent_schedules', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).nullable();
    t.string('owner_id', 26).notNullable();
    t.string('name', 120).notNullable();
    t.string('agent', 120).notNullable();
    t.string('cron', 120).notNullable();
    t.text('input', 'mediumtext').notNullable(); // sealed
    t.string('label', 20).notNullable();
    t.text('budgets').nullable(); // JSON
    t.boolean('enabled').notNullable().defaultTo(true);
    t.bigInteger('next_run_at').nullable();
    t.bigInteger('last_run_at').nullable();
    t.string('last_run_id', 26).nullable();
    t.string('last_result', 300).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'owner_id', 'name']);
    t.index(['enabled', 'next_run_at']);
  });

  await knex.schema.createTable('agent_schedule_runs', (t) => {
    t.string('id', 26).primary();
    t.string('schedule_id', 26).notNullable();
    t.string('tenant_id', 26).notNullable();
    t.string('run_id', 26).nullable();
    t.string('outcome', 20).notNullable(); // started | skipped | failed
    t.string('reason', 300).nullable();
    t.bigInteger('due_at').notNullable();
    t.bigInteger('at').notNullable();
    t.unique(['schedule_id', 'due_at']);
  });

  await knex.schema.alterTable('agent_runs', (t) => {
    t.string('schedule_id', 26).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('agent_runs', (t) => {
    t.dropColumn('schedule_id');
  });
  for (const table of ['agent_schedule_runs', 'agent_schedules', 'eval_overrides', 'eval_runs', 'eval_sets', 'api_holds']) await knex.schema.dropTableIfExists(table);
}
