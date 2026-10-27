import type { Knex } from 'knex';

/*
 * 1.7.0, Sprint 43 (B-114): cross-posting public feed posts to the author's repo on this server's PDS.
 *
 * - `feed_crosspost_authors`: an author's choice to cross-post (off unless they turn it on).
 * - `feed_crossposts`: per post, the record written in the author's repo (its at-uri, rkey and cid), whether it is
 *   there now (`written`) or was removed (`deleted`), why not, and the last error.
 *
 * Expand only. A build from before this migration ignores the tables and cross-posts nothing.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('feed_crosspost_authors'))) {
    await knex.schema.createTable('feed_crosspost_authors', (t) => {
      t.string('tenant_id', 26).notNullable();
      t.string('user_id', 26).notNullable();
      t.boolean('enabled').notNullable().defaultTo(false);
      t.bigInteger('updated_at').notNullable();
      t.primary(['tenant_id', 'user_id']);
    });
  }
  if (!(await knex.schema.hasTable('feed_crossposts'))) {
    await knex.schema.createTable('feed_crossposts', (t) => {
      t.string('post_id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('author_id', 26).notNullable();
      t.string('account_id', 26).notNullable();
      t.string('did', 255).notNullable();
      t.string('rkey', 64).notNullable();
      t.string('uri', 600).notNullable();
      t.string('cid', 120).nullable();
      t.string('state', 20).notNullable();
      t.string('reason', 300).nullable();
      t.string('error', 600).nullable();
      t.bigInteger('updated_at').notNullable();
      t.index(['tenant_id', 'author_id']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('feed_crossposts');
  await knex.schema.dropTableIfExists('feed_crosspost_authors');
}
