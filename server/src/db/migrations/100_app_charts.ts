import type { Knex } from 'knex';

/*
 * 1.8.0, Sprint 44 (B-120): charts over app records, saved queries and REST endpoints.
 *
 * - `app_charts`: one chart of one app, its own object beside the app's design (not inside the entity definitions or
 *   the `exprsn-app/2` package): private to `owner_id` or `shared` with the app's readers, as saved views are. `data`
 *   is the name and the definition (source, type, dimension, measures, sort, limit, colours, labels) sealed with the
 *   tenant key (associated data `app-chart:<id>`); `label` decides who it is listed to; `rev` counts saved versions.
 *   `source_kind` (`entity`, `query`, `rest`) and `entity_id` are in the clear so a chart can be found by its source.
 * - `app_chart_versions`: every saved definition, sealed as `app-chart:<id>:<rev>`, for history.
 *
 * Expand only. Both are emptied with their app; a build from before this migration ignores them.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('app_charts'))) {
    await knex.schema.createTable('app_charts', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('app_id', 26).notNullable();
      t.string('owner_id', 26).notNullable();
      t.boolean('shared').notNullable().defaultTo(false);
      t.string('label', 20).notNullable();
      t.string('source_kind', 16).notNullable();
      t.string('entity_id', 26).nullable();
      t.integer('rev').notNullable().defaultTo(1);
      t.text('data', 'mediumtext').notNullable();
      t.string('updated_by', 26).notNullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.index(['tenant_id', 'app_id'], 'app_charts_app');
      t.index(['entity_id'], 'app_charts_entity');
    });
  }
  if (!(await knex.schema.hasTable('app_chart_versions'))) {
    await knex.schema.createTable('app_chart_versions', (t) => {
      t.string('chart_id', 26).notNullable();
      t.integer('rev').notNullable();
      t.string('tenant_id', 26).notNullable();
      t.string('app_id', 26).notNullable();
      t.text('data', 'mediumtext').notNullable();
      t.string('created_by', 26).notNullable();
      t.bigInteger('created_at').notNullable();
      t.primary(['chart_id', 'rev']);
      t.index(['app_id'], 'app_chart_versions_app');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('app_chart_versions');
  await knex.schema.dropTableIfExists('app_charts');
}
