import type { Knex } from 'knex';

/*
 * Sprint 26d (1.4.0), the file store (028d): B-2401 to B-2405.
 *
 * - `file_folders`: a workspace's folder tree (`parent_id` null at the root). Trash is a mark (`trashed_at`), with
 *   `trashed_with` the id of the folder or file the user put in the trash, so restoring it restores what went with it.
 * - `files`: one row per file; its content is in `file_versions`. `current_version` is the newest version that passed
 *   quarantine; `state` is pending until one has, rejected when the first one failed.
 * - `file_versions`: every upload and every restore is a version that goes through the quarantine scan. Content is in
 *   the blob store, encrypted in segments with a random key per version; that key is sealed with the tenant key
 *   (`sealed_key`). `workspace_id` is copied from the file so storage use sums without a join.
 * - `file_previews`: an image or PDF preview per version, sealed like the original.
 * - `file_tags`: lower-case tags for search.
 * - `file_shares`: read-only shares with a user, a directory group, a workspace, or a link (token stored as an HMAC);
 *   links may expire and have a use limit (`max_uses`, `uses`).
 * - `file_quotas`: storage limits in bytes for the tenant (`workspace_id` null) and per workspace.
 * Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('file_folders', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).notNullable();
    t.string('parent_id', 26).nullable();
    t.string('name', 255).notNullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.bigInteger('trashed_at').nullable();
    t.string('trashed_by', 26).nullable();
    t.string('trashed_with', 26).nullable();
    t.bigInteger('purge_after').nullable();
    t.index(['tenant_id', 'workspace_id', 'parent_id']);
    t.index(['tenant_id', 'trashed_with']);
  });

  await knex.schema.createTable('files', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).notNullable();
    t.string('folder_id', 26).nullable();
    t.string('owner_id', 26).notNullable();
    t.string('name', 255).notNullable();
    t.string('name_lower', 255).notNullable();
    t.string('label', 20).notNullable();
    t.string('state', 20).notNullable(); // pending | ready | rejected
    t.integer('current_version').nullable();
    t.bigInteger('size').notNullable().defaultTo(0);
    t.string('type', 120).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.bigInteger('trashed_at').nullable();
    t.string('trashed_by', 26).nullable();
    t.string('trashed_with', 26).nullable();
    t.bigInteger('purge_after').nullable();
    t.index(['tenant_id', 'workspace_id', 'folder_id']);
    t.index(['tenant_id', 'name_lower']);
    t.index(['tenant_id', 'trashed_with']);
    t.index(['purge_after']);
  });

  await knex.schema.createTable('file_versions', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).notNullable();
    t.string('file_id', 26).notNullable().references('id').inTable('files').onDelete('CASCADE');
    t.integer('number').notNullable();
    t.string('state', 20).notNullable(); // quarantined | scanning | ready | rejected
    t.bigInteger('size').notNullable();
    t.string('sha256', 64).notNullable();
    t.string('type', 120).nullable();
    t.string('declared_type', 120).nullable();
    t.string('label', 20).notNullable();
    t.string('reason', 500).nullable();
    t.text('findings').nullable(); // JSON: scanner and detection counts, never matches
    t.string('blob_key', 512).nullable();
    t.text('sealed_key').nullable(); // the version's content key and nonce prefix, sealed with the tenant key
    t.integer('restored_from').nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('scanned_at').nullable();
    t.unique(['file_id', 'number']);
    t.index(['tenant_id', 'workspace_id', 'state']);
  });

  await knex.schema.createTable('file_previews', (t) => {
    t.string('version_id', 26).primary().references('id').inTable('file_versions').onDelete('CASCADE');
    t.string('tenant_id', 26).notNullable();
    t.string('file_id', 26).notNullable();
    t.string('state', 20).notNullable(); // queued | ready | failed | unavailable
    t.string('type', 60).nullable();
    t.bigInteger('size').nullable();
    t.string('blob_key', 512).nullable();
    t.text('sealed_key').nullable();
    t.string('error', 500).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['file_id']);
  });

  await knex.schema.createTable('file_tags', (t) => {
    t.string('file_id', 26).notNullable().references('id').inTable('files').onDelete('CASCADE');
    t.string('tenant_id', 26).notNullable();
    t.string('tag', 40).notNullable();
    t.primary(['file_id', 'tag']);
    t.index(['tenant_id', 'tag']);
  });

  await knex.schema.createTable('file_shares', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('file_id', 26).notNullable().references('id').inTable('files').onDelete('CASCADE');
    t.string('kind', 20).notNullable(); // user | group | workspace | link
    t.string('user_id', 26).nullable();
    t.string('group_name', 200).nullable();
    t.string('workspace_id', 26).nullable();
    t.string('token_hash', 64).nullable().unique();
    t.boolean('anonymous').notNullable().defaultTo(false);
    t.bigInteger('expires_at').nullable();
    t.integer('max_uses').nullable();
    t.integer('uses').notNullable().defaultTo(0);
    t.string('created_by', 26).notNullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('revoked_at').nullable();
    t.string('revoked_by', 26).nullable();
    t.bigInteger('last_used_at').nullable();
    t.index(['tenant_id', 'file_id']);
    t.index(['tenant_id', 'kind', 'user_id']);
  });

  await knex.schema.createTable('file_quotas', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).nullable();
    t.bigInteger('max_bytes').nullable();
    t.string('updated_by', 26).nullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id', 'workspace_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const t of ['file_quotas', 'file_shares', 'file_tags', 'file_previews', 'file_versions', 'files', 'file_folders']) await knex.schema.dropTableIfExists(t);
}
