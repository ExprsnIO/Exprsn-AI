import type { Knex } from 'knex';

/*
 * 1.7.0, Sprint 42 (B-9705, B-9707): a group's own roles, and what an event may ask of an RSVP.
 *
 * - `group_roles` (B-9705): a group's custom roles, each a name and the rights it carries (JSON, from the list in
 *   groups/roles.ts). `group_members.custom_role_id` names the one a member holds; null for everyone today.
 *   `group_members.role` and `group_requests.role` keep their column and their values: owner, moderator and member mean
 *   what they meant, and two more tiers, admin and guest, may now be written there. No membership row is changed, so
 *   nobody's rights change with this migration.
 * - `group_events` (B-9707): `kind` (in-person, virtual, hybrid; in-person for the events there are), `virtual_url`
 *   (sealed), `visibility` (group, members, organisers; group for the events there are, which is who read them
 *   before), `rsvp_deadline`, `rsvp_approval` and `waitlist` (off for the events there are). The state `draft` may now
 *   be written to `state`.
 * - `group_event_rsvps`: `queued_at` orders the waitlist and the answers that wait for approval; `decided_by` and
 *   `decided_at` record who approved or declined one. The responses `waitlisted` and `pending` may now be written.
 *
 * Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('group_roles'))) {
    await knex.schema.createTable('group_roles', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('group_id', 26).notNullable();
      t.string('name', 60).notNullable();
      t.string('name_key', 60).notNullable(); // the name in lower case: one role of a name in a group
      t.string('rights', 400).notNullable(); // JSON array of rights
      t.string('created_by', 26).notNullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.unique(['group_id', 'name_key']);
      t.index(['tenant_id', 'group_id']);
    });
  }
  if (!(await knex.schema.hasColumn('group_members', 'custom_role_id'))) {
    await knex.schema.alterTable('group_members', (t) => {
      t.string('custom_role_id', 26).nullable();
    });
  }
  if (!(await knex.schema.hasColumn('group_events', 'kind'))) {
    await knex.schema.alterTable('group_events', (t) => {
      t.string('kind', 20).notNullable().defaultTo('in-person'); // in-person | virtual | hybrid
      t.text('virtual_url').nullable(); // sealed as event-url:<id>
      t.string('visibility', 20).notNullable().defaultTo('group'); // group | members | organisers
      t.bigInteger('rsvp_deadline').nullable();
      t.boolean('rsvp_approval').notNullable().defaultTo(false);
      t.boolean('waitlist').notNullable().defaultTo(false);
    });
  }
  if (!(await knex.schema.hasColumn('group_event_rsvps', 'queued_at'))) {
    await knex.schema.alterTable('group_event_rsvps', (t) => {
      t.bigInteger('queued_at').nullable();
      t.string('decided_by', 26).nullable();
      t.bigInteger('decided_at').nullable();
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  // Custom roles and the tiers admin and guest have no meaning before this migration: their holders become members.
  await knex('group_members').whereIn('role', ['admin', 'guest']).update({ role: 'member' });
  await knex('group_requests').whereIn('role', ['admin', 'guest']).update({ role: 'member' });
  await knex('group_event_rsvps').whereIn('response', ['waitlisted', 'pending']).delete();
  await knex('group_events').where({ state: 'draft' }).update({ state: 'cancelled' });
  await knex.schema.alterTable('group_event_rsvps', (t) => {
    t.dropColumn('queued_at');
    t.dropColumn('decided_by');
    t.dropColumn('decided_at');
  });
  await knex.schema.alterTable('group_events', (t) => {
    t.dropColumn('kind');
    t.dropColumn('virtual_url');
    t.dropColumn('visibility');
    t.dropColumn('rsvp_deadline');
    t.dropColumn('rsvp_approval');
    t.dropColumn('waitlist');
  });
  await knex.schema.alterTable('group_members', (t) => {
    t.dropColumn('custom_role_id');
  });
  await knex.schema.dropTableIfExists('group_roles');
}
