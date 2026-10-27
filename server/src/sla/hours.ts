import { z } from 'zod';

/*
 * Sprint 46 (B-134): business hours. A weekly schedule of opening windows in a time zone, with holiday dates on which
 * nothing is open. SLA targets count only open time: `addBusiness` finds the moment a target falls due, and
 * `businessMs` measures open time between two moments. No schedule (null) means every hour counts (24/7).
 *
 * Wall times are turned into instants per day through `Intl` for the zone, so daylight-saving changes move the
 * windows with the clock. A window may end at 24:00. The search stops after `MAX_DAYS` days without enough open time
 * (a schedule with no windows), answering null.
 */

export const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Day = (typeof DAYS)[number];

const hhmm = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'a time such as 09:00 (24:00 ends the day)');
const window = z.tuple([hhmm, hhmm]).refine(([a, b]) => minutesOf(a) < minutesOf(b), 'a window opens before it closes');
const isZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const businessHoursSchema = z
  .object({
    timeZone: z.string().min(1).max(64).refine(isZone, 'an IANA time zone such as Europe/London'),
    week: z.object(Object.fromEntries(DAYS.map((d) => [d, z.array(window).max(4).optional()])) as Record<Day, z.ZodOptional<z.ZodArray<typeof window>>>).strict(),
    holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date such as 2026-12-25')).max(366).default([])
  })
  .strict();
export type BusinessHours = z.infer<typeof businessHoursSchema>;

const MAX_DAYS = 400;
const DAY_MS = 86_400_000;

function minutesOf(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h! * 60 + m!;
}

const formats = new Map<string, Intl.DateTimeFormat>();
function format(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formats.set(tz, f);
  }
  return f;
}

/** The wall-clock date and time of an instant in a zone. */
export function wallTime(t: number, tz: string): { y: number; m: number; d: number; h: number; min: number; s: number } {
  const parts = Object.fromEntries(format(tz).formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), h: Number(parts.hour) % 24, min: Number(parts.minute), s: Number(parts.second) };
}

/** The instant a wall-clock time in a zone names (the earlier one in a repeated hour, the later in a skipped one). */
export function zoned(y: number, m: number, d: number, minutes: number, tz: string): number {
  const naive = Date.UTC(y, m - 1, d, 0, minutes);
  let guess = naive;
  for (let i = 0; i < 3; i++) {
    const w = wallTime(guess, tz);
    const offset = Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s) - guess;
    const next = naive - offset;
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

const iso = (y: number, m: number, d: number) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** Opening windows (instants) on the local days from the one holding `from`, in order. */
function* windows(from: number, h: BusinessHours): Generator<[number, number]> {
  const start = wallTime(from, h.timeZone);
  const holidays = new Set(h.holidays);
  // Calendar arithmetic on the local date, done in UTC so no zone shifts the day.
  let day = Date.UTC(start.y, start.m - 1, start.d) - DAY_MS;
  for (let i = 0; i < MAX_DAYS; i++, day += DAY_MS) {
    const dt = new Date(day);
    const y = dt.getUTCFullYear();
    const m = dt.getUTCMonth() + 1;
    const d = dt.getUTCDate();
    if (holidays.has(iso(y, m, d))) continue;
    for (const [a, b] of h.week[DAYS[dt.getUTCDay()]!] ?? []) {
      const open = zoned(y, m, d, minutesOf(a), h.timeZone);
      const close = zoned(y, m, d, minutesOf(b), h.timeZone);
      if (close > from && close > open) yield [open, close];
    }
  }
}

/** Open time between two instants. */
export function businessMs(a: number, b: number, h: BusinessHours | null): number {
  if (b <= a) return 0;
  if (!h) return b - a;
  let total = 0;
  for (const [open, close] of windows(a, h)) {
    if (open >= b) break;
    total += Math.max(0, Math.min(close, b) - Math.max(open, a));
  }
  return total;
}

/** The instant `ms` of open time after `a`, or null when the schedule has no open time within MAX_DAYS. */
export function addBusiness(a: number, ms: number, h: BusinessHours | null): number | null {
  if (!h) return a + ms;
  let left = ms;
  for (const [open, close] of windows(a, h)) {
    const s = Math.max(open, a);
    if (s >= close) continue;
    if (left <= close - s) return s + left;
    left -= close - s;
  }
  return null;
}
