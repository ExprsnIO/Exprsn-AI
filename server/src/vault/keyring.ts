import type { Principal } from '../authz/policy.js';
import { hmac, safeEqual } from '../crypto/index.js';
import { HttpProblem } from '../http/problem.js';
import { platformTenant } from '../ops/common.js';
import { TOPICS } from '../platform/bus.js';
import type { Services } from '../services.js';
import { sysPath, SYS_SCOPE, transitPolicyPath } from './policy.js';

/*
 * 1.7.0 (B-9201, B-9203, B-9205): the platform's named HMAC keys.
 *
 * Until 1.7.0 every digest and signature the server keyed itself (session ids, CSRF tokens, API-key digests, recovery
 * codes, app passwords, PDS tokens, file and share links, calendar feed signatures and more) was derived from the one
 * static SESSION_SECRET, which could not be rotated without ending all of them at once (defect F21). They now use
 * named keys of type `hmac-sha256` in the vault's platform scope (`sys/transit/<name>`), each with versions:
 *
 * - version 1 of every key is the SESSION_SECRET the derivation used before, so what was issued under it stays valid;
 * - a rotation adds a version with fresh random material; new digests and signatures are made under it;
 * - verification accepts every version from the key's minimum decryption version up, so the previous version stays
 *   valid until an admin retires it (raises the minimum).
 *
 * A `KeySource` hands a feature its key's accepted secrets, the current one first. The secrets are read as the
 * feature's `service` subject (the path policy must allow `sign` and `verify` on the key), kept in this process and
 * reloaded when another instance changes a key or a policy (the bus topic `vault.sys`) and every
 * VAULT_SYS_REFRESH_SECONDS. Uses are not audited one by one: they are counted per service and minute and written as
 * one `vault.sys.used` entry (B-9203).
 */

export interface KeySource {
  /** The accepted secrets, the current version first. Throws 503 when the platform scope refuses the key. */
  all(): readonly string[];
}

export const staticKey = (secret: string): KeySource => ({ all: () => [secret] });
export const asKeySource = (k: string | KeySource): KeySource => (typeof k === 'string' ? staticKey(k) : k);

/** The digest under the current version: what a new row stores and a new token carries. */
export const mac = (k: KeySource, data: string): string => hmac(k.all()[0]!, data);
/** The digest under every accepted version, the current first: what a lookup or a comparison accepts. */
export const macs = (k: KeySource, data: string): string[] => [...new Set(k.all().map((secret) => hmac(secret, data)))];
/** Whether `presented` is the digest of `data` under an accepted version (every version is compared). */
export function macMatches(k: KeySource, data: string, presented: string, cut?: number): boolean {
  let ok = false;
  for (const m of macs(k, data)) if (safeEqual(cut ? m.slice(0, cut) : m, presented)) ok = true;
  return ok;
}

/** The named keys: the service that reads each (its policy subject) and what it keys. */
export const SYS_KEYS = {
  session: { service: 'identity.sessions', uses: 'Session ids and CSRF tokens' },
  'api-key': { service: 'identity.api-keys', uses: 'API-key digests and SCIM token digests' },
  mfa: { service: 'identity.mfa', uses: 'Recovery codes and emailed sign-in codes' },
  'app-password': { service: 'identity.app-passwords', uses: 'DAV and PDS app passwords' },
  pds: { service: 'atproto.pds', uses: 'PDS session tokens (JWTs), invite codes and PLC operation tokens' },
  link: { service: 'links', uses: 'File links, share links, public form links and media URL tokens' },
  feed: { service: 'groups.calendar', uses: 'Calendar feed signatures' },
  federation: { service: 'federation.oidc', uses: 'OIDC codes and tokens, pending sign-ins, consent and re-authentication tokens, DPoP nonces, MCP OAuth states' },
  channel: { service: 'channels', uses: 'Customer-service channel session tokens' },
  identifier: { service: 'identifiers', uses: 'Stable identifiers: SAML persistent NameIDs, sign-in device ids, channel customer keys. Rotating it changes them' }
} as const satisfies Record<string, { service: string; uses: string }>;
export type SysKeyName = keyof typeof SYS_KEYS;
export const SYS_KEY_NAMES = Object.keys(SYS_KEYS) as SysKeyName[];

type State = 'cold' | 'open' | 'failed';

export class SystemKeys {
  private state: State = 'cold';
  private failure: string | null = null;
  private opening: Promise<void> | null = null;
  private readonly cache = new Map<SysKeyName, { secrets: string[]; latest: number; min: number }>();
  private readonly refused = new Map<SysKeyName, string>();
  /** Uses since the last flush, per key (each key has one service). */
  private readonly used = new Map<SysKeyName, { n: number; from: number }>();
  private timers: NodeJS.Timeout[] = [];
  private reloading: Promise<void> | null = null;
  private listening = false;
  /** 1.8.0 (B-145): set while the vault is sealed; every key refuses with 503 and nothing is cached. */
  private sealedReason: string | null = null;
  /** How many times the store was read (tests check that a warm cache reads nothing). */
  loads = 0;

  constructor(
    private readonly s: () => Services,
    private readonly opts: { bootstrapSecret: string; refreshSeconds: number }
  ) {}

  get status(): { state: State; failure: string | null; keys: number } {
    return { state: this.state, failure: this.failure, keys: this.cache.size };
  }

  /**
   * The key's secrets for the feature that owns it. Before the platform scope is opened (the CLI, setup scripts and
   * tests that never start a server) this is the old derivation: SESSION_SECRET alone, which is version 1 of every
   * key. A server opens the scope before it serves a request (B-9202), and one that could not refuses with 503.
   */
  key(name: SysKeyName): KeySource {
    return {
      all: () => {
        if (this.sealedReason) throw new HttpProblem(503, 'Vault sealed', `The ${name} key cannot be used: ${this.sealedReason}.`, { extensions: { step: 'vault-sealed', sealed: true, key: name }, headers: { 'Retry-After': '30' } });
        if (this.state === 'cold') return [this.opts.bootstrapSecret];
        const hit = this.cache.get(name);
        if (!hit) {
          const why = this.state === 'failed' ? `the vault's platform scope did not open (${this.failure ?? 'unknown error'})` : (this.refused.get(name) ?? 'it is not loaded');
          throw new HttpProblem(503, 'Vault unavailable', `The ${name} key cannot be used: ${why}.`, { extensions: { step: 'vault-system-scope', key: name } });
        }
        const u = this.used.get(name);
        if (u) u.n++;
        else this.used.set(name, { n: 1, from: Date.now() });
        return hit.secrets;
      }
    };
  }

  /**
   * Opens the platform scope: creates the named keys that do not exist yet (version 1 is the bootstrap secret), reads
   * each as its service, and starts following changes. Idempotent; a failure leaves the scope closed (`failed`), so
   * every key refuses until a later `open` succeeds.
   */
  open(): Promise<void> {
    return (this.opening ??= this.doOpen().catch((err: unknown) => {
      this.state = 'failed';
      this.failure = ((err as Error).message || 'unknown error').slice(0, 300);
      this.opening = null;
      this.cache.clear();
      throw err;
    }));
  }

  private async doOpen(): Promise<void> {
    const s = this.s();
    const created: string[] = [];
    for (const name of SYS_KEY_NAMES) if (await s.vault.ensureSysHmacKey(name, SYS_KEYS[name].service, this.opts.bootstrapSecret)) created.push(name);
    await this.load();
    if (this.refused.size === SYS_KEY_NAMES.length) throw new Error(`no platform key could be read: ${[...this.refused.values()][0]}`);
    this.state = 'open';
    this.failure = null;
    if (created.length) s.log.info({ keys: created }, 'vault: platform keys created from the session secret');
    if (!this.listening) {
      this.listening = true;
      s.bus.on(TOPICS.vaultSys, () => void this.reload().catch((err: Error) => s.log.warn({ err: err.message }, 'vault: platform keys not reloaded')));
    }
    if (!this.timers.length) {
      if (this.opts.refreshSeconds > 0) this.timers.push(setInterval(() => void this.reload().catch((err: Error) => s.log.warn({ err: err.message }, 'vault: platform keys not refreshed')), this.opts.refreshSeconds * 1000));
      this.timers.push(setInterval(() => void this.flushUsage().catch(() => undefined), 60_000));
      for (const t of this.timers) t.unref();
    }
  }

  /** 1.8.0 (B-145): the vault seal: every key refuses and the secrets held here are dropped. */
  seal(reason: string): void {
    this.sealedReason = reason.slice(0, 300);
    this.cache.clear();
  }

  /** 1.8.0 (B-145): after the unseal, the keys are read again (a scope that was never opened stays as it was). */
  async unseal(): Promise<void> {
    this.sealedReason = null;
    if (this.state === 'open') await this.load();
  }

  get sealed(): boolean {
    return this.sealedReason !== null;
  }

  /** The scope stays closed for a reason outside it (an earlier boot step failed): every key refuses (B-9202). */
  refuse(reason: string): void {
    this.state = 'failed';
    this.failure = reason.slice(0, 300);
    this.cache.clear();
  }

  /** Reads every key as its service. A key its service is refused stays out of the cache, with the reason kept. */
  private async load(): Promise<void> {
    const s = this.s();
    this.loads++;
    const next = new Map<SysKeyName, { secrets: string[]; latest: number; min: number }>();
    const refused = new Map<SysKeyName, string>();
    for (const name of SYS_KEY_NAMES) {
      try {
        const k = await s.vault.hmacSecrets(s.vault.serviceCaller(SYS_KEYS[name].service), name);
        next.set(name, { secrets: k.secrets.map((v) => v.secret), latest: k.latest, min: k.min });
      } catch (err) {
        if (!(err instanceof HttpProblem) || err.status >= 500) throw err;
        refused.set(name, (err.detail ?? err.title).slice(0, 300));
        s.log.error({ key: name, service: SYS_KEYS[name].service, reason: err.detail ?? err.title }, 'vault: a platform key is refused to its service');
      }
    }
    this.cache.clear();
    for (const [k, v] of next) this.cache.set(k, v);
    this.refused.clear();
    for (const [k, v] of refused) this.refused.set(k, v);
  }

  /** Reads the keys again (a rotation, a retired version or a policy change, here or on another instance). */
  reload(): Promise<void> {
    if (this.state === 'cold' || this.sealedReason) return Promise.resolve();
    return (this.reloading ??= this.load().finally(() => {
      this.reloading = null;
    }));
  }

  /** After a change made here: this instance reloads now, the others when the event reaches them. */
  private async changed(name: string): Promise<void> {
    this.s().bus.publish(TOPICS.vaultSys, { name });
    // `publish` also reaches this instance's listener, which starts a reload; wait for it so the caller sees the change.
    await this.reload();
  }

  /** One `vault.sys.used` entry per key (and so per service) for the uses since the last flush (B-9203). */
  async flushUsage(): Promise<void> {
    const s = this.s();
    if (!this.used.size) return;
    const batch = [...this.used.entries()];
    this.used.clear();
    const tenantId = await platformTenant(s);
    if (!tenantId) return;
    const now = Date.now();
    for (const [name, u] of batch) {
      await s.audit.append({ tenantId, action: 'vault.sys.used', kind: 'system', actor: { service: SYS_KEYS[name].service }, target: { path: sysPath(transitPolicyPath(name)), scope: 'sys' }, label: 'restricted', detail: { uses: u.n, from: u.from, to: now } });
    }
  }

  async close(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.state === 'open') await this.flushUsage().catch(() => undefined);
  }

  // ---- administration (the routes require platform:manage) ----

  async list() {
    const s = this.s();
    const rows = (await s.db('vault_transit_keys').where({ tenant_id: SYS_SCOPE }).orderBy('name')) as { id: string; name: string; type: string; latest_version: number; min_decrypt_version: number; created_at: number; updated_at: number }[];
    const versions = rows.length ? ((await s.db('vault_transit_versions').whereIn('key_id', rows.map((r) => r.id)).orderBy('version')) as { key_id: string; version: number; created_at: number }[]) : [];
    return rows.map((r) => {
      const def = (SYS_KEYS as Record<string, { service: string; uses: string } | undefined>)[r.name];
      return {
        name: r.name,
        path: sysPath(transitPolicyPath(r.name)),
        type: r.type,
        service: def?.service ?? null,
        uses: def?.uses ?? null,
        latestVersion: Number(r.latest_version),
        minVersion: Number(r.min_decrypt_version),
        loaded: this.cache.has(r.name as SysKeyName),
        refused: this.refused.get(r.name as SysKeyName) ?? null,
        createdAt: Number(r.created_at),
        updatedAt: Number(r.updated_at),
        versions: versions.filter((v) => v.key_id === r.id).map((v) => ({ version: Number(v.version), createdAt: Number(v.created_at), accepted: Number(v.version) >= Number(r.min_decrypt_version) }))
      };
    });
  }

  /** A new version: new digests and signatures use it; the versions before it stay accepted until retired. */
  async rotate(p: Principal, name: string, ctx: { ip?: string | null; traceId?: string | null } = {}) {
    await this.open();
    await this.s().vault.rotateKey(this.s().vault.rootCaller(p, ctx), name);
    await this.changed(name);
    return (await this.list()).find((k) => k.name === name)!;
  }

  /** Retires the versions below `minVersion`: what was issued under them is refused from now on. */
  async retire(p: Principal, name: string, minVersion: number, ctx: { ip?: string | null; traceId?: string | null } = {}) {
    await this.open();
    await this.s().vault.configureKey(this.s().vault.rootCaller(p, ctx), name, { minDecryptVersion: minVersion });
    await this.changed(name);
    return (await this.list()).find((k) => k.name === name)!;
  }

  /** After a policy change in the platform scope. */
  async policiesChanged(): Promise<void> {
    if (this.state !== 'cold') await this.changed('*');
  }
}
