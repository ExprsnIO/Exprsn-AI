import { classifySql, type Classification } from './classify.js';

/*
 * 1.9.0: Snowflake SQL. Snowflake lexes differently from PostgreSQL: strings take backslash escapes as well as a
 * doubled quote, `$$ … $$` is a string, `//` starts a comment as `--` does, and `::type` casts name Snowflake types
 * (VARIANT, NUMBER(10,2), TIMESTAMP_NTZ…). The text is rewritten into the form `classifySql` reads (every string an
 * empty literal, every comment a space, every cast dropped), refusing first what only Snowflake has:
 *
 * - session and account verbs (USE, SHOW, DESCRIBE, LIST, PUT, GET, REMOVE, UNDROP, EXECUTE …) and anything writing;
 * - stage reads (`@stage`, `FROM @s/path`), which no allow-list entry names;
 * - SYSTEM$ functions, RESULT_SCAN (another query's results) and IDENTIFIER() (a table named by a value), denied;
 * - table functions (`TABLE(…)`), which cannot be checked against the allow-list: confirmed by the user, as the
 *   PostgreSQL set-returning rule. `FLATTEN(…)` over a column is read through when its arguments hold no SELECT.
 */

const WRITE_VERBS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'COPY', 'PUT', 'GET', 'REMOVE', 'RM', 'CALL', 'EXECUTE', 'TRUNCATE']);
const DDL_VERBS = new Set(['USE', 'SET', 'UNSET', 'ALTER', 'UNDROP', 'GRANT', 'REVOKE', 'BEGIN', 'COMMIT', 'ROLLBACK', 'DECLARE', 'CREATE', 'DROP', 'COMMENT', 'START', 'LET', 'RETURN']);
/** Metadata reads that list objects outside the allow-list. */
const LISTING_VERBS = new Set(['SHOW', 'DESCRIBE', 'DESC', 'LIST', 'LS', 'EXPLAIN']);

const fail = (kind: Classification['kind'], reason: string, verb: string | null = null, denied?: string): Classification => ({ kind, verb, objects: [], reason, ...(denied ? { denied } : {}) });

/** Index just past the parenthesised group opening at `open` (a `(`), or -1 when it is not closed. */
function closeParen(s: string, open: number): number {
  let depth = 0;
  for (let k = open; k < s.length; k++) {
    if (s[k] === '(') depth++;
    else if (s[k] === ')' && --depth === 0) return k + 1;
  }
  return -1;
}

/** Snowflake SQL, classified as `classifySql` reads it after the rewrite. */
export function classifySnowflake(sql: string): Classification {
  let out = '';
  let i = 0;
  let stage = false;
  const s = sql;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      if (end < 0) return fail('unparsed', 'The query has an unterminated comment.');
      out += ' ';
      i = end + 2;
    } else if ((c === '-' && s[i + 1] === '-') || (c === '/' && s[i + 1] === '/')) {
      const nl = s.indexOf('\n', i);
      out += ' ';
      i = nl < 0 ? s.length : nl;
    } else if (c === "'") {
      let j = i + 1;
      let closed = false;
      while (j < s.length) {
        if (s[j] === '\\') j += 2;
        else if (s[j] === "'" && s[j + 1] === "'") j += 2;
        else if (s[j] === "'") {
          closed = true;
          j++;
          break;
        } else j++;
      }
      if (!closed) return fail('unparsed', 'The query has an unterminated string.');
      out += "''";
      i = j;
    } else if (c === '$' && s[i + 1] === '$') {
      const end = s.indexOf('$$', i + 2);
      if (end < 0) return fail('unparsed', 'The query has an unterminated $$ string.');
      out += "''";
      i = end + 2;
    } else if (c === '"') {
      let j = i + 1;
      let closed = false;
      while (j < s.length) {
        if (s[j] === '"' && s[j + 1] === '"') j += 2;
        else if (s[j] === '"') {
          closed = true;
          j++;
          break;
        } else j++;
      }
      if (!closed) return fail('unparsed', 'The query has an unterminated identifier.');
      out += s.slice(i, j);
      i = j;
    } else if (c === ':' && s[i + 1] === ':') {
      // A cast: `::type` or `::type(10, 2)`, dropped (the value is still read from what precedes it).
      const m = /^::\s*([A-Za-z_][A-Za-z0-9_]*)\s*/.exec(s.slice(i));
      if (!m) return fail('unparsed', 'The query has a cast the parser cannot read.');
      i += m[0].length;
      if (s[i] === '(') {
        const end = closeParen(s, i);
        if (end < 0 || /[^0-9,\s]/.test(s.slice(i + 1, end - 1))) return fail('unparsed', `The cast ::${m[1]} has arguments the parser cannot read.`);
        i = end;
      }
      out += ' ';
    } else if (c === '@') {
      stage = true;
      out += ' ';
      i++;
    } else {
      out += c;
      i++;
    }
  }

  const words = out.match(/[A-Za-z_][A-Za-z0-9_$]*/g) ?? [];
  const verb = (out.replace(/^[\s(]+/, '').match(/^[A-Za-z_][A-Za-z0-9_$]*/)?.[0] ?? '').toUpperCase();
  if (!verb) return fail('unparsed', 'The query is empty.');
  if (out.split(';').filter((x) => x.trim()).length > 1) return fail('multiple', 'Send one statement at a time.');
  if (WRITE_VERBS.has(verb)) return { kind: 'write', verb: verb === 'INSERT' && /^\s*INSERT\s+OVERWRITE\b/i.test(out) ? 'INSERT OVERWRITE' : verb, objects: [], reason: verb === 'PUT' || verb === 'GET' || verb === 'REMOVE' || verb === 'RM' ? 'Stage file commands move files.' : verb === 'EXECUTE' || verb === 'CALL' ? 'Procedures, tasks and dynamic SQL can write.' : 'The statement writes data.' };
  if (DDL_VERBS.has(verb)) return { kind: 'ddl', verb, objects: [], reason: `A ${verb} statement changes objects, settings or the session.` };
  if (LISTING_VERBS.has(verb)) return { kind: 'denied', verb, objects: [], denied: verb, reason: `${verb} lists objects outside the allow-list; browse the schema tree instead.` };
  if (stage) return { kind: 'denied', verb, objects: [], denied: '@stage', reason: 'Stages (@name) are not on any allow-list: query a table or view.' };

  for (const w of words) {
    if (/^system\$/i.test(w)) return { kind: 'denied', verb, objects: [], denied: `${w.toLowerCase()}()`, reason: `The function ${w.toLowerCase()} is not allowed.` };
  }
  const fn = /([A-Za-z_][A-Za-z0-9_$]*)\s*\(/g;
  for (const m of out.matchAll(fn)) {
    const name = m[1]!.toUpperCase();
    if (name === 'RESULT_SCAN') return { kind: 'denied', verb, objects: [], denied: 'result_scan()', reason: 'RESULT_SCAN reads the results of other queries, which no allow-list covers.' };
    if (name === 'IDENTIFIER') return { kind: 'denied', verb, objects: [], denied: 'identifier()', reason: 'IDENTIFIER() names an object by a value, which cannot be checked against the allow-list.' };
  }

  // FLATTEN over a column reads only what its query already reads: drop it when its arguments hold no query.
  let text = out.replace(/\bQUALIFY\b/gi, 'HAVING');
  for (let guard = 0; guard < 50; guard++) {
    const m = /\b(?:LATERAL\s+)?(?:TABLE\s*\(\s*)?FLATTEN\s*\(/i.exec(text);
    if (!m) break;
    const open = text.indexOf('(', m.index + m[0].length - 1);
    const end = closeParen(text, open);
    if (end < 0) return fail('unparsed', 'FLATTEN( is not closed.');
    if (/\bSELECT\b/i.test(text.slice(open, end))) return { kind: 'unparsed', verb, objects: [], reason: 'FLATTEN over a subquery cannot be checked against the allow-list.' };
    let stop = end;
    if (/TABLE\s*\(/i.test(m[0])) {
      const rest = /^\s*\)/.exec(text.slice(end));
      if (!rest) return fail('unparsed', 'TABLE(FLATTEN( … ) is not closed.');
      stop = end + rest[0].length;
    }
    // A subquery stand-in keeps the FROM list's commas in place; it reads nothing.
    text = text.slice(0, m.index) + '(SELECT 1)' + text.slice(stop);
  }
  if (/\bTABLE\s*\(/i.test(text)) return { kind: 'unparsed', verb, objects: [], reason: 'A table function (TABLE(…)) cannot be checked against the allow-list.' };

  const cl = classifySql(text);
  return { ...cl, objects: cl.objects.map((o) => o.toLowerCase()) };
}
