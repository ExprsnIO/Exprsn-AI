import { localDate } from './time.js';

/*
 * iCalendar (RFC 5545) for group events (B-2504). Times are written in UTC (`DTSTART:20261103T080000Z`), which needs
 * no VTIMEZONE (RFC 5545 3.3.5, form 2); all-day events are dates in the event's own zone (`VALUE=DATE`). Text values
 * are escaped (3.3.11: backslash, semicolon, comma, line breaks) and every content line is folded at 75 octets without
 * splitting a UTF-8 sequence (3.1). Lines end in CRLF.
 */

export interface IcsEvent {
  uid: string;
  summary: string;
  description?: string | null;
  location?: string | null;
  url?: string | null;
  start: number;
  end: number;
  timeZone: string;
  allDay: boolean;
  status: 'CONFIRMED' | 'CANCELLED';
  sequence: number;
  created: number;
  updated: number;
  /** PUBLIC or PRIVATE (RFC 5545 3.8.1.3). */
  klass: 'PUBLIC' | 'PRIVATE' | 'CONFIDENTIAL';
  categories?: string[];
}

export interface IcsCalendar {
  name: string;
  description?: string | null;
  /** X-WR-TIMEZONE when every event shares one zone (a display hint only; the times are UTC). */
  timeZone?: string | null;
  events: IcsEvent[];
}

const CRLF = '\r\n';

/** Escapes a TEXT value (RFC 5545 3.3.11); control characters other than line breaks are dropped. */
export function escapeText(v: string): string {
  return (
    v
      // eslint-disable-next-line no-control-regex -- matching control characters is the point
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r\n|\r|\n/g, '\\n')
  );
}

/** Folds one content line at 75 octets (RFC 5545 3.1): CRLF and a space, never inside a UTF-8 sequence. */
export function foldLine(line: string): string {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > limit) {
      out.push(cur);
      cur = '';
      bytes = 0;
      limit = 74; // the leading space of a continuation line counts
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join(`${CRLF} `);
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** `20261103T080000Z`. */
export function utcStamp(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** The day after a `YYYYMMDD` date (DTEND of an all-day event is exclusive). */
function nextDate(yyyymmdd: string): string {
  const d = new Date(Date.UTC(Number(yyyymmdd.slice(0, 4)), Number(yyyymmdd.slice(4, 6)) - 1, Number(yyyymmdd.slice(6, 8)) + 1));
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

function eventLines(e: IcsEvent, stamp: number): string[] {
  const lines = ['BEGIN:VEVENT', `UID:${escapeText(e.uid)}`, `DTSTAMP:${utcStamp(stamp)}`];
  if (e.allDay) {
    const start = localDate(e.start, e.timeZone);
    // The last day the event covers, then the exclusive end after it.
    const lastDay = localDate(Math.max(e.start, e.end - 1), e.timeZone);
    lines.push(`DTSTART;VALUE=DATE:${start}`, `DTEND;VALUE=DATE:${nextDate(lastDay < start ? start : lastDay)}`);
  } else {
    lines.push(`DTSTART:${utcStamp(e.start)}`, `DTEND:${utcStamp(e.end)}`);
  }
  lines.push(`SUMMARY:${escapeText(e.summary)}`);
  if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
  if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
  if (e.url) lines.push(`URL:${e.url.replace(/[\r\n]/g, '')}`);
  if (e.categories?.length) lines.push(`CATEGORIES:${e.categories.map(escapeText).join(',')}`);
  lines.push(`STATUS:${e.status}`, `SEQUENCE:${Math.max(0, Math.floor(e.sequence))}`, `CLASS:${e.klass}`, `CREATED:${utcStamp(e.created)}`, `LAST-MODIFIED:${utcStamp(e.updated)}`, 'TRANSP:OPAQUE', 'END:VEVENT');
  return lines;
}

/** A VCALENDAR with its events, folded, CRLF line ends. */
export function renderCalendar(c: IcsCalendar, now = Date.now()): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Exprsn-AI//Groups and events 1.4//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${escapeText(c.name)}`];
  if (c.description) lines.push(`X-WR-CALDESC:${escapeText(c.description)}`);
  if (c.timeZone) lines.push(`X-WR-TIMEZONE:${escapeText(c.timeZone)}`);
  lines.push('REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H');
  for (const e of c.events) lines.push(...eventLines(e, now));
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join(CRLF) + CRLF;
}
