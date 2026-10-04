import type { Knex } from 'knex';

/*
 * Sprint 24 (B-1701 to B-1703): the tenant secrets vault.
 * - KV secrets by path: one row per path (label, current version, how many versions to keep, check-and-set, custom
 *   metadata) and one row per version holding the key/value map sealed with the tenant data key. Soft delete marks a
 *   version; destroy drops its sealed value for good.
 * - Transit keys: one row per named key (type, latest version, the minimum version that may still be decrypted or
 *   verified, the oldest version whose material is kept) and one row per version holding the key material sealed
 *   with the tenant data key (and, for signing keys, the public key).
 * - Policies: path-prefix grants (allow or deny a list of capabilities) to a user, a directory group, a workspace or
 *   an API key.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('vault_secrets', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('path', 400).notNullable();
    t.string('label', 20).notNullable();
    t.integer('current_version').notNullable().defaultTo(0);
    t.integer('max_versions').notNullable();
    t.boolean('cas_required').notNullable().defaultTo(false);
    t.text('custom_metadata').notNullable(); // JSON object of short strings
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'path']);
  });

  await knex.schema.createTable('vault_secret_versions', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('secret_id', 26).notNullable();
    t.integer('version').notNullable();
    t.text('value_sealed', 'mediumtext').nullable(); // null once destroyed
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('deleted_at').nullable();
    t.string('deleted_by', 26).nullable();
    t.bigInteger('destroyed_at').nullable();
    t.string('destroyed_by', 26).nullable();
    t.unique(['secret_id', 'version']);
  });

  await knex.schema.createTable('vault_transit_keys', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('name', 64).notNullable();
    t.string('type', 20).notNullable();
    t.string('label', 20).notNullable();
    t.integer('latest_version').notNullable();
    t.integer('min_decrypt_version').notNullable().defaultTo(1);
    t.integer('min_available_version').notNullable().defaultTo(1);
    t.boolean('deletion_allowed').notNullable().defaultTo(false);
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'name']);
  });

  await knex.schema.createTable('vault_transit_versions', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('key_id', 26).notNullable();
    t.integer('version').notNullable();
    t.text('material_sealed').notNullable();
    t.text('public_key').nullable(); // SPKI PEM for signing keys
    t.bigInteger('created_at').notNullable();
    t.unique(['key_id', 'version']);
  });

  await knex.schema.createTable('vault_policies', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('subject_kind', 20).notNullable(); // user | group | workspace | api_key
    t.string('subject', 200).notNullable();
    t.string('path', 400).notNullable(); // a path prefix, or * for every path
    t.text('capabilities').notNullable(); // JSON array
    t.string('effect', 10).notNullable(); // allow | deny
    t.string('description', 500).nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id', 'subject_kind']);
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const table of ['vault_policies', 'vault_transit_versions', 'vault_transit_keys', 'vault_secret_versions', 'vault_secrets']) await knex.schema.dropTableIfExists(table);
}
