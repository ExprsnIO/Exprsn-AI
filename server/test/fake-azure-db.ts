/*
 * 1.9.99-final, Sprint 59 (B-10301, B-10303, B-10307): Azure Database for PostgreSQL and MySQL Flexible Server for
 * `fake-azure.ts`. Servers, their configurations (server parameters) and backups are ordinary ARM resources there
 * (servers PUT asynchronously through `Azure-AsyncOperation`); this adds what is particular to them:
 *
 * - a server PUT gets its FQDN and state, and once it settles an automatic backup (the provider's own); a
 *   point-in-time restore (`createMode: PointInTimeRestore`) copies the source's server parameters and version;
 * - `azure.extensions` is checked against the extensions Azure offers (an unknown name is refused, as Azure refuses
 *   it), and `availableExtensions` is what `CREATE EXTENSION` would allow on a server (its allow-list);
 * - management locks (`.../providers/Microsoft.Authorization/locks/<name>`) at a server's scope, and a DELETE of a
 *   locked server answers 409 `ScopeLocked`, as ARM does;
 * - on-demand backups (`backups/<name>` PUT) answer with a completed time.
 *
 * It is never the real Azure.
 */
import type { RecordedRequest, Reply } from './fake-cloud-base.js';

interface ArmLike {
  id: string;
  name: string;
  type: string;
  location?: string;
  tags?: Record<string, string>;
  etag: string;
  body: Record<string, unknown>;
}

const SERVER = /^(\/subscriptions\/[^/]+\/resourcegroups\/[^/]+\/providers\/microsoft\.dbfor(?:postgresql|mysql)\/flexibleservers\/[^/]+)/i;
/** The extensions `azure.extensions` takes in this fake (a subset of Azure's list). */
export const AZURE_PG_EXTENSIONS = ['VECTOR', 'POSTGIS', 'PG_TRGM', 'PG_STAT_STATEMENTS', 'PGCRYPTO', 'UUID-OSSP', 'HSTORE', 'CITEXT'];

export class FakeAzureDb {
  readonly locks = new Map<string, { scope: string; name: string; level: string }>();
  /** Server PUT bodies as sent (the admin password is dropped as it arrives; only whether one came is kept). */
  readonly puts: { id: string; body: Record<string, unknown>; password: boolean }[] = [];

  /** The calls only Flexible Server and locks have; null for the generic ARM handling. */
  handle(r: RecordedRequest, resource: (key: string) => ArmLike | undefined): Reply | null {
    const lock = /^(.*)\/providers\/Microsoft\.Authorization\/locks\/([^/]+)$/i.exec(r.path);
    if (lock) {
      const scope = lock[1]!.toLowerCase();
      const key = `${scope}|${lock[2]!.toLowerCase()}`;
      if (!resource(scope)) return { status: 404, body: { error: { code: 'ResourceNotFound', message: `The Resource '${lock[1]}' was not found.` } } };
      if (r.method === 'PUT') {
        const b = JSON.parse(r.body || '{}') as { properties?: { level?: string } };
        this.locks.set(key, { scope, name: lock[2]!, level: b.properties?.level ?? 'CanNotDelete' });
        return { status: 201, body: { id: r.path, name: lock[2], type: 'Microsoft.Authorization/locks', properties: { level: b.properties?.level ?? 'CanNotDelete' } } };
      }
      if (r.method === 'GET') return this.locks.has(key) ? { status: 200, body: { id: r.path, name: lock[2], type: 'Microsoft.Authorization/locks', properties: { level: this.locks.get(key)!.level } } } : { status: 404, body: { error: { code: 'LockNotFound', message: 'The lock was not found.' } } };
      if (r.method === 'DELETE') {
        this.locks.delete(key);
        return { status: 200 };
      }
      return { status: 405, body: { error: { code: 'MethodNotAllowed', message: 'Not allowed' } } };
    }
    const m = SERVER.exec(r.path);
    if (!m) return null;
    const server = m[1]!.toLowerCase();
    if (r.method === 'DELETE' && r.path.toLowerCase() === server && this.lockedScope(server)) return { status: 409, body: { error: { code: 'ScopeLocked', message: `The scope '${r.path}' cannot perform delete operation because following scope(s) are locked: '${r.path}'. Please remove the lock and try again.` } } };
    const cfg = /\/configurations\/([^/]+)$/i.exec(r.path);
    if (cfg && r.method === 'PUT' && decodeURIComponent(cfg[1]!).toLowerCase() === 'azure.extensions') {
      const b = JSON.parse(r.body || '{}') as { properties?: { value?: string } };
      const bad = (b.properties?.value ?? '').split(',').map((x) => x.trim().toUpperCase()).filter((x) => x && !AZURE_PG_EXTENSIONS.includes(x));
      if (bad.length) return { status: 400, body: { error: { code: 'InvalidParameterValue', message: `Invalid value given for parameter azure.extensions: ${bad.join(', ')}.` } } };
    }
    if (r.method === 'PUT' && r.path.toLowerCase() === server) {
      const b = JSON.parse(r.body || '{}') as { properties?: Record<string, unknown> };
      const props = { ...(b.properties ?? {}) };
      const password = typeof props.administratorLoginPassword === 'string';
      delete props.administratorLoginPassword;
      this.puts.push({ id: r.path, body: { ...b, properties: props }, password });
      if (props.createMode === 'PointInTimeRestore' && !resource(String(props.sourceServerResourceId ?? '').toLowerCase())) return { status: 404, body: { error: { code: 'SourceServerNotFound', message: 'The source server of the restore was not found.' } } };
    }
    return null;
  }

  private lockedScope(id: string): boolean {
    return [...this.locks.values()].some((l) => id === l.scope || id.startsWith(`${l.scope}/`));
  }

  /** Decorates a server's properties as Azure reports them (called by the generic PUT). */
  decorate(type: string, path: string, props: Record<string, unknown>, existing: ArmLike | undefined, resource: (key: string) => ArmLike | undefined): void {
    if (!/^microsoft\.dbfor(postgresql|mysql)\/flexibleservers$/.test(type)) {
      if (/^microsoft\.dbfor(postgresql|mysql)\/flexibleservers\/backups$/.test(type)) Object.assign(props, { backupType: 'Customer On-Demand', completedTime: new Date().toISOString(), source: 'Automatic' });
      return;
    }
    delete props.administratorLoginPassword;
    const name = path.split('/').pop()!;
    const mysql = /mysql/.test(type);
    if (props.createMode === 'PointInTimeRestore') {
      const src = resource(String(props.sourceServerResourceId ?? '').toLowerCase());
      const sp = (src?.body.properties ?? {}) as Record<string, unknown>;
      Object.assign(props, { version: sp.version, administratorLogin: sp.administratorLogin, ...(props.storage ? {} : { storage: sp.storage }), ...(props.backup ? {} : { backup: sp.backup }), ...(props.maintenanceWindow ? {} : { maintenanceWindow: sp.maintenanceWindow }) });
    }
    if (existing) {
      const ep = (existing.body.properties ?? {}) as Record<string, unknown>;
      for (const k of ['version', 'administratorLogin', 'createMode', 'sourceServerResourceId']) if (props[k] === undefined && ep[k] !== undefined) props[k] = ep[k];
    }
    Object.assign(props, { state: 'Ready', fullyQualifiedDomainName: `${name}.${mysql ? 'mysql' : 'postgres'}.database.azure.com` });
  }

  /** After a server PUT: the provider's own automatic backup, and a restore's copied server parameters. */
  afterPut(type: string, key: string, res: ArmLike, set: (k: string, v: ArmLike) => void, resource: (key: string) => ArmLike | undefined, all: () => Iterable<[string, ArmLike]>): void {
    if (!/^microsoft\.dbfor(postgresql|mysql)\/flexibleservers$/.test(type)) return;
    const backup = `${key}/backups/backup_${Date.now()}`;
    if (![...all()].some(([k]) => k.startsWith(`${key}/backups/backup_`))) set(backup, { id: `${res.id}/backups/backup_${Date.now()}`, name: `backup_${Date.now()}`, type: `${res.type}/backups`, etag: 'W/"auto"', body: { properties: { backupType: 'Full', completedTime: new Date().toISOString(), source: 'Automatic' } } });
    const props = (res.body.properties ?? {}) as Record<string, unknown>;
    if (props.createMode === 'PointInTimeRestore') {
      const src = String(props.sourceServerResourceId ?? '').toLowerCase();
      for (const [k, v] of [...all()]) {
        if (!k.startsWith(`${src}/configurations/`)) continue;
        const nk = `${key}/configurations/${k.slice(`${src}/configurations/`.length)}`;
        if (!resource(nk)) set(nk, { ...v, id: `${res.id}/configurations/${v.name}` });
      }
    }
  }

  /** What `CREATE EXTENSION` would allow on a server: its `azure.extensions` (lower case), as pg_available_extensions plus the allow-list decide. */
  availableExtensions(serverId: string, resource: (key: string) => ArmLike | undefined): string[] {
    const c = resource(`${serverId.toLowerCase()}/configurations/azure.extensions`);
    const v = String(((c?.body.properties ?? {}) as { value?: string }).value ?? '');
    return v.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  }
}
