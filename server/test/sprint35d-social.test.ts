import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { digestWeekEnd } from '../src/feed/digest.js';
import { TOPICS } from '../src/platform/bus.js';
import { attachRealtime } from '../src/realtime/socket.js';
import { RoomStats } from '../src/realtime/rooms.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';
import { drain } from './retrieval-seed.js';
import { seedGateway } from './seed-gateway.js';

/*
 * Sprint 35d, Social and messaging live (B-4206): workspace policies for the feed, groups and messaging, trending
 * exclusions and digest settings, group administration and calendar feed revocation, legal-hold exports under dual
 * control (decision Q5), realtime counts and contact rules. The item's "done when" is the calendar feed test: a revoked
 * feed answers 404 on its next fetch.
 */

const S = '/api/admin/social';
type Person = Awaited<ReturnType<typeof personIn>>;

async function personIn(h: Harness, name: string, workspaces: string[], roles: string[] = ['member'], clearance: 'public' | 'internal' | 'confidential' | 'restricted' = 'internal') {
  const user = await localUser(h, name, roles, clearance);
  for (const w of workspaces) await h.s.tenants.addMember(w, user.id);
  const first = await login(h, name);
  const c: Client = first.res.body.stage === 'enroll' ? await loginAdmin(h, name) : first;
  const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
  return {
    user,
    ...c,
    post: (p: string, b?: object) => send('post', p, b),
    put: (p: string, b?: object) => send('put', p, b),
    del: (p: string) => send('delete', p),
    get: (p: string) => c.agent.get(p),
    upload: (ws: string, n: string, data: string) =>
      c.agent
        .put(`/api/files/uploads?${new URLSearchParams({ name: n, workspace: ws }).toString()}`)
        .set('x-csrf-token', c.csrf)
        .set('content-type', 'application/octet-stream')
        .send(Buffer.from(data))
  };
}

const audits = (h: Harness, action: string) => h.s.db('audit_events').where({ action });

describe('the digest week', () => {
  it('ends at the tenant’s weekday and hour (UTC), Monday 00:00 by default', () => {
    const wed = Date.parse('2026-10-07T15:00:00Z');
    expect(digestWeekEnd(wed)).toBe(Date.parse('2026-10-05T00:00:00Z'));
    expect(digestWeekEnd(wed, 4, 16)).toBe(Date.parse('2026-10-02T16:00:00Z')); // Friday 16:00, the week before
    expect(digestWeekEnd(wed, 2, 15)).toBe(wed);
    expect(digestWeekEnd(wed, 2, 16)).toBe(Date.parse('2026-09-30T16:00:00Z'));
  });

  it('counts signals and refusals by kind and minute, and auth failures for an hour', () => {
    const st = new RoomStats();
    const t = Date.parse('2026-10-07T15:00:30Z');
    st.signal('conversation', t - 120_000);
    st.signal('conversation', t);
    st.signal('conversation', t);
    st.refused('feed', t);
    st.authFailed(t - 2 * 3_600_000);
    st.authFailed(t);
    const snap = st.snapshot(t);
    const conv = snap.kinds.find((k) => k.kind === 'conversation')!;
    expect(conv.signalsPerMinute).toHaveLength(12);
    expect(conv.signalsPerMinute.slice(-3)).toEqual([1, 0, 2]);
    expect(snap.kinds.find((k) => k.kind === 'feed')!.refusedLastHour).toBe(1);
    expect(snap.authFailuresLastHour).toBe(1);
    expect(snap.sockets).toBe(0);
  });
});

describe('Social and messaging (Sprint 35d, B-4206)', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let ws: string;
  let field: string;
  let ta: Person;
  let sa: Person;
  let alice: Person;
  let bob: Person;

  beforeEach(async () => {
    ollama = await new FakeOllama().start();
    h = await harness({ FEED_DIGEST_PROFILE: 'general' });
    ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Finance Ops', 'confidential')).id;
    field = (await h.s.tenants.createWorkspace(h.tenantId, 'Field Sales', 'internal')).id;
    ta = await personIn(h, 'ta', [ws, field], ['tenant-admin'], 'confidential');
    sa = await personIn(h, 'sa', [ws], ['system-admin'], 'restricted');
    alice = await personIn(h, 'alice', [ws]);
    bob = await personIn(h, 'bob', [ws]);
  }, 60_000);
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  it('shows and changes workspace policies with social:manage; the moderation-facing ones are audited as weakened', async () => {
    await alice.get(`${S}/feed`).expect(403);
    await alice.put(`${S}/policies/${ws}`, { feedMedia: false }).expect(403);
    const feed = (await ta.get(`${S}/feed`).expect(200)).body;
    expect(feed.workspaces.find((w: { id: string }) => w.id === ws)).toMatchObject({ name: 'Finance Ops', label: 'confidential', feedGuard: true, feedApprover: 'reviewers', feedMedia: true, feedMediaMaxBytes: null, held: 0 });
    expect(feed.canModerate).toBe(true);
    expect(feed.trending).toMatchObject({ minutes: 60, hours: 72 });
    const after = (await ta.put(`${S}/policies/${ws}`, { feedMediaMaxBytes: 20 * 1048576, feedGuard: false }).expect(200)).body;
    expect(after).toMatchObject({ workspaceId: ws, feedGuard: false, feedMediaMaxBytes: 20 * 1048576 });
    const ev = await audits(h, 'social.policy.updated').first();
    expect(JSON.parse(ev.detail)).toMatchObject({ changed: ['feedGuard', 'feedMediaMaxBytes'], weakened: 'feedGuard', before: { feedGuard: true }, after: { feedGuard: false } });
    await ta.put(`${S}/policies/01ARZ3NDEKTSV4RRFFQ69G5FAV`, { feedMedia: false }).expect(404);
    await ta.put(`${S}/policies/${ws}`, { feedApprover: 'nobody' }).expect(400);
    // turning media off clears the size
    expect((await ta.put(`${S}/policies/${ws}`, { feedMedia: false }).expect(200)).body).toMatchObject({ feedMedia: false, feedMediaMaxBytes: null });
  });

  it('applies the feed policies: media refused, held posts decided by the named approvers, user-input off keeps only the baseline', async () => {
    const ga = await personIn(h, 'ga', [ws], ['guardrail-admin'], 'confidential');
    const fr = await personIn(h, 'fr', [ws], ['flag-reviewer'], 'confidential');
    const set = (await ga.post('/api/admin/guardrails/sets', { name: 'Feed rules', scope: 'tenant' }).expect(201)).body;
    await ga.put(`/api/admin/guardrails/sets/${set.id}/draft`, { rules: [{ id: 'wire', name: 'Wire transfers', checkpoint: 'user-input', type: 'pattern', mechanism: { kind: 'pattern', pattern: '(?i)wire transfer' }, action: 'require-approval', stage: 'enforce' }] }).expect(200);
    await ga.post(`/api/admin/guardrails/sets/${set.id}/draft/publish`).expect(200);

    // user-input in full: held; only holders of guardrails:manage decide when the workspace says so
    await ta.put(`${S}/policies/${ws}`, { feedApprover: 'guardrails' }).expect(200);
    const held = (await alice.post('/api/feed/posts', { workspaceId: ws, body: 'Approve the wire transfer' }).expect(202)).body;
    expect((await ta.get(`${S}/feed`).expect(200)).body.counters.held).toBe(1);
    const flag = (await fr.get('/api/flags').expect(200)).body.items.find((f: { kind: string }) => f.kind === 'hold');
    const refused = await fr.post(`/api/flags/${flag.ref}/decide`, { decision: 'approved' }).expect(403);
    expect(refused.body).toMatchObject({ step: 'approver', permission: 'guardrails:manage' });
    await ga.post(`/api/flags/${flag.ref}/decide`, { decision: 'approved' }).expect(200);
    expect((await bob.get(`/api/feed/posts/${held.id}`).expect(200)).body.state).toBe('published');

    // user-input off: the tenant's rule no longer holds internal posts; confidential ones are still checked in full
    await ta.put(`${S}/policies/${ws}`, { feedGuard: false }).expect(200);
    expect((await alice.post('/api/feed/posts', { workspaceId: ws, body: 'Another wire transfer' }).expect(201)).body.state).toBe('published');
    const carol = await personIn(h, 'carol', [ws], ['member'], 'confidential');
    await carol.post('/api/feed/posts', { workspaceId: ws, body: 'A confidential wire transfer', label: 'confidential' }).expect(202);

    // media off, then a size limit
    const file = (await alice.upload(ws, 'brief.txt', 'The launch brief, long enough').expect(202)).body;
    await drain(h);
    await ta.put(`${S}/policies/${ws}`, { feedMedia: false }).expect(200);
    expect((await alice.post('/api/feed/posts', { workspaceId: ws, body: 'With a file', media: [file.id] }).expect(422)).body.step).toBe('workspace-policy');
    await ta.put(`${S}/policies/${ws}`, { feedMedia: true, feedMediaMaxBytes: 1024 }).expect(200);
    await alice.post('/api/feed/posts', { workspaceId: ws, body: 'With a file', media: [file.id] }).expect(201);
  });

  it('keeps excluded tags out of trending, validates digest settings and sends a test digest to the requester alone', async () => {
    await seedGateway(h, ollama);
    await alice.post('/api/feed/posts', { workspaceId: ws, body: 'Close is done #monthendclose #vendorchatter' }).expect(201);
    await bob.post('/api/feed/posts', { workspaceId: ws, body: 'More #vendorchatter' }).expect(201);
    await ta.post(`${S}/trending/run`).expect(202);
    await drain(h);
    expect((await bob.get('/api/feed/trending').expect(200)).body.tags.map((t: { tag: string }) => t.tag)).toEqual(['vendorchatter', 'monthendclose']);
    // excluded at once for readers, and at the next run
    expect((await ta.post(`${S}/trending/exclusions`, { tag: '#VendorChatter' }).expect(201)).body).toEqual({ tag: 'vendorchatter', excluded: true });
    expect((await bob.get('/api/feed/trending').expect(200)).body.tags.map((t: { tag: string }) => t.tag)).toEqual(['monthendclose']);
    await h.s.feed.digests.trendingJob(h.tenantId); // the next run (the route dedupes requests within a minute)
    expect(await h.s.db('feed_trending').where({ tag: 'vendorchatter' }).first()).toBeUndefined();
    const tags = (await ta.get(`${S}/feed`).expect(200)).body.trending.tags;
    expect(tags.find((t: { tag: string }) => t.tag === 'vendorchatter')).toMatchObject({ excluded: true });
    await ta.del(`${S}/trending/exclusions/vendorchatter`).expect(200);
    expect(await audits(h, 'feed.trending.excluded').first()).toBeTruthy();
    expect(await audits(h, 'feed.trending.included').first()).toBeTruthy();

    // digest and summary settings
    expect((await ta.put(`${S}/settings`, { digestProfile: 'no-such-profile' }).expect(422)).body.field).toBe('digestProfile');
    const st = (await ta.put(`${S}/settings`, { digestProfile: 'general', digestDay: 4, digestHour: 16, digestTop: 1, digestMaxLabel: 'internal', summaryProfile: 'general' }).expect(200)).body;
    expect(st).toMatchObject({ digestProfile: 'general', digestDay: 4, digestHour: 16, digestTop: 1, digestMaxLabel: 'internal', summaryProfile: 'general' });
    expect((await ta.get(`${S}/feed`).expect(200)).body.digest).toMatchObject({ effective: { digestProfile: 'general', digestTop: 1 }, profiles: ['general'] });
    expect((await ta.get(`${S}/messaging`).expect(200)).body.summary).toMatchObject({ profile: 'general', effective: 'general' });

    // a test digest: only the requester is told, nothing is kept
    await ta.post(`${S}/digest/test`).expect(202);
    await drain(h);
    expect(JSON.stringify((await ta.get('/api/me/notifications').expect(200)).body)).toMatch(/Test digest for Finance Ops/);
    expect(JSON.stringify((await bob.get('/api/me/notifications').expect(200)).body)).not.toMatch(/Test digest/);
    expect(await h.s.db('feed_digests').first()).toBeUndefined();
  });

  it('applies group defaults, transfers ownership, archives read only, and a revoked calendar feed answers 404 on its next fetch', async () => {
    await ta.put(`${S}/policies/${ws}`, { groupCreate: 'admins', groupVisibility: 'public', groupJoin: 'open', eventCapacity: 25 }).expect(200);
    expect((await alice.post('/api/groups', { workspaceId: ws, name: 'Month-end close' }).expect(403)).body.step).toBe('workspace-policy');
    await ta.put(`${S}/policies/${ws}`, { groupCreate: 'members' }).expect(200);
    const g = (await alice.post('/api/groups', { workspaceId: ws, name: 'Month-end close' }).expect(201)).body;
    expect(g).toMatchObject({ visibility: 'public', joinMode: 'open' });
    await bob.post(`/api/groups/${g.id}/join`).expect(200);
    const ev = (await alice.post(`/api/groups/${g.id}/events`, { title: 'Close review', start: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 16), timeZone: 'UTC' }).expect(201)).body;
    expect(ev.capacity).toBe(25);

    const view = (await ta.get(`${S}/groups`).expect(200)).body;
    expect(view.defaults.find((d: { workspaceId: string }) => d.workspaceId === ws)).toMatchObject({ groupCreate: 'members', groupVisibility: 'public', groupJoin: 'open', eventCapacity: 25 });
    expect(view.groups.find((x: { id: string }) => x.id === g.id)).toMatchObject({ name: 'Month-end close', workspace: 'Finance Ops', members: 2, upcomingEvents: 1, feeds: 0, state: 'active', owners: [{ userId: alice.user.id }] });
    await alice.get(`${S}/groups`).expect(403);

    // B-4206 done when: a revoked calendar feed answers 404 on its next fetch
    const feed = (await bob.post('/api/calendar/feeds', { kind: 'group', targetId: g.id }).expect(201)).body;
    const path = new URL(feed.url).pathname;
    await bob.agent.get(path).set('cookie', '').expect(200);
    const listed = (await ta.get(`${S}/groups`).expect(200)).body;
    expect(listed.feeds.find((f: { id: string }) => f.id === feed.id)).toMatchObject({ kind: 'group', state: 'active', issuedTo: { userId: bob.user.id }, label: 'internal' });
    expect(listed.groups.find((x: { id: string }) => x.id === g.id).feeds).toBe(1);
    await alice.post(`${S}/calendar-feeds/${feed.id}/revoke`).expect(403);
    expect((await ta.post(`${S}/calendar-feeds/${feed.id}/revoke`).expect(200)).body).toMatchObject({ url: null });
    await bob.agent.get(path).set('cookie', '').expect(404);
    expect(JSON.parse((await audits(h, 'calendar.feed.revoked').first()).detail)).toMatchObject({ via: 'social-admin' });

    // ownership: a member only; the previous owners become moderators; the members are told
    const members = (await ta.get(`${S}/groups/${g.id}/members`).expect(200)).body.members;
    expect(members.map((m: { username: string }) => m.username).sort()).toEqual(['alice', 'bob']);
    await ta.post(`${S}/groups/${g.id}/transfer`, { userId: ta.user.id }).expect(422);
    expect((await ta.post(`${S}/groups/${g.id}/transfer`, { userId: bob.user.id }).expect(200)).body).toMatchObject({ owners: [bob.user.id], moderators: [alice.user.id] });
    const roles = (await bob.get(`/api/groups/${g.id}/members`).expect(200)).body.map((m: { username: string; role: string }) => `${m.username}:${m.role}`).sort();
    expect(roles).toEqual(['alice:moderator', 'bob:owner']);
    expect(await audits(h, 'group.ownership.transferred').first()).toBeTruthy();

    // archive: read only for everyone; the feed stays readable
    await bob.post('/api/feed/posts', { groupId: g.id, body: 'Before the archive' }).expect(201);
    expect((await ta.post(`${S}/groups/${g.id}/archive`).expect(200)).body).toMatchObject({ state: 'archived', members: 2 });
    await bob.post('/api/feed/posts', { groupId: g.id, body: 'After the archive' }).expect(409);
    await alice.post(`/api/groups/${g.id}/events`, { title: 'Too late', start: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 16), timeZone: 'UTC' }).expect(409);
    const carol = await personIn(h, 'carol', [ws]);
    await carol.post(`/api/groups/${g.id}/join`).expect(409);
    expect((await alice.get(`/api/feed/groups/${g.id}`).expect(200)).body.items.length).toBe(1);
    expect((await ta.get(`${S}/groups`).expect(200)).body.groups.find((x: { id: string }) => x.id === g.id).state).toBe('archived');
    expect(JSON.stringify((await alice.get('/api/me/notifications').expect(200)).body)).toMatch(/was archived/);
  });

  it('applies workspace contact rules on top of each person’s own', async () => {
    const C = '/api/messaging/conversations';
    await ta.put(`${S}/policies/${ws}`, { contactRule: 'contacts' }).expect(200);
    await alice.post(C, { kind: 'direct', userId: bob.user.id }).expect(403);
    await alice.post('/api/social/following', { userId: bob.user.id }).expect(201);
    await alice.post(C, { kind: 'direct', userId: bob.user.id }).expect(403);
    await bob.post('/api/social/following', { userId: alice.user.id }).expect(201);
    await alice.post(C, { kind: 'direct', userId: bob.user.id }).expect(201);
    await ta.put(`${S}/policies/${ws}`, { contactRule: 'admins' }).expect(200);
    const carol = await personIn(h, 'carol', [ws]);
    await alice.post(C, { kind: 'direct', userId: carol.user.id }).expect(403);
    await ta.post(C, { kind: 'direct', userId: carol.user.id }).expect(201);
    // another workspace the two share that lets anyone in is enough
    await h.s.tenants.addMember(field, alice.user.id);
    await h.s.tenants.addMember(field, carol.user.id);
    await alice.post(C, { kind: 'direct', userId: carol.user.id }).expect(201);
    expect((await ta.get(`${S}/relations`).expect(200)).body).toMatchObject({ counts: { follows: 2, blocks: 0 }, rules: expect.arrayContaining([{ workspaceId: ws, name: 'Finance Ops', contactRule: 'admins' }]) });
  });

  it('exports a conversation for a legal hold only after a second platform admin approves', async () => {
    const C = '/api/messaging/conversations';
    const conv = (await alice.post(C, { kind: 'direct', userId: bob.user.id }).expect(201)).body;
    await alice.post(`${C}/${conv.id}/messages`, { body: 'The vendor invoice is attached' }).expect(201);
    await bob.post(`${C}/${conv.id}/messages`, { body: '=SUM(A1) checked, thanks' }).expect(201);
    const list = (await ta.get(`${S}/conversations`).expect(200)).body;
    expect(list.find((c: { id: string }) => c.id === conv.id)).toMatchObject({ kind: 'direct', members: 2, title: expect.stringMatching(/ALICE and BOB|BOB and ALICE/) });
    expect(JSON.stringify(list)).not.toContain('vendor invoice');
    const msg = (await ta.get(`${S}/messaging`).expect(200)).body;
    expect(msg.approvers.map((a: { userId: string }) => a.userId)).toEqual([sa.user.id]);
    expect(msg.canApprove).toBe(false);

    const reason = 'Case LH-2026-14: preservation notice from counsel';
    expect((await ta.post(`${S}/exports`, { conversationId: conv.id, reason, approverId: ta.user.id }).expect(403)).body.step).toBe('dual-control');
    await ta.post(`${S}/exports`, { conversationId: conv.id, reason, approverId: alice.user.id }).expect(422);
    await ta.post(`${S}/exports`, { conversationId: conv.id, reason: 'short', approverId: sa.user.id }).expect(400);
    const x = (await ta.post(`${S}/exports`, { conversationId: conv.id, reason, approverId: sa.user.id }).expect(201)).body;
    expect(x).toMatchObject({ state: 'pending', reason, approver: { userId: sa.user.id }, mine: true, canDecide: false });
    await ta.post(`${S}/exports`, { conversationId: conv.id, reason, approverId: sa.user.id }).expect(409);
    // nothing is read before the approval; the requester cannot approve
    await ta.post(`${S}/exports/${x.id}/approve`).expect(403);
    expect(JSON.stringify((await sa.get('/api/me/notifications').expect(200)).body)).toMatch(/approve a conversation export/);
    const pending = (await sa.get(`${S}/messaging`).expect(200)).body.exports.find((e: { id: string }) => e.id === x.id);
    expect(pending).toMatchObject({ canDecide: true, reason });
    expect((await sa.post(`${S}/exports/${x.id}/approve`, { note: 'Counsel confirmed' }).expect(200)).body.state).toBe('approved');
    await sa.post(`${S}/exports/${x.id}/reject`).expect(409);
    await drain(h);
    const ready = (await ta.get(`${S}/messaging`).expect(200)).body.exports.find((e: { id: string }) => e.id === x.id);
    expect(ready).toMatchObject({ state: 'ready', messages: 2, file: expect.stringMatching(/\.csv$/) });
    // only the requester downloads it; formula-looking cells are defused
    await sa.get(`${S}/exports/${x.id}/download`).expect(404);
    const csv = await ta.get(`${S}/exports/${x.id}/download`).expect(200);
    expect(csv.headers['content-type']).toMatch(/^text\/csv/);
    expect(csv.text).toContain('The vendor invoice is attached');
    expect(csv.text).toContain(`"'=SUM(A1) checked, thanks"`);
    const exported = JSON.parse((await audits(h, 'messaging.conversation.exported').first()).detail);
    expect(exported).toMatchObject({ reason, requestedBy: 'ta', approvedBy: 'sa', messages: 2 });
    expect(await audits(h, 'messaging.export.downloaded').first()).toBeTruthy();
    // the members are not told
    expect(JSON.stringify((await alice.get('/api/me/notifications').expect(200)).body)).not.toMatch(/export/i);
    // withdraw and reject
    const y = (await ta.post(`${S}/exports`, { conversationId: conv.id, reason, approverId: sa.user.id }).expect(201)).body;
    await sa.post(`${S}/exports/${y.id}/withdraw`).expect(403);
    expect((await ta.post(`${S}/exports/${y.id}/withdraw`).expect(200)).body.state).toBe('withdrawn');
    const z = (await ta.post(`${S}/exports`, { conversationId: conv.id, reason, approverId: sa.user.id }).expect(201)).body;
    expect((await sa.post(`${S}/exports/${z.id}/reject`, { note: 'No case number' }).expect(200)).body.state).toBe('rejected');
    await alice.get(`${S}/messaging`).expect(403);
  });
});

describe('realtime (Sprint 35d, B-4206)', () => {
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
  }, 60_000);
  afterEach(async () => {
    for (const x of sockets.splice(0)) x.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await h.close();
  });

  it('counts rooms and sockets by kind on this instance, and closes a user’s sockets everywhere', async () => {
    const ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Design', 'internal')).id;
    const sa = await personIn(h, 'sa', [ws], ['system-admin'], 'restricted');
    const ta = await personIn(h, 'ta', [ws], ['tenant-admin'], 'confidential');
    const bob = await personIn(h, 'bob', [ws]);
    const sock = ioClient(url, { path: '/socket.io', transports: ['websocket'], reconnection: false, extraHeaders: { cookie: bob.cookie } });
    sockets.push(sock);
    await new Promise((r) => sock.on('ready', r));
    expect(await new Promise<{ ok: boolean }>((r) => sock.emit('room.join', { kind: 'feed', id: ws }, r))).toMatchObject({ ok: true });
    const bad = ioClient(url, { path: '/socket.io', transports: ['websocket'], reconnection: false, extraHeaders: { cookie: 'exai_sid=nope' } });
    sockets.push(bad);
    await new Promise((r) => bad.on('connect_error', r));

    await ta.get(`${S}/realtime`).expect(403);
    const rt = (await sa.get(`${S}/realtime`).expect(200)).body;
    expect(rt.kinds.find((k: { kind: string }) => k.kind === 'feed')).toMatchObject({ rooms: 1, sockets: 1 });
    expect(rt).toMatchObject({ sockets: 1, authFailuresLastHour: 1, signalsPerMinuteLimit: 60, redis: false });
    expect((await sa.get(`${S}/people?q=bo`).expect(200)).body.map((u: { username: string }) => u.username)).toEqual(['bob']);

    const published: unknown[] = [];
    h.s.bus.on(TOPICS.roomsClose, (e) => void published.push(e));
    const closed = new Promise((r) => sock.on('disconnect', r));
    await sa.post(`${S}/realtime/close`, { userId: bob.user.id }).expect(200);
    await closed;
    expect(published).toEqual([{ tenantId: h.tenantId, userId: bob.user.id }]);
    expect(await h.s.db('audit_events').where({ action: 'realtime.rooms.closed' }).first()).toBeTruthy();
    // the session stays: the console reconnects
    await bob.get('/api/me').expect(200);
  });
});
