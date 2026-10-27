import { hkdfSync, createHmac } from 'node:crypto';
import { ulid } from 'ulid';
import { actorFrom, isUniqueViolation } from '../audit/chain.js';
import { clears, isLabel, labelRank, type Label } from '../authz/labels.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { safeEqual } from '../crypto/index.js';
import type { Knex } from 'knex';
import { json } from '../db/knex.js';
import { loadPrincipal } from '../http/middleware.js';
import { conflict, HttpProblem, notFound, tooManyRequests } from '../http/problem.js';
import type { Services } from '../services.js';
import { renderCalendar, type IcsEvent } from './ical.js';
import { distanceKm, narrow, validPoint, type Near } from './geo.js';
import { decodeCursor, encodeCursor, likeOf, paged, pageSize, type Page, type PageQuery } from './paging.js';
import { can } from './roles.js';
import type { Access, Ctx, GroupRow } from './service.js';
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
 * - Notices (1.7.0, B-9708): the group's members hear of a new event; a change of time tells the attendees once (a row
 *   of `group_event_notices` with a unique key per event and sequence); an organiser may send the attendees a message
 *   ("notify attendees"), screened by the `user-input` guardrail and kept sealed with the event. Whoever is told is
 *   decided when the notice goes out: an attendee who can no longer read the event is never told.
 * - Extras (1.7.0, B-9707). An event has a kind (in-person, virtual, hybrid) and may carry a virtual URL, screened by
 *   the `user-input` guardrail, sealed, and shown with the event to those who may read it (never in a feed). Its
 *   visibility narrows who reads it inside the group: `group` (whoever reads the group, as before), `members` (the
 *   group's members), `organisers` (holders of the right `events`); `readable` is the one place that decides. A draft
 *   (state `draft`) is read only by those who may edit it and tells nobody anything until it is published. An RSVP
 *   deadline closes "going" and "maybe"; declining stays open. With approval required, "going" waits as `pending`
 *   until an organiser decides (audited). With a waitlist, "going" to a full event waits as `waitlisted`; when a place
 *   frees up `promote` gives it to the first on the list who may still attend and whose party fits, under the event
 *   row's lock and with a conditional update, so a place is given once.
 */

export interface AttendeeView {
  userId: string;
  username: string;
  displayName: string;
  response: RsvpState;
  guests: number;
  respondedAt: number;
  /** For organisers: when a waiting answer joined the waitlist or asked for approval. */
  queuedAt?: number | null;
  checkedIn?: boolean;
  checkedInAt?: number | null;
}

export const EVENT_OBJECT_NOTICE = 'group-event-notice';
/** How many messages an event's organisers may send its attendees in 24 hours. */
export const NOTICES_PER_DAY = 5;
export const NOTICE_MAX = 1000;

export const REMINDER_JOB = 'calendar.reminder';
export const FEED_KINDS = ['event', 'group', 'user'] as const;
export type FeedKind = (typeof FEED_KINDS)[number];
export const RSVP_RESPONSES = ['going', 'maybe', 'declined'] as const;
export type RsvpResponse = (typeof RSVP_RESPONSES)[number];
/** What an RSVP row may say (B-9707): an answer, or a "going" that waits for a place or for an organiser. */
export const RSVP_STATES = [...RSVP_RESPONSES, 'waitlisted', 'pending'] as const;
export type RsvpState = (typeof RSVP_STATES)[number];
export const EVENT_KINDS = ['in-person', 'virtual', 'hybrid'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export const EVENT_VISIBILITIES = ['group', 'members', 'organisers'] as const;
export type EventVisibility = (typeof EVENT_VISIBILITIES)[number];
export const EVENT_OBJECT_URL = 'group-event-url';

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
  /** 1.7.0 (B-9707): `draft` is read by those who may edit it and by nobody else. */
  state: 'draft' | 'scheduled' | 'cancelled' | 'hidden';
  sequence: number;
  cancel_reason: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  /** 1.6.0 (B-4403): the event's point for distance filters (WGS 84 degrees), optional. */
  lat: number | null;
  lon: number | null;
  /** 1.7.0 (B-9707). */
  kind: EventKind;
  virtual_url: string | null;
  visibility: EventVisibility;
  rsvp_deadline: number | null;
  rsvp_approval: boolean;
  waitlist: boolean;
}

interface RsvpRow {
  event_id: string;
  tenant_id: string;
  user_id: string;
  response: RsvpState;
  guests: number;
  queued_at?: number | null;
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
  /** 1.6.0 (B-4403): the point of the place (both or neither; null clears it). */
  lat?: number | null | undefined;
  lon?: number | null | undefined;
  /** 1.7.0 (B-9707). */
  kind?: EventKind | undefined;
  virtualUrl?: string | null | undefined;
  visibility?: EventVisibility | undefined;
  rsvpDeadline?: string | null | undefined;
  rsvpApproval?: boolean | undefined;
  waitlist?: boolean | undefined;
  /** On create: keep the event as a draft until it is published. */
  draft?: boolean | undefined;
}

/** Both coordinates or neither (B-4403); 422 otherwise. */
function pointOf(lat: number | null | undefined, lon: number | null | undefined): { lat: number | null; lon: number | null } {
  if (lat == null && lon == null) return { lat: null, lon: null };
  const p = { lat: lat ?? null, lon: lon ?? null };
  if (!validPoint(p)) throw new HttpProblem(422, 'Not a place', 'Give both a latitude (−90 to 90) and a longitude (−180 to 180), or neither.', { extensions: { step: 'location' } });
  return p;
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
  updated_at: num(r.updated_at),
  lat: r.lat == null ? null : num(r.lat),
  lon: r.lon == null ? null : num(r.lon),
  kind: (EVENT_KINDS as readonly string[]).includes(String(r.kind)) ? (r.kind as EventKind) : 'in-person',
  virtual_url: (r.virtual_url as string | null | undefined) ?? null,
  visibility: (EVENT_VISIBILITIES as readonly string[]).includes(String(r.visibility)) ? (r.visibility as EventVisibility) : 'group',
  rsvp_deadline: r.rsvp_deadline == null ? null : num(r.rsvp_deadline),
  rsvp_approval: !!r.rsvp_approval,
  waitlist: !!r.waitlist
});
const rsvpFrom = (r: Record<string, unknown>): RsvpRow => ({ ...(r as unknown as RsvpRow), guests: num(r.guests ?? 0), queued_at: r.queued_at == null ? null : num(r.queued_at), checked_in_at: r.checked_in_at == null ? null : num(r.checked_in_at), created_at: num(r.created_at), updated_at: num(r.updated_at) });
const reminderFrom = (r: Record<string, unknown>): ReminderRow => ({ ...(r as unknown as ReminderRow), minutes_before: num(r.minutes_before), fire_at: num(r.fire_at), recipients: r.recipients == null ? null : num(r.recipients), sent_at: r.sent_at == null ? null : num(r.sent_at), created_at: num(r.created_at) });
const feedFrom = (r: Record<string, unknown>): FeedRow => ({ ...(r as unknown as FeedRow), created_at: num(r.created_at), revoked_at: r.revoked_at == null ? null : num(r.revoked_at), last_used_at: r.last_used_at == null ? null : num(r.last_used_at) });

const MAX_EVENT_MS = 31 * 86_400_000;
const FEED_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const SIG = /^[A-Za-z0-9_-]{43}$/;

/**
 * B-3603: reads an event's row inside a transaction with a row lock (SELECT … FOR UPDATE on PostgreSQL and MySQL), so
 * whoever counts the places next waits for this transaction to finish. SQLite has no row locks and needs none here:
 * it has one writer and the app gives it one connection, so its transactions already run one after another.
 */
export async function lockEventRow(trx: Knex.Transaction, eventId: string): Promise<{ capacity: number | null; state: string } | undefined> {
  const q = trx('group_events').where({ id: eventId }).select('capacity', 'state');
  const sqlite = /sqlite/.test(String(trx.client.config.client));
  const r = (await (sqlite ? q : q.forUpdate()).first()) as { capacity: number | string | null; state: string } | undefined;
  return r ? { capacity: r.capacity == null ? null : Number(r.capacity), state: String(r.state) } : undefined;
}

function badTime(detail: string): HttpProblem {
  return new HttpProblem(400, 'Invalid request', detail, { extensions: { errors: [{ path: 'start', message: detail }] } });
}

export class CalendarService {
  private readonly feedKeyCache = new Map<string, Buffer>();

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

  async eventView(e: EventRow, a?: Pick<Access, 'rights'>, counts?: { going: number; maybe: number; guests: number; checkedIn: number; waitlisted?: number; pending?: number }, mine?: RsvpRow | null, position?: number | null) {
    return {
      id: e.id,
      groupId: e.group_id,
      workspaceId: e.workspace_id,
      title: (await this.open(e.tenant_id, e.title, `event-title:${e.id}`)) ?? '',
      description: await this.open(e.tenant_id, e.description, `event-description:${e.id}`),
      location: await this.open(e.tenant_id, e.location, `event-location:${e.id}`),
      lat: e.lat,
      lon: e.lon,
      startsAt: new Date(e.starts_at).toISOString(),
      endsAt: new Date(e.ends_at).toISOString(),
      timeZone: e.time_zone,
      localStart: localIso(e.starts_at, e.time_zone),
      localEnd: localIso(e.ends_at, e.time_zone),
      allDay: e.all_day,
      capacity: e.capacity,
      maxGuests: e.max_guests,
      // 1.7.0 (B-9707)
      kind: e.kind,
      virtualUrl: await this.open(e.tenant_id, e.virtual_url, `event-url:${e.id}`),
      visibility: e.visibility,
      rsvpDeadline: e.rsvp_deadline == null ? null : new Date(e.rsvp_deadline).toISOString(),
      rsvpApproval: e.rsvp_approval,
      waitlist: e.waitlist,
      reminders: e.reminders,
      label: e.label,
      state: e.state,
      sequence: e.sequence,
      cancelReason: e.cancel_reason,
      createdBy: e.created_by,
      createdAt: e.created_at,
      updatedAt: e.updated_at,
      ...(counts ? { attendance: counts } : {}),
      ...(mine !== undefined ? { myRsvp: mine ? { response: mine.response, guests: mine.guests, checkedIn: mine.checked_in_at != null, ...(position != null ? { position } : {}) } : null } : {}),
      ...(a ? { canManage: can(a, 'events') } : {})
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
    if (!a || !this.readable(e, a, p)) throw notFound('Event');
    if (right !== 'read') await s.groups.require(p, e.group_id, right);
    return { e, a };
  }

  /**
   * B-9707: may someone with this standing in the group read the event? The one place that decides it, for a request,
   * a list, a feed, a notice, a reminder and a promotion from the waitlist alike.
   */
  readable(e: EventRow, a: Access | null | undefined, p: Pick<Principal, 'clearance'>): boolean {
    if (!a?.read || !clears(p.clearance, e.label)) return false;
    const organiser = can(a, 'events');
    if (e.state === 'draft') return organiser;
    if (e.state === 'hidden' && !can(a, 'moderate')) return false;
    if (e.visibility === 'organisers') return organiser;
    // A suspended member's role is not in effect, so they are no member here either.
    if (e.visibility === 'members') return !!a.role || a.manager;
    return true;
  }

  /** May this person attend: read the event, and answer it (a member with the right `rsvp`, or anyone who reads a public group's event), with no ban or suspension standing. */
  private async mayAttend(e: EventRow, userId: string): Promise<boolean> {
    const s = this.s();
    const p = await loadPrincipal(s, e.tenant_id, userId, {});
    if (!p) return false;
    const a = await s.groups.accessOrNull(p, e.group_id);
    if (!a || !this.readable(e, a, p)) return false;
    if (await s.groups.bans.barred(a.group, userId)) return false;
    return a.role || a.manager ? can(a, 'rsvp') : a.group.visibility === 'public';
  }

  private async counts(eventId: string) {
    const rows = (await this.db('group_event_rsvps').where({ event_id: eventId }).select('response', 'guests', 'checked_in_at')) as { response: RsvpState; guests: number; checked_in_at: number | null }[];
    const going = rows.filter((r) => r.response === 'going');
    return { going: going.length, maybe: rows.filter((r) => r.response === 'maybe').length, guests: going.reduce((n, r) => n + Number(r.guests), 0), checkedIn: rows.filter((r) => r.checked_in_at != null).length, waitlisted: rows.filter((r) => (r.response as RsvpState) === 'waitlisted').length, pending: rows.filter((r) => (r.response as RsvpState) === 'pending').length };
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

  /** B-9707: a virtual URL passes the `user-input` guardrail before it is kept; a block, a hold or a redaction refuses it. */
  private async screenUrl(ctx: Ctx, g: Pick<GroupRow, 'id' | 'tenant_id' | 'workspace_id' | 'label'>, eventId: string, url: string | null | undefined): Promise<string | null> {
    if (!url) return null;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new HttpProblem(422, 'Not a link', 'Give the virtual URL as a full https:// or http:// address.', { extensions: { step: 'virtual-url' } });
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new HttpProblem(422, 'Not a link', 'Give the virtual URL as a full https:// or http:// address.', { extensions: { step: 'virtual-url' } });
    if (parsed.username || parsed.password) throw new HttpProblem(422, 'Not a link', 'A virtual URL must not carry a user name or a password.', { extensions: { step: 'virtual-url' } });
    const d = await this.s().guardrails.check({ tenantId: g.tenant_id, workspaceId: g.workspace_id, checkpoint: 'user-input', text: url, label: g.label, principal: ctx.p, source: { kind: EVENT_OBJECT_URL, id: eventId }, meta: { objectType: EVENT_OBJECT_URL, group: g.id, event: eventId } });
    if (d.action === 'block' || d.action === 'require-approval' || d.action === 'redact') throw new HttpProblem(422, 'Blocked by guardrails', d.reason ?? 'The virtual URL was blocked by a guardrail rule.', { extensions: { step: 'guardrails', action: d.action } });
    return url;
  }

  private deadlineOf(input: string | null | undefined, end: number): number | null {
    if (!input) return null;
    const t = Date.parse(input);
    if (!Number.isFinite(t)) throw new HttpProblem(400, 'Invalid request', 'Give the RSVP deadline as an ISO 8601 time.', { extensions: { errors: [{ path: 'rsvpDeadline', message: 'an ISO 8601 time' }] } });
    if (t > end) throw new HttpProblem(422, 'Deadline after the event', 'The RSVP deadline cannot be after the event ends.', { extensions: { step: 'rsvp-deadline' } });
    return t;
  }

  /** Who is told of an event that is now there to read: the members who may read it, never whoever made it so. */
  private async announce(e: EventRow, g: GroupRow, actorId: string): Promise<void> {
    const s = this.s();
    s.groups.event(g.tenant_id, 'group.event.created', g.label, { group: g.id, workspace: g.workspace_id, actor: actorId, event: e.id, startsAt: new Date(e.starts_at).toISOString() });
    s.groups.room(g, 'group.event.created', { eventId: e.id });
    // 1.7.0 (B-9708): the group's members hear of a new event; one kept to the organisers is told to them only (B-9707).
    const members = (await s.groups.membersWithAccess(g, e.visibility === 'organisers' ? 'events' : undefined)).filter((u) => u !== actorId);
    if (members.length) await s.notifications.notify({ tenantId: g.tenant_id, userIds: members, kind: 'event.created', title: `A new event in ${g.name}`, body: `It starts ${describeTime(e.starts_at, e.time_zone, e.all_day)}.`, route: `groups?id=${g.id}&event=${e.id}`, label: g.label });
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
    // 1.6.0 (B-4206): an event without a capacity starts from its workspace's default (Social and messaging).
    const capacity = input.capacity !== undefined ? input.capacity : (await s.socialAdmin.policy(g.tenant_id, g.workspace_id)).eventCapacity;
    const draft = !!input.draft;
    const row = {
      id, tenant_id: g.tenant_id, group_id: g.id, workspace_id: g.workspace_id,
      title: (await seal(input.title, 'title'))!, description: await seal(input.description, 'description'), location: await seal(input.location, 'location'),
      starts_at: start, ends_at: end, time_zone: input.timeZone, all_day: !!input.allDay, capacity: capacity ?? null, max_guests: input.maxGuests ?? 0,
      reminders: JSON.stringify(reminders), label: g.label, state: draft ? 'draft' : 'scheduled', sequence: 0, cancel_reason: null, created_by: ctx.p.userId, created_at: t, updated_at: t,
      ...pointOf(input.lat, input.lon),
      kind: input.kind ?? 'in-person', virtual_url: await seal(await this.screenUrl(ctx, g, id, input.virtualUrl), 'url'), visibility: input.visibility ?? 'group',
      rsvp_deadline: this.deadlineOf(input.rsvpDeadline, end), rsvp_approval: !!input.rsvpApproval, waitlist: !!input.waitlist
    };
    await s.db('group_events').insert(row);
    const e = eventFrom(row);
    // A draft schedules nothing and tells nobody until it is published (B-9707).
    const scheduled = await this.schedule(e);
    await this.audit(ctx, 'group.event.created', { group: g.id, event: id }, { startsAt: start, endsAt: end, timeZone: input.timeZone, reminders: scheduled, kind: e.kind, visibility: e.visibility, ...(draft ? { draft: true } : {}), ...(e.rsvp_approval ? { rsvpApproval: true } : {}), ...(e.waitlist ? { waitlist: true } : {}) }, g.label);
    if (!draft) await this.announce(e, g, ctx.p.userId);
    return this.eventView(e, a, { going: 0, maybe: 0, guests: 0, checkedIn: 0, waitlisted: 0, pending: 0 }, null);
  }

  /** Publishes a draft (B-9707): from now it is read as its visibility says, its reminders are scheduled and the members are told. */
  async publish(ctx: Ctx, id: string) {
    const s = this.s();
    const { e, a } = await this.load(ctx.p, id, 'events');
    if (e.state !== 'draft') throw conflict(`The event is ${e.state}, not a draft.`);
    if (e.ends_at < Date.now()) throw conflict('The event is over; change its time before publishing it.');
    const n = await s.db('group_events').where({ id, state: 'draft' }).update({ state: 'scheduled', updated_at: Date.now() });
    if (!n) throw conflict('The event changed meanwhile.');
    const after = (await this.row(e.tenant_id, id))!;
    const reminders = await this.schedule(after);
    await this.audit(ctx, 'group.event.published', { group: e.group_id, event: id }, { startsAt: after.starts_at, visibility: after.visibility, reminders }, e.label);
    await this.announce(after, a.group, ctx.p.userId);
    return this.eventView(after, a, await this.counts(id));
  }

  async get(p: Principal, id: string) {
    const { e, a } = await this.load(p, id);
    const mine = await this.db('group_event_rsvps').where({ event_id: id, user_id: p.userId }).first();
    const row = mine ? rsvpFrom(mine) : null;
    return this.eventView(e, a, await this.counts(id), row, row?.response === 'waitlisted' ? await this.position(id, row) : null);
  }

  async list(p: Principal, groupId: string, q: { from?: number | undefined; to?: number | undefined; includeCancelled?: boolean | undefined }) {
    const a = await this.s().groups.require(p, groupId, 'read');
    const rows = ((await this.db('group_events').where({ group_id: groupId }).modify((qb) => {
      if (q.from != null) qb.andWhere('ends_at', '>=', q.from);
      if (q.to != null) qb.andWhere('starts_at', '<=', q.to);
      const states = ['scheduled', ...(q.includeCancelled ? ['cancelled'] : []), ...(can(a, 'moderate') ? ['hidden'] : []), ...(can(a, 'events') ? ['draft'] : [])];
      qb.whereIn('state', states);
    }).orderBy('starts_at').limit(500)) as Record<string, unknown>[]).map(eventFrom).filter((e) => this.readable(e, a, p));
    return Promise.all(rows.map((e) => this.eventView(e, a)));
  }

  /**
   * The caller's own calendar: events of groups they belong to, and events they said they would attend. 1.6.0
   * (B-4403): `near` keeps the events whose point is within the distance, nearest first, with `distanceKm`.
   */
  async mine(p: Principal, q: { from: number; to: number; near?: Near | null }) {
    const rows = await this.visibleFor(p, q);
    if (!q.near) return Promise.all(rows.map(({ e, a }) => this.eventView(e, a)));
    const near = q.near;
    const hits = rows.map((x) => ({ ...x, d: distanceKm(near, { lat: x.e.lat!, lon: x.e.lon! }) })).filter((x) => x.d <= near.km).sort((x, y) => x.d - y.d || x.e.starts_at - y.e.starts_at);
    return Promise.all(hits.map(async ({ e, a, d }) => ({ ...(await this.eventView(e, a)), distanceKm: Math.round(d * 1000) / 1000 })));
  }

  private async visibleFor(p: Principal, q: { from: number; to: number; includeCancelled?: boolean; near?: Near | null }): Promise<{ e: EventRow; a: Access }[]> {
    const s = this.s();
    const groupIds = ((await this.db('group_members').where({ tenant_id: p.tenantId, user_id: p.userId }).select('group_id')) as { group_id: string }[]).map((r) => r.group_id);
    const rsvped = this.db('group_event_rsvps').where({ tenant_id: p.tenantId, user_id: p.userId }).whereIn('response', ['going', 'maybe']).select('event_id');
    const base = this.db('group_events');
    if (q.near) await narrow(this.db, base, 'group_events', q.near);
    const rows = ((await base
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
      if (a && this.readable(e, a, p)) out.push({ e, a });
    }
    return out;
  }

  async update(ctx: Ctx, id: string, patch: { [K in keyof EventInput]?: EventInput[K] | undefined }) {
    const s = this.s();
    const { e, a } = await this.load(ctx.p, id, 'events');
    if (e.state !== 'scheduled' && e.state !== 'draft') throw conflict(`The event is ${e.state}.`);
    const draft = e.state === 'draft';
    const upd: Record<string, unknown> = { updated_at: Date.now() };
    const seal = (v: string | null | undefined, kind: string) => (v ? s.keys.seal(e.tenant_id, v, `event-${kind}:${id}`) : Promise.resolve(null));
    if (patch.title !== undefined) upd.title = await seal(patch.title, 'title');
    if (patch.description !== undefined) upd.description = await seal(patch.description, 'description');
    if (patch.location !== undefined) upd.location = await seal(patch.location, 'location');
    if (patch.capacity !== undefined) upd.capacity = patch.capacity;
    if (patch.maxGuests !== undefined) upd.max_guests = patch.maxGuests;
    if (patch.lat !== undefined || patch.lon !== undefined) Object.assign(upd, pointOf(patch.lat === undefined ? e.lat : patch.lat, patch.lon === undefined ? e.lon : patch.lon));
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
    // 1.7.0 (B-9707)
    if (patch.kind !== undefined) upd.kind = patch.kind;
    if (patch.virtualUrl !== undefined) upd.virtual_url = patch.virtualUrl ? await seal(await this.screenUrl(ctx, a.group, id, patch.virtualUrl), 'url') : null;
    if (patch.visibility !== undefined) upd.visibility = patch.visibility;
    if (patch.rsvpDeadline !== undefined) upd.rsvp_deadline = this.deadlineOf(patch.rsvpDeadline, Number(upd.ends_at ?? e.ends_at));
    if (patch.rsvpApproval !== undefined) upd.rsvp_approval = patch.rsvpApproval;
    if (patch.waitlist !== undefined) upd.waitlist = patch.waitlist;
    const visible = timeChanged || patch.title !== undefined || patch.location !== undefined || patch.description !== undefined || patch.lat !== undefined || patch.lon !== undefined;
    if (visible && !draft) upd.sequence = e.sequence + 1;
    await s.db('group_events').where({ id }).update(upd);
    const after = (await this.row(e.tenant_id, id))!;
    let reminders: number[] | undefined;
    if (timeChanged || patch.reminders !== undefined) {
      await this.cancelReminders(e.tenant_id, id);
      reminders = await this.schedule(after);
    }
    // 1.7.0 (B-9708): a change of time tells the attendees, once.
    const moved = after.starts_at !== e.starts_at || after.ends_at !== e.ends_at || after.time_zone !== e.time_zone || after.all_day !== e.all_day;
    const notified = moved && !draft ? await this.noticeRescheduled(e, after, a.group, ctx.p.userId) : undefined;
    // B-9707: more room (a larger capacity) goes to the waitlist; who may read the event can change with its visibility.
    const promoted = !draft && (patch.capacity !== undefined || patch.maxGuests !== undefined) ? await this.promote(id) : [];
    await this.audit(ctx, 'group.event.updated', { group: e.group_id, event: id }, { changed: Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined), ...(notified !== undefined ? { attendeesNotified: notified } : {}), ...(timeChanged ? { before: { startsAt: e.starts_at, endsAt: e.ends_at, timeZone: e.time_zone }, after: { startsAt: after.starts_at, endsAt: after.ends_at, timeZone: after.time_zone } } : {}), ...(reminders ? { reminders } : {}) }, e.label);
    if (!draft) {
      s.groups.event(e.tenant_id, 'group.event.updated', e.label, { group: e.group_id, workspace: e.workspace_id, actor: ctx.p.userId, event: id, startsAt: new Date(after.starts_at).toISOString() });
      s.groups.room(a.group, 'group.event.updated', { eventId: id, sequence: after.sequence });
    }
    return { ...(await this.eventView(after, a, await this.counts(id))), ...(notified !== undefined ? { notified } : {}), ...(promoted.length ? { promoted: promoted.length } : {}) };
  }

  /** The attendees (going or maybe) who can read the event now: active, in the workspace, cleared, let into the group. */
  private async attendeesWithAccess(e: EventRow, exceptUserId?: string | null): Promise<string[]> {
    const s = this.s();
    const out: string[] = [];
    for (const userId of await this.attendeeIds(e.id)) {
      if (userId === exceptUserId) continue;
      const p = await loadPrincipal(s, e.tenant_id, userId, {});
      if (p && this.readable(e, await s.groups.accessOrNull(p, e.group_id), p)) out.push(userId);
    }
    return out;
  }

  /**
   * Tells the attendees of a new time. The notice row is written first, under a key unique to the event and its
   * sequence: a second attempt for the same change (a retry, another instance) finds the row and sends nothing.
   */
  private async noticeRescheduled(before: EventRow, after: EventRow, g: GroupRow, actorId: string): Promise<number> {
    const s = this.s();
    const id = ulid();
    try {
      await s.db('group_event_notices').insert({ id, tenant_id: after.tenant_id, event_id: after.id, group_id: after.group_id, kind: 'rescheduled', dedupe: `rescheduled:${after.id}:${after.sequence}`, body: null, recipients: 0, created_by: actorId, created_at: Date.now() });
    } catch (err) {
      if (isUniqueViolation(err)) return 0;
      throw err;
    }
    const to = await this.attendeesWithAccess(after, actorId);
    if (to.length) {
      const when = describeTime(after.starts_at, after.time_zone, after.all_day);
      const was = describeTime(before.starts_at, before.time_zone, before.all_day);
      await s.notifications.notify({ tenantId: after.tenant_id, userIds: to, kind: 'event.rescheduled', title: `An event in ${g.name} was moved`, body: `It now starts ${when} (it was ${was}).`, route: `groups?id=${g.id}&event=${after.id}`, label: after.label, emailTemplate: { name: 'event-notice', vars: { event: 'An event you plan to attend was moved', when, detail: `It was due to start ${was}.` } } });
      await s.db('group_event_notices').where({ id }).update({ recipients: to.length });
    }
    return to.length;
  }

  /**
   * "Notify attendees" (B-9708): an organiser's message to the attendees who can read the event now. The text passes
   * the `user-input` guardrail and is kept sealed with the event; the notification says only that there is a message.
   */
  async notifyAttendees(ctx: Ctx, id: string, message: string) {
    const s = this.s();
    const { e, a } = await this.load(ctx.p, id, 'events');
    if (e.state !== 'scheduled') throw conflict(`The event is ${e.state}.`);
    const since = Date.now() - 86_400_000;
    const sent = (await s.db('group_event_notices').where({ event_id: id, kind: 'message' }).andWhere('created_at', '>', since).orderBy('created_at').select('created_at')) as { created_at: number | string }[];
    if (sent.length >= NOTICES_PER_DAY) throw tooManyRequests(`An event's attendees are sent at most ${NOTICES_PER_DAY} messages in 24 hours.`, Math.max(1, Math.ceil((Number(sent[0]!.created_at) + 86_400_000 - Date.now()) / 1000)));
    const noticeId = ulid();
    const d = await s.guardrails.check({ tenantId: e.tenant_id, workspaceId: e.workspace_id, checkpoint: 'user-input', text: message, label: e.label, principal: ctx.p, source: { kind: EVENT_OBJECT_NOTICE, id: noticeId }, meta: { objectType: EVENT_OBJECT_NOTICE, group: e.group_id, event: id } });
    if (d.action === 'block' || d.action === 'require-approval') throw new HttpProblem(422, 'Blocked by guardrails', d.reason ?? 'The message was blocked by a guardrail rule.', { extensions: { step: 'guardrails', action: d.action } });
    const text = d.action === 'redact' ? d.text : message;
    const to = await this.attendeesWithAccess(e, ctx.p.userId);
    const t = Date.now();
    await s.db('group_event_notices').insert({ id: noticeId, tenant_id: e.tenant_id, event_id: id, group_id: e.group_id, kind: 'message', dedupe: null, body: await s.keys.seal(e.tenant_id, text, `event-notice:${noticeId}`), recipients: to.length, created_by: ctx.p.userId, created_at: t });
    if (to.length) {
      const when = describeTime(e.starts_at, e.time_zone, e.all_day);
      await s.notifications.notify({ tenantId: e.tenant_id, userIds: to, kind: 'event.notice', title: `A message about an event in ${a.group.name}`, body: `The organiser wrote to the attendees of the event that starts ${when}. Open the event to read it.`, route: `groups?id=${a.group.id}&event=${id}`, label: e.label, emailTemplate: { name: 'event-notice', vars: { event: 'The organiser of an event you plan to attend sent a message', when, detail: 'Sign in and open the event to read it.' } } });
    }
    await this.audit(ctx, 'group.event.notice.sent', { group: e.group_id, event: id, notice: noticeId }, { attendeesNotified: to.length, ...(d.action === 'redact' ? { redacted: true } : {}) }, e.label);
    s.groups.room(a.group, 'group.event.notice', { eventId: id, noticeId });
    return { id: noticeId, eventId: id, kind: 'message' as const, message: text, notified: to.length, createdBy: ctx.p.userId, createdAt: t };
  }

  /** The notices of an event, newest first, for whoever may read it: changes of time and the organisers' messages. */
  async notices(p: Principal, id: string) {
    const { e } = await this.load(p, id);
    const rows = (await this.db('group_event_notices').where({ event_id: id }).orderBy('created_at', 'desc').limit(100)) as { id: string; kind: string; body: string | null; recipients: number | string; created_by: string | null; created_at: number | string }[];
    return Promise.all(rows.map(async (r) => ({ id: r.id, eventId: id, kind: r.kind, message: r.kind === 'message' ? await this.open(e.tenant_id, r.body, `event-notice:${r.id}`) : null, notified: Number(r.recipients), createdBy: r.created_by, createdAt: Number(r.created_at) })));
  }

  /** Cancels the event: reminders stop, and every attendee (going or maybe) is told in the console and by email. */
  async cancel(ctx: Ctx, id: string, reason: string | null) {
    const s = this.s();
    const { e, a } = await this.load(ctx.p, id, 'events');
    if (e.state !== 'scheduled' && e.state !== 'draft') throw conflict(`The event is already ${e.state}.`);
    const n = await s.db('group_events').where({ id, state: e.state }).update({ state: 'cancelled', cancel_reason: reason, sequence: e.sequence + 1, updated_at: Date.now() });
    if (!n) throw conflict('The event changed meanwhile.');
    // B-9707: a draft was never announced and has no attendees: it is discarded, and nobody is told.
    if (e.state === 'draft') {
      await this.audit(ctx, 'group.event.cancelled', { group: e.group_id, event: id }, { draft: true, attendeesNotified: 0 }, e.label);
      return { ...(await this.eventView((await this.row(e.tenant_id, id))!, a, await this.counts(id))), notified: 0 };
    }
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
    // B-9705: a member's role must carry the right (every tier does; a custom role may not).
    if ((a.role || a.manager) && !can(a, 'rsvp')) throw new HttpProblem(403, 'Forbidden', `Your role in this group (${a.customRole?.name ?? a.acting}) does not allow this.`, { extensions: { step: 'group-role', right: 'rsvp' } });
    const wants = input.response;
    const t = Date.now();
    if (wants !== 'declined') {
      // B-9707: nobody a ban or suspension keeps out takes a place, and the deadline closes "going" and "maybe".
      await s.groups.bans.assertNone(a.group, ctx.p.userId, 'self');
      if (e.rsvp_deadline != null && t > e.rsvp_deadline) throw new HttpProblem(409, 'RSVPs are closed', `Answers to this event closed ${describeTime(e.rsvp_deadline, e.time_zone, false)}. You can still decline.`, { extensions: { step: 'rsvp-deadline', deadline: new Date(e.rsvp_deadline).toISOString() } });
    }
    const guests = wants === 'going' ? (input.guests ?? 0) : 0;
    if (guests > e.max_guests) throw new HttpProblem(422, 'Too many guests', e.max_guests ? `Bring at most ${e.max_guests} guest${e.max_guests === 1 ? '' : 's'}.` : 'This event does not allow guests.');
    const res: { outcome: RsvpState; freed: boolean } = { outcome: wants, freed: false };
    await s.db.transaction(async (trx) => {
      // B-3603: lock the event row, then count the places from what is committed (and read the capacity and state
      // again: they may have changed while this request waited for the lock).
      const locked = await lockEventRow(trx, id);
      if (!locked) throw notFound('Event');
      if (locked.state !== 'scheduled') throw conflict(`The event is ${locked.state}.`);
      const raw = await trx('group_event_rsvps').where({ event_id: id, user_id: ctx.p.userId }).first();
      const existing = raw ? rsvpFrom(raw) : null;
      const holds = existing?.response === 'going';
      if (wants === 'going') {
        // B-9707: with approval required, a first "going" waits for an organiser (an organiser's own does not).
        if (e.rsvp_approval && !holds && !can(a, 'events')) res.outcome = 'pending';
        else if (locked.capacity != null) {
          const capacity = locked.capacity;
          const rows = (await trx('group_event_rsvps').where({ event_id: id, response: 'going' }).whereNot({ user_id: ctx.p.userId }).select('guests')) as { guests: number }[];
          const taken = rows.reduce((n, r) => n + 1 + Number(r.guests), 0);
          if (taken + 1 + guests > capacity) {
            // A full event with a waitlist queues the answer; someone who holds a place keeps it and is refused the extra guests.
            if (e.waitlist && !holds) res.outcome = 'waitlisted';
            else throw new HttpProblem(409, 'Event full', `The event holds ${capacity} people and ${Math.max(0, capacity - taken)} place${capacity - taken === 1 ? ' is' : 's are'} left.`, { extensions: { capacity, left: Math.max(0, capacity - taken) } });
          }
        }
      }
      // The place in the queue is kept by whoever was already waiting the same way.
      const outcome = res.outcome;
      const queued = outcome === 'waitlisted' || outcome === 'pending' ? (existing?.response === outcome ? (existing.queued_at ?? t) : t) : null;
      if (existing) await trx('group_event_rsvps').where({ event_id: id, user_id: ctx.p.userId }).update({ response: outcome, guests, queued_at: queued, updated_at: t, ...(outcome !== existing.response ? { decided_by: null, decided_at: null } : {}) });
      else await trx('group_event_rsvps').insert({ event_id: id, tenant_id: e.tenant_id, user_id: ctx.p.userId, response: outcome, guests, queued_at: queued, checked_in_at: null, checked_in_by: null, created_at: t, updated_at: t });
      res.freed = holds && (outcome !== 'going' || guests < existing!.guests);
    });
    const { outcome, freed } = res;
    await this.audit(ctx, 'group.event.rsvp', { group: e.group_id, event: id, user: ctx.p.userId }, { response: outcome, guests, ...(outcome !== wants ? { asked: wants } : {}) }, e.label);
    s.groups.room(a.group, 'group.event.rsvp', { eventId: id, userId: ctx.p.userId, response: outcome, guests });
    if (outcome === 'pending') {
      const to = (await s.groups.membersWithAccess(a.group, 'events')).filter((u) => u !== ctx.p.userId);
      if (to.length) await s.notifications.notify({ tenantId: e.tenant_id, userIds: to, kind: 'event.rsvp.request', title: `${ctx.p.displayName} asked to attend an event in ${a.group.name}`, route: `groups?id=${a.group.id}&event=${id}`, label: e.label });
    }
    // B-9707: a freed place goes to the waitlist.
    const promoted = freed ? await this.promote(id) : [];
    const mine = outcome === 'waitlisted' ? await this.db('group_event_rsvps').where({ event_id: id, user_id: ctx.p.userId }).first() : null;
    return { eventId: id, response: outcome, guests, attendance: await this.counts(id), ...(mine ? { position: await this.position(id, rsvpFrom(mine)) } : {}), ...(promoted.length ? { promoted: promoted.length } : {}) };
  }

  /** A waitlisted answer's place in the queue, from 1. */
  private async position(eventId: string, r: RsvpRow): Promise<number> {
    const q = r.queued_at ?? r.updated_at;
    const ahead = (await this.db('group_event_rsvps').where({ event_id: eventId, response: 'waitlisted' }).andWhere((w) => { void w.where('queued_at', '<', q).orWhere((o) => { void o.where('queued_at', q).andWhere('user_id', '<', r.user_id); }); }).count({ n: '*' })) as { n: number | string }[];
    return Number(ahead[0]?.n ?? 0) + 1;
  }

  /**
   * B-9707: gives the places that are free to the waitlist, in the order people joined it. Someone who may no longer
   * attend (banned, suspended, out of the workspace, below the label, or outside the event's visibility) is passed
   * over and stays on the list; so is a party too large for what is left. Who may attend is decided first; the places
   * are then counted and given under the event row's lock, each with an update that only moves a row still
   * `waitlisted`, so two instances freeing places at once never give one place twice or promote one person twice.
   */
  async promote(eventId: string): Promise<string[]> {
    const s = this.s();
    const raw = await s.db('group_events').where({ id: eventId }).first();
    const e = raw ? eventFrom(raw) : null;
    if (!e || e.state !== 'scheduled' || e.ends_at < Date.now()) return [];
    const waiting = ((await s.db('group_event_rsvps').where({ event_id: eventId, response: 'waitlisted' }).orderBy('queued_at').orderBy('user_id').limit(500)) as Record<string, unknown>[]).map(rsvpFrom);
    if (!waiting.length) return [];
    const eligible: RsvpRow[] = [];
    for (const r of waiting) if (await this.mayAttend(e, r.user_id)) eligible.push(r);
    if (!eligible.length) return [];
    const promoted: RsvpRow[] = [];
    const t = Date.now();
    await s.db.transaction(async (trx) => {
      const locked = await lockEventRow(trx, eventId);
      if (!locked || locked.state !== 'scheduled') return;
      const going = (await trx('group_event_rsvps').where({ event_id: eventId, response: 'going' }).select('guests')) as { guests: number }[];
      let left = locked.capacity == null ? Number.MAX_SAFE_INTEGER : locked.capacity - going.reduce((n, r) => n + 1 + Number(r.guests), 0);
      for (const r of eligible) {
        if (left < 1) break;
        const need = 1 + r.guests;
        if (need > left) continue;
        const n = await trx('group_event_rsvps').where({ event_id: eventId, user_id: r.user_id, response: 'waitlisted' }).update({ response: 'going', queued_at: null, updated_at: t });
        if (!n) continue;
        left -= need;
        promoted.push(r);
      }
    });
    if (!promoted.length) return [];
    const g = await s.groups.row(e.tenant_id, e.group_id);
    const when = describeTime(e.starts_at, e.time_zone, e.all_day);
    for (const r of promoted) {
      await s.audit.append({ tenantId: e.tenant_id, action: 'group.event.waitlist.promoted', kind: 'system', actor: { service: 'calendar' }, target: { group: e.group_id, event: e.id, user: r.user_id }, label: e.label, detail: { guests: r.guests, queuedAt: r.queued_at ?? null } });
      if (g) s.groups.room(g, 'group.event.rsvp', { eventId: e.id, userId: r.user_id, response: 'going', guests: r.guests });
    }
    await s.notifications.notify({ tenantId: e.tenant_id, userIds: promoted.map((r) => r.user_id), kind: 'event.waitlist.promoted', title: `A place opened: you are going to an event in ${g?.name ?? 'your group'}`, body: `You were first on the waitlist. It starts ${when}.`, route: `groups?id=${e.group_id}&event=${e.id}`, label: e.label, emailTemplate: { name: 'event-notice', vars: { event: 'A place opened at an event you were waiting for', when, detail: 'You are now down as going. Decline if you can no longer attend.' } } });
    return promoted.map((r) => r.user_id);
  }

  /**
   * B-9707: an organiser approves or declines a "going" that waits for approval. An approved answer takes a place if
   * there is one, joins the waitlist if the event has one, and is otherwise refused (the event is full). Audited.
   */
  async decideRsvp(ctx: Ctx, id: string, userId: string, decision: 'approve' | 'decline') {
    const s = this.s();
    const { e, a } = await this.load(ctx.p, id, 'events');
    if (e.state !== 'scheduled') throw conflict(`The event is ${e.state}.`);
    if (userId === ctx.p.userId) throw new HttpProblem(403, 'Forbidden', 'Someone else decides your own answer.', { extensions: { step: 'self-approval' } });
    if (decision === 'approve' && !(await this.mayAttend(e, userId))) throw new HttpProblem(422, 'Cannot attend', 'This person can no longer attend the event (banned or suspended, outside the group’s workspace, below its label, or outside the event’s visibility). Decline the answer instead.', { extensions: { step: 'attendee' } });
    const res: { outcome: RsvpState } = { outcome: 'declined' };
    const t = Date.now();
    await s.db.transaction(async (trx) => {
      const locked = await lockEventRow(trx, id);
      if (!locked || locked.state !== 'scheduled') throw conflict('The event changed meanwhile.');
      const raw = await trx('group_event_rsvps').where({ event_id: id, user_id: userId }).first();
      const r = raw ? rsvpFrom(raw) : null;
      if (!r || r.response !== 'pending') throw new HttpProblem(409, 'Nothing to decide', 'This person has no answer waiting for approval.', { extensions: { step: 'rsvp' } });
      let queued: number | null = null;
      if (decision === 'approve') {
        res.outcome = 'going';
        if (locked.capacity != null) {
          const rows = (await trx('group_event_rsvps').where({ event_id: id, response: 'going' }).select('guests')) as { guests: number }[];
          const taken = rows.reduce((n, x) => n + 1 + Number(x.guests), 0);
          if (taken + 1 + r.guests > locked.capacity) {
            if (!e.waitlist) throw new HttpProblem(409, 'Event full', `The event holds ${locked.capacity} people and ${Math.max(0, locked.capacity - taken)} place${locked.capacity - taken === 1 ? ' is' : 's are'} left.`, { extensions: { capacity: locked.capacity, left: Math.max(0, locked.capacity - taken) } });
            res.outcome = 'waitlisted';
            queued = r.queued_at ?? t;
          }
        }
      }
      const n = await trx('group_event_rsvps').where({ event_id: id, user_id: userId, response: 'pending' }).update({ response: res.outcome, queued_at: queued, decided_by: ctx.p.userId, decided_at: t, updated_at: t });
      if (!n) throw conflict('The answer changed meanwhile.');
    });
    const outcome = res.outcome;
    await this.audit(ctx, decision === 'approve' ? 'group.event.rsvp.approved' : 'group.event.rsvp.declined', { group: e.group_id, event: id, user: userId }, { outcome }, e.label);
    s.groups.room(a.group, 'group.event.rsvp', { eventId: id, userId, response: outcome });
    const told = await loadPrincipal(s, e.tenant_id, userId, {});
    if (told && this.readable(e, await s.groups.accessOrNull(told, e.group_id), told)) {
      const title = outcome === 'going' ? `You are going to an event in ${a.group.name}` : outcome === 'waitlisted' ? `You are on the waitlist for an event in ${a.group.name}` : `Your request to attend an event in ${a.group.name} was declined`;
      await s.notifications.notify({ tenantId: e.tenant_id, userIds: [userId], kind: 'event.rsvp.decided', title, route: `groups?id=${a.group.id}&event=${id}`, label: e.label });
    }
    return { eventId: id, userId, response: outcome, attendance: await this.counts(id) };
  }

  /**
   * An event's attendees. 1.7.0 (B-9704): `q` matches the user name or the display name, `response` keeps one answer,
   * and with `limit` or `cursor` the answer is a page cut by keyset on (first answered, user id); without them it is
   * the whole list by display name, as before.
   */
  async attendees(p: Principal, id: string, q?: undefined): Promise<AttendeeView[]>;
  async attendees(p: Principal, id: string, q: PageQuery & { response?: RsvpState | undefined }): Promise<AttendeeView[] | Page<AttendeeView>>;
  async attendees(p: Principal, id: string, q: PageQuery & { response?: RsvpState | undefined } = {}): Promise<AttendeeView[] | Page<AttendeeView>> {
    const { a } = await this.load(p, id);
    const mod = can(a, 'check-in');
    // B-9707: who waits (for a place or for approval) is the organisers' to see.
    const organiser = can(a, 'events');
    const like = likeOf(q.q);
    const shown: RsvpState[] = [...(mod ? (['going', 'maybe', 'declined'] as const) : (['going', 'maybe'] as const)), ...(organiser ? (['waitlisted', 'pending'] as const) : [])];
    const base = () => this.db('group_event_rsvps as r').join('users as u', 'u.id', 'r.user_id').where({ 'r.event_id': id }).whereIn('r.response', q.response ? shown.filter((x) => x === q.response) : shown).modify((qb) => {
      if (like) qb.andWhere((w) => { void w.whereRaw('lower(u.username) like ?', [like]).orWhereRaw('lower(u.display_name) like ?', [like]); });
    });
    const view = (raw: Record<string, unknown>): AttendeeView => {
      const r = rsvpFrom(raw);
      return { userId: r.user_id, username: String(raw.username), displayName: String(raw.display_name), response: r.response, guests: r.guests, respondedAt: r.updated_at, ...(mod || r.user_id === p.userId ? { checkedIn: r.checked_in_at != null, checkedInAt: r.checked_in_at } : {}), ...(organiser && r.queued_at != null ? { queuedAt: r.queued_at } : {}) };
    };
    if (!paged(q)) return ((await base().orderBy('u.display_name').orderBy('r.user_id').select('r.*', 'u.username', 'u.display_name')) as Record<string, unknown>[]).map(view);
    const size = pageSize(q);
    const rows = (await base().modify((qb) => {
      if (!q.cursor) return;
      const [t, uid] = decodeCursor(q.cursor, ['number', 'string'] as const);
      qb.andWhere((w) => { void w.where('r.created_at', '>', t).orWhere((o) => { void o.where('r.created_at', t).andWhere('r.user_id', '>', uid); }); });
    }).orderBy('r.created_at').orderBy('r.user_id').limit(size + 1).select('r.*', 'u.username', 'u.display_name')) as Record<string, unknown>[];
    const total = Number(((await base().count({ n: '*' })) as { n: number | string }[])[0]?.n ?? 0);
    const items = rows.slice(0, size).map(view);
    const last = rows.length > size ? rows[size - 1] : null;
    return { items, next: last ? encodeCursor([Number(last.created_at), String(last.user_id)]) : null, total };
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
      if (!target || !this.readable(e, await s.groups.accessOrNull(target, e.group_id), target)) throw new HttpProblem(422, 'Cannot check in', 'The user cannot see this event (outside the group’s workspace, below its label, or not in a private group).');
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
      const recipients = await this.attendeesWithAccess(e);
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
    return this.feedKeys()[0]!;
  }

  /** 1.7.0 (B-9205): one key per accepted version of the platform key `feed`, the current first. */
  private feedKeys(): Buffer[] {
    return this.s().sysKeys.key('feed').all().map((secret) => {
      let k = this.feedKeyCache.get(secret);
      if (!k) {
        if (this.feedKeyCache.size > 16) this.feedKeyCache.clear();
        this.feedKeyCache.set(secret, (k = Buffer.from(hkdfSync('sha256', secret, 'exprsn-ai', 'calendar-feed-signature-v1', 32))));
      }
      return k;
    });
  }

  /** base64url HMAC-SHA256 over the feed's identity: a different id, tenant, owner or target needs a new signature. */
  sign(f: Pick<FeedRow, 'id' | 'tenant_id' | 'user_id' | 'kind' | 'target_id'>, key = this.feedKey()): string {
    return createHmac('sha256', key).update(`v1\n${f.id}\n${f.tenant_id}\n${f.user_id}\n${f.kind}\n${f.target_id ?? ''}`).digest('base64url');
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

  /** `admin`: from Social and messaging (B-4206), where the route already required social:manage. */
  async revokeFeed(ctx: Ctx, id: string, o: { admin?: boolean } = {}) {
    const r = await this.db('calendar_feeds').where({ tenant_id: ctx.p.tenantId, id }).first();
    if (!r) throw notFound('Feed');
    const f = feedFrom(r);
    // Owners revoke their own feeds; groups:manage holders (and social:manage, from the admin screen) any feed in the tenant.
    if (f.user_id !== ctx.p.userId && !o.admin && !effectivePermissions(ctx.p).has('groups:manage')) throw notFound('Feed');
    if (f.revoked_at) return this.feedView(f);
    await this.db('calendar_feeds').where({ id: f.id }).update({ revoked_at: Date.now(), revoked_by: ctx.p.userId });
    await this.audit(ctx, 'calendar.feed.revoked', { feed: f.id, kind: f.kind, owner: f.user_id }, o.admin ? { via: 'social-admin' } : undefined);
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
    // A URL made before the key was rotated carries the previous version's signature: every accepted one is compared.
    let signed = false;
    for (const key of this.feedKeys()) if (safeEqual(this.sign(f ?? { id, tenant_id: '-', user_id: '-', kind: 'user', target_id: null }, key), signature)) signed = true;
    if (!signed || !f || f.revoked_at) return null;
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
      items = rows.filter((e) => this.readable(e, a, p)).map((e) => ({ e, a }));
    } else {
      const e = await this.row(f.tenant_id, f.target_id!);
      const a = e ? await s.groups.accessOrNull(p, e.group_id) : null;
      if (!e || !a || !this.readable(e, a, p) || e.state === 'hidden' || e.state === 'draft') return null;
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
