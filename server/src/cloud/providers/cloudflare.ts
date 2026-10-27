import { FEATURES_BY_PROVIDER, type CloudAccount, type CloudFeature, type IdentityResult, type PermissionCheck } from '../types.js';
import { namePrefix } from '../tags.js';
import { bucketJurisdiction, R2_JURISDICTIONS, type R2Jurisdiction } from '../r2.js';
import { CloudflareAppTier, cloudflareSend, defaultAssetsRoot } from './cloudflare-app.js';
import { CF_CAPABILITIES, CF_FEATURE_PERMISSIONS } from './capabilities.js';
import { CloudTransport, type TransportOptions } from './transport.js';
import {
  assertAccount,
  CloudProviderError,
  CloudUnsupported,
  type AdapterCredential,
  type CallContext,
  type ChangeEvent,
  type ChangeTrailQuery,
  type CloudProvider,
  type ListFilter,
  type ObservedResource,
  type OperationHandle,
  type OperationResult,
  type PollResult,
  type ResourceOperation,
  type ResourceRef,
  type ResourceSpec,
  type ResourceType,
  type Support
} from './types.js';

/*
 * 1.9.99-final, Sprint 56 (B-10101): the Cloudflare adapter, over the API v4 through `CloudTransport` (egress guard,
 * rate limiter, `Retry-After` on 429). The credential is a scoped API token with the account id (no federation,
 * B-10009). Cloudflare runs the edge and the app tier only (B-109), so networks, subnets, VMs, clusters and caches are
 * `unsupported`.
 *
 * Idempotency: DNS records are looked up by name, type and content before a create (one record per value); R2
 * buckets and tunnels by their name (`exprsn-<account>-<name>`), and a bucket's "already exists, and you own it" is
 * adopted. Tags: Cloudflare has no general resource tags (`cloud/tags.ts`), so a DNS record's comment carries the
 * `exprsn:*` tags and the rest carry the name prefix; the journal holds them all.
 *
 * Token permissions (B-10007): the token's own policies when it may read them ("API Tokens Read"), else probes that
 * change nothing (a list for a read, an empty create, answered 400 when allowed and 403 when not); a permission with
 * no safe probe is reported as not checkable.
 */

export interface CloudflareEndpoints {
  /** The API origin (default `https://api.cloudflare.com`); paths are under `/client/v4`. */
  api?: string;
  /** Sprint 61 (B-10905): where a Worker's static assets are read from (default this build's web/ directory). */
  assetsRoot?: string;
}


interface CfEnvelope<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
  result_info?: { page: number; total_pages: number };
}
interface CfRecord { id: string; name: string; type: string; content: string; ttl: number; proxied?: boolean; comment?: string | null }
interface CfBucket { name: string; creation_date?: string; location?: string; jurisdiction?: string }
interface CfTunnel { id: string; name: string; status?: string; deleted_at?: string | null }
/** Sprint 62 (B-10703): one audit log entry (`/accounts/<id>/audit_logs`). */
interface CfAuditEntry { id?: string; when?: string; action?: { type?: string; result?: boolean }; actor?: { id?: string; email?: string; type?: string; ip?: string; token_id?: string }; resource?: { id?: string; type?: string; name?: string }; metadata?: Record<string, unknown>; newValueJson?: Record<string, unknown>; oldValueJson?: Record<string, unknown> }
/** At most this many pages of 100 audit entries per lookup. */
const CF_AUDIT_PAGES = 5;

export interface CloudflareProviderOptions extends Omit<TransportOptions, 'provider'> {
  endpoints?: CloudflareEndpoints;
}

export class CloudflareProvider implements CloudProvider {
  readonly kind = 'cloudflare' as const;
  readonly capabilities = CF_CAPABILITIES;
  readonly transport: CloudTransport;
  private endpoints: CloudflareEndpoints;

  constructor(o: CloudflareProviderOptions) {
    const { endpoints, ...t } = o;
    this.transport = new CloudTransport({ ...t, provider: 'cloudflare' });
    this.endpoints = endpoints ?? {};
  }

  setEndpoints(e: CloudflareEndpoints): void {
    this.endpoints = { ...e };
  }

  private get base(): string {
    return `${(this.endpoints.api ?? 'https://api.cloudflare.com').replace(/\/$/, '')}/client/v4`;
  }

  supports(type: ResourceType, op?: ResourceOperation): Support {
    const c = this.capabilities[type];
    if (c.support !== 'built') return c.support;
    return !op || c.operations.includes(op) ? 'built' : 'not_yet';
  }

  private accountId(account: CloudAccount): string {
    const id = account.providerIds.cloudflareAccountId;
    if (!id) throw new CloudProviderError(`The account ${account.name} has no Cloudflare account id.`, 'cloudflare', 400, 'no_account_id');
    return id;
  }

  private async call<T>(cred: AdapterCredential, account: CloudAccount, method: string, path: string, body?: unknown, signal?: AbortSignal, extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: CfEnvelope<T>; requestId: string | null }> {
    assertAccount('cloudflare', account);
    if (cred.kind !== 'token') throw new CloudProviderError('A Cloudflare account needs an API token.', 'cloudflare', 400, 'wrong_credential');
    const r = await this.transport.json<CfEnvelope<T>>(
      { method, url: `${this.base}${path}`, headers: { ...extraHeaders, authorization: `Bearer ${cred.token}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), accountId: account.id, ...(signal ? { signal } : {}) },
      (status, b) => {
        const e = ((b ?? {}) as CfEnvelope<unknown>).errors?.[0];
        return { message: `Cloudflare answered ${status}${e ? ` (${e.code})` : ''}: ${(e?.message ?? 'no detail').slice(0, 300)}`, code: e ? String(e.code) : null };
      }
    );
    return { status: r.status, body: r.body, requestId: r.requestId };
  }

  private async pages<T>(ctx: CallContext, path: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= 100; page++) {
      const r = await this.call<T[]>(ctx.cred, ctx.account, 'GET', `${path}${path.includes('?') ? '&' : '?'}page=${page}&per_page=100`, undefined, ctx.signal);
      out.push(...(r.body.result ?? []));
      if (!r.body.result_info || page >= r.body.result_info.total_pages) break;
    }
    return out;
  }

  /**
   * Sprint 61 (B-10901 to B-10904): one API v4 call for the front door module (`cloud/edge.ts`: zone settings,
   * certificate packs, rulesets, tunnel tokens and configuration, Access), through the same transport, egress guard
   * and limiter. Answers the envelope's `result`; a failure throws CloudProviderError as every call here does.
   */
  async edgeCall<T>(ctx: CallContext, method: string, path: string, body?: unknown): Promise<{ result: T; requestId: string | null }> {
    const r = await this.call<T>(ctx.cred, ctx.account, method, path, body, ctx.signal);
    return { result: r.body.result, requestId: r.requestId };
  }

  /** Sprint 61: every page of a list for the front door module. */
  async edgeList<T>(ctx: CallContext, path: string): Promise<T[]> {
    return this.pages<T>(ctx, path);
  }

  /**
   * B-10703 (Sprint 62): the account's audit log entries for one resource in a window (`/accounts/<id>/audit_logs`,
   * newest first, at most five pages of 100), matched by the resource's ids (a record set's record ids, a tunnel's id)
   * or, for DNS, the record's name. Reads ("view") are left out. Needs "Account Settings Read" (the front door feature).
   */
  async changeEvents(ctx: CallContext, q: ChangeTrailQuery): Promise<ChangeEvent[]> {
    const acc = encodeURIComponent(this.accountId(ctx.account));
    const ids = new Set([q.providerId, ...(q.ids ?? [])]);
    const name = q.name?.toLowerCase().replace(/\.$/, '') ?? null;
    const iso = (t: number) => new Date(t).toISOString();
    const limit = q.limit ?? 20;
    const out: ChangeEvent[] = [];
    for (let page = 1; page <= CF_AUDIT_PAGES && out.length < limit; page++) {
      const r = await this.call<CfAuditEntry[]>(ctx.cred, ctx.account, 'GET', `/accounts/${acc}/audit_logs?since=${encodeURIComponent(iso(q.from))}&before=${encodeURIComponent(iso(q.to))}&direction=desc&per_page=100&page=${page}`, undefined, ctx.signal);
      const list = r.body.result ?? [];
      for (const e of list) {
        const type = e.action?.type ?? '';
        if (!type || /^(view|read|get|list)$/i.test(type) || e.action?.result === false) continue;
        const named = name && [e.metadata?.name, e.newValueJson?.name, e.oldValueJson?.name, e.resource?.name].some((n) => typeof n === 'string' && n.toLowerCase().replace(/\.$/, '') === name);
        if (!(e.resource?.id && ids.has(e.resource.id)) && !named) continue;
        const at = Date.parse(e.when ?? '');
        const principal = e.actor?.email ?? (e.actor?.token_id ? `token ${e.actor.token_id}` : e.actor?.id);
        if (!Number.isFinite(at) || !principal) continue;
        out.push({ at, principal, principalType: e.actor?.type ?? null, action: type, source: `cloudflare${e.resource?.type ? `:${e.resource.type}` : ''}`, eventId: e.id ?? null, sourceIp: e.actor?.ip ?? null });
      }
      if (list.length < 100 || (r.body.result_info && page >= r.body.result_info.total_pages)) break;
    }
    return out.sort((a, b) => b.at - a.at).slice(0, limit);
  }

  // ---------- identity and permissions ----------

  /** Verifies the token as a user token, then as one of the account's own tokens. */
  private async verify(cred: AdapterCredential, account: CloudAccount): Promise<{ id: string; status: string; owner: 'user' | 'account'; requestId: string | null }> {
    try {
      const r = await this.call<{ id: string; status: string }>(cred, account, 'GET', '/user/tokens/verify');
      return { ...r.body.result, owner: 'user', requestId: r.requestId };
    } catch (err) {
      if (!(err instanceof CloudProviderError) || ![400, 401, 403].includes(err.status)) throw err;
      const r = await this.call<{ id: string; status: string }>(cred, account, 'GET', `/accounts/${encodeURIComponent(this.accountId(account))}/tokens/verify`);
      return { ...r.body.result, owner: 'account', requestId: r.requestId };
    }
  }

  async identity(cred: AdapterCredential, account: CloudAccount): Promise<IdentityResult> {
    try {
      const v = await this.verify(cred, account);
      if (v.status !== 'active') return { ok: false, principal: v.id, error: `The Cloudflare token is ${v.status}.` };
      return { ok: true, principal: `token ${v.id}`, ...(v.owner === 'account' ? { providerAccount: this.accountId(account) } : {}), ...(v.requestId ? { requestId: v.requestId } : {}) };
    } catch (err) {
      if (err instanceof CloudProviderError && [400, 401, 403].includes(err.status)) return { ok: false, error: `Cloudflare refused the token: ${err.message}`, ...(err.requestId ? { requestId: err.requestId } : {}) };
      throw err;
    }
  }

  async checkPermissions(cred: AdapterCredential, account: CloudAccount, features: CloudFeature[]): Promise<PermissionCheck[]> {
    const offered = FEATURES_BY_PROVIDER.cloudflare;
    const wanted = features.filter((f) => offered.includes(f) && CF_FEATURE_PERMISSIONS[f]);
    let held: Set<string> | null = null;
    const unknown = new Set<string>();
    if (wanted.length) {
      const v = await this.verify(cred, account);
      try {
        const path = v.owner === 'user' ? `/user/tokens/${encodeURIComponent(v.id)}` : `/accounts/${encodeURIComponent(this.accountId(account))}/tokens/${encodeURIComponent(v.id)}`;
        const r = await this.call<{ policies?: { effect: string; permission_groups?: { name: string }[] }[] }>(cred, account, 'GET', path);
        held = new Set((r.body.result.policies ?? []).filter((p) => p.effect === 'allow').flatMap((p) => (p.permission_groups ?? []).map((g) => g.name)));
      } catch (err) {
        if (!(err instanceof CloudProviderError) || (err.status !== 403 && err.status !== 401)) throw err;
        held = new Set<string>();
        for (const perm of new Set(wanted.flatMap((f) => CF_FEATURE_PERMISSIONS[f]!))) {
          const r = await this.probe(cred, account, perm);
          if (r === null) unknown.add(perm);
          else if (r) held.add(perm);
        }
      }
    }
    const has = (perm: string) => held!.has(perm) || held!.has(perm.replace(/ Read$/, ' Write')) || held!.has(perm.replace(/ Read$/, ' Edit')) || held!.has(perm.replace(/ Write$/, ' Edit')) || held!.has(perm.replace(/ Edit$/, ' Write'));
    return features.map((f) => {
      if (!wanted.includes(f)) return { feature: f, required: [], missing: [], unsupported: true };
      const required = CF_FEATURE_PERMISSIONS[f]!;
      const missing = required.filter((p) => !unknown.has(p) && !has(p));
      const unchecked = required.filter((p) => unknown.has(p));
      return { feature: f, required, missing, ...(unchecked.length ? { error: `The token may not read its own policies (API Tokens Read), and ${unchecked.join(', ')} cannot be checked without it.` } : {}) };
    });
  }

  /** Whether the token holds a permission, by a call that changes nothing; null when there is no safe probe. */
  private async probe(cred: AdapterCredential, account: CloudAccount, perm: string): Promise<boolean | null> {
    const acc = encodeURIComponent(this.accountId(account));
    const zone = account.providerIds.cloudflareZoneIds?.[0];
    const probes: Record<string, [string, string, unknown?] | null> = {
      'Zone Read': ['GET', '/zones?per_page=1'],
      'DNS Write': zone ? ['POST', `/zones/${encodeURIComponent(zone)}/dns_records`, {}] : null,
      'DNS Read': zone ? ['GET', `/zones/${encodeURIComponent(zone)}/dns_records?per_page=1`] : null,
      'Cloudflare Tunnel Write': ['POST', `/accounts/${acc}/cfd_tunnel`, {}],
      'Workers R2 Storage Write': ['POST', `/accounts/${acc}/r2/buckets`, {}],
      'Containers Edit': ['POST', `/accounts/${acc}/containers/applications`, {}],
      'Hyperdrive Write': ['POST', `/accounts/${acc}/hyperdrive/configs`, {}],
      'AI Gateway Write': ['POST', `/accounts/${acc}/ai-gateway/gateways`, {}],
      'Workers Scripts Write': null,
      // Sprint 62 (B-10703): the audit logs the change trail reads.
      'Account Settings Read': ['GET', `/accounts/${acc}/audit_logs?per_page=1`]
    };
    const p = probes[perm];
    if (!p) return null;
    try {
      await this.call(cred, account, p[0], p[1], p[2]);
      return true;
    } catch (err) {
      if (!(err instanceof CloudProviderError)) throw err;
      if (err.status === 403) return false;
      if (err.status === 429 || err.status >= 500) throw err;
      return true;
    }
  }

  // ---------- resources ----------

  private assertBuilt(type: ResourceType, op: ResourceOperation): void {
    const s = this.supports(type, op);
    if (s !== 'built') throw new CloudUnsupported('cloudflare', type, s, op, this.capabilities[type].note);
  }

  private cfName(ctx: CallContext, name: string): string {
    return `${namePrefix(ctx.account.name)}${name}`.toLowerCase();
  }

  private async zoneId(ctx: CallContext, zone: string): Promise<string> {
    if (/^[0-9a-f]{32}$/.test(zone)) return zone;
    const r = await this.call<{ id: string; name: string }[]>(ctx.cred, ctx.account, 'GET', `/zones?name=${encodeURIComponent(zone)}`, undefined, ctx.signal);
    const z = r.body.result.find((x) => x.name === zone);
    if (!z) throw new CloudProviderError(`No Cloudflare zone ${zone} for this token.`, 'cloudflare', 404, 'zone_not_found');
    return z.id;
  }

  private async records(ctx: CallContext, zoneId: string, fqdn: string, type: string): Promise<CfRecord[]> {
    return (await this.pages<CfRecord>(ctx, `/zones/${zoneId}/dns_records?name=${encodeURIComponent(fqdn)}&type=${encodeURIComponent(type)}`)).filter((r) => r.name === fqdn && r.type === type);
  }

  /** Sprint 61 (B-10905): the app tier's Workers, Hyperdrive configurations and Containers applications. */
  private appTierValue: CloudflareAppTier | null = null;
  private get appTier(): CloudflareAppTier {
    return (this.appTierValue ??= new CloudflareAppTier({ send: cloudflareSend(this.transport, () => this.base), accountId: (ctx) => this.accountId(ctx.account), name: (ctx, n) => this.cfName(ctx, n), zoneId: (ctx, z) => this.zoneId(ctx, z), assetsRoot: () => this.endpoints.assetsRoot ?? defaultAssetsRoot() }));
  }

  private static isAppTier(type: ResourceType): type is 'worker' | 'hyperdrive' | 'container_service' {
    return type === 'worker' || type === 'hyperdrive' || type === 'container_service';
  }

  async find(ctx: CallContext, spec: ResourceSpec): Promise<ObservedResource | null> {
    this.assertBuilt(spec.type, 'describe');
    if (CloudflareProvider.isAppTier(spec.type)) return this.appTier.find(ctx, spec);
    switch (spec.type) {
      case 'dns_record': {
        const p = (spec as ResourceSpec<'dns_record'>).props;
        const zoneId = await this.zoneId(ctx, p.zone);
        return this.describe(ctx, { type: 'dns_record', providerId: setId(zoneId, p.recordType, fqdnOf(p.record, p.zone)), locator: { zone: p.zone } });
      }
      case 'bucket': {
        // Sprint 61 (B-10906): a bucket in a jurisdiction is only found by asking in that jurisdiction.
        const j = bucketJurisdiction((spec as ResourceSpec<'bucket'>).props, spec.region ?? ctx.region);
        return this.describe(ctx, { type: 'bucket', providerId: (spec as ResourceSpec<'bucket'>).props.bucketName ?? this.cfName(ctx, spec.name), ...(j !== 'default' ? { locator: { jurisdiction: j } } : {}) });
      }
      case 'tunnel': {
        const name = this.cfName(ctx, spec.name);
        const list = await this.pages<CfTunnel>(ctx, `/accounts/${encodeURIComponent(this.accountId(ctx.account))}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`);
        const t = list.find((x) => x.name === name && !x.deleted_at);
        return t ? tunnelObserved(t, spec.name) : null;
      }
    }
    return null;
  }

  async describe(ctx: CallContext, ref: ResourceRef): Promise<ObservedResource | null> {
    this.assertBuilt(ref.type, 'describe');
    if (CloudflareProvider.isAppTier(ref.type)) return this.appTier.describe(ctx, ref);
    const acc = encodeURIComponent(this.accountId(ctx.account));
    try {
      switch (ref.type) {
        case 'dns_record': {
          const [zoneId, type, fqdn] = splitSet(ref.providerId);
          const rs = await this.records(ctx, zoneId, fqdn, type);
          return rs.length ? recordSetObserved(zoneId, type, fqdn, rs, ref.locator?.zone) : null;
        }
        case 'bucket': {
          const j = refJurisdiction(ref);
          const r = await this.call<CfBucket>(ctx.cred, ctx.account, 'GET', `/accounts/${acc}/r2/buckets/${encodeURIComponent(ref.providerId)}`, undefined, ctx.signal, jurisdictionHeader(j));
          return bucketObserved(r.body.result, namePrefix(ctx.account.name), ctx.account.name, j);
        }
        case 'tunnel': {
          const r = await this.call<CfTunnel>(ctx.cred, ctx.account, 'GET', `/accounts/${acc}/cfd_tunnel/${encodeURIComponent(ref.providerId)}`, undefined, ctx.signal);
          return r.body.result.deleted_at ? null : tunnelObserved(r.body.result);
        }
      }
    } catch (err) {
      if (err instanceof CloudProviderError && err.status === 404) return null;
      throw err;
    }
    return null;
  }

  async list(ctx: CallContext, type: ResourceType, filter: ListFilter = {}): Promise<ObservedResource[]> {
    this.assertBuilt(type, 'list');
    const prefix = namePrefix(ctx.account.name);
    if (CloudflareProvider.isAppTier(type)) return this.appTier.list(ctx, type, filter.managedOnly ? prefix : null);
    const acc = encodeURIComponent(this.accountId(ctx.account));
    switch (type) {
      case 'dns_record': {
        if (!filter.zone) throw new CloudProviderError('Listing DNS records needs the zone.', 'cloudflare', 400, 'zone_required');
        const zoneId = await this.zoneId(ctx, filter.zone);
        const all = await this.pages<CfRecord>(ctx, `/zones/${zoneId}/dns_records${filter.managedOnly ? `?comment.contains=${encodeURIComponent(`exprsn:account=${ctx.account.name}`)}` : ''}`);
        const sets = new Map<string, CfRecord[]>();
        for (const r of all) sets.set(`${r.type}|${r.name}`, [...(sets.get(`${r.type}|${r.name}`) ?? []), r]);
        return [...sets.values()].map((rs) => recordSetObserved(zoneId, rs[0]!.type, rs[0]!.name, rs, filter.zone));
      }
      case 'bucket': {
        // Sprint 61 (B-10906): R2 lists one jurisdiction at a time.
        const out: ObservedResource[] = [];
        for (const j of R2_JURISDICTIONS) {
          const r = await this.call<{ buckets: CfBucket[] }>(ctx.cred, ctx.account, 'GET', `/accounts/${acc}/r2/buckets`, undefined, ctx.signal, jurisdictionHeader(j));
          out.push(...(r.body.result.buckets ?? []).filter((b) => !filter.managedOnly || b.name.startsWith(prefix)).map((b) => bucketObserved(b, prefix, ctx.account.name, j)));
        }
        return out;
      }
      case 'tunnel':
        return (await this.pages<CfTunnel>(ctx, `/accounts/${acc}/cfd_tunnel?is_deleted=false`)).filter((t) => !filter.managedOnly || t.name.startsWith(prefix)).map((t) => tunnelObserved(t, t.name.startsWith(prefix) ? t.name.slice(prefix.length) : t.name));
    }
    return [];
  }

  async create(ctx: CallContext, spec: ResourceSpec): Promise<OperationResult> {
    this.assertBuilt(spec.type, 'create');
    if (CloudflareProvider.isAppTier(spec.type)) return this.appTier.create(ctx, spec);
    const acc = encodeURIComponent(this.accountId(ctx.account));
    switch (spec.type) {
      case 'dns_record':
        return this.reconcileRecords(ctx, spec as ResourceSpec<'dns_record'>);
      case 'bucket': {
        const name = (spec as ResourceSpec<'bucket'>).props.bucketName ?? this.cfName(ctx, spec.name);
        // Sprint 61 (B-10906): the jurisdiction (EU or FedRAMP) where residency needs it, sent as `cf-r2-jurisdiction`.
        const j = bucketJurisdiction((spec as ResourceSpec<'bucket'>).props, spec.region ?? ctx.region);
        const loc = j !== 'default' ? { locator: { jurisdiction: j } } : {};
        const existing = await this.describe(ctx, { type: 'bucket', providerId: name, ...loc });
        if (existing) return { done: true, resource: existing, adopted: true };
        try {
          const hint = (spec as ResourceSpec<'bucket'>).props.locationHint;
          const r = await this.call<CfBucket>(ctx.cred, ctx.account, 'POST', `/accounts/${acc}/r2/buckets`, { name, ...(hint ? { locationHint: hint } : {}) }, ctx.signal, jurisdictionHeader(j));
          return { done: true, resource: bucketObserved(r.body.result, namePrefix(ctx.account.name), ctx.account.name, j), ...(r.requestId ? { requestId: r.requestId } : {}) };
        } catch (err) {
          if (err instanceof CloudProviderError && err.status === 409 && err.code === '10004') {
            const found = await this.describe(ctx, { type: 'bucket', providerId: name, ...loc });
            if (found) return { done: true, resource: found, adopted: true };
          }
          throw err;
        }
      }
      case 'tunnel': {
        const existing = await this.find(ctx, spec);
        if (existing) return { done: true, resource: existing, adopted: true };
        const r = await this.call<CfTunnel>(ctx.cred, ctx.account, 'POST', `/accounts/${acc}/cfd_tunnel`, { name: this.cfName(ctx, spec.name), config_src: 'cloudflare' }, ctx.signal);
        return { done: true, resource: tunnelObserved(r.body.result, spec.name), ...(r.requestId ? { requestId: r.requestId } : {}) };
      }
    }
    throw new CloudUnsupported('cloudflare', spec.type, 'not_yet', 'create');
  }

  /** Makes a name's records of one type hold exactly the spec's values, each carrying the tags in its comment. */
  private async reconcileRecords(ctx: CallContext, spec: ResourceSpec<'dns_record'>): Promise<OperationResult> {
    const p = spec.props;
    const zoneId = await this.zoneId(ctx, p.zone);
    const fqdn = fqdnOf(p.record, p.zone);
    const current = await this.records(ctx, zoneId, fqdn, p.recordType);
    const comment = commentFor(spec);
    const want = new Set(p.values);
    for (const r of current) {
      if (!want.has(r.content)) await this.call(ctx.cred, ctx.account, 'DELETE', `/zones/${zoneId}/dns_records/${r.id}`, undefined, ctx.signal);
      else if ((p.ttl && r.ttl !== p.ttl) || (p.proxied !== undefined && Boolean(r.proxied) !== p.proxied) || r.comment !== comment) await this.call(ctx.cred, ctx.account, 'PATCH', `/zones/${zoneId}/dns_records/${r.id}`, { ttl: p.ttl ?? r.ttl, ...(p.proxied !== undefined ? { proxied: p.proxied } : {}), comment }, ctx.signal);
    }
    const have = new Set(current.map((r) => r.content));
    for (const v of p.values) {
      if (have.has(v)) continue;
      await this.call(ctx.cred, ctx.account, 'POST', `/zones/${zoneId}/dns_records`, { type: p.recordType, name: fqdn, content: v, ttl: p.ttl ?? 1, ...(p.proxied !== undefined ? { proxied: p.proxied } : {}), comment }, ctx.signal);
    }
    const resource = await this.describe(ctx, { type: 'dns_record', providerId: setId(zoneId, p.recordType, fqdn), locator: { zone: p.zone } });
    return { done: true, resource, ...(current.length ? { adopted: true } : {}) };
  }

  async update(ctx: CallContext, ref: ResourceRef, spec: ResourceSpec): Promise<OperationResult> {
    this.assertBuilt(ref.type, 'update');
    if (CloudflareProvider.isAppTier(ref.type)) return this.appTier.update(ctx, ref, spec);
    switch (ref.type) {
      case 'dns_record':
        return this.reconcileRecords(ctx, spec as ResourceSpec<'dns_record'>);
      case 'bucket':
      case 'tunnel':
        // Nothing of an R2 bucket or a tunnel that this build manages can change in place (tags live in the journal).
        return { done: true, resource: await this.describe(ctx, ref) };
    }
    throw new CloudUnsupported('cloudflare', ref.type, 'not_yet', 'update');
  }

  async delete(ctx: CallContext, ref: ResourceRef): Promise<OperationResult> {
    this.assertBuilt(ref.type, 'delete');
    if (CloudflareProvider.isAppTier(ref.type)) return this.appTier.delete(ctx, ref);
    const acc = encodeURIComponent(this.accountId(ctx.account));
    try {
      switch (ref.type) {
        case 'dns_record': {
          const [zoneId, type, fqdn] = splitSet(ref.providerId);
          for (const r of await this.records(ctx, zoneId, fqdn, type)) await this.call(ctx.cred, ctx.account, 'DELETE', `/zones/${zoneId}/dns_records/${r.id}`, undefined, ctx.signal);
          return { done: true, resource: null };
        }
        case 'bucket':
          await this.call(ctx.cred, ctx.account, 'DELETE', `/accounts/${acc}/r2/buckets/${encodeURIComponent(ref.providerId)}`, undefined, ctx.signal, jurisdictionHeader(refJurisdiction(ref)));
          return { done: true, resource: null };
        case 'tunnel':
          await this.call(ctx.cred, ctx.account, 'DELETE', `/accounts/${acc}/cfd_tunnel/${encodeURIComponent(ref.providerId)}`, undefined, ctx.signal);
          return { done: true, resource: null };
      }
    } catch (err) {
      if (err instanceof CloudProviderError && err.status === 404) return { done: true, resource: null };
      throw err;
    }
    throw new CloudUnsupported('cloudflare', ref.type, 'not_yet', 'delete');
  }

  /** Cloudflare's calls this build makes all finish in their answer; a handle (none is handed out yet) is re-read. */
  async poll(ctx: CallContext, h: OperationHandle): Promise<PollResult> {
    if (h.provider !== 'cloudflare') throw new CloudProviderError('That operation is not a Cloudflare one.', 'cloudflare', 400, 'wrong_provider');
    const o = await this.describe(ctx, h.ref);
    return h.op === 'delete' ? (o ? { state: 'pending', waitMs: 2000 } : { state: 'succeeded', resource: null }) : o ? { state: 'succeeded', resource: o } : { state: 'pending', waitMs: 2000 };
  }
}

// ---------- mapping ----------

const fqdnOf = (record: string, zone: string) => (record === '@' || !record ? zone : record.endsWith(zone) ? record : `${record}.${zone}`).toLowerCase();
const setId = (zoneId: string, type: string, fqdn: string) => `${zoneId}|${type}|${fqdn}`;
const splitSet = (id: string): [string, string, string] => {
  const [z, t, n] = id.split('|');
  return [z!, t!, n!];
};

/** The `exprsn:*` tags in a record's comment (`exprsn:managed=true exprsn:account=<a> ...`, at most 100 characters, the free plan's limit). */
export function commentFor(spec: ResourceSpec): string {
  const order = ['exprsn:managed', 'exprsn:account', 'exprsn:deployment', 'exprsn:tenant', 'exprsn:workspace', 'exprsn:pool'];
  const parts = order.filter((k) => spec.tags[k]).map((k) => `${k}=${spec.tags[k]}`);
  let out = '';
  for (const p of parts) if ((out ? `${out} ${p}` : p).length <= 100) out = out ? `${out} ${p}` : p;
  return out;
}

function parseComment(c: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of (c ?? '').matchAll(/(exprsn:[a-z]+)=(\S+)/g)) out[m[1]!] = m[2]!;
  return out;
}

function recordSetObserved(zoneId: string, type: string, fqdn: string, rs: CfRecord[], zone?: string): ObservedResource {
  return { type: 'dns_record', providerId: setId(zoneId, type, fqdn), name: fqdn, state: 'ready', tags: parseComment(rs[0]?.comment), props: { record: fqdn, recordType: type, values: rs.map((r) => r.content), ttl: rs[0]?.ttl, proxied: rs[0]?.proxied ?? false, ids: rs.map((r) => r.id) }, locator: { zoneId, ...(zone ? { zone } : {}) } };
}

function bucketObserved(b: CfBucket, prefix: string, account: string, jurisdiction: R2Jurisdiction = 'default'): ObservedResource {
  const ours = b.name.startsWith(prefix);
  const j = (R2_JURISDICTIONS as readonly string[]).includes(String(b.jurisdiction)) ? (b.jurisdiction as R2Jurisdiction) : jurisdiction;
  return { type: 'bucket', providerId: b.name, name: ours ? b.name.slice(prefix.length) : b.name, ...(b.location ? { region: b.location } : {}), state: 'ready', tags: ours ? { 'exprsn:managed': 'true', 'exprsn:account': account } : {}, props: { bucketName: b.name, ...(j !== 'default' ? { jurisdiction: j } : {}) }, ...(j !== 'default' ? { locator: { jurisdiction: j } } : {}) };
}

/** Sprint 61 (B-10906): a bucket reference's jurisdiction (kept in its locator). */
const refJurisdiction = (ref: ResourceRef): R2Jurisdiction => {
  const j = ref.locator?.jurisdiction;
  return j === 'eu' || j === 'fedramp' ? j : 'default';
};
/** The R2 jurisdiction header (none for the default jurisdiction). */
const jurisdictionHeader = (j: R2Jurisdiction): Record<string, string> => (j === 'default' ? {} : { 'cf-r2-jurisdiction': j });

function tunnelObserved(t: CfTunnel, name?: string): ObservedResource {
  // Only the tunnel's id, name and status; its token and credentials are never read back.
  return { type: 'tunnel', providerId: t.id, name: name ?? t.name, state: 'ready', tags: {}, props: { status: t.status ?? 'inactive' } };
}
