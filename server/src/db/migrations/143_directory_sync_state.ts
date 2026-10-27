import type { Knex } from 'knex';

/*
 * 1.9.9-qa (QA-1, the Sprint 54 leftovers of B-183): per-store directory state for the cloud directory pulls.
 *
 * - `directory_sync_state`: one row per user store. For a Microsoft Graph directory, the delta links of the last
 *   incremental pull (`/users/delta`, `/groups/delta`), so the next directory sync asks only for what changed; the
 *   links are the directory's own (they carry no credential: Graph needs the bearer token as well) and are dropped
 *   when the directory answers 410 (expired), which makes the next run a full pull. `mode` and `synced_at` say how
 *   the last run went.
 * - `directory_imports`: a full import of a cloud directory's users before their first sign-in (a dry run first,
 *   then the run that names it): who asked, the importer's roles and clearance at the time (the ceiling the run
 *   keeps to), the job, the counts and a capped per-user report. Users' details are in the report only as usernames
 *   and outcomes, never credentials.
 *
 * Expand only: two new tables. While they are missing, directory sync makes a full pull every time and the import
 * answers 409 "not available".
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('directory_sync_state'))) {
    await knex.schema.createTable('directory_sync_state', (t) => {
      t.string('provider_id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.text('users_delta_link').nullable();
      t.text('groups_delta_link').nullable();
      t.string('mode', 16).nullable(); // full | delta
      t.bigInteger('synced_at').nullable();
      t.bigInteger('updated_at').notNullable();
      t.index(['tenant_id']);
    });
  }
  if (!(await knex.schema.hasTable('directory_imports'))) {
    await knex.schema.createTable('directory_imports', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('provider_id', 26).notNullable();
      t.string('created_by', 26).nullable();
      t.text('actor').nullable(); // JSON: { roles, clearance } of the importer when asked
      t.boolean('dry_run').notNullable();
      t.string('from_dry_run', 26).nullable();
      t.string('state', 16).notNullable(); // queued | running | succeeded | failed
      t.string('job_id', 26).nullable();
      t.text('summary').nullable(); // JSON counts
      t.text('report', 'mediumtext').nullable(); // JSON rows, capped
      t.string('error', 500).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('finished_at').nullable();
      t.index(['tenant_id', 'provider_id', 'created_at']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('directory_imports');
  await knex.schema.dropTableIfExists('directory_sync_state');
}
