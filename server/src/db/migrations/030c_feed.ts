import type { Knex } from 'knex';

/*
 * Sprint 28c (1.4.0), the workspace feed (030c): B-2701 to B-2705. Relations (follows, blocks, mutes, lists) are the
 * shared `social_*` tables of 030b; nothing here duplicates them.
 *
 * - `feed_posts`: a post in a workspace's feed, or targeted at a group (`group_id`; the group feed). The body is sealed
 *   with the tenant key (`feed-post:<id>`), `label` is the high-water mark of the post and its media. `state` is held
 *   (waiting in the flag queue, `flag_id`), published, rejected (by a reviewer), hidden (by moderation) or deleted.
 *   A repost is a post with `repost_of` set; a plain repost (no text of its own) has `repost_key` = the original's id,
 *   unique per author, so reposting twice gives the first one back (NULLs do not collide in any of the dialects).
 *   `published_at` orders feeds (cursor: published_at, id).
 * - `feed_post_media`: files from the file store (B-24; only versions that passed quarantine) attached to a post.
 * - `feed_comments`: threaded comments (`parent_id` is another comment on the same post), sealed (`feed-comment:<id>`).
 * - `feed_reactions`, `feed_bookmarks`: one row per person, post and reaction kind; per person and post.
 * - `feed_hashtags`: tags extracted when a post is published (lower case), for tag feeds and the trending job.
 * - `feed_trending`: what the `feed.trending` job counted per workspace, tag and label (readers sum the labels they
 *   are cleared for).
 * - `feed_digests`: the weekly workspace digest: the top posts (ids in clear, ranked) and the summary a profile wrote
 *   (sealed, `feed-digest:<id>`), one per workspace and week.
 * - `feed_settings`: per workspace, whether digests are written and by which profile.
 * Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('feed_posts', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).notNullable();
    t.string('group_id', 26).nullable();
    t.string('author_id', 26).notNullable();
    t.text('body', 'mediumtext').nullable(); // sealed; null for a plain repost
    t.string('label', 20).notNullable();
    t.string('state', 20).notNullable(); // held | published | rejected | hidden | deleted
    t.string('repost_of', 26).nullable();
    t.string('repost_key', 26).nullable();
    t.string('flag_id', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.bigInteger('published_at').nullable();
    t.bigInteger('edited_at').nullable();
    t.unique(['tenant_id', 'author_id', 'repost_key']);
    t.index(['tenant_id', 'workspace_id', 'state', 'published_at']);
    t.index(['tenant_id', 'group_id', 'state', 'published_at']);
    t.index(['tenant_id', 'author_id', 'published_at']);
    t.index(['tenant_id', 'repost_of']);
  });

  await knex.schema.createTable('feed_post_media', (t) => {
    t.string('post_id', 26).notNullable().references('id').inTable('feed_posts').onDelete('CASCADE');
    t.string('tenant_id', 26).notNullable();
    t.string('file_id', 26).notNullable();
    t.integer('position').notNullable();
    t.primary(['post_id', 'file_id']);
    t.index(['tenant_id', 'file_id']);
  });

  await knex.schema.createTable('feed_comments', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('post_id', 26).notNullable().references('id').inTable('feed_posts').onDelete('CASCADE');
    t.string('parent_id', 26).nullable();
    t.string('author_id', 26).notNullable();
    t.text('body').notNullable(); // sealed
    t.string('label', 20).notNullable();
    t.string('state', 20).notNullable(); // published | hidden | deleted
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['post_id', 'created_at']);
  });

  await knex.schema.createTable('feed_reactions', (t) => {
    t.string('post_id', 26).notNullable().references('id').inTable('feed_posts').onDelete('CASCADE');
    t.string('tenant_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('kind', 20).notNullable();
    t.bigInteger('created_at').notNullable();
    t.primary(['post_id', 'user_id', 'kind']);
  });

  await knex.schema.createTable('feed_bookmarks', (t) => {
    t.string('tenant_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('post_id', 26).notNullable().references('id').inTable('feed_posts').onDelete('CASCADE');
    t.bigInteger('created_at').notNullable();
    t.primary(['user_id', 'post_id']);
    t.index(['tenant_id', 'user_id', 'created_at']);
  });

  await knex.schema.createTable('feed_hashtags', (t) => {
    t.string('post_id', 26).notNullable().references('id').inTable('feed_posts').onDelete('CASCADE');
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).notNullable();
    t.string('tag', 64).notNullable();
    t.bigInteger('published_at').notNullable();
    t.primary(['post_id', 'tag']);
    t.index(['tenant_id', 'workspace_id', 'tag', 'published_at']);
  });

  await knex.schema.createTable('feed_trending', (t) => {
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).notNullable();
    t.string('tag', 64).notNullable();
    t.string('label', 20).notNullable();
    t.integer('posts').notNullable();
    t.integer('people').notNullable();
    t.bigInteger('window_start').notNullable();
    t.bigInteger('computed_at').notNullable();
    t.primary(['tenant_id', 'workspace_id', 'tag', 'label']);
  });

  await knex.schema.createTable('feed_digests', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).notNullable();
    t.bigInteger('week_start').notNullable();
    t.bigInteger('week_end').notNullable();
    t.string('label', 20).notNullable();
    t.string('state', 20).notNullable(); // ready | empty | failed
    t.text('posts').notNullable(); // JSON: [{ id, score, reactions, comments, reposts }], ranked
    t.text('summary', 'mediumtext').nullable(); // sealed
    t.string('profile', 200).nullable();
    t.string('error', 500).nullable();
    t.bigInteger('created_at').notNullable();
    t.unique(['tenant_id', 'workspace_id', 'week_start']);
  });

  await knex.schema.createTable('feed_settings', (t) => {
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).notNullable();
    t.boolean('digest_enabled').notNullable();
    t.string('digest_profile', 200).nullable();
    t.string('updated_by', 26).nullable();
    t.bigInteger('updated_at').notNullable();
    t.primary(['tenant_id', 'workspace_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const table of ['feed_settings', 'feed_digests', 'feed_trending', 'feed_hashtags', 'feed_bookmarks', 'feed_reactions', 'feed_comments', 'feed_post_media', 'feed_posts']) await knex.schema.dropTableIfExists(table);
}
