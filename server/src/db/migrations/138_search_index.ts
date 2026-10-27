import type { Knex } from 'knex';

/*
 * 1.9.0, Sprint 52 (B-170): the blind search index over sealed content (`search/`). Messages, posts and comments are
 * sealed at rest, so the index holds keyed hashes of their words, never a word:
 *
 * - `search_postings`: one row per kept word of a document: `term` is HMAC-SHA-256(tenant search key of
 *   `key_version`, "t" ‖ word), cut to 32 hex characters; `pos` is the word's place among the kept words (for phrases);
 *   `scope_id` the partition readers are checked against first (a conversation for a message; the group, else the
 *   workspace, for a post or a comment).
 * - `search_prefixes`: for type-ahead, which term hashes start with which 2-, 3- and 4-character prefixes (the prefix
 *   hashed the same way with "p"). One row per prefix and term of the tenant's vocabulary, not per document.
 * - `search_docs`: what each indexed document is, for filters before anything is opened: its kind and id, partition,
 *   workspace and group, author, label, visibility, time, length in kept words, and whether it carries a file or a
 *   link. Ids and times only; no text.
 *
 * Expand only: three new tables. A build from before this migration ignores them; this build searches as before
 * (per conversation, by tag) while they are missing, and indexing at write does nothing.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('search_postings'))) {
    await knex.schema.createTable('search_postings', (t) => {
      t.bigIncrements('id');
      t.string('tenant_id', 26).notNullable();
      t.integer('key_version').notNullable();
      t.string('term', 32).notNullable();
      t.string('doc_kind', 16).notNullable();
      t.string('doc_id', 26).notNullable();
      t.string('scope_id', 26).notNullable();
      t.integer('pos').notNullable();
      t.index(['tenant_id', 'key_version', 'term'], 'search_postings_term');
      t.index(['doc_kind', 'doc_id'], 'search_postings_doc');
    });
  }
  if (!(await knex.schema.hasTable('search_prefixes'))) {
    await knex.schema.createTable('search_prefixes', (t) => {
      t.string('tenant_id', 26).notNullable();
      t.integer('key_version').notNullable();
      t.string('prefix', 32).notNullable();
      t.string('term', 32).notNullable();
      t.primary(['tenant_id', 'key_version', 'prefix', 'term']);
    });
  }
  if (!(await knex.schema.hasTable('search_docs'))) {
    await knex.schema.createTable('search_docs', (t) => {
      t.string('doc_kind', 16).notNullable();
      t.string('doc_id', 26).notNullable();
      t.string('tenant_id', 26).notNullable();
      t.string('scope_id', 26).notNullable();
      t.string('parent_id', 26).nullable();
      t.string('workspace_id', 26).nullable();
      t.string('group_id', 26).nullable();
      t.string('author_id', 26).notNullable();
      t.string('label', 16).notNullable();
      t.string('visibility', 16).nullable();
      t.bigInteger('created_at').notNullable();
      t.integer('length').notNullable().defaultTo(0);
      t.boolean('has_file').notNullable().defaultTo(false);
      t.boolean('has_link').notNullable().defaultTo(false);
      t.bigInteger('indexed_at').notNullable();
      t.primary(['doc_kind', 'doc_id']);
      t.index(['tenant_id', 'doc_kind', 'scope_id'], 'search_docs_scope');
      t.index(['tenant_id', 'parent_id'], 'search_docs_parent');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const table of ['search_docs', 'search_prefixes', 'search_postings']) await knex.schema.dropTableIfExists(table);
}
