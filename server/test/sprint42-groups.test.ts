import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normaliseTags, websiteOf } from '../src/groups/profile.js';
import { decodeCursor, encodeCursor } from '../src/groups/paging.js';
import { FakeClamd, TINY_PNG } from './sprint26d-fakes.js';
import { harness, localUser, login, type Client, type Harness } from './helpers.js';
import { drain } from './retrieval-seed.js';

/*
 * Sprint 42 (1.7.0), groups: profile fields, search and paging, notifications. The "done when" of each item is a test
 * below:
 *   B-9703 a group at its member limit refuses the next join and request;
 *   B-9704 searching a 5,000-member group's members returns pages in a stable order;
 *   B-9708 rescheduling an event notifies its attendees once, and never one who has lost access.
 */

type Person = Awaited<ReturnType<typeof personIn>>;

async function personIn(h: Harness, name: string, workspaces: string[], roles: string[] = ['member']) {
  const user = await localUser(h, name, roles);
  for (const w of workspaces) await h.s.tenants.addMember(w, user.id);
  const c: Client = await login(h, name);
  const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
  return {
    user,
    ...c,
    post: (p: string, b?: object) => send('post', p, b),
    patch: (p: string, b?: object) => send('patch', p, b),
    del: (p: string) => send('delete', p),
    get: (p: string) => c.agent.get(p),
    image: (path: string, data: Buffer, type = 'image/png') => c.agent.put(path).set('x-csrf-token', c.csrf).set('content-type', type).send(data)
  };
}

const wall = (ms: number) => new Date(ms).toISOString().slice(0, 16);
const notes = (h: Harness, kind: string, userId?: string) => h.s.db('notifications').where({ tenant_id: h.tenantId, kind, ...(userId ? { user_id: userId } : {}) }) as Promise<{ user_id: string; title: string; body: string | null }[]>;
const audits = (h: Harness, action: string) => h.s.db('audit_events').where({ action }) as Promise<{ detail: string | null }[]>;

describe('group profile helpers (B-9703, B-9704)', () => {
  it('normalises tags and websites, and reads only its own cursors', () => {
    expect(normaliseTags(['  Type  Design ', '#Kerning', 'kerning', '', 'TYPE design'])).toEqual(['type design', 'kerning']);
    expect(websiteOf(' https://example.test/fonts ')).toBe('https://example.test/fonts');
    for (const bad of ['javascript:alert(1)', 'example.test', 'https://user:pw@example.test/', 'ftp://example.test/']) expect(() => websiteOf(bad)).toThrow();
    const c = encodeCursor([12, 'abc']);
    expect(decodeCursor(c, ['number', 'string'] as const)).toEqual([12, 'abc']);
    expect(() => decodeCursor(c, ['string', 'string'] as const)).toThrow();
    expect(() => decodeCursor('not-a-cursor', ['number', 'string'] as const)).toThrow();
  });
});

describe('groups: profile fields, search and paging, notifications (Sprint 42)', () => {
  let h: Harness;
  let clamd: FakeClamd;
  let ws: string;
  let alice: Person;
  let bob: Person;
  let carol: Person;
  let dave: Person;

  beforeEach(async () => {
    clamd = await new FakeClamd().start();
    h = await harness({ CLAMD_HOST: '127.0.0.1', CLAMD_PORT: String(clamd.port) });
    ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Design', 'confidential')).id;
    alice = await personIn(h, 'alice', [ws]);
    bob = await personIn(h, 'bob', [ws]);
    carol = await personIn(h, 'carol', [ws]);
    dave = await personIn(h, 'dave', [ws]);
  }, 120_000);
  afterEach(async () => {
    await h.close();
    await clamd.stop();
  });

  it('B-9703: a group at its member limit refuses the next join and request; tags, website and images are kept', async () => {
    const g = (await alice.post('/api/groups', { workspaceId: ws, name: 'Type club', joinMode: 'open', visibility: 'public', tags: ['Type  Design', '#kerning', 'kerning'], website: 'https://example.test/type', memberLimit: 2 }).expect(201)).body;
    expect(g).toMatchObject({ tags: ['type design', 'kerning'], website: 'https://example.test/type', memberLimit: 2, full: false, avatar: null, banner: null });
    await alice.post('/api/groups', { workspaceId: ws, name: 'Bad site', website: 'javascript:alert(1)' }).expect(422);
    await alice.post('/api/groups', { workspaceId: ws, name: 'Too many', tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }).expect(400);

    // bob takes the last place; carol is refused, and the group says it is full
    await bob.post(`/api/groups/${g.id}/join`).expect(200);
    const full = await carol.post(`/api/groups/${g.id}/join`).expect(409);
    expect(full.body).toMatchObject({ title: 'Group full', step: 'member-limit', limit: 2 });
    expect((await carol.get(`/api/groups/${g.id}`).expect(200)).body).toMatchObject({ members: 2, memberLimit: 2, full: true });
    expect(await h.s.db('group_members').where({ group_id: g.id })).toHaveLength(2);

    // in request mode a full group takes no request, and no invitation either
    await alice.patch(`/api/groups/${g.id}`, { joinMode: 'request' }).expect(200);
    expect((await carol.post(`/api/groups/${g.id}/join`).expect(409)).body.step).toBe('member-limit');
    expect(await h.s.db('group_requests').where({ group_id: g.id })).toHaveLength(0);
    expect((await alice.post(`/api/groups/${g.id}/invites`, { userId: carol.user.id }).expect(409)).body.step).toBe('member-limit');

    // with room, carol asks; the limit falls back before the decision: accepting is refused and the request stays pending
    await alice.patch(`/api/groups/${g.id}`, { memberLimit: 3 }).expect(200);
    const asked = (await carol.post(`/api/groups/${g.id}/join`).expect(202)).body.request;
    await alice.patch(`/api/groups/${g.id}`, { memberLimit: 2 }).expect(200);
    expect((await alice.post(`/api/group-requests/${asked.id}/accept`).expect(409)).body.step).toBe('member-limit');
    expect((await h.s.db('group_requests').where({ id: asked.id }).first()).state).toBe('pending');
    // lowering the limit below the count removes nobody; lifting it lets the request through
    await alice.patch(`/api/groups/${g.id}`, { memberLimit: 1 }).expect(200);
    expect(await h.s.db('group_members').where({ group_id: g.id })).toHaveLength(2);
    await alice.patch(`/api/groups/${g.id}`, { memberLimit: null }).expect(200);
    await alice.post(`/api/group-requests/${asked.id}/accept`).expect(200);
    expect((await carol.get(`/api/groups/${g.id}`).expect(200)).body).toMatchObject({ members: 3, memberLimit: null, full: false, role: 'member' });

    // the avatar goes through the file store: nothing is served before its scan released it
    await bob.image(`/api/groups/${g.id}/avatar`, TINY_PNG).expect(403); // a member, not an owner
    await alice.image(`/api/groups/${g.id}/avatar`, Buffer.from('not an image'), 'text/plain').expect(415);
    const up = (await alice.image(`/api/groups/${g.id}/avatar`, TINY_PNG).expect(202)).body;
    expect(up.avatar).toMatchObject({ state: 'scanning', url: null });
    await bob.get(`/api/groups/${g.id}/avatar`).expect(404);
    await drain(h);
    const ready = (await bob.get(`/api/groups/${g.id}`).expect(200)).body;
    expect(ready.avatar).toMatchObject({ state: 'ready', url: `/api/groups/${g.id}/avatar?v=1` });
    const img = await bob.get(ready.avatar.url).buffer(true).expect(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(img.body as Buffer, TINY_PNG)).toBe(0);
    // an infected banner is never shown
    clamd.signatures = ['EVIL-MARKER'];
    await alice.image(`/api/groups/${g.id}/banner`, Buffer.concat([TINY_PNG, Buffer.from('EVIL-MARKER')])).expect(202);
    await drain(h);
    const after = (await bob.get(`/api/groups/${g.id}`).expect(200)).body;
    expect(after.banner).toMatchObject({ state: 'rejected', url: null });
    await bob.get(`/api/groups/${g.id}/banner`).expect(404);
    await alice.del(`/api/groups/${g.id}/banner`).expect(200);
    expect((await bob.get(`/api/groups/${g.id}`).expect(200)).body.banner).toBeNull();
    expect(await audits(h, 'group.avatar.set')).toHaveLength(1);
    expect(await audits(h, 'group.banner.removed')).toHaveLength(1);
  }, 120_000);

  it('B-9704: searching a 5,000-member group’s members returns pages in a stable order', async () => {
    const g = (await alice.post('/api/groups', { workspaceId: ws, name: 'Everyone', visibility: 'public', joinMode: 'open' }).expect(201)).body;
    // 5,000 members, many of them joined in the same millisecond (the id decides between them)
    const t0 = Date.now() - 10_000_000;
    const users: Record<string, unknown>[] = [];
    const members: Record<string, unknown>[] = [];
    for (let i = 0; i < 5000; i++) {
      const id = ulid();
      const n = String(i).padStart(4, '0');
      users.push({ id, tenant_id: h.tenantId, username: `m${n}`, display_name: i % 10 === 0 ? `Decade ${n}` : `Member ${n}`, state: 'active', clearance: 'internal', mfa_required: false, created_at: t0, updated_at: t0 });
      members.push({ group_id: g.id, tenant_id: h.tenantId, user_id: id, role: 'member', added_by: null, joined_at: t0 + Math.floor(i / 7) });
    }
    for (let i = 0; i < users.length; i += 100) await h.s.db('users').insert(users.slice(i, i + 100));
    for (let i = 0; i < members.length; i += 100) await h.s.db('group_members').insert(members.slice(i, i + 100));

    const walk = async (query: string, between?: (page: number) => Promise<void>) => {
      const seen: { userId: string; joinedAt: number; displayName: string }[] = [];
      let cursor: string | null = null;
      let total = 0;
      for (let page = 0; page < 100; page++) {
        const body = (await alice.get(`/api/groups/${g.id}/members?${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`).expect(200)).body as { items: typeof seen; next: string | null; total: number };
        seen.push(...body.items);
        total = body.total;
        cursor = body.next;
        if (!cursor) break;
        if (between) await between(page);
      }
      return { seen, total };
    };
    const ordered = (rows: { userId: string; joinedAt: number }[]) => rows.every((r, i) => i === 0 || rows[i - 1]!.joinedAt < r.joinedAt || (rows[i - 1]!.joinedAt === r.joinedAt && rows[i - 1]!.userId < r.userId));

    // every member once, in the same order on every walk
    const all = await walk('limit=200');
    expect(all.total).toBe(5001);
    expect(all.seen).toHaveLength(5001);
    expect(new Set(all.seen.map((m) => m.userId)).size).toBe(5001);
    expect(ordered(all.seen)).toBe(true);
    const again = await walk('limit=137');
    expect(again.seen.map((m) => m.userId)).toEqual(all.seen.map((m) => m.userId));

    // a search: 500 matches in pages of 60, in the same order as the whole list
    const found = await walk('q=decade&limit=60');
    expect(found.total).toBe(500);
    expect(found.seen).toHaveLength(500);
    expect(found.seen.every((m) => m.displayName.startsWith('Decade'))).toBe(true);
    expect(found.seen.map((m) => m.userId)).toEqual(all.seen.filter((m) => m.displayName.startsWith('Decade')).map((m) => m.userId));
    // wildcards typed into a search match nothing by themselves
    expect((await alice.get(`/api/groups/${g.id}/members?q=${encodeURIComponent('%')}&limit=5`).expect(200)).body.total).toBe(5001);
    expect((await alice.get(`/api/groups/${g.id}/members?q=m0042&limit=5`).expect(200)).body.items.map((m: { username: string }) => m.username)).toEqual(['m0042']);

    // members who leave and join between two pages neither repeat nor skip the others
    const gone = new Set<string>();
    const moving = await walk('q=decade&limit=60', async (page) => {
      if (page !== 1) return;
      // two already listed leave, two not yet listed leave, and someone joins at the end
      const listed = found.seen.slice(0, 2).map((m) => m.userId);
      const ahead = found.seen.slice(300, 302).map((m) => m.userId);
      for (const u of [...listed, ...ahead]) gone.add(u);
      await h.s.db('group_members').where({ group_id: g.id }).whereIn('user_id', [...listed, ...ahead]).delete();
      await bob.post(`/api/groups/${g.id}/join`).expect(200);
    });
    const expected = found.seen.map((m) => m.userId).filter((u) => !found.seen.slice(300, 302).some((x) => x.userId === u));
    expect(moving.seen.map((m) => m.userId)).toEqual(expected);
    expect(gone.size).toBe(4);

    // without limit or cursor the answer is the list it always was; a foreign cursor is refused
    const plain = (await alice.get(`/api/groups/${g.id}/members?q=decade%204990`).expect(200)).body;
    expect(Array.isArray(plain)).toBe(true);
    expect(plain).toHaveLength(1);
    await alice.get(`/api/groups/${g.id}/members?limit=10&cursor=abc`).expect(400);
    await alice.get(`/api/groups/${g.id}/members?limit=500`).expect(400);
  }, 180_000);

  it('B-9704: groups and attendees are searched and paged too, and discovery takes a search', async () => {
    const names = ['Alpha type', 'beta Type', 'Gamma', 'delta', 'Type Zeta', 'alpha type'];
    const ids: string[] = [];
    for (const [i, name] of names.entries()) ids.push((await alice.post('/api/groups', { workspaceId: ws, name, visibility: 'public', joinMode: 'open', ...(i === 2 ? { tags: ['typefaces'] } : {}) }).expect(201)).body.id);
    // by name or tag, two at a time, in code-point order and then by id
    const pages: { name: string; id: string }[][] = [];
    let cursor: string | null = null;
    do {
      const body = (await bob.get(`/api/groups?q=type&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`).expect(200)).body as { items: { name: string; id: string }[]; next: string | null; total: number };
      expect(body.total).toBe(5);
      pages.push(body.items);
      cursor = body.next;
    } while (cursor);
    expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);
    expect(pages.flat().map((x) => x.name)).toEqual(['Alpha type', 'Gamma', 'Type Zeta', 'alpha type', 'beta Type']);
    // the plain list still answers an array, now with the search
    expect(((await bob.get('/api/groups?q=typefaces').expect(200)).body as { name: string }[]).map((x) => x.name)).toEqual(['Gamma']);
    expect(((await bob.get('/api/groups/discover?q=zeta').expect(200)).body.groups as { name: string }[]).map((x) => x.name)).toEqual(['Type Zeta']);

    // attendees
    const g = ids[0]!;
    for (const p of [bob, carol, dave]) await p.post(`/api/groups/${g}/join`).expect(200);
    const e = (await alice.post(`/api/groups/${g}/events`, { title: 'Review', start: wall(Date.now() + 5 * 86_400_000), durationMinutes: 60, timeZone: 'UTC' }).expect(201)).body;
    for (const [p, response] of [[alice, 'going'], [bob, 'going'], [carol, 'maybe'], [dave, 'declined']] as const) await p.post(`/api/calendar/events/${e.id}/rsvp`, { response }).expect(200);
    const first = (await alice.get(`/api/calendar/events/${e.id}/attendees?limit=3`).expect(200)).body;
    expect(first.total).toBe(4);
    expect(first.items.map((x: { username: string }) => x.username)).toEqual(['alice', 'bob', 'carol']);
    const second = (await alice.get(`/api/calendar/events/${e.id}/attendees?limit=3&cursor=${encodeURIComponent(first.next)}`).expect(200)).body;
    expect(second.items.map((x: { username: string }) => x.username)).toEqual(['dave']);
    expect(second.next).toBeNull();
    // a member does not see who declined, paged or not
    expect((await bob.get(`/api/calendar/events/${e.id}/attendees?limit=10`).expect(200)).body.total).toBe(3);
    expect((await alice.get(`/api/calendar/events/${e.id}/attendees?q=CAR&limit=10`).expect(200)).body.items.map((x: { username: string }) => x.username)).toEqual(['carol']);
    expect((await alice.get(`/api/calendar/events/${e.id}/attendees?response=going`).expect(200)).body.map((x: { username: string }) => x.username)).toEqual(['alice', 'bob']);
  }, 120_000);

  it('B-9708: rescheduling an event notifies its attendees once, and never one who has lost access', async () => {
    const g = (await alice.post('/api/groups', { workspaceId: ws, name: 'Type club', visibility: 'public', joinMode: 'open' }).expect(201)).body;
    for (const p of [bob, carol, dave]) await p.post(`/api/groups/${g.id}/join`).expect(200);
    // the owner hears of each join, the joiner does not
    expect((await notes(h, 'group.member', alice.user.id)).map((n) => n.title)).toEqual(['BOB joined Type club', 'CAROL joined Type club', 'DAVE joined Type club']);
    expect(await notes(h, 'group.member', bob.user.id)).toHaveLength(0);

    const start = Date.now() + 5 * 86_400_000;
    const e = (await alice.post(`/api/groups/${g.id}/events`, { title: 'Specimen review', start: wall(start), durationMinutes: 60, timeZone: 'UTC' }).expect(201)).body;
    // the members hear of the new event; its creator does not, and the notice does not carry the sealed title
    const created = await notes(h, 'event.created');
    expect(created.map((n) => n.user_id).sort()).toEqual([bob.user.id, carol.user.id, dave.user.id].sort());
    expect(created.every((n) => n.title === 'A new event in Type club' && !`${n.title}${n.body}`.includes('Specimen'))).toBe(true);

    for (const p of [bob, carol]) await p.post(`/api/calendar/events/${e.id}/rsvp`, { response: 'going' }).expect(200);
    await dave.post(`/api/calendar/events/${e.id}/rsvp`, { response: 'declined' }).expect(200);
    // carol loses access: she leaves the workspace, and her RSVP row stays behind
    await h.s.tenants.removeMember(ws, carol.user.id);
    expect(await h.s.db('group_event_rsvps').where({ event_id: e.id, user_id: carol.user.id })).toHaveLength(1);

    // a change that moves nothing tells nobody
    await alice.patch(`/api/calendar/events/${e.id}`, { title: 'Specimen review, room 2' }).expect(200);
    await alice.patch(`/api/calendar/events/${e.id}`, { start: wall(start), durationMinutes: 60 }).expect(200);
    expect(await notes(h, 'event.rescheduled')).toHaveLength(0);

    // the move: bob (going) is told once; carol (no access), dave (declined) and alice (who moved it) are not
    const moved = (await alice.patch(`/api/calendar/events/${e.id}`, { start: wall(start + 86_400_000) }).expect(200)).body;
    expect(moved.notified).toBe(1);
    let told = await notes(h, 'event.rescheduled');
    expect(told.map((n) => n.user_id)).toEqual([bob.user.id]);
    expect(told[0]).toMatchObject({ title: 'An event in Type club was moved' });
    // the same request again moves nothing and tells nobody
    expect((await alice.patch(`/api/calendar/events/${e.id}`, { start: wall(start + 86_400_000) }).expect(200)).body.notified).toBeUndefined();
    expect(await notes(h, 'event.rescheduled')).toHaveLength(1);
    // a second attempt at the notice for the same change (a retry, another instance) finds its row and sends nothing
    const row = await h.s.db('group_event_notices').where({ event_id: e.id, kind: 'rescheduled' }).first();
    expect(row).toMatchObject({ dedupe: `rescheduled:${e.id}:${moved.sequence}`, recipients: 1 });
    const cal = h.s.calendar as unknown as { noticeRescheduled(b: unknown, a: unknown, g: unknown, by: string): Promise<number>; row(t: string, id: string): Promise<unknown> };
    const ev = { ...((await cal.row(h.tenantId, e.id)) as object), sequence: moved.sequence };
    expect(await cal.noticeRescheduled(ev, ev, await h.s.groups.row(h.tenantId, g.id), alice.user.id)).toBe(0);
    expect(await notes(h, 'event.rescheduled')).toHaveLength(1);
    // another move is another notice, still never to carol; once she is back and still going, she is told again
    await alice.patch(`/api/calendar/events/${e.id}`, { start: wall(start + 2 * 86_400_000) }).expect(200);
    told = await notes(h, 'event.rescheduled');
    expect(told.map((n) => n.user_id)).toEqual([bob.user.id, bob.user.id]);
    await h.s.tenants.addMember(ws, carol.user.id);
    await alice.patch(`/api/calendar/events/${e.id}`, { start: wall(start + 3 * 86_400_000) }).expect(200);
    expect((await notes(h, 'event.rescheduled', carol.user.id))).toHaveLength(1);
    expect((await audits(h, 'group.event.updated')).filter((a) => JSON.parse(a.detail ?? '{}').attendeesNotified !== undefined)).toHaveLength(3);

    // "notify attendees": a moderator's message, kept with the event; the notification does not carry it
    await bob.post(`/api/calendar/events/${e.id}/notify`, { message: 'Bring proofs.' }).expect(403);
    await h.s.tenants.removeMember(ws, carol.user.id);
    const sent = (await alice.post(`/api/calendar/events/${e.id}/notify`, { message: 'Bring your proofs, we start in room 2.' }).expect(201)).body;
    expect(sent).toMatchObject({ kind: 'message', notified: 1, message: 'Bring your proofs, we start in room 2.' });
    const msgs = await notes(h, 'event.notice');
    expect(msgs.map((n) => n.user_id)).toEqual([bob.user.id]);
    expect(`${msgs[0]!.title}${msgs[0]!.body}`).not.toContain('proofs');
    const stored = await h.s.db('group_event_notices').where({ id: sent.id }).first();
    expect(String(stored.body)).not.toContain('proofs');
    const list = (await bob.get(`/api/calendar/events/${e.id}/notices`).expect(200)).body as { kind: string; message: string | null }[];
    expect(list[0]).toMatchObject({ kind: 'message', message: 'Bring your proofs, we start in room 2.' });
    expect(list.filter((n) => n.kind === 'rescheduled')).toHaveLength(3);
    await carol.get(`/api/calendar/events/${e.id}/notices`).expect(404);
    // five messages in 24 hours, then 429
    for (let i = 0; i < 4; i++) await alice.post(`/api/calendar/events/${e.id}/notify`, { message: `Note ${i}` }).expect(201);
    const limited = await alice.post(`/api/calendar/events/${e.id}/notify`, { message: 'One more' }).expect(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

    // role and membership changes: the member is told, by name of the group only
    await alice.patch(`/api/groups/${g.id}/members/${bob.user.id}`, { role: 'moderator' }).expect(200);
    expect((await notes(h, 'group.role', bob.user.id)).map((n) => n.title)).toEqual(['Your role in Type club is now moderator']);
    await alice.del(`/api/groups/${g.id}/members/${dave.user.id}`).expect(200);
    expect((await notes(h, 'group.member', dave.user.id)).map((n) => n.title)).toEqual(['You were removed from Type club']);
    // bob leaves: the owner hears of it; carol, removed while outside the workspace, is told nothing
    await bob.del(`/api/groups/${g.id}/members/${bob.user.id}`).expect(200);
    expect((await notes(h, 'group.member', alice.user.id)).map((n) => n.title)).toContain('BOB left Type club');
    await alice.del(`/api/groups/${g.id}/members/${carol.user.id}`).expect(200);
    expect(await notes(h, 'group.member', carol.user.id)).toHaveLength(0);
  }, 120_000);
});
