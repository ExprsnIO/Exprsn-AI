import type { Knex } from 'knex';

/*
 * 1.6.0, Sprint 36b.
 *
 * B-4601 blob deduplication (within one tenant only):
 * - `file_blobs`: one stored, sealed object of the file store that several versions of the tenant's files may share.
 *   Its id is the id of the version that first stored it (the content's associated data names that version), its key
 *   is that version's sealed content key, and `refs` counts the versions that read it. Unique per tenant and SHA-256
 *   of the plaintext: identical content in two tenants is never shared (each tenant's key seals its own copy).
 * - `file_versions.blob_id`: the shared object a ready version reads (null: its own object, as before 1.6.0).
 * Ready versions stored before this migration are registered as blobs of their own (one per tenant and content; a
 * second copy of the same content stays unshared), so a later upload of the same content shares them.
 *
 * B-4701 held form values:
 * - `app_form_holds`: a public form submission the `user-input` guardrail held for review: its values sealed with the
 *   tenant key, the hold flag, and the decision (accepted into a record, or rejected).
 *
 * B-4803 reveal anomalies:
 * - `vault_reveals`: who revealed which KV secret, from which address, when (kept VAULT_ANOMALY_HISTORY_DAYS).
 * - `vault_reveal_flags`: a flag for the secret's owner when reveals look unusual (a new address, an odd hour, a
 *   burst), open until the owner or a vault administrator resolves it.
 * Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('file_blobs', (t) => {
    t.string('id', 26).primary(); // the version that first stored the object (the stream's associated data)
    t.string('tenant_id', 26).notNullable();
    t.string('sha256', 64).notNullable();
    t.bigInteger('size').notNullable();
    t.string('blob_key', 512).notNullable();
    t.text('sealed_key').notNullable(); // that version's content key, sealed with the tenant key (file-key:<id>)
    t.integer('refs').notNullable().defaultTo(1);
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'sha256'], { indexName: 'file_blobs_tenant_sha_uq' });
  });

  await knex.schema.alterTable('file_versions', (t) => {
    t.string('blob_id', 26).nullable();
    t.index(['blob_id'], 'file_versions_blob_idx');
  });

  await backfillBlobs(knex);

  await knex.schema.createTable('app_form_holds', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).nullable();
    t.string('app_id', 26).notNullable();
    t.string('entity_id', 26).notNullable();
    t.string('form_id', 26).notNullable();
    t.string('label', 20).notNullable();
    t.text('values_sealed', 'mediumtext').nullable(); // JSON of the screened values; null once purged
    t.text('held_fields').notNullable(); // JSON: the fields the guardrail held, with the rule names
    t.integer('dropped').notNullable().defaultTo(0);
    t.string('state', 20).notNullable(); // held | accepted | rejected
    t.string('flag_id', 26).nullable();
    t.string('record_id', 26).nullable();
    t.string('ip_hash', 64).nullable(); // keyed hash of the submitter's address (never the address)
    t.string('decided_by', 26).nullable();
    t.bigInteger('decided_at').nullable();
    t.string('reason', 500).nullable();
    t.bigInteger('created_at').notNullable();
    t.index(['tenant_id', 'state', 'created_at'], 'app_form_holds_state_idx');
    t.index(['form_id', 'state'], 'app_form_holds_form_idx');
  });

  await knex.schema.createTable('vault_reveals', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('secret_id', 26).notNullable();
    t.integer('version').notNullable();
    t.string('principal', 80).notNullable(); // user:<id> | key:<id> | service:<name>
    t.string('ip', 64).nullable();
    t.string('via', 60).nullable();
    t.integer('hour').notNullable(); // UTC hour of day, 0 to 23
    t.bigInteger('at').notNullable();
    t.index(['secret_id', 'at'], 'vault_reveals_secret_idx');
    t.index(['tenant_id', 'principal', 'at'], 'vault_reveals_principal_idx');
    t.index(['at'], 'vault_reveals_at_idx');
  });

  await knex.schema.createTable('vault_reveal_flags', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('secret_id', 26).notNullable();
    t.string('path', 400).notNullable();
    t.string('label', 20).notNullable();
    t.string('owner_id', 26).nullable();
    t.string('principal', 80).notNullable();
    t.string('principal_name', 200).nullable();
    t.string('ip', 64).nullable();
    t.text('signals').notNullable(); // JSON: [{kind: new-address | odd-hour | burst, detail, at}]
    t.integer('reveals').notNullable().defaultTo(1); // reveals counted against the flag while it is open
    t.string('state', 20).notNullable(); // open | expected | suspicious
    t.string('resolved_by', 26).nullable();
    t.bigInteger('resolved_at').nullable();
    t.string('note', 500).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id', 'state', 'created_at'], 'vault_reveal_flags_state_idx');
    t.index(['secret_id', 'principal', 'state'], 'vault_reveal_flags_secret_idx');
  });
}

/** Registers what is stored already: the first ready version of each content in a tenant becomes its blob. */
export async function backfillBlobs(knex: Knex): Promise<number> {
  const seen = new Set<string>();
  let after = '';
  let n = 0;
  for (;;) {
    const rows = (await knex('file_versions').where({ state: 'ready' }).whereNull('blob_id').whereNotNull('blob_key').whereNotNull('sealed_key').andWhere('id', '>', after).orderBy('id').limit(500).select('id', 'tenant_id', 'sha256', 'size', 'blob_key', 'sealed_key', 'created_at')) as { id: string; tenant_id: string; sha256: string; size: number | string; blob_key: string; sealed_key: string; created_at: number | string }[];
    if (!rows.length) return n;
    for (const r of rows) {
      const k = `${r.tenant_id}:${r.sha256}`;
      if (seen.has(k) || (await knex('file_blobs').where({ tenant_id: r.tenant_id, sha256: r.sha256 }).first('id'))) continue;
      seen.add(k);
      await knex('file_blobs').insert({ id: r.id, tenant_id: r.tenant_id, sha256: r.sha256, size: Number(r.size), blob_key: r.blob_key, sealed_key: r.sealed_key, refs: 1, created_at: Number(r.created_at), updated_at: Date.now() });
      await knex('file_versions').where({ id: r.id }).update({ blob_id: r.id });
      n++;
    }
    after = rows[rows.length - 1]!.id;
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const t of ['vault_reveal_flags', 'vault_reveals', 'app_form_holds']) await knex.schema.dropTableIfExists(t);
  await knex.schema.alterTable('file_versions', (t) => {
    t.dropIndex(['blob_id'], 'file_versions_blob_idx');
    t.dropColumn('blob_id');
  });
  await knex.schema.dropTableIfExists('file_blobs');
}
