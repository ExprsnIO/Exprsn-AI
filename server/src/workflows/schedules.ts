import { z } from 'zod';
import { isTimeZone, offsetAt, wallTime, zonedToUtc, type WallTime } from '../groups/time.js';
import { nextCron, parseCron as parseTrainingCron } from '../training/calendar.js';

/*
 * 1.8.0, Sprint 47 (B-138): schedule triggers with a time zone, presets and a preview of the next runs.
 *
 * A schedule trigger's `cron` has five fields (minute, hour, day of the month, month, day of the week) and reads its
 * wall-clock times in `timezone`, an IANA zone (`Europe/Berlin`); without one it is UTC, and an expression the
 * training calendar's parser reads is then computed by that parser (`nextCron`), so every schedule from before this
 * sprint fires at exactly the same instants. On top of that parser's numbers, `*`, ranges, lists and steps, a
 * workflow schedule also reads:
 *
 * - month and day names (`JAN`–`DEC`, `SUN`–`SAT`, any case);
 * - in the day of the month: `L` (the last day), `LW` (the last weekday), `15W` (the weekday nearest the 15th, within
 *   the month, so `1W` is the first business day);
 * - in the day of the week: `1#2` (the second Monday of the month).
 *
 * Daylight-saving changes, both directions:
 *
 * - clocks go forward (a wall time that does not exist that day): a schedule that names the hour (`30 2 * * *`) runs
 *   once, at the moment the clocks jump (03:00 in Europe/Berlin), as cron does; one whose hour is `*` (every 15
 *   minutes, hourly) just has fewer runs that day, since the skipped times never happen;
 * - clocks go back (a wall time that happens twice): a schedule that names the hour runs once, at the first
 *   occurrence; one whose hour is `*` keeps its pace through both, so "every 15 minutes" never pauses for an hour.
 *
 * Only the platform's Intl zone data is used (`groups/time.ts`), like group events and SLA business hours.
 */

const MINUTE = 60_000;
const DAY = 86_400_000;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DOWS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A schedule that cannot be read, with the reason in plain words. */
export class ScheduleError extends Error {}

interface Field {
  any: boolean;
  values: Set<number>;
}

interface DomSpecial {
  last: boolean;
  lastWeekday: boolean;
  nearest: number[];
}

export interface Schedule {
  minute: Field;
  hour: Field;
  dom: Field & DomSpecial;
  month: Field;
  dow: Field & { nth: { day: number; n: number }[] };
  /** The training parser reads it as is (no names, L, W or #). */
  plain: boolean;
}

type Part = 'minute' | 'hour' | 'day of the month' | 'month' | 'day of the week';
const RANGE: Record<Part, [number, number, string]> = {
  minute: [0, 59, 'minutes run from 0 to 59'],
  hour: [0, 23, 'hours run from 0 to 23'],
  'day of the month': [1, 31, 'days of the month run from 1 to 31'],
  month: [1, 12, 'months run from 1 (January) to 12 (December), or JAN to DEC'],
  'day of the week': [0, 7, 'days of the week run from 0 (Sunday) to 6 (Saturday), 7 is also Sunday, or SUN to SAT']
};

function named(src: string, names: string[], offset: number): string {
  return src.replace(/[A-Za-z]{3}/g, (m) => {
    const i = names.indexOf(m.toUpperCase());
    if (i < 0) throw new ScheduleError(`"${m}" is not a name this schedule knows; use ${names.slice(0, 3).join(', ')} and so on, or numbers.`);
    return String(i + offset);
  });
}

function field(raw: string, part: Part): Field {
  const [min, max, help] = RANGE[part];
  const values = new Set<number>();
  for (const piece of raw.split(',')) {
    if (piece === '') throw new ScheduleError(`The ${part} part "${raw}" has an empty item between commas.`);
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(piece);
    if (!m) throw new ScheduleError(`The ${part} part "${raw}" is not something a schedule can read: use a number, *, a range such as 1-5, a list such as 1,15 or a step such as */15.`);
    const step = m[4] ? Number(m[4]) : 1;
    const lo = m[1] === '*' ? min : Number(m[2]);
    const hi = m[1] === '*' ? max : m[3] ? Number(m[3]) : m[4] ? max : lo;
    if (step < 1) throw new ScheduleError(`The ${part} part "${raw}" steps by 0; a step is 1 or more.`);
    if (lo < min || hi > max) throw new ScheduleError(`The ${part} part "${raw}" is out of range: ${help}.`);
    if (lo > hi) throw new ScheduleError(`The ${part} part "${raw}" has a range that runs backwards (${lo} to ${hi}); write the smaller number first.`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { any: raw === '*', values };
}

/** Reads a five-field schedule, or throws a ScheduleError that says what is wrong in plain words. */
export function parseSchedule(expr: string): Schedule {
  const parts = String(expr ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5) throw new ScheduleError(`A schedule has five parts, minute, hour, day of the month, month and day of the week, such as "0 9 * * 1-5" (09:00 on weekdays); this one has ${parts.length}.`);
  const [mi, ho, dm, mo, dw] = parts as [string, string, string, string, string];
  let plain = true;
  try {
    parseTrainingCron(parts.join(' '));
  } catch {
    plain = false;
  }
  const minute = field(mi, 'minute');
  const hour = field(ho, 'hour');
  const month = field(named(mo, MONTHS, 1), 'month');
  // The day of the month: numbers, plus L, LW and nW.
  const domSpecial: DomSpecial = { last: false, lastWeekday: false, nearest: [] };
  const domPlain: string[] = [];
  for (const piece of dm.split(',')) {
    const up = piece.toUpperCase();
    if (up === 'L') domSpecial.last = true;
    else if (up === 'LW') domSpecial.lastWeekday = true;
    else if (/^\d+W$/.test(up)) {
      const n = Number(up.slice(0, -1));
      if (n < 1 || n > 31) throw new ScheduleError(`The day of the month part "${dm}" asks for the weekday nearest day ${n}; days of the month run from 1 to 31.`);
      domSpecial.nearest.push(n);
    } else if (/W|L/i.test(piece)) throw new ScheduleError(`The day of the month part "${dm}" is not something a schedule can read: L is the last day, LW the last weekday, and 15W the weekday nearest the 15th.`);
    else domPlain.push(piece);
  }
  const special = domSpecial.last || domSpecial.lastWeekday || domSpecial.nearest.length > 0;
  const domField = domPlain.length ? field(domPlain.join(','), 'day of the month') : { any: false, values: new Set<number>() };
  const dom = { ...domField, any: !special && domField.any, ...domSpecial };
  // The day of the week: numbers and names, plus d#n.
  const nth: { day: number; n: number }[] = [];
  const dowPlain: string[] = [];
  for (const piece of named(dw, DOWS, 0).split(',')) {
    const m = /^(\d)#(\d)$/.exec(piece);
    if (m) {
      const day = Number(m[1]) % 7;
      const n = Number(m[2]);
      if (Number(m[1]) > 7) throw new ScheduleError(`The day of the week part "${dw}" names day ${m[1]}; ${RANGE['day of the week'][2]}.`);
      if (n < 1 || n > 5) throw new ScheduleError(`The day of the week part "${dw}" asks for occurrence ${n} of a day in the month; there are at most 5 (1#1 is the first Monday, 5#5 the fifth Friday).`);
      nth.push({ day, n });
    } else if (piece.includes('#')) throw new ScheduleError(`The day of the week part "${dw}" is not something a schedule can read: 1#2 is the second Monday of the month.`);
    else dowPlain.push(piece);
  }
  const dowField = dowPlain.length ? field(dowPlain.join(','), 'day of the week') : { any: false, values: new Set<number>() };
  if (dowField.values.has(7)) dowField.values.add(0);
  const dow = { ...dowField, any: !nth.length && dowField.any, nth };
  if (!dom.any && !dom.values.size && !special && !dow.any && !dow.values.size && !nth.length) throw new ScheduleError('This schedule names no day.');
  return { minute, hour, dom, month, dow, plain };
}

const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const weekday = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

function nearestWeekday(y: number, m: number, n: number): number | null {
  const dim = daysIn(y, m);
  if (n > dim) return null;
  const w = weekday(y, m, n);
  if (w === 6) return n === 1 ? 3 : n - 1;
  if (w === 0) return n === dim ? n - 2 : n + 1;
  return n;
}

function lastWeekday(y: number, m: number): number {
  let d = daysIn(y, m);
  while (weekday(y, m, d) === 0 || weekday(y, m, d) === 6) d--;
  return d;
}

function dayMatches(c: Schedule, y: number, m: number, d: number): boolean {
  if (!c.month.values.has(m)) return false;
  const w = weekday(y, m, d);
  const domHit = c.dom.values.has(d) || (c.dom.last && d === daysIn(y, m)) || (c.dom.lastWeekday && d === lastWeekday(y, m)) || c.dom.nearest.some((n) => nearestWeekday(y, m, n) === d);
  const dowHit = c.dow.values.has(w) || c.dow.nth.some((x) => x.day === w && Math.ceil(d / 7) === x.n);
  // Standard cron: when both day parts are restricted, either may match.
  if (!c.dom.any && !c.dow.any) return domHit || dowHit;
  return (c.dom.any || domHit) && (c.dow.any || dowHit);
}

const wallMatches = (c: Schedule, w: WallTime) => dayMatches(c, w.year, w.month, w.day) && c.hour.values.has(w.hour) && c.minute.values.has(w.minute);

/** The wall time `minutes` after `w`, as plain calendar arithmetic. */
function addWall(w: WallTime, minutes: number): WallTime {
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) + minutes * MINUTE);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: 0 };
}

/** Throws a ScheduleError unless `tz` is an IANA zone this server knows. */
export function checkTimeZone(tz: string): void {
  if (!isTimeZone(tz)) throw new ScheduleError(`"${String(tz).slice(0, 64)}" is not a time zone this server knows. Use an IANA name such as Europe/Berlin or America/New_York, or UTC.`);
}

/**
 * The first instant strictly after `from` at which the schedule runs in `tz`, or null when it does not run within a
 * year and a day. UTC with a plain expression is the training calendar's `nextCron`, unchanged.
 */
export function nextRun(expr: string | Schedule, from: number, tz?: string | null): number | null {
  const zone = tz || 'UTC';
  const c = typeof expr === 'string' ? parseSchedule(expr) : expr;
  if (zone === 'UTC' && c.plain && typeof expr === 'string') return nextCron(expr, from);
  checkTimeZone(zone);
  const fixedHour = !c.hour.any;
  const minutes = [...c.minute.values].sort((a, b) => a - b);
  let t = Math.floor(from / MINUTE) * MINUTE + MINUTE;
  const limit = from + 367 * DAY;
  while (t <= limit) {
    const w = wallTime(t, zone);
    // Clocks just went forward: a schedule that names the hour runs now for a time the jump skipped.
    const before = offsetAt(t - MINUTE, zone);
    const gap = (offsetAt(t, zone) - before) / MINUTE;
    if (gap > 0 && fixedHour) {
      const prev = wallTime(t - MINUTE, zone);
      for (let k = 1; k <= gap; k++) if (wallMatches(c, addWall(prev, k))) return t;
    }
    if (!dayMatches(c, w.year, w.month, w.day)) {
      const n = addWall({ ...w, hour: 0, minute: 0, second: 0 }, 24 * 60);
      const midnight = zonedToUtc(n, zone);
      t = midnight > t ? midnight : t + MINUTE;
      continue;
    }
    if (!c.hour.values.has(w.hour)) {
      t += (60 - w.minute) * MINUTE;
      continue;
    }
    if (c.minute.values.has(w.minute)) {
      // Clocks went back: the second occurrence of a wall time runs only for schedules whose hour is *.
      if (fixedHour && zonedToUtc(w, zone) < t) {
        t += MINUTE;
        continue;
      }
      return t;
    }
    const next = minutes.find((m) => m > w.minute) ?? 60;
    const cap = w.minute < 30 ? 30 : 60; // land on :30 and :00, where zones change their offset
    t += (Math.min(next, cap) - w.minute) * MINUTE;
  }
  return null;
}

/** The next `count` runs after `from`. */
export function nextRuns(expr: string, tz: string | null | undefined, count: number, from = Date.now()): number[] {
  const c = parseSchedule(expr);
  const out: number[] = [];
  let t = from;
  for (let i = 0; i < count; i++) {
    const n = nextRun(c.plain && (!tz || tz === 'UTC') ? expr : c, t, tz);
    if (n == null) break;
    out.push(n);
    t = n;
  }
  return out;
}

/** Why a schedule cannot be saved, in plain words, or null. */
export function scheduleProblem(expr: string, tz?: string | null): string | null {
  try {
    if (tz) checkTimeZone(tz);
    const c = parseSchedule(expr);
    if (nextRun(c.plain && (!tz || tz === 'UTC') ? expr : c, Date.now(), tz) == null) return 'This schedule never runs within a year: check that the day of the month exists in the months it names (there is no 30 February).';
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

// ---------- in plain words ----------

const pad = (n: number) => String(n).padStart(2, '0');
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;
const NTH = ['', 'first', 'second', 'third', 'fourth', 'fifth'];

function stepOf(f: Field, min: number, max: number): number | null {
  const v = [...f.values].sort((a, b) => a - b);
  if (v.length < 2 || v[0] !== min) return null;
  const s = v[1]! - v[0]!;
  for (let i = 1; i < v.length; i++) if (v[i]! - v[i - 1]! !== s) return null;
  return v[v.length - 1]! + s > max ? s : null;
}

function rangeOf(f: Field): [number, number] | null {
  const v = [...f.values].sort((a, b) => a - b);
  if (v.length < 2) return null;
  for (let i = 1; i < v.length; i++) if (v[i]! !== v[i - 1]! + 1) return null;
  return [v[0]!, v[v.length - 1]!];
}

/** A reading of the schedule ("Weekdays at 09:00 (Europe/Berlin)"), or the expression when it is unusual. */
export function describeSchedule(expr: string, tz?: string | null): string {
  let c: Schedule;
  try {
    c = parseSchedule(expr);
  } catch {
    return expr;
  }
  const zone = ` (${tz || 'UTC'})`;
  const mins = [...c.minute.values].sort((a, b) => a - b);
  const hours = [...c.hour.values].sort((a, b) => a - b);
  let time: string;
  const mStep = stepOf(c.minute, 0, 59);
  const hStep = stepOf(c.hour, 0, 23);
  const hRange = rangeOf(c.hour);
  if (c.minute.any && c.hour.any) time = 'every minute';
  else if (mStep && c.hour.any) time = `every ${mStep} minutes`;
  else if (mStep && hRange) time = `every ${mStep} minutes from ${pad(hRange[0])}:00 to ${pad(hRange[1])}:${pad(60 - mStep)}`;
  else if (mins.length === 1 && c.hour.any) time = mins[0] === 0 ? 'every hour, on the hour' : `every hour at :${pad(mins[0]!)}`;
  else if (mins.length === 1 && hStep) time = `every ${hStep} hours at :${pad(mins[0]!)}`;
  else if (mins.length === 1 && hRange && hRange[1] - hRange[0] > 1) time = `every hour from ${pad(hRange[0])}:${pad(mins[0]!)} to ${pad(hRange[1])}:${pad(mins[0]!)}`;
  else if (mins.length * hours.length <= 6 && !c.hour.any) time = `at ${list(hours.flatMap((h) => mins.map((m) => `${pad(h)}:${pad(m)}`)))}`;
  else return `${expr}${zone}`;
  const days: string[] = [];
  const dows = [...c.dow.values].filter((d) => d < 7).sort((a, b) => a - b);
  if (!c.dow.any) {
    if (dows.join() === '1,2,3,4,5') days.push('on weekdays');
    else if (dows.join() === '0,6') days.push('at weekends');
    else if (dows.length) days.push(`on ${list(dows.map((d) => `${DAY_NAMES[d]}s`))}`);
    for (const x of c.dow.nth) days.push(`on the ${NTH[x.n]} ${DAY_NAMES[x.day]} of the month`);
  }
  if (!c.dom.any) {
    const ds = [...c.dom.values].sort((a, b) => a - b);
    if (ds.length) days.push(`on the ${list(ds.map(ordinal))} of the month`);
    if (c.dom.last) days.push('on the last day of the month');
    if (c.dom.lastWeekday) days.push('on the last business day of the month');
    for (const n of c.dom.nearest) days.push(n === 1 ? 'on the first business day of the month' : `on the weekday nearest the ${ordinal(n)}`);
  }
  let months = '';
  if (!c.month.any) {
    const ms = [...c.month.values].sort((a, b) => a - b);
    const ds = [...c.dom.values];
    months = ms.join() === '1,4,7,10' ? ' of each quarter' : ` in ${list(ms.map((m) => MONTH_NAMES[m - 1]!))}`;
    if (months === ' of each quarter') days.forEach((d, i) => (days[i] = d.replace(/ of the month$/, '')));
    else if (ms.length === 1 && ds.length === 1 && days.length === 1 && c.dow.any) {
      days[0] = `on ${ds[0]} ${MONTH_NAMES[ms[0]! - 1]}`;
      months = '';
    }
  }
  const dayText = days.length ? `${list(days)}${months}` : months ? `every day${months}` : '';
  const out = dayText ? `${dayText[0]!.toUpperCase()}${dayText.slice(1)}, ${time}` : `${time[0]!.toUpperCase()}${time.slice(1)}${/^(at|every hour|every \d+ hours)/.test(time) && !/minute/.test(time) ? ', every day' : ''}`;
  return `${out}${zone}`;
}

// ---------- presets ----------

export interface PresetParam {
  name: 'n' | 'minute' | 'hour' | 'hour2' | 'day' | 'dow';
  label: string;
  min: number;
  max: number;
  default: number;
}

export interface SchedulePreset {
  id: string;
  title: string;
  group: 'Minutes and hours' | 'Days' | 'Weeks' | 'Months and quarters' | 'Years';
  params: PresetParam[];
  build: (v: Record<string, number>) => string;
}

const P = {
  n: (label: string, min: number, max: number, def: number): PresetParam => ({ name: 'n', label, min, max, default: def }),
  minute: (def = 0): PresetParam => ({ name: 'minute', label: 'Minute', min: 0, max: 59, default: def }),
  hour: (def = 9): PresetParam => ({ name: 'hour', label: 'Hour', min: 0, max: 23, default: def }),
  hour2: (def = 17): PresetParam => ({ name: 'hour2', label: 'Second hour', min: 0, max: 23, default: def }),
  day: (def = 1): PresetParam => ({ name: 'day', label: 'Day of the month', min: 1, max: 31, default: def }),
  dow: (def = 1): PresetParam => ({ name: 'dow', label: 'Day of the week (0 Sunday to 6 Saturday)', min: 0, max: 6, default: def })
};

/** About twenty common schedules; each builds a cron the trigger stores (the cron is what runs, not the preset). */
export const SCHEDULE_PRESETS: SchedulePreset[] = [
  { id: 'every-n-minutes', title: 'Every N minutes', group: 'Minutes and hours', params: [P.n('Every (minutes)', 1, 30, 15)], build: (v) => (v.n === 1 ? '* * * * *' : `*/${v.n} * * * *`) },
  { id: 'hourly', title: 'Every hour at minute M', group: 'Minutes and hours', params: [P.minute(0)], build: (v) => `${v.minute} * * * *` },
  { id: 'every-n-hours', title: 'Every N hours', group: 'Minutes and hours', params: [P.n('Every (hours)', 2, 12, 2), P.minute(0)], build: (v) => `${v.minute} */${v.n} * * *` },
  { id: 'business-hours-hourly', title: 'Hourly in business hours (weekdays 09:00 to 17:00)', group: 'Minutes and hours', params: [P.minute(0)], build: (v) => `${v.minute} 9-17 * * 1-5` },
  { id: 'business-hours-every-15', title: 'Every 15 minutes in business hours', group: 'Minutes and hours', params: [], build: () => '*/15 9-16 * * 1-5' },
  { id: 'daily', title: 'Every day at a time', group: 'Days', params: [P.hour(9), P.minute(0)], build: (v) => `${v.minute} ${v.hour} * * *` },
  { id: 'twice-daily', title: 'Twice a day', group: 'Days', params: [P.hour(9), P.hour2(17), P.minute(0)], build: (v) => `${v.minute} ${[...new Set([v.hour!, v.hour2!])].sort((a, b) => a - b).join(',')} * * *` },
  { id: 'midnight', title: 'Every day at midnight', group: 'Days', params: [], build: () => '0 0 * * *' },
  { id: 'weekdays', title: 'Weekdays at a time', group: 'Days', params: [P.hour(9), P.minute(0)], build: (v) => `${v.minute} ${v.hour} * * 1-5` },
  { id: 'weekends', title: 'Weekends at a time', group: 'Days', params: [P.hour(10), P.minute(0)], build: (v) => `${v.minute} ${v.hour} * * 0,6` },
  { id: 'weekly', title: 'Once a week', group: 'Weeks', params: [P.dow(1), P.hour(9), P.minute(0)], build: (v) => `${v.minute} ${v.hour} * * ${v.dow}` },
  { id: 'monday-morning', title: 'Monday mornings at 08:00', group: 'Weeks', params: [], build: () => '0 8 * * 1' },
  { id: 'friday-afternoon', title: 'Friday afternoons at 16:00', group: 'Weeks', params: [], build: () => '0 16 * * 5' },
  { id: 'monthly', title: 'Monthly on a day', group: 'Months and quarters', params: [P.day(1), P.hour(9), P.minute(0)], build: (v) => `${v.minute} ${v.hour} ${v.day} * *` },
  { id: 'first-business-day', title: 'First business day of the month', group: 'Months and quarters', params: [P.hour(9), P.minute(0)], build: (v) => `${v.minute} ${v.hour} 1W * *` },
  { id: 'last-day', title: 'Last day of the month', group: 'Months and quarters', params: [P.hour(17), P.minute(0)], build: (v) => `${v.minute} ${v.hour} L * *` },
  { id: 'last-business-day', title: 'Last business day of the month', group: 'Months and quarters', params: [P.hour(17), P.minute(0)], build: (v) => `${v.minute} ${v.hour} LW * *` },
  { id: 'first-weekday-of-month', title: 'First chosen weekday of the month (such as the first Monday)', group: 'Months and quarters', params: [P.dow(1), P.hour(9), P.minute(0)], build: (v) => `${v.minute} ${v.hour} * * ${v.dow}#1` },
  { id: 'quarterly', title: 'Quarterly, on the first day of the quarter', group: 'Months and quarters', params: [P.hour(9), P.minute(0)], build: (v) => `${v.minute} ${v.hour} 1 1,4,7,10 *` },
  { id: 'quarterly-business-day', title: 'Quarterly, on the first business day of the quarter', group: 'Months and quarters', params: [P.hour(9), P.minute(0)], build: (v) => `${v.minute} ${v.hour} 1W 1,4,7,10 *` },
  { id: 'yearly', title: 'Once a year, on 1 January', group: 'Years', params: [P.hour(9), P.minute(0)], build: (v) => `${v.minute} ${v.hour} 1 1 *` }
];

export const presetView = (p: SchedulePreset) => ({ id: p.id, title: p.title, group: p.group, params: p.params, example: p.build(Object.fromEntries(p.params.map((x) => [x.name, x.default]))) });

/** The cron a preset builds with the given values (defaults for the rest), or a ScheduleError in plain words. */
export function buildPreset(id: string, values: Record<string, number> = {}): string {
  const p = SCHEDULE_PRESETS.find((x) => x.id === id);
  if (!p) throw new ScheduleError(`There is no schedule preset ${id}.`);
  const v: Record<string, number> = {};
  for (const x of p.params) {
    const raw = values[x.name] ?? x.default;
    if (!Number.isInteger(raw) || raw < x.min || raw > x.max) throw new ScheduleError(`${x.label} must be a whole number from ${x.min} to ${x.max}; ${String(raw)} is not.`);
    v[x.name] = raw;
  }
  return p.build(v);
}

// ---------- the preview ----------

export const previewSchema = z
  .object({
    cron: z.string().trim().min(1).max(120).optional(),
    preset: z.string().trim().min(1).max(60).optional(),
    values: z.object({ n: z.number().int().optional(), minute: z.number().int().optional(), hour: z.number().int().optional(), hour2: z.number().int().optional(), day: z.number().int().optional(), dow: z.number().int().optional() }).strict().optional(),
    timezone: z.string().trim().min(1).max(64).default('UTC'),
    count: z.number().int().min(1).max(50).default(10),
    from: z.number().int().min(0).optional()
  })
  .strict()
  .refine((b) => !!b.cron !== !!b.preset, 'Give a cron expression or a preset, not both');

/** The next runs of a schedule with their wall-clock times in its zone, and notes on daylight-saving changes. */
export function preview(input: z.infer<typeof previewSchema>) {
  const cron = input.preset ? buildPreset(input.preset, Object.fromEntries(Object.entries(input.values ?? {}).filter(([, v]) => v !== undefined)) as Record<string, number>) : input.cron!;
  checkTimeZone(input.timezone);
  const c = parseSchedule(cron);
  const from = input.from ?? Date.now();
  const runs = nextRuns(cron, input.timezone, input.count, from);
  if (!runs.length) throw new ScheduleError('This schedule never runs within a year: check that the day of the month exists in the months it names (there is no 30 February).');
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: input.timezone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });
  const notes: string[] = [];
  let prevOff: number | null = null;
  const items = runs.map((at) => {
    const off = offsetAt(at, input.timezone);
    const w = wallTime(at, input.timezone);
    const shifted = !c.hour.any && !wallMatches(c, w);
    if (prevOff != null && off !== prevOff) notes.push(`The clocks change before the run on ${fmt.format(new Date(at))}; the schedule keeps its wall-clock time.`);
    if (shifted) notes.push(`The run on ${fmt.format(new Date(at))} is at the moment the clocks go forward: the time it names does not exist that day.`);
    prevOff = off;
    return { at, iso: new Date(at).toISOString(), local: fmt.format(new Date(at)), offsetMinutes: Math.round(off / MINUTE) };
  });
  return { cron, timezone: input.timezone, description: describeSchedule(cron, input.timezone), runs: items, notes: [...new Set(notes)] };
}

/** For the tick: the next run, or null (the trigger then waits for its next publish) when the zone stopped existing. */
export function nextRunOrNull(expr: string, from: number, tz?: string | null): number | null {
  try {
    return nextRun(expr, from, tz);
  } catch {
    return null;
  }
}
