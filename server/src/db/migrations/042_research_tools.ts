import type { Knex } from 'knex';
import { BUILTIN_TOOLS } from '../../registry/builtin/catalog.js';

/*
 * The research built-in tools (042_research_tools). Expand only.
 *
 * - `registry_entries`: the built-in tools `knowledge_list`, `knowledge_read`, `knowledge_save`, `memory_search` and
 *   `memory_save` (added to the catalogue with this migration), platform entries like the other built-ins.
 * - `registry_entries`: `knowledge_search` takes no `kbIds` to search every published base the caller may read; its
 *   row gets the description and input schema that say so.
 */
const NAMES = ['knowledge_list', 'knowledge_read', 'knowledge_save', 'memory_search', 'memory_save'];

export async function up(knex: Knex): Promise<void> {
  const now = Date.now();
  for (const b of BUILTIN_TOOLS) {
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
  const search = BUILTIN_TOOLS.find((b) => b.name === 'knowledge_search')!;
  await knex('registry_entries').where({ id: search.id }).update({ description: search.description, input_schema: JSON.stringify(search.inputSchema), updated_at: now });
}

export async function down(knex: Knex): Promise<void> {
  await knex('registry_entries').where({ impl: 'builtin' }).whereIn('name', NAMES).delete();
}
