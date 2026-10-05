import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { escapeText, foldLine, renderCalendar } from '../src/groups/ical.js';
import { describeTime, isTimeZone, localIso, parseEventTime } from '../src/groups/time.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { createLogger, Metrics } from '../src/observability/index.js';
import { attachRealtime } from '../src/realtime/socket.js';
import { createServices, type Services } from '../src/services.js';
import { FakeMail } from './fake-account.js';
import { harness, localUser, login, type Harness } from './helpers.js';

/*
 * Sprint 27c (B-2501 to B-2505): groups in workspaces, events with time zones, reminders as queue jobs, signed
 * iCalendar feeds and reports on group content. The "done when" of each item is a test below:
 *   B-2501 a user outside the workspace cannot join;      B-2502 cancelling notifies every attendee;
 *   B-2503 a reminder fires at its time on one instance;  B-2504 a feed URL with a bad signature is refused;
 *   B-2505 a report on a group post makes a flag.
 */

describe('event time zones (B-2502)', () => {
  it('accepts IANA names and refuses offsets and unknown zones', () => {
    for (const tz of ['Europe/Berlin', 'America/Argentina/Buenos_Aires', 'UTC', 'Asia/Kolkata', 'Etc/GMT+5']) expect(isTimeZone(tz), tz).toBe(true);
    for (const tz of ['Mars/Olympus_Mons', '+05:00', 'Europe/', '', 'Europe/Berlin; DROP', 'a'.repeat(80)]) expect(isTimeZone(tz), tz).toBe(false);
  });

  it('turns wall-clock times into instants, across daylight-saving changes', () => {
    expect(new Date(parseEventTime('2026-11-03T09:00', 'Europe/Berlin')).toISOString()).toBe('2026-11-03T08:00:00.000Z');
    expect(new Date(parseEventTime('2026-07-03T09:00', 'Europe/Berlin')).toISOString()).toBe('2026-07-03T07:00:00.000Z');
    expect(new Date(parseEventTime('2026-07-03T09:00', 'America/New_York')).toISOString()).toBe('2026-07-03T13:00:00.000Z');
    expect(new Date(parseEventTime('2026-07-03T09:00', 'Asia/Kolkata')).toISOString()).toBe('2026-07-03T03:30:00.000Z');
    // a time in the spring gap moves forward by the gap; a repeated autumn time takes the earlier instant
    expect(new Date(parseEventTime('2026-03-29T02:30', 'Europe/Berlin')).toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(new Date(parseEventTime('2026-10-25T02:30', 'Europe/Berlin')).toISOString()).toBe('2026-10-25T00:30:00.000Z');
    // an instant with an offset is taken as it is, whatever the zone
    expect(new Date(parseEventTime('2026-11-03T09:00:00+01:00', 'Asia/Tokyo')).toISOString()).toBe('2026-11-03T08:00:00.000Z');
    expect(() => parseEventTime('2026-02-30T09:00', 'UTC')).toThrow(/valid/);
    expect(() => parseEventTime('next tuesday', 'UTC')).toThrow(/ISO 8601/);
    expect(localIso(Date.parse('2026-11-03T08:00:00Z'), 'Europe/Berlin')).toBe('2026-11-03T09:00:00');
    expect(describeTime(Date.parse('2026-11-03T08:00:00Z'), 'Europe/Berlin')).toMatch(/3 Nov 2026.*09:00 \(Europe\/Berlin\)/);
  });
});

describe('iCalendar (B-2504)', () => {
  it('escapes text values', () => {
    expect(escapeText('Budget, Q3; review\\notes\nline two\r\nthree')).toBe('Budget\\, Q3\\; review\\\\notes\\nline two\\nthree');
    expect(escapeText('bell\u0007here')).toBe('bellhere');
  });

  it('folds lines at 75 octets without splitting UTF-8 sequences', () => {
    const line = `SUMMARY:${'Überprüfung der Ausgaben für das Quartal – 日本語のテキスト '.repeat(4)}`;
    const folded = foldLine(line);
    const physical = folded.split('\r\n');
    expect(physical.length).toBeGreaterThan(2);
    for (const [i, l] of physical.entries()) {
      expect(Buffer.byteLength(l, 'utf8')).toBeLessThanOrEqual(75);
      if (i > 0) expect(l.startsWith(' ')).toBe(true);
      expect(l).not.toContain('�');
    }
    // unfolding (RFC 5545 3.1) gives the line back
    expect(folded.replace(/\r\n /g, '')).toBe(line);
  });

  it('renders UTC times, all-day dates in the event zone, and CRLF line ends', () => {
    const ics = renderCalendar(
      {
        name: 'Team, events',
        timeZone: 'Europe/Berlin',
        events: [
          { uid: 'a@x', summary: 'Plan; review', start: Date.parse('2026-11-03T08:00:00Z'), end: Date.parse('2026-11-03T09:00:00Z'), timeZone: 'Europe/Berlin', allDay: false, status: 'CONFIRMED', sequence: 2, created: 0, updated: 0, klass: 'PRIVATE' },
          { uid: 'b@x', summary: 'Offsite', start: Date.parse('2026-11-03T23:00:00Z'), end: Date.parse('2026-11-05T23:00:00Z'), timeZone: 'Europe/Berlin', allDay: true, status: 'CANCELLED', sequence: 1, created: 0, updated: 0, klass: 'PUBLIC' }
        ]
      },
      Date.parse('2026-10-01T00:00:00Z')
    );
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.split('\r\n').every((l) => !l.includes('\n'))).toBe(true);
    expect(ics).toContain('X-WR-CALNAME:Team\\, events');
    expect(ics).toContain('DTSTART:20261103T080000Z\r\nDTEND:20261103T090000Z');
    expect(ics).toContain('SUMMARY:Plan\\; review');
    expect(ics).toContain('SEQUENCE:2');
    // 00:00 on 4 November in Berlin, for two days: the end date is exclusive
    expect(ics).toContain('DTSTART;VALUE=DATE:20261104\r\nDTEND;VALUE=DATE:20261106');
    expect(ics).toContain('STATUS:CANCELLED');
    expect(ics).toContain('DTSTAMP:20261001T000000Z');
  });
});

type Member = Awaited<ReturnType<typeof memberOf>>;

async function memberOf(h: Harness, name: string, workspaces: string[], roles: string[] = ['member'], clearance: 'public' | 'internal' | 'confidential' = 'internal') {
  const user = await localUser(h, name, roles, clearance);
  await h.s.db('users').where({ id: user.id }).update({ email: `${name}@example.test` });
  for (const w of workspaces) await h.s.tenants.addMember(w, user.id);
  const c = await login(h, name);
  const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
  return {
    user,
    ...c,
    post: (p: string, b?: object) => send('post', p, b),
    patch: (p: string, b?: object) => send('patch', p, b),
    del: (p: string) => send('delete', p),
    get: (p: string) => c.agent.get(p),
    principal: async () => (await loadPrincipal(h.s, h.tenantId, user.id, {}))!
  };
}

/** A wall-clock time `days` from now in UTC, as the API takes it (`YYYY-MM-DDTHH:MM`). */
const wall = (ms: number) => new Date(ms).toISOString().slice(0, 16);

describe('groups and events (Sprint 27c)', () => {
  let h: Harness;
  let mail: FakeMail;
  let wsA: string;
  let wsB: string;
  let alice: Member;
  let bob: Member;
  let carol: Member;

  beforeEach(async () => {
    mail = new FakeMail();
    // (the first harness of a run can be slow on a cold disk)
    h = await harness({}, { mail });
    wsA = (await h.s.tenants.createWorkspace(h.tenantId, 'Design', 'confidential')).id;
    wsB = (await h.s.tenants.createWorkspace(h.tenantId, 'Legal', 'confidential')).id;
    alice = await memberOf(h, 'alice', [wsA]);
    bob = await memberOf(h, 'bob', [wsA]);
    carol = await memberOf(h, 'carol', [wsB]);
  }, 60_000);
  afterEach(async () => {
    vi.useRealTimers();
    await h.close();
  });

  const group = async (who: Member, body: Record<string, unknown> = {}) => (await who.post('/api/groups', { workspaceId: wsA, name: 'Type crit', visibility: 'private', joinMode: 'request', ...body }).expect(201)).body as { id: string; label: string };

  it('B-2501: a user outside the workspace cannot see, join or be invited to a group; requests are decided by moderators', async () => {
    const g = await group(alice, { description: 'Weekly type critique' });
    expect(g).toMatchObject({ workspaceId: wsA, role: 'owner', visibility: 'private', joinMode: 'request', members: 1, description: 'Weekly type critique' });
    // sealed at rest
    expect((await h.s.db('social_groups').where({ id: g.id }).first()).description).not.toContain('critique');

    // carol is only in another workspace: the group does not exist for her
    await carol.get(`/api/groups/${g.id}`).expect(404);
    await carol.post(`/api/groups/${g.id}/join`).expect(404);
    expect((await carol.get('/api/groups').expect(200)).body).toEqual([]);
    const refused = await alice.post(`/api/groups/${g.id}/invites`, { userId: carol.user.id }).expect(422);
    expect(refused.body.detail).toMatch(/workspace/);
    // even an open public group
    const open = await group(alice, { name: 'Open studio', visibility: 'public', joinMode: 'open' });
    await carol.post(`/api/groups/${open.id}/join`).expect(404);
    expect(await h.s.db('group_members').where({ group_id: open.id, user_id: carol.user.id })).toHaveLength(0);

    // bob, in the workspace, asks; a member cannot decide, the owner accepts
    const asked = await bob.post(`/api/groups/${g.id}/join`).expect(202);
    expect(asked.body.request).toMatchObject({ kind: 'request', state: 'pending', userId: bob.user.id });
    expect((await bob.post(`/api/groups/${g.id}/join`).expect(202)).body.request.id).toBe(asked.body.request.id);
    await bob.get(`/api/groups/${g.id}/posts`).expect(403);
    expect((await alice.get(`/api/groups/${g.id}/requests`).expect(200)).body).toHaveLength(1);
    await alice.post(`/api/group-requests/${asked.body.request.id}/accept`).expect(200);
    expect((await bob.get(`/api/groups/${g.id}`).expect(200)).body).toMatchObject({ role: 'member', members: 2 });
    await bob.post(`/api/groups/${g.id}/invites`, { userId: alice.user.id }).expect(403);

    // open groups take members at once
    expect((await bob.post(`/api/groups/${open.id}/join`).expect(200)).body).toMatchObject({ joined: true, role: 'member' });

    // the last owner cannot leave; roles change only by an owner
    await alice.del(`/api/groups/${g.id}/members/${alice.user.id}`).expect(409);
    await bob.patch(`/api/groups/${g.id}/members/${bob.user.id}`, { role: 'owner' }).expect(403);
    await alice.patch(`/api/groups/${g.id}/members/${bob.user.id}`, { role: 'moderator' }).expect(200);

    // leaving the workspace ends the group for bob at once, though his membership row stays
    await h.s.tenants.removeMember(wsA, bob.user.id);
    await bob.get(`/api/groups/${g.id}`).expect(404);
    await bob.get(`/api/groups/${g.id}/members`).expect(404);

    const actions = (await h.s.db('audit_events').where({ tenant_id: h.tenantId }).where('action', 'like', 'group.%').select('action')).map((r: { action: string }) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['group.created', 'group.request.created', 'group.request.accepted', 'group.member.joined', 'group.member.role']));
  });

  it('B-2501: invitation-only and hidden groups; invitations expire and do not outlive the workspace membership', async () => {
    const dave = await memberOf(h, 'dave', [wsA]);
    const g = await group(alice, { name: 'Board', visibility: 'hidden', joinMode: 'invite' });
    // hidden: unknown to dave until invited
    await dave.get(`/api/groups/${g.id}`).expect(404);
    expect((await dave.get('/api/groups').expect(200)).body).toEqual([]);
    const inv = (await alice.post(`/api/groups/${g.id}/invites`, { userId: dave.user.id }).expect(201)).body;
    expect(inv).toMatchObject({ kind: 'invite', state: 'pending', role: 'member' });
    await alice.post(`/api/groups/${g.id}/invites`, { userId: dave.user.id }).expect(409);
    expect((await dave.get('/api/groups').expect(200)).body.map((x: { id: string }) => x.id)).toEqual([g.id]);
    expect((await dave.get('/api/group-requests').expect(200)).body).toMatchObject([{ id: inv.id, groupName: 'Board' }]);
    // the inviter cannot answer for the invitee
    await alice.post(`/api/group-requests/${inv.id}/accept`).expect(403);
    // expired
    await h.s.db('group_requests').where({ id: inv.id }).update({ expires_at: Date.now() - 1 });
    await dave.post(`/api/group-requests/${inv.id}/accept`).expect(410);
    expect((await h.s.db('group_requests').where({ id: inv.id }).first()).state).toBe('expired');
    await dave.get(`/api/groups/${g.id}`).expect(404);
    // a fresh invitation, then dave leaves the workspace before accepting
    const again = (await alice.post(`/api/groups/${g.id}/invites`, { userId: dave.user.id }).expect(201)).body;
    await h.s.tenants.removeMember(wsA, dave.user.id);
    await dave.post(`/api/group-requests/${again.id}/accept`).expect(404);
    await h.s.tenants.addMember(wsA, dave.user.id);
    // invitation-only: joining without one is refused, accepting it works
    const g2 = await group(alice, { name: 'Panel', visibility: 'private', joinMode: 'invite' });
    await dave.post(`/api/groups/${g2.id}/join`).expect(403);
    await dave.post(`/api/group-requests/${again.id}/accept`).expect(200);
    expect((await dave.get(`/api/groups/${g.id}`).expect(200)).body.role).toBe('member');
  });

  it('B-2501: the group label bounds who joins and reads; rooms follow membership (B-2101)', async () => {
    const boss = await memberOf(h, 'boss', [wsA], ['member'], 'confidential');
    const high = await group(boss, { name: 'Restricted plans', visibility: 'public', joinMode: 'open', label: 'confidential' });
    // bob is cleared internal: a public, open group above that is not there for him
    await bob.get(`/api/groups/${high.id}`).expect(404);
    await bob.post(`/api/groups/${high.id}/join`).expect(404);
    expect((await bob.get('/api/groups').expect(200)).body).toEqual([]);
    await boss.post(`/api/groups/${high.id}/invites`, { userId: bob.user.id }).expect(422);
    await alice.post('/api/groups', { workspaceId: wsA, name: 'Too high', visibility: 'private', joinMode: 'open', label: 'restricted' }).expect(422);
    await alice.post('/api/groups', { workspaceId: wsA, name: 'Above me', visibility: 'private', joinMode: 'open', label: 'confidential' }).expect(403);

    const g = await group(alice, { name: 'Plans', visibility: 'public', joinMode: 'open' });
    await bob.post(`/api/groups/${g.id}/join`).expect(200);
    const pBob = await bob.principal();
    expect(await h.s.rooms.authorize(pBob, 'group', g.id)).toEqual({ label: 'internal', workspaceId: wsA });
    expect(await h.s.rooms.authorize(await carol.principal(), 'group', g.id)).toBeNull();
    const closed: unknown[] = [];
    const off = h.s.bus.on('room.access', (e) => void closed.push(e));
    await alice.del(`/api/groups/${g.id}/members/${bob.user.id}`).expect(200);
    off();
    expect(closed).toContainEqual({ tenantId: h.tenantId, kind: 'group', id: g.id, userIds: [bob.user.id] });
    // public group: bob may still read it (and be in its room) as a workspace member, but private ones close
    await alice.patch(`/api/groups/${g.id}`, { visibility: 'private' }).expect(200);
    expect(await h.s.rooms.authorize(pBob, 'group', g.id)).toBeNull();
  });

  it('B-2505: posts are sealed and screened; a report on a group post makes a flag in the workspace queue and a case', async () => {
    const reviewer = await memberOf(h, 'rev', [wsA], ['member', 'flag-reviewer']);
    const g = await group(alice, { visibility: 'private', joinMode: 'open' });
    await bob.post(`/api/groups/${g.id}/join`).expect(200);
    const post = (await alice.post(`/api/groups/${g.id}/posts`, { body: 'Draft specimen sheet, do not share' }).expect(201)).body;
    expect(post).toMatchObject({ body: 'Draft specimen sheet, do not share', state: 'published', label: g.label });
    expect((await h.s.db('group_posts').where({ id: post.id }).first()).body).not.toContain('specimen');
    expect((await bob.get(`/api/groups/${g.id}/posts`).expect(200)).body).toMatchObject([{ id: post.id, body: 'Draft specimen sheet, do not share' }]);
    // outsiders cannot report what they cannot see
    await carol.post('/api/moderation/reports', { type: 'group-post', id: post.id, reason: 'Spam' }).expect(404);

    const rep = await bob.post('/api/moderation/reports', { type: 'group-post', id: post.id, reason: 'Leaks a draft', severity: 'high' }).expect(201);
    expect(rep.body).toMatchObject({ duplicate: false, flag: { workspaceId: wsA, severity: 'high' } });
    const flag = await h.s.db('guard_flags').where({ id: rep.body.flag.id }).first();
    expect(flag).toMatchObject({ source_kind: 'group-post', source_id: post.id, workspace_id: wsA, state: 'open' });
    // the group's moderators see it as a case; members do not
    expect((await alice.get(`/api/groups/${g.id}/cases`).expect(200)).body).toMatchObject([{ ref: rep.body.flag.ref, objectType: 'group-post', objectId: post.id, state: 'open' }]);
    await bob.get(`/api/groups/${g.id}/cases`).expect(403);
    // a reviewer hides it: members no longer see it, moderators see it as hidden
    await reviewer.post(`/api/moderation/flags/${rep.body.flag.ref}/action`, { action: 'hide', reason: 'Leak' }).expect(201);
    expect((await h.s.db('group_posts').where({ id: post.id }).first()).state).toBe('hidden');
    expect((await bob.get(`/api/groups/${g.id}/posts`).expect(200)).body).toEqual([]);
    expect((await alice.get(`/api/groups/${g.id}/posts`).expect(200)).body).toMatchObject([{ id: post.id, state: 'hidden', body: null }]);
    // groups and events are moderation objects too
    expect((await bob.get('/api/moderation/types').expect(200)).body.items.map((t: { type: string }) => t.type)).toEqual(expect.arrayContaining(['group', 'group-post', 'group-event']));
    // the author deletes their own post; another member cannot
    const p2 = (await bob.post(`/api/groups/${g.id}/posts`, { body: 'Second' }).expect(201)).body;
    const dave = await memberOf(h, 'dave', [wsA]);
    await dave.post(`/api/groups/${g.id}/join`).expect(200);
    await dave.del(`/api/group-posts/${p2.id}`).expect(403);
    await bob.del(`/api/group-posts/${p2.id}`).expect(200);
  });

  it('B-2502: events in an IANA zone; RSVPs with guests and capacity; attendees and check-in; cancelling notifies every attendee', async () => {
    const dave = await memberOf(h, 'dave', [wsA]);
    const g = await group(alice, { visibility: 'private', joinMode: 'open' });
    for (const m of [bob, dave]) await m.post(`/api/groups/${g.id}/join`).expect(200);
    const startWall = wall(Date.now() + 10 * 86_400_000);
    await alice.post(`/api/groups/${g.id}/events`, { title: 'x', start: startWall, timeZone: 'Mars/Olympus' }).expect(400);
    await alice.post(`/api/groups/${g.id}/events`, { title: 'x', start: startWall, end: startWall, timeZone: 'UTC' }).expect(400);
    await bob.post(`/api/groups/${g.id}/events`, { title: 'x', start: startWall, timeZone: 'UTC' }).expect(403);
    const ev = (await alice.post(`/api/groups/${g.id}/events`, { title: 'Kerning night', description: 'Bring proofs', location: 'Room 4', start: startWall, durationMinutes: 90, timeZone: 'Asia/Kolkata', capacity: 3, maxGuests: 1 }).expect(201)).body;
    expect(ev).toMatchObject({ title: 'Kerning night', timeZone: 'Asia/Kolkata', localStart: `${startWall}:00`, capacity: 3, maxGuests: 1, state: 'scheduled' });
    expect(Date.parse(ev.endsAt) - Date.parse(ev.startsAt)).toBe(90 * 60_000);
    expect(new Date(parseEventTime(startWall, 'Asia/Kolkata')).toISOString()).toBe(ev.startsAt);
    const row = await h.s.db('group_events').where({ id: ev.id }).first();
    expect(row.title).not.toContain('Kerning');
    expect(row.time_zone).toBe('Asia/Kolkata');

    await bob.post(`/api/calendar/events/${ev.id}/rsvp`, { response: 'going', guests: 2 }).expect(422);
    expect((await bob.post(`/api/calendar/events/${ev.id}/rsvp`, { response: 'going', guests: 1 }).expect(200)).body.attendance).toMatchObject({ going: 1, guests: 1 });
    await dave.post(`/api/calendar/events/${ev.id}/rsvp`, { response: 'going', guests: 1 }).expect(409);
    await dave.post(`/api/calendar/events/${ev.id}/rsvp`, { response: 'going' }).expect(200);
    await alice.post(`/api/calendar/events/${ev.id}/rsvp`, { response: 'maybe' }).expect(200);
    await carol.post(`/api/calendar/events/${ev.id}/rsvp`, { response: 'going' }).expect(404);
    const attendees = (await bob.get(`/api/calendar/events/${ev.id}/attendees`).expect(200)).body;
    expect(attendees.map((a: { username: string; response: string }) => `${a.username}:${a.response}`).sort()).toEqual(['alice:maybe', 'bob:going', 'dave:going']);
    // check-in by a moderator only
    await bob.post(`/api/calendar/events/${ev.id}/check-in`, { userId: dave.user.id }).expect(403);
    expect((await alice.post(`/api/calendar/events/${ev.id}/check-in`, { userId: bob.user.id }).expect(200)).body.attendance.checkedIn).toBe(1);
    expect((await alice.get(`/api/calendar/events/${ev.id}/attendees`).expect(200)).body.find((a: { username: string }) => a.username === 'bob')).toMatchObject({ checkedIn: true });
    // my calendar
    expect((await dave.get('/api/calendar/events').expect(200)).body.map((e: { id: string }) => e.id)).toEqual([ev.id]);

    // cancel: every attendee (going or maybe) is told, in the console and by email; nothing sealed leaves
    const cancelled = (await alice.post(`/api/calendar/events/${ev.id}/cancel`, { reason: 'Venue flooded' }).expect(200)).body;
    expect(cancelled).toMatchObject({ state: 'cancelled', notified: 3, sequence: 1 });
    const notes = await h.s.db('notifications').where({ tenant_id: h.tenantId, kind: 'event.cancelled' });
    expect(notes.map((n: { user_id: string }) => n.user_id).sort()).toEqual([alice.user.id, bob.user.id, dave.user.id].sort());
    for (const n of notes) expect(`${n.title} ${n.body}`).not.toMatch(/Kerning|Flooded|Room 4/i);
    for (const who of ['alice', 'bob', 'dave']) {
      const m = await mail.next(`${who}@example.test`);
      expect(m.subject).toMatch(/cancelled/);
      expect(m.text).not.toMatch(/Kerning|flooded/i);
    }
    await bob.post(`/api/calendar/events/${ev.id}/rsvp`, { response: 'going' }).expect(409);
    await alice.post(`/api/calendar/events/${ev.id}/cancel`).expect(409);
  });

  it('B-2503: a reminder fires at its time, on one instance only, across two instances on the same database', async () => {
    const g = await group(alice, { visibility: 'private', joinMode: 'open' });
    await bob.post(`/api/groups/${g.id}/join`).expect(200);
    const start = Date.now() + 3 * 3_600_000;
    const ev = (await alice.post(`/api/groups/${g.id}/events`, { title: 'Proof review', start: new Date(start).toISOString().replace(/\.\d+Z$/, 'Z'), timeZone: 'Europe/Berlin', reminders: [60, 1440] }).expect(201)).body;
    // a day before is already past: only the hour-before reminder is scheduled
    const rems = (await alice.get(`/api/calendar/events/${ev.id}/reminders`).expect(200)).body;
    expect(rems).toMatchObject([{ minutesBefore: 60, state: 'scheduled' }]);
    const fireAt = Date.parse(rems[0].fireAt);
    expect(fireAt).toBe(Date.parse(ev.startsAt) - 3_600_000);
    const job = await h.s.db('jobs').where({ type: 'calendar.reminder' }).first();
    expect(Number(job.run_at)).toBe(fireAt);
    await bob.post(`/api/calendar/events/${ev.id}/rsvp`, { response: 'going' }).expect(200);
    await alice.post(`/api/calendar/events/${ev.id}/rsvp`, { response: 'maybe' }).expect(200);

    // a second instance: its own job queue, bus and services, the same database
    const other: Services = createServices(h.s.cfg, h.s.db, createLogger('silent', false), new Metrics(), { mail });
    try {
      const a = vi.spyOn(h.s.calendar, 'fireReminder');
      const b = vi.spyOn(other.calendar, 'fireReminder');
      // not yet due: neither instance runs it
      await Promise.all([h.s.jobs.runDue(), other.jobs.runDue()]);
      expect(a.mock.calls.length + b.mock.calls.length).toBe(0);
      expect(await h.s.db('notifications').where({ kind: 'event.reminder' })).toHaveLength(0);

      // its time comes: both instances poll at once, exactly one runs it
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(fireAt + 500);
      await Promise.all([h.s.jobs.runDue(), other.jobs.runDue(), h.s.jobs.runDue(), other.jobs.runDue()]);
      expect(a.mock.calls.length + b.mock.calls.length).toBe(1);
      const notes = await h.s.db('notifications').where({ kind: 'event.reminder' });
      expect(notes.map((n: { user_id: string }) => n.user_id).sort()).toEqual([alice.user.id, bob.user.id].sort());
      expect(notes[0].title).toMatch(/in 1 hour/);
      const after = await h.s.db('group_event_reminders').where({ event_id: ev.id }).first();
      expect(after).toMatchObject({ state: 'sent', recipients: 2 });
      expect((await h.s.db('jobs').where({ id: job.id }).first()).state).toBe('succeeded');
      vi.useRealTimers();
      await mail.next('bob@example.test');
      // the job run again (a retry or a duplicate) sends nothing: the reminder row was claimed
      expect(await other.calendar.fireReminder(after.id)).toEqual({ skipped: 'sent' });
      expect(await h.s.db('notifications').where({ kind: 'event.reminder' })).toHaveLength(2);
    } finally {
      vi.useRealTimers();
      await other.close();
    }
  });

  it('B-2503: moving or cancelling an event reschedules or stops its reminders', async () => {
    const g = await group(alice, { visibility: 'private', joinMode: 'open' });
    const start = Date.now() + 5 * 86_400_000;
    const ev = (await alice.post(`/api/groups/${g.id}/events`, { title: 'Launch', start: new Date(start).toISOString(), timeZone: 'UTC', reminders: [60] }).expect(201)).body;
    const first = (await alice.get(`/api/calendar/events/${ev.id}/reminders`).expect(200)).body[0];
    const moved = (await alice.patch(`/api/calendar/events/${ev.id}`, { start: new Date(start + 86_400_000).toISOString() }).expect(200)).body;
    expect(moved.sequence).toBe(1);
    const rems = (await alice.get(`/api/calendar/events/${ev.id}/reminders`).expect(200)).body;
    expect(rems.find((r: { id: string }) => r.id === first.id).state).toBe('cancelled');
    expect(rems.filter((r: { state: string }) => r.state === 'scheduled')).toMatchObject([{ minutesBefore: 60, fireAt: new Date(start + 86_400_000 - 3_600_000).toISOString() }]);
    expect((await h.s.db('jobs').where({ type: 'calendar.reminder', state: 'cancelled' })).length).toBe(1);
    await alice.post(`/api/calendar/events/${ev.id}/cancel`).expect(200);
    expect((await alice.get(`/api/calendar/events/${ev.id}/reminders`).expect(200)).body.every((r: { state: string }) => r.state === 'cancelled')).toBe(true);
  });

  it('B-2504: signed feeds per event, group and user; a bad signature, a revoked feed or a lost membership is refused', async () => {
    const g = await group(alice, { name: 'Type, crit', visibility: 'private', joinMode: 'open' });
    await bob.post(`/api/groups/${g.id}/join`).expect(200);
    const ev = (await alice.post(`/api/groups/${g.id}/events`, { title: 'Review; round 2, final', start: wall(Date.now() + 2 * 86_400_000), timeZone: 'Europe/Berlin' }).expect(201)).body;

    const feed = (await bob.post('/api/calendar/feeds', { kind: 'user' }).expect(201)).body;
    expect(feed.url).toMatch(/^http:\/\/localhost:8080\/calendar\/feeds\/[0-9A-Z]{26}\/[A-Za-z0-9_-]{43}\.ics$/);
    const path = new URL(feed.url).pathname;
    const res = await bob.agent.get(path).set('cookie', '').expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/calendar/);
    expect(res.text).toContain('BEGIN:VEVENT');
    expect(res.text).toContain('SUMMARY:Review\\; round 2\\, final');
    expect(res.text).toContain(`UID:${ev.id}@localhost`);
    expect(res.text).toContain('X-WR-TIMEZONE:Europe/Berlin');
    expect(res.text).toMatch(/DTSTART:\d{8}T\d{6}Z/);

    // a bad signature (one character changed), a signature for another feed, a malformed one: all the same 404
    const [, id, sig] = /\/calendar\/feeds\/([^/]+)\/([^.]+)\.ics$/.exec(path)!;
    const flipped = sig!.slice(0, -1) + (sig!.endsWith('A') ? 'B' : 'A');
    await bob.agent.get(`/calendar/feeds/${id}/${flipped}.ics`).expect(404);
    const other = (await alice.post('/api/calendar/feeds', { kind: 'group', targetId: g.id }).expect(201)).body;
    const otherSig = /\/([^/.]+)\.ics$/.exec(other.url)![1];
    await bob.agent.get(`/calendar/feeds/${id}/${otherSig}.ics`).expect(404);
    await bob.agent.get(`/calendar/feeds/${id}/nope.ics`).expect(404);
    // the group feed and the event feed
    expect((await bob.agent.get(new URL(other.url).pathname).expect(200)).text).toContain('X-WR-CALNAME:Type\\, crit');
    const evFeed = (await bob.post('/api/calendar/feeds', { kind: 'event', targetId: ev.id }).expect(201)).body;
    await bob.agent.get(new URL(evFeed.url).pathname).expect(200);
    await carol.post('/api/calendar/feeds', { kind: 'event', targetId: ev.id }).expect(404);

    // bob leaves the group: his event feed no longer renders; his user feed no longer lists the event
    await bob.del(`/api/groups/${g.id}/members/${bob.user.id}`).expect(200);
    await bob.agent.get(new URL(evFeed.url).pathname).expect(404);
    expect((await bob.agent.get(path).expect(200)).text).not.toContain('BEGIN:VEVENT');
    // revoked
    expect((await bob.del(`/api/calendar/feeds/${feed.id}`).expect(200)).body).toMatchObject({ url: null });
    await bob.agent.get(path).expect(404);
    await carol.del(`/api/calendar/feeds/${evFeed.id}`).expect(404);
    expect((await h.s.db('audit_events').where({ action: 'calendar.feed.revoked' })).length).toBe(1);
  });

  it('B-2504: events above CALENDAR_FEED_MAX_LABEL appear only as busy time', async () => {
    const boss = await memberOf(h, 'boss', [wsA], ['member'], 'confidential');
    const g = await group(boss, { name: 'Board', visibility: 'private', joinMode: 'open', label: 'confidential' });
    await boss.post(`/api/groups/${g.id}/events`, { title: 'Acquisition talks', location: 'HQ', start: wall(Date.now() + 86_400_000), timeZone: 'UTC' }).expect(201);
    const feed = (await boss.post('/api/calendar/feeds', { kind: 'group', targetId: g.id }).expect(201)).body;
    const ics = (await boss.agent.get(new URL(feed.url).pathname).expect(200)).text;
    expect(ics).toContain('SUMMARY:Busy (confidential)');
    expect(ics).toContain('CLASS:CONFIDENTIAL');
    expect(ics).not.toMatch(/Acquisition|HQ/);
  });

  it('deleting a group stops its reminders and closes it; changes are audited and emitted as catalogue events', async () => {
    const g = await group(alice, { visibility: 'public', joinMode: 'open' });
    await alice.post(`/api/groups/${g.id}/events`, { title: 'Later', start: wall(Date.now() + 3 * 86_400_000), timeZone: 'UTC', reminders: [30] }).expect(201);
    await bob.post(`/api/groups/${g.id}/join`).expect(200);
    await bob.del(`/api/groups/${g.id}`).expect(403);
    await alice.del(`/api/groups/${g.id}`).expect(200);
    await bob.get(`/api/groups/${g.id}`).expect(404);
    expect((await h.s.db('group_event_reminders')).every((r: { state: string }) => r.state === 'cancelled')).toBe(true);
    const actions = (await h.s.db('audit_events').where('action', 'like', 'group.%').select('action')).map((r: { action: string }) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['group.created', 'group.event.created', 'group.member.joined', 'group.deleted']));
  });
});

describe('the group room (B-2101 with B-2501)', () => {
  let h: Harness;
  let server: Server;
  let url: string;
  const sockets: Socket[] = [];

  beforeEach(async () => {
    h = await harness();
    server = createServer(h.app);
    attachRealtime(server, h.s);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    for (const x of sockets.splice(0)) x.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await h.close();
  });

  const until = async (fn: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!fn()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  async function connect(m: Member) {
    const sock = ioClient(url, { path: '/socket.io', transports: ['websocket'], reconnection: false, extraHeaders: { cookie: m.cookie } });
    sockets.push(sock);
    await new Promise((r) => sock.on('ready', r));
    const got: { event: string; data: Record<string, unknown> }[] = [];
    sock.onAny((event: string, data: Record<string, unknown>) => void got.push({ event, data }));
    const join = (id: string) => new Promise<{ ok: boolean }>((r) => sock.emit('room.join', { kind: 'group', id }, r));
    return { sock, got, join };
  }

  it('members hear the group; a removed member’s room closes at once; outsiders are never let in', async () => {
    const ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Design', 'internal')).id;
    const other = (await h.s.tenants.createWorkspace(h.tenantId, 'Legal', 'internal')).id;
    const alice = await memberOf(h, 'alice', [ws]);
    const bob = await memberOf(h, 'bob', [ws]);
    const eve = await memberOf(h, 'eve', [other]);
    const g = (await alice.post('/api/groups', { workspaceId: ws, name: 'Crit', visibility: 'private', joinMode: 'open' }).expect(201)).body;
    await bob.post(`/api/groups/${g.id}/join`).expect(200);
    const [a, b, e] = [await connect(alice), await connect(bob), await connect(eve)];
    expect(await a.join(g.id)).toMatchObject({ ok: true });
    expect(await b.join(g.id)).toMatchObject({ ok: true });
    expect(await e.join(g.id)).toMatchObject({ ok: false });

    await alice.post(`/api/groups/${g.id}/posts`, { body: 'one' }).expect(201);
    await until(() => b.got.some((x) => x.event === 'group.post.created'));
    // ids only, never the text; the author does not get their own post back
    expect(b.got.find((x) => x.event === 'group.post.created')!.data).toMatchObject({ kind: 'group', id: g.id, authorId: alice.user.id });
    expect(JSON.stringify(b.got)).not.toContain('one"');
    expect(a.got.some((x) => x.event === 'group.post.created')).toBe(false);

    await alice.del(`/api/groups/${g.id}/members/${bob.user.id}`).expect(200);
    await alice.post(`/api/groups/${g.id}/posts`, { body: 'two' }).expect(201);
    await until(() => b.got.some((x) => x.event === 'room.closed'));
    await new Promise((r) => setTimeout(r, 50));
    expect(b.got.filter((x) => x.event === 'group.post.created')).toHaveLength(1);
    expect(e.got.some((x) => x.event.startsWith('group.'))).toBe(false);
  });
});
