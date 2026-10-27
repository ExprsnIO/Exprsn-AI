import type { Knex } from 'knex';

/*
 * 1.8.0, Sprint 47 (B-140): presence and soft locks in the designers (`realtime/design-locks.ts`).
 *
 * Both live in the database rather than in one instance's memory, because the sockets of the people who have a design
 * open may be held by different instances: every instance reads the same rows, and one conditional write decides who
 * holds a lock.
 *
 * - `design_viewers`: one row per socket that has a design object open (a workflow draft, an app entity, form or
 *   flow), with the instance holding the socket. Refreshed by the console's heartbeat, deleted on close and
 *   disconnect; a row older than the viewer lease is from an instance that went away and is swept.
 * - `design_locks`: at most one edit lock per object (primary key tenant, kind, object). It names the holder (user,
 *   session, socket when taken over the socket), the object's label and title when taken (an admin's list is filtered
 *   by that label), and `expires_at`, pushed forward by the holder's heartbeat. An expired row holds nothing and is
 *   swept.
 *
 * Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('design_viewers'))) {
    await knex.schema.createTable('design_viewers', (t) => {
      t.string('socket_id', 64).notNullable();
      t.string('kind', 20).notNullable();
      t.string('object_id', 26).notNullable();
      t.string('tenant_id', 26).notNullable();
      t.string('user_id', 26).notNullable();
      t.string('user_name', 200).notNullable();
      t.string('instance_id', 100).notNullable();
      t.bigInteger('opened_at').notNullable();
      t.bigInteger('seen_at').notNullable();
      t.primary(['socket_id', 'kind', 'object_id']);
      t.index(['tenant_id', 'kind', 'object_id'], 'design_viewers_object');
      t.index(['seen_at'], 'design_viewers_seen');
    });
  }
  if (!(await knex.schema.hasTable('design_locks'))) {
    await knex.schema.createTable('design_locks', (t) => {
      t.string('tenant_id', 26).notNullable();
      t.string('kind', 20).notNullable();
      t.string('object_id', 26).notNullable();
      t.string('label', 20).notNullable();
      t.string('title', 200).notNullable();
      t.string('user_id', 26).notNullable();
      t.string('user_name', 200).notNullable();
      t.string('session_id', 26).nullable();
      t.string('socket_id', 64).nullable();
      t.string('instance_id', 100).notNullable();
      t.bigInteger('acquired_at').notNullable();
      t.bigInteger('renewed_at').notNullable();
      t.bigInteger('expires_at').notNullable();
      t.primary(['tenant_id', 'kind', 'object_id']);
      t.index(['expires_at'], 'design_locks_expires');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('design_locks');
  await knex.schema.dropTableIfExists('design_viewers');
}
