import type { Knex } from 'knex';

/*
 * Sprint 34c (1.5.0), profiles and presence: B-5801, B-5802.
 *
 * - `user_profiles`: per tenant and user, the parts of a profile a person writes themselves. `pronouns` and `bio` have
 *   passed the `user-input` guardrail (redacted text is what is stored). `label` is the profile's classification: a
 *   viewer whose clearance does not reach it sees the name only. `workspaces` (JSON list of workspace ids, null for
 *   every one) narrows who sees it to people sharing one of those workspaces. The avatar is a file in the file store
 *   (`avatar_file_id`, pinned to `avatar_version`); it is served only once that version passed the quarantine scan.
 * - `user_presence`: the status a person chose (`auto` derives it from their connections and idle time, or one of
 *   `available`, `away`, `busy`, `offline`), and `last_status`, the effective status last published, so a change is
 *   published once across instances.
 * - `presence_connections`: one row per user and instance holding sockets for them: how many, whether all of them
 *   report idle, and a heartbeat (`seen_at`). A row older than the lease belongs to an instance that went away.
 *
 * Expand only: new tables.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('user_profiles', (t) => {
    t.string('tenant_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('pronouns', 40).nullable();
    t.text('bio').nullable();
    t.string('label', 20).notNullable().defaultTo('internal');
    t.text('workspaces').nullable(); // JSON: workspace ids, null for all shared ones
    t.string('avatar_file_id', 26).nullable();
    t.integer('avatar_version').nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.primary(['tenant_id', 'user_id']);
    t.index(['tenant_id', 'avatar_file_id']);
  });

  await knex.schema.createTable('user_presence', (t) => {
    t.string('tenant_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('status', 20).notNullable().defaultTo('auto'); // auto | available | away | busy | offline
    t.string('last_status', 20).nullable(); // available | away | busy | offline
    t.bigInteger('updated_at').notNullable();
    t.primary(['tenant_id', 'user_id']);
  });

  await knex.schema.createTable('presence_connections', (t) => {
    t.string('tenant_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('instance_id', 100).notNullable();
    t.integer('sockets').notNullable();
    t.boolean('idle').notNullable().defaultTo(false);
    t.bigInteger('seen_at').notNullable();
    t.primary(['tenant_id', 'user_id', 'instance_id']);
    t.index(['instance_id']);
    t.index(['seen_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const table of ['presence_connections', 'user_presence', 'user_profiles']) await knex.schema.dropTableIfExists(table);
}
