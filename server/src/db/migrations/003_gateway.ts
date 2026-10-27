import type { Knex } from 'knex';

/*
 * Sprint 3: the Ollama gateway. Pools and instances are platform infrastructure (no tenant); the model catalogue is
 * platform-wide too; profiles belong to a tenant.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('pools', (t) => {
    t.string('id', 26).primary();
    t.string('name', 63).notNullable().unique();
    t.string('description', 500).nullable();
    t.string('accelerator', 20).notNullable(); // cuda | rocm | metal | cpu
    t.string('zone', 63).notNullable().defaultTo('inference');
    t.string('label_ceiling', 20).notNullable().defaultTo('internal'); // highest data label this pool may process
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
  });

  await knex.schema.createTable('instances', (t) => {
    t.string('id', 26).primary();
    t.string('pool_id', 26).notNullable().references('id').inTable('pools').onDelete('CASCADE');
    t.string('name', 100).notNullable();
    t.string('url', 300).notNullable();
    t.string('deploy', 20).notNullable(); // docker | baremetal
    t.text('tls').nullable(); // JSON {caFile, certFile, keyFile}: paths on the server, for mTLS
    t.text('settings').notNullable(); // JSON: memoryBytes, hardware, node, device, parallel, maxLoaded, numCtx, kvCacheType, keepAlive
    t.string('state', 20).notNullable().defaultTo('active'); // active | draining | disabled
    t.string('health', 20).notNullable().defaultTo('unknown'); // unknown | healthy | degraded | unreachable
    t.string('health_detail', 300).nullable();
    t.string('version', 40).nullable();
    t.bigInteger('last_seen_at').nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['pool_id', 'name']);
  });

  await knex.schema.createTable('models', (t) => {
    t.string('id', 26).primary();
    t.string('name', 200).notNullable().unique(); // the Ollama tag, e.g. llama3.1:8b-instruct-q5_K_M
    t.string('family', 100).nullable();
    t.string('parameter_size', 40).nullable();
    t.string('quantization', 40).nullable();
    t.string('format', 20).nullable(); // gguf | safetensors
    t.bigInteger('size_bytes').nullable();
    t.integer('context_length').nullable();
    t.text('capabilities').notNullable(); // JSON array: completion, tools, thinking, vision, embedding
    t.string('source', 500).notNullable();
    t.string('expected_digest', 80).nullable(); // pinned at request time; the pulled blob must match
    t.string('digest', 80).nullable(); // what was pulled and verified
    t.text('license').nullable(); // JSON {name, url, notes, recordedBy, recordedAt}
    t.string('label', 20).notNullable().defaultTo('internal'); // highest data label it is approved for
    t.string('state', 20).notNullable(); // draft | evaluated | approved | deprecated | retired
    t.string('import_state', 20).notNullable().defaultTo('pending'); // pending | pulling | pulled | failed
    t.string('import_error', 500).nullable();
    t.text('evaluation').nullable(); // JSON result of the last conformance run
    t.string('requested_by', 26).nullable();
    t.string('requested_tenant', 26).nullable();
    t.string('approved_by', 26).nullable();
    t.bigInteger('approved_at').nullable();
    t.bigInteger('retire_at').nullable();
    t.string('notes', 1000).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
  });

  await knex.schema.createTable('placements', (t) => {
    t.string('id', 26).primary();
    t.string('model_id', 26).notNullable().references('id').inTable('models').onDelete('CASCADE');
    t.string('pool_id', 26).notNullable().references('id').inTable('pools').onDelete('CASCADE');
    t.string('residency', 20).notNullable().defaultTo('warm'); // pinned | warm | cold
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.unique(['model_id', 'pool_id']);
  });

  await knex.schema.createTable('model_events', (t) => {
    t.string('id', 26).primary();
    t.string('instance_id', 26).notNullable();
    t.string('model', 200).notNullable();
    t.string('event', 20).notNullable(); // load | unload | evicted | pull
    t.string('reason', 300).nullable();
    t.string('actor', 200).nullable();
    t.bigInteger('ts').notNullable();
    t.index(['instance_id', 'ts']);
  });

  await knex.schema.createTable('profiles', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('name', 63).notNullable(); // slug used by clients and aliases
    t.string('display_name', 200).notNullable();
    t.string('description', 500).nullable();
    t.string('alias_of', 26).nullable(); // an alias profile only points at another profile
    t.string('model_id', 26).nullable().references('id').inTable('models');
    t.string('pool_id', 26).nullable().references('id').inTable('pools');
    t.integer('num_ctx').nullable();
    t.float('temperature').nullable();
    t.string('think_default', 10).notNullable().defaultTo('off'); // off | low | medium | high
    t.string('think_ceiling', 10).notNullable().defaultTo('off');
    t.text('system_prompt', 'mediumtext').nullable();
    t.text('fallback').nullable(); // JSON {profileId, afterQueueWaitMs}
    t.text('canary').nullable(); // JSON {modelId, percent}
    t.text('tools').notNullable(); // JSON array of built-in tools, e.g. ["calculate"]
    t.string('label', 20).notNullable().defaultTo('internal'); // highest data label; users need this clearance
    t.string('status', 20).notNullable(); // draft | published | disabled
    t.integer('version').notNullable();
    t.string('updated_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'name']);
  });

  await knex.schema.createTable('profile_versions', (t) => {
    t.string('id', 26).primary();
    t.string('profile_id', 26).notNullable().references('id').inTable('profiles').onDelete('CASCADE');
    t.integer('version').notNullable();
    t.text('snapshot', 'mediumtext').notNullable();
    t.string('note', 300).nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.unique(['profile_id', 'version']);
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const table of ['profile_versions', 'profiles', 'model_events', 'placements', 'models', 'instances', 'pools']) {
    await knex.schema.dropTableIfExists(table);
  }
}
