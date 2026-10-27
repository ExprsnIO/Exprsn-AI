import type { Knex } from 'knex';

/*
 * 1.8.0, Sprint 45 (B-128): many-to-many relationships and back-references in Apps.
 *
 * - `app_record_links`: one link of a `relation` field (apps/relations.ts) from one record to another. `relation_id`
 *   is `<source entity id>:<field name>`; `from_id` is the record whose relation field holds the link, `to_id` the
 *   linked record (of the field's target entity, or of the same entity for a self-relation). `position` orders a
 *   record's links. A link is stored here only, never in the record's sealed values or the clear index; it holds ids
 *   and nothing else, so it needs no sealing.
 *
 * Unique (relation, from, to); indexes (relation, from, position) for a record's list and (relation, to) for the
 * back-reference and the target's delete. Expand only: a build from before this migration ignores the table.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('app_record_links')) return;
  await knex.schema.createTable('app_record_links', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('app_id', 26).notNullable();
    t.string('relation_id', 100).notNullable();
    t.string('from_id', 26).notNullable();
    t.string('to_id', 26).notNullable();
    t.bigInteger('position').notNullable().defaultTo(0);
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.unique(['relation_id', 'from_id', 'to_id'], { indexName: 'app_record_links_rel_from_to' });
    t.index(['relation_id', 'from_id', 'position'], 'app_record_links_rel_from_pos');
    t.index(['relation_id', 'to_id'], 'app_record_links_rel_to');
    t.index(['tenant_id', 'app_id'], 'app_record_links_app');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('app_record_links');
}
