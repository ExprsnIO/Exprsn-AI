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
import { allowedIndex, allowedMysql, allowedSql, classifyMysql, classifyOpenSearch, classifySql, type Classification } from './classify.js';
import type { DynamicCredentials } from './dynamic.js';
import type { ConnectionSpec, DriverFactory, QueryResult, SchemaObject } from './drivers.js';
import type { ReplicationOptions, RowChange } from './replication.js';

/** A replicated change after masking; `raw` is the unmasked value of the requested column (the access column). */
export type MaskedChange = RowChange & { raw: unknown };
export interface MaskedReplicationStream {
  run(onBatch: (b: { lsn: string; changes: MaskedChange[] }) => Promise<void>, onReady?: () => void): Promise<void>;
  stop(): Promise<void>;
}

export type Engine = ConnectionSpec['engine'];
export const ENGINES: readonly Engine[] = ['postgres', 'opensearch', 'mysql'];

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
  tls: boolean;
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
  tls: !!r.tls,
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

export const connectionView = (c: ConnectionRow, usedBy: { kbId: string; kb: string; sourceId: string; object: string; lastSyncAt: number | null; state: string; docs: number }[] = []) => {
  const pii = piiColumns(c);
  const objects = c.schema ?? [];
  return {
    id: c.id,
    name: c.name,
    engine: c.engine,
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

function allowed(c: ConnectionRow, object: string): boolean {
  return c.engine === 'postgres' ? allowedSql(object, c.allow_list) : c.engine === 'mysql' ? allowedMysql(object, c.allow_list, c.database) : allowedIndex(object, c.allow_list);
}

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
 * Data connections: PostgreSQL and OpenSearch, with credentials sealed under the tenant key (never shown again),
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

  async create(p: Principal, input: { name: string; engine: Engine; endpoint: string; database: string | null; zone: string; label: Label; rowLimit: number; timeoutS: number; tls: boolean; username: string | null; password: string | null; baoRole?: string | null }): Promise<ConnectionRow> {
    if (!clears(p.clearance, input.label)) throw forbidden(`Your clearance is ${p.clearance}; a ${input.label} connection is above it.`, { step: 'clearance' });
    if (input.baoRole && !this.dynamic) throw conflict('OpenBao dynamic credentials need OPENBAO_ADDR and OPENBAO_TOKEN on the server.');
    if (input.baoRole && input.engine === 'opensearch') throw conflict('OpenBao dynamic credentials are for PostgreSQL and MySQL connections.');
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
      credential: input.username && !input.baoRole ? await this.sealCredential(p.tenantId, id, input.username, input.password ?? '') : null,
      account: input.baoRole ? null : input.username,
      credential_source: input.baoRole ? 'openbao' : 'static',
      bao_role: input.baoRole ?? null,
      tls: input.tls,
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

  private sealCredential(tenantId: string, id: string, username: string, password: string): Promise<string> {
    return this.keys.seal(tenantId, JSON.stringify({ username, password }), `connection:${id}`);
  }

  async update(p: Principal, id: string, patch: { endpoint?: string; database?: string | null; zone?: string; label?: Label; rowLimit?: number; timeoutS?: number; tls?: boolean }): Promise<ConnectionRow> {
    const c = await this.get(p.tenantId, id);
    if (patch.label && !clears(p.clearance, patch.label)) throw forbidden(`Your clearance is ${p.clearance}.`, { step: 'clearance' });
    const upd: Record<string, unknown> = { updated_at: Date.now(), version: c.version + 1 };
    if (patch.endpoint !== undefined) upd.endpoint = patch.endpoint;
    if (patch.database !== undefined) upd.database = patch.database;
    if (patch.zone !== undefined) upd.zone = patch.zone;
    if (patch.label !== undefined) upd.label = patch.label;
    if (patch.rowLimit !== undefined) upd.row_limit = patch.rowLimit;
    if (patch.timeoutS !== undefined) upd.timeout_s = patch.timeoutS;
    if (patch.tls !== undefined) upd.tls = patch.tls;
    // A new endpoint is a different server: its health is unknown until tested.
    if (patch.endpoint !== undefined && patch.endpoint !== c.endpoint) Object.assign(upd, { health: 'unknown', health_detail: null });
    await this.db('data_connections').where({ id: c.id }).update(upd);
    return this.get(p.tenantId, id);
  }

  async setCredential(p: Principal, id: string, username: string, password: string): Promise<ConnectionRow> {
    const c = await this.get(p.tenantId, id);
    await this.db('data_connections').where({ id: c.id }).update({ credential: await this.sealCredential(c.tenant_id, c.id, username, password), account: username, credential_source: 'static', bao_role: null, version: c.version + 1, updated_at: Date.now(), health: 'unknown' });
    await this.dynamic?.forget(c.id);
    return this.get(p.tenantId, id);
  }

  /** Switches a connection to OpenBao dynamic credentials for `role`; the static credential is dropped. */
  async setDynamicRole(p: Principal, id: string, role: string): Promise<ConnectionRow> {
    const c = await this.get(p.tenantId, id);
    if (!this.dynamic) throw conflict('OpenBao dynamic credentials need OPENBAO_ADDR and OPENBAO_TOKEN on the server.');
    if (c.engine === 'opensearch') throw conflict('OpenBao dynamic credentials are for PostgreSQL and MySQL connections.');
    await this.db('data_connections').where({ id: c.id }).update({ credential: null, account: null, credential_source: 'openbao', bao_role: role, version: c.version + 1, updated_at: Date.now(), health: 'unknown' });
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
    await this.db('data_connections').where({ id: c.id }).delete();
    await this.dynamic?.forget(c.id);
  }

  private async spec(c: ConnectionRow): Promise<ConnectionSpec> {
    if (c.credential_source === 'openbao') {
      if (!this.dynamic || !c.bao_role) throw conflict('This connection takes its credentials from OpenBao, which is not configured on this server (OPENBAO_ADDR, OPENBAO_TOKEN).');
      const d = await this.dynamic.get(c.bao_role, c.id);
      return { engine: c.engine, endpoint: c.endpoint, database: c.database, tls: c.tls, username: d.username, password: d.password };
    }
    const cred = c.credential ? json<{ username: string; password: string }>(await this.keys.open(c.tenant_id, c.credential, `connection:${c.id}`), { username: '', password: '' }) : null;
    return { engine: c.engine, endpoint: c.endpoint, database: c.database, tls: c.tls, username: cred?.username ?? null, password: cred?.password ?? null };
  }

  /** B-907: the secrets of the last spec built per connection, masked out of driver messages. */
  private readonly secretsOf = new Map<string, string[]>();

  private async driver(c: ConnectionRow) {
    const make = this.drivers[c.engine];
    if (!make) throw conflict(`The ${c.engine} engine is not installed on this platform.`);
    const spec = await this.spec(c);
    this.secretsOf.set(c.id, spec.password ? [spec.password] : []);
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
    const cl = c.engine === 'postgres' ? classifySql(input.query) : c.engine === 'mysql' ? classifyMysql(input.query) : classifyOpenSearch(input.query, input.object ?? null);
    if (cl.kind === 'read' || cl.kind === 'unparsed') {
      const bad = cl.objects.find((o) => !allowed(c, o));
      if (bad) return { ...cl, kind: 'denied', denied: bad, reason: `${bad} is not on the schema allow-list for ${c.name}.` };
      if (cl.kind === 'read' && !cl.objects.length && c.engine !== 'opensearch') return { ...cl, kind: 'unparsed', reason: 'The query reads no table or view the parser could find.' };
    }
    return cl;
  }

  /** Masks PII columns of the objects read and any value the classifier recognises as personal data. */
  private mask(c: ConnectionRow, objects: string[], r: QueryResult): { rows: unknown[][]; masked: string[] } {
    const pii = piiColumns(c);
    const byColumn = r.columns.map((col) => PII_NAME.test(col) || objects.some((o) => pii.has(`${o}.${col}`.toLowerCase()) || pii.has(`public.${o}.${col}`.toLowerCase())));
    const masked = new Set<string>(r.columns.filter((_, i) => byColumn[i]));
    const rows = r.rows.map((row) =>
      row.map((v, i) => {
        if (v == null) return v;
        if (byColumn[i]) return maskValue(v);
        if (typeof v === 'string' && v.length >= 6) {
          const d = classifyText(v).detections;
          if (d.email || d.iban || d.payment_card || d.us_ssn || d.phone) {
            masked.add(r.columns[i]!);
            return maskValue(v);
          }
        }
        return v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : v;
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
    if (cl.kind === 'unparsed' && c.engine === 'opensearch') {
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
      const message = this.scrub(c, err);
      await record('connection.query.failed', { error: message.slice(0, 300) });
      throw new HttpProblem(502, 'Query failed', `${c.name}: ${message}`.slice(0, 500), { extensions: { kind: 'failed' } });
    }
    const ms = Date.now() - t;
    const m = this.mask(c, cl.objects, r);
    await record(cl.kind === 'unparsed' ? 'connection.query.unparsed' : 'connection.query', { rows: m.rows.length, capped: r.capped, ms, masked: m.masked });
    return { columns: r.columns, rows: m.rows, capped: r.capped, estimate: r.estimate, ms, masked: m.masked, label: c.label, unparsed: cl.kind === 'unparsed', verb: cl.verb };
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
  async readRows(tenantId: string, id: string, object: string, opts: { watermarkColumn: string | null; after: string | null; limit: number; rawColumn?: string | null }): Promise<{ columns: string[]; rows: unknown[][]; capped: boolean; label: Label; name: string; raw?: unknown[] }> {
    const c = await this.get(tenantId, id);
    if (c.engine !== 'postgres' && c.engine !== 'mysql') throw conflict('Only PostgreSQL and MySQL tables and views can be a knowledge source.');
    if (!allowed(c, object)) throw conflict(`${object} is not on the schema allow-list for ${c.name}.`);
    const r = await (await this.driver(c)).rows(object, { watermarkColumn: opts.watermarkColumn, after: opts.after, limit: opts.limit, timeoutMs: c.timeout_s * 1000 });
    const at = opts.rawColumn ? r.columns.indexOf(opts.rawColumn) : -1;
    const raw = at >= 0 ? r.rows.map((row) => row[at]) : undefined;
    const m = this.mask(c, [object], r);
    return { columns: r.columns, rows: m.rows, capped: r.capped, label: c.label, name: c.name, ...(raw ? { raw } : {}) };
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

  /** Drops a knowledge source's replication slot on its connection (when the source is removed). */
  async dropReplicationSlot(tenantId: string, id: string, slot: string): Promise<boolean> {
    const c = await this.get(tenantId, id);
    const d = await this.driver(c);
    return d.dropReplicationSlot ? d.dropReplicationSlot(slot, c.timeout_s * 1000) : false;
  }
}
