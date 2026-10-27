import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CUSTOM_RIGHTS, GROUP_RIGHTS, TIER_RIGHTS, covers, isStaff, linkRole, ownsGroup, tierRights } from '../src/groups/roles.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * Sprint 42 (1.7.0), groups: custom roles and permission flags (B-9705) and event extras (B-9707).
 * The "done when" of each item is a test below:
 *   B-9705 a custom role with "create events" but not "post" can do the one and not the other;
 *   B-9707 when a "going" place frees up, the first on the waitlist is promoted and notified.
 */

type Person = Awaited<ReturnType<typeof personIn>>;

async function personIn(h: Harness, name: string, workspaces: string[], roles: string[] = ['member']) {
  const user = await localUser(h, name, roles);
  for (const w of workspaces) await h.s.tenants.addMember(w, user.id);
  const c: Client = await login(h, name);
  const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
  return { user, ...c, post: (p: string, b?: object) => send('post', p, b), patch: (p: string, b?: object) => send('patch', p, b), put: (p: string, b?: object) => send('put', p, b), del: (p: string) => send('delete', p), get: (p: string) => c.agent.get(p) };
}

const NUKE = { id: 'nuke', name: 'Never this', checkpoint: 'user-input', type: 'pattern', mechanism: { kind: 'pattern', pattern: '(?i)launch-codes' }, action: 'block', stage: 'enforce' };

async function rules(h: Harness, list: object[]) {
  await localUser(h, 'ga', ['guardrail-admin'], 'confidential');
  const ga = await loginAdmin(h, 'ga');
  const send = (method: 'post' | 'put', url: string, body: object = {}) => ga.agent[method](url).set('x-csrf-token', ga.csrf).send(body);
  const set = (await send('post', '/api/admin/guardrails/sets', { name: 'Group rules', scope: 'tenant' }).expect(201)).body;
  await send('put', `/api/admin/guardrails/sets/${set.id}/draft`, { rules: list }).expect(200);
  await send('post', `/api/admin/guardrails/sets/${set.id}/draft/publish`).expect(200);
}

const audits = async (h: Harness, action: string) => ((await h.s.db('audit_events').where({ action })) as { detail: string | null; target: string | null }[]).map((r) => ({ detail: r.detail ? JSON.parse(r.detail) : null, target: r.target ? JSON.parse(r.target) : null }));
const notes = (h: Harness, userId: string, kind: string) => h.s.db('notifications').where({ tenant_id: h.tenantId, user_id: userId, kind }) as Promise<{ title: string; kind: string }[]>;
const soon = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
const event = (extra: object = {}) => ({ title: 'Critique', start: soon(48), durationMinutes: 60, timeZone: 'UTC', ...extra });

describe('group rights (B-9705): the table every decision reads', () => {
  it('keeps owner, moderator and member exactly as they were before 1.7.0', () => {
    // Frozen copy of the rights table that shipped before custom roles (groups/service.ts, 1.6.0).
    expect([...TIER_RIGHTS.member]).toEqual(['read', 'post', 'rsvp']);
    expect([...TIER_RIGHTS.moderator]).toEqual(['read', 'post', 'rsvp', 'invite', 'decide', 'remove-members', 'moderate', 'events', 'check-in', 'cases', 'channels']);
    expect([...TIER_RIGHTS.owner]).toEqual(['read', 'post', 'rsvp', 'invite', 'decide', 'remove-members', 'moderate', 'events', 'check-in', 'cases', 'channels', 'settings', 'roles', 'delete']);
  });

  it('orders the tiers: nothing exceeds owner, only owner deletes, and a guest holds less than a member', () => {
    expect(new Set(TIER_RIGHTS.owner)).toEqual(new Set(GROUP_RIGHTS));
    for (const tier of ['admin', 'moderator', 'member', 'guest'] as const) {
      expect(covers(tierRights('owner'), tierRights(tier))).toBe(true);
      expect(ownsGroup(tierRights(tier))).toBe(false);
    }
    expect(covers(tierRights('admin'), tierRights('moderator'))).toBe(true);
    expect(covers(tierRights('moderator'), tierRights('admin'))).toBe(false);
    expect(covers(tierRights('member'), tierRights('guest'))).toBe(true);
    expect(tierRights('guest').has('post')).toBe(false);
    expect(CUSTOM_RIGHTS).not.toContain('delete');
    expect(isStaff(tierRights('member'))).toBe(false);
    expect(isStaff(tierRights('guest'))).toBe(false);
    expect(isStaff(tierRights('moderator'))).toBe(true);
    // The linked conversation (B-9709): the mapping the three old tiers had, by rights.
    expect(linkRole(tierRights('owner'))).toBe('owner');
    expect(linkRole(tierRights('moderator'))).toBe('admin');
    expect(linkRole(tierRights('admin'))).toBe('admin');
    expect(linkRole(tierRights('member'))).toBe('member');
    expect(linkRole(tierRights('guest'))).toBe('member');
  });
});

describe('groups: custom roles and event extras (Sprint 42)', () => {
  let h: Harness;
  let ws: string;
  let alice: Person;
  let bob: Person;
  let carol: Person;
  let dave: Person;
  let erin: Person;

  beforeEach(async () => {
    h = await harness();
    ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Design', 'confidential')).id;
    alice = await personIn(h, 'alice', [ws]);
    bob = await personIn(h, 'bob', [ws]);
    carol = await personIn(h, 'carol', [ws]);
    dave = await personIn(h, 'dave', [ws]);
    erin = await personIn(h, 'erin', [ws]);
  }, 120_000);
  afterEach(async () => {
    await h.close();
  });

  async function group(extra: object = {}) {
    const g = (await alice.post('/api/groups', { workspaceId: ws, name: 'Type club', joinMode: 'open', visibility: 'private', ...extra }).expect(201)).body;
    for (const x of [bob, carol, dave, erin]) await x.post(`/api/groups/${g.id}/join`).expect(200);
    return g;
  }

  it('B-9705: a custom role with "create events" but not "post" can do the one and not the other', async () => {
    const g = await group();
    const role = (await alice.post(`/api/groups/${g.id}/roles`, { name: 'Organiser', rights: ['events', 'rsvp'] }).expect(201)).body;
    expect(role.rights.sort()).toEqual(['events', 'read', 'rsvp']);
    await alice.patch(`/api/groups/${g.id}/members/${bob.user.id}`, { customRoleId: role.id }).expect(200);

    // The one: Bob schedules an event. The other: he cannot post.
    const e = (await bob.post(`/api/groups/${g.id}/events`, event()).expect(201)).body;
    expect(e.canManage).toBe(true);
    const refused = await bob.post(`/api/groups/${g.id}/posts`, { body: 'Hello' }).expect(403);
    expect(refused.body.step).toBe('group-role');
    expect(refused.body.right).toBe('post');
    // Carol, an ordinary member, has it the other way round.
    await carol.post(`/api/groups/${g.id}/posts`, { body: 'Hello' }).expect(201);
    await carol.post(`/api/groups/${g.id}/events`, event()).expect(403);

    // The view says what the caller may do and names the role; the member list carries it.
    const view = (await bob.get(`/api/groups/${g.id}`).expect(200)).body;
    expect(view.customRole).toMatchObject({ id: role.id, name: 'Organiser' });
    expect(view.rights.sort()).toEqual(['events', 'read', 'rsvp']);
    const members = (await alice.get(`/api/groups/${g.id}/members`).expect(200)).body as { userId: string; role: string; customRole: { name: string } | null }[];
    expect(members.find((m) => m.userId === bob.user.id)).toMatchObject({ role: 'member', customRole: { name: 'Organiser' } });
    const listed = (await carol.get(`/api/groups/${g.id}/roles`).expect(200)).body;
    expect(listed.tiers.map((t: { role: string }) => t.role)).toEqual(['owner', 'admin', 'moderator', 'member', 'guest']);
    expect(listed.custom).toMatchObject([{ name: 'Organiser', members: 1 }]);
    expect(listed.canManage).toBe(false);

    // Changing the role's rights changes what its holders may do at once.
    await alice.patch(`/api/groups/${g.id}/roles/${role.id}`, { rights: ['post'] }).expect(200);
    await bob.post(`/api/groups/${g.id}/posts`, { body: 'Now I can' }).expect(201);
    await bob.post(`/api/groups/${g.id}/events`, event()).expect(403);

    // Removing the role leaves its holders as members.
    expect((await alice.del(`/api/groups/${g.id}/roles/${role.id}`).expect(200)).body).toMatchObject({ removed: true, members: 1 });
    expect(((await alice.get(`/api/groups/${g.id}/members`).expect(200)).body as { userId: string; role: string; customRole: unknown }[]).find((m) => m.userId === bob.user.id)).toMatchObject({ role: 'member', customRole: null });

    // Every change is in the audit chain.
    expect(await audits(h, 'group.role.created')).toHaveLength(1);
    expect((await audits(h, 'group.role.updated'))[0]!.detail).toMatchObject({ before: { rights: ['rsvp', 'events'] }, after: { rights: ['post'] }, members: 1 });
    expect((await audits(h, 'group.role.removed'))[0]!.detail).toMatchObject({ members: 1 });
    expect((await audits(h, 'group.member.role'))[0]!.detail).toMatchObject({ before: 'member', after: 'member', afterCustomRole: role.id });
  });

  it('B-9705: nobody gives more than they hold, changes someone above them, or raises themselves; the last owner stays', async () => {
    const g = await group();
    // The tiers: an admin runs the group but does not own it; a guest reads and answers events but does not post.
    await alice.patch(`/api/groups/${g.id}/members/${bob.user.id}`, { role: 'admin' }).expect(200);
    await alice.patch(`/api/groups/${g.id}/members/${carol.user.id}`, { role: 'moderator' }).expect(200);
    await alice.patch(`/api/groups/${g.id}/members/${erin.user.id}`, { role: 'guest' }).expect(200);
    await erin.post(`/api/groups/${g.id}/posts`, { body: 'Hello' }).expect(403);
    const e = (await carol.post(`/api/groups/${g.id}/events`, event()).expect(201)).body;
    await erin.post(`/api/calendar/events/${e.id}/rsvp`, { response: 'going' }).expect(200);

    // An admin changes settings and gives roles up to their own, never ownership, and never touches an owner.
    await bob.patch(`/api/groups/${g.id}`, { name: 'Type club 2' }).expect(200);
    await bob.patch(`/api/groups/${g.id}/members/${dave.user.id}`, { role: 'moderator' }).expect(200);
    expect((await bob.patch(`/api/groups/${g.id}/members/${dave.user.id}`, { role: 'owner' }).expect(403)).body.step).toBe('group-role');
    expect((await bob.patch(`/api/groups/${g.id}/members/${alice.user.id}`, { role: 'member' }).expect(403)).body.step).toBe('group-role');
    await bob.del(`/api/groups/${g.id}/members/${alice.user.id}`).expect(403);
    await bob.post(`/api/groups/${g.id}/bans`, { userId: alice.user.id, kind: 'ban' }).expect(409);
    await bob.del(`/api/groups/${g.id}`).expect(403);
    // A custom role cannot carry deletion, nor anything its author lacks.
    await alice.post(`/api/groups/${g.id}/roles`, { name: 'Sneaky', rights: ['delete'] }).expect(400);
    const helper = (await bob.post(`/api/groups/${g.id}/roles`, { name: 'Helper', rights: ['invite', 'roles'] }).expect(201)).body;

    // A moderator has no say over roles, and removes or bars members only, as before.
    await carol.patch(`/api/groups/${g.id}/members/${erin.user.id}`, { role: 'member' }).expect(403);
    await carol.post(`/api/groups/${g.id}/roles`, { name: 'Mine', rights: ['post'] }).expect(403);
    await carol.del(`/api/groups/${g.id}/members/${dave.user.id}`).expect(403);
    await carol.post(`/api/groups/${g.id}/bans`, { userId: bob.user.id, kind: 'suspend', days: 1 }).expect(403);
    await carol.post(`/api/groups/${g.id}/invites`, { userId: alice.user.id, role: 'moderator' }).expect(403);

    // A holder of a custom role with `roles` gives only what the role holds, and never changes the role they hold.
    await alice.patch(`/api/groups/${g.id}/members/${dave.user.id}`, { customRoleId: helper.id }).expect(200);
    expect((await dave.patch(`/api/groups/${g.id}/roles/${helper.id}`, { rights: ['invite', 'roles', 'post'] }).expect(403)).body.step).toBe('self-grant');
    expect((await dave.patch(`/api/groups/${g.id}/members/${erin.user.id}`, { role: 'member' }).expect(403)).body.step).toBe('group-role');
    expect((await dave.post(`/api/groups/${g.id}/roles`, { name: 'Poster', rights: ['post'] }).expect(403)).body.step).toBe('group-role');
    const inviter = (await dave.post(`/api/groups/${g.id}/roles`, { name: 'Inviter', rights: ['invite'] }).expect(201)).body;
    // Erin is a guest, who holds a right (rsvp) the Helper role does not: Dave cannot change her role.
    expect((await dave.patch(`/api/groups/${g.id}/members/${erin.user.id}`, { customRoleId: inviter.id }).expect(403)).body.step).toBe('group-role');
    // Nobody raises themselves: Dave to moderator, Bob to owner.
    expect((await dave.patch(`/api/groups/${g.id}/members/${dave.user.id}`, { role: 'moderator' }).expect(403)).body.step).toBe('self-grant');
    expect((await bob.patch(`/api/groups/${g.id}/members/${bob.user.id}`, { role: 'owner' }).expect(403)).body.step).toBe('self-grant');
    // Stepping down is one's own to do; the last owner cannot.
    await bob.patch(`/api/groups/${g.id}/members/${bob.user.id}`, { role: 'member' }).expect(200);
    await alice.patch(`/api/groups/${g.id}/members/${alice.user.id}`, { role: 'admin' }).expect(409);
    await alice.del(`/api/groups/${g.id}/members/${alice.user.id}`).expect(409);
    // A second owner makes room.
    await alice.patch(`/api/groups/${g.id}/members/${bob.user.id}`, { role: 'owner' }).expect(200);
    await alice.patch(`/api/groups/${g.id}/members/${alice.user.id}`, { role: 'admin' }).expect(200);
    const roleAudits = await audits(h, 'group.member.role');
    expect(roleAudits.length).toBeGreaterThanOrEqual(8);
    expect(roleAudits.every((a) => Array.isArray(a.detail.rightsBefore) && Array.isArray(a.detail.rightsAfter))).toBe(true);
  });

  it('B-9705: memberships written before the migration keep their rights, and the linked conversation follows the rights', async () => {
    const g = await group();
    // Rows as 1.6.0 wrote them: a tier and no custom role.
    await h.s.db('group_members').where({ group_id: g.id, user_id: bob.user.id }).update({ role: 'moderator', custom_role_id: null });
    const rights = await h.s.groups.roles.rightsOfAll(g.id);
    expect([...rights.get(alice.user.id)!]).toEqual([...TIER_RIGHTS.owner]);
    expect([...rights.get(bob.user.id)!]).toEqual([...TIER_RIGHTS.moderator]);
    expect([...rights.get(carol.user.id)!]).toEqual([...TIER_RIGHTS.member]);
    expect((await bob.get(`/api/groups/${g.id}`).expect(200)).body).toMatchObject({ role: 'moderator', actingRole: 'moderator', customRole: null });
    // A custom role that has gone leaves the tier, never more.
    await h.s.db('group_members').where({ group_id: g.id, user_id: carol.user.id }).update({ custom_role_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' });
    expect([...(await h.s.groups.roles.rightsOfAll(g.id)).get(carol.user.id)!]).toEqual([...TIER_RIGHTS.member]);

    // The linked conversation: owner owns it, whoever moderates administers it, a guest and a custom role are members.
    await alice.put(`/api/groups/${g.id}/conversation`, {}).expect(201);
    const role = (await alice.post(`/api/groups/${g.id}/roles`, { name: 'Hands', rights: ['moderate', 'post'] }).expect(201)).body;
    await alice.patch(`/api/groups/${g.id}/members/${dave.user.id}`, { customRoleId: role.id }).expect(200);
    await alice.patch(`/api/groups/${g.id}/members/${erin.user.id}`, { role: 'guest' }).expect(200);
    const link = (await h.s.groups.conversations.ofGroup(g.id))!;
    const standing = async (x: Person) => h.s.groups.conversations.standing(await principal(x), link);
    expect(await standing(alice)).toBe('owner');
    expect(await standing(bob)).toBe('admin');
    expect(await standing(dave)).toBe('admin');
    expect(await standing(erin)).toBe('member');
  });

  async function principal(x: Person) {
    const { loadPrincipal } = await import('../src/http/middleware.js');
    return (await loadPrincipal(h.s, h.tenantId, x.user.id, {}))!;
  }

  it('B-9707: when a "going" place frees up, the first on the waitlist is promoted and notified', async () => {
    const g = await group();
    const e = (await alice.post(`/api/groups/${g.id}/events`, event({ capacity: 2, waitlist: true })).expect(201)).body;
    expect(e).toMatchObject({ waitlist: true, kind: 'in-person', visibility: 'group', rsvpApproval: false });
    await alice.post(`/api/calendar/events/${e.id}/rsvp`, { response: 'going' }).expect(200);
    await bob.post(`/api/calendar/events/${e.id}/rsvp`, { response: 'going' }).expect(200);
    // The event is full: the next three wait, in the order they asked.
    const c = (await carol.post(`/api/calendar/events/${e.id}/rsvp`, { response: 'going' }).expect(200)).body;
    expect(c).toMatchObject({ response: 'waitlisted', position: 1 });
    await new Promise((r) => setTimeout(r, 5));
    expect((await dave.post(`/api/calendar/events/${e.id}/rsvp`, { response: 'going' }).expect(200)).body).toMatchObject({ response: 'waitlisted', position: 2 });
    await new Promise((r) => setTimeout(r, 5));
    expect((await erin.post(`/api/calendar/events/${e.id}/rsvp`, { response: 'going' }).expect(200)).body).toMatchObject({ response: 'waitlisted', position: 3 });
    expect((await carol.get(`/api/calendar/events/${e.id}`).expect(200)).body).toMatchObject({ attendance: { going: 2, waitlisted: 3 }, myRsvp: { response: 'waitlisted', position: 1 } });
    // Those who wait are the organisers' to see, not the members'.
    expect(((await dave.get(`/api/calendar/events/${e.id}/attendees`).expect(200)).body as { response: string }[]).map((a) => a.response).sort()).toEqual(['going', 'going']);
    expect(((await alice.get(`/api/calendar/events/${e.id}/attendees?response=waitlisted`).expect(200)).body as { userId: string }[]).map((a) => a.userId)).toEqual(expect.arrayContaining([carol.user.id, dave.user.id, erin.user.id]));

    // A place frees up: the first on the list is promoted, once, and told.
    const freed = (await bob.post(`/api/calendar/events/${e.id}/rsvp`, { response: 'declined' }).expect(200)).body;
    expect(freed).toMatchObject({ response: 'declined', promoted: 1, attendance: { going: 2, waitlisted: 2 } });
    expect((await carol.get(`/api/calendar/events/${e.id}`).expect(200)).body.myRsvp).toMatchObject({ response: 'going' });
    expect(await notes(h, carol.user.id, 'event.waitlist.promoted')).toHaveLength(1);
    expect(await notes(h, dave.user.id, 'event.waitlist.promoted')).toHaveLength(0);
    expect((await audits(h, 'group.event.waitlist.promoted')).map((a) => a.target.user)).toEqual([carol.user.id]);
    // Promoting again with no free place gives nothing; two calls at once give one place once.
    expect(await h.s.calendar.promote(e.id)).toEqual([]);

    // Someone who may no longer attend is passed over, not admitted: Dave is suspended, so Erin gets the next place.
    await alice.post(`/api/groups/${g.id}/bans`, { userId: dave.user.id, kind: 'suspend', days: 3 }).expect(201);
    await alice.post(`/api/calendar/events/${e.id}/rsvp`, { response: 'maybe' }).expect(200);
    const rows = (await h.s.db('group_event_rsvps').where({ event_id: e.id }).select('user_id', 'response')) as { user_id: string; response: string }[];
    const of = (x: Person) => rows.find((r) => r.user_id === x.user.id)?.response;
    expect(of(erin)).toBe('going');
    expect(of(dave)).toBe('waitlisted');
    expect(await notes(h, erin.user.id, 'event.waitlist.promoted')).toHaveLength(1);
    expect(await notes(h, dave.user.id, 'event.waitlist.promoted')).toHaveLength(0);
    // A suspended member cannot take a place either.
    await dave.post(`/api/calendar/events/${e.id}/rsvp`, { response: 'going' }).expect((r) => expect([403, 404]).toContain(r.status));

    // More room goes to the waitlist too, concurrently and once: raise the capacity while a place frees.
    await alice.del(`/api/groups/${g.id}/bans/${(await alice.get(`/api/groups/${g.id}/bans`).expect(200)).body[0].id}`).expect(200);
    const [x, y] = await Promise.all([h.s.calendar.promote(e.id), alice.patch(`/api/calendar/events/${e.id}`, { capacity: 3 }).expect(200)]);
    expect(x.length + (y.body.promoted ?? 0)).toBe(1);
    expect((await dave.get(`/api/calendar/events/${e.id}`).expect(200)).body.myRsvp).toMatchObject({ response: 'going' });
    expect(await notes(h, dave.user.id, 'event.waitlist.promoted')).toHaveLength(1);
    // Without a waitlist a full event refuses, as before.
    const plain = (await alice.post(`/api/groups/${g.id}/events`, event({ capacity: 1 })).expect(201)).body;
    await alice.post(`/api/calendar/events/${plain.id}/rsvp`, { response: 'going' }).expect(200);
    await bob.post(`/api/calendar/events/${plain.id}/rsvp`, { response: 'going' }).expect(409);
  });

  it('B-9707: a deadline closes answers, approval makes "going" wait for an organiser, and decisions are audited', async () => {
    const g = await group();
    const closed = (await alice.post(`/api/groups/${g.id}/events`, event({ rsvpDeadline: soon(24) })).expect(201)).body;
    await bob.post(`/api/calendar/events/${closed.id}/rsvp`, { response: 'going' }).expect(200);
    await h.s.db('group_events').where({ id: closed.id }).update({ rsvp_deadline: Date.now() - 1000 });
    expect((await carol.post(`/api/calendar/events/${closed.id}/rsvp`, { response: 'going' }).expect(409)).body.step).toBe('rsvp-deadline');
    await carol.post(`/api/calendar/events/${closed.id}/rsvp`, { response: 'maybe' }).expect(409);
    // Declining stays open after the deadline.
    await bob.post(`/api/calendar/events/${closed.id}/rsvp`, { response: 'declined' }).expect(200);
    // A deadline after the event ends is refused.
    await alice.post(`/api/groups/${g.id}/events`, event({ rsvpDeadline: soon(480) })).expect(422);

    const e = (await alice.post(`/api/groups/${g.id}/events`, event({ rsvpApproval: true, capacity: 1, waitlist: true })).expect(201)).body;
    expect((await bob.post(`/api/calendar/events/${e.id}/rsvp`, { response: 'going' }).expect(200)).body).toMatchObject({ response: 'pending', attendance: { going: 0, pending: 1 } });
    await carol.post(`/api/calendar/events/${e.id}/rsvp`, { response: 'going' }).expect(200);
    await dave.post(`/api/calendar/events/${e.id}/rsvp`, { response: 'going' }).expect(200);
    expect(await notes(h, alice.user.id, 'event.rsvp.request')).toHaveLength(3);
    // Only an organiser decides, and never their own answer.
    await carol.post(`/api/calendar/events/${e.id}/rsvps/${bob.user.id}/decide`, { decision: 'approve' }).expect(403);
    expect((await alice.post(`/api/calendar/events/${e.id}/rsvps/${bob.user.id}/decide`, { decision: 'approve' }).expect(200)).body).toMatchObject({ response: 'going' });
    // The event is full now: the next approval joins the waitlist; a decline declines.
    expect((await alice.post(`/api/calendar/events/${e.id}/rsvps/${carol.user.id}/decide`, { decision: 'approve' }).expect(200)).body).toMatchObject({ response: 'waitlisted' });
    expect((await alice.post(`/api/calendar/events/${e.id}/rsvps/${dave.user.id}/decide`, { decision: 'decline' }).expect(200)).body).toMatchObject({ response: 'declined' });
    await alice.post(`/api/calendar/events/${e.id}/rsvps/${dave.user.id}/decide`, { decision: 'approve' }).expect(409);
    expect((await audits(h, 'group.event.rsvp.approved')).map((a) => [a.target.user, a.detail.outcome])).toEqual([[bob.user.id, 'going'], [carol.user.id, 'waitlisted']]);
    expect((await audits(h, 'group.event.rsvp.declined')).map((a) => a.target.user)).toEqual([dave.user.id]);
    expect(await notes(h, bob.user.id, 'event.rsvp.decided')).toHaveLength(1);
    // An organiser's own "going" needs no approval, but the place: Alice joins the waitlist behind Carol.
    expect((await alice.post(`/api/calendar/events/${e.id}/rsvp`, { response: 'going' }).expect(200)).body).toMatchObject({ response: 'waitlisted', position: 2 });
    // Bob leaves: Carol, approved and first, takes the place.
    await bob.post(`/api/calendar/events/${e.id}/rsvp`, { response: 'declined' }).expect(200);
    expect((await carol.get(`/api/calendar/events/${e.id}`).expect(200)).body.myRsvp).toMatchObject({ response: 'going' });
  });

  it('B-9707: drafts, per-event visibility and the virtual URL are read only by those who may', async () => {
    await rules(h, [NUKE]);
    const g = await group({ visibility: 'public' });
    const frank = await personIn(h, 'frank', [ws]);
    const before = (await notes(h, bob.user.id, 'event.created')).length;

    // A draft: only those who may edit it read it, and nobody is told.
    const d = (await alice.post(`/api/groups/${g.id}/events`, event({ draft: true, reminders: [60], kind: 'virtual', virtualUrl: 'https://meet.example.com/critique' })).expect(201)).body;
    expect(d).toMatchObject({ state: 'draft', kind: 'virtual', virtualUrl: 'https://meet.example.com/critique' });
    expect(await notes(h, bob.user.id, 'event.created')).toHaveLength(before);
    await bob.get(`/api/calendar/events/${d.id}`).expect(404);
    expect(((await bob.get(`/api/groups/${g.id}/events`).expect(200)).body as { id: string }[]).map((e) => e.id)).not.toContain(d.id);
    expect(((await alice.get(`/api/groups/${g.id}/events`).expect(200)).body as { id: string }[]).map((e) => e.id)).toContain(d.id);
    await bob.post(`/api/calendar/events/${d.id}/rsvp`, { response: 'going' }).expect(404);
    await alice.post(`/api/calendar/events/${d.id}/rsvp`, { response: 'going' }).expect(409);
    expect(await h.s.db('group_event_reminders').where({ event_id: d.id })).toHaveLength(0);
    // It can be changed while a draft, without a notice; publishing announces it and schedules its reminders.
    await alice.patch(`/api/calendar/events/${d.id}`, { start: soon(72), durationMinutes: 30 }).expect(200);
    await bob.post(`/api/calendar/events/${d.id}/publish`).expect(404);
    expect((await alice.post(`/api/calendar/events/${d.id}/publish`).expect(200)).body.state).toBe('scheduled');
    expect(await notes(h, bob.user.id, 'event.created')).toHaveLength(before + 1);
    expect(await h.s.db('group_event_reminders').where({ event_id: d.id, state: 'scheduled' })).toHaveLength(1);
    expect((await bob.get(`/api/calendar/events/${d.id}`).expect(200)).body.virtualUrl).toBe('https://meet.example.com/critique');
    await alice.post(`/api/calendar/events/${d.id}/publish`).expect(409);
    expect(await audits(h, 'group.event.published')).toHaveLength(1);

    // The virtual URL passes the guardrail, and must be a link.
    expect((await alice.post(`/api/groups/${g.id}/events`, event({ kind: 'virtual', virtualUrl: 'https://meet.example.com/launch-codes' })).expect(422)).body.step).toBe('guardrails');
    expect((await alice.post(`/api/groups/${g.id}/events`, event({ kind: 'virtual', virtualUrl: 'javascript:alert(1)' })).expect(422)).body.step).toBe('virtual-url');
    await alice.patch(`/api/calendar/events/${d.id}`, { virtualUrl: 'https://meet.example.com/launch-codes' }).expect(422);

    // Visibility. The group is public: Frank, not a member, reads a `group` event but not a `members` one.
    const open = (await alice.post(`/api/groups/${g.id}/events`, event()).expect(201)).body;
    const members = (await alice.post(`/api/groups/${g.id}/events`, event({ visibility: 'members', kind: 'hybrid', virtualUrl: 'https://meet.example.com/members' })).expect(201)).body;
    const staff = (await alice.post(`/api/groups/${g.id}/events`, event({ visibility: 'organisers' })).expect(201)).body;
    await frank.get(`/api/calendar/events/${open.id}`).expect(200);
    await frank.get(`/api/calendar/events/${members.id}`).expect(404);
    await frank.post(`/api/calendar/events/${members.id}/rsvp`, { response: 'going' }).expect(404);
    expect((await bob.get(`/api/calendar/events/${members.id}`).expect(200)).body.virtualUrl).toBe('https://meet.example.com/members');
    await bob.get(`/api/calendar/events/${staff.id}`).expect(404);
    await alice.get(`/api/calendar/events/${staff.id}`).expect(200);
    const listed = (x: { body: { id: string }[] }) => x.body.map((e) => e.id);
    expect(listed(await frank.get(`/api/groups/${g.id}/events`).expect(200))).toEqual(expect.not.arrayContaining([members.id, staff.id]));
    expect(listed(await bob.get(`/api/groups/${g.id}/events`).expect(200))).toEqual(expect.not.arrayContaining([staff.id]));
    expect(listed(await bob.get(`/api/groups/${g.id}/events`).expect(200))).toContain(members.id);
    // The organisers' event was announced to the organisers only (there are none but Alice, who made it).
    expect(await notes(h, bob.user.id, 'event.created')).toHaveLength(before + 3);
    // Narrowing an event takes it from those it no longer includes, their own calendar too.
    await bob.post(`/api/calendar/events/${open.id}/rsvp`, { response: 'going' }).expect(200);
    await alice.patch(`/api/calendar/events/${open.id}`, { visibility: 'organisers' }).expect(200);
    await bob.get(`/api/calendar/events/${open.id}`).expect(404);
    expect(listed(await bob.get(`/api/calendar/events`).expect(200))).not.toContain(open.id);
    // A draft that is discarded tells nobody.
    const gone = (await alice.post(`/api/groups/${g.id}/events`, event({ draft: true })).expect(201)).body;
    expect((await alice.post(`/api/calendar/events/${gone.id}/cancel`, {}).expect(200)).body).toMatchObject({ state: 'cancelled', notified: 0 });
  });
});
