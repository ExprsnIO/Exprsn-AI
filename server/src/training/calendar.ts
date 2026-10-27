/*
 * Time arithmetic for training: five-field cron expressions for recurring jobs, and training windows (always, daily
 * or weekly spans). Everything is UTC.
 */

const MINUTE = 60_000;
const DAY_MIN = 1440;
export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface CronField {
  any: boolean;
  values: Set<number>;
}

export interface Cron {
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
}

function field(src: string, min: number, max: number, name: string): CronField {
  const values = new Set<number>();
  for (const part of src.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`The ${name} field "${src}" is not valid cron.`);
    const step = m[4] ? Number(m[4]) : 1;
    const lo = m[1] === '*' ? min : Number(m[2]);
    const hi = m[1] === '*' ? max : m[3] ? Number(m[3]) : m[4] ? max : lo;
    if (step < 1 || lo < min || hi > max || lo > hi) throw new Error(`The ${name} field "${src}" is out of range (${min}–${max}).`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { any: src === '*', values };
}

/** Parses `m h dom mon dow` (numbers, `*`, ranges, lists and steps; day 7 is Sunday). Throws with a readable reason. */
export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('A cron expression has five fields: minute, hour, day of month, month, day of week.');
  const dow = field(parts[4]!, 0, 7, 'day-of-week');
  if (dow.values.has(7)) dow.values.add(0);
  return { minute: field(parts[0]!, 0, 59, 'minute'), hour: field(parts[1]!, 0, 23, 'hour'), dom: field(parts[2]!, 1, 31, 'day-of-month'), month: field(parts[3]!, 1, 12, 'month'), dow };
}

function dayMatches(c: Cron, d: Date): boolean {
  const dom = c.dom.values.has(d.getUTCDate());
  const dow = c.dow.values.has(d.getUTCDay());
  // Standard cron: when both day fields are restricted, either may match.
  if (!c.dom.any && !c.dow.any) return dom || dow;
  return dom && dow;
}

/** The first time strictly after `from` that the expression matches, or null within a year and a day. */
export function nextCron(expr: string | Cron, from: number): number | null {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  let t = Math.floor(from / MINUTE) * MINUTE + MINUTE;
  const limit = from + 367 * DAY_MIN * MINUTE;
  while (t <= limit) {
    const d = new Date(t);
    if (!c.month.values.has(d.getUTCMonth() + 1) || !dayMatches(c, d)) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
      continue;
    }
    if (!c.hour.values.has(d.getUTCHours())) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1);
      continue;
    }
    if (c.minute.values.has(d.getUTCMinutes())) return t;
    t += MINUTE;
  }
  return null;
}

/** A short reading of common expressions ("Thu 22:00", "daily 22:00"); the expression itself otherwise. */
export function describeCron(expr: string): string {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-7])$/.exec(expr.trim());
  if (!m) return expr;
  const at = `${m[2]!.padStart(2, '0')}:${m[1]!.padStart(2, '0')}`;
  return m[3] === '*' ? `daily ${at}` : `${DAYS[Number(m[3]) % 7]} ${at}`;
}

// ---------- windows ----------

export interface WindowSpec {
  kind: 'always' | 'daily' | 'weekly';
  start_day: number | null;
  start_time: string | null;
  end_day: number | null;
  end_time: string | null;
  reload_minutes: number;
}

const toMin = (hhmm: string | null): number => {
  const [h, m] = (hhmm ?? '00:00').split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/**
 * Whether a window is open at `now`, and when it closes (ms) and next opens. `closing` is true in the last
 * `reload_minutes` before the close: jobs checkpoint and the lent pool's pinned models are reloaded then.
 */
export function windowAt(w: WindowSpec, now: number): { open: boolean; closing: boolean; closesAt: number | null; opensAt: number | null } {
  if (w.kind === 'always') return { open: true, closing: false, closesAt: null, opensAt: null };
  const d = new Date(now);
  const period = w.kind === 'daily' ? DAY_MIN : 7 * DAY_MIN;
  const startOfPeriod = w.kind === 'daily' ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - d.getUTCDay());
  const pos = Math.floor((now - startOfPeriod) / MINUTE); // minutes into the day or week
  const s = (w.kind === 'weekly' ? (w.start_day ?? 0) * DAY_MIN : 0) + toMin(w.start_time);
  let e = (w.kind === 'weekly' ? (w.end_day ?? 0) * DAY_MIN : 0) + toMin(w.end_time);
  if (e <= s) e += period;
  // The span may have started in the previous period.
  let start = s;
  if (pos < s && pos + period < e) start = s - period;
  const end = start + (e - s);
  const open = pos >= start && pos < end;
  const closesAt = open ? startOfPeriod + end * MINUTE : null;
  const opensAt = open ? null : startOfPeriod + (pos < start ? start : start + period) * MINUTE;
  const closing = open && closesAt !== null && closesAt - now <= w.reload_minutes * MINUTE;
  return { open, closing, closesAt, opensAt };
}

export function describeWindow(w: WindowSpec): string {
  if (w.kind === 'always') return 'always';
  if (w.kind === 'daily') return `daily ${w.start_time} to ${w.end_time}`;
  return `${DAYS[w.start_day ?? 0]} ${w.start_time} to ${DAYS[w.end_day ?? 0]} ${w.end_time}`;
}

/** HH:MM of the reload before the close ("05:40" for a 06:00 close and 20 minutes). */
export function reloadTime(w: WindowSpec): string | null {
  if (w.kind === 'always' || !w.end_time) return null;
  const m = (toMin(w.end_time) - w.reload_minutes + DAY_MIN) % DAY_MIN;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
