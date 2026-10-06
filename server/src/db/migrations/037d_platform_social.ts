import type { Knex } from 'knex';

/*
 * Social and messaging administration (037d_platform_social): B-4206, the policies behind the Social and messaging
 * screen. Expand only.
 *
 * - `social_workspace_policies`: one row per workspace, created on the first change (no row: the defaults). Feed:
 *   whether posts pass the `user-input` checkpoint in full (`feed_guard`; off leaves only the platform baseline for
 *   posts labelled internal or below), who approves held posts (`feed_approver`: reviewers | feed | guardrails | moderators), media
 *   allowed and their largest size. Groups: who may create them (members | admins), the visibility, join mode and
 *   event capacity a new group or event starts with. Messaging: who may start a conversation in the workspace
 *   (`contact_rule`: workspace | contacts | admins), on top of each person's own contact rule.
 * - `social_tenant_settings`: the tenant's weekly digest (profile, weekday and hour in UTC, posts, highest label) and
 *   the messaging summary profile; null columns fall back to the environment (FEED_DIGEST_*, MESSAGING_SUMMARY_PROFILE).
 * - `feed_trending_exclusions`: hashtags the tenant keeps out of trending (they still work on posts and hashtag feeds).
 * - `messaging_exports`: legal-hold exports of a conversation under dual control (decision Q5): requested with a
 *   reason (sealed) by a holder of social:manage, approved by a second platform admin, then written by the job
 *   `messaging.conversation.export` as a sealed CSV in the blob store that only the requester downloads.
 * Groups gain the state `archived` (read only) in the existing `social_groups.state` column.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('social_workspace_policies', (t) => {
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).notNullable().references('id').inTable('workspaces').onDelete('CASCADE');
    t.boolean('feed_guard').notNullable().defaultTo(true);
    t.string('feed_approver', 20).notNullable().defaultTo('reviewers');
    t.boolean('feed_media').notNullable().defaultTo(true);
    t.bigInteger('feed_media_max_bytes').nullable();
    t.string('group_create', 10).notNullable().defaultTo('members');
    t.string('group_visibility', 10).notNullable().defaultTo('private');
    t.string('group_join', 10).notNullable().defaultTo('request');
    t.integer('event_capacity').nullable();
    t.string('contact_rule', 12).notNullable().defaultTo('workspace');
    t.string('updated_by', 26).nullable();
    t.bigInteger('updated_at').notNullable();
    t.primary(['tenant_id', 'workspace_id']);
  });
  await knex.schema.createTable('social_tenant_settings', (t) => {
    t.string('tenant_id', 26).primary();
    t.string('digest_profile', 200).nullable();
    t.integer('digest_day').nullable(); // 0 Monday … 6 Sunday
    t.integer('digest_hour').nullable(); // 0 … 23, UTC
    t.integer('digest_top').nullable();
    t.string('digest_max_label', 20).nullable();
    t.string('summary_profile', 63).nullable();
    t.string('updated_by', 26).nullable();
    t.bigInteger('updated_at').notNullable();
  });
  await knex.schema.createTable('feed_trending_exclusions', (t) => {
    t.string('tenant_id', 26).notNullable();
    t.string('tag', 64).notNullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.primary(['tenant_id', 'tag']);
  });
  await knex.schema.createTable('messaging_exports', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('conversation_id', 26).notNullable();
    t.string('workspace_id', 26).nullable();
    t.string('label', 20).notNullable();
    t.text('reason').notNullable(); // sealed
    t.string('requested_by', 26).notNullable();
    t.string('approver_id', 26).nullable();
    t.string('state', 20).notNullable(); // pending | approved | rejected | withdrawn | ready | failed
    t.string('decided_by', 26).nullable();
    t.bigInteger('decided_at').nullable();
    t.string('note', 500).nullable();
    t.string('job_id', 26).nullable();
    t.string('file', 200).nullable();
    t.string('blob_key', 300).nullable();
    t.integer('messages').nullable();
    t.string('error', 500).nullable();
    t.bigInteger('downloaded_at').nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id', 'created_at'], 'messaging_exports_tenant_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const t of ['messaging_exports', 'feed_trending_exclusions', 'social_tenant_settings', 'social_workspace_policies']) await knex.schema.dropTableIfExists(t);
}
