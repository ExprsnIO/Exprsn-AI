import { z } from 'zod';
import type { TypeChoice } from './ddl-types.js';

/*
 * 2.0.x: schema editing through a connection: the shared contract between the drivers (`describe`, `routines`), the
 * plan builder (ddl-edit.ts) and the console's edit forms.
 *
 * Editing never trusts what the browser says an object looks like now. The console loads an object's description
 * (`GET /connections/:id/objects/describe`), lets the person edit it in the same form the designer creates with, and
 * sends the edited definition; the server describes the object again from the database, compares, and writes the
 * statements that turn the one into the other. The plan's hash covers those statements, so an object that changed
 * between preview and apply makes apply refuse (409) rather than run a stale diff.
 *
 * A change that loses data (dropping a table, column, index, routine, collection, queue; narrowing a type) marks the
 * plan `destructive`, and apply then needs the object's name typed back (`confirm`).
 */

// ---------------------------------------------------------------------------------------------------------------
// Descriptions: what a driver reads back about one object
// ---------------------------------------------------------------------------------------------------------------

export interface DescribedDefault {
  kind: 'literal' | 'expression';
  /** literal: the value as text (numbers and booleans too); expression: the SQL as the database reports it. */
  value: string;
}

export interface DescribedColumn {
  name: string;
  /** The type read into the designer's catalogue (ddl-types.ts), or null when it is not one the designer offers. */
  type: TypeChoice | null;
  /** The type exactly as the database reports it (`character varying(200)`, `nvarchar(max)`, `NUMBER(12,2)`). */
  rawType: string;
  nullable: boolean;
  default: DescribedDefault | null;
  identity: boolean;
  comment: string | null;
  /** SQL Server: the name of the column's DEFAULT constraint, needed to change or drop the default. */
  defaultConstraint?: string | null;
}

export interface DescribedIndex {
  name: string;
  columns: { name: string; order?: 'asc' | 'desc' }[];
  unique: boolean;
  /** As the designer names methods (ddl.ts `indexMethods`): btree, gin, clustered, bitmap, search … */
  method: string | null;
  where: string | null;
  include: string[];
  /** The index that backs the primary key or a unique constraint: edited through the constraint, not here. */
  constraint: boolean;
}

export interface TableDescription {
  kind: 'table' | 'view';
  /** As introspection lists it (`schema.table`, BigQuery `dataset.table`). */
  name: string;
  columns: DescribedColumn[];
  primaryKey: { name: string | null; columns: string[] } | null;
  uniques: { name: string; columns: string[] }[];
  foreignKeys: { name: string; columns: string[]; refTable: string; refColumns: string[]; onDelete: string | null; onUpdate: string | null }[];
  checks: { name: string; expression: string }[];
  indexes: DescribedIndex[];
  comment: string | null;
  /** Vendor table options as sqlTableSpec.options names them (partitionBy, clusterBy, engine, strict …), when known. */
  options: Record<string, unknown>;
  /** View text, for views (read-only in the editor: views are dropped, not altered). */
  definition?: string | null;
}

export interface RoutineDescription {
  kind: 'procedure' | 'function';
  name: string;
  params: { name: string; type: TypeChoice | null; rawType: string; mode: 'in' | 'out' | 'inout' }[];
  returns: { type: TypeChoice | null; rawType: string } | null;
  language: string | null;
  /** The body as routineSpec.body takes it (without the CREATE header), so editing round-trips. */
  body: string;
  /** PostgreSQL: the argument types, to name an overloaded routine when dropping it (`integer, text`). */
  signature?: string | null;
  volatility?: 'immutable' | 'stable' | 'volatile' | null;
  deterministic?: boolean | null;
  comment: string | null;
}

/** Non-SQL objects: the definition the create form takes, read back (mongoCollectionSpec, searchIndexSpec …). */
export interface DocumentDescription {
  kind: 'collection' | 'search-index' | 'table' | 'container' | 'queue' | 'exchange' | 'stream-group';
  name: string;
  /** In the shape of the matching create schema in ddl.ts, as far as the store reports it. */
  definition: Record<string, unknown>;
  /** Indexes of a collection, table (GSIs) or container, in the matching index create shape. */
  indexes?: Record<string, unknown>[];
}

export type ObjectDescription = TableDescription | RoutineDescription | DocumentDescription;

/** What `describe` is asked for. */
export type DescribeKind = 'table' | 'view' | 'procedure' | 'function' | 'collection' | 'search-index' | 'container' | 'queue' | 'exchange' | 'stream-group';

// ---------------------------------------------------------------------------------------------------------------
// Edit and drop definitions (the console sends these; ddl-edit.ts turns them into plans)
// ---------------------------------------------------------------------------------------------------------------

const ident = z.string().trim().min(1).max(255);
const qualified = z.string().trim().min(1).max(520);

/**
 * An edited table: the table definition the create form takes (ddl.ts sqlTableSpec, without `kind` and
 * `ifNotExists`), where each column says which existing column it was (`from`; absent for a new column). An
 * existing column left out is dropped; constraints are matched by name (a new one has none or a new name). `rename`
 * renames the table last.
 */
export const alterTableSpec = z
  .object({
    kind: z.literal('alter-table'),
    /** The table as it is named now. */
    name: qualified,
    rename: ident.optional(),
    columns: z.array(z.object({ from: ident.optional() }).passthrough()).min(1).max(1000),
    primaryKey: z.array(ident).max(32).default([]),
    uniques: z.array(z.object({ name: ident.optional(), columns: z.array(ident).min(1).max(32) }).strict()).max(64).default([]),
    foreignKeys: z.array(z.object({ name: ident.optional() }).passthrough()).max(64).default([]),
    checks: z.array(z.object({ name: ident.optional(), expression: z.string().trim().min(1).max(2000) }).strict()).max(64).default([]),
    comment: z.string().max(1024).nullable().optional(),
    /** PostgreSQL: how a changed type converts existing values, per column (`USING amount::numeric`). */
    using: z.record(ident, z.string().trim().min(1).max(2000)).default({})
  })
  .strict();

/** An index replaced: the old one dropped and the new one created, in one plan. */
export const replaceIndexSpec = z.object({ kind: z.literal('replace-index'), from: ident }).passthrough();

/** Objects a drop names, per engine family (ddl-edit.ts says which an engine has). */
export const DROP_KINDS = ['table', 'view', 'index', 'procedure', 'function', 'dataset', 'collection', 'search-index', 'container', 'queue', 'exchange', 'binding', 'stream-group'] as const;

export const dropSpec = z
  .object({
    kind: z.literal('drop'),
    objectKind: z.enum(DROP_KINDS),
    name: qualified,
    /** An index's table (MySQL, SQL Server, BigQuery name the table); a stream group's stream; a binding's vhost/source. */
    on: qualified.optional(),
    /** PostgreSQL routines: the argument types when overloaded. */
    signature: z.string().max(1000).regex(/^[A-Za-z0-9_ ,.()[\]"]*$/).optional(),
    /** Drop what depends on it too (PostgreSQL, Snowflake, BigQuery datasets, Oracle CASCADE CONSTRAINTS). */
    cascade: z.boolean().default(false),
    ifExists: z.boolean().default(false),
    /** RabbitMQ: refuse to delete a queue that still has messages or consumers. */
    ifEmpty: z.boolean().default(true),
    /** RabbitMQ bindings: destination, destination type and the binding's properties key. */
    destination: z.string().max(255).optional(),
    destinationType: z.enum(['queue', 'exchange']).optional(),
    propertiesKey: z.string().max(500).optional()
  })
  .strict();

/** Edits of non-SQL objects that are not drops: the create definition again, compared with the description. */
export const editObjectSpec = z
  .object({
    kind: z.literal('edit'),
    objectKind: z.enum(['collection', 'search-index', 'table', 'container', 'stream-group']),
    name: qualified,
    /** The edited definition in the create shape (mongoCollectionSpec without kind …). */
    definition: z.record(z.string(), z.unknown())
  })
  .strict();

export const EDIT_KINDS = ['alter-table', 'replace-index', 'drop', 'edit'] as const;
export type EditKind = (typeof EDIT_KINDS)[number];

/** The new API operations edits and drops add to ddl.ts AdminOp. */
export type EditOp =
  | { op: 'mongo.collMod'; name: string; options: Record<string, unknown> }
  | { op: 'mongo.dropCollection'; name: string }
  | { op: 'mongo.dropIndex'; collection: string; index: string }
  | { op: 'opensearch.putMapping'; index: string; body: Record<string, unknown> }
  | { op: 'opensearch.putSettings'; index: string; body: Record<string, unknown> }
  | { op: 'opensearch.deleteIndex'; index: string }
  | { op: 'dynamodb.deleteTable'; input: { TableName: string } }
  | { op: 'cosmos.replaceContainer'; body: Record<string, unknown> }
  | { op: 'cosmos.deleteContainer'; id: string }
  | { op: 'cosmos.deleteDatabase'; id: string }
  | { op: 'influx.dropDatabase'; name: string }
  | { op: 'redis.xgroupDestroy'; key: string; group: string }
  | { op: 'redis.xgroupSetId'; key: string; group: string; id: string }
  | { op: 'rabbit.deleteQueue'; vhost: string; name: string; ifEmpty: boolean; ifUnused: boolean }
  | { op: 'rabbit.deleteExchange'; vhost: string; name: string; ifUnused: boolean }
  | { op: 'rabbit.unbind'; vhost: string; source: string; destination: string; destinationType: 'q' | 'e'; propertiesKey: string }
  | { op: 'bigquery.deleteDataset'; datasetId: string; deleteContents: boolean }
  | { op: 'bigquery.deleteRoutine'; datasetId: string; routineId: string };
