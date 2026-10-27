import { attr, elements, parseXml, type XmlElement } from '../federation/xml.js';

/*
 * 1.9.0: OData v4 for API connections (protocol `odata`, rest.ts).
 *
 * - `$metadata` (CSDL XML) is read with the strict parser (no DOCTYPE, so no entities) into what the editor and the
 *   checks need: entity sets and singletons with their entity type's properties (Edm type, nullable, key) and
 *   navigation properties. Actions and action imports are listed so the editor can say they exist, but are never
 *   callable; functions are left out too, because nothing in the metadata says one has no side effects.
 * - An endpoint names an entity set (or singleton) and its query options: `$select` and `$expand` from the metadata's
 *   names, `$orderby` of properties, and `$filter` / `$search` templates whose `{param}` placeholders become OData
 *   literals escaped by the type of the property they are compared with (else the parameter's own type), never text
 *   pasted in. A filter template is tokenised at save and at every read: property names, operators, the standard
 *   functions, literals and placeholders only.
 */

export const MAX_METADATA_BYTES = 2 * 1024 * 1024;

const EDMX = 'http://docs.oasis-open.org/odata/ns/edmx';
const EDM = 'http://docs.oasis-open.org/odata/ns/edm';

export interface ODataProperty {
  name: string;
  type: string;
  nullable: boolean;
  key: boolean;
}

export interface ODataNavigation {
  name: string;
  type: string;
  collection: boolean;
}

export interface ODataSet {
  name: string;
  /** `set` (a collection) or `singleton` (one entity). */
  kind: 'set' | 'singleton';
  entityType: string;
  properties: ODataProperty[];
  navigation: ODataNavigation[];
}

export interface ODataMeta {
  kind: 'odata';
  version: string | null;
  namespaces: string[];
  sets: ODataSet[];
  /** Listed, never called. */
  actions: string[];
  /** Listed, never called (side effects cannot be known). */
  functions: string[];
  notes: string[];
}

const unwrapCollection = (t: string): { type: string; collection: boolean } => {
  const m = /^Collection\((.+)\)$/.exec(t);
  return m ? { type: m[1]!, collection: true } : { type: t, collection: false };
};

/** Reads CSDL `$metadata`. Throws on a document that is not OData v4 metadata. */
export function parseMetadata(xml: string): ODataMeta {
  const root = parseXml(xml, MAX_METADATA_BYTES);
  if (root.ns !== EDMX || root.local !== 'Edmx') throw new Error('The document is not OData v4 metadata (edmx:Edmx).');
  const notes: string[] = [];
  if (elements(root, EDMX, 'Reference').length) notes.push('Referenced documents (edmx:Reference) are not read; types from them are unknown.');
  const services = elements(root, EDMX, 'DataServices');
  const schemas = services.flatMap((d) => elements(d, EDM, 'Schema'));
  if (!schemas.length) throw new Error('The metadata has no Schema.');
  // Entity types by every name they can be referred to: Namespace.Name and Alias.Name.
  const types = new Map<string, { el: XmlElement; ns: string }>();
  const namespaces: string[] = [];
  for (const sc of schemas) {
    const ns = attr(sc, 'Namespace') ?? '';
    const alias = attr(sc, 'Alias');
    namespaces.push(ns);
    for (const t of elements(sc, EDM, 'EntityType')) {
      const name = attr(t, 'Name') ?? '';
      types.set(`${ns}.${name}`, { el: t, ns });
      if (alias) types.set(`${alias}.${name}`, { el: t, ns });
    }
  }
  const resolve = (qualified: string, seen = new Set<string>()): { properties: ODataProperty[]; navigation: ODataNavigation[]; keys: string[] } => {
    const t = types.get(qualified);
    if (!t || seen.has(qualified) || seen.size > 10) return { properties: [], navigation: [], keys: [] };
    seen.add(qualified);
    const baseType = attr(t.el, 'BaseType');
    const inherited = baseType ? resolve(baseType, seen) : { properties: [], navigation: [], keys: [] };
    const keyEl = elements(t.el, EDM, 'Key')[0];
    const keys = keyEl ? elements(keyEl, EDM, 'PropertyRef').map((r) => attr(r, 'Name') ?? '').filter(Boolean) : inherited.keys;
    const properties = [...inherited.properties, ...elements(t.el, EDM, 'Property').map((p) => ({ name: attr(p, 'Name') ?? '', type: attr(p, 'Type') ?? 'Edm.String', nullable: attr(p, 'Nullable') !== 'false', key: false }))];
    const navigation = [...inherited.navigation, ...elements(t.el, EDM, 'NavigationProperty').map((n) => ({ name: attr(n, 'Name') ?? '', ...unwrapCollection(attr(n, 'Type') ?? '') }))];
    return { properties: properties.map((p) => ({ ...p, key: keys.includes(p.name) })), navigation, keys };
  };
  const sets: ODataSet[] = [];
  const actions: string[] = [];
  const functions: string[] = [];
  for (const sc of schemas) {
    for (const a of elements(sc, EDM, 'Action')) actions.push(attr(a, 'Name') ?? '');
    for (const f of elements(sc, EDM, 'Function')) functions.push(attr(f, 'Name') ?? '');
    for (const container of elements(sc, EDM, 'EntityContainer')) {
      for (const es of elements(container, EDM, 'EntitySet')) {
        const type = attr(es, 'EntityType') ?? '';
        const r = resolve(type);
        sets.push({ name: attr(es, 'Name') ?? '', kind: 'set', entityType: type, properties: r.properties, navigation: r.navigation });
      }
      for (const sg of elements(container, EDM, 'Singleton')) {
        const type = attr(sg, 'Type') ?? '';
        const r = resolve(type);
        sets.push({ name: attr(sg, 'Name') ?? '', kind: 'singleton', entityType: type, properties: r.properties, navigation: r.navigation });
      }
      for (const ai of elements(container, EDM, 'ActionImport')) actions.push(attr(ai, 'Name') ?? '');
      for (const fi of elements(container, EDM, 'FunctionImport')) functions.push(attr(fi, 'Name') ?? '');
    }
  }
  if (!sets.length) throw new Error('The metadata has no entity sets or singletons.');
  if (actions.length) notes.push(`Actions are never called through a connection (${[...new Set(actions)].slice(0, 10).join(', ')}).`);
  if (functions.length) notes.push(`Functions are not offered: the metadata cannot say they have no side effects (${[...new Set(functions)].slice(0, 10).join(', ')}).`);
  return { kind: 'odata', version: attr(root, 'Version') ?? null, namespaces, sets: sets.filter((x) => x.name).slice(0, 2000), actions: [...new Set(actions.filter(Boolean))], functions: [...new Set(functions.filter(Boolean))], notes };
}

// ---------- query options ----------

const OPERATORS = new Set(['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'and', 'or', 'not', 'has', 'in', 'add', 'sub', 'mul', 'div', 'divby', 'mod']);
const FUNCTIONS = new Set([
  'contains', 'startswith', 'endswith', 'length', 'indexof', 'substring', 'tolower', 'toupper', 'trim', 'concat', 'matchespattern',
  'year', 'month', 'day', 'hour', 'minute', 'second', 'fractionalseconds', 'totalseconds', 'date', 'time', 'totaloffsetminutes', 'now', 'mindatetime', 'maxdatetime',
  'round', 'floor', 'ceiling'
]);
const LITERAL_WORDS = new Set(['true', 'false', 'null']);

type Tok = { t: 'name' | 'op' | 'fn' | 'lit' | 'param' | 'punct'; v: string };

/** Tokens of a `$filter` template, or the reason it is refused. */
function tokenize(src: string): Tok[] | string {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= src.length) return 'The filter has an unterminated string.';
        if (src[j] === "'" && src[j + 1] === "'") j += 2;
        else if (src[j] === "'") break;
        else j++;
      }
      out.push({ t: 'lit', v: src.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    const param = /^\{([a-z][a-z0-9_]{0,62})\}/.exec(src.slice(i));
    if (param) {
      out.push({ t: 'param', v: param[1]! });
      i += param[0].length;
      continue;
    }
    // Numbers, dates and times, GUIDs: literal forms that start with a digit or a sign.
    const lit = /^(-?\d[\d.:TZ+-]*(?:[eE][+-]?\d+)?[mMdDfFlL]?|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/.exec(src.slice(i));
    if (lit && /[\d-]/.test(c)) {
      out.push({ t: 'lit', v: lit[0] });
      i += lit[0].length;
      continue;
    }
    if (c === '(' || c === ')' || c === ',') {
      out.push({ t: 'punct', v: c });
      i++;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*(\/[A-Za-z_][A-Za-z0-9_]*)*/.exec(src.slice(i));
    if (word) {
      const w = word[0];
      const lower = w.toLowerCase();
      if (OPERATORS.has(w)) out.push({ t: 'op', v: w });
      else if (LITERAL_WORDS.has(w)) out.push({ t: 'lit', v: w });
      else if (FUNCTIONS.has(lower) && src.slice(i + w.length).trimStart().startsWith('(')) out.push({ t: 'fn', v: lower });
      else out.push({ t: 'name', v: w });
      i += w.length;
      continue;
    }
    return `The filter has ${JSON.stringify(c)}, which is not part of a property, operator, function, literal or {parameter}.`;
  }
  return out;
}

/** The property a name token refers to (the first segment of a path, which must be a property or navigation). */
function nameProblem(name: string, set: ODataSet): string | null {
  const [first, ...rest] = name.split('/');
  if (set.properties.some((p) => p.name === first)) return rest.length ? null : null;
  if (set.navigation.some((n) => n.name === first)) return rest.length ? null : `${first} is a navigation property; name one of its properties (${first}/Name).`;
  return `${first} is not a property of ${set.name} (${set.properties.map((p) => p.name).slice(0, 15).join(', ')}).`;
}

/** Problems with a `$filter` template on an entity set: only its names, operators, functions, literals and parameters. */
export function filterProblems(template: string, set: ODataSet, params: ReadonlySet<string>): string[] {
  const toks = tokenize(template);
  if (typeof toks === 'string') return [toks];
  const out: string[] = [];
  let depth = 0;
  for (const tk of toks) {
    if (tk.t === 'name') {
      const p = nameProblem(tk.v, set);
      if (p) out.push(p);
    } else if (tk.t === 'param' && !params.has(tk.v)) out.push(`{${tk.v}} is not a parameter of this endpoint.`);
    else if (tk.v === '(') depth++;
    else if (tk.v === ')' && --depth < 0) out.push('The filter has a ) without its (.');
  }
  if (depth > 0) out.push('The filter has a ( without its ).');
  if (depth > 20) out.push('The filter is nested too deeply.');
  return [...new Set(out)];
}

/** Problems with `$orderby`: a comma list of property paths, each optionally `asc` or `desc`. */
export function orderbyProblems(orderby: string, set: ODataSet): string[] {
  const out: string[] = [];
  for (const part of orderby.split(',').map((x) => x.trim())) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*(?:\/[A-Za-z_][A-Za-z0-9_]*)*)(?:\s+(asc|desc))?$/.exec(part);
    if (!m) {
      out.push(`${part.slice(0, 60)} is not a property followed by asc or desc.`);
      continue;
    }
    const p = nameProblem(m[1]!, set);
    if (p) out.push(p);
  }
  return out;
}

/** Problems with a `$search` template: words, quoted phrases, AND, OR, NOT, parentheses and parameters. */
export function searchProblems(template: string, params: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const rest = template.replace(/"(?:[^"\\]|\\.)*"/g, ' ').replace(/\{([a-z][a-z0-9_]{0,62})\}/g, (_m, n: string) => {
    if (!params.has(n)) out.push(`{${n}} is not a parameter of this endpoint.`);
    return ' ';
  });
  if (/"/.test(rest)) out.push('The search has an unterminated phrase.');
  if (/[^A-Za-z0-9_\s()-]/.test(rest)) out.push('The search may hold words, "phrases", AND, OR, NOT, parentheses and {parameters} only.');
  return out;
}

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const NUMERIC = /^Edm\.(Int16|Int32|Int64|Byte|SByte|Decimal|Double|Single)$/;

/** One value as an OData literal of `edm` type (or of its own JS type when unknown). Throws for a value it cannot be. */
export function odataLiteral(v: unknown, edm: string | null): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `(${v.map((x) => odataLiteral(x, edm)).join(',')})`;
  if (edm === 'Edm.Guid') {
    if (typeof v !== 'string' || !GUID.test(v)) throw new Error(`${String(v).slice(0, 60)} is not a GUID`);
    return v.toLowerCase();
  }
  if (edm === 'Edm.DateTimeOffset' || edm === 'Edm.Date') {
    const d = new Date(String(v));
    if (Number.isNaN(d.getTime())) throw new Error(`${String(v).slice(0, 60)} is not a date`);
    return edm === 'Edm.Date' ? d.toISOString().slice(0, 10) : d.toISOString();
  }
  if (edm === 'Edm.Boolean') {
    if (typeof v === 'boolean') return String(v);
    if (v === 'true' || v === 'false') return v;
    throw new Error(`${String(v).slice(0, 60)} is not true or false`);
  }
  if ((edm && NUMERIC.test(edm)) || (!edm && typeof v === 'number')) {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n) || (typeof v === 'string' && v.trim() === '')) throw new Error(`${String(v).slice(0, 60)} is not a number`);
    return String(n);
  }
  if (!edm && typeof v === 'boolean') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * A `$filter` template with its placeholders as literals. A placeholder takes the type of the property it is
 * compared with (`Price gt {min}`, `{min} lt Price`, `Id in ({ids})`), or of a function's first argument
 * (`contains(Name, {q})`); otherwise the parameter's own type decides (dates are DateTimeOffset).
 */
export function renderFilter(template: string, set: ODataSet, values: Record<string, unknown>, paramTypes: Record<string, string>): string {
  const toks = tokenize(template);
  if (typeof toks === 'string') throw new Error(toks);
  const typeOf = (name: string): string | null => set.properties.find((p) => p.name === name.split('/')[0] && !name.includes('/'))?.type ?? null;
  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i]!;
    if (tk.t !== 'param') {
      out.push(tk.v);
      continue;
    }
    // The property this value meets: before an operator, after one, or the first argument of the enclosing function.
    let edm: string | null = null;
    const prev = toks[i - 1];
    const prev2 = toks[i - 2];
    const next = toks[i + 1];
    const next2 = toks[i + 2];
    if (prev?.t === 'op' && prev2?.t === 'name') edm = typeOf(prev2.v);
    else if (next?.t === 'op' && next2?.t === 'name') edm = typeOf(next2.v);
    else if (prev?.v === '(' && prev2?.t === 'op' && prev2.v === 'in' && toks[i - 3]?.t === 'name') edm = typeOf(toks[i - 3]!.v);
    else if (prev?.v === ',' && prev2?.t === 'name' && toks[i - 3]?.v === '(' && toks[i - 4]?.t === 'fn') edm = typeOf(prev2.v);
    if (edm && /^Edm\.String$/.test(edm)) edm = 'Edm.String';
    if (!edm && paramTypes[tk.v] === 'date') edm = 'Edm.DateTimeOffset';
    const v = values[tk.v];
    // A list in an `in (...)` already sits in parentheses: its items go in as a comma list.
    const lit = Array.isArray(v) && prev?.v === '(' && next?.v === ')' ? v.map((x) => odataLiteral(x, edm)).join(',') : odataLiteral(v, edm);
    out.push(lit);
  }
  // A function name meets its parenthesis; elsewhere one space (OData allows whitespace between tokens).
  let text = '';
  for (let i = 0; i < out.length; i++) {
    const glue = i === 0 || toks[i - 1]!.t === 'fn' || toks[i - 1]!.v === '(' || toks[i - 1]!.v === ',' || toks[i]!.v === ')' || toks[i]!.v === ',';
    text += (glue ? '' : ' ') + out[i];
  }
  return text;
}

/** A `$search` template with each placeholder as a quoted phrase (quotes and backslashes escaped). */
export function renderSearch(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{([a-z][a-z0-9_]{0,62})\}/g, (_m, n: string) => {
    const v = values[n];
    const text = Array.isArray(v) ? v.join(' ') : v == null ? '' : String(v);
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  });
}

/** An OData error answer's message, or null. */
export function odataError(doc: unknown): { code: string | null; message: string } | null {
  const e = doc && typeof doc === 'object' ? (doc as { error?: { code?: unknown; message?: unknown } }).error : undefined;
  if (!e || typeof e !== 'object') return null;
  const m = e.message;
  const message = typeof m === 'string' ? m : m && typeof m === 'object' && typeof (m as { value?: unknown }).value === 'string' ? (m as { value: string }).value : 'error';
  return { code: typeof e.code === 'string' ? e.code : null, message };
}
