import type { Knex } from 'knex';

/*
 * Sprint 6: knowledge bases (sources, documents, versioned indexes, chunks and their keyword terms), the vector
 * table used by the database vector adapter, memory (records, versions, rejected proposals, exports) and data
 * connections. Chunk text, memory text, connection credentials and message citations are sealed with the tenant key;
 * keyword terms are stored as keyed hashes, never as words.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('knowledge_bases', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('workspace_id', 26).nullable(); // null: every workspace of the tenant
    t.string('name', 200).notNullable();
    t.string('description', 500).nullable();
    t.string('label', 20).notNullable(); // label floor: every document gets at least this
    t.string('embed_model', 200).notNullable();
    t.string('reranker', 200).nullable(); // a completion model that scores the fused candidates
    t.string('sharing', 20).notNullable().defaultTo('members'); // members | curators
    t.string('status', 20).notNullable().defaultTo('draft'); // draft | published
    t.text('chunking').notNullable(); // JSON {tokens, overlap}
    t.string('serving_index_id', 26).nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'name']);
  });

  await knex.schema.createTable('knowledge_indexes', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('kb_id', 26).notNullable().references('id').inTable('knowledge_bases').onDelete('CASCADE');
    t.integer('version').notNullable();
    t.string('embed_model', 200).notNullable();
    t.integer('dims').nullable();
    t.string('state', 20).notNullable(); // building | serving | retired | cancelled | failed
    t.integer('progress').notNullable().defaultTo(0);
    t.string('message', 300).nullable();
    t.integer('chunks').notNullable().defaultTo(0);
    t.string('job_id', 26).nullable();
    t.string('error', 500).nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('built_at').nullable();
    t.unique(['kb_id', 'version']);
  });

  await knex.schema.createTable('knowledge_sources', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('kb_id', 26).notNullable().references('id').inTable('knowledge_bases').onDelete('CASCADE');
    t.string('kind', 20).notNullable(); // upload | s3 | git | database
    t.string('location', 500).notNullable();
    t.text('config').notNullable(); // JSON, kind-specific
    t.string('label_floor', 20).notNullable();
    t.string('schedule', 20).notNullable(); // 15m | hourly | daily | manual
    t.string('state', 20).notNullable().defaultTo('idle'); // idle | syncing | failed
    t.string('watermark', 200).nullable(); // last commit, object time or column value seen
    t.bigInteger('last_sync_at').nullable();
    t.string('last_error', 500).nullable();
    t.string('last_trace', 64).nullable();
    t.string('job_id', 26).nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id', 'kb_id']);
  });

  await knex.schema.createTable('knowledge_documents', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('kb_id', 26).notNullable().references('id').inTable('knowledge_bases').onDelete('CASCADE');
    t.string('source_id', 26).notNullable().references('id').inTable('knowledge_sources').onDelete('CASCADE');
    t.string('external_key', 64).notNullable(); // sha256 of the object key, path or row id
    t.string('name', 300).notNullable();
    t.string('type', 100).nullable(); // detected media type
    t.bigInteger('size').notNullable().defaultTo(0);
    t.string('sha256', 64).nullable();
    t.string('version', 200).nullable(); // what the source reports (ETag, commit, row watermark): unchanged skips the fetch
    t.string('label', 20).notNullable(); // effective: the highest of floor, classifier and manual label
    t.string('auto_label', 20).nullable();
    t.string('manual_label', 20).nullable();
    t.string('label_origin', 200).notNullable();
    t.text('detections').nullable(); // JSON kinds and counts, never the matches
    t.string('state', 30).notNullable(); // quarantined | queued | indexing | indexed | unchanged | failed | rejected
    t.string('error', 500).nullable();
    t.string('trace_id', 64).nullable();
    t.string('blob_key', 300).nullable(); // sealed original
    t.integer('chunks').notNullable().defaultTo(0);
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.bigInteger('indexed_at').nullable();
    t.unique(['source_id', 'external_key']);
    t.index(['tenant_id', 'kb_id']);
  });

  await knex.schema.createTable('knowledge_chunks', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('kb_id', 26).notNullable();
    t.string('index_id', 26).notNullable().references('id').inTable('knowledge_indexes').onDelete('CASCADE');
    t.string('document_id', 26).notNullable();
    t.integer('seq').notNullable();
    t.text('content', 'mediumtext').notNullable(); // sealed JSON {text, heading}
    t.string('label', 20).notNullable();
    t.integer('label_rank').notNullable();
    t.integer('tokens').notNullable();
    t.bigInteger('created_at').notNullable();
    t.index(['index_id', 'document_id']);
    t.index(['index_id', 'label_rank']);
  });

  await knex.schema.createTable('knowledge_terms', (t) => {
    t.string('tenant_id', 26).notNullable();
    t.string('index_id', 26).notNullable();
    t.string('chunk_id', 26).notNullable();
    t.string('term', 32).notNullable(); // keyed hash of the normalised word
    t.integer('tf').notNullable();
    t.integer('label_rank').notNullable();
    t.index(['index_id', 'term']);
    t.index(['index_id', 'chunk_id']);
  });

  await knex.schema.createTable('knowledge_access', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('kb_id', 26).notNullable().references('id').inTable('knowledge_bases').onDelete('CASCADE');
    t.string('principal_kind', 20).notNullable(); // workspace | user | profile
    t.string('principal_id', 26).notNullable();
    t.string('access', 20).notNullable(); // read | manage
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.unique(['kb_id', 'principal_kind', 'principal_id']);
  });

  await knex.schema.createTable('knowledge_bindings', (t) => {
    t.string('conversation_id', 26).notNullable().references('id').inTable('conversations').onDelete('CASCADE');
    t.string('kb_id', 26).notNullable().references('id').inTable('knowledge_bases').onDelete('CASCADE');
    t.string('tenant_id', 26).notNullable();
    t.bigInteger('created_at').notNullable();
    t.primary(['conversation_id', 'kb_id']);
  });

  await knex.schema.createTable('knowledge_keys', (t) => {
    t.string('tenant_id', 26).primary();
    t.text('sealed').notNullable(); // the keyed-hash key for terms and the embedding cache, sealed with the tenant key
    t.bigInteger('created_at').notNullable();
  });

  await knex.schema.createTable('embedding_cache', (t) => {
    t.string('tenant_id', 26).notNullable();
    t.string('model', 200).notNullable();
    t.string('hash', 64).notNullable(); // keyed hash of the chunk text
    t.integer('dims').notNullable();
    t.text('embedding').notNullable();
    t.bigInteger('created_at').notNullable();
    t.primary(['tenant_id', 'model', 'hash']);
  });

  await knex.schema.createTable('vectors', (t) => {
    t.string('collection', 80).notNullable();
    t.string('id', 64).notNullable();
    t.string('tenant_id', 26).notNullable();
    t.string('partition', 80).notNullable();
    t.integer('label_rank').notNullable();
    t.integer('dims').notNullable();
    t.text('embedding').notNullable(); // base64 Float32
    t.bigInteger('created_at').notNullable();
    t.primary(['collection', 'id']);
    t.index(['collection', 'tenant_id', 'label_rank']);
    t.index(['tenant_id']);
  });

  await knex.schema.createTable('memories', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('scope', 20).notNullable(); // user | workspace | agent
    t.string('owner_id', 64).notNullable(); // user id, workspace id or agent name
    t.string('type', 30).notNullable();
    t.text('content').notNullable(); // sealed
    t.string('label', 20).notNullable();
    t.string('source_label', 20).notNullable(); // high-water mark of the sources; relabel cannot go below it
    t.string('state', 20).notNullable(); // proposed | active | superseded
    t.text('source').nullable(); // JSON {conversationId, messageId}
    t.string('origin', 30).notNullable(); // manual | chat | extraction
    t.string('author_id', 26).nullable();
    t.string('accepted_by', 26).nullable();
    t.string('embed_model', 200).nullable();
    t.bigInteger('expires_at').nullable();
    t.integer('version').notNullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id', 'scope', 'owner_id']);
  });

  await knex.schema.createTable('memory_versions', (t) => {
    t.string('id', 26).primary();
    t.string('memory_id', 26).notNullable().references('id').inTable('memories').onDelete('CASCADE');
    t.string('tenant_id', 26).notNullable();
    t.integer('version').notNullable();
    t.text('content').nullable(); // sealed; the text as it was at this version
    t.string('note', 300).notNullable();
    t.string('actor', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.index(['memory_id', 'created_at']);
  });

  await knex.schema.createTable('memory_rejections', (t) => {
    t.string('tenant_id', 26).notNullable();
    t.string('owner_key', 100).notNullable(); // scope:owner
    t.string('hash', 64).notNullable(); // keyed hash of the rejected text
    t.bigInteger('created_at').notNullable();
    t.primary(['tenant_id', 'owner_key', 'hash']);
  });

  await knex.schema.createTable('memory_exports', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('scope', 20).notNullable();
    t.string('owner_id', 64).notNullable();
    t.string('format', 10).notNullable(); // json | csv
    t.string('file', 200).notNullable();
    t.string('state', 20).notNullable(); // queued | ready | failed | purged
    t.integer('rows').nullable();
    t.string('label', 20).nullable(); // the highest label in the file
    t.string('max_label', 20).notNullable();
    t.string('blob_key', 300).nullable();
    t.string('job_id', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.index(['tenant_id', 'user_id']);
  });

  await knex.schema.createTable('data_connections', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('name', 63).notNullable();
    t.string('engine', 20).notNullable(); // postgres | opensearch
    t.string('endpoint', 300).notNullable();
    t.string('database', 200).nullable();
    t.string('zone', 63).notNullable();
    t.string('label', 20).notNullable(); // label ceiling: results carry it
    t.string('ops', 20).notNullable().defaultTo('read');
    t.integer('row_limit').notNullable();
    t.integer('timeout_s').notNullable();
    t.text('credential').nullable(); // sealed JSON {username, password}
    t.string('account', 200).nullable(); // the account name, shown
    t.boolean('tls').notNullable().defaultTo(false);
    t.text('allow_list').notNullable(); // JSON array of object names
    t.text('pii_columns').notNullable(); // JSON array of "object.column" marked by an admin
    t.text('schema', 'mediumtext').nullable(); // JSON introspection
    t.bigInteger('schema_at').nullable();
    t.string('health', 20).notNullable().defaultTo('unknown'); // unknown | healthy | degraded | unreachable
    t.string('health_detail', 300).nullable();
    t.bigInteger('checked_at').nullable();
    t.integer('version').notNullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'name']);
  });

  await knex.schema.alterTable('messages', (t) => {
    t.text('citations', 'mediumtext').nullable(); // sealed JSON: knowledge chunks and memories used for the answer
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('messages', (t) => {
    t.dropColumn('citations');
  });
  for (const table of [
    'data_connections',
    'memory_exports',
    'memory_rejections',
    'memory_versions',
    'memories',
    'vectors',
    'embedding_cache',
    'knowledge_keys',
    'knowledge_bindings',
    'knowledge_access',
    'knowledge_terms',
    'knowledge_chunks',
    'knowledge_documents',
    'knowledge_sources',
    'knowledge_indexes',
    'knowledge_bases'
  ]) {
    await knex.schema.dropTableIfExists(table);
  }
  if (knex.client.config.client === 'pg') await knex.raw('DROP TABLE IF EXISTS vectors_pg');
}
