import type { Knex } from 'knex';

/*
 * 1.8.0, Sprint 44 (B-123): exports of an app's records, saved views, reports and dashboards as XLSX, PDF, CSV or
 * HTML, written by the `apps.export-file` job.
 *
 * - `app_exports`: one requested export: what (`kind`, `ref_id`), in which format, by whom, its state and progress
 *   through the job, and the sealed file in the blob store (`blob_key`, sealed with associated data
 *   `app-export:<id>`). `input` (parameters and filters) is sealed too. Only the requester downloads the file, while
 *   their clearance clears `label`; the sweep deletes the file at `expires_at`.
 *
 * Expand only; a build from before this migration ignores the table.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('app_exports'))) {
    await knex.schema.createTable('app_exports', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('app_id', 26).notNullable();
      t.string('user_id', 26).notNullable();
      t.string('kind', 20).notNullable();
      t.string('ref_id', 26).notNullable();
      t.string('format', 10).notNullable();
      t.string('state', 20).notNullable();
      t.text('input').nullable();
      t.string('file', 200).nullable();
      t.string('label', 20).notNullable();
      t.string('blob_key', 300).nullable();
      t.bigInteger('bytes').nullable();
      t.integer('rows').nullable();
      t.boolean('truncated').notNullable().defaultTo(false);
      t.string('error', 500).nullable();
      t.string('job_id', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('finished_at').nullable();
      t.bigInteger('expires_at').nullable();
      t.index(['tenant_id', 'user_id', 'created_at']);
      t.index(['app_id']);
      t.index(['expires_at']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('app_exports');
}
