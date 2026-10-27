import type { Knex } from 'knex';

/*
 * Sprint 29 (1.5.0), record queries that the database answers from an index (031b): B-3601.
 *
 * The value indexes of `app_record_values` (029) gain the record id, so a page sorted on one indexed field is read in
 * order from the index, ties included, and stops at the page size (apps/query.ts). On PostgreSQL the text columns are
 * indexed with `COLLATE "C"`, the byte order the queries compare and sort in (the database's own collation is a
 * locale's, which neither matches byte order nor lets `like 'prefix%'` use the index), and each covers only the rows
 * with a value in its column: a query that says which column it reads (`v_num is not null`) can then use only the
 * index for it, even before the planner has statistics. MySQL's `v_norm` is already `utf8mb4_bin` and SQLite compares
 * bytes; their indexes are plain.
 *
 * The 029 indexes are dropped: the new ones start with the same columns on SQLite and MySQL, and on PostgreSQL they
 * serve the same equality lookups once the queries say `COLLATE "C"`. A 1.4.0 instance still running during a rolling
 * upgrade gets the same rows, its PostgreSQL text filters just no longer find an index. Expand only (a dropped index is
 * not a contract step: no build reads it by name).
 */
const NUM_INDEX = 'app_record_values_num_idx';
const NORM_INDEX = 'app_record_values_norm_idx';

export async function up(knex: Knex): Promise<void> {
  const pg = knex.client.config.client === 'pg';
  if (pg) {
    await knex.raw(`create index ${NUM_INDEX} on app_record_values (entity_id, field, v_num, record_id collate "C") where v_num is not null`);
    await knex.raw(`create index ${NORM_INDEX} on app_record_values (entity_id, field, v_norm collate "C", record_id collate "C") where v_norm is not null`);
  } else {
    await knex.schema.alterTable('app_record_values', (t) => {
      t.index(['entity_id', 'field', 'v_num', 'record_id'], NUM_INDEX);
      t.index(['entity_id', 'field', 'v_norm', 'record_id'], NORM_INDEX);
    });
  }
  await knex.schema.alterTable('app_record_values', (t) => {
    t.dropIndex(['entity_id', 'field', 'v_norm']);
    t.dropIndex(['entity_id', 'field', 'v_num']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('app_record_values', (t) => {
    t.index(['entity_id', 'field', 'v_norm']);
    t.index(['entity_id', 'field', 'v_num']);
  });
  await knex.schema.alterTable('app_record_values', (t) => {
    t.dropIndex([], NUM_INDEX);
    t.dropIndex([], NORM_INDEX);
  });
}
