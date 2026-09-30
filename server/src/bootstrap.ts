import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import { LABELS } from './authz/labels.js';
import { isRole } from './authz/permissions.js';
import { PROVIDER_KINDS, parseProviderConfig } from './identity/providers/types.js';
import { normaliseGroup } from './repos/users.js';
import type { Services } from './services.js';

const fileSchema = z
  .object({
    tenants: z.array(
      z
        .object({
          slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
          name: z.string().min(1).max(200),
          directoryDn: z.string().optional(),
          workspaces: z.array(z.object({ name: z.string().min(1).max(200), labelCeiling: z.enum(LABELS) }).strict()).default([]),
          providers: z
            .array(
              z
                .object({
                  name: z.string().min(1).max(100),
                  kind: z.enum(PROVIDER_KINDS),
                  position: z.number().int().min(0).max(10000),
                  enabled: z.boolean().default(true),
                  config: z.record(z.string(), z.unknown()).default({})
                })
                .strict()
            )
            .default([]),
          groupMappings: z
            .array(
              z
                .object({
                  provider: z.string().optional(),
                  group: z.string().min(1).max(512),
                  role: z.string().refine(isRole, 'Unknown role'),
                  clearance: z.enum(LABELS)
                })
                .strict()
            )
            .default([])
        })
        .strict()
    )
  })
  .strict();

export type IdentityFile = z.infer<typeof fileSchema>;

export function parseIdentityFile(text: string): IdentityFile {
  const data = fileSchema.parse(YAML.parse(text));
  for (const t of data.tenants) for (const p of t.providers) parseProviderConfig(p.kind, p.config);
  return data;
}

/**
 * Brings the database to its baseline on start: the default tenant with a local user store, then anything declared
 * in IDENTITY_CONFIG. Declared stores are marked "managed by config" and updated from the file on every start;
 * stores created through the admin API are left alone. Mappings from the file are added when missing.
 */
export async function bootstrap(s: Services): Promise<void> {
  const tenant = await s.tenants.ensure(s.cfg.DEFAULT_TENANT, s.cfg.DEFAULT_TENANT === 'default' ? 'Default' : s.cfg.DEFAULT_TENANT);
  if (!(await s.providers.list(tenant.id)).some((p) => p.kind === 'local')) {
    await s.providers.create(tenant.id, { name: 'Local accounts', kind: 'local', position: 1000, enabled: true, config: {} });
  }

  if (!s.cfg.IDENTITY_CONFIG) return;
  const file = parseIdentityFile(readFileSync(s.cfg.IDENTITY_CONFIG, 'utf8'));
  for (const t of file.tenants) {
    let row = await s.tenants.bySlug(t.slug);
    if (!row) row = await s.tenants.create({ slug: t.slug, name: t.name, directoryDn: t.directoryDn ?? null });
    else if (row.name !== t.name || (t.directoryDn ?? null) !== row.directory_dn) row = await s.tenants.update(row.id, { name: t.name, directoryDn: t.directoryDn ?? null });
    // Archived workspaces count as existing: recreating one would hit the unique name on every start, and
    // un-archiving is an admin's decision, not the config file's.
    const existingWs = new Set((await s.tenants.workspaces(row.id, { includeArchived: true })).map((w) => w.name));
    for (const w of t.workspaces) if (!existingWs.has(w.name)) await s.tenants.createWorkspace(row.id, w.name, w.labelCeiling);

    for (const p of t.providers) {
      const existing = await s.providers.byName(row.id, p.name);
      if (!existing) {
        await s.providers.create(row.id, { ...p, managedBy: 'config' });
      } else if (existing.managed_by === 'config') {
        await s.providers.update(row.id, existing.id, { position: p.position, enabled: p.enabled, config: p.config });
      } else {
        s.log.warn({ tenant: t.slug, provider: p.name }, 'identity config: a store with this name was created through the API; left unchanged');
      }
    }

    const providers = await s.providers.list(row.id);
    const mappings = await s.users.mappings(row.id);
    for (const m of t.groupMappings) {
      const providerId = m.provider ? providers.find((p) => p.name === m.provider)?.id : null;
      if (providerId === undefined) throw new Error(`identity config: tenant ${t.slug} maps a group for unknown store ${m.provider}`);
      const dup = mappings.some((x) => x.group_name === normaliseGroup(m.group) && x.role === m.role && x.provider_id === providerId);
      if (!dup) await s.users.addMapping(row.id, { providerId, group: m.group, role: m.role, clearance: m.clearance });
    }
  }
  s.log.info({ file: s.cfg.IDENTITY_CONFIG, tenants: file.tenants.length }, 'identity configuration applied');
}
