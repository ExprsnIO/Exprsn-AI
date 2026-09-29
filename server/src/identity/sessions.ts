import type { Db } from '../db/knex.js';
import { hmac, randomToken } from '../crypto/index.js';

export type SessionStage = 'mfa' | 'enroll' | 'active';

export interface SessionRow {
  id: string;
  user_id: string;
  tenant_id: string;
  stage: SessionStage;
  method: string;
  provider_id: string | null;
  ip: string | null;
  user_agent: string | null;
  challenge: string | null;
  challenge_expires_at: number | null;
  mfa_verified_at: number | null;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
  workspace_id?: string | null;
}

export interface SessionSettings {
  secret: string;
  idleMinutes: number;
  absoluteHours: number;
  pendingMinutes: number;
}

const toRow = (r: Record<string, unknown>): SessionRow => ({
  ...(r as unknown as SessionRow),
  challenge_expires_at: r.challenge_expires_at == null ? null : Number(r.challenge_expires_at),
  mfa_verified_at: r.mfa_verified_at == null ? null : Number(r.mfa_verified_at),
  created_at: Number(r.created_at),
  last_seen_at: Number(r.last_seen_at),
  expires_at: Number(r.expires_at),
  revoked_at: r.revoked_at == null ? null : Number(r.revoked_at)
});

/**
 * Server-side sessions. The browser holds only an opaque random token in an httpOnly cookie; the database
 * holds HMAC(secret, token), so a copy of the table cannot be replayed as cookies.
 * Sessions have an idle timeout, an absolute lifetime, and a short lifetime while a second factor is pending.
 * The token is rotated whenever the session's privilege changes (MFA completed), which defeats fixation.
 */
export class SessionService {
  private readonly touched = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly cfg: SessionSettings,
    private readonly onRevoke: (sessionIds: string[]) => void = () => undefined
  ) {}

  idFor(token: string): string {
    return hmac(this.cfg.secret, 'session:' + token);
  }

  csrfFor(sessionId: string): string {
    return hmac(this.cfg.secret, 'csrf:' + sessionId);
  }

  private expiry(stage: SessionStage, createdAt: number): number {
    return stage === 'active' ? createdAt + this.cfg.absoluteHours * 3600_000 : Date.now() + this.cfg.pendingMinutes * 60_000;
  }

  async create(input: { userId: string; tenantId: string; stage: SessionStage; method: string; providerId: string | null; ip: string | null; userAgent: string | null; mfaVerified?: boolean }): Promise<{ token: string; session: SessionRow }> {
    const token = randomToken(32);
    const t = Date.now();
    const row: SessionRow = {
      id: this.idFor(token),
      user_id: input.userId,
      tenant_id: input.tenantId,
      stage: input.stage,
      method: input.method,
      provider_id: input.providerId,
      ip: input.ip,
      user_agent: input.userAgent?.slice(0, 300) ?? null,
      challenge: null,
      challenge_expires_at: null,
      mfa_verified_at: input.mfaVerified ? t : null,
      created_at: t,
      last_seen_at: t,
      expires_at: this.expiry(input.stage, t),
      revoked_at: null
    };
    await this.db('sessions').insert(row);
    return { token, session: row };
  }

  /** Returns the live session for a cookie token, or null when unknown, revoked, expired or idle. */
  async resolve(token: string): Promise<SessionRow | null> {
    if (!token || token.length > 200) return null;
    const r = await this.db('sessions').where({ id: this.idFor(token) }).first();
    if (!r) return null;
    const s = toRow(r);
    const t = Date.now();
    if (s.revoked_at || s.expires_at <= t) return null;
    if (s.stage === 'active' && t - s.last_seen_at > this.cfg.idleMinutes * 60_000) return null;
    return s;
  }

  /** Records activity, at most once a minute per session. */
  async touch(s: SessionRow): Promise<void> {
    const t = Date.now();
    const last = this.touched.get(s.id) ?? s.last_seen_at;
    if (t - last < 60_000) return;
    this.touched.set(s.id, t);
    if (this.touched.size > 50_000) this.touched.clear();
    await this.db('sessions').where({ id: s.id }).update({ last_seen_at: t });
  }

  /** Moves a session to a new stage under a new token. The old token stops working immediately. */
  async rotate(s: SessionRow, patch: { stage: SessionStage; method?: string; mfaVerified?: boolean }): Promise<{ token: string; session: SessionRow }> {
    const token = randomToken(32);
    const id = this.idFor(token);
    const t = Date.now();
    const upd = {
      id,
      stage: patch.stage,
      method: patch.method ?? s.method,
      mfa_verified_at: patch.mfaVerified ? t : s.mfa_verified_at,
      challenge: null,
      challenge_expires_at: null,
      last_seen_at: t,
      expires_at: this.expiry(patch.stage, patch.stage === 'active' && s.stage !== 'active' ? t : s.created_at)
    };
    const n = await this.db('sessions').where({ id: s.id, revoked_at: null }).update(upd);
    if (!n) throw new Error('Session no longer exists');
    this.onRevoke([s.id]);
    return { token, session: { ...s, ...upd } };
  }

  async setChallenge(sessionId: string, challenge: string, ttlMs = 5 * 60_000): Promise<void> {
    await this.db('sessions').where({ id: sessionId }).update({ challenge, challenge_expires_at: Date.now() + ttlMs });
  }

  /** Returns and clears the pending WebAuthn challenge (single use). */
  async takeChallenge(sessionId: string): Promise<string | null> {
    const r = (await this.db('sessions').where({ id: sessionId }).first('challenge', 'challenge_expires_at')) as { challenge: string | null; challenge_expires_at: number | null } | undefined;
    await this.db('sessions').where({ id: sessionId }).update({ challenge: null, challenge_expires_at: null });
    if (!r?.challenge || !r.challenge_expires_at || Number(r.challenge_expires_at) < Date.now()) return null;
    return r.challenge;
  }

  async listForUser(userId: string): Promise<SessionRow[]> {
    const rows = await this.db('sessions').where({ user_id: userId, revoked_at: null }).andWhere('expires_at', '>', Date.now()).orderBy('last_seen_at', 'desc');
    return rows.map(toRow);
  }

  async listForTenant(tenantId: string, limit = 200): Promise<(SessionRow & { username: string; display_name: string })[]> {
    const rows = await this.db('sessions as s')
      .join('users as u', 'u.id', 's.user_id')
      .where({ 's.tenant_id': tenantId, 's.revoked_at': null })
      .andWhere('s.expires_at', '>', Date.now())
      .orderBy('s.last_seen_at', 'desc')
      .limit(limit)
      .select('s.*', 'u.username', 'u.display_name');
    return rows.map((r: Record<string, unknown>) => ({ ...toRow(r), username: String(r.username), display_name: String(r.display_name) }));
  }

  async get(tenantId: string, id: string): Promise<SessionRow | undefined> {
    const r = await this.db('sessions').where({ tenant_id: tenantId, id }).first();
    return r ? toRow(r) : undefined;
  }

  async revoke(tenantId: string, id: string): Promise<boolean> {
    const n = await this.db('sessions').where({ tenant_id: tenantId, id, revoked_at: null }).update({ revoked_at: Date.now() });
    if (n) this.onRevoke([id]);
    return n > 0;
  }

  /** Revokes every session of a user, optionally keeping one (sign out everywhere else). */
  async setWorkspace(id: string, workspaceId: string | null): Promise<void> {
    await this.db('sessions').where({ id }).update({ workspace_id: workspaceId });
  }

  async revokeAllForUser(userId: string, exceptId?: string): Promise<number> {
    const q = this.db('sessions').where({ user_id: userId, revoked_at: null });
    if (exceptId) q.andWhereNot({ id: exceptId });
    const ids = (await q.clone().select('id')).map((r: { id: string }) => r.id);
    if (!ids.length) return 0;
    await this.db('sessions').whereIn('id', ids).update({ revoked_at: Date.now() });
    this.onRevoke(ids);
    return ids.length;
  }

  /** Deletes sessions that ended more than a day ago. */
  async purge(): Promise<number> {
    const cutoff = Date.now() - 24 * 3600_000;
    return this.db('sessions').where('expires_at', '<', cutoff).orWhere('revoked_at', '<', cutoff).delete();
  }
}
