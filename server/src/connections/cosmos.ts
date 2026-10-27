import { createHash, createHmac } from 'node:crypto';
import { guardedRequest } from '../platform/egress.js';
import { addressProblem, parseAllowList, type AllowList } from '../mcp/hosts.js';
import type { Classification } from './classify.js';
import type { DdlPlan } from './ddl.js';
import type { DescribeKind, DocumentDescription } from './ddl-edit-types.js';
import type { ConnectionSpec, DataDriver, QueryResult, SchemaObject, TestResult } from './drivers.js';
import type { GuardedSend } from './dynamodb.js';
import type { NonSqlContext } from './nonsql.js';
import { allowedPattern } from './patterns.js';

/*
 * 1.9.99-final, Sprint 59 (B-10304): Azure Cosmos DB for NoSQL as a read-only data connection (open decision 15). The
 * query language is Cosmos DB's SQL, which has no statements that write: writes are other REST calls, and this driver
 * makes only these:
 *
 *   GET  /dbs/<db>                       Test connection
 *   GET  /dbs/<db>/colls                 the containers (introspection)
 *   POST /dbs/<db>/colls/<c>/docs        a query (`x-ms-documentdb-isquery: True`), and the schema sample's
 *                                        `SELECT TOP 20 * FROM c`
 *
 * A query is `SELECT ...` with the container picked in the schema tree, or named after FROM when none is picked, or
 * JSON `{"container": "orders", "query": "SELECT ...", "parameters": [{"name": "@s", "value": "open"}]}`. Refused by
 * classification: anything but one SELECT, user-defined functions (`udf.*`, JavaScript on the server) and
 * containers outside the allow-list. Rows are capped at the connection's limit (one more is asked for to know whether
 * the result is capped) and masked by the service like every other result.
 *
 * Authentication: the account key (`type=master`, HMAC-SHA256 over the verb, resource and date) from the sealed or
 * vault: credential; a Microsoft Entra service principal (client id and secret, `type=aad`), whose token comes from
 * the Entra token endpoint for `https://cosmos.azure.com/.default`; or, for a connection made from a cloud account
 * (B-10306), a token bought through `s.cloud.credentials`. Requests go through the outbound address guard
 * (`guardedRequest`, the connection rules of CONNECTIONS_ALLOWED_HOSTS; in tests a real Azure host is refused).
 *
 * 2.0.x: a previewed schema plan (`applyDdl`) makes a database (`POST /dbs`, resource type `dbs`, link ``) or a
 * container in the connection's database (`POST /dbs/<db>/colls`, resource type `colls`, link `dbs/<db>`), with
 * `x-ms-offer-throughput` when the plan sets throughput, on the connection's separate admin credential only. That
 * must be a read-write account key: Cosmos DB's data-plane RBAC does not let an Entra token create databases or
 * containers (those go through Azure Resource Manager), so with Entra the service answers 403 and the driver says so.
 *
 * 2.0.x editing: a plan may also replace a container's definition (`PUT /dbs/<db>/colls/<id>` with the full body:
 * the indexing policy and default TTL change; the partition key and unique keys cannot), delete a container
 * (`DELETE /dbs/<db>/colls/<id>`, resource type `colls`, link `dbs/<db>/colls/<id>`) or delete a database
 * (`DELETE /dbs/<id>`, resource type `dbs`, link `dbs/<id>`), again with the read-write account key of the admin
 * credential. `describe` reads a container back on the read credential (`GET /dbs/<db>/colls/<id>`): a read-only
 * key or the Built-in Data Reader role is enough.
 */

/** The checked request the driver sends. */
export interface CosmosOp {
  container: string;
  query: string;
  parameters?: { name: string; value: unknown }[];
}

const CONTAINER = /^[^/\\#?\s]{1,255}$/;
const WRITE_WORDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'UPSERT', 'REPLACE', 'PATCH', 'MERGE']);
const DDL_WORDS = new Set(['CREATE', 'DROP', 'ALTER', 'TRUNCATE']);
const SYSTEM = new Set(['_rid', '_self', '_etag', '_attachments']);
const API_VERSION = '2018-12-31';
export const COSMOS_SCOPE = 'https://cosmos.azure.com/.default';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Strings and comments out, `;` counted. */
function lex(text: string): { bare: string; statements: number } | string {
  let bare = '';
  let statements = 1;
  for (let i = 0; i < text.length; ) {
    const ch = text[i]!;
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === '\\' ? 2 : 1;
      if (j >= text.length) return 'A string is not closed.';
      bare += ' "" ';
      i = j + 1;
    } else if (ch === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (ch === ';') {
      if (text.slice(i + 1).trim()) statements++;
      i++;
    } else {
      bare += ch;
      i++;
    }
  }
  return { bare, statements };
}

/** Classifies a Cosmos DB SQL query (or its JSON form) for the container `object` picked in the schema tree. */
export function classifyCosmos(text: string, object: string | null, _ctx?: NonSqlContext): Classification {
  let query = text.trim();
  let container = object;
  let parameters: CosmosOp['parameters'];
  if (query.startsWith('{')) {
    let q: unknown;
    try {
      q = JSON.parse(query);
    } catch {
      return { kind: 'unparsed', verb: null, objects: [], reason: 'The request is not JSON or a SELECT.' };
    }
    if (!isObj(q) || typeof q.query !== 'string') return { kind: 'unparsed', verb: null, objects: [], reason: 'Write {"container": "<container>", "query": "SELECT ...", "parameters": [...]}.' };
    const extra = Object.keys(q).find((k) => !['container', 'query', 'parameters'].includes(k));
    if (extra) return { kind: 'unparsed', verb: null, objects: [], reason: `${extra} is not read: a query takes container, query and parameters.` };
    if (q.container !== undefined && typeof q.container !== 'string') return { kind: 'unparsed', verb: null, objects: [], reason: 'container must be a name.' };
    if (q.parameters !== undefined && !(Array.isArray(q.parameters) && q.parameters.every((p) => isObj(p) && typeof p.name === 'string' && /^@[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(p.name)))) return { kind: 'unparsed', verb: null, objects: [], reason: 'parameters are [{"name": "@name", "value": ...}].' };
    query = q.query.trim();
    container = (q.container as string | undefined) ?? container;
    parameters = q.parameters as CosmosOp['parameters'];
  }
  const l = lex(query);
  if (typeof l === 'string') return { kind: 'unparsed', verb: null, objects: [], reason: l };
  if (l.statements > 1) return { kind: 'multiple', verb: null, objects: [], reason: 'Send one query at a time.' };
  const verb = (/^\s*([A-Za-z]+)/.exec(l.bare)?.[1] ?? '').toUpperCase();
  if (WRITE_WORDS.has(verb)) return { kind: 'write', verb, objects: container ? [container] : [], reason: `${verb} would change items; Cosmos DB connections are read-only.` };
  if (DDL_WORDS.has(verb)) return { kind: 'ddl', verb, objects: container ? [container] : [], reason: `${verb} would change containers.` };
  if (verb !== 'SELECT') return { kind: 'unparsed', verb: verb || null, objects: [], reason: 'Write one Cosmos DB SQL SELECT, such as SELECT TOP 10 * FROM c WHERE c.status = "open".' };
  if (/\budf\s*\./i.test(l.bare)) return { kind: 'denied', verb, objects: [], denied: 'udf', reason: 'User-defined functions run JavaScript on the database and are not called from a connection.' };
  const from = /\bFROM\s+([A-Za-z_][A-Za-z0-9_-]*)/i.exec(l.bare)?.[1] ?? null;
  container ??= from;
  if (!container || !CONTAINER.test(container)) return { kind: 'unparsed', verb, objects: [], reason: 'Pick a container in the schema tree, or name it after FROM.' };
  return { kind: 'read', verb, objects: [container], op: { container, query: query.replace(/;\s*$/, ''), ...(parameters ? { parameters } : {}) } satisfies CosmosOp };
}

export const allowedContainer = allowedPattern;

// ---------- authentication ----------

/** The `authorization` header for a master key: HMAC-SHA256 of verb, resource type, resource link and date. */
export function masterKeyAuth(o: { verb: string; resourceType: string; resourceLink: string; date: string; key: string }): string {
  const text = `${o.verb.toLowerCase()}\n${o.resourceType.toLowerCase()}\n${o.resourceLink}\n${o.date.toLowerCase()}\n\n`;
  const sig = createHmac('sha256', Buffer.from(o.key, 'base64')).update(text).digest('base64');
  return encodeURIComponent(`type=master&ver=1.0&sig=${sig}`);
}

export const aadAuth = (token: string): string => encodeURIComponent(`type=aad&ver=1.0&sig=${token}`);

/** Entra tokens of service principals, per instance, until a third of their life is left (keyed by a digest, never the secret). */
const tokens = new Map<string, { token: string; expiresAt: number; ttl: number }>();

// ---------- the driver ----------

export interface CosmosDriverOptions {
  /** The Entra authority for a service principal's token (CLOUD_AZURE_AUTHORITY; tests: the fake). */
  authority?: string;
  send?: GuardedSend;
}

export class CosmosDriver implements DataDriver {
  private readonly base: URL;
  private readonly send: GuardedSend;

  constructor(
    private readonly spec: ConnectionSpec,
    private readonly allow: AllowList = parseAllowList(''),
    private readonly o: CosmosDriverOptions = {}
  ) {
    const e = spec.endpoint.replace(/\/+$/, '');
    this.base = new URL(/^https?:\/\//.test(e) ? e : `https://${e}`);
    this.send = o.send ?? guardedRequest;
  }

  private check = (address: string, host: string) => addressProblem(address, host, this.allow);

  /** The bearer for a service principal, from the Entra token endpoint through the same guard. */
  private async entraToken(timeoutMs: number): Promise<string> {
    const tenant = String(this.spec.options?.entraTenantId ?? '');
    if (!tenant || !this.spec.username || !this.spec.password) throw new Error('A service principal needs the Entra tenant id, its client id and its client secret.');
    const key = createHash('sha256').update(`${tenant}\n${this.spec.username}\n${this.spec.password}`).digest('hex');
    const have = tokens.get(key);
    if (have && have.expiresAt - Date.now() > have.ttl / 3) return have.token;
    const url = new URL(`${(this.o.authority ?? 'https://login.microsoftonline.com').replace(/\/+$/, '')}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`);
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: this.spec.username, client_secret: this.spec.password, scope: COSMOS_SCOPE }).toString();
    const res = await this.send({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body, timeoutMs, maxBytes: 256 * 1024, check: this.check });
    let b: Record<string, unknown> = {};
    try {
      b = JSON.parse(res.body.toString('utf8')) as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
    if (res.status !== 200 || typeof b.access_token !== 'string') throw new Error(`Entra refused the token request${typeof b.error === 'string' ? ` (${b.error})` : ''}.`);
    const ttl = Number(b.expires_in ?? 3600) * 1000;
    tokens.set(key, { token: b.access_token, expiresAt: Date.now() + ttl, ttl });
    return b.access_token;
  }

  private async authorization(verb: string, resourceType: string, resourceLink: string, date: string, timeoutMs: number): Promise<string> {
    if (this.spec.bearer) return aadAuth(this.spec.bearer);
    if (this.spec.options?.auth === 'entra-service-principal') return aadAuth(await this.entraToken(timeoutMs));
    if (!this.spec.password) throw new Error('A Cosmos DB connection needs the account key, a service principal, or a cloud account.');
    return masterKeyAuth({ verb, resourceType, resourceLink, date, key: this.spec.password });
  }

  private async call(verb: 'GET' | 'POST' | 'PUT' | 'DELETE', resourceType: string, resourceLink: string, path: string, opts: { timeoutMs: number; body?: unknown; headers?: Record<string, string> }): Promise<{ body: Record<string, unknown>; headers: Record<string, string> }> {
    const date = new Date().toUTCString();
    const url = new URL(path, this.base);
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-ms-date': date,
      'x-ms-version': API_VERSION,
      authorization: await this.authorization(verb, resourceType, resourceLink, date, opts.timeoutMs),
      ...(opts.headers ?? {})
    };
    const res = await this.send({ method: verb, url, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}), timeoutMs: opts.timeoutMs, maxBytes: 16 * 1024 * 1024, check: this.check });
    const text = res.body.toString('utf8');
    let data: Record<string, unknown> = {};
    try {
      data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      /* not JSON */
    }
    if (res.status >= 300) throw new Error(`Cosmos DB answered ${res.status}${typeof data.code === 'string' ? ` (${data.code})` : ''}: ${String(data.message ?? text).split('\n')[0]!.slice(0, 300)}`);
    return { body: data, headers: res.headers };
  }

  private get database(): string {
    if (!this.spec.database) throw new Error('A Cosmos DB connection names its database.');
    return this.spec.database;
  }

  private dbLink = () => `dbs/${this.database}`;

  /** One query on a container, page by page, until `want` documents or the end. */
  private async run(container: string, op: Pick<CosmosOp, 'query' | 'parameters'>, want: number, timeoutMs: number, maxPages = 20): Promise<{ docs: Record<string, unknown>[]; more: boolean }> {
    const link = `${this.dbLink()}/colls/${container}`;
    const docs: Record<string, unknown>[] = [];
    let continuation: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const r = await this.call('POST', 'docs', link, `/${link.split('/').map(encodeURIComponent).join('/')}/docs`, {
        timeoutMs,
        body: { query: op.query, parameters: op.parameters ?? [] },
        headers: {
          'content-type': 'application/query+json',
          'x-ms-documentdb-isquery': 'True',
          'x-ms-documentdb-query-enablecrosspartition': 'True',
          'x-ms-max-item-count': String(Math.min(1000, Math.max(1, want - docs.length))),
          ...(continuation ? { 'x-ms-continuation': continuation } : {})
        }
      });
      docs.push(...((r.body.Documents as Record<string, unknown>[] | undefined) ?? []));
      continuation = r.headers['x-ms-continuation'] || undefined;
      if (!continuation || docs.length >= want) return { docs, more: !!continuation };
    }
    return { docs, more: true };
  }

  async test(timeoutMs: number): Promise<TestResult> {
    const r = await this.call('GET', 'dbs', this.dbLink(), `/dbs/${encodeURIComponent(this.database)}`, { timeoutMs });
    return {
      version: 'Azure Cosmos DB for NoSQL',
      readOnly: true,
      health: 'healthy',
      detail: `Database ${String(r.body.id ?? this.database)} is reachable. Only queries are sent; use a read-only key, or a principal with the Cosmos DB Built-in Data Reader role only.`
    };
  }

  async introspect(timeoutMs: number): Promise<SchemaObject[]> {
    const r = await this.call('GET', 'colls', this.dbLink(), `/dbs/${encodeURIComponent(this.database)}/colls`, { timeoutMs });
    const colls = ((r.body.DocumentCollections as { id: string; partitionKey?: { paths?: string[] } }[] | undefined) ?? []).filter((c) => CONTAINER.test(c.id)).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, 500);
    const out: SchemaObject[] = [];
    for (const [i, c] of colls.entries()) {
      const pk = (c.partitionKey?.paths ?? []).map((p) => p.replace(/^\//, '').replace(/\//g, '.'));
      const columns = pk.map((name) => ({ name, type: 'partition key' }));
      // Fields are sampled from the first documents of the first 100 containers: Cosmos DB keeps no schema.
      if (i < 100) {
        const sample = await this.run(c.id, { query: 'SELECT TOP 20 * FROM c' }, 20, timeoutMs, 1).catch(() => ({ docs: [] as Record<string, unknown>[] }));
        for (const d of sample.docs) for (const [k, v] of Object.entries(d)) if (!SYSTEM.has(k) && !columns.some((x) => x.name === k)) columns.push({ name: k, type: v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v });
      }
      out.push({ name: c.id, kind: 'collection', columns });
    }
    return out;
  }

  async query(c: Classification, _text: string, opts: { limit: number; timeoutMs: number }): Promise<QueryResult> {
    const op = c.op as CosmosOp | undefined;
    // Checked again here: only one SELECT is ever sent.
    if (!op || classifyCosmos(op.query, op.container).kind !== 'read') throw new Error('The request was not classified as a Cosmos DB read.');
    const { docs, more } = await this.run(op.container, op, opts.limit + 1, opts.timeoutMs);
    const kept = docs.slice(0, opts.limit).map((d) => (isObj(d) ? Object.fromEntries(Object.entries(d).filter(([k]) => !SYSTEM.has(k))) : { value: d }));
    const columns: string[] = [];
    for (const d of kept) for (const k of Object.keys(d)) if (!columns.includes(k)) columns.push(k);
    if (columns.includes('id')) columns.splice(0, 0, ...columns.splice(columns.indexOf('id'), 1));
    return { columns, rows: kept.map((d) => columns.map((k) => (d as Record<string, unknown>)[k] ?? null)), capped: docs.length > opts.limit || (more && docs.length >= opts.limit), estimate: null };
  }

  async rows(): Promise<QueryResult> {
    throw new Error('Cosmos DB containers are not a knowledge source.');
  }

  /** 2.0.x: a schema plan's operations on the admin credential (see the header). */
  async applyDdl(plan: DdlPlan, timeoutMs: number): Promise<{ applied: number; detail?: string }> {
    const known = new Set(['cosmos.createDatabase', 'cosmos.createContainer', 'cosmos.replaceContainer', 'cosmos.deleteContainer', 'cosmos.deleteDatabase']);
    for (const op of plan.ops) if (!known.has(op.op)) throw new Error(`Cosmos DB connections do not perform ${op.op}.`);
    if (!plan.ops.length) throw new Error('The plan has no Cosmos DB operations.');
    const entra = !!this.spec.bearer || this.spec.options?.auth === 'entra-service-principal';
    let applied = 0;
    const done: string[] = [];
    const DB_ID = /^[^/\\#?\s]{1,255}$/;
    const path = (...parts: string[]) => `/${parts.map(encodeURIComponent).join('/')}`;
    for (const op of plan.ops) {
      let what = 'It';
      try {
        const throughput = (t: number | null): Record<string, string> => (t ? { 'x-ms-offer-throughput': String(Math.floor(t)) } : {});
        if (op.op === 'cosmos.createDatabase') {
          what = `The database ${op.id}`;
          if (!DB_ID.test(op.id)) throw new Error(`${op.id} is not a Cosmos DB database id.`);
          await this.call('POST', 'dbs', '', '/dbs', { timeoutMs, body: { id: op.id }, headers: { 'content-type': 'application/json', ...throughput(op.throughput) } });
          done.push(`created database ${op.id}`);
        } else if (op.op === 'cosmos.createContainer') {
          const id = String(op.body.id ?? '');
          what = `The container ${id}`;
          if (!CONTAINER.test(id)) throw new Error(`${id || 'The container id'} is not a Cosmos DB container id.`);
          await this.call('POST', 'colls', this.dbLink(), `/dbs/${encodeURIComponent(this.database)}/colls`, { timeoutMs, body: op.body, headers: { 'content-type': 'application/json', ...throughput(op.throughput) } });
          done.push(`created container ${id}`);
        } else if (op.op === 'cosmos.replaceContainer') {
          const id = String(op.body.id ?? '');
          what = `The container ${id}`;
          if (!CONTAINER.test(id)) throw new Error(`${id || 'The container id'} is not a Cosmos DB container id.`);
          await this.call('PUT', 'colls', `${this.dbLink()}/colls/${id}`, path('dbs', this.database, 'colls', id), { timeoutMs, body: op.body, headers: { 'content-type': 'application/json' } });
          done.push(`replaced container ${id}`);
        } else if (op.op === 'cosmos.deleteContainer') {
          what = `The container ${op.id}`;
          if (!CONTAINER.test(op.id)) throw new Error(`${op.id || 'The container id'} is not a Cosmos DB container id.`);
          await this.call('DELETE', 'colls', `${this.dbLink()}/colls/${op.id}`, path('dbs', this.database, 'colls', op.id), { timeoutMs });
          done.push(`deleted container ${op.id}`);
        } else if (op.op === 'cosmos.deleteDatabase') {
          what = `The database ${op.id}`;
          if (!DB_ID.test(op.id)) throw new Error(`${op.id} is not a Cosmos DB database id.`);
          await this.call('DELETE', 'dbs', `dbs/${op.id}`, path('dbs', op.id), { timeoutMs });
          done.push(`deleted database ${op.id}`);
        }
      } catch (err) {
        let msg = (err as Error).message;
        if (/answered 409/.test(msg)) msg = `${what} already exists. ${msg}`;
        else if (/answered 404/.test(msg)) msg = `${what} does not exist. ${msg}`;
        else if (op.op === 'cosmos.replaceContainer' && /answered 400/.test(msg)) msg = `Cosmos DB refused the new definition (a container's partition key and unique keys cannot change; recreate the container for that). ${msg}`;
        else if (entra && /answered 403/.test(msg)) msg = `Entra tokens cannot create databases or containers, nor change or delete them, through the Cosmos DB data plane; give the admin account the account key, or do it through Azure Resource Manager. ${msg}`;
        throw new Error(plan.ops.length > 1 ? `${msg} (${applied} of ${plan.ops.length} operations were applied before it.)` : msg, { cause: err });
      }
      applied++;
    }
    const text = done.join(', ');
    return { applied, detail: `${text.charAt(0).toUpperCase()}${text.slice(1)}.` };
  }

  /**
   * 2.0.x editing: a container as the create form takes it (cosmosContainerSpec): partition key paths, default TTL,
   * unique keys and excluded paths. One GET on the read credential; null when there is no such container.
   */
  async describe(object: string, kind: DescribeKind, timeoutMs: number): Promise<DocumentDescription | null> {
    if (kind !== 'container') throw new Error(`Cosmos DB connections describe containers, not ${kind}.`);
    if (!CONTAINER.test(object)) throw new Error(`${object} is not a Cosmos DB container id.`);
    let c: Record<string, unknown>;
    try {
      c = (await this.call('GET', 'colls', `${this.dbLink()}/colls/${object}`, `/dbs/${encodeURIComponent(this.database)}/colls/${encodeURIComponent(object)}`, { timeoutMs })).body;
    } catch (err) {
      if (/answered 404/.test((err as Error).message)) return null;
      throw err;
    }
    const pk = (c.partitionKey ?? {}) as { paths?: string[] };
    const unique = ((c.uniqueKeyPolicy as { uniqueKeys?: { paths?: string[] }[] } | undefined)?.uniqueKeys ?? []).map((u) => u.paths ?? []).filter((p) => p.length);
    // The service always adds /"_etag"/? to the excluded paths: left out, as the form never asks for it.
    const excluded = ((c.indexingPolicy as { excludedPaths?: { path?: string }[] } | undefined)?.excludedPaths ?? []).map((p) => String(p.path ?? '')).filter((p) => p && p !== '/"_etag"/?');
    const definition: Record<string, unknown> = {
      name: String(c.id ?? object),
      partitionKeyPaths: pk.paths ?? [],
      ...(typeof c.defaultTtl === 'number' ? { defaultTtl: c.defaultTtl } : {}),
      uniqueKeys: unique,
      excludedPaths: excluded
    };
    return { kind: 'container', name: String(c.id ?? object), definition };
  }
}
