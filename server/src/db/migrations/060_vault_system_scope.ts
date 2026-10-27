import type { Knex } from 'knex';

/*
 * 1.7.0, Sprint 41 (B-9201 to B-9205): the vault's platform scope and the generic lease table.
 *
 * - `vault_leases` (B-9204): leases of any kind, generalised from the database leases of `vault_db_leases`: who holds
 *   one, an optional verifier (a digest of the secret its holder presents, for one indexed lookup), the renew period
 *   (the idle timeout), the absolute maximum, and the state the sweeper works on. Rows of the platform scope carry
 *   `platform` in `tenant_id`.
 *
 * The platform scope itself needs no new table: its keys, versions and grants are rows of `vault_transit_keys`,
 * `vault_transit_versions` and `vault_policies` with `platform` in `tenant_id`, created by the server when it opens
 * the scope (the named HMAC keys of B-9205, whose first version is the SESSION_SECRET in use). This migration changes
 * no existing row.
 *
 * Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('vault_leases'))) {
    await knex.schema.createTable('vault_leases', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable(); // a tenant, or `platform`
      t.string('kind', 40).notNullable(); // apikey, session, ...
      t.string('holder_kind', 20).notNullable(); // user | api_key | service
      t.string('holder', 200).nullable();
      t.string('ref', 200).nullable(); // the kind's own id for what is leased
      t.string('verifier', 64).nullable(); // a digest, never the secret
      t.string('label', 20).notNullable();
      t.text('data').notNullable(); // JSON, nothing secret
      t.string('state', 12).notNullable(); // active | revoking | revoked | expired
      t.bigInteger('issued_at').notNullable();
      t.bigInteger('renewed_at').notNullable();
      t.bigInteger('renew_period_ms').notNullable();
      t.bigInteger('expires_at').notNullable();
      t.bigInteger('max_expires_at').notNullable();
      t.integer('renewals').notNullable().defaultTo(0);
      t.bigInteger('ended_at').nullable();
      t.string('ended_by', 64).nullable();
      t.string('end_reason', 40).nullable();
      t.integer('attempts').notNullable().defaultTo(0);
      t.string('last_error', 500).nullable();
      t.bigInteger('next_attempt_at').nullable();
      t.unique(['verifier']);
      t.index(['tenant_id', 'kind', 'state']);
      t.index(['state', 'expires_at']);
      t.index(['tenant_id', 'holder']);
      t.index(['tenant_id', 'ref']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('vault_leases');
}
