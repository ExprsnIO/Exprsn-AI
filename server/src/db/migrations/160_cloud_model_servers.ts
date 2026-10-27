import type { Knex } from 'knex';

/*
 * 1.9.99-final, Sprint 60 (B-10509; the columns B-10505 prices every cloud model into next sprint):
 *
 * - `usage_records.neurons`: a Workers AI call's neurons (Cloudflare's billing unit), null for everything else.
 * - `usage_records.cost_micros`, `currency`, `price_id`: what the record cost at metering, in millionths of the
 *   currency, and the price it was priced with (`workers-ai:neurons@<sheet version>`); null when nothing priced it.
 *
 * Cloud model instances (Azure OpenAI, DigitalOcean GenAI, Workers AI) keep their flavour and account in the
 * instance's `settings.cloud`, and a DigitalOcean agent published as a tool keeps its endpoint and key reference in
 * the registry entry's definition, so neither needs a column. Expand only; a build from before this migration
 * ignores the columns, and the metering code writes them only once they exist.
 */
export async function up(knex: Knex): Promise<void> {
  const cols = [
    ['neurons', (t: Knex.AlterTableBuilder) => t.bigInteger('neurons').nullable()],
    ['cost_micros', (t: Knex.AlterTableBuilder) => t.bigInteger('cost_micros').nullable()],
    ['currency', (t: Knex.AlterTableBuilder) => t.string('currency', 3).nullable()],
    ['price_id', (t: Knex.AlterTableBuilder) => t.string('price_id', 100).nullable()]
  ] as const;
  for (const [name, add] of cols) {
    if (!(await knex.schema.hasColumn('usage_records', name))) await knex.schema.alterTable('usage_records', (t) => void add(t));
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const name of ['price_id', 'currency', 'cost_micros', 'neurons']) {
    if (await knex.schema.hasColumn('usage_records', name)) await knex.schema.alterTable('usage_records', (t) => t.dropColumn(name));
  }
}
