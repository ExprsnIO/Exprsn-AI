import type { Knex } from 'knex';

/*
 * Sprint 31 (1.5.0), custom feed generators and relay commit verification (033b, B-3001 to B-3003, B-3604). Expand
 * only.
 *
 * - `atproto_feeds`: a tenant's feeds, each served by the tenant's AT-Protocol identity as a feed generator
 *   (`app.bsky.feed.getFeedSkeleton`): its record key, display name and description (the `app.bsky.feed.generator`
 *   record B-3004 publishes, and where it was published), its rules over the firehose (authors, collections, keywords,
 *   labels), an optional ranking through the gateway, retention, a per-feed rate limit, and running counts.
 * - `atproto_feed_items`: the feed index. One row per post a feed took from the firehose, with the sort key its
 *   cursor pages over (`sort`, then `id`): the time it was indexed, or its ranking score.
 * - `firehose_subscriptions.rejected`: relay commits dropped because their signature or proof did not verify.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('atproto_feeds', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('rkey', 64).notNullable(); // the generator record's key, and the last segment of the feed's at:// URI
    t.string('display_name', 100).notNullable();
    t.text('description').nullable();
    t.string('subscription_id', 26).nullable(); // only posts from this firehose subscription; null: every one
    t.text('rules', 'mediumtext').notNullable(); // JSON: authors, collections, keywords, labels, excludeLabels
    t.text('ranking').nullable(); // JSON: { kind: embedding | classifier, … } or null (newest first)
    t.integer('retention_hours').notNullable();
    t.integer('max_items').notNullable();
    t.integer('rate_per_minute').notNullable();
    t.string('auth', 20).notNullable().defaultTo('optional'); // optional | required (a service JWT)
    t.string('state', 20).notNullable().defaultTo('active'); // active | paused
    t.integer('rev').notNullable().defaultTo(1);
    t.string('publisher_did', 300).nullable(); // B-3004: the repo the generator record was published to
    t.string('record_uri', 500).nullable();
    t.string('record_cid', 200).nullable();
    t.bigInteger('published_at').nullable();
    t.bigInteger('indexed').notNullable().defaultTo(0);
    t.bigInteger('served').notNullable().defaultTo(0);
    t.bigInteger('rank_failed').notNullable().defaultTo(0);
    t.string('last_error', 500).nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'rkey'], { indexName: 'atproto_feeds_tenant_rkey_unique' });
  });
  await knex.schema.createTable('atproto_feed_items', (t) => {
    t.string('id', 26).primary(); // ULID: time-ordered, the tie-breaker under `sort`
    t.string('feed_id', 26).notNullable().references('id').inTable('atproto_feeds').onDelete('CASCADE');
    t.string('tenant_id', 26).notNullable();
    t.string('uri', 2048).notNullable();
    t.string('uri_hash', 64).notNullable();
    t.string('cid', 200).nullable();
    t.string('author_did', 300).notNullable();
    t.string('collection', 317).notNullable();
    t.bigInteger('sort').notNullable(); // indexed time (ms), or the ranking score × 1e9
    t.double('score').nullable();
    t.bigInteger('created_at').notNullable();
    t.unique(['feed_id', 'uri_hash'], { indexName: 'atproto_feed_items_feed_uri_unique' });
    t.index(['feed_id', 'sort', 'id'], 'atproto_feed_items_page_index');
    t.index(['feed_id', 'created_at'], 'atproto_feed_items_age_index');
    t.index(['tenant_id', 'uri_hash'], 'atproto_feed_items_uri_index');
  });
  await knex.schema.alterTable('firehose_subscriptions', (t) => {
    t.bigInteger('rejected').notNullable().defaultTo(0);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('atproto_feed_items');
  await knex.schema.dropTableIfExists('atproto_feeds');
  if (await knex.schema.hasColumn('firehose_subscriptions', 'rejected')) {
    await knex.schema.alterTable('firehose_subscriptions', (t) => {
      t.dropColumn('rejected');
    });
  }
}
