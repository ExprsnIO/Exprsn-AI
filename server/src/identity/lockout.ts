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
      if (r.key.startsWith('u:') && t - Number(r.window_start) < this.cfg.windowMinutes * 60_000) remaining = Math.max(0, this.limit(r.key) - r.failures);
    }
    return { locked: retry > 0, retryAfterSeconds: Math.ceil(retry), remaining };
  }

  /** Records a failure against each key and returns the attempts left on the account key. */
  async fail(keys: string[]): Promise<ThrottleState> {
    const t = Date.now();
    const windowMs = this.cfg.windowMinutes * 60_000;
    await this.db.transaction(async (trx) => {
      for (const key of keys) {
        const r = (await trx('login_throttle').where({ key }).first()) as { failures: number; window_start: number } | undefined;
        const fresh = !r || t - Number(r.window_start) >= windowMs;
        const failures = fresh ? 1 : r.failures + 1;
        const locked_until = failures >= this.limit(key) ? t + this.cfg.durationMinutes * 60_000 : null;
        if (r) await trx('login_throttle').where({ key }).update({ failures, window_start: fresh ? t : r.window_start, locked_until });
        else await trx('login_throttle').insert({ key, failures, window_start: t, locked_until });
      }
    });
    return this.check(keys);
  }

  async succeed(accountKey: string): Promise<void> {
    await this.db('login_throttle').where({ key: accountKey }).delete();
  }

  async purge(): Promise<number> {
    const cutoff = Date.now() - Math.max(this.cfg.windowMinutes, this.cfg.durationMinutes) * 60_000;
    return this.db('login_throttle').where('window_start', '<', cutoff).andWhere((w) => w.whereNull('locked_until').orWhere('locked_until', '<', Date.now())).delete();
  }
}
