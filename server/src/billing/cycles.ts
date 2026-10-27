/*
 * 1.9.0, Sprint 51 (B-163): billing cycle arithmetic and exact money arithmetic. Pure functions; plans and
 * subscriptions (B-162) may use `cycleBounds` to work out `periodStart` and `periodEnd`.
 */
import type { Cycle, CycleKind, Fraction } from './types.js';

export const CYCLE_MONTHS: Record<Exclude<CycleKind, 'custom'>, number> = { monthly: 1, quarterly: 3, annual: 12 };

/** A cycle from its kind, with the months a kind implies (a `custom` cycle names its own, 1 to 36). */
export function cycleOf(kind: CycleKind, anchorDay: number, months?: number): Cycle {
  const m = kind === 'custom' ? (months ?? 1) : CYCLE_MONTHS[kind];
  if (!Number.isInteger(m) || m < 1 || m > 36) throw new RangeError('a cycle is 1 to 36 months');
  if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) throw new RangeError('an anchor day is 1 to 31');
  return { kind, months: m, anchorDay };
}

/** 00:00 UTC on `anchorDay` of the month `index` (months since year 0, `y * 12 + m0`), on the last day if shorter. */
export function anchorDate(index: number, anchorDay: number): number {
  const y = Math.floor(index / 12);
  const m0 = index - y * 12;
  const last = new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
  return Date.UTC(y, m0, Math.min(anchorDay, last));
}

const monthIndex = (t: number): number => {
  const d = new Date(t);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
};

/**
 * The cycle containing `at`, counted in steps of `cycle.months` from the anchor date on or before `origin` (the
 * subscription's start). Every boundary is the anchor day of its month (clamped to the month's last day), so a
 * 31st anchor gives 31 Jan, 28 Feb, 31 Mar rather than drifting to the 28th.
 */
export function cycleBounds(cycle: Pick<Cycle, 'months' | 'anchorDay'>, origin: number, at: number): { start: number; end: number } {
  let o = monthIndex(origin);
  if (anchorDate(o, cycle.anchorDay) > origin) o -= 1;
  const k = Math.floor((monthIndex(at) - o) / cycle.months);
  let start = anchorDate(o + k * cycle.months, cycle.anchorDay);
  let i = k;
  // The month count gets within one cycle; the anchor day settles the rest.
  while (start > at) start = anchorDate(o + --i * cycle.months, cycle.anchorDay);
  let end = anchorDate(o + (i + 1) * cycle.months, cycle.anchorDay);
  while (end <= at) {
    i += 1;
    start = end;
    end = anchorDate(o + (i + 1) * cycle.months, cycle.anchorDay);
  }
  return { start, end };
}

// ---------- exact arithmetic ----------

/** `round(a × num / den)`, half away from zero, with no floating-point intermediate (BigInt). */
export function mulDiv(a: number, num: number, den: number): number {
  if (den === 0) throw new RangeError('division by zero');
  if (!Number.isInteger(a) || !Number.isInteger(num) || !Number.isInteger(den)) return roundHalfAway((a * num) / den);
  const p = BigInt(a) * BigInt(num);
  const d = BigInt(den);
  const neg = p < 0n !== d < 0n;
  const ap = p < 0n ? -p : p;
  const ad = d < 0n ? -d : d;
  const q = (ap * 2n + ad) / (ad * 2n);
  return Number(neg ? -q : q);
}

/** Half away from zero (Math.round goes half up, which is toward zero for negative halves). */
export const roundHalfAway = (x: number): number => (x < 0 ? -Math.round(-x) : Math.round(x));

/** The step of one minor unit in micros (10,000 for cents, 1,000,000 for a zero-decimal currency). */
export const minorStep = (digits: number): number => 10 ** (6 - digits);

/** Micros rounded to a whole minor unit, half away from zero. */
export const toWholeMinor = (micros: number, digits: number): number => {
  const step = minorStep(digits);
  return mulDiv(micros, 1, step) * step;
};

export const fraction = (num: number, den: number): Fraction => ({ num, den });

/** The sum of fractions, exact (BigInt), reduced. */
export function addFractions(xs: readonly Fraction[]): Fraction {
  let n = 0n;
  let d = 1n;
  for (const x of xs) {
    n = n * BigInt(x.den) + BigInt(x.num) * d;
    d *= BigInt(x.den);
    const g = gcd(n < 0n ? -n : n, d);
    if (g > 1n) {
      n /= g;
      d /= g;
    }
  }
  return { num: Number(n), den: Number(d) };
}

const gcd = (a: bigint, b: bigint): bigint => {
  while (b) [a, b] = [b, a % b];
  return a || 1n;
};

/** A price (micros) times a fraction, rounded to a whole minor unit, half away from zero. */
export function prorate(micros: number, f: Fraction, digits: number): number {
  const step = minorStep(digits);
  // round(micros × num / den / step) × step, in one exact division.
  return mulDiv(micros, f.num, f.den * step) * step;
}

/** A fraction as text for a line description: "15/30 of the cycle" reduced, or "the whole cycle". */
export function fractionText(f: Fraction): string {
  if (f.num === f.den) return 'the whole cycle';
  const g = Number(gcd(BigInt(f.num), BigInt(f.den)));
  return `${f.num / g}/${f.den / g} of the cycle`;
}
