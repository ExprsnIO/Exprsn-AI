import { createHash, randomUUID } from 'node:crypto';
import type { Services } from '../services.js';
import { DavError } from './xml.js';

/*
 * WebDAV locks (RFC 4918 6 and 9.10, class 2) on file-store paths, for Finder and Office. A lock is on a path (it
 * does not move with a resource), exclusive or shared, depth 0 or infinity, with a timeout of at most an hour
 * (refreshable). Tokens are `opaquelocktoken:<uuid>`; a request that changes a locked path must name the lock's
 * token in its If header, and only the lock's owner may use it. Expired locks are ignored and pruned.
 */

export interface LockRow {
  token: string;
  tenant_id: string;
  user_id: string;
  root: string;
  depth: '0' | 'infinity';
  scope: 'exclusive' | 'shared';
  owner: string | null;
  timeout_s: number;
  expires_at: number;
  created_at: number;
}

export const MAX_LOCK_SECONDS = 3600;
const lockFrom = (r: Record<string, unknown>): LockRow => ({ ...(r as unknown as LockRow), timeout_s: Number(r.timeout_s), expires_at: Number(r.expires_at), created_at: Number(r.created_at) });
const rootHash = (tenantId: string, root: string) => createHash('sha256').update(`${tenantId}\n${root}`).digest('hex');

/** Does a lock on `root` apply to `path` (the path itself, or below it for a depth-infinity lock)? */
export const covers = (l: Pick<LockRow, 'root' | 'depth'>, path: string): boolean => l.root === path || (l.depth === 'infinity' && path.startsWith(`${l.root}/`));

/** Parses a Timeout header (`Second-600, Infinite`): seconds, capped. */
export function parseTimeout(h: string | undefined): number {
  if (!h) return MAX_LOCK_SECONDS;
  for (const part of h.split(',').map((x) => x.trim())) {
    if (/^infinite$/i.test(part)) return MAX_LOCK_SECONDS;
    const m = /^Second-(\d{1,10})$/i.exec(part);
    if (m) return Math.max(1, Math.min(MAX_LOCK_SECONDS, Number(m[1])));
  }
  return MAX_LOCK_SECONDS;
}

export class LockManager {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  /** Live locks of a tenant on `path`, above it (covering it) or, with `below`, under it. */
  async around(tenantId: string, path: string, o: { below?: boolean } = {}): Promise<LockRow[]> {
    const now = Date.now();
    const parts = path.split('/');
    const hashes = parts.map((_, i) => rootHash(tenantId, parts.slice(0, i + 1).join('/'))).filter((_, i) => i > 0);
    const exact = ((await this.db('dav_locks').where({ tenant_id: tenantId }).whereIn('root_hash', hashes).andWhere('expires_at', '>', now)) as Record<string, unknown>[]).map(lockFrom).filter((l) => covers(l, path));
    if (!o.below) return exact;
    // Locks below a path: few per tenant, filtered here rather than with a LIKE on the path.
    const all = ((await this.db('dav_locks').where({ tenant_id: tenantId }).andWhere('expires_at', '>', now).limit(10_000)) as Record<string, unknown>[]).map(lockFrom);
    return [...exact, ...all.filter((l) => l.root.startsWith(`${path}/`))];
  }

  async byToken(tenantId: string, token: string): Promise<LockRow | null> {
    const r = await this.db('dav_locks').where({ tenant_id: tenantId, token }).andWhere('expires_at', '>', Date.now()).first();
    return r ? lockFrom(r) : null;
  }

  /**
   * Takes a new lock, or refuses with 423 when it conflicts: an exclusive lock conflicts with any lock covering the
   * path or (for depth infinity) under it; a shared lock with an exclusive one.
   */
  async lock(input: { tenantId: string; userId: string; root: string; depth: '0' | 'infinity'; scope: 'exclusive' | 'shared'; owner: string | null; timeoutS: number }): Promise<LockRow> {
    const existing = await this.around(input.tenantId, input.root, { below: input.depth === 'infinity' });
    const clash = existing.find((l) => input.scope === 'exclusive' || l.scope === 'exclusive');
    if (clash) throw new DavError(423, 'The resource is locked.', '{DAV:}no-conflicting-lock', { 'x-lock-root': clash.root });
    const t = Date.now();
    const row: LockRow = { token: `opaquelocktoken:${randomUUID()}`, tenant_id: input.tenantId, user_id: input.userId, root: input.root, depth: input.depth, scope: input.scope, owner: input.owner?.slice(0, 4000) ?? null, timeout_s: input.timeoutS, expires_at: t + input.timeoutS * 1000, created_at: t };
    await this.db('dav_locks').insert({ ...row, root_hash: rootHash(input.tenantId, input.root) });
    return row;
  }

  async refresh(l: LockRow, timeoutS: number): Promise<LockRow> {
    const expires = Date.now() + timeoutS * 1000;
    await this.db('dav_locks').where({ token: l.token }).update({ timeout_s: timeoutS, expires_at: expires });
    return { ...l, timeout_s: timeoutS, expires_at: expires };
  }

  async unlock(l: LockRow): Promise<void> {
    await this.db('dav_locks').where({ token: l.token }).delete();
  }

  /** Drops the locks on a path and below it (after DELETE or MOVE: locks stay with paths, not resources). */
  async dropAt(tenantId: string, path: string): Promise<number> {
    const rows = await this.around(tenantId, path, { below: true });
    const mine = rows.filter((l) => l.root === path || l.root.startsWith(`${path}/`));
    if (!mine.length) return 0;
    return this.db('dav_locks').whereIn('token', mine.map((l) => l.token)).delete();
  }

  async prune(): Promise<number> {
    return this.db('dav_locks').where('expires_at', '<=', Date.now()).delete();
  }

  /**
   * Refuses a change to `path` (and, with `below`, to what is under it) unless every lock on it was submitted in the
   * If header by its owner: 423 with DAV:lock-token-submitted naming the lock's root.
   */
  async assertUnlocked(tenantId: string, userId: string, path: string, submitted: Set<string>, o: { below?: boolean } = {}): Promise<void> {
    for (const l of await this.around(tenantId, path, o)) {
      if (submitted.has(l.token) && l.user_id === userId) continue;
      // A shared lock someone else holds still blocks; so does a token presented by another user.
      throw new DavError(423, 'The resource is locked; submit its lock token.', '{DAV:}lock-token-submitted', { 'x-lock-root': l.root });
    }
  }
}
