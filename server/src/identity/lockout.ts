import type { Db } from '../db/knex.js';

export interface LockoutSettings {
  maxAttempts: number;
  windowMinutes: number;
  durationMinutes: number;
}

export interface ThrottleState {
  locked: boolean;
  retryAfterSeconds: number;
  remaining: number;
}

/**
 * Failed sign-in counters, kept in the database so every instance sees them.
 * Two keys per attempt: the account (tenant + username, whether or not it exists, so the counter itself does not
 * reveal existence) and the client address, which gets a higher threshold to allow shared NAT.
 */
export class LoginThrottle {
  constructor(
    private readonly db: Db,
    private readonly cfg: LockoutSettings
  ) {}

  static keys(tenantId: string, username: string, ip: string | null): { account: string; ip: string | null } {
    return { account: `u:${tenantId}:${username.toLowerCase()}`.slice(0, 255), ip: ip ? `ip:${ip}` : null };
  }

  private limit(key: string): number {
    return key.startsWith('ip:') ? this.cfg.maxAttempts * 5 : this.cfg.maxAttempts;
  }

  async check(keys: string[]): Promise<ThrottleState> {
    const t = Date.now();
    const rows = (await this.db('login_throttle').whereIn('key', keys)) as { key: string; failures: number; window_start: number; locked_until: number | null }[];
    let retry = 0;
    let remaining = this.cfg.maxAttempts;
    for (const r of rows) {
      if (r.locked_until && Number(r.locked_until) > t) retry = Math.max(retry, (Number(r.locked_until) - t) / 1000);
      if ((r.key.startsWith('u:') || r.key.startsWith('mfa:')) && t - Number(r.window_start) < this.cfg.windowMinutes * 60_000) remaining = Math.max(0, this.limit(r.key) - r.failures);
    }
    return { locked: retry > 0, retryAfterSeconds: Math.ceil(retry), remaining };
  }

  /**
   * Atomically counts one attempt against a key and returns the count, starting a new window when the old one has
   * expired. The increment is a single UPDATE, so concurrent requests get distinct counts; a window reset only
   * applies if nobody reset it first (compare-and-set on window_start), otherwise the loop increments instead.
   */
  private async bump(key: string, t: number, windowMs: number): Promise<{ failures: number; locked_until: number | null }> {
    for (let i = 0; i < 5; i++) {
      const r = (await this.db('login_throttle').where({ key }).first()) as { failures: number; window_start: number; locked_until: number | null } | undefined;
      if (!r) {
        try {
          await this.db('login_throttle').insert({ key, failures: 1, window_start: t, locked_until: null });
          return { failures: 1, locked_until: null };
        } catch {
          continue; // another request inserted it first
        }
      }
      if (t - Number(r.window_start) >= windowMs) {
        const n = await this.db('login_throttle').where({ key, window_start: r.window_start }).update({ failures: 1, window_start: t });
        if (!n) continue;
      } else {
        await this.db('login_throttle').where({ key }).increment('failures', 1);
      }
      const after = (await this.db('login_throttle').where({ key }).first()) as { failures: number; locked_until: number | null } | undefined;
      if (after) return { failures: Number(after.failures), locked_until: after.locked_until == null ? null : Number(after.locked_until) };
    }
    throw new Error('Could not record the sign-in attempt; try again.');
  }

  private async lock(key: string, t: number): Promise<void> {
    await this.db('login_throttle')
      .where({ key })
      .andWhere((w) => w.whereNull('locked_until').orWhere('locked_until', '<=', t))
      .update({ locked_until: t + this.cfg.durationMinutes * 60_000 });
  }

  /**
   * Reserves an attempt on every key before the credential is checked, so N parallel requests cannot all pass a
   * check that ran before any of them failed. Refuses (locked) when a key is locked or this attempt is past its limit.
   * Follow with `failed` when the credential was wrong, or `release` when it was right.
   */
  async reserve(keys: string[]): Promise<ThrottleState> {
    const t = Date.now();
    const windowMs = this.cfg.windowMinutes * 60_000;
    let retry = 0;
    let remaining = this.cfg.maxAttempts;
    for (const key of keys) {
      const r = await this.bump(key, t, windowMs);
      const limit = this.limit(key);
      if (r.failures > limit) {
        await this.lock(key, t);
        const lockedUntil = r.locked_until && r.locked_until > t ? r.locked_until : t + this.cfg.durationMinutes * 60_000;
        retry = Math.max(retry, (lockedUntil - t) / 1000);
      } else if (r.locked_until && r.locked_until > t) {
        retry = Math.max(retry, (r.locked_until - t) / 1000);
      }
      if (key.startsWith('u:') || key.startsWith('mfa:')) remaining = Math.max(0, limit - r.failures);
    }
    return { locked: retry > 0, retryAfterSeconds: Math.ceil(retry), remaining };
  }

  /** A reserved attempt failed: locks keys that reached their limit and returns the attempts left on the account key. */
  async failed(keys: string[]): Promise<ThrottleState> {
    const t = Date.now();
    const rows = (await this.db('login_throttle').whereIn('key', keys)) as { key: string; failures: number }[];
    for (const r of rows) if (Number(r.failures) >= this.limit(r.key)) await this.lock(r.key, t);
    return this.check(keys);
  }

  /** A reserved attempt succeeded: gives the reservation back. */
  async release(keys: string[]): Promise<void> {
    for (const key of keys) await this.db('login_throttle').where({ key }).andWhere('failures', '>', 0).decrement('failures', 1);
  }

  /** Records a failure against each key (reserve and fail in one step, for callers that verify before counting). */
  async fail(keys: string[]): Promise<ThrottleState> {
    await this.reserve(keys);
    return this.failed(keys);
  }

  async succeed(accountKey: string): Promise<void> {
    await this.db('login_throttle').where({ key: accountKey }).delete();
  }

  async purge(): Promise<number> {
    const cutoff = Date.now() - Math.max(this.cfg.windowMinutes, this.cfg.durationMinutes) * 60_000;
    return this.db('login_throttle').where('window_start', '<', cutoff).andWhere((w) => w.whereNull('locked_until').orWhere('locked_until', '<', Date.now())).delete();
  }
}
