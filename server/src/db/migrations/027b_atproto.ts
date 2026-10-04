import type { Knex } from 'knex';

/*
 * Sprint 25 (1.4.0), AT-Protocol trust (027b): service DIDs per tenant with a platform fallback (B-1609), their keys
 * held by the signer or OpenBao (B-1608), the signed labeler with its ordered sequence (B-1610), and the registry of
 * trusted external labelers with the labels received from them (B-1611). Long subjects are text; lookups by subject
 * go through a SHA-256 of it, so the indexes stay within MySQL's key length. Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('atproto_identities', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).nullable(); // null: the platform's identity, the fallback for tenants without one
    t.string('method', 10).notNullable(); // web | plc
    t.string('did', 300).notNullable().unique();
    t.string('handle', 253).nullable().unique();
    t.string('host', 260).nullable().unique(); // a tenant's own host (did:web:<host>), lower case, with any port
    t.string('path_key', 63).nullable().unique(); // /atproto/<path_key>/… when the tenant has no host of its own
    t.string('endpoint', 500).notNullable(); // the #atproto_labeler service endpoint
    t.string('plc_prev', 120).nullable(); // CID of the last accepted PLC operation
    t.text('plc_op', 'mediumtext').nullable(); // JSON: that operation, signed
    t.string('state', 20).notNullable().defaultTo('active');
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id']);
  });

  await knex.schema.createTable('atproto_keys', (t) => {
    t.string('id', 26).primary();
    t.string('identity_id', 26).notNullable();
    t.string('tenant_id', 26).nullable();
    t.string('purpose', 20).notNullable(); // label | rotation
    t.string('curve', 20).notNullable(); // secp256k1 | p256
    t.string('custody', 20).notNullable(); // signer | openbao
    t.string('key_name', 200).notNullable();
    t.text('key_wrapped').nullable(); // the signer's wrapped blob (opaque here); null in transit
    t.string('multikey', 100).notNullable(); // z… (did:key without the prefix)
    t.string('state', 20).notNullable(); // active | retired
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('retired_at').nullable();
    t.index(['identity_id', 'purpose', 'state']);
  });

  await knex.schema.createTable('atproto_labels', (t) => {
    t.string('id', 26).primary();
    t.string('identity_id', 26).notNullable();
    t.string('tenant_id', 26).nullable(); // the tenant whose verdict it is
    t.bigInteger('seq').notNullable();
    t.string('src', 300).notNullable();
    t.text('uri').notNullable();
    t.string('uri_hash', 64).notNullable();
    t.string('cid', 120).nullable();
    t.string('val', 128).notNullable();
    t.boolean('neg').notNullable().defaultTo(false);
    t.string('cts', 40).notNullable();
    t.string('exp', 40).nullable();
    t.string('sig', 120).notNullable(); // base64 of the 64-byte signature
    t.string('key_id', 26).notNullable(); // the atproto_keys row that signed it
    t.string('flag_id', 26).nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.unique(['identity_id', 'seq']);
    t.index(['identity_id', 'uri_hash']);
    t.index(['flag_id']);
  });

  await knex.schema.createTable('atproto_labelers', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('did', 300).notNullable();
    t.string('name', 100).notNullable();
    t.string('endpoint', 500).nullable();
    t.string('multikey', 100).nullable();
    t.string('workspace_id', 26).nullable(); // where its flags go; null for the tenant queue
    t.text('vals').notNullable(); // JSON: the label values that become flags
    t.string('state', 20).notNullable(); // active | paused
    t.bigInteger('cursor').nullable();
    t.bigInteger('last_pull_at').nullable();
    t.string('last_error', 500).nullable();
    t.integer('received').notNullable().defaultTo(0);
    t.integer('rejected').notNullable().defaultTo(0);
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'did']);
  });

  await knex.schema.createTable('atproto_inbound_labels', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('labeler_id', 26).notNullable();
    t.bigInteger('seq').nullable(); // the labeler's event sequence it arrived in
    t.text('uri').notNullable();
    t.string('uri_hash', 64).notNullable();
    t.string('cid', 120).nullable();
    t.string('val', 128).notNullable();
    t.boolean('neg').notNullable().defaultTo(false);
    t.string('cts', 40).notNullable();
    t.string('exp', 40).nullable();
    t.string('dedupe', 64).notNullable(); // sha256 of uri, val, neg and cts
    t.string('flag_id', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.unique(['labeler_id', 'dedupe']);
    t.index(['tenant_id', 'labeler_id', 'created_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const t of ['atproto_inbound_labels', 'atproto_labelers', 'atproto_labels', 'atproto_keys', 'atproto_identities']) await knex.schema.dropTableIfExists(t);
}
