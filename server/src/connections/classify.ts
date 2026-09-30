/**
 * Query classification for data connections. The parser is advisory: read-only is enforced by the database account
 * and a read-only transaction. It decides what is never sent (writes, DDL, several statements, objects outside the
 * allow-list, dangerous functions) and what needs the user's confirmation (syntax it does not know).
 */
export type QueryKind = 'read' | 'write' | 'ddl' | 'multiple' | 'unparsed' | 'denied';

export interface Classification {
  kind: QueryKind;
  /** The statement's verb (SELECT, UPDATE, DROP, _delete_by_query…). */
  verb: string | null;
  /** Objects the query reads (tables, views, index patterns), normalised. */
  objects: string[];
  /** For `denied`: the object or function refused. */
  denied?: string;
  /** Plain-language reason for anything other than `read`. */
  reason?: string;
  /** OpenSearch: the request to send. */
  request?: { method: string; path: string; body: Record<string, unknown> | null; target: string | null; endpoint: string };
}

const WRITE = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'COPY', 'CALL', 'DO', 'LOCK']);
const DDL = new Set([
  'CREATE', 'DROP', 'ALTER', 'TRUNCATE', 'GRANT', 'REVOKE', 'COMMENT', 'VACUUM', 'ANALYZE', 'REINDEX', 'CLUSTER', 'REFRESH', 'SECURITY', 'IMPORT', 'RENAME',
  'DISCARD', 'SET', 'RESET', 'BEGIN', 'COMMIT', 'ROLLBACK', 'START', 'SAVEPOINT', 'RELEASE', 'PREPARE', 'EXECUTE', 'DEALLOCATE', 'LISTEN', 'NOTIFY', 'UNLISTEN', 'LOAD', 'CHECKPOINT', 'END', 'ABORT'
]);
const READ = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE']);
const KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'JOIN', 'LEFT', 'RIGHT', 'FULL', 'INNER', 'OUTER', 'CROSS', 'NATURAL', 'ON', 'USING', 'AS', 'UNION',
  'INTERSECT', 'EXCEPT', 'ALL', 'DISTINCT', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'ILIKE', 'BETWEEN', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'WINDOW', 'FETCH', 'FOR', 'LATERAL',
  'ONLY', 'WITH', 'RECURSIVE', 'VALUES', 'TABLE', 'ASC', 'DESC', 'NULLS', 'FIRST', 'LAST', 'INTO', 'EXISTS', 'ANY', 'SOME', 'OVER', 'PARTITION', 'FILTER', 'WITHIN', 'TABLESAMPLE'
]);
const END_FROM = new Set(['WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT', 'EXCEPT', 'WINDOW', 'FETCH', 'FOR', 'RETURNING', 'SELECT']);
const KNOWN_TYPES = /^(text|int|int2|int4|int8|integer|bigint|smallint|numeric|decimal|real|float|float4|float8|double|money|date|time|timetz|timestamp|timestamptz|interval|boolean|bool|varchar|char|character|bpchar|json|jsonb|uuid|name|regclass|bytea|inet|cidr)$/i;
/** Functions that read files, reach other servers, sleep, or change settings: never sent. */
const DANGEROUS_FN = /^(pg_(?!catalog$)|lo_|dblink|set_config|current_setting|query_to_xml|table_to_xml|cursor_to_xml|database_to_xml|schema_to_xml|xpath|copy|txid_|pg_catalog)/i;

interface Token {
  t: 'word' | 'qident' | 'str' | 'num' | 'punct';
  v: string;
}

function tokenize(sql: string): { tokens: Token[]; statements: number; unparsed: string | null } {
  const tokens: Token[] = [];
  let statements = 0;
  let inStatement = false;
  let unparsed: string | null = null;
  let i = 0;
  const s = sql;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === '-' && s[i + 1] === '-') {
      while (i < s.length && s[i] !== '\n') i++;
    } else if (c === '/' && s[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < s.length && depth) {
        if (s[i] === '/' && s[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (s[i] === '*' && s[i + 1] === '/') {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth) unparsed ??= 'an unterminated comment';
    } else if (c === "'" || ((c === 'E' || c === 'e') && s[i + 1] === "'")) {
      const esc = c !== "'";
      i += esc ? 2 : 1;
      let v = '';
      let closed = false;
      while (i < s.length) {
        if (esc && s[i] === '\\') {
          v += s[i + 1] ?? '';
          i += 2;
        } else if (s[i] === "'" && s[i + 1] === "'") {
          v += "'";
          i += 2;
        } else if (s[i] === "'") {
          i++;
          closed = true;
          break;
        } else v += s[i++];
      }
      if (!closed) unparsed ??= 'an unterminated string';
      tokens.push({ t: 'str', v });
      inStatement = true;
    } else if (c === '"') {
      let v = '';
      i++;
      let closed = false;
      while (i < s.length) {
        if (s[i] === '"' && s[i + 1] === '"') {
          v += '"';
          i += 2;
        } else if (s[i] === '"') {
          i++;
          closed = true;
          break;
        } else v += s[i++];
      }
      if (!closed) unparsed ??= 'an unterminated identifier';
      tokens.push({ t: 'qident', v });
      inStatement = true;
    } else if (c === '$' && /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.test(s.slice(i))) {
      unparsed ??= 'dollar-quoted text ($$)';
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i))![0];
      const end = s.indexOf(tag, i + tag.length);
      i = end < 0 ? s.length : end + tag.length;
      inStatement = true;
    } else if (c === ';') {
      if (inStatement) statements++;
      inStatement = false;
      i++;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(s.slice(i))!;
      tokens.push({ t: 'word', v: m[0] });
      i += m[0].length;
      inStatement = true;
    } else if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]*)?([eE][-+]?[0-9]+)?/.exec(s.slice(i))!;
      tokens.push({ t: 'num', v: m[0] });
      i += m[0].length;
      inStatement = true;
    } else if (c === ':' && s[i + 1] === ':') {
      tokens.push({ t: 'punct', v: '::' });
      i += 2;
    } else {
      tokens.push({ t: 'punct', v: c });
      i++;
      inStatement = true;
    }
  }
  if (inStatement) statements++;
  return { tokens, statements, unparsed };
}

const up = (t: Token | undefined) => (t && t.t === 'word' ? t.v.toUpperCase() : '');
const ident = (t: Token | undefined) => (t ? (t.t === 'qident' ? t.v : t.t === 'word' && !KEYWORDS.has(t.v.toUpperCase()) ? t.v.toLowerCase() : null) : null);

/** SQL (PostgreSQL dialect). */
export function classifySql(sql: string): Classification {
  const { tokens, statements, unparsed } = tokenize(sql);
  if (!tokens.length) return { kind: 'unparsed', verb: null, objects: [], reason: 'The query is empty.' };
  if (statements > 1) return { kind: 'multiple', verb: null, objects: [], reason: 'Send one statement at a time.' };
  let first = 0;
  while (tokens[first]?.v === '(') first++;
  const verb = up(tokens[first]) || tokens[first]!.v;
  if (DDL.has(verb)) return { kind: 'ddl', verb, objects: [], reason: `A ${verb} statement changes the schema, settings or transaction state.` };
  // A write verb where a statement can start: first, inside parentheses (data-modifying CTEs), after a CTE list or EXPLAIN.
  const writeAt = tokens.findIndex((t, i) => t.t === 'word' && WRITE.has(t.v.toUpperCase()) && (i === 0 || ['(', ')'].includes(tokens[i - 1]!.v) || ['EXPLAIN', 'ANALYZE', 'VERBOSE'].includes(up(tokens[i - 1]))));
  if (WRITE.has(verb) || writeAt >= 0) return { kind: 'write', verb: WRITE.has(verb) ? verb : up(tokens[writeAt]), objects: [], reason: 'The statement writes data.' };
  for (let i = 0; i < tokens.length - 1; i++) {
    if (up(tokens[i]) === 'FOR' && ['UPDATE', 'SHARE', 'NO'].includes(up(tokens[i + 1]))) return { kind: 'write', verb: `SELECT FOR ${up(tokens[i + 1])}`, objects: [], reason: 'The statement takes row locks.' };
  }
  if (!READ.has(verb)) return { kind: 'unparsed', verb, objects: [], reason: `The parser does not know ${verb} statements.` };

  let depth = 0;
  const ctes = new Set<string>();
  const objects: string[] = [];
  // Depths at which a FROM clause is open: a comma there starts another table reference.
  const fromAt: number[] = [];
  const top = () => fromAt[fromAt.length - 1];
  /** Reads the table reference starting at `j`; returns a refusal when it is a function. */
  const tableRef = (j: number): Classification | null => {
    while (['LATERAL', 'ONLY'].includes(up(tokens[j]))) j++;
    if (tokens[j]?.v === '(') return null; // a subquery: its own FROM is read as the tokens go by
    const parts: string[] = [];
    let id = ident(tokens[j]);
    if (!id) return null;
    parts.push(id);
    j++;
    while (tokens[j]?.v === '.' && (id = ident(tokens[j + 1]))) {
      parts.push(id);
      j += 2;
    }
    const name = parts.join('.');
    if (tokens[j]?.v === '(') {
      if (DANGEROUS_FN.test(parts[parts.length - 1]!)) return { kind: 'denied', verb, objects, denied: `${name}()`, reason: `The function ${name} is not allowed.` };
      return { kind: 'unparsed', verb, objects, reason: `The set-returning function ${name} cannot be checked against the allow-list.` };
    }
    if (!(parts.length === 1 && ctes.has(name))) objects.push(name);
    return null;
  };
  if (verb === 'TABLE') {
    const r = tableRef(first + 1);
    if (r) return r;
  }
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i]!;
    if (tk.v === '(') depth++;
    else if (tk.v === ')') {
      while (fromAt.length && top()! >= depth) fromAt.pop();
      depth--;
    }
    const w = up(tk);
    if (END_FROM.has(w)) while (fromAt.length && top() === depth) fromAt.pop();
    // SELECT … INTO creates a table.
    if (w === 'INTO' && depth === 0) return { kind: 'write', verb: 'SELECT INTO', objects: [], reason: 'SELECT INTO creates a table.' };
    // CTE names: WITH name AS ( … ), name AS ( … )
    if ((w === 'WITH' || w === 'RECURSIVE' || tk.v === ',') && ident(tokens[i + 1]) && up(tokens[i + 2]) === 'AS' && tokens[i + 3]?.v === '(') ctes.add(ident(tokens[i + 1])!);
    if (tk.t === 'word' && tokens[i + 1]?.v === '(' && DANGEROUS_FN.test(tk.v)) return { kind: 'denied', verb, objects, denied: `${tk.v.toLowerCase()}()`, reason: `The function ${tk.v.toLowerCase()} is not allowed.` };
    if (tk.v === '::') {
      const ty = tokens[i + 1];
      if (ty && ty.t !== 'punct' && !KNOWN_TYPES.test(ty.v)) return { kind: 'unparsed', verb, objects, reason: `The cast ::${ty.v} uses a type the parser does not know.` };
    }
    let ref = -1;
    if (w === 'FROM') {
      fromAt.push(depth);
      ref = i + 1;
    } else if (w === 'JOIN') ref = i + 1;
    else if (tk.v === ',' && fromAt.length && top() === depth) ref = i + 1;
    if (ref >= 0) {
      const r = tableRef(ref);
      if (r) return r;
    }
  }
  if (unparsed) return { kind: 'unparsed', verb, objects: [...new Set(objects)], reason: `The query uses ${unparsed}, which the parser does not read.` };
  return { kind: 'read', verb, objects: [...new Set(objects)] };
}

/** True when `object` (possibly unqualified) is on the allow-list; unqualified names resolve to `public`. */
export function allowedSql(object: string, allow: string[]): boolean {
  const list = allow.map((a) => a.toLowerCase());
  const o = object.toLowerCase();
  return list.includes(o) || (!o.includes('.') && list.includes(`public.${o}`)) || (o.startsWith('public.') && list.includes(o.slice(7)));
}

const glob = (pattern: string) => new RegExp('^' + pattern.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');

/** True when every index in a comma list is on the allow-list, directly or through a pattern such as `logs-*`. */
export function allowedIndex(target: string, allow: string[]): boolean {
  return target.split(',').every((t) => allow.some((a) => a === t || (a.includes('*') && !t.includes('*') && glob(a).test(t)) || (a.includes('*') && t === a)));
}

/**
 * OpenSearch: either `METHOD /path` on the first line followed by a JSON body, or a JSON body alone (sent to
 * `/<object>/_search`). Only `_search` and `_count` are reads; by-query writes, bulk and document APIs are writes;
 * index creation and deletion, settings and mappings are DDL.
 */
export function classifyOpenSearch(text: string, object: string | null): Classification {
  const trimmed = text.trim();
  const head = /^(GET|POST|PUT|DELETE|HEAD|PATCH)\s+(\/\S*)\s*/i.exec(trimmed);
  const method = head ? head[1]!.toUpperCase() : 'POST';
  const rawPath = head ? head[2]! : object ? `/${object}/_search` : '';
  const rest = head ? trimmed.slice(head[0].length) : trimmed;
  if (!rawPath) return { kind: 'unparsed', verb: null, objects: [], reason: 'Pick an index in the schema tree, or start the query with a line such as POST /logs-*/_search.' };
  const segs = rawPath.split('?')[0]!.split('/').filter(Boolean);
  const endpoint = segs.find((x) => x.startsWith('_')) ?? '';
  const target = segs[0] && !segs[0].startsWith('_') ? decodeURIComponent(segs[0]) : null;
  const writeEps = ['_delete_by_query', '_update_by_query', '_bulk', '_doc', '_update', '_create', '_reindex', '_rollover', '_split', '_shrink', '_clone', '_forcemerge'];
  if (writeEps.includes(endpoint)) return { kind: 'write', verb: endpoint, objects: target ? [target] : [], reason: `${endpoint} writes documents.` };
  if ((method === 'DELETE' || method === 'PUT') && (!endpoint || ['_mapping', '_settings', '_alias', '_aliases'].includes(endpoint))) {
    return { kind: 'ddl', verb: `${method} ${endpoint || 'index'}`, objects: target ? [target] : [], reason: method === 'DELETE' ? 'Deleting an index removes its data.' : 'Creating an index or changing its mapping or settings is a schema change.' };
  }
  if (!['_search', '_count'].includes(endpoint) || !['GET', 'POST'].includes(method)) return { kind: 'denied', verb: `${method} ${endpoint || rawPath}`, objects: target ? [target] : [], denied: rawPath, reason: 'Only _search and _count requests run on a connection.' };
  let body: Record<string, unknown> | null = null;
  if (rest) {
    try {
      const parsed = JSON.parse(rest) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      body = parsed as Record<string, unknown>;
    } catch {
      return { kind: 'unparsed', verb: endpoint, objects: target ? [target] : [], reason: 'The request body is not a JSON object.' };
    }
  }
  if (!target) return { kind: 'denied', verb: endpoint, objects: [], denied: '_all', reason: 'Name an index or index pattern; searching every index is refused.' };
  return { kind: 'read', verb: endpoint, objects: [target], request: { method, path: `/${encodeURIComponent(target).replace(/%2C/g, ',').replace(/%2A/g, '*')}/${endpoint}`, body, target, endpoint } };
}

/** MySQL functions that read files, sleep, take locks or reach the server's host: never sent. */
const MYSQL_DANGEROUS_FN = /^(load_file|sleep|benchmark|get_lock|release_lock|release_all_locks|is_free_lock|is_used_lock|master_pos_wait|source_pos_wait|wait_for_executed_gtid_set|sys_exec|sys_eval|uuid_short|connection_id|found_rows|last_insert_id)$/i;

/**
 * SQL for MySQL (B-416). MySQL lexes differently from PostgreSQL: backslashes escape inside strings, double quotes
 * delimit strings, backticks delimit identifiers, `#` starts a comment, `--` is a comment only before a space, and
 * `/*! … *\/` is executed rather than ignored. The text is first rewritten into the PostgreSQL form the parser reads
 * (every string becomes an empty literal, every backtick identifier a double-quoted one), refusing what cannot be
 * rewritten safely, so the parser sees exactly the tokens MySQL would run.
 */
export function classifyMysql(sql: string): Classification {
  let out = '';
  let i = 0;
  const s = sql;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '/' && s[i + 1] === '*') {
      if (s[i + 2] === '!' || s[i + 2] === '+') return { kind: 'denied', verb: null, objects: [], denied: s[i + 2] === '!' ? '/*!' : '/*+', reason: 'MySQL executable comments and optimizer hints are not allowed.' };
      const end = s.indexOf('*/', i + 2);
      if (end < 0) return { kind: 'unparsed', verb: null, objects: [], reason: 'The query has an unterminated comment.' };
      out += ' ';
      i = end + 2;
    } else if (c === '#') {
      const nl = s.indexOf('\n', i);
      out += ' ';
      i = nl < 0 ? s.length : nl;
    } else if (c === '-' && s[i + 1] === '-') {
      // A comment only when followed by whitespace or the end; otherwise it is two minus signs.
      if (i + 2 < s.length && !/\s/.test(s[i + 2]!)) return { kind: 'unparsed', verb: null, objects: [], reason: '"--" without a following space is not a comment in MySQL. Add a space, or write the minus signs apart.' };
      const nl = s.indexOf('\n', i);
      out += ' ';
      i = nl < 0 ? s.length : nl;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      let closed = false;
      while (j < s.length) {
        if (s[j] === '\\') j += 2;
        else if (s[j] === c && s[j + 1] === c) j += 2;
        else if (s[j] === c) {
          closed = true;
          j++;
          break;
        } else j++;
      }
      if (!closed) return { kind: 'unparsed', verb: null, objects: [], reason: 'The query has an unterminated string.' };
      out += "''";
      i = j;
    } else if (c === '`') {
      let j = i + 1;
      let v = '';
      let closed = false;
      while (j < s.length) {
        if (s[j] === '`' && s[j + 1] === '`') {
          v += '`';
          j += 2;
        } else if (s[j] === '`') {
          closed = true;
          j++;
          break;
        } else v += s[j++];
      }
      if (!closed) return { kind: 'unparsed', verb: null, objects: [], reason: 'The query has an unterminated identifier.' };
      out += '"' + v.replace(/"/g, '""') + '"';
      i = j;
    } else if (c === '$') {
      // Not quoting in MySQL: keep it from being read as a PostgreSQL dollar quote.
      out += ' ';
      i++;
    } else {
      out += c;
      i++;
    }
  }
  const fn = /([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  for (const m of out.matchAll(fn)) if (MYSQL_DANGEROUS_FN.test(m[1]!)) return { kind: 'denied', verb: null, objects: [], denied: `${m[1]!.toLowerCase()}()`, reason: `The function ${m[1]!.toLowerCase()} is not allowed.` };
  if (/\bLOCK\s+IN\s+SHARE\s+MODE\b/i.test(out)) return { kind: 'write', verb: 'SELECT LOCK IN SHARE MODE', objects: [], reason: 'The statement takes row locks.' };
  if (/\bINTO\s+(OUTFILE|DUMPFILE)\b/i.test(out)) return { kind: 'write', verb: 'SELECT INTO OUTFILE', objects: [], reason: 'INTO OUTFILE writes a file on the database server.' };
  if (/\b(HANDLER|SHOW|DESCRIBE|DESC|USE|KILL|FLUSH|INSTALL|UNINSTALL|SHUTDOWN|REPLACE)\b/i.test(out.trim().split(/\s+/)[0] ?? '')) {
    const verb = (out.trim().split(/\s+/)[0] ?? '').toUpperCase();
    return verb === 'REPLACE' ? { kind: 'write', verb, objects: [], reason: 'The statement writes data.' } : { kind: 'unparsed', verb, objects: [], reason: `The parser does not run ${verb} statements.` };
  }
  return classifySql(out);
}

/** MySQL: unqualified names resolve to the connection's database. */
export function allowedMysql(object: string, allow: string[], database: string | null): boolean {
  const list = allow.map((a) => a.toLowerCase());
  const o = object.toLowerCase();
  return list.includes(o) || (!!database && !o.includes('.') && list.includes(`${database.toLowerCase()}.${o}`)) || (!!database && o.startsWith(`${database.toLowerCase()}.`) && list.includes(o.slice(database.length + 1)));
}
