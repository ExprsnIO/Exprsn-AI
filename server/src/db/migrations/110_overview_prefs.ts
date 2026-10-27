import type { Knex } from 'knex';

/*
 * 1.8.0, Sprint 48 (B-148): the Overview's cards, per admin.
 *
 * - `overview_prefs`: one row per person and tenant: the order of the Overview cards, the ones pinned to the top,
 *   the ones hidden (`cards`, JSON) and the density (`compact` or `comfortable`). No row: the default layout. Which
 *   cards a person may see is decided when the page is read (`ops/overview-cards.ts`), never stored here.
 *
 * Expand only. A build from before this migration ignores the table.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('overview_prefs')) return;
  await knex.schema.createTable('overview_prefs', (t) => {
    t.string('tenant_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.text('cards').notNullable();
    t.string('density', 20).notNullable().defaultTo('comfortable');
    t.bigInteger('updated_at').notNullable();
    t.primary(['tenant_id', 'user_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('overview_prefs');
}
