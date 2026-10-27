import { classifySql, type Classification } from './classify.js';

/*
 * 1.9.0: T-SQL (SQL Server and Azure SQL). As for MySQL, the text is first rewritten into the PostgreSQL form the
 * parser reads: every string (also N'…') becomes an empty literal, [bracket] identifiers become "double-quoted" ones,
 * comments (nested /* … *\/ and --) become a space, `::` (static methods such as geography::Point) becomes `.`, `$` a
 * space, and APPLY is read as JOIN so that what it applies is checked as a table reference. What T-SQL can do that the
 * PostgreSQL parser would not recognise is refused before that: a second statement (T-SQL needs no `;` between them,
 * and GO separates batches), EXEC and every write verb, settings, transaction and server verbs, rowset providers
 * that reach files or other servers (OPENROWSET, OPENQUERY, OPENDATASOURCE, OPENXML), extended and system procedures
 * (xp_, sp_), the functions that read trace and audit files, and table hints that take update or exclusive locks.
 * Objects come back without brackets; `db..table` keeps its empty middle part, which dialects.ts resolves to the
 * default schema.
 */

/** Verbs that write data. */
const WRITE = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'BULK', 'EXEC', 'EXECUTE', 'WRITETEXT', 'UPDATETEXT', 'OUTPUT', 'INTO', 'TRUNCATE']);
/** Verbs that change the schema, settings, permissions, transaction state or the server. */
const DDL = new Set([
  'CREATE', 'DROP', 'ALTER', 'GRANT', 'DENY', 'REVOKE', 'SET', 'USE', 'DBCC', 'BACKUP', 'RESTORE', 'KILL', 'SHUTDOWN', 'RECONFIGURE', 'WAITFOR', 'DECLARE', 'BEGIN', 'COMMIT',
  'ROLLBACK', 'SAVE', 'CHECKPOINT', 'PRINT', 'RAISERROR', 'THROW', 'OPEN', 'CLOSE', 'DEALLOCATE', 'READTEXT', 'GO', 'RETURN', 'GOTO', 'ENABLE', 'DISABLE', 'ADD', 'SETUSER', 'REVERT'
]);
/** Verbs that start a statement wherever they stand at depth 0: their presence after the first statement means a second one. */
const STATEMENT_START = new Set([...WRITE, 'CREATE', 'DROP', 'ALTER', 'GRANT', 'DENY', 'REVOKE', 'SET', 'USE', 'DBCC', 'BACKUP', 'RESTORE', 'KILL', 'SHUTDOWN', 'RECONFIGURE', 'WAITFOR', 'DECLARE', 'BEGIN', 'COMMIT', 'ROLLBACK', 'PRINT', 'RAISERROR', 'THROW', 'CHECKPOINT']);
/** Words that may stand before a SELECT at depth 0 without it starting another statement. */
const SELECT_JOINERS = new Set(['UNION', 'ALL', 'EXCEPT', 'INTERSECT']);
/** Rowset providers, procedures and functions that reach files, other servers or the operating system. */
const DANGEROUS = /^(openrowset|openquery|opendatasource|openxml|xp_\w*|sp_\w*|fn_get_audit_file|fn_xe_file_target_read_file|fn_xe_telemetry_blob_target_read_file|fn_trace_gettable|fn_dblog|fn_dump_dblog|fn_virtualfilestats|fn_get_sql)$/i;
/** Table hints that take update or exclusive locks, or hold them. */
const LOCK_HINTS = new Set(['UPDLOCK', 'XLOCK', 'TABLOCKX', 'HOLDLOCK', 'SERIALIZABLE', 'REPEATABLEREAD']);

/** The placeholder for the empty schema of `db..table`, removed again from the objects. */
const DEFAULT_SCHEMA = '__exprsn_default_schema__';

interface Rewritten {
  out: string;
  problem?: Classification;
}

function rewrite(sql: string): Rewritten {
  let out = '';
  let i = 0;
  const s = sql;
  const unparsed = (reason: string): Rewritten => ({ out: '', problem: { kind: 'unparsed', verb: null, objects: [], reason } });
  while (i < s.length) {
    const c = s[i]!;
    if (c === '/' && s[i + 1] === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < s.length && depth) {
        if (s[j] === '/' && s[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (s[j] === '*' && s[j + 1] === '/') {
          depth--;
          j += 2;
        } else j++;
      }
      if (depth) return unparsed('The query has an unterminated comment.');
      out += ' ';
      i = j;
    } else if (c === '-' && s[i + 1] === '-') {
      const nl = s.indexOf('\n', i);
      out += ' ';
      i = nl < 0 ? s.length : nl;
    } else if (c === "'" || ((c === 'N' || c === 'n') && s[i + 1] === "'" && !/[A-Za-z0-9_@#$]/.test(s[i - 1] ?? ''))) {
      let j = c === "'" ? i + 1 : i + 2;
      let closed = false;
      while (j < s.length) {
        if (s[j] === "'" && s[j + 1] === "'") j += 2;
        else if (s[j] === "'") {
          closed = true;
          j++;
          break;
        } else j++;
      }
      if (!closed) return unparsed('The query has an unterminated string.');
      out += " '' ";
      i = j;
    } else if (c === '[' || c === '"') {
      const close = c === '[' ? ']' : '"';
      let j = i + 1;
      let v = '';
      let closed = false;
      while (j < s.length) {
        if (s[j] === close && s[j + 1] === close) {
          v += close;
          j += 2;
        } else if (s[j] === close) {
          closed = true;
          j++;
          break;
        } else v += s[j++];
      }
      if (!closed) return unparsed('The query has an unterminated identifier.');
      if (!v.length) return unparsed('The query has an empty identifier.');
      out += '"' + v.replace(/"/g, '""') + '"';
      i = j;
    } else if (c === ':' && s[i + 1] === ':') {
      out += '.';
      i += 2;
    } else if (c === '$') {
      out += ' ';
      i++;
    } else if (c === '.' && s[i + 1] === '.' && s[i + 2] !== '.') {
      // `db..table`: the default schema, kept as an explicit empty part.
      out += `."${DEFAULT_SCHEMA}".`;
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  return { out };
}

interface Word {
  v: string;
  depth: number;
  /** The previous significant token (a word in upper case, or a punctuation character). */
  prev: string;
}

/** Bare words of the rewritten text (quoted identifiers and strings skipped) with their parenthesis depth. */
function words(text: string): Word[] {
  const out: Word[] = [];
  let depth = 0;
  let prev = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '"' && text[j + 1] === '"') j += 2;
        else if (text[j] === '"') break;
        else j++;
      }
      i = j + 1;
      prev = '"';
    } else if (c === "'") {
      i += 2; // always '' after the rewrite
      prev = "'";
    } else if (/[A-Za-z_@#]/.test(c)) {
      const m = /^[A-Za-z_@#][A-Za-z0-9_@#$]*/.exec(text.slice(i))!;
      const v = m[0];
      out.push({ v, depth, prev });
      prev = v.toUpperCase();
      i += v.length;
    } else if (/\s/.test(c)) i++;
    else {
      if (c === '(') depth++;
      else if (c === ')') depth--;
      if (!/[0-9]/.test(c)) prev = c;
      i++;
    }
  }
  return out;
}

/** T-SQL (SQL Server, Azure SQL). */
export function classifyTsql(sql: string): Classification {
  if (/^[ \t]*GO(?:[ \t]+\d+)?[ \t]*;?[ \t]*$/im.test(sql)) return { kind: 'multiple', verb: null, objects: [], reason: 'GO separates batches; send one statement at a time.' };
  const r = rewrite(sql);
  if (r.problem) return r.problem;
  const ws = words(r.out);
  if (!ws.length) return { kind: 'unparsed', verb: null, objects: [], reason: 'The query is empty.' };
  const first = ws[0]!.v.toUpperCase();
  for (const w of ws) {
    if (DANGEROUS.test(w.v) || (/^fn_/i.test(w.v) && w.prev === '.')) return { kind: 'denied', verb: first, objects: [], denied: `${w.v.toLowerCase()}()`, reason: `${w.v} reaches files, other servers or the server itself; it is not allowed.` };
  }
  if (WRITE.has(first)) return { kind: 'write', verb: first === 'EXEC' ? 'EXECUTE' : first, objects: [], reason: first === 'EXEC' || first === 'EXECUTE' ? 'EXECUTE runs a procedure, which may write.' : 'The statement writes data.' };
  if (DDL.has(first)) return { kind: 'ddl', verb: first, objects: [], reason: `A ${first} statement changes the schema, settings, permissions or transaction state.` };
  let heads = 0;
  for (let k = 0; k < ws.length; k++) {
    const w = ws[k]!;
    const u = w.v.toUpperCase();
    if (k > 0 && w.depth === 0 && STATEMENT_START.has(u)) {
      if (WRITE.has(u)) return { kind: 'write', verb: u === 'INTO' ? 'SELECT INTO' : u === 'EXEC' ? 'EXECUTE' : u, objects: [], reason: u === 'INTO' ? 'SELECT INTO creates a table.' : u === 'OUTPUT' ? 'An OUTPUT clause belongs to a statement that writes.' : 'The statement writes data.' };
      return { kind: 'multiple', verb: u, objects: [], reason: 'Send one statement at a time.' };
    }
    if (WRITE.has(u)) return { kind: 'write', verb: u === 'INTO' ? 'SELECT INTO' : u === 'EXEC' ? 'EXECUTE' : u, objects: [], reason: u === 'INTO' ? 'SELECT INTO creates a table.' : 'The statement writes data.' };
    if (LOCK_HINTS.has(u)) return { kind: 'write', verb: `WITH (${u})`, objects: [], reason: `The ${u} hint takes or holds locks a read does not need.` };
    if (u === 'SELECT' && w.depth === 0 && !SELECT_JOINERS.has(w.prev)) heads++;
    if (heads > 1) return { kind: 'multiple', verb: 'SELECT', objects: [], reason: 'Send one statement at a time.' };
  }
  // APPLY applies a table expression: read it as a JOIN so a table-valued function in it is checked.
  const text = r.out.replace(/("(?:[^"]|"")*"|'')|\bAPPLY\b/gi, (m, q: string | undefined) => (q ? m : 'JOIN'));
  const cl = classifySql(text);
  const objects = cl.objects.map((o) => o.split(`.${DEFAULT_SCHEMA}.`).join('..'));
  return { ...cl, objects };
}
