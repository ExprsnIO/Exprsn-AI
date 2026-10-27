import type { Knex } from 'knex';

/*
 * Sprint 31 (1.5.0), the AT-Protocol personal data server (033_pds): B-2901 to B-2906 and B-3004. Expand only.
 *
 * - `pds_tenants`: hosting is opt-in per tenant and switched on by a platform admin (the owner decision of
 *   2026-10-05). Handles live under `handle_domain` (`<tenant>.<pds domain>`, fixed when hosting is enabled), and the
 *   tenant may lower the blob limits and require invite codes even when its sign-up policy is open.
 * - `pds_accounts`: one AT-Protocol account per Exprsn-AI user. The repo signing key (`#atproto`) and, for a did:plc
 *   the PDS controls, the rotation key are held by the signer or OpenBao transit: the row keeps the key name, the
 *   signer's wrapped blob (which this process cannot open) and the public multikey, never a private key. `commit_cid`,
 *   `rev` and `data_cid` are the repo head; a write compares and swaps `rev`.
 * - `pds_records`: the records in each repo (`path_hash` is SHA-256 of `<collection>/<rkey>`, `height` its MST layer).
 * - `pds_blocks`: the repo's blocks (records, MST nodes, the head commit) by CID, as base64 of the DAG-CBOR.
 * - `pds_blobs` and `pds_blob_refs`: blobs through the attachment quarantine and ClamAV (sealed at rest like files),
 *   and which records use them.
 * - `pds_app_passwords`, `pds_sessions`, `pds_tokens`: app passwords (an HMAC of the secret), refresh-token sessions
 *   (by `jti`), and single-use tokens for PLC operations.
 * - `pds_invites` and `pds_invite_uses`: invite codes (an HMAC of the code) under the tenant's sign-up policy (B-1801).
 * - `pds_events` and `pds_counters`: the sequencer. `seq` comes from the `seq` counter row, taken inside the commit's
 *   transaction, so events become visible in seq order; `body` is the event's DAG-CBOR (base64).
 * - `pds_crawls`: when each configured relay was last asked to crawl.
 * - `pds_feed_records`: `app.bsky.feed.generator` records published for the tenant (B-3004), to a hosted repo or an
 *   external account.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('pds_tenants', (t) => {
    t.string('tenant_id', 26).primary();
    t.boolean('enabled').notNullable().defaultTo(false);
    t.string('zone', 64).notNullable();
    t.string('handle_domain', 253).notNullable().unique('pds_tenants_domain_uq');
    t.boolean('invite_required').notNullable().defaultTo(false);
    t.bigInteger('blob_max_bytes').nullable(); // null: the platform's PDS_BLOB_MAX_BYTES
    t.text('blob_types').nullable(); // JSON: accepted MIME types (type/* allowed); null: the platform's list
    t.string('enabled_by', 26).nullable();
    t.bigInteger('enabled_at').nullable();
    t.bigInteger('disabled_at').nullable();
    t.string('updated_by', 26).nullable();
    t.bigInteger('updated_at').notNullable();
  });

  await knex.schema.createTable('pds_accounts', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('user_id', 26).notNullable().unique('pds_accounts_user_uq');
    t.string('did', 255).notNullable().unique('pds_accounts_did_uq');
    t.string('handle', 253).notNullable().unique('pds_accounts_handle_uq');
    t.string('state', 20).notNullable(); // active | deactivated | takendown
    t.string('state_reason', 500).nullable();
    t.string('takedown_ref', 64).nullable(); // the moderation action (B-1903) behind a takedown
    t.boolean('migrating').notNullable().defaultTo(false); // created by a migration in, until activated
    t.string('did_method', 10).notNullable(); // plc | web
    t.string('key_curve', 20).notNullable();
    t.string('key_custody', 20).notNullable(); // signer | openbao
    t.string('key_name', 200).notNullable();
    t.text('key_wrapped').nullable();
    t.string('key_multikey', 100).notNullable();
    t.string('rot_curve', 20).nullable();
    t.string('rot_custody', 20).nullable();
    t.string('rot_key_name', 200).nullable();
    t.text('rot_key_wrapped').nullable();
    t.string('rot_multikey', 100).nullable();
    t.text('plc_op', 'mediumtext').nullable(); // JSON: the last PLC operation accepted for this DID
    t.string('plc_prev', 100).nullable(); // its CID
    t.string('commit_cid', 100).nullable();
    t.string('rev', 13).nullable();
    t.string('data_cid', 100).nullable();
    t.string('email', 320).nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.bigInteger('deactivated_at').nullable();
    t.bigInteger('takendown_at').nullable();
    t.index(['tenant_id', 'state'], 'pds_accounts_tenant_idx');
  });

  await knex.schema.createTable('pds_records', (t) => {
    t.string('account_id', 26).notNullable();
    t.string('path_hash', 64).notNullable();
    t.string('coll_hash', 64).notNullable();
    t.string('collection', 320).notNullable();
    t.string('rkey', 512).notNullable();
    t.string('cid', 100).notNullable();
    t.integer('height').notNullable();
    t.string('rev', 13).notNullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.primary(['account_id', 'path_hash'], 'pds_records_pk');
    t.index(['account_id', 'coll_hash', 'rkey'], 'pds_records_coll_idx');
    t.index(['account_id', 'cid'], 'pds_records_cid_idx');
  });

  await knex.schema.createTable('pds_blocks', (t) => {
    t.string('account_id', 26).notNullable();
    t.string('cid', 100).notNullable();
    t.string('kind', 10).notNullable(); // commit | mst | record
    t.integer('size').notNullable();
    t.text('data', 'mediumtext').notNullable(); // base64 of the block
    t.string('rev', 13).notNullable();
    t.primary(['account_id', 'cid'], 'pds_blocks_pk');
  });

  await knex.schema.createTable('pds_blobs', (t) => {
    t.string('id', 26).primary();
    t.string('account_id', 26).notNullable();
    t.string('tenant_id', 26).notNullable();
    t.string('cid', 100).notNullable();
    t.string('mime', 255).notNullable();
    t.bigInteger('size').notNullable();
    t.string('state', 20).notNullable(); // quarantined | scanning | ready | rejected
    t.string('reason', 500).nullable();
    t.string('blob_key', 300).nullable();
    t.text('sealed_key').nullable();
    t.boolean('taken_down').notNullable().defaultTo(false);
    t.bigInteger('created_at').notNullable();
    t.bigInteger('scanned_at').nullable();
    t.unique(['account_id', 'cid'], 'pds_blobs_account_cid_uq');
    t.index(['state', 'created_at'], 'pds_blobs_state_idx');
  });

  await knex.schema.createTable('pds_blob_refs', (t) => {
    t.string('account_id', 26).notNullable();
    t.string('cid', 100).notNullable();
    t.string('path_hash', 64).notNullable();
    t.string('rev', 13).notNullable(); // the commit that made the reference (listBlobs since)
    t.primary(['account_id', 'cid', 'path_hash'], 'pds_blob_refs_pk');
    t.index(['account_id', 'path_hash'], 'pds_blob_refs_path_idx');
  });

  await knex.schema.createTable('pds_app_passwords', (t) => {
    t.string('id', 26).primary();
    t.string('account_id', 26).notNullable();
    t.string('tenant_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('name', 100).notNullable();
    t.string('secret_hash', 64).notNullable().unique('pds_app_passwords_hash_uq');
    t.boolean('privileged').notNullable().defaultTo(false);
    t.bigInteger('created_at').notNullable();
    t.bigInteger('last_used_at').nullable();
    t.bigInteger('revoked_at').nullable();
    t.index(['account_id'], 'pds_app_passwords_account_idx');
  });

  await knex.schema.createTable('pds_sessions', (t) => {
    t.string('id', 64).primary(); // the refresh token's jti
    t.string('account_id', 26).notNullable();
    t.string('app_password_id', 26).nullable();
    t.string('scope', 40).notNullable(); // the access scope the session grants
    t.bigInteger('created_at').notNullable();
    t.bigInteger('expires_at').notNullable();
    t.bigInteger('used_at').nullable(); // a refresh token is spent once
    t.bigInteger('revoked_at').nullable();
    t.string('ip', 64).nullable();
    t.index(['account_id'], 'pds_sessions_account_idx');
  });

  await knex.schema.createTable('pds_tokens', (t) => {
    t.string('id', 26).primary();
    t.string('account_id', 26).notNullable();
    t.string('purpose', 20).notNullable(); // plc
    t.string('token_hash', 64).notNullable().unique('pds_tokens_hash_uq');
    t.bigInteger('created_at').notNullable();
    t.bigInteger('expires_at').notNullable();
    t.bigInteger('used_at').nullable();
  });

  await knex.schema.createTable('pds_invites', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('code_hash', 64).notNullable().unique('pds_invites_hash_uq');
    t.string('hint', 12).notNullable(); // the code's last characters, to tell codes apart in a list
    t.integer('uses_max').notNullable();
    t.integer('uses').notNullable().defaultTo(0);
    t.string('note', 200).nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('expires_at').nullable();
    t.bigInteger('disabled_at').nullable();
    t.index(['tenant_id'], 'pds_invites_tenant_idx');
  });

  await knex.schema.createTable('pds_invite_uses', (t) => {
    t.string('invite_id', 26).notNullable();
    t.string('account_id', 26).notNullable();
    t.bigInteger('used_at').notNullable();
    t.primary(['invite_id', 'account_id'], 'pds_invite_uses_pk');
  });

  await knex.schema.createTable('pds_counters', (t) => {
    t.string('name', 40).primary();
    t.bigInteger('value').notNullable();
  });
  await knex('pds_counters').insert({ name: 'seq', value: 0 });

  await knex.schema.createTable('pds_events', (t) => {
    t.bigInteger('seq').primary();
    t.string('did', 255).notNullable();
    t.string('type', 20).notNullable(); // commit | sync | identity | account
    t.text('body', 'mediumtext').notNullable(); // base64 of the event's DAG-CBOR, without seq and time
    t.string('time', 30).notNullable(); // ISO 8601, when it was sequenced
    t.bigInteger('created_at').notNullable();
    t.index(['created_at'], 'pds_events_created_idx');
  });

  await knex.schema.createTable('pds_crawls', (t) => {
    t.string('relay_hash', 64).primary();
    t.string('relay', 500).notNullable();
    t.bigInteger('last_at').nullable();
    t.integer('last_status').nullable();
    t.string('last_error', 500).nullable();
  });

  await knex.schema.createTable('pds_feed_records', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('target', 10).notNullable(); // hosted | external
    t.string('account_id', 26).nullable();
    t.string('repo', 255).notNullable(); // the DID whose repo holds the record
    t.string('rkey', 512).notNullable();
    t.string('uri', 1000).notNullable();
    t.string('cid', 100).notNullable();
    t.string('service_did', 255).notNullable();
    t.string('display_name', 64).notNullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id'], 'pds_feed_records_tenant_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const table of ['pds_feed_records', 'pds_crawls', 'pds_events', 'pds_counters', 'pds_invite_uses', 'pds_invites', 'pds_tokens', 'pds_sessions', 'pds_app_passwords', 'pds_blob_refs', 'pds_blobs', 'pds_blocks', 'pds_records', 'pds_accounts', 'pds_tenants']) {
    await knex.schema.dropTableIfExists(table);
  }
}
