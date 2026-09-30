import { isIP } from 'node:net';
import type { Db } from '../db/knex.js';
import { json } from '../db/knex.js';
import { parseAllowList, type AllowList } from '../mcp/hosts.js';

/*
 * The per-tenant outbound host allow-list (B-303). Workflow HTTP steps and webhooks consult it on top of the
 * operator's own rules (internal addresses only, or the operator's allow-list): when a tenant has entries, a host
 * must match one of them, or every address it resolves to must fall in one of its networks. The tenant list only
 * narrows; it never lets a tenant reach an address the operator's rules refuse.
 */

const HOSTNAME = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Why an entry is not a hostname, `*.domain`, address or CIDR network, or null when it is one. */
export function hostEntryProblem(raw: string): string | null {
  const x = raw.trim().toLowerCase();
  if (!x) return 'An entry is empty.';
  if (x.length > 253) return `${x.slice(0, 40)}… is too long.`;
  const [addr, bits, extra] = x.split('/');
  if (extra !== undefined) return `${x} is not a host or network.`;
  const fam = addr ? isIP(addr) : 0;
  if (bits !== undefined) {
    if (!fam) return `${x} is not a network: the part before / must be an address.`;
    const n = Number(bits);
    if (!/^\d+$/.test(bits) || n < (fam === 4 ? 8 : 16) || n > (fam === 4 ? 32 : 128)) return `${x} has a prefix length out of range.`;
    return null;
  }
  if (fam) return null;
  return HOSTNAME.test(x) ? null : `${x} is not a hostname, *.domain, address or CIDR network.`;
}

const nameMatches = (host: string, list: AllowList) => list.hosts.some((h) => (h.startsWith('*.') ? host.endsWith(h.slice(1)) : host === h));

/**
 * Why the tenant's list refuses a host, or null when it allows it (or is empty). `addresses` are the addresses the
 * caller resolved and will dial; a network entry admits the host only when every one of them is inside it.
 */
export function tenantHostProblem(host: string, addresses: readonly string[], list: AllowList | null): string | null {
  if (!list || list.empty) return null;
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (nameMatches(h, list)) return null;
  const fam = (a: string) => (isIP(a) === 6 ? 'ipv6' : 'ipv4');
  if (addresses.length && addresses.every((a) => list.networks.check(a.replace(/^::ffff:/i, ''), fam(a.replace(/^::ffff:/i, ''))))) return null;
  return `${h} is not on this tenant's list of allowed hosts.`;
}

export interface IntegrationSettings {
  allowedHosts: string[];
  priceBookId: string | null;
  billingCustomer: string | null;
  updatedBy: string | null;
  updatedAt: number | null;
}

/** Per-tenant integration settings: the outbound host allow-list, the price book and the billing customer. */
export class TenantIntegrations {
  constructor(private readonly db: Db) {}

  async get(tenantId: string): Promise<IntegrationSettings> {
    const r = (await this.db('tenant_integrations').where({ tenant_id: tenantId }).first()) as Record<string, unknown> | undefined;
    return {
      allowedHosts: json<string[]>(r?.allowed_hosts, []),
      priceBookId: (r?.price_book_id as string | null) ?? null,
      billingCustomer: (r?.billing_customer as string | null) ?? null,
      updatedBy: (r?.updated_by as string | null) ?? null,
      updatedAt: r?.updated_at == null ? null : Number(r.updated_at)
    };
  }

  async set(tenantId: string, patch: Partial<Pick<IntegrationSettings, 'allowedHosts' | 'priceBookId' | 'billingCustomer'>>, by: string): Promise<IntegrationSettings> {
    const cur = await this.get(tenantId);
    const row = {
      allowed_hosts: JSON.stringify(patch.allowedHosts ?? cur.allowedHosts),
      price_book_id: patch.priceBookId !== undefined ? patch.priceBookId : cur.priceBookId,
      billing_customer: patch.billingCustomer !== undefined ? patch.billingCustomer : cur.billingCustomer,
      updated_by: by,
      updated_at: Date.now()
    };
    const exists = await this.db('tenant_integrations').where({ tenant_id: tenantId }).first('tenant_id');
    if (exists) await this.db('tenant_integrations').where({ tenant_id: tenantId }).update(row);
    else await this.db('tenant_integrations').insert({ tenant_id: tenantId, ...row });
    return this.get(tenantId);
  }

  /** The tenant's allow-list, parsed, or null when it has none. */
  async allowList(tenantId: string): Promise<AllowList | null> {
    const { allowedHosts } = await this.get(tenantId);
    return allowedHosts.length ? parseAllowList(allowedHosts.join(',')) : null;
  }
}
