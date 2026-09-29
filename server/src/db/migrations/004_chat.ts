import type { Knex } from 'knex';

/*
 * Sprint 4: conversations, messages (a tree: every message has a parent, so edits and regenerations are branches),
 * and attachments. Titles, message content and thinking are sealed with the tenant's data key.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('conversations', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).nullable();
    t.string('user_id', 26).notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('kind', 20).notNullable(); // chat | compare
    t.text('title').nullable(); // sealed
    t.string('profile_id', 26).nullable();
    t.string('label', 20).notNullable();
    t.string('head_id', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.bigInteger('archived_at').nullable();
    t.index(['tenant_id', 'user_id', 'updated_at']);
  });

  await knex.schema.createTable('messages', (t) => {
    t.string('id', 26).primary();
    t.string('conversation_id', 26).notNullable().references('id').inTable('conversations').onDelete('CASCADE');
    t.string('tenant_id', 26).notNullable();
    t.string('parent_id', 26).nullable();
    t.string('role', 20).notNullable(); // user | assistant
    t.text('content', 'mediumtext').nullable(); // sealed; MySQL TEXT is only 64 KB
    t.text('thinking', 'mediumtext').nullable(); // sealed
    t.text('tools', 'mediumtext').nullable(); // sealed JSON: calculation steps
    t.string('state', 20).notNullable(); // queued | streaming | complete | stopped | failed
    t.string('profile_id', 26).nullable();
    t.string('profile_name', 63).nullable();
    t.string('model', 200).nullable();
    t.string('instance_id', 26).nullable();
    t.string('think', 10).nullable();
    t.integer('compare_slot').nullable();
    t.string('error', 500).nullable();
    t.string('label', 20).notNullable();
    t.text('attachments').nullable(); // JSON array of attachment ids
    t.bigInteger('prompt_tokens').nullable();
    t.bigInteger('output_tokens').nullable();
    t.bigInteger('thinking_tokens').nullable();
    t.integer('calc_calls').nullable();
    t.bigInteger('gpu_ms').nullable();
    t.integer('first_token_ms').nullable();
    t.integer('seq').notNullable().defaultTo(0);
    t.boolean('canary').notNullable().defaultTo(false);
    t.bigInteger('created_at').notNullable();
    t.bigInteger('completed_at').nullable();
    t.index(['conversation_id', 'created_at']);
  });

  await knex.schema.createTable('attachments', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).nullable();
    t.string('user_id', 26).notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('name', 255).notNullable();
    t.string('type', 100).notNullable(); // detected media type once scanned
    t.string('declared_type', 100).nullable();
    t.bigInteger('size').notNullable();
    t.string('sha256', 64).notNullable();
    t.string('state', 20).notNullable(); // quarantined | scanning | rejected | ready
    t.string('label', 20).notNullable();
    t.string('reason', 500).nullable();
    t.text('findings').nullable(); // JSON: scanner verdict and classifier detections (kinds and counts only)
    t.string('blob_key', 300).nullable();
    t.bigInteger('created_at').notNullable();
    t.index(['tenant_id', 'user_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const table of ['attachments', 'messages', 'conversations']) await knex.schema.dropTableIfExists(table);
}
