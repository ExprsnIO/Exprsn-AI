import { json } from '../db/knex.js';
import { randomToken, sha256 } from '../crypto/index.js';
import { actorFrom } from '../audit/chain.js';
import type { Principal } from '../authz/policy.js';
import { badRequest } from '../http/problem.js';
import type { Services } from '../services.js';
import { BreachedPasswords } from './breached.js';
import { checkPasswordPolicy, hashPassword, verifyPassword } from './passwords.js';
import { SignInNotices } from './signin-notices.js';
import type { SessionRow, SessionStage } from './sessions.js';

/** `enrol` (B-810): an `admin:create --enrol-link` link, which sets the password and then asks for the second factor. */
export type PasswordTokenKind = 'reset' | 'admin' | 'invite' | 'enrol';

export interface PasswordTokenRow {
  id: string;
  tenant_id: string;
  user_id: string;
  kind: PasswordTokenKind;
  created_by: string | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
}

export interface Preferences {
  a11y: 'system' | 'aa' | 'aaa';
}

const DEFAULT_PREFERENCES: Preferences = { a11y: 'system' };

/** Where a user's password lives: the local store (changeable here) or a directory (changed there). */
export type PasswordHome = { kind: 'local'; mustChange: boolean } | { kind: 'directory'; stores: { name: string; kind: string }[] };

/**
 * Account self-service: local passwords (change, admin reset, forced change, reset and invite links), the
 * breached-password check, step-up freshness, per-user preferences, and a small counter for reset throttling.
 * Reset and invite tokens are 256-bit random values; only their SHA-256 is stored, they work once and expire.
 */
export class AccountService {
  private checker: BreachedPasswords | null = null;
  private notices: SignInNotices | null = null;

  constructor(private readonly s: () => Services) {}

  /** Sprint 17 (B-801): new-device and new-network sign-in notices. */
  get signIns(): SignInNotices {
    return (this.notices ??= new SignInNotices(this.s));
  }

  get breached(): BreachedPasswords {
    const cfg = this.s().cfg;
    return (this.checker ??= new BreachedPasswords({ mode: cfg.BREACHED_PASSWORDS, hibpUrl: cfg.BREACHED_HIBP_URL, timeoutMs: cfg.BREACHED_TIMEOUT_MS, file: cfg.BREACHED_FILE }));
  }

  private get db() {
    return this.s().db;
  }

  // ---------- passwords ----------

  async localCredential(userId: string): Promise<{ password_hash: string; must_change: boolean } | undefined> {
    const r = (await this.db('local_credentials').where({ user_id: userId }).first('password_hash', 'must_change')) as { password_hash: string; must_change: unknown } | undefined;
    return r ? { password_hash: r.password_hash, must_change: !!r.must_change } : undefined;
  }

  async passwordHome(tenantId: string, userId: string): Promise<PasswordHome> {
    const cred = await this.localCredential(userId);
    if (cred) return { kind: 'local', mustChange: cred.must_change };
    const [identities, providers] = await Promise.all([this.s().users.identitiesFor(userId), this.s().providers.list(tenantId)]);
    const byId = new Map(providers.map((p) => [p.id, p]));
    const stores = identities.map((i) => byId.get(i.provider_id)).filter((p) => !!p).map((p) => ({ name: p!.name, kind: p!.kind }));
    return { kind: 'directory', stores };
  }

  async mustChange(userId: string): Promise<boolean> {
    return (await this.localCredential(userId))?.must_change ?? false;
  }

  /**
   * Checks a new password against the policy and, when configured, the breached-password corpus. Throws a 400 with
   * the reason. A breach source that cannot be reached is audited and the password accepted (fail open).
   */
  async checkNewPassword(input: { tenantId: string; username: string; password: string; actor?: Principal | null; ip?: string | null; traceId?: string }): Promise<void> {
    const policy = checkPasswordPolicy(input.password, input.username);
    if (!policy.ok) throw badRequest(policy.reason!, { reason: 'policy' });
    const r = await this.breached.check(input.password);
    if (r.breached) throw badRequest('This password appears in a public list of breached passwords. Choose another.', { reason: 'breached' });
    if (r.unavailable?.length) {
      await this.s().audit.append({
        tenantId: input.tenantId,
        action: 'password.breach_check.unavailable',
        kind: 'auth',
        actor: input.actor ? actorFrom(input.actor, input.ip ?? null) : { username: input.username, ip: input.ip ?? null },
        target: { username: input.username },
        detail: { sources: r.unavailable, note: 'The breached-password check failed open: the password was accepted without it.' },
        ...(input.traceId ? { traceId: input.traceId } : {})
      });
    }
  }

  /** True when `password` is the user's current local password. */
  async isCurrent(userId: string, password: string): Promise<boolean> {
    const cred = await this.localCredential(userId);
    return !!cred && (await verifyPassword(cred.password_hash, password));
  }

  async setPassword(userId: string, password: string, mustChange: boolean): Promise<void> {
    const hash = await hashPassword(password);
    await this.db('local_credentials').where({ user_id: userId }).update({ password_hash: hash, must_change: mustChange, updated_at: Date.now() });
  }

  /** Replaces the password with a random one nobody knows (the old one stops working; a link sets the next). */
  async scramblePassword(userId: string): Promise<void> {
    await this.setPassword(userId, randomToken(32), false);
  }

  /** Ends every OAuth grant (refresh-token family) of the user; access tokens carrying those grants fail at once. */
  async revokeGrants(tenantId: string, userId: string): Promise<number> {
    return this.db('oidc_refresh_tokens').where({ tenant_id: tenantId, user_id: userId, revoked_at: null }).update({ revoked_at: Date.now() });
  }

  /** The stage a signed-in session moves to once its factor step is done. */
  async stageAfterFactor(userId: string): Promise<SessionStage> {
    return (await this.mustChange(userId)) ? 'password' : 'active';
  }

  // ---------- reset and invite tokens ----------

  /** Issues a single-use token and invalidates the user's earlier unused ones. Returns the token (never stored). */
  async issueToken(input: { tenantId: string; userId: string; kind: PasswordTokenKind; ttlMs: number; createdBy?: string | null }): Promise<{ token: string; expiresAt: number }> {
    const token = randomToken(32);
    const t = Date.now();
    await this.db('password_tokens').where({ user_id: input.userId, used_at: null }).update({ used_at: t });
    const row: PasswordTokenRow = { id: sha256(token), tenant_id: input.tenantId, user_id: input.userId, kind: input.kind, created_by: input.createdBy ?? null, created_at: t, expires_at: t + input.ttlMs, used_at: null };
    await this.db('password_tokens').insert(row);
    return { token, expiresAt: row.expires_at };
  }

  /** The live (unused, unexpired) token row, without claiming it. */
  async findToken(token: string): Promise<PasswordTokenRow | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const r = (await this.db('password_tokens').where({ id: sha256(token) }).first()) as Record<string, unknown> | undefined;
    if (!r || r.used_at != null || Number(r.expires_at) <= Date.now()) return null;
    return { ...(r as unknown as PasswordTokenRow), created_at: Number(r.created_at), expires_at: Number(r.expires_at), used_at: null };
  }

  /** Claims a token: returns its row when it is live, and marks it used (atomically, so it works once). */
  async consumeToken(token: string): Promise<PasswordTokenRow | null> {
    const row = await this.findToken(token);
    if (!row) return null;
    const n = await this.db('password_tokens').where({ id: row.id, used_at: null }).update({ used_at: Date.now() });
    return n ? { ...row, used_at: Date.now() } : null;
  }

  /** The console link for a token: the sign-in screen, with the token in the fragment (never sent to a server). */
  resetLink(token: string, tenantSlug: string): string {
    const base = this.s().cfg.PUBLIC_URL.replace(/\/$/, '');
    const tenant = tenantSlug === this.s().cfg.DEFAULT_TENANT ? '' : `&tenant=${encodeURIComponent(tenantSlug)}`;
    return `${base}/#/signin?reset=${token}${tenant}`;
  }

  // ---------- throttle ----------

  /** Counts one event against `key` in a fixed window; true while the count is within `limit`. */
  async hit(key: string, limit: number, windowMs: number): Promise<boolean> {
    const t = Date.now();
    key = key.slice(0, 255);
    for (let i = 0; i < 5; i++) {
      const r = (await this.db('account_throttle').where({ key }).first()) as { count: number; window_start: number } | undefined;
      if (!r) {
        try {
          await this.db('account_throttle').insert({ key, count: 1, window_start: t });
          return limit >= 1;
        } catch {
          continue;
        }
      }
      if (t - Number(r.window_start) >= windowMs) {
        const n = await this.db('account_throttle').where({ key, window_start: r.window_start }).update({ count: 1, window_start: t });
        if (!n) continue;
        return limit >= 1;
      }
      await this.db('account_throttle').where({ key }).increment('count', 1);
      const after = (await this.db('account_throttle').where({ key }).first()) as { count: number } | undefined;
      return Number(after?.count ?? limit + 1) <= limit;
    }
    return false;
  }

  async purge(): Promise<number> {
    const t = Date.now();
    let n = await this.db('account_throttle').where('window_start', '<', t - 24 * 3600_000).delete();
    n += await this.db('password_tokens').where('expires_at', '<', t - 7 * 24 * 3600_000).delete();
    n += await this.signIns.purge();
    n += await this.s().identityPolicy.purge(); // Sprint 26a: expired trusted devices
    n += await this.s().db('email_verifications').where('expires_at', '<', t - 7 * 24 * 3600_000).delete();
    n += await this.s().mfa.purgeEmailCodes(); // Sprint 28a (B-1806): used and expired email codes
    return n;
  }

  // ---------- step-up ----------

  /** When the session's owner last proved who they are. */
  static authTime(session: SessionRow): number {
    return session.auth_at ?? session.created_at;
  }

  isRecent(session: SessionRow): boolean {
    return Date.now() - AccountService.authTime(session) <= this.s().cfg.STEPUP_WINDOW_SECONDS * 1000;
  }

  // ---------- preferences ----------

  async preferences(userId: string): Promise<Preferences> {
    const r = (await this.db('users').where({ id: userId }).first('preferences')) as { preferences: string | null } | undefined;
    return { ...DEFAULT_PREFERENCES, ...json<Partial<Preferences>>(r?.preferences ?? null, {}) };
  }

  async setPreferences(tenantId: string, userId: string, patch: Partial<Preferences>): Promise<Preferences> {
    const next = { ...(await this.preferences(userId)), ...patch };
    await this.db('users').where({ tenant_id: tenantId, id: userId }).update({ preferences: JSON.stringify(next), updated_at: Date.now() });
    return next;
  }
}
