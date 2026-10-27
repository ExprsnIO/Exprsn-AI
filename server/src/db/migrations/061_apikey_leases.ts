import type { Knex } from 'knex';

/*
 * 1.7.0, Sprint 41 (B-9301, B-9302): dynamic API-key leases on the generic lease table of `060_vault_system_scope`.
 *
 * - `vault_apikey_providers` (B-9302): an outside service that makes and revokes keys (GitHub App installation
 *   tokens are the reference provider), with its admin credential as a vault reference. The built-in provider
 *   `exprsn`, which issues this server's own API keys (B-9301), has no row.
 * - `vault_apikey_roles`: a provider's roles: the scope set and the lifetime of the keys it issues.
 * - `api_keys.lease_id`: the lease an API key was issued under. Such a key is accepted only while its lease is
 *   live. Existing keys keep NULL and are unaffected.
 *
 * Expand only; no existing row changes.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('vault_apikey_providers'))) {
    await knex.schema.createTable('vault_apikey_providers', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('name', 64).notNullable();
      t.string('kind', 40).notNullable(); // github
      t.string('endpoint', 300).notNullable();
      t.string('label', 20).notNullable();
      t.text('config').notNullable(); // JSON, nothing secret
      t.string('credential_ref', 600).nullable(); // vault:path#key, read as the owner
      t.string('owner_id', 26).nullable();
      t.string('state', 12).notNullable(); // active | disabled
      t.string('created_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.unique(['tenant_id', 'name']);
    });
  }
  if (!(await knex.schema.hasTable('vault_apikey_roles'))) {
    await knex.schema.createTable('vault_apikey_roles', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('provider', 64).notNullable(); // `exprsn`, or a row of vault_apikey_providers by name
      t.string('name', 64).notNullable();
      t.text('scopes').notNullable(); // JSON array
      t.text('config').notNullable(); // JSON, the provider's own (repositories, ...)
      t.integer('ttl_s').nullable();
      t.integer('max_ttl_s').nullable();
      t.string('created_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.unique(['tenant_id', 'provider', 'name']);
    });
  }
  if (!(await knex.schema.hasColumn('api_keys', 'lease_id'))) {
    await knex.schema.alterTable('api_keys', (t) => {
      t.string('lease_id', 26).nullable();
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('api_keys', 'lease_id')) {
    await knex.schema.alterTable('api_keys', (t) => {
      t.dropColumn('lease_id');
    });
  }
  await knex.schema.dropTableIfExists('vault_apikey_roles');
  await knex.schema.dropTableIfExists('vault_apikey_providers');
}
