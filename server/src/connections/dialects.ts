import type { Classification } from './classify.js';
import { allowedMysql, allowedSql, classifyMysql, classifySql } from './classify.js';
import { classifyBigQuery } from './classify-bigquery.js';
import { classifyOracle } from './classify-oracle.js';
import { classifySnowflake } from './classify-snowflake.js';
import { classifySqlite } from './classify-sqlite.js';
import { classifyTsql } from './classify-tsql.js';
import { engineInfo, type DialectId, type Engine } from './engines.js';

/*
 * 1.9.0: SQL dialects. Each says how its text is lexed (so a saved query's `:name` placeholders are found outside
 * strings, quoted identifiers and comments), how a bound value is written in the text, how an identifier is quoted,
 * how the classifier reads it, and how an object name resolves against the connection's allow-list.
 *
 * Object names compare case-insensitively in their canonical form: `schema.table` (BigQuery: `dataset.table`), the
 * form introspection lists them in. A three-part name whose first part is the connection's own database (SQL Server,
 * Snowflake) or project (BigQuery) drops it; an unqualified name takes the dialect's home schema.
 */

export interface Lex {
  /** Backslash escapes inside strings. */
  backslash: boolean;
  /** Characters that open a string ('…' always). */
  strings: string[];
  /** Characters that open a quoted identifier, with their closing character. */
  idents: [open: string, close: string][];
  /** Line comment openers besides `--`. */
  lineComments: string[];
  /** `$$ … $$` (and `$tag$`) quoting. */
  dollar: boolean;
  /** PostgreSQL `E'…'` escape strings. */
  eStrings: boolean;
  /** Oracle `q'[…]'` alternative quoting. */
  qQuote: boolean;
  /** BigQuery `'''…'''` and `"""…"""`. */
  triple: boolean;
}

/** How a bound value appears in the text: `$1` (repeats share one), `?` (one per use), `@p1`, `:1` (one per use). */
export type PlaceholderStyle = 'dollar' | 'question' | 'at' | 'colon';

export interface SqlDialect {
  id: DialectId;
  lex: Lex;
  placeholder: PlaceholderStyle;
  quoteIdent(name: string): string;
  classify(sql: string): Classification;
}

const quoteWith = (open: string, close: string) => (name: string) =>
  name
    .split('.')
    .map((p) => open + p.split(close).join(close + close) + close)
    .join('.');

const base: Lex = { backslash: false, strings: ["'"], idents: [['"', '"']], lineComments: [], dollar: false, eStrings: false, qQuote: false, triple: false };

const DIALECTS: Record<DialectId, SqlDialect> = {
  postgres: { id: 'postgres', lex: { ...base, dollar: true, eStrings: true }, placeholder: 'dollar', quoteIdent: quoteWith('"', '"'), classify: classifySql },
  mysql: { id: 'mysql', lex: { ...base, backslash: true, strings: ["'", '"'], idents: [['`', '`']], lineComments: ['#'] }, placeholder: 'question', quoteIdent: quoteWith('`', '`'), classify: classifyMysql },
  tsql: { id: 'tsql', lex: { ...base, idents: [['"', '"'], ['[', ']']] }, placeholder: 'at', quoteIdent: quoteWith('[', ']'), classify: classifyTsql },
  oracle: { id: 'oracle', lex: { ...base, qQuote: true }, placeholder: 'colon', quoteIdent: quoteWith('"', '"'), classify: classifyOracle },
  snowflake: { id: 'snowflake', lex: { ...base, backslash: true, lineComments: ['//'], dollar: true }, placeholder: 'question', quoteIdent: quoteWith('"', '"'), classify: classifySnowflake },
  bigquery: { id: 'bigquery', lex: { ...base, backslash: true, strings: ["'", '"'], idents: [['`', '`']], lineComments: ['#'], triple: true }, placeholder: 'question', quoteIdent: quoteWith('`', '`'), classify: classifyBigQuery },
  // 1.9.99-final, Sprint 61 (B-10907): SQLite, as Cloudflare D1 runs it.
  sqlite: { id: 'sqlite', lex: { ...base, idents: [['"', '"'], ['`', '`'], ['[', ']']] }, placeholder: 'question', quoteIdent: quoteWith('"', '"'), classify: classifySqlite }
};

export const dialect = (id: DialectId): SqlDialect => DIALECTS[id];

/** The dialect of a SQL engine; null for OpenSearch and MongoDB. */
export function dialectOf(engine: Engine): SqlDialect | null {
  const d = engineInfo(engine).dialect;
  return d ? DIALECTS[d] : null;
}

/** What `canonical` needs to know about a connection. */
export interface NameContext {
  engine: Engine;
  database: string | null;
  account: string | null;
  options: Record<string, unknown>;
}

/** The schema an unqualified name resolves to (lower case), or null when a name must be qualified. */
export function homeSchema(c: NameContext): string | null {
  switch (c.engine) {
    case 'postgres':
      return 'public';
    case 'mysql':
      return c.database?.toLowerCase() ?? null;
    case 'mssql':
    case 'azure-sql':
      return String(c.options.schema ?? 'dbo').toLowerCase();
    case 'oracle':
      return String(c.options.schema ?? c.account ?? '').toLowerCase() || null;
    case 'snowflake':
      return String(c.options.schema ?? 'public').toLowerCase();
    case 'cloudflare-d1':
      return 'main'; // SQLite's own schema: `orders` and `main.orders` are one table

    default:
      return null; // BigQuery: a table is always named with its dataset
  }
}

/**
 * The canonical lower-case name of an object for SQL Server, Azure SQL, Oracle, Snowflake and BigQuery: two parts.
 * A leading database (or project) part equal to the connection's is dropped; any other is kept, and so never matches
 * an allow-list entry. Quoting is assumed removed by the classifier.
 */
export function canonical(object: string, c: NameContext): string {
  const parts = object.toLowerCase().split('.');
  const own = c.database?.toLowerCase() ?? null;
  if (parts.length === 3 && own && parts[0] === own) parts.shift();
  // SQL Server's `db..table` (default schema) arrives as three parts with an empty middle.
  if (parts.length === 2 && parts[0] === '' && (c.engine === 'mssql' || c.engine === 'azure-sql')) parts[0] = homeSchema(c) ?? '';
  if (parts.length === 1) {
    const home = homeSchema(c);
    if (home) parts.unshift(home);
  }
  return parts.join('.');
}

/** True when `object` is on the allow-list of a connection of one of the 1.9.0 SQL engines. */
export function allowedQualified(object: string, allow: string[], c: NameContext): boolean {
  const o = canonical(object, c);
  return allow.some((a) => canonical(a, c) === o);
}

/** Whether `object` is on a SQL connection's allow-list, in that engine's naming. */
export function allowedSqlObject(object: string, allow: string[], c: NameContext): boolean {
  if (c.engine === 'postgres') return allowedSql(object, allow);
  if (c.engine === 'mysql') return allowedMysql(object, allow, c.database);
  return allowedQualified(object, allow, c);
}

/** The name an introspected object is listed under for a name the user typed (knowledge sources, imports). */
export function findObject<T extends { name: string }>(objects: readonly T[], name: string, c: NameContext): T | undefined {
  const lower = name.toLowerCase();
  const exact = objects.find((o) => o.name.toLowerCase() === lower);
  if (exact) return exact;
  if (c.engine === 'postgres' || c.engine === 'mysql') {
    const home = homeSchema(c);
    return home ? objects.find((o) => o.name.toLowerCase() === `${home}.${lower}`) : undefined;
  }
  const want = canonical(name, c);
  return objects.find((o) => canonical(o.name, c) === want);
}
