import { createHash } from 'node:crypto';
import type { DnsProvider } from '../ops/dns.js';
import { challengeName } from '../ops/dns.js';
import type { Services } from '../services.js';
import { CloudProviderError, type CallContext, type CloudProvider, type ObservedResource, type OperationHandle, type OperationResult, type ResourceSpec } from './providers/types.js';
import { cloudTags } from './tags.js';
import type { CloudAccount, Provider } from './types.js';

/*
 * 1.9.99-final, Sprint 58 (B-10206): ACME dns-01 through a cloud account's DNS. `ACME_DNS_PROVIDER` takes `route53`,
 * `azure-dns` and `digitalocean` beside `rfc2136` and `webhook`; `ACME_DNS_CLOUD_ACCOUNT` names the cloud account (its
 * id or name) whose credential (`deploy` purpose) publishes the TXT record, and `ACME_DNS_CLOUD_ZONE` the hosted zones
 * (a comma list; the longest one a name ends in holds its record). Route 53 may leave it out: the longest suffix of the
 * name with a hosted zone in the account is used. Azure DNS and DigitalOcean need it (their APIs answer a missing zone
 * like an empty one).
 *
 * The TXT record set `_acme-challenge.<name>` is written through the account's adapter (`dns_record` in
 * `cloud/providers/*`), so every call goes through the egress guard, the rate limiter and the breaker like any other
 * cloud call: a value is added to the set (a wildcard and its base name share one set), and removed at cleanup (the
 * set is deleted when it holds nothing else). Long-running changes (Route 53 `GetChange` until INSYNC, Azure async
 * operations) are followed before the CA is asked to validate.
 */

export const CLOUD_DNS_PROVIDERS = { route53: 'aws', 'azure-dns': 'azure', digitalocean: 'digitalocean' } as const satisfies Record<string, Provider>;
export type CloudDnsKind = keyof typeof CLOUD_DNS_PROVIDERS;
export const isCloudDnsKind = (v: string): v is CloudDnsKind => v in CLOUD_DNS_PROVIDERS;

const NAMES: Record<CloudDnsKind, string> = { route53: 'Route 53', 'azure-dns': 'Azure DNS', digitalocean: 'DigitalOcean DNS' };

export interface CloudDnsOptions {
  /** How long a change is followed before present or cleanup fails. */
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** The DNS provider for dns-01 through a cloud account. */
export class CloudDnsProvider implements DnsProvider {
  readonly name: string;
  private readonly maxWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly zones = new Map<string, string>();
  private readonly configured: string[];

  constructor(
    private readonly s: () => Services,
    readonly kind: CloudDnsKind,
    private readonly accountRef: string,
    zones: string | string[] | null = null,
    o: CloudDnsOptions = {}
  ) {
    this.configured = (Array.isArray(zones) ? zones : (zones ?? '').split(','))
      .map((z) => z.trim().replace(/\.$/, '').toLowerCase())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    this.name = `${NAMES[kind]} through the cloud account ${accountRef}`;
    this.maxWaitMs = o.maxWaitMs ?? 5 * 60_000;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** The account: active, of the provider the kind names. */
  private async account(): Promise<CloudAccount> {
    const accounts = this.s().cloud.accounts;
    await accounts.need();
    let a = await accounts.get(this.accountRef);
    if (!a) a = (await accounts.list(null)).find((x) => x.name === this.accountRef) ?? null;
    if (!a) throw new Error(`ACME_DNS_CLOUD_ACCOUNT names no cloud account (${this.accountRef}).`);
    const want = CLOUD_DNS_PROVIDERS[this.kind];
    if (a.provider !== want) throw new Error(`${a.name} is a ${a.provider} account; ACME_DNS_PROVIDER=${this.kind} needs a ${want} account.`);
    if (a.state === 'pending' || a.state === 'disabled') throw new Error(`${a.name} is ${a.state}; nothing is called on it.`);
    return a;
  }

  private async context(): Promise<{ account: CloudAccount; provider: CloudProvider; ctx: CallContext }> {
    const s = this.s();
    const account = await this.account();
    if (!s.cloud.credentials) throw new Error('Cloud credentials are not available on this server.');
    const cred = (await s.cloud.credentials.for(account, 'deploy')) as CallContext['cred'];
    const provider = s.cloud.providers.providerFor(account.provider);
    return { account, provider, ctx: { account, cred, ...(account.defaultRegion ? { region: account.defaultRegion } : {}) } };
  }

  private spec(account: CloudAccount, zone: string, fqdn: string, values: string[]): ResourceSpec<'dns_record'> {
    const record = fqdn === zone ? '@' : fqdn.slice(0, -(zone.length + 1));
    const key = createHash('sha256').update(fqdn).digest('hex').slice(0, 16);
    return { type: 'dns_record', name: `acme-${key}`, idempotencyKey: `acme-dns01:${fqdn}:${values.join(',')}`.slice(0, 200), tags: cloudTags({ account: account.name, deployment: 'acme' }), ...(account.defaultRegion ? { region: account.defaultRegion } : {}), props: { zone, record, recordType: 'TXT', values, ttl: 60 } };
  }

  /** The zone holding a name: the configured one, else the longest suffix the provider has a zone for. */
  private async zoneFor(c: { provider: CloudProvider; ctx: CallContext; account: CloudAccount }, fqdn: string): Promise<string> {
    if (this.configured.length) {
      const z = this.configured.find((x) => fqdn === x || fqdn.endsWith(`.${x}`));
      if (!z) throw new Error(`${fqdn} is not inside ${this.configured.join(', ')} (ACME_DNS_CLOUD_ZONE).`);
      return z;
    }
    if (this.kind !== 'route53') throw new Error(`ACME_DNS_PROVIDER=${this.kind} needs ACME_DNS_CLOUD_ZONE (the zones it may write in).`);
    const cached = this.zones.get(fqdn);
    if (cached) return cached;
    const labels = fqdn.split('.');
    for (let i = 1; i < labels.length - 1; i++) {
      const z = labels.slice(i).join('.');
      try {
        await c.provider.find(c.ctx, this.spec(c.account, z, fqdn, []));
        this.zones.set(fqdn, z);
        return z;
      } catch (err) {
        if (err instanceof CloudProviderError && (err.status === 404 || /zone/i.test(err.code ?? ''))) continue;
        throw err;
      }
    }
    throw new Error(`No ${NAMES[this.kind]} zone in ${c.account.name} holds ${fqdn}; set ACME_DNS_CLOUD_ZONE.`);
  }

  /** Follows a long-running change until it settles. */
  private async settle(c: { provider: CloudProvider; ctx: CallContext }, r: OperationResult): Promise<ObservedResource | null> {
    if (r.done) return r.resource;
    let handle: OperationHandle = r.operation;
    const end = Date.now() + this.maxWaitMs;
    for (;;) {
      const p = await c.provider.poll(c.ctx, handle);
      if (p.state === 'succeeded') return p.resource;
      if (p.state === 'failed') throw new Error(`${NAMES[this.kind]} did not apply the change: ${p.error}${p.code ? ` (${p.code})` : ''}`);
      if (Date.now() > end) throw new Error(`${NAMES[this.kind]} did not apply the change within ${Math.round(this.maxWaitMs / 1000)} s.`);
      await this.sleep(Math.min(Math.max(250, p.waitMs), 5000));
      handle = { ...handle };
    }
  }

  private async change(domain: string, value: string, remove: boolean): Promise<void> {
    const c = await this.context();
    const fqdn = challengeName(domain).toLowerCase();
    const zone = await this.zoneFor(c, fqdn);
    const found = await c.provider.find(c.ctx, this.spec(c.account, zone, fqdn, []));
    const have = ((found?.props.values as string[] | undefined) ?? []).map((v) => v.replace(/^"|"$/g, ''));
    const want = remove ? have.filter((v) => v !== value) : have.includes(value) ? have : [...have, value];
    if (found && want.length === have.length && want.every((v, i) => v === have[i])) return;
    const spec = this.spec(c.account, zone, fqdn, want);
    if (!found) {
      if (remove) return;
      await this.settle(c, await c.provider.create(c.ctx, spec));
    } else if (!want.length) {
      await this.settle(c, await c.provider.delete(c.ctx, { type: 'dns_record', providerId: found.providerId, ...(found.region ? { region: found.region } : {}), ...(found.locator ? { locator: found.locator } : {}) }));
    } else {
      await this.settle(c, await c.provider.update(c.ctx, { type: 'dns_record', providerId: found.providerId, ...(found.region ? { region: found.region } : {}), ...(found.locator ? { locator: found.locator } : {}) }, spec));
    }
  }

  present(domain: string, value: string): Promise<void> {
    return this.change(domain, value, false);
  }

  cleanup(domain: string, value: string): Promise<void> {
    return this.change(domain, value, true);
  }
}

/** The cloud DNS provider the settings ask for, or null (not a cloud kind, or no account named). */
export function cloudDnsProvider(s: () => Services, cfg: { ACME_DNS_PROVIDER: string; ACME_DNS_CLOUD_ACCOUNT?: string | undefined; ACME_DNS_CLOUD_ZONE?: string | undefined }): CloudDnsProvider | null {
  if (!isCloudDnsKind(cfg.ACME_DNS_PROVIDER) || !cfg.ACME_DNS_CLOUD_ACCOUNT) return null;
  return new CloudDnsProvider(s, cfg.ACME_DNS_PROVIDER, cfg.ACME_DNS_CLOUD_ACCOUNT, cfg.ACME_DNS_CLOUD_ZONE ?? null);
}
