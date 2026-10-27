import { createHash } from 'node:crypto';
import { signV4 } from '../platform/blob.js';
import { guardedRequest, type GuardedRequest, type GuardedResponse } from '../platform/egress.js';
import { addressProblem, parseAllowList, type AllowList } from '../mcp/hosts.js';
import type { Classification } from './classify.js';
import type { DdlPlan } from './ddl.js';
import type { DescribeKind, DocumentDescription } from './ddl-edit-types.js';
import type { ConnectionSpec, DataDriver, QueryResult, SchemaObject, TestResult } from './drivers.js';
import type { NonSqlContext } from './nonsql.js';

/*
 * 1.9.99-final, Sprint 59 (B-10304): Amazon DynamoDB as a read-only data connection (open decision 15: read-only, as
 * SQL connections are). Two request forms run, nothing else:
 *
 *   Query        JSON: `{"Query": {"TableName": "orders", "KeyConditionExpression": "pk = :p", ...}}` (or the Query
 *                input itself, or only its expressions with a table picked in the schema tree). A Query always names
 *                the partition key, so it never reads the whole table.
 *   PartiQL      `SELECT ... FROM "orders" WHERE pk = ?` through ExecuteStatement, or JSON
 *                `{"ExecuteStatement": {"Statement": "...", "Parameters": [{"S": "x"}]}}`. A SELECT must have a WHERE,
 *                and when the table's keys are known from introspection, the WHERE must name the partition key with
 *                `=` or `IN`, so a statement DynamoDB would run as a full scan is refused.
 *
 * Refused by classification before anything reaches DynamoDB: every write (PartiQL INSERT, UPDATE, DELETE and UPSERT;
 * PutItem, UpdateItem, DeleteItem, BatchWriteItem, TransactWriteItems, BatchExecuteStatement, ExecuteTransaction), every
 * table or backup change (CreateTable, UpdateTable, DeleteTable, ...), Scan and ParallelScan, and every other
 * operation. The driver checks the operation again before it signs, and signs only `Query`, `ExecuteStatement`,
 * `ListTables`, `DescribeTable` and the schema sample's `Scan` (20 items, never a user's request) for reads.
 *
 * 2.0.x: a previewed schema plan (`applyDdl`) signs `CreateTable`, `UpdateTable` (a new global secondary index) and
 * `UpdateTimeToLive`, with the input the plan carries, on the connection's separate admin key only (it needs
 * dynamodb:CreateTable, dynamodb:UpdateTable, dynamodb:UpdateTimeToLive and dynamodb:DescribeTable). Before a TTL
 * change on a table it just created, the driver waits (DescribeTable) until the table is ACTIVE.
 *
 * 2.0.x editing: a plan may also sign `UpdateTable` to delete a global secondary index or change the billing mode and
 * capacity, and `DeleteTable`; the admin key then also needs dynamodb:DeleteTable. Between two changes of the same
 * table the driver waits until the table and its indexes are ACTIVE again (DynamoDB takes one change at a time).
 * `describe` reads a table back on the read key with `DescribeTable` and `DescribeTimeToLive`, so the read key's
 * policy needs dynamodb:DescribeTimeToLive too for the edit form to show the TTL attribute (without it, the table
 * is described without one).
 *
 * Requests are signed with SigV4 (`dynamodb`, the region from the endpoint or the `region` setting) and sent through
 * the outbound address guard (`guardedRequest`: resolved once, checked against the connection rules of
 * CONNECTIONS_ALLOWED_HOSTS, pinned, no redirects, capped; in tests a real AWS host is refused outright). The key is
 * the connection's sealed (or vault:) credential, or, for a connection made from a cloud account (B-10306), a
 * short-lived session from `s.cloud.credentials`.
 */

const TABLE = /^[A-Za-z0-9_.-]{3,255}$/;
const INDEX = /^[A-Za-z0-9_.-]{3,255}$/;
const TARGET = 'DynamoDB_20120810';

/** The checked request the driver sends. */
export type DynamoOp = { kind: 'query'; input: Record<string, unknown> } | { kind: 'statement'; statement: string; parameters?: unknown[] };

const WRITE_OPS = new Set(['PutItem', 'UpdateItem', 'DeleteItem', 'BatchWriteItem', 'TransactWriteItems', 'BatchExecuteStatement', 'ExecuteTransaction']);
const DDL_OPS = new Set([
  'CreateTable', 'UpdateTable', 'DeleteTable', 'UpdateTimeToLive', 'CreateGlobalTable', 'UpdateGlobalTable', 'UpdateGlobalTableSettings', 'CreateBackup', 'DeleteBackup', 'RestoreTableFromBackup',
  'RestoreTableToPointInTime', 'UpdateContinuousBackups', 'ImportTable', 'ExportTableToPointInTime', 'TagResource', 'UntagResource', 'PutResourcePolicy', 'DeleteResourcePolicy',
  'EnableKinesisStreamingDestination', 'DisableKinesisStreamingDestination', 'UpdateKinesisStreamingDestination', 'UpdateContributorInsights', 'UpdateTableReplicaAutoScaling'
]);
const SCAN_OPS = new Set(['Scan', 'ParallelScan']);
const OTHER_READS = new Set(['GetItem', 'BatchGetItem', 'TransactGetItems', 'DescribeTable', 'ListTables']);
const QUERY_KEYS = new Set(['TableName', 'IndexName', 'KeyConditionExpression', 'FilterExpression', 'ProjectionExpression', 'ExpressionAttributeNames', 'ExpressionAttributeValues', 'ScanIndexForward', 'Limit', 'ExclusiveStartKey', 'ConsistentRead', 'Select', 'ReturnConsumedCapacity']);
const SELECTS = new Set(['ALL_ATTRIBUTES', 'ALL_PROJECTED_ATTRIBUTES', 'SPECIFIC_ATTRIBUTES', 'COUNT']);
const PARTIQL_WRITES = new Set(['INSERT', 'UPDATE', 'DELETE', 'UPSERT', 'REPLACE', 'REMOVE', 'SET']);
const PARTIQL_DDL = new Set(['CREATE', 'DROP', 'ALTER']);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

interface Lexed {
  /** The text with strings and quoted names replaced by placeholders, comments removed. */
  bare: string;
  /** The quoted names (`"orders"`), in order, unquoted. */
  quoted: string[];
  /** Statements: more than one is refused. */
  statements: number;
}

/** PartiQL lexing: single-quoted strings, double-quoted names, `--` and block comments, `;`. */
function lex(text: string): Lexed | string {
  let bare = '';
  const quoted: string[] = [];
  let statements = 1;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "'") {
      let j = i + 1;
      while (j < text.length && !(text[j] === "'" && text[j + 1] !== "'")) j += text[j] === "'" ? 2 : 1;
      if (j >= text.length) return 'A string is not closed.';
      bare += " '' ";
      i = j + 1;
    } else if (ch === '"') {
      let j = i + 1;
      let name = '';
      while (j < text.length && !(text[j] === '"' && text[j + 1] !== '"')) {
        name += text[j] === '"' ? '"' : text[j];
        j += text[j] === '"' ? 2 : 1;
      }
      if (j >= text.length) return 'A quoted name is not closed.';
      bare += ` "${quoted.length}" `;
      quoted.push(name);
      i = j + 1;
    } else if (ch === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) return 'A comment is not closed.';
      i = end + 2;
    } else if (ch === ';') {
      if (text.slice(i + 1).trim().replace(/^(--[^\n]*\n?)*/, '').trim()) statements++;
      i++;
    } else {
      bare += ch;
      i++;
    }
  }
  return { bare, quoted, statements };
}

/** A FROM target: `"orders"`, `orders`, `"orders"."by-status"` or `orders.byStatus`. */
function fromTarget(bare: string, quoted: string[]): { table: string; index: string | null } | null {
  const m = /\bFROM\s+("(\d+)"|[A-Za-z_][A-Za-z0-9_.-]*)(?:\s*\.\s*("(\d+)"|[A-Za-z_][A-Za-z0-9_-]*))?/i.exec(bare);
  if (!m) return null;
  const name = (whole: string | undefined, idx: string | undefined) => (idx !== undefined ? quoted[Number(idx)]! : whole ?? '');
  let table = name(m[1], m[2]);
  let index = m[3] ? name(m[3], m[4]) : null;
  // An unquoted `orders.byStatus` is read as one word by the pattern above.
  if (!m[2] && !index && table.includes('.')) [table, index] = [table.slice(0, table.indexOf('.')), table.slice(table.indexOf('.') + 1)];
  return { table, index };
}

/** The partition key of a table (or `table.index`) as introspected: the column whose type ends `partition key`. */
function partitionKey(ctx: NonSqlContext | undefined, object: string): string | null {
  const o = ctx?.schema?.find((x) => x.name === object);
  return o?.columns.find((c) => /partition key/.test(c.type))?.name ?? null;
}

/** Classifies a PartiQL statement: SELECT with a WHERE (naming the partition key when it is known) runs. */
export function classifyPartiql(text: string, ctx?: NonSqlContext, parameters?: unknown[]): Classification {
  const l = lex(text.trim());
  if (typeof l === 'string') return { kind: 'unparsed', verb: null, objects: [], reason: l };
  if (l.statements > 1) return { kind: 'multiple', verb: null, objects: [], reason: 'Send one statement at a time.' };
  const verb = (/^\s*([A-Za-z]+)/.exec(l.bare)?.[1] ?? '').toUpperCase();
  const target = fromTarget(l.bare, l.quoted);
  const objects = target ? [target.table] : [];
  if (PARTIQL_WRITES.has(verb)) return { kind: 'write', verb, objects, reason: `${verb} writes items; DynamoDB connections are read-only.` };
  if (PARTIQL_DDL.has(verb)) return { kind: 'ddl', verb, objects, reason: `${verb} changes tables.` };
  if (verb === 'EXISTS') return { kind: 'denied', verb, objects, denied: 'EXISTS', reason: 'EXISTS is a transaction condition; only SELECT runs on a connection.' };
  if (verb !== 'SELECT') return { kind: 'unparsed', verb: verb || null, objects, reason: 'Write a PartiQL SELECT, or a Query as JSON: {"Query": {"TableName": "<table>", "KeyConditionExpression": "pk = :p", "ExpressionAttributeValues": {":p": {"S": "..."}}}}.' };
  if (!target || !TABLE.test(target.table) || (target.index && !INDEX.test(target.index))) return { kind: 'unparsed', verb, objects, reason: 'The SELECT names no table the parser could read (FROM "table" or FROM "table"."index").' };
  const where = /\bWHERE\b([\s\S]*)$/i.exec(l.bare)?.[1];
  if (!where || !where.trim()) return { kind: 'denied', verb, objects, denied: 'Scan', reason: 'A SELECT without WHERE scans the whole table, which DynamoDB connections never do. Name the partition key in WHERE (pk = ? or pk IN [...]), or send a Query.' };
  const pk = partitionKey(ctx, target.index ? `${target.table}.${target.index}` : target.table);
  if (pk) {
    // The key as written in the WHERE: plain or as one of the quoted names.
    const names = [pk, ...l.quoted.map((q, i) => (q === pk ? `"${i}"` : null)).filter((x): x is string => !!x)];
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\"]/g, '\\$&');
    const hit = names.some((n) => new RegExp(`(^|[^A-Za-z0-9_])${esc(n)}\\s*(=|\\bIN\\b)`, 'i').test(where));
    // OR with something that is not the key would widen to a scan: refused as well.
    if (!hit || /\bOR\b/i.test(where)) return { kind: 'denied', verb, objects, denied: 'Scan', reason: `DynamoDB would scan ${target.table} for this WHERE: it must name the partition key ${pk} with = or IN, and not widen it with OR.` };
  }
  return { kind: 'read', verb, objects, op: { kind: 'statement', statement: text.trim().replace(/;\s*$/, ''), ...(parameters ? { parameters } : {}) } satisfies DynamoOp };
}

/** Checks a Query input: known keys only, a table and a key condition, a Select DynamoDB reads. */
function checkQuery(input: Record<string, unknown>, object: string | null): Classification {
  const q: Record<string, unknown> = { ...input };
  if (q.TableName === undefined && object) q.TableName = object;
  const extra = Object.keys(q).find((k) => !QUERY_KEYS.has(k));
  if (extra) return { kind: 'unparsed', verb: 'Query', objects: typeof q.TableName === 'string' ? [q.TableName] : [], reason: `${extra} is not read: a Query takes ${[...QUERY_KEYS].join(', ')}.` };
  if (typeof q.TableName !== 'string' || !TABLE.test(q.TableName)) return { kind: 'unparsed', verb: 'Query', objects: [], reason: 'The Query names no table (TableName), and no table is picked in the schema tree.' };
  const objects = [q.TableName];
  if (q.IndexName !== undefined && (typeof q.IndexName !== 'string' || !INDEX.test(q.IndexName))) return { kind: 'unparsed', verb: 'Query', objects, reason: 'IndexName must be an index name.' };
  if (typeof q.KeyConditionExpression !== 'string' || !q.KeyConditionExpression.trim()) return { kind: 'unparsed', verb: 'Query', objects, reason: 'A Query needs a KeyConditionExpression on the partition key.' };
  for (const k of ['FilterExpression', 'ProjectionExpression'] as const) if (q[k] !== undefined && typeof q[k] !== 'string') return { kind: 'unparsed', verb: 'Query', objects, reason: `${k} must be text.` };
  for (const k of ['ExpressionAttributeNames', 'ExpressionAttributeValues', 'ExclusiveStartKey'] as const) if (q[k] !== undefined && !isObj(q[k])) return { kind: 'unparsed', verb: 'Query', objects, reason: `${k} must be an object.` };
  if (q.Limit !== undefined && !(Number.isInteger(q.Limit) && (q.Limit as number) > 0)) return { kind: 'unparsed', verb: 'Query', objects, reason: 'Limit must be a whole number above zero.' };
  if (q.Select !== undefined && !SELECTS.has(String(q.Select))) return { kind: 'unparsed', verb: 'Query', objects, reason: `Select is one of ${[...SELECTS].join(', ')}.` };
  return { kind: 'read', verb: 'Query', objects, op: { kind: 'query', input: q } satisfies DynamoOp };
}

/**
 * The DynamoDB classifier: a PartiQL statement, or JSON naming one operation (`{"Query": {...}}`,
 * `{"ExecuteStatement": {...}}`) or a Query input. Writes, table changes and scans are named and refused.
 */
export function classifyDynamo(text: string, object: string | null, ctx?: NonSqlContext): Classification {
  const t = text.trim();
  if (!t) return { kind: 'unparsed', verb: null, objects: [], reason: 'The request is empty.' };
  if (!t.startsWith('{')) return classifyPartiql(t, ctx);
  let q: unknown;
  try {
    q = JSON.parse(t);
  } catch {
    return { kind: 'unparsed', verb: null, objects: [], reason: 'The request is not JSON or PartiQL.' };
  }
  if (!isObj(q)) return { kind: 'unparsed', verb: null, objects: [], reason: 'The request must be a JSON object.' };
  const keys = Object.keys(q);
  const op = keys.length === 1 && /^[A-Z][A-Za-z]+$/.test(keys[0]!) && isObj(q[keys[0]!]) ? keys[0]! : null;
  if (op) {
    const body = q[op] as Record<string, unknown>;
    const table = typeof body.TableName === 'string' ? [body.TableName] : [];
    if (WRITE_OPS.has(op)) return { kind: 'write', verb: op, objects: table, reason: `${op} writes items; DynamoDB connections are read-only.` };
    if (DDL_OPS.has(op)) return { kind: 'ddl', verb: op, objects: table, reason: `${op} changes tables, backups or their settings.` };
    if (SCAN_OPS.has(op)) return { kind: 'denied', verb: op, objects: table, denied: op, reason: `${op} reads the whole table, which DynamoDB connections never do. Send a Query with a key condition, or a PartiQL SELECT whose WHERE names the partition key.` };
    if (op === 'Query') return checkQuery(body, object);
    if (op === 'ExecuteStatement') {
      if (typeof body.Statement !== 'string') return { kind: 'unparsed', verb: op, objects: [], reason: 'ExecuteStatement needs a Statement.' };
      const extra = Object.keys(body).find((k) => !['Statement', 'Parameters', 'ConsistentRead', 'Limit', 'NextToken'].includes(k));
      if (extra) return { kind: 'unparsed', verb: op, objects: [], reason: `${extra} is not read: ExecuteStatement takes Statement, Parameters, ConsistentRead, Limit.` };
      if (body.Parameters !== undefined && !Array.isArray(body.Parameters)) return { kind: 'unparsed', verb: op, objects: [], reason: 'Parameters must be a list of attribute values.' };
      return classifyPartiql(body.Statement, ctx, body.Parameters as unknown[] | undefined);
    }
    if (OTHER_READS.has(op)) return { kind: 'denied', verb: op, objects: table, denied: op, reason: `${op} is not run on a connection; send a Query (with a key condition) or a PartiQL SELECT.` };
    return { kind: 'denied', verb: op, objects: table, denied: op, reason: `${op} is not run on a connection: only Query and PartiQL SELECT are.` };
  }
  if ('KeyConditionExpression' in q || 'TableName' in q) return checkQuery(q, object);
  return { kind: 'unparsed', verb: null, objects: [], reason: 'Write {"Query": {"TableName": "<table>", "KeyConditionExpression": "pk = :p", ...}} or a PartiQL SELECT.' };
}

// ---------- values ----------

/** One DynamoDB attribute value as a plain value. */
export function unmarshall(v: unknown, depth = 0): unknown {
  if (!isObj(v) || depth > 50) return v ?? null;
  const [tag, x] = Object.entries(v)[0] ?? [];
  switch (tag) {
    case 'S':
      return x;
    case 'N': {
      const n = Number(x);
      return Number.isSafeInteger(n) || (!Number.isInteger(n) && Number.isFinite(n) && String(n) === x) ? n : String(x);
    }
    case 'BOOL':
      return !!x;
    case 'NULL':
      return null;
    case 'B':
      return `[binary ${Buffer.from(String(x), 'base64').length} bytes]`;
    case 'SS':
      return x;
    case 'NS':
      return (x as string[]).map((n) => unmarshall({ N: n }));
    case 'BS':
      return (x as string[]).map((b) => unmarshall({ B: b }));
    case 'L':
      return (x as unknown[]).map((e) => unmarshall(e, depth + 1));
    case 'M':
      return Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, e]) => [k, unmarshall(e, depth + 1)]));
    default:
      return null;
  }
}

const TAGS: Record<string, string> = { S: 'string', N: 'number', B: 'binary', BOOL: 'boolean', NULL: 'null', M: 'map', L: 'list', SS: 'string set', NS: 'number set', BS: 'binary set' };
const typeOf = (v: unknown): string => (isObj(v) ? (TAGS[Object.keys(v)[0] ?? ''] ?? 'unknown') : 'unknown');

// ---------- the driver ----------

/** How a request leaves (tests stand in a recorder); the default is the outbound address guard. */
export type GuardedSend = (r: GuardedRequest) => Promise<GuardedResponse>;

const sha256 = (b: string) => createHash('sha256').update(b).digest('hex');

/** The region of a DynamoDB endpoint: `dynamodb.<region>.amazonaws.com`, a VPC endpoint's, or the setting. */
export function dynamoRegion(endpoint: string, option?: unknown): string {
  if (typeof option === 'string' && option) return option;
  const host = endpoint.replace(/^[a-z]+:\/\//i, '').replace(/[:/].*$/, '').toLowerCase();
  return /(?:^|\.)dynamodb(?:-fips)?\.([a-z]{2}(?:-[a-z]+)+-\d)\.(?:vpce\.)?amazonaws\.com(?:\.cn)?$/.exec(host)?.[1] ?? 'us-east-1';
}

export class DynamoDriver implements DataDriver {
  private readonly base: URL;
  private readonly region: string;

  constructor(
    private readonly spec: ConnectionSpec,
    private readonly allow: AllowList = parseAllowList(''),
    private readonly send: GuardedSend = guardedRequest
  ) {
    const e = spec.endpoint.replace(/\/+$/, '');
    this.base = new URL(/^https?:\/\//.test(e) ? e : `${spec.tls ? 'https' : 'http'}://${e}`);
    this.region = dynamoRegion(spec.endpoint, spec.options?.region);
  }

  private async call<T = Record<string, unknown>>(action: string, body: Record<string, unknown>, timeoutMs: number): Promise<T> {
    if (!this.spec.username || !this.spec.password) throw new Error('A DynamoDB connection needs an access key (the account and secret), or a cloud account.');
    const payload = JSON.stringify(body);
    const url = new URL('/', this.base);
    const headers = signV4({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': `${TARGET}.${action}`, ...(this.spec.sessionToken ? { 'x-amz-security-token': this.spec.sessionToken } : {}) },
      payloadHash: sha256(payload),
      region: this.region,
      service: 'dynamodb',
      accessKeyId: this.spec.username,
      secretAccessKey: this.spec.password,
      date: new Date()
    });
    const res = await this.send({ method: 'POST', url, headers, body: payload, timeoutMs, maxBytes: 16 * 1024 * 1024, check: (address, host) => addressProblem(address, host, this.allow) });
    const text = res.body.toString('utf8');
    let data: Record<string, unknown> = {};
    try {
      data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      /* not JSON */
    }
    if (res.status !== 200) {
      const type = String(data.__type ?? res.headers['x-amzn-errortype'] ?? '').split('#').pop() || `HTTP ${res.status}`;
      throw new Error(`DynamoDB refused ${action} (${type}): ${String(data.message ?? data.Message ?? text.slice(0, 200))}`);
    }
    return data as T;
  }

  async test(timeoutMs: number): Promise<TestResult> {
    const r = await this.call<{ TableNames?: string[] }>('ListTables', { Limit: 1 }, timeoutMs);
    const local = !/amazonaws\.com(\.cn)?$/i.test(this.base.hostname);
    return {
      version: local ? `DynamoDB-compatible (${this.base.host})` : `Amazon DynamoDB (${this.region})`,
      readOnly: true,
      health: 'healthy',
      detail: `Reachable${r.TableNames?.length ? '' : '; no tables listed yet'}. Only Query and PartiQL SELECT are sent; give the key an IAM policy with dynamodb:Query, dynamodb:PartiQLSelect, dynamodb:DescribeTable and dynamodb:ListTables only.`
    };
  }

  async introspect(timeoutMs: number): Promise<SchemaObject[]> {
    const names: string[] = [];
    let start: string | undefined;
    do {
      const r = await this.call<{ TableNames?: string[]; LastEvaluatedTableName?: string }>('ListTables', { Limit: 100, ...(start ? { ExclusiveStartTableName: start } : {}) }, timeoutMs);
      names.push(...(r.TableNames ?? []));
      start = r.LastEvaluatedTableName;
    } while (start && names.length < 500);
    const out: SchemaObject[] = [];
    for (const [i, name] of names.sort().entries()) {
      if (i >= 200) {
        out.push({ name, kind: 'table', columns: [] });
        continue;
      }
      const d = await this.call<{ Table?: { AttributeDefinitions?: { AttributeName: string; AttributeType: string }[]; KeySchema?: { AttributeName: string; KeyType: string }[]; GlobalSecondaryIndexes?: { IndexName: string; KeySchema?: { AttributeName: string; KeyType: string }[] }[]; LocalSecondaryIndexes?: { IndexName: string; KeySchema?: { AttributeName: string; KeyType: string }[] }[] } }>('DescribeTable', { TableName: name }, timeoutMs).catch(() => ({ Table: undefined }));
      const defs = new Map((d.Table?.AttributeDefinitions ?? []).map((a) => [a.AttributeName, TAGS[a.AttributeType] ?? a.AttributeType]));
      const keyCols = (ks: { AttributeName: string; KeyType: string }[] = []) => ks.map((k) => ({ name: k.AttributeName, type: `${defs.get(k.AttributeName) ?? 'string'}, ${k.KeyType === 'HASH' ? 'partition key' : 'sort key'}` }));
      const columns = keyCols(d.Table?.KeySchema);
      // Attributes beyond the keys are sampled from the first items: DynamoDB keeps no schema for them.
      const sample = await this.call<{ Items?: Record<string, unknown>[] }>('Scan', { TableName: name, Limit: 20 }, timeoutMs).catch(() => ({ Items: [] }));
      for (const item of sample.Items ?? []) for (const [k, v] of Object.entries(item)) if (!columns.some((c) => c.name === k)) columns.push({ name: k, type: typeOf(v) });
      out.push({ name, kind: 'table', columns });
      for (const ix of [...(d.Table?.GlobalSecondaryIndexes ?? []), ...(d.Table?.LocalSecondaryIndexes ?? [])]) out.push({ name: `${name}.${ix.IndexName}`, kind: 'index', columns: keyCols(ix.KeySchema) });
    }
    return out;
  }

  async query(c: Classification, _text: string, opts: { limit: number; timeoutMs: number }): Promise<QueryResult> {
    const op = c.op as DynamoOp | undefined;
    // Checked again here: only a Query or a SELECT statement is ever signed.
    if (!op || (op.kind !== 'query' && op.kind !== 'statement')) throw new Error('The request was not classified as a DynamoDB read.');
    if (op.kind === 'statement' && classifyPartiql(op.statement).verb !== 'SELECT') throw new Error('Only a PartiQL SELECT is sent.');
    if (op.kind === 'query' && checkQuery(op.input, null).kind !== 'read') throw new Error('The Query is not a read.');
    const maxPages = Number(this.spec.options?.maxPages ?? 10);
    const consistent = this.spec.options?.consistentRead === 'on';
    // A smaller Limit of the query's own is kept; otherwise one more than the cap tells whether more exist.
    const own = op.kind === 'query' && typeof op.input.Limit === 'number' ? (op.input.Limit as number) : null;
    const want = own && own <= opts.limit ? own : opts.limit + 1;
    const items: Record<string, unknown>[] = [];
    let count = 0;
    let more = false;
    let next: unknown;
    const counting = op.kind === 'query' && op.input.Select === 'COUNT';
    for (let page = 0; page < maxPages; page++) {
      let r: { Items?: Record<string, unknown>[]; Count?: number; LastEvaluatedKey?: unknown; NextToken?: string };
      const left = Math.max(1, want - (counting ? 0 : items.length));
      if (op.kind === 'query') {
        const input = { ...(consistent && op.input.ConsistentRead === undefined && !op.input.IndexName ? { ConsistentRead: true } : {}), ...op.input, ...(counting && !own ? {} : { Limit: left }), ...(next ? { ExclusiveStartKey: next } : {}) };
        r = await this.call('Query', input, opts.timeoutMs);
        next = r.LastEvaluatedKey;
      } else {
        r = await this.call('ExecuteStatement', { Statement: op.statement, ...(op.parameters ? { Parameters: op.parameters } : {}), ...(consistent ? { ConsistentRead: true } : {}), Limit: left, ...(next ? { NextToken: next } : {}) }, opts.timeoutMs);
        next = r.NextToken;
      }
      count += Number(r.Count ?? r.Items?.length ?? 0);
      items.push(...(r.Items ?? []));
      if (!next || items.length >= want) break;
      if (page === maxPages - 1) more = true;
    }
    if (counting) return { columns: ['count'], rows: [[count]], capped: !!next, estimate: null };
    const capped = items.length > opts.limit || more || (!!next && items.length >= opts.limit);
    const kept = items.slice(0, opts.limit).map((it) => Object.fromEntries(Object.entries(it).map(([k, v]) => [k, unmarshall(v)])));
    const columns: string[] = [];
    for (const it of kept) for (const k of Object.keys(it)) if (!columns.includes(k)) columns.push(k);
    return { columns, rows: kept.map((it) => columns.map((k) => it[k] ?? null)), capped, estimate: null };
  }

  async rows(): Promise<QueryResult> {
    throw new Error('DynamoDB tables are not a knowledge source.');
  }

  /** 2.0.x: a schema plan's operations, signed as the reads are, on the admin key (see the header). */
  async applyDdl(plan: DdlPlan, timeoutMs: number): Promise<{ applied: number; detail?: string }> {
    const actions: Record<string, string> = { 'dynamodb.createTable': 'CreateTable', 'dynamodb.updateTable': 'UpdateTable', 'dynamodb.updateTimeToLive': 'UpdateTimeToLive', 'dynamodb.deleteTable': 'DeleteTable' };
    for (const op of plan.ops) if (!actions[op.op]) throw new Error(`DynamoDB connections do not perform ${op.op}.`);
    if (!plan.ops.length) throw new Error('The plan has no DynamoDB operations.');
    const deadline = Date.now() + timeoutMs;
    const created = new Set<string>();
    const changed = new Set<string>();
    let deleted = 0;
    let applied = 0;
    for (const op of plan.ops) {
      if (op.op !== 'dynamodb.createTable' && op.op !== 'dynamodb.updateTable' && op.op !== 'dynamodb.updateTimeToLive' && op.op !== 'dynamodb.deleteTable') continue;
      const table = String(op.input.TableName ?? '');
      try {
        if (!TABLE.test(table)) throw new Error(`${table || 'The table name'} is not a DynamoDB table name.`);
        if (op.op === 'dynamodb.deleteTable' && Object.keys(op.input).some((k) => k !== 'TableName')) throw new Error('DeleteTable takes only the table name.');
        // A table being created or changed takes no other change until it (and its indexes) are ACTIVE.
        if (created.has(table) || changed.has(table)) await this.waitActive(table, deadline, changed.has(table));
        await this.call(actions[op.op]!, op.input, Math.max(1000, deadline - Date.now()));
        if (op.op === 'dynamodb.createTable') created.add(table);
        else if (op.op === 'dynamodb.updateTable') changed.add(table);
        else if (op.op === 'dynamodb.deleteTable') {
          deleted++;
          created.delete(table);
          changed.delete(table);
        }
      } catch (err) {
        let msg = (err as Error).message;
        if (/ResourceNotFoundException/.test(msg)) msg = `The table ${table} does not exist. ${msg}`;
        else if (/ResourceInUseException/.test(msg)) msg = `The table ${table} is busy with another change (or, for CreateTable, already exists). ${msg}`;
        else if (/AccessDenied|UnrecognizedClient/.test(msg)) msg = `The admin key may not make this change (it needs dynamodb:${actions[op.op]}). ${msg}`;
        throw new Error(plan.ops.length > 1 ? `${msg} (${applied} of ${plan.ops.length} operations were applied before it.)` : msg, { cause: err });
      }
      applied++;
    }
    const notes = [
      ...(created.size ? ['DynamoDB creates the table in the background; it reads as CREATING until it is ACTIVE.'] : []),
      ...(changed.size ? ['DynamoDB applies table changes in the background; an index being removed reads as DELETING until it is gone.'] : []),
      ...(deleted ? ['DynamoDB deletes the table in the background; it reads as DELETING until it is gone.'] : [])
    ];
    return { applied, ...(notes.length ? { detail: notes.join(' ') } : {}) };
  }

  /**
   * 2.0.x editing: a table as the create form takes it (dynamoTableSpec): keys with their attribute types, billing,
   * capacity, global secondary indexes and the TTL attribute. DescribeTable and DescribeTimeToLive only; null when the
   * table does not exist.
   */
  async describe(object: string, kind: DescribeKind, timeoutMs: number): Promise<DocumentDescription | null> {
    if (kind !== 'table') throw new Error(`DynamoDB connections describe tables, not ${kind}.`);
    if (!TABLE.test(object)) throw new Error(`${object} is not a DynamoDB table name.`);
    type Keys = { AttributeName: string; KeyType: string }[];
    type Throughput = { ReadCapacityUnits?: number; WriteCapacityUnits?: number };
    let d: { Table?: { AttributeDefinitions?: { AttributeName: string; AttributeType: string }[]; KeySchema?: Keys; BillingModeSummary?: { BillingMode?: string }; ProvisionedThroughput?: Throughput; GlobalSecondaryIndexes?: { IndexName: string; KeySchema?: Keys; Projection?: { ProjectionType?: string; NonKeyAttributes?: string[] }; ProvisionedThroughput?: Throughput }[] } };
    try {
      d = await this.call('DescribeTable', { TableName: object }, timeoutMs);
    } catch (err) {
      if (/ResourceNotFoundException/.test((err as Error).message)) return null;
      throw err;
    }
    const t = d.Table;
    if (!t) return null;
    const types = new Map((t.AttributeDefinitions ?? []).map((a) => [a.AttributeName, a.AttributeType]));
    const key = (ks: Keys | undefined, type: 'HASH' | 'RANGE') => {
      const k = (ks ?? []).find((x) => x.KeyType === type);
      return k ? { name: k.AttributeName, type: types.get(k.AttributeName) ?? 'S' } : undefined;
    };
    // A table made on demand reports no BillingModeSummary on some versions (and DynamoDB Local): capacity 0 means on demand.
    const provisioned = t.BillingModeSummary?.BillingMode ? t.BillingModeSummary.BillingMode === 'PROVISIONED' : Number(t.ProvisionedThroughput?.ReadCapacityUnits ?? 0) > 0;
    const capacity = (p: Throughput | undefined) => (provisioned && p ? { ...(p.ReadCapacityUnits ? { readCapacity: p.ReadCapacityUnits } : {}), ...(p.WriteCapacityUnits ? { writeCapacity: p.WriteCapacityUnits } : {}) } : {});
    const indexes = (t.GlobalSecondaryIndexes ?? []).map((g) => {
      const sk = key(g.KeySchema, 'RANGE');
      return {
        name: g.IndexName,
        partitionKey: key(g.KeySchema, 'HASH'),
        ...(sk ? { sortKey: sk } : {}),
        projection: g.Projection?.ProjectionType ?? 'ALL',
        nonKeyAttributes: g.Projection?.NonKeyAttributes ?? [],
        ...capacity(g.ProvisionedThroughput)
      };
    });
    let ttl: string | undefined;
    try {
      const r = await this.call<{ TimeToLiveDescription?: { TimeToLiveStatus?: string; AttributeName?: string } }>('DescribeTimeToLive', { TableName: object }, timeoutMs);
      const s = r.TimeToLiveDescription;
      if (s?.AttributeName && (s.TimeToLiveStatus === 'ENABLED' || s.TimeToLiveStatus === 'ENABLING')) ttl = s.AttributeName;
    } catch {
      // The read key may lack dynamodb:DescribeTimeToLive: described without a TTL attribute.
    }
    const sk = key(t.KeySchema, 'RANGE');
    const definition: Record<string, unknown> = {
      name: object,
      partitionKey: key(t.KeySchema, 'HASH'),
      ...(sk ? { sortKey: sk } : {}),
      billingMode: provisioned ? 'PROVISIONED' : 'PAY_PER_REQUEST',
      ...capacity(t.ProvisionedThroughput),
      indexes,
      ...(ttl ? { ttlAttribute: ttl } : {})
    };
    return { kind: 'table', name: object, definition, indexes };
  }

  /** Until the table is ACTIVE (and, with `indexes`, no global secondary index is still CREATING, UPDATING or DELETING). */
  private async waitActive(table: string, deadline: number, indexes = false): Promise<void> {
    for (let wait = 250; ; wait = Math.min(wait * 2, 2000)) {
      const d = await this.call<{ Table?: { TableStatus?: string; GlobalSecondaryIndexes?: { IndexStatus?: string }[] } }>('DescribeTable', { TableName: table }, Math.max(1000, deadline - Date.now()));
      if (d.Table?.TableStatus === 'ACTIVE' && (!indexes || (d.Table.GlobalSecondaryIndexes ?? []).every((g) => !g.IndexStatus || g.IndexStatus === 'ACTIVE'))) return;
      if (Date.now() + wait > deadline) throw new Error(`The table ${table} is still ${d.Table?.TableStatus ?? 'not ACTIVE'}, so the changes that follow were not made.`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
