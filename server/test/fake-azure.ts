/*
 * 1.9.99-final, Sprint 56 (B-10109): an in-process stand-in for Entra ID's token endpoint, Azure Resource Manager and
 * the two Microsoft Graph calls credential rotation needs, on one port (each client's endpoint is pointed here).
 *
 * - Entra: `POST /<tenant>/oauth2/v2.0/token` with the client credentials grant, by client secret or by client
 *   assertion (a federated credential's issuer, subject and audience are checked, or a test's own validator runs);
 *   tokens carry their scope and are what ARM and Graph accept.
 * - ARM: subscriptions, resource groups and any provider resource by path (PUT by name, GET, PATCH of tags, DELETE,
 *   collection lists), `If-None-Match: *` and `If-Match`, `x-ms-ratelimit-remaining-*` headers, and long-running
 *   operations: network resources answer 201 with `Azure-AsyncOperation` (InProgress, then Succeeded after
 *   `settleAfter` polls), storage accounts 202 with `Location`; deletes of those types are asynchronous too. DNS record
 *   sets keep their tags as `metadata`, as Azure DNS does. `Microsoft.Authorization/permissions` at subscription and
 *   resource-group scope.
 * - Cost Management (B-10603): the subscription-scope `query` (Daily, grouped by a tag key and ServiceName, paged by
 *   `nextLink`) over the costs a test adds (`addCost`).
 * - Activity Log (B-10703): `eventtypes/management/values` filtered by time and `resourceUri`, over the
 *   administrative events a test adds (`addActivity`).
 * - Graph: `applications/<id>/addPassword` and `removePassword` (by object id or `applications(appId='...')`), and the
 *   application's password list.
 *
 * - Key Vault keys and Blob storage (B-10208): `fake.keyVault` and `fake.blobs`, in `fake-azure-data.ts`.
 *
 * It is never the real Azure.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { FakeCloudBase, json, jwtClaims, type RecordedRequest, type Reply } from './fake-cloud-base.js';
import { FakeBlobService, FakeKeyVault } from './fake-azure-data.js';
import { FakeAzureCompute } from './fake-azure-compute.js';
import { FakeAks } from './fake-azure-aks.js';
import { FakeAzureDb } from './fake-azure-db.js';
import { FakeAzureCaches } from './fake-cloud-caches.js';
import { FakeCosmos } from './fake-azure-cosmos.js';

export interface FakeAzureApp {
  tenantId: string;
  clientId: string;
  objectId: string;
  secrets: Map<string, { secretText: string; displayName: string; endDateTime: string; startDateTime: string }>;
  /** Federated identity credentials: an assertion must match one. */
  federated: { issuer: string; subject: string; audience: string }[];
}

interface ArmResource {
  id: string;
  name: string;
  type: string;
  location?: string;
  tags?: Record<string, string>;
  etag: string;
  body: Record<string, unknown>;
}

interface AsyncOp {
  id: string;
  status: 'InProgress' | 'Succeeded' | 'Failed' | 'Canceled';
  polls: number;
  resourceId: string;
  kind: 'put' | 'delete';
  error?: { code: string; message: string };
}

const ASYNC_NETWORK = new Set(['microsoft.network/virtualnetworks', 'microsoft.network/virtualnetworks/subnets', 'microsoft.network/networksecuritygroups', 'microsoft.network/networksecuritygroups/securityrules', 'microsoft.network/publicipaddresses', 'microsoft.network/loadbalancers', 'microsoft.containerservice/managedclusters', 'microsoft.containerservice/managedclusters/agentpools', 'microsoft.dbforpostgresql/flexibleservers', 'microsoft.dbformysql/flexibleservers']);
const ASYNC_LOCATION = new Set(['microsoft.storage/storageaccounts']);

export class FakeAzure extends FakeCloudBase {
  readonly apps = new Map<string, FakeAzureApp>();
  readonly subscriptions = new Map<string, { tenantId: string; displayName: string; state: string }>();
  readonly resources = new Map<string, ArmResource>();
  readonly operations = new Map<string, AsyncOp>();
  /** Tokens issued: token → claims. */
  readonly tokens = new Map<string, { tenantId: string; clientId: string; scope: string; exp: number }>();
  /** Every client assertion presented, with its claims (unverified). */
  readonly assertions: { clientId: string; claims: Record<string, unknown> | null }[] = [];
  /** A test's own check of a client assertion (a JWKS signature check); a string refuses with that message. */
  validateAssertion: ((assertion: string, app: FakeAzureApp) => string | null | Promise<string | null>) | null = null;
  /** What `Microsoft.Authorization/permissions` answers (per scope id prefix, longest match; '' for everywhere). */
  readonly permissions = new Map<string, { actions: string[]; notActions: string[] }>([['', { actions: ['*'], notActions: [] }]]);
  /** Polls an asynchronous operation answers InProgress before it settles. */
  settleAfter = 1;
  tokenSeconds = 3600;
  /** The origin the operation URLs it hands out name (the real ARM origin when a test maps it here). */
  publicOrigin: string | null = null;
  /** The next PUT of this type (lower case) settles as Failed with this error. */
  failNextAsync: { type: string; code: string; message: string } | null = null;
  /** B-10208: Key Vault keys (the vault URL is this fake's origin) and Blob storage (`<origin>/<account>/...`). */
  readonly keyVault = new FakeKeyVault(() => this.url);
  readonly blobs = new FakeBlobService();
  /** Sprint 59 (B-10304): the Cosmos DB for NoSQL data plane, one account (`fake-azure-cosmos.ts`). */
  readonly cosmos = new FakeCosmos(() => this.tokens);

  addApp(o: { tenantId: string; clientId?: string; secret?: boolean; federated?: FakeAzureApp['federated'] }): FakeAzureApp & { secret?: string } {
    const app: FakeAzureApp = { tenantId: o.tenantId, clientId: o.clientId ?? randomUUID(), objectId: randomUUID(), secrets: new Map(), federated: o.federated ?? [] };
    let secret: string | undefined;
    if (o.secret) {
      secret = `fake~${randomBytes(18).toString('base64url')}`;
      app.secrets.set(randomUUID(), { secretText: secret, displayName: 'initial', startDateTime: new Date().toISOString(), endDateTime: new Date(Date.now() + 365 * 864e5).toISOString() });
    }
    this.apps.set(app.clientId, app);
    return Object.assign(app, secret ? { secret } : {});
  }

  addSubscription(id: string, tenantId: string, displayName = 'Exprsn test subscription'): void {
    this.subscriptions.set(id.toLowerCase(), { tenantId, displayName, state: 'Enabled' });
  }

  /** The permissions ARM reports for a scope (a subscription or resource group id) and everything below it. */
  setPermissions(scope: string, actions: string[], notActions: string[] = []): this {
    this.permissions.set(scope.toLowerCase(), { actions, notActions });
    return this;
  }

  protected classify(r: Omit<RecordedRequest, 'op'>): string {
    if (r.path === '/api/retail/prices') return 'retail:prices';
    if (FakeCosmos.matches(r.path)) return this.cosmos.classify(r);
    if (this.keyVault.matches(r.path)) return this.keyVault.classify(r);
    if (this.blobs.matches(r.path)) return this.blobs.classify(r);
    if (/\/oauth2\/v2\.0\/token$/.test(r.path)) return 'entra:token';
    if (r.path.startsWith('/v1.0/')) return `graph:${r.method} ${r.path.replace(/^\/v1\.0/, '').replace(/[0-9a-f-]{36}/g, '{id}').replace(/\(appId='[^']*'\)/, "(appId='{id}')")}`;
    if (/\/operations\/|\/asyncoperations\//i.test(r.path)) return 'arm:operation';
    if (/\/providers\/Microsoft\.Authorization\/permissions$/i.test(r.path)) return 'arm:permissions';
    if (/\/providers\/Microsoft\.CostManagement\/query$/i.test(r.path)) return 'cost:query';
    if (/\/providers\/Microsoft\.Insights\/eventtypes\/management\/values$/i.test(r.path)) return 'arm:activity';
    const { type, collection } = parseArm(r.path);
    return `arm:${r.method} ${type}${collection ? ' (list)' : ''}`;
  }

  protected throttleReply(_r: RecordedRequest, retryAfterS: number): Reply {
    return { status: 429, headers: { 'retry-after': String(retryAfterS), 'x-ms-ratelimit-remaining-subscription-reads': '0' }, body: { error: { code: 'TooManyRequests', message: 'The request is being throttled.' } } };
  }

  private bearer(r: RecordedRequest, audience: string): { tenantId: string; clientId: string } | Reply {
    const tok = /^Bearer (.+)$/.exec(r.headers.authorization ?? '')?.[1];
    const t = tok ? this.tokens.get(tok) : undefined;
    if (!t || t.exp < Date.now() || !t.scope.startsWith(audience)) return { status: 401, headers: { 'www-authenticate': `Bearer authorization_uri="${this.url}/common/oauth2/authorize", error="invalid_token"` }, body: { error: { code: 'InvalidAuthenticationToken', message: 'The access token is invalid.' } } };
    return t;
  }

  // ---------- Activity Log (B-10703) ----------

  /** Administrative events the Activity Log answers (`addActivity`), per subscription. */
  readonly activity: { subscriptionId: string; resourceId: string; caller: string; at: number; operation: string; status: string; id: string; ip: string; idtyp: string }[] = [];
  /** Events per page before a `nextLink`. */
  activityPageSize = 200;

  addActivity(o: { subscriptionId: string; resourceId: string; caller: string; at: number; operation: string; status?: string; ip?: string; idtyp?: string }): this {
    this.activity.push({ subscriptionId: o.subscriptionId.toLowerCase(), resourceId: o.resourceId, caller: o.caller, at: o.at, operation: o.operation, status: o.status ?? 'Succeeded', id: randomUUID(), ip: o.ip ?? '203.0.113.9', idtyp: o.idtyp ?? (o.caller.includes('@') ? 'user' : 'app') });
    return this;
  }

  /** `GET /subscriptions/<id>/providers/Microsoft.Insights/eventtypes/management/values`: the `$filter` on time and `resourceUri`, newest first, paged by `nextLink`. */
  private activityLog(r: RecordedRequest): Reply {
    const sub = (/^\/subscriptions\/([^/]+)/i.exec(r.path)?.[1] ?? '').toLowerCase();
    const filter = r.query.get('$filter') ?? '';
    const ge = /eventTimestamp ge '([^']+)'/.exec(filter)?.[1];
    const le = /eventTimestamp le '([^']+)'/.exec(filter)?.[1];
    if (!ge) return { status: 400, body: { error: { code: 'BadRequest', message: "The $filter must name eventTimestamp ge '<time>'." } } };
    const from = Date.parse(ge);
    const to = le ? Date.parse(le) : Date.now();
    if (to - from > 90 * 86_400_000) return { status: 400, body: { error: { code: 'BadRequest', message: 'The time range is at most 90 days.' } } };
    const uri = /resourceUri eq '((?:[^']|'')+)'/.exec(filter)?.[1]?.replace(/''/g, "'").toLowerCase();
    const all = this.activity.filter((e) => e.subscriptionId === sub && e.at >= from && e.at <= to && (!uri || e.resourceId.toLowerCase() === uri)).sort((a, b) => b.at - a.at);
    const skip = Number(r.query.get('$skiptoken') ?? 0) || 0;
    const page = all.slice(skip, skip + this.activityPageSize);
    const value = page.map((e) => ({ authorization: { action: e.operation, scope: e.resourceId }, caller: e.caller, claims: { idtyp: e.idtyp }, correlationId: randomUUID(), eventDataId: e.id, eventName: { value: 'EndRequest' }, category: { value: 'Administrative' }, httpRequest: { clientIpAddress: e.ip, method: e.operation.endsWith('/delete') ? 'DELETE' : 'PUT' }, level: 'Informational', operationName: { value: e.operation, localizedValue: e.operation }, resourceGroupName: /resourceGroups\/([^/]+)/i.exec(e.resourceId)?.[1] ?? '', resourceProviderName: { value: e.operation.split('/')[0] }, resourceId: e.resourceId, status: { value: e.status }, eventTimestamp: new Date(e.at).toISOString(), submissionTimestamp: new Date(e.at + 30_000).toISOString(), subscriptionId: sub }));
    const next = skip + this.activityPageSize < all.length ? `${this.publicOrigin ?? this.url}${r.path}?api-version=${r.query.get('api-version')}&$filter=${encodeURIComponent(filter)}&$skiptoken=${skip + this.activityPageSize}` : undefined;
    return { status: 200, body: { value, ...(next ? { nextLink: next } : {}) } };
  }

  // ---------- Cost Management (B-10603) ----------

  /** Daily costs the subscription-scope `query` answers (`addCost`); a later `addCost` for the same key revises it. */
  readonly costs: { subscriptionId: string; day: string; service: string; tags: Record<string, string>; cost: number; currency: string }[] = [];
  /** Rows per page before a `nextLink`. */
  costPageSize = 1000;

  addCost(o: { subscriptionId: string; day: string; service: string; cost: number; tags?: Record<string, string>; currency?: string }): this {
    const tags = o.tags ?? {};
    const sub = o.subscriptionId.toLowerCase();
    const had = this.costs.find((c) => c.subscriptionId === sub && c.day === o.day && c.service === o.service && JSON.stringify(c.tags) === JSON.stringify(tags));
    const row = { subscriptionId: sub, day: o.day, service: o.service, tags, cost: o.cost, currency: o.currency ?? 'USD' };
    if (had) Object.assign(had, row);
    else this.costs.push(row);
    return this;
  }

  /** `POST /subscriptions/<id>/providers/Microsoft.CostManagement/query`: Daily, Sum of Cost, grouped by a TagKey and ServiceName. */
  private costQuery(r: RecordedRequest, tenantId: string): Reply {
    if (r.method !== 'POST') return { status: 405, body: { error: { code: 'MethodNotAllowed', message: 'POST only' } } };
    const subId = /^\/subscriptions\/([^/]+)\//i.exec(r.path)?.[1]?.toLowerCase() ?? '';
    const sub = this.subscriptions.get(subId);
    if (!sub || sub.tenantId !== tenantId) return { status: 404, body: { error: { code: 'SubscriptionNotFound', message: `The subscription '${subId}' could not be found.` } } };
    const b = json(r) as { type?: string; timeframe?: string; timePeriod?: { from?: string; to?: string }; dataset?: { granularity?: string; grouping?: { type: string; name: string }[] } };
    if (b.timeframe !== 'Custom' || !b.timePeriod?.from || !b.timePeriod?.to) return { status: 400, body: { error: { code: 'BadRequest', message: 'A Custom timeframe needs timePeriod.from and timePeriod.to.' } } };
    const from = b.timePeriod.from.slice(0, 10);
    const to = b.timePeriod.to.slice(0, 10);
    const tagKey = b.dataset?.grouping?.find((g) => g.type === 'TagKey')?.name ?? null;
    const bySvc = !!b.dataset?.grouping?.some((g) => g.type === 'Dimension' && g.name === 'ServiceName');
    const m = new Map<string, unknown[]>();
    for (const c of this.costs.filter((x) => x.subscriptionId === subId && x.day >= from && x.day <= to)) {
      const tagValue = tagKey ? (Object.entries(c.tags).find(([k]) => k.toLowerCase() === tagKey.toLowerCase())?.[1] ?? '') : '';
      const svc = bySvc ? c.service : '';
      const k = `${c.day}|${tagValue}|${svc}|${c.currency}`;
      const row = m.get(k) ?? [0, Number(c.day.replace(/-/g, '')), ...(tagKey ? [tagValue ? tagKey : '', tagValue] : []), ...(bySvc ? [svc] : []), c.currency];
      row[0] = Number(row[0]) + c.cost;
      m.set(k, row);
    }
    const all = [...m.values()];
    const skip = Number(r.query.get('$skiptoken') ?? 0) || 0;
    const rows = all.slice(skip, skip + this.costPageSize);
    const more = skip + this.costPageSize < all.length;
    const columns = [{ name: 'Cost', type: 'Number' }, { name: 'UsageDate', type: 'Number' }, ...(tagKey ? [{ name: 'TagKey', type: 'String' }, { name: 'TagValue', type: 'String' }] : []), ...(bySvc ? [{ name: 'ServiceName', type: 'String' }] : []), { name: 'Currency', type: 'String' }];
    const nextLink = more ? `${this.publicOrigin ?? this.url}${r.path}?api-version=${r.query.get('api-version')}&$skiptoken=${skip + this.costPageSize}` : null;
    return { status: 200, body: { id: `${r.path}/${randomUUID()}`, name: randomUUID(), type: 'Microsoft.CostManagement/query', properties: { nextLink, columns, rows } } };
  }

  // ---------- Retail Prices (B-10601) ----------

  /** The meters the Retail Prices API answers (`addRetailPrice`); filtered by the `$filter` the caller sends. */
  readonly retailPrices: { serviceName: string; armRegionName: string; armSkuName: string; retailPrice: number; currencyCode: string; productName: string; skuName: string; meterName: string; unitOfMeasure: string; type: string; effectiveStartDate: string }[] = [];

  addRetailPrice(o: { armSkuName: string; armRegionName: string; retailPrice: number; currencyCode?: string; productName?: string; skuName?: string; meterName?: string; serviceName?: string; effectiveStartDate?: string; type?: string; unitOfMeasure?: string }): this {
    const size = o.armSkuName.replace(/^Standard_/, '').replace(/_/g, ' ');
    this.retailPrices.push({ serviceName: o.serviceName ?? 'Virtual Machines', armRegionName: o.armRegionName, armSkuName: o.armSkuName, retailPrice: o.retailPrice, currencyCode: o.currencyCode ?? 'USD', productName: o.productName ?? `Virtual Machines ${size.split(' ')[0]} Series`, skuName: o.skuName ?? size, meterName: o.meterName ?? o.skuName ?? size, unitOfMeasure: o.unitOfMeasure ?? '1 Hour', type: o.type ?? 'Consumption', effectiveStartDate: o.effectiveStartDate ?? '2026-09-01T00:00:00Z' });
    return this;
  }

  /**
   * Sprint 61 (B-10505): an Azure OpenAI meter as the Retail Prices API lists them (service `Foundry Models`, product
   * `Azure OpenAI` or another `Azure OpenAI ...` one such as `Azure OpenAI Embedding` or `Azure OpenAI Media`, priced
   * per `1K` or `1M` tokens; `skuName` and `armSkuName` the meter, `meterName` it with ` Tokens`), e.g.
   * `gpt 4o 1120 Inp glbl`, `gpt-4o-mini-0718-Outp-regnl`, `gpt 4.1 mini cached Inp DZone`, `text embedding 3 small DZ`.
   */
  addOpenAiMeter(o: { region: string; meter: string; retailPrice: number; unitOfMeasure?: string; effectiveStartDate?: string; currencyCode?: string; productName?: string }): this {
    return this.addRetailPrice({ armSkuName: o.meter, armRegionName: o.region, retailPrice: o.retailPrice, productName: o.productName ?? 'Azure OpenAI', serviceName: 'Foundry Models', skuName: o.meter, meterName: `${o.meter} Tokens`, unitOfMeasure: o.unitOfMeasure ?? '1K', ...(o.effectiveStartDate ? { effectiveStartDate: o.effectiveStartDate } : {}), ...(o.currencyCode ? { currencyCode: o.currencyCode } : {}) });
  }

  /** `GET /api/retail/prices?currencyCode=&$filter=` (no credential): `eq` and `startswith(field, '...')` clauses joined by `and`. */
  private retail(r: RecordedRequest): Reply {
    const filter = r.query.get('$filter') ?? '';
    const clauses = [...filter.matchAll(/(\w+) eq '([^']*)'/g)].map((m) => [m[1]!, m[2]!] as const);
    const prefixes = [...filter.matchAll(/startswith\((\w+),\s*'([^']*)'\)/g)].map((m) => [m[1]!, m[2]!] as const);
    const currency = (r.query.get('currencyCode') ?? 'USD').replace(/'/g, '');
    const items = this.retailPrices.filter((p) => clauses.every(([k, v]) => k === 'priceType' ? p.type === v : String((p as Record<string, unknown>)[k] ?? '') === v) && prefixes.every(([k, v]) => String((p as Record<string, unknown>)[k] ?? '').startsWith(v))).map((p) => ({ ...p, currencyCode: p.currencyCode === 'USD' ? currency : p.currencyCode, retailPrice: p.retailPrice, unitPrice: p.retailPrice, isPrimaryMeterRegion: true }));
    return { status: 200, body: { BillingCurrency: currency, CustomerEntityId: 'Default', CustomerEntityType: 'Retail', Items: items, NextPageLink: null, Count: items.length } };
  }

  /** Sprint 58 (B-10203): AKS clusters' agent pools, credentials and role assignments (`fake-azure-aks.ts`). */
  readonly aks: FakeAks = new FakeAks(() => this.tokens);
  /** Sprint 59 (B-10301, B-10303, B-10307): Flexible Server particulars and management locks (`fake-azure-db.ts`). */
  readonly db = new FakeAzureDb();
  /** Sprint 59 (B-10305): cache hosts and access keys (`fake-cloud-caches.ts`). */
  readonly caches = new FakeAzureCaches();
  /** Sprint 58 (B-10204, B-10205): boot diagnostics, job executions and container app revisions (`fake-azure-compute.ts`). */
  readonly compute: FakeAzureCompute = new FakeAzureCompute({ resource: (k) => this.resources.get(k), origin: () => this.publicOrigin ?? this.url, settleAfter: () => this.settleAfter });

  protected async handle(r: RecordedRequest): Promise<Reply> {
    if (r.path.startsWith(FakeAzureCompute.LOG_PREFIX)) return this.compute.serialLog(r);
    if (r.op === 'retail:prices') return this.retail(r);
    if (r.op === 'entra:token') return this.token(r);
    if (r.op.startsWith('cosmos:')) return this.cosmos.handle(r);
    if (r.op.startsWith('keyvault:')) {
      const who = this.bearer(r, 'https://vault.azure.net');
      return 'status' in who ? who : this.keyVault.handle(r);
    }
    if (r.op.startsWith('blob:')) {
      if (!r.headers.authorization?.startsWith('SharedKey ')) {
        const who = this.bearer(r, 'https://storage.azure.com');
        if ('status' in who) return who;
      }
      return this.blobs.handle(r);
    }
    if (r.op.startsWith('graph:')) {
      const who = this.bearer(r, 'https://graph.microsoft.com');
      if ('status' in who) return who;
      return this.graph(r);
    }
    const who = this.bearer(r, 'https://management.azure.com');
    if ('status' in who) return who;
    if (!r.query.get('api-version')) return { status: 400, body: { error: { code: 'MissingApiVersionParameter', message: "The api-version query parameter (?api-version=) is required for all requests." } } };
    // Sprint 59 (B-10603): Cost Management queries from the costs a test adds (`addCost`).
    // Sprint 62 (B-10703): the Activity Log from the events a test adds (`addActivity`).
    const reply = r.op === 'cost:query' ? this.costQuery(r, who.tenantId) : r.op === 'arm:activity' ? this.activityLog(r) : this.arm(r, who.tenantId);
    reply.headers = { 'x-ms-request-id': randomUUID(), 'x-ms-ratelimit-remaining-subscription-reads': '11999', 'x-ms-ratelimit-remaining-subscription-writes': '1199', ...(reply.headers ?? {}) };
    return reply;
  }

  // ---------- Entra ----------

  private async token(r: RecordedRequest): Promise<Reply> {
    const tenantId = r.path.split('/')[1] ?? '';
    const f = new URLSearchParams(r.body);
    const err = (status: number, error: string, desc: string): Reply => ({ status, body: { error, error_description: desc, error_codes: [status === 401 ? 7000215 : 700016] } });
    if (f.get('grant_type') !== 'client_credentials') return err(400, 'unsupported_grant_type', 'AADSTS70003: The app requested an unsupported grant type.');
    const app = this.apps.get(f.get('client_id') ?? '');
    if (!app || app.tenantId !== tenantId) return err(400, 'unauthorized_client', `AADSTS700016: Application with identifier '${f.get('client_id')}' was not found in the directory '${tenantId}'.`);
    const scope = f.get('scope') ?? '';
    if (!/\/\.default$/.test(scope)) return err(400, 'invalid_scope', 'AADSTS1002012: The provided value for scope is not valid.');
    const assertion = f.get('client_assertion');
    if (assertion) {
      if (f.get('client_assertion_type') !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer') return err(400, 'invalid_request', 'AADSTS50027: Invalid client assertion type.');
      const claims = jwtClaims(assertion);
      this.assertions.push({ clientId: app.clientId, claims });
      if (!claims) return err(401, 'invalid_client', 'AADSTS50027: JWT token is invalid or malformed.');
      if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) return err(401, 'invalid_client', 'AADSTS700024: Client assertion is not within its valid time range.');
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      const ok = app.federated.some((fc) => fc.issuer === claims.iss && fc.subject === claims.sub && aud.includes(fc.audience));
      if (!ok) return err(401, 'invalid_client', `AADSTS700213: No matching federated identity record found for presented assertion subject '${String(claims.sub)}'.`);
      if (this.validateAssertion) {
        const problem = await this.validateAssertion(assertion, app);
        if (problem) return err(401, 'invalid_client', `AADSTS700211: ${problem}`);
      }
    } else {
      const secret = f.get('client_secret');
      const match = [...app.secrets.values()].find((s) => s.secretText === secret && Date.parse(s.endDateTime) > Date.now());
      if (!match) return err(401, 'invalid_client', 'AADSTS7000215: Invalid client secret provided.');
    }
    const token = `eyJ.fake-azure.${randomBytes(24).toString('base64url')}`;
    this.tokens.set(token, { tenantId, clientId: app.clientId, scope: scope.replace(/\/\.default$/, ''), exp: Date.now() + this.tokenSeconds * 1000 });
    return { status: 200, body: { token_type: 'Bearer', expires_in: this.tokenSeconds, ext_expires_in: this.tokenSeconds, access_token: token } };
  }

  // ---------- Graph ----------

  private graph(r: RecordedRequest): Reply {
    const m = /^\/v1\.0\/applications(?:\/([^/]+)|\(appId='([^']+)'\))(?:\/(addPassword|removePassword))?$/.exec(r.path);
    if (!m) return { status: 404, body: { error: { code: 'Request_ResourceNotFound', message: 'Resource not found.' } } };
    const app = m[1] ? [...this.apps.values()].find((a) => a.objectId === m[1]) : this.apps.get(m[2]!);
    if (!app) return { status: 404, body: { error: { code: 'Request_ResourceNotFound', message: `Resource '${m[1] ?? m[2]}' does not exist.` } } };
    const b = json(r);
    if (m[3] === 'addPassword' && r.method === 'POST') {
      const pc = (b.passwordCredential ?? {}) as { displayName?: string; endDateTime?: string };
      const keyId = randomUUID();
      const secretText = `fake~${randomBytes(18).toString('base64url')}`;
      const entry = { secretText, displayName: pc.displayName ?? '', startDateTime: new Date().toISOString(), endDateTime: pc.endDateTime ?? new Date(Date.now() + 180 * 864e5).toISOString() };
      app.secrets.set(keyId, entry);
      return { status: 200, body: { '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#microsoft.graph.passwordCredential', customKeyIdentifier: null, displayName: entry.displayName, endDateTime: entry.endDateTime, hint: secretText.slice(0, 3), keyId, secretText, startDateTime: entry.startDateTime } };
    }
    if (m[3] === 'removePassword' && r.method === 'POST') {
      const keyId = String(b.keyId ?? '');
      if (!app.secrets.delete(keyId)) return { status: 400, body: { error: { code: 'Request_BadRequest', message: `No password credential found with keyId '${keyId}'.` } } };
      return { status: 204 };
    }
    if (!m[3] && r.method === 'GET') return { status: 200, body: { id: app.objectId, appId: app.clientId, passwordCredentials: [...app.secrets.entries()].map(([keyId, s]) => ({ keyId, displayName: s.displayName, hint: s.secretText.slice(0, 3), startDateTime: s.startDateTime, endDateTime: s.endDateTime, secretText: null })) } };
    return { status: 405, body: { error: { code: 'Request_BadRequest', message: 'Method not allowed.' } } };
  }

  /** Sprint 60 (B-10405): compute usages by location (`*`: every location), as the usages API lists them. */
  readonly computeUsages = new Map<string, { family: string; localized: string; current: number; limit: number }[]>([
    [
      '*',
      [
        { family: 'cores', localized: 'Total Regional vCPUs', current: 8, limit: 350 },
        { family: 'standardNCADSH100v5Family', localized: 'Standard NCADS H100 v5 Family vCPUs', current: 0, limit: 80 },
        { family: 'standardNVADSA10v5Family', localized: 'Standard NVADS A10 v5 Family vCPUs', current: 0, limit: 72 }
      ]
    ]
  ]);

  // ---------- ARM ----------

  private notFound(id: string): Reply {
    return { status: 404, body: { error: { code: 'ResourceNotFound', message: `The Resource '${id}' was not found.` } } };
  }

  private view(res: ArmResource): Record<string, unknown> {
    return { ...res.body, id: res.id, name: res.name, type: res.type, ...(res.location ? { location: res.location } : {}), ...(res.tags && !res.type.toLowerCase().startsWith('microsoft.network/dnszones/') ? { tags: res.tags } : {}), etag: res.etag };
  }

  private opUrl(sub: string, ns: string, location: string, id: string, kind: 'async' | 'location', apiVersion: string): string {
    return `${this.publicOrigin ?? this.url}/subscriptions/${sub}/providers/${ns}/locations/${location}/${kind === 'async' ? 'operations' : 'asyncoperations'}/${id}?api-version=${apiVersion}`;
  }

  private arm(r: RecordedRequest, tenantId: string): Reply {
    if (r.op === 'arm:operation') return this.pollOp(r);
    const subM = /^\/subscriptions(?:\/([^/]+))?/i.exec(r.path);
    if (!subM) return { status: 404, body: { error: { code: 'NotFound', message: 'No route' } } };
    if (!subM[1]) return { status: 200, body: { value: [...this.subscriptions.entries()].filter(([, s]) => s.tenantId === tenantId).map(([id, s]) => ({ id: `/subscriptions/${id}`, subscriptionId: id, tenantId: s.tenantId, displayName: s.displayName, state: s.state })) } };
    const subId = subM[1].toLowerCase();
    const sub = this.subscriptions.get(subId);
    if (!sub || sub.tenantId !== tenantId) return { status: 404, body: { error: { code: 'SubscriptionNotFound', message: `The subscription '${subM[1]}' could not be found.` } } };
    if (/^\/subscriptions\/[^/]+$/i.test(r.path)) return { status: 200, body: { id: `/subscriptions/${subM[1]}`, subscriptionId: subM[1], tenantId, displayName: sub.displayName, state: sub.state, subscriptionPolicies: { locationPlacementId: 'Public_2014-09-01', quotaId: 'PayAsYouGo_2014-09-01', spendingLimit: 'Off' }, authorizationSource: 'RoleBased' } };
    if (r.op === 'arm:permissions') {
      const scope = r.path.replace(/\/providers\/Microsoft\.Authorization\/permissions$/i, '').toLowerCase();
      const best = [...this.permissions.entries()].filter(([k]) => scope.startsWith(k)).sort((a, b) => b[0].length - a[0].length)[0]![1];
      return { status: 200, body: { value: [{ actions: best.actions, notActions: best.notActions, dataActions: [], notDataActions: [] }] } };
    }
    // Sprint 60 (B-10405): the region's compute usages (vCPU quotas per VM family), from `computeUsages`.
    const usages = /^\/subscriptions\/[^/]+\/providers\/Microsoft\.Compute\/locations\/([^/]+)\/usages$/i.exec(r.path);
    if (usages && r.method === 'GET') {
      const list = this.computeUsages.get(usages[1]!.toLowerCase()) ?? this.computeUsages.get('*') ?? [];
      return { status: 200, body: { value: list.map((u) => ({ unit: 'Count', name: { value: u.family, localizedValue: u.localized }, currentValue: u.current, limit: u.limit })) } };
    }
    const cache = this.caches.handle(r, (k) => this.resources.get(k));
    if (cache) return cache;
    const extra = r.method === 'POST' ? this.compute.post(r) : r.method === 'GET' ? this.compute.get(r) : null;
    if (extra) return extra;
    // Sprint 58 (B-10203): what only AKS has (`fake-azure-aks.ts`).
    const dbr = this.db.handle(r, (k) => this.resources.get(k));
    if (dbr) return dbr;
    const aks = this.aks.handle(r, (k) => this.resources.get(k));
    if (aks) return aks;
    // Sprint 59 (B-10306): a resource type's list across the subscription, and a Cosmos DB account's read-only keys.
    const subList = /^\/subscriptions\/[^/]+\/providers\/([^/]+\/[^/]+)$/i.exec(r.path);
    if (subList && r.method === 'GET') return { status: 200, body: { value: [...this.resources.values()].filter((x) => x.id.toLowerCase().startsWith(`/subscriptions/${subId}/`) && x.type.toLowerCase() === subList[1]!.toLowerCase()).map((x) => this.view(x)) } };
    if (/\/providers\/Microsoft\.DocumentDB\/databaseAccounts\/[^/]+\/readonlykeys$/i.test(r.path) && r.method === 'POST') return this.resources.has(r.path.replace(/\/readonlykeys$/i, '').toLowerCase()) ? { status: 200, body: { primaryReadonlyMasterKey: this.cosmos.readKey, secondaryReadonlyMasterKey: this.cosmos.readKey } } : this.notFound(r.path);
    const key = r.path.toLowerCase();
    const { type, collection, location: _l } = parseArm(r.path);
    if (/^\/subscriptions\/[^/]+\/resourcegroups\/[^/]+\/resources$/i.test(r.path)) {
      const prefix = key.replace(/\/resources$/, '/');
      const filter = /tagName eq '([^']+)' and tagValue eq '([^']*)'/.exec(r.query.get('$filter') ?? '');
      return { status: 200, body: { value: [...this.resources.values()].filter((x) => x.id.toLowerCase().startsWith(prefix) && x.id.toLowerCase().includes('/providers/') && (!filter || x.tags?.[filter[1]!] === filter[2])).map((x) => this.view(x)) } };
    }
    if (collection) {
      const parent = key.slice(0, key.lastIndexOf('/'));
      const leaf = key.slice(key.lastIndexOf('/') + 1);
      const value = [...this.resources.values()].filter((x) => {
        const id = x.id.toLowerCase();
        const p = id.slice(0, id.lastIndexOf('/'));
        const owner = p.slice(0, p.lastIndexOf('/'));
        return leaf === 'recordsets' ? owner === parent && x.type.toLowerCase().startsWith('microsoft.network/dnszones/') : p === `${parent}/${leaf}` || (leaf === 'resourcegroups' && owner === parent.replace(/\/resourcegroups$/, '') && x.type === 'Microsoft.Resources/resourceGroups');
      });
      return { status: 200, body: { value: value.map((x) => this.view(x)) } };
    }
    const existing = this.resources.get(key);
    const rgM = /^(\/subscriptions\/[^/]+\/resourcegroups\/[^/]+)/i.exec(r.path);
    switch (r.method) {
      case 'GET':
        return existing ? { status: 200, headers: { etag: existing.etag }, body: this.view(existing) } : this.notFound(r.path);
      case 'PUT':
      case 'PATCH': {
        if (r.method === 'PATCH' && !existing) return this.notFound(r.path);
        if (r.headers['if-none-match'] === '*' && existing) return { status: 412, body: { error: { code: 'PreconditionFailed', message: 'The resource already exists.' } } };
        if (r.headers['if-match'] && r.headers['if-match'] !== '*' && r.headers['if-match'] !== existing?.etag) return { status: 412, body: { error: { code: 'PreconditionFailed', message: 'The ETag does not match.' } } };
        if (rgM && type !== 'Microsoft.Resources/resourceGroups' && !this.resources.has(rgM[1]!.toLowerCase())) return { status: 404, body: { error: { code: 'ResourceGroupNotFound', message: `Resource group '${rgM[1]!.split('/').pop()}' could not be found.` } } };
        const parentId = key.slice(0, key.lastIndexOf('/', key.lastIndexOf('/') - 1));
        if (type.split('/').length > 2 && !type.toLowerCase().startsWith('microsoft.network/dnszones/') && !this.resources.has(parentId)) return this.notFound(parentId);
        if (type.toLowerCase().startsWith('microsoft.network/dnszones/') && !this.resources.has(parentId)) return { status: 404, body: { error: { code: 'ParentResourceNotFound', message: `Can not perform requested operation on nested resource. Parent resource '${parentId.split('/').pop()}' not found.` } } };
        const b = json(r);
        const merged = r.method === 'PATCH' ? { ...existing!.body, ...b, properties: { ...(existing!.body.properties as object), ...((b.properties as object) ?? {}) } } : b;
        const lower = type.toLowerCase();
        const isAsync = ASYNC_NETWORK.has(lower) || ASYNC_LOCATION.has(lower);
        const props = { ...((merged.properties as Record<string, unknown>) ?? {}), provisioningState: isAsync ? (ASYNC_LOCATION.has(lower) ? 'Creating' : 'Updating') : 'Succeeded' };
        this.compute.decorate(lower, r.path, props);
        this.db.decorate(lower, r.path, props, existing, (k) => this.resources.get(k));
        if (lower === 'microsoft.storage/storageaccounts') Object.assign(props, { primaryEndpoints: { blob: `https://${r.path.split('/').pop()}.blob.core.windows.net/` } });
        if (lower.startsWith('microsoft.network/dnszones/')) Object.assign(props, { fqdn: `${r.path.split('/').pop()}.${r.path.split('/').slice(-3)[0]}.` });
        const segs = r.path.split('/');
        const res: ArmResource = { id: r.path, name: type === 'Microsoft.Resources/resourceGroups' ? segs[4]! : segs[segs.length - 1]!, type: lower.startsWith('microsoft.network/dnszones/') ? `Microsoft.Network/dnszones/${segs[segs.length - 2]}` : type, location: (merged.location as string | undefined) ?? existing?.location, tags: (merged.tags as Record<string, string> | undefined) ?? existing?.tags, etag: `W/"${randomUUID()}"`, body: { ...merged, properties: props } };
        this.resources.set(key, res);
        this.aks.afterPut(key, res, (k, v) => this.resources.set(k, v), (k) => this.resources.get(k));
        this.db.afterPut(lower, key, res, (k, v) => this.resources.set(k, v), (k) => this.resources.get(k), () => this.resources.entries());
        if (!isAsync) return { status: existing ? 200 : 201, headers: { etag: res.etag }, body: this.view(res) };
        const op: AsyncOp = { id: randomUUID(), status: 'InProgress', polls: 0, resourceId: key, kind: 'put' };
        if (this.failNextAsync && this.failNextAsync.type === lower) {
          op.error = { code: this.failNextAsync.code, message: this.failNextAsync.message };
          this.failNextAsync = null;
        }
        this.operations.set(op.id, op);
        const ns = type.split('/')[0]!;
        const loc = res.location ?? 'westeurope';
        if (ASYNC_LOCATION.has(lower)) return { status: 202, headers: { location: this.opUrl(subM[1], ns, loc, op.id, 'location', r.query.get('api-version')!), 'retry-after': '0' } };
        return { status: existing ? 200 : 201, headers: { 'azure-asyncoperation': this.opUrl(subM[1], ns, loc, op.id, 'async', r.query.get('api-version')!), etag: res.etag }, body: this.view(res) };
      }
      case 'DELETE': {
        if (!existing) return { status: 204 };
        const lower = type.toLowerCase();
        if (ASYNC_NETWORK.has(lower)) {
          const op: AsyncOp = { id: randomUUID(), status: 'InProgress', polls: 0, resourceId: key, kind: 'delete' };
          this.operations.set(op.id, op);
          const url = this.opUrl(subM[1], type.split('/')[0]!, existing.location ?? 'westeurope', op.id, 'async', r.query.get('api-version')!);
          return { status: 202, headers: { 'azure-asyncoperation': url, location: url, 'retry-after': '0' } };
        }
        this.remove(key);
        return { status: 200 };
      }
    }
    return { status: 405, body: { error: { code: 'MethodNotAllowed', message: 'Not allowed' } } };
  }

  private remove(key: string): void {
    for (const k of [...this.resources.keys()]) if (k === key || k.startsWith(`${key}/`)) this.resources.delete(k);
  }

  private pollOp(r: RecordedRequest): Reply {
    const id = r.path.split('/').pop()!;
    const op = this.operations.get(id);
    if (!op) return { status: 404, body: { error: { code: 'OperationNotFound', message: 'The operation was not found.' } } };
    op.polls += 1;
    if (op.status === 'InProgress' && op.polls > this.settleAfter) {
      op.status = op.error ? 'Failed' : 'Succeeded';
      const res = this.resources.get(op.resourceId);
      if (op.kind === 'delete') this.remove(op.resourceId);
      else if (res) (res.body.properties as Record<string, unknown>).provisioningState = op.status;
    }
    const location = /\/asyncoperations\//i.test(r.path);
    if (location) {
      if (op.status === 'InProgress') return { status: 202, headers: { location: `${this.publicOrigin ?? this.url}${r.path}?${r.query.toString()}`, 'retry-after': '0' } };
      const res = this.resources.get(op.resourceId);
      if (op.status === 'Failed') return { status: 400, body: { error: op.error } };
      return res ? { status: 200, body: this.view(res) } : { status: 204 };
    }
    return { status: 200, headers: op.status === 'InProgress' ? { 'retry-after': '0' } : {}, body: { id: `${r.path}`, name: id, status: op.status, startTime: new Date().toISOString(), ...(op.error && op.status === 'Failed' ? { error: op.error } : {}) } };
  }
}

/** The ARM resource type a path names, and whether it is a collection. */
export function parseArm(path: string): { type: string; collection: boolean; location?: string } {
  const segs = path.replace(/^\//, '').split('/');
  // subscriptions/{s}/resourceGroups/{rg}/providers/{ns}/{type}/{name}/{type}/{name}...
  const pi = segs.findIndex((s) => s.toLowerCase() === 'providers');
  if (pi < 0) {
    if (segs.length === 3 && segs[2]!.toLowerCase() === 'resourcegroups') return { type: 'Microsoft.Resources/resourceGroups', collection: true };
    if (segs.length === 4 && segs[2]!.toLowerCase() === 'resourcegroups') return { type: 'Microsoft.Resources/resourceGroups', collection: false };
    if (segs.length === 5 && segs[4]!.toLowerCase() === 'resources') return { type: 'Microsoft.Resources/resources', collection: true };
    return { type: 'Microsoft.Resources/subscriptions', collection: segs.length === 1 };
  }
  const ns = segs[pi + 1] ?? '';
  const rest = segs.slice(pi + 2);
  const types: string[] = [];
  for (let i = 0; i < rest.length; i += 2) types.push(rest[i]!);
  return { type: [ns, ...types].join('/'), collection: rest.length % 2 === 1 };
}
