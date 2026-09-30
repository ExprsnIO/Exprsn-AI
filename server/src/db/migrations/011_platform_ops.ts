import type { Knex } from 'knex';

/*
 * Sprint 9: platform operations. Signed import bundles and the offline keys that sign them, internal mirrors,
 * ACME certificates (the account and pending http-01 challenges too), database backups and restore drills, and a
 * small key-value table for platform alerts. Platform rows are not tenant data: they have no tenant_id and are
 * managed by system admins only (`platform:manage`).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('platform_signer_keys', (t) => {
    t.string('id', 26).primary();
    t.string('name', 100).notNullable();
    t.string('algorithm', 30).notNullable(); // ed25519 | ecdsa-p256-sha256
    t.string('fingerprint', 64).notNullable().unique(); // sha256 of the SPKI DER, hex
    t.text('public_key_pem').notNullable();
    t.string('state', 20).notNullable(); // active | revoked
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.string('revoked_by', 26).nullable();
    t.bigInteger('revoked_at').nullable();
    t.string('revoke_reason', 500).nullable();
  });

  await knex.schema.createTable('platform_bundles', (t) => {
    t.string('id', 26).primary();
    t.string('name', 100).notNullable().unique(); // the bundle id people use, e.g. 2026-38-weekly
    t.string('state', 30).notNullable(); // awaiting transfer | verifying | ready to promote | promoting | in production | rejected
    t.boolean('expedited').notNullable().defaultTo(false);
    t.string('ticket', 100).nullable();
    t.string('transfer', 30).notNullable(); // diode | removable media | upload
    t.string('contents', 500).nullable();
    t.bigInteger('size').nullable();
    t.string('digest', 71).nullable(); // sha256:<hex> of the whole transfer
    t.string('blob_key', 512).nullable();
    t.string('manifest_id', 100).nullable();
    t.string('signer_fingerprint', 64).nullable();
    t.string('signer_key_id', 26).nullable();
    t.text('steps').notNullable(); // JSON: seven { state, detail, at }
    t.text('report', 'mediumtext').nullable(); // JSON: files by mirror, SBOM summary, findings, licences
    t.string('error', 1000).nullable();
    t.string('job_id', 26).nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('received_at').nullable();
    t.bigInteger('verified_at').nullable();
    t.string('promoted_by', 26).nullable();
    t.bigInteger('promoted_at').nullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['state']);
  });

  await knex.schema.createTable('platform_mirrors', (t) => {
    t.string('id', 26).primary();
    t.string('name', 100).notNullable().unique();
    t.string('kind', 20).notNullable(); // images | npm | pypi | trivy | models | apt | tofu
    t.string('store', 100).notNullable(); // Harbor, Verdaccio, devpi…
    t.string('url', 500).notNullable();
    t.string('consumer', 200).nullable();
    t.integer('max_age_days').nullable(); // null: content-addressed, never stale
    t.string('last_bundle', 100).nullable();
    t.bigInteger('last_promoted_at').nullable();
    t.bigInteger('last_check_at').nullable();
    t.boolean('last_check_ok').nullable();
    t.string('last_check_detail', 500).nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
  });

  await knex.schema.createTable('platform_certificates', (t) => {
    t.string('id', 26).primary();
    t.string('name', 253).notNullable();
    t.text('domains').notNullable(); // JSON array
    t.string('issued_to', 200).nullable();
    t.string('use', 20).notNullable(); // TLS | mTLS | LDAPS | CA | other
    t.string('method', 20).notNullable(); // acme | tracked
    t.string('state', 20).notNullable(); // pending | issuing | valid | failed | revoked
    t.boolean('auto_renew').notNullable().defaultTo(true);
    t.string('issuer', 500).nullable();
    t.string('serial', 100).nullable();
    t.string('fingerprint', 100).nullable();
    t.bigInteger('not_before').nullable();
    t.bigInteger('not_after').nullable();
    t.text('chain_pem', 'mediumtext').nullable();
    t.text('key_sealed').nullable(); // sealed with the platform data key, row id as associated data
    t.string('order_url', 500).nullable();
    t.string('error', 1000).nullable();
    t.string('job_id', 26).nullable();
    t.bigInteger('notified_at').nullable();
    t.bigInteger('renewed_at').nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
  });

  await knex.schema.createTable('platform_acme_accounts', (t) => {
    t.string('directory_url', 500).primary();
    t.string('kid', 500).notNullable();
    t.text('key_sealed').notNullable();
    t.string('contact', 200).nullable();
    t.bigInteger('created_at').notNullable();
  });

  await knex.schema.createTable('platform_acme_challenges', (t) => {
    t.string('token', 200).primary();
    t.string('key_authorization', 400).notNullable();
    t.bigInteger('expires_at').notNullable();
  });

  await knex.schema.createTable('platform_backups', (t) => {
    t.string('id', 26).primary();
    t.string('state', 20).notNullable(); // running | succeeded | failed
    t.string('kind', 20).notNullable(); // manual | scheduled | cli
    t.string('db_client', 10).notNullable();
    t.integer('tables').nullable();
    t.bigInteger('rows').nullable();
    t.bigInteger('bytes').nullable();
    t.string('manifest_hash', 64).nullable();
    t.string('signature', 200).nullable();
    t.string('blob_key', 512).nullable();
    t.string('manifest_key', 512).nullable();
    t.string('error', 1000).nullable();
    t.string('job_id', 26).nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('finished_at').nullable();
    t.index(['state', 'created_at']);
  });

  await knex.schema.createTable('platform_drills', (t) => {
    t.string('id', 26).primary();
    t.string('backup_id', 26).notNullable();
    t.string('state', 20).notNullable(); // running | passed | failed
    t.text('steps').notNullable(); // JSON: { title, state, ms, detail }
    t.bigInteger('rpo_ms').nullable();
    t.bigInteger('rto_ms').nullable();
    t.bigInteger('rpo_target_ms').notNullable();
    t.bigInteger('rto_target_ms').notNullable();
    t.boolean('within_target').nullable();
    t.text('detail', 'mediumtext').nullable(); // JSON: counts, chains, skipped tables
    t.string('error', 1000).nullable();
    t.string('job_id', 26).nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('finished_at').nullable();
    t.index(['created_at']);
  });

  await knex.schema.createTable('platform_state', (t) => {
    t.string('key', 100).primary();
    t.text('value').notNullable(); // JSON
    t.bigInteger('updated_at').notNullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const table of ['platform_state', 'platform_drills', 'platform_backups', 'platform_acme_challenges', 'platform_acme_accounts', 'platform_certificates', 'platform_mirrors', 'platform_bundles', 'platform_signer_keys']) {
    await knex.schema.dropTableIfExists(table);
  }
}
