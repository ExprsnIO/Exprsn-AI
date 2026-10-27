import type { Knex } from 'knex';

/*
 * 1.7.0, Sprint 41 (B-9401 to B-9404): held messages, group posts, feed comments and edits.
 *
 * `held_writes` is one write the `user-input` guardrail held instead of refusing: a direct or group message, an edit
 * of one, a group post, a feed comment or an edit of a feed post. `reason` says why it waits: `review` (a rule asked
 * for a reviewer; `flag_id` is its hold flag in the review queue) or `unavailable` (a model-backed rule could not
 * run; the re-screen job decides it when the guard answers again, and no flag is filed). A new object waits in its own
 * table in the state `held` (its row keeps its id and its time); an edit waits here, sealed in `body`
 * (`held-write:<id>`), while the object keeps its published text. `state` moves once from `held` to `delivered`,
 * `rejected` or `withdrawn`, by compare-and-set, so a write is delivered at most once.
 *
 * `dm_messages.released_at`: when a held message was delivered, so it counts as unread for members who had already
 * read past its original time.
 *
 * The state columns of `dm_messages`, `group_posts` and `feed_comments` are plain strings and take `held` and
 * `rejected` as they are. Expand only: one new table and one nullable column.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('held_writes', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).nullable();
    t.string('kind', 24).notNullable(); // dm-message | dm-edit | group-post | feed-comment | feed-post | feed-post-edit
    t.string('object_id', 26).notNullable(); // the message, post or comment
    t.string('scope_id', 26).notNullable(); // its conversation, group or post
    t.string('author_id', 26).notNullable();
    t.string('label', 20).notNullable();
    t.text('body').nullable(); // sealed: the text of a held edit
    t.string('reason', 12).notNullable(); // review | unavailable
    t.string('state', 12).notNullable(); // held | delivered | rejected | withdrawn
    t.string('rule_name', 200).nullable();
    t.string('flag_id', 26).nullable();
    t.integer('attempts').notNullable().defaultTo(0);
    t.bigInteger('screened_at').nullable();
    t.string('decided_by', 26).nullable(); // a reviewer; null when the re-screen job or the author decided
    t.bigInteger('decided_at').nullable();
    t.string('note', 500).nullable();
    t.bigInteger('created_at').notNullable();
    t.index(['tenant_id', 'state', 'reason', 'created_at']);
    t.index(['object_id', 'state']);
    t.index(['author_id', 'state']);
  });
  await knex.schema.alterTable('dm_messages', (t) => {
    t.bigInteger('released_at').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('dm_messages', (t) => {
    t.dropColumn('released_at');
  });
  await knex.schema.dropTableIfExists('held_writes');
}
