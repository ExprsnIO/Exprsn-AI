import type { Knex } from 'knex';

/*
 * 1.7.0, Sprint 43 (B-99): the response cache.
 *
 * - `profiles.cache_ttl_seconds` (NULL: no cache, as every existing profile) and `profiles.cache_lenient` (false):
 *   a profile opts in to caching its answers, and may also cache turns with tools, attachments or a warm temperature.
 * - `chat_response_cache`: one entry per tenant and key (a SHA-256 of everything that shapes the answer), the answer
 *   and its thinking sealed with the tenant key, its label, and when it expires.
 * - `usage_records.cache_hit`: a turn answered from the cache (metered with no model tokens).
 *
 * Expand only; no existing row changes. A build from before this migration ignores the columns and the table.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('profiles', 'cache_ttl_seconds'))) {
    await knex.schema.alterTable('profiles', (t) => {
      t.integer('cache_ttl_seconds').nullable();
      t.boolean('cache_lenient').notNullable().defaultTo(false);
    });
  }
  if (!(await knex.schema.hasTable('chat_response_cache'))) {
    await knex.schema.createTable('chat_response_cache', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('workspace_id', 26).nullable();
      t.string('profile_id', 26).notNullable();
      t.string('key_hash', 64).notNullable();
      t.string('label', 20).notNullable();
      t.string('model', 200).notNullable();
      t.string('source', 10).notNullable();
      t.text('content', 'mediumtext').notNullable();
      t.text('thinking', 'mediumtext').nullable();
      t.text('citations', 'mediumtext').nullable();
      t.integer('hits').notNullable().defaultTo(0);
      t.bigInteger('created_at').notNullable();
      t.bigInteger('expires_at').notNullable();
      t.bigInteger('last_hit_at').nullable();
      t.unique(['tenant_id', 'key_hash']);
      t.index(['tenant_id', 'profile_id']);
      t.index(['expires_at']);
    });
  }
  if (!(await knex.schema.hasColumn('usage_records', 'cache_hit'))) {
    await knex.schema.alterTable('usage_records', (t) => {
      t.boolean('cache_hit').notNullable().defaultTo(false);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('usage_records', 'cache_hit')) await knex.schema.alterTable('usage_records', (t) => t.dropColumn('cache_hit'));
  await knex.schema.dropTableIfExists('chat_response_cache');
  if (await knex.schema.hasColumn('profiles', 'cache_ttl_seconds')) {
    await knex.schema.alterTable('profiles', (t) => {
      t.dropColumn('cache_ttl_seconds');
      t.dropColumn('cache_lenient');
    });
  }
}
