import type { Knex } from 'knex';

/*
 * 1.6.0, Sprint 39a.
 *
 * B-7901 content credentials: a generated PNG carries a C2PA manifest store (`caBX` chunk) signed by the tenant's
 * content-credentials certificate, which the tenant CA issues on first use and keeps in `pki_content_signers` (the
 * key in custody, the certificate also listed in `pki_certificates` so it can be revoked from the Certificates
 * screen). `image_jobs.c2pa` holds the summary the Images screen shows (the manifest label, the signer's fingerprint,
 * or why the image was not signed).
 *
 * B-8001 versioned artifacts: the code, documents and HTML an answer produces are `chat_artifacts` of a
 * conversation, one per name (a file name from the fence, or the language and position), with a
 * `chat_artifact_versions` row per turn that changed it, sealed with the tenant key. An artifact's versions stay
 * readable in order; a share reader sees the versions whose message is on the shared path.
 *
 * Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('image_jobs', (t) => {
    t.text('c2pa').nullable();
  });

  await knex.schema.createTable('pki_content_signers', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('issuer_id', 26).notNullable();
    t.string('certificate_id', 26).notNullable();
    t.string('custody', 16).notNullable(); // signer | openbao
    t.string('key_name', 200).notNullable();
    t.text('key_wrapped').nullable();
    t.string('key_type', 16).notNullable();
    t.text('public_key_pem').notNullable();
    t.text('certificate_pem').notNullable();
    t.string('fingerprint', 64).notNullable();
    t.bigInteger('not_after').notNullable();
    t.string('state', 16).notNullable(); // active | retired
    t.bigInteger('created_at').notNullable();
    t.index(['tenant_id', 'state']);
  });

  await knex.schema.createTable('chat_artifacts', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('conversation_id', 26).notNullable();
    t.string('key', 200).notNullable(); // the file name from the fence, or <language>-<n>
    t.string('kind', 16).notNullable(); // code | document | html
    t.string('language', 40).nullable();
    t.string('title', 200).notNullable();
    t.string('label', 16).notNullable();
    t.integer('versions').notNullable().defaultTo(0);
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['conversation_id', 'key']);
    t.index(['tenant_id', 'conversation_id']);
  });

  await knex.schema.createTable('chat_artifact_versions', (t) => {
    t.string('id', 26).primary();
    t.string('artifact_id', 26).notNullable();
    t.string('tenant_id', 26).notNullable();
    t.string('conversation_id', 26).notNullable();
    t.string('message_id', 26).notNullable();
    t.integer('version').notNullable();
    t.text('content', 'mediumtext').notNullable(); // sealed
    t.string('sha256', 64).notNullable();
    t.integer('bytes').notNullable();
    t.bigInteger('created_at').notNullable();
    t.unique(['artifact_id', 'version']);
    t.index(['conversation_id', 'message_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('chat_artifact_versions');
  await knex.schema.dropTableIfExists('chat_artifacts');
  await knex.schema.dropTableIfExists('pki_content_signers');
  await knex.schema.alterTable('image_jobs', (t) => {
    t.dropColumn('c2pa');
  });
}
