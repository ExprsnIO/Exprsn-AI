import type { Knex } from 'knex';

/*
 * Messaging folders: each person files the conversations they are in into their own folders, without changing the
 * conversation or what the other members see.
 *
 * - `dm_folders`: a person's custom folders (the name sealed with the tenant key, `dm-folder:<id>` as associated data),
 *   nested at most two deep (`parent_id` names a top-level folder), ordered by `position` among siblings.
 * - `dm_filings`: where one person filed one conversation: `archive` or a folder id. No row is the Inbox. `filed_at`
 *   lets a message from someone else after archiving bring the conversation back to the Inbox (decided on read).
 *
 * Expand only. A build from before this migration ignores the tables and shows every conversation as before.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('dm_folders'))) {
    await knex.schema.createTable('dm_folders', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('user_id', 26).notNullable();
      t.string('parent_id', 26).nullable();
      t.text('name').notNullable();
      t.integer('position').notNullable().defaultTo(0);
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.index(['tenant_id', 'user_id']);
    });
  }
  if (!(await knex.schema.hasTable('dm_filings'))) {
    await knex.schema.createTable('dm_filings', (t) => {
      t.string('conversation_id', 26).notNullable();
      t.string('user_id', 26).notNullable();
      t.string('tenant_id', 26).notNullable();
      t.string('folder', 26).notNullable();
      t.bigInteger('filed_at').notNullable();
      t.primary(['conversation_id', 'user_id']);
      t.index(['tenant_id', 'user_id', 'folder']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('dm_filings');
  await knex.schema.dropTableIfExists('dm_folders');
}
