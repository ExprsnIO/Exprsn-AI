/*
 * Formula fields (B-2203): a small expression language parsed into a tree and evaluated by walking it. There is no
 * `eval`, no `Function`, no property access and no indexing, so a formula cannot reach a global, a prototype or the
 * process: the only names it can read are the entity's own fields (checked when the formula is compiled, read at run
 * time from a Map built from the record's own keys) and the only things it can call are the functions in `FUNCTIONS`
 * (a Map, so `constructor` or `__proto__` are simply unknown names).
 *
 *   literals     12, 3.5, 'text', "text", true, false, null
 *   operators    + - * / %   & (join as text)   = == != <> < <= > >=   and or not  && || !   unary -   ( )
 *   functions    the library in formula-functions.ts (about 70 since 1.8.0, B-141); `formulaCatalogue()` lists them
 *
 * Errors while evaluating (a type mismatch, division by zero) give null rather than throwing: a formula fails soft.
 * Since 1.8.0 a value may also be a list (Split, List, a field holding a JSON array); a formula whose result is a list
 * gives it as text, its items joined by ", ". Every node and every piece of work a function does (per item, per
 * thousand characters) counts toward MAX_STEPS.
 */

import { FormulaBudget, FUNCTIONS, FUNCTION_NAMES, FORMAT_HELP, formulaCatalogue, isList, isNum, kindName, MAX_LIST, MAX_TEXT, numeric, parseFormat, toText, toWhen, zoneFormatter, blank, cap, type Fn, type Kind, type Result, type RunCtx, type Scalar, type V } from './formula-functions.js';

export class FormulaError extends Error {}

type Node =
  | { k: 'lit'; v: Value }
  | { k: 'ref'; name: string }
  | { k: 'un'; op: '-' | 'not'; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'call'; fn: string; args: Node[] };

export type Value = string | number | boolean | null;

export const MAX_FORMULA_LENGTH = 2000;
const MAX_DEPTH = 40;
const MAX_STEPS = 20_000;

type Tok = { t: 'num'; v: number } | { t: 'str'; v: string } | { t: 'id'; v: string } | { t: 'op'; v: string } | { t: 'end' };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const two = ['==', '!=', '<>', '<=', '>=', '&&', '||'];
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i))!;
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let s = '';
      for (;;) {
        if (j >= src.length) throw new FormulaError('A text value is not closed.');
        const d = src[j]!;
        if (d === c) {
          if (src[j + 1] === c) {
            s += c;
            j += 2;
            continue;
          }
          break;
        }
        s += d;
        j++;
      }
      out.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    const pair = src.slice(i, i + 2);
    if (two.includes(pair)) {
      out.push({ t: 'op', v: pair });
      i += 2;
      continue;
    }
    if ('+-*/%&=<>!(),'.includes(c)) {
      out.push({ t: 'op', v: c });
      i++;
      continue;
    }
    throw new FormulaError(`Unexpected character ${JSON.stringify(c)} at position ${i + 1}.`);
  }
  out.push({ t: 'end' });
  return out;
}

// A Map, so a name like `constructor` is not found on a prototype.
const WORD_OPS = new Map<string, string>([
  ['and', '&&'],
  ['or', '||'],
  ['not', '!']
]);

class Parser {
  private i = 0;
  constructor(private readonly toks: Tok[]) {}

  private peek(): Tok {
    return this.toks[this.i]!;
  }

  private isOp(v: string): boolean {
    const t = this.peek();
    return (t.t === 'op' && t.v === v) || (t.t === 'id' && WORD_OPS.get(t.v.toLowerCase()) === v);
  }

  private take(v: string): void {
    if (!this.isOp(v)) throw new FormulaError(`Expected ${v}.`);
    this.i++;
  }

  parse(): Node {
    const n = this.or(0);
    if (this.peek().t !== 'end') throw new FormulaError('Unexpected text after the end of the formula.');
    return n;
  }

  /** `depth` counts nesting (parentheses, arguments, repeated `-` or `not`), not precedence levels (since 1.8.0). */
  private guard(depth: number): void {
    if (depth > MAX_DEPTH) throw new FormulaError('The formula is nested too deeply.');
  }

  private or(d: number): Node {
    this.guard(d);
    let a = this.and(d);
    while (this.isOp('||')) {
      this.i++;
      a = { k: 'bin', op: '||', a, b: this.and(d) };
    }
    return a;
  }

  private and(d: number): Node {
    let a = this.not(d);
    while (this.isOp('&&')) {
      this.i++;
      a = { k: 'bin', op: '&&', a, b: this.not(d) };
    }
    return a;
  }

  private not(d: number): Node {
    this.guard(d);
    if (this.isOp('!')) {
      this.i++;
      return { k: 'un', op: 'not', a: this.not(d + 1) };
    }
    return this.cmp(d);
  }

  private cmp(d: number): Node {
    let a = this.concat(d);
    for (;;) {
      const t = this.peek();
      if (t.t !== 'op' || !['=', '==', '!=', '<>', '<', '<=', '>', '>='].includes(t.v)) return a;
      this.i++;
      const op = t.v === '==' ? '=' : t.v === '<>' ? '!=' : t.v;
      a = { k: 'bin', op, a, b: this.concat(d) };
    }
  }

  private concat(d: number): Node {
    let a = this.add(d);
    while (this.isOp('&')) {
      this.i++;
      a = { k: 'bin', op: '&', a, b: this.add(d) };
    }
    return a;
  }

  private add(d: number): Node {
    let a = this.mul(d);
    for (;;) {
      const t = this.peek();
      if (t.t !== 'op' || (t.v !== '+' && t.v !== '-')) return a;
      this.i++;
      a = { k: 'bin', op: t.v, a, b: this.mul(d) };
    }
  }

  private mul(d: number): Node {
    let a = this.unary(d);
    for (;;) {
      const t = this.peek();
      if (t.t !== 'op' || !['*', '/', '%'].includes(t.v)) return a;
      this.i++;
      a = { k: 'bin', op: t.v, a, b: this.unary(d) };
    }
  }

  private unary(d: number): Node {
    this.guard(d);
    if (this.isOp('-')) {
      this.i++;
      return { k: 'un', op: '-', a: this.unary(d + 1) };
    }
    if (this.isOp('+')) {
      this.i++;
      return this.unary(d + 1);
    }
    return this.primary(d);
  }

  private primary(d: number): Node {
    this.guard(d);
    const t = this.peek();
    if (t.t === 'num') {
      this.i++;
      return { k: 'lit', v: t.v };
    }
    if (t.t === 'str') {
      this.i++;
      return { k: 'lit', v: t.v };
    }
    if (t.t === 'op' && t.v === '(') {
      this.i++;
      const n = this.or(d + 1);
      this.take(')');
      return n;
    }
    if (t.t === 'id') {
      this.i++;
      const lower = t.v.toLowerCase();
      if (lower === 'true' || lower === 'false') return { k: 'lit', v: lower === 'true' };
      if (lower === 'null') return { k: 'lit', v: null };
      if (WORD_OPS.has(lower)) throw new FormulaError(`${t.v} needs something before it.`);
      if (this.isOp('(')) {
        this.i++;
        const args: Node[] = [];
        if (!this.isOp(')')) {
          for (;;) {
            args.push(this.or(d + 1));
            if (this.isOp(',')) {
              this.i++;
              continue;
            }
            break;
          }
        }
        this.take(')');
        return { k: 'call', fn: lower, args };
      }
      return { k: 'ref', name: t.v };
    }
    if (t.t === 'end') throw new FormulaError('The formula ends too early.');
    throw new FormulaError(`Unexpected ${t.v}.`);
  }
}

// ---------- functions ----------

// The library lives in formula-functions.ts (B-141); this file keeps the language: parsing, checks and evaluation.

export const FORMULA_FUNCTIONS = FUNCTION_NAMES;
export { formulaCatalogue };

// ---------- compile and evaluate ----------

export interface Formula {
  /** The field names the formula reads. */
  refs: string[];
  evaluate(values: ReadonlyMap<string, unknown>): Value;
}

/** The name CountIf's condition reads each item by. */
const ITEM = 'item';

/** A field value as a formula reads it: scalars as they are, a JSON array of scalars as a list, anything else null. */
const asValue = (v: unknown): V => {
  if (v == null) return null;
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (Array.isArray(v)) {
    // Only a list of scalars: an array holding objects or arrays reads as null, as every array did before 1.8.0.
    if (!v.every((x) => x == null || typeof x === 'string' || typeof x === 'boolean' || typeof x === 'number')) return null;
    return v.slice(0, MAX_LIST).map((x) => asValue(x) as Scalar);
  }
  return null;
};

function compare(op: string, a: V, b: V): boolean | null {
  if (isList(a) || isList(b)) {
    if (op !== '=' && op !== '!=') return null;
    const eq = isList(a) && isList(b) && a.length === b.length && a.every((x, i) => compare('=', x, b[i]!) === true);
    return op === '=' ? eq : !eq;
  }
  if (op === '=' || op === '!=') {
    // A number equals a text that reads as the same number ('3' = 3); otherwise values are equal only when identical.
    const eq = a === b || (typeof a !== typeof b && a != null && b != null && numeric(a) != null && numeric(a) === numeric(b));
    return op === '=' ? eq : !eq;
  }
  if (a == null || b == null) return null;
  if (isNum(a) && isNum(b)) return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
  if (typeof a === 'string' && typeof b === 'string') return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
  return null;
}

const truthy = (v: V): boolean => (isList(v) ? v.length > 0 : v !== null && v !== false && v !== 0 && v !== '');

// ---------- parse-time checks (B-141) ----------

const ORDINAL = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];
const nth = (i: number) => ORDINAL[i] ?? `${i + 1}th`;

/** What a node gives, as far as can be told before it runs. */
function resultOf(n: Node): Result | 'item' {
  switch (n.k) {
    case 'lit':
      return n.v == null ? 'any' : typeof n.v === 'number' ? 'num' : typeof n.v === 'boolean' ? 'bool' : 'text';
    case 'ref':
      return 'any';
    case 'un':
      return n.op === '-' ? 'num' : 'bool';
    case 'bin':
      return n.op === '&' ? 'text' : ['+', '-', '*', '/', '%'].includes(n.op) ? 'num' : 'bool';
    case 'call':
      return FUNCTIONS.get(n.fn)?.returns ?? 'any';
  }
}

const describe = (r: Result | 'item'): string => (r === 'num' ? 'a number' : r === 'text' ? 'text' : r === 'bool' ? 'true or false' : r === 'list' ? 'a list' : r === 'date' ? 'a date' : 'a value');

/** Throws when an argument cannot be of the kind a parameter takes. Unknown kinds (fields, `any` results) pass. */
function checkArg(f: Fn, i: number, kind: Kind, arg: Node): void {
  if (kind === 'any') return;
  const got = resultOf(arg);
  const lit = arg.k === 'lit' ? arg.v : undefined;
  const fail = (what: string) => {
    throw new FormulaError(`${f.name}'s ${nth(i)} argument is ${what}; it is given ${arg.k === 'lit' ? (typeof lit === 'string' ? `'${lit.length > 30 ? `${lit.slice(0, 30)}…` : lit}'` : String(lit)) : describe(got)}. ${f.signature}.`);
  };
  if (lit === null) return;
  if (typeof kind === 'object') {
    if (got === 'list' || got === 'num' || got === 'bool') fail(kindName(kind));
    if (typeof lit === 'string' && !kind.enum.includes(lit.trim().toLowerCase())) fail(kindName(kind));
    return;
  }
  switch (kind) {
    case 'num':
      if (got === 'list' || got === 'bool' || got === 'date') fail('a number');
      if (got === 'text' && (typeof lit !== 'string' || numeric(lit) == null)) fail('a number');
      return;
    case 'date':
      if (got === 'list' || got === 'bool') fail('a date');
      if (typeof lit === 'string' && !toWhen(lit)) fail('a date (YYYY-MM-DD, or an ISO date and time)');
      if (got === 'text' && lit === undefined && arg.k === 'call') fail('a date');
      return;
    case 'list':
      if (got === 'num' || got === 'bool' || got === 'text' || got === 'date') fail('a list');
      return;
    case 'zone':
      if (got === 'list' || got === 'num' || got === 'bool') fail('a time zone');
      if (typeof lit === 'string' && !zoneFormatter(lit)) fail('a time zone such as UTC or Europe/Lisbon');
      return;
    case 'fmt':
      if (got === 'list' || got === 'num' || got === 'bool') fail('a format');
      if (typeof lit === 'string' && !parseFormat(lit)) fail(FORMAT_HELP);
      return;
    case 'text':
      if (got === 'list') fail('text');
      return;
    case 'bool':
      return;
  }
}

/**
 * Parses a formula and checks every name against `fields` (the entity's fields a formula may read) and every function
 * against the library: its number of arguments and, for the functions added in 1.8.0, the kind of each argument that
 * can be told before it runs. Throws a FormulaError that says what is wrong.
 */
export function compileFormula(src: string, fields: ReadonlySet<string>): Formula {
  if (src.length > MAX_FORMULA_LENGTH) throw new FormulaError(`A formula has at most ${MAX_FORMULA_LENGTH} characters.`);
  const tree = new Parser(tokenize(src)).parse();
  const refs = new Set<string>();
  const check = (n: Node, inPredicate: boolean): void => {
    if (n.k === 'ref') {
      if (inPredicate && n.name === ITEM) return;
      if (!fields.has(n.name)) throw new FormulaError(`${n.name} is not a field this formula can read${n.name === ITEM ? ' (item is read only inside CountIf\'s condition)' : ''}.`);
      refs.add(n.name);
      return;
    }
    if (n.k === 'un') return check(n.a, inPredicate);
    if (n.k === 'bin') {
      check(n.a, inPredicate);
      check(n.b, inPredicate);
      return;
    }
    if (n.k === 'call') {
      const f = FUNCTIONS.get(n.fn);
      if (!f) throw new FormulaError(`${n.fn} is not a formula function.`);
      if (n.args.length < f.min || n.args.length > f.max) throw new FormulaError(`${f.name} takes ${f.min === f.max ? f.min : f.max >= 20 ? `at least ${f.min}` : `${f.min} to ${f.max}`} argument${f.max === 1 && f.min === 1 ? '' : 's'}: ${f.signature}.`);
      n.args.forEach((a, i) => checkArg(f, i, f.params[i] ?? f.rest ?? 'any', a));
      n.args.forEach((a, i) => check(a, inPredicate || (n.fn === 'countif' && i === 1)));
    }
  };
  check(tree, false);
  return {
    refs: [...refs],
    evaluate(values) {
      let steps = 0;
      const ctx: RunCtx = {
        charge(units) {
          steps += units;
          if (steps > MAX_STEPS) throw new FormulaBudget('The formula took too many steps.');
        }
      };
      const ev = (n: Node, item: { v: V } | null): V => {
        ctx.charge(1);
        switch (n.k) {
          case 'lit':
            return n.v;
          case 'ref':
            return item && n.name === ITEM ? item.v : asValue(values.get(n.name));
          case 'un': {
            const a = ev(n.a, item);
            if (n.op === 'not') return !truthy(a);
            return isNum(a) ? -a : null;
          }
          case 'bin': {
            if (n.op === '&&') return truthy(ev(n.a, item)) && truthy(ev(n.b, item));
            if (n.op === '||') return truthy(ev(n.a, item)) || truthy(ev(n.b, item));
            const a = ev(n.a, item);
            const b = ev(n.b, item);
            if (n.op === '&') return cap(toText(a) + toText(b));
            if (['=', '!=', '<', '<=', '>', '>='].includes(n.op)) return compare(n.op, a, b);
            if (!isNum(a) || !isNum(b)) return null;
            const r = n.op === '+' ? a + b : n.op === '-' ? a - b : n.op === '*' ? a * b : n.op === '/' ? (b === 0 ? null : a / b) : b === 0 ? null : a % b;
            return r == null || !Number.isFinite(r) ? null : r;
          }
          case 'call': {
            const f = FUNCTIONS.get(n.fn)!;
            const arg = (i: number) => ev(n.args[i]!, item);
            switch (n.fn) {
              case 'if':
                return truthy(arg(0)) ? arg(1) : n.args[2] ? arg(2) : null;
              case 'coalesce':
                for (let i = 0; i < n.args.length; i++) {
                  const v = arg(i);
                  if (v != null && v !== '') return v;
                }
                return null;
              case 'switch': {
                const v = arg(0);
                let i = 1;
                for (; i + 1 < n.args.length; i += 2) if (compare('=', v, arg(i)) === true) return arg(i + 1);
                return i < n.args.length ? arg(i) : null;
              }
              case 'iferror': {
                try {
                  const v = arg(0);
                  return blank(v) && !isList(v) ? arg(1) : v;
                } catch (err) {
                  if (err instanceof FormulaBudget) throw err;
                  return arg(1);
                }
              }
              case 'countif': {
                const list = arg(0);
                const items: Scalar[] = isList(list) ? list : list == null ? [] : [list];
                const pred = n.args[1]!;
                let usesItem = false;
                const scan = (x: Node): void => {
                  if (x.k === 'ref' && x.name === ITEM) usesItem = true;
                  else if (x.k === 'un') scan(x.a);
                  else if (x.k === 'bin') {
                    scan(x.a);
                    scan(x.b);
                  }
                  else if (x.k === 'call') x.args.forEach(scan);
                };
                scan(pred);
                if (!usesItem) {
                  const target = ev(pred, item);
                  return items.filter((x) => compare('=', x, target) === true).length;
                }
                return items.filter((x) => truthy(ev(pred, { v: x }))).length;
              }
              default: {
                const v = f.run(n.args.map((a) => ev(a, item)), ctx);
                return typeof v === 'string' && v.length > MAX_TEXT ? cap(v) : v;
              }
            }
          }
        }
      };
      try {
        const v = ev(tree, null);
        // A list is the formula's value only as text: a formula field holds one value.
        if (isList(v)) return cap(toText(v));
        return typeof v === 'string' ? cap(v) : v;
      } catch {
        // A fault, a budget past its limit: a formula fails soft.
        return null;
      }
    }
  };
}
