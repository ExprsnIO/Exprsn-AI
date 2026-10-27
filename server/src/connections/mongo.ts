import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { BSON, MongoClient, ObjectId, type AuthMechanism, type Document } from 'mongodb';
import { checkHost, parseAllowList, type AllowList } from '../mcp/hosts.js';
import type { Classification } from './classify.js';
import type { DdlPlan } from './ddl.js';
import type { DescribeKind, DocumentDescription } from './ddl-edit-types.js';
import type { ConnectionSpec, DataDriver, QueryResult, SchemaObject, TestResult } from './drivers.js';

/*
 * MongoDB data connections. Read-only is enforced three ways: the query model only has `find` and `aggregate` (the
 * driver never issues any other command on a user's behalf), aggregation stages come from an allow-list checked
 * before anything is sent and again by the driver, and the account should hold the `read` role only (Test connection
 * reports any write privilege). Server-side JavaScript ($where, $function, $accumulator, Code values) is refused.
 *
 * 2.0.x: a previewed schema plan (`applyDdl`) creates a collection (`createCollection`, with a $jsonSchema validator,
 * capped or time-series options) or an index (`createIndex`), on the connection's separate admin account only (it
 * needs createCollection and createIndex on the database: the readWrite or dbAdmin role). The same driver does it
 * for DocumentDB, Cosmos DB for MongoDB and DigitalOcean; what a service does not support, it answers with an error.
 *
 * 2.0.x editing: a plan may also change a collection (`collMod`: validator, validationLevel/Action, a time-series
 * collection's expireAfterSeconds, an index's TTL), drop a collection (`drop`) or drop an index by name
 * (`dropIndexes`), again on the admin account only, which then also needs the collMod, dropCollection and dropIndex
 * actions (the dbAdmin role has them; readWrite has dropCollection only). System collections and server-side
 * JavaScript are refused as for creates. `describe` reads a collection back on the read account with
 * `listCollections` (filtered to the name) and `listIndexes` only: the `read` role is enough.
 */

/** A checked MongoDB request: what the driver sends. */
export interface MongoRequest {
  op: 'find' | 'aggregate';
  collection: string;
  filter?: Record<string, unknown>;
  projection?: Record<string, unknown>;
  sort?: Record<string, unknown>;
  limit?: number;
  skip?: number;
  pipeline?: Record<string, unknown>[];
}

/** Aggregation stages that only read. Anything else is refused ($out and $merge as writes). */
export const MONGO_STAGES = new Set([
  '$match', '$project', '$addFields', '$set', '$unset', '$group', '$sort', '$limit', '$skip', '$count', '$unwind', '$lookup', '$graphLookup', '$unionWith', '$facet', '$bucket',
  '$bucketAuto', '$sortByCount', '$replaceRoot', '$replaceWith', '$sample', '$redact', '$setWindowFields', '$densify', '$fill', '$geoNear'
]);
/** Operators and extended-JSON types that run JavaScript on the server: never sent. */
const JS_KEYS = new Set(['$where', '$function', '$accumulator', '$code', '$scope']);
const WRITE_STAGES = new Set(['$out', '$merge']);
const WRITE_METHODS = /^(insert|insertOne|insertMany|update|updateOne|updateMany|replaceOne|delete|deleteOne|deleteMany|remove|save|findOneAndUpdate|findOneAndReplace|findOneAndDelete|findAndModify|bulkWrite)$/;
const DDL_METHODS = /^(drop|dropIndex|dropIndexes|createIndex|createIndexes|ensureIndex|renameCollection|createCollection|createView|dropDatabase|runCommand|adminCommand|collMod)$/;
const WRITE_COMMANDS = ['insert', 'update', 'delete', 'findAndModify', 'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete', 'bulkWrite'];
const DDL_COMMANDS = ['create', 'drop', 'dropDatabase', 'createIndexes', 'dropIndexes', 'renameCollection', 'collMod', 'createView', 'convertToCapped'];
const JS_COMMANDS = ['mapReduce', 'eval', '$eval', 'group'];
const FIND_KEYS = new Set(['find', 'filter', 'projection', 'sort', 'limit', 'skip']);
const AGG_KEYS = new Set(['aggregate', 'pipeline']);

/** A collection name the platform reads: not a system collection, no `$` or NUL. */
export const COLLECTION = /^(?!system\.)[^$\0]{1,200}$/;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The first key anywhere in `v` that is in `keys`. */
function findKey(v: unknown, keys: Set<string>, depth = 0): string | null {
  if (depth > 100) return '(nesting too deep)';
  if (Array.isArray(v)) {
    for (const x of v) {
      const k = findKey(x, keys, depth + 1);
      if (k) return k;
    }
  } else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (keys.has(k)) return k;
      const f = findKey(x, keys, depth + 1);
      if (f) return f;
    }
  }
  return null;
}

/**
 * Checks a pipeline's stages against the allow-list, collecting the collections it reads ($lookup, $graphLookup and
 * $unionWith, also inside sub-pipelines and $facet). Returns a refusal, or null.
 */
export function checkPipeline(stages: unknown, objects: string[], verb = 'aggregate'): Classification | null {
  if (!Array.isArray(stages)) return { kind: 'unparsed', verb, objects, reason: 'The pipeline must be an array of stages.' };
  for (const st of stages) {
    if (!isObj(st) || Object.keys(st).length !== 1) return { kind: 'unparsed', verb, objects, reason: 'Each pipeline stage is an object with one stage name.' };
    const [name, spec] = Object.entries(st)[0]!;
    if (WRITE_STAGES.has(name)) return { kind: 'write', verb: name, objects, reason: `${name} writes to a collection.` };
    if (!MONGO_STAGES.has(name)) return { kind: 'denied', verb, objects, denied: name, reason: `The stage ${name} is not allowed. Allowed stages: ${[...MONGO_STAGES].join(', ')}.` };
    const from = (coll: unknown): Classification | null => {
      if (typeof coll !== 'string' || !COLLECTION.test(coll)) return { kind: 'denied', verb, objects, denied: `${name}`, reason: `${name} must name a collection of this database (system collections and other databases are refused).` };
      objects.push(coll);
      return null;
    };
    if (name === '$lookup' || name === '$graphLookup') {
      if (!isObj(spec)) return { kind: 'unparsed', verb, objects, reason: `${name} takes an object.` };
      const r = from(spec.from);
      if (r) return r;
      if (spec.pipeline !== undefined) {
        const p = checkPipeline(spec.pipeline, objects, verb);
        if (p) return p;
      }
    } else if (name === '$unionWith') {
      const r = from(isObj(spec) ? spec.coll : spec);
      if (r) return r;
      if (isObj(spec) && spec.pipeline !== undefined) {
        const p = checkPipeline(spec.pipeline, objects, verb);
        if (p) return p;
      }
    } else if (name === '$facet') {
      if (!isObj(spec)) return { kind: 'unparsed', verb, objects, reason: '$facet takes an object of pipelines.' };
      for (const sub of Object.values(spec)) {
        const p = checkPipeline(sub, objects, verb);
        if (p) return p;
      }
    }
  }
  return null;
}

/**
 * MongoDB queries are JSON: `{"find": "orders", "filter": {…}, "projection": {…}, "sort": {…}, "limit": 50}` or
 * `{"aggregate": "orders", "pipeline": [ … ]}`. With a collection picked in the schema tree, a bare object is the
 * filter of a find on it. Values may use extended JSON (`{"$date": "…"}`, `{"$oid": "…"}`). mongosh syntax
 * (`db.orders.find(…)`) is not run: write methods are named as writes, the rest asked to be written as JSON.
 */
export function classifyMongo(text: string, object: string | null): Classification {
  const t = text.trim();
  const shell = /^db\s*\.\s*(?:getCollection\(\s*["']([^"']+)["']\s*\)|([^.\s(]+))\s*\.\s*([A-Za-z]+)\s*\(/.exec(t) ?? /^db\s*\.\s*([A-Za-z]+)\s*\(/.exec(t);
  if (shell) {
    const method = shell[3] ?? shell[1] ?? '';
    const coll = shell[3] ? (shell[1] ?? shell[2] ?? null) : null;
    const objects = coll ? [coll] : [];
    if (WRITE_METHODS.test(method)) return { kind: 'write', verb: method, objects, reason: `${method} writes documents.` };
    if (DDL_METHODS.test(method)) return { kind: 'ddl', verb: method, objects, reason: `${method} changes collections, indexes or the database.` };
    return { kind: 'unparsed', verb: method, objects, reason: 'mongosh syntax is not run. Write the query as JSON, such as {"find": "orders", "filter": {"status": "open"}} or {"aggregate": "orders", "pipeline": [ … ]}.' };
  }
  let q: unknown;
  try {
    q = JSON.parse(t);
  } catch {
    return { kind: 'unparsed', verb: null, objects: [], reason: 'The query is not JSON. Write {"find": "<collection>", "filter": { … }} or {"aggregate": "<collection>", "pipeline": [ … ]}.' };
  }
  if (!isObj(q)) return { kind: 'unparsed', verb: null, objects: [], reason: 'The query must be a JSON object.' };
  const js = findKey(q, JS_KEYS);
  if (js) return { kind: 'denied', verb: null, objects: [], denied: js, reason: `${js} runs JavaScript on the database server and is not allowed.` };
  const cmd = Object.keys(q)[0] ?? '';
  const write = WRITE_COMMANDS.find((k) => k in q);
  if (write) return { kind: 'write', verb: write, objects: typeof q[write] === 'string' ? [q[write] as string] : [], reason: `${write} writes documents.` };
  const ddl = DDL_COMMANDS.find((k) => k in q);
  if (ddl) return { kind: 'ddl', verb: ddl, objects: [], reason: `${ddl} changes collections, indexes or the database.` };
  const jsCmd = JS_COMMANDS.find((k) => k in q);
  if (jsCmd) return { kind: 'denied', verb: jsCmd, objects: [], denied: jsCmd, reason: `${jsCmd} runs JavaScript on the database server; only find and aggregate run on a connection.` };
  const stageWrite = findKey(q, WRITE_STAGES);
  if (stageWrite) return { kind: 'write', verb: stageWrite, objects: [], reason: `${stageWrite} writes to a collection.` };

  if ('find' in q || 'aggregate' in q) {
    const op = 'find' in q ? 'find' : 'aggregate';
    if ('find' in q && 'aggregate' in q) return { kind: 'unparsed', verb: null, objects: [], reason: 'Send either find or aggregate, not both.' };
    const coll = q[op];
    if (typeof coll !== 'string' || !COLLECTION.test(coll)) return { kind: 'denied', verb: op, objects: [], denied: String(coll), reason: `${op} must name a collection of this database; system collections are refused.` };
    const allowedKeys = op === 'find' ? FIND_KEYS : AGG_KEYS;
    const extra = Object.keys(q).find((k) => !allowedKeys.has(k));
    if (extra) return { kind: 'unparsed', verb: op, objects: [coll], reason: `${extra} is not read: ${op} takes ${[...allowedKeys].join(', ')}.` };
    const objects = [coll];
    if (op === 'find') {
      for (const k of ['filter', 'projection', 'sort'] as const) if (q[k] !== undefined && !isObj(q[k])) return { kind: 'unparsed', verb: op, objects, reason: `${k} must be an object.` };
      for (const k of ['limit', 'skip'] as const) if (q[k] !== undefined && !(Number.isInteger(q[k]) && (q[k] as number) >= 0)) return { kind: 'unparsed', verb: op, objects, reason: `${k} must be a whole number.` };
      const request: MongoRequest = { op, collection: coll, ...(q.filter ? { filter: q.filter as Record<string, unknown> } : {}), ...(q.projection ? { projection: q.projection as Record<string, unknown> } : {}), ...(q.sort ? { sort: q.sort as Record<string, unknown> } : {}), ...(q.limit !== undefined ? { limit: q.limit as number } : {}), ...(q.skip !== undefined ? { skip: q.skip as number } : {}) };
      return { kind: 'read', verb: op, objects, mongo: request };
    }
    const bad = checkPipeline(q.pipeline ?? [], objects);
    if (bad) return bad;
    return { kind: 'read', verb: op, objects: [...new Set(objects)], mongo: { op, collection: coll, pipeline: (q.pipeline ?? []) as Record<string, unknown>[] } };
  }
  if (!object) return { kind: 'unparsed', verb: cmd || null, objects: [], reason: 'Pick a collection in the schema tree, or write {"find": "<collection>", "filter": { … }}.' };
  if (!COLLECTION.test(object)) return { kind: 'denied', verb: 'find', objects: [], denied: object, reason: 'System collections are refused.' };
  return { kind: 'read', verb: 'find', objects: [object], mongo: { op: 'find', collection: object, filter: q } };
}

/**
 * 1.9.99-final (B-10304): `classifyMongo` for a MongoDB-compatible service: a pipeline using a stage the service does
 * not run is refused here, before anything is sent, naming the service.
 */
export function classifyMongoFor(flavour: MongoFlavour, text: string, object: string | null): Classification {
  const c = classifyMongo(text, object);
  const stage = c.kind === 'read' && c.mongo?.op === 'aggregate' && flavour.unsupportedStages ? findKey(c.mongo.pipeline ?? [], flavour.unsupportedStages as Set<string>) : null;
  return stage ? { kind: 'denied', verb: 'aggregate', objects: c.objects, denied: stage, reason: `${flavour.title} does not run the ${stage} stage.` } : c;
}

/** True when a collection is on the allow-list, by name or through a pattern such as `orders_*`. */
export function allowedCollection(name: string, allow: string[]): boolean {
  return allow.some((a) => a === name || (a.includes('*') && !name.includes('*') && new RegExp('^' + a.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(name)));
}

// ---------- values ----------

/** A BSON value as a plain one: ObjectId as hex, Decimal128 and Long as text, dates kept, documents walked. */
export function plain(v: unknown, depth = 0): unknown {
  if (v == null) return null;
  if (v instanceof Date || typeof v !== 'object') return v;
  if (depth > 50) return '[nested]';
  if (Array.isArray(v)) return v.map((x) => plain(x, depth + 1));
  const t = (v as { _bsontype?: string })._bsontype;
  if (t) {
    if (t === 'ObjectId') return (v as ObjectId).toHexString();
    if (t === 'Binary') {
      const b = v as BSON.Binary;
      return b.sub_type === 4 ? b.toUUID().toString() : `[binary ${b.length()} bytes]`;
    }
    if (t === 'BSONRegExp') return `/${(v as BSON.BSONRegExp).pattern}/${(v as BSON.BSONRegExp).options}`;
    if (t === 'Code') return '[code]';
    return String(v);
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = plain(x, depth + 1);
  return out;
}

/** The value at a dotted path (`customer.name`). */
export function getPath(doc: Record<string, unknown>, path: string): unknown {
  let cur: unknown = doc;
  for (const part of path.split('.')) {
    if (!isObj(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

const typeName = (v: unknown): string => (v == null ? 'null' : v instanceof Date ? 'date' : Array.isArray(v) ? 'array' : typeof v === 'object' ? ((v as { _bsontype?: string })._bsontype?.toLowerCase() ?? 'object') : typeof v);

// ---------- descriptions (2.0.x editing) ----------

/** What listCollections and listIndexes report, in the create form's shape (ddl.ts mongoCollectionSpec, mongoIndexSpec). */
export function describeMongoCollection(name: string, info: Document, indexes: Document[]): DocumentDescription {
  const options = (info.options ?? {}) as Document;
  const def: Record<string, unknown> = { name };
  const schema = isObj(options.validator) && isObj(options.validator.$jsonSchema) ? (options.validator.$jsonSchema as Document) : null;
  const required = new Set(Array.isArray(schema?.required) ? (schema!.required as unknown[]).map(String) : []);
  const fields: Record<string, unknown>[] = [];
  if (schema && isObj(schema.properties)) {
    for (const [field, p] of Object.entries(schema.properties as Document)) {
      const raw = isObj(p) ? (p.bsonType ?? p.type) : undefined;
      // A field allowed several types is read as its first; the form edits one type per field.
      const bsonType = String(Array.isArray(raw) ? (raw[0] ?? 'object') : (raw ?? 'object'));
      fields.push({ name: field, bsonType, required: required.has(field), ...(isObj(p) && typeof p.description === 'string' ? { description: p.description } : {}) });
    }
  }
  for (const r of required) if (!fields.some((f) => f.name === r)) fields.push({ name: r, bsonType: 'object', required: true });
  def.fields = fields;
  def.additionalProperties = schema ? schema.additionalProperties !== false : true;
  def.validationLevel = typeof options.validationLevel === 'string' ? options.validationLevel : 'strict';
  def.validationAction = typeof options.validationAction === 'string' ? options.validationAction : 'error';
  if (options.capped) def.capped = { size: Number(options.size ?? 0), ...(options.max ? { max: Number(options.max) } : {}) };
  if (isObj(options.timeseries)) {
    const t = options.timeseries as Document;
    def.timeseries = { timeField: String(t.timeField), ...(t.metaField ? { metaField: String(t.metaField) } : {}), ...(t.granularity ? { granularity: String(t.granularity) } : {}) };
  }
  if (options.expireAfterSeconds != null) def.expireAfterSeconds = Number(options.expireAfterSeconds);
  const ixs = indexes
    .filter((ix) => ix.name !== '_id_')
    .map((ix) => {
      const keys: { field: string; order: 1 | -1 | string }[] = [];
      for (const [field, order] of Object.entries((ix.key ?? {}) as Document)) {
        // A text index is reported as {_fts: 'text', _ftsx: 1}; its fields are the weights' keys.
        if (field === '_fts') keys.push(...Object.keys((ix.weights ?? {}) as Document).map((f) => ({ field: f, order: 'text' })));
        else if (field !== '_ftsx') keys.push({ field, order: typeof order === 'string' ? order : Number(order) < 0 ? -1 : 1 });
      }
      return {
        collection: name,
        name: String(ix.name),
        keys,
        unique: !!ix.unique,
        sparse: !!ix.sparse,
        ...(ix.expireAfterSeconds != null ? { expireAfterSeconds: Number(ix.expireAfterSeconds) } : {}),
        ...(isObj(ix.partialFilterExpression) ? { partialFilter: BSON.EJSON.serialize(ix.partialFilterExpression, { relaxed: true }) as Record<string, unknown> } : {})
      };
    });
  return { kind: 'collection', name, definition: def, indexes: ixs };
}

// ---------- the backend seam ----------

/** The slice of the MongoDB driver the platform uses; tests stand in an in-memory one. */
export interface MongoBackend {
  /** A command on the connection's database (ping, buildInfo, connectionStatus). */
  command(cmd: Document, timeoutMs: number): Promise<Document>;
  listCollections(timeoutMs: number): Promise<{ name: string; type: string }[]>;
  find(collection: string, filter: Document, opts: { projection?: Document; sort?: Document; skip?: number; limit: number; maxTimeMS: number }): Promise<Document[]>;
  aggregate(collection: string, pipeline: Document[], opts: { maxTimeMS: number }): Promise<Document[]>;
  /** 2.0.x: schema plans only, on the admin account (optional so read-only stand-ins need not have them). */
  createCollection?(name: string, options: Document, timeoutMs: number): Promise<void>;
  createIndex?(collection: string, keys: Document, options: Document, timeoutMs: number): Promise<string>;
  /** 2.0.x editing: `{collMod: name, ...options}`, a collection dropped, an index dropped by name (admin account). */
  collMod?(name: string, options: Document, timeoutMs: number): Promise<void>;
  dropCollection?(name: string, timeoutMs: number): Promise<void>;
  dropIndex?(collection: string, index: string, timeoutMs: number): Promise<void>;
  close(): Promise<void>;
}

export interface MongoDial {
  /** The name from the endpoint (the TLS server name when it is not an address). */
  host: string;
  /** The checked address actually dialled. */
  address: string;
  port: number;
  tls: boolean;
  database: string;
  username: string | null;
  password: string | null;
  timeoutMs: number;
  /** 1.9.99-final (B-10304): the CA bundle a managed service's certificate chains to (DocumentDB, DigitalOcean). */
  ca?: string | Buffer;
  /** 1.9.99-final (B-10304): the SASL mechanism a managed service insists on (DocumentDB: SCRAM-SHA-1). */
  authMechanism?: AuthMechanism;
  /** 1.9.99-final (B-10304): where reads go (DocumentDB's reader endpoint: secondaryPreferred). */
  readPreference?: 'primary' | 'primaryPreferred' | 'secondary' | 'secondaryPreferred' | 'nearest';
}

/**
 * 1.9.99-final, Sprint 59 (B-10304): a MongoDB-compatible managed service the same driver reads (Amazon DocumentDB,
 * Azure Cosmos DB for MongoDB vCore, DigitalOcean Managed MongoDB), with what differs from MongoDB itself.
 */
export interface MongoFlavour {
  /** The service's name, in messages. */
  title: string;
  authMechanism?: AuthMechanism;
  /** Aggregation stages the service does not run: refused before anything is sent, with the service named. */
  unsupportedStages?: ReadonlySet<string>;
  /** False when `connectionStatus` with `showPrivileges` is not answered (DocumentDB): Test connection says so instead of failing. */
  privileges?: boolean;
}

export type MongoOpener = (d: MongoDial) => Promise<MongoBackend>;

/**
 * The account and the database it authenticates against: `<authdb>/<user>` names the database (`admin/root`); a plain
 * username authenticates against the connection's database, as `mongodb://user@host/<database>` would.
 */
export function mongoAccount(username: string | null, database: string): { user: string | null; authSource: string } {
  const slash = username ? username.indexOf('/') : -1;
  return slash > 0 ? { user: username!.slice(slash + 1), authSource: username!.slice(0, slash) } : { user: username, authSource: database };
}

/**
 * The official driver: one direct connection (no replica-set discovery, so no host the server names is dialled),
 * the checked address pinned through `lookup` so DNS cannot rebind (TLS still verifies the name), no retries, and
 * credentials passed as options, never in a URI. The account authenticates against the connection's database (as a
 * URI naming that database would) unless the username is written `<authdb>/<user>`, such as `admin/root`.
 */
export const openMongo: MongoOpener = async (d) => {
  const pinned = (_h: string, opts: { all?: boolean } | number | undefined, cb: (err: Error | null, address: string | { address: string; family: number }[], family?: number) => void) => {
    const family = isIP(d.address);
    if (typeof opts === 'object' && opts?.all) cb(null, [{ address: d.address, family }]);
    else cb(null, d.address, family);
  };
  const { user, authSource } = mongoAccount(d.username, d.database);
  const hostPart = isIP(d.host) === 6 ? `[${d.host}]` : d.host;
  const client = new MongoClient(`mongodb://${hostPart}:${d.port}/`, {
    directConnection: true,
    tls: d.tls,
    lookup: pinned as never,
    serverSelectionTimeoutMS: Math.min(d.timeoutMs, 10_000),
    connectTimeoutMS: Math.min(d.timeoutMs, 10_000),
    socketTimeoutMS: d.timeoutMs + 5000,
    maxPoolSize: 1,
    retryReads: false,
    retryWrites: false,
    appName: 'exprsn-ai',
    ...(d.ca ? { ca: d.ca } : {}),
    ...(d.authMechanism ? { authMechanism: d.authMechanism } : {}),
    ...(d.readPreference ? { readPreference: d.readPreference } : {}),
    ...(user ? { auth: { username: user, password: d.password ?? '' }, authSource } : {})
  });
  await client.connect();
  const db = client.db(d.database);
  return {
    command: (cmd, timeoutMs) => db.command(cmd, { timeoutMS: timeoutMs }),
    listCollections: async (timeoutMs) => (await db.listCollections({}, { nameOnly: false, authorizedCollections: true, timeoutMS: timeoutMs }).toArray()).map((c) => ({ name: c.name, type: (c as { type?: string }).type ?? 'collection' })),
    find: (collection, filter, o) => db.collection(collection).find(filter, { ...(o.projection ? { projection: o.projection } : {}), ...(o.sort ? { sort: o.sort as never } : {}), ...(o.skip ? { skip: o.skip } : {}), limit: o.limit, maxTimeMS: o.maxTimeMS }).toArray(),
    aggregate: (collection, pipeline, o) => db.collection(collection).aggregate(pipeline, { maxTimeMS: o.maxTimeMS, allowDiskUse: false }).toArray(),
    createCollection: async (name, options, timeoutMs) => {
      await db.createCollection(name, { ...options, timeoutMS: timeoutMs });
    },
    createIndex: (collection, keys, options, timeoutMs) => db.collection(collection).createIndex(keys as never, { ...options, timeoutMS: timeoutMs }),
    collMod: async (name, options, timeoutMs) => {
      await db.command({ collMod: name, ...options }, { timeoutMS: timeoutMs });
    },
    dropCollection: async (name, timeoutMs) => {
      await db.command({ drop: name }, { timeoutMS: timeoutMs });
    },
    dropIndex: async (collection, index, timeoutMs) => {
      await db.command({ dropIndexes: collection, index }, { timeoutMS: timeoutMs });
    },
    close: () => client.close()
  };
};

/** Privilege actions that change data, schema, users or the server: an account holding any is not read-only. */
const WRITE_ACTIONS = new Set([
  'anyAction', 'insert', 'update', 'remove', 'createCollection', 'dropCollection', 'createIndex', 'dropIndex', 'dropDatabase', 'renameCollectionSameDB', 'collMod', 'convertToCapped',
  'emptycapped', 'bypassDocumentValidation', 'applyOps', 'createUser', 'dropUser', 'updateUser', 'grantRole', 'revokeRole', 'createRole', 'dropRole', 'changePassword', 'changeOwnPassword',
  'compact', 'reIndex', 'shutdown', 'enableSharding', 'moveChunk', 'splitChunk', 'createSearchIndexes', 'dropSearchIndex', 'updateSearchIndex', 'killop', 'fsync', 'setParameter', 'internal'
]);

/** MongoDB through the official driver (or `opener` in tests). Every call opens and closes its own connection. */
export class MongoDriver implements DataDriver {
  constructor(
    private readonly spec: ConnectionSpec,
    private readonly allow: AllowList = parseAllowList(''),
    private readonly opener: MongoOpener = openMongo,
    /** 1.9.99-final (B-10304): a MongoDB-compatible managed service, or MongoDB itself when absent. */
    private readonly flavour: MongoFlavour | null = null
  ) {}

  private get title(): string {
    return this.flavour?.title ?? 'MongoDB';
  }

  /** The CA bundle: from the connection's cloud link (B-10306), else the `tlsCaFile` setting (a PEM file on this server). */
  private ca(): string | Buffer | undefined {
    if (this.spec.ca) return this.spec.ca;
    const file = this.spec.options?.tlsCaFile;
    return typeof file === 'string' && file ? readFileSync(file) : undefined;
  }

  private async backend<T>(timeoutMs: number, fn: (b: MongoBackend) => Promise<T>): Promise<T> {
    if (!this.spec.database) throw new Error(`A ${this.title} connection names its database.`);
    const m = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(this.spec.endpoint.replace(/^mongodb:\/\//i, '').replace(/\/.*$/, ''));
    const host = m?.[1] ?? this.spec.endpoint;
    const port = m?.[2] ? Number(m[2]) : 27017;
    // Resolve and check once, then dial the checked address, as for PostgreSQL and MySQL.
    const { host: checked, addresses } = await checkHost(host, this.allow);
    const ca = this.spec.tls ? this.ca() : undefined;
    const rp = this.spec.options?.readPreference;
    const b = await this.opener({ host: checked, address: addresses[0]!, port, tls: this.spec.tls, database: this.spec.database, username: this.spec.username, password: this.spec.password, timeoutMs, ...(ca ? { ca } : {}), ...(this.flavour?.authMechanism ? { authMechanism: this.flavour.authMechanism } : {}), ...(typeof rp === 'string' && rp ? { readPreference: rp as MongoDial['readPreference'] } : {}) });
    try {
      return await fn(b);
    } finally {
      await b.close().catch(() => undefined);
    }
  }

  async test(timeoutMs: number): Promise<TestResult> {
    return this.backend(timeoutMs, async (b) => {
      await b.command({ ping: 1 }, timeoutMs);
      const info = await b.command({ buildInfo: 1 }, timeoutMs).catch(() => ({}) as Document);
      const status = await b.command({ connectionStatus: 1, showPrivileges: true }, timeoutMs).catch((err: unknown) => {
        if (this.flavour && this.flavour.privileges === false) return null;
        throw err;
      });
      const version = `${this.title} ${String(info.version ?? 'unknown')}`;
      if (!status) return { version, readOnly: true, health: 'healthy', detail: `${this.title} does not report an account's privileges. Only find and aggregate are sent; use an account with the read role only.` };
      const auth = (status.authInfo ?? {}) as { authenticatedUsers?: { user: string; db: string }[]; authenticatedUserPrivileges?: { resource: { db?: string; collection?: string; anyResource?: boolean; cluster?: boolean }; actions: string[] }[] };
      const users = auth.authenticatedUsers ?? [];
      const privs = auth.authenticatedUserPrivileges ?? [];
      if (!users.length) {
        // No account: either authentication is off (anyone can write) or the server refuses everything.
        const open = await b.listCollections(timeoutMs).then(() => true, () => false);
        return open
          ? { version, readOnly: false, health: 'healthy', detail: 'The server accepts connections without an account, so anyone who reaches it can write. Only find and aggregate are sent; turn on authentication and use an account with the read role.' }
          : { version, readOnly: true, health: 'degraded', detail: 'Reachable, but no account is set and the server refuses unauthenticated reads.' };
      }
      const who = `${users[0]!.user}@${users[0]!.db}`;
      const writes = [...new Set(privs.flatMap((p) => p.actions.filter((a) => WRITE_ACTIONS.has(a))))];
      const canFind = privs.some((p) => p.actions.includes('find') && (p.resource.anyResource || p.resource.db === '' || p.resource.db === this.spec.database));
      if (!canFind) return { version, readOnly: !writes.length, health: 'degraded', detail: `Account ${who} authenticated but holds no find privilege on ${this.spec.database}. Grant it the read role on that database.` };
      return writes.length
        ? { version, readOnly: false, health: 'healthy', detail: `Account ${who} holds write privileges (${writes.slice(0, 6).join(', ')}${writes.length > 6 ? ', …' : ''}). Only find and aggregate are sent; use an account with the read role.` }
        : { version, readOnly: true, health: 'healthy', detail: `Account ${who} is read-only on ${this.spec.database}; no write privileges.` };
    });
  }

  async introspect(timeoutMs: number): Promise<SchemaObject[]> {
    return this.backend(timeoutMs, async (b) => {
      const colls = (await b.listCollections(timeoutMs)).filter((c) => COLLECTION.test(c.name)).sort((x, y) => (x.name < y.name ? -1 : 1)).slice(0, 500);
      const out: SchemaObject[] = [];
      for (const [i, c] of colls.entries()) {
        const fields = new Map<string, string>();
        // Fields are sampled from the first documents of the first 200 collections: MongoDB has no fixed schema.
        if (i < 200) {
          const docs = await b.find(c.name, {}, { limit: 20, maxTimeMS: timeoutMs }).catch(() => [] as Document[]);
          for (const d of docs) for (const [k, v] of Object.entries(d)) if (!fields.has(k) || fields.get(k) === 'null') fields.set(k, typeName(v));
        }
        out.push({ name: c.name, kind: c.type === 'view' ? 'view' : 'table', columns: [...fields].map(([name, type]) => ({ name, type })) });
      }
      return out;
    });
  }

  async query(c: Classification, _text: string, opts: { limit: number; timeoutMs: number }): Promise<QueryResult> {
    const req = c.mongo;
    if (!req) throw new Error('The request was not classified as a MongoDB read.');
    // Checked again here, so nothing but an allow-listed read pipeline ever reaches the server.
    if (findKey(req, JS_KEYS) || findKey(req, WRITE_STAGES)) throw new Error('The request is not a read.');
    if (req.op === 'aggregate' && checkPipeline(req.pipeline ?? [], [])) throw new Error('The pipeline is not a read.');
    const unsupported = this.flavour?.unsupportedStages && req.op === 'aggregate' ? findKey(req.pipeline ?? [], this.flavour.unsupportedStages as Set<string>) : null;
    if (unsupported) throw new Error(`${this.title} does not run the ${unsupported} stage.`);
    const ejson = <T>(v: unknown): T => BSON.EJSON.deserialize(v as Document, { relaxed: true }) as T;
    return this.backend(opts.timeoutMs, async (b) => {
      let docs: Document[];
      if (req.op === 'find') {
        // A smaller limit of the query's own is kept; otherwise one more than the cap tells whether more exist.
        const fetch = req.limit && req.limit <= opts.limit ? req.limit : opts.limit + 1;
        docs = await b.find(req.collection, ejson(req.filter ?? {}), { ...(req.projection ? { projection: ejson(req.projection) } : {}), ...(req.sort ? { sort: ejson(req.sort) } : {}), ...(req.skip ? { skip: req.skip } : {}), limit: fetch, maxTimeMS: opts.timeoutMs });
      } else {
        docs = await b.aggregate(req.collection, [...ejson<Document[]>(req.pipeline ?? []), { $limit: opts.limit + 1 }], { maxTimeMS: opts.timeoutMs });
      }
      const capped = docs.length > opts.limit;
      const kept = docs.slice(0, opts.limit).map((d) => plain(d) as Record<string, unknown>);
      const columns: string[] = [];
      for (const d of kept) for (const k of Object.keys(d)) if (!columns.includes(k)) columns.push(k);
      if (columns.includes('_id')) columns.splice(0, 0, ...columns.splice(columns.indexOf('_id'), 1));
      return { columns, rows: kept.map((d) => columns.map((k) => d[k] ?? null)), capped, estimate: null };
    });
  }

  /** 2.0.x: a schema plan's operations on the admin account (see the header). */
  async applyDdl(plan: DdlPlan, timeoutMs: number): Promise<{ applied: number; detail?: string }> {
    const known = new Set(['mongo.createCollection', 'mongo.createIndex', 'mongo.collMod', 'mongo.dropCollection', 'mongo.dropIndex']);
    for (const op of plan.ops) if (!known.has(op.op)) throw new Error(`${this.title} connections do not perform ${op.op}.`);
    if (!plan.ops.length) throw new Error(`The plan has no ${this.title} operations.`);
    // Extended JSON in the options ({"$date": ...} in a partial filter) becomes BSON values; JavaScript never runs.
    const ejson = (v: unknown): Document => BSON.EJSON.deserialize((v ?? {}) as Document, { relaxed: true }) as Document;
    const system = (name: string, what: string) => {
      if (!COLLECTION.test(name)) throw new Error(`${name} is not a collection name the platform ${what} (system collections are refused).`);
    };
    return this.backend(timeoutMs, async (b) => {
      let applied = 0;
      const done: string[] = [];
      for (const op of plan.ops) {
        try {
          if (findKey(op, JS_KEYS)) throw new Error('Server-side JavaScript is not sent.');
          if (op.op === 'mongo.createCollection') {
            system(op.name, 'creates');
            if (!b.createCollection) throw new Error('This connection cannot create collections.');
            await b.createCollection(op.name, ejson(op.options), timeoutMs);
            done.push(`created collection ${op.name}`);
          } else if (op.op === 'mongo.createIndex') {
            system(op.collection, 'indexes');
            if (!b.createIndex) throw new Error('This connection cannot create indexes.');
            const name = await b.createIndex(op.collection, { ...op.keys }, ejson(op.options), timeoutMs);
            done.push(`created index ${name} on ${op.collection}`);
          } else if (op.op === 'mongo.collMod') {
            system(op.name, 'changes');
            if (!b.collMod) throw new Error('This connection cannot change collections.');
            const options = ejson(op.options);
            if ('collMod' in options) throw new Error('collMod options do not name the collection again.');
            await b.collMod(op.name, options, timeoutMs);
            done.push(`changed collection ${op.name}`);
          } else if (op.op === 'mongo.dropCollection') {
            system(op.name, 'drops');
            if (!b.dropCollection) throw new Error('This connection cannot drop collections.');
            await b.dropCollection(op.name, timeoutMs);
            done.push(`dropped collection ${op.name}`);
          } else if (op.op === 'mongo.dropIndex') {
            system(op.collection, 'changes');
            if (!op.index || op.index === '*') throw new Error('An index is dropped by its name (not *).');
            if (op.index === '_id_') throw new Error('The _id index cannot be dropped.');
            if (!b.dropIndex) throw new Error('This connection cannot drop indexes.');
            await b.dropIndex(op.collection, op.index, timeoutMs);
            done.push(`dropped index ${op.index} on ${op.collection}`);
          }
        } catch (err) {
          let msg = (err as Error).message;
          if (/already exists|NamespaceExists/i.test(msg) && op.op === 'mongo.createCollection') msg = `The collection ${op.name} already exists. ${msg}`;
          else if (/IndexOptionsConflict|IndexKeySpecsConflict|same name as the requested index/i.test(msg)) msg = `An index with that name or those keys already exists with other options. ${msg}`;
          else if (/IndexNotFound|index not found/i.test(msg) && op.op === 'mongo.dropIndex') msg = `The index ${op.index} does not exist on ${op.collection}. ${msg}`;
          else if (/NamespaceNotFound|ns not found|ns does not exist/i.test(msg)) msg = `The collection ${op.op === 'mongo.createIndex' || op.op === 'mongo.dropIndex' ? op.collection : 'name' in op ? String(op.name) : ''} does not exist. ${msg}`;
          else if (/not authorized|Unauthorized/i.test(msg)) msg = `The admin account may not make this change (it needs createCollection, createIndex, collMod, dropCollection and dropIndex on the database). ${msg}`;
          throw new Error(plan.ops.length > 1 ? `${msg} (${applied} of ${plan.ops.length} operations were applied before it.)` : msg, { cause: err });
        }
        applied++;
      }
      const text = done.join(', ');
      return { applied, detail: `${text.charAt(0).toUpperCase()}${text.slice(1)}.` };
    });
  }

  /**
   * 2.0.x editing: a collection as the create form takes it (mongoCollectionSpec) with its indexes (mongoIndexSpec),
   * read with listCollections and listIndexes only; null when there is no such collection.
   */
  async describe(object: string, kind: DescribeKind, timeoutMs: number): Promise<DocumentDescription | null> {
    if (kind !== 'collection') throw new Error(`${this.title} connections describe collections, not ${kind}.`);
    if (!COLLECTION.test(object)) throw new Error('System collections are refused.');
    return this.backend(timeoutMs, async (b) => {
      const listed = await b.command({ listCollections: 1, filter: { name: object }, nameOnly: false, authorizedCollections: true }, timeoutMs);
      const info = ((listed.cursor as { firstBatch?: Document[] } | undefined)?.firstBatch ?? [])[0];
      if (!info) return null;
      if (info.type === 'view') throw new Error(`${object} is a view, not a collection.`);
      const indexed = await b.command({ listIndexes: object }, timeoutMs).catch((err: Error) => {
        // A time-series collection's buckets carry its indexes; an empty list is kept rather than failing the read.
        if (/NamespaceNotFound|ns does not exist/i.test(err.message)) return { cursor: { firstBatch: [] } } as Document;
        throw err;
      });
      return describeMongoCollection(object, info, ((indexed.cursor as { firstBatch?: Document[] } | undefined)?.firstBatch ?? []) as Document[]);
    });
  }

  /**
   * Documents of a collection after a watermark, ordered by it (knowledge sources). With `fields`, the result has the
   * columns `fields` (dotted paths allowed) and only those are fetched; otherwise every top-level field. The
   * watermark is kept as text between syncs, so it is compared as each type it can stand for (a date, a number, an
   * ObjectId or the text itself).
   */
  async rows(object: string, opts: { watermarkColumn: string | null; after: string | null; limit: number; timeoutMs: number; fields?: string[] | null }): Promise<QueryResult> {
    if (!COLLECTION.test(object)) throw new Error('System collections are refused.');
    const wm = opts.watermarkColumn;
    let filter: Document = {};
    if (wm && opts.after != null) {
      const a = opts.after;
      const cands: unknown[] = [a];
      if (/^-?\d+(\.\d+)?$/.test(a)) cands.push(Number(a));
      if (/^\d{4}-\d{2}-\d{2}/.test(a) && !Number.isNaN(Date.parse(a))) cands.push(new Date(a));
      if (/^[0-9a-f]{24}$/i.test(a)) cands.push(new ObjectId(a));
      filter = { $or: cands.map((v) => ({ [wm]: { $gt: v } })) };
    }
    const fields = opts.fields?.length ? [...new Set(opts.fields)] : null;
    // A path under another one in the list would collide in the projection; the parent already brings it.
    const projected = fields?.filter((f) => !fields.some((g) => f !== g && f.startsWith(g + '.')));
    return this.backend(opts.timeoutMs, async (b) => {
      const docs = await b.find(object, filter, { ...(fields ? { projection: Object.fromEntries(projected!.map((f) => [f, 1])) } : {}), ...(wm ? { sort: { [wm]: 1, _id: 1 } } : {}), limit: opts.limit + 1, maxTimeMS: opts.timeoutMs });
      const kept = docs.slice(0, opts.limit).map((d) => plain(d) as Record<string, unknown>);
      let columns = fields ?? [];
      if (!fields) for (const d of kept) for (const k of Object.keys(d)) if (!columns.includes(k)) columns = [...columns, k];
      return { columns, rows: kept.map((d) => columns.map((k) => getPath(d, k) ?? null)), capped: docs.length > opts.limit, estimate: null };
    });
  }
}
