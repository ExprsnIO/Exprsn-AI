import type { Knex } from 'knex';

/*
 * 1.7.0, Sprint 42 (B-9207): signing keys as vault keys.
 *
 * - `vault_signing_keys`: a signing key of another domain (OIDC, SAML, webhooks, the CA and its OCSP responders,
 *   content credentials, the ACME account, AT-Protocol, the PDS) registered with the vault by reference: its domain,
 *   the domain's own id for it, where its private half is (`signer`, `openbao`, or `sealed` in the database) and its
 *   path in the vault's transit namespace. A row holds no key material and none is moved: the key stays in its own
 *   table, in the signer or in OpenBao. Rows of the platform scope carry `platform` in `tenant_id`.
 * - `vault_transit_keys.custody`: where a transit key's private half lives. NULL (every existing key): sealed in
 *   `vault_transit_versions` and used in this process. `signer` or `openbao`: made and used there, with a reference
 *   in the version row and never the material.
 *
 * Expand only; no existing row changes and nothing is registered by the migration. A build from before it ignores
 * both; it cannot sign with a held transit key (it would take the reference for sealed material and refuse).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('vault_signing_keys'))) {
    await knex.schema.createTable('vault_signing_keys', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable(); // a tenant, or `platform`
      t.string('domain', 20).notNullable(); // oidc | saml | saml-enc | webhook | ca | ocsp | content | acme | atproto | pds
      t.string('source_id', 200).notNullable(); // the domain's own id for the key
      t.string('path', 400).notNullable(); // transit/signing/<domain>/<name>
      t.string('backend', 12).notNullable(); // signer | openbao | sealed, as it was when registered
      t.string('key_type', 40).notNullable();
      t.string('title', 200).notNullable();
      t.string('registered_by', 26).nullable();
      t.bigInteger('registered_at').notNullable();
      t.unique(['tenant_id', 'domain', 'source_id']);
    });
  }
  if (!(await knex.schema.hasColumn('vault_transit_keys', 'custody'))) {
    await knex.schema.alterTable('vault_transit_keys', (t) => {
      t.string('custody', 12).nullable();
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('vault_signing_keys');
  if (await knex.schema.hasColumn('vault_transit_keys', 'custody')) {
    await knex.schema.alterTable('vault_transit_keys', (t) => {
      t.dropColumn('custody');
    });
  }
}
