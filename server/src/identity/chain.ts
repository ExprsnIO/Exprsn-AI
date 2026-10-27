import type { Db } from '../db/knex.js';
import type { Logger } from 'pino';
import { parseAllowList, type AllowList } from '../mcp/hosts.js';
import type { ProviderRepo, ProviderRow } from '../repos/providers.js';
import { LdapProvider } from './providers/ldap.js';
import { LocalProvider } from './providers/local.js';
import { SqlProvider } from './providers/sql.js';
import { FederatedProvider, type FederatedTester } from './providers/federated.js';
import { ScimProvider } from './providers/scim.js';
import { AdProvider, type SrvResolver } from './providers/ad.js';
import { CloudDirectoryProvider, type DirectoryNet } from './providers/cloud-directory.js';
import './providers/store-kinds.js'; // 1.9.0 (B-182 to B-184): the new kinds and presets in the kind registry
import { burnPasswordCheck } from './passwords.js';
import type { VaultRefResolver } from './secrets.js';
import { parseProviderConfig, type AdConfig, type ExternalUser, type IdentityProvider, type LdapConfig, type OidcUpstreamConfig, type SqlConfig, type Step, type StoreRefusal } from './providers/types.js';

export type ChainResult =
  | { status: 'ok'; provider: ProviderRow; user: ExternalUser }
  | { status: 'invalid' | 'disabled'; provider: ProviderRow; reason?: StoreRefusal }
  | { status: 'not_found'; errors: { provider: string; message: string }[] };

/**
 * The ordered chain of user stores for a tenant. Stores are tried in position order:
 *   - "not found" and store errors move on to the next store;
 *   - a wrong password or a disabled account in the store that owns the username stops the chain,
 *     so one password is never tried against several stores.
 * Provider instances are cached and rebuilt when their row changes.
 */
export class IdentityChain {
  private readonly cache = new Map<string, { updatedAt: number; provider: IdentityProvider }>();
  /** Connectivity checks for upstream (OIDC, SAML) providers, supplied by the federation service. */
  private federatedTester: FederatedTester | null = null;

  useFederatedTester(tester: FederatedTester): void {
    this.federatedTester = tester;
  }

  /** Sprint 25 (B-1705): how a store resolves its `vault:` references (as the user who saved it). */
  private vaultResolver: ((row: ProviderRow) => VaultRefResolver) | null = null;

  useVaultResolver(fn: (row: ProviderRow) => VaultRefResolver): void {
    this.vaultResolver = fn;
  }

  /** 1.9.0 (B-183): how cloud directories (Graph, Google) are reached: the egress guard, set by the federation service. */
  private directoryNet: DirectoryNet | null = null;

  useDirectoryNet(net: DirectoryNet): void {
    this.directoryNet = net;
  }

  /** 1.9.0 (B-182): DNS SRV lookups for Active Directory's domain controllers (a stand-in in tests). */
  private srvResolver: SrvResolver | undefined;

  useSrvResolver(fn: SrvResolver): void {
    this.srvResolver = fn;
  }

  constructor(
    private readonly db: Db,
    private readonly providers: ProviderRepo,
    private readonly log: Logger,
    private readonly production: boolean,
    /** Where LDAP and SQL stores may connect: internal hosts (plus the allow-list), never the app's own SQLite file. */
    private readonly outbound: { allow: AllowList; refusedSqliteFiles: string[] } = { allow: parseAllowList(''), refusedSqliteFiles: [] }
  ) {}

  build(row: ProviderRow): IdentityProvider {
    const cached = this.cache.get(row.id);
    if (cached && cached.updatedAt === row.updated_at) return cached.provider;
    if (cached) void cached.provider.close().catch(() => undefined);
    const provider = this.make(row);
    this.cache.set(row.id, { updatedAt: row.updated_at, provider });
    return provider;
  }

  /**
   * 1.9.0 (B-181): a provider for a configuration that is not (or not yet) saved, built as the chain builds a store
   * (the same outbound checks and vault resolver) but never cached. The caller closes it.
   */
  probe(row: ProviderRow): IdentityProvider {
    return this.make(row);
  }

  private make(row: ProviderRow): IdentityProvider {
    const cfg = parseProviderConfig(row.kind, row.config);
    let provider: IdentityProvider;
    switch (row.kind) {
      case 'local':
        provider = new LocalProvider(row.id, row.name, this.db, row.tenant_id);
        break;
      case 'ldap':
        provider = new LdapProvider(row.id, row.name, cfg as LdapConfig, this.production, this.outbound.allow, this.vaultResolver?.(row) ?? null);
        break;
      case 'sql':
        provider = new SqlProvider(row.id, row.name, cfg as SqlConfig, this.outbound, this.vaultResolver?.(row) ?? null);
        break;
      case 'oidc':
        // 1.9.0 (B-183): with a directory (Graph, Google), the store can be looked up and joins directory sync.
        provider = (cfg as OidcUpstreamConfig).directory && this.directoryNet
          ? new CloudDirectoryProvider(row, (r, steps) => (this.federatedTester ? this.federatedTester(r, steps) : Promise.resolve(false)), this.directoryNet, this.vaultResolver?.(row) ?? null)
          : new FederatedProvider(row, (r, steps) => (this.federatedTester ? this.federatedTester(r, steps) : Promise.resolve(false)));
        break;
      case 'saml':
      case 'atproto': // Sprint 26 (B-1808): AT-Protocol accounts sign in by redirect too
      case 'github':
        provider = new FederatedProvider(row, (r, steps) => (this.federatedTester ? this.federatedTester(r, steps) : Promise.resolve(false)));
        break;
      case 'scim': // 1.6.0 (B-7201): users pushed by an identity provider; no passwords
        provider = new ScimProvider(row.id, row.name, this.db);
        break;
      case 'ad': // 1.9.0 (B-182): Active Directory, LDAPS or StartTLS only
        provider = new AdProvider(row.id, row.name, cfg as AdConfig, this.outbound.allow, this.vaultResolver?.(row) ?? null, this.srvResolver);
        break;
      case 'exprsn-platform': // 1.9.0 (B-184): the platform's OAuth server signs in by redirect
        provider = new FederatedProvider(row, (r, steps) => (this.federatedTester ? this.federatedTester(r, steps) : Promise.resolve(false)));
        break;
    }
    return provider;
  }

  async authenticate(tenantId: string, username: string, password: string, steps?: Step[]): Promise<ChainResult> {
    // 1.9.0 (B-185): an archived store is also disabled; both are checked so neither alone lets it back in.
    const rows = (await this.providers.list(tenantId)).filter((r) => r.enabled && r.state !== 'archived');
    const errors: { provider: string; message: string }[] = [];
    for (const row of rows) {
      let provider: IdentityProvider;
      try {
        provider = this.build(row);
      } catch (err) {
        errors.push({ provider: row.name, message: (err as Error).message });
        steps?.push({ title: `${row.name} (${row.kind})`, ok: false, detail: (err as Error).message });
        continue;
      }
      const inner: Step[] = [];
      const res = await provider.authenticate(username, password, inner);
      steps?.push({ title: `${row.name} (${row.kind})`, ok: res.status === 'ok', detail: res.status === 'error' ? res.message : res.status.replace('_', ' ') }, ...inner.map((s) => ({ ...s, title: '  ' + s.title })));
      switch (res.status) {
        case 'ok':
          return { status: 'ok', provider: row, user: res.user };
        case 'invalid':
        case 'disabled':
          return { status: res.status, provider: row, ...(res.reason ? { reason: res.reason } : {}) };
        case 'error':
          errors.push({ provider: row.name, message: res.message });
          this.log.warn({ provider: row.name, kind: row.kind, err: res.message }, 'identity provider error');
          break;
        case 'not_found':
          break;
      }
    }
    await burnPasswordCheck(password);
    return { status: 'not_found', errors };
  }

  async close(): Promise<void> {
    await Promise.all([...this.cache.values()].map((c) => c.provider.close().catch(() => undefined)));
    this.cache.clear();
  }
}
