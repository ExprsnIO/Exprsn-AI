import type { Knex } from 'knex';
import { BUILTIN_TOOLS } from '../../registry/builtin/catalog.js';

/*
 * Requests to the outside and script tools on files (048_net_and_file_tools). Expand only: the built-in tools
 * `http_fetch`, `http_request`, `http_download`, `files.run_tool`, `files.apply_tool`, `files.save` and `files.extract`
 * as platform entries in `registry_entries`, seeded from the catalogue like the built-ins before them
 * (`registry/builtin/net-files.ts`).
 */
const NAMES = ['http_fetch', 'http_request', 'http_download', 'files.run_tool', 'files.apply_tool', 'files.save', 'files.extract'];

export async function up(knex: Knex): Promise<void> {
  const now = Date.now();
  for (const b of BUILTIN_TOOLS.filter((x) => NAMES.includes(x.name))) {
    if (await knex('registry_entries').where({ id: b.id }).first('id')) continue;
    const hash = `builtin-${b.builtin}-1`;
    await knex('registry_entries').insert({
      id: b.id,
      tenant_id: null,
      workspace_id: null,
      kind: 'tool',
      name: b.name,
      version: '1.0.0',
      description: b.description,
      impl: 'builtin',
      side_effect: b.sideEffect,
      confirm: 'never',
      rate_per_hour: null,
      label: b.label,
      input_schema: JSON.stringify(b.inputSchema),
      output_schema: JSON.stringify(b.outputSchema),
      definition: JSON.stringify({ builtin: b.builtin }),
      status: 'published',
      schema_hash: hash,
      approved_hash: hash,
      checks: JSON.stringify([{ name: 'Built into the platform', ok: true, detail: 'Ships with the server; acts through the domain service as the caller; reviewed with each release.' }]),
      checked_at: now,
      owner_id: null,
      owner_name: 'Platform',
      publish_scope: 'platform',
      created_at: now,
      updated_at: now
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex('registry_entries').where({ impl: 'builtin' }).whereIn('name', NAMES).delete();
}
