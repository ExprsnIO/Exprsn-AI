import type { Knex } from 'knex';

/*
 * 1.9.99-final, Sprint 56 (B-10003 to B-10006): the federation issuer the clouds trust and the state of each cloud
 * account's credential (`cloud/issuer.ts`, `cloud/credentials.ts`).
 *
 * - `cloud_issuer_keys`: the issuer's signing keys, apart from the console's own OIDC keys (`federation_keys`). `alg`
 *   is ES256, or RS256 for the key used only for the Azure audience (open decision 3). `private_ref` is `signer:` and
 *   the signer's wrapped blob, or `kms:` and an OpenBao transit key name; only when neither is configured is it the
 *   private key sealed with the platform data key. `state`: next (published, not signing) | signing | retired (still
 *   published until `removes_at`, after every session bought with it has ended).
 * - `cloud_issuer_state`: one row (`id` = `issuer`): where the discovery document and JWKS are published (`target`,
 *   JSON with references only, never a value), what was published last (`published_kids`, `published_hash`) and the
 *   last comparison of the published JWKS with the issuer's keys (`check_state`: ok | mismatch | error | unpublished).
 * - `cloud_credential_state`: per account, what is known of its credential beyond the references in
 *   `cloud_credentials`: last use, the rotation in progress (`previous` holds the provider's id of the key or secret
 *   that is deleted when the overlap ends, never a value), when it expires and which expiry notice was sent.
 *
 * Expand only: three new tables. While they are missing, the issuer reports itself as not installed and federated
 * credentials are unavailable.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('cloud_issuer_keys'))) {
    await knex.schema.createTable('cloud_issuer_keys', (t) => {
      t.string('kid', 40).primary();
      t.string('alg', 10).notNullable(); // ES256 | RS256
      t.string('state', 10).notNullable(); // next | signing | retired
      t.text('public_jwk').notNullable();
      t.text('private_ref', 'mediumtext').notNullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('activates_at').notNullable();
      t.bigInteger('retires_at').nullable();
      t.bigInteger('removes_at').nullable();
      t.index(['alg', 'state']);
    });
  }
  if (!(await knex.schema.hasTable('cloud_issuer_state'))) {
    await knex.schema.createTable('cloud_issuer_state', (t) => {
      t.string('id', 20).primary();
      t.text('target').notNullable(); // JSON: kind and settings, references only
      t.bigInteger('published_at').nullable();
      t.string('published_hash', 64).nullable();
      t.text('published_kids').nullable(); // JSON array
      t.string('publish_error', 1000).nullable();
      t.bigInteger('checked_at').nullable();
      t.string('check_state', 20).nullable(); // ok | mismatch | error | unpublished
      t.string('check_detail', 1000).nullable();
      t.bigInteger('alerted_at').nullable();
      t.string('updated_by', 26).nullable();
      t.bigInteger('updated_at').notNullable();
    });
  }
  if (!(await knex.schema.hasTable('cloud_credential_state'))) {
    await knex.schema.createTable('cloud_credential_state', (t) => {
      t.string('account_id', 26).primary();
      t.string('kind', 20).notNullable(); // aws-keys | azure-secret | azure-certificate | token | federated
      t.bigInteger('last_used_at').nullable();
      t.string('last_used_purpose', 20).nullable();
      t.bigInteger('rotated_at').nullable();
      t.string('rotation_state', 12).notNullable().defaultTo('idle'); // idle | overlap | failed
      t.text('previous').nullable(); // JSON: the provider's id of the key or secret to delete after the overlap
      t.bigInteger('overlap_until').nullable();
      t.bigInteger('expires_at').nullable();
      t.string('notice_stage', 10).nullable(); // due | expired
      t.bigInteger('notice_for').nullable(); // the expires_at the notice was sent for
      t.string('last_error', 1000).nullable();
      t.bigInteger('updated_at').notNullable();
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('cloud_credential_state');
  await knex.schema.dropTableIfExists('cloud_issuer_state');
  await knex.schema.dropTableIfExists('cloud_issuer_keys');
}
