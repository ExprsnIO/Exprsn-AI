import type { Knex } from 'knex';

/*
 * 1.7.0, Sprint 43 (B-113): `did:exprsn`.
 *
 * - `atproto_exprsn_dids`: a user's own self-certifying DID, minted on first use. The key is held by the signer or
 *   OpenBao transit; `key_ref` is the reference to it (atproto/keys.ts), never the key. One per user.
 *
 * Expand only. A build from before this migration ignores the table; did:exprsn DIDs need no table to resolve.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('atproto_exprsn_dids'))) {
    await knex.schema.createTable('atproto_exprsn_dids', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('user_id', 26).notNullable();
      t.string('did', 120).notNullable().unique('atproto_exprsn_dids_did_uq');
      t.string('multikey', 100).notNullable();
      t.string('curve', 20).notNullable();
      t.text('key_ref').notNullable();
      t.bigInteger('created_at').notNullable();
      t.unique(['tenant_id', 'user_id'], { indexName: 'atproto_exprsn_dids_user_uq' });
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('atproto_exprsn_dids');
}
