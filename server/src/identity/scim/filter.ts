/*
 * SCIM 2.0 filters and attribute paths (RFC 7644 sections 3.4.2.2 and 3.5.2).
 *
 *   FILTER    = attrExp / logExp / valuePath / *1"not" "(" FILTER ")" / "(" FILTER ")"
 *   valuePath = attrPath "[" valFilter "]"
 *   attrExp   = (attrPath SP "pr") / (attrPath SP compareOp SP compValue)
 *   compareOp = "eq" / "ne" / "co" / "sw" / "ew" / "gt" / "lt" / "ge" / "le"
 *   attrPath  = [URI ":"] ATTRNAME *1subAttr
 *
 * Operators and attribute names are case-insensitive; precedence is not, then and, then or. Strings compare without
 * case unless the attribute is case-exact (`id`, `externalId`, `meta.version`); timestamps compare as instants. A
 * multi-valued attribute matches when any value does; a complex multi-valued attribute without a sub-attribute
 * compares its `value`. The parser is a small recursive descent with a nesting cap, so a request cannot make it work
 * hard; evaluation is a pure function over the JSON resource.
 */

export class ScimFilterError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export type CompareOp = 'eq' | 'ne' | 'co' | 'sw' | 'ew' | 'gt' | 'lt' | 'ge' | 'le';
export type CompValue = string | number | boolean | null;

export interface AttrPath {
  /** The schema URN when the path named one (core URNs are dropped by `parsePath`'s callers). */
  urn: string | null;
  attr: string;
  sub: string | null;
}

export type Filter =
  | { kind: 'cmp'; path: AttrPath; op: CompareOp; value: CompValue }
  | { kind: 'pr'; path: AttrPath }
  | { kind: 'and' | 'or'; left: Filter; right: Filter }
  | { kind: 'not'; inner: Filter }
  | { kind: 'value'; path: AttrPath; filter: Filter };

const OPS = new Set(['eq', 'ne', 'co', 'sw', 'ew', 'gt', 'lt', 'ge', 'le']);
const MAX_DEPTH = 32;
const MAX_LEN = 4096;

export const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const ENTERPRISE_SCHEMA = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
const CORE_URNS = [USER_SCHEMA, GROUP_SCHEMA].map((u) => u.toLowerCase());
const KNOWN_URNS = [USER_SCHEMA, GROUP_SCHEMA, ENTERPRISE_SCHEMA];

/** Splits `urn:...:User:name.givenName` into the URN and the rest; a core schema URN is dropped. */
export function parseAttrPath(raw: string): AttrPath {
  let text = raw.trim();
  let urn: string | null = null;
  const lower = text.toLowerCase();
  for (const u of KNOWN_URNS) {
    const l = u.toLowerCase();
    if (lower === l) return { urn: CORE_URNS.includes(l) ? null : u, attr: '', sub: null };
    if (lower.startsWith(l + ':')) {
      urn = CORE_URNS.includes(l) ? null : u;
      text = text.slice(u.length + 1);
      break;
    }
  }
  if (!/^[A-Za-z$][\w$-]*(\.[A-Za-z$][\w$-]*)?$/.test(text)) throw new ScimFilterError(`"${raw.slice(0, 100)}" is not an attribute path.`);
  const [attr, sub] = text.split('.');
  return { urn, attr: attr!, sub: sub ?? null };
}

class Lexer {
  pos = 0;
  constructor(readonly src: string) {}

  ws(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos]!)) this.pos++;
  }

  peek(ch: string): boolean {
    this.ws();
    return this.src[this.pos] === ch;
  }

  eat(ch: string): void {
    this.ws();
    if (this.src[this.pos] !== ch) throw new ScimFilterError(`Expected "${ch}" at ${this.pos + 1}.`);
    this.pos++;
  }

  /** A bare word: an attribute path, an operator, a keyword (stops at space, brackets, parentheses, quote). */
  word(): string {
    this.ws();
    const start = this.pos;
    while (this.pos < this.src.length && !/[\s()[\]"]/.test(this.src[this.pos]!)) this.pos++;
    if (start === this.pos) throw new ScimFilterError(`Expected a word at ${start + 1}.`);
    return this.src.slice(start, this.pos);
  }

  peekWord(): string | null {
    const save = this.pos;
    try {
      return this.word().toLowerCase();
    } catch {
      return null;
    } finally {
      this.pos = save;
    }
  }

  value(): CompValue {
    this.ws();
    if (this.src[this.pos] === '"') {
      let out = '';
      this.pos++;
      while (this.pos < this.src.length) {
        const ch = this.src[this.pos++]!;
        if (ch === '\\') {
          const nx = this.src[this.pos++];
          if (nx === undefined) break;
          if (nx === 'u') {
            const hex = this.src.slice(this.pos, this.pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new ScimFilterError('A bad \\u escape in a string.');
            out += String.fromCharCode(parseInt(hex, 16));
            this.pos += 4;
          } else out += nx === 'n' ? '\n' : nx === 't' ? '\t' : nx === 'r' ? '\r' : nx === 'b' ? '\b' : nx === 'f' ? '\f' : nx;
        } else if (ch === '"') return out;
        else out += ch;
      }
      throw new ScimFilterError('A string in the filter is not closed.');
    }
    const w = this.word();
    const l = w.toLowerCase();
    if (l === 'true') return true;
    if (l === 'false') return false;
    if (l === 'null') return null;
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(w)) return Number(w);
    throw new ScimFilterError(`"${w.slice(0, 50)}" is not a value: quote strings.`);
  }

  done(): boolean {
    this.ws();
    return this.pos >= this.src.length;
  }
}

function parseOr(lx: Lexer, depth: number): Filter {
  let left = parseAnd(lx, depth);
  while (lx.peekWord() === 'or') {
    lx.word();
    left = { kind: 'or', left, right: parseAnd(lx, depth) };
  }
  return left;
}

function parseAnd(lx: Lexer, depth: number): Filter {
  let left = parseUnary(lx, depth);
  while (lx.peekWord() === 'and') {
    lx.word();
    left = { kind: 'and', left, right: parseUnary(lx, depth) };
  }
  return left;
}

function parseUnary(lx: Lexer, depth: number): Filter {
  if (depth > MAX_DEPTH) throw new ScimFilterError('The filter nests too deeply.');
  if (lx.peek('(')) {
    lx.eat('(');
    const f = parseOr(lx, depth + 1);
    lx.eat(')');
    return f;
  }
  const w = lx.peekWord();
  if (w === 'not') {
    const save = lx.pos;
    lx.word();
    if (lx.peek('(')) {
      lx.eat('(');
      const inner = parseOr(lx, depth + 1);
      lx.eat(')');
      return { kind: 'not', inner };
    }
    lx.pos = save; // an attribute named "not"
  }
  const path = parseAttrPath(lx.word());
  if (lx.peek('[')) {
    if (path.sub) throw new ScimFilterError('A value filter follows the attribute, not its sub-attribute.');
    lx.eat('[');
    const inner = parseOr(lx, depth + 1);
    lx.eat(']');
    // `emails[type eq "work"].value` is a path, not a filter; inside a filter the sub-attribute is not allowed.
    return { kind: 'value', path, filter: inner };
  }
  const op = lx.word().toLowerCase();
  if (op === 'pr') return { kind: 'pr', path };
  if (!OPS.has(op)) throw new ScimFilterError(`"${op.slice(0, 20)}" is not a comparison operator.`);
  return { kind: 'cmp', path, op: op as CompareOp, value: lx.value() };
}

export function parseFilter(text: string): Filter {
  if (text.length > MAX_LEN) throw new ScimFilterError('The filter is too long.');
  const lx = new Lexer(text);
  const f = parseOr(lx, 0);
  if (!lx.done()) throw new ScimFilterError(`Unexpected text at ${lx.pos + 1}.`);
  return f;
}

/** A PATCH path: `attr`, `attr.sub`, `attr[filter]` or `attr[filter].sub`, any of them after a schema URN. */
export interface PatchPath {
  path: AttrPath;
  filter: Filter | null;
}

export function parsePatchPath(text: string): PatchPath {
  if (text.length > MAX_LEN) throw new ScimFilterError('The path is too long.');
  const open = text.indexOf('[');
  if (open < 0) return { path: parseAttrPath(text), filter: null };
  const close = text.lastIndexOf(']');
  if (close < open) throw new ScimFilterError('A value filter in the path is not closed.');
  const base = parseAttrPath(text.slice(0, open));
  if (base.sub) throw new ScimFilterError('A value filter follows the attribute, not its sub-attribute.');
  const filter = parseFilter(text.slice(open + 1, close));
  const rest = text.slice(close + 1);
  if (rest && !/^\.[A-Za-z$][\w$-]*$/.test(rest)) throw new ScimFilterError(`Unexpected text after the value filter: "${rest.slice(0, 50)}".`);
  return { path: { ...base, sub: rest ? rest.slice(1) : null }, filter };
}

// ---------- evaluation ----------

/** Case-exact attributes (RFC 7643): compared as they are. */
const CASE_EXACT = new Set(['id', 'externalid', 'meta.version']);

/** A key of `obj` matching `name` without case. */
export function keyOf(obj: Record<string, unknown>, name: string): string | undefined {
  const l = name.toLowerCase();
  return Object.keys(obj).find((k) => k.toLowerCase() === l);
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The container an attribute path reads from: the resource, or its extension object. */
export function containerOf(resource: Record<string, unknown>, path: AttrPath): Record<string, unknown> | undefined {
  if (!path.urn) return resource;
  const k = keyOf(resource, path.urn);
  const v = k ? resource[k] : undefined;
  return isObj(v) ? v : undefined;
}

/** The values an attribute path names in a resource (flattened over multi-valued attributes). */
function valuesAt(resource: Record<string, unknown>, path: AttrPath, compareSubValue: boolean): unknown[] {
  const box = containerOf(resource, path);
  if (!box) return [];
  const k = keyOf(box, path.attr);
  if (k === undefined) return [];
  const top = box[k];
  const items = Array.isArray(top) ? top : [top];
  const out: unknown[] = [];
  for (const it of items) {
    if (path.sub) {
      if (isObj(it)) {
        const sk = keyOf(it, path.sub);
        if (sk !== undefined) out.push(it[sk]);
      }
    } else if (isObj(it) && compareSubValue && Array.isArray(top)) {
      const vk = keyOf(it, 'value');
      if (vk !== undefined) out.push(it[vk]);
    } else out.push(it);
  }
  return out;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function compare(actual: unknown, op: CompareOp, expected: CompValue, caseExact: boolean): boolean {
  if (expected === null) return op === 'eq' ? actual === null || actual === undefined : op === 'ne' ? actual !== null && actual !== undefined : false;
  if (actual === null || actual === undefined) return op === 'ne';
  if (typeof expected === 'boolean') {
    const a = typeof actual === 'boolean' ? actual : typeof actual === 'string' ? actual.toLowerCase() === 'true' : null;
    if (a === null) return op === 'ne';
    return op === 'eq' ? a === expected : op === 'ne' ? a !== expected : false;
  }
  if (typeof expected === 'number') {
    const a = typeof actual === 'number' ? actual : Number(actual);
    if (Number.isNaN(a)) return op === 'ne';
    switch (op) {
      case 'eq': return a === expected;
      case 'ne': return a !== expected;
      case 'gt': return a > expected;
      case 'ge': return a >= expected;
      case 'lt': return a < expected;
      case 'le': return a <= expected;
      default: return false;
    }
  }
  if (typeof actual !== 'string') return op === 'ne';
  if (ISO.test(actual) && ISO.test(expected) && ['gt', 'ge', 'lt', 'le', 'eq', 'ne'].includes(op)) {
    const a = Date.parse(actual);
    const e = Date.parse(expected);
    switch (op) {
      case 'eq': return a === e;
      case 'ne': return a !== e;
      case 'gt': return a > e;
      case 'ge': return a >= e;
      case 'lt': return a < e;
      case 'le': return a <= e;
    }
  }
  const a = caseExact ? actual : actual.toLowerCase();
  const e = caseExact ? expected : expected.toLowerCase();
  switch (op) {
    case 'eq': return a === e;
    case 'ne': return a !== e;
    case 'co': return a.includes(e);
    case 'sw': return a.startsWith(e);
    case 'ew': return a.endsWith(e);
    case 'gt': return a > e;
    case 'ge': return a >= e;
    case 'lt': return a < e;
    case 'le': return a <= e;
  }
}

const pathKey = (p: AttrPath) => (p.sub ? `${p.attr}.${p.sub}` : p.attr).toLowerCase();

export function matches(resource: Record<string, unknown>, f: Filter): boolean {
  switch (f.kind) {
    case 'and':
      return matches(resource, f.left) && matches(resource, f.right);
    case 'or':
      return matches(resource, f.left) || matches(resource, f.right);
    case 'not':
      return !matches(resource, f.inner);
    case 'pr': {
      const vals = valuesAt(resource, f.path, false);
      return vals.some((v) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length) && !(isObj(v) && !Object.keys(v).length));
    }
    case 'cmp': {
      const vals = valuesAt(resource, f.path, true);
      const exact = CASE_EXACT.has(pathKey(f.path));
      if (f.op === 'ne') return !vals.some((v) => compare(v, 'eq', f.value, exact));
      return vals.some((v) => compare(v, f.op, f.value, exact));
    }
    case 'value': {
      const box = containerOf(resource, f.path);
      const k = box ? keyOf(box, f.path.attr) : undefined;
      const top = box && k !== undefined ? box[k] : undefined;
      const items = Array.isArray(top) ? top : top === undefined ? [] : [top];
      return items.some((it) => isObj(it) && matches(it, f.filter));
    }
  }
}

/**
 * When a filter is one top-level `eq` on a column the store indexes (`userName`, `externalId`, `id`, `displayName`),
 * the attribute and value, so the list can ask the database instead of reading every resource.
 */
export function simpleEq(f: Filter): { attr: string; value: string } | null {
  if (f.kind !== 'cmp' || f.op !== 'eq' || f.path.urn || f.path.sub || typeof f.value !== 'string') return null;
  const a = f.path.attr.toLowerCase();
  return ['username', 'externalid', 'id', 'displayname'].includes(a) ? { attr: a, value: f.value } : null;
}
