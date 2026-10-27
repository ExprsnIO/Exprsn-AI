import type { Knex } from 'knex';

/*
 * 1.9.0, Sprint 53 (B-177): albums on Files (`files/albums.ts`).
 *
 * - `albums`: an ordered set of files with a title, a description and a cover. `kind` is `personal`, `group` or
 *   `workspace`; `workspace_id` is always set (the workspace of a workspace album, the group's workspace for a group
 *   album, the owner's chosen workspace for a personal one: where upload-link uploads land). `label` is the floor the
 *   owner chose for the title and description; `effective_label` the high-water mark of that floor and the items'
 *   labels, kept by the service. `notified_at`: the newest item contributors were told about (B-179, batched).
 *   `deleted_at` marks an album deleted (its files stay).
 * - `album_items`: one file in one album at a `position` (ascending), who added it and when. A file is in an album
 *   once.
 * - `album_contributors`: a person's role in an album: `viewer`, `contributor` or `editor` (the owner has no row).
 *
 * Expand only: three new tables. A build from before this migration ignores them; this build reports albums as not
 * available while they are missing.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('albums'))) {
    await knex.schema.createTable('albums', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('kind', 16).notNullable();
      t.string('owner_id', 26).notNullable();
      t.string('workspace_id', 26).notNullable();
      t.string('group_id', 26).nullable();
      t.string('title', 200).notNullable();
      t.text('description').nullable();
      t.string('label', 16).notNullable();
      t.string('effective_label', 16).notNullable();
      t.string('cover_file_id', 26).nullable();
      t.integer('item_count').notNullable().defaultTo(0);
      t.bigInteger('notified_at').nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.bigInteger('deleted_at').nullable();
      t.index(['tenant_id', 'workspace_id']);
      t.index(['tenant_id', 'group_id']);
      t.index(['tenant_id', 'owner_id']);
    });
  }
  if (!(await knex.schema.hasTable('album_items'))) {
    await knex.schema.createTable('album_items', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('album_id', 26).notNullable();
      t.string('file_id', 26).notNullable();
      t.integer('position').notNullable();
      t.string('added_by', 26).notNullable();
      t.bigInteger('added_at').notNullable();
      t.unique(['album_id', 'file_id']);
      t.index(['album_id', 'position']);
      t.index(['tenant_id', 'file_id']);
    });
  }
  if (!(await knex.schema.hasTable('album_contributors'))) {
    await knex.schema.createTable('album_contributors', (t) => {
      t.string('album_id', 26).notNullable();
      t.string('tenant_id', 26).notNullable();
      t.string('user_id', 26).notNullable();
      t.string('role', 16).notNullable();
      t.string('added_by', 26).notNullable();
      t.bigInteger('added_at').notNullable();
      t.primary(['album_id', 'user_id']);
      t.index(['tenant_id', 'user_id']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('album_contributors');
  await knex.schema.dropTableIfExists('album_items');
  await knex.schema.dropTableIfExists('albums');
}
