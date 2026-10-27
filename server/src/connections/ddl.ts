import { createHash } from 'node:crypto';
import { z } from 'zod';
import { dialect, homeSchema, type NameContext } from './dialects.js';
import { BSON_TYPES, DYNAMO_KEY_TYPES, findType, OPENSEARCH_TYPES, renderType, stringLiteral, typesOf, type TypeChoice } from './ddl-types.js';
import { engineInfo, type DialectId, type Engine } from './engines.js';
import type { EditOp, ObjectDescription } from './ddl-edit-types.js';
import { buildEditPlan, isEditKind } from './ddl-edit.js';

/*
 * 2.0.x: schema changes through a connection (the Schema designer and Queues tabs).
 *
 * A change is never free text sent to the database: the console sends a structured definition (a table with typed
 * columns and constraints, an index, a stored procedure or function, a dataset or schema, a document collection, a
 * search index, a container, a stream consumer group, a queue, exchange or binding), `buildPlan` checks it against
 * the engine's rules and the vendor's types (ddl-types.ts), and writes the statements (SQL engines) or the API
 * operations (the rest). Names are plain identifiers, quoted in the dialect; literals are escaped by type; the few
 * places an expression is accepted (a column default, a CHECK, an index predicate) are scanned so they cannot end
 * the statement, open a comment or leave a string open. A routine's body is the one place free text goes, always
 * inside a construct it cannot leave: dollar quoting with a tag the body does not contain (PostgreSQL, Snowflake), a
 * quoted string (Snowflake fallback), the API's own field (BigQuery routines), or a statement that runs alone on a
 * connection without multi-statement support (MySQL, SQL Server, Oracle).
 *
 * The plan is what the preview shows and what apply runs; apply rebuilds it and compares `hash` with the one the
 * person saw, so what runs is what was reviewed. Plans run on the connection's admin account, never on the read-only
 * account (service.ts).
 */

export const DDL_KINDS = ['table', 'index', 'procedure', 'function', 'dataset', 'collection', 'search-index', 'container', 'stream-group', 'queue', 'exchange', 'binding'] as const;
/** What a plan does: one of the create kinds, or (2.0.x editing) an edit kind of ddl-edit-types.ts. */
export type DdlKind = (typeof DDL_KINDS)[number] | 'alter-table' | 'replace-index' | 'drop' | 'edit';

/** API operations for the engines that are not driven by SQL text (and BigQuery routines and datasets). */
export type AdminOp =
  | EditOp
  | { op: 'bigquery.insertDataset'; datasetId: string; location: string | null; description: string | null; defaultTableExpirationMs: number | null; ifNotExists: boolean }
  | { op: 'bigquery.insertRoutine'; datasetId: string; routineId: string; routineType: 'PROCEDURE' | 'SCALAR_FUNCTION'; language: 'SQL' | 'JAVASCRIPT'; arguments: { name: string; dataType: { typeKind: string }; mode?: 'IN' | 'OUT' | 'INOUT' }[]; returnType: { typeKind: string } | null; definitionBody: string; replace: boolean }
  | { op: 'mongo.createCollection'; name: string; options: Record<string, unknown> }
  | { op: 'mongo.createIndex'; collection: string; keys: Record<string, 1 | -1 | 'text' | '2dsphere' | 'hashed'>; options: Record<string, unknown> }
  | { op: 'opensearch.createIndex'; index: string; body: Record<string, unknown> }
  | { op: 'dynamodb.createTable'; input: Record<string, unknown> }
  | { op: 'dynamodb.updateTable'; input: Record<string, unknown> }
  | { op: 'dynamodb.updateTimeToLive'; input: Record<string, unknown> }
  | { op: 'cosmos.createDatabase'; id: string; throughput: number | null }
  | { op: 'cosmos.createContainer'; body: Record<string, unknown>; throughput: number | null }
  | { op: 'influx.createDatabase'; name: string; duration: string | null }
  | { op: 'redis.xgroupCreate'; key: string; group: string; id: string; mkstream: boolean }
  | { op: 'rabbit.declareQueue'; vhost: string; name: string; body: { durable: boolean; auto_delete: boolean; arguments: Record<string, unknown> } }
  | { op: 'rabbit.declareExchange'; vhost: string; name: string; body: { type: string; durable: boolean; auto_delete: boolean; internal: boolean; arguments: Record<string, unknown> } }
  | { op: 'rabbit.bind'; vhost: string; source: string; destination: string; destinationType: 'q' | 'e'; body: { routing_key: string; arguments: Record<string, unknown> } };

export interface DdlPlan {
  engine: Engine;
  kind: DdlKind;
  /** The object made, as it is named in the allow-list (`schema.table`, `vhost/queue`, a collection or key). */
  object: string;
  /** What runs (SQL engines), or a readable form of each operation (the rest). */
  statements: string[];
  /** The operations a non-SQL driver performs; empty for SQL text. */
  ops: AdminOp[];
  /** Every statement runs in one transaction (PostgreSQL, SQL Server, D1); otherwise each commits on its own. */
  transactional: boolean;
  /** Existing objects the change acts on; each must be on the connection's allow-list. */
  touches: string[];
  notes: string[];
  /** 2.0.x editing: the plan loses data (a drop, a narrowed type); apply needs `confirmName` typed back. */
  destructive: boolean;
  /** The name a destructive plan must be confirmed with (the object's name as the person knows it). */
  confirmName: string | null;
  /** sha256 of the statements and operations: apply refuses a plan that differs from the previewed one. */
  hash: string;
}

export class DdlProblem extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join(' '));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------------------------

const ident = z.string().trim().min(1).max(255);
/** A possibly qualified name (`schema.table`, `dataset.table`). */
const qualified = z.string().trim().min(1).max(520);
const typeChoice = z
  .object({
    type: z.string().trim().min(1).max(60),
    length: z.union([z.number().int(), z.literal('max')]).nullable().optional(),
    precision: z.number().int().nullable().optional(),
    scale: z.number().int().nullable().optional(),
    values: z.array(z.string().max(255)).max(1000).nullable().optional(),
    unsigned: z.boolean().optional(),
    array: z.boolean().optional()
  })
  .strict();
const defaultValue = z.union([z.object({ kind: z.literal('literal'), value: z.union([z.string().max(4000), z.number(), z.boolean(), z.null()]) }).strict(), z.object({ kind: z.literal('expression'), sql: z.string().trim().min(1).max(2000) }).strict()]);
const comment = z.string().max(1024).optional();

export const columnSpec = z
  .object({
    name: ident,
    type: typeChoice,
    nullable: z.boolean().default(true),
    default: defaultValue.nullable().optional(),
    identity: z.boolean().default(false),
    comment
  })
  .strict();

const fkAction = z.enum(['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT']);
export const foreignKeySpec = z.object({ name: ident.optional(), columns: z.array(ident).min(1).max(32), refTable: qualified, refColumns: z.array(ident).min(1).max(32), onDelete: fkAction.optional(), onUpdate: fkAction.optional() }).strict();

export const sqlTableSpec = z
  .object({
    kind: z.literal('table'),
    name: qualified,
    columns: z.array(columnSpec).min(1).max(1000),
    primaryKey: z.array(ident).max(32).default([]),
    uniques: z.array(z.object({ name: ident.optional(), columns: z.array(ident).min(1).max(32) }).strict()).max(64).default([]),
    foreignKeys: z.array(foreignKeySpec).max(64).default([]),
    checks: z.array(z.object({ name: ident.optional(), expression: z.string().trim().min(1).max(2000) }).strict()).max(64).default([]),
    ifNotExists: z.boolean().default(false),
    comment,
    /** Vendor table options: PostgreSQL `unlogged`; MySQL `engine`, `charset`, `collation`; Snowflake `transient`, `clusterBy`; BigQuery `partitionBy`, `partitionGranularity`, `clusterBy`, `expirationDays`; SQLite `strict`, `withoutRowid`. */
    options: z
      .object({
        unlogged: z.boolean().optional(),
        engine: z.enum(['InnoDB', 'MyISAM', 'MEMORY', 'ARCHIVE']).optional(),
        charset: z.string().regex(/^[a-z0-9_]{1,32}$/).optional(),
        collation: z.string().regex(/^[a-z0-9_]{1,64}$/).optional(),
        transient: z.boolean().optional(),
        clusterBy: z.array(ident).max(4).optional(),
        partitionBy: ident.optional(),
        partitionGranularity: z.enum(['HOUR', 'DAY', 'MONTH', 'YEAR']).optional(),
        expirationDays: z.number().min(0.01).max(36_500).optional(),
        strict: z.boolean().optional(),
        withoutRowid: z.boolean().optional()
      })
      .strict()
      .default({})
  })
  .strict();

export const sqlIndexSpec = z
  .object({
    kind: z.literal('index'),
    name: ident,
    table: qualified,
    columns: z.array(z.object({ name: ident, order: z.enum(['asc', 'desc']).optional() }).strict()).max(32).default([]),
    /** BigQuery search indexes: every column. */
    allColumns: z.boolean().default(false),
    unique: z.boolean().default(false),
    /** PostgreSQL btree, hash, gin, gist, brin, spgist; MySQL btree, hash, fulltext, spatial; SQL Server clustered, nonclustered; Oracle btree, bitmap; BigQuery search. */
    method: z.string().trim().toLowerCase().optional(),
    include: z.array(ident).max(32).default([]),
    where: z.string().trim().min(1).max(2000).optional(),
    concurrently: z.boolean().default(false),
    ifNotExists: z.boolean().default(false)
  })
  .strict();

const routineParam = z.object({ name: ident, type: typeChoice, mode: z.enum(['in', 'out', 'inout']).default('in') }).strict();

export const routineSpec = z
  .object({
    kind: z.enum(['procedure', 'function']),
    name: qualified,
    params: z.array(routineParam).max(100).default([]),
    /** A function's result type; a Snowflake procedure's too. */
    returns: typeChoice.optional(),
    /** PostgreSQL plpgsql or sql; Snowflake and BigQuery sql or javascript. Others: their one language. */
    language: z.enum(['sql', 'plpgsql', 'javascript']).optional(),
    body: z.string().min(1).max(100_000),
    orReplace: z.boolean().default(false),
    /** MySQL functions: DETERMINISTIC. */
    deterministic: z.boolean().default(false),
    /** PostgreSQL functions. */
    volatility: z.enum(['immutable', 'stable', 'volatile']).optional(),
    /** Snowflake procedures: run with the owner's or the caller's rights. */
    executeAs: z.enum(['owner', 'caller']).optional(),
    comment
  })
  .strict();

export const datasetSpec = z
  .object({
    kind: z.literal('dataset'),
    name: ident,
    ifNotExists: z.boolean().default(false),
    /** PostgreSQL and SQL Server: the owning role. */
    owner: ident.optional(),
    /** MySQL. */
    charset: z.string().regex(/^[a-z0-9_]{1,32}$/).optional(),
    collation: z.string().regex(/^[a-z0-9_]{1,64}$/).optional(),
    /** BigQuery. */
    location: z.string().regex(/^[A-Za-z0-9-]{2,40}$/).optional(),
    defaultTableExpirationDays: z.number().min(0.042).max(36_500).optional(),
    /** Snowflake. */
    managedAccess: z.boolean().optional(),
    retentionDays: z.number().int().min(0).max(90).optional(),
    /** InfluxDB 1.x retention, such as 30d or INF. */
    duration: z.string().regex(/^(INF|\d{1,6}[hdw])$/).optional(),
    /** Cosmos DB provisioned throughput (RU/s); serverless when absent. */
    throughput: z.number().int().min(400).max(1_000_000).optional(),
    comment
  })
  .strict();

const mongoField = z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_.]{0,199}$/, 'a field path: letters, digits, _ and dots, not starting with $');

export const mongoCollectionSpec = z
  .object({
    kind: z.literal('collection'),
    name: z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,119}$/, 'a collection name: letters, digits, _, - and dots'),
    fields: z.array(z.object({ name: mongoField, bsonType: z.enum(BSON_TYPES), required: z.boolean().default(false), description: z.string().max(500).optional() }).strict()).max(500).default([]),
    additionalProperties: z.boolean().default(true),
    validationLevel: z.enum(['off', 'strict', 'moderate']).default('strict'),
    validationAction: z.enum(['error', 'warn']).default('error'),
    capped: z.object({ size: z.number().int().min(4096).max(1e15), max: z.number().int().min(1).optional() }).strict().optional(),
    timeseries: z.object({ timeField: mongoField, metaField: mongoField.optional(), granularity: z.enum(['seconds', 'minutes', 'hours']).optional() }).strict().optional(),
    expireAfterSeconds: z.number().int().min(1).optional()
  })
  .strict();

export const mongoIndexSpec = z
  .object({
    kind: z.literal('index'),
    collection: z.string().trim().min(1).max(120),
    name: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,127}$/).optional(),
    keys: z.array(z.object({ field: mongoField, order: z.union([z.literal(1), z.literal(-1), z.enum(['text', '2dsphere', 'hashed'])]) }).strict()).min(1).max(32),
    unique: z.boolean().default(false),
    sparse: z.boolean().default(false),
    expireAfterSeconds: z.number().int().min(0).optional(),
    /** Equality and range filters only: `{"status": "open"}`, `{"qty": {"$gt": 0}}`. */
    partialFilter: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

export const searchIndexSpec = z
  .object({
    kind: z.literal('search-index'),
    name: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,254}$/, 'lower-case letters, digits, ., _ and -, not starting with ., _ or -'),
    shards: z.number().int().min(1).max(1024).default(1),
    replicas: z.number().int().min(0).max(10).default(1),
    dynamic: z.enum(['true', 'false', 'strict']).default('true'),
    fields: z.array(z.object({ name: z.string().trim().regex(/^[A-Za-z_@][A-Za-z0-9_.@-]{0,199}$/), type: z.enum(OPENSEARCH_TYPES), analyzer: z.enum(['standard', 'simple', 'whitespace', 'keyword', 'english', 'french', 'german', 'spanish']).optional(), format: z.string().max(200).regex(/^[A-Za-z0-9_|:./ '-]+$/).optional(), dimension: z.number().int().min(1).max(16_000).optional(), scalingFactor: z.number().positive().optional() }).strict()).max(1000).default([])
  })
  .strict();

const dynamoKey = z.object({ name: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,255}$/), type: z.enum(DYNAMO_KEY_TYPES) }).strict();
const dynamoName = z.string().trim().regex(/^[A-Za-z0-9_.-]{3,255}$/, '3 to 255 letters, digits, _, . and -');
const gsi = z
  .object({
    name: dynamoName,
    partitionKey: dynamoKey,
    sortKey: dynamoKey.optional(),
    projection: z.enum(['ALL', 'KEYS_ONLY', 'INCLUDE']).default('ALL'),
    nonKeyAttributes: z.array(z.string().regex(/^[A-Za-z0-9_.-]{1,255}$/)).max(100).default([]),
    readCapacity: z.number().int().min(1).optional(),
    writeCapacity: z.number().int().min(1).optional()
  })
  .strict();

export const dynamoTableSpec = z
  .object({
    kind: z.literal('table'),
    name: dynamoName,
    partitionKey: dynamoKey,
    sortKey: dynamoKey.optional(),
    billingMode: z.enum(['PAY_PER_REQUEST', 'PROVISIONED']).default('PAY_PER_REQUEST'),
    readCapacity: z.number().int().min(1).optional(),
    writeCapacity: z.number().int().min(1).optional(),
    indexes: z.array(gsi).max(20).default([]),
    ttlAttribute: z.string().regex(/^[A-Za-z0-9_.-]{1,255}$/).optional()
  })
  .strict();

export const dynamoIndexSpec = gsi.extend({ kind: z.literal('index'), table: dynamoName }).strict();

export const cosmosContainerSpec = z
  .object({
    kind: z.literal('container'),
    name: z.string().trim().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,254}$/),
    partitionKeyPaths: z.array(z.string().regex(/^(\/[A-Za-z0-9_]{1,100}){1,8}$/, 'a path such as /tenantId')).min(1).max(3),
    defaultTtl: z.number().int().min(-1).max(2_147_483_647).optional(),
    uniqueKeys: z.array(z.array(z.string().regex(/^(\/[A-Za-z0-9_]{1,100}){1,8}$/)).min(1).max(16)).max(10).default([]),
    excludedPaths: z.array(z.string().regex(/^(\/[A-Za-z0-9_*?]{1,100}){1,8}(\/\*|\/\?)?$|^\/"_etag"\/\?$/)).max(100).default([]),
    throughput: z.number().int().min(400).max(1_000_000).optional()
  })
  .strict();

const redisKey = z.string().min(1).max(512).regex(/^[^\s*?[\]]+$/, 'a key name: no spaces or glob characters');

export const streamGroupSpec = z
  .object({
    kind: z.literal('stream-group'),
    key: redisKey,
    group: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/),
    /** `$`: only new entries; `0`: the whole stream; or an entry id. */
    startId: z.string().regex(/^(\$|0|\d{1,20}-\d{1,20})$/).default('$'),
    mkstream: z.boolean().default(true)
  })
  .strict();

const rabbitName = z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9_.:@-][A-Za-z0-9_.:@/-]*$/, 'letters, digits, _, ., :, @, - and /');
const vhost = z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9_./:@-]+$/).optional();

export const rabbitQueueSpec = z
  .object({
    kind: z.literal('queue'),
    vhost,
    name: rabbitName,
    type: z.enum(['classic', 'quorum', 'stream']).default('quorum'),
    durable: z.boolean().default(true),
    autoDelete: z.boolean().default(false),
    arguments: z
      .object({
        messageTtl: z.number().int().min(0).max(2 ** 32 - 1).optional(),
        expires: z.number().int().min(1).max(2 ** 32 - 1).optional(),
        maxLength: z.number().int().min(0).optional(),
        maxLengthBytes: z.number().int().min(0).optional(),
        overflow: z.enum(['drop-head', 'reject-publish', 'reject-publish-dlx']).optional(),
        deadLetterExchange: z.string().max(255).regex(/^[A-Za-z0-9_.:@/-]*$/).optional(),
        deadLetterRoutingKey: z.string().max(255).optional(),
        deadLetterStrategy: z.enum(['at-most-once', 'at-least-once']).optional(),
        singleActiveConsumer: z.boolean().optional(),
        maxPriority: z.number().int().min(1).max(255).optional(),
        deliveryLimit: z.number().int().min(1).optional(),
        initialGroupSize: z.number().int().min(1).max(15).optional(),
        maxAge: z.string().regex(/^\d{1,6}(Y|M|D|h|m|s)$/).optional(),
        streamMaxSegmentSizeBytes: z.number().int().min(1).optional()
      })
      .strict()
      .default({})
  })
  .strict();

export const rabbitExchangeSpec = z
  .object({
    kind: z.literal('exchange'),
    vhost,
    name: rabbitName,
    type: z.enum(['direct', 'fanout', 'topic', 'headers']).default('direct'),
    durable: z.boolean().default(true),
    autoDelete: z.boolean().default(false),
    internal: z.boolean().default(false),
    alternateExchange: rabbitName.optional()
  })
  .strict();

export const rabbitBindingSpec = z
  .object({
    kind: z.literal('binding'),
    vhost,
    source: rabbitName,
    destination: rabbitName,
    destinationType: z.enum(['queue', 'exchange']).default('queue'),
    routingKey: z.string().max(255).default(''),
    arguments: z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/), z.union([z.string().max(255), z.number(), z.boolean()])).default({})
  })
  .strict();

// ---------------------------------------------------------------------------------------------------------------
// What each engine accepts
// ---------------------------------------------------------------------------------------------------------------

type Family = 'sql' | 'mongo' | 'opensearch' | 'dynamodb' | 'cosmos' | 'influx' | 'redis' | 'rabbitmq' | 'none';

const MONGO_ENGINES: Engine[] = ['mongodb', 'documentdb', 'cosmos-mongodb', 'do-mongodb'];

export function familyOf(engine: Engine): Family {
  if (engineInfo(engine).dialect) return 'sql';
  if (MONGO_ENGINES.includes(engine)) return 'mongo';
  switch (engine) {
    case 'opensearch':
      return 'opensearch';
    case 'dynamodb':
      return 'dynamodb';
    case 'cosmos-nosql':
      return 'cosmos';
    case 'influxdb':
      return 'influx';
    case 'redis':
      return 'redis';
    case 'rabbitmq':
      return 'rabbitmq';
    default:
      return 'none';
  }
}

/** The kinds of object the designer offers on an engine, with what each is called there. */
export function ddlKinds(engine: Engine): { kind: DdlKind; label: string }[] {
  const d = engineInfo(engine).dialect;
  switch (familyOf(engine)) {
    case 'sql': {
      const out: { kind: DdlKind; label: string }[] = [{ kind: 'table', label: 'Table' }];
      if (d !== 'snowflake') out.push({ kind: 'index', label: d === 'bigquery' ? 'Search index' : 'Index' });
      if (d !== 'sqlite') out.push({ kind: 'procedure', label: 'Stored procedure' }, { kind: 'function', label: 'Function' });
      if (d !== 'sqlite' && d !== 'oracle') out.push({ kind: 'dataset', label: d === 'bigquery' ? 'Dataset' : d === 'mysql' ? 'Database' : 'Schema' });
      return out;
    }
    case 'mongo':
      return [
        { kind: 'collection', label: 'Collection' },
        { kind: 'index', label: 'Index' }
      ];
    case 'opensearch':
      return [{ kind: 'search-index', label: 'Index' }];
    case 'dynamodb':
      return [
        { kind: 'table', label: 'Table' },
        { kind: 'index', label: 'Global secondary index' }
      ];
    case 'cosmos':
      return [
        { kind: 'container', label: 'Container' },
        { kind: 'dataset', label: 'Database' }
      ];
    case 'influx':
      return [{ kind: 'dataset', label: 'Database' }];
    case 'redis':
      return [{ kind: 'stream-group', label: 'Stream queue (consumer group)' }];
    case 'rabbitmq':
      return [
        { kind: 'queue', label: 'Queue' },
        { kind: 'exchange', label: 'Exchange' },
        { kind: 'binding', label: 'Binding' }
      ];
    default:
      return [];
  }
}

/** Language choices for routines per dialect (the first is the default). */
export function routineLanguages(d: DialectId): string[] {
  switch (d) {
    case 'postgres':
      return ['plpgsql', 'sql'];
    case 'snowflake':
    case 'bigquery':
      return ['sql', 'javascript'];
    case 'sqlite':
      return [];
    default:
      return ['sql'];
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Names and expressions
// ---------------------------------------------------------------------------------------------------------------

export const MAX_IDENT: Record<DialectId, number> = { postgres: 63, mysql: 64, tsql: 128, oracle: 128, snowflake: 255, bigquery: 300, sqlite: 128 };
const PLAIN: Record<DialectId, RegExp> = {
  postgres: /^[A-Za-z_][A-Za-z0-9_$]*$/,
  mysql: /^[A-Za-z_][A-Za-z0-9_$]*$/,
  tsql: /^[A-Za-z_@#][A-Za-z0-9_@#$]*$/,
  oracle: /^[A-Za-z][A-Za-z0-9_$#]*$/,
  snowflake: /^[A-Za-z_][A-Za-z0-9_$]*$/,
  bigquery: /^[A-Za-z_][A-Za-z0-9_]*$/,
  sqlite: /^[A-Za-z_][A-Za-z0-9_$]*$/
};

/** Folds a plain name the way the database folds an unquoted one, so the quoted name is the one people expect. */
export const fold = (d: DialectId, part: string): string => (d === 'oracle' || d === 'snowflake' ? part.toUpperCase() : d === 'postgres' ? part.toLowerCase() : part);

export class Names {
  readonly problems: string[] = [];
  constructor(
    readonly d: DialectId,
    readonly ctx: NameContext
  ) {}

  part(p: string, what: string): string {
    if (!PLAIN[this.d].test(p)) this.problems.push(`${what} ${JSON.stringify(p)} is not a plain name (letters, digits and _, starting with a letter${this.d === 'oracle' ? '' : ' or _'}).`);
    else if (p.length > MAX_IDENT[this.d]) this.problems.push(`${what} ${p} is longer than ${MAX_IDENT[this.d]} characters.`);
    return fold(this.d, p);
  }

  /** A column, parameter or constraint name, quoted. */
  one(p: string, what = 'The name'): string {
    return dialect(this.d).quoteIdent(this.part(p, what));
  }

  /** An object name with at most `parts` parts (BigQuery's tables need two), quoted; and its allow-list spelling. */
  object(name: string, what: string, opts: { parts?: number; needSchema?: boolean } = {}): { sql: string; list: string; parts: string[] } {
    const raw = name.split('.');
    const max = opts.parts ?? 2;
    if (raw.length > max || raw.some((x) => !x)) {
      this.problems.push(`${what} ${name} has too many parts; write ${max === 1 ? 'a plain name' : 'schema.name'}.`);
      return { sql: '', list: name, parts: raw };
    }
    if (opts.needSchema && raw.length < 2) this.problems.push(`${what} ${name} needs its ${this.d === 'bigquery' ? 'dataset' : 'schema'}: write ${this.d === 'bigquery' ? 'dataset' : 'schema'}.${name}.`);
    const parts = raw.map((p) => this.part(p, what));
    return { sql: parts.map((p) => dialect(this.d).quoteIdent(p)).join('.'), list: name, parts };
  }

  /** The schema an object lands in, for names of indexes in Oracle (indexes live in a schema). */
  schemaOf(parts: string[]): string | null {
    if (parts.length === 2) return parts[0]!;
    const h = homeSchema(this.ctx);
    return h ? fold(this.d, h) : null;
  }
}

/**
 * Checks an expression (a default, a CHECK, an index predicate) cannot leave its place: strings and quoted names
 * closed, brackets balanced, no statement terminator and no comment outside a string. Returns the problem or null.
 */
export function expressionProblem(d: DialectId, text: string): string | null {
  const lex = dialect(d).lex;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const two = text.slice(i, i + 2);
    if (lex.strings.includes(ch)) {
      const close = ch;
      i++;
      for (;;) {
        if (i >= text.length) return 'A string is not closed.';
        const c = text[i]!;
        if (lex.backslash && c === '\\') {
          i += 2;
          continue;
        }
        if (c === close) {
          if (text[i + 1] === close) {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      continue;
    }
    const id = lex.idents.find(([o]) => o === ch);
    if (id) {
      const end = text.indexOf(id[1], i + 1);
      if (end < 0) return 'A quoted name is not closed.';
      i = end;
      continue;
    }
    if (two === '--' || two === '/*' || two === '*/' || (lex.lineComments.includes('#') && ch === '#') || (lex.lineComments.includes('//') && two === '//')) return 'Comments are not accepted in an expression.';
    if (ch === '$' && (lex.dollar || d === 'postgres') && /^\$[A-Za-z_]*\$/.test(text.slice(i))) return 'Dollar quoting is not accepted in an expression.';
    if (ch === ';') return 'An expression cannot contain ; outside a string.';
    if (ch === '(') depth++;
    if (ch === ')' && --depth < 0) return 'A ) has no matching (.';
  }
  if (depth !== 0) return 'A ( is not closed.';
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------------------------------------------

export const TRANSACTIONAL: Record<DialectId, boolean> = { postgres: true, tsql: true, sqlite: true, mysql: false, oracle: false, snowflake: false, bigquery: false };

export function boolLiteral(d: DialectId, typeName: string, v: boolean): string {
  if (d === 'tsql' || d === 'sqlite' || (d === 'oracle' && typeName !== 'BOOLEAN')) return v ? '1' : '0';
  return v ? 'TRUE' : 'FALSE';
}

export function literalFor(d: DialectId, typeName: string, value: string | number | boolean | null, problems: string[], col: string): string {
  if (value === null) return 'NULL';
  const vt = findType(d, typeName);
  const group = vt?.group ?? 'other';
  if (group === 'boolean') {
    if (typeof value === 'boolean') return boolLiteral(d, vt!.name, value);
    if (value === 0 || value === 1) return boolLiteral(d, vt!.name, value === 1);
    problems.push(`The default of ${col} must be true or false.`);
    return 'NULL';
  }
  if (group === 'integer' || group === 'decimal' || group === 'float') {
    const s = typeof value === 'number' ? String(value) : String(value).trim();
    if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s) || (group === 'integer' && !/^-?\d+$/.test(s))) {
      problems.push(`The default of ${col} must be a ${group === 'integer' ? 'whole number' : 'number'}.`);
      return 'NULL';
    }
    return s;
  }
  const s = String(value);
  if (d === 'oracle' && (group === 'timestamp' || group === 'date')) {
    if (vt!.name === 'DATE' && /^\d{4}-\d{2}-\d{2}$/.test(s)) return `DATE ${stringLiteral(d, s)}`;
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?$/.test(s)) return `TIMESTAMP ${stringLiteral(d, s.replace('T', ' '))}`;
    problems.push(`The default of ${col} must be written YYYY-MM-DD or YYYY-MM-DD HH:MM:SS.`);
    return 'NULL';
  }
  if (d === 'bigquery' && (group === 'date' || group === 'timestamp' || group === 'time' || group === 'json' || group === 'binary')) {
    const kw = vt!.name === 'BYTES' ? 'B' : `${vt!.name} `;
    return vt!.name === 'BYTES' ? `${kw}${stringLiteral(d, s)}` : `${kw}${stringLiteral(d, s)}`;
  }
  const lit = stringLiteral(d, s);
  if (d === 'tsql' && vt && /^N(VAR)?CHAR$/.test(vt.name)) return `N${lit}`;
  return lit;
}

/** MySQL: TEXT, BLOB, JSON and spatial columns take a default only as an expression in brackets (8.0.13). */
export const mysqlNeedsExprDefault = (typeName: string) => /^(TINY|MEDIUM|LONG)?(TEXT|BLOB)$|^JSON$|^GEOMETRY$|^POINT$/.test(typeName.toUpperCase());

export function identityClause(d: DialectId): string | null {
  switch (d) {
    case 'postgres':
    case 'oracle':
      return 'GENERATED BY DEFAULT AS IDENTITY';
    case 'mysql':
      return 'AUTO_INCREMENT';
    case 'tsql':
    case 'snowflake':
      return 'IDENTITY(1, 1)';
    default:
      return null;
  }
}

export const shortName = (prefix: string, table: string, cols: string[], max: number) => {
  const base = [prefix, table.split('.').pop(), ...cols].join('_').replace(/[^A-Za-z0-9_]/g, '_');
  if (base.length <= max) return base;
  const h = createHash('sha256').update(base).digest('hex').slice(0, 8);
  return `${base.slice(0, max - 9)}_${h}`;
};

/** A foreign key's clause after its CONSTRAINT name: FOREIGN KEY (…) REFERENCES … with the actions the dialect takes. */
export function foreignKeyClause(d: DialectId, fk: z.infer<typeof foreignKeySpec>, n: Names, notes: string[]): string {
  const P = n.problems;
  if (fk.columns.length !== fk.refColumns.length) P.push(`A foreign key on ${fk.columns.join(', ')} names ${fk.refColumns.length} referenced columns for ${fk.columns.length} columns.`);
  const ref = n.object(fk.refTable, 'The referenced table', { needSchema: d === 'bigquery' });
  let s = `FOREIGN KEY (${fk.columns.map((c) => n.one(c)).join(', ')}) REFERENCES ${ref.sql} (${fk.refColumns.map((c) => n.one(c)).join(', ')})`;
  if (d === 'bigquery') {
    if (fk.onDelete || fk.onUpdate) P.push('BigQuery foreign keys take no ON DELETE or ON UPDATE.');
    s += ' NOT ENFORCED';
  } else if (d === 'snowflake') {
    if (fk.onDelete || fk.onUpdate) notes.push('Snowflake keeps ON DELETE and ON UPDATE as metadata only.');
  }
  if (fk.onDelete && d !== 'bigquery') {
    if (d === 'oracle' && !['CASCADE', 'SET NULL', 'NO ACTION'].includes(fk.onDelete)) P.push(`Oracle takes ON DELETE CASCADE or SET NULL, not ${fk.onDelete}.`);
    else if (d === 'tsql' && fk.onDelete === 'RESTRICT') P.push('SQL Server has no RESTRICT; use NO ACTION.');
    else if (!(d === 'oracle' && fk.onDelete === 'NO ACTION')) s += ` ON DELETE ${fk.onDelete}`;
  }
  if (fk.onUpdate && d !== 'bigquery') {
    if (d === 'oracle') P.push('Oracle foreign keys take no ON UPDATE.');
    else if (d === 'tsql' && fk.onUpdate === 'RESTRICT') P.push('SQL Server has no RESTRICT; use NO ACTION.');
    else s += ` ON UPDATE ${fk.onUpdate}`;
  }
  return s;
}

export function buildSqlTable(d: DialectId, spec: z.infer<typeof sqlTableSpec>, n: Names, notes: string[]): { statements: string[]; touches: string[]; object: string } {
  const P = n.problems;
  const t = n.object(spec.name, 'The table', { needSchema: d === 'bigquery' });
  const colNames = new Set<string>();
  const defs: string[] = [];
  const after: string[] = [];
  let identities = 0;
  const lower = (s: string) => s.toLowerCase();
  const known = (c: string, where: string) => {
    if (!colNames.has(lower(c))) P.push(`${where} names ${c}, which is not a column of the table.`);
  };
  for (const col of spec.columns) {
    if (colNames.has(lower(col.name))) P.push(`The column ${col.name} is listed twice.`);
    colNames.add(lower(col.name));
  }
  const pk = spec.primaryKey;
  pk.forEach((c) => known(c, 'The primary key'));
  const sqliteRowid = d === 'sqlite' && spec.columns.some((c) => c.identity);
  for (const col of spec.columns) {
    const name = n.one(col.name, 'The column');
    const ty = renderType(d, col.type as TypeChoice);
    if ('problem' in ty) {
      P.push(`${col.name}: ${ty.problem}`);
      continue;
    }
    const vt = findType(d, col.type.type)!;
    let def = `${name} ${ty.text}`;
    if (col.identity) {
      identities++;
      if (!vt.identity) P.push(`${col.name}: a ${vt.name} column cannot be an identity column in ${d}.`);
      if (col.default) P.push(`${col.name}: an identity column takes no default.`);
      if (d === 'bigquery') P.push('BigQuery has no identity columns; use GENERATE_UUID() as a default instead.');
      else if (d === 'sqlite') {
        if (vt.name !== 'INTEGER' || pk.length > 1 || (pk.length === 1 && lower(pk[0]!) !== lower(col.name))) P.push(`${col.name}: in SQLite only a single-column INTEGER PRIMARY KEY auto-increments.`);
        def += ' PRIMARY KEY AUTOINCREMENT';
      } else {
        if (d === 'mysql' && !pk.map(lower).includes(lower(col.name))) P.push(`${col.name}: MySQL needs an AUTO_INCREMENT column in the primary key.`);
        def += ` ${identityClause(d)}`;
      }
    }
    if (!col.nullable || (col.identity && d !== 'sqlite')) def += ' NOT NULL';
    else if (d === 'tsql') def += ' NULL';
    if (col.default) {
      let v: string;
      if (col.default.kind === 'expression') {
        const bad = expressionProblem(d, col.default.sql);
        if (bad) P.push(`The default of ${col.name}: ${bad}`);
        v = d === 'sqlite' || (d === 'mysql' && mysqlNeedsExprDefault(vt.name)) ? `(${col.default.sql})` : col.default.sql;
      } else {
        v = literalFor(d, vt.name, col.default.value, P, col.name);
        if (d === 'mysql' && mysqlNeedsExprDefault(vt.name) && v !== 'NULL') v = `(${v})`;
      }
      // Oracle writes DEFAULT before NOT NULL; the others accept either order.
      def = d === 'oracle' ? def.replace(/ NOT NULL$/, '') + ` DEFAULT ${v}` + (!col.nullable ? ' NOT NULL' : '') : `${def} DEFAULT ${v}`;
    }
    if (col.comment) {
      if (d === 'mysql') def += ` COMMENT ${stringLiteral(d, col.comment)}`;
      else if (d === 'snowflake') def += ` COMMENT ${stringLiteral(d, col.comment)}`;
      else if (d === 'bigquery') def += ` OPTIONS(description=${stringLiteral(d, col.comment)})`;
      else if (d === 'postgres' || d === 'oracle') after.push(`COMMENT ON COLUMN ${t.sql}.${name} IS ${stringLiteral(d, col.comment)}`);
      else notes.push(`${d === 'tsql' ? 'SQL Server' : 'SQLite'} keeps no column comments here; ${col.name}'s comment is left out.`);
    }
    defs.push(def);
  }
  if (identities > 1) P.push('A table has at most one identity column.');
  const max = MAX_IDENT[d];
  const tableBase = t.parts[t.parts.length - 1] ?? 't';
  const constraint = (given: string | undefined, prefix: string, cols: string[]) => n.one(given ?? shortName(prefix, tableBase, cols, max), 'The constraint name');
  if (pk.length && !sqliteRowid) {
    defs.push(`${d === 'bigquery' ? '' : `CONSTRAINT ${constraint(undefined, 'pk', [])} `}PRIMARY KEY (${pk.map((c) => n.one(c)).join(', ')})${d === 'bigquery' ? ' NOT ENFORCED' : ''}`);
    if (d === 'snowflake') notes.push('Snowflake records primary, unique and foreign keys but does not enforce them (NOT NULL is enforced).');
  }
  for (const u of spec.uniques) {
    u.columns.forEach((c) => known(c, 'A unique constraint'));
    if (d === 'bigquery') P.push('BigQuery has no unique constraints.');
    else defs.push(`CONSTRAINT ${constraint(u.name, 'uq', u.columns)} UNIQUE (${u.columns.map((c) => n.one(c)).join(', ')})`);
  }
  const touches: string[] = [];
  for (const fk of spec.foreignKeys) {
    fk.columns.forEach((c) => known(c, 'A foreign key'));
    touches.push(fk.refTable);
    defs.push(`${d === 'bigquery' ? '' : `CONSTRAINT ${constraint(fk.name, 'fk', fk.columns)} `}${foreignKeyClause(d, fk, n, notes)}`);
  }
  for (const ck of spec.checks) {
    if (d === 'bigquery' || d === 'snowflake') {
      P.push(`${d === 'bigquery' ? 'BigQuery' : 'Snowflake'} has no CHECK constraints.`);
      continue;
    }
    const bad = expressionProblem(d, ck.expression);
    if (bad) P.push(`A CHECK constraint: ${bad}`);
    defs.push(`CONSTRAINT ${constraint(ck.name, 'ck', [String(spec.checks.indexOf(ck) + 1)])} CHECK (${ck.expression})`);
  }

  const o = spec.options;
  const only = (key: keyof typeof o, ds: DialectId[], label: string) => {
    if (o[key] !== undefined && !ds.includes(d)) P.push(`${label} is not a ${d} table option.`);
  };
  only('unlogged', ['postgres'], 'UNLOGGED');
  only('engine', ['mysql'], 'ENGINE');
  only('charset', ['mysql'], 'CHARACTER SET');
  only('collation', ['mysql'], 'COLLATE');
  only('transient', ['snowflake'], 'TRANSIENT');
  only('clusterBy', ['snowflake', 'bigquery'], 'CLUSTER BY');
  only('partitionBy', ['bigquery'], 'PARTITION BY');
  only('partitionGranularity', ['bigquery'], 'The partition granularity');
  only('expirationDays', ['bigquery'], 'The table expiration');
  only('strict', ['sqlite'], 'STRICT');
  only('withoutRowid', ['sqlite'], 'WITHOUT ROWID');
  for (const c of o.clusterBy ?? []) known(c, 'CLUSTER BY');
  if (o.partitionBy) known(o.partitionBy, 'PARTITION BY');
  if (spec.ifNotExists && (d === 'tsql' || d === 'oracle')) P.push(`${d === 'tsql' ? 'SQL Server' : 'Oracle before 23ai'} has no CREATE TABLE IF NOT EXISTS; leave it off.`);
  if (o.withoutRowid && !pk.length) P.push('A WITHOUT ROWID table needs a primary key.');

  const head = d === 'postgres' && o.unlogged ? 'CREATE UNLOGGED TABLE' : d === 'snowflake' && o.transient ? 'CREATE TRANSIENT TABLE' : 'CREATE TABLE';
  let sql = `${head}${spec.ifNotExists ? ' IF NOT EXISTS' : ''} ${t.sql} (\n  ${defs.join(',\n  ')}\n)`;
  const tail: string[] = [];
  if (d === 'mysql') {
    tail.push(`ENGINE=${o.engine ?? 'InnoDB'}`);
    if (o.charset) tail.push(`DEFAULT CHARSET=${o.charset}`);
    if (o.collation) tail.push(`COLLATE=${o.collation}`);
    if (spec.comment) tail.push(`COMMENT=${stringLiteral(d, spec.comment)}`);
  }
  if (d === 'sqlite') {
    if (o.withoutRowid) tail.push('WITHOUT ROWID');
    if (o.strict) tail.push('STRICT');
    if (spec.comment) notes.push('SQLite keeps no table comments; the comment is left out.');
  }
  if (d === 'snowflake') {
    if (o.clusterBy?.length) tail.push(`CLUSTER BY (${o.clusterBy.map((c) => n.one(c)).join(', ')})`);
    if (spec.comment) tail.push(`COMMENT = ${stringLiteral(d, spec.comment)}`);
  }
  if (d === 'bigquery') {
    if (o.partitionBy) {
      const col = spec.columns.find((c) => lower(c.name) === lower(o.partitionBy!));
      const ty = col ? findType(d, col.type.type)?.name : undefined;
      const g = o.partitionGranularity ?? 'DAY';
      if (ty === 'DATE') tail.push(g === 'DAY' ? `PARTITION BY ${n.one(o.partitionBy)}` : `PARTITION BY DATE_TRUNC(${n.one(o.partitionBy)}, ${g})`);
      else if (ty === 'TIMESTAMP' || ty === 'DATETIME') tail.push(`PARTITION BY ${ty}_TRUNC(${n.one(o.partitionBy)}, ${g})`);
      else if (col) P.push('BigQuery partitions by a DATE, TIMESTAMP or DATETIME column.');
    }
    if (o.clusterBy?.length) tail.push(`CLUSTER BY ${o.clusterBy.map((c) => n.one(c)).join(', ')}`);
    const opts: string[] = [];
    if (spec.comment) opts.push(`description=${stringLiteral(d, spec.comment)}`);
    if (o.expirationDays) opts.push(`expiration_timestamp=TIMESTAMP_ADD(CURRENT_TIMESTAMP(), INTERVAL ${Math.round(o.expirationDays * 24)} HOUR)`);
    if (opts.length) tail.push(`OPTIONS(${opts.join(', ')})`);
  }
  if (tail.length) sql += `\n${tail.join('\n')}`;
  const statements = [sql];
  if (spec.comment && (d === 'postgres' || d === 'oracle')) statements.push(`COMMENT ON TABLE ${t.sql} IS ${stringLiteral(d, spec.comment)}`);
  if (spec.comment && d === 'tsql') notes.push('SQL Server keeps comments as extended properties, which the designer does not write; the comment is left out.');
  statements.push(...after);
  return { statements, touches, object: spec.name };
}

const INDEX_METHODS: Record<DialectId, string[]> = {
  postgres: ['btree', 'hash', 'gin', 'gist', 'brin', 'spgist'],
  mysql: ['btree', 'hash', 'fulltext', 'spatial'],
  tsql: ['nonclustered', 'clustered'],
  oracle: ['btree', 'bitmap'],
  snowflake: [],
  bigquery: ['search'],
  sqlite: ['btree']
};

export const indexMethods = (d: DialectId): string[] => INDEX_METHODS[d];

export function buildSqlIndex(d: DialectId, spec: z.infer<typeof sqlIndexSpec>, n: Names, notes: string[]): { statements: string[]; touches: string[]; object: string; transactional?: boolean } {
  const P = n.problems;
  if (d === 'snowflake') P.push('Snowflake standard tables have no indexes; set a clustering key on the table instead.');
  const t = n.object(spec.table, 'The table', { needSchema: d === 'bigquery' });
  const method = spec.method ?? INDEX_METHODS[d][0];
  if (method && !INDEX_METHODS[d].includes(method)) P.push(`${d} indexes are ${INDEX_METHODS[d].join(', ')}, not ${method}.`);
  if (!spec.allColumns && !spec.columns.length) P.push('An index needs at least one column.');
  if (spec.allColumns && d !== 'bigquery') P.push('Only BigQuery search indexes cover every column.');
  const cols = spec.columns.map((c) => n.one(c.name, 'The column') + (c.order === 'desc' ? ' DESC' : c.order === 'asc' && d !== 'bigquery' ? ' ASC' : ''));
  if (spec.unique && (d === 'bigquery' || (d === 'postgres' && method !== 'btree') || (d === 'mysql' && (method === 'fulltext' || method === 'spatial')) || (d === 'oracle' && method === 'bitmap'))) P.push(`A ${method} index cannot be unique.`);
  if (spec.include.length && d !== 'postgres' && d !== 'tsql') P.push('INCLUDE columns are for PostgreSQL and SQL Server.');
  if (spec.where) {
    if (!['postgres', 'tsql', 'sqlite'].includes(d)) P.push('Partial (filtered) indexes are for PostgreSQL, SQL Server and SQLite.');
    const bad = expressionProblem(d, spec.where);
    if (bad) P.push(`The index predicate: ${bad}`);
  }
  if (spec.concurrently && d !== 'postgres') P.push('CONCURRENTLY is PostgreSQL only.');
  if (spec.ifNotExists && !['postgres', 'sqlite', 'bigquery'].includes(d)) P.push(`${d} has no CREATE INDEX IF NOT EXISTS; leave it off.`);
  const name = n.one(spec.name, 'The index name');
  const incl = spec.include.length ? ` INCLUDE (${spec.include.map((c) => n.one(c)).join(', ')})` : '';
  const where = spec.where ? ` WHERE ${spec.where}` : '';
  const ine = spec.ifNotExists ? ' IF NOT EXISTS' : '';
  let sql: string;
  switch (d) {
    case 'postgres':
      sql = `CREATE ${spec.unique ? 'UNIQUE ' : ''}INDEX${spec.concurrently ? ' CONCURRENTLY' : ''}${ine} ${name} ON ${t.sql}${method && method !== 'btree' ? ` USING ${method}` : ''} (${cols.join(', ')})${incl}${where}`;
      if (spec.concurrently) notes.push('CREATE INDEX CONCURRENTLY runs outside a transaction and does not lock writes.');
      break;
    case 'mysql':
      sql = `CREATE ${spec.unique ? 'UNIQUE ' : method === 'fulltext' ? 'FULLTEXT ' : method === 'spatial' ? 'SPATIAL ' : ''}INDEX ${name} ON ${t.sql} (${cols.join(', ')})${method === 'hash' ? ' USING HASH' : ''}`;
      if (method === 'hash') notes.push('InnoDB builds a B-tree whatever USING says; HASH applies to MEMORY tables.');
      break;
    case 'tsql':
      sql = `CREATE ${spec.unique ? 'UNIQUE ' : ''}${method === 'clustered' ? 'CLUSTERED' : 'NONCLUSTERED'} INDEX ${name} ON ${t.sql} (${cols.join(', ')})${incl}${where}`;
      break;
    case 'oracle': {
      const schema = n.schemaOf(t.parts);
      sql = `CREATE ${spec.unique ? 'UNIQUE ' : method === 'bitmap' ? 'BITMAP ' : ''}INDEX ${schema ? `${dialect(d).quoteIdent(schema)}.` : ''}${name} ON ${t.sql} (${cols.join(', ')})`;
      break;
    }
    case 'bigquery':
      sql = `CREATE SEARCH INDEX${ine} ${name} ON ${t.sql} (${spec.allColumns ? 'ALL COLUMNS' : spec.columns.map((c) => n.one(c.name)).join(', ')})`;
      if (spec.columns.some((c) => c.order)) P.push('Search index columns take no order.');
      notes.push('A search index covers STRING and JSON columns; BigQuery builds it in the background.');
      break;
    default:
      sql = `CREATE ${spec.unique ? 'UNIQUE ' : ''}INDEX${ine} ${name} ON ${t.sql} (${cols.join(', ')})${where}`;
  }
  return { statements: [sql], touches: [spec.table], object: `${spec.table}:${spec.name}`, ...(spec.concurrently ? { transactional: false } : {}) };
}

/** A dollar-quote tag the body does not contain. */
function dollarTag(body: string): string {
  for (let i = 0; ; i++) {
    const tag = i === 0 ? '$exprsn$' : `$exprsn${i}$`;
    if (!body.includes(tag)) return tag;
  }
}

export function buildRoutine(d: DialectId, spec: z.infer<typeof routineSpec>, n: Names, notes: string[], ctx: NameContext): { statements: string[]; ops: AdminOp[]; object: string } {
  const P = n.problems;
  const fn = spec.kind === 'function';
  const word = fn ? 'FUNCTION' : 'PROCEDURE';
  if (d === 'sqlite') P.push('SQLite has no stored procedures or functions.');
  const langs = routineLanguages(d);
  const lang = spec.language ?? langs[0];
  if (lang && !langs.includes(lang)) P.push(`${d} routines are written in ${langs.join(' or ')}, not ${lang}.`);
  const name = n.object(spec.name, `The ${spec.kind}`, { needSchema: d === 'bigquery' });
  const params = spec.params.map((p) => {
    const ty = renderType(d, p.type as TypeChoice, { forRoutine: true });
    if ('problem' in ty) P.push(`Parameter ${p.name}: ${ty.problem}`);
    if (p.mode !== 'in') {
      if (fn) P.push(`Function parameters are input only (${p.name} is ${p.mode.toUpperCase()}).`);
      else if (d === 'snowflake') P.push('Snowflake procedure parameters are input only.');
    }
    return { name: p.name, mode: p.mode, type: 'text' in ty ? ty.text : '', typeName: findType(d, p.type.type)?.name ?? p.type.type };
  });
  const seen = new Set<string>();
  for (const p of params) {
    if (seen.has(p.name.toLowerCase())) P.push(`The parameter ${p.name} is listed twice.`);
    seen.add(p.name.toLowerCase());
  }
  let returns: string | null = null;
  if (spec.returns) {
    const r = renderType(d, spec.returns as TypeChoice, { forRoutine: true });
    if ('problem' in r) P.push(`The result: ${r.problem}`);
    else returns = r.text;
  }
  const needsReturns = fn || d === 'snowflake';
  if (needsReturns && !returns) {
    if (d === 'snowflake' && !fn) returns = 'VARCHAR';
    else if (!(d === 'postgres' && fn)) P.push(`A ${spec.kind} needs a result type.`);
    else returns = 'void';
  }
  if (!needsReturns && spec.returns && d !== 'bigquery') P.push('A procedure has no result type; use OUT parameters.');
  if (spec.volatility && d !== 'postgres') P.push('Volatility is a PostgreSQL setting.');
  if (spec.executeAs && d !== 'snowflake') P.push('EXECUTE AS is a Snowflake setting.');
  if (spec.deterministic && !(d === 'mysql' && fn)) notes.push('DETERMINISTIC applies to MySQL functions only and is left out.');
  const body = spec.body.replace(/\r\n/g, '\n').trimEnd();
  const q = (p: string) => n.one(p, 'The parameter');
  const statements: string[] = [];
  const ops: AdminOp[] = [];
  const orReplace = spec.orReplace ? (d === 'tsql' ? ' OR ALTER' : ' OR REPLACE') : '';
  switch (d) {
    case 'postgres': {
      const tag = dollarTag(body);
      const ps = params.map((p) => `${p.mode === 'in' ? '' : `${p.mode.toUpperCase()} `}${q(p.name)} ${p.type}`).join(', ');
      statements.push(`CREATE${orReplace} ${word} ${name.sql}(${ps})${fn ? ` RETURNS ${returns}` : ''}\nLANGUAGE ${lang}${fn && spec.volatility ? ` ${spec.volatility.toUpperCase()}` : ''}\nAS ${tag}\n${body}\n${tag}`);
      break;
    }
    case 'mysql': {
      const ps = params.map((p) => `${fn ? '' : `${p.mode.toUpperCase()} `}${q(p.name)} ${p.type}`).join(', ');
      const wrapped = /^\s*BEGIN\b/i.test(body) ? body : `BEGIN\n${body}\nEND`;
      if (spec.orReplace) {
        // MySQL has no CREATE OR REPLACE for routines: the old one is dropped first (2.0.x editing).
        statements.push(`DROP ${word} IF EXISTS ${name.sql}`);
        notes.push(`MySQL has no CREATE OR REPLACE for routines: the old ${spec.kind} is dropped first, so it is briefly absent while the new one is created.`);
      }
      statements.push(`CREATE ${word} ${name.sql}(${ps})${fn ? ` RETURNS ${returns}\n${spec.deterministic ? 'DETERMINISTIC' : 'NOT DETERMINISTIC'} READS SQL DATA` : ''}\n${wrapped}`);
      if (fn) notes.push('With binary logging on, MySQL refuses functions that are not DETERMINISTIC or READS SQL DATA unless log_bin_trust_function_creators is set.');
      break;
    }
    case 'tsql': {
      const ps = params.map((p) => `@${n.part(p.name, 'The parameter')} ${p.type}${p.mode !== 'in' ? ' OUTPUT' : ''}`);
      if (fn) statements.push(`CREATE${orReplace} FUNCTION ${name.sql}(${ps.join(', ')})\nRETURNS ${returns}\nAS\nBEGIN\n${body}\nEND`);
      else statements.push(`CREATE${orReplace} PROCEDURE ${name.sql}${ps.length ? `\n  ${ps.join(',\n  ')}` : ''}\nAS\nBEGIN\n  SET NOCOUNT ON;\n${body}\nEND`);
      if (fn && !/\bRETURN\b/i.test(body)) P.push('A SQL Server function body must end with RETURN.');
      break;
    }
    case 'oracle': {
      const ps = params.map((p) => `${q(p.name)} ${p.mode === 'inout' ? 'IN OUT' : p.mode.toUpperCase()} ${p.type}`).join(', ');
      const wrapped = /\bBEGIN\b/i.test(body) ? body : `BEGIN\n${body}\nEND;`;
      statements.push(`CREATE${orReplace} ${word} ${name.sql}${ps ? ` (${ps})` : ''}${fn ? ` RETURN ${returns}` : ''}\nAS\n${wrapped}`);
      break;
    }
    case 'snowflake': {
      const ps = params.map((p) => `${q(p.name)} ${p.type}`).join(', ');
      const tagged = body.includes('$$') ? stringLiteral(d, body) : `$$\n${body}\n$$`;
      statements.push(`CREATE${orReplace} ${word} ${name.sql}(${ps})\nRETURNS ${returns}\nLANGUAGE ${lang === 'javascript' ? 'JAVASCRIPT' : 'SQL'}${!fn && spec.executeAs ? `\nEXECUTE AS ${spec.executeAs.toUpperCase()}` : ''}\nAS ${tagged}`);
      if (lang === 'javascript') notes.push('In JavaScript, Snowflake passes arguments in upper case (A, not a).');
      break;
    }
    case 'bigquery': {
      const ps = params.map((p) => `${!fn && p.mode !== 'in' ? `${p.mode.toUpperCase()} ` : ''}${q(p.name)} ${p.type}`).join(', ');
      const js = lang === 'javascript';
      if (!fn && js) P.push('BigQuery procedures are written in SQL.');
      if (fn) statements.push(`CREATE${orReplace} FUNCTION ${name.sql}(${ps})\nRETURNS ${returns}${js ? '\nLANGUAGE js\nAS r"""\n' + body + '\n"""' : `\nAS (\n${body}\n)`}`);
      else statements.push(`CREATE${orReplace} PROCEDURE ${name.sql}(${ps})\nBEGIN\n${body}\nEND`);
      ops.push({
        op: 'bigquery.insertRoutine',
        datasetId: name.parts[0] ?? '',
        routineId: name.parts[1] ?? '',
        routineType: fn ? 'SCALAR_FUNCTION' : 'PROCEDURE',
        language: js ? 'JAVASCRIPT' : 'SQL',
        arguments: params.map((p) => ({ name: p.name, dataType: { typeKind: p.typeName }, ...(fn ? {} : { mode: p.mode.toUpperCase() as 'IN' | 'OUT' | 'INOUT' }) })),
        returnType: fn && spec.returns ? { typeKind: findType(d, spec.returns.type)?.name ?? spec.returns.type } : null,
        // A procedure's body is its BEGIN … END block, as BigQuery reports one made by DDL; a function's is the expression.
        definitionBody: fn || /^\s*BEGIN\b/i.test(body) ? body : `BEGIN\n${body}\nEND`,
        replace: spec.orReplace
      });
      notes.push('Sent to BigQuery through its routines API; the body travels as a field, never inside other text.');
      break;
    }
    default:
      break;
  }
  void ctx;
  return { statements, ops, object: spec.name };
}

function buildDataset(engine: Engine, d: DialectId | null, spec: z.infer<typeof datasetSpec>, n: Names | null, notes: string[], problems: string[], ctx?: NameContext): { statements: string[]; ops: AdminOp[]; object: string } {
  const only = (key: keyof typeof spec, ok: boolean, label: string) => {
    if (spec[key] !== undefined && spec[key] !== false && !ok) problems.push(`${label} does not apply here.`);
  };
  only('owner', d === 'postgres' || d === 'tsql', 'An owner');
  only('charset', d === 'mysql', 'A character set');
  only('collation', d === 'mysql', 'A collation');
  only('location', d === 'bigquery', 'A location');
  only('defaultTableExpirationDays', d === 'bigquery', 'A default table expiration');
  only('managedAccess', d === 'snowflake', 'Managed access');
  only('retentionDays', d === 'snowflake', 'Time Travel retention');
  only('duration', engine === 'influxdb', 'A retention duration');
  only('throughput', engine === 'cosmos-nosql', 'Throughput');
  if (engine === 'cosmos-nosql') {
    if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,254}$/.test(spec.name)) problems.push('A Cosmos DB database id takes letters, digits, _, - and dots.');
    return { statements: [`POST /dbs {"id": ${JSON.stringify(spec.name)}}${spec.throughput ? ` x-ms-offer-throughput: ${spec.throughput}` : ''}`], ops: [{ op: 'cosmos.createDatabase', id: spec.name, throughput: spec.throughput ?? null }], object: spec.name };
  }
  if (engine === 'influxdb') {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(spec.name)) problems.push('An InfluxDB database name takes letters, digits, _, . and -.');
    return { statements: [`CREATE DATABASE "${spec.name}"${spec.duration ? ` WITH DURATION ${spec.duration}` : ''}`], ops: [{ op: 'influx.createDatabase', name: spec.name, duration: spec.duration ?? null }], object: spec.name };
  }
  if (!d || !n) {
    problems.push('This engine has no datasets.');
    return { statements: [], ops: [], object: spec.name };
  }
  const name = n.one(spec.name, 'The name');
  const ine = spec.ifNotExists ? ' IF NOT EXISTS' : '';
  switch (d) {
    case 'postgres':
      return { statements: [`CREATE SCHEMA${ine} ${name}${spec.owner ? ` AUTHORIZATION ${n.one(spec.owner, 'The owner')}` : ''}`, ...(spec.comment ? [`COMMENT ON SCHEMA ${name} IS ${stringLiteral(d, spec.comment)}`] : [])], ops: [], object: spec.name };
    case 'mysql':
      if (spec.comment) notes.push('MySQL databases keep no comment; it is left out.');
      return { statements: [`CREATE DATABASE${ine} ${name}${spec.charset ? ` CHARACTER SET ${spec.charset}` : ''}${spec.collation ? ` COLLATE ${spec.collation}` : ''}`], ops: [], object: spec.name };
    case 'tsql':
      if (spec.ifNotExists) problems.push('SQL Server has no CREATE SCHEMA IF NOT EXISTS; leave it off.');
      return { statements: [`CREATE SCHEMA ${name}${spec.owner ? ` AUTHORIZATION ${n.one(spec.owner, 'The owner')}` : ''}`], ops: [], object: spec.name };
    case 'snowflake':
      return { statements: [`CREATE SCHEMA${ine} ${name}${spec.managedAccess ? ' WITH MANAGED ACCESS' : ''}${spec.retentionDays !== undefined ? ` DATA_RETENTION_TIME_IN_DAYS = ${spec.retentionDays}` : ''}${spec.comment ? ` COMMENT = ${stringLiteral(d, spec.comment)}` : ''}`], ops: [], object: spec.name };
    case 'bigquery': {
      // Without a location of its own, the dataset goes where the connection's jobs run; shown, so the preview says so.
      const location = spec.location ?? (typeof ctx?.options.location === 'string' ? ctx.options.location : null);
      const opts = [location ? `location=${stringLiteral(d, location)}` : null, spec.defaultTableExpirationDays ? `default_table_expiration_days=${spec.defaultTableExpirationDays}` : null, spec.comment ? `description=${stringLiteral(d, spec.comment)}` : null].filter(Boolean);
      return {
        statements: [`CREATE SCHEMA${ine} ${name}${opts.length ? ` OPTIONS(${opts.join(', ')})` : ''}`],
        ops: [{ op: 'bigquery.insertDataset', datasetId: n.part(spec.name, 'The dataset'), location, description: spec.comment ?? null, defaultTableExpirationMs: spec.defaultTableExpirationDays ? Math.round(spec.defaultTableExpirationDays * 86_400_000) : null, ifNotExists: spec.ifNotExists }],
        object: spec.name
      };
    }
    default:
      problems.push(d === 'oracle' ? 'An Oracle schema is a user; create it with your DBA tools.' : 'SQLite has one schema per database.');
      return { statements: [], ops: [], object: spec.name };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The rest
// ---------------------------------------------------------------------------------------------------------------

const json = (v: unknown) => JSON.stringify(v, null, 2);

/** One field of an OpenSearch mapping, as the create and edit plans write it. */
export function searchFieldMapping(f: z.infer<typeof searchIndexSpec>['fields'][number], problems: string[]): Record<string, unknown> {
  const m: Record<string, unknown> = { type: f.type };
  if (f.analyzer) {
    if (f.type !== 'text' && f.type !== 'match_only_text') problems.push(`${f.name}: an analyzer applies to text fields.`);
    m.analyzer = f.analyzer;
  }
  if (f.format) {
    if (f.type !== 'date' && f.type !== 'date_nanos') problems.push(`${f.name}: a format applies to date fields.`);
    m.format = f.format;
  }
  if (f.type === 'knn_vector') {
    if (!f.dimension) problems.push(`${f.name}: a knn_vector needs its dimension.`);
    m.dimension = f.dimension;
  } else if (f.dimension) problems.push(`${f.name}: a dimension applies to knn_vector fields.`);
  if (f.type === 'scaled_float') {
    if (!f.scalingFactor) problems.push(`${f.name}: a scaled_float needs its scaling factor.`);
    m.scaling_factor = f.scalingFactor;
  }
  return m;
}

/** A Cosmos DB container's body, as the create and replace calls send it. */
export function cosmosContainerBody(s: z.infer<typeof cosmosContainerSpec>): Record<string, unknown> {
  return {
    id: s.name,
    partitionKey: { paths: s.partitionKeyPaths, kind: s.partitionKeyPaths.length > 1 ? 'MultiHash' : 'Hash', version: 2 },
    ...(s.defaultTtl !== undefined ? { defaultTtl: s.defaultTtl } : {}),
    ...(s.uniqueKeys.length ? { uniqueKeyPolicy: { uniqueKeys: s.uniqueKeys.map((paths) => ({ paths })) } } : {}),
    ...(s.excludedPaths.length ? { indexingPolicy: { indexingMode: 'consistent', automatic: true, includedPaths: [{ path: '/*' }], excludedPaths: s.excludedPaths.map((path) => ({ path })) } } : {})
  };
}

function mongoFilterProblem(v: unknown, depth = 0): string | null {
  if (depth > 6) return 'The partial filter is nested too deeply.';
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (k.startsWith('$') && !['$eq', '$gt', '$gte', '$lt', '$lte', '$exists', '$type', '$and', '$in'].includes(k)) return `${k} is not accepted in a partial filter.`;
      const p = mongoFilterProblem(x, depth + 1);
      if (p) return p;
    }
  } else if (Array.isArray(v)) for (const x of v) {
    const p = mongoFilterProblem(x, depth + 1);
    if (p) return p;
  }
  return null;
}

export function buildOther(engine: Engine, family: Family, raw: unknown, ctx: NameContext, problems: string[], notes: string[]): { kind: DdlKind; statements: string[]; ops: AdminOp[]; touches: string[]; object: string } {
  const kind = (raw as { kind?: string } | null)?.kind;
  const parse = <T extends z.ZodTypeAny>(schema: T): z.infer<T> => {
    const r = schema.safeParse(raw);
    if (!r.success) throw new DdlProblem(r.error.issues.map((i) => `${i.path.join('.') || 'definition'}: ${i.message}`));
    return r.data;
  };
  if (family === 'mongo' && kind === 'collection') {
    const s = parse(mongoCollectionSpec);
    const options: Record<string, unknown> = {};
    if (s.fields.length) {
      const properties: Record<string, unknown> = {};
      for (const f of s.fields) {
        if (f.name.includes('.')) {
          problems.push(`${f.name}: the validator describes top-level fields; nested paths go inside an object field.`);
          continue;
        }
        properties[f.name] = { bsonType: f.bsonType, ...(f.description ? { description: f.description } : {}) };
      }
      const required = s.fields.filter((f) => f.required).map((f) => f.name);
      options.validator = { $jsonSchema: { bsonType: 'object', ...(required.length ? { required } : {}), properties, ...(s.additionalProperties ? {} : { additionalProperties: false }) } };
      options.validationLevel = s.validationLevel;
      options.validationAction = s.validationAction;
      if (!s.additionalProperties && !s.fields.some((f) => f.name === '_id')) problems.push('With no other fields allowed, list _id as a field too.');
    }
    if (s.capped) {
      if (s.timeseries) problems.push('A collection is capped or time series, not both.');
      Object.assign(options, { capped: true, size: s.capped.size, ...(s.capped.max ? { max: s.capped.max } : {}) });
    }
    if (s.timeseries) options.timeseries = s.timeseries;
    if (s.expireAfterSeconds !== undefined) {
      if (!s.timeseries) problems.push('expireAfterSeconds on a collection is for time series; use a TTL index otherwise.');
      options.expireAfterSeconds = s.expireAfterSeconds;
    }
    if (engine !== 'mongodb' && (s.timeseries || s.capped)) notes.push(`${engineInfo(engine).title} may not support ${s.timeseries ? 'time series' : 'capped'} collections; the service answers if not.`);
    return { kind: 'collection', statements: [`db.createCollection(${JSON.stringify(s.name)}, ${json(options)})`], ops: [{ op: 'mongo.createCollection', name: s.name, options }], touches: [], object: s.name };
  }
  if (family === 'mongo' && kind === 'index') {
    const s = parse(mongoIndexSpec);
    const keys: Record<string, 1 | -1 | 'text' | '2dsphere' | 'hashed'> = {};
    for (const k of s.keys) {
      if (k.field in keys) problems.push(`${k.field} is listed twice.`);
      keys[k.field] = k.order;
    }
    if (s.keys.filter((k) => k.order === 'hashed').length > 1) problems.push('An index has at most one hashed field.');
    if (s.unique && s.keys.some((k) => k.order === 'hashed' || k.order === 'text')) problems.push('Hashed and text indexes cannot be unique.');
    if (s.expireAfterSeconds !== undefined && s.keys.length !== 1) problems.push('A TTL index has exactly one field (a date).');
    if (s.partialFilter) {
      const p = mongoFilterProblem(s.partialFilter);
      if (p) problems.push(p);
      if (s.sparse) problems.push('An index is sparse or partial, not both.');
    }
    const options = { ...(s.name ? { name: s.name } : {}), ...(s.unique ? { unique: true } : {}), ...(s.sparse ? { sparse: true } : {}), ...(s.expireAfterSeconds !== undefined ? { expireAfterSeconds: s.expireAfterSeconds } : {}), ...(s.partialFilter ? { partialFilterExpression: s.partialFilter } : {}) };
    return { kind: 'index', statements: [`db.${s.collection}.createIndex(${JSON.stringify(keys)}, ${JSON.stringify(options)})`], ops: [{ op: 'mongo.createIndex', collection: s.collection, keys, options }], touches: [s.collection], object: `${s.collection}:${s.name ?? Object.keys(keys).join('_')}` };
  }
  if (family === 'opensearch' && kind === 'search-index') {
    const s = parse(searchIndexSpec);
    const properties: Record<string, unknown> = {};
    let knn = false;
    for (const f of s.fields) {
      if (f.name in properties) problems.push(`${f.name} is listed twice.`);
      const m = searchFieldMapping(f, problems);
      if (f.type === 'knn_vector') knn = true;
      properties[f.name] = m;
    }
    const body = { settings: { index: { number_of_shards: s.shards, number_of_replicas: s.replicas, ...(knn ? { knn: true } : {}) } }, mappings: { dynamic: s.dynamic, properties } };
    return { kind: 'search-index', statements: [`PUT /${s.name}\n${json(body)}`], ops: [{ op: 'opensearch.createIndex', index: s.name, body }], touches: [], object: s.name };
  }
  if (family === 'dynamodb') {
    const attrs = new Map<string, string>();
    const def = (k: { name: string; type: string }) => {
      const had = attrs.get(k.name);
      if (had && had !== k.type) problems.push(`${k.name} is used as type ${had} and ${k.type}.`);
      attrs.set(k.name, k.type);
    };
    const keySchema = (pk: { name: string; type: string }, sk?: { name: string; type: string }) => {
      def(pk);
      if (sk) def(sk);
      return [{ AttributeName: pk.name, KeyType: 'HASH' }, ...(sk ? [{ AttributeName: sk.name, KeyType: 'RANGE' }] : [])];
    };
    const projection = (g: z.infer<typeof gsi>) => {
      if (g.projection === 'INCLUDE' && !g.nonKeyAttributes.length) problems.push(`${g.name}: INCLUDE needs the attributes to include.`);
      if (g.projection !== 'INCLUDE' && g.nonKeyAttributes.length) problems.push(`${g.name}: attributes are listed only with INCLUDE.`);
      return { ProjectionType: g.projection, ...(g.projection === 'INCLUDE' ? { NonKeyAttributes: g.nonKeyAttributes } : {}) };
    };
    const throughput = (provisioned: boolean, r?: number, w?: number, what = 'The table') => {
      if (provisioned && (!r || !w)) problems.push(`${what} needs read and write capacity with provisioned billing.`);
      if (!provisioned && (r || w)) problems.push(`${what} takes capacity only with provisioned billing.`);
      return provisioned ? { ProvisionedThroughput: { ReadCapacityUnits: r ?? 1, WriteCapacityUnits: w ?? 1 } } : {};
    };
    if (kind === 'table') {
      const s = parse(dynamoTableSpec);
      const prov = s.billingMode === 'PROVISIONED';
      const input: Record<string, unknown> = {
        TableName: s.name,
        KeySchema: keySchema(s.partitionKey, s.sortKey),
        BillingMode: s.billingMode,
        ...throughput(prov, s.readCapacity, s.writeCapacity),
        ...(s.indexes.length ? { GlobalSecondaryIndexes: s.indexes.map((g) => ({ IndexName: g.name, KeySchema: keySchema(g.partitionKey, g.sortKey), Projection: projection(g), ...throughput(prov, g.readCapacity, g.writeCapacity, g.name) })) } : {})
      };
      input.AttributeDefinitions = [...attrs].map(([AttributeName, AttributeType]) => ({ AttributeName, AttributeType }));
      const ops: AdminOp[] = [{ op: 'dynamodb.createTable', input }];
      if (s.ttlAttribute) ops.push({ op: 'dynamodb.updateTimeToLive', input: { TableName: s.name, TimeToLiveSpecification: { Enabled: true, AttributeName: s.ttlAttribute } } });
      return { kind: 'table', statements: ops.map((o) => `${o.op === 'dynamodb.createTable' ? 'CreateTable' : 'UpdateTimeToLive'} ${json((o as { input: unknown }).input)}`), ops, touches: [], object: s.name };
    }
    if (kind === 'index') {
      const s = parse(dynamoIndexSpec);
      const create = { IndexName: s.name, KeySchema: keySchema(s.partitionKey, s.sortKey), Projection: projection(s), ...(s.readCapacity || s.writeCapacity ? { ProvisionedThroughput: { ReadCapacityUnits: s.readCapacity ?? 1, WriteCapacityUnits: s.writeCapacity ?? 1 } } : {}) };
      const input = { TableName: s.table, AttributeDefinitions: [...attrs].map(([AttributeName, AttributeType]) => ({ AttributeName, AttributeType })), GlobalSecondaryIndexUpdates: [{ Create: create }] };
      notes.push('DynamoDB builds the index in the background; it reads as CREATING until it is backfilled.');
      if (s.readCapacity || s.writeCapacity) notes.push('Capacity applies only to a table with provisioned billing; an on-demand table refuses it.');
      else notes.push('A table with provisioned billing needs read and write capacity for the index too.');
      return { kind: 'index', statements: [`UpdateTable ${json(input)}`], ops: [{ op: 'dynamodb.updateTable', input }], touches: [s.table], object: `${s.table}:${s.name}` };
    }
  }
  if (family === 'cosmos' && kind === 'container') {
    const s = parse(cosmosContainerSpec);
    const body = cosmosContainerBody(s);
    if (s.defaultTtl === 0) problems.push('defaultTtl is -1 (on, no default) or a number of seconds; 0 is not allowed.');
    return { kind: 'container', statements: [`POST /dbs/${ctx.database ?? '<database>'}/colls${s.throughput ? ` (x-ms-offer-throughput: ${s.throughput})` : ''}\n${json(body)}`], ops: [{ op: 'cosmos.createContainer', body, throughput: s.throughput ?? null }], touches: [], object: s.name };
  }
  if ((family === 'cosmos' || family === 'influx') && kind === 'dataset') {
    const s = parse(datasetSpec);
    const r = buildDataset(engine, null, s, null, notes, problems);
    if (engine === 'influxdb') {
      const v = String(ctx.options.version ?? 'v2');
      if (v === 'v2') problems.push('InfluxDB 2.x makes buckets in its own UI or API with an org token; the designer creates databases on 1.x and 3.');
      if (v === 'v3' && s.duration) notes.push('InfluxDB 3 takes a retention period in its own settings; the duration is left out.');
    }
    return { kind: 'dataset', ...r, touches: [] };
  }
  if (family === 'redis' && kind === 'stream-group') {
    const s = parse(streamGroupSpec);
    notes.push(s.mkstream ? 'MKSTREAM makes an empty stream when the key does not exist yet.' : 'Without MKSTREAM the stream must already exist.');
    return { kind: 'stream-group', statements: [`XGROUP CREATE ${s.key} ${s.group} ${s.startId}${s.mkstream ? ' MKSTREAM' : ''}`], ops: [{ op: 'redis.xgroupCreate', key: s.key, group: s.group, id: s.startId, mkstream: s.mkstream }], touches: [s.key], object: s.key };
  }
  if (family === 'rabbitmq') {
    const home = (v?: string) => (v ?? ctx.database ?? '/').replace(/%2F/gi, '/');
    const reserved = (name: string) => {
      if (/^amq\./.test(name)) problems.push(`Names starting amq. are reserved by RabbitMQ (${name}).`);
    };
    const path = (vh: string, name: string) => `${encodeURIComponent(vh)}/${encodeURIComponent(name)}`;
    if (kind === 'queue') {
      const s = parse(rabbitQueueSpec);
      reserved(s.name);
      const a = s.arguments;
      // A classic queue carries no x-queue-type: brokers before 3.10 treat an added one as a different queue.
      const args: Record<string, unknown> = s.type === 'classic' ? {} : { 'x-queue-type': s.type };
      const set = (k: string, v: unknown) => {
        if (v !== undefined) args[k] = v;
      };
      set('x-message-ttl', a.messageTtl);
      set('x-expires', a.expires);
      set('x-max-length', a.maxLength);
      set('x-max-length-bytes', a.maxLengthBytes);
      set('x-overflow', a.overflow);
      set('x-dead-letter-exchange', a.deadLetterExchange);
      set('x-dead-letter-routing-key', a.deadLetterRoutingKey);
      set('x-dead-letter-strategy', a.deadLetterStrategy);
      set('x-single-active-consumer', a.singleActiveConsumer);
      set('x-max-priority', a.maxPriority);
      set('x-delivery-limit', a.deliveryLimit);
      set('x-quorum-initial-group-size', a.initialGroupSize);
      set('x-max-age', a.maxAge);
      set('x-stream-max-segment-size-bytes', a.streamMaxSegmentSizeBytes);
      const not = (cond: boolean, msg: string) => {
        if (cond) problems.push(msg);
      };
      if (s.type !== 'classic') {
        not(!s.durable, `${s.type} queues are always durable.`);
        not(s.autoDelete, `${s.type} queues cannot be auto-delete.`);
        not(a.maxPriority !== undefined, `${s.type} queues have no priorities (x-max-priority is for classic queues).`);
      }
      if (s.type === 'stream') {
        for (const [k, v] of Object.entries({ messageTtl: a.messageTtl, expires: a.expires, maxLength: a.maxLength, overflow: a.overflow, deadLetterExchange: a.deadLetterExchange, deliveryLimit: a.deliveryLimit, singleActiveConsumer: a.singleActiveConsumer })) not(v !== undefined, `Streams do not take ${k}; bound them with maxLengthBytes and maxAge.`);
      } else {
        not(a.maxAge !== undefined, 'maxAge is a stream setting.');
        not(a.streamMaxSegmentSizeBytes !== undefined, 'The segment size is a stream setting.');
      }
      if (s.type !== 'quorum') {
        not(a.deliveryLimit !== undefined, 'The delivery limit is a quorum queue setting.');
        not(a.deadLetterStrategy !== undefined, 'The dead-letter strategy is a quorum queue setting.');
      }
      if (s.type === 'classic') not(a.initialGroupSize !== undefined, 'The initial group size is for quorum queues and streams.');
      not(a.overflow === 'reject-publish-dlx' && s.type === 'quorum', 'Quorum queues take drop-head or reject-publish.');
      not(a.deadLetterStrategy === 'at-least-once' && a.overflow !== 'reject-publish', 'At-least-once dead-lettering needs overflow reject-publish.');
      not(a.deadLetterRoutingKey !== undefined && a.deadLetterExchange === undefined, 'A dead-letter routing key needs a dead-letter exchange.');
      const vh = home(s.vhost);
      const body = { durable: s.durable, auto_delete: s.autoDelete, arguments: args };
      return { kind: 'queue', statements: [`PUT /api/queues/${path(vh, s.name)}\n${json(body)}`], ops: [{ op: 'rabbit.declareQueue', vhost: vh, name: s.name, body }], touches: [], object: `${vh}/${s.name}` };
    }
    if (kind === 'exchange') {
      const s = parse(rabbitExchangeSpec);
      reserved(s.name);
      const vh = home(s.vhost);
      const body = { type: s.type, durable: s.durable, auto_delete: s.autoDelete, internal: s.internal, arguments: s.alternateExchange ? { 'alternate-exchange': s.alternateExchange } : {} };
      return { kind: 'exchange', statements: [`PUT /api/exchanges/${path(vh, s.name)}\n${json(body)}`], ops: [{ op: 'rabbit.declareExchange', vhost: vh, name: s.name, body }], touches: [], object: `${vh}/${s.name}` };
    }
    if (kind === 'binding') {
      const s = parse(rabbitBindingSpec);
      const vh = home(s.vhost);
      if (s.source === '') problems.push('The default exchange cannot be bound explicitly.');
      const body = { routing_key: s.routingKey, arguments: s.arguments };
      const t = s.destinationType === 'queue' ? 'q' : 'e';
      return { kind: 'binding', statements: [`POST /api/bindings/${encodeURIComponent(vh)}/e/${encodeURIComponent(s.source)}/${t}/${encodeURIComponent(s.destination)}\n${json(body)}`], ops: [{ op: 'rabbit.bind', vhost: vh, source: s.source, destination: s.destination, destinationType: t, body }], touches: s.destinationType === 'queue' ? [`${vh}/${s.destination}`] : [], object: `${vh}/${s.source}->${s.destination}` };
    }
  }
  const offered = ddlKinds(engine).map((k) => k.kind);
  throw new DdlProblem([offered.length ? `${engineInfo(engine).title} offers ${offered.join(', ')}, not ${kind ?? 'that'}.` : `${engineInfo(engine).title} connections have no schema changes.`]);
}

// ---------------------------------------------------------------------------------------------------------------

const hashOf = (statements: string[], ops: AdminOp[]) => createHash('sha256').update(JSON.stringify({ statements, ops })).digest('hex');

/**
 * Checks a definition for a connection's engine and writes its plan. Throws `DdlProblem` with every problem found
 * (as plain sentences) when it is not valid; nothing has been sent anywhere.
 */
export function buildPlan(engine: Engine, ctx: NameContext, raw: unknown, current: ObjectDescription | null = null): DdlPlan {
  const family = familyOf(engine);
  const kind = (raw as { kind?: unknown } | null)?.kind;
  // 2.0.x: edits and drops of existing objects (ddl-edit.ts), diffed against the description read just now.
  if (typeof kind === 'string' && isEditKind(kind)) {
    const p = buildEditPlan(engine, ctx, raw, current);
    return { ...p, hash: hashOf(p.statements, p.ops) };
  }
  if (typeof kind !== 'string' || !(DDL_KINDS as readonly string[]).includes(kind)) throw new DdlProblem([`kind: one of ${ddlKinds(engine).map((k) => k.kind).join(', ') || 'nothing on this engine'}.`]);
  if (!ddlKinds(engine).some((k) => k.kind === kind)) {
    const offered = ddlKinds(engine).map((k) => k.kind);
    throw new DdlProblem([offered.length ? `${engineInfo(engine).title} offers ${offered.join(', ')}, not ${kind}.` : `${engineInfo(engine).title} connections have no schema changes.`]);
  }
  const notes: string[] = [];
  if (family === 'sql') {
    const d = engineInfo(engine).dialect!;
    const n = new Names(d, ctx);
    const parse = <T extends z.ZodTypeAny>(schema: T): z.infer<T> => {
      const r = schema.safeParse(raw);
      if (!r.success) throw new DdlProblem(r.error.issues.map((i) => `${i.path.join('.') || 'definition'}: ${i.message}`));
      return r.data;
    };
    let out: { statements: string[]; ops?: AdminOp[]; touches?: string[]; object: string; transactional?: boolean };
    if (kind === 'table') out = buildSqlTable(d, parse(sqlTableSpec), n, notes);
    else if (kind === 'index') out = buildSqlIndex(d, parse(sqlIndexSpec), n, notes);
    else if (kind === 'procedure' || kind === 'function') out = buildRoutine(d, parse(routineSpec), n, notes, ctx);
    else out = buildDataset(engine, d, parse(datasetSpec), n, notes, n.problems, ctx);
    if (n.problems.length) throw new DdlProblem([...new Set(n.problems)]);
    const transactional = out.transactional ?? (TRANSACTIONAL[d] && out.statements.length > 0);
    if (!transactional && out.statements.length > 1) notes.push('This database commits each DDL statement on its own: if a later statement fails, the earlier ones stay.');
    const ops = out.ops ?? [];
    return { engine, kind: kind as DdlKind, object: out.object, statements: out.statements, ops, transactional, touches: out.touches ?? [], notes, destructive: false, confirmName: null, hash: hashOf(out.statements, ops) };
  }
  const problems: string[] = [];
  const r = buildOther(engine, family, raw, ctx, problems, notes);
  if (problems.length) throw new DdlProblem([...new Set(problems)]);
  return { engine, kind: r.kind, object: r.object, statements: r.statements, ops: r.ops, transactional: false, touches: r.touches, notes, destructive: false, confirmName: null, hash: hashOf(r.statements, r.ops) };
}

/** What the console's Schema designer is drawn from, per engine: the kinds, and the vendor's column or field types. */
export function designerInfo(engine: Engine) {
  const d = engineInfo(engine).dialect;
  const family = familyOf(engine);
  return {
    kinds: ddlKinds(engine),
    types: d ? typesOf(d) : [],
    fieldTypes: family === 'opensearch' ? [...OPENSEARCH_TYPES] : family === 'mongo' ? [...BSON_TYPES] : family === 'dynamodb' ? [...DYNAMO_KEY_TYPES] : ([] as string[]),
    languages: d ? routineLanguages(d) : [],
    indexMethods: d ? INDEX_METHODS[d] : [],
    transactional: d ? TRANSACTIONAL[d] : false,
    identity: d ? d !== 'bigquery' : false
  };
}
