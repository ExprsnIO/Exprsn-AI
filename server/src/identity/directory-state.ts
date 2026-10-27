import type { Db } from '../db/knex.js';

/*
 * 1.9.9-qa (QA-1): per-store directory state (migration `143_directory_sync_state`): the Graph delta links directory
 * sync follows next time, and how the last run went. Every reader tolerates the table's absence: without it directory
 * sync pulls in full every time, as before.
 */

export interface DeltaLinks {
  users: string;
  groups: string;
}

export interface DirectorySyncStateRow {
  provider_id: string;
  tenant_id: string;
  users_delta_link: string | null;
  groups_delta_link: string | null;
  mode: string | null;
  synced_at: number | null;
  updated_at: number;
}

/** Whether a table exists; a yes is remembered, a no is asked again (the migration may be applied while running). */
export class TableCheck {
  private known = new Set<string>();
  constructor(private readonly db: Db) {}

  async has(table: string): Promise<boolean> {
    if (this.known.has(table)) return true;
    const yes = await this.db.schema.hasTable(table).catch(() => false);
    if (yes) this.known.add(table);
    return yes;
  }
}

export class DirectoryState {
  private readonly tables: TableCheck;
  constructor(private readonly db: Db) {
    this.tables = new TableCheck(db);
  }

  available(): Promise<boolean> {
    return this.tables.has('directory_sync_state');
  }

  async get(providerId: string): Promise<DirectorySyncStateRow | null> {
    if (!(await this.available())) return null;
    return ((await this.db('directory_sync_state').where({ provider_id: providerId }).first()) as DirectorySyncStateRow | undefined) ?? null;
  }

  async links(providerId: string): Promise<DeltaLinks | null> {
    const r = await this.get(providerId);
    return r?.users_delta_link && r.groups_delta_link ? { users: r.users_delta_link, groups: r.groups_delta_link } : null;
  }

  /** Saves the links the next run follows (null: the next run is a full pull) and how this run went. */
  async save(tenantId: string, providerId: string, links: DeltaLinks | null, mode: 'full' | 'delta'): Promise<void> {
    if (!(await this.available())) return;
    const now = Date.now();
    const row = { users_delta_link: links?.users ?? null, groups_delta_link: links?.groups ?? null, mode, synced_at: now, updated_at: now };
    const n = await this.db('directory_sync_state').where({ provider_id: providerId }).update(row);
    if (n) return;
    try {
      await this.db('directory_sync_state').insert({ provider_id: providerId, tenant_id: tenantId, ...row });
    } catch {
      // Another run inserted it first: this run's answer wins.
      await this.db('directory_sync_state').where({ provider_id: providerId }).update(row);
    }
  }
}
