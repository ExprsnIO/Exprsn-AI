/*
 * 1.9.99-final, Sprint 59 (B-10304, B-10306): the Cosmos DB for NoSQL data plane `FakeAzure` also answers (paths
 * under `/dbs`, on the same port: one account per fake), and the subscription-wide lists and read-only keys ARM gives.
 *
 * - Authorization: a master key signature (`type=master`: HMAC-SHA256 of verb, resource type, resource link and the
 *   `x-ms-date`, checked with `key` or `readKey`), or an Entra token the fake issued for https://cosmos.azure.com
 *   (`type=aad`). A missing or wrong one is 401.
 * - GET `/dbs/<db>`, GET `/dbs/<db>/colls`, and queries: POST `/dbs/<db>/colls/<c>/docs` with
 *   `x-ms-documentdb-isquery: True`, reading `SELECT [TOP n] * FROM c [WHERE c.<field> = @p | '<text>' | <number>]`
 *   and `SELECT VALUE COUNT(1) FROM c`; pages by `x-ms-max-item-count` and `x-ms-continuation`. Anything else (a
 *   document write, a stored procedure) is 405 and recorded in `writes`.
 *
 * Never the real Azure.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { RecordedRequest, Reply } from './fake-cloud-base.js';

export interface FakeContainer {
  partitionKey: string;
  docs: Record<string, unknown>[];
}

export class FakeCosmos {
  /** The account keys (base64), as Azure hands them out. */
  readonly key = randomBytes(32).toString('base64');
  readonly readKey = randomBytes(32).toString('base64');
  readonly databases = new Map<string, Map<string, FakeContainer>>();
  /** Requests that were not reads (they would have written). */
  readonly writes: { method: string; path: string }[] = [];
  /** The auth kinds seen, in order (`master-read`, `master`, `aad`). */
  readonly auths: string[] = [];

  constructor(private readonly tokens: () => Map<string, { scope: string; exp: number }>) {}

  addContainer(db: string, name: string, c: FakeContainer): this {
    if (!this.databases.has(db)) this.databases.set(db, new Map());
    this.databases.get(db)!.set(name, c);
    return this;
  }

  static matches(path: string): boolean {
    return path === '/dbs' || path.startsWith('/dbs/');
  }

  classify(r: Pick<RecordedRequest, 'method' | 'path' | 'headers'>): string {
    if (/\/docs$/.test(r.path) && r.headers['x-ms-documentdb-isquery']) return 'cosmos:query';
    if (/\/colls$/.test(r.path)) return 'cosmos:listContainers';
    if (/^\/dbs\/[^/]+$/.test(r.path)) return 'cosmos:readDatabase';
    return `cosmos:${r.method} ${r.path}`;
  }

  private auth(r: RecordedRequest, resourceType: string, link: string): Reply | null {
    const raw = decodeURIComponent(r.headers.authorization ?? '');
    const m = /^type=(master|aad)&ver=1\.0&sig=(.+)$/.exec(raw);
    const refuse: Reply = { status: 401, body: { code: 'Unauthorized', message: 'The input authorization token can\'t serve the request.' } };
    if (!m) return refuse;
    if (m[1] === 'aad') {
      const t = this.tokens().get(m[2]!);
      if (!t || t.exp < Date.now() || t.scope !== 'https://cosmos.azure.com') return refuse;
      this.auths.push('aad');
      return null;
    }
    const date = r.headers['x-ms-date'] ?? '';
    const text = `${r.method.toLowerCase()}\n${resourceType}\n${link}\n${date.toLowerCase()}\n\n`;
    for (const [kind, key] of [['master', this.key], ['master-read', this.readKey]] as const) {
      if (createHmac('sha256', Buffer.from(key, 'base64')).update(text).digest('base64') === m[2]) {
        this.auths.push(kind);
        return null;
      }
    }
    return refuse;
  }

  handle(r: RecordedRequest): Reply {
    const parts = r.path.split('/').slice(1).map(decodeURIComponent);
    const db = parts[1] ? this.databases.get(parts[1]) : undefined;
    const notFound: Reply = { status: 404, body: { code: 'NotFound', message: 'Resource Not Found.' } };
    if (r.method === 'GET' && parts.length === 2) {
      const a = this.auth(r, 'dbs', `dbs/${parts[1]}`);
      if (a) return a;
      return db ? { status: 200, body: { id: parts[1], _rid: 'abc==', _self: `dbs/abc==/` } } : notFound;
    }
    if (r.method === 'GET' && parts.length === 3 && parts[2] === 'colls') {
      const a = this.auth(r, 'colls', `dbs/${parts[1]}`);
      if (a) return a;
      if (!db) return notFound;
      return { status: 200, body: { DocumentCollections: [...db.entries()].map(([id, c]) => ({ id, partitionKey: { paths: [`/${c.partitionKey}`], kind: 'Hash' } })), _count: db.size } };
    }
    if (r.method === 'POST' && parts.length === 5 && parts[4] === 'docs' && r.headers['x-ms-documentdb-isquery'] === 'True') {
      const a = this.auth(r, 'docs', `dbs/${parts[1]}/colls/${parts[3]}`);
      if (a) return a;
      const c = db?.get(parts[3]!);
      if (!c) return notFound;
      let q: { query?: string; parameters?: { name: string; value: unknown }[] } = {};
      try {
        q = JSON.parse(r.body) as typeof q;
      } catch {
        return { status: 400, body: { code: 'BadRequest', message: 'Malformed query.' } };
      }
      const text = String(q.query ?? '');
      if (/^\s*SELECT\s+VALUE\s+COUNT\(1\)\s+FROM\s+\w+\s*$/i.test(text)) return { status: 200, body: { Documents: [c.docs.length], _count: 1 } };
      const m = /^\s*SELECT\s+(?:TOP\s+(\d+)\s+)?\*\s+FROM\s+(\w+)(?:\s+WHERE\s+\2\.(\w+)\s*=\s*(@\w+|'[^']*'|"[^"]*"|\d+))?\s*$/i.exec(text);
      if (!m) return { status: 400, body: { code: 'BadRequest', message: `The fake does not read this query: ${text.slice(0, 60)}` } };
      const want = m[4] === undefined ? undefined : m[4].startsWith('@') ? q.parameters?.find((p) => p.name === m[4])?.value : /^\d+$/.test(m[4]) ? Number(m[4]) : m[4].slice(1, -1);
      let docs = m[3] ? c.docs.filter((d) => d[m[3]!] === want) : c.docs;
      if (m[1]) docs = docs.slice(0, Number(m[1]));
      const start = Number(r.headers['x-ms-continuation'] ?? 0);
      const size = Number(r.headers['x-ms-max-item-count'] ?? 100);
      const page = docs.slice(start, start + size).map((d) => ({ ...d, _rid: 'rid', _self: 'self', _etag: '"e"', _attachments: 'attachments/', _ts: 1 }));
      const more = start + size < docs.length;
      return { status: 200, headers: more ? { 'x-ms-continuation': String(start + size) } : {}, body: { Documents: page, _count: page.length } };
    }
    this.writes.push({ method: r.method, path: r.path });
    return { status: 405, body: { code: 'MethodNotAllowed', message: 'The fake answers reads only.' } };
  }
}
