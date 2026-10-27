import type { Knex } from 'knex';

/*
 * 1.8.0, Sprint 48 (B-146): use-limited credentials.
 *
 * - `api_keys.max_uses`, `api_keys.uses_left`: a key accepted at most `max_uses` times. An `exai_k1_` key counts down
 *   `uses_left` on its row; an `exai_k2_` key (its verifier in a lease) counts down its lease's `uses_left`, and its
 *   row keeps `max_uses` only, for lists. Null: no limit, and no extra write per request.
 * - `vault_leases.max_uses`, `vault_leases.uses_left`: a lease used at most so many times (`GenericLeases.spend`).
 * - `app_embed_sessions.max_uses`, `app_embed_sessions.uses_left`: an embedded session from a host token whose
 *   `max_uses` claim limits its requests.
 *
 * Every count goes down by one conditional update (`uses_left > 0`), so instances sharing the database can never
 * accept more uses than the limit between them. Expand only: an older build ignores the columns (and the limit).
 */
const TABLES = ['api_keys', 'vault_leases', 'app_embed_sessions'] as const;

export async function up(knex: Knex): Promise<void> {
  for (const table of TABLES) {
    const hasMax = await knex.schema.hasColumn(table, 'max_uses');
    const hasLeft = await knex.schema.hasColumn(table, 'uses_left');
    if (hasMax && hasLeft) continue;
    await knex.schema.alterTable(table, (t) => {
      if (!hasMax) t.integer('max_uses').nullable();
      if (!hasLeft) t.integer('uses_left').nullable();
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const table of TABLES) {
    await knex.schema.alterTable(table, (t) => {
      t.dropColumn('uses_left');
      t.dropColumn('max_uses');
    });
  }
}
