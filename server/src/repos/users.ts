import { ulid } from 'ulid';
import { json, type Db } from '../db/knex.js';
import { highest, isLabel, type Label } from '../authz/labels.js';

export interface UserRow {
  id: string;
  tenant_id: string;
  username: string;
  display_name: string;
  email: string | null;
  state: 'active' | 'disabled';
  disabled_reason: string | null;
  clearance: Label;
  clearance_direct: Label | null;
  mfa_required: boolean;
  last_login_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface GroupMapping {
  id: string;
  tenant_id: string;
  provider_id: string | null;
  group_name: string;
  role: string;
  clearance: Label;
  workspace_id: string | null;
  created_at: number;
}

const userFromRow = (r: Record<string, unknown>): UserRow => ({
  ...(r as unknown as UserRow),
  mfa_required: !!r.mfa_required,
  last_login_at: r.last_login_at == null ? null : Number(r.last_login_at),
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at)
});

export const normaliseGroup = (g: string): string => g.trim().toLowerCase().replace(/\s*,\s*/g, ',');

/** Users, their roles and identity links. Every method takes the tenant id; nothing crosses tenants. */
export class UserRepo {
  constructor(private readonly db: Db) {}

  /** The same repository inside a transaction, so several writes commit or roll back together. */
  within(trx: Db): UserRepo {
    const r = new UserRepo(trx);
    r.onMembershipsLost = this.onMembershipsLost;
    return r;
  }

  async get(tenantId: string, id: string): Promise<UserRow | undefined> {
    const r = await this.db('users').where({ tenant_id: tenantId, id }).first();
    return r ? userFromRow(r) : undefined;
  }

  async byUsername(tenantId: string, username: string): Promise<UserRow | undefined> {
    const r = await this.db('users').where({ tenant_id: tenantId, username: username.toLowerCase() }).first();
    return r ? userFromRow(r) : undefined;
  }

  async list(tenantId: string, opts: { q?: string; limit?: number; offset?: number } = {}): Promise<UserRow[]> {
    const q = this.db('users').where({ tenant_id: tenantId });
    if (opts.q) {
      // '!' as the LIKE escape character behaves the same on PostgreSQL, MySQL and SQLite.
      const like = `%${opts.q.toLowerCase().replace(/[%_!]/g, '!$&')}%`;
      q.andWhere((w) => w.whereRaw("LOWER(username) LIKE ? ESCAPE '!'", [like]).orWhereRaw("LOWER(display_name) LIKE ? ESCAPE '!'", [like]));
    }
    const rows = await q.orderBy('username').limit(Math.min(opts.limit ?? 100, 500)).offset(opts.offset ?? 0);
    return rows.map(userFromRow);
  }

  async create(tenantId: string, input: { username: string; displayName: string; email?: string | null; clearance?: Label; mfaRequired?: boolean }): Promise<UserRow> {
    const t = Date.now();
    const row = {
      id: ulid(),
      tenant_id: tenantId,
      username: input.username.toLowerCase(),
      display_name: input.displayName,
      email: input.email ?? null,
      state: 'active',
      disabled_reason: null,
      clearance: input.clearance ?? 'internal',
      clearance_direct: null,
      mfa_required: input.mfaRequired ?? false,
      last_login_at: null,
      created_at: t,
      updated_at: t
    };
    await this.db('users').insert(row);
    return userFromRow(row);
  }

  async update(tenantId: string, id: string, patch: Partial<Pick<UserRow, 'display_name' | 'email' | 'state' | 'disabled_reason' | 'clearance' | 'clearance_direct' | 'mfa_required' | 'last_login_at'>>): Promise<void> {
    await this.db('users').where({ tenant_id: tenantId, id }).update({ ...patch, updated_at: Date.now() });
  }

  async roles(userId: string): Promise<{ role: string; source: 'mapping' | 'direct' }[]> {
    return this.db('user_roles').where({ user_id: userId }).select('role', 'source').orderBy('role');
  }

  async roleIds(userId: string): Promise<string[]> {
    return [...new Set((await this.roles(userId)).map((r) => r.role))];
  }

  /** Role ids for many users in one query (list screens). */
  async roleIdsFor(userIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>(userIds.map((id) => [id, []]));
    if (!userIds.length) return out;
    const rows = (await this.db('user_roles').whereIn('user_id', userIds).select('user_id', 'role')) as { user_id: string; role: string }[];
    for (const r of rows) {
      const list = out.get(r.user_id)!;
      if (!list.includes(r.role)) list.push(r.role);
    }
    return out;
  }

  async setRoles(userId: string, source: 'mapping' | 'direct', roles: string[]): Promise<void> {
    await this.db.transaction(async (trx) => {
      await trx('user_roles').where({ user_id: userId, source }).delete();
      const t = Date.now();
      const unique = [...new Set(roles)];
      if (unique.length) await trx('user_roles').insert(unique.map((role) => ({ user_id: userId, role, source, created_at: t })));
    });
  }

  async identity(providerId: string, externalId: string): Promise<{ id: string; user_id: string } | undefined> {
    return this.db('user_identities').where({ provider_id: providerId, external_id: externalId }).first('id', 'user_id');
  }

  async identitiesFor(userId: string): Promise<{ provider_id: string; external_id: string; last_seen_at: number }[]> {
    return this.db('user_identities').where({ user_id: userId }).select('provider_id', 'external_id', 'last_seen_at');
  }

  /**
   * 1.6.0 (B-7201): the user's links to SCIM stores, with the store's configuration and the SCIM groups recorded on
   * the link (a SCIM store governs the users it provisioned: their groups decide their mapped roles).
   */
  async scimLinks(userId: string): Promise<{ providerId: string; groups: string[]; config: Record<string, unknown> }[]> {
    const rows = (await this.db('user_identities as i').join('identity_providers as p', 'p.id', 'i.provider_id').where({ 'i.user_id': userId, 'p.kind': 'scim' }).select('i.provider_id', 'i.groups', 'p.config')) as { provider_id: string; groups: string; config: unknown }[];
    return rows.map((r) => ({ providerId: r.provider_id, groups: json<string[]>(r.groups, []), config: typeof r.config === 'string' ? json<Record<string, unknown>>(r.config, {}) : ((r.config as Record<string, unknown>) ?? {}) }));
  }

  /**
   * Links a user to their identity in a store. `manager` (1.5.0, B-3305) is the manager the store names, when the
   * caller read one from the store (null: the store names none); undefined leaves the stored value as it is.
   */
  async upsertIdentity(userId: string, providerId: string, externalId: string, groups: string[], manager?: string | null): Promise<void> {
    const t = Date.now();
    const existing = await this.identity(providerId, externalId);
    const m = manager === undefined ? {} : { manager_ref: manager ? manager.slice(0, 512) : null };
    if (existing) {
      await this.db('user_identities').where({ id: existing.id }).update({ groups: JSON.stringify(groups), last_seen_at: t, ...m });
    } else {
      await this.db('user_identities').insert({ id: ulid(), user_id: userId, provider_id: providerId, external_id: externalId, groups: JSON.stringify(groups), last_seen_at: t, ...m });
    }
  }

  /**
   * 1.5.0 (B-3305): the user's manager, when a store they are linked to names one and that manager is an active user
   * of the same tenant linked to the same store (matched on the external id, ignoring case). Null otherwise.
   */
  async managerOf(tenantId: string, userId: string): Promise<string | null> {
    const refs = (await this.db('user_identities').where({ user_id: userId }).whereNotNull('manager_ref').select('provider_id', 'manager_ref')) as { provider_id: string; manager_ref: string }[];
    for (const r of refs) {
      const m = (await this.db('user_identities as i')
        .join('users as u', 'u.id', 'i.user_id')
        .where({ 'i.provider_id': r.provider_id, 'u.tenant_id': tenantId, 'u.state': 'active' })
        .whereRaw('LOWER(i.external_id) = ?', [r.manager_ref.toLowerCase()])
        .first('u.id')) as { id: string } | undefined;
      if (m && m.id !== userId) return m.id;
    }
    return null;
  }

  // ---- group mappings ----

  async mappings(tenantId: string): Promise<GroupMapping[]> {
    const rows = await this.db('group_mappings').where({ tenant_id: tenantId }).orderBy(['group_name', 'role']);
    return rows.map((r: Record<string, unknown>) => ({ ...(r as unknown as GroupMapping), workspace_id: (r.workspace_id as string | null) ?? null, created_at: Number(r.created_at) }));
  }

  async addMapping(tenantId: string, input: { providerId: string | null; group: string; role: string; clearance: Label; workspaceId?: string | null }): Promise<GroupMapping> {
    const row: GroupMapping = { id: ulid(), tenant_id: tenantId, provider_id: input.providerId, group_name: normaliseGroup(input.group), role: input.role, clearance: input.clearance, workspace_id: input.workspaceId ?? null, created_at: Date.now() };
    await this.db('group_mappings').insert(row);
    return row;
  }

  async removeMapping(tenantId: string, id: string): Promise<boolean> {
    return (await this.db('group_mappings').where({ tenant_id: tenantId, id }).delete()) > 0;
  }

  async updateMapping(tenantId: string, id: string, patch: { role?: string; clearance?: Label; workspaceId?: string | null; group?: string }): Promise<void> {
    const upd: Record<string, unknown> = {};
    if (patch.role !== undefined) upd.role = patch.role;
    if (patch.clearance !== undefined) upd.clearance = patch.clearance;
    if (patch.workspaceId !== undefined) upd.workspace_id = patch.workspaceId;
    if (patch.group !== undefined) upd.group_name = normaliseGroup(patch.group);
    if (Object.keys(upd).length) await this.db('group_mappings').where({ tenant_id: tenantId, id }).update(upd);
  }

  // ---- workspace membership ----

  /** Told about workspaces a user is no longer a member of at all (Sprint 21, B-1305: live shared watches end). */
  onMembershipsLost: ((userId: string, workspaceIds: string[]) => void) | null = null;

  async setWorkspaceMemberships(userId: string, source: 'mapping' | 'direct', workspaceIds: string[]): Promise<void> {
    const before = this.onMembershipsLost ? await this.workspaceIds(userId) : [];
    await this.db.transaction(async (trx) => {
      await trx('workspace_members').where({ user_id: userId, source }).delete();
      const t = Date.now();
      const unique = [...new Set(workspaceIds)];
      if (unique.length) await trx('workspace_members').insert(unique.map((workspace_id) => ({ workspace_id, user_id: userId, source, created_at: t })));
    });
    if (this.onMembershipsLost && before.length) {
      const after = new Set(await this.workspaceIds(userId));
      const lost = before.filter((w) => !after.has(w));
      if (lost.length) this.onMembershipsLost(userId, lost);
    }
  }

  async workspaceIds(userId: string): Promise<string[]> {
    return [...new Set((await this.db('workspace_members').where({ user_id: userId }).select('workspace_id')).map((r: { workspace_id: string }) => r.workspace_id))];
  }
}

/**
 * Resolves groups to roles and clearance: the union of roles over every matching mapping, and the highest clearance.
 * A mapping with a provider id only matches groups from that provider.
 */
export function resolveMappings(mappings: GroupMapping[], providerId: string, groups: string[]): { roles: string[]; clearance: Label | null; workspaces: string[] } {
  const have = new Set(groups.map(normaliseGroup));
  const hits = mappings.filter((m) => (m.provider_id == null || m.provider_id === providerId) && have.has(m.group_name));
  if (!hits.length) return { roles: [], clearance: null, workspaces: [] };
  return {
    roles: [...new Set(hits.map((m) => m.role))].sort(),
    clearance: highest(...hits.map((m) => (isLabel(m.clearance) ? m.clearance : 'public'))),
    workspaces: [...new Set(hits.map((m) => m.workspace_id).filter((w): w is string => !!w))].sort()
  };
}
