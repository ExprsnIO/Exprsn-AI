import type { DialectId } from './engines.js';

/*
 * 2.0.x: the column types each SQL dialect offers in the Schema designer, with the parameters each type takes and
 * their limits, as the vendor documents them. `renderType` turns a chosen type and its parameters into the text of a
 * column definition, refusing a parameter the type does not take or one outside its range, so a CREATE TABLE never
 * carries a type the database would reject for its shape.
 *
 * Parameters:
 * - `length`: `TYPE(n)`, 1 ≤ n ≤ maxLength. `max` allowed where `allowMax` (T-SQL varchar(max)).
 * - `precision`: `TYPE(p)`, a precision or a fractional-seconds precision (time(6)), minPrecision ≤ p ≤ maxPrecision.
 * - `precision-scale`: `TYPE(p, s)` or `TYPE(p)`; minScale ≤ s ≤ min(p, maxScale) (Oracle's scale may exceed it).
 * - `values`: MySQL ENUM and SET: a list of string literals.
 * - `none`: no parameters.
 */

export type TypeGroup = 'integer' | 'decimal' | 'float' | 'text' | 'binary' | 'boolean' | 'date' | 'time' | 'timestamp' | 'interval' | 'json' | 'uuid' | 'spatial' | 'network' | 'other';
export type TypeParams = 'none' | 'length' | 'precision' | 'precision-scale' | 'values';

export interface VendorType {
  /** The type as written in DDL (upper case, except PostgreSQL's lower-case names). */
  name: string;
  group: TypeGroup;
  params: TypeParams;
  /** The parameters must be given (VARCHAR2(n), varchar(n) in MySQL). */
  required?: boolean;
  maxLength?: number;
  /** `max` is a valid length (T-SQL). */
  allowMax?: boolean;
  minPrecision?: number;
  maxPrecision?: number;
  minScale?: number;
  maxScale?: number;
  /** What the designer pre-fills. */
  defaultLength?: number;
  defaultPrecision?: number;
  defaultScale?: number;
  /** MySQL integer types: UNSIGNED and ZEROFILL apply. */
  unsigned?: boolean;
  /** The column can be an identity / auto-increment column. */
  identity?: boolean;
  /** A note the designer shows beside the type. */
  note?: string;
}

const t = (name: string, group: TypeGroup, extra: Partial<VendorType> = {}): VendorType => ({ name, group, params: 'none', ...extra });
const len = (name: string, group: TypeGroup, maxLength: number, extra: Partial<VendorType> = {}): VendorType => ({ name, group, params: 'length', maxLength, ...extra });
const prec = (name: string, group: TypeGroup, minPrecision: number, maxPrecision: number, extra: Partial<VendorType> = {}): VendorType => ({ name, group, params: 'precision', minPrecision, maxPrecision, ...extra });
const ps = (name: string, maxPrecision: number, maxScale: number, extra: Partial<VendorType> = {}): VendorType => ({ name, group: 'decimal', params: 'precision-scale', minPrecision: 1, maxPrecision, minScale: 0, maxScale, ...extra });

/** PostgreSQL 13 to 17. */
const POSTGRES: VendorType[] = [
  t('smallint', 'integer', { identity: true }),
  t('integer', 'integer', { identity: true }),
  t('bigint', 'integer', { identity: true }),
  ps('numeric', 1000, 1000, { defaultPrecision: 12, defaultScale: 2 }),
  t('real', 'float'),
  t('double precision', 'float'),
  t('money', 'decimal', { note: 'Locale-dependent; numeric is usually better.' }),
  t('boolean', 'boolean'),
  len('char', 'text', 10_485_760, { defaultLength: 1 }),
  len('varchar', 'text', 10_485_760, { defaultLength: 255 }),
  t('text', 'text'),
  t('citext', 'text', { note: 'Needs the citext extension.' }),
  t('bytea', 'binary'),
  t('date', 'date'),
  prec('time', 'time', 0, 6),
  prec('timetz', 'time', 0, 6),
  prec('timestamp', 'timestamp', 0, 6),
  prec('timestamptz', 'timestamp', 0, 6),
  t('interval', 'interval'),
  t('uuid', 'uuid'),
  t('json', 'json'),
  t('jsonb', 'json'),
  t('xml', 'other'),
  t('inet', 'network'),
  t('cidr', 'network'),
  t('macaddr', 'network'),
  t('tsvector', 'other'),
  t('point', 'spatial'),
  t('int4range', 'other'),
  t('tstzrange', 'other')
];

/** MySQL 8.0 and 8.4 (and MariaDB's common subset). */
const MYSQL: VendorType[] = [
  t('TINYINT', 'integer', { unsigned: true, identity: true }),
  t('SMALLINT', 'integer', { unsigned: true, identity: true }),
  t('MEDIUMINT', 'integer', { unsigned: true, identity: true }),
  t('INT', 'integer', { unsigned: true, identity: true }),
  t('BIGINT', 'integer', { unsigned: true, identity: true }),
  ps('DECIMAL', 65, 30, { defaultPrecision: 12, defaultScale: 2 }),
  t('FLOAT', 'float'),
  t('DOUBLE', 'float'),
  prec('BIT', 'binary', 1, 64, { defaultPrecision: 1 }),
  t('BOOLEAN', 'boolean', { note: 'An alias of TINYINT(1).' }),
  len('CHAR', 'text', 255, { defaultLength: 1 }),
  len('VARCHAR', 'text', 65_535, { required: true, defaultLength: 255, note: 'The row size limit (65,535 bytes) counts every column; utf8mb4 takes 4 bytes a character.' }),
  t('TINYTEXT', 'text'),
  t('TEXT', 'text'),
  t('MEDIUMTEXT', 'text'),
  t('LONGTEXT', 'text'),
  len('BINARY', 'binary', 255, { defaultLength: 16 }),
  len('VARBINARY', 'binary', 65_535, { required: true, defaultLength: 255 }),
  t('BLOB', 'binary'),
  t('MEDIUMBLOB', 'binary'),
  t('LONGBLOB', 'binary'),
  t('DATE', 'date'),
  prec('TIME', 'time', 0, 6),
  prec('DATETIME', 'timestamp', 0, 6),
  prec('TIMESTAMP', 'timestamp', 0, 6, { note: 'Stored in UTC, range 1970 to 2038.' }),
  t('YEAR', 'date'),
  t('JSON', 'json'),
  { name: 'ENUM', group: 'text', params: 'values', required: true },
  { name: 'SET', group: 'text', params: 'values', required: true },
  t('GEOMETRY', 'spatial'),
  t('POINT', 'spatial')
];

/** SQL Server 2017 to 2022 and Azure SQL Database. */
const TSQL: VendorType[] = [
  t('BIT', 'boolean'),
  t('TINYINT', 'integer', { identity: true }),
  t('SMALLINT', 'integer', { identity: true }),
  t('INT', 'integer', { identity: true }),
  t('BIGINT', 'integer', { identity: true }),
  ps('DECIMAL', 38, 38, { defaultPrecision: 18, defaultScale: 2, identity: true }),
  ps('NUMERIC', 38, 38, { defaultPrecision: 18, defaultScale: 2, identity: true }),
  t('MONEY', 'decimal'),
  t('SMALLMONEY', 'decimal'),
  prec('FLOAT', 'float', 1, 53),
  t('REAL', 'float'),
  len('CHAR', 'text', 8000, { defaultLength: 1 }),
  len('VARCHAR', 'text', 8000, { allowMax: true, defaultLength: 255 }),
  len('NCHAR', 'text', 4000, { defaultLength: 1 }),
  len('NVARCHAR', 'text', 4000, { allowMax: true, defaultLength: 255 }),
  len('BINARY', 'binary', 8000, { defaultLength: 16 }),
  len('VARBINARY', 'binary', 8000, { allowMax: true, defaultLength: 255 }),
  t('UNIQUEIDENTIFIER', 'uuid'),
  t('DATE', 'date'),
  prec('TIME', 'time', 0, 7),
  t('DATETIME', 'timestamp', { note: 'Prefer DATETIME2.' }),
  prec('DATETIME2', 'timestamp', 0, 7),
  prec('DATETIMEOFFSET', 'timestamp', 0, 7),
  t('SMALLDATETIME', 'timestamp'),
  t('ROWVERSION', 'binary', { note: 'One per table, set by the server.' }),
  t('XML', 'other'),
  t('SQL_VARIANT', 'other'),
  t('HIERARCHYID', 'other'),
  t('GEOGRAPHY', 'spatial'),
  t('GEOMETRY', 'spatial')
];

/** Oracle Database 19c to 23ai. */
const ORACLE: VendorType[] = [
  { name: 'NUMBER', group: 'decimal', params: 'precision-scale', minPrecision: 1, maxPrecision: 38, minScale: -84, maxScale: 127, defaultPrecision: 12, defaultScale: 2, identity: true },
  prec('FLOAT', 'float', 1, 126),
  t('BINARY_FLOAT', 'float'),
  t('BINARY_DOUBLE', 'float'),
  len('VARCHAR2', 'text', 32_767, { required: true, defaultLength: 255, note: 'Over 4000 bytes needs MAX_STRING_SIZE = EXTENDED.' }),
  len('NVARCHAR2', 'text', 16_383, { required: true, defaultLength: 255 }),
  len('CHAR', 'text', 2000, { defaultLength: 1 }),
  len('NCHAR', 'text', 1000, { defaultLength: 1 }),
  t('CLOB', 'text'),
  t('NCLOB', 'text'),
  t('BLOB', 'binary'),
  len('RAW', 'binary', 32_767, { required: true, defaultLength: 16 }),
  t('DATE', 'timestamp', { note: 'Oracle DATE holds a time of day too.' }),
  prec('TIMESTAMP', 'timestamp', 0, 9),
  prec('TIMESTAMP WITH TIME ZONE', 'timestamp', 0, 9),
  prec('TIMESTAMP WITH LOCAL TIME ZONE', 'timestamp', 0, 9),
  t('INTERVAL YEAR TO MONTH', 'interval'),
  t('INTERVAL DAY TO SECOND', 'interval'),
  t('BOOLEAN', 'boolean', { note: 'Oracle 23ai and later; use NUMBER(1) before that.' }),
  t('JSON', 'json', { note: 'Oracle 21c and later.' })
];

/** Snowflake. */
const SNOWFLAKE: VendorType[] = [
  ps('NUMBER', 38, 37, { defaultPrecision: 38, defaultScale: 0, identity: true }),
  t('INTEGER', 'integer', { identity: true, note: 'NUMBER(38,0).' }),
  t('BIGINT', 'integer', { identity: true, note: 'NUMBER(38,0).' }),
  t('SMALLINT', 'integer', { identity: true, note: 'NUMBER(38,0).' }),
  t('FLOAT', 'float'),
  t('DOUBLE', 'float'),
  len('VARCHAR', 'text', 134_217_728, { note: 'Without a length, the maximum.' }),
  len('CHAR', 'text', 134_217_728, { defaultLength: 1 }),
  t('STRING', 'text'),
  t('TEXT', 'text'),
  len('BINARY', 'binary', 67_108_864),
  t('BOOLEAN', 'boolean'),
  t('DATE', 'date'),
  prec('TIME', 'time', 0, 9),
  prec('TIMESTAMP_NTZ', 'timestamp', 0, 9),
  prec('TIMESTAMP_LTZ', 'timestamp', 0, 9),
  prec('TIMESTAMP_TZ', 'timestamp', 0, 9),
  t('VARIANT', 'json'),
  t('OBJECT', 'json'),
  t('ARRAY', 'json'),
  t('GEOGRAPHY', 'spatial'),
  t('GEOMETRY', 'spatial')
];

/** BigQuery (GoogleSQL). */
const BIGQUERY: VendorType[] = [
  t('INT64', 'integer'),
  { name: 'NUMERIC', group: 'decimal', params: 'precision-scale', minPrecision: 1, maxPrecision: 29, minScale: 0, maxScale: 9, note: 'Without parameters NUMERIC(38, 9).' },
  { name: 'BIGNUMERIC', group: 'decimal', params: 'precision-scale', minPrecision: 1, maxPrecision: 76, minScale: 0, maxScale: 38 },
  t('FLOAT64', 'float'),
  t('BOOL', 'boolean'),
  len('STRING', 'text', 2_147_483_647),
  len('BYTES', 'binary', 2_147_483_647),
  t('DATE', 'date'),
  t('TIME', 'time'),
  t('DATETIME', 'timestamp'),
  t('TIMESTAMP', 'timestamp'),
  t('INTERVAL', 'interval'),
  t('JSON', 'json'),
  t('GEOGRAPHY', 'spatial')
];

/** SQLite, as Cloudflare D1 runs it: the five storage classes (any declared type has an affinity; these are what STRICT tables accept). */
const SQLITE: VendorType[] = [
  t('INTEGER', 'integer', { identity: true, note: 'INTEGER PRIMARY KEY is the rowid.' }),
  t('REAL', 'float'),
  t('NUMERIC', 'decimal'),
  t('TEXT', 'text'),
  t('BLOB', 'binary'),
  t('ANY', 'other', { note: 'STRICT tables only.' })
];

const TYPES: Record<DialectId, VendorType[]> = { postgres: POSTGRES, mysql: MYSQL, tsql: TSQL, oracle: ORACLE, snowflake: SNOWFLAKE, bigquery: BIGQUERY, sqlite: SQLITE };

export const typesOf = (d: DialectId): VendorType[] => TYPES[d];

export const findType = (d: DialectId, name: string): VendorType | undefined => {
  const want = name.trim().toLowerCase().replace(/\s+/g, ' ');
  return TYPES[d].find((x) => x.name.toLowerCase() === want);
};

export interface TypeChoice {
  type: string;
  length?: number | 'max' | null;
  precision?: number | null;
  scale?: number | null;
  /** MySQL ENUM and SET. */
  values?: string[] | null;
  /** MySQL integer types. */
  unsigned?: boolean;
  /** PostgreSQL: an array of the type. */
  array?: boolean;
}

/** A string literal in the dialect: '' doubled, and backslashes doubled where the dialect reads escapes. */
export function stringLiteral(d: DialectId, v: string): string {
  // BigQuery reads only backslash escapes; MySQL and Snowflake read both, so backslashes are doubled there too.
  if (d === 'bigquery') return `'${v.split('\\').join('\\\\').split("'").join("\\'").split('\n').join('\\n')}'`;
  let s = v.split("'").join("''");
  if (d === 'mysql' || d === 'snowflake') s = s.split('\\').join('\\\\');
  // T-SQL and Oracle: an N'…' literal keeps Unicode in NVARCHAR columns; plain literals are fine for the rest.
  return `'${s}'`;
}

/**
 * The text of a type with its parameters, or the problem with them. `forRoutine`: Oracle routine parameters take no
 * size (VARCHAR2, not VARCHAR2(20)), nor do BigQuery's, so the parameters are dropped there.
 */
export function renderType(d: DialectId, c: TypeChoice, opts: { forRoutine?: boolean } = {}): { text: string } | { problem: string } {
  const vt = findType(d, c.type);
  if (!vt) return { problem: `${c.type} is not a ${d} type the designer offers.` };
  const has = (v: unknown) => v !== undefined && v !== null && v !== '';
  let out = vt.name;
  const extra = (what: string) => ({ problem: `${vt.name} takes no ${what}.` });
  // Oracle and BigQuery routine parameters take no size or precision (VARCHAR2, STRING, NUMERIC).
  if (opts.forRoutine && (d === 'oracle' || d === 'bigquery')) return { text: vt.name };
  switch (vt.params) {
    case 'none':
      if (has(c.length)) return extra('length');
      if (has(c.precision) || has(c.scale)) return extra('precision');
      break;
    case 'length': {
      if (has(c.precision) || has(c.scale)) return extra('precision');
      if (!has(c.length)) {
        if (vt.required) return { problem: `${vt.name} needs a length.` };
        break;
      }
      if (c.length === 'max') {
        if (!vt.allowMax) return { problem: `${vt.name} does not take max.` };
        out += '(MAX)';
        break;
      }
      const n = Number(c.length);
      if (!Number.isInteger(n) || n < 1 || n > (vt.maxLength ?? Infinity)) return { problem: `${vt.name} takes a length from 1 to ${vt.maxLength}${vt.allowMax ? ', or max' : ''}.` };
      out += `(${n})`;
      break;
    }
    case 'precision': {
      if (has(c.length) || has(c.scale)) return extra(has(c.length) ? 'length' : 'scale');
      if (!has(c.precision)) break;
      const p = Number(c.precision);
      if (!Number.isInteger(p) || p < (vt.minPrecision ?? 0) || p > (vt.maxPrecision ?? Infinity)) return { problem: `${vt.name} takes a precision from ${vt.minPrecision} to ${vt.maxPrecision}.` };
      // Oracle's TIMESTAMP WITH TIME ZONE puts the precision after TIMESTAMP.
      out = / WITH /.test(vt.name) ? vt.name.replace(/^TIMESTAMP/, `TIMESTAMP(${p})`) : `${vt.name}(${p})`;
      break;
    }
    case 'precision-scale': {
      if (has(c.length)) return extra('length');
      if (!has(c.precision)) {
        if (has(c.scale)) return { problem: `${vt.name} needs a precision with a scale.` };
        break;
      }
      const p = Number(c.precision);
      if (!Number.isInteger(p) || p < (vt.minPrecision ?? 1) || p > (vt.maxPrecision ?? Infinity)) return { problem: `${vt.name} takes a precision from ${vt.minPrecision ?? 1} to ${vt.maxPrecision}.` };
      if (has(c.scale)) {
        const s = Number(c.scale);
        const maxS = d === 'oracle' ? (vt.maxScale ?? 127) : Math.min(p, vt.maxScale ?? p);
        if (!Number.isInteger(s) || s < (vt.minScale ?? 0) || s > maxS) return { problem: `${vt.name}(${p}, s) takes a scale from ${vt.minScale ?? 0} to ${maxS}.` };
        // BigQuery: NUMERIC's precision must leave room for the scale (P - S ≤ 29, BIGNUMERIC P - S ≤ 38).
        if (d === 'bigquery' && (vt.name === 'NUMERIC' ? p - s > 29 || p < s : p - s > 38 || p < s)) return { problem: `${vt.name}(${p}, ${s}) is outside BigQuery's range.` };
        out += `(${p}, ${s})`;
      } else out += `(${p})`;
      break;
    }
    case 'values': {
      const vs = c.values ?? [];
      if (!vs.length) return { problem: `${vt.name} needs at least one value.` };
      if (vs.length > (vt.name === 'SET' ? 64 : 65_535)) return { problem: `${vt.name} takes at most ${vt.name === 'SET' ? 64 : 65_535} values.` };
      if (new Set(vs).size !== vs.length) return { problem: `${vt.name} values must be distinct.` };
      if (vt.name === 'SET' && vs.some((v) => v.includes(','))) return { problem: 'SET values cannot contain a comma.' };
      out += `(${vs.map((v) => stringLiteral(d, v)).join(', ')})`;
      break;
    }
  }
  if (c.unsigned) {
    if (!vt.unsigned) return { problem: `${vt.name} cannot be UNSIGNED.` };
    out += ' UNSIGNED';
  }
  if (c.array) {
    if (d !== 'postgres') return { problem: 'Only PostgreSQL has array columns.' };
    out += '[]';
  }
  return { text: out };
}

/** Field types of an OpenSearch mapping the designer offers. */
export const OPENSEARCH_TYPES = ['text', 'keyword', 'match_only_text', 'long', 'integer', 'short', 'byte', 'double', 'float', 'half_float', 'scaled_float', 'unsigned_long', 'boolean', 'date', 'date_nanos', 'ip', 'geo_point', 'geo_shape', 'binary', 'object', 'nested', 'flat_object', 'knn_vector'] as const;

/** BSON types a MongoDB $jsonSchema validator can require. */
export const BSON_TYPES = ['string', 'int', 'long', 'double', 'decimal', 'bool', 'date', 'timestamp', 'objectId', 'object', 'array', 'binData', 'null', 'regex', 'uuid'] as const;

/** DynamoDB key attribute types. */
export const DYNAMO_KEY_TYPES = ['S', 'N', 'B'] as const;

/** Splits `name(args) rest` at the first parenthesised group (quotes respected): the name with the group taken out, and the arguments. */
function splitTypeArgs(raw: string): { name: string; args: string[] | null } {
  const open = raw.indexOf('(');
  if (open < 0) return { name: raw, args: null };
  let depth = 0;
  let quote = false;
  let close = -1;
  for (let i = open; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote) {
      if (ch === "'" && raw[i + 1] === "'") i++;
      else if (ch === '\\') i++;
      else if (ch === "'") quote = false;
      continue;
    }
    if (ch === "'") quote = true;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close < 0) return { name: raw, args: null };
  const inner = raw.slice(open + 1, close);
  const args: string[] = [];
  let cur = '';
  quote = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (quote) {
      cur += ch;
      if (ch === "'" && inner[i + 1] === "'") cur += inner[++i];
      else if (ch === '\\' && i + 1 < inner.length) cur += inner[++i];
      else if (ch === "'") quote = false;
      continue;
    }
    if (ch === "'") quote = true;
    if (ch === ',') {
      args.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  args.push(cur.trim());
  return { name: `${raw.slice(0, open)} ${raw.slice(close + 1)}`.replace(/\s+/g, ' ').trim(), args };
}

/** MySQL ENUM / SET values: quoted strings with '' doubled and backslash escapes. */
function quotedValues(args: string[]): string[] {
  return args.map((a) => {
    const m = /^'([\s\S]*)'$/.exec(a.trim());
    if (!m) return a.trim();
    return m[1]!.replace(/''/g, "'").replace(/\\(.)/g, (_, c: string) => ({ n: '\n', t: '\t', r: '\r', '0': '\0' })[c] ?? c);
  });
}

const intArg = (a: string | undefined): number | null => {
  if (a == null) return null;
  const m = /^\s*(-?\d+)/.exec(a);
  return m ? Number(m[1]) : null;
};

/** Per dialect: names a database reports, lower case, mapped to the catalogue's name. */
const TYPE_ALIASES: Record<DialectId, Record<string, string>> = {
  postgres: {
    'character varying': 'varchar',
    character: 'char',
    bpchar: 'char',
    int: 'integer',
    int4: 'integer',
    serial: 'integer',
    serial4: 'integer',
    int2: 'smallint',
    smallserial: 'smallint',
    serial2: 'smallint',
    int8: 'bigint',
    bigserial: 'bigint',
    serial8: 'bigint',
    float4: 'real',
    float8: 'double precision',
    float: 'double precision',
    bool: 'boolean',
    decimal: 'numeric',
    'timestamp without time zone': 'timestamp',
    'timestamp with time zone': 'timestamptz',
    'time without time zone': 'time',
    'time with time zone': 'timetz'
  },
  mysql: { integer: 'int', bool: 'boolean', dec: 'decimal', numeric: 'decimal', fixed: 'decimal', real: 'double', 'double precision': 'double', 'character varying': 'varchar', character: 'char', 'national varchar': 'varchar', nvarchar: 'varchar', nchar: 'char' },
  tsql: { integer: 'int', dec: 'decimal', 'double precision': 'float', timestamp: 'rowversion', 'character varying': 'varchar', character: 'char', 'national character varying': 'nvarchar', 'national character': 'nchar', sysname: 'nvarchar' },
  oracle: { varchar: 'varchar2', 'double precision': 'float', real: 'float', decimal: 'number', numeric: 'number', 'national char': 'nchar', 'national character varying': 'nvarchar2' },
  snowflake: {
    decimal: 'number',
    numeric: 'number',
    int: 'integer',
    tinyint: 'smallint',
    byteint: 'smallint',
    float4: 'float',
    float8: 'float',
    real: 'float',
    'double precision': 'double',
    'character varying': 'varchar',
    character: 'char',
    nchar: 'char',
    nvarchar: 'varchar',
    nvarchar2: 'varchar',
    char_varying: 'varchar',
    varbinary: 'binary',
    datetime: 'timestamp_ntz',
    timestamp: 'timestamp_ntz',
    timestampntz: 'timestamp_ntz',
    timestampltz: 'timestamp_ltz',
    timestamptz: 'timestamp_tz'
  },
  bigquery: { integer: 'int64', int: 'int64', smallint: 'int64', bigint: 'int64', tinyint: 'int64', byteint: 'int64', float: 'float64', boolean: 'bool', decimal: 'numeric', bigdecimal: 'bignumeric' },
  sqlite: {}
};

/** SQLite's affinity rules (section 3.1 of "Datatypes In SQLite") for a declared type. */
function sqliteAffinity(declared: string): string | null {
  const t = declared.toUpperCase();
  if (!t.trim()) return null;
  if (t.trim() === 'ANY') return 'ANY';
  if (t.includes('INT')) return 'INTEGER';
  if (/CHAR|CLOB|TEXT/.test(t)) return 'TEXT';
  if (t.includes('BLOB')) return 'BLOB';
  if (/REAL|FLOA|DOUB/.test(t)) return 'REAL';
  return 'NUMERIC';
}

/**
 * 2.0.x editing: a column, parameter or result type as the database reports it (information_schema's type with its
 * lengths, `format_type`, COLUMN_TYPE, a type text from a catalog) read into the designer's catalogue, or null when it
 * is not a type the designer offers (PostgreSQL `ARRAY` without its element, BigQuery STRUCT and ARRAY, MySQL
 * LINESTRING …). Display widths and other parameters a catalogue type does not take are dropped (MySQL `int(11)`).
 */
export function parseType(d: DialectId, raw: string): TypeChoice | null {
  let text = raw.trim().replace(/\s+/g, ' ');
  if (!text) return null;
  if (d === 'sqlite') {
    const a = sqliteAffinity(text);
    return a ? { type: a } : null;
  }
  let array = false;
  if (d === 'postgres') {
    if (/\[\d*\](\s*\[\d*\])*$/.test(text)) {
      array = true;
      text = text.replace(/(\s*\[\d*\])+$/, '');
    } else if (/^_[a-z0-9_]+$/i.test(text)) {
      array = true;
      text = text.slice(1);
    }
    // A schema-qualified or quoted name (pg_catalog.int4, "char").
    text = text.replace(/^pg_catalog\./i, '').replace(/^"([^"]+)"$/, '$1');
  }
  if (d === 'bigquery' && /^(ARRAY|STRUCT|RECORD|RANGE)\b/i.test(text)) return null;
  let unsigned = false;
  if (d === 'mysql') {
    if (/\bunsigned\b/i.test(text)) unsigned = true;
    text = text.replace(/\b(unsigned|signed|zerofill)\b/gi, '').replace(/\s+/g, ' ').trim();
    // Character set and collation clauses (a parameter's DTD_IDENTIFIER carries them).
    text = text.replace(/\s+(CHARACTER SET|CHARSET|COLLATE)\s+\S+/gi, '').trim();
  }
  const first = splitTypeArgs(text);
  const args = first.args;
  let name = first.name;
  // Oracle: INTERVAL DAY(2) TO SECOND(6), TIMESTAMP(6) WITH TIME ZONE: the remaining groups come out too.
  if (d === 'oracle') {
    let more = splitTypeArgs(name);
    while (more.args) {
      name = more.name;
      more = splitTypeArgs(name);
    }
  }
  let key = name.toLowerCase().replace(/\s+/g, ' ').trim();
  // MySQL: TINYINT(1) is how BOOLEAN is stored.
  if (d === 'mysql' && key === 'tinyint' && args && intArg(args[0]) === 1) return { type: 'BOOLEAN' };
  if (d === 'tsql' && key === 'sysname') return { type: 'NVARCHAR', length: 128 };
  // Oracle: INTEGER, INT and SMALLINT are NUMBER(*,0), reported as NUMBER with scale 0.
  if (d === 'oracle' && (key === 'integer' || key === 'int' || key === 'smallint')) return { type: 'NUMBER', precision: 38, scale: 0 };
  key = TYPE_ALIASES[d][key] ?? key;
  const vt = TYPES[d].find((x) => x.name.toLowerCase() === key);
  if (!vt) return null;
  const out: TypeChoice = { type: vt.name };
  switch (vt.params) {
    case 'length': {
      const a = args?.[0];
      if (a != null && a !== '') {
        if (/^max$/i.test(a) || a === '-1') out.length = vt.allowMax ? 'max' : null;
        else {
          const n = intArg(a);
          if (n != null) out.length = n;
        }
      }
      break;
    }
    case 'precision': {
      const p = intArg(args?.[0]);
      if (p != null) out.precision = p;
      break;
    }
    case 'precision-scale': {
      if (args?.length) {
        const p = args[0]!.trim() === '*' ? (d === 'oracle' ? 38 : null) : intArg(args[0]);
        const s = intArg(args[1]);
        if (p != null) out.precision = p;
        if (s != null && p != null) out.scale = s;
      }
      break;
    }
    case 'values':
      out.values = args ? quotedValues(args) : [];
      break;
    default:
      break;
  }
  if (unsigned && vt.unsigned) out.unsigned = true;
  if (array) out.array = true;
  return out;
}
