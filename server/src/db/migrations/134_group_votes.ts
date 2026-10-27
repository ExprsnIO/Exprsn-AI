import type { Knex } from 'knex';

/*
 * 1.9.0, Sprint 53 (B-175, B-176): ballots, who voted, the commitments published at close, and a group budget.
 *
 * - `group_ballots`: one row per ballot. A public ballot names its voter (`voter_id`) and when it was cast. A secret
 *   ballot does not: `voter_id` and `voted_at` stay null, its id is random (not a ULID, which would carry a time), and
 *   it holds only the choice, the commitment HMAC(server key, ballot id, choice, nonce) and the digest of the change
 *   token its voter was given (to change it before close without the server knowing whose it is).
 * - `group_vote_participation`: who has voted on a proposal, with nothing about how and no time.
 * - `group_vote_commitments`: the list of (commitment, choice) published at close, for voters to find their receipt.
 * - `group_budgets` and `group_budget_entries`: a group's budget, an amount in minor units of one currency, and its
 *   ledger. An entry made by carrying out a decision names its proposal (unique), so a spend happens at most once.
 *
 * Expand only: five new tables.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('group_ballots'))) {
    await knex.schema.createTable('group_ballots', (t) => {
      t.string('id', 32).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('proposal_id', 26).notNullable();
      t.string('voter_id', 26).nullable();
      t.text('choice').notNullable();
      t.string('commitment', 64).nullable();
      t.string('change_hash', 64).nullable();
      t.bigInteger('voted_at').nullable();
      t.unique(['proposal_id', 'voter_id']);
      t.index(['proposal_id']);
    });
  }
  if (!(await knex.schema.hasTable('group_vote_participation'))) {
    await knex.schema.createTable('group_vote_participation', (t) => {
      t.string('proposal_id', 26).notNullable();
      t.string('tenant_id', 26).notNullable();
      t.string('user_id', 26).notNullable();
      t.primary(['proposal_id', 'user_id']);
    });
  }
  if (!(await knex.schema.hasTable('group_vote_commitments'))) {
    await knex.schema.createTable('group_vote_commitments', (t) => {
      t.string('proposal_id', 26).notNullable();
      t.string('tenant_id', 26).notNullable();
      t.string('commitment', 64).notNullable();
      t.text('choice').notNullable();
      t.primary(['proposal_id', 'commitment']);
    });
  }
  if (!(await knex.schema.hasTable('group_budgets'))) {
    await knex.schema.createTable('group_budgets', (t) => {
      t.string('group_id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('currency', 3).notNullable();
      t.bigInteger('balance_minor').notNullable().defaultTo(0);
      t.bigInteger('updated_at').notNullable();
    });
  }
  if (!(await knex.schema.hasTable('group_budget_entries'))) {
    await knex.schema.createTable('group_budget_entries', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('group_id', 26).notNullable();
      t.bigInteger('amount_minor').notNullable();
      t.string('currency', 3).notNullable();
      t.bigInteger('balance_after').notNullable();
      t.text('memo').nullable();
      t.string('proposal_id', 26).nullable().unique();
      t.string('created_by', 26).notNullable();
      t.bigInteger('created_at').notNullable();
      t.index(['tenant_id', 'group_id', 'created_at']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('group_budget_entries');
  await knex.schema.dropTableIfExists('group_budgets');
  await knex.schema.dropTableIfExists('group_vote_commitments');
  await knex.schema.dropTableIfExists('group_vote_participation');
  await knex.schema.dropTableIfExists('group_ballots');
}
