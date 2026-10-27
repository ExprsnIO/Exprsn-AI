import type { Knex } from 'knex';

/*
 * 1.8.0, Sprint 48 (B-147): the plugin creator.
 *
 * - `plugin_drafts`: one person's wizard state for a plugin they are writing (`wizard`, JSON: the basics, the
 *   capabilities, the UI surfaces, the events and handler), the step they were on, and the plugin it was installed as
 *   (`plugin_id`, once installed as a draft). A draft is data: the server builds a manifest from it and checks it, it
 *   never loads or runs anything from it. Drafts are private to their author.
 *
 * Expand only. A build from before this migration ignores the table.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('plugin_drafts')) return;
  await knex.schema.createTable('plugin_drafts', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('name', 100).notNullable();
    t.string('plugin_key', 63).nullable();
    t.integer('step').notNullable().defaultTo(1);
    t.text('wizard', 'mediumtext').notNullable();
    t.string('plugin_id', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id', 'user_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('plugin_drafts');
}
