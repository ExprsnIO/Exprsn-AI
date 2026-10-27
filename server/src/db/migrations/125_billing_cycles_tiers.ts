import type { Knex } from 'knex';

/*
 * 1.9.0, Sprint 51 (B-163, B-164): statements per billing cycle, and tiered prices.
 *
 * `billing_statements` gains, all nullable (a row from before reads as a one-month cycle of its calendar month, and
 * nothing stored is rewritten):
 * - `period_start`, `period_end`: the window the statement covers (ms, UTC, end exclusive). `month` stays the key: the
 *   month the window ends in (a monthly statement's own month).
 * - `cycle`: JSON `{ kind, months, anchorDay }` plus the subscription and plan it was computed for, if any.
 * - `charges`: JSON, the statement lines of `billing/types.ts` (`ChargeLine[]`): plan, seats, proration, usage,
 *   discount and tax. The PDF and the Stripe invoice items are built from these.
 * - `pricing`: `monthly` (usage priced as before 1.9.0; the money is in `lines`) or `cycle` (the money is in
 *   `charges`, each a whole minor unit; `lines` keeps the metered detail).
 * - `discount_micros`: the sum of the discount lines (zero or negative).
 *
 * Tiers need no structural change: price book items are JSON (`price_books.items`, `price_book_versions.items`), and a
 * tiered item only adds keys (`pricing`, `tiers`, `minimumMicros`, `capMicros`) that a build from before ignores.
 *
 * Expand only.
 */
const COLUMNS = ['period_start', 'period_end', 'cycle', 'charges', 'pricing', 'discount_micros'] as const;

export async function up(knex: Knex): Promise<void> {
  const missing: string[] = [];
  for (const c of COLUMNS) if (!(await knex.schema.hasColumn('billing_statements', c))) missing.push(c);
  if (!missing.length) return;
  await knex.schema.alterTable('billing_statements', (t) => {
    if (missing.includes('period_start')) t.bigInteger('period_start').nullable();
    if (missing.includes('period_end')) t.bigInteger('period_end').nullable();
    if (missing.includes('cycle')) t.text('cycle').nullable();
    if (missing.includes('charges')) t.text('charges', 'mediumtext').nullable();
    if (missing.includes('pricing')) t.string('pricing', 10).nullable();
    if (missing.includes('discount_micros')) t.bigInteger('discount_micros').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const c of [...COLUMNS].reverse()) {
    if (await knex.schema.hasColumn('billing_statements', c)) await knex.schema.alterTable('billing_statements', (t) => t.dropColumn(c));
  }
}
