import { randomBytes } from 'node:crypto';
import { hmac } from '../crypto/index.js';
import type { Db } from '../db/knex.js';
import type { DataKeys } from '../platform/datakeys.js';

/*
 * 1.9.0, Sprint 52 (B-170): the tenant search keys. Each version is 32 random bytes, sealed with the tenant key (so a
 * destroyed tenant key leaves every posting meaningless, as for knowledge's keyed terms), kept in `search_keys`. A
 * term is HMAC-SHA-256(key, "t" NUL word) and a prefix HMAC-SHA-256(key, "p" NUL prefix), both cut to 128 bits: the
 * two never collide by construction, and the same word under another version or tenant hashes to something else.
 *
 * Not `s.sysKeys`: those are platform keys shared by every tenant, so one tenant's postings would be comparable with
 * another's and a rotation would be platform-wide. A version is immutable once written, so the cache never goes stale;
 * a retired version's row is deleted after its postings.
 */

export const TERM_HEX = 32;

export class SearchKeys {
  private readonly cache = new Map<string, Promise<Buffer>>();

  constructor(
    private readonly db: () => Db,
    private readonly keys: () => DataKeys
  ) {}

  private aad = (tenantId: string, version: number) => `search-key:${tenantId}:${version}`;

  /** Makes a new key version for a tenant (in state `building`). */
  async create(tenantId: string, version: number): Promise<void> {
    const fresh = randomBytes(32);
    await this.db()('search_keys').insert({ tenant_id: tenantId, version, sealed: await this.keys().seal(tenantId, fresh.toString('base64'), this.aad(tenantId, version)), state: 'building', created_at: Date.now() });
    this.cache.set(`${tenantId}:${version}`, Promise.resolve(fresh));
  }

  async setState(tenantId: string, version: number, state: 'building' | 'active' | 'retiring'): Promise<void> {
    await this.db()('search_keys').where({ tenant_id: tenantId, version }).update({ state });
  }

  async remove(tenantId: string, version: number): Promise<void> {
    await this.db()('search_keys').where({ tenant_id: tenantId, version }).delete();
    this.cache.delete(`${tenantId}:${version}`);
  }

  async versions(tenantId: string): Promise<{ version: number; state: string; createdAt: number }[]> {
    return ((await this.db()('search_keys').where({ tenant_id: tenantId }).orderBy('version').select('version', 'state', 'created_at')) as { version: number; state: string; created_at: number | string }[]).map((r) => ({ version: Number(r.version), state: r.state, createdAt: Number(r.created_at) }));
  }

  async key(tenantId: string, version: number): Promise<Buffer> {
    const id = `${tenantId}:${version}`;
    let k = this.cache.get(id);
    if (!k) {
      k = (async () => {
        const row = (await this.db()('search_keys').where({ tenant_id: tenantId, version }).first('sealed')) as { sealed: string } | undefined;
        if (!row) throw new Error(`No search key version ${version}`);
        return Buffer.from(await this.keys().open(tenantId, row.sealed, this.aad(tenantId, version)), 'base64');
      })();
      k.catch(() => this.cache.delete(id));
      this.cache.set(id, k);
    }
    return k;
  }

  /** Forgets a tenant's cached keys (offboarding, a disabled index). */
  forget(tenantId: string): void {
    for (const k of [...this.cache.keys()]) if (k.startsWith(`${tenantId}:`)) this.cache.delete(k);
  }
}

export const termHash = (key: Buffer, term: string): string => hmac(key, `t\u0000${term}`).slice(0, TERM_HEX);
export const prefixHash = (key: Buffer, prefix: string): string => hmac(key, `p\u0000${prefix}`).slice(0, TERM_HEX);
