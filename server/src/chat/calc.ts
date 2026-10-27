import { Worker } from 'node:worker_threads';

/**
 * The exact-calculation worker. Models are bad at arithmetic, so profiles with the `calculate` tool hand
 * expressions to this evaluator, which computes with exact rationals (BigInt numerator and denominator) and answers
 * with the exact fraction and its decimal expansion (terminating, or marked as rounded).
 *
 * Grammar: numbers (123, 1.5, 2e-3, 1_000), + - * / ^ (integer exponents), unary minus, parentheses, postfix %.
 * It runs in a worker thread with a small heap and a time limit, so a hostile expression costs a worker, not
 * the server. The evaluator is plain JavaScript source so the worker needs no build or loader.
 */
export const CALC_SOURCE = String.raw`
function gcd(a, b) { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) { const t = a % b; a = b; b = t; } return a; }
function norm(n, d) {
  if (d === 0n) throw new Error('Division by zero');
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d) || 1n;
  n /= g; d /= g;
  if (n.toString().length + d.toString().length > 20000) throw new Error('The result is too large');
  return { n, d };
}
const MAX_TOKENS = 400;
function tokenize(s) {
  const out = []; let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = /^(?:\d[\d_]*)?(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(s.slice(i));
      if (!m || !m[0] || m[0] === '.') throw new Error('Bad number at ' + i);
      out.push({ t: 'num', v: m[0].replace(/_/g, '') }); i += m[0].length; continue;
    }
    if ('+-*/^()%'.includes(c)) { out.push({ t: c }); i++; continue; }
    if (c === '×') { out.push({ t: '*' }); i++; continue; }
    if (c === '÷') { out.push({ t: '/' }); i++; continue; }
    throw new Error('Unexpected "' + c + '" at ' + i);
  }
  if (out.length > MAX_TOKENS) throw new Error('The expression is too long');
  return out;
}
function parseNumber(v) {
  const m = /^(\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(v);
  if (!m || m[1].length + (m[2] || '').length > 1000) throw new Error('Number too long');
  const frac = m[2] || '';
  let n = BigInt((m[1] || '0') + frac); let d = 10n ** BigInt(frac.length);
  const e = Number(m[3] || 0);
  if (Math.abs(e) > 1000) throw new Error('Exponent too large');
  if (e > 0) n *= 10n ** BigInt(e); else if (e < 0) d *= 10n ** BigInt(-e);
  return norm(n, d);
}
function evaluate(expr) {
  if (typeof expr !== 'string' || !expr.trim()) throw new Error('Empty expression');
  if (expr.length > 2000) throw new Error('The expression is too long');
  const toks = tokenize(expr); let p = 0;
  const peek = () => toks[p] && toks[p].t;
  const eat = (t) => { if (peek() !== t) throw new Error('Expected ' + t); p++; };
  function primary() {
    const k = peek();
    if (k === 'num') { return parseNumber(toks[p++].v); }
    if (k === '(') { p++; const v = sum(); eat(')'); return v; }
    throw new Error(k ? 'Unexpected ' + k : 'Unexpected end');
  }
  function postfix() { let v = primary(); while (peek() === '%') { p++; v = norm(v.n, v.d * 100n); } return v; }
  // Exponentiation binds tighter than unary minus (-2^2 = -4) and is right-associative (2^3^2 = 2^9).
  function power() {
    const base = postfix();
    if (peek() !== '^') return base;
    p++;
    const e = unary();
    if (e.d !== 1n) throw new Error('Only whole-number exponents are exact');
    if (e.n > 10000n || e.n < -10000n) throw new Error('Exponent too large');
    const k = Number(e.n < 0n ? -e.n : e.n);
    const r = norm(base.n ** BigInt(k), base.d ** BigInt(k));
    return e.n < 0n ? norm(r.d, r.n) : r;
  }
  function unary() {
    if (peek() === '-') { p++; const v = unary(); return { n: -v.n, d: v.d }; }
    if (peek() === '+') { p++; return unary(); }
    return power();
  }
  function product() {
    let v = unary();
    while (peek() === '*' || peek() === '/') {
      const op = toks[p++].t; const r = unary();
      v = op === '*' ? norm(v.n * r.n, v.d * r.d) : norm(v.n * r.d, v.d * r.n);
    }
    return v;
  }
  function sum() {
    let v = product();
    while (peek() === '+' || peek() === '-') {
      const op = toks[p++].t; const r = product();
      v = norm(op === '+' ? v.n * r.d + r.n * v.d : v.n * r.d - r.n * v.d, v.d * r.d);
    }
    return v;
  }
  const v = sum();
  if (p !== toks.length) throw new Error('Unexpected ' + toks[p].t);
  return format(v);
}
function format(v) {
  const neg = v.n < 0n; let n = neg ? -v.n : v.n; const d = v.d;
  let dd = d; while (dd % 2n === 0n) dd /= 2n; while (dd % 5n === 0n) dd /= 5n;
  const exact = dd === 1n;
  const whole = n / d; let rem = n % d; let digits = '';
  const max = exact ? 20000 : 40;
  while (rem && digits.length < max) { rem *= 10n; digits += (rem / d).toString(); rem %= d; }
  const decimal = (neg ? '-' : '') + whole.toString() + (digits ? '.' + digits : '');
  return { fraction: (neg ? '-' : '') + n.toString() + (d === 1n ? '' : '/' + d.toString()), decimal, exact };
}
`;

export interface CalcResult {
  fraction: string;
  decimal: string;
  /** False when the decimal expansion does not terminate and was cut off (40 digits). */
  exact: boolean;
}

const WORKER_CODE = `${CALC_SOURCE}
const { parentPort } = require('node:worker_threads');
parentPort.on('message', ({ id, expr }) => {
  try { parentPort.postMessage({ id, ok: true, result: evaluate(expr) }); }
  catch (err) { parentPort.postMessage({ id, ok: false, error: String(err && err.message || err) }); }
});`;

export class CalcError extends Error {}

/** One worker thread, restarted when a calculation times out or the worker dies. */
export class CalcWorker {
  private worker: Worker | null = null;
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (r: CalcResult) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly timeoutMs = 2000) {}

  private spawn(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(WORKER_CODE, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 48, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
    w.unref();
    w.on('message', (m: { id: number; ok: boolean; result?: CalcResult; error?: string }) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m.result!);
      else p.reject(new CalcError(m.error ?? 'Calculation failed'));
    });
    const fail = (err: Error) => {
      if (this.worker === w) this.worker = null;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new CalcError(`The calculation worker stopped: ${err.message}`));
        this.pending.delete(id);
      }
    };
    w.on('error', fail);
    w.on('exit', (code) => fail(new Error(`exit ${code}`)));
    this.worker = w;
    return w;
  }

  evaluate(expr: string): Promise<CalcResult> {
    const w = this.spawn();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CalcError('The calculation took too long'));
        // A runaway calculation keeps the thread busy: replace the worker.
        if (this.worker === w) this.worker = null;
        void w.terminate();
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      w.postMessage({ id, expr });
    });
  }

  async close(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    await w?.terminate();
  }
}

/** The tool definition offered to models on profiles that enable `calculate`. */
export const CALCULATE_TOOL = {
  type: 'function',
  function: {
    name: 'calculate',
    description: 'Evaluates an arithmetic expression exactly (+ - * / ^, parentheses, percentages). Use it for every calculation instead of computing in your head.',
    parameters: { type: 'object', properties: { expression: { type: 'string', description: 'For example (1250 * 1.07) / 12' } }, required: ['expression'] }
  }
} as const;
