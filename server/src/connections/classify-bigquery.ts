import { classifySql, type Classification } from './classify.js';

/*
 * 1.9.0: BigQuery (GoogleSQL). The text is lexed as BigQuery lexes it and rewritten into the form the PostgreSQL
 * parser in classify.ts reads, so that parser sees exactly the tokens BigQuery would run:
 *
 * - '…' and "…" strings with backslash escapes, '''…''' and """…""", r/R raw and b/B bytes prefixes (and rb, br):
 *   every string becomes an empty literal ''. A raw string with a backslash before a quote or another backslash is
 *   refused as ambiguous, so the lexer can never end a string where BigQuery does not.
 * - `backtick` identifiers, which may hold dots (`proj.ds.table`): split into parts, each a double-quoted identifier.
 *   A wildcard table (`ds.events_*`, backticks required by BigQuery) keeps its `*` inside the last part.
 * - # and -- comments (-- is always a comment here), /* … *\/ (not nested: the first *\/ ends it, as in BigQuery).
 * - UNNEST(…) loses its name, so the parser reads a parenthesised expression, not a function it cannot check; any
 *   FROM inside it is read as usual. QUALIFY reads as HAVING (both end the FROM clause).
 *
 * Refused before the parser runs: #legacySQL, scripting (DECLARE, SET, BEGIN, IF, LOOP, WHILE, REPEAT, FOR, CALL,
 * EXECUTE IMMEDIATE, RAISE, RETURN, ASSERT, …), EXPORT DATA and LOAD DATA (writes), UNDROP (DDL), EXTERNAL_QUERY and
 * EXTERNAL_OBJECT_TRANSFORM (they reach other systems). ML.* and AI.* functions and VECTOR_SEARCH read tables passed
 * as arguments the allow-list cannot see: unparsed. Objects come back in lower case as `dataset.table` or
 * `project.dataset.table`.
 */

const SCRIPTING = new Set(['DECLARE', 'SET', 'BEGIN', 'END', 'IF', 'ELSEIF', 'LOOP', 'WHILE', 'REPEAT', 'FOR', 'BREAK', 'LEAVE', 'CONTINUE', 'ITERATE', 'CALL', 'EXECUTE', 'RAISE', 'RETURN', 'ASSERT', 'CASE', 'COMMIT', 'ROLLBACK', 'TRANSACTION']);
const DANGEROUS_FN = /^(external_query|external_object_transform)$/i;
const OPAQUE_FN = /^vector_search$/i;

const refuse = (kind: Classification['kind'], verb: string | null, reason: string, denied?: string): Classification => ({ kind, verb, objects: [], reason, ...(denied ? { denied } : {}) });

export function classifyBigQuery(sql: string): Classification {
  if (/^\s*#\s*legacysql\b/i.test(sql)) return refuse('denied', null, 'Legacy SQL is not run; write GoogleSQL (standard SQL).', '#legacySQL');
  let out = '';
  let i = 0;
  const s = sql;
  const wordBefore = (k: number) => /[A-Za-z0-9_]/.test(s[k - 1] ?? '');
  while (i < s.length) {
    const c = s[i]!;
    // String prefixes: r, b, rb, br (any case), directly before a quote and not part of a longer word.
    const pre = /^([rRbB]|[rR][bB]|[bB][rR])(?=['"])/.exec(s.slice(i));
    if (pre && !wordBefore(i)) {
      const raw = /r/i.test(pre[1]!);
      const r = readString(s, i + pre[1]!.length, raw);
      if ('problem' in r) return refuse('unparsed', null, r.problem);
      out += " '' ";
      i = r.end;
      continue;
    }
    if (c === "'" || c === '"') {
      const r = readString(s, i, false);
      if ('problem' in r) return refuse('unparsed', null, r.problem);
      out += " '' ";
      i = r.end;
    } else if (c === '`') {
      const end = s.indexOf('`', i + 1);
      if (end < 0) return refuse('unparsed', null, 'The query has an unterminated identifier.');
      const body = s.slice(i + 1, end);
      if (!body || /[\\\n]/.test(body)) return refuse('unparsed', null, 'A quoted identifier is empty or holds an escape the parser does not read.');
      const parts = body.split('.');
      if (parts.some((p) => !p.trim())) return refuse('unparsed', null, `\`${body.slice(0, 100)}\` has an empty name part.`);
      out += parts.map((p) => '"' + p.replace(/"/g, '""') + '"').join('.');
      i = end + 1;
    } else if (c === '#' || (c === '-' && s[i + 1] === '-')) {
      const nl = s.indexOf('\n', i);
      out += ' ';
      i = nl < 0 ? s.length : nl;
    } else if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      if (end < 0) return refuse('unparsed', null, 'The query has an unterminated comment.');
      out += ' ';
      i = end + 2;
    } else if (c === '$') {
      // Not quoting in BigQuery: keep it from being read as a PostgreSQL dollar quote.
      out += ' ';
      i++;
    } else {
      out += c;
      i++;
    }
  }

  const words = [...out.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)];
  const first = (words[0]?.[0] ?? '').toUpperCase();
  const second = (words[1]?.[0] ?? '').toUpperCase();
  if (first === 'EXPORT' || (first === 'LOAD' && second === 'DATA')) return refuse('write', `${first} DATA`, `${first} DATA writes data ${first === 'EXPORT' ? 'out to storage' : 'into a table'}.`);
  if (first === 'UNDROP') return refuse('ddl', 'UNDROP', 'An UNDROP statement changes the schema.');
  if (SCRIPTING.has(first)) return refuse('ddl', first, `BigQuery scripting (${first}) is not run on a connection: send one query.`);
  // Names compared without their quotes: BigQuery accepts `external_query`(…) as well as external_query(…).
  const plain = out.replace(/"((?:[^"]|"")*)"/g, (_m, v: string) => v.replace(/""/g, '"'));
  for (const m of plain.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const fn = m[0];
    if (DANGEROUS_FN.test(fn)) return refuse('denied', first || null, `The function ${fn.toLowerCase()} is not allowed: it reaches another system.`, `${fn.toLowerCase()}()`);
    if (OPAQUE_FN.test(fn)) return refuse('unparsed', first || null, `${fn.toUpperCase()} reads tables passed as arguments, which the allow-list cannot check.`);
  }
  const mlai = /\b(ML|AI)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/i.exec(plain);
  if (mlai) return refuse('unparsed', first || null, `${mlai[1]!.toUpperCase()}.${mlai[2]!.toUpperCase()} reads models and tables passed as arguments, which the allow-list cannot check.`);

  // UNNEST(…) → (…): an expression, not a table function. QUALIFY → HAVING.
  const rewritten = out.replace(/\bUNNEST(\s*\()/gi, ' $1').replace(/\bQUALIFY\b/gi, 'HAVING');
  const cl = classifySql(rewritten);
  const lower = (x: string) => x.toLowerCase();
  return { ...cl, objects: [...new Set(cl.objects.map(lower))], ...(cl.denied ? { denied: lower(cl.denied) } : {}) };
}

/** Reads a string starting at the quote at `at`; triple-quoted when three quotes open it. */
function readString(s: string, at: number, raw: boolean): { end: number } | { problem: string } {
  const q = s[at]!;
  const triple = s.startsWith(q.repeat(3), at);
  const close = triple ? q.repeat(3) : q;
  let j = at + close.length;
  while (j < s.length) {
    if (s[j] === '\\') {
      if (raw) {
        if (s[j + 1] === q || s[j + 1] === '\\') return { problem: 'A raw string with a backslash before a quote or another backslash is ambiguous; write it as an ordinary string.' };
        j++;
        continue;
      }
      j += 2;
      continue;
    }
    if (s.startsWith(close, j)) return { end: j + close.length };
    if (!triple && s[j] === '\n') return { problem: 'A string runs past the end of its line; use a triple-quoted string.' };
    j++;
  }
  return { problem: 'The query has an unterminated string.' };
}
