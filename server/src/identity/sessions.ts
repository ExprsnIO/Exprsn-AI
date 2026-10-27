import type { Db } from '../db/knex.js';
import { randomToken } from '../crypto/index.js';
import type { GenericLeases, HeldLease } from '../vault/generic-leases.js';
import { asKeySource, mac, macMatches, macs, type KeySource } from '../vault/keyring.js';

/** `password`: the account must change its password (admin-set or reset) before anything else. */
export type SessionStage = 'mfa' | 'enroll' | 'password' | 'active';

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
  /** When the owner last proved who they are (password or factor); null on rows from before 1.1 (use created_at). */
  auth_at?: number | null;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
  workspace_id?: string | null;
  /** 1.7.0 (B-9206): the lease that is this session, when it is one; a row of `sessions` has none. */
  lease_id?: string | null;
}

/** Where new sessions and API keys are kept (CREDENTIAL_STORE). Both stores are read whichever is chosen. */
export type CredentialStore = 'table' | 'leases';

export const SESSION_LEASE_KIND = 'session';
/**
 * A lease session's cookie token starts with this, which no token of a `sessions` row can (they are base64url, with
 * no dot), so a presented token names its store and a request still makes one indexed lookup.
 */
export const LEASE_TOKEN_PREFIX = 'l1.';

export interface SessionSettings {
  /** 1.7.0 (B-9205): the `session` key (its accepted versions), or a fixed secret. */
  secret: string | KeySource;
  idleMinutes: number;
  absoluteHours: number;
  pendingMinutes: number;
  /** 1.7.0 (B-9206): `leases` makes a new session a row of `vault_leases`; without it, a row of `sessions`. */
  store?: CredentialStore;
  /** The lease table (lazy: it is built after this service). Without it only `sessions` is read. */
  leases?: () => GenericLeases;
}

const LEASE_ACTOR = { service: 'identity.sessions' } as const;

/** A session read from its lease: the digest it is found by is its id, as a `sessions` row's id is. */
function fromLease(h: HeldLease): SessionRow {
  const l = h.lease;
  const d = l.data as Partial<SessionRow> & { sid?: string };
  const stage = (d.stage ?? 'mfa') as SessionStage;
  return {
    id: h.verifier ?? String(d.sid ?? ''),
    user_id: String(l.holder ?? ''),
    tenant_id: l.tenantId,
    stage,
    method: String(d.method ?? ''),
    provider_id: d.provider_id ?? null,
    ip: d.ip ?? null,
    user_agent: d.user_agent ?? null,
    challenge: d.challenge ?? null,
    challenge_expires_at: d.challenge_expires_at == null ? null : Number(d.challenge_expires_at),
    mfa_verified_at: d.mfa_verified_at == null ? null : Number(d.mfa_verified_at),
    auth_at: d.auth_at == null ? null : Number(d.auth_at),
    created_at: d.created_at == null ? l.issuedAt : Number(d.created_at),
    last_seen_at: l.renewedAt,
    // The absolute end for an active session (its idle timeout is the lease's renew period); the pending end otherwise.
    expires_at: stage === 'active' ? l.maxExpiresAt : l.expiresAt,
    revoked_at: l.state === 'revoked' || l.state === 'revoking' ? (l.endedAt ?? l.renewedAt) : null,
    workspace_id: d.workspace_id ?? null,
    lease_id: l.id
  };
}

const toRow = (r: Record<string, unknown>): SessionRow => ({
  ...(r as unknown as SessionRow),
  challenge_expires_at: r.challenge_expires_at == null ? null : Number(r.challenge_expires_at),
  mfa_verified_at: r.mfa_verified_at == null ? null : Number(r.mfa_verified_at),
  auth_at: r.auth_at == null ? null : Number(r.auth_at),
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
 *
 * 1.7.0 (B-9206): with CREDENTIAL_STORE=leases a new session is a lease of kind `session` in `vault_leases`: the
 * lease's verifier is the same digest, its renew period is the idle timeout, its maximum the absolute lifetime, and
 * its data the rest of the row (nothing secret). Signing out revokes the lease. Both stores are always read, by the
 * token's form, so a session made before the switch (or after switching back) keeps working until it ends.
 */
export class SessionService {
  private readonly touched = new Map<string, number>();
  /** Sprint 26 (B-1904): refuses a session for a sanctioned user (installed by the moderation service); throws. */
  admit: ((tenantId: string, userId: string) => Promise<void>) | null = null;
  /**
   * 1.9.0 (B-150): push devices end with the person's sessions and follow a rotated session (installed by
   * `PushDevices` in `services.ts`). Called after the sessions changed; a failure is swallowed, the revocation stands.
   */
  devices: { end(scope: { userId?: string; exceptSessionId?: string; sessionId?: string; tenantId?: string }): Promise<number>; moved(from: string, to: string): Promise<void> } | null = null;

  /**
   * 1.9.0 (B-190): a tenant's shorter idle and absolute lifetimes (its sign-in policy, installed in `services.ts`);
   * null, or no hook, means the platform's. A tenant value never lengthens a session.
   */
  policy: { lifetimes(tenantId: string): Promise<{ idleMinutes: number; absoluteHours: number } | null> } | null = null;

  /** Applies the tenant's lifetimes to a live session: null when it is past them, else the session with its end. */
  private async withinTenant(s: SessionRow, t: number): Promise<SessionRow | null> {
    if (!this.policy || s.stage !== 'active') return s;
    const life = await this.policy.lifetimes(s.tenant_id).catch(() => null);
    if (!life) return s;
    if (life.idleMinutes < this.cfg.idleMinutes && t - s.last_seen_at > life.idleMinutes * 60_000) return null;
    if (life.absoluteHours < this.cfg.absoluteHours) {
      // An active session's end is its start plus the platform's absolute lifetime; the tenant's ends it sooner.
      const end = s.expires_at - (this.cfg.absoluteHours - life.absoluteHours) * 3600_000;
      if (end <= t) return null;
      return { ...s, expires_at: end };
    }
    return s;
  }

  private async endDevices(scope: { userId?: string; exceptSessionId?: string; sessionId?: string; tenantId?: string }): Promise<void> {
    await this.devices?.end(scope).catch(() => 0);
  }

  constructor(
    private readonly db: Db,
    private readonly cfg: SessionSettings,
    private readonly onRevoke: (sessionIds: string[]) => void = () => undefined
  ) {}

  private get key(): KeySource {
    return asKeySource(this.cfg.secret);
  }

  private get leases(): GenericLeases | null {
    return this.cfg.leases?.() ?? null;
  }

  /** Whether new sessions are leases. */
  get store(): CredentialStore {
    return this.cfg.store === 'leases' && this.cfg.leases ? 'leases' : 'table';
  }

  /** Registers the lease kind: a revoked session lease closes its sockets everywhere, whoever revoked it. */
  registerLeaseKind(): void {
    this.leases?.registerKind(SESSION_LEASE_KIND, {
      // The sign-in and the sign-out are audited where they happen; an idle session ending is not an event.
      quiet: { issued: true, expired: true },
      end: async (lease, reason) => {
        const sid = (lease.data as { sid?: string }).sid;
        if (reason === 'revoked' && sid) this.onRevoke([sid]);
      }
    });
  }

  private async leaseById(id: string): Promise<HeldLease | null> {
    const h = await this.leases?.findByVerifier(id);
    return h && h.lease.kind === SESSION_LEASE_KIND ? h : null;
  }

  /** The renew period and the absolute end of a session lease in a stage. */
  private leaseLife(stage: SessionStage, activeSince: number): { renewPeriodSeconds: number; maxExpiresAt: number } {
    return stage === 'active'
      ? { renewPeriodSeconds: this.cfg.idleMinutes * 60, maxExpiresAt: activeSince + this.cfg.absoluteHours * 3600_000 }
      : { renewPeriodSeconds: this.cfg.pendingMinutes * 60, maxExpiresAt: Date.now() + this.cfg.pendingMinutes * 60_000 };
  }

  /** The id a new session gets: the digest under the key's current version. */
  idFor(token: string): string {
    return mac(this.key, 'session:' + token);
  }

  /** The ids a presented token may have: one per accepted key version, so a rotation keeps sessions (B-9205). */
  private idsFor(token: string): string[] {
    return macs(this.key, 'session:' + token);
  }

  csrfFor(sessionId: string): string {
    return mac(this.key, 'csrf:' + sessionId);
  }

  /** Whether a presented CSRF token is this session's under any accepted key version. */
  csrfMatches(sessionId: string, presented: string): boolean {
    return macMatches(this.key, 'csrf:' + sessionId, presented);
  }

  private expiry(stage: SessionStage, createdAt: number): number {
    return stage === 'active' ? createdAt + this.cfg.absoluteHours * 3600_000 : Date.now() + this.cfg.pendingMinutes * 60_000;
  }

  async create(input: { userId: string; tenantId: string; stage: SessionStage; method: string; providerId: string | null; ip: string | null; userAgent: string | null; mfaVerified?: boolean }): Promise<{ token: string; session: SessionRow }> {
    // Sprint 26 (B-1904): a suspended or banned user gets no session, whichever way they signed in.
    if (this.admit) await this.admit(input.tenantId, input.userId);
    if (this.store === 'leases') return this.createLease(input);
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
      auth_at: t,
      created_at: t,
      last_seen_at: t,
      expires_at: this.expiry(input.stage, t),
      revoked_at: null
    };
    await this.db('sessions').insert(row);
    return { token, session: row };
  }

  private async createLease(input: { userId: string; tenantId: string; stage: SessionStage; method: string; providerId: string | null; ip: string | null; userAgent: string | null; mfaVerified?: boolean }): Promise<{ token: string; session: SessionRow }> {
    const token = LEASE_TOKEN_PREFIX + randomToken(32);
    const id = this.idFor(token);
    const t = Date.now();
    const life = this.leaseLife(input.stage, t);
    const data = {
      sid: id,
      stage: input.stage,
      method: input.method,
      provider_id: input.providerId,
      ip: input.ip,
      user_agent: input.userAgent?.slice(0, 300) ?? null,
      challenge: null,
      challenge_expires_at: null,
      mfa_verified_at: input.mfaVerified ? t : null,
      auth_at: t,
      created_at: t,
      workspace_id: null
    };
    const lease = await this.leases!.issue({ tenantId: input.tenantId, kind: SESSION_LEASE_KIND, holderKind: 'user', holder: input.userId, verifier: id, label: 'internal', data, renewPeriodSeconds: life.renewPeriodSeconds, maxLifetimeSeconds: Math.max(1, Math.ceil((life.maxExpiresAt - t) / 1000)), actor: LEASE_ACTOR });
    return { token, session: fromLease({ lease, verifier: id }) };
  }

  /** Returns the live session for a cookie token, or null when unknown, revoked, expired or idle. */
  async resolve(token: string): Promise<SessionRow | null> {
    if (!token || token.length > 200) return null;
    if (token.startsWith(LEASE_TOKEN_PREFIX)) {
      // The lease's expiry is the idle timeout and the absolute end at once; a pending session is never renewed.
      const h = await this.leases?.held(this.idsFor(token));
      return h && h.lease.kind === SESSION_LEASE_KIND ? this.withinTenant(fromLease(h), Date.now()) : null;
    }
    const r = await this.db('sessions').whereIn('id', this.idsFor(token)).first();
    if (!r) return null;
    const s = toRow(r);
    const t = Date.now();
    if (s.revoked_at || s.expires_at <= t) return null;
    if (s.stage === 'active' && t - s.last_seen_at > this.cfg.idleMinutes * 60_000) return null;
    return this.withinTenant(s, t);
  }

  /** Records activity, at most once a minute per session. */
  async touch(s: SessionRow): Promise<void> {
    const t = Date.now();
    const last = this.touched.get(s.id) ?? s.last_seen_at;
    if (t - last < 60_000) return;
    this.touched.set(s.id, t);
    if (this.touched.size > 50_000) this.touched.clear();
    if (s.lease_id) {
      // A use renews the lease by its idle timeout (never past the absolute end); a pending session is not renewed.
      if (s.stage === 'active') await this.leases?.use(s.lease_id, Math.min(t + this.cfg.idleMinutes * 60_000, s.expires_at));
      return;
    }
    await this.db('sessions').where({ id: s.id }).update({ last_seen_at: t });
  }

  /** Moves a session to a new stage under a new token. The old token stops working immediately. */
  async rotate(s: SessionRow, patch: { stage: SessionStage; method?: string; mfaVerified?: boolean }): Promise<{ token: string; session: SessionRow }> {
    if (s.lease_id) return this.rotateLease(s, patch);
    const token = randomToken(32);
    const id = this.idFor(token);
    const t = Date.now();
    const upd = {
      id,
      stage: patch.stage,
      method: patch.method ?? s.method,
      mfa_verified_at: patch.mfaVerified ? t : s.mfa_verified_at,
      auth_at: patch.mfaVerified ? t : (s.auth_at ?? s.created_at),
      challenge: null,
      challenge_expires_at: null,
      last_seen_at: t,
      expires_at: this.expiry(patch.stage, patch.stage === 'active' && s.stage !== 'active' ? t : s.created_at)
    };
    const n = await this.db('sessions').where({ id: s.id, revoked_at: null }).update(upd);
    if (!n) throw new Error('Session no longer exists');
    this.onRevoke([s.id]);
    await this.devices?.moved(s.id, id).catch(() => undefined);
    return { token, session: { ...s, ...upd } };
  }

  /** The same for a session that is a lease: the lease gets the new digest and the new life in place. */
  private async rotateLease(s: SessionRow, patch: { stage: SessionStage; method?: string; mfaVerified?: boolean }): Promise<{ token: string; session: SessionRow }> {
    const token = LEASE_TOKEN_PREFIX + randomToken(32);
    const id = this.idFor(token);
    const t = Date.now();
    const life = this.leaseLife(patch.stage, patch.stage === 'active' && s.stage !== 'active' ? t : s.created_at);
    const data = {
      sid: id,
      stage: patch.stage,
      method: patch.method ?? s.method,
      provider_id: s.provider_id,
      ip: s.ip,
      user_agent: s.user_agent,
      challenge: null,
      challenge_expires_at: null,
      mfa_verified_at: patch.mfaVerified ? t : s.mfa_verified_at,
      auth_at: patch.mfaVerified ? t : (s.auth_at ?? s.created_at),
      created_at: s.created_at,
      workspace_id: s.workspace_id ?? null
    };
    const h = await this.leases?.rekey(s.lease_id!, { verifier: id, data, ...life });
    if (!h) throw new Error('Session no longer exists');
    this.onRevoke([s.id]);
    await this.devices?.moved(s.id, id).catch(() => undefined);
    return { token, session: fromLease(h) };
  }

  /** Changes fields of a session that is a lease; false when no live lease has this id. */
  private async patchLease(sessionId: string, patch: Record<string, unknown>): Promise<boolean> {
    const h = await this.leaseById(sessionId);
    return h ? this.leases!.patch(h.lease.id, patch) : false;
  }

  /**
   * Records a fresh password or factor check on the session (step-up re-authentication). With `mfa` (a TOTP code or a
   * passkey) the session's second-factor time moves too: 1.5.0 (B-3101) app passwords need a fresh one.
   */
  async markAuthenticated(sessionId: string, o: { mfa?: boolean } = {}): Promise<number> {
    const t = Date.now();
    const upd = o.mfa ? { auth_at: t, mfa_verified_at: t } : { auth_at: t };
    if (!(await this.db('sessions').where({ id: sessionId }).update(upd))) await this.patchLease(sessionId, upd);
    return t;
  }

  async setChallenge(sessionId: string, challenge: string, ttlMs = 5 * 60_000): Promise<void> {
    const upd = { challenge, challenge_expires_at: Date.now() + ttlMs };
    if (!(await this.db('sessions').where({ id: sessionId }).update(upd))) await this.patchLease(sessionId, upd);
  }

  /** Returns and clears the pending WebAuthn challenge (single use). */
  async takeChallenge(sessionId: string): Promise<string | null> {
    let r = (await this.db('sessions').where({ id: sessionId }).first('challenge', 'challenge_expires_at')) as { challenge: string | null; challenge_expires_at: number | null } | undefined;
    if (r) await this.db('sessions').where({ id: sessionId }).update({ challenge: null, challenge_expires_at: null });
    else {
      const h = await this.leaseById(sessionId);
      if (h) {
        r = h.lease.data as { challenge: string | null; challenge_expires_at: number | null };
        await this.leases!.patch(h.lease.id, { challenge: null, challenge_expires_at: null });
      }
    }
    if (!r?.challenge || !r.challenge_expires_at || Number(r.challenge_expires_at) < Date.now()) return null;
    return r.challenge;
  }

  /** The live sessions that are leases, of one user or one tenant. */
  private async leaseSessions(where: { holder?: string; tenantId?: string }, limit = 1000): Promise<SessionRow[]> {
    return ((await this.leases?.liveOf({ kind: SESSION_LEASE_KIND, ...where }, limit)) ?? []).map(fromLease);
  }

  async listForUser(userId: string): Promise<SessionRow[]> {
    const rows = await this.db('sessions').where({ user_id: userId, revoked_at: null }).andWhere('expires_at', '>', Date.now()).orderBy('last_seen_at', 'desc');
    return [...rows.map(toRow), ...(await this.leaseSessions({ holder: userId }))].sort((a, b) => b.last_seen_at - a.last_seen_at);
  }

  async listForTenant(tenantId: string, limit = 200): Promise<(SessionRow & { username: string; display_name: string })[]> {
    const rows = await this.db('sessions as s')
      .join('users as u', 'u.id', 's.user_id')
      .where({ 's.tenant_id': tenantId, 's.revoked_at': null })
      .andWhere('s.expires_at', '>', Date.now())
      .orderBy('s.last_seen_at', 'desc')
      .limit(limit)
      .select('s.*', 'u.username', 'u.display_name');
    const out = rows.map((r: Record<string, unknown>) => ({ ...toRow(r), username: String(r.username), display_name: String(r.display_name) }));
    const leased = await this.leaseSessions({ tenantId }, limit);
    if (!leased.length) return out;
    const names = new Map(((await this.db('users').where({ tenant_id: tenantId }).whereIn('id', [...new Set(leased.map((l) => l.user_id))]).select('id', 'username', 'display_name')) as { id: string; username: string; display_name: string }[]).map((u) => [u.id, u]));
    for (const l of leased) {
      const u = names.get(l.user_id);
      if (u) out.push({ ...l, username: String(u.username), display_name: String(u.display_name) });
    }
    return out.sort((a, b) => b.last_seen_at - a.last_seen_at).slice(0, limit);
  }

  async get(tenantId: string, id: string): Promise<SessionRow | undefined> {
    const r = await this.db('sessions').where({ tenant_id: tenantId, id }).first();
    if (r) return toRow(r);
    const h = await this.leaseById(id);
    return h && h.lease.tenantId === tenantId ? fromLease(h) : undefined;
  }

  /** Whether a session was revoked or no longer exists (an OAuth grant made in it ends with it). */
  async gone(id: string): Promise<boolean> {
    const r = (await this.db('sessions').where({ id }).first('revoked_at')) as { revoked_at: number | null } | undefined;
    if (r) return r.revoked_at != null;
    const h = await this.leaseById(id);
    return !h || h.lease.state === 'revoked' || h.lease.state === 'revoking';
  }

  async revoke(tenantId: string, id: string): Promise<boolean> {
    const n = await this.db('sessions').where({ tenant_id: tenantId, id, revoked_at: null }).update({ revoked_at: Date.now() });
    if (n) {
      this.onRevoke([id]);
      await this.endDevices({ sessionId: id });
      return true;
    }
    const h = await this.leaseById(id);
    if (!h || h.lease.tenantId !== tenantId || h.lease.state !== 'active') return false;
    // The lease kind's handler closes the session's sockets.
    await this.leases!.revoke(tenantId, h.lease.id, LEASE_ACTOR);
    await this.endDevices({ sessionId: id });
    return true;
  }

  /** Revokes every session of a user, optionally keeping one (sign out everywhere else). */
  async setWorkspace(id: string, workspaceId: string | null): Promise<void> {
    if (!(await this.db('sessions').where({ id }).update({ workspace_id: workspaceId }))) await this.patchLease(id, { workspace_id: workspaceId });
  }

  async revokeAllForUser(userId: string, exceptId?: string): Promise<number> {
    const q = this.db('sessions').where({ user_id: userId, revoked_at: null });
    if (exceptId) q.andWhereNot({ id: exceptId });
    const ids = (await q.clone().select('id')).map((r: { id: string }) => r.id);
    // Sprint 26a (B-1803): trusted devices end with the sessions (all of them; the kept one keeps no trust either).
    await this.db('trusted_devices').where({ user_id: userId }).delete();
    const leased = (await this.leases?.endWhere({ kind: SESSION_LEASE_KIND, holder: userId, ...(exceptId ? { exceptVerifier: exceptId } : {}) }, LEASE_ACTOR))?.length ?? 0;
    // 1.9.0 (B-150): and the push devices, except those registered from the session that is kept.
    await this.endDevices({ userId, ...(exceptId ? { exceptSessionId: exceptId } : {}) });
    if (!ids.length) return leased;
    await this.db('sessions').whereIn('id', ids).update({ revoked_at: Date.now() });
    this.onRevoke(ids);
    return ids.length + leased;
  }

  /** Revokes every live session in a tenant (tenant disabled or offboarded); their sockets close everywhere. */
  async revokeAllForTenant(tenantId: string): Promise<number> {
    const ids = (await this.db('sessions').where({ tenant_id: tenantId, revoked_at: null }).select('id')).map((r: { id: string }) => r.id);
    await this.db('trusted_devices').where({ tenant_id: tenantId }).delete();
    const leased = (await this.leases?.endWhere({ kind: SESSION_LEASE_KIND, tenantId }, LEASE_ACTOR))?.length ?? 0;
    await this.endDevices({ tenantId }); // 1.9.0 (B-150)
    if (!ids.length) return leased;
    await this.db('sessions').whereIn('id', ids).update({ revoked_at: Date.now() });
    this.onRevoke(ids);
    return ids.length + leased;
  }

  /** Deletes sessions that ended more than a day ago. */
  async purge(): Promise<number> {
    const cutoff = Date.now() - 24 * 3600_000;
    const leased = (await this.leases?.purgeEnded(SESSION_LEASE_KIND, cutoff)) ?? 0;
    return Number(await this.db('sessions').where('expires_at', '<', cutoff).orWhere('revoked_at', '<', cutoff).delete()) + Number(leased);
  }
}
