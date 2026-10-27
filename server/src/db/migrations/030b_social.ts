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
 *
 * Messaging (B-2601 to B-2605), person to person, sealed at rest (no end-to-end encryption, so search and summaries
 * work). The `dm_` prefix keeps these apart from chat's `conversations` and `messages`.
 * - `dm_conversations`: `kind` direct (two people) or group. A group conversation lives in one workspace; a direct one
 *   has no workspace and needs the two to share one. `pair_key` (the two user ids, sorted) is set only for direct
 *   conversations and unique, so a pair has one direct conversation even when both start it at once. The title is
 *   sealed. `state` active | deleted.
 * - `dm_members`: one row per member with the role (owner, admin, member), `visible_from` (a member added later sees
 *   messages from then on), read and delivery receipts, the per-conversation mute (`muted_until`) and notification
 *   rule (`notify` all | mentions | none), and `last_seen_at` for presence.
 * - `dm_messages`: body sealed (the message id as associated data) and set to null when deleted; `thread_id` is the
 *   thread's first message; `reply_to_id` quotes a message; `forwarded_from` names the message it copies;
 *   `attachments` is a JSON list of file ids from the file store (already through its quarantine). `state` sent |
 *   hidden (moderation) | deleted.
 * - `dm_reactions`: one row per message, user and emoji.
 * - `dm_terms`: the keyword index, keyed hashes of the words of each message (as knowledge's terms), never the words.
 * Embeddings for semantic search live in the vector store (collection `dm-messages`, one partition per conversation).
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

  await knex.schema.createTable('dm_conversations', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('kind', 20).notNullable(); // direct | group
    t.string('workspace_id', 26).nullable();
    t.string('pair_key', 60).nullable().unique();
    t.text('title').nullable(); // sealed
    t.string('label', 20).notNullable();
    t.string('state', 20).notNullable(); // active | deleted
    t.string('created_by', 26).notNullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.bigInteger('last_message_at').nullable();
    t.index(['tenant_id', 'workspace_id']);
  });

  await knex.schema.createTable('dm_members', (t) => {
    t.string('conversation_id', 26).notNullable().references('id').inTable('dm_conversations').onDelete('CASCADE');
    t.string('tenant_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('role', 20).notNullable(); // owner | admin | member
    t.string('added_by', 26).nullable();
    t.bigInteger('joined_at').notNullable();
    t.bigInteger('visible_from').notNullable();
    t.string('last_read_id', 26).nullable();
    t.bigInteger('last_read_at').nullable();
    t.string('delivered_id', 26).nullable();
    t.bigInteger('delivered_at').nullable();
    t.bigInteger('muted_until').nullable();
    t.string('notify', 20).notNullable().defaultTo('all'); // all | mentions | none
    t.bigInteger('last_seen_at').nullable();
    t.primary(['conversation_id', 'user_id']);
    t.index(['tenant_id', 'user_id']);
  });

  await knex.schema.createTable('dm_messages', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('conversation_id', 26).notNullable().references('id').inTable('dm_conversations').onDelete('CASCADE');
    t.string('author_id', 26).notNullable();
    t.text('body', 'mediumtext').nullable(); // sealed; null once deleted
    t.string('reply_to_id', 26).nullable();
    t.string('thread_id', 26).nullable();
    t.integer('reply_count').notNullable().defaultTo(0);
    t.string('forwarded_from', 26).nullable();
    t.text('attachments').nullable(); // JSON: file ids
    t.string('label', 20).notNullable();
    t.string('state', 20).notNullable(); // sent | hidden | deleted
    t.integer('edits').notNullable().defaultTo(0);
    t.bigInteger('edited_at').nullable();
    t.bigInteger('pinned_at').nullable();
    t.string('pinned_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id', 'conversation_id', 'created_at']);
    t.index(['conversation_id', 'thread_id']);
  });

  await knex.schema.createTable('dm_reactions', (t) => {
    t.string('message_id', 26).notNullable().references('id').inTable('dm_messages').onDelete('CASCADE');
    t.string('tenant_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('emoji', 32).notNullable();
    t.bigInteger('created_at').notNullable();
    t.primary(['message_id', 'user_id', 'emoji']);
  });

  await knex.schema.createTable('dm_terms', (t) => {
    t.string('message_id', 26).notNullable().references('id').inTable('dm_messages').onDelete('CASCADE');
    t.string('tenant_id', 26).notNullable();
    t.string('conversation_id', 26).notNullable();
    t.string('term', 32).notNullable();
    t.integer('tf').notNullable();
    t.primary(['message_id', 'term']);
    t.index(['conversation_id', 'term']);
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const table of ['dm_terms', 'dm_reactions', 'dm_messages', 'dm_members', 'dm_conversations', 'social_settings', 'social_list_members', 'social_lists', 'social_follows', 'social_mutes', 'social_blocks']) await knex.schema.dropTableIfExists(table);
}
