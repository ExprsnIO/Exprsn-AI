import { ulid } from 'ulid';
import { scrubError } from '../platform/diagnostics.js';
import { json, type Db } from '../db/knex.js';
import { clears, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { actorFrom, type AuditLog } from '../audit/chain.js';
import { csvLine } from '../audit/exports.js';
import { classify as classifyText } from '../chat/attachments.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { DataKeys } from '../platform/datakeys.js';
import type { Guardrails } from '../guardrails/types.js';
import { allowedIndex, classifyOpenSearch, type Classification } from './classify.js';
import { allowedSqlObject, canonical, dialectOf, findObject } from './dialects.js';
import { categoryOf, engineInfo, ENGINES, parseOptions, engineTitle, type Engine } from './engines.js';
import { buildPlan, DdlProblem, ddlKinds, type DdlPlan } from './ddl.js';
import { describeTarget, editKinds } from './ddl-edit.js';
import type { DescribeKind, ObjectDescription } from './ddl-edit-types.js';
import type { DynamicCredentials } from './dynamic.js';
import { classifyInflux } from './influxdb.js';
import { allowedCollection, classifyMongo, classifyMongoFor } from './mongo.js';
import { MONGO_SERVICES } from './mongo-services.js';
import { classifyCosmos } from './cosmos.js';
import { classifyDynamo } from './dynamodb.js';
import type { NonSqlContext } from './nonsql.js';
import { allowedPattern } from './patterns.js';
import { classifyPrometheus } from './prometheus.js';
import { classifyRabbit } from './rabbitmq.js';
import { classifyRedis } from './redis.js';
import type { CredentialVault } from '../vault/credential-moves.js';
import { isVaultRef } from '../vault/policy.js';
import type { RowMutation, ConnectionSpec, DriverFactory, QueueInfo, QueryResult, RoleCheck, SchemaObject } from './drivers.js';
import type { ReplicationOptions, RowChange } from './replication.js';

/** A replicated change after masking; `raw` is the unmasked value of the requested column (the access column). */
export type MaskedChange = RowChange & { raw: unknown };
export interface MaskedReplicationStream {
  run(onBatch: (b: { lsn: string; changes: MaskedChange[] }) => Promise<void>, onReady?: () => void): Promise<void>;
  stop(): Promise<void>;
}

export { ENGINES, type Engine };

export interface ConnectionRow {
  id: string;
  tenant_id: string;
  name: string;
  engine: Engine;
  endpoint: string;
  database: string | null;
  zone: string;
  label: Label;
  ops: 'read';
  row_limit: number;
  timeout_s: number;
  credential: string | null;
  account: string | null;
  /** Sprint 15: `openbao` takes a short-lived account from OpenBao's database engine for role `bao_role`. */
  credential_source: 'static' | 'openbao';
  bao_role: string | null;
  /** Sprint 25 (B-1705): who saved a `vault:` password reference; it resolves under their vault policy. */
  vault_owner: string | null;
  /** 1.7.0 (B-9208): the vault reference the credential is read through once it was moved; the sealed value stays. */
  credential_ref?: string | null;
  /** 2.0.x: the separate admin account schema changes run on (migration 169); queries never use it. */
  admin_credential?: string | null;
  admin_account?: string | null;
  admin_vault_owner?: string | null;
  admin_credential_ref?: string | null;
  admin_set_at?: number | null;
  tls: boolean;
  /** 1.9.0: the engine's own settings (engines.ts), never a secret. */
  options: Record<string, unknown>;
  allow_list: string[];
  pii_columns: string[];
  schema: SchemaObject[] | null;
  schema_at: number | null;
  health: 'unknown' | 'healthy' | 'degraded' | 'unreachable';
  health_detail: string | null;
  checked_at: number | null;
  version: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

const n = (v: unknown) => (v == null ? null : Number(v));
const fromRow = (r: Record<string, unknown>): ConnectionRow => ({
  ...(r as unknown as ConnectionRow),
  credential_source: r.credential_source === 'openbao' ? 'openbao' : 'static',
  bao_role: (r.bao_role as string | null | undefined) ?? null,
  vault_owner: (r.vault_owner as string | null | undefined) ?? null,
  credential_ref: (r.credential_ref as string | null | undefined) ?? null,
  admin_credential: (r.admin_credential as string | null | undefined) ?? null,
  admin_account: (r.admin_account as string | null | undefined) ?? null,
  admin_vault_owner: (r.admin_vault_owner as string | null | undefined) ?? null,
  admin_credential_ref: (r.admin_credential_ref as string | null | undefined) ?? null,
  admin_set_at: n(r.admin_set_at),
  tls: !!r.tls,
  options: json<Record<string, unknown>>(r.options, {}),
  row_limit: Number(r.row_limit),
  timeout_s: Number(r.timeout_s),
  allow_list: json<string[]>(r.allow_list, []),
  pii_columns: json<string[]>(r.pii_columns, []),
  schema: json<SchemaObject[] | null>(r.schema, null),
  schema_at: n(r.schema_at),
  checked_at: n(r.checked_at),
  version: Number(r.version),
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at)
});

/** Column names that hold personal data, by convention. Admins mark others in the allow-list. */
export const PII_NAME = /(^|_)(e_?mail|phone|mobile|fax|iban|bic|swift|account_?(no|number)|sort_?code|ssn|social_security|passport|national_?id|tax_?id|nino|salary|wage|dob|date_of_birth|birth_?date|address|street|postcode|zip_?code|card_?(no|number)|pan|first_?name|last_?name|full_?name|surname|actor|user_?name)($|_)/i;

export const maskValue = (v: unknown): string => {
  const s = String(v);
  return s.length <= 4 ? '••••' : `••••${s.slice(-4)}`;
};

/** A string the classifier recognises as personal data (an email address, IBAN, card or phone number, SSN). */
const looksPersonal = (v: string): boolean => {
  if (v.length < 6) return false;
  const d = classifyText(v).detections;
  return !!(d.email || d.iban || d.payment_card || d.us_ssn || d.phone);
};

/** Masks fields with personal names and values that look personal inside a document or JSON value. */
function maskDeep(v: unknown, onMask: () => void, depth = 0): unknown {
  if (v == null || depth > 50) return v;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map((x) => maskDeep(x, onMask, depth + 1));
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (x != null && typeof x !== 'object' && PII_NAME.test(k)) {
        onMask();
        out[k] = maskValue(x);
      } else out[k] = maskDeep(x, onMask, depth + 1);
    }
    return out;
  }
  if (typeof v === 'string' && looksPersonal(v)) {
    onMask();
    return maskValue(v);
  }
  return v;
}

export const connectionView = (c: ConnectionRow, usedBy: { kbId: string; kb: string; sourceId: string; object: string; lastSyncAt: number | null; state: string; docs: number }[] = []) => {
  const pii = piiColumns(c);
  const objects = c.schema ?? [];
  return {
    id: c.id,
    name: c.name,
    engine: c.engine,
    engineTitle: engineTitle(c.engine),
    family: engineInfo(c.engine)?.family ?? null,
    /** 2.0.x: the console's group (engines.ts `categoryOf`). */
    category: categoryOf(c.engine),
    options: c.options,
    endpoint: c.endpoint,
    database: c.database,
    zone: c.zone,
    label: c.label,
    ops: c.ops,
    rowLimit: c.row_limit,
    timeoutS: c.timeout_s,
    account: c.account,
    hasCredential: !!c.credential || c.credential_source === 'openbao',
    credentialSource: c.credential_source,
    baoRole: c.bao_role,
    passwordFromVault: !!c.vault_owner,
    /** 2.0.x: the admin account for schema changes; its secret is never shown. */
    admin: { set: !!c.admin_credential, account: c.admin_account ?? null, setAt: c.admin_set_at ?? null, fromVault: !!c.admin_vault_owner },
    tls: c.tls,
    allowList: c.allow_list,
    piiColumns: c.pii_columns,
    schema: objects.map((o) => ({ name: o.name, kind: o.kind, allowed: allowed(c, o.name), columns: o.columns.map((col) => ({ name: col.name, type: col.type, pii: pii.has(`${o.name}.${col.name}`.toLowerCase()) })) })),
    schemaAt: c.schema_at,
    health: c.health,
    healthDetail: c.health_detail,
    checkedAt: c.checked_at,
    version: c.version,
    syncs: usedBy,
    createdAt: c.created_at,
    updatedAt: c.updated_at
  };
};

/** Whether an object (table, view, index or collection) is on the connection's allow-list. */
export function allowed(c: ConnectionRow, object: string): boolean {
  const other = NON_SQL[c.engine];
  return other ? other.allowed(object, c.allow_list) : allowedSqlObject(object, c.allow_list, c);
}

/**
 * The engines whose queries are not SQL: each reads its own request language into a checked request (`request`,
 * `mongo` or `op` on the classification) and names its objects in its own way (index and key patterns, collections,
 * queues, metrics, measurements). Such a request is sent as parsed, so one the parser could not read never runs.
 */
/** 2.0.x: kinds whose new object is something the read account reads, so it can join the allow-list. */
const LISTABLE = new Set(['table', 'collection', 'search-index', 'container', 'queue', 'stream-group']);

/** 2.0.x: engines with schema changes (ddl.ts `ddlKinds`). */
const designable = (e: Engine): boolean => ddlKinds(e).length > 0;

const NON_SQL: Partial<Record<Engine, { classify(query: string, object: string | null, ctx: NonSqlContext): Classification; allowed(object: string, allow: string[]): boolean }>> = {
  mongodb: { classify: (q, o) => classifyMongo(q, o), allowed: allowedCollection },
  opensearch: { classify: (q, o) => classifyOpenSearch(q, o), allowed: allowedIndex },
  redis: { classify: classifyRedis, allowed: allowedPattern },
  rabbitmq: { classify: classifyRabbit, allowed: allowedPattern },
  prometheus: { classify: classifyPrometheus, allowed: allowedPattern },
  influxdb: { classify: classifyInflux, allowed: allowedPattern },
  // 1.9.99-final, Sprint 59 (B-10304): the MongoDB-compatible services, DynamoDB and Cosmos DB for NoSQL, read-only.
  documentdb: { classify: (q, o) => classifyMongoFor(MONGO_SERVICES.documentdb, q, o), allowed: allowedCollection },
  'cosmos-mongodb': { classify: (q, o) => classifyMongoFor(MONGO_SERVICES['cosmos-mongodb'], q, o), allowed: allowedCollection },
  'do-mongodb': { classify: (q, o) => classifyMongoFor(MONGO_SERVICES['do-mongodb'], q, o), allowed: allowedCollection },
  dynamodb: { classify: classifyDynamo, allowed: allowedPattern },
  'cosmos-nosql': { classify: classifyCosmos, allowed: allowedPattern }
};

/**
 * 1.9.99-final (B-10306): what a connection made from a cloud account (`cloud/discovery.ts`) adds to, or puts in place
 * of, its stored credential at each use: a leased database user, an RDS IAM or Entra token, a cloud account's session,
 * the service's CA bundle. A field left undefined keeps what the stored credential gives.
 */
export interface CloudConnectionAuth {
  username?: string | null;
  password?: string | null;
  sessionToken?: string | null;
  bearer?: string | null;
  ca?: string | null;
}

export interface CloudConnectionHooks {
  /** Null when the connection has no cloud link (or the link table is not installed): the stored credential as before. */
  auth(c: ConnectionRow): Promise<CloudConnectionAuth | null>;
  /** The connection is being removed: its link, and any lease this instance holds for it, go too. */
  forget(c: ConnectionRow): Promise<void>;
}

/** OpenBao's database engine issues PostgreSQL and MySQL accounts. */
const dynamicEngine = (e: Engine): boolean => engineInfo(e).dynamicCredentials;

/** "object.column" (lower case) for every PII column: named by convention or marked by an admin. */
export function piiColumns(c: ConnectionRow): Set<string> {
  const out = new Set(c.pii_columns.map((x) => x.toLowerCase()));
  for (const o of c.schema ?? []) for (const col of o.columns) if (PII_NAME.test(col.name)) out.add(`${o.name}.${col.name}`.toLowerCase());
  return out;
}

export interface QueryInput {
  query: string;
  /** The object picked in the schema tree (OpenSearch requests without a path line go to it). */
  object?: string | null;
  /** Run a query the parser could not read, on the read-only account. */
  confirmUnparsed?: boolean;
}

export interface CallContext {
  principal: Principal;
  ip: string | null;
  traceId: string;
}

/**
 * Data connections: PostgreSQL, MySQL, OpenSearch and MongoDB, and since 1.9.0 SQL Server, Azure SQL, Oracle,
 * Snowflake and BigQuery (engines.ts, dialects.ts), with credentials sealed under the tenant key (never shown again),
 * a schema allow-list, and a query path that classifies before anything is sent: writes, DDL, several statements
 * and objects outside the allow-list are refused and audited; syntax the parser cannot read runs only after the
 * user confirms. Reads run on the read-only account in a read-only transaction with a statement timeout and a row
 * cap; PII columns and values that look like personal data are masked in every result, which carries the
 * connection's label.
 */
export class ConnectionService {
  constructor(
    private readonly db: Db,
    private readonly keys: DataKeys,
    private readonly audit: AuditLog,
    private readonly guard: Guardrails,
    private readonly drivers: Partial<Record<Engine, DriverFactory>>,
    /** OpenBao database engine (Sprint 15); null when OPENBAO_ADDR and OPENBAO_TOKEN are not set. */
    private readonly dynamic: DynamicCredentials | null = null
  ) {}

  /**
   * Sprint 25 (B-1705): resolves a `vault:` password reference as the user who saved it (set by createServices; a
   * reference does not resolve without it).
   */
  vaultResolver: ((tenantId: string, ownerId: string | null, ref: string, via: string) => Promise<string>) | null = null;
  /** 1.7.0 (B-9208): reads a password that was moved to the vault, and keeps the vault's copy current (set by createServices). */
  credentialVault: CredentialVault | null = null;
  /** 1.9.99-final (B-10306): connections made from a cloud account (set by createServices from `s.cloud.discovery`). */
  cloud: CloudConnectionHooks | null = null;

  /** 1.9.0: the engines this platform has a driver for (all of them, unless a test or deployment leaves some out). */
  installed(): Engine[] {
    return ENGINES.filter((e) => !!(this.drivers as Partial<Record<string, DriverFactory>>)[e]);
  }

  /** Revokes the OpenBao leases this instance holds. */
  async close(): Promise<void> {
    await this.dynamic?.close();
  }

  /** The OpenBao lease this instance holds for a connection (for the view). */
  lease(id: string) {
    return this.dynamic?.lease(id) ?? null;
  }

  async list(tenantId: string): Promise<ConnectionRow[]> {
    return ((await this.db('data_connections').where({ tenant_id: tenantId }).orderBy('name')) as Record<string, unknown>[]).map(fromRow);
  }

  async get(tenantId: string, id: string): Promise<ConnectionRow> {
    const r = await this.db('data_connections').where({ tenant_id: tenantId, id }).first();
    if (!r) throw notFound('Connection');
    return fromRow(r);
  }

  /** Knowledge sources that read from each connection. */
  async usage(tenantId: string): Promise<Map<string, { kbId: string; kb: string; sourceId: string; object: string; lastSyncAt: number | null; state: string; docs: number }[]>> {
    const rows = (await this.db('knowledge_sources as s').join('knowledge_bases as b', 'b.id', 's.kb_id').where({ 's.tenant_id': tenantId, 's.kind': 'database' }).select('s.id', 's.kb_id', 'b.name as kb', 's.config', 's.location', 's.last_sync_at', 's.state')) as { id: string; kb_id: string; kb: string; config: string; location: string; last_sync_at: number | null; state: string }[];
    const docs = new Map(((await this.db('knowledge_documents').where({ tenant_id: tenantId }).whereIn('source_id', rows.map((r) => r.id)).groupBy('source_id').select('source_id').count({ n: '*' })) as { source_id: string; n: number }[]).map((d) => [d.source_id, Number(d.n)]));
    const out = new Map<string, { kbId: string; kb: string; sourceId: string; object: string; lastSyncAt: number | null; state: string; docs: number }[]>();
    for (const r of rows) {
      const cfg = json<{ connectionId?: string; object?: string }>(r.config, {});
      if (!cfg.connectionId) continue;
      const list = out.get(cfg.connectionId) ?? [];
      list.push({ kbId: r.kb_id, kb: r.kb, sourceId: r.id, object: cfg.object ?? r.location, lastSyncAt: n(r.last_sync_at), state: r.state, docs: docs.get(r.id) ?? 0 });
      out.set(cfg.connectionId, list);
    }
    return out;
  }

  async create(p: Principal, input: { name: string; engine: Engine; endpoint: string; database: string | null; zone: string; label: Label; rowLimit: number; timeoutS: number; tls: boolean; username: string | null; password: string | null; baoRole?: string | null; options?: Record<string, unknown> | null }): Promise<ConnectionRow> {
    if (!clears(p.clearance, input.label)) throw forbidden(`Your clearance is ${p.clearance}; a ${input.label} connection is above it.`, { step: 'clearance' });
    const info = engineInfo(input.engine);
    if (input.baoRole && !dynamicEngine(input.engine)) throw conflict('OpenBao dynamic credentials are for PostgreSQL and MySQL connections; give this connection a sealed read-only account (or a vault: reference).');
    if (input.baoRole && !this.dynamic) throw conflict('OpenBao dynamic credentials need OPENBAO_ADDR and OPENBAO_TOKEN on the server.');
    if (info.database?.required && !input.database) throw conflict(`A ${info.title} connection names the ${info.database.label.toLowerCase()} it reads.`);
    if (!input.baoRole && info.credential.usernameRequired && input.password && !input.username) throw conflict(`A ${info.title} connection names its ${info.credential.usernameLabel.toLowerCase()}.`);
    const opts = parseOptions(input.engine, input.options ?? {});
    if (opts.problems.length) throw new HttpProblem(422, 'Invalid settings', `${info.title}: ${opts.problems.join(' ')}`, { extensions: { problems: opts.problems } });
    const id = ulid();
    const t = Date.now();
    const row = {
      id,
      tenant_id: p.tenantId,
      name: input.name,
      engine: input.engine,
      endpoint: input.endpoint,
      database: input.database,
      zone: input.zone,
      label: input.label,
      ops: 'read',
      row_limit: input.rowLimit,
      timeout_s: input.timeoutS,
      credential: (input.username || input.password) && !input.baoRole ? await this.sealCredential(p.tenantId, id, input.username, input.password ?? '') : null,
      vault_owner: (input.username || input.password) && !input.baoRole && isVaultRef(input.password) ? p.userId : null,
      account: input.baoRole ? null : input.username,
      credential_source: input.baoRole ? 'openbao' : 'static',
      bao_role: input.baoRole ?? null,
      // HTTPS engines and Azure SQL always use TLS.
      tls: info.tlsRequired || input.tls,
      options: JSON.stringify(opts.options),
      allow_list: '[]',
      pii_columns: '[]',
      schema: null,
      schema_at: null,
      health: 'unknown',
      health_detail: null,
      checked_at: null,
      version: 1,
      created_by: p.userId,
      created_at: t,
      updated_at: t
    };
    await this.db('data_connections').insert(row);
    return this.get(p.tenantId, id);
  }

  private sealCredential(tenantId: string, id: string, username: string | null, password: string): Promise<string> {
    return this.keys.seal(tenantId, JSON.stringify({ username, password }), `connection:${id}`);
  }

  async update(p: Principal, id: string, patch: { endpoint?: string; database?: string | null; zone?: string; label?: Label; rowLimit?: number; timeoutS?: number; tls?: boolean; options?: Record<string, unknown> }): Promise<ConnectionRow> {
    const c = await this.get(p.tenantId, id);
    if (patch.label && !clears(p.clearance, patch.label)) throw forbidden(`Your clearance is ${p.clearance}.`, { step: 'clearance' });
    const info = engineInfo(c.engine);
    if (info.database?.required && patch.database === null) throw conflict(`A ${info.title} connection names the ${info.database.label.toLowerCase()} it reads.`);
    if (info.tlsRequired && patch.tls === false) throw conflict(`${info.title} connections always use TLS.`);
    const upd: Record<string, unknown> = { updated_at: Date.now(), version: c.version + 1 };
    if (patch.endpoint !== undefined) upd.endpoint = patch.endpoint;
    if (patch.database !== undefined) upd.database = patch.database;
    if (patch.zone !== undefined) upd.zone = patch.zone;
    if (patch.label !== undefined) upd.label = patch.label;
    if (patch.rowLimit !== undefined) upd.row_limit = patch.rowLimit;
    if (patch.timeoutS !== undefined) upd.timeout_s = patch.timeoutS;
    if (patch.tls !== undefined) upd.tls = patch.tls;
    if (patch.options !== undefined) {
      const opts = parseOptions(c.engine, patch.options);
      if (opts.problems.length) throw new HttpProblem(422, 'Invalid settings', `${info.title}: ${opts.problems.join(' ')}`, { extensions: { problems: opts.problems } });
      upd.options = JSON.stringify(opts.options);
    }
    // A new endpoint is a different server: its health is unknown until tested.
    if (patch.endpoint !== undefined && patch.endpoint !== c.endpoint) Object.assign(upd, { health: 'unknown', health_detail: null });
    await this.db('data_connections').where({ id: c.id }).update(upd);
    return this.get(p.tenantId, id);
  }

  async setCredential(p: Principal, id: string, username: string | null, password: string): Promise<ConnectionRow> {
    const c = await this.get(p.tenantId, id);
    if (!username && engineInfo(c.engine).credential.usernameRequired) throw conflict(`A ${engineTitle(c.engine)} credential names its ${engineInfo(c.engine).credential.usernameLabel.toLowerCase()}.`);
    await this.db('data_connections').where({ id: c.id }).update({ credential: await this.sealCredential(c.tenant_id, c.id, username, password), credential_ref: (await this.credentialVault?.rewritten('connection', c.tenant_id, c.id, 'password', password, c.credential_ref)) ?? null, account: username, credential_source: 'static', bao_role: null, vault_owner: isVaultRef(password) ? p.userId : null, version: c.version + 1, updated_at: Date.now(), health: 'unknown' });
    await this.dynamic?.forget(c.id);
    return this.get(p.tenantId, id);
  }

  /** Switches a connection to OpenBao dynamic credentials for `role`; the static credential is dropped. */
  async setDynamicRole(p: Principal, id: string, role: string): Promise<ConnectionRow> {
    const c = await this.get(p.tenantId, id);
    if (!dynamicEngine(c.engine)) throw conflict('OpenBao dynamic credentials are for PostgreSQL and MySQL connections; give this connection a sealed read-only account (or a vault: reference).');
    if (!this.dynamic) throw conflict('OpenBao dynamic credentials need OPENBAO_ADDR and OPENBAO_TOKEN on the server.');
    await this.db('data_connections').where({ id: c.id }).update({ credential: null, credential_ref: null, account: null, credential_source: 'openbao', bao_role: role, vault_owner: null, version: c.version + 1, updated_at: Date.now(), health: 'unknown' });
    await this.dynamic.forget(c.id);
    return this.get(p.tenantId, id);
  }

  async setAllowList(p: Principal, id: string, objects: string[], pii: string[]): Promise<ConnectionRow> {
    const c = await this.get(p.tenantId, id);
    const known = new Set((c.schema ?? []).map((o) => o.name.toLowerCase()));
    const unknown = objects.filter((o) => !known.has(o.toLowerCase()) && !o.includes('*'));
    if (c.schema && unknown.length) throw conflict(`Not in the introspected schema: ${unknown.join(', ')}. Refresh the schema first.`);
    await this.db('data_connections').where({ id: c.id }).update({ allow_list: JSON.stringify([...new Set(objects)]), pii_columns: JSON.stringify([...new Set(pii.map((x) => x.toLowerCase()))]), version: c.version + 1, updated_at: Date.now() });
    return this.get(p.tenantId, id);
  }

  async remove(p: Principal, id: string): Promise<void> {
    const c = await this.get(p.tenantId, id);
    const used = (await this.usage(p.tenantId)).get(c.id) ?? [];
    if (used.length) throw conflict(`${[...new Set(used.map((u) => u.kb))].join(', ')} still sync${used.length === 1 ? 's' : ''} from ${c.name}. Remove the knowledge source first.`);
    // 1.8.0 (B-125): its saved queries go first, so none is left pointing at nothing.
    const saved = (await this.db.schema.hasTable('connection_queries')) ? ((await this.db('connection_queries').where({ tenant_id: c.tenant_id, connection_id: c.id }).select('name')) as { name: string }[]) : [];
    if (saved.length) throw conflict(`${c.name} has saved queries (${saved.map((q) => q.name).slice(0, 5).join(', ')}). Remove them first.`);
    await this.db('data_connections').where({ id: c.id }).delete();
    await this.dynamic?.forget(c.id);
    await this.cloud?.forget(c).catch(() => undefined);
  }

  private async spec(c: ConnectionRow): Promise<ConnectionSpec> {
    const base = await this.storedSpec(c);
    const cloud = this.cloud ? await this.cloud.auth(c) : null;
    if (!cloud) return base;
    const out: ConnectionSpec = { ...base };
    for (const k of ['username', 'password', 'sessionToken', 'bearer', 'ca'] as const) if (cloud[k] !== undefined) out[k] = cloud[k];
    return out;
  }

  private async storedSpec(c: ConnectionRow): Promise<ConnectionSpec> {
    if (c.credential_source === 'openbao') {
      if (!this.dynamic || !c.bao_role) throw conflict('This connection takes its credentials from OpenBao, which is not configured on this server (OPENBAO_ADDR, OPENBAO_TOKEN).');
      const d = await this.dynamic.get(c.bao_role, c.id);
      return { engine: c.engine, endpoint: c.endpoint, database: c.database, tls: c.tls, username: d.username, password: d.password, options: c.options };
    }
    const cred = c.credential ? json<{ username: string; password: string }>(await this.keys.open(c.tenant_id, c.credential, `connection:${c.id}`), { username: '', password: '' }) : null;
    if (cred && c.credential_ref && this.credentialVault && !isVaultRef(cred.password)) {
      // 1.7.0 (B-9208): the password was moved to the vault; it is read there, as the connections service.
      cred.password = await this.credentialVault.read('connection', c.tenant_id, c.credential_ref, `connection:${c.id}`);
    } else if (cred && isVaultRef(cred.password)) {
      // B-1705: read at every use, as the user who saved it, so a revoked grant stops the connection at once.
      if (!this.vaultResolver) throw conflict('This connection takes its password from the vault, which cannot be read here.');
      cred.password = await this.vaultResolver(c.tenant_id, c.vault_owner, cred.password, `connection:${c.id}`);
    }
    return { engine: c.engine, endpoint: c.endpoint, database: c.database, tls: c.tls, username: cred?.username ?? null, password: cred?.password ?? null, options: c.options };
  }

  /**
   * 2.0.x: the admin account's spec: the connection's endpoint and settings with the admin credential. Never the
   * read account, never OpenBao or a cloud link: a schema change runs only on an account someone set for it.
   */
  private async adminSpec(c: ConnectionRow): Promise<ConnectionSpec> {
    if (!c.admin_credential) throw conflict(`${c.name} has no admin account for schema changes. Set one on its Settings tab; queries keep using the read-only account.`);
    const cred = json<{ username: string | null; password: string }>(await this.keys.open(c.tenant_id, c.admin_credential, `connection-admin:${c.id}`), { username: null, password: '' });
    if (c.admin_credential_ref && this.credentialVault && !isVaultRef(cred.password)) cred.password = await this.credentialVault.read('connection', c.tenant_id, c.admin_credential_ref, `connection-admin:${c.id}`);
    else if (isVaultRef(cred.password)) {
      if (!this.vaultResolver) throw conflict('This admin account takes its password from the vault, which cannot be read here.');
      cred.password = await this.vaultResolver(c.tenant_id, c.admin_vault_owner ?? null, cred.password, `connection-admin:${c.id}`);
    }
    return { engine: c.engine, endpoint: c.endpoint, database: c.database, tls: c.tls, username: cred.username, password: cred.password, options: c.options };
  }

  private async adminDriver(c: ConnectionRow) {
    const make = (this.drivers as Partial<Record<string, DriverFactory>>)[c.engine];
    if (!make) throw conflict(`The ${c.engine} engine is not installed on this platform.`);
    const spec = await this.adminSpec(c);
    this.secretsOf.set(c.id, [...(this.secretsOf.get(c.id) ?? []), spec.password].filter((x): x is string => !!x));
    return make(spec);
  }

  /** B-907: the secrets of the last spec built per connection, masked out of driver messages. */
  private readonly secretsOf = new Map<string, string[]>();

  private async driver(c: ConnectionRow) {
    const make = (this.drivers as Partial<Record<string, DriverFactory>>)[c.engine];
    if (!make) throw conflict(`The ${c.engine} engine is not installed on this platform.`);
    const spec = await this.spec(c);
    this.secretsOf.set(c.id, [spec.password, spec.sessionToken, spec.bearer].filter((x): x is string => !!x));
    return make(spec);
  }

  /** A driver's error message with the connection's password and any other credentials masked. */
  private scrub(c: ConnectionRow, err: unknown): string {
    return scrubError(err, this.secretsOf.get(c.id) ?? []);
  }

  async test(tenantId: string, id: string): Promise<{ ok: boolean; ms: number; version?: string; readOnly?: boolean; detail: string; health: ConnectionRow['health'] }> {
    const c = await this.get(tenantId, id);
    const t = Date.now();
    try {
      const r = await (await this.driver(c)).test(c.timeout_s * 1000);
      const ms = Date.now() - t;
      const health = r.health === 'healthy' && !r.readOnly ? 'degraded' : r.health;
      await this.db('data_connections').where({ id }).update({ health, health_detail: r.detail.slice(0, 300), checked_at: Date.now() });
      return { ok: true, ms, version: r.version, readOnly: r.readOnly, detail: r.detail, health };
    } catch (err) {
      const detail = this.scrub(c, err).slice(0, 300);
      await this.db('data_connections').where({ id }).update({ health: 'unreachable', health_detail: detail, checked_at: Date.now() });
      return { ok: false, ms: Date.now() - t, detail, health: 'unreachable' };
    }
  }

  async refreshSchema(tenantId: string, id: string): Promise<{ objects: number; allowed: number; outside: number }> {
    const c = await this.get(tenantId, id);
    let schema: SchemaObject[];
    try {
      schema = await (await this.driver(c)).introspect(c.timeout_s * 1000);
    } catch (err) {
      throw new HttpProblem(502, 'Introspection failed', `${c.name} could not be read: ${this.scrub(c, err)}`.slice(0, 500));
    }
    await this.db('data_connections').where({ id }).update({ schema: JSON.stringify(schema), schema_at: Date.now() });
    const ok = schema.filter((o) => allowed(c, o.name)).length;
    return { objects: schema.length, allowed: ok, outside: schema.length - ok };
  }

  classify(c: ConnectionRow, input: QueryInput): Classification {
    const d = dialectOf(c.engine);
    const other = NON_SQL[c.engine];
    if (!d && !other) return { kind: 'denied', verb: null, objects: [], denied: c.engine, reason: `The ${c.engine} engine is not installed on this platform.` };
    const cl = d ? d.classify(input.query) : other!.classify(input.query, input.object ?? null, { database: c.database, options: c.options, schema: c.schema });
    if (cl.kind === 'read' || cl.kind === 'unparsed') {
      const bad = cl.objects.find((o) => !allowed(c, o));
      if (bad) return { ...cl, kind: 'denied', denied: bad, reason: `${bad} is not on the schema allow-list for ${c.name}.` };
      if (cl.kind === 'read' && !cl.objects.length && d) return { ...cl, kind: 'unparsed', reason: 'The query reads no table or view the parser could find.' };
    }
    return cl;
  }

  /** Masks PII columns of the objects read and any value the classifier recognises as personal data. */
  private mask(c: ConnectionRow, objects: string[], r: QueryResult): { rows: unknown[][]; masked: string[] } {
    const pii = piiColumns(c);
    // The objects as listed in the schema (schema.table), so a PII mark on `dbo.people.email` covers `people`.
    const names = new Set(objects.flatMap((o) => [o.toLowerCase(), `public.${o}`.toLowerCase(), ...(c.engine !== 'postgres' && c.engine !== 'mysql' && dialectOf(c.engine) ? [canonical(o, c)] : []), ...(c.engine === 'mysql' && c.database && !o.includes('.') ? [`${c.database}.${o}`.toLowerCase()] : [])]));
    const byColumn = r.columns.map((col) => PII_NAME.test(col) || [...names].some((o) => pii.has(`${o}.${col}`.toLowerCase())));
    const masked = new Set<string>(r.columns.filter((_, i) => byColumn[i]));
    const rows = r.rows.map((row) =>
      row.map((v, i) => {
        if (v == null) return v;
        if (byColumn[i]) return maskValue(v);
        if (typeof v === 'string' && looksPersonal(v)) {
          masked.add(r.columns[i]!);
          return maskValue(v);
        }
        if (v instanceof Date) return v.toISOString();
        if (typeof v === 'object') {
          // Documents and JSON values (MongoDB sub-documents, json columns): personal fields and values inside are masked too.
          let hit = false;
          const out = maskDeep(v, () => (hit = true));
          if (hit) masked.add(r.columns[i]!);
          return JSON.stringify(out);
        }
        return v;
      })
    );
    return { rows, masked: [...masked] };
  }

  private refuse(c: ConnectionRow, cl: Classification): HttpProblem {
    const ext = { kind: cl.kind, verb: cl.verb, ...(cl.denied ? { object: cl.denied } : {}) };
    switch (cl.kind) {
      case 'ddl':
        return new HttpProblem(422, 'DDL refused', `The parser read a ${cl.verb} statement. Schema changes are never sent to a registered connection. Nothing reached ${c.endpoint}.`, { extensions: ext });
      case 'write':
        return new HttpProblem(422, 'Write refused', `${/^[AEIOU]/i.test(cl.verb ?? '') ? 'An' : 'A'} ${cl.verb} was proposed on a read-only connection. The database account would refuse it, so it is not sent.`, { extensions: ext });
      case 'multiple':
        return new HttpProblem(422, 'Several statements refused', 'Send one statement at a time.', { extensions: ext });
      case 'denied':
        return new HttpProblem(422, 'Object outside the allow-list', cl.reason ?? `${cl.denied} is not allowed.`, { extensions: ext });
      default:
        return new HttpProblem(409, 'Parser could not read it', `${cl.reason ?? 'The parser could not read the query.'} Read-only is still enforced by the database account. Confirm to run it as written.`, { extensions: { ...ext, kind: 'unparsed' } });
    }
  }

  /** Classifies, checks, runs and masks one query from the data browser. Every outcome is audited. */
  async run(ctx: CallContext, id: string, input: QueryInput): Promise<{ columns: string[]; rows: unknown[][]; capped: boolean; estimate: number | null; ms: number; masked: string[]; label: Label; unparsed: boolean; verb: string | null }> {
    const p = ctx.principal;
    const c = await this.get(p.tenantId, id);
    if (!clears(p.clearance, c.label)) throw forbidden(`This connection is labelled ${c.label} and your clearance is ${p.clearance}. The schema is listed; queries and results are withheld.`, { step: 'clearance' });
    const cl = this.classify(c, input);
    const record = (action: string, detail: Record<string, unknown>) =>
      this.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ctx.ip), target: { connection: c.id, name: c.name }, label: c.label, detail: { query: input.query.slice(0, 2000), kind: cl.kind, verb: cl.verb, objects: cl.objects, ...detail }, traceId: ctx.traceId });
    if (cl.kind !== 'read' && !(cl.kind === 'unparsed' && input.confirmUnparsed)) {
      await record('connection.query.refused', { reason: cl.reason ?? null, ...(cl.denied ? { object: cl.denied } : {}) });
      throw this.refuse(c, cl);
    }
    // Requests of the non-SQL engines (OpenSearch, MongoDB and its services, Redis, RabbitMQ, Prometheus, InfluxDB, DynamoDB, Cosmos DB) are sent as parsed, so one the parser could not read cannot run at all.
    if (cl.kind === 'unparsed' && !dialectOf(c.engine)) {
      await record('connection.query.refused', { reason: cl.reason ?? null });
      throw new HttpProblem(422, 'Request refused', cl.reason ?? 'The request could not be read.', { extensions: { kind: 'unparsed' } });
    }
    const guard = await this.guard.check({ tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, checkpoint: 'db-query', text: input.query, label: c.label, principal: p, source: { kind: 'connection', id: c.id }, meta: { engine: c.engine, kind: cl.kind, objects: cl.objects } });
    if (guard.action === 'block' || guard.action === 'require-approval') {
      await record('connection.query.refused', { reason: guard.reason ?? 'guardrail', guard: guard.action });
      throw new HttpProblem(403, 'Blocked by a guardrail', guard.reason ?? 'A guardrail rule refused this query.', { extensions: { step: 'guardrail', checkpoint: 'db-query' } });
    }
    const text = guard.action === 'redact' ? guard.text : input.query;
    const t = Date.now();
    let r: QueryResult;
    try {
      r = await (await this.driver(c)).query(cl, text, { limit: c.row_limit, timeoutMs: c.timeout_s * 1000 });
    } catch (err) {
      // A refusal before anything reached the database (a vault reference the owner may no longer read, B-1705).
      if (err instanceof HttpProblem && err.status < 500) {
        await record('connection.query.refused', { reason: (err.detail ?? err.title).slice(0, 300) });
        throw err;
      }
      const message = this.scrub(c, err);
      await record('connection.query.failed', { error: message.slice(0, 300) });
      throw new HttpProblem(502, 'Query failed', `${c.name}: ${message}`.slice(0, 500), { extensions: { kind: 'failed' } });
    }
    const ms = Date.now() - t;
    const m = this.mask(c, cl.objects, r);
    await record(cl.kind === 'unparsed' ? 'connection.query.unparsed' : 'connection.query', { rows: m.rows.length, capped: r.capped, ms, masked: m.masked });
    return { columns: r.columns, rows: m.rows, capped: r.capped, estimate: r.estimate, ms, masked: m.masked, label: c.label, unparsed: cl.kind === 'unparsed', verb: cl.verb };
  }

  /**
   * 1.8.0 (B-125): one read of a saved query, already classified and checked by `SavedQueries` (published version,
   * allow-list, the db-query guardrail, clearance, audit there): the bound parameters travel apart from the text, the
   * result is capped and masked as every other read, and a driver's message is scrubbed of the credentials.
   */
  async runBound(c: ConnectionRow, cl: Classification, text: string, opts: { params: unknown[]; limit: number; offset: number; timeoutMs: number }): Promise<{ columns: string[]; rows: unknown[][]; capped: boolean; masked: string[]; ms: number }> {
    const t = Date.now();
    let r: QueryResult;
    try {
      r = await (await this.driver(c)).query(cl, text, { limit: opts.limit, timeoutMs: Math.min(opts.timeoutMs, c.timeout_s * 1000), params: opts.params, offset: opts.offset });
    } catch (err) {
      if (err instanceof HttpProblem && err.status < 500) throw err;
      throw new HttpProblem(502, 'Query failed', `${c.name}: ${this.scrub(c, err)}`.slice(0, 500), { extensions: { kind: 'failed' } });
    }
    const m = this.mask(c, cl.objects, r);
    return { columns: r.columns, rows: m.rows, capped: r.capped, masked: m.masked, ms: Date.now() - t };
  }

  /** The same checks as `run`, then the result as CSV through the export checkpoint. */
  async exportCsv(ctx: CallContext, id: string, input: QueryInput): Promise<{ file: string; csv: string; rows: number; label: Label }> {
    const c = await this.get(ctx.principal.tenantId, id);
    const r = await this.run(ctx, id, input);
    let csv = `# label: ${c.label}; exported by ${ctx.principal.username}; masked: ${r.masked.join(' ') || 'none'}\r\n` + csvLine(r.columns) + r.rows.map((row) => csvLine(row)).join('');
    const guard = await this.guard.check({ tenantId: c.tenant_id, workspaceId: ctx.principal.workspaceId ?? null, checkpoint: 'export', text: csv, label: c.label, principal: ctx.principal, source: { kind: 'connection', id: c.id }, meta: { rows: r.rows.length } });
    if (guard.action === 'block' || guard.action === 'require-approval') throw new HttpProblem(403, 'Blocked by a guardrail', guard.reason ?? 'A guardrail rule refused this export.', { extensions: { step: 'guardrail', checkpoint: 'export' } });
    if (guard.action === 'redact') csv = guard.text;
    const file = `${c.name}-${new Date().toISOString().slice(0, 10)}.csv`;
    await this.audit.append({ tenantId: c.tenant_id, action: 'connection.exported', kind: 'admin', actor: actorFrom(ctx.principal, ctx.ip), target: { connection: c.id, name: c.name }, label: c.label, detail: { rows: r.rows.length, file, masked: r.masked }, traceId: ctx.traceId });
    return { file, csv, rows: r.rows.length, label: c.label };
  }

  /**
   * Rows of an allow-listed object for a knowledge source, masked the same way. `rawColumn` (a row-level access
   * column, B-1002) is also returned unmasked beside the rows, as it decides who may retrieve each row.
   */
  async readRows(tenantId: string, id: string, object: string, opts: { watermarkColumn: string | null; after: string | null; limit: number; rawColumn?: string | null; role?: string | null; fields?: string[] | null }): Promise<{ columns: string[]; rows: unknown[][]; capped: boolean; label: Label; name: string; raw?: unknown[] }> {
    const c = await this.get(tenantId, id);
    if (!engineInfo(c.engine).knowledgeSource) throw conflict('Only SQL tables and views, and MongoDB collections, can be a knowledge source.');
    if (!allowed(c, object)) throw conflict(`${object} is not on the schema allow-list for ${c.name}.`);
    if (opts.role && c.engine !== 'postgres') throw conflict('Reading as a database role is for PostgreSQL connections.');
    const r = await (await this.driver(c)).rows(object, { watermarkColumn: opts.watermarkColumn, after: opts.after, limit: opts.limit, timeoutMs: c.timeout_s * 1000, ...(opts.role ? { role: opts.role } : {}), ...(opts.fields?.length ? { fields: opts.fields } : {}) });
    const at = opts.rawColumn ? r.columns.indexOf(opts.rawColumn) : -1;
    const raw = at >= 0 ? r.rows.map((row) => row[at]) : undefined;
    const m = this.mask(c, [object], r);
    return { columns: r.columns, rows: m.rows, capped: r.capped, label: c.label, name: c.name, ...(raw ? { raw } : {}) };
  }

  /**
   * Rows of an allow-listed table for an app entity backed by it (1.6.0, B-8501), unmasked: the entity's records seal
   * them under a label at least the connection's, and the pull is audited by the app service. PostgreSQL and MySQL
   * only.
   */
  async readRowsForApp(tenantId: string, id: string, object: string, opts: { limit: number; fields?: string[] | null }): Promise<{ columns: string[]; rows: unknown[][]; capped: boolean; connection: ConnectionRow }> {
    const c = await this.get(tenantId, id);
    if (c.engine !== 'postgres' && c.engine !== 'mysql') throw conflict('Only a PostgreSQL or MySQL table can back an app entity.');
    if (!allowed(c, object)) throw conflict(`${object} is not on the schema allow-list for ${c.name}.`);
    const r = await (await this.driver(c)).rows(object, { watermarkColumn: null, after: null, limit: opts.limit, timeoutMs: c.timeout_s * 1000, ...(opts.fields ? { fields: opts.fields } : {}) });
    return { columns: r.columns, rows: r.rows.map((row) => row.map((v) => (v instanceof Date ? v.toISOString() : v))), capped: r.capped, connection: c };
  }

  /** One row written to an allow-listed table for an app entity backed by it (1.6.0, B-8501); the caller audits. */
  async mutateRow(tenantId: string, id: string, object: string, op: RowMutation): Promise<{ affected: number }> {
    const c = await this.get(tenantId, id);
    if (c.engine !== 'postgres' && c.engine !== 'mysql') throw conflict('Only a PostgreSQL or MySQL table can back an app entity.');
    if (!allowed(c, object)) throw conflict(`${object} is not on the schema allow-list for ${c.name}.`);
    const d = await this.driver(c);
    if (!d.mutate) throw conflict(`The ${c.engine} driver cannot write rows.`);
    try {
      return await d.mutate(object, op, c.timeout_s * 1000);
    } catch (err) {
      if (err instanceof HttpProblem) throw err;
      throw new HttpProblem(502, 'Write failed', `${c.name}: ${this.scrub(c, err)}`.slice(0, 500), { extensions: { kind: 'failed' } });
    }
  }

  /** How PostgreSQL would read an allow-listed object as each mapped role (B-1503). */
  async roleCheck(tenantId: string, id: string, object: string, roles: string[]): Promise<RoleCheck> {
    const c = await this.get(tenantId, id);
    if (c.engine !== 'postgres') throw conflict('Row security through database roles is for PostgreSQL connections.');
    if (!allowed(c, object)) throw conflict(`${object} is not on the schema allow-list for ${c.name}.`);
    const d = await this.driver(c);
    if (!d.roleCheck) throw conflict(`The ${c.engine} driver cannot check roles.`);
    return d.roleCheck(object, roles, c.timeout_s * 1000);
  }

  /**
   * A logical replication stream of one allow-listed PostgreSQL table (B-1003). Changes to other relations are
   * dropped; values are masked as in every other read, with `rawColumn` kept unmasked beside them (`raw`).
   */
  async replicate(tenantId: string, id: string, object: string, opts: Omit<ReplicationOptions, 'table' | 'timeoutMs'> & { rawColumn?: string | null }): Promise<MaskedReplicationStream> {
    const c = await this.get(tenantId, id);
    if (c.engine !== 'postgres') throw conflict('Logical replication is for PostgreSQL connections.');
    if (!allowed(c, object)) throw conflict(`${object} is not on the schema allow-list for ${c.name}.`);
    const d = await this.driver(c);
    if (!d.replicate) throw conflict(`The ${c.engine} driver cannot replicate.`);
    const inner = await d.replicate({ slot: opts.slot, publication: opts.publication, startLsn: opts.startLsn, table: object, timeoutMs: c.timeout_s * 1000 });
    const same = (rel: string) => rel.toLowerCase() === object.toLowerCase() || `public.${rel}`.toLowerCase() === object.toLowerCase() || rel.toLowerCase() === `public.${object}`.toLowerCase();
    const maskOne = (columns: string[], row: unknown[] | null) => (row ? this.mask(c, [object], { columns, rows: [row], capped: false, estimate: null }).rows[0]! : null);
    return {
      stop: () => inner.stop(),
      run: (onBatch, onReady) =>
        inner.run(async (b) => {
          const changes = b.changes
            .filter((ch) => same(ch.relation))
            .map((ch) => {
              const at = opts.rawColumn ? ch.columns.indexOf(opts.rawColumn) : -1;
              return { ...ch, raw: at >= 0 && ch.values ? ch.values[at] : undefined, values: maskOne(ch.columns, ch.values), old: maskOne(ch.columns, ch.old) };
            });
          await onBatch({ lsn: b.lsn, changes });
        }, onReady)
    };
  }

  /** 2.0.x: sets the admin account schema changes run on (sealed as `connection-admin:<id>`, or a `vault:` reference). */
  async setAdminCredential(p: Principal, id: string, username: string | null, password: string): Promise<ConnectionRow> {
    const c = await this.get(p.tenantId, id);
    if (!clears(p.clearance, c.label)) throw forbidden(`This connection is labelled ${c.label} and your clearance is ${p.clearance}.`, { step: 'clearance' });
    if (!designable(c.engine)) throw conflict(`${engineTitle(c.engine)} connections have no schema changes, so they take no admin account.`);
    if (!username && engineInfo(c.engine).credential.usernameRequired) throw conflict(`A ${engineTitle(c.engine)} admin account names its ${engineInfo(c.engine).credential.usernameLabel.toLowerCase()}.`);
    const sealed = await this.keys.seal(c.tenant_id, JSON.stringify({ username, password }), `connection-admin:${c.id}`);
    const ref = (await this.credentialVault?.rewritten('connection', c.tenant_id, c.id, 'adminPassword', password, c.admin_credential_ref)) ?? null;
    await this.db('data_connections').where({ id: c.id }).update({ admin_credential: sealed, admin_credential_ref: ref, admin_account: username, admin_vault_owner: isVaultRef(password) ? p.userId : null, admin_set_at: Date.now(), version: c.version + 1, updated_at: Date.now() });
    return this.get(p.tenantId, id);
  }

  async clearAdminCredential(p: Principal, id: string): Promise<ConnectionRow> {
    const c = await this.get(p.tenantId, id);
    await this.db('data_connections').where({ id: c.id }).update({ admin_credential: null, admin_credential_ref: null, admin_account: null, admin_vault_owner: null, admin_set_at: null, version: c.version + 1, updated_at: Date.now() });
    return this.get(p.tenantId, id);
  }

  /** The plan for a definition, or a 422 listing every problem. */
  plan(c: ConnectionRow, definition: unknown, current: ObjectDescription | null = null): DdlPlan {
    try {
      return buildPlan(c.engine, c, definition, current);
    } catch (err) {
      if (err instanceof DdlProblem) throw new HttpProblem(422, 'Definition not valid', err.problems.join(' '), { extensions: { problems: err.problems } });
      throw err;
    }
  }

  /** Why applying a plan would be refused now, as sentences (empty when it can run). */
  private blockers(p: Principal, c: ConnectionRow, plan: DdlPlan): string[] {
    const out: string[] = [];
    if (!clears(p.clearance, c.label)) out.push(`This connection is labelled ${c.label} and your clearance is ${p.clearance}.`);
    if (!c.admin_credential) out.push(`${c.name} has no admin account for schema changes; set one on the Settings tab.`);
    for (const t of plan.touches) if (!allowed(c, t)) out.push(`${t} is not on the schema allow-list; a change can only act on allow-listed objects.`);
    return out;
  }

  /** 2.0.x: the statements a definition would run, with what stands in the way. Nothing is sent. */
  async previewDdl(ctx: CallContext, id: string, definition: unknown): Promise<{ plan: DdlPlan; blockers: string[] }> {
    const c = await this.get(ctx.principal.tenantId, id);
    const plan = this.plan(c, definition, await this.currentFor(c, definition));
    return { plan, blockers: this.blockers(ctx.principal, c, plan) };
  }

  /**
   * 2.0.x editing: the live description an edit is diffed against, read on the read account at every preview and
   * apply (never taken from the browser); null for creates and drops.
   */
  private async currentFor(c: ConnectionRow, definition: unknown): Promise<ObjectDescription | null> {
    const target = describeTarget(c.engine, definition);
    if (!target) return null;
    return this.describeRow(c, target.name, target.kind);
  }

  private async describeRow(c: ConnectionRow, name: string, kind: DescribeKind): Promise<ObjectDescription | null> {
    try {
      const d = await this.driver(c);
      if (!d.describe) throw conflict(`${engineTitle(c.engine)} connections cannot describe objects for editing.`);
      return await d.describe(name, kind, c.timeout_s * 1000);
    } catch (err) {
      if (err instanceof HttpProblem && err.status < 500) throw err;
      throw new HttpProblem(502, 'Object could not be read', `${c.name}: ${this.scrub(c, err)}`.slice(0, 500));
    }
  }

  /** 2.0.x editing: one object in full, for the edit forms (read account; clearance as for queries). */
  async describeObject(ctx: CallContext, id: string, name: string, kind: DescribeKind): Promise<ObjectDescription> {
    const p = ctx.principal;
    const c = await this.get(p.tenantId, id);
    if (!clears(p.clearance, c.label)) throw forbidden(`This connection is labelled ${c.label} and your clearance is ${p.clearance}.`, { step: 'clearance' });
    const out = await this.describeRow(c, name, kind);
    if (!out) throw notFound(`${name} on ${c.name}`);
    return out;
  }

  /** 2.0.x editing: the objects the designer can edit or drop: the introspected schema and the routines. */
  async objects(ctx: CallContext, id: string): Promise<{ objects: { name: string; kind: string; allowed: boolean; signature?: string | null }[]; editable: { edit: string[]; drop: string[] } }> {
    const p = ctx.principal;
    const c = await this.get(p.tenantId, id);
    if (!clears(p.clearance, c.label)) throw forbidden(`This connection is labelled ${c.label} and your clearance is ${p.clearance}.`, { step: 'clearance' });
    const out: { name: string; kind: string; allowed: boolean; signature?: string | null }[] = (c.schema ?? []).map((o) => ({ name: o.name, kind: o.kind === 'index' ? 'search-index' : o.kind === 'keyspace' ? 'stream-group' : o.kind, allowed: allowed(c, o.name) }));
    const d = await this.driver(c).catch(() => null);
    if (d?.routines) {
      try {
        for (const r of await d.routines(c.timeout_s * 1000)) out.push({ name: r.name, kind: r.kind, allowed: true, ...(r.signature !== undefined ? { signature: r.signature } : {}) });
      } catch {
        // An account that cannot list routines still lists its tables.
      }
    }
    return { objects: out, editable: editKinds(c.engine) };
  }

  /**
   * 2.0.x: runs a previewed schema change on the admin account. The plan is rebuilt from the definition and must match
   * the hash the person saw; the clearance, the allow-list for what it acts on, and the db-query guardrail apply; every
   * outcome is audited with the statements. Afterwards the schema is refreshed on the read account and, if asked, the
   * new object is added to the allow-list.
   */
  async applyDdl(ctx: CallContext, id: string, input: { definition: unknown; hash: string; allowList: boolean; confirm?: string | null }): Promise<{ applied: number; ms: number; plan: DdlPlan; schemaRefreshed: boolean; allowListed: boolean }> {
    const p = ctx.principal;
    const c = await this.get(p.tenantId, id);
    // An edit is diffed against the object as it is now: a change since the preview gives another hash, refused below.
    const plan = this.plan(c, input.definition, await this.currentFor(c, input.definition));
    const record = (action: string, detail: Record<string, unknown>) =>
      this.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ctx.ip), target: { connection: c.id, name: c.name }, label: c.label, detail: { kind: plan.kind, object: plan.object, account: c.admin_account ?? null, statements: plan.statements.map((x) => x.slice(0, 4000)).slice(0, 20), hash: plan.hash, ...detail }, traceId: ctx.traceId });
    if (plan.hash !== input.hash) {
      await record('connection.ddl.refused', { reason: 'changed since preview' });
      throw new HttpProblem(409, 'Preview again', 'The definition is not the one previewed. Preview it again and check the statements before applying.', { extensions: { kind: 'hash' } });
    }
    if (plan.destructive && (input.confirm ?? '').trim() !== (plan.confirmName ?? '')) {
      await record('connection.ddl.refused', { reason: 'destructive change not confirmed' });
      throw new HttpProblem(422, 'Confirm the change', `This change loses data. Type ${plan.confirmName} to confirm it.`, { extensions: { kind: 'confirm', confirmName: plan.confirmName } });
    }
    const blockers = this.blockers(p, c, plan);
    if (blockers.length) {
      await record('connection.ddl.refused', { reason: blockers.join(' ') });
      if (!clears(p.clearance, c.label)) throw forbidden(blockers[0]!, { step: 'clearance' });
      throw new HttpProblem(409, 'Schema change refused', blockers.join(' '), { extensions: { blockers } });
    }
    const guard = await this.guard.check({ tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, checkpoint: 'db-query', text: plan.statements.join('\n;\n'), label: c.label, principal: p, source: { kind: 'connection', id: c.id }, meta: { engine: c.engine, kind: 'ddl', objects: [plan.object, ...plan.touches] } });
    // A redaction would change the statements reviewed in the preview, so it refuses as a block does.
    if (guard.action === 'block' || guard.action === 'require-approval' || guard.action === 'redact') {
      await record('connection.ddl.refused', { reason: guard.reason ?? 'guardrail', guard: guard.action });
      throw new HttpProblem(403, 'Blocked by a guardrail', guard.reason ?? 'A guardrail rule refused this change.', { extensions: { step: 'guardrail', checkpoint: 'db-query' } });
    }
    const t = Date.now();
    let out: { applied: number; detail?: string };
    try {
      const d = await this.adminDriver(c);
      if (!d.applyDdl) throw conflict(`The ${engineTitle(c.engine)} driver cannot make schema changes.`);
      out = await d.applyDdl(plan, c.timeout_s * 1000);
    } catch (err) {
      if (err instanceof HttpProblem && err.status < 500) {
        await record('connection.ddl.refused', { reason: (err.detail ?? err.title).slice(0, 300) });
        throw err;
      }
      const message = this.scrub(c, err);
      await record('connection.ddl.failed', { error: message.slice(0, 500) });
      throw new HttpProblem(502, 'Schema change failed', `${c.name}: ${message}`.slice(0, 600), { extensions: { kind: 'failed' } });
    }
    const ms = Date.now() - t;
    let schemaRefreshed = false;
    let allowListed = false;
    try {
      await this.refreshSchema(p.tenantId, c.id);
      schemaRefreshed = true;
    } catch {
      // The change ran; a schema the read account cannot list yet is refreshed by hand later.
    }
    // 2.0.x editing: a dropped object leaves the allow-list; a renamed table keeps its place on it under the new name.
    if (plan.kind === 'drop' || plan.kind === 'alter-table') {
      const def = input.definition as { kind?: string; name?: string; rename?: string; objectKind?: string };
      const now = await this.get(p.tenantId, c.id);
      const same = (a: string) => a.toLowerCase() === String(def.name ?? '').toLowerCase() || (!!now.schema && dialectOf(c.engine) !== null && findObject([{ name: a }], String(def.name ?? ''), now) !== undefined);
      let list = now.allow_list;
      if (def.kind === 'drop' && ['table', 'view', 'collection', 'search-index', 'container', 'queue'].includes(String(def.objectKind))) list = list.filter((a) => !same(a));
      if (def.kind === 'alter-table' && def.rename) {
        const parts = String(def.name).split('.');
        const renamed = [...parts.slice(0, -1), def.rename].join('.');
        list = list.map((a) => (same(a) ? (a.includes('.') && !renamed.includes('.') ? `${a.split('.').slice(0, -1).join('.')}.${def.rename}` : renamed) : a));
      }
      if (JSON.stringify(list) !== JSON.stringify(now.allow_list)) await this.db('data_connections').where({ id: c.id }).update({ allow_list: JSON.stringify(list), version: now.version + 1, updated_at: Date.now() });
    }
    if (input.allowList && LISTABLE.has(plan.kind)) {
      const now = await this.get(p.tenantId, c.id);
      const found = now.schema ? (dialectOf(c.engine) ? findObject(now.schema, plan.object, now) : now.schema.find((o) => o.name.toLowerCase() === plan.object.toLowerCase())) : undefined;
      const name = found?.name ?? (dialectOf(c.engine) ? null : plan.object);
      if (name && !allowed(now, name)) {
        await this.db('data_connections').where({ id: c.id }).update({ allow_list: JSON.stringify([...now.allow_list, name]), version: now.version + 1, updated_at: Date.now() });
        allowListed = true;
      } else if (name) allowListed = true;
    }
    await record('connection.ddl.applied', { applied: out.applied, ms, transactional: plan.transactional, destructive: plan.destructive, allowListed });
    return { applied: out.applied, ms, plan, schemaRefreshed, allowListed };
  }

  /** 2.0.x: the allow-listed queues of a Redis or RabbitMQ connection, read on the read account. */
  async queues(ctx: CallContext, id: string): Promise<{ queues: QueueInfo[]; outside: number; capped: boolean; ms: number }> {
    const p = ctx.principal;
    const c = await this.get(p.tenantId, id);
    if (!clears(p.clearance, c.label)) throw forbidden(`This connection is labelled ${c.label} and your clearance is ${p.clearance}.`, { step: 'clearance' });
    const t = Date.now();
    let r: { queues: QueueInfo[]; outside: number; capped: boolean };
    try {
      const d = await this.driver(c);
      if (!d.queues) throw conflict(`${engineTitle(c.engine)} connections have no queues to inspect.`);
      r = await d.queues({ allowed: (name) => allowed(c, name), patterns: c.allow_list, limit: c.row_limit, timeoutMs: c.timeout_s * 1000 });
    } catch (err) {
      if (err instanceof HttpProblem && err.status < 500) throw err;
      throw new HttpProblem(502, 'Queues could not be read', `${c.name}: ${this.scrub(c, err)}`.slice(0, 500));
    }
    const ms = Date.now() - t;
    await this.audit.append({ tenantId: p.tenantId, action: 'connection.queues.read', kind: 'admin', actor: actorFrom(p, ctx.ip), target: { connection: c.id, name: c.name }, label: c.label, detail: { queues: r.queues.length, outside: r.outside, capped: r.capped, ms }, traceId: ctx.traceId });
    return { ...r, ms };
  }

  /** Drops a knowledge source's replication slot on its connection (when the source is removed). */
  async dropReplicationSlot(tenantId: string, id: string, slot: string): Promise<boolean> {
    const c = await this.get(tenantId, id);
    const d = await this.driver(c);
    return d.dropReplicationSlot ? d.dropReplicationSlot(slot, c.timeout_s * 1000) : false;
  }
}
