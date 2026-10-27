import type { Knex } from 'knex';

/*
 * 1.7.0, Sprint 42 (B-9703, B-9708): group profile fields, the member limit and event notices.
 *
 * - `social_groups.tags` (a JSON array of lower-case tags, in the clear like the name: the list searches them),
 *   `website`, `member_limit` (null: no limit) and the avatar and banner as pinned file versions (`*_file_id`,
 *   `*_version`), served only once the file store's scan released that version, as a person's avatar is.
 * - `group_event_notices`: one row per notice sent to an event's attendees: a reschedule (`dedupe` is
 *   `rescheduled:<event>:<sequence>`, unique, so one change of time tells its attendees once on any number of
 *   instances) or an organiser's message (`body` sealed as `event-notice:<id>`, read from the event by those who may
 *   read it; `dedupe` null).
 *
 * Expand only: nullable columns and one new table. No existing row changes.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('social_groups', 'member_limit'))) {
    await knex.schema.alterTable('social_groups', (t) => {
      t.text('tags').nullable();
      t.string('website', 300).nullable();
      t.integer('member_limit').nullable();
      t.string('avatar_file_id', 26).nullable();
      t.integer('avatar_version').nullable();
      t.string('banner_file_id', 26).nullable();
      t.integer('banner_version').nullable();
    });
  }
  if (!(await knex.schema.hasTable('group_event_notices'))) {
    await knex.schema.createTable('group_event_notices', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('event_id', 26).notNullable();
      t.string('group_id', 26).notNullable();
      t.string('kind', 16).notNullable(); // rescheduled | message
      t.string('dedupe', 80).nullable().unique();
      t.text('body').nullable(); // sealed: an organiser's message
      t.integer('recipients').notNullable().defaultTo(0);
      t.string('created_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.index(['event_id', 'created_at']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('group_event_notices');
  await knex.schema.alterTable('social_groups', (t) => {
    for (const c of ['tags', 'website', 'member_limit', 'avatar_file_id', 'avatar_version', 'banner_file_id', 'banner_version']) t.dropColumn(c);
  });
}
