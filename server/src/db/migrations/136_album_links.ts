import type { Knex } from 'knex';

/*
 * 1.9.0, Sprint 53 (B-178): album share links and upload links (`files/album-links.ts`).
 *
 * - `album_share_links`: a link to an album for people without an account. `token_hash` is the HMAC of the token
 *   (shown once) under the `link` key; `mode` is `view` or `download`; `password_hash` an argon2id hash or null;
 *   `expires_at` always set; `views` and `downloads` count uses; revoked, never deleted.
 * - `album_upload_links`: a link that lets people without an account add photos and videos to an album: where they
 *   land (`workspace_id`, `folder_id`), its expiry, `max_files` and `max_bytes` (per file), `files_received` (taken
 *   atomically as each upload starts); revoked, never deleted. The files are owned by `created_by`.
 * - `album_pending_uploads`: each upload through a link: the file it made, its name and size, the uploader's name as
 *   given (sealed under the tenant key, associated data `album-upload:<id>`), `state` `scanning`, `added` or
 *   `rejected` with the scanner's reason. No address is kept here (the audit entry has what file links keep).
 *
 * Expand only: three new tables. A build from before this migration ignores them; this build reports album links as
 * not available while they are missing.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('album_share_links'))) {
    await knex.schema.createTable('album_share_links', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('album_id', 26).notNullable();
      t.string('token_hash', 128).notNullable().unique();
      t.string('mode', 16).notNullable();
      t.string('password_hash', 255).nullable();
      t.bigInteger('expires_at').notNullable();
      t.integer('views').notNullable().defaultTo(0);
      t.integer('downloads').notNullable().defaultTo(0);
      t.bigInteger('last_used_at').nullable();
      t.string('created_by', 26).notNullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('revoked_at').nullable();
      t.string('revoked_by', 26).nullable();
      t.index(['tenant_id', 'album_id']);
    });
  }
  if (!(await knex.schema.hasTable('album_upload_links'))) {
    await knex.schema.createTable('album_upload_links', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('album_id', 26).notNullable();
      t.string('token_hash', 128).notNullable().unique();
      t.string('workspace_id', 26).notNullable();
      t.string('folder_id', 26).nullable();
      t.bigInteger('expires_at').notNullable();
      t.integer('max_files').notNullable();
      t.bigInteger('max_bytes').notNullable();
      t.integer('files_received').notNullable().defaultTo(0);
      t.string('created_by', 26).notNullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('revoked_at').nullable();
      t.string('revoked_by', 26).nullable();
      t.index(['tenant_id', 'album_id']);
    });
  }
  if (!(await knex.schema.hasTable('album_pending_uploads'))) {
    await knex.schema.createTable('album_pending_uploads', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('album_id', 26).notNullable();
      t.string('link_id', 26).notNullable();
      t.string('file_id', 26).notNullable();
      t.string('name', 255).notNullable();
      t.bigInteger('size').notNullable().defaultTo(0);
      t.text('uploader_name').notNullable();
      t.string('state', 16).notNullable();
      t.string('reason', 500).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('settled_at').nullable();
      t.index(['tenant_id', 'album_id']);
      t.index(['tenant_id', 'file_id']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('album_pending_uploads');
  await knex.schema.dropTableIfExists('album_upload_links');
  await knex.schema.dropTableIfExists('album_share_links');
}
