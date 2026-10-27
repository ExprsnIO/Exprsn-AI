import { classifySql, type Classification } from './classify.js';

/*
 * 1.9.0: Oracle SQL. As with MySQL, the text is first rewritten into the PostgreSQL form `classifySql` reads, refusing
 * what cannot be rewritten safely: every string (including N'…' and the alternative quoting q'[…]' and nq'…') becomes
 * an empty literal, so a keyword inside one is never read; comments (hints included) become a space; "quoted"
 * identifiers are kept; an unquoted name with `#` in it is quoted. Before the generic parser, the Oracle verbs are
 * sorted: PL/SQL blocks, writes and session or schema statements are refused, and so are the packages that reach the
 * network, files or the database's internals, database links (`table@link`) and sequence reads (`seq.NEXTVAL`
 * advances the sequence). `SELECT FROM dual` reads no allow-listed object.
 */

const Q_CLOSE: Record<string, string> = { '[': ']', '{': '}', '(': ')', '<': '>' };

const WRITE_VERBS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT', 'LOCK', 'CALL', 'EXEC', 'EXECUTE', 'EXPLAIN']);
const DDL_VERBS = new Set(['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'GRANT', 'REVOKE', 'COMMENT', 'RENAME', 'PURGE', 'FLASHBACK', 'SET', 'ANALYZE', 'AUDIT', 'NOAUDIT', 'ASSOCIATE', 'DISASSOCIATE', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'ADMINISTER', 'SHUTDOWN', 'STARTUP']);
const PLSQL = new Set(['BEGIN', 'DECLARE']);

/** Packages and types that reach the network, files or the database's internals: never sent. */
const DANGEROUS = /\b(UTL_(HTTP|TCP|SMTP|MAIL|FILE|INADDR)|DBMS_[A-Z0-9_$#]*|HTTPURITYPE|DBURITYPE|XDBURITYPE|URIFACTORY)\b/i;

const unparsed = (reason: string): Classification => ({ kind: 'unparsed', verb: null, objects: [], reason });

/** The Oracle text rewritten for `classifySql`, or a classification when it cannot be. */
export function rewriteOracle(sql: string): { text: string } | { refuse: Classification } {
  let out = '';
  let i = 0;
  const s = sql;
  const wordBefore = (k: number) => /[A-Za-z0-9_$#]/.test(s[k - 1] ?? '');
  while (i < s.length) {
    const c = s[i]!;
    // Alternative quoting: q'X…X' and nq'X…X' (X a delimiter; brackets close with their pair).
    const qAt = (c === 'q' || c === 'Q') && s[i + 1] === "'" ? i : (c === 'n' || c === 'N') && (s[i + 1] === 'q' || s[i + 1] === 'Q') && s[i + 2] === "'" ? i + 1 : -1;
    if (qAt >= 0 && !wordBefore(i)) {
      const open = s[qAt + 2];
      if (!open || /\s/.test(open)) return { refuse: unparsed('The q-quoted text has no delimiter.') };
      const close = (Q_CLOSE[open] ?? open) + "'";
      const end = s.indexOf(close, qAt + 3);
      if (end < 0) return { refuse: unparsed('The query has an unterminated q-quoted string.') };
      out += "''";
      i = end + 2;
    } else if (c === "'" || ((c === 'n' || c === 'N') && s[i + 1] === "'" && !wordBefore(i))) {
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
      if (!closed) return { refuse: unparsed('The query has an unterminated string.') };
      out += "''";
      i = j;
    } else if (c === '"') {
      const end = s.indexOf('"', i + 1);
      if (end < 0) return { refuse: unparsed('The query has an unterminated identifier.') };
      out += s.slice(i, end + 1);
      i = end + 1;
    } else if (c === '-' && s[i + 1] === '-') {
      const nl = s.indexOf('\n', i);
      out += ' ';
      i = nl < 0 ? s.length : nl;
    } else if (c === '/' && s[i + 1] === '*') {
      // Oracle block comments do not nest; hints (/*+ … */) are comments too.
      const end = s.indexOf('*/', i + 2);
      if (end < 0) return { refuse: unparsed('The query has an unterminated comment.') };
      out += ' ';
      i = end + 2;
    } else if (/[A-Za-z]/.test(c) && !wordBefore(i)) {
      const m = /^[A-Za-z][A-Za-z0-9_$#]*/.exec(s.slice(i))!;
      // `#` is part of an Oracle name; the generic parser would split it, so the name is quoted (lower case, as unquoted names compare).
      out += m[0].includes('#') ? `"${m[0].toLowerCase()}"` : m[0];
      i += m[0].length;
    } else if (c === '$') {
      // Not quoting in Oracle (only inside names, which the branch above reads whole).
      out += ' ';
      i++;
    } else {
      out += c;
      i++;
    }
  }
  // SQL*Plus ends a statement with a line holding only `/`; one at the very end is that terminator.
  const lines = out.replace(/\s+$/, '').split('\n');
  if (lines.length > 1 && lines[lines.length - 1]!.trim() === '/') lines.pop();
  out = lines.join('\n');
  if (lines.some((l, k) => k > 0 && l.trim() === '/')) return { refuse: { kind: 'multiple', verb: null, objects: [], reason: 'Send one statement at a time.' } };
  return { text: out };
}

/** Oracle SQL: one read, or the reason it is refused. */
export function classifyOracle(sql: string): Classification {
  const r = rewriteOracle(sql);
  if ('refuse' in r) return r.refuse;
  const text = r.text;
  const words = text.replace(/^[\s(]+/, '').split(/[^A-Za-z0-9_$#]+/).filter(Boolean);
  const verb = (words[0] ?? '').toUpperCase();
  if (!verb) return unparsed('The query is empty.');
  if (PLSQL.has(verb)) return { kind: 'write', verb, objects: [], reason: 'A PL/SQL block can do anything the account may; only single SELECT statements run.' };
  if (DDL_VERBS.has(verb)) return { kind: 'ddl', verb, objects: [], reason: `A ${verb} statement changes the schema, settings or transaction state.` };
  if (WRITE_VERBS.has(verb)) return { kind: 'write', verb: verb === 'EXPLAIN' ? 'EXPLAIN PLAN' : verb, objects: [], reason: verb === 'EXPLAIN' ? 'EXPLAIN PLAN writes to the plan table.' : 'The statement writes data or runs a procedure.' };
  // Several statements: a `;` with anything after it.
  if (/;\s*\S/.test(text)) return { kind: 'multiple', verb: null, objects: [], reason: 'Send one statement at a time.' };
  const danger = DANGEROUS.exec(text);
  if (danger) return { kind: 'denied', verb, objects: [], denied: danger[1]!.toLowerCase(), reason: `${danger[1]!.toUpperCase()} is not allowed: it reaches the network, files or the database's internals.` };
  const link = /([A-Za-z0-9_$#"]+)\s*@\s*([A-Za-z_"][A-Za-z0-9_$#."]*)/.exec(text);
  if (link) return { kind: 'denied', verb, objects: [], denied: `@${link[2]!.replace(/"/g, '').toLowerCase()}`, reason: `The database link ${link[2]!.replace(/"/g, '')} reaches another database; it is not allowed.` };
  if (/\.\s*NEXTVAL\b/i.test(text)) return { kind: 'write', verb: 'NEXTVAL', objects: [], reason: 'Reading NEXTVAL advances the sequence.' };
  const cl = classifySql(text);
  // `dual` is Oracle's one-row table: reading it reads nothing that needs allowing.
  return { ...cl, objects: cl.objects.filter((o) => o !== 'dual' && o !== 'sys.dual') };
}
