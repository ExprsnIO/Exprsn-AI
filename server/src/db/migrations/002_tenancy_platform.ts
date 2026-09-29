import type { Knex } from 'knex';

/*
 * Sprint 2: workspaces and membership, quotas and metering, per-tenant data keys, jobs, notifications,
 * audit checkpoints and exports. Same conventions as 001_core (ULIDs, epoch-ms bigints, JSON text).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('workspaces', (t) => {
    t.string('slug', 63).nullable();
    t.string('description', 500).nullable();
    // tenant: every member of the tenant may use it; members: only listed members (direct or via a group mapping)
    t.string('visibility', 20).notNullable().defaultTo('members');
    t.string('state', 20).notNullable().defaultTo('active'); // active | archived
    t.bigInteger('updated_at').nullable();
  });

  await knex.schema.createTable('workspace_members', (t) => {
    t.string('workspace_id', 26).notNullable().references('id').inTable('workspaces').onDelete('CASCADE');
    t.string('user_id', 26).notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('source', 20).notNullable(); // direct | mapping
    t.bigInteger('created_at').notNullable();
    t.primary(['workspace_id', 'user_id', 'source']);
    t.index(['user_id']);
  });

  await knex.schema.alterTable('group_mappings', (t) => {
    // A mapping with a workspace also makes the group's members members of that workspace.
    t.string('workspace_id', 26).nullable().references('id').inTable('workspaces').onDelete('CASCADE');
  });

  await knex.schema.alterTable('sessions', (t) => {
    t.string('workspace_id', 26).nullable();
  });

  await knex.schema.createTable('quotas', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('workspace_id', 26).nullable().references('id').inTable('workspaces').onDelete('CASCADE'); // null: tenant total
    t.bigInteger('tokens_per_day').nullable(); // null: unlimited
    t.bigInteger('gpu_seconds_per_month').nullable();
    t.bigInteger('training_gpu_hours_per_month').nullable();
    t.string('updated_by', 26).nullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'workspace_id']);
  });

  await knex.schema.createTable('usage_records', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).nullable();
    t.string('user_id', 26).nullable();
    t.string('api_key_id', 26).nullable();
    t.string('kind', 20).notNullable(); // chat | compare | load | embed | training
    t.string('profile_id', 26).nullable();
    t.string('model', 200).nullable();
    t.string('pool_id', 26).nullable();
    t.string('conversation_id', 26).nullable();
    t.string('message_id', 26).nullable();
    t.bigInteger('prompt_tokens').notNullable().defaultTo(0);
    t.bigInteger('output_tokens').notNullable().defaultTo(0);
    t.bigInteger('thinking_tokens').notNullable().defaultTo(0);
    t.integer('calc_calls').notNullable().defaultTo(0);
    t.bigInteger('gpu_ms').notNullable().defaultTo(0);
    t.integer('day').notNullable(); // YYYYMMDD, UTC
    t.integer('month').notNullable(); // YYYYMM, UTC
    t.bigInteger('ts').notNullable();
    t.index(['tenant_id', 'day']);
    t.index(['tenant_id', 'workspace_id', 'day']);
    t.index(['tenant_id', 'month']);
  });

  await knex.schema.createTable('tenant_keys', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable(); // or "platform"
    t.integer('version').notNullable();
    t.string('kms', 20).notNullable(); // local | openbao
    t.string('key_name', 200).notNullable(); // KEK name in the KMS
    t.text('wrapped').nullable(); // the data key, wrapped by the KEK; null once destroyed
    t.string('state', 20).notNullable(); // active | retired | destroyed
    t.bigInteger('created_at').notNullable();
    t.bigInteger('destroyed_at').nullable();
    t.unique(['tenant_id', 'version']);
  });

  await knex.schema.createTable('jobs', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('type', 60).notNullable();
    t.string('state', 20).notNullable(); // queued | running | succeeded | failed | cancelled | preempted
    t.text('payload').notNullable();
    t.text('result', 'mediumtext').nullable();
    t.string('error', 1000).nullable();
    t.integer('progress').notNullable().defaultTo(0);
    t.string('message', 300).nullable();
    t.integer('attempts').notNullable().defaultTo(0);
    t.integer('max_attempts').notNullable().defaultTo(3);
    t.string('created_by', 26).nullable();
    t.string('dedupe_key', 200).nullable().unique();
    t.string('worker', 100).nullable();
    t.bigInteger('run_at').notNullable();
    t.bigInteger('locked_until').nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('started_at').nullable();
    t.bigInteger('finished_at').nullable();
    t.index(['state', 'run_at']);
    t.index(['tenant_id', 'created_at']);
  });

  await knex.schema.createTable('notifications', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('user_id', 26).notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('kind', 60).notNullable();
    t.string('title', 200).notNullable();
    t.string('body', 1000).nullable();
    t.string('route', 200).nullable();
    t.string('label', 20).notNullable().defaultTo('internal');
    t.bigInteger('created_at').notNullable();
    t.bigInteger('read_at').nullable();
    t.bigInteger('emailed_at').nullable();
    t.index(['user_id', 'created_at']);
  });

  await knex.schema.createTable('audit_checkpoints', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.bigInteger('seq').notNullable();
    t.string('hash', 64).notNullable();
    t.bigInteger('ts').notNullable();
    t.string('key', 200).notNullable();
    t.string('signature', 300).notNullable();
    t.string('blob_key', 300).nullable();
    t.string('created_by', 100).notNullable();
    t.unique(['tenant_id', 'seq']);
  });

  await knex.schema.createTable('exports', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('kind', 20).notNullable(); // audit | usage
    t.string('file', 200).notNullable();
    t.text('params').notNullable();
    t.string('scope', 300).notNullable();
    t.string('max_label', 20).notNullable();
    t.string('state', 20).notNullable(); // queued | running | ready | failed
    t.integer('rows').nullable();
    t.integer('omitted').nullable();
    t.string('blob_key', 300).nullable();
    t.string('job_id', 26).nullable();
    t.string('created_by', 26).notNullable();
    t.bigInteger('created_at').notNullable();
    t.index(['tenant_id', 'created_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const table of ['exports', 'audit_checkpoints', 'notifications', 'jobs', 'tenant_keys', 'usage_records', 'quotas', 'workspace_members']) {
    await knex.schema.dropTableIfExists(table);
  }
  await knex.schema.alterTable('sessions', (t) => t.dropColumn('workspace_id'));
  await knex.schema.alterTable('group_mappings', (t) => {
    // MySQL refuses to drop a column that a foreign key still uses.
    t.dropForeign(['workspace_id']);
    t.dropColumn('workspace_id');
  });
  await knex.schema.alterTable('workspaces', (t) => {
    t.dropColumn('slug');
    t.dropColumn('description');
    t.dropColumn('visibility');
    t.dropColumn('state');
    t.dropColumn('updated_at');
  });
}
