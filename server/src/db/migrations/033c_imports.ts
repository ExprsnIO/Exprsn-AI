import type { Knex } from 'knex';

/*
 * Sprint 31 (1.5.0), import repositories and model import (033c; built in Sprint 30 as 032b, renamed so it runs after
 * the Sprint 30 migrations on databases that already have them): B-3801 to B-3803.
 *
 * - `import_repositories`: the tenant's registry of sources (Hugging Face compatible hubs, Ollama compatible
 *   registries, CKAN, DCAT-AP, SDMX, OpenML, InvenioRDM, Kaggle and the signed bundle share). A repository is proposed
 *   by one admin and confirmed by another before its hosts join the staging-proxy allow-list and it is harvested; its
 *   credential is a `vault:` reference resolved as the user who saved it.
 * - `import_catalog` and `import_catalog_facets`: the catalogue snapshot of each repository, one row per model or
 *   dataset with its facet values (classification, licence, format… from the source's own taxonomy) in a side table,
 *   so a facet's count and the rows its filter returns are the same query.
 * - `import_jobs`: the Imports queue (one row per import request, with its pinned files, checks, log and manifest);
 *   `import_exceptions`: licence exceptions decided by the `legal-review` role; `import_gates`: gated repositories
 *   accepted with the recorded token; `import_quotas` and `import_settings`: the tenant's import quota and licence
 *   allow-list.
 *
 * Expand only: new tables.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('import_repositories', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('name', 120).notNullable();
    t.string('type', 20).notNullable(); // hf | ollama | ckan | dcat | sdmx | openml | invenio | kaggle | bundle
    t.string('base_url', 500).notNullable();
    t.string('host', 253).notNullable();
    t.text('extra_hosts').notNullable(); // JSON array: redirect and CDN hosts on the allow-list with the base host
    t.string('region', 40).notNullable();
    t.text('kinds').notNullable(); // JSON array: model, dataset
    t.text('options').notNullable(); // JSON: type-specific (models to track, query, page size)
    t.string('credential_ref', 300).nullable(); // vault:path#key
    t.string('credential_owner', 26).nullable(); // whose vault policy resolves it
    t.string('licence_policy', 1000).nullable(); // the repository's note on licences, shown with its items
    t.integer('harvest_minutes').nullable(); // null: manual
    t.bigInteger('next_harvest_at').nullable();
    t.string('state', 20).notNullable(); // pending | active | disabled | rejected
    t.string('status', 20).notNullable(); // unknown | reachable | rate limited | unreachable | needs token
    t.string('status_detail', 500).nullable();
    t.bigInteger('backoff_until').nullable();
    t.integer('backoff_count').notNullable().defaultTo(0);
    t.bigInteger('snapshot_at').nullable();
    t.integer('snapshot_items').notNullable().defaultTo(0);
    t.string('harvest_job', 26).nullable();
    t.string('requested_by', 26).notNullable();
    t.string('decided_by', 26).nullable();
    t.bigInteger('decided_at').nullable();
    t.string('decision_note', 500).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'name']);
    t.index(['state', 'next_harvest_at']);
  });

  await knex.schema.createTable('import_catalog', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('repository_id', 26).notNullable();
    t.string('kind', 10).notNullable(); // model | dataset
    t.string('item_id', 300).notNullable(); // the source's id: org/repo, a CKAN name, an SDMX flow…
    t.string('name', 400).notNullable();
    t.string('publisher', 200).nullable();
    t.text('description').nullable();
    t.string('classification', 120).nullable();
    t.string('licence', 120).nullable();
    t.text('formats').notNullable(); // JSON array
    t.boolean('gated').notNullable().defaultTo(false);
    t.bigInteger('size_bytes').nullable();
    t.string('updated', 40).nullable(); // as the source states it
    t.text('search').notNullable(); // lower-cased text the snapshot search matches
    t.text('data', 'mediumtext').notNullable(); // JSON: the source's other fields (variants, tags, popularity…)
    t.integer('position').notNullable(); // the source's order (popularity) in the harvest
    t.bigInteger('harvested_at').notNullable();
    t.unique(['repository_id', 'kind', 'item_id']);
    t.index(['tenant_id', 'repository_id', 'kind']);
  });

  await knex.schema.createTable('import_catalog_facets', (t) => {
    t.string('catalog_id', 26).notNullable();
    t.string('repository_id', 26).notNullable();
    t.string('facet', 40).notNullable();
    t.string('value', 200).notNullable();
    t.primary(['catalog_id', 'facet', 'value']);
    t.index(['repository_id', 'facet', 'value']);
  });

  await knex.schema.createTable('import_jobs', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('ref', 20).notNullable(); // IMP-2026-41
    t.string('workspace_id', 26).nullable();
    t.string('kind', 10).notNullable(); // model | dataset
    t.string('repository_id', 26).notNullable();
    t.string('item_id', 300).notNullable();
    t.string('item_name', 400).notNullable();
    t.string('revision', 100).nullable(); // pinned commit, manifest digest or bundle
    t.string('target', 20).notNullable(); // models
    t.string('mode', 10).notNullable(); // direct | bundle
    t.string('state', 30).notNullable(); // queued | waiting on licence | queued for bundle | running | complete | refused | failed | cancelled
    t.string('stage', 60).nullable();
    t.integer('progress').notNullable().defaultTo(0);
    t.string('note', 500).nullable();
    t.text('files', 'mediumtext').notNullable(); // JSON: pinned files with their download state
    t.text('options').notNullable(); // JSON: tag, quantization, pool, family, capabilities
    t.text('checks').notNullable(); // JSON: the policy checks at request time
    t.text('log', 'mediumtext').notNullable(); // JSON: the timeline
    t.text('manifest', 'mediumtext').nullable(); // JSON: source, revision, digests, licence, label, attribution, requester
    t.string('licence', 120).nullable();
    t.string('licence_status', 30).notNullable(); // allowed | exception pending | exception granted | exception refused
    t.string('label', 20).notNullable();
    t.string('attribution', 500).nullable();
    t.bigInteger('size_bytes').notNullable().defaultTo(0);
    t.bigInteger('stored_bytes').notNullable().defaultTo(0);
    t.string('job_id', 26).nullable();
    t.string('model_id', 26).nullable();
    t.string('error', 1000).nullable();
    t.string('requested_by', 26).notNullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.bigInteger('started_at').nullable();
    t.bigInteger('finished_at').nullable();
    t.unique(['tenant_id', 'ref']);
    t.index(['tenant_id', 'state']);
  });

  await knex.schema.createTable('import_exceptions', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('ref', 20).notNullable(); // EXC-118
    t.string('import_id', 26).notNullable();
    t.string('licence', 120).notNullable();
    t.string('reason', 1000).nullable();
    t.string('state', 20).notNullable(); // pending | granted | refused
    t.string('requested_by', 26).notNullable();
    t.bigInteger('requested_at').notNullable();
    t.string('decided_by', 26).nullable();
    t.bigInteger('decided_at').nullable();
    t.string('decision_note', 1000).nullable();
    t.unique(['tenant_id', 'ref']);
    t.index(['tenant_id', 'state']);
  });

  await knex.schema.createTable('import_gates', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('repository_id', 26).notNullable();
    t.string('item_id', 300).notNullable();
    t.string('account', 200).nullable(); // the source account the recorded token belongs to
    t.string('credential_ref', 300).nullable();
    t.string('accepted_by', 26).notNullable();
    t.bigInteger('accepted_at').notNullable();
    t.unique(['repository_id', 'item_id']);
  });

  await knex.schema.createTable('import_quotas', (t) => {
    t.string('tenant_id', 26).primary();
    t.bigInteger('max_bytes').nullable(); // null: the default (IMPORT_DATASET_QUOTA_GB)
    t.string('updated_by', 26).nullable();
    t.bigInteger('updated_at').notNullable();
  });

  await knex.schema.createTable('import_settings', (t) => {
    t.string('tenant_id', 26).primary();
    t.text('allowed_licences').notNullable(); // JSON array of licence ids
    t.string('updated_by', 26).nullable();
    t.bigInteger('updated_at').notNullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const t of ['import_settings', 'import_quotas', 'import_gates', 'import_exceptions', 'import_jobs', 'import_catalog_facets', 'import_catalog', 'import_repositories']) await knex.schema.dropTableIfExists(t);
}
