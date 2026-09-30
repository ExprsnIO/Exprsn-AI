import type { Knex } from 'knex';

/*
 * Sprint 12: chat. Answers can be held for review (`state` held, withdrawn) and interrupted when the instance
 * generating them stops: each streaming answer records the instance generating it and a heartbeat. Stream chunks are
 * kept briefly (sealed, in batches) so a client on any instance can catch up. Tenants set a conversation retention.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('messages', (t) => {
    t.string('generator', 40).nullable(); // the app instance generating the answer
    t.bigInteger('heartbeat_at').nullable(); // its last sign of life; stale means interrupted
  });

  await knex.schema.createTable('chat_stream_chunks', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('message_id', 26).notNullable();
    t.integer('from_seq').notNullable();
    t.integer('to_seq').notNullable();
    t.text('data', 'mediumtext').notNullable(); // sealed JSON array of chunks
    t.bigInteger('created_at').notNullable();
    t.index(['message_id', 'to_seq']);
    t.index(['created_at']);
  });

  await knex.schema.createTable('chat_retention', (t) => {
    t.string('tenant_id', 26).primary();
    t.integer('conversation_days').nullable(); // null: keep conversations until their owner deletes them
    t.string('updated_by', 26).nullable();
    t.bigInteger('updated_at').notNullable();
    t.bigInteger('last_run_at').nullable();
    t.integer('last_purged').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('chat_retention');
  await knex.schema.dropTableIfExists('chat_stream_chunks');
  await knex.schema.alterTable('messages', (t) => {
    t.dropColumn('generator');
    t.dropColumn('heartbeat_at');
  });
}
