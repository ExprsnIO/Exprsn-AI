import { readFileSync } from 'node:fs';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import type { Config } from '../config/index.js';

/** A database account issued by OpenBao for one connection, with its lease. */
export interface DynamicCredential {
  username: string;
  password: string;
  leaseId: string;
  /** When the lease ends (ms). */
  expiresAt: number;
  ttlMs: number;
  renewable: boolean;
}

type BaoFetch = (url: string, init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; dispatcher?: Dispatcher }) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

export class DynamicCredentialError extends Error {}

/**
 * OpenBao (or Vault) database secrets engine credentials for data connections (B-416). `GET <mount>/creds/<role>`
 * issues a short-lived database account; this instance keeps it while its lease runs, renews it when a third of the
 * lease is left (`sys/leases/renew`), takes a fresh account when renewal is refused or cut short by the role's max
 * TTL, and revokes leases it no longer uses (`sys/leases/revoke`) so the accounts are dropped at once.
 */
export class DynamicCredentials {
  private readonly cache = new Map<string, DynamicCredential>();
  private readonly inflight = new Map<string, Promise<DynamicCredential>>();
  private readonly agent: Agent | undefined;

  constructor(
    private readonly addr: string,
    private readonly token: () => string,
    private readonly mount = 'database',
    caFile?: string,
    private readonly doFetch: BaoFetch = undiciFetch as unknown as BaoFetch
  ) {
    this.agent = caFile ? new Agent({ connect: { ca: readFileSync(caFile) } }) : undefined;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.doFetch(`${this.addr.replace(/\/$/, '')}/v1/${path}`, {
      method,
      headers: { 'X-Vault-Token': this.token(), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
      ...(this.agent ? { dispatcher: this.agent } : {})
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 200);
      try {
        detail = ((JSON.parse(text) as { errors?: string[] }).errors ?? []).join('; ') || detail;
      } catch {
        // not JSON
      }
      throw new DynamicCredentialError(`OpenBao ${method} ${path.replace(/creds\/.*/, 'creds/…')}: ${res.status} ${detail}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  private async issue(role: string): Promise<DynamicCredential> {
    const r = await this.call<{ lease_id: string; lease_duration: number; renewable: boolean; data: { username: string; password: string } }>('GET', `${this.mount}/creds/${encodeURIComponent(role)}`);
    if (!r.data?.username || !r.lease_id) throw new DynamicCredentialError('OpenBao issued no credentials for that role.');
    const ttlMs = Math.max(1, Number(r.lease_duration)) * 1000;
    return { username: r.data.username, password: r.data.password, leaseId: r.lease_id, expiresAt: Date.now() + ttlMs, ttlMs, renewable: !!r.renewable };
  }

  private async renew(c: DynamicCredential): Promise<DynamicCredential | null> {
    if (!c.renewable) return null;
    try {
      const r = await this.call<{ lease_id: string; lease_duration: number }>('PUT', 'sys/leases/renew', { lease_id: c.leaseId, increment: Math.round(c.ttlMs / 1000) });
      const ms = Number(r.lease_duration) * 1000;
      // A renewal cut short by the role's max TTL is not worth keeping: take a new account.
      if (!ms || ms < c.ttlMs / 3) return null;
      return { ...c, expiresAt: Date.now() + ms };
    } catch {
      return null;
    }
  }

  async revokeLease(leaseId: string): Promise<void> {
    await this.call('PUT', 'sys/leases/revoke', { lease_id: leaseId });
  }

  /** The credential for a connection (`key`), from the cache, renewed, or newly issued. */
  get(role: string, key: string): Promise<DynamicCredential> {
    const cached = this.cache.get(key);
    const now = Date.now();
    if (cached && cached.expiresAt - now > cached.ttlMs / 3) return Promise.resolve(cached);
    const running = this.inflight.get(key);
    if (running) return running;
    const p = (async () => {
      let next = cached && cached.expiresAt - now > 5000 ? await this.renew(cached) : null;
      if (!next) {
        next = await this.issue(role);
        if (cached) await this.revokeLease(cached.leaseId).catch(() => undefined);
      }
      this.cache.set(key, next);
      return next;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /** Drops and revokes a connection's credential (on delete, or when its source or role changes). */
  async forget(key: string): Promise<void> {
    const c = this.cache.get(key);
    this.cache.delete(key);
    if (c) await this.revokeLease(c.leaseId).catch(() => undefined);
  }

  /** Revokes every lease this instance holds (shutdown). */
  async close(): Promise<void> {
    await Promise.all([...this.cache.keys()].map((k) => this.forget(k)));
    await this.agent?.close().catch(() => undefined);
  }

  /** What this instance holds, for the connection view (never the password). */
  lease(key: string): { username: string; expiresAt: number; renewable: boolean } | null {
    const c = this.cache.get(key);
    return c ? { username: c.username, expiresAt: c.expiresAt, renewable: c.renewable } : null;
  }
}

export function createDynamicCredentials(cfg: Config): DynamicCredentials | null {
  if (!cfg.OPENBAO_ADDR || !cfg.OPENBAO_TOKEN) return null;
  const token = cfg.OPENBAO_TOKEN;
  return new DynamicCredentials(cfg.OPENBAO_ADDR, () => token, cfg.OPENBAO_DATABASE_MOUNT, cfg.OPENBAO_CA_FILE);
}
