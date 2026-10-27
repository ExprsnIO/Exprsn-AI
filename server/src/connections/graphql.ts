/*
 * 1.9.0: GraphQL documents for API connections of protocol `graphql`.
 *
 * A small lexer and parser of the executable part of the GraphQL grammar (operations, fragments, selections,
 * arguments, values, variables, directives), enough to decide what a document would do before anything is sent:
 * exactly one operation, and it must be a `query` (or the `{ … }` shorthand). `mutation` and `subscription` are
 * refused. Selections are measured with fragments expanded (a cycle is refused), so a document deeper than
 * MAX_DEPTH or wider than MAX_FIELDS is refused too. `__schema` and `__type` (introspection) are for the schema
 * helper only. Parameters never reach the text: they are sent as variables.
 */

export const MAX_DEPTH = 12;
export const MAX_FIELDS = 500;
export const MAX_DOCUMENT = 20_000;

type Tok = { t: 'name' | 'punct' | 'num' | 'str' | 'spread'; v: string };

export class GraphqlSyntaxError extends Error {}

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '﻿' || c === ',' || /\s/.test(c)) {
      i++;
    } else if (c === '#') {
      while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i++;
    } else if (src.startsWith('...', i)) {
      out.push({ t: 'spread', v: '...' });
      i += 3;
    } else if ('!$&():=@[]{}|'.includes(c)) {
      out.push({ t: 'punct', v: c });
      i++;
    } else if (/[_A-Za-z]/.test(c)) {
      const m = /^[_A-Za-z][_0-9A-Za-z]*/.exec(src.slice(i))!;
      out.push({ t: 'name', v: m[0] });
      i += m[0].length;
    } else if (/[-0-9]/.test(c)) {
      const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(src.slice(i));
      if (!m) throw new GraphqlSyntaxError(`Unexpected character ${c} at ${i}.`);
      out.push({ t: 'num', v: m[0] });
      i += m[0].length;
    } else if (src.startsWith('"""', i)) {
      let j = i + 3;
      for (;;) {
        if (j >= src.length) throw new GraphqlSyntaxError('Unterminated block string.');
        if (src.startsWith('\\"""', j)) j += 4;
        else if (src.startsWith('"""', j)) break;
        else j++;
      }
      out.push({ t: 'str', v: src.slice(i + 3, j) });
      i = j + 3;
    } else if (c === '"') {
      let j = i + 1;
      let v = '';
      for (;;) {
        if (j >= src.length || src[j] === '\n') throw new GraphqlSyntaxError('Unterminated string.');
        if (src[j] === '\\') {
          v += src[j + 1] ?? '';
          j += 2;
        } else if (src[j] === '"') break;
        else v += src[j++];
      }
      out.push({ t: 'str', v });
      i = j + 1;
    } else throw new GraphqlSyntaxError(`Unexpected character ${c} at ${i}.`);
  }
  return out;
}

interface Field {
  kind: 'field';
  name: string;
  sel: Selection[];
}
interface Spread {
  kind: 'spread';
  name: string;
}
interface Inline {
  kind: 'inline';
  sel: Selection[];
}
type Selection = Field | Spread | Inline;

interface Operation {
  type: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: string[];
  sel: Selection[];
}

export interface ParsedDocument {
  operations: Operation[];
  fragments: Map<string, Selection[]>;
}

export function parseGraphql(src: string): ParsedDocument {
  const toks = lex(src);
  let i = 0;
  const peek = () => toks[i];
  const next = () => {
    const t = toks[i++];
    if (!t) throw new GraphqlSyntaxError('The document ends early.');
    return t;
  };
  const expect = (v: string) => {
    const t = next();
    if (t.v !== v || (t.t !== 'punct' && t.t !== 'name')) throw new GraphqlSyntaxError(`Expected ${v}, found ${t.v}.`);
  };
  const name = () => {
    const t = next();
    if (t.t !== 'name') throw new GraphqlSyntaxError(`Expected a name, found ${t.v}.`);
    return t.v;
  };
  const value = (depth = 0): void => {
    if (depth > 32) throw new GraphqlSyntaxError('A value is nested too deeply.');
    const t = next();
    if (t.t === 'punct' && t.v === '$') return void name();
    if (t.t === 'punct' && t.v === '[') {
      while (peek()?.v !== ']') value(depth + 1);
      return void next();
    }
    if (t.t === 'punct' && t.v === '{') {
      while (peek()?.v !== '}') {
        name();
        expect(':');
        value(depth + 1);
      }
      return void next();
    }
    if (t.t === 'name' || t.t === 'num' || t.t === 'str') return;
    throw new GraphqlSyntaxError(`Unexpected ${t.v} in a value.`);
  };
  const args = () => {
    if (peek()?.v !== '(' || peek()?.t !== 'punct') return;
    next();
    while (peek()?.v !== ')') {
      name();
      expect(':');
      value();
    }
    next();
  };
  const directives = () => {
    while (peek()?.t === 'punct' && peek()?.v === '@') {
      next();
      name();
      args();
    }
  };
  const type = (): void => {
    if (peek()?.v === '[') {
      next();
      type();
      expect(']');
    } else name();
    if (peek()?.v === '!') next();
  };
  const selectionSet = (depth: number): Selection[] => {
    if (depth > 64) throw new GraphqlSyntaxError('Selections are nested too deeply.');
    expect('{');
    const out: Selection[] = [];
    while (peek()?.v !== '}') {
      if (!peek()) throw new GraphqlSyntaxError('Unterminated selection set.');
      if (peek()!.t === 'spread') {
        next();
        if (peek()?.t === 'name' && peek()!.v !== 'on') {
          out.push({ kind: 'spread', name: name() });
          directives();
        } else {
          if (peek()?.v === 'on') {
            next();
            name();
          }
          directives();
          out.push({ kind: 'inline', sel: selectionSet(depth + 1) });
        }
        continue;
      }
      let n = name();
      if (peek()?.v === ':' && peek()?.t === 'punct') {
        next();
        n = name();
      }
      args();
      directives();
      out.push({ kind: 'field', name: n, sel: peek()?.v === '{' && peek()?.t === 'punct' ? selectionSet(depth + 1) : [] });
    }
    next();
    return out;
  };
  const doc: ParsedDocument = { operations: [], fragments: new Map() };
  while (i < toks.length) {
    const t = peek()!;
    if (t.t === 'punct' && t.v === '{') {
      doc.operations.push({ type: 'query', name: null, variables: [], sel: selectionSet(0) });
    } else if (t.t === 'name' && (t.v === 'query' || t.v === 'mutation' || t.v === 'subscription')) {
      next();
      const op: Operation = { type: t.v, name: null, variables: [], sel: [] };
      if (peek()?.t === 'name') op.name = name();
      if (peek()?.v === '(' && peek()?.t === 'punct') {
        next();
        while (peek()?.v !== ')') {
          expect('$');
          op.variables.push(name());
          expect(':');
          type();
          if (peek()?.v === '=') {
            next();
            value();
          }
          directives();
        }
        next();
      }
      directives();
      op.sel = selectionSet(0);
      doc.operations.push(op);
    } else if (t.t === 'name' && t.v === 'fragment') {
      next();
      const n = name();
      if (n === 'on') throw new GraphqlSyntaxError('A fragment cannot be named on.');
      expect('on');
      name();
      directives();
      if (doc.fragments.has(n)) throw new GraphqlSyntaxError(`The fragment ${n} is defined twice.`);
      doc.fragments.set(n, selectionSet(0));
    } else throw new GraphqlSyntaxError(`Unexpected ${t.v}: only queries and fragments may be sent.`);
  }
  return doc;
}

export interface GraphqlClassification {
  ok: boolean;
  operation: 'query' | 'mutation' | 'subscription' | null;
  name: string | null;
  variables: string[];
  depth: number;
  fields: number;
  introspection: boolean;
  problems: string[];
}

/** Whether a document may be sent as a read: one query, within the caps, no introspection unless asked. */
export function classifyGraphql(src: string, opts: { allowIntrospection?: boolean } = {}): GraphqlClassification {
  const out: GraphqlClassification = { ok: false, operation: null, name: null, variables: [], depth: 0, fields: 0, introspection: false, problems: [] };
  if (src.length > MAX_DOCUMENT) {
    out.problems.push(`The document is longer than ${MAX_DOCUMENT} characters.`);
    return out;
  }
  let doc: ParsedDocument;
  try {
    doc = parseGraphql(src);
  } catch (err) {
    out.problems.push(`The GraphQL document could not be read: ${(err as Error).message}`);
    return out;
  }
  if (doc.operations.length !== 1) {
    out.problems.push(doc.operations.length ? 'Send exactly one operation per endpoint.' : 'The document has no operation.');
    return out;
  }
  const op = doc.operations[0]!;
  Object.assign(out, { operation: op.type, name: op.name, variables: op.variables });
  if (op.type !== 'query') {
    out.problems.push(`A ${op.type} is refused: API connections only read, so only query operations are sent.`);
    return out;
  }
  // Measure with fragments expanded; a fragment that spreads itself (directly or not) is refused.
  let fields = 0;
  let depth = 0;
  let introspection = false;
  const walk = (sel: Selection[], d: number, path: string[]): void => {
    for (const s of sel) {
      if (fields > MAX_FIELDS || depth > MAX_DEPTH) return;
      if (s.kind === 'field') {
        fields++;
        if (s.name === '__schema' || s.name === '__type') introspection = true;
        depth = Math.max(depth, d + 1);
        walk(s.sel, d + 1, path);
      } else if (s.kind === 'inline') walk(s.sel, d, path);
      else {
        if (path.includes(s.name)) throw new GraphqlSyntaxError(`The fragment ${s.name} spreads itself.`);
        const f = doc.fragments.get(s.name);
        if (!f) throw new GraphqlSyntaxError(`The fragment ${s.name} is not defined.`);
        walk(f, d, [...path, s.name]);
      }
    }
  };
  try {
    walk(op.sel, 0, []);
  } catch (err) {
    out.problems.push((err as Error).message);
    return out;
  }
  Object.assign(out, { depth, fields, introspection });
  if (depth > MAX_DEPTH) out.problems.push(`The query is nested deeper than ${MAX_DEPTH} levels.`);
  if (fields > MAX_FIELDS) out.problems.push(`The query selects more than ${MAX_FIELDS} fields.`);
  if (introspection && !opts.allowIntrospection) out.problems.push('Introspection (__schema, __type) is for the schema helper, not an endpoint.');
  out.ok = !out.problems.length;
  return out;
}

/** The root query fields the schema helper lists. */
export const INTROSPECTION_QUERY = `query ExprsnSchema {
  __schema {
    queryType { name }
    types {
      name
      kind
      fields { name description args { name type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }
    }
  }
}`;

interface TypeRef {
  kind: string;
  name: string | null;
  ofType?: TypeRef | null;
}

/** `[Order!]!` from an introspection type reference. */
export function typeName(t: TypeRef | null | undefined): string {
  if (!t) return '?';
  if (t.kind === 'NON_NULL') return `${typeName(t.ofType)}!`;
  if (t.kind === 'LIST') return `[${typeName(t.ofType)}]`;
  return t.name ?? '?';
}

export interface RootField {
  name: string;
  description: string | null;
  type: string;
  args: { name: string; type: string }[];
}

/** The Query type's fields from an introspection answer. */
export function rootFields(data: unknown): { queryType: string | null; fields: RootField[] } {
  const schema = (data as { __schema?: { queryType?: { name?: string } | null; types?: { name?: string; fields?: { name: string; description?: string | null; args?: { name: string; type: TypeRef }[]; type: TypeRef }[] | null }[] } } | null)?.__schema;
  const q = schema?.queryType?.name ?? null;
  const t = (schema?.types ?? []).find((x) => x.name === q);
  return {
    queryType: q,
    fields: (t?.fields ?? []).slice(0, 500).map((f) => ({ name: String(f.name).slice(0, 200), description: f.description ? String(f.description).slice(0, 500) : null, type: typeName(f.type), args: (f.args ?? []).slice(0, 50).map((a) => ({ name: String(a.name).slice(0, 200), type: typeName(a.type) })) }))
  };
}
