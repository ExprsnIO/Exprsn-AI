/*
 * The formula functions (B-2203, extended in 1.8.0 by B-141) and the catalogue the console's formula editor lists.
 *
 * Every function is pure and deterministic: it reads its arguments and nothing else (no globals, no clock, no I/O),
 * except `today` and `now`, which read the clock. Time zones come from the runtime's IANA database through `Intl`,
 * which is data, not code. Names are matched case-insensitively (`DateAdd` and `dateadd` are the same function).
 *
 * Values are text, numbers, booleans, null and, since 1.8.0, lists of those (from `Split`, `List`, `Sort`, `Unique`
 * or a field that holds a JSON array). Dates are ISO text (`2026-10-15` is a calendar date, `2026-10-15T09:30:00Z`
 * an instant) or milliseconds since 1970; everything is in UTC unless a zone argument names an IANA zone. A function
 * given the wrong kind of value gives null (a formula fails soft); `IfError` and `Coalesce` give a fallback.
 *
 * Resource limits: text results are capped at MAX_TEXT characters (Rept refuses anything longer rather than cutting
 * it), lists at MAX_LIST items, and work in proportion to the size of the input is charged to the formula's step
 * budget (`charge`), so a formula cannot loop for long.
 */

export type Scalar = string | number | boolean | null;
/** A value while a formula runs: lists are flat (a list inside a list is spread into it). */
export type V = Scalar | Scalar[];

export const MAX_TEXT = 10_000;
export const MAX_LIST = 10_000;
/** WorkDay and DateAdd refuse steps larger than this many days (about 270 years). */
const MAX_DAYS = 100_000;

/** A resource limit was reached: never caught by IfError, and the whole formula gives null. */
export class FormulaBudget extends Error {}
/** A function could not give a value (wrong kind of value, out of range); IfError's fallback, otherwise null. */
export class FormulaFault extends Error {}

export interface RunCtx {
  /** Adds work to the formula's step budget (throws FormulaBudget past it). */
  charge(units: number): void;
}

/** Parameter kinds, checked at parse time against literals and the result kinds of nested calls. */
export type Kind = 'any' | 'num' | 'text' | 'date' | 'list' | 'bool' | 'zone' | 'fmt' | { enum: readonly string[] };
export type Result = 'any' | 'num' | 'text' | 'date' | 'list' | 'bool';

export interface Fn {
  /** The name the catalogue shows (calls match it case-insensitively). */
  name: string;
  min: number;
  max: number;
  params: Kind[];
  /** The kind of every argument past `params` (variadic functions). */
  rest?: Kind;
  returns: Result;
  /** Lazy functions get their arguments unevaluated (if, coalesce, switch, iferror, countif). */
  lazy?: boolean;
  run: (args: V[], ctx: RunCtx) => V;
  category: 'Logic' | 'Text' | 'Math' | 'Dates' | 'Lists';
  signature: string;
  description: string;
  example: string;
}

// ---------- helpers ----------

export const isNum = (v: V | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
export const isList = (v: V | undefined): v is Scalar[] => Array.isArray(v);
const scalarText = (v: Scalar | undefined): string => (v == null ? '' : typeof v === 'number' ? String(Math.round(v * 1e10) / 1e10) : String(v));
export const toText = (v: V | undefined): string => (isList(v) ? v.map(scalarText).join(', ') : scalarText(v));
export const cap = (s: string): string => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s);
export const blank = (v: V | undefined): boolean => v == null || v === '' || (isList(v) && v.length === 0);
const numeric = (v: V | undefined): number | null => (isNum(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const int = (v: V | undefined): number | null => (isNum(v) ? Math.trunc(v) : null);
/** Floating-point noise off a product before it is rounded (1.1 * 10 is 11.000000000000002). */
const tidy = (x: number): number => Number(x.toPrecision(15));
const finite = (x: number): number | null => (Number.isFinite(x) ? x : null);
/** A list argument: a list as it is, a blank as an empty list, anything else as a list of one. */
const listOf = (v: V | undefined): Scalar[] => (isList(v) ? v : v == null ? [] : [v]);
/** Lists spread into the arguments; blanks inside a list are skipped, blanks given directly are kept. */
const spread = (args: V[]): Scalar[] => args.flatMap((a) => (isList(a) ? a.filter((x) => x != null && x !== '') : [a]));
/** For the number functions: a list's items that read as numbers ('3' from Split) count as numbers. */
const spreadNumbers = (args: V[]): Scalar[] => args.flatMap((a) => (isList(a) ? a.filter((x) => x != null && x !== '').map((x) => numeric(x) ?? x) : [a]));
const chars = (s: string): string[] => [...s];
const PRINTABLE = (c: string): boolean => !/\p{C}/u.test(c);

export function listCap(items: Scalar[]): Scalar[] {
  if (items.length > MAX_LIST) throw new FormulaFault(`A list has at most ${MAX_LIST} items.`);
  return items;
}

// ---------- dates ----------

const DAY = 86_400_000;
const UNIT_MS: Record<string, number> = { seconds: 1000, minutes: 60_000, hours: 3_600_000 };
export const UNITS = ['seconds', 'minutes', 'hours', 'days', 'weeks', 'months', 'quarters', 'years'] as const;
const UNIT_ALIASES = new Map<string, (typeof UNITS)[number]>([
  ...UNITS.map((u) => [u, u] as [string, (typeof UNITS)[number]]),
  ...UNITS.map((u) => [u.slice(0, -1), u] as [string, (typeof UNITS)[number]])
]);
const unitOf = (v: V | undefined): (typeof UNITS)[number] | null => (typeof v === 'string' ? (UNIT_ALIASES.get(v.trim().toLowerCase()) ?? null) : null);

/** A date argument: the instant, and whether it was a calendar date (no time, no zone). */
export interface When {
  t: number;
  dateOnly: boolean;
}

export function toWhen(v: V | undefined): When | null {
  if (isNum(v)) return Math.abs(v) <= 8.64e15 ? { t: v, dateOnly: false } : null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  const dateOnly = v.length === 10;
  const t = Date.parse(dateOnly ? `${v}T00:00:00Z` : v);
  return Number.isFinite(t) ? { t, dateOnly } : null;
}

/** The existing functions' reading of a date: an instant in milliseconds. */
export const toTime = (v: V | undefined): number | null => toWhen(v)?.t ?? null;

export const isoDay = (t: number): string => new Date(t).toISOString().slice(0, 10);

interface Fields {
  y: number;
  mo: number; // 1-12
  d: number;
  h: number;
  mi: number;
  s: number;
  ms: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** A valid IANA zone name (or UTC); the formatter is kept, so a zone is checked once. */
export function zoneFormatter(zone: string): Intl.DateTimeFormat | null {
  if (zone.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(zone)) return null;
  const hit = formatters.get(zone);
  if (hit) return hit;
  try {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', era: 'short' });
    if (formatters.size > 200) formatters.clear();
    formatters.set(zone, f);
    return f;
  } catch {
    return null;
  }
}

function zoneArg(v: V | undefined): string | null | undefined {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !zoneFormatter(v)) return undefined;
  return v.toUpperCase() === 'UTC' ? null : v;
}

function utcFields(t: number): Fields {
  const x = new Date(t);
  return { y: x.getUTCFullYear(), mo: x.getUTCMonth() + 1, d: x.getUTCDate(), h: x.getUTCHours(), mi: x.getUTCMinutes(), s: x.getUTCSeconds(), ms: x.getUTCMilliseconds() };
}

function fieldsAt(t: number, zone: string | null): Fields {
  if (!zone) return utcFields(t);
  const parts = zoneFormatter(zone)!.formatToParts(new Date(t));
  const get = (k: string) => Number(parts.find((p) => p.type === k)?.value ?? NaN);
  const era = parts.find((p) => p.type === 'era')?.value;
  const y = get('year');
  return { y: era === 'BC' || era === 'B' ? 1 - y : y, mo: get('month'), d: get('day'), h: get('hour') % 24, mi: get('minute'), s: get('second'), ms: ((t % 1000) + 1000) % 1000 };
}

const utcOf = (f: Fields): number => {
  const x = new Date(0);
  x.setUTCFullYear(f.y, f.mo - 1, f.d);
  x.setUTCHours(f.h, f.mi, f.s, f.ms);
  return x.getTime();
};

/** The instant of a wall-clock time in a zone (the earlier one when the clock goes back, the later when it skips). */
function fromLocal(f: Fields, zone: string | null): number {
  const guess = utcOf(f);
  if (!zone) return guess;
  const offset = (t: number) => utcOf({ ...fieldsAt(t, zone), ms: 0 }) - (t - (((t % 1000) + 1000) % 1000));
  const o1 = offset(guess);
  const t1 = guess - o1;
  const o2 = offset(t1);
  return o1 === o2 ? t1 : guess - Math.max(o1, o2);
}

/** A date's fields: a calendar date is the same date in every zone; an instant is read in the zone. */
const local = (w: When, zone: string | null): Fields => fieldsAt(w.t, w.dateOnly ? null : zone);
const leap = (y: number): boolean => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
const daysInMonth = (y: number, mo: number): number => (mo === 2 ? (leap(y) ? 29 : 28) : [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!);
const inRange = (t: number): boolean => {
  if (!Number.isFinite(t) || Math.abs(t) > 8.64e15) return false;
  const y = new Date(t).getUTCFullYear();
  return y >= 1 && y <= 9999;
};
const out = (t: number, dateOnly: boolean): string | null => (inRange(t) ? (dateOnly ? isoDay(t) : new Date(t).toISOString()) : null);
/** Days since 1970-01-01 of a calendar date. */
const dayNumber = (f: Pick<Fields, 'y' | 'mo' | 'd'>): number => Math.round(utcOf({ y: f.y, mo: f.mo, d: f.d, h: 0, mi: 0, s: 0, ms: 0 }) / DAY);
/** 0 Sunday … 6 Saturday of a day number (1970-01-01 was a Thursday). */
const weekdayOf = (n: number): number => (((n + 4) % 7) + 7) % 7;
const weekend = (n: number): boolean => weekdayOf(n) === 0 || weekdayOf(n) === 6;

function addMonths(f: Fields, months: number): Fields {
  const total = f.y * 12 + (f.mo - 1) + months;
  const y = Math.floor(total / 12);
  const mo = (total % 12) + 1 + (total % 12 < 0 ? 12 : 0);
  // Month-end: Jan 31 plus one month is the last day of February.
  return { ...f, y, mo, d: Math.min(f.d, daysInMonth(y, mo)) };
}

function dateAdd(dv: V | undefined, nv: V | undefined, uv: V | undefined, zv: V | undefined): V {
  const w = toWhen(dv);
  const unit = unitOf(uv);
  const zone = zoneArg(zv);
  if (!w || !isNum(nv) || !unit || zone === undefined) return null;
  const n = Math.round(nv);
  if (unit in UNIT_MS) {
    if (Math.abs(n) * UNIT_MS[unit]! > MAX_DAYS * DAY) return null;
    return out(w.t + n * UNIT_MS[unit]!, false);
  }
  const months = unit === 'months' ? n : unit === 'quarters' ? n * 3 : unit === 'years' ? n * 12 : 0;
  const days = unit === 'days' ? n : unit === 'weeks' ? n * 7 : 0;
  if (Math.abs(days) > MAX_DAYS || Math.abs(months) > 12 * 10_000) return null;
  const z = w.dateOnly ? null : zone;
  const f = fieldsAt(w.t, z);
  if (days) {
    const x = utcFields((dayNumber(f) + days) * DAY);
    return out(fromLocal({ ...f, y: x.y, mo: x.mo, d: x.d }, z), w.dateOnly);
  }
  return out(fromLocal(addMonths(f, months), z), w.dateOnly);
}

/** Whole months from a to b (a <= b), counting a month that ends on the last day of a shorter month as complete. */
function wholeMonths(a: Fields, b: Fields): number {
  let m = (b.y - a.y) * 12 + (b.mo - a.mo);
  const tod = (f: Fields) => ((f.h * 60 + f.mi) * 60 + f.s) * 1000 + f.ms;
  const endOfMonth = b.d === daysInMonth(b.y, b.mo);
  if (m > 0 && (b.d < a.d || (b.d === a.d && tod(b) < tod(a))) && !(endOfMonth && b.d < a.d && tod(b) >= tod(a))) m--;
  return m;
}

function dateDiff(sv: V | undefined, ev: V | undefined, uv: V | undefined, zv: V | undefined): V {
  const a = toWhen(sv);
  const b = toWhen(ev);
  const unit = unitOf(uv);
  const zone = zoneArg(zv);
  if (!a || !b || !unit || zone === undefined) return null;
  if (b.t < a.t) {
    const r = dateDiff(ev, sv, uv, zv);
    return isNum(r) ? -r || 0 : r;
  }
  if (unit in UNIT_MS) return Math.trunc((b.t - a.t) / UNIT_MS[unit]!);
  const fa = local(a, zone);
  const fb = local(b, zone);
  if (unit === 'days' || unit === 'weeks') {
    const tod = (f: Fields) => ((f.h * 60 + f.mi) * 60 + f.s) * 1000 + f.ms;
    let days = dayNumber(fb) - dayNumber(fa);
    if (days > 0 && tod(fb) < tod(fa)) days--;
    return unit === 'days' ? days : Math.trunc(days / 7);
  }
  const m = wholeMonths(fa, fb);
  return unit === 'months' ? m : unit === 'quarters' ? Math.trunc(m / 3) : Math.trunc(m / 12);
}

function part(k: keyof Fields | 'weekday' | 'weeknum') {
  return ([dv, zv]: V[]): V => {
    const w = toWhen(dv);
    const zone = zoneArg(zv);
    if (!w || zone === undefined) return null;
    const f = local(w, zone);
    if (k === 'weekday') return weekdayOf(dayNumber(f)) + 1;
    if (k === 'weeknum') {
      // ISO 8601: weeks start on Monday; week 1 holds the year's first Thursday.
      const n = dayNumber(f);
      const iso = ((weekdayOf(n) + 6) % 7) + 1;
      const thursday = n + 4 - iso;
      const y = utcFields(thursday * DAY).y;
      return Math.floor((thursday - dayNumber({ y, mo: 1, d: 1 })) / 7) + 1;
    }
    return f[k];
  };
}

/** Distinct day numbers of the holidays given (calendar dates or instants, read in UTC), within the budget. */
function holidaysOf(v: V | undefined, ctx: RunCtx): Set<number> | null {
  const days = new Set<number>();
  const list = listOf(v);
  ctx.charge(Math.ceil(list.length / 10));
  for (const h of list) {
    if (h == null || h === '') continue;
    const w = toWhen(h);
    if (!w) return null;
    days.add(dayNumber(utcFields(w.t)));
  }
  return days;
}

/** Weekdays (Monday to Friday) from day a to day b, both included (a <= b). */
function weekdaysBetween(a: number, b: number): number {
  const span = b - a + 1;
  let n = Math.floor(span / 7) * 5;
  for (let d = a + Math.floor(span / 7) * 7; d <= b; d++) if (!weekend(d)) n++;
  return n;
}

function netWorkDays([sv, ev, hv]: V[], ctx: RunCtx): V {
  const a = toWhen(sv);
  const b = toWhen(ev);
  const holidays = holidaysOf(hv, ctx);
  if (!a || !b || !holidays) return null;
  let x = dayNumber(utcFields(a.t));
  let y = dayNumber(utcFields(b.t));
  const sign = y < x ? -1 : 1;
  if (y < x) [x, y] = [y, x];
  let n = weekdaysBetween(x, y);
  for (const h of holidays) if (h >= x && h <= y && !weekend(h)) n--;
  return sign * n;
}

function workDay([sv, nv, hv]: V[], ctx: RunCtx): V {
  const a = toWhen(sv);
  const holidays = holidaysOf(hv, ctx);
  if (!a || !isNum(nv) || !holidays) return null;
  let left = Math.trunc(nv);
  if (Math.abs(left) > MAX_DAYS) return null;
  const step = left < 0 ? -1 : 1;
  let d = dayNumber(utcFields(a.t));
  const sorted = [...holidays].filter((h) => !weekend(h));
  // Jump whole weeks, then walk the rest; each holiday passed on the way adds one more working day to walk.
  for (let round = 0; left !== 0; round++) {
    if (round > sorted.length + 2) return null;
    const from = d;
    const weeks = Math.trunc(Math.abs(left) / 5) - (Math.abs(left) % 5 === 0 ? 1 : 0);
    d += step * weeks * 7;
    let rest = Math.abs(left) - weeks * 5;
    while (rest > 0) {
      d += step;
      if (!weekend(d)) rest--;
    }
    // Holidays strictly after `from` and up to `d` (in the direction of travel) still have to be made up.
    left = step * sorted.filter((h) => (step > 0 ? h > from && h <= d : h < from && h >= d)).length;
    ctx.charge(1);
  }
  const t = d * DAY;
  return inRange(t) ? isoDay(t) : null;
}

function eoMonth([dv, mv]: V[]): V {
  const w = toWhen(dv);
  const months = mv == null ? 0 : int(mv);
  if (!w || months == null || Math.abs(months) > 120_000) return null;
  const f = addMonths({ ...utcFields(w.t), d: 1 }, months);
  const t = utcOf({ ...f, d: daysInMonth(f.y, f.mo), h: 0, mi: 0, s: 0, ms: 0 });
  return inRange(t) ? isoDay(t) : null;
}

// ---------- Text formats ----------

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const NUMBER_FORMAT = /^([$€£¥ ]{0,3})([#,]*0[0,]*)(?:\.(0{1,10}))?(%?)([ $€£¥]{0,3})$/u;
const DATE_TOKEN = /YYYY|YY|MMMM|MMM|MM|M|DDDD|DDD|DD|D|HH|H|hh|h|mm|ss|A|[-/:., T]/g;
export const FORMAT_HELP = 'a number format such as 0, 0.00, #,##0.00, 0%, or $#,##0.00, or a date format of YYYY, YY, MMMM, MMM, MM, M, DDDD, DDD, DD, D, HH, H, hh, h, mm, ss and A (AM or PM) with - / : . , space and T between them';

export type Format = { kind: 'number'; prefix: string; group: boolean; decimals: number; percent: boolean; suffix: string } | { kind: 'date'; tokens: string[] };

export function parseFormat(fmt: string): Format | null {
  if (fmt.length > 60) return null;
  const n = NUMBER_FORMAT.exec(fmt);
  if (n) return { kind: 'number', prefix: n[1]!, group: n[2]!.includes(','), decimals: n[3]?.length ?? 0, percent: n[4] === '%', suffix: n[5]! };
  const tokens = fmt.match(DATE_TOKEN) ?? [];
  if (!tokens.length || tokens.join('') !== fmt || !tokens.some((t) => /[A-Za-z]/.test(t))) return null;
  return { kind: 'date', tokens };
}

function formatNumber(x: number, f: Extract<Format, { kind: 'number' }>): string | null {
  const v = f.percent ? tidy(x * 100) : x;
  if (Math.abs(v) >= 1e21) return null;
  const fixed = Math.abs(tidy(v)).toFixed(f.decimals);
  const [whole, frac] = fixed.split('.');
  const grouped = f.group ? whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : whole!;
  const negative = v < 0 && Number(fixed) !== 0;
  return `${negative ? '-' : ''}${f.prefix}${grouped}${frac ? `.${frac}` : ''}${f.percent ? '%' : ''}${f.suffix}`;
}

function formatDate(w: When, f: Extract<Format, { kind: 'date' }>, zone: string | null): string {
  const x = local(w, zone);
  const p2 = (n: number) => String(n).padStart(2, '0');
  const wd = weekdayOf(dayNumber(x));
  return f.tokens
    .map((t) => {
      switch (t) {
        case 'YYYY': return String(x.y).padStart(4, '0');
        case 'YY': return p2(x.y % 100);
        case 'MMMM': return MONTHS[x.mo - 1]!;
        case 'MMM': return MONTHS[x.mo - 1]!.slice(0, 3);
        case 'MM': return p2(x.mo);
        case 'M': return String(x.mo);
        case 'DDDD': return DAYS[wd]!;
        case 'DDD': return DAYS[wd]!.slice(0, 3);
        case 'DD': return p2(x.d);
        case 'D': return String(x.d);
        case 'HH': return p2(x.h);
        case 'H': return String(x.h);
        case 'hh': return p2(x.h % 12 || 12);
        case 'h': return String(x.h % 12 || 12);
        case 'mm': return p2(x.mi);
        case 'ss': return p2(x.s);
        case 'A': return x.h < 12 ? 'AM' : 'PM';
        default: return t;
      }
    })
    .join('');
}

function textFn([v, fv, zv]: V[]): V {
  if (fv == null) return toText(v ?? null);
  if (typeof fv !== 'string') return null;
  const f = parseFormat(fv);
  const zone = zoneArg(zv);
  if (!f || zone === undefined) return null;
  if (f.kind === 'number') {
    const x = numeric(v);
    return x == null ? null : formatNumber(x, f);
  }
  const w = toWhen(v);
  return w ? formatDate(w, f, zone) : null;
}

const VALUE_RE = /^[+-]?[$€£¥]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:e[+-]?\d+)?%?$/i;

function valueFn([v]: V[]): V {
  if (isNum(v)) return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/\s+/g, '');
  if (!s || !VALUE_RE.test(s) || !/\d/.test(s)) return null;
  const pct = s.endsWith('%');
  const n = Number(s.replace(/[$€£¥,%]/g, ''));
  return Number.isFinite(n) ? (pct ? tidy(n / 100) : n) : null;
}

// ---------- text ----------

function findIn(needle: V | undefined, hay: V | undefined, start: V | undefined, fold: boolean): V {
  if (needle == null || hay == null) return null;
  const s = start == null ? 1 : int(start);
  if (s == null || s < 1) return null;
  let h = toText(hay);
  let n = toText(needle);
  if (fold) {
    h = h.toLowerCase();
    n = n.toLowerCase();
  }
  const hc = chars(h);
  if (s > hc.length + 1) return 0;
  const offset = hc.slice(0, s - 1).join('').length;
  const at = h.indexOf(n, offset);
  return at < 0 ? 0 : chars(h.slice(0, at)).length + 1;
}

function substitute([tv, ov, nv, iv]: V[], ctx: RunCtx): V {
  if (tv == null) return null;
  const text = toText(tv);
  const old = toText(ov ?? null);
  const rep = toText(nv ?? null);
  ctx.charge(Math.ceil(text.length / 1000));
  if (old === '') return text;
  if (iv == null) {
    const r = text.split(old).join(rep);
    return r.length > MAX_TEXT ? null : r;
  }
  const k = int(iv);
  if (k == null || k < 1) return null;
  let at = -1;
  let from = 0;
  for (let i = 0; i < k; i++) {
    at = text.indexOf(old, from);
    if (at < 0) return text;
    from = at + old.length;
  }
  const r = text.slice(0, at) + rep + text.slice(at + old.length);
  return r.length > MAX_TEXT ? null : r;
}

function rept([tv, nv]: V[], ctx: RunCtx): V {
  const n = int(nv);
  if (tv == null || n == null || n < 0) return null;
  const t = toText(tv);
  // Refused, not cut: a repeated text past the cap is almost certainly a mistake.
  if (t.length * n > MAX_TEXT) throw new FormulaFault(`Rept makes at most ${MAX_TEXT} characters.`);
  ctx.charge(Math.ceil((t.length * n) / 1000));
  return t.repeat(n);
}

function split([tv, sv]: V[], ctx: RunCtx): V {
  if (tv == null) return [];
  const t = toText(tv);
  const sep = sv == null ? ',' : toText(sv);
  ctx.charge(Math.ceil(t.length / 100));
  const parts = sep === '' ? chars(t) : t.split(sep);
  return listCap(parts);
}

function proper([tv]: V[]): V {
  if (tv == null) return null;
  return toText(tv)
    .toLowerCase()
    .replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu, (_m, p: string, c: string) => p + c.toUpperCase());
}

function charFn([nv]: V[]): V {
  const n = int(nv);
  if (n == null || n < 32 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return null;
  const c = String.fromCodePoint(n);
  return PRINTABLE(c) ? c : null;
}

function codeFn([tv]: V[]): V {
  if (tv == null) return null;
  const c = chars(toText(tv))[0];
  return c && PRINTABLE(c) ? c.codePointAt(0)! : null;
}

// ---------- math ----------

function roundTo(mode: 'up' | 'down') {
  return ([xv, dv]: V[]): V => {
    const d = dv == null ? 0 : int(dv);
    if (!isNum(xv) || d == null || d < -10 || d > 10) return null;
    const f = 10 ** d;
    const scaled = tidy(Math.abs(xv) * f);
    const r = (mode === 'up' ? Math.ceil(scaled) : Math.floor(scaled)) / f;
    return finite(Math.sign(xv) * tidy(r)) ?? null;
  };
}

function numbersOf(args: V[]): number[] | null {
  const all = spreadNumbers(args);
  return all.every(isNum) ? (all as number[]) : null;
}

// ---------- lists ----------

/** Numbers first (in order), then text (by code point), then booleans; blanks last. Deterministic, no locale. */
function order(a: Scalar, b: Scalar): number {
  const rank = (x: Scalar) => (x == null || x === '' ? 3 : isNum(x) ? 0 : typeof x === 'string' ? 1 : 2);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return (a as number) - (b as number);
  if (ra === 1) return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
  if (ra === 2) return Number(a) - Number(b);
  return 0;
}

const key = (x: Scalar): string => `${typeof x}:${String(x)}`;

// ---------- the table ----------

const DATE_PARAMS: Kind[] = ['date', 'zone'];
const ORDER = { enum: ['asc', 'desc'] } as const;
const UNIT: Kind = { enum: [...UNITS, ...UNITS.map((u) => u.slice(0, -1))] };

const fn = (name: string, f: Omit<Fn, 'name'>): [string, Fn] => [name.toLowerCase(), { name, ...f }];

/**
 * Every function. The ones from before 1.8.0 keep their behaviour and take any kind of argument, so no formula saved
 * before is refused now; the new ones say at parse time what each argument must be.
 */
export const FUNCTIONS = new Map<string, Fn>([
  // ----- logic -----
  fn('if', { min: 2, max: 3, params: ['any', 'any', 'any'], returns: 'any', lazy: true, run: () => null, category: 'Logic', signature: 'if(condition, then, [else])', description: 'The second argument when the condition holds, else the third (or blank).', example: "if(amount > 1000, 'large', 'small')" }),
  fn('coalesce', { min: 1, max: 20, params: [], rest: 'any', returns: 'any', lazy: true, run: () => null, category: 'Logic', signature: 'coalesce(value, …)', description: 'The first argument that is not blank (neither empty text nor null).', example: "coalesce(nickname, name, 'unknown')" }),
  fn('isblank', { min: 1, max: 1, params: ['any'], returns: 'bool', run: ([a]) => blank(a), category: 'Logic', signature: 'isblank(value)', description: 'True for null, empty text or an empty list.', example: 'isblank(phone)' }),
  fn('Switch', { min: 3, max: 41, params: ['any'], rest: 'any', returns: 'any', lazy: true, run: () => null, category: 'Logic', signature: 'Switch(value, match1, result1, …, [default])', description: 'The result paired with the first match equal to the value (with = rules), else the default (or blank).', example: "Switch(status, 'open', 1, 'won', 2, 0)" }),
  fn('IfError', { min: 2, max: 2, params: ['any', 'any'], returns: 'any', lazy: true, run: () => null, category: 'Logic', signature: 'IfError(value, fallback)', description: 'The value, or the fallback when the value fails (a wrong kind of value, out of range, a division by zero) or is blank.', example: 'IfError(total / count, 0)' }),
  fn('IsNumeric', { min: 1, max: 1, params: ['any'], returns: 'bool', run: ([a]) => numeric(a) != null, category: 'Logic', signature: 'IsNumeric(value)', description: 'True for a number, or text that reads as one.', example: "IsNumeric('42')" }),
  fn('IsText', { min: 1, max: 1, params: ['any'], returns: 'bool', run: ([a]) => typeof a === 'string', category: 'Logic', signature: 'IsText(value)', description: 'True when the value is text (including empty text).', example: 'IsText(code)' }),

  // ----- text -----
  fn('concat', { min: 1, max: 20, params: [], rest: 'any', returns: 'text', run: (a) => cap(a.map(toText).join('')), category: 'Text', signature: 'concat(value, …)', description: 'The values joined as text (the & operator does the same).', example: "concat(first, ' ', last)" }),
  fn('upper', { min: 1, max: 1, params: ['any'], returns: 'text', run: ([a]) => (a == null ? null : toText(a).toUpperCase()), category: 'Text', signature: 'upper(text)', description: 'The text in capitals.', example: 'upper(code)' }),
  fn('lower', { min: 1, max: 1, params: ['any'], returns: 'text', run: ([a]) => (a == null ? null : toText(a).toLowerCase()), category: 'Text', signature: 'lower(text)', description: 'The text in lower case.', example: 'lower(email)' }),
  fn('Proper', { min: 1, max: 1, params: ['text'], returns: 'text', run: proper, category: 'Text', signature: 'Proper(text)', description: 'Each word with a capital first letter and the rest in lower case.', example: "Proper('ADA LOVELACE')" }),
  fn('trim', { min: 1, max: 1, params: ['any'], returns: 'text', run: ([a]) => (a == null ? null : toText(a).trim()), category: 'Text', signature: 'trim(text)', description: 'The text without spaces at either end (spaces inside are kept).', example: 'trim(name)' }),
  fn('len', { min: 1, max: 1, params: ['any'], returns: 'num', run: ([a]) => (a == null ? 0 : chars(toText(a)).length), category: 'Text', signature: 'len(text)', description: 'The number of characters.', example: 'len(code)' }),
  fn('left', { min: 2, max: 2, params: ['any', 'any'], returns: 'text', run: ([a, n]) => (a == null || !isNum(n) ? null : chars(toText(a)).slice(0, Math.max(0, Math.floor(n))).join('')), category: 'Text', signature: 'left(text, count)', description: 'The first characters.', example: 'left(code, 3)' }),
  fn('right', { min: 2, max: 2, params: ['any', 'any'], returns: 'text', run: ([a, n]) => (a == null || !isNum(n) ? null : n <= 0 ? '' : chars(toText(a)).slice(-Math.floor(n)).join('')), category: 'Text', signature: 'right(text, count)', description: 'The last characters.', example: 'right(iban, 4)' }),
  fn('mid', { min: 3, max: 3, params: ['any', 'any', 'any'], returns: 'text', run: ([a, s, n]) => (a == null || !isNum(s) || !isNum(n) ? null : chars(toText(a)).slice(Math.max(0, Math.floor(s) - 1), Math.max(0, Math.floor(s) - 1) + Math.max(0, Math.floor(n))).join('')), category: 'Text', signature: 'mid(text, start, count)', description: 'Count characters from position start (the first is 1).', example: 'mid(code, 2, 3)' }),
  fn('contains', { min: 2, max: 2, params: ['any', 'any'], returns: 'bool', run: ([a, b]) => (a == null || b == null ? false : toText(a).toLowerCase().includes(toText(b).toLowerCase())), category: 'Text', signature: 'contains(text, part)', description: 'True when the text holds the part, ignoring case.', example: "contains(notes, 'urgent')" }),
  fn('replace', { min: 3, max: 3, params: ['any', 'any', 'any'], returns: 'text', run: ([a, b, c]) => (a == null ? null : toText(b) === '' ? toText(a) : cap(toText(a).split(toText(b)).join(toText(c)))), category: 'Text', signature: 'replace(text, old, new)', description: 'Every occurrence of old replaced by new.', example: "replace(phone, ' ', '')" }),
  fn('Substitute', { min: 3, max: 4, params: ['text', 'text', 'text', 'num'], returns: 'text', run: substitute, category: 'Text', signature: 'Substitute(text, old, new, [instance])', description: 'Old replaced by new: every occurrence, or only the instance-th (from 1).', example: "Substitute('a-b-c', '-', '+', 2)" }),
  fn('Find', { min: 2, max: 3, params: ['text', 'text', 'num'], returns: 'num', run: ([n, h, s]) => findIn(n, h, s, false), category: 'Text', signature: 'Find(part, text, [start])', description: 'The position (from 1) of the part in the text, matching case; 0 when it is not there.', example: "Find('-', code)" }),
  fn('Search', { min: 2, max: 3, params: ['text', 'text', 'num'], returns: 'num', run: ([n, h, s]) => findIn(n, h, s, true), category: 'Text', signature: 'Search(part, text, [start])', description: 'Like Find, ignoring case.', example: "Search('ltd', company)" }),
  fn('Rept', { min: 2, max: 2, params: ['text', 'num'], returns: 'text', run: rept, category: 'Text', signature: 'Rept(text, times)', description: `The text repeated; refused (blank) past ${MAX_TEXT} characters.`, example: "Rept('*', rating)" }),
  fn('Split', { min: 1, max: 2, params: ['text', 'text'], returns: 'list', run: split, category: 'Text', signature: "Split(text, [separator])", description: `A list of the parts between separators (a comma by default; empty text splits into characters), at most ${MAX_LIST}.`, example: "Split(tags, ';')" }),
  fn('Join', { min: 1, max: 2, params: ['list', 'text'], returns: 'text', run: ([l, s], ctx) => { const items = listOf(l); ctx.charge(Math.ceil(items.length / 100)); const r = items.map(scalarText).join(s == null ? ', ' : toText(s)); return r.length > MAX_TEXT ? null : r; }, category: 'Text', signature: "Join(list, [separator])", description: "The list's items as one text, separated by ', ' or the separator given.", example: "Join(Sort(Split(tags)), ' / ')" }),
  fn('text', { min: 1, max: 3, params: ['any', 'fmt', 'zone'], returns: 'text', run: textFn, category: 'Text', signature: 'text(value, [format], [zone])', description: `The value as text; with a format, ${FORMAT_HELP}.`, example: "text(amount, '#,##0.00')" }),
  fn('number', { min: 1, max: 1, params: ['any'], returns: 'num', run: ([a]) => (isNum(a) ? a : typeof a === 'boolean' ? (a ? 1 : 0) : typeof a === 'string' && a.trim() !== '' && Number.isFinite(Number(a)) ? Number(a) : null), category: 'Text', signature: 'number(value)', description: 'The value as a number (true is 1), or blank.', example: 'number(quantity)' }),
  fn('Value', { min: 1, max: 1, params: ['any'], returns: 'num', run: valueFn, category: 'Text', signature: 'Value(text)', description: "The number written in the text, with thousands commas, a currency sign or a percent allowed ('1,250.50', '$12', '15%').", example: "Value('1,250.50')" }),
  fn('Char', { min: 1, max: 1, params: ['num'], returns: 'text', run: charFn, category: 'Text', signature: 'Char(code)', description: 'The character with that Unicode code point; blank for control, format and unassigned characters.', example: 'Char(9731)' }),
  fn('Code', { min: 1, max: 1, params: ['text'], returns: 'num', run: codeFn, category: 'Text', signature: 'Code(text)', description: "The Unicode code point of the text's first character (blank for a control character).", example: "Code('A')" }),

  // ----- math -----
  fn('round', { min: 1, max: 2, params: ['any', 'any'], returns: 'num', run: ([a, d]) => (isNum(a) ? Math.round(a * 10 ** (isNum(d) ? Math.min(10, Math.max(0, Math.floor(d))) : 0)) / 10 ** (isNum(d) ? Math.min(10, Math.max(0, Math.floor(d))) : 0) : null), category: 'Math', signature: 'round(number, [digits])', description: 'Rounded to 0 to 10 decimal places (halves away from zero for positive numbers).', example: 'round(price * 1.2, 2)' }),
  fn('RoundUp', { min: 1, max: 2, params: ['num', 'num'], returns: 'num', run: roundTo('up'), category: 'Math', signature: 'RoundUp(number, [digits])', description: 'Rounded away from zero to -10 to 10 decimal places.', example: 'RoundUp(3.141, 2)' }),
  fn('RoundDown', { min: 1, max: 2, params: ['num', 'num'], returns: 'num', run: roundTo('down'), category: 'Math', signature: 'RoundDown(number, [digits])', description: 'Rounded toward zero to -10 to 10 decimal places.', example: 'RoundDown(3.149, 2)' }),
  fn('floor', { min: 1, max: 1, params: ['any'], returns: 'num', run: ([a]) => (isNum(a) ? Math.floor(a) : null), category: 'Math', signature: 'floor(number)', description: 'The whole number at or below.', example: 'floor(hours)' }),
  fn('ceil', { min: 1, max: 1, params: ['any'], returns: 'num', run: ([a]) => (isNum(a) ? Math.ceil(a) : null), category: 'Math', signature: 'ceil(number)', description: 'The whole number at or above.', example: 'ceil(boxes)' }),
  fn('abs', { min: 1, max: 1, params: ['any'], returns: 'num', run: ([a]) => (isNum(a) ? Math.abs(a) : null), category: 'Math', signature: 'abs(number)', description: 'The number without its sign.', example: 'abs(balance)' }),
  fn('Sign', { min: 1, max: 1, params: ['num'], returns: 'num', run: ([a]) => (isNum(a) ? Math.sign(a) || 0 : null), category: 'Math', signature: 'Sign(number)', description: '1, 0 or -1.', example: 'Sign(balance)' }),
  fn('Power', { min: 2, max: 2, params: ['num', 'num'], returns: 'num', run: ([a, b]) => (isNum(a) && isNum(b) ? finite(a ** b) : null), category: 'Math', signature: 'Power(base, exponent)', description: 'The base raised to the exponent (blank when the result is not a real number).', example: 'Power(1.05, years)' }),
  fn('Sqrt', { min: 1, max: 1, params: ['num'], returns: 'num', run: ([a]) => (isNum(a) && a >= 0 ? Math.sqrt(a) : null), category: 'Math', signature: 'Sqrt(number)', description: 'The square root (blank for a negative number).', example: 'Sqrt(area)' }),
  fn('Exp', { min: 1, max: 1, params: ['num'], returns: 'num', run: ([a]) => (isNum(a) ? finite(Math.exp(a)) : null), category: 'Math', signature: 'Exp(number)', description: 'e raised to the number.', example: 'Exp(1)' }),
  fn('Ln', { min: 1, max: 1, params: ['num'], returns: 'num', run: ([a]) => (isNum(a) && a > 0 ? Math.log(a) : null), category: 'Math', signature: 'Ln(number)', description: 'The natural logarithm (blank at or below zero).', example: 'Ln(growth)' }),
  fn('Log', { min: 1, max: 2, params: ['num', 'num'], returns: 'num', run: ([a, b]) => { const base = b == null ? 10 : b; return isNum(a) && a > 0 && isNum(base) && base > 0 && base !== 1 ? tidy(Math.log(a) / Math.log(base)) : null; }, category: 'Math', signature: 'Log(number, [base])', description: 'The logarithm in the base given (10 by default).', example: 'Log(8, 2)' }),
  fn('Mod', { min: 2, max: 2, params: ['num', 'num'], returns: 'num', run: ([a, b]) => (isNum(a) && isNum(b) && b !== 0 ? tidy(a - b * Math.floor(a / b)) : null), category: 'Math', signature: 'Mod(number, divisor)', description: 'The remainder, with the sign of the divisor (the % operator keeps the sign of the number).', example: 'Mod(-7, 3)' }),
  fn('Clamp', { min: 3, max: 3, params: ['num', 'num', 'num'], returns: 'num', run: ([x, lo, hi]) => (isNum(x) && isNum(lo) && isNum(hi) && lo <= hi ? Math.min(hi, Math.max(lo, x)) : null), category: 'Math', signature: 'Clamp(number, low, high)', description: 'The number kept between low and high.', example: 'Clamp(discount, 0, 0.3)' }),
  fn('min', { min: 1, max: 20, params: [], rest: 'any', returns: 'num', run: (a) => { const n = numbersOf(a); return n && n.length ? Math.min(...n) : null; }, category: 'Math', signature: 'min(number or list, …)', description: 'The smallest number; lists are read item by item (their blanks skipped).', example: 'min(Split(scores))' }),
  fn('max', { min: 1, max: 20, params: [], rest: 'any', returns: 'num', run: (a) => { const n = numbersOf(a); return n && n.length ? Math.max(...n) : null; }, category: 'Math', signature: 'max(number or list, …)', description: 'The largest number; lists are read item by item.', example: 'max(a, b, c)' }),
  fn('sum', { min: 1, max: 20, params: [], rest: 'any', returns: 'num', run: (a) => { const all = spreadNumbers(a); return all.every((x) => x == null || isNum(x)) ? tidy((all.filter(isNum) as number[]).reduce((x, y) => x + y, 0)) : null; }, category: 'Math', signature: 'sum(number or list, …)', description: 'The total; blanks count as nothing.', example: 'sum(net, tax)' }),
  fn('Average', { min: 1, max: 20, params: [], rest: 'any', returns: 'num', run: (a) => { const all = spreadNumbers(a).filter((x) => x != null); return all.length && all.every(isNum) ? tidy((all as number[]).reduce((x, y) => x + y, 0) / all.length) : null; }, category: 'Math', signature: 'Average(number or list, …)', description: 'The mean of the numbers, blanks left out (blank when there are none).', example: 'Average(q1, q2, q3, q4)' }),

  // ----- dates -----
  fn('today', { min: 0, max: 0, params: [], returns: 'date', run: () => isoDay(Date.now()), category: 'Dates', signature: 'today()', description: "Today's date in UTC. Reads the clock: the value is fixed when the record is written.", example: 'today()' }),
  fn('now', { min: 0, max: 0, params: [], returns: 'date', run: () => new Date().toISOString(), category: 'Dates', signature: 'now()', description: 'The current instant in UTC. Reads the clock: the value is fixed when the record is written.', example: 'now()' }),
  fn('year', { min: 1, max: 2, params: DATE_PARAMS, returns: 'num', run: part('y'), category: 'Dates', signature: 'year(date, [zone])', description: 'The year (in the zone given, else UTC).', example: 'year(closed_on)' }),
  fn('month', { min: 1, max: 2, params: DATE_PARAMS, returns: 'num', run: part('mo'), category: 'Dates', signature: 'month(date, [zone])', description: 'The month, 1 to 12.', example: 'month(closed_on)' }),
  fn('day', { min: 1, max: 2, params: DATE_PARAMS, returns: 'num', run: part('d'), category: 'Dates', signature: 'day(date, [zone])', description: 'The day of the month, 1 to 31.', example: 'day(due)' }),
  fn('Hour', { min: 1, max: 2, params: DATE_PARAMS, returns: 'num', run: part('h'), category: 'Dates', signature: 'Hour(date, [zone])', description: 'The hour, 0 to 23 (0 for a calendar date).', example: "Hour(created, 'Europe/Lisbon')" }),
  fn('Minute', { min: 1, max: 2, params: DATE_PARAMS, returns: 'num', run: part('mi'), category: 'Dates', signature: 'Minute(date, [zone])', description: 'The minute, 0 to 59.', example: 'Minute(created)' }),
  fn('Second', { min: 1, max: 2, params: DATE_PARAMS, returns: 'num', run: part('s'), category: 'Dates', signature: 'Second(date, [zone])', description: 'The second, 0 to 59.', example: 'Second(created)' }),
  fn('Weekday', { min: 1, max: 2, params: DATE_PARAMS, returns: 'num', run: part('weekday'), category: 'Dates', signature: 'Weekday(date, [zone])', description: 'The day of the week, 1 (Sunday) to 7 (Saturday).', example: 'Weekday(due)' }),
  fn('WeekNum', { min: 1, max: 2, params: DATE_PARAMS, returns: 'num', run: part('weeknum'), category: 'Dates', signature: 'WeekNum(date, [zone])', description: 'The ISO 8601 week number, 1 to 53 (weeks start on Monday).', example: 'WeekNum(due)' }),
  fn('add_days', { min: 2, max: 2, params: ['any', 'any'], returns: 'date', run: ([a, n]) => (toTime(a ?? null) == null || !isNum(n) ? null : isoDay(toTime(a ?? null)! + Math.round(n) * DAY)), category: 'Dates', signature: 'add_days(date, days)', description: 'The calendar date that many days later (earlier when negative).', example: 'add_days(start, 30)' }),
  fn('days_between', { min: 2, max: 2, params: ['any', 'any'], returns: 'num', run: ([a, b]) => (toTime(a ?? null) == null || toTime(b ?? null) == null ? null : Math.round((toTime(b ?? null)! - toTime(a ?? null)!) / DAY)), category: 'Dates', signature: 'days_between(start, end)', description: 'Days from start to end, rounded.', example: 'days_between(opened, closed)' }),
  fn('DateAdd', { min: 3, max: 4, params: ['date', 'num', UNIT, 'zone'], returns: 'date', run: ([d, n, u, z]) => dateAdd(d, n, u, z), category: 'Dates', signature: 'DateAdd(date, amount, unit, [zone])', description: `The date moved by a whole amount of ${UNITS.join(', ')}. Months, quarters and years end on the last day of a shorter month (31 January plus one month is 28 or 29 February). A calendar date stays a calendar date for days and longer.`, example: "DateAdd(start, 1, 'months')" }),
  fn('DateDiff', { min: 3, max: 4, params: ['date', 'date', UNIT, 'zone'], returns: 'num', run: ([a, b, u, z]) => dateDiff(a, b, u, z), category: 'Dates', signature: 'DateDiff(start, end, unit, [zone])', description: 'Whole units from start to end (negative when end is earlier). A month that ends on the last day of a shorter month counts as complete.', example: "DateDiff(hired, today(), 'years')" }),
  fn('EOMonth', { min: 1, max: 2, params: ['date', 'num'], returns: 'date', run: eoMonth, category: 'Dates', signature: 'EOMonth(date, [months])', description: 'The last day of the month, that many months later.', example: 'EOMonth(invoiced, 1)' }),
  fn('NetWorkDays', { min: 2, max: 3, params: ['date', 'date', 'list'], returns: 'num', run: netWorkDays, category: 'Dates', signature: 'NetWorkDays(start, end, [holidays])', description: 'Monday-to-Friday days from start to end, both counted, less the holidays (a list of dates).', example: "NetWorkDays(start, end, Split('2026-12-25,2026-12-26'))" }),
  fn('WorkDay', { min: 2, max: 3, params: ['date', 'num', 'list'], returns: 'date', run: workDay, category: 'Dates', signature: 'WorkDay(start, days, [holidays])', description: 'The date that many working days (Monday to Friday, not a holiday) after start.', example: 'WorkDay(ordered, 5)' }),

  // ----- lists -----
  fn('List', { min: 0, max: 50, params: [], rest: 'any', returns: 'list', run: (a) => listCap(a.flatMap((x) => (isList(x) ? x : [x]))), category: 'Lists', signature: 'List(value, …)', description: 'A list of the values (lists given are spread into it).', example: "List('red', 'green')" }),
  fn('Count', { min: 1, max: 20, params: [], rest: 'any', returns: 'num', run: (a) => spread(a).filter((x) => x != null && x !== '').length, category: 'Lists', signature: 'Count(list or value, …)', description: 'How many items are not blank.', example: 'Count(Split(tags))' }),
  fn('CountIf', { min: 2, max: 2, params: ['list', 'any'], returns: 'num', lazy: true, run: () => null, category: 'Lists', signature: 'CountIf(list, condition)', description: 'How many items meet the condition, which reads each one as item (or, without item, how many equal it).', example: 'CountIf(Split(scores), number(item) >= 50)' }),
  fn('First', { min: 1, max: 1, params: ['list'], returns: 'any', run: ([l]) => listOf(l)[0] ?? null, category: 'Lists', signature: 'First(list)', description: 'The first item (blank for an empty list).', example: 'First(Split(name, " "))' }),
  fn('Last', { min: 1, max: 1, params: ['list'], returns: 'any', run: ([l]) => listOf(l).at(-1) ?? null, category: 'Lists', signature: 'Last(list)', description: 'The last item.', example: "Last(Split(path, '/'))" }),
  fn('Index', { min: 2, max: 2, params: ['list', 'num'], returns: 'any', run: ([l, n]) => { const items = listOf(l); const i = int(n); if (i == null || i === 0) return null; return (i > 0 ? items[i - 1] : items[items.length + i]) ?? null; }, category: 'Lists', signature: 'Index(list, position)', description: 'The item at the position, from 1 (negative counts from the end).', example: 'Index(Split(code, "-"), 2)' }),
  fn('Sort', { min: 1, max: 2, params: ['list', ORDER], returns: 'list', run: ([l, o], ctx) => { const items = [...listOf(l)]; ctx.charge(Math.ceil((items.length * Math.log2(items.length + 2)) / 50)); items.sort(order); return o != null && String(o).toLowerCase() === 'desc' ? items.reverse() : items; }, category: 'Lists', signature: "Sort(list, ['asc' or 'desc'])", description: 'The items in order: numbers, then text by character code, then true and false, blanks last.', example: "Sort(Split(tags), 'desc')" }),
  fn('Unique', { min: 1, max: 1, params: ['list'], returns: 'list', run: ([l], ctx) => { const items = listOf(l); ctx.charge(Math.ceil(items.length / 50)); const seen = new Set<string>(); return items.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true))); }, category: 'Lists', signature: 'Unique(list)', description: 'The items without repeats, in the order first seen.', example: 'Unique(Split(tags))' })
]);

/** The names a formula can call, lower-case (as written in prompts and checked by the console). */
export const FUNCTION_NAMES = [...FUNCTIONS.keys()];

/** The catalogue the formula editor lists: name, signature, what it does, an example, its category. */
export function formulaCatalogue() {
  return [...FUNCTIONS.values()].map((f) => ({ name: f.name, call: f.name.toLowerCase(), category: f.category, signature: f.signature, description: f.description, example: f.example, minArgs: f.min, maxArgs: f.max }));
}

export const kindName = (k: Kind | Result): string => (typeof k === 'object' ? `one of ${k.enum.filter((x) => x.endsWith('s') || !k.enum.includes(`${x}s`)).join(', ')}` : k === 'num' ? 'a number' : k === 'text' ? 'text' : k === 'date' ? 'a date' : k === 'list' ? 'a list' : k === 'bool' ? 'true or false' : k === 'zone' ? 'a time zone such as Europe/Lisbon' : k === 'fmt' ? 'a format' : 'any value');
export { unitOf, zoneArg, numeric };
