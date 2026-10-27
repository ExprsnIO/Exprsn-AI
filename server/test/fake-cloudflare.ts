/*
 * 1.9.99-final, Sprint 56 (B-10109): an in-process stand-in for the Cloudflare API v4 (under `/client/v4`).
 * Working: token verify for user-owned and account-owned tokens, the token's own details with its policies (when the
 * token holds "API Tokens Read"), zones by name, DNS records (list with name and type filters, create, read, patch,
 * put, delete), R2 buckets and Cloudflare Tunnels; the account's audit logs (B-10703: `addAuditLog`, filtered by
 * `since` and `before`, paged). Basic (list, create, read, delete, no behaviour): Workers scripts,
 * Containers applications, Hyperdrive configs and AI Gateway gateways. Each route asks for one permission group by
 * name ("DNS Write", "Workers R2 Storage Read"...), and a token without it gets Cloudflare's 403 envelope; a throttled
 * call answers 429 with `Retry-After`. It is never the real Cloudflare.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { FakeCloudBase, json, type RecordedRequest, type Reply } from './fake-cloud-base.js';
import { FakeWorkersAi } from './fake-workers-ai.js';
import { FakeD1 } from './fake-d1.js';
import { FakeCloudflareApp } from './fake-cloudflare-app.js';
import { FakeCloudflareBilling } from './fake-cloudflare-billing.js';
import { EDGE_PERMISSIONS, FakeCloudflareEdge } from './fake-cloudflare-edge.js';

export interface FakeCfToken {
  id: string;
  value: string;
  status: 'active' | 'disabled' | 'expired';
  /** The account that owns it (an account-owned token), or null for a user token. */
  accountId: string | null;
  /** Permission group names this token holds. */
  permissions: Set<string>;
  expiresOn?: string;
}

interface DnsRecord { id: string; zone_id: string; zone_name: string; name: string; type: string; content: string; ttl: number; proxied: boolean; comment: string | null; tags: string[]; created_on: string; modified_on: string }
interface Zone { id: string; name: string; status: string; account: { id: string; name: string } }

const PERMISSION: [RegExp, string, string][] = [
  // [path pattern, read permission, write permission]
  // Sprint 61 (B-10901 to B-10904): zone settings, certificate packs, rulesets and Access (`fake-cloudflare-edge.ts`).
  ...EDGE_PERMISSIONS,
  [/^\/zones\/[^/]+\/dns_records/, 'DNS Read', 'DNS Write'],
  [/^\/zones/, 'Zone Read', 'Zone Write'],
  [/^\/accounts\/[^/]+\/r2\//, 'Workers R2 Storage Read', 'Workers R2 Storage Write'],
  [/^\/accounts\/[^/]+\/cfd_tunnel/, 'Cloudflare Tunnel Read', 'Cloudflare Tunnel Write'],
  [/^\/accounts\/[^/]+\/workers\//, 'Workers Scripts Read', 'Workers Scripts Write'],
  [/^\/accounts\/[^/]+\/containers\//, 'Containers Read', 'Containers Edit'],
  [/^\/accounts\/[^/]+\/hyperdrive\//, 'Hyperdrive Read', 'Hyperdrive Write'],
  [/^\/accounts\/[^/]+\/ai-gateway\//, 'AI Gateway Read', 'AI Gateway Write'],
  // Sprint 60 (B-10509): running a Workers AI model is a POST that "Workers AI Read" allows.
  [/^\/accounts\/[^/]+\/ai\//, 'Workers AI Read', 'Workers AI Read'],
  // Sprint 61 (B-10907): a D1 query is a POST that "D1 Read" allows here (the read-only connection never writes).
  [/^\/accounts\/[^/]+\/d1\//, 'D1 Read', 'D1 Read'],
  [/^\/(user|accounts\/[^/]+)\/tokens\/(?!verify)/, 'API Tokens Read', 'API Tokens Write'],
  // Sprint 61 (B-10608): the GraphQL Analytics API (a POST that "Account Analytics Read" allows) and the billing history.
  [/^\/graphql$/, 'Account Analytics Read', 'Account Analytics Read'],
  [/^\/accounts\/[^/]+\/billing\//, 'Billing Read', 'Billing Read'],
  // Sprint 62 (B-10703): the account's audit logs (the change trail on drift findings).
  [/^\/accounts\/[^/]+\/audit_logs/, 'Account Settings Read', 'Account Settings Write']
];

export class FakeCloudflare extends FakeCloudBase {
  readonly tokens = new Map<string, FakeCfToken>();
  accountId = randomBytes(16).toString('hex');
  readonly zones = new Map<string, Zone>();
  readonly records = new Map<string, DnsRecord>();
  readonly buckets = new Map<string, { name: string; creation_date: string; location: string; jurisdiction: string }>();
  readonly tunnels = new Map<string, { id: string; name: string; created_at: string; deleted_at: string | null; status: string; config_src: string; account_tag: string }>();
  /** Workers scripts, Containers applications, Hyperdrive configs and AI gateways, by kind and id. */
  readonly basic = new Map<string, Map<string, Record<string, unknown>>>();
  /** Sprint 60 (B-10509): Workers AI (`fake-workers-ai.ts`). */
  readonly workersAi = new FakeWorkersAi();
  /** Sprint 61 (B-10907): D1 databases (`fake-d1.ts`). */
  readonly d1 = new FakeD1();
  /** Sprint 61 (B-10905): Workers with static assets, Hyperdrive and Containers (`fake-cloudflare-app.ts`). */
  readonly app = new FakeCloudflareApp();
  /** Sprint 61 (B-10608): GraphQL Analytics and the billing history (`fake-cloudflare-billing.ts`). */
  readonly billing = new FakeCloudflareBilling(() => this.accountId);
  /** Sprint 61 (B-10901 to B-10904): the front door's settings, rulesets, tunnel tokens and configuration, Access (`fake-cloudflare-edge.ts`). */
  readonly edge = new FakeCloudflareEdge(() => this.zones, () => this.tunnels);

  /** Sprint 62 (B-10703): audit log entries `/accounts/<id>/audit_logs` answers (`addAuditLog`). */
  readonly auditLogs: { id: string; when: string; action: { type: string; result: boolean }; actor: { id: string; email: string; type: string; ip: string }; resource: { id: string; type: string }; metadata: Record<string, unknown>; newValueJson?: Record<string, unknown>; owner: { id: string } }[] = [];

  addAuditLog(o: { resourceId: string; resourceType?: string; action: string; at: number; email?: string; actorType?: string; ip?: string; name?: string; result?: boolean }): this {
    this.auditLogs.push({ id: randomUUID(), when: new Date(o.at).toISOString(), action: { type: o.action, result: o.result ?? true }, actor: { id: randomBytes(16).toString('hex'), email: o.email ?? 'someone@example.test', type: o.actorType ?? 'user', ip: o.ip ?? '192.0.2.44' }, resource: { id: o.resourceId, type: o.resourceType ?? 'DNS_record' }, metadata: o.name ? { name: o.name } : {}, ...(o.name ? { newValueJson: { name: o.name } } : {}), owner: { id: this.accountId } });
    return this;
  }

  addToken(permissions: string[], o: { accountOwned?: boolean; status?: FakeCfToken['status'] } = {}): FakeCfToken {
    const t: FakeCfToken = { id: randomBytes(16).toString('hex'), value: randomBytes(30).toString('base64url'), status: o.status ?? 'active', accountId: o.accountOwned ? this.accountId : null, permissions: new Set(permissions) };
    this.tokens.set(t.value, t);
    return t;
  }

  addZone(name: string): Zone {
    const z: Zone = { id: randomBytes(16).toString('hex'), name, status: 'active', account: { id: this.accountId, name: 'Exprsn test account' } };
    this.zones.set(z.id, z);
    return z;
  }

  protected classify(r: Omit<RecordedRequest, 'op'>): string {
    const p = r.path.replace(/^\/client\/v4/, '').replace(/\/[0-9a-f]{32}(?=\/|$)/g, '/{id}').replace(/\/[0-9a-f]{8}-[0-9a-f-]{27}/g, '/{id}');
    return `${r.method} ${p}`;
  }

  protected throttleReply(_r: RecordedRequest, retryAfterS: number): Reply {
    return { status: 429, headers: { 'retry-after': String(retryAfterS) }, body: { success: false, errors: [{ code: 971, message: 'Please wait and consider throttling your request speed' }], messages: [], result: null } };
  }

  private ok(result: unknown, info?: Record<string, unknown>, status = 200): Reply {
    return { status, body: { success: true, errors: [], messages: [], result, ...(info ? { result_info: info } : {}) } };
  }

  private err(status: number, code: number, message: string): Reply {
    return { status, body: { success: false, errors: [{ code, message }], messages: [], result: null } };
  }

  private list<T>(r: RecordedRequest, items: T[]): Reply {
    const per = Math.min(5000, Number(r.query.get('per_page')) || 100);
    const page = Math.max(1, Number(r.query.get('page')) || 1);
    const slice = items.slice((page - 1) * per, page * per);
    return this.ok(slice, { page, per_page: per, count: slice.length, total_count: items.length, total_pages: Math.max(1, Math.ceil(items.length / per)) });
  }

  protected handle(r: RecordedRequest): Reply {
    // Sprint 61 (B-10904): the Access team's signing keys, public as on <team>.cloudflareaccess.com.
    if (this.edge.publicMatches(r.path)) return this.edge.publicRoute();
    if (!r.path.startsWith('/client/v4/')) return this.err(404, 7000, 'No route for that URI');
    const path = r.path.slice('/client/v4'.length);
    const value = /^Bearer (.+)$/.exec(r.headers.authorization ?? '')?.[1] ?? '';
    const tok = this.tokens.get(value);
    // Sprint 61 (B-10905): a static asset upload carries its upload session's JWT, not an API token.
    if (!tok && this.app.acceptsJwt(path, value)) return this.app.route(r, path);
    if (!tok) return this.err(400, 1000, 'Invalid API Token');
    const verify = /^\/(user|accounts\/([^/]+))\/tokens\/verify$/.exec(path);
    if (verify) {
      if (verify[2] ? tok.accountId !== verify[2] : tok.accountId !== null) return this.err(401, 1000, 'Invalid API Token');
      return { status: 200, body: { success: tok.status === 'active', errors: tok.status === 'active' ? [] : [{ code: 1000, message: 'Invalid API Token' }], messages: [{ code: 10000, message: 'This API Token is valid and active', type: null }], result: { id: tok.id, status: tok.status, ...(tok.expiresOn ? { expires_on: tok.expiresOn } : {}) } } };
    }
    if (tok.status !== 'active') return this.err(401, 1000, 'Invalid API Token');
    const write = r.method !== 'GET' && r.method !== 'HEAD';
    const rule = PERMISSION.find(([re]) => re.test(path));
    // A write permission includes the read.
    if (rule && !tok.permissions.has(rule[2]) && (write || !tok.permissions.has(rule[1]))) return this.err(403, 10000, 'Authentication error');
    const acc = /^\/accounts\/([^/]+)/.exec(path)?.[1];
    if (acc && acc !== this.accountId) return this.err(403, 9109, 'Unauthorized to access requested resource');
    return this.route(r, path);
  }

  private route(r: RecordedRequest, path: string): Reply {
    if (this.edge.matches(path)) return this.edge.route(r, path);
    if (this.workersAi.matches(path)) return this.workersAi.route(r, path);
    if (this.d1.matches(path)) return this.d1.route(r, path);
    if (this.app.matches(path)) return this.app.route(r, path);
    if (this.billing.matches(path)) return this.billing.route(r, path);
    const b = json(r);
    const now = new Date().toISOString();
    let m: RegExpExecArray | null;
    if ((m = /^\/(user|accounts\/[^/]+)\/tokens\/([^/]+)$/.exec(path))) {
      const t = [...this.tokens.values()].find((x) => x.id === m![2]);
      if (!t) return this.err(404, 1003, 'Not found');
      const resources = { [`com.cloudflare.api.account.${this.accountId}`]: '*' };
      return this.ok({ id: t.id, name: 'exprsn-ai', status: t.status, issued_on: now, policies: [{ id: randomUUID(), effect: 'allow', resources, permission_groups: [...t.permissions].map((name) => ({ id: randomBytes(16).toString('hex'), name })) }] });
    }
    if (path === '/zones' && r.method === 'GET') {
      const name = r.query.get('name');
      return this.list(r, [...this.zones.values()].filter((z) => !name || z.name === name));
    }
    if ((m = /^\/zones\/([^/]+)$/.exec(path))) {
      const z = this.zones.get(m[1]!);
      return z ? this.ok(z) : this.err(404, 1001, 'Invalid zone identifier');
    }
    if ((m = /^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/.exec(path))) {
      const z = this.zones.get(m[1]!);
      if (!z) return this.err(404, 7003, 'Could not route to /zones/..., perhaps your object identifier is invalid?');
      const id = m[2];
      if (!id) {
        if (r.method === 'GET') {
          const name = r.query.get('name') ?? r.query.get('name.exact');
          const type = r.query.get('type');
          const comment = r.query.get('comment.contains');
          return this.list(r, [...this.records.values()].filter((x) => x.zone_id === z.id && (!name || x.name === name) && (!type || x.type === type) && (!comment || (x.comment ?? '').includes(comment))));
        }
        if (r.method === 'POST') {
          if (!b.type || !b.name || b.content == null) return this.err(400, 9000, 'DNS name, type and content are required.');
          const name = String(b.name) === '@' ? z.name : String(b.name).endsWith(z.name) ? String(b.name) : `${String(b.name)}.${z.name}`;
          if (['A', 'AAAA', 'CNAME'].includes(String(b.type)) && [...this.records.values()].some((x) => x.zone_id === z.id && x.name === name && (x.type === 'CNAME' || b.type === 'CNAME'))) return this.err(400, 81053, 'An A, AAAA, or CNAME record with that host already exists.');
          if ([...this.records.values()].some((x) => x.zone_id === z.id && x.name === name && x.type === b.type && x.content === String(b.content))) return this.err(400, 81058, 'An identical record already exists.');
          const rec: DnsRecord = { id: randomBytes(16).toString('hex'), zone_id: z.id, zone_name: z.name, name, type: String(b.type), content: String(b.content), ttl: Number(b.ttl ?? 1), proxied: Boolean(b.proxied), comment: (b.comment as string) ?? null, tags: (b.tags as string[]) ?? [], created_on: now, modified_on: now };
          this.records.set(rec.id, rec);
          return this.ok(rec);
        }
      }
      const rec = id ? this.records.get(id) : undefined;
      if (!rec || rec.zone_id !== z.id) return this.err(404, 81044, 'Record does not exist.');
      if (r.method === 'GET') return this.ok(rec);
      if (r.method === 'DELETE') {
        this.records.delete(rec.id);
        return this.ok({ id: rec.id });
      }
      if (r.method === 'PATCH' || r.method === 'PUT') {
        const next = r.method === 'PUT' ? { content: String(b.content ?? ''), ttl: Number(b.ttl ?? 1), proxied: Boolean(b.proxied), comment: (b.comment as string) ?? null, tags: (b.tags as string[]) ?? [] } : Object.fromEntries(Object.entries(b).filter(([k]) => ['type', 'content', 'ttl', 'proxied', 'comment', 'tags'].includes(k)));
        Object.assign(rec, next, { modified_on: now });
        return this.ok(rec);
      }
    }
    if ((m = /^\/accounts\/[^/]+\/r2\/buckets(?:\/([^/]+))?$/.exec(path))) {
      const name = m[1] ? decodeURIComponent(m[1]) : undefined;
      // Sprint 61 (B-10906): R2 answers within one jurisdiction (`cf-r2-jurisdiction`, default when absent).
      const jurisdiction = String(r.headers['cf-r2-jurisdiction'] || 'default');
      if (!name) {
        if (r.method === 'GET') return this.ok({ buckets: [...this.buckets.values()].filter((x) => x.jurisdiction === jurisdiction) });
        if (r.method === 'POST') {
          const n = String(b.name ?? '');
          if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(n)) return this.err(400, 10005, 'The bucket name is not valid.');
          if (this.buckets.has(n)) return this.err(409, 10004, 'The bucket you tried to create already exists, and you own it.');
          const bucket = { name: n, creation_date: now, location: String(b.locationHint ?? 'weur').toUpperCase(), jurisdiction };
          this.buckets.set(n, bucket);
          return this.ok(bucket);
        }
      }
      const bucket = name ? this.buckets.get(name) : undefined;
      if (!bucket || bucket.jurisdiction !== jurisdiction) return this.err(404, 10006, 'The specified bucket does not exist.');
      if (r.method === 'GET') return this.ok(bucket);
      if (r.method === 'DELETE') {
        this.buckets.delete(bucket.name);
        return this.ok({});
      }
    }
    if ((m = /^\/accounts\/[^/]+\/cfd_tunnel(?:\/([^/]+))?$/.exec(path))) {
      const id = m[1];
      if (!id) {
        if (r.method === 'GET') {
          const name = r.query.get('name');
          const deleted = r.query.get('is_deleted');
          return this.list(r, [...this.tunnels.values()].filter((t) => (!name || t.name === name) && (deleted === 'true' ? true : !t.deleted_at)));
        }
        if (r.method === 'POST') {
          if (!b.name) return this.err(400, 1003, 'name is required');
          if ([...this.tunnels.values()].some((t) => t.name === b.name && !t.deleted_at)) return this.err(409, 1013, 'You already have a tunnel with this name.');
          const t = { id: randomUUID(), name: String(b.name), created_at: now, deleted_at: null, status: 'inactive', config_src: String(b.config_src ?? 'cloudflare'), account_tag: this.accountId };
          this.tunnels.set(t.id, t);
          return this.ok(t);
        }
      }
      const t = id ? this.tunnels.get(id) : undefined;
      if (!t || t.deleted_at) return this.err(404, 1003, 'Tunnel not found');
      if (r.method === 'GET') return this.ok(t);
      if (r.method === 'DELETE') {
        t.deleted_at = now;
        return this.ok(t);
      }
    }
    if (/^\/accounts\/[^/]+\/audit_logs$/.test(path) && r.method === 'GET') {
      const since = r.query.get('since') ? Date.parse(r.query.get('since')!) : 0;
      const before = r.query.get('before') ? Date.parse(r.query.get('before')!) : Date.now() + 1;
      const asc = r.query.get('direction') === 'asc';
      const items = this.auditLogs.filter((e) => Date.parse(e.when) >= since && Date.parse(e.when) < before).sort((a, b) => (asc ? 1 : -1) * (Date.parse(a.when) - Date.parse(b.when)));
      return this.list(r, items);
    }
    const basic: [RegExp, string][] = [
      [/^\/accounts\/[^/]+\/workers\/scripts(?:\/([^/]+))?$/, 'workers'],
      [/^\/accounts\/[^/]+\/containers\/applications(?:\/([^/]+))?$/, 'containers'],
      [/^\/accounts\/[^/]+\/hyperdrive\/configs(?:\/([^/]+))?$/, 'hyperdrive'],
      [/^\/accounts\/[^/]+\/ai-gateway\/gateways(?:\/([^/]+))?$/, 'ai-gateway']
    ];
    for (const [re, kind] of basic) {
      const bm = re.exec(path);
      if (!bm) continue;
      const store = this.basic.get(kind) ?? new Map<string, Record<string, unknown>>();
      this.basic.set(kind, store);
      const id = bm[1] ? decodeURIComponent(bm[1]) : undefined;
      if (!id) {
        if (r.method === 'GET') return this.list(r, [...store.values()]);
        if (r.method === 'POST') {
          if (!b.name && !b.id) return this.err(400, 10021, 'A name is required.');
          const item = { id: String(b.id ?? b.name ?? randomUUID()), ...b, created_on: now };
          store.set(String(item.id), item);
          return this.ok(item);
        }
      } else {
        if (r.method === 'PUT') {
          const item = { id, ...b, modified_on: now };
          store.set(id, item);
          return this.ok(item);
        }
        const item = store.get(id);
        if (!item) return this.err(404, 10007, 'Not found');
        if (r.method === 'GET') return this.ok(item);
        if (r.method === 'DELETE') {
          store.delete(id);
          return this.ok({ id });
        }
      }
    }
    return this.err(404, 7000, 'No route for that URI');
  }
}
