import type { Knex } from 'knex';

/*
 * 1.9.0, Sprint 53 (B-174, B-176): group governance settings, proposals and the electorate fixed when voting opens.
 *
 * - `group_governance`: one row per group (none means the defaults in `groups/governance.ts`): who may propose
 *   (`propose`: members | role | owners, with `propose_role` a tier name or a custom role id), the default voting
 *   method and supermajority fraction, the default quorum (`quorum_kind`: none | share | count, `quorum_value` a
 *   percentage or a number of ballots), how long voting lasts (`min_hours`, `max_hours`, `default_hours`), whether
 *   ballots are secret by default, the kinds whose decisions wait for an owner's confirmation (`confirm_kinds`, JSON)
 *   and the group's rules (`rules`, sealed as `group-rules:<group id>`).
 * - `group_proposals`: a proposal and its lifecycle (draft → open → closed → carried_out | failed). Its title, text,
 *   options and the action it would take are one sealed JSON document (`content`, sealed as `group-proposal:<id>`);
 *   only the kind, the method, the times and the counts stand in clear. `result` is the published tally and working
 *   (option ids and counts, never option text); `carry_claimed_at` makes carrying out happen at most once.
 * - `group_proposal_electorate`: who may vote on a proposal, fixed when voting opens.
 *
 * Expand only: three new tables. Until this migration is applied the features report themselves unavailable.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('group_governance'))) {
    await knex.schema.createTable('group_governance', (t) => {
      t.string('group_id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('propose', 16).notNullable().defaultTo('members');
      t.string('propose_role', 26).nullable();
      t.string('method', 20).notNullable().defaultTo('majority');
      t.integer('threshold_num').notNullable().defaultTo(2);
      t.integer('threshold_den').notNullable().defaultTo(3);
      t.string('quorum_kind', 10).notNullable().defaultTo('none');
      t.integer('quorum_value').notNullable().defaultTo(0);
      t.integer('min_hours').notNullable().defaultTo(24);
      t.integer('max_hours').notNullable().defaultTo(336);
      t.integer('default_hours').notNullable().defaultTo(72);
      t.boolean('secret').notNullable().defaultTo(false);
      t.text('confirm_kinds').nullable();
      t.text('rules', 'mediumtext').nullable();
      t.string('updated_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.index(['tenant_id']);
    });
  }
  if (!(await knex.schema.hasTable('group_proposals'))) {
    await knex.schema.createTable('group_proposals', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('group_id', 26).notNullable();
      t.string('workspace_id', 26).notNullable();
      t.string('kind', 16).notNullable();
      t.string('state', 16).notNullable();
      t.text('content', 'mediumtext').notNullable();
      t.string('label', 20).notNullable();
      t.string('method', 20).notNullable();
      t.integer('threshold_num').notNullable().defaultTo(2);
      t.integer('threshold_den').notNullable().defaultTo(3);
      t.string('quorum_kind', 10).notNullable().defaultTo('none');
      t.integer('quorum_value').notNullable().defaultTo(0);
      t.boolean('secret').notNullable().defaultTo(false);
      t.integer('options').notNullable().defaultTo(0);
      t.integer('hours').nullable();
      t.bigInteger('opens_at').nullable();
      t.bigInteger('closes_at').nullable();
      t.bigInteger('reminded_at').nullable();
      t.bigInteger('closed_at').nullable();
      t.string('outcome', 16).nullable();
      t.text('result', 'mediumtext').nullable();
      t.integer('electorate').notNullable().defaultTo(0);
      t.integer('turnout').notNullable().defaultTo(0);
      t.boolean('needs_confirmation').notNullable().defaultTo(false);
      t.string('confirmed_by', 26).nullable();
      t.bigInteger('confirmed_at').nullable();
      t.bigInteger('carry_claimed_at').nullable();
      t.bigInteger('carried_at').nullable();
      t.text('carried_result').nullable();
      t.text('failure').nullable();
      t.string('conversation_id', 26).nullable();
      t.string('discussion_message_id', 26).nullable();
      t.string('created_by', 26).notNullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.index(['tenant_id', 'group_id', 'state']);
      t.index(['state', 'closes_at']);
    });
  }
  if (!(await knex.schema.hasTable('group_proposal_electorate'))) {
    await knex.schema.createTable('group_proposal_electorate', (t) => {
      t.string('proposal_id', 26).notNullable();
      t.string('tenant_id', 26).notNullable();
      t.string('user_id', 26).notNullable();
      t.primary(['proposal_id', 'user_id']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('group_proposal_electorate');
  await knex.schema.dropTableIfExists('group_proposals');
  await knex.schema.dropTableIfExists('group_governance');
}
