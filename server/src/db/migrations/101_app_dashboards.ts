import type { Knex } from 'knex';

/*
 * 1.8.0, Sprint 44 (B-121): dashboards per app.
 *
 * - `app_dashboards`: a grid of cards (charts, number tiles, a saved view's table, Markdown text) in their order and
 *   preset sizes, the dashboard's filters (a date range, a field value) and its refresh interval. Private to
 *   `owner_id` or `shared` with the app's readers (sharing needs `apps:design`). `data` is the name, description, cards,
 *   filters and refresh sealed with the tenant key (associated data `app-dashboard:<id>`); `label` decides who it is
 *   listed to; `rev` guards concurrent edits. Every card is computed as the person viewing it, never stored.
 *
 * Expand only. Emptied with its app; a build from before this migration ignores it.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('app_dashboards')) return;
  await knex.schema.createTable('app_dashboards', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('app_id', 26).notNullable();
    t.string('owner_id', 26).notNullable();
    t.boolean('shared').notNullable().defaultTo(false);
    t.string('label', 20).notNullable();
    t.integer('rev').notNullable().defaultTo(1);
    t.text('data', 'mediumtext').notNullable();
    t.string('updated_by', 26).notNullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id', 'app_id'], 'app_dashboards_app');
    t.index(['owner_id'], 'app_dashboards_owner');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('app_dashboards');
}
