import type { Knex } from 'knex';

/*
 * 1.9.0, Sprint 55 (B-192 to B-194): leaked-password lists, checks against them and tenant deny words.
 *
 * - `leaked_password_lists`: a named list owned by the platform (`owner` = 'platform', `tenant_id` null) or by one
 *   tenant (`owner` = its id). Its hash kind (`sha1` or `ntlm`) is fixed when it is made; `active_version` is the
 *   version checks use (null until one is built; a rollback points it at an older one).
 * - `leaked_password_versions`: one import or mirror of a list. Its state goes staging → building → ready (or
 *   failed); the counts (lines read, invalid, duplicates, entries), the Bloom filter's size, hash count and false-
 *   positive rate, the prefix length of its shards and the blob prefix they live under; for an HIBP mirror the
 *   cursor (the next of the 16^5 range prefixes) so a stopped mirror resumes. Nothing in it is a password: the blob
 *   store holds sorted binary hashes only.
 * - `leaked_password_shards`: each shard of a version (its hex prefix, how many hashes, how many bytes).
 * - `leaked_password_checks`: per account, when its password was last checked at sign-in and against which list
 *   versions, and when (and with which action) it was found on one.
 * - `leaked_password_settings`: per tenant, what a sign-in with a newly listed password does (warn, require change,
 *   block), whether a check that cannot run accepts or refuses a new password, and the tenant's deny words (or a
 *   guardrail term list used as them).
 *
 * Expand only: five new tables.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('leaked_password_lists', (t) => {
    t.string('id', 26).primary();
    t.string('owner', 26).notNullable(); // 'platform' or the tenant's id
    t.string('tenant_id', 26).nullable();
    t.string('name', 100).notNullable();
    t.string('description', 500).nullable();
    t.string('hash_kind', 8).notNullable();
    t.string('source', 32).notNullable();
    t.boolean('enabled').notNullable().defaultTo(true);
    t.integer('active_version').nullable();
    t.integer('latest_version').notNullable().defaultTo(0);
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['owner', 'name']);
  });
  await knex.schema.createTable('leaked_password_versions', (t) => {
    t.string('id', 26).primary();
    t.string('list_id', 26).notNullable().references('id').inTable('leaked_password_lists').onDelete('CASCADE');
    t.integer('version').notNullable();
    t.string('state', 16).notNullable();
    t.string('format', 16).notNullable();
    t.string('source', 32).notNullable();
    t.string('note', 500).nullable();
    t.boolean('activate').notNullable().defaultTo(true);
    t.bigInteger('lines_read').notNullable().defaultTo(0);
    t.bigInteger('invalid').notNullable().defaultTo(0);
    t.bigInteger('duplicates').notNullable().defaultTo(0);
    t.bigInteger('entries').notNullable().defaultTo(0);
    t.bigInteger('bytes').notNullable().defaultTo(0);
    t.bigInteger('bloom_bits').notNullable().defaultTo(0);
    t.integer('bloom_hashes').notNullable().defaultTo(0);
    t.double('fp_rate').notNullable().defaultTo(0);
    t.integer('prefix_len').notNullable().defaultTo(2);
    t.string('blob_prefix', 200).notNullable();
    t.integer('mirror_cursor').nullable();
    t.integer('mirror_total').nullable();
    t.string('job_id', 26).nullable();
    t.string('error', 500).nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('built_at').nullable();
    t.unique(['list_id', 'version']);
  });
  await knex.schema.createTable('leaked_password_shards', (t) => {
    t.string('version_id', 26).notNullable().references('id').inTable('leaked_password_versions').onDelete('CASCADE');
    t.string('prefix', 8).notNullable();
    t.integer('entries').notNullable();
    t.integer('bytes').notNullable();
    t.primary(['version_id', 'prefix']);
  });
  await knex.schema.createTable('leaked_password_checks', (t) => {
    t.string('user_id', 26).primary();
    t.string('tenant_id', 26).notNullable().index();
    t.bigInteger('checked_at').notNullable();
    t.text('versions').notNullable(); // JSON: the list version ids checked
    t.bigInteger('flagged_at').nullable();
    t.string('flag_action', 16).nullable();
  });
  await knex.schema.createTable('leaked_password_settings', (t) => {
    t.string('tenant_id', 26).primary();
    t.string('signin_action', 16).notNullable().defaultTo('require_change');
    t.string('fail_mode', 8).notNullable().defaultTo('open');
    t.text('deny_words').notNullable(); // JSON: strings
    t.string('deny_term_list', 26).nullable();
    t.string('updated_by', 26).nullable();
    t.bigInteger('updated_at').notNullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('leaked_password_settings');
  await knex.schema.dropTableIfExists('leaked_password_checks');
  await knex.schema.dropTableIfExists('leaked_password_shards');
  await knex.schema.dropTableIfExists('leaked_password_versions');
  await knex.schema.dropTableIfExists('leaked_password_lists');
}
