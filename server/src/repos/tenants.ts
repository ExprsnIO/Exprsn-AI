import { ulid } from 'ulid';
import type { Db } from '../db/knex.js';
import type { Label } from '../authz/labels.js';

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  directory_dn: string | null;
  state: 'active' | 'offboarding' | 'disabled';
  created_at: number;
  updated_at: number;
}

export interface Workspace {
  id: string;
  tenant_id: string;
  name: string;
  label_ceiling: Label;
  created_at: number;
}

export class TenantRepo {
  constructor(private readonly db: Db) {}

  bySlug(slug: string): Promise<Tenant | undefined> {
    return this.db('tenants').where({ slug }).first();
  }

  byId(id: string): Promise<Tenant | undefined> {
    return this.db('tenants').where({ id }).first();
  }

  list(): Promise<Tenant[]> {
    return this.db('tenants').orderBy('slug');
  }

  async create(input: { slug: string; name: string; directoryDn?: string | null }): Promise<Tenant> {
    const t = Date.now();
    const row: Tenant = { id: ulid(), slug: input.slug, name: input.name, directory_dn: input.directoryDn ?? null, state: 'active', created_at: t, updated_at: t };
    await this.db('tenants').insert(row);
    return row;
  }

  async update(id: string, patch: { name?: string; directoryDn?: string | null }): Promise<Tenant> {
    const upd: Record<string, unknown> = { updated_at: Date.now() };
    if (patch.name !== undefined) upd.name = patch.name;
    if (patch.directoryDn !== undefined) upd.directory_dn = patch.directoryDn;
    await this.db('tenants').where({ id }).update(upd);
    return (await this.byId(id)) as Tenant;
  }

  async ensure(slug: string, name: string): Promise<Tenant> {
    return (await this.bySlug(slug)) ?? this.create({ slug, name });
  }

  workspaces(tenantId: string): Promise<Workspace[]> {
    return this.db('workspaces').where({ tenant_id: tenantId }).orderBy('name');
  }

  async createWorkspace(tenantId: string, name: string, labelCeiling: Label): Promise<Workspace> {
    const row: Workspace = { id: ulid(), tenant_id: tenantId, name, label_ceiling: labelCeiling, created_at: Date.now() };
    await this.db('workspaces').insert(row);
    return row;
  }
}
