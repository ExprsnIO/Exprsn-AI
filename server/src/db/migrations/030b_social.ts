import type { Knex } from 'knex';

/*
 * Sprint 28b (1.4.0), social relations and messaging (030b): B-2601 to B-2606, shared with the workspace feed (B-2702).
 *
 * Relations (B-2606, B-2702), per tenant and per user:
 * - `social_blocks`: `user_id` blocks `target_id`. A block works in both directions (neither sees, hears from or
 *   messages the other); the row records who blocked.
 * - `social_mutes`: `user_id` mutes `target_id` (their posts leave the home feed, their messages notify nobody), until
 *   `expires_at` or for good (null). One-directional and invisible to the muted person.
 * - `social_follows`: `user_id` follows `target_id`.
 * - `social_lists` and `social_list_members`: a user's named lists of people (for list feeds). `name_key` is the lower
 *   case name, unique per owner.
 * - `social_settings`: per user, `contact_rule` (who may start a conversation with them or add them to one:
 *   `workspace` everyone who shares a workspace with them, `following` only people they follow, `nobody`).
 * Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('social_blocks', (t) => {
    t.string('tenant_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('target_id', 26).notNullable();
    t.bigInteger('created_at').notNullable();
    t.primary(['tenant_id', 'user_id', 'target_id']);
    t.index(['tenant_id', 'target_id']);
  });

  await knex.schema.createTable('social_mutes', (t) => {
    t.string('tenant_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('target_id', 26).notNullable();
    t.bigInteger('expires_at').nullable();
    t.bigInteger('created_at').notNullable();
    t.primary(['tenant_id', 'user_id', 'target_id']);
  });

  await knex.schema.createTable('social_follows', (t) => {
    t.string('tenant_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('target_id', 26).notNullable();
    t.bigInteger('created_at').notNullable();
    t.primary(['tenant_id', 'user_id', 'target_id']);
    t.index(['tenant_id', 'target_id']);
  });

  await knex.schema.createTable('social_lists', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('owner_id', 26).notNullable();
    t.string('name', 100).notNullable();
    t.string('name_key', 100).notNullable();
    t.string('description', 500).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'owner_id', 'name_key']);
  });

  await knex.schema.createTable('social_list_members', (t) => {
    t.string('list_id', 26).notNullable().references('id').inTable('social_lists').onDelete('CASCADE');
    t.string('tenant_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.bigInteger('added_at').notNullable();
    t.primary(['list_id', 'user_id']);
    t.index(['tenant_id', 'user_id']);
  });

  await knex.schema.createTable('social_settings', (t) => {
    t.string('tenant_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('contact_rule', 20).notNullable(); // workspace | following | nobody
    t.bigInteger('updated_at').notNullable();
    t.primary(['tenant_id', 'user_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const table of ['social_settings', 'social_list_members', 'social_lists', 'social_follows', 'social_mutes', 'social_blocks']) await knex.schema.dropTableIfExists(table);
}
