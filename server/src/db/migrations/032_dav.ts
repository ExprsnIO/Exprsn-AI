import type { Knex } from 'knex';

/*
 * Sprint 30 (1.5.0), the WebDAV core, CalDAV and CardDAV (032_dav): B-3101 to B-3104. The file store over WebDAV
 * (B-32, locks) has its own migration, 036c_dav_files.
 *
 * - `dav_app_passwords`: per-device app passwords for DAV clients (`exai_d1_<prefix>_<secret>`). The secret is kept as
 *   an HMAC; `scopes` is a JSON array of `caldav`, `carddav` and `webdav`. They authenticate `/dav` only, never `/api`
 *   or the console. `last_used_*` is what the settings list shows.
 * - `dav_collections`: personal calendars (`kind` calendar) and personal address books (`kind` addressbook), at the
 *   href segment the client chose (`slug`). The description is sealed with the tenant key. `sync_seq` is the collection's change counter (RFC 6578 sync tokens).
 * - `dav_objects`: the calendar objects and vCards in them, sealed (`body`), with the indexable times of a calendar
 *   object (`starts_at`, `ends_at`, UTC ms; null for an open end) so a time-range query is answered without opening
 *   every object. `sync_seq` is the collection's counter at the object's last change.
 * - `dav_tombstones`: objects removed from a collection, for sync-collection reports.
 * - `dav_properties`: dead properties set with PROPPATCH (value sealed), per resource (`coll:<id>`, a group calendar
 *   per user, and from B-32 files and folders), keyed by a SHA-256 of the property's name.
 * Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('dav_app_passwords', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('name', 100).notNullable();
    t.string('prefix', 12).notNullable().unique();
    t.string('secret_hash', 64).notNullable();
    t.string('scopes', 100).notNullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('expires_at').nullable();
    t.bigInteger('last_used_at').nullable();
    t.string('last_used_ip', 64).nullable();
    t.string('last_used_agent', 200).nullable();
    t.bigInteger('revoked_at').nullable();
    t.string('revoked_by', 26).nullable();
    t.index(['tenant_id', 'user_id'], 'dav_app_passwords_owner_idx');
  });

  await knex.schema.createTable('dav_collections', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('owner_id', 26).notNullable();
    t.string('kind', 20).notNullable(); // calendar | addressbook
    t.string('slug', 200).notNullable(); // the href segment the client chose (MKCALENDAR, extended MKCOL)
    t.string('name', 200).notNullable();
    t.text('description').nullable(); // sealed
    t.string('color', 20).nullable();
    t.string('time_zone', 64).nullable();
    t.string('components', 100).notNullable().defaultTo('');
    t.string('label', 20).notNullable();
    t.bigInteger('sync_seq').notNullable().defaultTo(0);
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.bigInteger('deleted_at').nullable();
    t.index(['tenant_id', 'owner_id', 'kind'], 'dav_collections_owner_idx');
    t.index(['tenant_id', 'owner_id', 'slug'], 'dav_collections_slug_idx');
  });

  await knex.schema.createTable('dav_objects', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('collection_id', 26).notNullable().references('id').inTable('dav_collections').onDelete('CASCADE');
    t.string('name', 255).notNullable();
    t.string('uid', 255).notNullable();
    t.string('etag', 64).notNullable();
    t.string('component', 20).nullable();
    t.bigInteger('starts_at').nullable();
    t.bigInteger('ends_at').nullable();
    t.integer('size').notNullable();
    t.text('body', 'mediumtext').notNullable(); // sealed
    t.bigInteger('sync_seq').notNullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['collection_id', 'name'], { indexName: 'dav_objects_name_uq' });
    t.index(['collection_id', 'uid'], 'dav_objects_uid_idx');
    t.index(['collection_id', 'sync_seq'], 'dav_objects_seq_idx');
    t.index(['collection_id', 'starts_at'], 'dav_objects_start_idx');
  });

  await knex.schema.createTable('dav_tombstones', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('collection_id', 26).notNullable().references('id').inTable('dav_collections').onDelete('CASCADE');
    t.string('name', 255).notNullable();
    t.bigInteger('sync_seq').notNullable();
    t.bigInteger('deleted_at').notNullable();
    t.index(['collection_id', 'sync_seq'], 'dav_tombstones_seq_idx');
  });

  await knex.schema.createTable('dav_properties', (t) => {
    t.string('resource', 40).notNullable();
    t.string('prop_key', 64).notNullable();
    t.string('tenant_id', 26).notNullable();
    t.string('ns', 512).notNullable();
    t.string('local', 255).notNullable();
    t.text('value').notNullable(); // sealed
    t.bigInteger('updated_at').notNullable();
    t.primary(['resource', 'prop_key'], 'dav_properties_pk');
    t.index(['tenant_id'], 'dav_properties_tenant_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const t of ['dav_properties', 'dav_tombstones', 'dav_objects', 'dav_collections', 'dav_app_passwords']) await knex.schema.dropTableIfExists(t);
}
