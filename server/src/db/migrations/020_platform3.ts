import type { Knex } from 'knex';

/*
 * Sprint 18: platform hardening. Certificate push hooks (B-904), sealed training data and artefacts with worker
 * grants (B-905), member moves in zone proposals (B-908), and push targets for promoted bundles (B-909).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('platform_cert_hooks', (t) => {
    t.string('id', 26).primary();
    t.string('certificate_id', 26).notNullable().references('id').inTable('platform_certificates').onDelete('CASCADE');
    t.string('kind', 20).notNullable(); // command | webhook
    t.string('command', 100).nullable(); // a name from ACME_RELOAD_COMMANDS
    t.string('url', 500).nullable();
    t.text('secret_sealed').nullable(); // webhook signing secret, sealed with the platform data key
    t.string('last_state', 20).nullable(); // ok | failed
    t.string('last_detail', 500).nullable();
    t.bigInteger('last_at').nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.index(['certificate_id']);
  });

  await knex.schema.createTable('training_worker_grants', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('job_id', 26).notNullable();
    t.string('kind', 20).notNullable(); // key | artifacts
    t.string('token_hash', 64).notNullable();
    t.text('key_sealed').nullable(); // the run's data key, sealed with the tenant key (key grants)
    t.bigInteger('used_at').nullable();
    t.bigInteger('expires_at').notNullable();
    t.bigInteger('created_at').notNullable();
    t.index(['job_id']);
  });

  await knex.schema.createTable('training_artifacts', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('job_id', 26).notNullable();
    t.string('name', 200).notNullable();
    t.string('kind', 20).notNullable(); // checkpoint | gguf | other
    t.string('blob_key', 512).notNullable();
    t.text('key_sealed').notNullable(); // the artefact's AES-256-GCM key, sealed with the tenant key
    t.string('iv', 40).notNullable();
    t.string('tag', 40).notNullable();
    t.string('sha256', 64).notNullable();
    t.bigInteger('bytes').notNullable();
    t.bigInteger('created_at').notNullable();
    t.unique(['job_id', 'name']);
  });

  await knex.schema.alterTable('zone_versions', (t) => {
    t.text('move_members').nullable(); // JSON [{ kind: connection | mcp, id, name }]
  });

  await knex.schema.createTable('platform_push_targets', (t) => {
    t.string('id', 26).primary();
    t.string('mirror_id', 26).notNullable().unique().references('id').inTable('platform_mirrors').onDelete('CASCADE');
    t.string('kind', 20).notNullable(); // oci | npm | pypi
    t.string('url', 500).notNullable();
    t.string('repository', 200).nullable(); // Harbor project, devpi index (user/index)
    t.string('username', 200).nullable();
    t.text('secret_sealed').nullable();
    t.string('state', 20).notNullable(); // active | disabled
    t.bigInteger('last_push_at').nullable();
    t.boolean('last_push_ok').nullable();
    t.string('last_detail', 500).nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
  });

  await knex.schema.createTable('platform_pushes', (t) => {
    t.string('id', 26).primary();
    t.string('bundle_id', 26).notNullable();
    t.string('target_id', 26).notNullable();
    t.string('path', 500).notNullable();
    t.string('sha256', 64).notNullable();
    t.string('artefact', 300).nullable(); // name@version or repository:tag
    t.string('state', 20).notNullable(); // pushed | exists | failed
    t.string('detail', 500).nullable();
    t.bigInteger('at').notNullable();
    t.index(['bundle_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('platform_pushes');
  await knex.schema.dropTableIfExists('platform_push_targets');
  await knex.schema.alterTable('zone_versions', (t) => {
    t.dropColumn('move_members');
  });
  await knex.schema.dropTableIfExists('training_artifacts');
  await knex.schema.dropTableIfExists('training_worker_grants');
  await knex.schema.dropTableIfExists('platform_cert_hooks');
}
