import { attr } from '../federation/xml.js';
import { componentSpan, param, parseDuration, parseUtc, prop, propTime, props, unescape, type IcsComponent, type IcsProp } from './ics.js';
import { DavError, kids, NS, textOf, type XmlElement } from './xml.js';

/*
 * Query filters: CalDAV `calendar-query` (RFC 4791 9.7) and CardDAV `addressbook-query` (RFC 6352 10.5), evaluated on
 * parsed objects. exprsn-platform's CalDAV got these operators wrong (a negated text match matched everything, and
 * is-not-defined was ignored); every operator here has a case in the conformance run (B-3104):
 *
 * - comp-filter: is-not-defined, time-range, nested comp-filters and prop-filters (all must hold; a component filter
 *   holds when at least one such component does);
 * - prop-filter: is-not-defined, time-range (on DATE and DATE-TIME properties), text-match, param-filters; CardDAV
 *   adds `test="anyof|allof"` over its tests;
 * - param-filter: is-not-defined, text-match;
 * - text-match: collations i;octet, i;ascii-casemap and i;unicode-casemap; match types equals, contains (the default),
 *   starts-with and ends-with; negate-condition. An unsupported collation is a 403 with CALDAV/CARDDAV:supported-collation.
 * - time-range on VEVENT, VTODO, VJOURNAL, VFREEBUSY and VALARM by the tables of RFC 4791 9.9; a recurring component
 *   is tested against the span from its first start to its last possible end (inclusive, see docs/dav.md).
 */

export const COLLATIONS = ['i;octet', 'i;ascii-casemap', 'i;unicode-casemap'] as const;

interface TextMatch {
  text: string;
  collation: string;
  matchType: 'equals' | 'contains' | 'starts-with' | 'ends-with';
  negate: boolean;
}

function textMatchOf(el: XmlElement, ns: string, defaultCollation: string): TextMatch {
  const collation = attr(el, 'collation') ?? defaultCollation;
  if (!(COLLATIONS as readonly string[]).includes(collation)) throw new DavError(403, `The collation ${collation} is not supported.`, `{${ns}}supported-collation`);
  const mt = attr(el, 'match-type') ?? 'contains';
  if (!['equals', 'contains', 'starts-with', 'ends-with'].includes(mt)) throw new DavError(400, `Unknown match-type ${mt}.`, `{${ns}}supported-filter`);
  const neg = attr(el, 'negate-condition');
  return { text: textOf(el), collation, matchType: mt as TextMatch['matchType'], negate: neg === 'yes' };
}

function fold(s: string, collation: string): string {
  if (collation === 'i;octet') return s;
  if (collation === 'i;ascii-casemap') return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  // i;unicode-casemap (RFC 5051): compatibility decomposition and case folding.
  return s.normalize('NFKD').toUpperCase().toLowerCase();
}

/** One value against a text-match, with negation applied. */
export function textMatches(value: string, m: TextMatch): boolean {
  const v = fold(value, m.collation);
  const t = fold(m.text, m.collation);
  const hit = m.matchType === 'equals' ? v === t : m.matchType === 'starts-with' ? v.startsWith(t) : m.matchType === 'ends-with' ? v.endsWith(t) : v.includes(t);
  return m.negate ? !hit : hit;
}

export interface TimeRange {
  start: number;
  end: number;
}

function timeRangeOf(el: XmlElement): TimeRange {
  const s = attr(el, 'start');
  const e = attr(el, 'end');
  const start = s ? parseUtc(s) : -8.64e15;
  const end = e ? parseUtc(e) : 8.64e15;
  if (start == null || end == null || (!s && !e)) throw new DavError(400, 'A time-range needs a start or an end in UTC (20261103T080000Z).', '{urn:ietf:params:xml:ns:caldav}valid-filter');
  return { start, end };
}

const DAY = 86_400_000;

/** Does a component overlap a time range (RFC 4791 9.9)? */
export function componentInRange(c: IcsComponent, root: IcsComponent, tr: TimeRange, zone: string | null): boolean {
  const t = (name: string) => propTime(prop(c, name), root, zone);
  if (prop(c, 'RRULE') || prop(c, 'RDATE')) {
    const sp = componentSpan(c, root, zone);
    if (sp.start == null) return false;
    return sp.start < tr.end && (sp.end == null || sp.end > tr.start);
  }
  if (c.name === 'VEVENT') {
    const start = t('DTSTART');
    if (!start) return false;
    const end = t('DTEND');
    const durP = prop(c, 'DURATION');
    const dur = durP ? parseDuration(durP.value) : null;
    if (end) return tr.start < end.ms && tr.end > start.ms;
    if (dur != null && dur > 0) return tr.start < start.ms + dur && tr.end > start.ms;
    if (dur != null) return tr.start <= start.ms && tr.end > start.ms;
    if (start.date) return tr.start < start.ms + DAY && tr.end > start.ms;
    return tr.start <= start.ms && tr.end > start.ms;
  }
  if (c.name === 'VTODO') {
    const start = t('DTSTART');
    const due = t('DUE');
    const durP = prop(c, 'DURATION');
    const dur = durP ? parseDuration(durP.value) : null;
    const completed = t('COMPLETED');
    const created = t('CREATED');
    if (start && dur != null) return tr.start <= start.ms + dur && (tr.end > start.ms || tr.end >= start.ms + dur);
    if (start && due) return (tr.start < due.ms || tr.start <= start.ms) && (tr.end > start.ms || tr.end >= due.ms);
    if (start) return tr.start <= start.ms && tr.end > start.ms;
    if (due) return tr.start < due.ms && tr.end >= due.ms;
    if (completed && created) return (tr.start <= created.ms || tr.start <= completed.ms) && (tr.end >= created.ms || tr.end >= completed.ms);
    if (completed) return tr.start <= completed.ms && tr.end >= completed.ms;
    if (created) return tr.end > created.ms;
    return true;
  }
  if (c.name === 'VJOURNAL') {
    const start = t('DTSTART');
    if (!start) return false;
    if (start.date) return tr.start < start.ms + DAY && tr.end > start.ms;
    return tr.start <= start.ms && tr.end > start.ms;
  }
  if (c.name === 'VFREEBUSY') {
    const start = t('DTSTART');
    const end = t('DTEND');
    if (start && end) return tr.start < end.ms && tr.end > start.ms;
    const periods = props(c, 'FREEBUSY').flatMap((p) => p.value.split(','));
    return periods.some((pv) => {
      const [a, b] = pv.split('/');
      const ps = parseUtc(a);
      const pe = b ? (parseUtc(b) ?? (ps != null && parseDuration(b) != null ? ps + parseDuration(b)! : null)) : null;
      return ps != null && pe != null && tr.start < pe && tr.end > ps;
    });
  }
  return false;
}

/** VALARM: the trigger time, absolute or relative to its parent's start (or end), then a point test. */
function alarmInRange(alarm: IcsComponent, parent: IcsComponent, root: IcsComponent, tr: TimeRange, zone: string | null): boolean {
  const trig = prop(alarm, 'TRIGGER');
  if (!trig) return false;
  let at: number | null;
  if (param(trig, 'VALUE')?.toUpperCase() === 'DATE-TIME') at = parseUtc(trig.value);
  else {
    const off = parseDuration(trig.value);
    if (off == null) return false;
    const related = param(trig, 'RELATED')?.toUpperCase() === 'END';
    const sp = componentSpan(parent, root, zone);
    const base = related ? sp.end : sp.start;
    if (base == null) return false;
    at = base + off;
  }
  return at != null && tr.start <= at && tr.end > at;
}

function paramFilterHolds(p: IcsProp, f: XmlElement, ns: string, defaultCollation: string): boolean {
  const name = (attr(f, 'name') ?? '').toUpperCase();
  const values = p.params[name];
  if (kids(f, ns, 'is-not-defined').length) return values === undefined;
  if (values === undefined) return false;
  const tm = kids(f, ns, 'text-match')[0];
  if (!tm) return true;
  const m = textMatchOf(tm, ns, defaultCollation);
  return m.negate ? values.every((v) => textMatches(v, m)) : values.some((v) => textMatches(v, m));
}

// ---------- CalDAV ----------

function calPropFilterHolds(c: IcsComponent, root: IcsComponent, f: XmlElement, zone: string | null): boolean {
  const name = (attr(f, 'name') ?? '').toUpperCase();
  const found = props(c, name);
  if (kids(f, NS.cal, 'is-not-defined').length) return found.length === 0;
  if (!found.length) return false;
  const tr = kids(f, NS.cal, 'time-range')[0];
  const tm = kids(f, NS.cal, 'text-match')[0];
  const pfs = kids(f, NS.cal, 'param-filter');
  const match = tm ? textMatchOf(tm, NS.cal, 'i;ascii-casemap') : null;
  const range = tr ? timeRangeOf(tr) : null;
  return found.some((p) => {
    if (range) {
      const at = propTime(p, root, zone);
      if (!at || !(range.start <= at.ms && range.end > at.ms)) return false;
    }
    if (match && !textMatches(unescape(p.value), match)) return false;
    return pfs.every((pf) => paramFilterHolds(p, pf, NS.cal, 'i;ascii-casemap'));
  });
}

function compFilterHolds(candidates: IcsComponent[], parent: IcsComponent | null, root: IcsComponent, f: XmlElement, zone: string | null): boolean {
  const name = (attr(f, 'name') ?? '').toUpperCase();
  const matching = candidates.filter((c) => c.name === name);
  if (kids(f, NS.cal, 'is-not-defined').length) return matching.length === 0;
  if (!matching.length) return false;
  const tr = kids(f, NS.cal, 'time-range')[0];
  const range = tr ? timeRangeOf(tr) : null;
  return matching.some((c) => {
    if (range) {
      if (c.name === 'VALARM') {
        if (!parent || !alarmInRange(c, parent, root, range, zone)) return false;
      } else if (c.name !== 'VCALENDAR' && !componentInRange(c, root, range, zone)) return false;
    }
    for (const pf of kids(f, NS.cal, 'prop-filter')) if (!calPropFilterHolds(c, root, pf, zone)) return false;
    for (const cf of kids(f, NS.cal, 'comp-filter')) if (!compFilterHolds(c.components, c, root, cf, zone)) return false;
    return true;
  });
}

/** Does a calendar object match a CALDAV:filter? */
export function calendarFilterMatches(root: IcsComponent, filter: XmlElement, zone: string | null): boolean {
  const top = kids(filter, NS.cal, 'comp-filter');
  if (top.length !== 1 || (attr(top[0], 'name') ?? '').toUpperCase() !== 'VCALENDAR') throw new DavError(403, 'A calendar-query filter has one comp-filter, for VCALENDAR.', '{urn:ietf:params:xml:ns:caldav}valid-filter');
  return compFilterHolds([root], null, root, top[0]!, zone);
}

/** The time range a filter asks for at the component level, if any (for the database prefilter). */
export function filterRange(filter: XmlElement): TimeRange | null {
  const cal = kids(filter, NS.cal, 'comp-filter')[0];
  for (const comp of kids(cal, NS.cal, 'comp-filter')) {
    if (kids(comp, NS.cal, 'is-not-defined').length) continue;
    const tr = kids(comp, NS.cal, 'time-range')[0];
    if (tr) return timeRangeOf(tr);
  }
  return null;
}

/** The component names a filter requires (`VEVENT`, `VTODO`), when it names exactly one. */
export function filterComponent(filter: XmlElement): string | null {
  const cal = kids(filter, NS.cal, 'comp-filter')[0];
  const comps = kids(cal, NS.cal, 'comp-filter').filter((c) => !kids(c, NS.cal, 'is-not-defined').length);
  return comps.length === 1 ? (attr(comps[0], 'name') ?? '').toUpperCase() : null;
}

// ---------- CardDAV ----------

function cardPropFilterHolds(card: IcsComponent, f: XmlElement): boolean {
  const name = (attr(f, 'name') ?? '').toUpperCase();
  const found = props(card, name);
  if (kids(f, NS.card, 'is-not-defined').length) return found.length === 0;
  const tests = [...kids(f, NS.card, 'text-match'), ...kids(f, NS.card, 'param-filter')];
  const allof = attr(f, 'test') === 'allof';
  if (!found.length) return false;
  if (!tests.length) return true;
  const results = tests.map((t) => {
    if (t.local === 'text-match') {
      const m = textMatchOf(t, NS.card, 'i;unicode-casemap');
      return found.some((p) => textMatches(unescape(p.value), m));
    }
    return found.some((p) => paramFilterHolds(p, t, NS.card, 'i;unicode-casemap'));
  });
  return allof ? results.every(Boolean) : results.some(Boolean);
}

/** Does a vCard match a CARDDAV:filter (`test` anyof by default)? */
export function cardFilterMatches(card: IcsComponent, filter: XmlElement): boolean {
  const pfs = kids(filter, NS.card, 'prop-filter');
  if (!pfs.length) return true;
  const allof = attr(filter, 'test') === 'allof';
  return allof ? pfs.every((f) => cardPropFilterHolds(card, f)) : pfs.some((f) => cardPropFilterHolds(card, f));
}

/** Validates a filter's operators up front, so an unsupported collation fails the whole REPORT (not per object). */
export function checkFilter(filter: XmlElement, ns: string): void {
  const walk = (e: XmlElement) => {
    for (const c of kids(e)) {
      if (c.ns === ns && c.local === 'text-match') textMatchOf(c, ns, ns === NS.cal ? 'i;ascii-casemap' : 'i;unicode-casemap');
      if (c.ns === ns && c.local === 'time-range') timeRangeOf(c);
      walk(c);
    }
  };
  walk(filter);
}
