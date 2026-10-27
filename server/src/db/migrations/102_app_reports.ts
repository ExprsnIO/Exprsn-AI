import type { Knex } from 'knex';

/*
 * 1.8.0, Sprint 44 (B-122): reports of an app.
 *
 * - `app_reports`: one report definition (source, parameters, layout, computed columns, sorting, conditional
 *   formatting, title, notes and page setup), never SQL. `data` is the title and the definition sealed with the
 *   tenant key (associated data `app-report:<id>`); `name` is the report's handle in its app; `label` decides who it is
 *   listed to (the app's at most); `source_kind` is in the clear so the routes can say which right a run needs.
 * - `app_report_runs`: the run history: who ran it, with which parameters (sealed, `app-report-run:<id>:params`), how
 *   many rows, truncated or not, how long. `result` holds the computed result sealed (`app-report-run:<id>`) until
 *   `expires_at`; the sweep clears it after that, the history row stays.
 *
 * Expand only. Both tables are emptied with their app; a build from before this migration ignores them.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('app_reports'))) {
    await knex.schema.createTable('app_reports', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('app_id', 26).notNullable();
      t.string('name', 63).notNullable();
      t.string('label', 20).notNullable();
      t.string('source_kind', 20).notNullable();
      t.text('data', 'mediumtext').notNullable();
      t.integer('version').notNullable().defaultTo(1);
      t.string('created_by', 26).notNullable();
      t.string('updated_by', 26).notNullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.unique(['app_id', 'name']);
      t.index(['tenant_id', 'app_id']);
    });
  }
  if (!(await knex.schema.hasTable('app_report_runs'))) {
    await knex.schema.createTable('app_report_runs', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('app_id', 26).notNullable();
      t.string('report_id', 26).notNullable();
      t.string('user_id', 26).notNullable();
      t.string('state', 20).notNullable();
      t.text('params').nullable();
      t.integer('rows').notNullable().defaultTo(0);
      t.boolean('truncated').notNullable().defaultTo(false);
      t.integer('ms').notNullable().defaultTo(0);
      t.string('label', 20).notNullable();
      t.string('error', 500).nullable();
      t.text('result', 'mediumtext').nullable();
      t.bigInteger('expires_at').nullable();
      t.bigInteger('created_at').notNullable();
      t.index(['report_id', 'created_at']);
      t.index(['tenant_id', 'user_id']);
      t.index(['expires_at']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('app_report_runs');
  await knex.schema.dropTableIfExists('app_reports');
}
