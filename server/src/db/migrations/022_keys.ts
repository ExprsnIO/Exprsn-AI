import type { Knex } from 'knex';

/*
 * Sprint 20: keys and supply chain.
 * - HTTP Message Signatures (B-1203): an API key may carry an Ed25519 public key; every `/v1` request made with that
 *   key must then be signed with it (RFC 9421). Webhooks may add RFC 9421 signatures next to their own headers.
 * Signer-held and KMS-held keys (B-1201, B-1202) need no schema change: `private_sealed` holds a reference.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('api_keys', (t) => {
    t.string('signature_key', 64).nullable(); // Ed25519 public key, the JWK x value (base64url, 43 characters)
  });
  await knex.schema.alterTable('webhooks', (t) => {
    t.boolean('message_signatures').notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('webhooks', (t) => {
    t.dropColumn('message_signatures');
  });
  await knex.schema.alterTable('api_keys', (t) => {
    t.dropColumn('signature_key');
  });
}
