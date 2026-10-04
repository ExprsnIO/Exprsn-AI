import type { Knex } from 'knex';

/*
 * Sprint 25 (B-1605 to B-1607): the ACME server and certificate lifecycle.
 * - pki_acme_settings: one row per tenant: whether its ACME directory is open, the server profile orders are issued
 *   under (its allowed names bound what may be ordered), whether accounts need external account binding, and which
 *   challenge types are offered.
 * - pki_acme_eab_keys: external account binding keys (RFC 8555 7.3.4); the MAC key is sealed with the tenant key and
 *   shown once. A key binds one account.
 * - pki_acme_accounts: ACME accounts per tenant, by JWK thumbprint (RFC 7638).
 * - pki_acme_nonces: single-use replay nonces (any instance can consume any instance's nonce).
 * - pki_acme_orders, pki_acme_authorizations, pki_acme_challenges: the RFC 8555 objects, always with the tenant and
 *   the account that owns them.
 * - pki_expiry_notices: one row per certificate and notice threshold (30 and 7 days), so a notice is sent once.
 * - pki_certificates.renewed_from: the certificate a renewal replaced.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('pki_acme_settings', (t) => {
    t.string('tenant_id', 26).primary();
    t.boolean('enabled').notNullable().defaultTo(false);
    t.string('profile_id', 26).nullable();
    t.boolean('eab_required').notNullable().defaultTo(false);
    t.string('challenges', 64).notNullable().defaultTo('http-01,dns-01');
    t.string('updated_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
  });

  await knex.schema.createTable('pki_acme_eab_keys', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('name', 100).notNullable();
    t.text('key_sealed').notNullable();
    t.string('state', 16).notNullable(); // active | bound | revoked
    t.string('account_id', 26).nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('bound_at').nullable();
    t.index(['tenant_id', 'state']);
  });

  await knex.schema.createTable('pki_acme_accounts', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('thumbprint', 64).notNullable();
    t.text('jwk').notNullable();
    t.text('contact').notNullable(); // JSON array of mailto: URLs
    t.string('status', 16).notNullable(); // valid | deactivated | revoked
    t.string('eab_key_id', 26).nullable();
    t.string('created_ip', 64).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'thumbprint']);
  });

  await knex.schema.createTable('pki_acme_nonces', (t) => {
    t.string('nonce', 64).primary();
    t.bigInteger('expires_at').notNullable();
    t.index(['expires_at']);
  });

  await knex.schema.createTable('pki_acme_orders', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('account_id', 26).notNullable();
    t.string('status', 16).notNullable(); // pending | ready | processing | valid | invalid
    t.text('identifiers').notNullable(); // JSON [{ type: 'dns', value }]
    t.string('profile_id', 26).notNullable();
    t.bigInteger('expires_at').notNullable();
    t.text('error').nullable(); // JSON problem
    t.string('certificate_id', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id', 'account_id', 'status']);
    t.index(['tenant_id', 'created_at']);
  });

  await knex.schema.createTable('pki_acme_authorizations', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('account_id', 26).notNullable();
    t.string('order_id', 26).notNullable();
    t.string('identifier', 255).notNullable(); // the name without a wildcard's "*."
    t.boolean('wildcard').notNullable().defaultTo(false);
    t.string('status', 16).notNullable(); // pending | valid | invalid | deactivated | expired | revoked
    t.bigInteger('expires_at').notNullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['order_id']);
  });

  await knex.schema.createTable('pki_acme_challenges', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('authz_id', 26).notNullable();
    t.string('type', 16).notNullable(); // http-01 | dns-01
    t.string('token', 64).notNullable();
    t.string('status', 16).notNullable(); // pending | processing | valid | invalid
    t.text('error').nullable(); // JSON problem
    t.bigInteger('validated_at').nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['authz_id']);
  });

  await knex.schema.createTable('pki_expiry_notices', (t) => {
    t.string('certificate_id', 26).notNullable();
    t.integer('threshold').notNullable(); // days
    t.string('tenant_id', 26).notNullable();
    t.bigInteger('sent_at').notNullable();
    t.primary(['certificate_id', 'threshold']);
  });

  await knex.schema.alterTable('pki_certificates', (t) => {
    t.string('renewed_from', 26).nullable();
    t.string('acme_account_id', 26).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('pki_certificates', (t) => {
    t.dropColumn('acme_account_id');
    t.dropColumn('renewed_from');
  });
  for (const table of ['pki_expiry_notices', 'pki_acme_challenges', 'pki_acme_authorizations', 'pki_acme_orders', 'pki_acme_nonces', 'pki_acme_accounts', 'pki_acme_eab_keys', 'pki_acme_settings']) await knex.schema.dropTableIfExists(table);
}
