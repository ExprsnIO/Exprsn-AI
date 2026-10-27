import { ulid } from 'ulid';
import { json, type Db } from '../db/knex.js';

/*
 * Default profile and visible profiles (2.0.0).
 *
 * A tenant, a workspace and a person may each name the profile a new conversation starts on. The person's own choice
 * wins over the workspace's, which wins over the tenant's, unless the tenant or the workspace enforces its default:
 * then that default wins over everything below it (an enforced tenant default over an enforced workspace default).
 * A named profile the person cannot use (unpublished, above their clearance, outside their key's profiles) is
 * skipped, and the next one down applies. A person also hides profiles from their own pickers; an enforced default
 * stays visible.
 */

export type PreferenceScope = 'tenant' | 'workspace' | 'user';
export type DefaultSource = PreferenceScope | null;

export interface PreferenceRow {
  scope: PreferenceScope;
  scopeId: string;
  defaultProfile: string | null;
  enforced: boolean;
  hidden: string[];
  updatedAt: number | null;
}

export interface ResolvedDefault {
  profile: string | null;
  source: DefaultSource;
  enforced: boolean;
}

interface Row {
  id: string;
  tenant_id: string;
  scope: PreferenceScope;
  scope_id: string;
  default_profile: string | null;
  enforced: boolean | number;
  hidden: string | null;
  updated_by: string | null;
  updated_at: number | string;
}

const empty = (scope: PreferenceScope, scopeId: string): PreferenceRow => ({ scope, scopeId, defaultProfile: null, enforced: false, hidden: [], updatedAt: null });

const fromRow = (r: Row): PreferenceRow => ({
  scope: r.scope,
  scopeId: r.scope_id,
  defaultProfile: r.default_profile,
  enforced: r.enforced === true || r.enforced === 1,
  hidden: json<string[]>(r.hidden, []),
  updatedAt: Number(r.updated_at)
});

export class ProfilePreferences {
  constructor(private readonly db: Db) {}

  async get(tenantId: string, scope: PreferenceScope, scopeId: string): Promise<PreferenceRow> {
    const r = (await this.db('profile_preferences').where({ tenant_id: tenantId, scope, scope_id: scopeId }).first()) as Row | undefined;
    return r ? fromRow(r) : empty(scope, scopeId);
  }

  /** Every workspace's row in the tenant (for the admin view). */
  async workspaces(tenantId: string): Promise<PreferenceRow[]> {
    return ((await this.db('profile_preferences').where({ tenant_id: tenantId, scope: 'workspace' })) as Row[]).map(fromRow);
  }

  /** Sets the given fields of a scope's row, creating it; returns the row before and after. */
  async set(tenantId: string, scope: PreferenceScope, scopeId: string, patch: Partial<Pick<PreferenceRow, 'defaultProfile' | 'enforced' | 'hidden'>>, by: string | null): Promise<{ before: PreferenceRow; after: PreferenceRow }> {
    const before = await this.get(tenantId, scope, scopeId);
    const after: PreferenceRow = { ...before, ...patch, updatedAt: Date.now() };
    if (scope === 'user') after.enforced = false;
    else after.hidden = [];
    const cols = { default_profile: after.defaultProfile, enforced: after.enforced, hidden: after.hidden.length ? JSON.stringify([...new Set(after.hidden)].sort()) : null, updated_by: by, updated_at: after.updatedAt! };
    if (before.updatedAt == null) await this.db('profile_preferences').insert({ id: ulid(), tenant_id: tenantId, scope, scope_id: scopeId, ...cols });
    else await this.db('profile_preferences').where({ tenant_id: tenantId, scope, scope_id: scopeId }).update(cols);
    return { before, after };
  }

  /** The three rows that apply to a person in a workspace. */
  async layers(tenantId: string, workspaceId: string | null | undefined, userId: string): Promise<{ tenant: PreferenceRow; workspace: PreferenceRow | null; user: PreferenceRow }> {
    const [tenant, workspace, user] = await Promise.all([this.get(tenantId, 'tenant', tenantId), workspaceId ? this.get(tenantId, 'workspace', workspaceId) : Promise.resolve(null), this.get(tenantId, 'user', userId)]);
    return { tenant, workspace, user };
  }
}

/** The default among `usable` profile names, by the precedence above. */
export function resolveDefault(l: { tenant: PreferenceRow; workspace: PreferenceRow | null; user: PreferenceRow }, usable: Set<string>): ResolvedDefault {
  const order: [PreferenceRow | null, PreferenceScope, boolean][] = [
    [l.tenant.enforced ? l.tenant : null, 'tenant', true],
    [l.workspace?.enforced ? l.workspace : null, 'workspace', true],
    [l.user, 'user', false],
    [l.workspace, 'workspace', false],
    [l.tenant, 'tenant', false]
  ];
  for (const [row, source, enforced] of order) {
    if (row?.defaultProfile && usable.has(row.defaultProfile)) return { profile: row.defaultProfile, source, enforced };
  }
  return { profile: null, source: null, enforced: false };
}
