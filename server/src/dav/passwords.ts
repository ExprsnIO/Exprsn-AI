import { randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import type { Permission } from '../authz/permissions.js';
import { hmac, randomToken, safeEqual } from '../crypto/index.js';
import { json, type Db } from '../db/knex.js';

/*
 * App passwords for DAV clients (B-3101). Per device, `exai_d1_<prefix>_<secret>`, shown once; the row keeps the
 * prefix and an HMAC of the whole password. They authenticate `/dav` only: `/api` and the console never accept them
 * (the API's credential parser knows only session cookies, `exai_k1_` keys and OAuth tokens), and on `/dav` the
 * principal is narrowed to the permissions of the password's DAV scopes. Creating one needs a fresh second-factor
 * step-up (the owner decision of 2026-10-05), which is why the request it authenticates counts as MFA-verified for DAV.
 */

export const DAV_SCOPES = ['caldav', 'carddav', 'webdav'] as const;
export type DavScope = (typeof DAV_SCOPES)[number];

/** What each DAV scope lets a request do: the permissions it may use, always intersected with the owner's roles. */
export const SCOPE_PERMISSIONS: Record<DavScope, readonly Permission[]> = {
  caldav: ['calendars:read', 'calendars:write', 'groups:read', 'groups:write'],
  carddav: ['contacts:read', 'contacts:write'],
  webdav: ['files:read', 'files:write']
};

export const permissionsOfScopes = (scopes: readonly DavScope[]): Permission[] => [...new Set(scopes.flatMap((s) => SCOPE_PERMISSIONS[s]))].sort();

export interface AppPasswordRow {
  id: string;
  tenant_id: string;
  user_id: string;
  name: string;
  prefix: string;
  scopes: DavScope[];
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  last_used_ip: string | null;
  last_used_agent: string | null;
  revoked_at: number | null;
  revoked_by: string | null;
}

const PASSWORD_RE = /^exai_d1_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
const isScope = (v: unknown): v is DavScope => typeof v === 'string' && (DAV_SCOPES as readonly string[]).includes(v);

const toRow = (r: Record<string, unknown>): AppPasswordRow => ({
  id: String(r.id),
  tenant_id: String(r.tenant_id),
  user_id: String(r.user_id),
  name: String(r.name),
  prefix: String(r.prefix),
  scopes: json<unknown[]>(r.scopes, []).filter(isScope),
  created_at: Number(r.created_at),
  expires_at: r.expires_at == null ? null : Number(r.expires_at),
  last_used_at: r.last_used_at == null ? null : Number(r.last_used_at),
  last_used_ip: r.last_used_ip == null ? null : String(r.last_used_ip),
  last_used_agent: r.last_used_agent == null ? null : String(r.last_used_agent),
  revoked_at: r.revoked_at == null ? null : Number(r.revoked_at),
  revoked_by: r.revoked_by == null ? null : String(r.revoked_by)
});

export const appPasswordState = (r: AppPasswordRow, now = Date.now()): 'active' | 'expired' | 'revoked' => (r.revoked_at ? 'revoked' : r.expires_at != null && r.expires_at <= now ? 'expired' : 'active');

export const appPasswordView = (r: AppPasswordRow) => ({
  id: r.id,
  name: r.name,
  prefix: `exai_d1_${r.prefix}`,
  scopes: r.scopes,
  state: appPasswordState(r),
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  lastUsedAt: r.last_used_at,
  lastUsedIp: r.last_used_ip,
  lastUsedAgent: r.last_used_agent,
  revokedAt: r.revoked_at
});

/** A presented secret that looks like an app password (for the API's refusal message and the DAV parser). */
export const looksLikeAppPassword = (v: string): boolean => PASSWORD_RE.test(v);

export class AppPasswordService {
  constructor(
    private readonly db: Db,
    private readonly secret: string
  ) {}

  private digest(password: string): string {
    return hmac(this.secret, 'dav-app-password:' + password);
  }

  async create(input: { tenantId: string; userId: string; name: string; scopes: DavScope[]; ttlDays: number | null }): Promise<{ password: string; row: AppPasswordRow }> {
    const prefix = randomBytes(6).toString('hex');
    const password = `exai_d1_${prefix}_${randomToken(32)}`;
    const t = Date.now();
    const raw = {
      id: ulid(),
      tenant_id: input.tenantId,
      user_id: input.userId,
      name: input.name,
      prefix,
      secret_hash: this.digest(password),
      scopes: JSON.stringify([...new Set(input.scopes)].sort()),
      created_at: t,
      expires_at: input.ttlDays ? t + input.ttlDays * 86_400_000 : null,
      last_used_at: null,
      last_used_ip: null,
      last_used_agent: null,
      revoked_at: null,
      revoked_by: null
    };
    await this.db('dav_app_passwords').insert(raw);
    return { password, row: toRow(raw) };
  }

  /**
   * The active app password a presented secret matches, or null. `known` tells a wrong secret for an existing prefix
   * (counted against the owner's account) from one that matches nothing (counted against the address only).
   */
  async verify(password: string): Promise<{ row: AppPasswordRow | null; known: AppPasswordRow | null }> {
    const m = PASSWORD_RE.exec(password);
    if (!m) return { row: null, known: null };
    const r = await this.db('dav_app_passwords').where({ prefix: m[1] }).first();
    if (!r) return { row: null, known: null };
    const row = toRow(r);
    if (!safeEqual(String(r.secret_hash), this.digest(password))) return { row: null, known: row };
    if (appPasswordState(row) !== 'active') return { row: null, known: row };
    return { row, known: row };
  }

  /** Records the last use (at most once a minute per password, so a syncing client does not write on every request). */
  async touch(row: AppPasswordRow, ip: string | null, agent: string | null): Promise<void> {
    const t = Date.now();
    if (row.last_used_at && t - row.last_used_at < 60_000 && row.last_used_ip === ip) return;
    await this.db('dav_app_passwords')
      .where({ id: row.id })
      .update({ last_used_at: t, last_used_ip: ip?.slice(0, 64) ?? null, last_used_agent: agent?.replace(/[\r\n]/g, ' ').slice(0, 200) ?? null });
  }

  async get(userId: string, id: string): Promise<AppPasswordRow | null> {
    const r = await this.db('dav_app_passwords').where({ user_id: userId, id }).first();
    return r ? toRow(r) : null;
  }

  /** A user's app passwords; revoked and expired ones stay listed for 30 days. */
  async listForUser(userId: string): Promise<AppPasswordRow[]> {
    const cutoff = Date.now() - 30 * 86_400_000;
    const rows = await this.db('dav_app_passwords')
      .where({ user_id: userId })
      .andWhere((w) => w.whereNull('revoked_at').orWhere('revoked_at', '>', cutoff))
      .andWhere((w) => w.whereNull('expires_at').orWhere('expires_at', '>', cutoff))
      .orderBy('created_at', 'desc');
    return (rows as Record<string, unknown>[]).map(toRow);
  }

  async revoke(userId: string, id: string, by: string): Promise<boolean> {
    return (await this.db('dav_app_passwords').where({ user_id: userId, id, revoked_at: null }).update({ revoked_at: Date.now(), revoked_by: by })) > 0;
  }

  async revokeAllForUser(userId: string, by: string): Promise<number> {
    return this.db('dav_app_passwords').where({ user_id: userId, revoked_at: null }).update({ revoked_at: Date.now(), revoked_by: by });
  }
}
