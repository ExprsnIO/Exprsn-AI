import type { Knex } from 'knex';

/*
 * Sprint 16: chat and AI depth. Retention periods per workspace and per user beside the tenant's (the shortest
 * applicable one wins); the tenant's sharing settings (anonymous links are off until a tenant admin turns them on);
 * share links marked anonymous (they open signed-out, only while the conversation is `public`).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('chat_retention_scopes', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('scope', 20).notNullable(); // workspace | user
    t.string('scope_id', 26).notNullable(); // the workspace or user id
    t.integer('conversation_days').notNullable();
    t.string('updated_by', 26).nullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'scope', 'scope_id']);
  });

  await knex.schema.createTable('chat_sharing_settings', (t) => {
    t.string('tenant_id', 26).primary();
    t.boolean('anonymous_links').notNullable().defaultTo(false);
    t.integer('anonymous_max_hours').notNullable().defaultTo(72);
    t.string('updated_by', 26).nullable();
    t.bigInteger('updated_at').notNullable();
  });

  await knex.schema.alterTable('conversation_shares', (t) => {
    t.boolean('anonymous').notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('conversation_shares', (t) => {
    t.dropColumn('anonymous');
  });
  await knex.schema.dropTableIfExists('chat_sharing_settings');
  await knex.schema.dropTableIfExists('chat_retention_scopes');
}
