import { randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import { json, type Db } from '../db/knex.js';
import { randomToken } from '../crypto/index.js';
import type { GenericLease, GenericLeases } from '../vault/generic-leases.js';
import { asKeySource, mac, macMatches, macs, type KeySource } from '../vault/keyring.js';
import type { Permission } from '../authz/permissions.js';
import type { CredentialStore } from './sessions.js';

export interface ApiKeyRow {
  id: string;
  tenant_id: string;
  user_id: string;
  name: string;
  prefix: string;
  scopes: Permission[];
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  created_at: number;
  /** Sprint 20 (B-1203): an Ed25519 public key (JWK x); when set, every `/v1` request with this key must be signed. */
  signature_key: string | null;
  /** 1.6.0 (B-7701): the agent identity the key was minted for; requests with it act as the agent on the owner's behalf. */
  agent_id: string | null;
  /** 1.6.0 (B-8601): a key limited to one app (and, with `entity`, one entity's records); accepted nowhere else. */
  app_scope: AppKeyScope | null;
  /** 1.7.0 (B-9301): the vault lease the key was issued under; the key is accepted only while that lease is live. */
  lease_id: string | null;
  /** 1.7.0 (B-9206): the lease that holds this key's verifier, when the key is stored as a lease (`exai_k2_`). */
  store_lease_id: string | null;
  /** 1.8.0 (B-146): the most times the key is accepted; null: no limit. */
  max_uses: number | null;
  /** 1.8.0 (B-146): the uses left (an `exai_k2_` key's count lives in its lease; lists read it from there). */
  uses_left: number | null;
}

export interface AppKeyScope {
  app: string;
  entity: string | null;
  /** 1.6.0 (B-8702): the entity names an embedded session reaches (its app's settings); absent or null: every entity. */
  entities?: string[] | null;
}

const KEY_RE = /^exai_k1_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
/** 1.7.0 (B-9206): a key stored as a lease. Its form names its store, so a request still makes one indexed lookup. */
const LEASE_KEY_RE = /^exai_k2_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
/** The lease kind of a personal or agent key (the dynamic keys of B-9301 are the kind `apikey`). */
export const APIKEY_STORE_KIND = 'api-key';
const LEASE_ACTOR = { service: 'identity.api-keys' } as const;
/** What `secret_hash` holds for a key whose verifier is in its lease: a marker no digest equals. */
const inLease = (leaseId: string): string => `lease:${leaseId}`;

/** What a key's lease carries of the key (nothing secret): what a request needs, so it reads the lease alone. */
interface LeasedKeyData {
  keyId: string;
  name: string;
  prefix: string;
  scopes: Permission[];
  signatureKey: string | null;
  agentId: string | null;
  appScope: AppKeyScope | null;
  createdAt: number;
  /** 1.8.0 (B-146): the key's use limit; the lease counts the uses. */
  maxUses?: number | null;
}

const toRow = (r: Record<string, unknown>): ApiKeyRow => ({
  id: String(r.id),
  tenant_id: String(r.tenant_id),
  user_id: String(r.user_id),
  name: String(r.name),
  prefix: String(r.prefix),
  scopes: json<Permission[]>(r.scopes, []),
  expires_at: Number(r.expires_at),
  last_used_at: r.last_used_at == null ? null : Number(r.last_used_at),
  revoked_at: r.revoked_at == null ? null : Number(r.revoked_at),
  created_at: Number(r.created_at),
  signature_key: r.signature_key == null ? null : String(r.signature_key),
  agent_id: r.agent_id == null ? null : String(r.agent_id),
  app_scope: r.app_scope == null ? null : json<AppKeyScope | null>(r.app_scope, null),
  lease_id: r.lease_id == null ? null : String(r.lease_id),
  store_lease_id: r.store_lease_id == null ? null : String(r.store_lease_id),
  max_uses: r.max_uses == null ? null : Number(r.max_uses),
  uses_left: r.uses_left == null ? null : Number(r.uses_left)
});

/** How a key is shown: its form and its prefix, never more (`exai_k2_` for a key stored as a lease, B-9206). */
export const apiKeyPrefix = (k: Pick<ApiKeyRow, 'prefix' | 'store_lease_id'>): string => `exai_k${k.store_lease_id ? 2 : 1}_${k.prefix}`;

export const apiKeyState = (k: ApiKeyRow): 'active' | 'expired' | 'revoked' =>
  k.revoked_at ? 'revoked' : k.expires_at <= Date.now() ? 'expired' : 'active';

/**
 * Personal API keys: `exai_k1_<prefix>_<secret>`. The full key is shown once; we keep the prefix (to find the row
 * and show it in lists) and HMAC(secret, key). A key's scopes are a subset of its owner's permissions at creation,
 * and are intersected with the owner's current roles on every request, so demoting a user demotes their keys.
 *
 * 1.7.0 (B-9206): with CREDENTIAL_STORE=leases a new key is `exai_k2_<prefix>_<secret>` and its verifier lives in a
 * lease of kind `api-key` in `vault_leases`, with what a request needs of the key in the lease's data. The row of
 * `api_keys` stays as the key's record (name, lists, the ids other tables point at) and holds no verifier. Revoking
 * the key revokes the lease and the other way round. `exai_k1_` keys are read from `api_keys` as before, always.
 */
export class ApiKeyService {
  private readonly used = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly secret: string | KeySource,
    /** 1.7.0 (B-9301): whether a lease is live now (cached and dropped on revoke by the lease table). */
    private readonly leaseLive: (leaseId: string) => Promise<boolean> = async () => false,
    /** 1.7.0 (B-9206): where new keys are kept, and the lease table (lazy: it is built after this service). */
    private readonly opts: {
      store?: CredentialStore;
      leases?: () => GenericLeases;
      /** 1.8.0 (B-146): told once when a use-limited key spent its last use and was revoked (audit, the owner's notice). */
      onExhausted?: (row: ApiKeyRow) => Promise<void>;
    } = {}
  ) {}

  private get leases(): GenericLeases | null {
    return this.opts.leases?.() ?? null;
  }

  /** Whether new keys are leases. */
  get store(): CredentialStore {
    return this.opts.store === 'leases' && this.opts.leases ? 'leases' : 'table';
  }

  /** Registers the lease kind: a key's lease that is revoked (from the vault, or by a sweep) revokes the key's record. */
  registerLeaseKind(): void {
    this.leases?.registerKind(APIKEY_STORE_KIND, {
      end: async (lease, reason) => {
        if (reason === 'revoked') await this.db('api_keys').where({ store_lease_id: lease.id, revoked_at: null }).update({ revoked_at: Date.now() });
      }
    });
  }

  /** Under the `api-key` key's current version (1.7.0, B-9205); `matches` accepts every accepted version. */
  private digest(key: string): string {
    return mac(asKeySource(this.secret), 'apikey:' + key);
  }

  private matches(key: string, hash: string): boolean {
    return macMatches(asKeySource(this.secret), 'apikey:' + key, hash);
  }

  async create(input: { tenantId: string; userId: string; name: string; scopes: Permission[]; ttlDays: number; signatureKey?: string | null; agentId?: string | null; appScope?: AppKeyScope | null; leaseId?: string | null; expiresAt?: number; maxUses?: number | null }): Promise<{ key: string; row: ApiKeyRow }> {
    const prefix = randomBytes(6).toString('hex');
    const t = Date.now();
    const expiresAt = input.expiresAt ?? t + input.ttlDays * 86400_000;
    // A key issued under a dynamic lease (B-9301) is its own lease's; it stays a row whichever store is chosen.
    const leased = this.store === 'leases' && !input.leaseId && expiresAt > t + 1000;
    const key = `exai_k${leased ? 2 : 1}_${prefix}_${randomToken(32)}`;
    const storeLeaseId = leased ? ulid() : null;
    const scopes = [...new Set(input.scopes)].sort();
    const row = {
      id: ulid(),
      tenant_id: input.tenantId,
      user_id: input.userId,
      name: input.name,
      prefix,
      secret_hash: storeLeaseId ? inLease(storeLeaseId) : this.digest(key),
      scopes: JSON.stringify(scopes),
      expires_at: expiresAt,
      last_used_at: null,
      revoked_at: null,
      created_at: t,
      signature_key: input.signatureKey ?? null,
      agent_id: input.agentId ?? null,
      app_scope: input.appScope ? JSON.stringify(input.appScope) : null,
      lease_id: input.leaseId ?? null,
      store_lease_id: storeLeaseId,
      // 1.8.0 (B-146): a key stored as a lease counts its uses in the lease; the row keeps the limit for lists.
      max_uses: input.maxUses ?? null,
      uses_left: input.maxUses && !storeLeaseId ? input.maxUses : null
    };
    await this.db('api_keys').insert(row);
    if (storeLeaseId) {
      const data: LeasedKeyData = { keyId: row.id, name: row.name, prefix, scopes, signatureKey: row.signature_key, agentId: row.agent_id, appScope: input.appScope ?? null, createdAt: t, ...(input.maxUses ? { maxUses: input.maxUses } : {}) };
      const life = Math.max(1, Math.ceil((expiresAt - t) / 1000));
      try {
        // No idle timeout: the renew period is the whole life, and a use does not renew it.
        await this.leases!.issue({ id: storeLeaseId, tenantId: input.tenantId, kind: APIKEY_STORE_KIND, holderKind: 'user', holder: input.userId, ref: row.id, verifier: this.digest(key), label: 'internal', data: { ...data }, renewPeriodSeconds: life, maxLifetimeSeconds: life, ...(input.maxUses ? { maxUses: input.maxUses } : {}), actor: LEASE_ACTOR });
      } catch (err) {
        await this.db('api_keys').where({ id: row.id }).delete();
        throw err;
      }
    }
    return { key, row: toRow(row) };
  }

  /** A key stored as a lease: the lease is found by the key's digest and carries what the request needs. */
  private async verifyLeased(key: string): Promise<ApiKeyRow | null> {
    const h = await this.leases?.held(macs(asKeySource(this.secret), 'apikey:' + key));
    if (!h || h.lease.kind !== APIKEY_STORE_KIND) return null;
    let row = this.fromLease(h.lease);
    // 1.8.0 (B-146): a use-limited key spends one use of its lease, which decides across instances.
    if (row.max_uses != null) {
      const spent = await this.leases!.spend(h.lease.id);
      if (!spent.ok) {
        await this.exhaust(row);
        return null;
      }
      row = { ...row, uses_left: spent.left };
      if (spent.left === 0) await this.exhaust(row);
    }
    const now = Date.now();
    const last = this.used.get(row.id) ?? 0;
    if (now - last > 60_000) {
      this.used.set(row.id, now);
      if (this.used.size > 50_000) this.used.clear();
      await this.db('api_keys').where({ id: row.id }).update({ last_used_at: now });
    }
    return { ...row, last_used_at: last || now };
  }

  private fromLease(l: GenericLease): ApiKeyRow {
    const d = l.data as unknown as LeasedKeyData;
    return {
      id: String(d.keyId),
      tenant_id: l.tenantId,
      user_id: String(l.holder ?? ''),
      name: String(d.name ?? ''),
      prefix: String(d.prefix ?? ''),
      scopes: Array.isArray(d.scopes) ? d.scopes : [],
      expires_at: l.maxExpiresAt,
      last_used_at: null,
      revoked_at: null,
      created_at: Number(d.createdAt ?? l.issuedAt),
      signature_key: d.signatureKey ?? null,
      agent_id: d.agentId ?? null,
      app_scope: d.appScope ?? null,
      lease_id: null,
      store_lease_id: l.id,
      max_uses: d.maxUses ?? null,
      uses_left: l.usesLeft
    };
  }

  /**
   * 1.8.0 (B-146): a use-limited key that has no use left is revoked here, through the key service (its record, then
   * its lease), and the instance that revoked it tells `onExhausted` once (the audit entry and the owner's notice).
   */
  private async exhaust(row: ApiKeyRow): Promise<void> {
    const n = await this.revokeRows({ id: row.id });
    if (n && this.opts.onExhausted) await this.opts.onExhausted({ ...row, uses_left: 0, revoked_at: Date.now() }).catch(() => undefined);
  }

  /**
   * 1.8.0 (B-146): spends one use of an `exai_k1_` key: one conditional update (`uses_left > 0`), so concurrent
   * requests on any instance never pass the limit. Null when no use is left.
   */
  private async spendRow(row: ApiKeyRow): Promise<ApiKeyRow | null> {
    const n = await this.db('api_keys').where({ id: row.id, revoked_at: null }).andWhere('uses_left', '>', 0).decrement('uses_left', 1);
    if (!n) {
      await this.exhaust(row);
      return null;
    }
    const r = (await this.db('api_keys').where({ id: row.id }).first('uses_left')) as { uses_left: unknown } | undefined;
    const left = Math.max(0, Number(r?.uses_left ?? 0));
    const after = { ...row, uses_left: left };
    if (left === 0) await this.exhaust(after);
    return after;
  }

  /** 1.8.0 (B-146): the uses left of keys stored as leases, read from their leases (one query), for lists. */
  async withUses(rows: ApiKeyRow[]): Promise<ApiKeyRow[]> {
    const ids = rows.filter((r) => r.max_uses != null && r.store_lease_id).map((r) => r.store_lease_id!);
    if (!ids.length) return rows;
    const left = new Map(((await this.db('vault_leases').whereIn('id', ids).select('id', 'uses_left')) as { id: string; uses_left: unknown }[]).map((l) => [l.id, l.uses_left == null ? null : Number(l.uses_left)]));
    return rows.map((r) => (r.store_lease_id && left.has(r.store_lease_id) ? { ...r, uses_left: r.revoked_at ? 0 : (left.get(r.store_lease_id) ?? null) } : r));
  }

  /** Ends the leases of keys that were just revoked, so the keys stop being accepted at once on every instance. */
  private async endLeases(rows: { tenant_id: string; store_lease_id: string | null }[]): Promise<void> {
    for (const r of rows) if (r.store_lease_id) await this.leases?.revoke(String(r.tenant_id), r.store_lease_id, LEASE_ACTOR).catch(() => undefined);
  }

  /** Revokes the live keys a query selects: their records, then the leases of those that are leases. */
  private async revokeRows(where: Record<string, unknown>): Promise<number> {
    const rows = (await this.db('api_keys').where({ ...where, revoked_at: null }).select('id', 'tenant_id', 'store_lease_id')) as { id: string; tenant_id: string; store_lease_id: string | null }[];
    if (!rows.length) return 0;
    const n = await this.db('api_keys').whereIn('id', rows.map((r) => r.id)).andWhere({ revoked_at: null }).update({ revoked_at: Date.now() });
    await this.endLeases(rows);
    return Number(n);
  }

  /**
   * Ends the leases of keys whose record says revoked. The key service revokes both together; a build from before
   * B-9206 (run again after this one, or beside it during a rolling deploy) updates the record alone, and without
   * this its revocation would be forgotten when this build reads the lease. Run at start and with the housekeeping.
   */
  async reconcileLeases(): Promise<number> {
    if (!this.leases) return 0;
    const rows = (await this.db('api_keys as k').join('vault_leases as l', 'l.id', 'k.store_lease_id').whereNotNull('k.revoked_at').andWhere('l.state', 'active').select('k.tenant_id', 'k.store_lease_id')) as { tenant_id: string; store_lease_id: string }[];
    await this.endLeases(rows);
    return rows.length;
  }

  /** Resolves a presented key to its row if it is well-formed, matches, and is active. */
  async verify(key: string): Promise<ApiKeyRow | null> {
    if (LEASE_KEY_RE.test(key)) return this.verifyLeased(key);
    const m = KEY_RE.exec(key);
    if (!m) return null;
    const r = await this.db('api_keys').where({ prefix: m[1] }).first();
    if (!r || !this.matches(key, String(r.secret_hash))) return null;
    let row = toRow(r);
    if (apiKeyState(row) !== 'active') return null;
    // A leased key is its lease: revoked, expired or idle past its renew period, the key is refused (B-9301).
    if (row.lease_id && !(await this.leaseLive(row.lease_id))) return null;
    // 1.8.0 (B-146): a use-limited key spends a use; a key without a limit makes no extra round trip.
    if (row.max_uses != null) {
      const spent = await this.spendRow(row);
      if (!spent) return null;
      row = spent;
    }
    if (!row.last_used_at || Date.now() - row.last_used_at > 60_000) {
      await this.db('api_keys').where({ id: row.id }).update({ last_used_at: Date.now() });
    }
    return row;
  }

  /** 1.6.0 (B-7701): the keys minted for an agent identity (any owner); revoked and expired ones stay listed for 30 days. */
  async listForAgent(agentId: string): Promise<ApiKeyRow[]> {
    const cutoff = Date.now() - 30 * 86400_000;
    const rows = await this.db('api_keys')
      .where({ agent_id: agentId })
      .andWhere((w) => w.whereNull('revoked_at').orWhere('revoked_at', '>', cutoff))
      .andWhere('expires_at', '>', cutoff)
      .orderBy('created_at', 'desc');
    return this.withUses(rows.map(toRow));
  }

  async revokeForAgent(agentId: string, id: string): Promise<boolean> {
    return (await this.revokeRows({ agent_id: agentId, id })) > 0;
  }

  /** The scopes of a key, narrowed (an agent identity lost a role): the record, and the lease a request reads. */
  async setScopes(id: string, scopes: Permission[]): Promise<void> {
    const kept = [...new Set(scopes)].sort();
    await this.db('api_keys').where({ id }).update({ scopes: JSON.stringify(kept) });
    const r = (await this.db('api_keys').where({ id }).first('store_lease_id')) as { store_lease_id: string | null } | undefined;
    if (r?.store_lease_id) await this.leases?.patch(r.store_lease_id, { scopes: kept });
  }

  /** Lists a user's keys (their personal ones, not those minted for agents or issued under a vault lease); expired and revoked keys stay listed for 30 days. */
  async listForUser(userId: string): Promise<ApiKeyRow[]> {
    const cutoff = Date.now() - 30 * 86400_000;
    const rows = await this.db('api_keys')
      .where({ user_id: userId })
      .whereNull('agent_id')
      .whereNull('lease_id')
      .andWhere((w) => w.whereNull('revoked_at').orWhere('revoked_at', '>', cutoff))
      .andWhere('expires_at', '>', cutoff)
      .orderBy('created_at', 'desc');
    return this.withUses(rows.map(toRow));
  }

  /** Sprint 20 (B-1203): sets or clears the public key that `/v1` requests made with this key must be signed with. */
  async setSignatureKey(userId: string, id: string, publicKey: string | null): Promise<ApiKeyRow | null> {
    const n = await this.db('api_keys').where({ user_id: userId, id, revoked_at: null }).update({ signature_key: publicKey });
    if (!n) return null;
    const row = toRow(await this.db('api_keys').where({ id }).first());
    if (row.store_lease_id) await this.leases?.patch(row.store_lease_id, { signatureKey: publicKey });
    return row;
  }

  async revoke(userId: string, id: string): Promise<boolean> {
    return (await this.revokeRows({ user_id: userId, id })) > 0;
  }

  /** 1.7.0 (B-9301): ends the key of a lease that ended. */
  async revokeLeased(leaseId: string, id: string): Promise<boolean> {
    return (await this.db('api_keys').where({ id, lease_id: leaseId, revoked_at: null }).update({ revoked_at: Date.now() })) > 0;
  }

  async get(id: string): Promise<ApiKeyRow | null> {
    const r = await this.db('api_keys').where({ id }).first();
    return r ? toRow(r) : null;
  }

  async revokeAllForUser(userId: string): Promise<number> {
    return this.revokeRows({ user_id: userId });
  }

  /** Every live key of a tenant (the tenant is being offboarded). */
  async revokeAllForTenant(tenantId: string): Promise<number> {
    return this.revokeRows({ tenant_id: tenantId });
  }
}
