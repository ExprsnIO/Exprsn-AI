import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boundingBox, distanceKm, parseNear } from '../src/groups/geo.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';
import { drain } from './retrieval-seed.js';

/*
 * Sprint 36a (1.6.0), groups depth (B-4401 to B-4405). The "done when" of each item is a test below:
 *   B-4401 a channel inside a group has its own members and feed;
 *   B-4402 the discovery page never shows a group above the viewer's clearance;
 *   B-4403 a distance filter returns the same groups on the three databases (here SQLite; the integration suite runs
 *          the same fixture on PostgreSQL and MySQL, server/test/integration/groups2.test.ts);
 *   B-4404 a group with a burst of joins appears in trending within one job run;
 *   B-4405 removing a category leaves its groups uncategorised, not hidden.
 */

const S = '/api/admin/social';
type Person = Awaited<ReturnType<typeof personIn>>;
type Label = 'public' | 'internal' | 'confidential' | 'restricted';

async function personIn(h: Harness, name: string, workspaces: string[], roles: string[] = ['member'], clearance: Label = 'internal') {
  const user = await localUser(h, name, roles, clearance);
  for (const w of workspaces) await h.s.tenants.addMember(w, user.id);
  const first = await login(h, name);
  const c: Client = first.res.body.stage === 'enroll' ? await loginAdmin(h, name) : first;
  const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
  return {
    user,
    ...c,
    post: (p: string, b?: object) => send('post', p, b),
    patch: (p: string, b?: object) => send('patch', p, b),
    del: (p: string) => send('delete', p),
    get: (p: string) => c.agent.get(p)
  };
}

const names = (rows: { name: string }[]) => rows.map((g) => g.name);
const audits = (h: Harness, action: string) => h.s.db('audit_events').where({ action });

// Places for the distance tests (WGS 84).
export const PLACES = {
  berlin: { lat: 52.52, lon: 13.405 },
  potsdam: { lat: 52.3906, lon: 13.0645 },
  hamburg: { lat: 53.5511, lon: 9.9937 },
  lisbon: { lat: 38.7223, lon: -9.1393 }
};

describe('distances (B-4403)', () => {
  it('measures great circles on the PostGIS sphere', () => {
    expect(distanceKm(PLACES.berlin, PLACES.hamburg)).toBeGreaterThan(254);
    expect(distanceKm(PLACES.berlin, PLACES.hamburg)).toBeLessThan(257);
    expect(distanceKm(PLACES.berlin, PLACES.potsdam)).toBeGreaterThan(26);
    expect(distanceKm(PLACES.berlin, PLACES.potsdam)).toBeLessThan(28);
    expect(distanceKm(PLACES.berlin, PLACES.berlin)).toBe(0);
    // half the circumference
    expect(distanceKm({ lat: 0, lon: 0 }, { lat: 0, lon: 180 })).toBeCloseTo(Math.PI * 6371.0087714, 3);
  });

  it('bounds a circle, across the antimeridian and over a pole', () => {
    const b = boundingBox({ ...PLACES.berlin, km: 50 });
    expect(b.lon).toHaveLength(1);
    expect(b.minLat).toBeLessThan(PLACES.berlin.lat);
    // every point of the circle is inside the box
    for (let i = 0; i < 360; i += 15) {
      const d = 50 / 6371.0087714;
      const lat = PLACES.berlin.lat + (d * Math.cos((i * Math.PI) / 180) * 180) / Math.PI;
      expect(lat).toBeGreaterThanOrEqual(b.minLat - 1e-9);
      expect(lat).toBeLessThanOrEqual(b.maxLat + 1e-9);
    }
    const fiji = boundingBox({ lat: -17.7, lon: 179.9, km: 100 });
    expect(fiji.lon).toHaveLength(2);
    expect(fiji.lon![0]![1]).toBe(180);
    expect(fiji.lon![1]![0]).toBe(-180);
    expect(boundingBox({ lat: 89.9, lon: 0, km: 50 }).lon).toBeNull();
  });

  it('parses near=<lat>,<lon> and caps the radius', () => {
    expect(parseNear('52.52,13.405', 10)).toEqual({ lat: 52.52, lon: 13.405, km: 10 });
    expect(parseNear('52.52, 13.405', undefined)).toMatchObject({ km: 25 });
    expect(parseNear('91,0', 10)).toBeNull();
    expect(parseNear('berlin', 10)).toBeNull();
    expect(parseNear('0,0', 1e9)!.km).toBe(20_016);
  });
});

describe('Groups depth (Sprint 36a, B-4401 to B-4405)', () => {
  let h: Harness;
  let ws: string;
  let other: string;
  let ta: Person;
  let owner: Person;
  let ann: Person;
  let ben: Person;
  let cy: Person;

  beforeEach(async () => {
    h = await harness();
    ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Finance Ops', 'confidential')).id;
    other = (await h.s.tenants.createWorkspace(h.tenantId, 'Field Sales', 'internal')).id;
    ta = await personIn(h, 'ta', [ws, other], ['tenant-admin'], 'confidential');
    owner = await personIn(h, 'owner', [ws], ['member'], 'confidential');
    ann = await personIn(h, 'ann', [ws], ['member'], 'confidential');
    ben = await personIn(h, 'ben', [ws]);
    cy = await personIn(h, 'cy', [other]);
  }, 60_000);
  afterEach(async () => {
    await h.close();
  });

  const group = async (p: Person, body: Record<string, unknown>) => (await p.post('/api/groups', { workspaceId: ws, visibility: 'public', joinMode: 'open', ...body }).expect(201)).body;

  it('B-4401: a channel inside a group has its own members and feed', async () => {
    const g = await group(owner, { name: 'Month-end close', visibility: 'private', joinMode: 'open' });
    await ann.post(`/api/groups/${g.id}/join`).expect(200);
    await ben.post(`/api/groups/${g.id}/join`).expect(200);

    // the floor and the depth
    await owner.post(`/api/groups/${g.id}/channels`, { name: 'Too low', label: 'public' }).expect(422);
    await ben.post(`/api/groups/${g.id}/channels`, { name: 'Members do not create' }).expect(403);
    const ch = (await owner.post(`/api/groups/${g.id}/channels`, { name: 'Accruals', visibility: 'private', joinMode: 'open' }).expect(201)).body;
    expect(ch).toMatchObject({ parentId: g.id, label: 'internal', visibility: 'private', role: 'owner', members: 1, parentName: 'Month-end close' });
    await owner.post(`/api/groups/${ch.id}/channels`, { name: 'Nested' }).expect(422);
    expect((await audits(h, 'group.channel.created').first()).target).toContain(ch.id);

    // a channel is not listed among groups; its group counts and lists it
    expect(names((await ann.get('/api/groups').expect(200)).body)).toEqual(['Month-end close']);
    expect((await ann.get(`/api/groups/${g.id}`).expect(200)).body.channels).toBe(1);
    expect((await ann.get(`/api/groups/${g.id}/channels`).expect(200)).body).toMatchObject([{ name: 'Accruals', parentId: g.id, parentName: 'Month-end close', parentLabel: 'internal' }]);

    // own members: only the group's members join, and joining the group does not join the channel
    await ann.post(`/api/groups/${ch.id}/join`).expect(200);
    const cyIn = await personIn(h, 'cyin', [ws]);
    const refused = await cyIn.post(`/api/groups/${ch.id}/join`).expect(404); // a private group's channels are unknown to non-members
    expect(refused.body.status).toBe(404);
    expect((await ann.get(`/api/groups/${ch.id}/members`).expect(200)).body.map((m: { username: string }) => m.username).sort()).toEqual(['ann', 'owner']);
    expect((await ann.get(`/api/groups/${g.id}/members`).expect(200)).body).toHaveLength(3);

    // own feed: a post in the channel is not in the group, and ben (a group member, not in the private channel) cannot read it
    await ann.post(`/api/groups/${ch.id}/posts`, { body: 'Accruals above 25k need a ticket' }).expect(201);
    await owner.post(`/api/groups/${g.id}/posts`, { body: 'Cut-off is Wednesday' }).expect(201);
    expect((await ann.get(`/api/groups/${ch.id}/posts`).expect(200)).body.map((x: { body: string }) => x.body)).toEqual(['Accruals above 25k need a ticket']);
    expect((await ann.get(`/api/groups/${g.id}/posts`).expect(200)).body.map((x: { body: string }) => x.body)).toEqual(['Cut-off is Wednesday']);
    await ben.get(`/api/groups/${ch.id}/posts`).expect(403);
    expect((await ben.get(`/api/groups/${ch.id}`).expect(200)).body).toMatchObject({ role: null, description: null });

    // a public channel is read by the group's readers; ben joins it as a group member
    const pub = (await owner.post(`/api/groups/${g.id}/channels`, { name: 'Notices', visibility: 'public' }).expect(201)).body;
    await ben.get(`/api/groups/${pub.id}/posts`).expect(200);
    await ben.post(`/api/groups/${pub.id}/join`).expect(200);
    // ...whose own roles the channel's owner sets
    await owner.patch(`/api/groups/${pub.id}/members/${ben.user.id}`, { role: 'moderator' }).expect(200);
    expect((await ben.get(`/api/groups/${pub.id}`).expect(200)).body.role).toBe('moderator');

    // a channel's own label may rise, never below the group's
    await owner.patch(`/api/groups/${pub.id}`, { label: 'public' }).expect(422);
    await owner.patch(`/api/groups/${pub.id}`, { categoryId: null }).expect(422);
    // raising the group's label raises the channels below it (and ben, internal, loses them with the group)
    await owner.patch(`/api/groups/${g.id}`, { label: 'confidential' }).expect(200);
    const after = (await ann.get(`/api/groups/${g.id}/channels`).expect(200)).body as { name: string; label: string }[];
    expect(after.map((c) => `${c.name}:${c.label}`).sort()).toEqual(['Accruals:confidential', 'Notices:confidential']);
    await ben.get(`/api/groups/${pub.id}`).expect(404);
    await owner.patch(`/api/groups/${g.id}`, { label: 'internal' }).expect(200);

    // leaving the group leaves its channels
    const left = (await ann.del(`/api/groups/${g.id}/members/${ann.user.id}`).expect(200)).body;
    expect(left).toMatchObject({ removed: true, channels: 1 });
    expect(await h.s.db('group_members').where({ group_id: ch.id, user_id: ann.user.id }).first()).toBeUndefined();

    // the group's owner acts as owner of a channel they are not a member of; deleting the group deletes its channels
    await ann.post(`/api/groups/${g.id}/join`).expect(200);
    const annCh = (await ann.post(`/api/groups/${pub.id}/join`).expect(200)).body;
    expect(annCh).toMatchObject({ joined: true });
    const out = (await owner.del(`/api/groups/${g.id}`).expect(200)).body;
    expect(out).toMatchObject({ state: 'deleted', channels: 2 });
    await ann.get(`/api/groups/${pub.id}`).expect(404);

    // someone outside the workspace never sees a channel
    await cy.get(`/api/groups/${ch.id}`).expect(404);
  });

  it('B-4401: channel events and invitations stay inside the group', async () => {
    const g = await group(owner, { name: 'Close', visibility: 'public', joinMode: 'open' });
    const ch = (await owner.post(`/api/groups/${g.id}/channels`, { name: 'Leads', visibility: 'private', joinMode: 'invite' }).expect(201)).body;
    // the invitation picker offers members of the group only; inviting someone else is 422
    expect((await owner.get(`/api/groups/${ch.id}/candidates`).expect(200)).body).toEqual([]);
    await owner.post(`/api/groups/${ch.id}/invites`, { userId: ann.user.id }).expect(422);
    await ann.post(`/api/groups/${g.id}/join`).expect(200);
    expect((await owner.get(`/api/groups/${ch.id}/candidates`).expect(200)).body.map((c: { username: string }) => c.username)).toEqual(['ann']);
    const inv = (await owner.post(`/api/groups/${ch.id}/invites`, { userId: ann.user.id }).expect(201)).body;
    await ann.post(`/api/group-requests/${inv.id}/accept`).expect(200);
    const ev = (await owner.post(`/api/groups/${ch.id}/events`, { title: 'Leads sync', start: '2030-03-04T10:00', timeZone: 'Europe/Berlin' }).expect(201)).body;
    expect(ev.groupId).toBe(ch.id);
    expect((await ann.get('/api/calendar/events?from=2030-03-01T00:00:00Z&to=2030-03-31T00:00:00Z').expect(200)).body.map((e: { id: string }) => e.id)).toEqual([ev.id]);
    // a group member who is not in the private channel does not see its events
    await ben.post(`/api/groups/${g.id}/join`).expect(200);
    await ben.get(`/api/calendar/events/${ev.id}`).expect(404);
  });

  it('B-4402: discovery lists joinable groups ranked by shared members and activity, never above the viewer’s clearance', async () => {
    const ian = await personIn(h, 'ian', [ws], ['tenant-admin'], 'internal'); // groups:manage, cleared for internal only
    const mine = await group(owner, { name: 'Mine', joinMode: 'open' });
    await ben.post(`/api/groups/${mine.id}/join`).expect(200);
    await ann.post(`/api/groups/${mine.id}/join`).expect(200);
    // shared: ann (whom ben shares Mine with) is in Shared
    const shared = await group(ann, { name: 'Shared' });
    // Busy and Quiet are ta's, whom ben shares no group with
    const busy = await group(ta, { name: 'Busy' });
    for (let i = 0; i < 2; i++) await ta.post(`/api/groups/${busy.id}/posts`, { body: `Notice ${i}` }).expect(201);
    const quiet = await group(ta, { name: 'Quiet', joinMode: 'request', visibility: 'private' });
    await group(owner, { name: 'Invitation only', joinMode: 'invite' });
    await group(owner, { name: 'Above', label: 'confidential' });

    const d = (await ben.get('/api/groups/discover').expect(200)).body;
    expect(names(d.groups)).toEqual(['Shared', 'Busy', 'Quiet']);
    expect(d.groups[0]).toMatchObject({ sharedMembers: 1, score: 3 + 2, activity: { joins: 1, posts: 0 } });
    expect(d.groups[1]).toMatchObject({ sharedMembers: 0, score: 2 + 2, activity: { joins: 1, posts: 2 } });
    expect(d.groups.find((g: { name: string }) => g.name === 'Quiet')).toMatchObject({ joinMode: 'request', description: null });
    expect(d.windowDays).toBe(30);

    // ian manages groups and sees Above in the list, but discovery never shows a group above his clearance
    expect(names((await ian.get('/api/groups').expect(200)).body)).toContain('Above');
    expect(names((await ian.get('/api/groups/discover').expect(200)).body.groups)).not.toContain('Above');
    expect(names((await ann.get('/api/groups/discover').expect(200)).body.groups)).toContain('Above');
    // an invitation makes an invite-only group joinable for its invitee
    const io = (await owner.get('/api/groups').expect(200)).body.find((g: { name: string }) => g.name === 'Invitation only');
    await owner.post(`/api/groups/${io.id}/invites`, { userId: ben.user.id }).expect(201);
    expect((await ben.get('/api/groups/discover').expect(200)).body.groups.find((g: { name: string }) => g.name === 'Invitation only')).toMatchObject({ invited: true });
    // a pending request is marked
    await ben.post(`/api/groups/${quiet.id}/join`).expect(202);
    expect((await ben.get('/api/groups/discover').expect(200)).body.groups.find((g: { name: string }) => g.name === 'Quiet')).toMatchObject({ requested: true });
    expect(shared.id).toBeTruthy();
  });

  it('B-4403: groups and events have an optional place; a distance filter keeps those within it, nearest first', async () => {
    const berlin = await group(owner, { name: 'Berlin office', location: { name: 'Alexanderplatz', ...PLACES.berlin } });
    expect(berlin.location).toEqual({ name: 'Alexanderplatz', ...PLACES.berlin });
    await group(owner, { name: 'Potsdam', location: PLACES.potsdam });
    await group(owner, { name: 'Hamburg', location: PLACES.hamburg });
    await group(owner, { name: 'Lisbon', location: { name: 'Lisbon office', ...PLACES.lisbon } });
    await group(owner, { name: 'Nowhere' });
    const priv = await group(owner, { name: 'Private Berlin', visibility: 'private', location: PLACES.berlin });
    await owner.post('/api/groups', { workspaceId: ws, name: 'Half', location: { lat: 52 } }).expect(422);
    await owner.post('/api/groups', { workspaceId: ws, name: 'Off', location: { lat: 95, lon: 0 } }).expect(400);

    const near = `near=${PLACES.berlin.lat},${PLACES.berlin.lon}`;
    const hits = (await ann.get(`/api/groups?${near}&km=50`).expect(200)).body as { name: string; distanceKm: number }[];
    // the private group's place is its members': it never matches a distance for others
    expect(names(hits)).toEqual(['Berlin office', 'Potsdam']);
    expect(hits[0]!.distanceKm).toBe(0);
    expect(hits[1]!.distanceKm).toBeGreaterThan(26);
    expect(names((await owner.get(`/api/groups?${near}&km=50`).expect(200)).body)).toEqual(['Berlin office', 'Private Berlin', 'Potsdam']);
    expect(names((await ann.get(`/api/groups?${near}&km=300`).expect(200)).body)).toEqual(['Berlin office', 'Potsdam', 'Hamburg']);
    expect(names((await ann.get(`/api/groups/discover?${near}&km=300`).expect(200)).body.groups)).toEqual(['Berlin office', 'Potsdam', 'Hamburg']);
    await ann.get('/api/groups?near=somewhere').expect(400);
    // a non-reader sees no place
    expect((await ann.get(`/api/groups/${priv.id}`).expect(200)).body.location).toBeNull();
    // the place can be moved or cleared
    expect((await owner.patch(`/api/groups/${berlin.id}`, { location: { name: 'Mitte', ...PLACES.potsdam } }).expect(200)).body.location).toEqual({ name: 'Mitte', ...PLACES.potsdam });
    expect((await owner.patch(`/api/groups/${berlin.id}`, { location: null }).expect(200)).body.location).toBeNull();

    // events: a point beside the place name, and the calendar's distance filter
    await ann.post(`/api/groups/${berlin.id}/join`).expect(200);
    const mk = (title: string, p: { lat: number; lon: number } | null) => owner.post(`/api/groups/${berlin.id}/events`, { title, start: '2030-05-04T10:00', timeZone: 'Europe/Berlin', location: title, ...(p ?? {}) }).expect(201);
    const e1 = (await mk('Kickoff in Berlin', PLACES.berlin)).body;
    expect(e1).toMatchObject({ lat: PLACES.berlin.lat, lon: PLACES.berlin.lon });
    await mk('Hamburg review', PLACES.hamburg);
    await mk('Online', null);
    await owner.post(`/api/groups/${berlin.id}/events`, { title: 'Bad', start: '2030-05-04T10:00', timeZone: 'UTC', lon: 3 }).expect(422);
    const range = 'from=2030-05-01T00:00:00Z&to=2030-05-31T00:00:00Z';
    expect((await ann.get(`/api/calendar/events?${range}`).expect(200)).body).toHaveLength(3);
    const evs = (await ann.get(`/api/calendar/events?${range}&${near}&km=100`).expect(200)).body as { title: string; distanceKm: number }[];
    expect(evs.map((e) => e.title)).toEqual(['Kickoff in Berlin']);
    // moving an event moves its sequence
    const moved = (await owner.patch(`/api/calendar/events/${e1.id}`, { lat: PLACES.hamburg.lat, lon: PLACES.hamburg.lon }).expect(200)).body;
    expect(moved.sequence).toBe(1);
    expect((await ann.get(`/api/calendar/events?${range}&near=${PLACES.hamburg.lat},${PLACES.hamburg.lon}&km=1`).expect(200)).body.map((e: { title: string }) => e.title).sort()).toEqual(['Hamburg review', 'Kickoff in Berlin']);
  });

  it('B-4404: a group with a burst of joins appears in trending within one job run', async () => {
    const calm = await group(owner, { name: 'Calm' });
    await owner.post(`/api/groups/${calm.id}/posts`, { body: 'One notice' }).expect(201);
    const hot = await group(ta, { name: 'Hot' });
    const hidden = await group(owner, { name: 'Hidden', visibility: 'hidden' });
    for (const n of ['p1', 'p2', 'p3', 'p4']) {
      const p = await personIn(h, n, [ws]);
      await p.post(`/api/groups/${hot.id}/join`).expect(200);
    }
    await owner.post(`/api/groups/${hidden.id}/posts`, { body: 'quiet' }).expect(201);
    expect((await ann.get('/api/groups/trending').expect(200)).body.groups).toEqual([]);
    // one run of the job, from Social and messaging
    await ann.post(`${S}/groups/trending/run`).expect(403);
    expect((await ta.post(`${S}/groups/trending/run`).expect(202)).body.jobId).toBeTruthy();
    await drain(h);
    const t = (await ann.get('/api/groups/trending').expect(200)).body;
    expect(names(t.groups)).toEqual(['Hot', 'Calm']);
    expect(t.groups[0]).toMatchObject({ name: 'Hot', trend: { joins: 5, posts: 0, score: 15 } });
    expect(t.groups[1]).toMatchObject({ trend: { joins: 1, posts: 1, score: 4 } });
    expect(names(t.groups)).not.toContain('Hidden');
    expect(t.hours).toBe(72);
    expect(t.computedAt).toBeGreaterThan(0);
    expect((await audits(h, 'group.trending.requested').first()).action).toBe('group.trending.requested');
    // someone in another workspace sees none of them
    expect((await cy.get('/api/groups/trending').expect(200)).body.groups).toEqual([]);
    // the admin view shows them too
    expect((await ta.get(`${S}/groups`).expect(200)).body.trending.groups[0].name).toBe('Hot');
  });

  it('B-4405: tenant categories, managed from Social and messaging; removing one leaves its groups uncategorised, not hidden', async () => {
    await ann.post(`${S}/group-categories`, { name: 'Projects' }).expect(403);
    const proj = (await ta.post(`${S}/group-categories`, { name: 'Projects', description: 'Time-boxed work' }).expect(201)).body;
    const teams = (await ta.post(`${S}/group-categories`, { name: 'Teams' }).expect(201)).body;
    await ta.post(`${S}/group-categories`, { name: 'projects' }).expect(409);
    expect(proj.position).toBe(0);
    expect(teams.position).toBe(1);
    expect((await ann.get('/api/group-categories').expect(200)).body.map((c: { name: string }) => c.name)).toEqual(['Projects', 'Teams']);
    await ta.patch(`${S}/group-categories/${teams.id}`, { name: 'Standing teams', position: 0 }).expect(200);
    await ta.patch(`${S}/group-categories/${teams.id}`, { name: 'PROJECTS' }).expect(409);
    expect((await ann.get('/api/group-categories').expect(200)).body.map((c: { name: string }) => c.name)).toEqual(['Projects', 'Standing teams']);

    await owner.post('/api/groups', { workspaceId: ws, name: 'Bad category', categoryId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }).expect(422);
    const close = await group(owner, { name: 'Close project', categoryId: proj.id });
    expect(close.categoryId).toBe(proj.id);
    const plain = await group(owner, { name: 'Plain' });
    await owner.patch(`/api/groups/${plain.id}`, { categoryId: teams.id }).expect(200);
    await ann.patch(`/api/groups/${plain.id}`, { categoryId: null }).expect(403);
    await group(owner, { name: 'Loose' });

    expect(names((await ann.get(`/api/groups?category=${proj.id}`).expect(200)).body)).toEqual(['Close project']);
    expect(names((await ann.get('/api/groups?category=none').expect(200)).body)).toEqual(['Loose']);
    expect(names((await ben.get(`/api/groups/discover?category=${teams.id}`).expect(200)).body.groups)).toEqual(['Plain']);
    const admin = (await ta.get(`${S}/groups`).expect(200)).body;
    expect(admin.categories.categories.map((c: { name: string; groups: number }) => `${c.name}:${c.groups}`)).toEqual(['Projects:1', 'Standing teams:1']);
    expect(admin.categories.uncategorised).toBe(1);
    expect(admin.groups.find((g: { name: string }) => g.name === 'Close project')).toMatchObject({ categoryId: proj.id, parentId: null });

    const out = (await ta.del(`${S}/group-categories/${proj.id}`).expect(200)).body;
    expect(out).toMatchObject({ removed: true, uncategorised: 1 });
    const ev = await audits(h, 'group.category.removed').first();
    expect(JSON.parse(ev.detail)).toMatchObject({ name: 'Projects', uncategorised: 1 });
    // still listed, uncategorised
    const g = (await ann.get(`/api/groups/${close.id}`).expect(200)).body;
    expect(g).toMatchObject({ name: 'Close project', categoryId: null, state: 'active' });
    expect(names((await ann.get('/api/groups?category=none').expect(200)).body)).toEqual(['Close project', 'Loose']);
    expect(names((await ann.get('/api/groups').expect(200)).body)).toContain('Close project');
    await ta.del(`${S}/group-categories/${proj.id}`).expect(404);
  });
});
