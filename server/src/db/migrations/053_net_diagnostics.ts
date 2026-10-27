import type { Knex } from 'knex';
import { BUILTIN_TOOLS } from '../../registry/builtin/catalog.js';

/*
 * The network diagnostic tools (053_net_diagnostics). Expand only: the built-in tools `dns.lookup`, `whois.lookup`
 * and `net.scan` as platform entries in `registry_entries`, seeded from the catalogue
 * (`registry/builtin/net-diagnostics.ts`), published to every tenant like the other built-ins.
 */
const NAMES = ['dns.lookup', 'whois.lookup', 'net.scan'];

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
