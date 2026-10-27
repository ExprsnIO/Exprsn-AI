import { classifySql, type Classification } from './classify.js';

/*
 * 1.9.99-final, Sprint 61 (B-10907): SQLite SQL, as Cloudflare D1 runs it. SQLite lexes differently from PostgreSQL:
 * identifiers may be quoted with "…", `…` or […], strings take a doubled quote (never a backslash), and `--` and
 * `/* … *\/` are comments. The text is rewritten into the form `classifySql` reads (every string an empty literal,
 * every comment a space, every identifier "…"), refusing first what only SQLite has:
 *
 * - writes `classifySql` does not know (REPLACE INTO, INSERT OR …, UPSERT) and SQLite's own statements: PRAGMA,
 *   ATTACH and DETACH (another database file), VACUUM (INTO a file), REINDEX, ANALYZE, savepoints and transactions;
 * - functions that read or write files, load code or list the schema outside the allow-list: load_extension,
 *   readfile, writefile, edit, fts3_tokenizer, the pragma_* table-valued functions and sqlite_* functions;
 * - the schema tables (sqlite_schema, sqlite_master, D1's _cf_* tables) are objects like any other, so they are
 *   refused unless the allow-list names them.
 *
 * D1 has no read-only role and the query API runs one statement outside any read-only transaction, so this
 * classification is what keeps a D1 connection read-only: a refused statement is never sent.
 */

const WRITE_VERBS = new Set(['INSERT', 'REPLACE', 'UPDATE', 'DELETE', 'UPSERT']);
const DDL_VERBS = new Set(['CREATE', 'DROP', 'ALTER', 'ATTACH', 'DETACH', 'PRAGMA', 'VACUUM', 'REINDEX', 'ANALYZE', 'BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE']);
const DANGEROUS_FN = /^(load_extension|readfile|writefile|edit|fts3_tokenizer|zipfile|sqlar_\w*|pragma_\w+|sqlite_\w+)$/i;

const fail = (kind: Classification['kind'], reason: string, verb: string | null = null, denied?: string): Classification => ({ kind, verb, objects: [], reason, ...(denied ? { denied } : {}) });

/** SQLite SQL (Cloudflare D1), classified as `classifySql` reads it after the rewrite. */
export function classifySqlite(sql: string): Classification {
  let out = '';
  let i = 0;
  const s = sql;
  const quoted = (close: string, start: number): { v: string; end: number } | null => {
    let j = start;
    let v = '';
    while (j < s.length) {
      if (s[j] === close && close !== ']' && s[j + 1] === close) {
        v += close;
        j += 2;
      } else if (s[j] === close) return { v, end: j + 1 };
      else v += s[j++];
    }
    return null;
  };
  while (i < s.length) {
    const c = s[i]!;
    if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      if (end < 0) return fail('unparsed', 'The query has an unterminated comment.');
      out += ' ';
      i = end + 2;
    } else if (c === '-' && s[i + 1] === '-') {
      const nl = s.indexOf('\n', i);
      out += ' ';
      i = nl < 0 ? s.length : nl;
    } else if (c === "'") {
      const q = quoted("'", i + 1);
      if (!q) return fail('unparsed', 'The query has an unterminated string.');
      out += "''";
      i = q.end;
    } else if (c === '"' || c === '`' || c === '[') {
      const q = quoted(c === '[' ? ']' : c, i + 1);
      if (!q) return fail('unparsed', 'The query has an unterminated identifier.');
      out += `"${q.v.replace(/"/g, '""')}"`;
      i = q.end;
    } else if ((c === '?' || c === ':' || c === '@' || c === '$') && /[A-Za-z0-9_]/.test(s[i + 1] ?? '') && (c === '?' || !/[A-Za-z0-9_]/.test(s[i - 1] ?? ''))) {
      // A bound parameter (?1, :name, @name, $name): a literal for the classifier.
      let j = i + 1;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j]!)) j++;
      out += "''";
      i = j;
    } else {
      out += c;
      i++;
    }
  }
  const words = out.match(/[A-Za-z_][A-Za-z0-9_$]*|[();]/g) ?? [];
  let first = 0;
  while (words[first] === '(') first++;
  const verb = (words[first] ?? '').toUpperCase();
  if (!verb) return fail('unparsed', 'The query is empty.');
  if (verb === 'WITH') {
    // A CTE list followed by a write: WITH x AS (…) INSERT/REPLACE/UPDATE/DELETE …
    let depth = 0;
    for (let k = first + 1; k < words.length; k++) {
      const w = words[k]!;
      if (w === '(') depth++;
      else if (w === ')') depth--;
      else if (depth === 0 && WRITE_VERBS.has(w.toUpperCase()) && (w.toUpperCase() !== 'REPLACE' || /^into$/i.test(words[k + 1] ?? ''))) return fail('write', 'The statement writes data.', w.toUpperCase());
    }
  }
  if (WRITE_VERBS.has(verb)) return fail('write', 'The statement writes data.', verb);
  if (DDL_VERBS.has(verb)) return fail('ddl', `A ${verb} statement changes the schema, the database files or the transaction state.`, verb);
  if (verb === 'EXPLAIN') return fail('denied', 'EXPLAIN shows the plan of a statement, which may be a write; it is not sent.', verb, 'explain');
  for (let k = 0; k < words.length - 1; k++) {
    const w = words[k]!;
    if (words[k + 1] === '(' && DANGEROUS_FN.test(w)) return fail('denied', `The function ${w.toLowerCase()} is not allowed.`, verb, `${w.toLowerCase()}()`);
    // REPLACE INTO in a nested statement position (REPLACE( … ) is the string function and stays a read).
    if (/^replace$/i.test(w) && /^into$/i.test(words[k + 1]!)) return fail('write', 'The statement writes data.', 'REPLACE');
  }
  return classifySql(out);
}
