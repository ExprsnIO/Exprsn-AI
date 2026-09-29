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
  slug: string | null;
  description: string | null;
  label_ceiling: Label;
  visibility: 'tenant' | 'members';
  state: 'active' | 'archived';
  created_at: number;
  updated_at: number | null;
}

const wsFromRow = (r: Record<string, unknown>): Workspace => ({
  ...(r as unknown as Workspace),
  visibility: (r.visibility as Workspace['visibility']) ?? 'members',
  state: (r.state as Workspace['state']) ?? 'active',
  created_at: Number(r.created_at),
  updated_at: r.updated_at == null ? null : Number(r.updated_at)
});

export const slugify = (name: string): string =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63) || 'workspace';

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

  async update(id: string, patch: { name?: string; directoryDn?: string | null; state?: Tenant['state'] }): Promise<Tenant> {
    const upd: Record<string, unknown> = { updated_at: Date.now() };
    if (patch.name !== undefined) upd.name = patch.name;
    if (patch.directoryDn !== undefined) upd.directory_dn = patch.directoryDn;
    if (patch.state !== undefined) upd.state = patch.state;
    await this.db('tenants').where({ id }).update(upd);
    return (await this.byId(id)) as Tenant;
  }

  async ensure(slug: string, name: string): Promise<Tenant> {
    return (await this.bySlug(slug)) ?? this.create({ slug, name });
  }

  // ---------- workspaces ----------

  async workspaces(tenantId: string, opts: { includeArchived?: boolean } = {}): Promise<Workspace[]> {
    const q = this.db('workspaces').where({ tenant_id: tenantId });
    if (!opts.includeArchived) q.andWhere({ state: 'active' });
    return (await q.orderBy('name')).map(wsFromRow);
  }

  async workspace(tenantId: string, id: string): Promise<Workspace | undefined> {
    const r = await this.db('workspaces').where({ tenant_id: tenantId, id }).first();
    return r ? wsFromRow(r) : undefined;
  }

  async createWorkspace(tenantId: string, name: string, labelCeiling: Label, opts: { description?: string | null; visibility?: Workspace['visibility'] } = {}): Promise<Workspace> {
    const t = Date.now();
    const row: Workspace = { id: ulid(), tenant_id: tenantId, name, slug: slugify(name), description: opts.description ?? null, label_ceiling: labelCeiling, visibility: opts.visibility ?? 'members', state: 'active', created_at: t, updated_at: t };
    await this.db('workspaces').insert(row);
    return row;
  }

  async updateWorkspace(tenantId: string, id: string, patch: { name?: string; description?: string | null; labelCeiling?: Label; visibility?: Workspace['visibility']; state?: Workspace['state'] }): Promise<Workspace | undefined> {
    const upd: Record<string, unknown> = { updated_at: Date.now() };
    if (patch.name !== undefined) {
      upd.name = patch.name;
      upd.slug = slugify(patch.name);
    }
    if (patch.description !== undefined) upd.description = patch.description;
    if (patch.labelCeiling !== undefined) upd.label_ceiling = patch.labelCeiling;
    if (patch.visibility !== undefined) upd.visibility = patch.visibility;
    if (patch.state !== undefined) upd.state = patch.state;
    await this.db('workspaces').where({ tenant_id: tenantId, id }).update(upd);
    return this.workspace(tenantId, id);
  }

  /** Workspaces a user may use: every tenant-wide workspace plus those they are a member of. */
  async workspacesForUser(tenantId: string, userId: string): Promise<Workspace[]> {
    const member = this.db('workspace_members').where({ user_id: userId }).select('workspace_id');
    const rows = await this.db('workspaces')
      .where({ tenant_id: tenantId, state: 'active' })
      .andWhere((w) => w.where({ visibility: 'tenant' }).orWhereIn('id', member))
      .orderBy('name');
    return rows.map(wsFromRow);
  }

  async members(workspaceId: string): Promise<{ user_id: string; username: string; display_name: string; clearance: Label; state: string; last_login_at: number | null; sources: string[] }[]> {
    const rows = (await this.db('workspace_members as m')
      .join('users as u', 'u.id', 'm.user_id')
      .where({ 'm.workspace_id': workspaceId })
      .select('u.id as user_id', 'u.username', 'u.display_name', 'u.clearance', 'u.state', 'u.last_login_at', 'm.source')
      .orderBy('u.username')) as { user_id: string; username: string; display_name: string; clearance: Label; state: string; last_login_at: number | null; source: string }[];
    const by = new Map<string, { user_id: string; username: string; display_name: string; clearance: Label; state: string; last_login_at: number | null; sources: string[] }>();
    for (const r of rows) {
      const e = by.get(r.user_id);
      if (e) e.sources.push(r.source);
      else by.set(r.user_id, { user_id: r.user_id, username: r.username, display_name: r.display_name, clearance: r.clearance, state: r.state, last_login_at: r.last_login_at == null ? null : Number(r.last_login_at), sources: [r.source] });
    }
    return [...by.values()];
  }

  async memberCounts(tenantId: string): Promise<Map<string, number>> {
    const rows = await this.db('workspace_members as m').join('workspaces as w', 'w.id', 'm.workspace_id').where({ 'w.tenant_id': tenantId }).groupBy('m.workspace_id').select('m.workspace_id').countDistinct({ n: 'm.user_id' });
    return new Map(rows.map((r: Record<string, unknown>) => [String(r.workspace_id), Number(r.n)]));
  }

  async addMember(workspaceId: string, userId: string): Promise<void> {
    const exists = await this.db('workspace_members').where({ workspace_id: workspaceId, user_id: userId, source: 'direct' }).first();
    if (!exists) await this.db('workspace_members').insert({ workspace_id: workspaceId, user_id: userId, source: 'direct', created_at: Date.now() });
  }

  async removeMember(workspaceId: string, userId: string): Promise<number> {
    return this.db('workspace_members').where({ workspace_id: workspaceId, user_id: userId, source: 'direct' }).delete();
  }
}
