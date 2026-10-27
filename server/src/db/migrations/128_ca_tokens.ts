import type { Knex } from 'knex';

/*
 * 1.9.0, Sprint 55 (B-188, B-189): CA tokens, one-time tickets and member certificates.
 *
 * - `pki_token_signers`: each tenant's token-signing certificates. The certificate is an end-entity certificate under
 *   the tenant's intermediate (also a row of `pki_certificates`, so it can be revoked on the Certificates screen); its
 *   key is in custody like every CA key (`custody`, `key_name`, and the signer's opaque `key_wrapped`). `alg` is the
 *   JWS algorithm it signs with (ES256, ES384 or PS256). `state` is `active` (signs new tokens) or `retired` (still
 *   verifies what it signed). Revoking its certificate ends every token it signed.
 * - `pki_tokens`: one row per token or ticket. The token itself is never stored: `hash` is the SHA-256 of the compact
 *   JWS (unique) and `id` its `jti`. A token is bound to one resource (`resource_type` url, did or cid, and
 *   `resource`), carries permission bits (read 1, write 2, append 4, delete 8, admin 16), and ends by time
 *   (`expires_at`), by uses (`max_uses`, `uses_left`, spent in one conditional update) or never (`expiry`
 *   `persistent`, until revoked or its signer's certificate ends). A ticket (`kind` ticket) is good for one use of one
 *   `action`. `state` is `active`, `revoked`, `spent` or `replaced` (refreshed into `replaced_by`).
 * - `pki_member_certificates`: the client certificate a member gets when they join (a tenant setting). `key_sealed`
 *   holds the key made for them, sealed with the tenant key, until they pick it up once in Settings; `token_sealed`
 *   the optional CA token the same way. `state` is `active`, `replaced` (renewed) or `revoked` (they left).
 *
 * Expand only. A build without this migration reports CA tokens and member certificates as not configured.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('pki_token_signers'))) {
    await knex.schema.createTable('pki_token_signers', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('issuer_id', 26).notNullable();
      t.string('certificate_id', 26).notNullable();
      t.string('custody', 10).notNullable();
      t.string('key_name', 200).notNullable();
      t.text('key_wrapped').nullable();
      t.string('key_type', 16).notNullable();
      t.string('alg', 8).notNullable();
      t.text('public_key_pem').notNullable();
      t.text('certificate_pem').notNullable();
      t.string('fingerprint', 64).notNullable();
      t.bigInteger('not_after').notNullable();
      t.string('state', 10).notNullable().defaultTo('active');
      t.bigInteger('created_at').notNullable();
      t.bigInteger('retired_at').nullable();
      t.index(['tenant_id', 'state']);
      t.index(['certificate_id']);
      t.index(['issuer_id']);
    });
  }
  if (!(await knex.schema.hasTable('pki_tokens'))) {
    await knex.schema.createTable('pki_tokens', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('signer_id', 26).notNullable();
      t.string('hash', 64).notNullable().unique();
      t.string('kind', 8).notNullable().defaultTo('token');
      t.string('resource_type', 8).notNullable();
      t.string('resource', 500).notNullable();
      t.integer('permissions').notNullable();
      t.string('action', 100).nullable();
      t.string('subject', 26).nullable();
      t.string('label', 200).nullable();
      t.string('expiry', 12).notNullable();
      t.bigInteger('expires_at').nullable();
      t.integer('max_uses').nullable();
      t.integer('uses_left').nullable();
      t.integer('size').notNullable().defaultTo(0);
      t.string('state', 10).notNullable().defaultTo('active');
      t.bigInteger('revoked_at').nullable();
      t.string('revoked_reason', 100).nullable();
      t.string('replaced_by', 26).nullable();
      t.string('refreshed_from', 26).nullable();
      t.string('created_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('last_used_at').nullable();
      t.index(['tenant_id', 'state', 'created_at']);
      t.index(['signer_id', 'state']);
      t.index(['tenant_id', 'subject']);
    });
  }
  if (!(await knex.schema.hasTable('pki_member_certificates'))) {
    await knex.schema.createTable('pki_member_certificates', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('user_id', 26).notNullable();
      t.string('certificate_id', 26).notNullable();
      t.string('token_id', 26).nullable();
      t.string('state', 10).notNullable().defaultTo('active');
      t.text('key_sealed').nullable();
      t.text('token_sealed').nullable();
      t.bigInteger('picked_up_at').nullable();
      t.string('renewed_from', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.bigInteger('revoked_at').nullable();
      t.index(['tenant_id', 'user_id', 'state']);
      t.index(['certificate_id']);
      t.index(['state']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('pki_member_certificates');
  await knex.schema.dropTableIfExists('pki_tokens');
  await knex.schema.dropTableIfExists('pki_token_signers');
}
