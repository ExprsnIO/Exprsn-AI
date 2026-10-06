import { renderCalendar, utcStamp, type IcsEvent } from '../groups/ical.js';
import { roleHas, type Ctx } from '../groups/service.js';
import { localDate } from '../groups/time.js';
import { HttpProblem } from '../http/problem.js';
import { IcsError, MAX_OBJECT_BYTES, objectSpan, param, parseObject, prop, propTime, props, unescape, type IcsComponent } from './ics.js';
import { addressesOf, audit, need, primaryAddress, type DavCtx, type EventView, type Node } from './tree.js';
import { DavError } from './xml.js';

/*
 * CalDAV (RFC 4791) over personal calendars and B-25 group events (B-3102).
 *
 * Personal calendar objects are stored as sent (sealed), validated first: one VCALENDAR without METHOD, one kind of
 * component the calendar supports, one UID, unique in the calendar.
 *
 * A group event renders as a VEVENT with the organiser, the attendees who said going or maybe (and, for moderators,
 * those who declined), and the caller with their own answer, or NEEDS-ACTION when they may RSVP. A PUT of it is read
 * for the caller's PARTSTAT, which is written back as their RSVP (B-2502, with its capacity and guest rules); other
 * changes apply only for those whose group role may change events (as through the API) and are ignored for others.
 * The server's version then differs from what the client sent, so no ETag is returned and the client fetches it again.
 */

export const CAL_COMPONENTS = ['VEVENT', 'VTODO', 'VJOURNAL'] as const;
const PARTSTAT: Record<string, 'going' | 'maybe' | 'declined'> = { ACCEPTED: 'going', TENTATIVE: 'maybe', DECLINED: 'declined' };
const TO_PARTSTAT = { going: 'ACCEPTED', maybe: 'TENTATIVE', declined: 'DECLINED' } as const;

const invalid = (msg: string, condition = '{urn:ietf:params:xml:ns:caldav}valid-calendar-data') => new DavError(403, msg, condition);

export const groupCtx = (ctx: DavCtx): Ctx => ({ p: ctx.p, ip: ctx.ip, traceId: ctx.traceId });

/** Parses and checks a calendar object for a personal calendar. */
export function validateCalendarObject(text: string, supported: string[]): { root: IcsComponent; uid: string; component: string } {
  if (Buffer.byteLength(text, 'utf8') > MAX_OBJECT_BYTES) throw new DavError(403, 'The calendar object is too large.', '{urn:ietf:params:xml:ns:caldav}max-resource-size');
  let root: IcsComponent;
  try {
    root = parseObject(text);
  } catch (err) {
    if (err instanceof IcsError) throw invalid(`The body is not valid iCalendar: ${err.message}`);
    throw err;
  }
  if (root.name !== 'VCALENDAR') throw invalid('The body is not a VCALENDAR.');
  if (prop(root, 'METHOD')) throw invalid('A stored calendar object has no METHOD (RFC 4791 4.1).', '{urn:ietf:params:xml:ns:caldav}valid-calendar-object-resource');
  const comps = root.components.filter((c) => c.name !== 'VTIMEZONE');
  if (!comps.length) throw invalid('The calendar object has no component.', '{urn:ietf:params:xml:ns:caldav}valid-calendar-object-resource');
  const kinds = new Set(comps.map((c) => c.name));
  if (kinds.size !== 1) throw invalid('A calendar object holds one kind of component.', '{urn:ietf:params:xml:ns:caldav}valid-calendar-object-resource');
  const component = [...kinds][0]!;
  if (!supported.includes(component)) throw new DavError(403, `This calendar does not take ${component}.`, '{urn:ietf:params:xml:ns:caldav}supported-calendar-component');
  const uids = new Set(comps.map((c) => prop(c, 'UID')?.value.trim() ?? ''));
  if (uids.size !== 1 || uids.has('')) throw invalid('Every component of a calendar object carries the same UID.', '{urn:ietf:params:xml:ns:caldav}valid-calendar-object-resource');
  return { root, uid: [...uids][0]!, component };
}

/** Writes a personal calendar object (new, or replacing `existing`). */
export async function putCalendarObject(ctx: DavCtx, coll: Node, name: string, existing: Node | null, text: string): Promise<{ created: boolean; etag: string }> {
  await need(ctx, 'calendars:write', coll.label);
  const c = coll.coll!;
  const { root, uid, component } = validateCalendarObject(text, (c.components || 'VEVENT,VTODO').split(','));
  const clash = await ctx.s.dav.store.byUid(c, uid);
  if (clash && clash.name !== name) throw new DavError(403, 'Another object in this calendar has the same UID.', '{urn:ietf:params:xml:ns:caldav}no-uid-conflict');
  const span = objectSpan(root, c.time_zone);
  const row = await ctx.s.dav.store.putObject(c, { name, uid, component, startsAt: span.start, endsAt: span.end, body: text.replace(/\r?\n/g, '\r\n') }, existing?.obj ?? null);
  await audit(ctx, existing ? 'dav.object.updated' : 'dav.object.created', { collection: c.id, object: row.id, kind: 'calendar' }, { component, size: row.size }, c.label);
  return { created: !existing, etag: row.etag };
}

// ---------- group events ----------

const host = (ctx: DavCtx) => new URL(ctx.s.cfg.PUBLIC_URL).hostname;

/** The VEVENT of a group event as the caller sees it. */
export async function renderGroupEvent(ctx: DavCtx, n: Node): Promise<string> {
  const s = ctx.s;
  const e = n.event!;
  const a = n.access!;
  const mine = (await s.calendar.get(ctx.p, e.id)).myRsvp;
  const people = await s.calendar.attendees(ctx.p, e.id);
  const ids = [...new Set([e.createdBy, ctx.p.userId, ...people.map((x) => x.userId)])];
  const users = new Map(((await s.db('users').where({ tenant_id: ctx.p.tenantId }).whereIn('id', ids).select('id', 'email', 'display_name')) as { id: string; email: string | null; display_name: string }[]).map((u) => [u.id, u]));
  const person = (id: string, fallback: string) => {
    const u = users.get(id);
    return { address: primaryAddress({ id, email: u?.email ?? null }), name: u?.display_name ?? fallback };
  };
  const attendees: NonNullable<IcsEvent['attendees']> = people.map((x) => ({ ...person(x.userId, x.displayName), partstat: TO_PARTSTAT[x.response] }));
  if (!people.some((x) => x.userId === ctx.p.userId)) {
    if (mine) attendees.push({ ...person(ctx.p.userId, ctx.p.displayName), partstat: TO_PARTSTAT[mine.response] });
    else if (e.state === 'scheduled' && (a.role || a.manager || a.group.visibility === 'public')) attendees.push({ ...person(ctx.p.userId, ctx.p.displayName), partstat: 'NEEDS-ACTION', rsvp: true });
  }
  const ev: IcsEvent = {
    uid: `${e.id}@${host(ctx)}`,
    summary: e.title,
    description: e.description,
    location: e.location,
    url: s.notifications.consoleUrl(`groups?id=${e.groupId}&event=${e.id}`),
    start: Date.parse(e.startsAt),
    end: Date.parse(e.endsAt),
    timeZone: e.timeZone,
    allDay: e.allDay,
    status: e.state === 'cancelled' ? 'CANCELLED' : 'CONFIRMED',
    sequence: e.sequence,
    created: e.createdAt,
    updated: n.modified ?? e.updatedAt,
    klass: e.label === 'public' ? 'PUBLIC' : 'PRIVATE',
    categories: [a.group.name],
    organizer: person(e.createdBy, 'Organiser'),
    attendees
  };
  return renderCalendar({ name: a.group.name, events: [ev], object: true });
}

const norm = (v: string | null | undefined) => (v ?? '').replace(/\r\n?/g, '\n').trim();

/** A PUT of a group event: the caller's RSVP, and for event managers the changes to the event. */
export async function putGroupEvent(ctx: DavCtx, n: Node, text: string): Promise<void> {
  const s = ctx.s;
  const e = n.event!;
  const a = n.access!;
  await need(ctx, 'groups:write', e.label);
  let root: IcsComponent;
  try {
    root = parseObject(text);
  } catch (err) {
    if (err instanceof IcsError) throw invalid(`The body is not valid iCalendar: ${err.message}`);
    throw err;
  }
  const ev = root.components.find((c) => c.name === 'VEVENT' && !prop(c, 'RECURRENCE-ID'));
  if (root.name !== 'VCALENDAR' || !ev) throw invalid('The body has no VEVENT.');
  const uid = prop(ev, 'UID')?.value.trim();
  if (uid && uid !== `${e.id}@${host(ctx)}`) throw invalid('The UID does not match this event.', '{urn:ietf:params:xml:ns:caldav}valid-calendar-object-resource');
  const gctx = groupCtx(ctx);

  // The caller's answer, from their ATTENDEE line.
  const u = await s.users.get(ctx.p.tenantId, ctx.p.userId);
  const mineAddrs = new Set(addressesOf({ id: ctx.p.userId, email: u?.email ?? null }).map((x) => x.toLowerCase()));
  const me = props(ev, 'ATTENDEE').find((x) => mineAddrs.has(x.value.trim().toLowerCase()));
  const answer = me ? PARTSTAT[(param(me, 'PARTSTAT') ?? '').toUpperCase()] : undefined;

  // Changes to the event itself: only for those who may change events (moderators, owners, groups:manage).
  if (roleHas(a.acting, 'events') && e.state === 'scheduled') {
    const status = prop(ev, 'STATUS')?.value.trim().toUpperCase();
    if (status === 'CANCELLED') {
      await s.calendar.cancel(gctx, e.id, null);
      return;
    }
    const start = propTime(prop(ev, 'DTSTART'), root, e.timeZone);
    const endT = propTime(prop(ev, 'DTEND'), root, e.timeZone);
    const patch: Record<string, unknown> = {};
    const summary = prop(ev, 'SUMMARY') ? unescape(prop(ev, 'SUMMARY')!.value) : null;
    if (summary && norm(summary) !== norm(e.title)) patch.title = summary.slice(0, 300);
    const loc = prop(ev, 'LOCATION') ? unescape(prop(ev, 'LOCATION')!.value) : null;
    if (norm(loc) !== norm(e.location)) patch.location = loc ? loc.slice(0, 500) : null;
    const desc = prop(ev, 'DESCRIPTION') ? unescape(prop(ev, 'DESCRIPTION')!.value) : null;
    if (norm(desc) !== norm(e.description)) patch.description = desc ? desc.slice(0, 20_000) : null;
    if (start && (start.ms !== Date.parse(e.startsAt) || (endT && endT.ms !== Date.parse(e.endsAt)) || start.date !== e.allDay)) {
      patch.allDay = start.date;
      const day = (ms: number) => localDate(ms, e.timeZone).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
      patch.start = start.date ? day(start.ms) : new Date(start.ms).toISOString();
      // An all-day DTEND is exclusive; the API takes the last day.
      if (endT) patch.end = start.date ? day(endT.ms - 1) : new Date(endT.ms).toISOString();
      if (start.date) patch.timeZone = e.timeZone;
    }
    if (Object.keys(patch).length) await s.calendar.update(gctx, e.id, patch as Parameters<typeof s.calendar.update>[2]);
  }

  if (answer && e.state === 'scheduled') {
    const current = (await s.calendar.get(ctx.p, e.id)).myRsvp;
    if (current?.response !== answer) {
      try {
        await s.calendar.rsvp(gctx, e.id, { response: answer, guests: answer === 'going' ? (current?.guests ?? 0) : 0 });
      } catch (err) {
        // The API's refusals (full, over, not a member) keep their status; a DAV client shows the error.
        if (err instanceof HttpProblem) throw new DavError(err.status === 409 ? 409 : 403, err.detail ?? err.title);
        throw err;
      }
    }
  }
}

/** DELETE of a group event: cancelling it, for those who may change events. */
export async function deleteGroupEvent(ctx: DavCtx, n: Node): Promise<void> {
  await need(ctx, 'groups:write', n.event!.label);
  if (!roleHas(n.access!.acting, 'events')) throw new DavError(403, 'Only the group’s moderators and owners can cancel its events; decline it instead.', '{DAV:}need-privileges');
  if (n.event!.state !== 'scheduled') return;
  await ctx.s.calendar.cancel(groupCtx(ctx), n.event!.id, null);
}

// ---------- free-busy (RFC 4791 7.10) ----------

export function freeBusy(busy: { start: number; end: number }[], range: { start: number; end: number }): string {
  const clipped = busy
    .map((b) => ({ start: Math.max(b.start, range.start), end: Math.min(b.end, range.end) }))
    .filter((b) => b.end > b.start)
    .sort((x, y) => x.start - y.start);
  const merged: { start: number; end: number }[] = [];
  for (const b of clipped) {
    const last = merged[merged.length - 1];
    if (last && b.start <= last.end) last.end = Math.max(last.end, b.end);
    else merged.push({ ...b });
  }
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Exprsn-AI//CalDAV 1.5//EN', 'BEGIN:VFREEBUSY', `DTSTAMP:${utcStamp(Date.now())}`, `DTSTART:${utcStamp(range.start)}`, `DTEND:${utcStamp(range.end)}`, ...merged.map((b) => `FREEBUSY;FBTYPE=BUSY:${utcStamp(b.start)}/${utcStamp(b.end)}`), 'END:VFREEBUSY', 'END:VCALENDAR'];
  return lines.join('\r\n') + '\r\n';
}

/** Busy periods of a parsed calendar object (events that are not transparent or cancelled). */
export function busyOf(root: IcsComponent, zone: string | null): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const c of root.components) {
    if (c.name !== 'VEVENT') continue;
    if (prop(c, 'TRANSP')?.value.trim().toUpperCase() === 'TRANSPARENT' || prop(c, 'STATUS')?.value.trim().toUpperCase() === 'CANCELLED') continue;
    const s = propTime(prop(c, 'DTSTART'), root, zone);
    if (!s) continue;
    const e = propTime(prop(c, 'DTEND'), root, zone);
    const end = e ? e.ms : s.date ? s.ms + 86_400_000 : s.ms;
    if (end > s.ms) out.push({ start: s.ms, end });
  }
  return out;
}

export const groupEventBusy = (e: EventView): { start: number; end: number } | null => (e.state === 'scheduled' ? { start: Date.parse(e.startsAt), end: Date.parse(e.endsAt) } : null);
