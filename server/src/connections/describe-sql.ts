import type { DescribedDefault, RoutineDescription, TableDescription } from './ddl-edit-types.js';

/*
 * 2.0.x editing: the pieces the SQL drivers' `describe` share. Reading a catalog is each driver's own; what it reads
 * (a default's text, a CHECK's definition, a routine's source) is turned into the description's shape here, so the
 * rules are the same everywhere and are tested without a database.
 */

/** An empty table description, filled in by a driver. */
export const emptyTable = (kind: 'table' | 'view', name: string): TableDescription => ({ kind, name, columns: [], primaryKey: null, uniques: [], foreignKeys: [], checks: [], indexes: [], comment: null, options: {} });

/** True when `s` is wrapped in one pair of parentheses that spans all of it (quotes respected). */
export function wrappedInParens(s: string): boolean {
  const t = s.trim();
  if (!t.startsWith('(') || !t.endsWith(')')) return false;
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (quote) {
      if (ch === quote && t[i + 1] === quote) i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0 && i < t.length - 1) return false;
    }
  }
  return depth === 0;
}

/** Outer parentheses taken off, as many pairs as wrap the whole text (`((0))` → `0`). */
export function unwrapParens(s: string): string {
  let t = s.trim();
  while (wrappedInParens(t)) t = t.slice(1, -1).trim();
  return t;
}

/** A CHECK constraint's expression without `CHECK (` … `)` and a trailing NOT VALID / NOT ENFORCED. */
export function checkExpression(def: string): string {
  let t = def.trim().replace(/\s+NOT\s+(VALID|ENFORCED|DEFERRABLE)\b.*$/i, '');
  const m = /^CHECK\s*([\s\S]*)$/i.exec(t);
  if (m) t = m[1]!.trim();
  if (wrappedInParens(t)) t = t.slice(1, -1).trim();
  return t;
}

/** A quoted string literal (`'it''s'`, T-SQL `N'…'`, PostgreSQL `E'…'`) read to its value, or null when `s` is not one whole literal. */
function readQuoted(s: string): { value: string; rest: string } | null {
  const m = /^([NE]?)'/i.exec(s);
  if (!m) return null;
  const escapes = m[1]!.toUpperCase() === 'E';
  let out = '';
  for (let i = m[0].length; i < s.length; i++) {
    const ch = s[i]!;
    if (escapes && ch === '\\' && i + 1 < s.length) {
      const n = s[++i]!;
      out += ({ n: '\n', t: '\t', r: '\r' } as Record<string, string>)[n] ?? n;
      continue;
    }
    if (ch === "'") {
      if (s[i + 1] === "'") {
        out += "'";
        i++;
        continue;
      }
      return { value: out, rest: s.slice(i + 1) };
    }
    out += ch;
  }
  return null;
}

const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
/** PostgreSQL casts after a literal: `::character varying`, `::numeric(12,2)`, `::text[]`. */
const CASTS = /^(\s*::\s*"?[A-Za-z_][A-Za-z0-9_ ."]*(\(\s*\d+(\s*,\s*\d+)?\s*\))?(\s*with(out)? time zone)?(\[\])*)+$/i;

/**
 * A column default as a catalog reports it, classified: a plain number, quoted string or boolean is a literal (its
 * value as text, quotes, casts and wrapping parentheses removed); NULL is no default; anything else is an expression
 * (`now()`, `nextval(…)`, `CURRENT_TIMESTAMP`, `getdate()`), given with its wrapping parentheses removed.
 */
export function classifyDefault(raw: string | null | undefined): DescribedDefault | null {
  if (raw == null) return null;
  const t = unwrapParens(String(raw));
  if (!t) return null;
  if (/^null$/i.test(t) || /^null\s*::/i.test(t)) return null;
  if (NUMBER.test(t)) return { kind: 'literal', value: t.replace(/^\+/, '') };
  if (/^(true|false)$/i.test(t)) return { kind: 'literal', value: t.toLowerCase() };
  const q = readQuoted(t);
  if (q && (!q.rest.trim() || CASTS.test(q.rest))) return { kind: 'literal', value: q.value };
  // A number cast to a type: `(0)::numeric`, `'-1'::integer` is handled above.
  const cast = /^\(?([+-]?[\d.]+(?:[eE][+-]?\d+)?)\)?(\s*::[\s\S]+)$/.exec(t);
  if (cast && NUMBER.test(cast[1]!) && CASTS.test(cast[2]!)) return { kind: 'literal', value: cast[1]!.replace(/^\+/, '') };
  if (/^(true|false)\s*::\s*boolean$/i.test(t)) return { kind: 'literal', value: t.split(/\s*::/)[0]!.toLowerCase() };
  return { kind: 'expression', value: t };
}

/** A referential action as the contract names it, or null. */
export function fkAction(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = String(raw).trim().toUpperCase().replace(/_/g, ' ');
  return ['CASCADE', 'SET NULL', 'NO ACTION', 'RESTRICT', 'SET DEFAULT'].includes(t) ? t : null;
}

/** An identifier with a pair of quotes taken off (`"Name"` → `Name`, `[x]` → `x`, `` `y` `` → `y`). */
export const unquoteIdent = (s: string): string => {
  const t = s.trim();
  if (/^".*"$/.test(t)) return t.slice(1, -1).replace(/""/g, '"');
  if (/^\[.*\]$/.test(t)) return t.slice(1, -1).replace(/]]/g, ']');
  if (/^`.*`$/.test(t)) return t.slice(1, -1).replace(/``/g, '`');
  return t;
};

/** Splits `a.b` at the first dot outside quotes: [schema, name], or [null, name]. */
export function splitQualified(object: string): [string | null, string] {
  let quote: string | null = null;
  for (let i = 0; i < object.length; i++) {
    const ch = object[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === '`' || ch === '[') quote = ch === '[' ? ']' : ch;
    else if (ch === '.') return [unquoteIdent(object.slice(0, i)), unquoteIdent(object.slice(i + 1))];
  }
  return [null, unquoteIdent(object)];
}

/** `name(sig)`: a routine named with its argument types (PostgreSQL overloads); the signature is null without one. */
export function routineName(object: string): { name: string; signature: string | null } {
  const m = /^([^()]+)\(([\s\S]*)\)\s*$/.exec(object.trim());
  return m ? { name: m[1]!.trim(), signature: m[2]!.trim() } : { name: object.trim(), signature: null };
}

/** Top-level comma split (parentheses and quotes respected). */
export function splitTopLevel(s: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === sep && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The first trailing and leading line break around a body that the designer's CREATE put there taken off. */
export const trimBody = (body: string): string => {
  const t = body.replace(/\r\n/g, '\n');
  // A body on its own lines keeps its first line's indentation; one that follows the header on its line does not.
  return (/^[ \t]*\n/.test(t) ? t.replace(/^[ \t]*\n/, '') : t.replace(/^[ \t]+/, '')).replace(/\s+$/, '');
};

/**
 * Index of the first top-level keyword (`AS`, `IS`) in `text` at or after `from`: outside quotes, comments, brackets
 * and parentheses. -1 when there is none.
 */
export function topLevelKeyword(text: string, words: string[], from = 0): { index: number; word: string } | null {
  let depth = 0;
  const re = new RegExp(`^(${words.join('|')})\\b`, 'i');
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "'" || ch === '"' || ch === '[' || ch === '`') {
      const close = ch === '[' ? ']' : ch;
      const end = text.indexOf(close, i + 1);
      if (end < 0) return null;
      i = end;
      continue;
    }
    if (ch === '-' && text[i + 1] === '-') {
      const end = text.indexOf('\n', i);
      if (end < 0) return null;
      i = end;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) return null;
      i = end + 1;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && (i === 0 || !/[A-Za-z0-9_$#@]/.test(text[i - 1]!))) {
      const m = re.exec(text.slice(i));
      if (m) return { index: i, word: m[1]!.toUpperCase() };
    }
  }
  return null;
}

/**
 * SQL Server: a routine's body from `sys.sql_modules.definition`, as routineSpec.body takes it. The designer's own
 * wrapper (`AS BEGIN SET NOCOUNT ON; … END` for procedures, `AS BEGIN … END` for functions) is taken off; otherwise
 * the text after the header's `AS`.
 */
export function tsqlRoutineBody(definition: string, kind: 'procedure' | 'function'): string {
  const text = definition.replace(/\r\n/g, '\n');
  // The header ends at the first top-level AS after the name (after RETURNS for a function).
  const head = /\b(CREATE|ALTER)\s+(OR\s+ALTER\s+)?(PROC|PROCEDURE|FUNCTION)\b/i.exec(text);
  let from = head ? head.index + head[0].length : 0;
  if (kind === 'function') {
    const r = topLevelKeyword(text, ['RETURNS'], from);
    if (r) from = r.index + 7;
  }
  const as = topLevelKeyword(text, ['AS'], from);
  if (!as) return trimBody(text);
  const after = text.slice(as.index + 2);
  const wrapped = kind === 'procedure' ? /^\s*BEGIN\s*\n\s*SET NOCOUNT ON;[ \t]*\n([\s\S]*)\nEND\s*;?\s*$/i.exec(after) : /^\s*BEGIN[ \t]*\n([\s\S]*)\nEND\s*;?\s*$/i.exec(after);
  if (wrapped) return wrapped[1]!.replace(/\s+$/, '');
  return trimBody(after);
}

/** Oracle: a routine's body from ALL_SOURCE (the lines joined), the text after the header's IS or AS. */
export function oracleRoutineBody(source: string): string {
  const text = source.replace(/\r\n/g, '\n');
  const head = /\b(PROCEDURE|FUNCTION)\b/i.exec(text);
  const kw = topLevelKeyword(text, ['IS', 'AS'], head ? head.index + head[0].length : 0);
  if (!kw) return trimBody(text);
  return trimBody(text.slice(kw.index + kw.word.length));
}

/** MySQL: a routine's body from SHOW CREATE … (when ROUTINE_DEFINITION is hidden): from the body's BEGIN on. */
export function mysqlBodyFromCreate(create: string): string {
  const text = create.replace(/\r\n/g, '\n');
  const m = /\n\s*(BEGIN\b[\s\S]*)$/i.exec(text) ?? /\b(BEGIN\b[\s\S]*)$/i.exec(text);
  if (m) return m[1]!.trim();
  // A single-statement body: the last line.
  return text.split('\n').pop()!.trim();
}

/** Routine parameter modes from a vendor's names. */
export function paramMode(raw: string | null | undefined): 'in' | 'out' | 'inout' {
  const t = String(raw ?? 'IN').trim().toUpperCase().replace(/[\s/]/g, '');
  if (t === 'OUT' || t === 'O') return 'out';
  if (t === 'INOUT' || t === 'B') return 'inout';
  return 'in';
}

/** An empty routine description, filled in by a driver. */
export const emptyRoutine = (kind: 'procedure' | 'function', name: string): RoutineDescription => ({ kind, name, params: [], returns: null, language: null, body: '', comment: null });

/** SQLite: the parts of a CREATE TABLE text describe needs (constraint names, checks, options); best-effort. */
export function sqliteCreateParts(sql: string): {
  checks: { name: string; expression: string }[];
  named: { kind: 'pk' | 'unique' | 'fk'; name: string; columns: string[] }[];
  strict: boolean;
  withoutRowid: boolean;
  autoincrement: boolean;
} {
  const open = sql.indexOf('(');
  const out = { checks: [] as { name: string; expression: string }[], named: [] as { kind: 'pk' | 'unique' | 'fk'; name: string; columns: string[] }[], strict: false, withoutRowid: false, autoincrement: /\bAUTOINCREMENT\b/i.test(sql) };
  if (open < 0) return out;
  // The body ends at the parenthesis that closes the first one.
  let depth = 0;
  let close = -1;
  let quote: string | null = null;
  for (let i = open; i < sql.length; i++) {
    const ch = sql[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '[') quote = ']';
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close < 0) return out;
  const tail = sql.slice(close + 1);
  out.strict = /\bSTRICT\b/i.test(tail);
  out.withoutRowid = /\bWITHOUT\s+ROWID\b/i.test(tail);
  const ident = `("(?:[^"]|"")+"|\`[^\`]+\`|\\[[^\\]]+\\]|[A-Za-z_][A-Za-z0-9_$]*)`;
  for (const part of splitTopLevel(sql.slice(open + 1, close))) {
    // Each CHECK in the part (a column may carry one), with the CONSTRAINT name in front of it when there is one.
    const re = new RegExp(`(?:\\bCONSTRAINT\\s+${ident}\\s+)?\\bCHECK\\s*\\(`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(part))) {
      const start = m.index + m[0].length - 1;
      let d = 0;
      let end = -1;
      let q: string | null = null;
      for (let i = start; i < part.length; i++) {
        const ch = part[i]!;
        if (q) {
          if (ch === q) q = null;
          continue;
        }
        if (ch === "'" || ch === '"') q = ch;
        else if (ch === '(') d++;
        else if (ch === ')' && --d === 0) {
          end = i;
          break;
        }
      }
      if (end < 0) break;
      out.checks.push({ name: m[1] ? unquoteIdent(m[1]) : '', expression: part.slice(start + 1, end).trim() });
      re.lastIndex = end;
    }
    const c = new RegExp(`^CONSTRAINT\\s+${ident}\\s+(PRIMARY\\s+KEY|UNIQUE|FOREIGN\\s+KEY)\\s*\\(([^)]*)\\)`, 'i').exec(part.trim());
    if (c) {
      const kind = /^PRIMARY/i.test(c[2]!) ? 'pk' : /^UNIQUE/i.test(c[2]!) ? 'unique' : 'fk';
      out.named.push({ kind, name: unquoteIdent(c[1]!), columns: splitTopLevel(c[3]!).map((x) => unquoteIdent(x.replace(/\s+(ASC|DESC|COLLATE\s+\S+)$/i, ''))) });
    }
  }
  return out;
}

/** The predicate of a partial index from its CREATE INDEX text (`… WHERE deleted = 0`), or null. */
export function indexPredicate(sql: string | null | undefined): string | null {
  if (!sql) return null;
  const kw = topLevelKeyword(sql, ['WHERE']);
  return kw ? sql.slice(kw.index + 5).trim() || null : null;
}

/** A view's SELECT from its CREATE VIEW text (SQLite, SQL Server), or the text as it is. */
export function viewSelect(sql: string): string {
  const head = /^\s*CREATE\s+(OR\s+(REPLACE|ALTER)\s+)?(TEMP(ORARY)?\s+)?VIEW\b/i.exec(sql);
  if (!head) return sql.trim();
  const as = topLevelKeyword(sql, ['AS'], head[0].length);
  return as ? sql.slice(as.index + 2).trim() : sql.trim();
}

/** SQL Server: a column's type text from sys.columns (nvarchar lengths are bytes: 2 a character; -1 is max). */
export function tsqlTypeText(name: string, maxLength: number, precision: number, scale: number): string {
  const n = name.toLowerCase();
  if (['varchar', 'char', 'varbinary', 'binary'].includes(n)) return `${n}(${maxLength === -1 ? 'max' : maxLength})`;
  if (['nvarchar', 'nchar'].includes(n)) return `${n}(${maxLength === -1 ? 'max' : Math.floor(maxLength / 2)})`;
  if (n === 'decimal' || n === 'numeric') return `${n}(${precision},${scale})`;
  if (['datetime2', 'time', 'datetimeoffset'].includes(n)) return `${n}(${scale})`;
  if (n === 'float') return `float(${precision})`;
  return n;
}

/** Oracle: a column's type text from ALL_TAB_COLUMNS. */
export function oracleTypeText(o: { dataType: string; dataLength: number | null; charLength: number | null; charUsed: string | null; precision: number | null; scale: number | null }): string {
  const t = o.dataType.toUpperCase();
  if (t === 'VARCHAR2' || t === 'CHAR') return `${t}(${o.charLength ?? o.dataLength}${o.charUsed === 'C' ? ' CHAR' : ' BYTE'})`;
  if (t === 'NVARCHAR2' || t === 'NCHAR') return `${t}(${o.charLength ?? o.dataLength})`;
  if (t === 'RAW') return `RAW(${o.dataLength})`;
  if (t === 'NUMBER') {
    if (o.precision == null) return o.scale === 0 ? 'NUMBER(*,0)' : 'NUMBER';
    return `NUMBER(${o.precision},${o.scale ?? 0})`;
  }
  if (t === 'FLOAT' && o.precision != null) return `FLOAT(${o.precision})`;
  return o.dataType;
}

/** Snowflake: a column's type text from INFORMATION_SCHEMA.COLUMNS (TEXT with a length is VARCHAR(n)). */
export function snowflakeTypeText(o: { dataType: string; length: number | null; precision: number | null; scale: number | null; datetimePrecision: number | null }): string {
  const t = o.dataType.toUpperCase();
  if ((t === 'TEXT' || t === 'VARCHAR') && o.length != null) return `VARCHAR(${o.length})`;
  if (t === 'BINARY' && o.length != null) return `BINARY(${o.length})`;
  if (t === 'NUMBER' && o.precision != null) return `NUMBER(${o.precision},${o.scale ?? 0})`;
  if (/^(TIMESTAMP_(NTZ|LTZ|TZ)|TIME)$/.test(t) && o.datetimePrecision != null) return `${t}(${o.datetimePrecision})`;
  return t;
}
