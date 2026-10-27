import { ulid } from 'ulid';
import { json } from '../db/knex.js';
import { HttpProblem } from '../http/problem.js';
import type { ProviderRow } from '../repos/providers.js';
import type { Services } from '../services.js';

/*
 * 1.9.0, Sprint 54 (B-181, B-185): the lifecycle of a user store beyond create, change and remove.
 *
 * - Versions: every saved change of a store is a numbered version (name, order, enabled, configuration with its secret
 *   references, the reason given, who and when) in `identity_provider_versions`, shown with a diff against the one
 *   before. A store saved before migration 140 gets its first version when it is next changed.
 * - Archive: `state = archived` and `enabled = false` together, so the sign-in chain, directory sync and the redirect
 *   sign-in options leave it out. Its users keep their accounts (and any other way in, such as a local password); its
 *   configuration, group mappings and identity links stay, read-only. Optionally the sessions started through it are
 *   revoked at once, and the API keys of users who have no other store. Restore puts it back as it was (enabled or
 *   disabled), or disabled when asked, for review.
 *
 * Both need migration 140; until it is applied they answer 503 `migration_pending` and the rest of the store screens
 * work as before.
 */

const SCHEMA_RECHECK_MS = 30_000;

export const storeStateMissing = () => new HttpProblem(503, 'Not installed', 'Archiving stores and keeping their versions need the database migration 140_identity_store_state, which has not been applied.', { extensions: { reason: 'migration_pending' } });

export interface StoreVersion {
  version: number;
  name: string;
  kind: string;
  position: number;
  enabled: boolean;
  config: Record<string, unknown>;
  reason: string | null;
  createdBy: string | null;
  createdAt: number;
}

export interface ConfigChange {
  path: string;
  before: unknown;
  after: unknown;
}

/** Every leaf of a value as a dotted path (arrays compare whole). */
function flatten(value: unknown, prefix: string, out: Map<string, unknown>): Map<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) out.set(prefix, value);
  return out;
}

/** What changed between two versions of a store: its name, order, enabled flag and each configuration leaf. */
export function diffVersions(before: Pick<StoreVersion, 'name' | 'position' | 'enabled' | 'config'> | null, after: Pick<StoreVersion, 'name' | 'position' | 'enabled' | 'config'>): ConfigChange[] {
  const a = flatten({ name: before?.name, position: before?.position, enabled: before?.enabled, config: before?.config ?? {} }, '', new Map());
  const b = flatten({ name: after.name, position: after.position, enabled: after.enabled, config: after.config }, '', new Map());
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
  return keys.filter((k) => JSON.stringify(a.get(k)) !== JSON.stringify(b.get(k))).map((k) => ({ path: k, before: a.get(k) ?? null, after: b.get(k) ?? null }));
}

const versionFrom = (r: Record<string, unknown>): StoreVersion => ({
  version: Number(r.version),
  name: String(r.name),
  kind: String(r.kind),
  position: Number(r.position),
  enabled: !!r.enabled,
  config: json<Record<string, unknown>>(r.config, {}),
  reason: (r.reason as string | null) ?? null,
  createdBy: (r.created_by as string | null) ?? null,
  createdAt: Number(r.created_at)
});

export class StoreAdmin {
  private schema: { ok: boolean; at: number } | null = null;

  constructor(private readonly s: Services) {}

  /** Whether migration 140 is applied (cached; rechecked every 30 seconds while it is not). */
  async installed(): Promise<boolean> {
    const t = Date.now();
    if (this.schema && (this.schema.ok || t - this.schema.at < SCHEMA_RECHECK_MS)) return this.schema.ok;
    let ok: boolean;
    try {
      ok = (await this.s.db.schema.hasColumn('identity_providers', 'state')) && (await this.s.db.schema.hasTable('identity_provider_versions'));
    } catch {
      ok = false;
    }
    this.schema = { ok, at: t };
    return ok;
  }

  resetSchemaCache(): void {
    this.schema = null;
  }

  private async need(): Promise<void> {
    if (!(await this.installed())) throw storeStateMissing();
  }

  // ---------- versions ----------

  /** Records the store as it now is as its next version. A no-op (null) without migration 140. */
  async recordVersion(row: ProviderRow, reason: string | null, by: string | null): Promise<number | null> {
    if (!(await this.installed())) return null;
    const db = this.s.db;
    for (let attempt = 0; attempt < 3; attempt++) {
      const top = (await db('identity_provider_versions').where({ provider_id: row.id }).max({ v: 'version' }).first()) as { v: number | string | null } | undefined;
      const version = Number(top?.v ?? 0) + 1;
      try {
        await db('identity_provider_versions').insert({ id: ulid(), tenant_id: row.tenant_id, provider_id: row.id, version, name: row.name, kind: row.kind, position: row.position, enabled: row.enabled, config: JSON.stringify(row.config), reason: reason ? reason.slice(0, 500) : null, created_by: by, created_at: Date.now() });
        return version;
      } catch (err) {
        // Two saves at once: the unique (provider, version) refuses one; it takes the next number.
        if (attempt === 2) throw err;
      }
    }
    return null;
  }

  async versions(tenantId: string, providerId: string): Promise<StoreVersion[]> {
    if (!(await this.installed())) return [];
    const rows = (await this.s.db('identity_provider_versions').where({ tenant_id: tenantId, provider_id: providerId }).orderBy('version', 'asc')) as Record<string, unknown>[];
    return rows.map(versionFrom);
  }

  /** The versions newest first, each with what changed from the one before. */
  async history(tenantId: string, providerId: string): Promise<(StoreVersion & { changes: ConfigChange[] })[]> {
    const list = await this.versions(tenantId, providerId);
    return list.map((v, i) => ({ ...v, changes: diffVersions(i ? list[i - 1]! : null, v) })).reverse();
  }

  // ---------- archive and restore ----------

  async archive(row: ProviderRow, by: string, opts: { revokeSessions?: boolean; revokeApiKeys?: boolean } = {}): Promise<{ row: ProviderRow; sessionsRevoked: number; apiKeysRevoked: number; users: number }> {
    await this.need();
    if (row.state === 'archived') throw new HttpProblem(409, 'Conflict', 'This store is already archived.');
    const t = Date.now();
    const db = this.s.db;
    await db('identity_providers').where({ tenant_id: row.tenant_id, id: row.id }).update({ state: 'archived', state_before: row.enabled ? 'enabled' : 'disabled', archived_at: t, archived_by: by, enabled: false, updated_at: t });
    const linked = ((await db('user_identities as i').join('users as u', 'u.id', 'i.user_id').where({ 'i.provider_id': row.id, 'u.tenant_id': row.tenant_id }).select('u.id as user_id')) as { user_id: string }[]).map((r) => r.user_id);
    let sessionsRevoked = 0;
    let apiKeysRevoked = 0;
    if (opts.revokeSessions) {
      // Through SessionService, so leased sessions end too and their sockets close.
      for (const userId of linked) {
        for (const x of await this.s.sessions.listForUser(userId)) if (x.provider_id === row.id && (await this.s.sessions.revoke(row.tenant_id, x.id))) sessionsRevoked++;
      }
    }
    if (opts.revokeApiKeys) {
      for (const userId of linked) {
        // Only people for whom this store was the one way in: someone who also has a local password or another store
        // keeps their keys.
        const others = (await db('user_identities').where({ user_id: userId }).whereNot({ provider_id: row.id }).count({ n: '*' }).first()) as { n: number | string } | undefined;
        if (Number(others?.n ?? 0) === 0) apiKeysRevoked += await this.s.apiKeys.revokeAllForUser(userId);
      }
    }
    const fresh = (await this.s.providers.get(row.tenant_id, row.id))!;
    return { row: fresh, sessionsRevoked, apiKeysRevoked, users: linked.length };
  }

  /** Back to the state before archiving (`previous`), or `disabled` for review. */
  async restore(row: ProviderRow, to: 'previous' | 'disabled' = 'previous'): Promise<ProviderRow> {
    await this.need();
    if (row.state !== 'archived') throw new HttpProblem(409, 'Conflict', 'This store is not archived.');
    const enabled = to === 'previous' ? row.state_before !== 'disabled' : false;
    await this.s.db('identity_providers').where({ tenant_id: row.tenant_id, id: row.id }).update({ state: null, state_before: null, archived_at: null, archived_by: null, enabled, updated_at: Date.now() });
    return (await this.s.providers.get(row.tenant_id, row.id))!;
  }

  /** The counts the Archived view shows: users linked, mappings kept. */
  async keptCounts(row: ProviderRow): Promise<{ users: number; mappings: number }> {
    const db = this.s.db;
    const users = (await db('user_identities').where({ provider_id: row.id }).count({ n: '*' }).first()) as { n: number | string } | undefined;
    const mappings = (await db('group_mappings').where({ tenant_id: row.tenant_id, provider_id: row.id }).count({ n: '*' }).first()) as { n: number | string } | undefined;
    return { users: Number(users?.n ?? 0), mappings: Number(mappings?.n ?? 0) };
  }
}

const admins = new WeakMap<Services, StoreAdmin>();

/** The one `StoreAdmin` of a `Services` (its schema answer is cached there). */
export function storeAdminFor(s: Services): StoreAdmin {
  let a = admins.get(s);
  if (!a) admins.set(s, (a = new StoreAdmin(s)));
  return a;
}
