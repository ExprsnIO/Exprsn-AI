import { ulid } from 'ulid';
import { json, type Db } from '../db/knex.js';
import { parseProviderConfig, type ProviderKind } from '../identity/providers/types.js';

export interface ProviderRow {
  id: string;
  tenant_id: string;
  name: string;
  kind: ProviderKind;
  position: number;
  enabled: boolean;
  config: Record<string, unknown>;
  managed_by: 'api' | 'config';
  created_at: number;
  updated_at: number;
}

const fromRow = (r: Record<string, unknown>): ProviderRow => ({
  id: String(r.id),
  tenant_id: String(r.tenant_id),
  name: String(r.name),
  kind: r.kind as ProviderKind,
  position: Number(r.position),
  enabled: !!r.enabled,
  config: json<Record<string, unknown>>(r.config, {}),
  managed_by: r.managed_by as 'api' | 'config',
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at)
});

/** Identity provider (user store) definitions, always scoped to one tenant. */
export class ProviderRepo {
  constructor(private readonly db: Db) {}

  async list(tenantId: string): Promise<ProviderRow[]> {
    const rows = await this.db('identity_providers').where({ tenant_id: tenantId }).orderBy([{ column: 'position' }, { column: 'name' }]);
    return rows.map(fromRow);
  }

  async get(tenantId: string, id: string): Promise<ProviderRow | undefined> {
    const r = await this.db('identity_providers').where({ tenant_id: tenantId, id }).first();
    return r ? fromRow(r) : undefined;
  }

  async byName(tenantId: string, name: string): Promise<ProviderRow | undefined> {
    const r = await this.db('identity_providers').where({ tenant_id: tenantId, name }).first();
    return r ? fromRow(r) : undefined;
  }

  async create(
    tenantId: string,
    input: { name: string; kind: ProviderKind; position: number; enabled: boolean; config: unknown; managedBy?: 'api' | 'config' }
  ): Promise<ProviderRow> {
    const config = parseProviderConfig(input.kind, input.config) as Record<string, unknown>;
    const t = Date.now();
    const row = { id: ulid(), tenant_id: tenantId, name: input.name, kind: input.kind, position: input.position, enabled: input.enabled, config: JSON.stringify(config), managed_by: input.managedBy ?? 'api', created_at: t, updated_at: t };
    await this.db('identity_providers').insert(row);
    return fromRow(row);
  }

  async update(tenantId: string, id: string, patch: { name?: string; position?: number; enabled?: boolean; config?: unknown }): Promise<ProviderRow | undefined> {
    const current = await this.get(tenantId, id);
    if (!current) return undefined;
    const upd: Record<string, unknown> = { updated_at: Date.now() };
    if (patch.name !== undefined) upd.name = patch.name;
    if (patch.position !== undefined) upd.position = patch.position;
    if (patch.enabled !== undefined) upd.enabled = patch.enabled;
    if (patch.config !== undefined) upd.config = JSON.stringify(parseProviderConfig(current.kind, patch.config));
    await this.db('identity_providers').where({ tenant_id: tenantId, id }).update(upd);
    return this.get(tenantId, id);
  }

  async remove(tenantId: string, id: string): Promise<boolean> {
    return (await this.db('identity_providers').where({ tenant_id: tenantId, id }).delete()) > 0;
  }
}
