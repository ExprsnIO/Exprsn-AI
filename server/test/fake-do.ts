/*
 * 1.9.99-final, Sprint 56 (B-10109): an in-process stand-in for the DigitalOcean API v2. Working: `/v2/account`,
 * VPCs, cloud firewalls (status `waiting`, then `succeeded` after `settleAfter` reads), domains and their records,
 * droplets with their create action and `/v2/actions/<id>` (in-progress, then completed), droplet snapshots (the
 * `snapshot` action and `/v2/droplets/<id>/snapshots`, B-10107), tags and tagging, `/v2/sizes`
 * with prices (B-10601), all with page/per_page paging; billing (B-10603): the balance, billing history, invoices with
 * the current month's preview, invoice items and the invoice CSV (`addInvoice`). DOKS clusters, node pools and credentials (Sprint 58, `fake-do-doks.ts`). Stubs that list: databases, apps, Spaces keys and GenAI agents.
 *
 * Tokens: each token has a set of custom scopes (`vpc:read`, `firewall:create`...) or full access (null). A route
 * checks its scope before it validates the body, as DigitalOcean does, so an empty create answers 422 to a token that
 * may create and 403 to one that may not. Rate limits: `ratelimit-limit`, `ratelimit-remaining` and `ratelimit-reset`
 * on every answer, per token, with a per-minute window (`perMinute`) and an hourly one (`perHour`) that answer 429
 * once spent. It is never the real DigitalOcean.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { FakeCloudBase, json, type RecordedRequest, type Reply } from './fake-cloud-base.js';
import { FakeDoApps } from './fake-do-apps.js';
import { FakeDoks } from './fake-do-doks.js';
import { FakeDoCaches } from './fake-cloud-caches.js';
import { FakeDoDatabases } from './fake-do-db.js';
import { FakeDoGenAi } from './fake-do-genai.js';

interface Vpc { id: string; urn: string; name: string; description: string; region: string; ip_range: string; default: boolean; created_at: string }
interface FirewallRule { protocol: string; ports: string; sources?: Record<string, string[]>; destinations?: Record<string, string[]> }
interface Firewall { id: string; name: string; status: string; inbound_rules: FirewallRule[]; outbound_rules: FirewallRule[]; droplet_ids: number[]; tags: string[]; created_at: string; pending_changes: unknown[]; reads: number }
interface DomainRecord { id: number; type: string; name: string; data: string; ttl: number; priority: number | null; port: number | null; weight: number | null; flags: number | null; tag: string | null }
interface Action { id: number; status: 'in-progress' | 'completed' | 'errored'; type: string; started_at: string; completed_at: string | null; resource_id: number; resource_type: string; region_slug: string; reads: number }
interface Droplet { id: number; name: string; status: string; region: { slug: string }; size_slug: string; tags: string[]; vpc_uuid: string; created_at: string }

export class FakeDigitalOcean extends FakeCloudBase {
  /** token → scopes (null: full access). */
  readonly tokens = new Map<string, Set<string> | null>();
  account = { uuid: randomUUID(), email: 'ops@example.test', team: { uuid: randomUUID(), name: 'Exprsn test team' } };
  perMinute = 250;
  /** The length of the "per minute" window (tests shorten it to drive a burst in seconds). */
  minuteMs = 60_000;
  /** Answers that went out as 429 because a window was spent (B-10108: a well-behaved client never sees one). */
  limited = 0;
  perHour = 5000;
  settleAfter = 1;
  readonly vpcs = new Map<string, Vpc>();
  readonly firewalls = new Map<string, Firewall>();
  readonly domains = new Map<string, DomainRecord[]>();
  readonly droplets = new Map<number, Droplet>();
  /** Sprint 60 (B-10405): the account's droplet limit (`/v2/account`), which the GPU quota check reads. */
  dropletLimit = 25;
  readonly actions = new Map<number, Action>();
  readonly tags = new Map<string, { resource_id: string; resource_type: string }[]>();
  /** Sprint 58 (B-10204): the cloud-init user data each droplet was created with. */
  readonly userData = new Map<number, string>();
  /** Sprint 58 (B-10205): App Platform (`fake-do-apps.ts`). */
  readonly appPlatform = new FakeDoApps(() => this.settleAfter);
  /** Sprint 58 (B-10203): DOKS (`fake-do-doks.ts`); `doks.acceptsToken` is what a cluster's API asks. */
  readonly doks = new FakeDoks(() => this.settleAfter);
  /** Sprint 59 (B-10306): database clusters `/v2/databases` lists (with the admin password, as DigitalOcean's API does) and their CA certificates (PEM). */
  readonly databases: { id: string; name: string; engine: string; region: string; status: string; connection: Record<string, unknown>; private_connection?: Record<string, unknown>; tags?: string[]; db_names?: string[] }[] = [];
  readonly databaseCa = new Map<string, string>();
  /** Sprint 59 (B-10305): managed Valkey clusters (`fake-cloud-caches.ts`), listed with the databases above. */
  readonly caches = new FakeDoCaches(() => this.settleAfter);
  /** Sprint 59 (B-10301, B-10303, B-10307): managed PostgreSQL and MySQL clusters (`fake-do-db.ts`), listed with the databases above. */
  readonly dbs = new FakeDoDatabases(() => this.settleAfter);
  /** Sprint 60 (B-10503): GenAI serverless inference, agents and their endpoints (`fake-do-genai.ts`). */
  readonly genai = new FakeDoGenAi(() => this.url);
  /** Droplet snapshots (B-10107): made by a droplet's `snapshot` action once it completes; they outlive the droplet. */
  readonly snapshots = new Map<string, { id: string; name: string; resource_id: string; resource_type: 'droplet'; created_at: string }>();
  private readonly windows = new Map<string, { minute: { n: number; ends: number }; hour: { n: number; ends: number } }>();
  private num = 100000;
  private readonly pendingSnapshots = new Map<number, string>();
  /** `/v2/sizes` (B-10601): droplet and GPU sizes with their monthly and hourly prices. */
  readonly sizes: { slug: string; memory: number; vcpus: number; disk: number; transfer: number; price_monthly: number; price_hourly: number; regions: string[]; available: boolean; description: string }[] = [
    { slug: 's-2vcpu-4gb', memory: 4096, vcpus: 2, disk: 80, transfer: 4, price_monthly: 24, price_hourly: 0.03571, regions: ['ams3', 'fra1', 'nyc3', 'sfo3', 'tor1'], available: true, description: 'Basic' },
    { slug: 's-4vcpu-8gb', memory: 8192, vcpus: 4, disk: 160, transfer: 5, price_monthly: 48, price_hourly: 0.07143, regions: ['ams3', 'fra1', 'nyc3', 'sfo3', 'tor1'], available: true, description: 'Basic' },
    { slug: 's-8vcpu-16gb', memory: 16384, vcpus: 8, disk: 320, transfer: 6, price_monthly: 96, price_hourly: 0.14286, regions: ['ams3', 'fra1', 'nyc3', 'sfo3', 'tor1'], available: true, description: 'Basic' },
    { slug: 'gpu-h100x1-80gb', memory: 245760, vcpus: 20, disk: 720, transfer: 15, price_monthly: 2482.56, price_hourly: 3.39, regions: ['nyc2', 'tor1'], available: true, description: 'H100 GPU' }
  ];

  addToken(scopes: string[] | null = null): string {
    const token = `dop_v1_${randomBytes(32).toString('hex')}`;
    this.tokens.set(token, scopes ? new Set(scopes) : null);
    return token;
  }

  protected classify(r: Omit<RecordedRequest, 'op'>): string {
    if (this.genai.matches(r.path)) return this.genai.classify(r);
    const p = r.path.replace(/^\/v2/, '').replace(/\/[0-9a-f]{8}-[0-9a-f-]{27}/g, '/{id}').replace(/\/\d+(?=\/|$)/g, '/{id}');
    const domainish = p.replace(/^\/domains\/[^/]+/, '/domains/{domain}');
    return `${r.method} ${domainish}`;
  }

  protected throttleReply(_r: RecordedRequest, retryAfterS: number): Reply {
    const reset = Math.ceil(Date.now() / 1000) + retryAfterS;
    return { status: 429, headers: { 'ratelimit-limit': String(this.perMinute), 'ratelimit-remaining': '0', 'ratelimit-reset': String(reset), 'retry-after': String(retryAfterS) }, body: { id: 'too_many_requests', message: 'API Rate limit exceeded.' } };
  }

  private scopeFor(r: RecordedRequest): string | null {
    const seg = r.path.replace(/^\/v2\//, '').split('/');
    const verb = r.method === 'GET' || r.method === 'HEAD' ? 'read' : r.method === 'POST' ? 'create' : r.method === 'DELETE' ? 'delete' : 'update';
    const res: Record<string, string> = { account: 'account', vpcs: 'vpc', firewalls: 'firewall', domains: 'domain', droplets: 'droplet', actions: 'actions', tags: 'tag', kubernetes: 'kubernetes', databases: 'database', apps: 'app', spaces: 'spaces_key', 'gen-ai': 'genai', customers: 'billing' };
    const base = res[seg[0] ?? ''];
    if (!base) return null;
    if (base === 'domain' && seg[2] === 'records') return `domain:${verb}`;
    if (base === 'tag' && seg[2] === 'resources') return 'tag:create';
    return `${base}:${verb}`;
  }

  private limits(token: string): Record<string, string> & { over?: string } {
    const now = Date.now();
    let w = this.windows.get(token);
    if (!w) this.windows.set(token, (w = { minute: { n: 0, ends: now + this.minuteMs }, hour: { n: 0, ends: now + 3_600_000 } }));
    if (w.minute.ends <= now) w.minute = { n: 0, ends: now + this.minuteMs };
    if (w.hour.ends <= now) w.hour = { n: 0, ends: now + 3_600_000 };
    w.minute.n += 1;
    w.hour.n += 1;
    const overMinute = w.minute.n > this.perMinute;
    const overHour = w.hour.n > this.perHour;
    const ends = overMinute ? w.minute.ends : w.hour.ends;
    const headers: Record<string, string> = { 'ratelimit-limit': String(this.perHour), 'ratelimit-remaining': String(Math.max(0, this.perHour - w.hour.n)), 'ratelimit-reset': String(Math.ceil(ends / 1000)) };
    if (overMinute || overHour) return { ...headers, 'retry-after': String(Math.max(1, Math.ceil((ends - now) / 1000))), over: '1' };
    return headers;
  }

  protected handle(r: RecordedRequest): Reply {
    // Sprint 60 (B-10503): the inference and agent endpoints take model and agent keys, not API tokens.
    if (this.genai.matches(r.path)) return this.genai.handle(r);
    const token = /^Bearer (.+)$/.exec(r.headers.authorization ?? '')?.[1] ?? '';
    if (!this.tokens.has(token)) return { status: 401, body: { id: 'Unauthorized', message: 'Unable to authenticate you' } };
    const { over, ...headers } = this.limits(token);
    if (over) {
      this.limited += 1;
      return { status: 429, headers, body: { id: 'too_many_requests', message: 'API Rate limit exceeded.' } };
    }
    const scopes = this.tokens.get(token)!;
    const need = this.scopeFor(r);
    if (scopes && need && !scopes.has(need)) return { status: 403, headers, body: { id: 'Forbidden', message: 'You are not authorized to perform this operation' } };
    const reply = this.route(r);
    reply.headers = { ...headers, ...(reply.headers ?? {}) };
    return reply;
  }

  private page<T>(r: RecordedRequest, key: string, items: T[]): Reply {
    const per = Math.min(200, Number(r.query.get('per_page')) || 20);
    const page = Math.max(1, Number(r.query.get('page')) || 1);
    const slice = items.slice((page - 1) * per, page * per);
    const last = Math.max(1, Math.ceil(items.length / per));
    const link = (n: number) => `${this.url}${r.path}?page=${n}&per_page=${per}`;
    return { status: 200, body: { [key]: slice, links: { pages: page < last ? { next: link(page + 1), last: link(last) } : {} }, meta: { total: items.length } } };
  }

  private unprocessable(message: string): Reply {
    return { status: 422, body: { id: 'unprocessable_entity', message } };
  }

  private notFound(): Reply {
    return { status: 404, body: { id: 'not_found', message: 'The resource you were accessing could not be found.' } };
  }

  // ---------- billing (B-10603) ----------

  /** The balance, invoices (the current month's preview and finished months) and their items a test sets. */
  readonly billing: {
    balance: { month_to_date_balance: string; account_balance: string; month_to_date_usage: string; generated_at: string };
    invoices: { invoice_uuid: string; invoice_id: string; invoice_period: string; amount: string; updated_at: string; preview?: boolean; items: { product: string; resource_id: string; resource_uuid: string; group_description: string; description: string; amount: string; duration: string; duration_unit: string; start_time: string; end_time: string; project_name: string; category: string }[] }[];
  } = { balance: { month_to_date_balance: '0.00', account_balance: '0.00', month_to_date_usage: '0.00', generated_at: new Date().toISOString() }, invoices: [] };

  /** An invoice (`preview: true` for the current month's) with its items; amounts are dollars as strings. */
  addInvoice(o: { period: string; preview?: boolean; items: { product: string; amount: string; resource_id?: string; resource_uuid?: string; description?: string; start_time?: string; end_time?: string }[] }): string {
    const uuid = randomUUID();
    const amount = o.items.reduce((n, i) => n + Number(i.amount), 0).toFixed(2);
    this.billing.invoices = this.billing.invoices.filter((i) => !(o.preview && i.preview));
    this.billing.invoices.push({ invoice_uuid: uuid, invoice_id: String(this.num++), invoice_period: o.period, amount, updated_at: new Date().toISOString(), preview: !!o.preview, items: o.items.map((i) => ({ product: i.product, resource_id: i.resource_id ?? '', resource_uuid: i.resource_uuid ?? '', group_description: '', description: i.description ?? i.product, amount: i.amount, duration: '744', duration_unit: 'Hours', start_time: i.start_time ?? `${o.period}-01T00:00:00Z`, end_time: i.end_time ?? '', project_name: 'Default', category: 'iaas' })) });
    if (o.preview) this.billing.balance = { ...this.billing.balance, month_to_date_usage: amount, month_to_date_balance: amount, generated_at: new Date().toISOString() };
    return uuid;
  }

  /** `/v2/customers/my/balance`, `/billing_history`, `/invoices`, `/invoices/<uuid>` (items, paged) and `/invoices/<uuid>/csv`. */
  private billingRoute(r: RecordedRequest, seg: string[]): Reply {
    if (r.method !== 'GET') return this.notFound();
    const view = (i: (typeof this.billing.invoices)[number]) => ({ invoice_uuid: i.invoice_uuid, invoice_id: i.invoice_id, amount: i.amount, invoice_period: i.invoice_period, updated_at: i.updated_at });
    if (seg[0] === 'balance') return { status: 200, body: this.billing.balance };
    if (seg[0] === 'billing_history') return this.page(r, 'billing_history', this.billing.invoices.filter((i) => !i.preview).map((i) => ({ description: `Invoice for ${i.invoice_period}`, amount: i.amount, invoice_id: i.invoice_id, invoice_uuid: i.invoice_uuid, date: i.updated_at, type: 'Invoice' })));
    if (seg[0] !== 'invoices') return this.notFound();
    if (!seg[1]) {
      const preview = this.billing.invoices.find((i) => i.preview);
      const listed = this.page(r, 'invoices', this.billing.invoices.filter((i) => !i.preview).map(view));
      (listed.body as Record<string, unknown>).invoice_preview = preview ? view(preview) : null;
      return listed;
    }
    const inv = this.billing.invoices.find((i) => i.invoice_uuid === seg[1]);
    if (!inv) return this.notFound();
    if (seg[2] === 'csv') {
      const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
      const lines = ['product,group_description,description,hours,start,end,USD,project_name,category', ...inv.items.map((i) => [i.product, i.group_description, i.description, i.duration, i.start_time, i.end_time, i.amount, i.project_name, i.category].map(esc).join(','))];
      return { status: 200, headers: { 'content-type': 'text/csv' }, body: lines.join('\n') + '\n' };
    }
    return this.page(r, 'invoice_items', inv.items);
  }

  private route(r: RecordedRequest): Reply {
    const seg = r.path.replace(/^\/v2\//, '').split('/');
    const b = json(r);
    const now = new Date().toISOString();
    switch (seg[0]) {
      case 'customers':
        // Sprint 59 (B-10603): balance, invoices, invoice items and the invoice CSV (`billing`).
        return this.billingRoute(r, seg.slice(2));
      case 'account':
        return { status: 200, body: { account: { droplet_limit: this.dropletLimit, floating_ip_limit: 3, volume_limit: 100, email: this.account.email, uuid: this.account.uuid, email_verified: true, status: 'active', status_message: '', team: this.account.team } } };
      case 'vpcs': {
        const id = seg[1];
        if (!id) {
          if (r.method === 'GET') return this.page(r, 'vpcs', [...this.vpcs.values()]);
          if (!b.name || !b.region) return this.unprocessable('name and region are required');
          if ([...this.vpcs.values()].some((v) => v.name === b.name)) return this.unprocessable(`A VPC with the name ${String(b.name)} already exists.`);
          const v: Vpc = { id: randomUUID(), urn: '', name: String(b.name), description: String(b.description ?? ''), region: String(b.region), ip_range: String(b.ip_range ?? '10.10.0.0/20'), default: false, created_at: now };
          v.urn = `do:vpc:${v.id}`;
          this.vpcs.set(v.id, v);
          return { status: 201, body: { vpc: v } };
        }
        const v = this.vpcs.get(id);
        if (!v) return this.notFound();
        if (r.method === 'GET') return { status: 200, body: { vpc: v } };
        if (r.method === 'DELETE') {
          this.vpcs.delete(id);
          return { status: 204 };
        }
        Object.assign(v, { ...(b.name ? { name: String(b.name) } : {}), ...(b.description != null ? { description: String(b.description) } : {}) });
        return { status: 200, body: { vpc: v } };
      }
      case 'firewalls': {
        const id = seg[1];
        const view = (f: Firewall) => {
          const { reads: _reads, ...rest } = f;
          return rest;
        };
        if (!id) {
          if (r.method === 'GET') return this.page(r, 'firewalls', [...this.firewalls.values()].map(view));
          if (!b.name) return this.unprocessable('name is required');
          const f: Firewall = { id: randomUUID(), name: String(b.name), status: 'waiting', inbound_rules: (b.inbound_rules as FirewallRule[]) ?? [], outbound_rules: (b.outbound_rules as FirewallRule[]) ?? [], droplet_ids: (b.droplet_ids as number[]) ?? [], tags: (b.tags as string[]) ?? [], created_at: now, pending_changes: [], reads: 0 };
          this.firewalls.set(f.id, f);
          return { status: 202, body: { firewall: view(f) } };
        }
        const f = this.firewalls.get(id);
        if (!f) return this.notFound();
        if (r.method === 'GET') {
          f.reads += 1;
          if (f.status === 'waiting' && f.reads > this.settleAfter) f.status = 'succeeded';
          return { status: 200, body: { firewall: view(f) } };
        }
        if (r.method === 'DELETE') {
          this.firewalls.delete(id);
          return { status: 204 };
        }
        if (r.method === 'PUT') {
          Object.assign(f, { name: String(b.name ?? f.name), inbound_rules: (b.inbound_rules as FirewallRule[]) ?? [], outbound_rules: (b.outbound_rules as FirewallRule[]) ?? [], tags: (b.tags as string[]) ?? f.tags, status: 'waiting', reads: 0 });
          return { status: 200, body: { firewall: view(f) } };
        }
        break;
      }
      case 'domains': {
        const name = seg[1] ? decodeURIComponent(seg[1]) : undefined;
        if (!name) {
          if (r.method === 'GET') return this.page(r, 'domains', [...this.domains.keys()].map((d) => ({ name: d, ttl: 1800, zone_file: '' })));
          if (!b.name) return this.unprocessable('name is required');
          if (this.domains.has(String(b.name))) return this.unprocessable('Name already exists');
          this.domains.set(String(b.name), [{ id: this.num++, type: 'NS', name: '@', data: 'ns1.digitalocean.com', ttl: 1800, priority: null, port: null, weight: null, flags: null, tag: null }]);
          return { status: 201, body: { domain: { name: b.name, ttl: 1800, zone_file: null } } };
        }
        const records = this.domains.get(name);
        if (!records) return this.notFound();
        if (seg[2] !== 'records') {
          if (r.method === 'DELETE') {
            this.domains.delete(name);
            return { status: 204 };
          }
          return { status: 200, body: { domain: { name, ttl: 1800, zone_file: '' } } };
        }
        const rid = seg[3] ? Number(seg[3]) : undefined;
        if (rid === undefined) {
          if (r.method === 'GET') {
            const type = r.query.get('type');
            const full = r.query.get('name');
            const rel = full ? (full === name ? '@' : full.endsWith(`.${name}`) ? full.slice(0, -(name.length + 1)) : full) : null;
            return this.page(r, 'domain_records', records.filter((x) => (!type || x.type === type) && (!rel || x.name === rel)));
          }
          if (!b.type || b.data == null || !b.name) return this.unprocessable('type, name and data are required');
          const rec: DomainRecord = { id: this.num++, type: String(b.type), name: String(b.name), data: String(b.data), ttl: Number(b.ttl ?? 1800), priority: (b.priority as number) ?? null, port: null, weight: null, flags: null, tag: null };
          records.push(rec);
          return { status: 201, body: { domain_record: rec } };
        }
        const rec = records.find((x) => x.id === rid);
        if (!rec) return this.notFound();
        if (r.method === 'GET') return { status: 200, body: { domain_record: rec } };
        if (r.method === 'DELETE') {
          records.splice(records.indexOf(rec), 1);
          return { status: 204 };
        }
        Object.assign(rec, { ...(b.data != null ? { data: String(b.data) } : {}), ...(b.ttl != null ? { ttl: Number(b.ttl) } : {}), ...(b.name ? { name: String(b.name) } : {}) });
        return { status: 200, body: { domain_record: rec } };
      }
      case 'droplets': {
        const id = seg[1] ? Number(seg[1]) : undefined;
        if (id === undefined) {
          if (r.method === 'GET') {
            const tag = r.query.get('tag_name');
            return this.page(r, 'droplets', [...this.droplets.values()].filter((d) => !tag || d.tags.includes(tag)));
          }
          if (!b.name || !b.region || !b.size || !b.image) return this.unprocessable('name, region, size and image are required');
          const d: Droplet = { id: this.num++, name: String(b.name), status: 'new', region: { slug: String(b.region) }, size_slug: String(b.size), tags: (b.tags as string[]) ?? [], vpc_uuid: String(b.vpc_uuid ?? ''), created_at: now };
          this.droplets.set(d.id, d);
          if (typeof b.user_data === 'string') this.userData.set(d.id, b.user_data);
          const a = this.action('create', d.id, 'droplet', d.region.slug);
          return { status: 202, body: { droplet: d, links: { actions: [{ id: a.id, rel: 'create', href: `${this.url}/v2/actions/${a.id}` }] } } };
        }
        const d = this.droplets.get(id);
        if (!d) return this.notFound();
        if (seg[2] === 'actions' && r.method === 'POST') {
          if (b.type !== 'snapshot') return this.unprocessable(`The action ${String(b.type)} is not offered by this fake.`);
          const a = this.action('snapshot', d.id, 'droplet', d.region.slug);
          this.pendingSnapshots.set(a.id, String(b.name ?? `${d.name}-${Date.now()}`));
          return { status: 201, body: { action: { id: a.id, status: a.status, type: a.type, resource_id: d.id, resource_type: 'droplet' } } };
        }
        if (seg[2] === 'snapshots') return this.page(r, 'snapshots', [...this.snapshots.values()].filter((x) => x.resource_id === String(d.id)));
        if (r.method === 'DELETE') {
          this.droplets.delete(id);
          return { status: 204 };
        }
        return { status: 200, body: { droplet: d } };
      }
      case 'actions': {
        if (!seg[1]) return this.page(r, 'actions', [...this.actions.values()].map(({ reads: _r, ...a }) => a));
        const a = this.actions.get(Number(seg[1]));
        if (!a) return this.notFound();
        a.reads += 1;
        if (a.status === 'in-progress' && a.reads > this.settleAfter) {
          a.status = 'completed';
          a.completed_at = new Date().toISOString();
          const d = this.droplets.get(a.resource_id);
          if (d && a.type === 'create') d.status = 'active';
          const snap = this.pendingSnapshots.get(a.id);
          if (snap) {
            this.pendingSnapshots.delete(a.id);
            const id = String(this.num++);
            this.snapshots.set(id, { id, name: snap, resource_id: String(a.resource_id), resource_type: 'droplet', created_at: new Date().toISOString() });
          }
        }
        const { reads: _reads, ...rest } = a;
        return { status: 200, body: { action: rest } };
      }
      case 'tags': {
        // Sprint 59 (B-10307): tagging databases (deletion protection is a tag on DigitalOcean).
        const dbTag = this.dbs.tagRoute(r, seg, b);
        if (dbTag) return dbTag;
        const name = seg[1] ? decodeURIComponent(seg[1]) : undefined;
        if (!name) {
          if (r.method === 'GET') return this.page(r, 'tags', [...this.tags.keys()].map((t) => ({ name: t, resources: { count: this.tags.get(t)!.length } })));
          if (!b.name) return this.unprocessable('name is required');
          if (!this.tags.has(String(b.name))) this.tags.set(String(b.name), []);
          return { status: 201, body: { tag: { name: b.name, resources: { count: 0 } } } };
        }
        const list = this.tags.get(name);
        if (!list) return this.notFound();
        if (seg[2] === 'resources' && r.method === 'POST') {
          for (const x of (b.resources as { resource_id: string; resource_type: string }[]) ?? []) if (!list.some((y) => y.resource_id === x.resource_id)) list.push(x);
          for (const x of (b.resources as { resource_id: string; resource_type: string }[]) ?? []) {
            const d = this.droplets.get(Number(x.resource_id));
            if (d && !d.tags.includes(name)) d.tags.push(name);
          }
          return { status: 204 };
        }
        if (r.method === 'DELETE') {
          this.tags.delete(name);
          return { status: 204 };
        }
        return { status: 200, body: { tag: { name, resources: { count: list.length } } } };
      }
      case 'kubernetes':
        // Sprint 58 (B-10203): clusters, node pools, credentials (`fake-do-doks.ts`).
        return this.doks.route(r, seg, b, (key, items) => this.page(r, key, items));
      case 'databases': {
        // Sprint 59 (B-10305): managed Valkey clusters (`fake-cloud-caches.ts`); the rest below.
        const cache = this.caches.route(r, seg, b, this.databases);
        if (cache) return cache;
        // Sprint 59 (B-10301, B-10303): PostgreSQL and MySQL clusters (`fake-do-db.ts`), and the list with the tag filter.
        const db = this.dbs.route(r, seg, b, this.databases);
        if (db) return db;
        // Sprint 59 (B-10306): the clusters a test adds, one cluster, and its CA.
        if (r.method !== 'GET') return { status: 200, body: { databases: [] } };
        if (!seg[1]) return { status: 200, body: { databases: this.databases } };
        const d = this.databases.find((x) => x.id === seg[1]);
        if (!d) return this.notFound();
        if (seg[2] === 'ca') return { status: 200, body: { ca: { certificate: Buffer.from(this.databaseCa.get(d.id) ?? '').toString('base64') } } };
        return { status: 200, body: { database: d } };
      }
      case 'apps':
        return this.appPlatform.route(r, seg, b);
      case 'spaces':
        return this.page(r, 'keys', []);
      case 'gen-ai':
        return this.genai.api(seg) ?? this.page(r, 'agents', []);
      case 'sizes':
        return this.page(r, 'sizes', this.sizes);
    }
    return this.notFound();
  }

  private action(type: string, resourceId: number, resourceType: string, region: string): Action {
    const a: Action = { id: this.num++, status: 'in-progress', type, started_at: new Date().toISOString(), completed_at: null, resource_id: resourceId, resource_type: resourceType, region_slug: region, reads: 0 };
    this.actions.set(a.id, a);
    return a;
  }
}
