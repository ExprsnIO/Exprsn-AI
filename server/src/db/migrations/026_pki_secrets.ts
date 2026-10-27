import type { Knex } from 'knex';

/*
 * Sprint 24 (B-1601 to B-1604): the certificate authority.
 * - pki_issuers: the platform root (tenant_id null) and each tenant's intermediates. Rows hold the certificate, the
 *   public key and a reference to the private key in the signer (its wrapped blob) or OpenBao transit (its key
 *   name); never a private key. A rotation adds a row and retires the old one, which keeps serving CRLs and OCSP.
 * - pki_responders: the delegated OCSP signing certificates each issuer has issued (short-lived, keys held as above).
 * - pki_profiles: per-tenant issuance policy (kind, SAN rules, key types, lifetimes).
 * - pki_certificates: issued end-entity certificates and their revocation (RFC 5280 reason codes).
 * - pki_crls: every CRL each issuer has signed, numbered (cRLNumber) per issuer.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('pki_issuers', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).nullable(); // null: the platform root
    t.string('parent_id', 26).nullable(); // the issuer that signed this one; null for a root
    t.string('kind', 16).notNullable(); // root | intermediate
    t.string('name', 200).notNullable(); // the subject common name
    t.string('organization', 200).nullable();
    t.string('key_type', 16).notNullable(); // ecdsa-p256 | rsa-3072
    t.string('custody', 16).notNullable(); // signer | openbao
    t.string('key_name', 200).notNullable();
    t.text('key_wrapped').nullable(); // the signer's wrapped blob; the app cannot open it
    t.text('public_key_pem').notNullable();
    t.text('subject_der').notNullable(); // base64 of the subject Name, byte for byte
    t.string('serial', 64).notNullable(); // hex
    t.text('certificate_pem').notNullable();
    t.integer('generation').notNullable().defaultTo(1);
    t.integer('path_len').nullable();
    t.bigInteger('not_before').notNullable();
    t.bigInteger('not_after').notNullable();
    t.string('state', 16).notNullable(); // active | retired | revoked
    t.bigInteger('revoked_at').nullable();
    t.integer('revocation_reason').nullable();
    t.bigInteger('crl_number').notNullable().defaultTo(0); // the last CRL number used
    t.string('replaced_by', 26).nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id', 'state']);
    t.index(['parent_id', 'serial']);
  });

  await knex.schema.createTable('pki_responders', (t) => {
    t.string('id', 26).primary();
    t.string('issuer_id', 26).notNullable();
    t.string('key_type', 16).notNullable();
    t.string('custody', 16).notNullable();
    t.string('key_name', 200).notNullable();
    t.text('key_wrapped').nullable();
    t.string('serial', 64).notNullable();
    t.text('certificate_pem').notNullable();
    t.bigInteger('not_before').notNullable();
    t.bigInteger('not_after').notNullable();
    t.bigInteger('created_at').notNullable();
    t.index(['issuer_id', 'not_after']);
  });

  await knex.schema.createTable('pki_profiles', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('name', 100).notNullable();
    t.string('kind', 20).notNullable(); // server | client | code-signing
    t.text('policy').notNullable(); // JSON: SAN rules and key types
    t.integer('max_days').notNullable();
    t.integer('default_days').notNullable();
    t.string('state', 16).notNullable(); // active | disabled
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'name']);
  });

  await knex.schema.createTable('pki_certificates', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('issuer_id', 26).notNullable();
    t.string('profile_id', 26).nullable();
    t.string('serial', 64).notNullable(); // hex
    t.string('common_name', 255).nullable();
    t.text('sans').notNullable(); // JSON [{ type, value }]
    t.string('key_type', 16).notNullable();
    t.bigInteger('not_before').notNullable();
    t.bigInteger('not_after').notNullable();
    t.text('certificate_pem').notNullable();
    t.string('fingerprint', 64).notNullable(); // SHA-256 of the DER, hex
    t.string('state', 16).notNullable(); // valid | revoked
    t.bigInteger('revoked_at').nullable();
    t.integer('revocation_reason').nullable();
    t.bigInteger('invalidity_date').nullable();
    t.string('revoked_by', 26).nullable();
    t.string('requested_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.unique(['issuer_id', 'serial']);
    t.index(['tenant_id', 'created_at']);
    t.index(['issuer_id', 'state']);
  });

  await knex.schema.createTable('pki_crls', (t) => {
    t.string('id', 26).primary();
    t.string('issuer_id', 26).notNullable();
    t.bigInteger('number').notNullable();
    t.bigInteger('this_update').notNullable();
    t.bigInteger('next_update').notNullable();
    t.integer('entries').notNullable();
    t.text('der', 'mediumtext').notNullable(); // base64
    t.bigInteger('created_at').notNullable();
    t.unique(['issuer_id', 'number']);
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const table of ['pki_crls', 'pki_certificates', 'pki_profiles', 'pki_responders', 'pki_issuers']) await knex.schema.dropTableIfExists(table);
}
