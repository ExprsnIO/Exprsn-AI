/*
 * Time zones for group events (B-2502). Events are stored as UTC instants with the IANA zone they were planned in;
 * the zone is what turns a wall-clock time ("09:00 in Europe/Berlin") into the instant, and what reminders and
 * notices show. Only the platform's Intl data is used (no zone database is shipped).
 */

const ZONE_NAME = /^(?:UTC|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){1,2})$/;
const WALL = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const ABSOLUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(tz, f);
  }
  return f;
}

/** An IANA zone name the platform knows (`Europe/Berlin`, `America/Argentina/Buenos_Aires`, `UTC`); not an offset. */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length > 64 || !ZONE_NAME.test(tz)) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall-clock time in `tz` at the instant `ms`. */
export function wallTime(ms: number, tz: string): WallTime {
  const parts = Object.fromEntries(formatter(tz).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second) };
}

/** The zone's offset from UTC (ms, east positive) at the instant `ms`. */
export function offsetAt(ms: number, tz: string): number {
  const w = wallTime(ms, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant a wall-clock time in `tz` names. A time that occurs twice (when clocks go back) takes the earlier
 * instant; a time that does not exist (when clocks go forward) moves forward by the gap, as calendar programs do.
 */
export function zonedToUtc(w: WallTime, tz: string): number {
  const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const DAY = 86_400_000;
  const before = offsetAt(guess - DAY, tz);
  const offsets = new Set([before, offsetAt(guess, tz), offsetAt(guess + DAY, tz)]);
  const valid = [...offsets].map((o) => guess - o).filter((t) => wallEquals(wallTime(t, tz), w));
  if (valid.length) return Math.min(...valid);
  // In a gap: the offset in force before it, which lands the same distance past the gap.
  return guess - before;
}

const wallEquals = (a: WallTime, b: WallTime) => a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute && a.second === b.second;

export class TimeInputError extends Error {}

/**
 * Parses an event time: an instant with an offset (`2026-11-03T08:00:00Z`, `…+01:00`), or a wall-clock time
 * (`2026-11-03T09:00`) or date (`2026-11-03`, all-day events) in `tz`. Returns epoch ms.
 */
export function parseEventTime(v: string, tz: string): number {
  if (ABSOLUTE.test(v)) {
    const ms = Date.parse(v);
    if (!Number.isFinite(ms)) throw new TimeInputError(`${v} is not a valid time.`);
    return ms;
  }
  const m = WALL.exec(v);
  if (!m) throw new TimeInputError(`${v} is not an ISO 8601 date or time.`);
  const w: WallTime = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4] ?? 0), minute: Number(m[5] ?? 0), second: Number(m[6] ?? 0) };
  const check = new Date(Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second));
  if (check.getUTCFullYear() !== w.year || check.getUTCMonth() !== w.month - 1 || check.getUTCDate() !== w.day || w.hour > 23 || w.minute > 59 || w.second > 59) throw new TimeInputError(`${v} is not a valid date or time.`);
  return zonedToUtc(w, tz);
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** `2026-11-03T09:00:00` in `tz` (no offset): what the console shows next to the zone name. */
export function localIso(ms: number, tz: string): string {
  const w = wallTime(ms, tz);
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`;
}

/** The calendar date in `tz` as `YYYYMMDD` (all-day events in iCalendar). */
export function localDate(ms: number, tz: string): string {
  const w = wallTime(ms, tz);
  return `${pad(w.year, 4)}${pad(w.month)}${pad(w.day)}`;
}

/** A readable time for notices: `Tue 3 Nov 2026, 09:00 (Europe/Berlin)`. */
export function describeTime(ms: number, tz: string, allDay = false): string {
  const opts: Intl.DateTimeFormatOptions = allDay ? { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' } : { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  return `${new Intl.DateTimeFormat('en-GB', opts).format(new Date(ms))} (${tz})`;
}
