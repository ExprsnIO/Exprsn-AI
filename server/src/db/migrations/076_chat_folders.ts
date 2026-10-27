import type { Knex } from 'knex';

/*
 * Chat organisation (2026-10-15).
 *
 * - `chat_folders`: a person's folders for their Chat conversations, per tenant, user and workspace (`workspace_id`
 *   null is "no workspace"), nested at most three deep (`parent_id`), ordered by `position` among siblings. The name
 *   is sealed with the tenant key (`chat-folder:<id>` as associated data).
 * - `conversations.folder_id`: the folder a conversation is filed in; null is no folder. Deleting a folder sets it
 *   back to null for every conversation in it and below it.
 * - `chat_message_groups`: named selections of messages in one conversation ("final answer", "ideas"). The name is
 *   sealed (`chat-group:<id>`); `message_ids` is a JSON array of message ids, never copies of their text, so a group
 *   reads what the conversation holds and access follows the conversation's.
 * - `conversation_exports.group_id`: an export of one group's messages instead of the active branch.
 *
 * Expand only. A build from before this migration ignores the new tables and columns.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('chat_folders'))) {
    await knex.schema.createTable('chat_folders', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('user_id', 26).notNullable();
      t.string('workspace_id', 26).nullable();
      t.string('parent_id', 26).nullable();
      t.text('name').notNullable();
      t.integer('position').notNullable().defaultTo(0);
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.index(['tenant_id', 'user_id', 'workspace_id']);
    });
  }
  if (!(await knex.schema.hasColumn('conversations', 'folder_id'))) {
    await knex.schema.alterTable('conversations', (t) => {
      t.string('folder_id', 26).nullable();
      t.index(['folder_id']);
    });
  }
  if (!(await knex.schema.hasTable('chat_message_groups'))) {
    await knex.schema.createTable('chat_message_groups', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('conversation_id', 26).notNullable();
      t.string('created_by', 26).notNullable();
      t.text('name').notNullable();
      t.text('message_ids').notNullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.index(['tenant_id', 'conversation_id']);
    });
  }
  if (!(await knex.schema.hasColumn('conversation_exports', 'group_id'))) {
    await knex.schema.alterTable('conversation_exports', (t) => {
      t.string('group_id', 26).nullable();
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('conversation_exports', 'group_id')) {
    await knex.schema.alterTable('conversation_exports', (t) => {
      t.dropColumn('group_id'); // contract: rollback of this migration only
    });
  }
  await knex.schema.dropTableIfExists('chat_message_groups'); // contract: rollback of this migration only
  if (await knex.schema.hasColumn('conversations', 'folder_id')) {
    await knex.schema.alterTable('conversations', (t) => {
      t.dropIndex(['folder_id']);
      t.dropColumn('folder_id'); // contract: rollback of this migration only
    });
  }
  await knex.schema.dropTableIfExists('chat_folders'); // contract: rollback of this migration only
}
