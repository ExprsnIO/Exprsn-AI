import { ulid } from 'ulid';
import { json } from '../db/knex.js';
import { clears, type Label } from '../authz/labels.js';
import { isPermission, permissionsFor, type Permission } from '../authz/permissions.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { actorFrom, type AuditActor, type AuditKind } from '../audit/chain.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { scrubError } from '../platform/diagnostics.js';
import { guardedRequest, ServiceUrlRefused, toolAddressProblem, type ServicePolicy } from '../platform/egress.js';
import type { Services } from '../services.js';
import type { ApiKeyProvider, ApiKeyProviders, ProviderTarget } from './apikey-providers.js';
import type { GenericLease, GenericLeaseState } from './generic-leases.js';
import { apiKeyPolicyPath, parseVaultRef, SYS_SCOPE } from './policy.js';
import type { VaultCaller } from './service.js';

/*
 * 1.7.0, Sprint 41 (B-9301, B-9302): dynamic API-key leases, ported from exprsn-platform's dynamic API-key secrets
 * (decision D11f) onto the generic lease table (`vault_leases`, kind `apikey`).
 *
 * - A provider makes keys. `exprsn` is built in: it issues this server's own API keys (B-9301). An outside provider
 *   is a row of `vault_apikey_providers` registered by a holder of `secrets:admin`, with its admin credential as a
 *   `vault:path#key` reference read as that person; its calls go through the outbound address guard, and a public
 *   host must be on the tenant's list of allowed hosts (B-9302). A tenant without such a row has no outside provider,
 *   and nothing is called.
 * - A role names a scope set and a lifetime. Reading its credential path (`apikey/<provider>/<role>`, capability
 *   `read` in the vault policy) issues a fresh key whose life is the lease's. For `exprsn` the key belongs to the
 *   reader and carries the role's scopes that the reader holds, so it never exceeds the role nor the reader; like
 *   every API key it is intersected with its owner's roles on each request.
 * - The key is in the issue response only. An `exprsn` key is stored as every API key is (a digest); an outside key
 *   is kept sealed with its lease only when the provider needs it to revoke.
 * - A leased `exprsn` key is accepted only while its lease is live (`ApiKeyService.verify` asks the lease table,
 *   which drops a revoked lease on every instance at once). When a lease ends, by revocation or by the sweeper at
 *   expiry, the key is revoked here or at its provider; a provider that fails leaves the lease in `revoking`, retried
 *   with back-off.
 * - Workflows, HTTP tools and plugins read a lease by reference: `vault:apikey:<provider>/<role>#key`, resolved like
 *   any vault reference as the person who saved it. Each read issues a fresh key.
 */

export const EXPRSN_PROVIDER = 'exprsn';
export const APIKEY_LEASE_KIND = 'apikey';
export const APIKEY_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PROVIDER_TIMEOUT_MS = 10_000;
const PROVIDER_MAX_BYTES = 256 * 1024;

interface ProviderRow {
  id: string;
  tenant_id: string;
  name: string;
  kind: string;
  endpoint: string;
  label: Label;
  config: string;
  credential_ref: string | null;
  owner_id: string | null;
  state: 'active' | 'disabled';
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

interface RoleRow {
  id: string;
  tenant_id: string;
  provider: string;
  name: string;
  scopes: string;
  config: string;
  ttl_s: number | null;
  max_ttl_s: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));
const providerFrom = (r: Record<string, unknown>): ProviderRow => ({ ...(r as unknown as ProviderRow), created_at: num(r.created_at), updated_at: num(r.updated_at) });
const roleFrom = (r: Record<string, unknown>): RoleRow => ({ ...(r as unknown as RoleRow), ttl_s: numOrNull(r.ttl_s), max_ttl_s: numOrNull(r.max_ttl_s), created_at: num(r.created_at), updated_at: num(r.updated_at) });

interface Ctx {
  ip?: string | null;
  traceId?: string | null;
}

export interface ApiKeyProviderInput {
  name: string;
  kind: string;
  endpoint?: string | undefined;
  label?: Label | undefined;
  config: unknown;
  credentialRef: string;
}

export interface ApiKeyRoleInput {
  scopes: string[];
  config?: unknown;
  ttlSeconds?: number | null | undefined;
  maxTtlSeconds?: number | null | undefined;
}

/** What a lease's `data` holds. `sealed` is the outside key, kept for the provider's revoke; it is never shown. */
interface LeaseData {
  provider: string;
  providerKind: string;
  role: string;
  scopes: string[];
  keyId?: string;
  prefix?: string;
  sealed?: string | null;
  detail?: Record<string, unknown>;
}

const leaseRef = (provider: string, role: string, id: string): string => `${provider}/${role}/${id}`;
const sealAad = (leaseId: string): string => `apikey-lease:${leaseId}`;

export const apiKeyLeaseView = (l: GenericLease) => {
  const d = l.data as unknown as LeaseData;
  return {
    id: l.id,
    provider: d.provider,
    providerKind: d.providerKind,
    role: d.role,
    scopes: d.scopes ?? [],
    keyPrefix: d.prefix ?? null,
    detail: d.detail ?? null,
    label: l.label,
    state: l.state,
    issuedTo: l.holder,
    issuedAt: l.issuedAt,
    expiresAt: l.expiresAt,
    maxExpiresAt: l.maxExpiresAt,
    renewals: l.renewals,
    endedAt: l.endedAt,
    endReason: l.endReason,
    attempts: l.attempts,
    lastError: l.lastError
  };
};

export class ApiKeyLeases {
  private registered = false;

  constructor(
    private readonly s: () => Services,
    private readonly opts: { providers: ApiKeyProviders; policy: ServicePolicy; defaultTtlS: number; maxTtlS: number; maxActive: number }
  ) {}

  private get db() {
    return this.s().db;
  }

  /** Registers the lease kind's end handler. Idempotent; called at start and before the first lease. */
  register(): void {
    if (this.registered) return;
    this.registered = true;
    this.s().leases.registerKind(APIKEY_LEASE_KIND, { end: (lease) => this.endKey(lease) });
  }

  static isAdmin(p: Principal): boolean {
    return effectivePermissions(p).has('secrets:admin');
  }

  private audit(tenantId: string, action: string, kind: AuditKind, actor: AuditActor, target: Record<string, unknown>, label: Label, detail?: Record<string, unknown>, traceId?: string | null) {
    return this.s().audit.append({ tenantId, action, kind, actor, target, label, ...(detail ? { detail } : {}), traceId: traceId ?? null });
  }

  // ---------- providers (secrets:admin) ----------

  /** The provider kinds this server can talk to, and what each needs. None is configured until a tenant registers one. */
  kinds() {
    return Object.values(this.opts.providers).map((p) => ({ kind: p.kind, title: p.title, defaultEndpoint: p.defaultEndpoint, needs: p.needs }));
  }

  private kind(name: string): ApiKeyProvider {
    const k = this.opts.providers[name];
    if (!k) throw badRequest(`No provider kind ${name}. Known kinds: ${Object.keys(this.opts.providers).join(', ') || 'none'}.`);
    return k;
  }

  private async providerRow(tenantId: string, name: string, clearance: Label): Promise<ProviderRow> {
    const r = await this.db('vault_apikey_providers').where({ tenant_id: tenantId, name }).first();
    if (!r) throw notFound('Provider');
    const row = providerFrom(r);
    if (!clears(clearance, row.label)) throw notFound('Provider');
    return row;
  }

  private rolesOf(tenantId: string, provider: string): Promise<RoleRow[]> {
    return this.db('vault_apikey_roles').where({ tenant_id: tenantId, provider }).orderBy('name').then((rows: Record<string, unknown>[]) => rows.map(roleFrom));
  }

  private roleView(r: RoleRow) {
    return { name: r.name, scopes: json<string[]>(r.scopes, []), config: json<Record<string, unknown>>(r.config, {}), ttlSeconds: r.ttl_s ?? this.opts.defaultTtlS, maxTtlSeconds: r.max_ttl_s ?? this.opts.maxTtlS, path: apiKeyPolicyPath(r.provider, r.name), reference: `vault:apikey:${r.provider}/${r.name}#key` };
  }

  private async liveLeases(tenantId: string, provider: string, role?: string): Promise<number> {
    const r = (await this.db('vault_leases')
      .where({ tenant_id: tenantId, kind: APIKEY_LEASE_KIND })
      .whereIn('state', ['active', 'revoking'])
      .andWhere('ref', 'like', `${provider}/${role ? role + '/' : ''}%`)
      .count({ n: '*' })
      .first()) as { n: number | string } | undefined;
    return Number(r?.n ?? 0);
  }

  private async providerView(p: ProviderRow) {
    const kind = this.opts.providers[p.kind];
    return {
      name: p.name,
      kind: p.kind,
      title: kind?.title ?? p.kind,
      endpoint: p.endpoint,
      label: p.label,
      config: json<Record<string, unknown>>(p.config, {}),
      credentialRef: p.credential_ref,
      // Without its admin credential (or a kind this server knows) a provider issues nothing.
      configured: Boolean(p.credential_ref) && Boolean(kind),
      state: p.state,
      ownerId: p.owner_id,
      roles: (await this.rolesOf(p.tenant_id, p.name)).map((r) => this.roleView(r)),
      liveLeases: await this.liveLeases(p.tenant_id, p.name),
      createdAt: p.created_at,
      updatedAt: p.updated_at
    };
  }

  /** The built-in provider and the tenant's outside ones. */
  async listProviders(p: Principal) {
    const rows = ((await this.db('vault_apikey_providers').where({ tenant_id: p.tenantId }).orderBy('name')) as Record<string, unknown>[]).map(providerFrom).filter((r) => clears(p.clearance, r.label));
    const builtin = {
      name: EXPRSN_PROVIDER,
      kind: EXPRSN_PROVIDER,
      title: 'Exprsn-AI API keys',
      endpoint: null,
      label: 'internal' as Label,
      config: {},
      credentialRef: null,
      configured: true,
      state: 'active' as const,
      ownerId: null,
      roles: (await this.rolesOf(p.tenantId, EXPRSN_PROVIDER)).map((r) => this.roleView(r)),
      liveLeases: await this.liveLeases(p.tenantId, EXPRSN_PROVIDER),
      createdAt: null,
      updatedAt: null
    };
    return { providers: [builtin, ...(await Promise.all(rows.map((r) => this.providerView(r))))], kinds: this.kinds() };
  }

  private endpoint(input: string | undefined, kind: ApiKeyProvider): string {
    const raw = (input ?? kind.defaultEndpoint).replace(/\/+$/, '');
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw badRequest('The endpoint is a URL such as https://api.github.com.');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw badRequest('The endpoint starts with https:// (or http:// for a host the operator allows).');
    if (url.username || url.password || url.search || url.hash) throw badRequest('The endpoint is a scheme, a host and an optional path: no credentials, query or fragment.');
    return raw;
  }

  private credentialRef(ref: string): string {
    if (!parseVaultRef(ref)) throw badRequest('The admin credential is a vault reference to a KV value: vault:<path>#<key>.');
    return ref;
  }

  async registerProvider(p: Principal, input: ApiKeyProviderInput, ctx: Ctx = {}) {
    if (input.name === EXPRSN_PROVIDER) throw badRequest(`${EXPRSN_PROVIDER} is the built-in provider; choose another name.`);
    const kind = this.kind(input.kind);
    const config = kind.providerConfig(input.config);
    const endpoint = this.endpoint(input.endpoint, kind);
    const label = input.label ?? 'internal';
    if (!clears(p.clearance, label)) throw forbidden(`Your clearance ${p.clearance} does not reach the label ${label}.`, { step: 'clearance' });
    await this.s().vault.assertRefsReadable(p, [this.credentialRef(input.credentialRef)], ctx);
    if (await this.db('vault_apikey_providers').where({ tenant_id: p.tenantId, name: input.name }).first('id')) throw conflict(`A provider named ${input.name} exists.`);
    const now = Date.now();
    const row: ProviderRow = { id: ulid(), tenant_id: p.tenantId, name: input.name, kind: kind.kind, endpoint, label, config: JSON.stringify(config), credential_ref: input.credentialRef, owner_id: p.userId, state: 'active', created_by: p.userId, created_at: now, updated_at: now };
    await this.db('vault_apikey_providers').insert(row);
    await this.audit(p.tenantId, 'vault.apikey.provider.registered', 'admin', actorFrom(p, ctx.ip), { provider: row.name, kind: row.kind }, label, { endpoint, config, credentialRef: input.credentialRef }, ctx.traceId);
    return this.providerView(row);
  }

  async updateProvider(p: Principal, name: string, patch: { endpoint?: string | undefined; label?: Label | undefined; config?: unknown; credentialRef?: string | undefined; state?: 'active' | 'disabled' | undefined }, ctx: Ctx = {}) {
    const row = await this.providerRow(p.tenantId, name, p.clearance);
    const kind = this.kind(row.kind);
    const upd: Partial<ProviderRow> = { updated_at: Date.now() };
    if (patch.endpoint !== undefined) upd.endpoint = this.endpoint(patch.endpoint, kind);
    if (patch.config !== undefined) upd.config = JSON.stringify(kind.providerConfig(patch.config));
    if (patch.label !== undefined) {
      if (!clears(p.clearance, patch.label)) throw forbidden(`Your clearance ${p.clearance} does not reach the label ${patch.label}.`, { step: 'clearance' });
      upd.label = patch.label;
    }
    if (patch.credentialRef !== undefined) {
      await this.s().vault.assertRefsReadable(p, [this.credentialRef(patch.credentialRef)], ctx);
      upd.credential_ref = patch.credentialRef;
      upd.owner_id = p.userId; // the reference is read as whoever saved it last
    }
    if (patch.state !== undefined) upd.state = patch.state;
    await this.db('vault_apikey_providers').where({ id: row.id }).update(upd);
    await this.audit(p.tenantId, 'vault.apikey.provider.updated', 'admin', actorFrom(p, ctx.ip), { provider: row.name, kind: row.kind }, upd.label ?? row.label, { changed: Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined) }, ctx.traceId);
    return this.providerView({ ...row, ...upd });
  }

  async removeProvider(p: Principal, name: string, ctx: Ctx = {}): Promise<void> {
    const row = await this.providerRow(p.tenantId, name, p.clearance);
    const live = await this.liveLeases(p.tenantId, row.name);
    if (live) throw conflict(`${row.name} has ${live} live lease${live === 1 ? '' : 's'}. Revoke them first: their keys can only be revoked at the provider while it is registered.`);
    await this.db.transaction(async (trx) => {
      await trx('vault_apikey_roles').where({ tenant_id: p.tenantId, provider: row.name }).delete();
      await trx('vault_apikey_providers').where({ id: row.id }).delete();
    });
    await this.audit(p.tenantId, 'vault.apikey.provider.removed', 'admin', actorFrom(p, ctx.ip), { provider: row.name, kind: row.kind }, row.label, undefined, ctx.traceId);
  }

  // ---------- roles (secrets:admin) ----------

  async putRole(p: Principal, provider: string, roleName: string, input: ApiKeyRoleInput, ctx: Ctx = {}) {
    let scopes: string[];
    let config: Record<string, unknown>;
    let label: Label = 'internal';
    if (provider === EXPRSN_PROVIDER) {
      scopes = [...new Set(input.scopes)].sort();
      const unknown = scopes.filter((x) => !isPermission(x));
      if (!scopes.length) throw badRequest('A role names at least one scope (a permission such as chat:read).');
      if (unknown.length) throw badRequest(`Not a permission: ${unknown.slice(0, 5).join(', ')}.`);
      if (input.config !== undefined && input.config !== null && Object.keys(input.config as object).length) throw badRequest('A role of the built-in provider has no configuration of its own.');
      config = {};
    } else {
      const row = await this.providerRow(p.tenantId, provider, p.clearance);
      label = row.label;
      ({ scopes, config } = this.kind(row.kind).role({ scopes: input.scopes, config: input.config ?? {} }));
    }
    const max = input.maxTtlSeconds ?? null;
    const ttl = input.ttlSeconds ?? null;
    if (max != null && max > this.opts.maxTtlS) throw badRequest(`A lease lives ${this.opts.maxTtlS} seconds at most (VAULT_LEASE_MAX_TTL_SECONDS).`);
    if ((ttl ?? this.opts.defaultTtlS) > (max ?? this.opts.maxTtlS)) throw badRequest('The lifetime cannot be longer than the maximum lifetime.');
    const now = Date.now();
    const existing = await this.db('vault_apikey_roles').where({ tenant_id: p.tenantId, provider, name: roleName }).first();
    const row: RoleRow = { id: existing ? String((existing as { id: string }).id) : ulid(), tenant_id: p.tenantId, provider, name: roleName, scopes: JSON.stringify(scopes), config: JSON.stringify(config), ttl_s: ttl, max_ttl_s: max, created_by: existing ? ((existing as { created_by: string | null }).created_by ?? null) : p.userId, created_at: existing ? num((existing as { created_at: unknown }).created_at) : now, updated_at: now };
    if (existing) await this.db('vault_apikey_roles').where({ id: row.id }).update({ scopes: row.scopes, config: row.config, ttl_s: ttl, max_ttl_s: max, updated_at: now });
    else await this.db('vault_apikey_roles').insert(row);
    await this.audit(p.tenantId, 'vault.apikey.role.saved', 'admin', actorFrom(p, ctx.ip), { provider, role: roleName }, label, { scopes, config, ttlSeconds: ttl, maxTtlSeconds: max }, ctx.traceId);
    return { provider, ...this.roleView(row) };
  }

  async removeRole(p: Principal, provider: string, roleName: string, ctx: Ctx = {}): Promise<void> {
    if (provider !== EXPRSN_PROVIDER) await this.providerRow(p.tenantId, provider, p.clearance);
    const r = await this.db('vault_apikey_roles').where({ tenant_id: p.tenantId, provider, name: roleName }).first('id');
    if (!r) throw notFound('Role');
    await this.db('vault_apikey_roles').where({ id: (r as { id: string }).id }).delete();
    // Leases already issued run to their end: their scopes were fixed when they were issued.
    await this.audit(p.tenantId, 'vault.apikey.role.removed', 'admin', actorFrom(p, ctx.ip), { provider, role: roleName }, 'internal', undefined, ctx.traceId);
  }

  /** The roles the caller may see or take a lease for (their policy's `list` or `read` on the role path). */
  async issuableRoles(p: Principal) {
    const providers = new Map(((await this.db('vault_apikey_providers').where({ tenant_id: p.tenantId })) as Record<string, unknown>[]).map(providerFrom).map((r) => [r.name, r]));
    const roles = ((await this.db('vault_apikey_roles').where({ tenant_id: p.tenantId }).orderBy('provider').orderBy('name')) as Record<string, unknown>[]).map(roleFrom).filter((r) => {
      if (r.provider === EXPRSN_PROVIDER) return true;
      const row = providers.get(r.provider);
      return row != null && clears(p.clearance, row.label);
    });
    if (!roles.length) return [];
    const c = await this.s().vault.callerFor(p);
    const paths = roles.map((r) => apiKeyPolicyPath(r.provider, r.name));
    const [canList, canRead] = await Promise.all([this.s().vault.allowedPaths(c, paths, 'list'), this.s().vault.allowedPaths(c, paths, 'read')]);
    return roles
      .filter((_, i) => canList.has(paths[i]!) || canRead.has(paths[i]!))
      .map((r) => {
        const row = providers.get(r.provider);
        const ready = r.provider === EXPRSN_PROVIDER || (row != null && row.state === 'active' && Boolean(row.credential_ref));
        return { provider: r.provider, providerKind: row?.kind ?? EXPRSN_PROVIDER, ...this.roleView(r), canIssue: canRead.has(apiKeyPolicyPath(r.provider, r.name)) && ready };
      });
  }

  // ---------- calls to an outside provider ----------

  private target(row: ProviderRow, traceId?: string | null): ProviderTarget {
    const s = this.s();
    return {
      tenantId: row.tenant_id,
      name: row.name,
      endpoint: row.endpoint,
      config: json<Record<string, unknown>>(row.config, {}),
      credential: () => {
        if (!row.credential_ref) throw new HttpProblem(409, 'Conflict', `${row.name} has no admin credential yet, so it issues and revokes nothing. Give it a vault reference.`, { extensions: { step: 'apikey-provider-unconfigured' } });
        return s.vault.resolveFor(row.tenant_id, row.owner_id, row.credential_ref, { via: `apikey-provider:${row.name}`, traceId: traceId ?? null });
      },
      request: async (r) => {
        const tenant = await s.integrations.allowList(row.tenant_id);
        const secrets = [r.headers.authorization?.replace(/^Bearer\s+/i, '')];
        try {
          const res = await guardedRequest({
            method: r.method,
            url: new URL(row.endpoint + r.path),
            headers: { ...r.headers, ...(r.body !== undefined ? { 'content-type': 'application/json' } : {}) },
            ...(r.body !== undefined ? { body: JSON.stringify(r.body) } : {}),
            timeoutMs: PROVIDER_TIMEOUT_MS,
            maxBytes: PROVIDER_MAX_BYTES,
            check: (address, host) => toolAddressProblem(address, host, this.opts.policy, tenant)
          });
          let body: unknown = null;
          if (res.body.length) {
            try {
              body = JSON.parse(res.body.toString('utf8'));
            } catch {
              body = null;
            }
          }
          return { status: res.status, body };
        } catch (err) {
          if (err instanceof ServiceUrlRefused) throw new HttpProblem(409, 'Conflict', `The address of provider ${row.name} is refused: ${err.message}`, { extensions: { step: 'egress' } });
          throw new HttpProblem(502, 'Provider unreachable', `Provider ${row.name} did not answer: ${scrubError(err, secrets).slice(0, 300)}`, { extensions: { step: 'apikey-provider' } });
        }
      }
    };
  }

  // ---------- leases ----------

  /**
   * Issues a lease and its key for the caller (the reader of the credential path, or the owner of a saved
   * reference). `within` narrows an `exprsn` key further (the scopes of the credential the request came with).
   */
  async issue(c: VaultCaller, provider: string, roleName: string, input: { ttlSeconds?: number | undefined; within?: Set<Permission> | undefined; agentId?: string | null | undefined } = {}) {
    this.register();
    const s = this.s();
    const userId = c.subjects.userId;
    if (!userId || c.tenantId === SYS_SCOPE) throw forbidden('An API-key lease is issued to a person; this caller is not one.', { step: 'vault-owner' });
    await s.vault.authorize(c, apiKeyPolicyPath(provider, roleName), 'read');
    // A leased key takes no lease: a chain of keys would outlive the revocation of the first.
    if (c.subjects.apiKeyId && (await s.apiKeys.get(c.subjects.apiKeyId))?.lease_id) throw forbidden('A key issued from a lease cannot take a lease itself.', { step: 'apikey-lease-chain' });
    const r = await this.db('vault_apikey_roles').where({ tenant_id: c.tenantId, provider, name: roleName }).first();
    if (!r) throw notFound('Role');
    const role = roleFrom(r);
    const roleScopes = json<string[]>(role.scopes, []);
    const maxTtl = Math.min(role.max_ttl_s ?? this.opts.maxTtlS, this.opts.maxTtlS);
    let ttl = Math.min(input.ttlSeconds ?? role.ttl_s ?? this.opts.defaultTtlS, maxTtl);
    const held = ((await this.db('vault_leases').where({ tenant_id: c.tenantId, kind: APIKEY_LEASE_KIND, holder: userId, state: 'active' }).andWhere('expires_at', '>', Date.now()).andWhere('ref', 'like', `${provider}/${roleName}/%`).count({ n: '*' }).first()) as { n: number | string } | undefined)?.n;
    if (Number(held ?? 0) >= this.opts.maxActive) throw new HttpProblem(429, 'Too many requests', `You hold ${held} live leases of ${provider}/${roleName}, the most allowed (VAULT_APIKEY_LEASES_MAX). Revoke some, or wait for them to end.`, { extensions: { step: 'apikey-lease-limit', limit: this.opts.maxActive } });

    const leaseId = ulid();
    const now = Date.now();
    if (provider === EXPRSN_PROVIDER) {
      const owner = permissionsFor(await s.users.roleIds(userId), c.tenantId);
      const scopes = roleScopes.filter((x): x is Permission => isPermission(x) && owner.has(x) && (!input.within || input.within.has(x)));
      if (!scopes.length) throw new HttpProblem(409, 'Conflict', `You hold none of the scopes of ${provider}/${roleName}, so its key could do nothing.`, { extensions: { step: 'apikey-lease-scopes', scopes: roleScopes } });
      const { key, row } = await s.apiKeys.create({ tenantId: c.tenantId, userId, name: `lease ${provider}/${roleName}`.slice(0, 100), scopes, ttlDays: 0, expiresAt: now + maxTtl * 1000, leaseId, agentId: input.agentId ?? null });
      let lease: GenericLease;
      try {
        lease = await s.leases.issue({ id: leaseId, tenantId: c.tenantId, kind: APIKEY_LEASE_KIND, holderKind: 'user', holder: userId, ref: leaseRef(provider, roleName, row.id), label: 'internal', data: { provider, providerKind: EXPRSN_PROVIDER, role: roleName, scopes, keyId: row.id, prefix: row.prefix } satisfies LeaseData, renewPeriodSeconds: ttl, maxLifetimeSeconds: maxTtl, actor: c.actor, traceId: c.traceId ?? null });
      } catch (err) {
        await s.apiKeys.revokeLeased(leaseId, row.id);
        throw err;
      }
      await this.audit(c.tenantId, 'vault.apikey.lease.issued', 'decision', c.actor, { lease: lease.id, provider, role: roleName, key: row.id }, 'internal', { scopes, ttlSeconds: ttl, maxTtlSeconds: maxTtl }, c.traceId);
      return { ...apiKeyLeaseView(lease), key, leaseDurationSeconds: ttl, renewable: ttl < maxTtl };
    }

    const prow = await this.providerRow(c.tenantId, provider, c.clearance);
    if (prow.state !== 'active') throw conflict(`${prow.name} is disabled; it issues no keys.`);
    const kind = this.opts.providers[prow.kind];
    if (!kind) throw new HttpProblem(409, 'Conflict', `This server has no provider of kind ${prow.kind}, so ${prow.name} issues nothing.`, { extensions: { step: 'apikey-provider-unconfigured' } });
    const target = this.target(prow, c.traceId);
    const issued = await kind.create(target, { name: role.name, scopes: roleScopes, config: json<Record<string, unknown>>(role.config, {}) });
    let lease: GenericLease;
    try {
      // The lease never outlives the key: a provider that ends its keys by itself sets the maximum.
      const maxLife = issued.expiresAt ? Math.max(1, Math.min(maxTtl, Math.floor((issued.expiresAt - Date.now()) / 1000))) : maxTtl;
      ttl = Math.min(ttl, maxLife);
      const sealed = issued.secret ? await s.keys.seal(c.tenantId, issued.secret, sealAad(leaseId)) : null;
      lease = await s.leases.issue({ id: leaseId, tenantId: c.tenantId, kind: APIKEY_LEASE_KIND, holderKind: 'user', holder: userId, ref: leaseRef(provider, roleName, leaseId), label: prow.label, data: { provider, providerKind: prow.kind, role: roleName, scopes: roleScopes, sealed, ...(issued.detail ? { detail: issued.detail } : {}) } satisfies LeaseData, renewPeriodSeconds: ttl, maxLifetimeSeconds: maxLife, actor: c.actor, traceId: c.traceId ?? null });
      await this.audit(c.tenantId, 'vault.apikey.lease.issued', 'decision', c.actor, { lease: lease.id, provider, role: roleName, kind: prow.kind }, prow.label, { scopes: roleScopes, ttlSeconds: ttl, maxTtlSeconds: maxLife }, c.traceId);
      return { ...apiKeyLeaseView(lease), key: issued.key, leaseDurationSeconds: ttl, renewable: ttl < maxLife };
    } catch (err) {
      await kind.revoke(target, { secret: issued.secret ?? null }).catch(() => undefined);
      throw err;
    }
  }

  /** The value behind `vault:apikey:<provider>/<role>#key`: a fresh key, issued to the reference's reader. */
  async readRef(c: VaultCaller, ref: { provider: string; role: string }): Promise<string> {
    return (await this.issue(c, ref.provider, ref.role)).key;
  }

  /** Undoes the key of a lease that ended (the lease kind's handler). A throw leaves the lease in `revoking`. */
  private async endKey(lease: GenericLease): Promise<void> {
    const s = this.s();
    const d = lease.data as unknown as LeaseData;
    if (d.providerKind === EXPRSN_PROVIDER) {
      if (d.keyId) await s.apiKeys.revokeLeased(lease.id, d.keyId);
      return;
    }
    const r = await this.db('vault_apikey_providers').where({ tenant_id: lease.tenantId, name: d.provider }).first();
    const kind = this.opts.providers[d.providerKind];
    // A provider that is gone cannot be asked; removal is refused while it has live leases, so this is a leftover.
    if (!r || !kind) return;
    const secret = d.sealed ? await s.keys.open(lease.tenantId, d.sealed, sealAad(lease.id)) : null;
    await kind.revoke(this.target(providerFrom(r)), { secret });
  }

  private async visible(p: Principal, id: string): Promise<GenericLease> {
    const l = await this.s().leases.get(p.tenantId, id).catch(() => null);
    if (!l || l.kind !== APIKEY_LEASE_KIND || !clears(p.clearance, l.label)) throw notFound('Lease');
    if (l.holder !== p.userId && !ApiKeyLeases.isAdmin(p)) throw notFound('Lease');
    return l;
  }

  async listLeases(p: Principal, opts: { all?: boolean; provider?: string; state?: GenericLeaseState; limit?: number } = {}) {
    if (opts.all && !ApiKeyLeases.isAdmin(p)) throw forbidden('Every lease in the tenant is shown to holders of secrets:admin.', { step: 'role', action: 'secrets:admin' });
    const rows = await this.s().leases.list(p.tenantId, { kind: APIKEY_LEASE_KIND, ...(opts.all ? {} : { holder: p.userId }), ...(opts.state ? { state: opts.state } : {}), limit: opts.limit ?? 200 });
    return rows.filter((l) => clears(p.clearance, l.label)).map(apiKeyLeaseView).filter((l) => !opts.provider || l.provider === opts.provider);
  }

  async getLease(p: Principal, id: string) {
    return apiKeyLeaseView(await this.visible(p, id));
  }

  /** Moves the expiry by the lease's period, never past its maximum. The holder's policy must still allow the path. */
  async renew(p: Principal, id: string, ctx: Ctx = {}) {
    const l = await this.visible(p, id);
    const d = l.data as unknown as LeaseData;
    await this.s().vault.authorize(await this.s().vault.callerFor(p, ctx), apiKeyPolicyPath(d.provider, d.role), 'read');
    return apiKeyLeaseView(await this.s().leases.renew(p.tenantId, l.id, actorFrom(p, ctx.ip), ctx.traceId));
  }

  /** Ends a lease now: its key is refused at once, and revoked here or at its provider. */
  async revoke(p: Principal, id: string, ctx: Ctx = {}) {
    this.register();
    const l = await this.visible(p, id);
    const after = await this.s().leases.revoke(p.tenantId, l.id, actorFrom(p, ctx.ip), { by: p.userId, traceId: ctx.traceId ?? null });
    if (after.state === 'revoking') throw new HttpProblem(502, 'Provider refused', `The lease has ended here, but its provider could not revoke the key yet: ${after.lastError ?? 'unknown error'}. It is retried until it is.`, { extensions: { lease: apiKeyLeaseView(after) } });
    return apiKeyLeaseView(after);
  }
}
