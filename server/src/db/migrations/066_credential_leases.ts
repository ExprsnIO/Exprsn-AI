import type { Knex } from 'knex';

/*
 * 1.7.0, Sprint 42 (B-9206): sessions and API keys as leases.
 *
 * - `api_keys.store_lease_id`: the lease in `vault_leases` that holds the verifier of a key stored as a lease
 *   (`exai_k2_`). Such a key's row here is its record (name, scopes, the id other tables point at) and holds no
 *   verifier. Existing keys keep NULL and are verified from this table as before.
 *
 * Sessions need no column: a session stored as a lease is a row of `vault_leases` of kind `session` and has no row
 * in `sessions`. Nothing is copied or converted: both stores are read, by the form of the token or key, and what
 * exists ends by itself (a session at its absolute lifetime, a key at its expiry or when it is revoked).
 *
 * Expand only; no existing row changes. A build from before this migration ignores the column.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('api_keys', 'store_lease_id'))) {
    await knex.schema.alterTable('api_keys', (t) => {
      t.string('store_lease_id', 26).nullable();
      t.index(['store_lease_id']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('api_keys', 'store_lease_id')) {
    await knex.schema.alterTable('api_keys', (t) => {
      t.dropIndex(['store_lease_id']);
      t.dropColumn('store_lease_id');
    });
  }
}
