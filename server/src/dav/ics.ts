import { isTimeZone, zonedToUtc } from '../groups/time.js';
import { escapeText, foldLine } from '../groups/ical.js';

/*
 * Reading iCalendar (RFC 5545) and vCard (RFC 6350, and 3.0 from RFC 2426) objects that DAV clients PUT: content
 * lines are unfolded, split into a name, parameters and a value, and nested by BEGIN/END into components. Nothing is
 * evaluated: no includes, no URLs fetched. Times are resolved to UTC instants: UTC (`Z`), a TZID that is an IANA
 * zone, a TZID defined by the object's own VTIMEZONE (its first STANDARD offset, an approximation documented in
 * docs/dav.md), or floating (read in the collection's zone, else UTC). The writer for what the server renders is
 * `groups/ical.ts` (B-2504).
 */

export class IcsError extends Error {}

export interface IcsProp {
  /** Upper-case property name, without a vCard group (`EMAIL`). */
  name: string;
  /** The vCard group (`item1` in `item1.EMAIL`), lower-case, or null. */
  group: string | null;
  /** Upper-case parameter names to their values (quotes removed, comma lists split). */
  params: Record<string, string[]>;
  /** The raw value, still escaped. */
  value: string;
}

export interface IcsComponent {
  name: string;
  props: IcsProp[];
  components: IcsComponent[];
}

export const MAX_OBJECT_BYTES = 1024 * 1024;
const NAME = /^[A-Za-z0-9-]+$/;

/** Splits a value list at unescaped commas (or another separator). */
function splitUnquoted(v: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (const ch of v) {
    if (ch === '"') q = !q;
    else if (ch === sep && !q) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function parseLine(line: string): IcsProp {
  // The name and parameters end at the first ':' outside a quoted parameter value.
  let i = 0;
  let q = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === ':' && !q) break;
  }
  if (i >= line.length) throw new IcsError(`A content line without a value: ${line.slice(0, 40)}`);
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const parts = splitUnquoted(head, ';');
  let name = parts.shift()!;
  let group: string | null = null;
  const dot = name.lastIndexOf('.');
  if (dot > 0) {
    group = name.slice(0, dot).toLowerCase();
    name = name.slice(dot + 1);
  }
  if (!NAME.test(name)) throw new IcsError(`Invalid property name ${name.slice(0, 40)}.`);
  const params: Record<string, string[]> = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    // vCard 2.1-style bare parameters (`TEL;CELL:`) count as TYPE values.
    const k = (eq < 0 ? 'TYPE' : p.slice(0, eq)).toUpperCase();
    const raw = eq < 0 ? p : p.slice(eq + 1);
    if (!NAME.test(k)) throw new IcsError(`Invalid parameter name ${k.slice(0, 40)}.`);
    const vals = splitUnquoted(raw, ',').map((v) => (v.startsWith('"') && v.endsWith('"') && v.length >= 2 ? v.slice(1, -1) : v));
    params[k] = [...(params[k] ?? []), ...vals];
  }
  return { name: name.toUpperCase(), group, params, value };
}

/** Parses one object (VCALENDAR or VCARD) and returns its root component. */
export function parseObject(text: string, maxBytes = MAX_OBJECT_BYTES): IcsComponent {
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new IcsError('The object is too large.');
  const lines = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n|\r/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n')
    .filter((l) => l.trim().length);
  const stack: IcsComponent[] = [];
  let root: IcsComponent | null = null;
  let count = 0;
  for (const line of lines) {
    if (++count > 100_000) throw new IcsError('The object has too many lines.');
    const p = parseLine(line);
    if (p.name === 'BEGIN') {
      const c: IcsComponent = { name: p.value.trim().toUpperCase(), props: [], components: [] };
      if (!NAME.test(c.name)) throw new IcsError('Invalid component name.');
      const top = stack[stack.length - 1];
      if (top) top.components.push(c);
      else if (root) throw new IcsError('More than one object in the body.');
      else root = c;
      stack.push(c);
      if (stack.length > 16) throw new IcsError('Components are nested too deeply.');
    } else if (p.name === 'END') {
      const top = stack.pop();
      if (!top || top.name !== p.value.trim().toUpperCase()) throw new IcsError(`Mismatched END:${p.value.slice(0, 40)}.`);
    } else {
      const top = stack[stack.length - 1];
      if (!top) throw new IcsError('A property outside any component.');
      top.props.push(p);
    }
  }
  if (stack.length) throw new IcsError(`Unclosed component ${stack[stack.length - 1]!.name}.`);
  if (!root) throw new IcsError('No object in the body.');
  return root;
}

export const prop = (c: IcsComponent, name: string): IcsProp | undefined => c.props.find((p) => p.name === name);
export const props = (c: IcsComponent, name: string): IcsProp[] => c.props.filter((p) => p.name === name);
export const param = (p: IcsProp, name: string): string | undefined => p.params[name]?.[0];

/** Unescapes a TEXT value (RFC 5545 3.3.11, RFC 6350 3.4). */
export const unescape = (v: string): string => v.replace(/\\([\\;,nN])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c));

// ---------- serialising (what we store and send back is what was parsed, re-folded) ----------

function paramValue(v: string): string {
  return /[;:,]/.test(v) ? `"${v.replace(/"/g, '')}"` : v;
}

export function serialiseProp(p: IcsProp): string {
  const head = (p.group ? `${p.group}.` : '') + p.name + Object.entries(p.params).map(([k, vs]) => `;${k}=${vs.map(paramValue).join(',')}`).join('');
  return foldLine(`${head}:${p.value}`);
}

export function serialise(c: IcsComponent): string {
  const out = [`BEGIN:${c.name}`, ...c.props.map(serialiseProp), ...c.components.map((x) => serialise(x).replace(/\r\n$/, '')), `END:${c.name}`];
  return out.join('\r\n') + '\r\n';
}

export { escapeText };

// ---------- times ----------

export interface IcsTime {
  ms: number;
  /** A DATE value (all-day). */
  date: boolean;
}

const DATE_RE = /^(\d{4})(\d{2})(\d{2})$/;
const DATETIME_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/;

/** The offset (ms) of a VTIMEZONE defined in the object: its first STANDARD (else DAYLIGHT) TZOFFSETTO. */
function vtimezoneOffset(root: IcsComponent | null, tzid: string): number | null {
  if (!root) return null;
  const tz = root.components.find((c) => c.name === 'VTIMEZONE' && prop(c, 'TZID')?.value === tzid);
  const sub = tz?.components.find((c) => c.name === 'STANDARD') ?? tz?.components.find((c) => c.name === 'DAYLIGHT');
  const off = sub ? prop(sub, 'TZOFFSETTO')?.value : undefined;
  const m = off ? /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(off) : null;
  if (!m) return null;
  return (m[1] === '-' ? -1 : 1) * ((Number(m[2]) * 60 + Number(m[3])) * 60 + Number(m[4] ?? 0)) * 1000;
}

/** Parses a DATE or DATE-TIME value in its context; null for anything else. */
export function parseTime(value: string, o: { tzid?: string | undefined; root?: IcsComponent | null; floatingZone?: string | null } = {}): IcsTime | null {
  const v = value.trim();
  const d = DATE_RE.exec(v);
  if (d) {
    const w = { year: Number(d[1]), month: Number(d[2]), day: Number(d[3]), hour: 0, minute: 0, second: 0 };
    const zone = o.floatingZone && isTimeZone(o.floatingZone) ? o.floatingZone : 'UTC';
    return { ms: zone === 'UTC' ? Date.UTC(w.year, w.month - 1, w.day) : zonedToUtc(w, zone), date: true };
  }
  const m = DATETIME_RE.exec(v);
  if (!m) return null;
  const w = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6]) };
  if (w.month < 1 || w.month > 12 || w.day < 1 || w.day > 31 || w.hour > 23 || w.minute > 59 || w.second > 60) return null;
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, Math.min(w.second, 59));
  if (m[7] === 'Z') return { ms: asUtc, date: false };
  if (o.tzid) {
    const id = o.tzid.replace(/^\//, '');
    if (isTimeZone(id)) return { ms: zonedToUtc(w, id), date: false };
    const off = vtimezoneOffset(o.root ?? null, o.tzid);
    if (off != null) return { ms: asUtc - off, date: false };
  }
  if (o.floatingZone && isTimeZone(o.floatingZone)) return { ms: zonedToUtc(w, o.floatingZone), date: false };
  return { ms: asUtc, date: false };
}

/** A property's time in its component's context. */
export function propTime(p: IcsProp | undefined, root: IcsComponent | null, floatingZone: string | null): IcsTime | null {
  if (!p) return null;
  return parseTime(p.value, { tzid: param(p, 'TZID'), root, floatingZone });
}

/** An RFC 5545 DURATION in ms (`P1D`, `-PT15M`, `P2W`), or null. */
export function parseDuration(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m || v.trim() === 'P' || /T$/.test(v.trim())) return null;
  const ms = (((Number(m[2] ?? 0) * 7 + Number(m[3] ?? 0)) * 24 + Number(m[4] ?? 0)) * 60 + Number(m[5] ?? 0)) * 60_000 + Number(m[6] ?? 0) * 1000;
  return m[1] === '-' ? -ms : ms;
}

const DAY = 86_400_000;

/**
 * The span a VEVENT, VTODO or VJOURNAL covers for indexing and time-range tests: [start, end) in UTC ms, end null
 * when it never ends (a recurrence without COUNT or UNTIL). A recurring component spans from its first start to the
 * end of its last possible occurrence, so a time-range test on it is inclusive rather than exact (docs/dav.md).
 */
export function componentSpan(c: IcsComponent, root: IcsComponent | null, floatingZone: string | null): { start: number | null; end: number | null; instant: boolean } {
  const start = propTime(prop(c, 'DTSTART'), root, floatingZone);
  let s: number | null = start?.ms ?? null;
  let e: number | null = null;
  let instant = false;
  if (c.name === 'VTODO') {
    // For indexing only: the earliest and latest of its times (the exact VTODO rules are in filters.ts).
    const due = propTime(prop(c, 'DUE'), root, floatingZone);
    const dur = prop(c, 'DURATION') ? parseDuration(prop(c, 'DURATION')!.value) : null;
    const completed = propTime(prop(c, 'COMPLETED'), root, floatingZone);
    const created = propTime(prop(c, 'CREATED'), root, floatingZone);
    const times = [start?.ms, due?.ms, completed?.ms, created?.ms, start && dur != null ? start.ms + dur : undefined].filter((x): x is number => typeof x === 'number');
    s = times.length ? Math.min(...times) : null;
    // Only CREATED: it matches every range after it, so the span stays open.
    e = !start && !due && !completed && created ? null : times.length ? Math.max(...times) : null;
  } else {
    const end = propTime(prop(c, 'DTEND'), root, floatingZone);
    const dur = prop(c, 'DURATION') ? parseDuration(prop(c, 'DURATION')!.value) : null;
    if (start && end) e = end.ms;
    else if (start && dur != null) e = start.ms + Math.max(0, dur);
    else if (start?.date) e = start.ms + DAY;
    else if (start) {
      e = start.ms;
      instant = true;
    }
  }
  const length = s != null && e != null ? e - s : 0;
  const rrule = prop(c, 'RRULE');
  if (rrule && s != null) {
    const rule = Object.fromEntries(rrule.value.split(';').map((kv) => kv.split('=') as [string, string]).map(([k, v]) => [k?.toUpperCase(), v]));
    const until = rule.UNTIL ? parseTime(rule.UNTIL, { floatingZone }) : null;
    const count = rule.COUNT ? Number(rule.COUNT) : null;
    const interval = Math.max(1, Number(rule.INTERVAL ?? 1) || 1);
    const per: Record<string, number> = { SECONDLY: 1000, MINUTELY: 60_000, HOURLY: 3_600_000, DAILY: DAY, WEEKLY: 7 * DAY, MONTHLY: 31 * DAY, YEARLY: 366 * DAY };
    if (until) e = until.ms + length + (until.date ? DAY : 0);
    else if (count && per[String(rule.FREQ ?? '').toUpperCase()]) e = s + count * interval * per[String(rule.FREQ).toUpperCase()]! + length;
    else e = null;
    instant = false;
  }
  for (const rd of props(c, 'RDATE'))
    for (const v of rd.value.split(',')) {
      const t = parseTime(v.split('/')[0]!, { tzid: param(rd, 'TZID'), root, floatingZone });
      if (t && s != null && e != null) e = Math.max(e, t.ms + (t.date && !length ? DAY : length));
    }
  return { start: s, end: e, instant };
}

/** The span of a whole calendar object: the union of its components' spans. */
export function objectSpan(root: IcsComponent, floatingZone: string | null): { start: number | null; end: number | null } {
  let start: number | null = null;
  let end: number | null = null;
  let open = false;
  for (const c of root.components) {
    if (!['VEVENT', 'VTODO', 'VJOURNAL'].includes(c.name)) continue;
    const sp = componentSpan(c, root, floatingZone);
    if (sp.start != null) start = start == null ? sp.start : Math.min(start, sp.start);
    if (sp.end == null && sp.start != null) open = true;
    else if (sp.end != null) end = end == null ? sp.end : Math.max(end, sp.end);
  }
  return { start, end: open ? null : end };
}

/** `20261103T080000Z` to ms, for time-range attributes in REPORT bodies (which must be UTC). */
export function parseUtc(v: string | undefined): number | null {
  if (!v) return null;
  const m = DATETIME_RE.exec(v.trim());
  if (!m || m[7] !== 'Z') return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}
