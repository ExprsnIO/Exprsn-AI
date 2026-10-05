import { hkdfSync, createHmac } from 'node:crypto';
import { ulid } from 'ulid';
import { actorFrom } from '../audit/chain.js';
import { clears, isLabel, labelRank, type Label } from '../authz/labels.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { safeEqual } from '../crypto/index.js';
import { json } from '../db/knex.js';
import { loadPrincipal } from '../http/middleware.js';
import { conflict, HttpProblem, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import { renderCalendar, type IcsEvent } from './ical.js';
import { roleHas, type Access, type Ctx, type GroupRow } from './service.js';
import { describeTime, isTimeZone, localIso, parseEventTime, TimeInputError } from './time.js';

/*
 * Group events (B-2502), reminders (B-2503) and signed iCalendar feeds (B-2504).
 *
 * - Events belong to a group and are read by whoever reads the group; moderators and owners create, change and cancel
 *   them and check people in. Times are stored in UTC with the IANA zone they were planned in.
 * - RSVPs: going, maybe or declined, with up to `max_guests` guests; `capacity` counts people (attendees and guests).
 *   Cancelling notifies every attendee (going or maybe), in the console and by email.
 * - Reminders: one row and one queue job per offset, run at `fire_at` (the job's `run_at`). The queue claims a job with
 *   a conditional update, so one instance runs it, and the reminder row moves scheduled → sending → sent with a
 *   compare-and-set of its own, so a retried or duplicated job never sends twice. Changing the time reschedules.
 * - Feeds: `/calendar/feeds/<id>/<signature>.ics`, outside the authenticated API. The signature is an HMAC over the
 *   feed's id, tenant, owner and target with a key derived from SESSION_SECRET (HKDF, its own info string); a feed is
 *   rendered as its owner now (workspace, group and clearance checks apply at every fetch) and can be revoked.
 *   Events above CALENDAR_FEED_MAX_LABEL appear as busy time without their details, because calendar clients copy
 *   feeds to other servers.
 */

export const REMINDER_JOB = 'calendar.reminder';
export const FEED_KINDS = ['event', 'group', 'user'] as const;
export type FeedKind = (typeof FEED_KINDS)[number];
export const RSVP_RESPONSES = ['going', 'maybe', 'declined'] as const;
export type RsvpResponse = (typeof RSVP_RESPONSES)[number];

export interface EventRow {
  id: string;
  tenant_id: string;
  group_id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  location: string | null;
  starts_at: number;
  ends_at: number;
  time_zone: string;
  all_day: boolean;
  capacity: number | null;
  max_guests: number;
  reminders: number[];
  label: Label;
  state: 'scheduled' | 'cancelled' | 'hidden';
  sequence: number;
  cancel_reason: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

interface RsvpRow {
  event_id: string;
  tenant_id: string;
  user_id: string;
  response: RsvpResponse;
  guests: number;
  checked_in_at: number | null;
  checked_in_by: string | null;
  created_at: number;
  updated_at: number;
}

interface ReminderRow {
  id: string;
  tenant_id: string;
  event_id: string;
  minutes_before: number;
  fire_at: number;
  state: 'scheduled' | 'sending' | 'sent' | 'cancelled' | 'skipped';
  job_id: string | null;
  recipients: number | null;
  sent_at: number | null;
  created_at: number;
}

export interface FeedRow {
  id: string;
  tenant_id: string;
  user_id: string;
  kind: FeedKind;
  target_id: string | null;
  name: string | null;
  created_at: number;
  revoked_at: number | null;
  revoked_by: string | null;
  last_used_at: number | null;
}

export interface EventInput {
  title: string;
  description?: string | null | undefined;
  location?: string | null | undefined;
  start: string;
  end?: string | undefined;
  durationMinutes?: number | undefined;
  timeZone: string;
  allDay?: boolean | undefined;
  capacity?: number | null | undefined;
  maxGuests?: number | undefined;
  reminders?: number[] | undefined;
}

const num = (v: unknown) => Number(v);
const eventFrom = (r: Record<string, unknown>): EventRow => ({
  ...(r as unknown as EventRow),
  starts_at: num(r.starts_at),
  ends_at: num(r.ends_at),
  all_day: !!r.all_day,
  capacity: r.capacity == null ? null : num(r.capacity),
  max_guests: num(r.max_guests ?? 0),
  reminders: json<number[]>(r.reminders, []),
  label: isLabel(r.label) ? r.label : 'internal',
  sequence: num(r.sequence ?? 0),
  created_at: num(r.created_at),
  updated_at: num(r.updated_at)
});
const rsvpFrom = (r: Record<string, unknown>): RsvpRow => ({ ...(r as unknown as RsvpRow), guests: num(r.guests ?? 0), checked_in_at: r.checked_in_at == null ? null : num(r.checked_in_at), created_at: num(r.created_at), updated_at: num(r.updated_at) });
const reminderFrom = (r: Record<string, unknown>): ReminderRow => ({ ...(r as unknown as ReminderRow), minutes_before: num(r.minutes_before), fire_at: num(r.fire_at), recipients: r.recipients == null ? null : num(r.recipients), sent_at: r.sent_at == null ? null : num(r.sent_at), created_at: num(r.created_at) });
const feedFrom = (r: Record<string, unknown>): FeedRow => ({ ...(r as unknown as FeedRow), created_at: num(r.created_at), revoked_at: r.revoked_at == null ? null : num(r.revoked_at), last_used_at: r.last_used_at == null ? null : num(r.last_used_at) });

const MAX_EVENT_MS = 31 * 86_400_000;
const FEED_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const SIG = /^[A-Za-z0-9_-]{43}$/;

function badTime(detail: string): HttpProblem {
  return new HttpProblem(400, 'Invalid request', detail, { extensions: { errors: [{ path: 'start', message: detail }] } });
}

export class CalendarService {
  private feedKeyCache: Buffer | null = null;

  constructor(
    private readonly s: () => Services,
    private readonly o: { feedMaxLabel: Label }
  ) {}

  private get db() {
    return this.s().db;
  }

  registerJobs(): void {
    this.s().jobs.register(REMINDER_JOB, async (p) => this.fireReminder(String(p.reminderId)), { timeoutMs: 2 * 60_000 });
  }

  private async audit(ctx: Ctx, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>, label?: Label): Promise<void> {
    await this.s().audit.append({ tenantId: ctx.p.tenantId, action, kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target, ...(detail ? { detail } : {}), ...(label ? { label } : {}), traceId: ctx.traceId ?? null });
  }

  // ---------- events ----------

  private async open(tenantId: string, sealed: string | null, aad: string): Promise<string | null> {
    return sealed ? ((await this.s().keys.open(tenantId, sealed, aad)) ?? null) : null;
  }

  async moderationText(tenantId: string, id: string): Promise<string> {
    const r = await this.db('group_events').where({ tenant_id: tenantId, id }).first('title', 'description', 'location');
    if (!r) return '';
    return [await this.open(tenantId, r.title as string, `event-title:${id}`), await this.open(tenantId, r.description as string | null, `event-description:${id}`), await this.open(tenantId, r.location as string | null, `event-location:${id}`)].filter(Boolean).join('\n\n');
  }

  async eventView(e: EventRow, a?: Pick<Access, 'acting'>, counts?: { going: number; maybe: number; guests: number; checkedIn: number }, mine?: RsvpRow | null) {
    return {
      id: e.id,
      groupId: e.group_id,
      workspaceId: e.workspace_id,
      title: (await this.open(e.tenant_id, e.title, `event-title:${e.id}`)) ?? '',
      description: await this.open(e.tenant_id, e.description, `event-description:${e.id}`),
      location: await this.open(e.tenant_id, e.location, `event-location:${e.id}`),
      startsAt: new Date(e.starts_at).toISOString(),
      endsAt: new Date(e.ends_at).toISOString(),
      timeZone: e.time_zone,
      localStart: localIso(e.starts_at, e.time_zone),
      localEnd: localIso(e.ends_at, e.time_zone),
      allDay: e.all_day,
      capacity: e.capacity,
      maxGuests: e.max_guests,
      reminders: e.reminders,
      label: e.label,
      state: e.state,
      sequence: e.sequence,
      cancelReason: e.cancel_reason,
      createdBy: e.created_by,
      createdAt: e.created_at,
      updatedAt: e.updated_at,
      ...(counts ? { attendance: counts } : {}),
      ...(mine !== undefined ? { myRsvp: mine ? { response: mine.response, guests: mine.guests, checkedIn: mine.checked_in_at != null } : null } : {}),
      ...(a ? { canManage: roleHas(a.acting, 'events') } : {})
    };
  }

  private async row(tenantId: string, id: string): Promise<EventRow | null> {
    const r = await this.db('group_events').where({ tenant_id: tenantId, id }).first();
    return r ? eventFrom(r) : null;
  }

  /** The event and the caller's standing in its group; hidden events only for moderators. */
  private async load(p: Principal, id: string, right: 'read' | 'events' | 'check-in' | 'rsvp' = 'read'): Promise<{ e: EventRow; a: Access }> {
    const s = this.s();
    const e = await this.row(p.tenantId, id);
    if (!e) throw notFound('Event');
    const a = await s.groups.accessOrNull(p, e.group_id);
    if (!a?.read || !clears(p.clearance, e.label)) throw notFound('Event');
    if (e.state === 'hidden' && !roleHas(a.acting, 'moderate')) throw notFound('Event');
    if (right !== 'read') await s.groups.require(p, e.group_id, right);
    return { e, a };
  }

  private async counts(eventId: string) {
    const rows = (await this.db('group_event_rsvps').where({ event_id: eventId }).select('response', 'guests', 'checked_in_at')) as { response: RsvpResponse; guests: number; checked_in_at: number | null }[];
    const going = rows.filter((r) => r.response === 'going');
    return { going: going.length, maybe: rows.filter((r) => r.response === 'maybe').length, guests: going.reduce((n, r) => n + Number(r.guests), 0), checkedIn: rows.filter((r) => r.checked_in_at != null).length };
  }

  /** Validates times: the zone, start before end, at most 31 days long. */
  private times(input: { start: string; end?: string | undefined; durationMinutes?: number | undefined; timeZone: string; allDay?: boolean | undefined }): { start: number; end: number } {
    if (!isTimeZone(input.timeZone)) throw new HttpProblem(400, 'Invalid request', `${input.timeZone} is not an IANA time zone name (such as Europe/Berlin or UTC).`, { extensions: { errors: [{ path: 'timeZone', message: 'an IANA time zone name' }] } });
    try {
      const start = parseEventTime(input.start, input.timeZone);
      let end: number;
      if (input.end) end = parseEventTime(input.end, input.timeZone);
      else if (input.allDay) end = start + 86_400_000;
      else end = start + (input.durationMinutes ?? 60) * 60_000;
      // An all-day event ending on a date ends at the end of that day.
      if (input.allDay && input.end && /^\d{4}-\d{2}-\d{2}$/.test(input.end)) end = parseEventTime(input.end, input.timeZone) + 86_400_000;
      if (end <= start) throw badTime('The event must end after it starts.');
      if (end - start > MAX_EVENT_MS) throw badTime('An event lasts at most 31 days.');
      return { start, end };
    } catch (err) {
      if (err instanceof TimeInputError) throw badTime(err.message);
      throw err;
    }
  }

  async create(ctx: Ctx, groupId: string, input: EventInput) {
    const s = this.s();
    const a = await s.groups.require(ctx.p, groupId, 'events');
    const g = a.group;
    if (g.state !== 'active') throw conflict('The group is not active.');
    const { start, end } = this.times(input);
    const id = ulid();
    const t = Date.now();
    const seal = (v: string | null | undefined, kind: string) => (v ? s.keys.seal(g.tenant_id, v, `event-${kind}:${id}`) : Promise.resolve(null));
    const reminders = [...new Set(input.reminders ?? [])].sort((x, y) => y - x);
    const row = {
      id, tenant_id: g.tenant_id, group_id: g.id, workspace_id: g.workspace_id,
      title: (await seal(input.title, 'title'))!, description: await seal(input.description, 'description'), location: await seal(input.location, 'location'),
      starts_at: start, ends_at: end, time_zone: input.timeZone, all_day: !!input.allDay, capacity: input.capacity ?? null, max_guests: input.maxGuests ?? 0,
      reminders: JSON.stringify(reminders), label: g.label, state: 'scheduled', sequence: 0, cancel_reason: null, created_by: ctx.p.userId, created_at: t, updated_at: t
    };
    await s.db('group_events').insert(row);
    const e = eventFrom(row);
    const scheduled = await this.schedule(e);
    await this.audit(ctx, 'group.event.created', { group: g.id, event: id }, { startsAt: start, endsAt: end, timeZone: input.timeZone, reminders: scheduled }, g.label);
    s.groups.event(g.tenant_id, 'group.event.created', g.label, { group: g.id, workspace: g.workspace_id, actor: ctx.p.userId, event: id, startsAt: new Date(start).toISOString() });
    s.groups.room(g, 'group.event.created', { eventId: id });
    return this.eventView(e, a, { going: 0, maybe: 0, guests: 0, checkedIn: 0 }, null);
  }

  async get(p: Principal, id: string) {
    const { e, a } = await this.load(p, id);
    const mine = await this.db('group_event_rsvps').where({ event_id: id, user_id: p.userId }).first();
    return this.eventView(e, a, await this.counts(id), mine ? rsvpFrom(mine) : null);
  }

  async list(p: Principal, groupId: string, q: { from?: number | undefined; to?: number | undefined; includeCancelled?: boolean | undefined }) {
    const a = await this.s().groups.require(p, groupId, 'read');
    const rows = ((await this.db('group_events').where({ group_id: groupId }).modify((qb) => {
      if (q.from != null) qb.andWhere('ends_at', '>=', q.from);
      if (q.to != null) qb.andWhere('starts_at', '<=', q.to);
      const states = ['scheduled', ...(q.includeCancelled ? ['cancelled'] : []), ...(roleHas(a.acting, 'moderate') ? ['hidden'] : [])];
      qb.whereIn('state', states);
    }).orderBy('starts_at').limit(500)) as Record<string, unknown>[]).map(eventFrom).filter((e) => clears(p.clearance, e.label));
    return Promise.all(rows.map((e) => this.eventView(e, a)));
  }

  /** The caller's own calendar: events of groups they belong to, and events they said they would attend. */
  async mine(p: Principal, q: { from: number; to: number }) {
    return Promise.all((await this.visibleFor(p, q)).map(({ e, a }) => this.eventView(e, a)));
  }

  private async visibleFor(p: Principal, q: { from: number; to: number; includeCancelled?: boolean }): Promise<{ e: EventRow; a: Access }[]> {
    const s = this.s();
    const groupIds = ((await this.db('group_members').where({ tenant_id: p.tenantId, user_id: p.userId }).select('group_id')) as { group_id: string }[]).map((r) => r.group_id);
    const rsvped = this.db('group_event_rsvps').where({ tenant_id: p.tenantId, user_id: p.userId }).whereIn('response', ['going', 'maybe']).select('event_id');
    const rows = ((await this.db('group_events')
      .where({ tenant_id: p.tenantId })
      .andWhere((qb) => qb.whereIn('group_id', groupIds.length ? groupIds : ['-']).orWhereIn('id', rsvped))
      .whereIn('state', q.includeCancelled ? ['scheduled', 'cancelled'] : ['scheduled'])
      .andWhere('ends_at', '>=', q.from)
      .andWhere('starts_at', '<=', q.to)
      .orderBy('starts_at')
      .limit(1000)) as Record<string, unknown>[]).map(eventFrom);
    const ws = await s.groups.workspaceIds(p);
    const access = new Map<string, Access | null>();
    const out: { e: EventRow; a: Access }[] = [];
    for (const e of rows) {
      if (!access.has(e.group_id)) access.set(e.group_id, await s.groups.accessOrNull(p, e.group_id, ws));
      const a = access.get(e.group_id);
      if (a?.read && clears(p.clearance, e.label)) out.push({ e, a });
    }
    return out;
  }

  async update(ctx: Ctx, id: string, patch: { [K in keyof EventInput]?: EventInput[K] | undefined }) {
    const s = this.s();
    const { e, a } = await this.load(ctx.p, id, 'events');
    if (e.state !== 'scheduled') throw conflict(`The event is ${e.state}.`);
    const upd: Record<string, unknown> = { updated_at: Date.now() };
    const seal = (v: string | null | undefined, kind: string) => (v ? s.keys.seal(e.tenant_id, v, `event-${kind}:${id}`) : Promise.resolve(null));
    if (patch.title !== undefined) upd.title = await seal(patch.title, 'title');
    if (patch.description !== undefined) upd.description = await seal(patch.description, 'description');
    if (patch.location !== undefined) upd.location = await seal(patch.location, 'location');
    if (patch.capacity !== undefined) upd.capacity = patch.capacity;
    if (patch.maxGuests !== undefined) upd.max_guests = patch.maxGuests;
    const timeChanged = patch.start !== undefined || patch.end !== undefined || patch.timeZone !== undefined || patch.durationMinutes !== undefined || patch.allDay !== undefined;
    if (timeChanged) {
      const tz = patch.timeZone ?? e.time_zone;
      const allDay = patch.allDay ?? e.all_day;
      const startIn = patch.start ?? new Date(e.starts_at).toISOString();
      const endIn = patch.end ?? (patch.start === undefined && patch.durationMinutes === undefined ? new Date(e.ends_at).toISOString() : undefined);
      const { start, end } = this.times({ start: startIn, ...(endIn ? { end: endIn } : {}), durationMinutes: patch.durationMinutes ?? Math.round((e.ends_at - e.starts_at) / 60_000), timeZone: tz, allDay });
      Object.assign(upd, { starts_at: start, ends_at: end, time_zone: tz, all_day: allDay });
    }
    if (patch.reminders !== undefined) upd.reminders = JSON.stringify([...new Set(patch.reminders)].sort((x, y) => y - x));
    const visible = timeChanged || patch.title !== undefined || patch.location !== undefined || patch.description !== undefined;
    if (visible) upd.sequence = e.sequence + 1;
    await s.db('group_events').where({ id }).update(upd);
    const after = (await this.row(e.tenant_id, id))!;
    let reminders: number[] | undefined;
    if (timeChanged || patch.reminders !== undefined) {
      await this.cancelReminders(e.tenant_id, id);
      reminders = await this.schedule(after);
    }
    await this.audit(ctx, 'group.event.updated', { group: e.group_id, event: id }, { changed: Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined), ...(timeChanged ? { before: { startsAt: e.starts_at, endsAt: e.ends_at, timeZone: e.time_zone }, after: { startsAt: after.starts_at, endsAt: after.ends_at, timeZone: after.time_zone } } : {}), ...(reminders ? { reminders } : {}) }, e.label);
    s.groups.event(e.tenant_id, 'group.event.updated', e.label, { group: e.group_id, workspace: e.workspace_id, actor: ctx.p.userId, event: id, startsAt: new Date(after.starts_at).toISOString() });
    s.groups.room(a.group, 'group.event.updated', { eventId: id, sequence: after.sequence });
    return this.eventView(after, a, await this.counts(id));
  }

  /** Cancels the event: reminders stop, and every attendee (going or maybe) is told in the console and by email. */
  async cancel(ctx: Ctx, id: string, reason: string | null) {
    const s = this.s();
    const { e, a } = await this.load(ctx.p, id, 'events');
    if (e.state !== 'scheduled') throw conflict(`The event is already ${e.state}.`);
    const n = await s.db('group_events').where({ id, state: 'scheduled' }).update({ state: 'cancelled', cancel_reason: reason, sequence: e.sequence + 1, updated_at: Date.now() });
    if (!n) throw conflict('The event changed meanwhile.');
    const reminders = await this.cancelReminders(e.tenant_id, id);
    const attendees = await this.attendeeIds(id);
    await this.noticeAttendees(e, a.group, attendees, 'cancelled', reason);
    await this.audit(ctx, 'group.event.cancelled', { group: e.group_id, event: id }, { attendeesNotified: attendees.length, remindersCancelled: reminders, ...(reason ? { reason } : {}) }, e.label);
    s.groups.event(e.tenant_id, 'group.event.cancelled', e.label, { group: e.group_id, workspace: e.workspace_id, actor: ctx.p.userId, event: id, attendees: attendees.length });
    s.groups.room(a.group, 'group.event.cancelled', { eventId: id });
    const after = (await this.row(e.tenant_id, id))!;
    return { ...(await this.eventView(after, a, await this.counts(id))), notified: attendees.length };
  }

  private async attendeeIds(eventId: string): Promise<string[]> {
    return ((await this.db('group_event_rsvps as r').join('users as u', 'u.id', 'r.user_id').where({ 'r.event_id': eventId, 'u.state': 'active' }).whereIn('r.response', ['going', 'maybe']).select('r.user_id')) as { user_id: string }[]).map((r) => r.user_id);
  }

  /**
   * In-app notices name the group (a name, not content) and the time; neither they nor the emails carry the event's
   * sealed title or description, which the console shows to those still entitled to read it.
   */
  private async noticeAttendees(e: EventRow, g: GroupRow, userIds: string[], what: 'cancelled' | 'reminder', reason?: string | null, minutesBefore?: number): Promise<void> {
    if (!userIds.length) return;
    const when = describeTime(e.starts_at, e.time_zone, e.all_day);
    const title = what === 'cancelled' ? `An event in ${g.name} was cancelled` : `Reminder: an event in ${g.name} starts ${minutesBefore != null ? inWords(minutesBefore) : 'soon'}`;
    const body = what === 'cancelled' ? `It was due to start ${when}.${reason ? ' The organiser gave a reason; open the event to read it.' : ''}` : `It starts ${when}.`;
    await this.s().notifications.notify({
      tenantId: e.tenant_id,
      userIds,
      kind: what === 'cancelled' ? 'event.cancelled' : 'event.reminder',
      title,
      body,
      route: `groups?id=${g.id}&event=${e.id}`,
      label: e.label,
      emailTemplate: { name: 'event-notice', vars: { event: what === 'cancelled' ? 'An event you planned to attend was cancelled' : 'Event reminder', when, detail: body } }
    });
  }

  // ---------- RSVPs, attendees, check-in ----------

  async rsvp(ctx: Ctx, id: string, input: { response: RsvpResponse; guests?: number | undefined }) {
    const s = this.s();
    const { e, a } = await this.load(ctx.p, id);
    if (e.state !== 'scheduled') throw conflict(`The event is ${e.state}.`);
    if (e.ends_at < Date.now()) throw conflict('The event is over.');
    // Members RSVP; in a public group, so may anyone in the workspace who can read it.
    if (!a.role && !a.manager && a.group.visibility !== 'public') throw new HttpProblem(403, 'Forbidden', 'Join the group to RSVP.', { extensions: { step: 'group-role' } });
    const guests = input.response === 'going' ? (input.guests ?? 0) : 0;
    if (guests > e.max_guests) throw new HttpProblem(422, 'Too many guests', e.max_guests ? `Bring at most ${e.max_guests} guest${e.max_guests === 1 ? '' : 's'}.` : 'This event does not allow guests.');
    const t = Date.now();
    await s.db.transaction(async (trx) => {
      if (input.response === 'going' && e.capacity != null) {
        const rows = (await trx('group_event_rsvps').where({ event_id: id, response: 'going' }).whereNot({ user_id: ctx.p.userId }).select('guests')) as { guests: number }[];
        const taken = rows.reduce((n, r) => n + 1 + Number(r.guests), 0);
        if (taken + 1 + guests > e.capacity) throw new HttpProblem(409, 'Event full', `The event holds ${e.capacity} people and ${Math.max(0, e.capacity - taken)} place${e.capacity - taken === 1 ? ' is' : 's are'} left.`, { extensions: { capacity: e.capacity, left: Math.max(0, e.capacity - taken) } });
      }
      const existing = await trx('group_event_rsvps').where({ event_id: id, user_id: ctx.p.userId }).first();
      if (existing) await trx('group_event_rsvps').where({ event_id: id, user_id: ctx.p.userId }).update({ response: input.response, guests, updated_at: t });
      else await trx('group_event_rsvps').insert({ event_id: id, tenant_id: e.tenant_id, user_id: ctx.p.userId, response: input.response, guests, checked_in_at: null, checked_in_by: null, created_at: t, updated_at: t });
    });
    await this.audit(ctx, 'group.event.rsvp', { group: e.group_id, event: id, user: ctx.p.userId }, { response: input.response, guests }, e.label);
    s.groups.room(a.group, 'group.event.rsvp', { eventId: id, userId: ctx.p.userId, response: input.response, guests });
    return { eventId: id, response: input.response, guests, attendance: await this.counts(id) };
  }

  async attendees(p: Principal, id: string) {
    const { a } = await this.load(p, id);
    const mod = roleHas(a.acting, 'check-in');
    const rows = (await this.db('group_event_rsvps as r').join('users as u', 'u.id', 'r.user_id').where({ 'r.event_id': id }).whereIn('r.response', mod ? ['going', 'maybe', 'declined'] : ['going', 'maybe']).orderBy('u.display_name').select('r.*', 'u.username', 'u.display_name')) as Record<string, unknown>[];
    return rows.map((raw) => {
      const r = rsvpFrom(raw);
      return { userId: r.user_id, username: String(raw.username), displayName: String(raw.display_name), response: r.response, guests: r.guests, respondedAt: r.updated_at, ...(mod || r.user_id === p.userId ? { checkedIn: r.checked_in_at != null, checkedInAt: r.checked_in_at } : {}) };
    });
  }

  /** Checks an attendee in (or out again); someone who did not RSVP is added as going. */
  async checkIn(ctx: Ctx, id: string, userId: string, checkedIn: boolean) {
    const s = this.s();
    const { e, a } = await this.load(ctx.p, id, 'check-in');
    if (e.state !== 'scheduled') throw conflict(`The event is ${e.state}.`);
    const t = Date.now();
    const existing = await s.db('group_event_rsvps').where({ event_id: id, user_id: userId }).first();
    if (!existing) {
      if (!checkedIn) throw notFound('Attendee');
      const u = await s.users.get(e.tenant_id, userId);
      if (!u) throw notFound('User');
      const target = await loadPrincipal(s, e.tenant_id, userId, {});
      if (!target || !(await s.groups.accessOrNull(target, e.group_id))?.read) throw new HttpProblem(422, 'Cannot check in', 'The user cannot see this event (outside the group’s workspace, below its label, or not in a private group).');
      await s.db('group_event_rsvps').insert({ event_id: id, tenant_id: e.tenant_id, user_id: userId, response: 'going', guests: 0, checked_in_at: t, checked_in_by: ctx.p.userId, created_at: t, updated_at: t });
    } else {
      await s.db('group_event_rsvps').where({ event_id: id, user_id: userId }).update(checkedIn ? { checked_in_at: t, checked_in_by: ctx.p.userId, response: 'going', updated_at: t } : { checked_in_at: null, checked_in_by: null, updated_at: t });
    }
    await this.audit(ctx, checkedIn ? 'group.event.checked-in' : 'group.event.check-in-undone', { group: e.group_id, event: id, user: userId }, undefined, e.label);
    s.groups.room(a.group, 'group.event.check-in', { eventId: id, userId, checkedIn });
    return { eventId: id, userId, checkedIn, attendance: await this.counts(id) };
  }

  // ---------- reminders (B-2503) ----------

  /** One reminder row and queue job per offset still in the future. Returns the offsets scheduled. */
  private async schedule(e: EventRow): Promise<number[]> {
    if (e.state !== 'scheduled') return [];
    const s = this.s();
    const now = Date.now();
    const out: number[] = [];
    for (const minutes of e.reminders) {
      const fireAt = e.starts_at - minutes * 60_000;
      if (fireAt <= now) continue;
      const id = ulid();
      await s.db('group_event_reminders').insert({ id, tenant_id: e.tenant_id, event_id: e.id, minutes_before: minutes, fire_at: fireAt, state: 'scheduled', job_id: null, recipients: null, sent_at: null, created_at: now });
      const job = await s.jobs.enqueue({ tenantId: e.tenant_id, type: REMINDER_JOB, payload: { reminderId: id }, runAt: fireAt, dedupeKey: `${REMINDER_JOB}:${id}`, maxAttempts: 3 });
      await s.db('group_event_reminders').where({ id }).update({ job_id: job.id });
      out.push(minutes);
    }
    return out;
  }

  private async cancelReminders(tenantId: string, eventId: string): Promise<number> {
    const s = this.s();
    const rows = ((await s.db('group_event_reminders').where({ tenant_id: tenantId, event_id: eventId, state: 'scheduled' })) as Record<string, unknown>[]).map(reminderFrom);
    let n = 0;
    for (const r of rows) {
      if (!(await s.db('group_event_reminders').where({ id: r.id, state: 'scheduled' }).update({ state: 'cancelled' }))) continue;
      n++;
      if (r.job_id) await s.jobs.cancel(tenantId, r.job_id).catch(() => undefined);
    }
    return n;
  }

  async cancelRemindersForGroup(tenantId: string, groupId: string): Promise<number> {
    const ids = ((await this.db('group_events').where({ tenant_id: tenantId, group_id: groupId, state: 'scheduled' }).select('id')) as { id: string }[]).map((r) => r.id);
    let n = 0;
    for (const id of ids) n += await this.cancelReminders(tenantId, id);
    return n;
  }

  /**
   * The reminder job. The row is claimed (scheduled → sending) before anything is sent, so only one run sends it even
   * if the job were run twice; an event that was cancelled, hidden or moved since is skipped. Recipients are the
   * attendees (going or maybe) who can still read the event now.
   */
  async fireReminder(reminderId: string): Promise<{ sent?: number; skipped?: string }> {
    const s = this.s();
    const raw = await s.db('group_event_reminders').where({ id: reminderId }).first();
    if (!raw) return { skipped: 'gone' };
    const r = reminderFrom(raw);
    if (r.state !== 'scheduled') return { skipped: r.state };
    const claimed = await s.db('group_event_reminders').where({ id: r.id, state: 'scheduled' }).update({ state: 'sending' });
    if (!claimed) return { skipped: 'claimed elsewhere' };
    try {
      const e = await this.row(r.tenant_id, r.event_id);
      const g = e ? await s.groups.row(r.tenant_id, e.group_id) : null;
      if (!e || !g || e.state !== 'scheduled' || g.state !== 'active' || e.starts_at - r.minutes_before * 60_000 !== r.fire_at) {
        await s.db('group_event_reminders').where({ id: r.id }).update({ state: 'skipped' });
        return { skipped: 'event changed' };
      }
      const recipients: string[] = [];
      for (const userId of await this.attendeeIds(e.id)) {
        const p = await loadPrincipal(s, e.tenant_id, userId, {});
        if (p && clears(p.clearance, e.label) && (await s.groups.accessOrNull(p, e.group_id))?.read) recipients.push(userId);
      }
      await this.noticeAttendees(e, g, recipients, 'reminder', null, r.minutes_before);
      await s.db('group_event_reminders').where({ id: r.id }).update({ state: 'sent', recipients: recipients.length, sent_at: Date.now() });
      await s.audit.append({ tenantId: r.tenant_id, action: 'group.event.reminded', kind: 'system', actor: { service: 'calendar' }, target: { group: e.group_id, event: e.id, reminder: r.id }, label: e.label, detail: { minutesBefore: r.minutes_before, recipients: recipients.length } });
      return { sent: recipients.length };
    } catch (err) {
      // Nothing was recorded as sent: let the job's retry claim it again.
      await s.db('group_event_reminders').where({ id: r.id, state: 'sending' }).update({ state: 'scheduled' });
      throw err;
    }
  }

  async reminders(p: Principal, id: string) {
    await this.load(p, id, 'events');
    return ((await this.db('group_event_reminders').where({ event_id: id }).orderBy('fire_at')) as Record<string, unknown>[]).map(reminderFrom).map((r) => ({ id: r.id, minutesBefore: r.minutes_before, fireAt: new Date(r.fire_at).toISOString(), state: r.state, recipients: r.recipients, sentAt: r.sent_at }));
  }

  // ---------- feeds (B-2504) ----------

  private feedKey(): Buffer {
    return (this.feedKeyCache ??= Buffer.from(hkdfSync('sha256', this.s().cfg.SESSION_SECRET, 'exprsn-ai', 'calendar-feed-signature-v1', 32)));
  }

  /** base64url HMAC-SHA256 over the feed's identity: a different id, tenant, owner or target needs a new signature. */
  sign(f: Pick<FeedRow, 'id' | 'tenant_id' | 'user_id' | 'kind' | 'target_id'>): string {
    return createHmac('sha256', this.feedKey()).update(`v1\n${f.id}\n${f.tenant_id}\n${f.user_id}\n${f.kind}\n${f.target_id ?? ''}`).digest('base64url');
  }

  feedUrl(f: FeedRow): string {
    return `${this.s().cfg.PUBLIC_URL.replace(/\/+$/, '')}/calendar/feeds/${f.id}/${this.sign(f)}.ics`;
  }

  feedView(f: FeedRow) {
    return { id: f.id, kind: f.kind, targetId: f.target_id, name: f.name, url: f.revoked_at ? null : this.feedUrl(f), createdAt: f.created_at, revokedAt: f.revoked_at, lastUsedAt: f.last_used_at };
  }

  async createFeed(ctx: Ctx, input: { kind: FeedKind; targetId?: string | null | undefined }) {
    const s = this.s();
    const p = ctx.p;
    let name: string;
    let label: Label = 'internal';
    if (input.kind === 'user') name = `${p.displayName}: my events`;
    else if (!input.targetId) throw new HttpProblem(400, 'Invalid request', `A ${input.kind} feed names its ${input.kind} (targetId).`);
    else if (input.kind === 'group') {
      const a = await s.groups.require(p, input.targetId, 'read');
      name = a.group.name;
      label = a.group.label;
    } else {
      const { e, a } = await this.load(p, input.targetId);
      name = `${a.group.name}: event`;
      label = e.label;
    }
    const row: FeedRow = { id: ulid(), tenant_id: p.tenantId, user_id: p.userId, kind: input.kind, target_id: input.kind === 'user' ? null : (input.targetId ?? null), name: name.slice(0, 200), created_at: Date.now(), revoked_at: null, revoked_by: null, last_used_at: null };
    await s.db('calendar_feeds').insert(row);
    await this.audit(ctx, 'calendar.feed.created', { feed: row.id, kind: row.kind, ...(row.target_id ? { target: row.target_id } : {}) }, undefined, label);
    return this.feedView(row);
  }

  async feeds(p: Principal) {
    return ((await this.db('calendar_feeds').where({ tenant_id: p.tenantId, user_id: p.userId }).orderBy('created_at', 'desc')) as Record<string, unknown>[]).map(feedFrom).map((f) => this.feedView(f));
  }

  async revokeFeed(ctx: Ctx, id: string) {
    const r = await this.db('calendar_feeds').where({ tenant_id: ctx.p.tenantId, id }).first();
    if (!r) throw notFound('Feed');
    const f = feedFrom(r);
    // Owners revoke their own feeds; groups:manage holders any feed in the tenant.
    if (f.user_id !== ctx.p.userId && !effectivePermissions(ctx.p).has('groups:manage')) throw notFound('Feed');
    if (f.revoked_at) return this.feedView(f);
    await this.db('calendar_feeds').where({ id: f.id }).update({ revoked_at: Date.now(), revoked_by: ctx.p.userId });
    await this.audit(ctx, 'calendar.feed.revoked', { feed: f.id, kind: f.kind, owner: f.user_id });
    return this.feedView(feedFrom(await this.db('calendar_feeds').where({ id: f.id }).first()));
  }

  /**
   * Renders a feed for the public route, or null for every refusal (unknown id, bad signature, revoked, owner gone or
   * no longer entitled): the caller answers them all with the same 404.
   */
  async renderFeed(id: string, signature: string): Promise<{ body: string; feed: FeedRow } | null> {
    if (!FEED_ID.test(id) || !SIG.test(signature)) return null;
    const s = this.s();
    const r = await s.db('calendar_feeds').where({ id }).first();
    // Compare with a signature even for an unknown id, so timing does not tell ids apart.
    const f = r ? feedFrom(r) : null;
    const want = this.sign(f ?? { id, tenant_id: '-', user_id: '-', kind: 'user', target_id: null });
    if (!safeEqual(want, signature) || !f || f.revoked_at) return null;
    const tenant = await s.tenants.byId(f.tenant_id);
    if (!tenant || tenant.state !== 'active') return null;
    const p = await loadPrincipal(s, f.tenant_id, f.user_id, {});
    if (!p) return null;
    const now = Date.now();
    let items: { e: EventRow; a: Access }[];
    let name = f.name ?? 'Events';
    if (f.kind === 'user') {
      items = await this.visibleFor(p, { from: now - 30 * 86_400_000, to: now + 366 * 86_400_000, includeCancelled: true });
    } else if (f.kind === 'group') {
      const a = await s.groups.accessOrNull(p, f.target_id!);
      if (!a?.read) return null;
      name = a.group.name;
      const rows = ((await s.db('group_events').where({ group_id: a.group.id }).whereIn('state', ['scheduled', 'cancelled']).andWhere('ends_at', '>=', now - 30 * 86_400_000).orderBy('starts_at').limit(1000)) as Record<string, unknown>[]).map(eventFrom);
      items = rows.filter((e) => clears(p.clearance, e.label)).map((e) => ({ e, a }));
    } else {
      const e = await this.row(f.tenant_id, f.target_id!);
      const a = e ? await s.groups.accessOrNull(p, e.group_id) : null;
      if (!e || !a?.read || !clears(p.clearance, e.label) || e.state === 'hidden') return null;
      items = [{ e, a }];
    }
    const host = new URL(s.cfg.PUBLIC_URL).hostname;
    const events: IcsEvent[] = [];
    for (const { e, a } of items) {
      const detailed = labelRank(e.label) <= labelRank(this.o.feedMaxLabel);
      events.push({
        uid: `${e.id}@${host}`,
        summary: detailed ? ((await this.open(e.tenant_id, e.title, `event-title:${e.id}`)) ?? '') : `Busy (${e.label})`,
        description: detailed ? await this.open(e.tenant_id, e.description, `event-description:${e.id}`) : null,
        location: detailed ? await this.open(e.tenant_id, e.location, `event-location:${e.id}`) : null,
        url: s.notifications.consoleUrl(`groups?id=${e.group_id}&event=${e.id}`),
        start: e.starts_at,
        end: e.ends_at,
        timeZone: e.time_zone,
        allDay: e.all_day,
        status: e.state === 'cancelled' ? 'CANCELLED' : 'CONFIRMED',
        sequence: e.sequence,
        created: e.created_at,
        updated: e.updated_at,
        klass: e.label === 'public' ? 'PUBLIC' : detailed ? 'PRIVATE' : 'CONFIDENTIAL',
        categories: detailed ? [a.group.name] : []
      });
    }
    const zones = new Set(items.map((x) => x.e.time_zone));
    await s.db('calendar_feeds').where({ id: f.id }).update({ last_used_at: now });
    return { body: renderCalendar({ name, timeZone: zones.size === 1 ? [...zones][0]! : null, events }, now), feed: f };
  }
}

function inWords(minutes: number): string {
  if (minutes % 1440 === 0) return `in ${minutes / 1440} day${minutes === 1440 ? '' : 's'}`;
  if (minutes % 60 === 0) return `in ${minutes / 60} hour${minutes === 60 ? '' : 's'}`;
  return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
}
