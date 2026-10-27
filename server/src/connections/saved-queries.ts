import { ulid } from 'ulid';
import { z } from 'zod';
import { actorFrom, type AuditActor } from '../audit/chain.js';
import { clears, highest, labelRank, LABELS, type Label } from '../authz/labels.js';
import { authorize, type Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import type { Classification } from './classify.js';
import { dialect, dialectOf } from './dialects.js';
import type { DialectId } from './engines.js';
import { bindParams, paramProblems, paramsSchema, sampleValue, type ParamDef } from './params.js';
import type { ConnectionRow } from './service.js';

/*
 * 1.8.0, Sprint 45 (B-125): saved, named, parameterised connection queries.
 *
 * - A query belongs to one data connection and carries a label at least the connection's. Its text is SQL with
 *   `:name` placeholders (PostgreSQL and MySQL), or the OpenSearch or MongoDB query JSON with `{"$param": "name"}`
 *   where a value goes. Parameters are typed (`connections/params.ts`) and always bound: SQL placeholders become the
 *   driver's own (`$1`, `?`), JSON placeholders are replaced by the typed value as a JSON value, so a parameter can never
 *   become query text. An `identifier` parameter (a column to sort by) only stands for one of the names its definition
 *   lists, quoted.
 * - It is classified when it is saved (`connections/classify.ts` through `ConnectionService.classify`, so the
 *   allow-list applies), with every identifier it may stand for. A query that writes is refused unless it is marked
 *   as a write query, which only a connections manager saves, and which does not run anywhere in this release
 *   (registered connections are read-only). DDL, several statements, objects outside the allow-list and syntax the
 *   parser cannot read are refused outright.
 * - Draft and published versions: the editor saves the draft against its revision; publishing classifies it again
 *   against the allow-list in force and snapshots it as the next version. Runs use the published version only.
 * - Every run (the read API, the tool `connections.query`, a workflow tool step, a knowledge source of kind
 *   `saved-query`, an app lookup) classifies the bound text again against the allow-list in force, passes the
 *   `db-query` guardrail with the parameter values, caps rows and time at the query's and the connection's limits,
 *   masks as the data browser does, and is audited (`connection.query.run`, `.run.refused`, `.run.failed`).
 */

const QUERY_NAME = /^[a-z][a-z0-9_-]{0,62}$/;
export const queryName = z.string().trim().regex(QUERY_NAME, 'lower-case letters, digits, _ and -, starting with a letter');
const objectName = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_.*$-]+$/);

export const queryDefinitionSchema = z
  .object({
    text: z.string().min(1).max(20_000),
    /** OpenSearch and MongoDB: the index or collection a bare JSON body goes to. */
    object: objectName.nullable().default(null),
    params: paramsSchema.default([]),
    rowLimit: z.number().int().min(1).max(10_000).default(500),
    timeoutS: z.number().int().min(1).max(300).default(10)
  })
  .strict();
export type QueryDefinition = z.infer<typeof queryDefinitionSchema>;

export const queryCreateSchema = z
  .object({
    name: queryName,
    title: z.string().trim().max(200).nullable().default(null),
    description: z.string().trim().max(1000).nullable().default(null),
    label: z.enum(LABELS).default('internal'),
    write: z.boolean().default(false),
    lookups: z.boolean().default(false),
    definition: queryDefinitionSchema
  })
  .strict();

export const queryUpdateSchema = z
  .object({
    rev: z.number().int().min(1).optional(),
    title: z.string().trim().max(200).nullable().optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    label: z.enum(LABELS).optional(),
    write: z.boolean().optional(),
    lookups: z.boolean().optional(),
    definition: queryDefinitionSchema.optional()
  })
  .strict();

export interface StoredClassification {
  kind: Classification['kind'];
  verb: string | null;
  objects: string[];
}

export interface QueryRow {
  id: string;
  tenant_id: string;
  connection_id: string;
  name: string;
  title: string | null;
  description: string | null;
  label: Label;
  write: boolean;
  lookups: boolean;
  draft: QueryDefinition;
  draft_classification: StoredClassification | null;
  draft_rev: number;
  published_version: number | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface VersionRow {
  id: string;
  query_id: string;
  version: number;
  definition: QueryDefinition;
  classification: StoredClassification;
  state: 'published' | 'retired';
  note: string | null;
  published_by: string | null;
  published_at: number;
}

const fromRow = (r: Record<string, unknown>): QueryRow => ({
  ...(r as unknown as QueryRow),
  label: r.label as Label,
  write: !!r.write,
  lookups: !!r.lookups,
  draft: queryDefinitionSchema.parse(json(r.draft, {})),
  draft_classification: json<StoredClassification | null>(r.draft_classification, null),
  draft_rev: Number(r.draft_rev),
  published_version: r.published_version == null ? null : Number(r.published_version),
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at)
});
const versionFrom = (r: Record<string, unknown>): VersionRow => ({
  ...(r as unknown as VersionRow),
  version: Number(r.version),
  definition: queryDefinitionSchema.parse(json(r.definition, {})),
  classification: json<StoredClassification>(r.classification, { kind: 'unparsed', verb: null, objects: [] }),
  published_at: Number(r.published_at)
});

export const queryView = (q: QueryRow, c: Pick<ConnectionRow, 'name' | 'engine' | 'label'> | null, versions?: VersionRow[]) => ({
  id: q.id,
  connectionId: q.connection_id,
  connection: c?.name ?? null,
  engine: c?.engine ?? null,
  name: q.name,
  title: q.title,
  description: q.description,
  label: q.label,
  write: q.write,
  lookups: q.lookups,
  draft: q.draft,
  draftClassification: q.draft_classification,
  draftRev: q.draft_rev,
  publishedVersion: q.published_version,
  dirty: versions ? !versions.some((v) => v.version === q.published_version && JSON.stringify(v.definition) === JSON.stringify(q.draft)) : undefined,
  params: (versions?.find((v) => v.version === q.published_version)?.definition ?? q.draft).params,
  ...(versions ? { versions: versions.map((v) => ({ version: v.version, state: v.state, note: v.note, publishedBy: v.published_by, publishedAt: v.published_at, classification: v.classification })) } : {}),
  createdAt: q.created_at,
  updatedAt: q.updated_at
});

// ---------- compiling placeholders ----------

type Piece = { lit: string } | { param: string };

/**
 * Splits SQL into literal text and `:name` placeholders, skipping strings, quoted identifiers, comments,
 * dollar-quoted text and `::` casts, as the dialect lexes them (1.9.0: every SQL dialect in dialects.ts). A `:word`
 * that names no parameter is refused, so a typo is not sent as text.
 */
export function sqlPieces(text: string, dialectId: DialectId, names: ReadonlySet<string>): { pieces: Piece[]; used: Set<string> } {
  const lex = dialect(dialectId).lex;
  const pieces: Piece[] = [];
  const used = new Set<string>();
  let lit = '';
  let i = 0;
  const s = text;
  const until = (end: string, from: number, backslash: boolean): number => {
    let j = from;
    while (j < s.length) {
      if (backslash && s[j] === '\\') j += 2;
      else if (s.startsWith(end, j)) {
        // A doubled quote is the quote itself.
        if (end.length === 1 && s[j + 1] === end) j += 2;
        else return j + end.length;
      } else j++;
    }
    return s.length;
  };
  const blockEnd = (from: number): number => {
    // Block comments nest in PostgreSQL, SQL Server and Snowflake; MySQL ends at the first */.
    let depth = 1;
    let j = from;
    while (j < s.length && depth) {
      if (dialectId !== 'mysql' && s.startsWith('/*', j)) {
        depth++;
        j += 2;
      } else if (s.startsWith('*/', j)) {
        depth--;
        j += 2;
      } else j++;
    }
    return j;
  };
  const wordBefore = (k: number) => /[A-Za-z0-9_]/.test(s[k - 1] ?? '');
  const Q_CLOSE: Record<string, string> = { '[': ']', '{': '}', '(': ')', '<': '>' };
  while (i < s.length) {
    const c = s[i]!;
    let j = -1;
    const ident = lex.idents.find(([open]) => open === c);
    if (lex.qQuote && (c === 'q' || c === 'Q' || ((c === 'n' || c === 'N') && (s[i + 1] === 'q' || s[i + 1] === 'Q'))) && !wordBefore(i)) {
      const at = c === 'n' || c === 'N' ? i + 1 : i;
      if (s[at + 1] === "'" && s[at + 2] && !/\s/.test(s[at + 2]!)) {
        const close = (Q_CLOSE[s[at + 2]!] ?? s[at + 2]!) + "'";
        const end = s.indexOf(close, at + 3);
        j = end < 0 ? s.length : end + 2;
      }
    }
    if (j >= 0) {
      // Oracle q'[…]' text
    } else if (lex.triple && lex.strings.includes(c) && s.startsWith(c.repeat(3), i)) j = until(c.repeat(3), i + 3, lex.backslash);
    else if (lex.strings.includes(c)) j = until(c, i + 1, lex.backslash);
    else if (lex.eStrings && (c === 'E' || c === 'e') && s[i + 1] === "'" && !wordBefore(i)) j = until("'", i + 2, true);
    else if (ident) j = until(ident[1], i + 1, false);
    else if (c === '-' && s[i + 1] === '-') j = s.indexOf('\n', i) < 0 ? s.length : s.indexOf('\n', i);
    else if (lex.lineComments.some((lc) => s.startsWith(lc, i))) j = s.indexOf('\n', i) < 0 ? s.length : s.indexOf('\n', i);
    else if (c === '/' && s[i + 1] === '*') j = blockEnd(i + 2);
    else if (c === '$' && lex.dollar && /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.test(s.slice(i))) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i))![0];
      const end = s.indexOf(tag, i + tag.length);
      j = end < 0 ? s.length : end + tag.length;
    } else if (c === ':' && s[i + 1] === ':') j = i + 2;
    else if (c === ':' && s[i + 1] === '=') j = i + 2;
    else if (c === ':' && /[a-z]/.test(s[i + 1] ?? '') && !wordBefore(i)) {
      const m = /^:([a-z][a-z0-9_]{0,62})/.exec(s.slice(i))!;
      if (/[A-Za-z0-9_]/.test(s[i + m[0].length] ?? '')) j = i + m[0].length;
      else {
        if (!names.has(m[1]!)) throw new HttpProblem(400, 'Invalid query', `The query uses :${m[1]}, which is not one of its parameters (a cast is written ::type).`);
        if (lit) pieces.push({ lit });
        lit = '';
        pieces.push({ param: m[1]! });
        used.add(m[1]!);
        i += m[0].length;
        continue;
      }
    }
    if (j < 0) {
      lit += c;
      i++;
    } else {
      lit += s.slice(i, j);
      i = j;
    }
  }
  if (lit) pieces.push({ lit });
  return { pieces, used };
}

/**
 * The text and the values to bind for one run of SQL pieces, in the dialect's placeholder style: `$n` (PostgreSQL)
 * and `@pn` (SQL Server) share one value between uses of a parameter, `?` (MySQL, Snowflake, BigQuery) and `:n`
 * (Oracle) take one per use. A list parameter is one value in PostgreSQL (an array) and one per item elsewhere.
 */
export function renderSql(pieces: Piece[], dialectId: DialectId, defs: readonly ParamDef[], values: Record<string, unknown>): { text: string; params: unknown[] } {
  const d = dialect(dialectId);
  const byName = new Map(defs.map((x) => [x.name, x]));
  const params: unknown[] = [];
  const shared = new Map<string, number>();
  let text = '';
  const one = (v: unknown): string => {
    params.push(v);
    return d.placeholder === 'colon' ? `:${params.length}` : d.placeholder === 'at' ? `@p${params.length}` : d.placeholder === 'dollar' ? `$${params.length}` : '?';
  };
  for (const p of pieces) {
    if ('lit' in p) {
      text += p.lit;
      continue;
    }
    const def = byName.get(p.param)!;
    const v = values[p.param];
    if (def.type === 'identifier') {
      if (typeof v !== 'string') throw new HttpProblem(400, 'Invalid parameters', `${p.param} is required: it names a column.`);
      text += d.quoteIdent(v);
    } else if (d.placeholder === 'dollar' || (d.placeholder === 'at' && !(def.type === 'list' && Array.isArray(v)))) {
      let n = shared.get(p.param);
      if (!n) {
        one(v ?? null);
        n = params.length;
        shared.set(p.param, n);
      }
      text += d.placeholder === 'dollar' ? `$${n}` : `@p${n}`;
    } else if (def.type === 'list' && Array.isArray(v)) {
      text += (v as unknown[]).map((x) => one(x)).join(', ');
    } else {
      text += one(v ?? null);
    }
  }
  return { text, params };
}

/** OpenSearch's optional `METHOD /path` line and the JSON after it. */
function splitJson(text: string): { head: string; body: string } {
  const m = /^\s*((?:GET|POST|PUT|DELETE|HEAD|PATCH)\s+\/\S*)\s*/i.exec(text);
  return m ? { head: m[1]!, body: text.slice(m[0].length) } : { head: '', body: text };
}

const isPlaceholder = (v: unknown): v is { $param: string } => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && typeof (v as { $param?: unknown }).$param === 'string';

/** The parameters a JSON query uses, or a 400 when it is not JSON or names one that is not defined. */
export function jsonParams(text: string, names: ReadonlySet<string>): Set<string> {
  const { body } = splitJson(text);
  let doc: unknown;
  try {
    doc = body.trim() ? JSON.parse(body) : {};
  } catch {
    throw new HttpProblem(400, 'Invalid query', 'The query is not JSON. Put {"$param": "<name>"} where a parameter value goes.');
  }
  const used = new Set<string>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > 60 || v == null || typeof v !== 'object') return;
    if (isPlaceholder(v)) {
      if (!names.has(v.$param)) throw new HttpProblem(400, 'Invalid query', `The query uses {"$param": "${v.$param.slice(0, 63)}"}, which is not one of its parameters.`);
      used.add(v.$param);
      return;
    }
    for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x, depth + 1);
  };
  walk(doc, 0);
  return used;
}

/** A JSON query with each placeholder replaced by its value as a JSON value (a value never becomes structure). */
export function renderJson(text: string, values: Record<string, unknown>): string {
  const { head, body } = splitJson(text);
  const doc = body.trim() ? (JSON.parse(body) as unknown) : null;
  const sub = (v: unknown, depth: number): unknown => {
    if (depth > 60 || v == null || typeof v !== 'object') return v;
    if (isPlaceholder(v)) return values[v.$param] ?? null;
    if (Array.isArray(v)) return v.map((x) => sub(x, depth + 1));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x, depth + 1)]));
  };
  const out = doc == null ? '' : JSON.stringify(sub(doc, 0));
  return head ? `${head}\n${out}` : out;
}

// ---------- results ----------

export interface ReadColumn {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'json' | 'null';
}

/** The read API every caller shares (B-125, B-126; charts and reports later): typed columns, rows as objects, paging. */
export interface ReadResult {
  columns: ReadColumn[];
  rows: Record<string, unknown>[];
  truncated: boolean;
  nextCursor?: string;
  label: Label;
  masked: string[];
  ms: number;
}

export function columnTypes(columns: string[], rows: unknown[][]): ReadColumn[] {
  return columns.map((name, i) => {
    const v = rows.map((r) => r[i]).find((x) => x != null);
    return { name, type: v == null ? 'null' : typeof v === 'number' || typeof v === 'bigint' ? 'number' : typeof v === 'boolean' ? 'boolean' : typeof v === 'object' ? 'json' : 'string' };
  });
}

export const asObjects = (columns: string[], rows: unknown[][]): Record<string, unknown>[] => rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, typeof r[i] === 'bigint' ? Number(r[i]) : r[i]])));

const encodeCursor = (o: Record<string, unknown>) => Buffer.from(JSON.stringify(o)).toString('base64url');
export function decodeCursor<T>(cursor: string | null | undefined): T | null {
  if (!cursor) return null;
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as T;
  } catch {
    throw new HttpProblem(400, 'Invalid request', 'The cursor is not one this server issued.');
  }
}

/** Who a run is for: a person (the read API, the tool, a workflow step) or a service on a person's or a design's behalf. */
export interface RunCaller {
  tenantId: string;
  principal: Principal | null;
  /** The highest label the result may carry (the label of the conversation, run, base or entity it goes to). */
  ceiling?: Label | null;
  via: string;
  ip?: string | null;
  traceId?: string | null;
}

export class SavedQueries {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  // ---------- design (connections:manage, checked by the routes) ----------

  async list(tenantId: string, connectionId?: string): Promise<QueryRow[]> {
    const q = this.db('connection_queries').where({ tenant_id: tenantId });
    if (connectionId) q.andWhere({ connection_id: connectionId });
    return ((await q.orderBy('name')) as Record<string, unknown>[]).map(fromRow);
  }

  /** A query by id or name. */
  async get(tenantId: string, ref: string): Promise<QueryRow> {
    const r = await this.db('connection_queries').where({ tenant_id: tenantId }).andWhere((w) => void w.where({ id: ref }).orWhere({ name: ref })).first();
    if (!r) throw notFound('Saved query');
    return fromRow(r);
  }

  async versions(q: Pick<QueryRow, 'id'>): Promise<VersionRow[]> {
    return ((await this.db('connection_query_versions').where({ query_id: q.id }).orderBy('version', 'desc')) as Record<string, unknown>[]).map(versionFrom);
  }

  async version(q: QueryRow, v: number): Promise<VersionRow> {
    const r = await this.db('connection_query_versions').where({ query_id: q.id, version: v }).first();
    if (!r) throw notFound('Version');
    return versionFrom(r);
  }

  async view(q: QueryRow) {
    const c = await this.s().connections.get(q.tenant_id, q.connection_id).catch(() => null);
    return queryView(q, c, await this.versions(q));
  }

  /**
   * Classifies a definition on its connection with sample values for every parameter, once per identifier it may
   * stand for, so whatever a caller later picks has been classified. Refuses anything but a read (or, for a write
   * query, a single write) on allow-listed objects.
   */
  classify(c: ConnectionRow, def: QueryDefinition, write: boolean): StoredClassification {
    const problems = paramProblems(def.params);
    if (problems.length) throw new HttpProblem(400, 'Invalid parameters', problems.join(' '));
    const names = new Set(def.params.map((p) => p.name));
    const sqlDialect = dialectOf(c.engine)?.id ?? null;
    const sql = !!sqlDialect;
    let used: Set<string>;
    let pieces: Piece[] = [];
    if (sql) ({ pieces, used } = sqlPieces(def.text, sqlDialect!, names));
    else {
      if (def.params.some((p) => p.type === 'identifier')) throw new HttpProblem(400, 'Invalid parameters', 'Identifier parameters are for SQL queries.');
      used = jsonParams(def.text, names);
    }
    const unused = def.params.filter((p) => !used.has(p.name)).map((p) => p.name);
    if (unused.length) throw new HttpProblem(400, 'Invalid parameters', `${unused.join(', ')} ${unused.length === 1 ? 'is' : 'are'} not used in the query.`);
    const base = Object.fromEntries(def.params.map((p) => [p.name, sampleValue(p)]));
    const variants: Record<string, unknown>[] = [base];
    for (const p of def.params.filter((x) => x.type === 'identifier')) for (const a of (p.allowed ?? []).slice(1)) variants.push({ ...base, [p.name]: a });
    const objects = new Set<string>();
    let first: Classification | null = null;
    for (const values of variants) {
      const text = sql ? renderSql(pieces, sqlDialect!, def.params, values).text : renderJson(def.text, values);
      const cl = this.s().connections.classify(c, { query: text, object: def.object });
      this.assertKind(c, cl, write);
      first ??= cl;
      cl.objects.forEach((o) => objects.add(o));
    }
    return { kind: first!.kind, verb: first!.verb, objects: [...objects] };
  }

  /** Read, or a write for a write query; anything else is refused with the parser's reason. */
  private assertKind(c: ConnectionRow, cl: Classification, write: boolean): void {
    const ext = { kind: cl.kind, verb: cl.verb, ...(cl.denied ? { object: cl.denied } : {}) };
    if (cl.kind === 'read' && !write) return;
    if (cl.kind === 'write' && write) return;
    if (cl.kind === 'read' && write) throw new HttpProblem(422, 'Not a write query', 'The query only reads. Save it without "write query".', { extensions: ext });
    if (cl.kind === 'write') throw new HttpProblem(422, 'Write refused', `The parser read a ${cl.verb ?? 'write'}. A saved query is read-only unless a connections manager marks it as a write query.`, { extensions: ext });
    if (cl.kind === 'ddl') throw new HttpProblem(422, 'DDL refused', `The parser read a ${cl.verb} statement. Schema changes are never saved or sent to ${c.name}.`, { extensions: ext });
    if (cl.kind === 'multiple') throw new HttpProblem(422, 'Several statements refused', 'A saved query is one statement.', { extensions: ext });
    if (cl.kind === 'denied') throw new HttpProblem(422, 'Object outside the allow-list', cl.reason ?? `${cl.denied} is not allowed.`, { extensions: ext });
    throw new HttpProblem(422, 'Parser could not read it', `${cl.reason ?? 'The parser could not read the query.'} A saved query must be one the parser reads, so it can be checked at every run.`, { extensions: { ...ext, kind: 'unparsed' } });
  }

  private checkLabel(p: Principal, c: ConnectionRow, label: Label): void {
    if (!clears(p.clearance, label)) throw forbidden(`Your clearance is ${p.clearance}; a ${label} query is above it.`, { step: 'clearance' });
    if (labelRank(label) < labelRank(c.label)) throw conflict(`${c.name} is labelled ${c.label}; a query on it is labelled at least that.`);
  }

  async create(p: Principal, connectionId: string, input: z.infer<typeof queryCreateSchema>, ctx: { ip?: string | null; traceId?: string | null } = {}): Promise<QueryRow> {
    const s = this.s();
    const c = await s.connections.get(p.tenantId, connectionId);
    if (!clears(p.clearance, c.label)) throw forbidden(`This connection is labelled ${c.label} and your clearance is ${p.clearance}.`, { step: 'clearance' });
    this.checkLabel(p, c, input.label);
    const cl = this.classify(c, input.definition, input.write);
    if (await this.db('connection_queries').where({ tenant_id: p.tenantId, name: input.name }).first('id')) throw conflict(`A saved query called ${input.name} exists.`);
    const id = ulid();
    const t = Date.now();
    await this.db('connection_queries').insert({ id, tenant_id: p.tenantId, connection_id: c.id, name: input.name, title: input.title, description: input.description, label: input.label, write: input.write, lookups: input.lookups && !input.write, draft: JSON.stringify(input.definition), draft_classification: JSON.stringify(cl), draft_rev: 1, published_version: null, created_by: p.userId, updated_by: p.userId, created_at: t, updated_at: t });
    await this.audit(p, 'connection.query.created', id, input.name, c, input.label, { write: input.write, lookups: input.lookups, kind: cl.kind, verb: cl.verb, objects: cl.objects, params: input.definition.params.map((x) => x.name) }, ctx);
    return this.get(p.tenantId, id);
  }

  async update(p: Principal, ref: string, input: z.infer<typeof queryUpdateSchema>, ctx: { ip?: string | null; traceId?: string | null } = {}): Promise<QueryRow> {
    const q = await this.readable(p, ref);
    const c = await this.s().connections.get(p.tenantId, q.connection_id);
    if (input.rev !== undefined && input.rev !== q.draft_rev) throw new HttpProblem(409, 'Changed meanwhile', `The draft is at revision ${q.draft_rev}; reload it before saving.`, { extensions: { rev: q.draft_rev } });
    const label = input.label ?? q.label;
    this.checkLabel(p, c, label);
    const write = input.write ?? q.write;
    const def = input.definition ?? q.draft;
    const cl = this.classify(c, def, write);
    const upd: Record<string, unknown> = { updated_by: p.userId, updated_at: Date.now(), draft_classification: JSON.stringify(cl) };
    if (input.title !== undefined) upd.title = input.title;
    if (input.description !== undefined) upd.description = input.description;
    if (input.label !== undefined) upd.label = input.label;
    if (input.write !== undefined) upd.write = input.write;
    if (input.lookups !== undefined || input.write !== undefined) upd.lookups = (input.lookups ?? q.lookups) && !write;
    if (input.definition) Object.assign(upd, { draft: JSON.stringify(input.definition), draft_rev: q.draft_rev + 1 });
    await this.db('connection_queries').where({ id: q.id }).update(upd);
    await this.audit(p, 'connection.query.updated', q.id, q.name, c, label, { changed: Object.keys(input).filter((k) => k !== 'rev'), write, kind: cl.kind, objects: cl.objects }, ctx);
    return this.get(p.tenantId, q.id);
  }

  async publish(p: Principal, ref: string, note: string | null, ctx: { ip?: string | null; traceId?: string | null } = {}): Promise<{ query: QueryRow; version: number }> {
    const q = await this.readable(p, ref);
    const c = await this.s().connections.get(p.tenantId, q.connection_id);
    let cl: StoredClassification;
    try {
      cl = this.classify(c, q.draft, q.write);
    } catch (err) {
      await this.audit(p, 'connection.query.publish.refused', q.id, q.name, c, q.label, { reason: (err as HttpProblem).detail ?? (err as Error).message }, ctx);
      throw err;
    }
    const last = (await this.versions(q))[0];
    if (last && last.version === q.published_version && JSON.stringify(last.definition) === JSON.stringify(q.draft)) throw conflict(`Version ${last.version} is the draft as it is; change the draft first.`);
    const version = (last?.version ?? 0) + 1;
    const t = Date.now();
    await this.db.transaction(async (trx) => {
      await trx('connection_query_versions').where({ query_id: q.id, state: 'published' }).update({ state: 'retired' });
      await trx('connection_query_versions').insert({ id: ulid(), tenant_id: q.tenant_id, query_id: q.id, version, definition: JSON.stringify(q.draft), classification: JSON.stringify(cl), state: 'published', note, published_by: p.userId, published_at: t });
      await trx('connection_queries').where({ id: q.id }).update({ published_version: version, draft_classification: JSON.stringify(cl), updated_by: p.userId, updated_at: t });
    });
    await this.audit(p, 'connection.query.published', q.id, q.name, c, q.label, { version, note, kind: cl.kind, objects: cl.objects }, ctx);
    return { query: await this.get(p.tenantId, q.id), version };
  }

  async remove(p: Principal, ref: string, ctx: { ip?: string | null; traceId?: string | null } = {}): Promise<void> {
    const q = await this.readable(p, ref);
    const used = await this.usedBy(q);
    if (used.length) throw new HttpProblem(409, 'Still in use', `${used.map((u) => u.name).join(', ')} still ${used.length === 1 ? 'reads' : 'read'} ${q.name}. Remove ${used.length === 1 ? 'it' : 'them'} first.`, { extensions: { usedBy: used } });
    await this.db.transaction(async (trx) => {
      await trx('connection_query_versions').where({ query_id: q.id }).delete();
      await trx('connection_queries').where({ id: q.id }).delete();
    });
    const c = await this.s().connections.get(p.tenantId, q.connection_id).catch(() => null);
    await this.audit(p, 'connection.query.removed', q.id, q.name, c, q.label, {}, ctx);
  }

  /** Knowledge sources that sync from a query (lookups read it by name at use and fail closed once it is gone). */
  async usedBy(q: Pick<QueryRow, 'id' | 'tenant_id'>): Promise<{ kind: string; id: string; name: string }[]> {
    const rows = (await this.db('knowledge_sources as s').join('knowledge_bases as b', 'b.id', 's.kb_id').where({ 's.tenant_id': q.tenant_id, 's.kind': 'saved-query' }).select('s.id', 's.config', 'b.name as kb')) as { id: string; config: string; kb: string }[];
    return rows.filter((r) => json<{ external?: { ref?: string } }>(r.config, {}).external?.ref === q.id).map((r) => ({ kind: 'knowledge-source', id: r.id, name: `knowledge base ${r.kb}` }));
  }

  /** A query the caller may see: its label within their clearance (otherwise it does not exist for them). */
  private async readable(p: Principal, ref: string): Promise<QueryRow> {
    const q = await this.get(p.tenantId, ref);
    if (!clears(p.clearance, q.label)) throw notFound('Saved query');
    return q;
  }

  async listFor(p: Principal, connectionId?: string): Promise<QueryRow[]> {
    return (await this.list(p.tenantId, connectionId)).filter((q) => clears(p.clearance, q.label));
  }

  private audit(p: Principal | null, action: string, id: string, name: string, c: Pick<ConnectionRow, 'id' | 'name'> | null, label: Label, detail: Record<string, unknown>, ctx: { ip?: string | null; traceId?: string | null; service?: string }) {
    const actor: AuditActor = p ? actorFrom(p, ctx.ip ?? null) : { service: ctx.service ?? 'connections.query' };
    return this.s().audit.append({ tenantId: p?.tenantId ?? (c as ConnectionRow | null)?.tenant_id ?? '', action, kind: p ? 'admin' : 'system', actor, target: { savedQuery: id, name, ...(c ? { connection: c.id, connectionName: c.name } : {}) }, label, detail, traceId: ctx.traceId ?? null });
  }

  // ---------- running ----------

  /**
   * B-129's entry point (Agent 2's import) and the read API: the published version, as `principal`, who needs
   * `connections:query` and clearance for the query's label. Rows as objects with typed columns; `cursor` pages on.
   */
  async run(principal: Principal, queryId: string, params: Record<string, unknown> | null | undefined, opts: { limit?: number; cursor?: string | null; ceiling?: Label | null; via?: string; ip?: string | null; traceId?: string | null } = {}): Promise<ReadResult> {
    const d = authorize(principal, 'connections:query', { tenantId: principal.tenantId });
    if (!d.allow) throw forbidden(`${principal.displayName} may not run saved queries: ${d.reason}.`, { step: d.step });
    const q = await this.get(principal.tenantId, queryId).catch(() => null);
    if (!q || !clears(principal.clearance, q.label)) throw notFound('Saved query');
    return this.execute({ tenantId: principal.tenantId, principal, ceiling: opts.ceiling ?? null, via: opts.via ?? 'api', ip: opts.ip ?? null, traceId: opts.traceId ?? null }, q, 'published', params, { limit: opts.limit, cursor: opts.cursor ?? null });
  }

  /** The test panel (connections:manage): the draft or a version, as the designer. */
  async test(p: Principal, ref: string, version: number | 'draft' | 'published', params: Record<string, unknown> | null | undefined, opts: { limit?: number; ip?: string | null; traceId?: string | null } = {}): Promise<ReadResult & { version: number | 'draft'; classification: StoredClassification }> {
    const q = await this.readable(p, ref);
    const out = await this.execute({ tenantId: p.tenantId, principal: p, via: 'test', ip: opts.ip ?? null, traceId: opts.traceId ?? null }, q, version, params, { limit: opts.limit, cursor: null });
    return out;
  }

  /**
   * A run on behalf of a design rather than a person (a knowledge source's sync): the same checks, with the result's
   * label held to `ceiling`. The design was checked against its author's rights when it was saved.
   */
  async runAsService(tenantId: string, queryId: string, params: Record<string, unknown> | null | undefined, opts: { ceiling: Label; via: string; limit?: number; cursor?: string | null; principal?: Principal | null }): Promise<ReadResult> {
    const q = await this.get(tenantId, queryId);
    return this.execute({ tenantId, principal: opts.principal ?? null, ceiling: opts.ceiling, via: opts.via }, q, 'published', params, { limit: opts.limit, cursor: opts.cursor ?? null });
  }

  async execute(caller: RunCaller, q: QueryRow, which: number | 'draft' | 'published', given: Record<string, unknown> | null | undefined, opts: { limit?: number | undefined; cursor: string | null }): Promise<ReadResult & { version: number | 'draft'; classification: StoredClassification }> {
    const s = this.s();
    const c = await s.connections.get(caller.tenantId, q.connection_id);
    const label = highest(q.label, c.label);
    const ctx = { ip: caller.ip ?? null, traceId: caller.traceId ?? null };
    let version: number | 'draft';
    let def: QueryDefinition;
    if (which === 'draft') {
      version = 'draft';
      def = q.draft;
    } else {
      const v = which === 'published' ? q.published_version : which;
      if (v == null) throw conflict(`${q.name} has no published version yet.`);
      const row = await this.version(q, v);
      version = row.version;
      def = row.definition;
    }
    const refuse = async (problem: HttpProblem, detail: Record<string, unknown> = {}) => {
      await this.audit(caller.principal, 'connection.query.run.refused', q.id, q.name, c, label, { via: caller.via, version, reason: (problem.detail ?? problem.title).slice(0, 300), ...detail }, { ...ctx, service: caller.via });
      return problem;
    };
    if (caller.principal && !clears(caller.principal.clearance, label)) throw await refuse(forbidden(`${q.name} reads ${label} data and your clearance is ${caller.principal.clearance}.`, { step: 'clearance' }));
    if (caller.ceiling && labelRank(label) > labelRank(caller.ceiling)) throw await refuse(forbidden(`Blocked by label ceiling: ${q.name} reads ${label} data, above the ${caller.ceiling} it is called from.`, { step: 'label' }));
    if (q.write) throw await refuse(new HttpProblem(409, 'Write query', `${q.name} is a write query. Registered connections are read-only in this release, so write queries are saved and reviewed but never run.`));
    const values = bindParams(def.params, given);
    const cursor = decodeCursor<{ o: number; q: string; v: number | 'draft' }>(opts.cursor);
    if (cursor && (cursor.q !== q.id || cursor.v !== version)) throw await refuse(conflict(`The cursor belongs to another query or version of ${q.name}; start from the first page.`));
    const limit = Math.max(1, Math.min(opts.limit ?? def.rowLimit, def.rowLimit, c.row_limit));
    const offset = cursor ? Math.max(0, Math.floor(cursor.o)) : 0;
    const sqlDialect = dialectOf(c.engine)?.id ?? null;
    const sql = !!sqlDialect;
    // The bound text, classified again against the allow-list in force (it may have narrowed since publishing).
    let text: string;
    let bound: unknown[] = [];
    if (sql) {
      const { pieces } = sqlPieces(def.text, sqlDialect!, new Set(def.params.map((p) => p.name)));
      ({ text, params: bound } = renderSql(pieces, sqlDialect!, def.params, values));
    } else text = renderJson(def.text, values);
    const cl = s.connections.classify(c, { query: text, object: def.object });
    try {
      this.assertKind(c, cl, false);
    } catch (err) {
      throw await refuse(err as HttpProblem, { kind: cl.kind });
    }
    const guard = await s.guardrails.check({ tenantId: caller.tenantId, workspaceId: caller.principal?.workspaceId ?? null, checkpoint: 'db-query', text: `${def.text}\n-- parameters: ${JSON.stringify(values)}`, label, ...(caller.principal ? { principal: caller.principal } : {}), source: { kind: 'saved-query', id: q.id }, meta: { engine: c.engine, kind: cl.kind, objects: cl.objects, savedQuery: q.name, via: caller.via } });
    if (guard.action === 'block' || guard.action === 'require-approval' || guard.action === 'redact') {
      // A redaction cannot be applied to a saved query and its bound values without changing what it means, so it refuses too.
      throw await refuse(new HttpProblem(403, 'Blocked by a guardrail', guard.reason ?? 'A guardrail rule refused this query.', { extensions: { step: 'guardrail', checkpoint: 'db-query' } }), { guard: guard.action });
    }
    let r: Awaited<ReturnType<typeof s.connections.runBound>>;
    try {
      r = await s.connections.runBound(c, cl, text, { params: bound, limit, offset: sql ? offset : 0, timeoutMs: def.timeoutS * 1000 });
    } catch (err) {
      const e = err instanceof HttpProblem ? err : new HttpProblem(502, 'Query failed', (err as Error).message.slice(0, 300));
      await this.audit(caller.principal, e.status < 500 ? 'connection.query.run.refused' : 'connection.query.run.failed', q.id, q.name, c, label, { via: caller.via, version, error: (e.detail ?? e.title).slice(0, 300) }, { ...ctx, service: caller.via });
      throw e;
    }
    await this.audit(caller.principal, 'connection.query.run', q.id, q.name, c, label, { via: caller.via, version, params: Object.keys(values), rows: r.rows.length, capped: r.capped, ms: r.ms, masked: r.masked, objects: cl.objects }, { ...ctx, service: caller.via });
    const next = r.capped && sql ? encodeCursor({ o: offset + r.rows.length, q: q.id, v: version }) : undefined;
    return { columns: columnTypes(r.columns, r.rows), rows: asObjects(r.columns, r.rows), truncated: r.capped, ...(next ? { nextCursor: next } : {}), label, masked: r.masked, ms: r.ms, version, classification: { kind: cl.kind, verb: cl.verb, objects: cl.objects } };
  }

  // ---------- app lookups ----------

  private readonly optionCache = new Map<string, { at: number; options: { value: string; label: string }[] }>();

  /**
   * Options for an app lookup field from a query column: only a published query marked for lookups, at most at the
   * entity's label and within the reader's clearance. It runs on behalf of the app, not of the reader's own
   * connections rights; results are kept 30 seconds per query and parameters in this process.
   */
  async lookupOptions(p: Principal | null, tenantId: string, ref: string, o: { valueColumn: string; labelColumn?: string | null; params?: Record<string, unknown> | null; ceiling: Label }): Promise<{ value: string; label: string }[]> {
    const q = await this.get(tenantId, ref).catch(() => null);
    if (!q || (p && !clears(p.clearance, q.label))) throw notFound('Saved query');
    if (!q.lookups) throw conflict(`${q.name} is not offered to app lookups; a connections manager turns that on.`);
    const key = `${tenantId}:${q.id}:${q.published_version}:${JSON.stringify(o)}`;
    const hit = this.optionCache.get(key);
    if (hit && Date.now() - hit.at < 30_000) return hit.options;
    const r = await this.execute({ tenantId, principal: p, ceiling: o.ceiling, via: 'lookup' }, q, 'published', o.params ?? {}, { limit: 500, cursor: null });
    if (!r.columns.some((c) => c.name === o.valueColumn)) throw conflict(`${q.name} has no column ${o.valueColumn}.`);
    const seen = new Set<string>();
    const options: { value: string; label: string }[] = [];
    for (const row of r.rows) {
      const v = row[o.valueColumn];
      if (v == null || seen.has(String(v))) continue;
      seen.add(String(v));
      const l = o.labelColumn ? row[o.labelColumn] : null;
      options.push({ value: String(v).slice(0, 500), label: String(l ?? v).slice(0, 500) });
    }
    if (this.optionCache.size > 500) this.optionCache.clear();
    this.optionCache.set(key, { at: Date.now(), options });
    return options;
  }
}
