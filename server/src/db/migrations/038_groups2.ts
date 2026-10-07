import type { Knex } from 'knex';

/*
 * Sprint 36a (1.6.0), groups depth (038_groups2): B-4401 to B-4405. Expand only.
 *
 * - `social_groups.parent_id`: a channel (subgroup) is a group row inside another group (one level deep). It has its own
 *   members (`group_members`), roles and posts (`group_posts`), and its label is never below its group's (the floor).
 * - `social_groups.category_id`: the tenant's group category (B-4405); null is uncategorised. No foreign key: removing
 *   a category sets its groups' column to null in the same transaction, so they stay listed.
 * - `social_groups.location` (sealed place name), `lat`, `lon` and `group_events.lat`, `lon` (B-4403): an optional point
 *   in WGS 84 degrees for distance filters. Coordinates are kept in the clear so the database can filter on them.
 * - `group_categories`: the tenant-managed category list (decision Q6), managed from Social and messaging.
 * - `group_trending`: what the `groups.trending` job counted per group (joins and posts in the window), like
 *   `feed_trending` for hashtags (B-4404).
 * On PostgreSQL with PostGIS available (installed, or installable by this role), the extension is created and both
 * tables get a GiST index on the point as a geography, which the distance filter uses; elsewhere it filters on a
 * bounding box (the latitude index). Either way the exact distance is decided by the same great-circle formula.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('social_groups', (t) => {
    t.string('parent_id', 26).nullable();
    t.string('category_id', 26).nullable();
    t.text('location').nullable(); // sealed
    t.double('lat').nullable();
    t.double('lon').nullable();
    t.index(['tenant_id', 'parent_id'], 'social_groups_parent_idx');
    t.index(['tenant_id', 'category_id'], 'social_groups_category_idx');
    t.index(['tenant_id', 'lat'], 'social_groups_lat_idx');
  });
  await knex.schema.alterTable('group_events', (t) => {
    t.double('lat').nullable();
    t.double('lon').nullable();
    t.index(['tenant_id', 'lat'], 'group_events_lat_idx');
  });
  await knex.schema.createTable('group_categories', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('name', 80).notNullable();
    t.string('name_key', 80).notNullable(); // lower-cased name: unique per tenant on every dialect
    t.string('description', 300).nullable();
    t.integer('position').notNullable().defaultTo(0);
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'name_key'], { indexName: 'group_categories_name_uq' });
  });
  await knex.schema.createTable('group_trending', (t) => {
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).notNullable();
    t.string('group_id', 26).notNullable();
    t.string('label', 20).notNullable();
    t.integer('joins').notNullable();
    t.integer('posts').notNullable();
    t.integer('score').notNullable();
    t.bigInteger('window_start').notNullable();
    t.bigInteger('computed_at').notNullable();
    t.primary(['tenant_id', 'group_id']);
    t.index(['tenant_id', 'workspace_id'], 'group_trending_ws_idx');
  });

  if (knex.client.config.client === 'pg' && (await postgisInstallable(knex))) {
    await knex.raw('CREATE EXTENSION IF NOT EXISTS postgis');
    for (const table of ['social_groups', 'group_events'])
      await knex.raw(`CREATE INDEX IF NOT EXISTS ${table}_geog_idx ON ${table} USING gist ((ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography)) WHERE lat IS NOT NULL AND lon IS NOT NULL`);
  }
}

/** PostGIS is installed already, or available and this role may create it (a superuser). Never fails the migration. */
async function postgisInstallable(knex: Knex): Promise<boolean> {
  const r = (await knex.raw(
    "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') AS installed, EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'postgis') AS available, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS super"
  )) as { rows: { installed: boolean; available: boolean; super: boolean }[] };
  const row = r.rows[0];
  return !!row && (row.installed || (row.available && row.super));
}

export async function down(knex: Knex): Promise<void> {
  if (knex.client.config.client === 'pg') for (const table of ['social_groups', 'group_events']) await knex.raw(`DROP INDEX IF EXISTS ${table}_geog_idx`);
  await knex.schema.dropTableIfExists('group_trending');
  await knex.schema.dropTableIfExists('group_categories');
  await knex.schema.alterTable('group_events', (t) => {
    t.dropIndex(['tenant_id', 'lat'], 'group_events_lat_idx');
    t.dropColumn('lat');
    t.dropColumn('lon');
  });
  await knex.schema.alterTable('social_groups', (t) => {
    t.dropIndex(['tenant_id', 'parent_id'], 'social_groups_parent_idx');
    t.dropIndex(['tenant_id', 'category_id'], 'social_groups_category_idx');
    t.dropIndex(['tenant_id', 'lat'], 'social_groups_lat_idx');
    for (const c of ['parent_id', 'category_id', 'location', 'lat', 'lon']) t.dropColumn(c);
  });
}
