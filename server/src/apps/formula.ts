/*
 * Formula fields (B-2203): a small expression language parsed into a tree and evaluated by walking it. There is no
 * `eval`, no `Function`, no property access and no indexing, so a formula cannot reach a global, a prototype or the
 * process: the only names it can read are the entity's own fields (checked when the formula is compiled, read at run
 * time from a Map built from the record's own keys) and the only things it can call are the functions in `FUNCTIONS`
 * (a Map, so `constructor` or `__proto__` are simply unknown names).
 *
 *   literals     12, 3.5, 'text', "text", true, false, null
 *   operators    + - * / %   & (join as text)   = == != <> < <= > >=   and or not  && || !   unary -   ( )
 *   functions    if, coalesce, isblank, concat, upper, lower, trim, len, left, right, mid, contains, replace, round,
 *                floor, ceil, abs, min, max, sum, number, text, today, now, year, month, day, add_days, days_between
 *
 * Errors while evaluating (a type mismatch, division by zero) give null rather than throwing: a formula fails soft.
 */

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
const MAX_TEXT = 10_000;
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

  private guard(depth: number): void {
    if (depth > MAX_DEPTH) throw new FormulaError('The formula is nested too deeply.');
  }

  private or(d: number): Node {
    this.guard(d);
    let a = this.and(d + 1);
    while (this.isOp('||')) {
      this.i++;
      a = { k: 'bin', op: '||', a, b: this.and(d + 1) };
    }
    return a;
  }

  private and(d: number): Node {
    let a = this.not(d + 1);
    while (this.isOp('&&')) {
      this.i++;
      a = { k: 'bin', op: '&&', a, b: this.not(d + 1) };
    }
    return a;
  }

  private not(d: number): Node {
    this.guard(d);
    if (this.isOp('!')) {
      this.i++;
      return { k: 'un', op: 'not', a: this.not(d + 1) };
    }
    return this.cmp(d + 1);
  }

  private cmp(d: number): Node {
    let a = this.concat(d + 1);
    for (;;) {
      const t = this.peek();
      if (t.t !== 'op' || !['=', '==', '!=', '<>', '<', '<=', '>', '>='].includes(t.v)) return a;
      this.i++;
      const op = t.v === '==' ? '=' : t.v === '<>' ? '!=' : t.v;
      a = { k: 'bin', op, a, b: this.concat(d + 1) };
    }
  }

  private concat(d: number): Node {
    let a = this.add(d + 1);
    while (this.isOp('&')) {
      this.i++;
      a = { k: 'bin', op: '&', a, b: this.add(d + 1) };
    }
    return a;
  }

  private add(d: number): Node {
    let a = this.mul(d + 1);
    for (;;) {
      const t = this.peek();
      if (t.t !== 'op' || (t.v !== '+' && t.v !== '-')) return a;
      this.i++;
      a = { k: 'bin', op: t.v, a, b: this.mul(d + 1) };
    }
  }

  private mul(d: number): Node {
    let a = this.unary(d + 1);
    for (;;) {
      const t = this.peek();
      if (t.t !== 'op' || !['*', '/', '%'].includes(t.v)) return a;
      this.i++;
      a = { k: 'bin', op: t.v, a, b: this.unary(d + 1) };
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
    return this.primary(d + 1);
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

const isNum = (v: Value | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
const toText = (v: Value | undefined): string => (v == null ? '' : typeof v === 'number' ? String(Math.round(v * 1e10) / 1e10) : String(v));
const cap = (s: string): string => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s);
const DAY = 86_400_000;
const toTime = (v: Value | undefined): number | null => {
  if (isNum(v)) return v;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  const t = Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v);
  return Number.isFinite(t) ? t : null;
};
const isoDay = (t: number): string => new Date(t).toISOString().slice(0, 10);

interface Fn {
  min: number;
  max: number;
  /** Lazy functions get their arguments unevaluated (if, coalesce). */
  lazy?: boolean;
  run: (args: Value[]) => Value;
}

const FUNCTIONS = new Map<string, Fn>([
  ['if', { min: 2, max: 3, lazy: true, run: () => null }],
  ['coalesce', { min: 1, max: 20, lazy: true, run: () => null }],
  ['isblank', { min: 1, max: 1, run: ([a]) => a == null || a === '' }],
  ['concat', { min: 1, max: 20, run: (a) => cap(a.map(toText).join('')) }],
  ['upper', { min: 1, max: 1, run: ([a]) => (a == null ? null : toText(a).toUpperCase()) }],
  ['lower', { min: 1, max: 1, run: ([a]) => (a == null ? null : toText(a).toLowerCase()) }],
  ['trim', { min: 1, max: 1, run: ([a]) => (a == null ? null : toText(a).trim()) }],
  ['len', { min: 1, max: 1, run: ([a]) => (a == null ? 0 : [...toText(a)].length) }],
  ['left', { min: 2, max: 2, run: ([a, n]) => (a == null || !isNum(n) ? null : [...toText(a)].slice(0, Math.max(0, Math.floor(n))).join('')) }],
  ['right', { min: 2, max: 2, run: ([a, n]) => (a == null || !isNum(n) ? null : n <= 0 ? '' : [...toText(a)].slice(-Math.floor(n)).join('')) }],
  ['mid', { min: 3, max: 3, run: ([a, s, n]) => (a == null || !isNum(s) || !isNum(n) ? null : [...toText(a)].slice(Math.max(0, Math.floor(s) - 1), Math.max(0, Math.floor(s) - 1) + Math.max(0, Math.floor(n))).join('')) }],
  ['contains', { min: 2, max: 2, run: ([a, b]) => (a == null || b == null ? false : toText(a).toLowerCase().includes(toText(b).toLowerCase())) }],
  ['replace', { min: 3, max: 3, run: ([a, b, c]) => (a == null ? null : toText(b) === '' ? toText(a) : cap(toText(a).split(toText(b)).join(toText(c)))) }],
  ['round', { min: 1, max: 2, run: ([a, d]) => (isNum(a) ? Math.round(a * 10 ** (isNum(d) ? Math.min(10, Math.max(0, Math.floor(d))) : 0)) / 10 ** (isNum(d) ? Math.min(10, Math.max(0, Math.floor(d))) : 0) : null) }],
  ['floor', { min: 1, max: 1, run: ([a]) => (isNum(a) ? Math.floor(a) : null) }],
  ['ceil', { min: 1, max: 1, run: ([a]) => (isNum(a) ? Math.ceil(a) : null) }],
  ['abs', { min: 1, max: 1, run: ([a]) => (isNum(a) ? Math.abs(a) : null) }],
  ['min', { min: 1, max: 20, run: (a) => (a.every(isNum) ? Math.min(...(a as number[])) : null) }],
  ['max', { min: 1, max: 20, run: (a) => (a.every(isNum) ? Math.max(...(a as number[])) : null) }],
  ['sum', { min: 1, max: 20, run: (a) => (a.every((x) => x == null || isNum(x)) ? (a.filter(isNum) as number[]).reduce((x, y) => x + y, 0) : null) }],
  ['number', { min: 1, max: 1, run: ([a]) => (isNum(a) ? a : typeof a === 'boolean' ? (a ? 1 : 0) : typeof a === 'string' && a.trim() !== '' && Number.isFinite(Number(a)) ? Number(a) : null) }],
  ['text', { min: 1, max: 1, run: ([a]) => toText(a ?? null) }],
  ['today', { min: 0, max: 0, run: () => isoDay(Date.now()) }],
  ['now', { min: 0, max: 0, run: () => new Date().toISOString() }],
  ['year', { min: 1, max: 1, run: ([a]) => (toTime(a ?? null) == null ? null : new Date(toTime(a ?? null)!).getUTCFullYear()) }],
  ['month', { min: 1, max: 1, run: ([a]) => (toTime(a ?? null) == null ? null : new Date(toTime(a ?? null)!).getUTCMonth() + 1) }],
  ['day', { min: 1, max: 1, run: ([a]) => (toTime(a ?? null) == null ? null : new Date(toTime(a ?? null)!).getUTCDate()) }],
  ['add_days', { min: 2, max: 2, run: ([a, n]) => (toTime(a ?? null) == null || !isNum(n) ? null : isoDay(toTime(a ?? null)! + Math.round(n) * DAY)) }],
  ['days_between', { min: 2, max: 2, run: ([a, b]) => (toTime(a ?? null) == null || toTime(b ?? null) == null ? null : Math.round((toTime(b ?? null)! - toTime(a ?? null)!) / DAY)) }]
]);

export const FORMULA_FUNCTIONS = [...FUNCTIONS.keys()];

// ---------- compile and evaluate ----------

export interface Formula {
  /** The field names the formula reads. */
  refs: string[];
  evaluate(values: ReadonlyMap<string, unknown>): Value;
}

function walk(n: Node, visit: (n: Node) => void): void {
  visit(n);
  if (n.k === 'un') walk(n.a, visit);
  else if (n.k === 'bin') {
    walk(n.a, visit);
    walk(n.b, visit);
  } else if (n.k === 'call') for (const a of n.args) walk(a, visit);
}

const asValue = (v: unknown): Value => (v == null ? null : typeof v === 'string' || typeof v === 'boolean' ? v : typeof v === 'number' ? (Number.isFinite(v) ? v : null) : null);

function compare(op: string, a: Value, b: Value): boolean | null {
  if (op === '=' || op === '!=') {
    // A number equals a text that reads as the same number ('3' = 3); otherwise values are equal only when identical.
    const numeric = (x: Value) => (isNum(x) ? x : typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x)) ? Number(x) : null);
    const eq = a === b || (typeof a !== typeof b && a != null && b != null && numeric(a) != null && numeric(a) === numeric(b));
    return op === '=' ? eq : !eq;
  }
  if (a == null || b == null) return null;
  if (isNum(a) && isNum(b)) return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
  if (typeof a === 'string' && typeof b === 'string') return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
  return null;
}

const truthy = (v: Value): boolean => v !== null && v !== false && v !== 0 && v !== '';

/**
 * Parses a formula and checks every name against `fields` (the entity's fields a formula may read) and every function
 * against the list above. Throws a FormulaError that says what is wrong.
 */
export function compileFormula(src: string, fields: ReadonlySet<string>): Formula {
  if (src.length > MAX_FORMULA_LENGTH) throw new FormulaError(`A formula has at most ${MAX_FORMULA_LENGTH} characters.`);
  const tree = new Parser(tokenize(src)).parse();
  const refs = new Set<string>();
  walk(tree, (n) => {
    if (n.k === 'ref') {
      if (!fields.has(n.name)) throw new FormulaError(`${n.name} is not a field this formula can read.`);
      refs.add(n.name);
    }
    if (n.k === 'call') {
      const f = FUNCTIONS.get(n.fn);
      if (!f) throw new FormulaError(`${n.fn} is not a formula function.`);
      if (n.args.length < f.min || n.args.length > f.max) throw new FormulaError(`${n.fn} takes ${f.min === f.max ? f.min : `${f.min} to ${f.max}`} argument${f.max === 1 ? '' : 's'}.`);
    }
  });
  return {
    refs: [...refs],
    evaluate(values) {
      let steps = 0;
      const ev = (n: Node): Value => {
        if (++steps > MAX_STEPS) throw new FormulaError('The formula took too many steps.');
        switch (n.k) {
          case 'lit':
            return n.v;
          case 'ref':
            return asValue(values.get(n.name));
          case 'un': {
            const a = ev(n.a);
            if (n.op === 'not') return !truthy(a);
            return isNum(a) ? -a : null;
          }
          case 'bin': {
            if (n.op === '&&') return truthy(ev(n.a)) && truthy(ev(n.b));
            if (n.op === '||') return truthy(ev(n.a)) || truthy(ev(n.b));
            const a = ev(n.a);
            const b = ev(n.b);
            if (n.op === '&') return cap(toText(a) + toText(b));
            if (['=', '!=', '<', '<=', '>', '>='].includes(n.op)) return compare(n.op, a, b);
            if (!isNum(a) || !isNum(b)) return null;
            const r = n.op === '+' ? a + b : n.op === '-' ? a - b : n.op === '*' ? a * b : n.op === '/' ? (b === 0 ? null : a / b) : b === 0 ? null : a % b;
            return r == null || !Number.isFinite(r) ? null : r;
          }
          case 'call': {
            const f = FUNCTIONS.get(n.fn)!;
            if (n.fn === 'if') return truthy(ev(n.args[0]!)) ? ev(n.args[1]!) : n.args[2] ? ev(n.args[2]) : null;
            if (n.fn === 'coalesce') {
              for (const a of n.args) {
                const v = ev(a);
                if (v != null && v !== '') return v;
              }
              return null;
            }
            return f.run(n.args.map(ev));
          }
        }
      };
      try {
        const v = ev(tree);
        return typeof v === 'string' ? cap(v) : v;
      } catch {
        return null;
      }
    }
  };
}
