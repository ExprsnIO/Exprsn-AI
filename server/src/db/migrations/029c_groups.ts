import type { Knex } from 'knex';

/*
 * Sprint 27c (1.4.0), groups and events (029c): B-2501 to B-2505.
 *
 * - `social_groups`: a group inside one workspace (the workspace stays the outer boundary). `visibility` is public
 *   (workspace members see it and read its content), private (listed; content for members) or hidden (only members,
 *   invitees and managers know it exists); `join_mode` is open, request or invite. `label` is the highest label of the
 *   group's content. The description is sealed with the tenant key. (`groups` itself is a reserved word in MySQL 8.)
 * - `group_members`: one row per member with the group role (owner, moderator, member).
 * - `group_requests`: join requests (`kind` request, from the user) and invitations (`kind` invite, to the user), each
 *   with an expiry. `pending_key` is set only while pending and unique, so a user has at most one pending request or
 *   invitation per group (NULLs do not collide in any of the three dialects).
 * - `group_posts`: small discussion posts (the workspace feed is B-27), body sealed; `state` published | hidden | deleted.
 * - `group_events`: events with the start and end in UTC and the IANA zone they were planned in; title, description
 *   and location sealed. `sequence` is the iCalendar SEQUENCE, moved by every change attendees should see.
 * - `group_event_rsvps`: RSVPs with guests and check-in.
 * - `group_event_reminders`: one row per reminder offset; the queue job fires it, and the row's state moves from
 *   scheduled to sent with a compare-and-set, so a reminder is sent once however many instances run jobs.
 * - `calendar_feeds`: signed iCalendar feed URLs (an event, a group or the user's own calendar); revocable.
 * Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('social_groups', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).notNullable();
    t.string('name', 200).notNullable();
    t.text('description').nullable(); // sealed
    t.string('visibility', 20).notNullable(); // public | private | hidden
    t.string('join_mode', 20).notNullable(); // open | request | invite
    t.string('label', 20).notNullable();
    t.string('state', 20).notNullable(); // active | hidden | deleted
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id', 'workspace_id', 'state']);
  });

  await knex.schema.createTable('group_members', (t) => {
    t.string('group_id', 26).notNullable().references('id').inTable('social_groups').onDelete('CASCADE');
    t.string('tenant_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('role', 20).notNullable(); // owner | moderator | member
    t.string('added_by', 26).nullable();
    t.bigInteger('joined_at').notNullable();
    t.primary(['group_id', 'user_id']);
    t.index(['tenant_id', 'user_id']);
  });

  await knex.schema.createTable('group_requests', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('group_id', 26).notNullable().references('id').inTable('social_groups').onDelete('CASCADE');
    t.string('user_id', 26).notNullable();
    t.string('kind', 20).notNullable(); // request | invite
    t.string('role', 20).notNullable();
    t.string('state', 20).notNullable(); // pending | accepted | declined | cancelled | expired
    t.string('pending_key', 60).nullable().unique();
    t.string('created_by', 26).notNullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('expires_at').notNullable();
    t.string('decided_by', 26).nullable();
    t.bigInteger('decided_at').nullable();
    t.index(['tenant_id', 'group_id', 'state']);
    t.index(['tenant_id', 'user_id', 'state']);
  });

  await knex.schema.createTable('group_posts', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('group_id', 26).notNullable().references('id').inTable('social_groups').onDelete('CASCADE');
    t.string('workspace_id', 26).notNullable();
    t.string('author_id', 26).notNullable();
    t.text('body', 'mediumtext').notNullable(); // sealed
    t.string('label', 20).notNullable();
    t.string('state', 20).notNullable(); // published | hidden | deleted
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id', 'group_id', 'created_at']);
  });

  await knex.schema.createTable('group_events', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('group_id', 26).notNullable().references('id').inTable('social_groups').onDelete('CASCADE');
    t.string('workspace_id', 26).notNullable();
    t.text('title').notNullable(); // sealed
    t.text('description', 'mediumtext').nullable(); // sealed
    t.text('location').nullable(); // sealed
    t.bigInteger('starts_at').notNullable(); // UTC epoch ms
    t.bigInteger('ends_at').notNullable();
    t.string('time_zone', 64).notNullable(); // IANA
    t.boolean('all_day').notNullable().defaultTo(false);
    t.integer('capacity').nullable();
    t.integer('max_guests').notNullable().defaultTo(0);
    t.string('reminders', 200).notNullable().defaultTo('[]'); // JSON: minutes before the start
    t.string('label', 20).notNullable();
    t.string('state', 20).notNullable(); // scheduled | cancelled | hidden
    t.integer('sequence').notNullable().defaultTo(0);
    t.string('cancel_reason', 500).nullable();
    t.string('created_by', 26).notNullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id', 'group_id', 'starts_at']);
  });

  await knex.schema.createTable('group_event_rsvps', (t) => {
    t.string('event_id', 26).notNullable().references('id').inTable('group_events').onDelete('CASCADE');
    t.string('tenant_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('response', 20).notNullable(); // going | maybe | declined
    t.integer('guests').notNullable().defaultTo(0);
    t.bigInteger('checked_in_at').nullable();
    t.string('checked_in_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.primary(['event_id', 'user_id']);
    t.index(['tenant_id', 'user_id']);
  });

  await knex.schema.createTable('group_event_reminders', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('event_id', 26).notNullable().references('id').inTable('group_events').onDelete('CASCADE');
    t.integer('minutes_before').notNullable();
    t.bigInteger('fire_at').notNullable();
    t.string('state', 20).notNullable(); // scheduled | sending | sent | cancelled | skipped
    t.string('job_id', 26).nullable();
    t.integer('recipients').nullable();
    t.bigInteger('sent_at').nullable();
    t.bigInteger('created_at').notNullable();
    t.index(['tenant_id', 'event_id']);
  });

  await knex.schema.createTable('calendar_feeds', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('kind', 20).notNullable(); // event | group | user
    t.string('target_id', 26).nullable();
    t.string('name', 200).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('revoked_at').nullable();
    t.string('revoked_by', 26).nullable();
    t.bigInteger('last_used_at').nullable();
    t.index(['tenant_id', 'user_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const table of ['calendar_feeds', 'group_event_reminders', 'group_event_rsvps', 'group_events', 'group_posts', 'group_requests', 'group_members', 'social_groups']) await knex.schema.dropTableIfExists(table);
}
