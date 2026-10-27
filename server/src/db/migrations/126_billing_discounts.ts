import type { Knex } from 'knex';

/*
 * 1.9.0, Sprint 51 (B-165): discount tables, promotion codes, negotiated discounts and their approvals.
 *
 * - `billing_discount_rules`: one discount: `source` (`rule` for a table entry, `promotion` for one redeemed with a
 *   code, `negotiated` for one tenant's own terms), `scope` (`plan`, `seats`, `meter`, `model`, `family`,
 *   `statement`) with `scope_value` (the meter, model or family), `kind` (`percent`, `amount`, `allowance`,
 *   `volume`, `commitment`) with `terms` (JSON, `DiscountTerms` in `billing/types.ts`) and `currency` (for a fixed
 *   amount), validity (`valid_from`, `valid_to`, ms, end exclusive, null for open), who it applies to (`target_kind`
 *   `all`, `tenants` or `plans`, with `target_ids` JSON), `stack_order` (applied in ascending order), `state`
 *   (`proposed` until a second admin approves it when it is above the approval threshold, `active`, `rejected`,
 *   `retired`) and who proposed and decided it.
 * - `billing_promo_codes`: a code (unique, upper case) that redeems a promotion rule, with an expiry and a redemption
 *   limit; `redemptions` is counted in one conditional update, so concurrent redemptions never pass the limit.
 * - `billing_promo_redemptions`: one row per code and tenant (unique: a tenant redeems a code once).
 * - `billing_discount_approvals`: dual control: a proposal to create a rule, or to change one, above the threshold;
 *   `proposal` is the change (JSON); the proposer cannot decide it.
 * - `billing_discount_policy`: the platform's cap on the total discount of a statement (a share of the pre-discount
 *   total in parts per million, an amount in minor units, or both: the smaller wins) and the approval thresholds.
 *
 * Expand only. A build from before this migration ignores the tables.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('billing_discount_rules'))) {
    await knex.schema.createTable('billing_discount_rules', (t) => {
      t.string('id', 26).primary();
      t.string('name', 100).notNullable();
      t.string('source', 12).notNullable();
      t.string('scope', 12).notNullable();
      t.string('scope_value', 200).nullable();
      t.string('kind', 12).notNullable();
      t.text('terms').notNullable();
      t.string('currency', 3).nullable();
      t.bigInteger('valid_from').nullable();
      t.bigInteger('valid_to').nullable();
      t.string('target_kind', 8).notNullable();
      t.text('target_ids').nullable();
      t.integer('stack_order').notNullable().defaultTo(100);
      t.string('state', 10).notNullable();
      t.string('proposed_by', 26).nullable();
      t.bigInteger('proposed_at').notNullable();
      t.string('decided_by', 26).nullable();
      t.bigInteger('decided_at').nullable();
      t.string('note', 300).nullable();
      t.string('updated_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.index(['state', 'source'], 'billing_discount_rules_state');
    });
  }
  if (!(await knex.schema.hasTable('billing_promo_codes'))) {
    await knex.schema.createTable('billing_promo_codes', (t) => {
      t.string('id', 26).primary();
      t.string('code', 40).notNullable().unique('billing_promo_codes_code');
      t.string('rule_id', 26).notNullable();
      t.bigInteger('expires_at').nullable();
      t.integer('max_redemptions').nullable();
      t.integer('redemptions').notNullable().defaultTo(0);
      t.string('state', 10).notNullable();
      t.string('created_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.index(['rule_id'], 'billing_promo_codes_rule');
    });
  }
  if (!(await knex.schema.hasTable('billing_promo_redemptions'))) {
    await knex.schema.createTable('billing_promo_redemptions', (t) => {
      t.string('id', 26).primary();
      t.string('code_id', 26).notNullable();
      t.string('rule_id', 26).notNullable();
      t.string('tenant_id', 26).notNullable();
      t.string('redeemed_by', 26).nullable();
      t.bigInteger('redeemed_at').notNullable();
      t.unique(['code_id', 'tenant_id'], 'billing_promo_redemptions_once');
      t.index(['tenant_id', 'rule_id'], 'billing_promo_redemptions_tenant');
    });
  }
  if (!(await knex.schema.hasTable('billing_discount_approvals'))) {
    await knex.schema.createTable('billing_discount_approvals', (t) => {
      t.string('id', 26).primary();
      t.string('rule_id', 26).notNullable();
      t.string('change', 10).notNullable();
      t.text('proposal').notNullable();
      t.string('reason', 300).nullable();
      t.string('state', 10).notNullable();
      t.string('proposed_by', 26).notNullable();
      t.bigInteger('proposed_at').notNullable();
      t.string('decided_by', 26).nullable();
      t.bigInteger('decided_at').nullable();
      t.string('note', 300).nullable();
      t.index(['state', 'proposed_at'], 'billing_discount_approvals_state');
      t.index(['rule_id', 'state'], 'billing_discount_approvals_rule');
    });
  }
  if (!(await knex.schema.hasTable('billing_discount_policy'))) {
    await knex.schema.createTable('billing_discount_policy', (t) => {
      t.string('id', 20).primary();
      t.integer('cap_percent_ppm').nullable();
      t.bigInteger('cap_amount_minor').nullable();
      t.integer('approval_percent_ppm').nullable();
      t.bigInteger('approval_amount_minor').nullable();
      t.string('updated_by', 26).nullable();
      t.bigInteger('updated_at').notNullable();
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const t of ['billing_discount_policy', 'billing_discount_approvals', 'billing_promo_redemptions', 'billing_promo_codes', 'billing_discount_rules']) await knex.schema.dropTableIfExists(t);
}
