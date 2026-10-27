/*
 * 1.9.99-final, Sprint 59 (B-10301, B-10303, B-10307): DigitalOcean Managed PostgreSQL and MySQL for the DigitalOcean
 * fake (`fake-do.ts` routes `/v2/databases` here after the Valkey clusters). Clusters (creating or forking, then online
 * after `settleAfter` reads; resizing), the database firewall (trusted sources), the maintenance window, the engine
 * config, daily backups (one when a cluster comes online), forks and restores through `backup_restore` (from a
 * cluster's name and, optionally, a point in time inside its seven days), and tags on databases (`/v2/tags/<tag>/resources`
 * with `resource_type: database`, to tag and untag). DigitalOcean answers a new cluster with its admin password, so this
 * fake does too (the adapter must drop it). Every cluster is also put in the shared list `/v2/databases` answers. It is
 * never the real DigitalOcean.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { RecordedRequest, Reply } from './fake-cloud-base.js';

export interface FakeDoDb {
  id: string;
  name: string;
  engine: string;
  version: string;
  status: string;
  size: string;
  region: string;
  num_nodes: number;
  private_network_uuid?: string;
  storage_size_mib?: number;
  tags: string[];
  maintenance_window: { day: string; hour: string; pending: boolean } | null;
  connection: Record<string, unknown>;
  private_connection: Record<string, unknown>;
  created_at: string;
  /** Not in DigitalOcean's answer: the fake's own state. */
  reads: number;
  firewall: { uuid: string; type: string; value: string }[];
  config: Record<string, unknown>;
  backups: { created_at: string; size_gigabytes: number }[];
  restoredFrom: { database_name: string; backup_created_at?: string } | null;
}

const unprocessable = (message: string): Reply => ({ status: 422, body: { id: 'unprocessable_entity', message } });
const notFound = (): Reply => ({ status: 404, body: { id: 'not_found', message: 'The resource you were accessing could not be found.' } });

export class FakeDoDatabases {
  readonly clusters = new Map<string, FakeDoDb>();

  constructor(private readonly settleAfter: () => number) {}

  view(c: FakeDoDb): Record<string, unknown> {
    const { reads: _r, firewall: _f, config: _c, backups: _b, restoredFrom: _x, ...rest } = c;
    return rest;
  }

  private settle(c: FakeDoDb): void {
    c.reads += 1;
    if (['creating', 'forking', 'restoring', 'resizing', 'migrating'].includes(c.status) && c.reads > this.settleAfter()) {
      c.status = 'online';
      if (!c.backups.length) c.backups.push({ created_at: new Date().toISOString(), size_gigabytes: 0.05 });
    }
  }

  /** `/v2/tags/<tag>/resources` for databases (tag and untag); null for anything else. */
  tagRoute(r: RecordedRequest, seg: string[], b: Record<string, unknown>): Reply | null {
    if (seg[0] !== 'tags' || seg[2] !== 'resources') return null;
    const res = (b.resources as { resource_id: string; resource_type: string }[] | undefined) ?? [];
    if (!res.length || !res.every((x) => x.resource_type === 'database')) return null;
    const tag = decodeURIComponent(seg[1]!);
    for (const x of res) {
      const c = this.clusters.get(x.resource_id);
      if (!c) return notFound();
      if (r.method === 'POST' && !c.tags.includes(tag)) c.tags.push(tag);
      if (r.method === 'DELETE') c.tags = c.tags.filter((t) => t !== tag);
    }
    return { status: 204 };
  }

  /** `/v2/databases` for PostgreSQL and MySQL; null hands the request on (other engines, a test's own clusters). */
  route(r: RecordedRequest, seg: string[], b: Record<string, unknown>, shared: { id: string; tags?: string[] | null }[]): Reply | null {
    if (!seg[1]) {
      if (r.method === 'GET') {
        const tag = r.query.get('tag_name');
        for (const c of this.clusters.values()) this.settle(c);
        const list = shared.filter((x) => !tag || (x.tags ?? []).includes(tag)).map((x) => (this.clusters.has(x.id) ? this.view(this.clusters.get(x.id)!) : x));
        return { status: 200, body: { databases: list, links: {}, meta: { total: list.length } } };
      }
      if (r.method !== 'POST' || (b.engine !== 'pg' && b.engine !== 'mysql')) return null;
      if (!b.name || !b.size || !b.region) return unprocessable('name, size and region are required');
      if ([...this.clusters.values()].some((c) => c.name === b.name)) return unprocessable(`A database cluster named ${String(b.name)} already exists.`);
      const restore = (b.backup_restore as { database_name: string; backup_created_at?: string } | undefined) ?? null;
      if (restore) {
        const src = [...this.clusters.values()].find((c) => c.name === restore.database_name);
        if (!src) return unprocessable(`No database cluster named ${restore.database_name} to restore from.`);
        if (restore.backup_created_at && Date.parse(restore.backup_created_at) < Date.now() - 7 * 86_400_000) return unprocessable('The point in time is outside the seven days of backups.');
      }
      const id = randomUUID();
      const password = `AVNS_${randomBytes(12).toString('base64url')}`;
      const engine = String(b.engine);
      const host = `${String(b.name)}-do-user-1.b.db.ondigitalocean.com`;
      const port = 25060;
      const c: FakeDoDb = {
        id,
        name: String(b.name),
        engine,
        version: String(b.version ?? (engine === 'mysql' ? '8' : '17')),
        status: restore ? 'forking' : 'creating',
        size: String(b.size),
        region: String(b.region),
        num_nodes: Number(b.num_nodes ?? 1),
        ...(b.private_network_uuid ? { private_network_uuid: String(b.private_network_uuid) } : {}),
        ...(b.storage_size_mib ? { storage_size_mib: Number(b.storage_size_mib) } : {}),
        tags: (b.tags as string[]) ?? [],
        maintenance_window: { day: 'tuesday', hour: '08:00:00', pending: false },
        connection: { protocol: engine === 'mysql' ? 'mysql' : 'postgresql', host, port, user: 'doadmin', password, database: 'defaultdb', ssl: true },
        private_connection: { protocol: engine === 'mysql' ? 'mysql' : 'postgresql', host: `private-${host}`, port, user: 'doadmin', password, database: 'defaultdb', ssl: true },
        created_at: new Date().toISOString(),
        reads: 0,
        firewall: [],
        config: {},
        backups: [],
        restoredFrom: restore
      };
      this.clusters.set(id, c);
      shared.push(c as unknown as { id: string; tags?: string[] });
      return { status: 201, body: { database: this.view(c) } };
    }
    const c = this.clusters.get(seg[1]!);
    if (!c) return null;
    const sub = seg[2];
    if (!sub) {
      if (r.method === 'GET') {
        this.settle(c);
        return { status: 200, body: { database: this.view(c) } };
      }
      if (r.method === 'DELETE') {
        this.clusters.delete(c.id);
        const i = shared.findIndex((x) => x.id === c.id);
        if (i >= 0) shared.splice(i, 1);
        return { status: 204 };
      }
    }
    switch (sub) {
      case 'firewall':
        if (r.method === 'GET') return { status: 200, body: { rules: c.firewall.map((f) => ({ ...f, cluster_uuid: c.id, created_at: c.created_at })) } };
        if (r.method === 'PUT') {
          const rules = (b.rules as { type: string; value: string }[] | undefined) ?? [];
          if (rules.some((x) => !['ip_addr', 'droplet', 'k8s', 'tag', 'app'].includes(x.type))) return unprocessable('rule type must be ip_addr, droplet, k8s, tag or app');
          c.firewall = rules.map((x) => ({ uuid: randomUUID(), type: x.type, value: x.value }));
          return { status: 204 };
        }
        break;
      case 'maintenance':
        if (r.method === 'PUT') {
          if (!b.day || !/^\d{2}:\d{2}$/.test(String(b.hour ?? ''))) return unprocessable('day and hour (HH:MM) are required');
          c.maintenance_window = { day: String(b.day), hour: `${String(b.hour)}:00`, pending: false };
          return { status: 204 };
        }
        break;
      case 'config':
        if (r.method === 'GET') return { status: 200, body: { config: c.config } };
        if (r.method === 'PATCH') {
          Object.assign(c.config, (b.config as Record<string, unknown>) ?? {});
          return { status: 200, body: { config: c.config } };
        }
        break;
      case 'resize':
        if (r.method === 'PUT') {
          Object.assign(c, { size: String(b.size ?? c.size), num_nodes: Number(b.num_nodes ?? c.num_nodes), ...(b.storage_size_mib ? { storage_size_mib: Number(b.storage_size_mib) } : {}), status: 'resizing', reads: 0 });
          return { status: 202 };
        }
        break;
      case 'backups':
        if (r.method === 'GET') return { status: 200, body: { backups: c.backups, links: {}, meta: { total: c.backups.length } } };
        break;
      case 'ca':
        return null;
    }
    return { status: 405, body: { id: 'method_not_allowed', message: 'Not allowed' } };
  }
}
