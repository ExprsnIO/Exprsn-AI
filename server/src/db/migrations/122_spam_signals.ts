import type { Knex } from 'knex';

/*
 * 1.9.0, Sprint 50 (B-159, B-160): spam and flood signals and scores.
 *
 * The rate windows themselves are counters in the rate limiter's store (Redis or memory), not here. These tables hold
 * only what the pattern detectors need across events, and never content:
 *
 * - `spam_policies`: one row per tenant: whether the checks run at all (`enabled`, off until an admin saves a policy),
 *   the policy as JSON (per surface: off, shadow or enforce, and the window thresholds per account, IP range and
 *   tenant; the pattern thresholds; the score steps and the decay half-life) and the allow-list of exempt accounts.
 * - `spam_fingerprints`: one row per screened text: a 64-bit SimHash over word shingles (`fingerprint`, hex) split
 *   into four 16-bit bands (`b0` to `b3`) to find near-duplicates by band, the account that sent it, a 64-bit hash of
 *   where it went (`recipient`: a conversation, a post, a workspace or group) and when. Kept 24 hours by `spam.sweep`.
 * - `spam_domains`: the domains linked in a tenant, when each was first and last seen and how often: a domain first
 *   seen recently is "new". Rows unused for 90 days are pruned.
 * - `spam_scores`: per account (a user id, an AT-Protocol DID, or `ip:<range>` when no account is known): the score
 *   from 0 to 100 as last computed, its level (none, slow, hold, limit, case), the reasons (signal, value, threshold,
 *   points) and when; it decays from `updated_at` with the policy's half-life when read.
 *
 * Expand only. A build from before this migration ignores the tables.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('spam_policies'))) {
    await knex.schema.createTable('spam_policies', (t) => {
      t.string('tenant_id', 26).primary();
      t.boolean('enabled').notNullable().defaultTo(false);
      t.text('policy').notNullable();
      t.text('allow_list').nullable();
      t.string('updated_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
    });
  }
  if (!(await knex.schema.hasTable('spam_fingerprints'))) {
    await knex.schema.createTable('spam_fingerprints', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('account', 200).notNullable();
      t.string('surface', 20).notNullable();
      t.string('fingerprint', 16).notNullable();
      t.integer('b0').notNullable();
      t.integer('b1').notNullable();
      t.integer('b2').notNullable();
      t.integer('b3').notNullable();
      t.string('recipient', 16).nullable();
      t.bigInteger('created_at').notNullable();
      t.index(['tenant_id', 'b0', 'created_at'], 'spam_fingerprints_b0');
      t.index(['tenant_id', 'b1', 'created_at'], 'spam_fingerprints_b1');
      t.index(['tenant_id', 'b2', 'created_at'], 'spam_fingerprints_b2');
      t.index(['tenant_id', 'b3', 'created_at'], 'spam_fingerprints_b3');
      t.index(['tenant_id', 'account', 'created_at'], 'spam_fingerprints_account');
      t.index(['created_at'], 'spam_fingerprints_time');
    });
  }
  if (!(await knex.schema.hasTable('spam_domains'))) {
    await knex.schema.createTable('spam_domains', (t) => {
      t.string('tenant_id', 26).notNullable();
      t.string('domain', 253).notNullable();
      t.bigInteger('first_seen').notNullable();
      t.bigInteger('last_seen').notNullable();
      t.integer('uses').notNullable().defaultTo(1);
      t.primary(['tenant_id', 'domain']);
      t.index(['last_seen'], 'spam_domains_last_seen');
    });
  }
  if (!(await knex.schema.hasTable('spam_scores'))) {
    await knex.schema.createTable('spam_scores', (t) => {
      t.string('tenant_id', 26).notNullable();
      t.string('account', 200).notNullable();
      t.string('kind', 10).notNullable();
      t.string('user_id', 26).nullable();
      t.integer('score').notNullable().defaultTo(0);
      t.string('level', 10).notNullable().defaultTo('none');
      t.text('reasons').nullable();
      t.integer('events').notNullable().defaultTo(0);
      t.string('last_surface', 20).nullable();
      t.bigInteger('first_seen').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.primary(['tenant_id', 'account']);
      t.index(['tenant_id', 'updated_at'], 'spam_scores_tenant_time');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const t of ['spam_scores', 'spam_domains', 'spam_fingerprints', 'spam_policies']) await knex.schema.dropTableIfExists(t);
}
