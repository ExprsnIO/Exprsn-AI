import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachRealtime } from '../src/realtime/socket.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';
import { drain } from './retrieval-seed.js';
import { FakeClamd, TINY_PNG } from './sprint26d-fakes.js';

/*
 * Sprint 34c (1.5.0), profiles and presence. The "done when" of each item is a test below:
 *   B-5801 opening an author from a post shows their profile; an avatar that fails the scan is never shown;
 *   B-5802 a member set to busy shows busy to a contact within five seconds and not at all to a blocked user.
 */

type Person = Awaited<ReturnType<typeof personIn>>;

async function personIn(h: Harness, name: string, workspaces: string[], roles: string[] = ['member'], clearance: 'public' | 'internal' | 'confidential' = 'internal') {
  const user = await localUser(h, name, roles, clearance);
  for (const w of workspaces) await h.s.tenants.addMember(w, user.id);
  const c = await login(h, name);
  const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
  return {
    user,
    ...c,
    post: (p: string, b?: object) => send('post', p, b),
    put: (p: string, b?: object) => send('put', p, b),
    patch: (p: string, b?: object) => send('patch', p, b),
    del: (p: string) => send('delete', p),
    get: (p: string) => c.agent.get(p),
    avatar: (data: Buffer, type = 'image/png') => c.agent.put('/api/people/me/avatar').set('x-csrf-token', c.csrf).set('content-type', type).send(data)
  };
}

const sendAs = (c: Client, method: 'post' | 'put', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);
const audits = async (h: Harness, action: string) => (await h.s.db('audit_events').where({ action })) as { detail: string | null; target: string }[];

describe('profiles (B-5801)', () => {
  let h: Harness;
  let clamd: FakeClamd;
  let ws: string;
  let other: string;

  beforeEach(async () => {
    clamd = await new FakeClamd().start();
    h = await harness({ CLAMD_HOST: '127.0.0.1', CLAMD_PORT: String(clamd.port) });
    ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Design', 'confidential')).id;
    other = (await h.s.tenants.createWorkspace(h.tenantId, 'Legal', 'confidential')).id;
  }, 60_000);
  afterEach(async () => {
    await h.close();
    await clamd.stop();
  });

  it('opening an author from a post shows their profile, with an avatar that passed the scan', async () => {
    const alice = await personIn(h, 'alice', [ws]);
    const bob = await personIn(h, 'bob', [ws]);
    const dave = await personIn(h, 'dave', [other]);

    // alice writes her profile and uploads an avatar
    const saved = (await alice.patch('/api/people/me', { pronouns: 'she/her', bio: 'Type designer. Ask me about kerning.' }).expect(200)).body;
    expect(saved).toMatchObject({ pronouns: 'she/her', bio: 'Type designer. Ask me about kerning.', label: 'internal', workspaces: null, avatar: null, presence: { status: 'auto' } });
    const up = (await alice.avatar(TINY_PNG).expect(202)).body;
    expect(up.avatar).toMatchObject({ state: 'quarantined', url: null, version: 1 });
    // before the scan, nobody sees an avatar
    expect((await bob.get(`/api/people/${alice.user.id}`).expect(200)).body.avatar).toBeNull();
    await bob.get(`/api/people/${alice.user.id}/avatar`).expect(404);
    await drain(h);
    expect(clamd.scans.length).toBeGreaterThan(0);
    const mine = (await alice.get('/api/people/me').expect(200)).body;
    expect(mine.avatar).toMatchObject({ state: 'ready', url: `/api/people/${alice.user.id}/avatar?v=1` });
    // the image is in the file store, in her workspace
    const file = (await alice.get(`/api/files/${mine.avatar.fileId}`).expect(200)).body;
    expect(file).toMatchObject({ workspaceId: ws, state: 'ready', type: 'image/png' });

    // alice posts; bob opens the author from the post
    const post = (await alice.post('/api/feed/posts', { workspaceId: ws, body: 'New specimen sheet is up.' }).expect(201)).body;
    const seen = (await bob.get(`/api/feed/posts/${post.id}`).expect(200)).body;
    const prof = (await bob.get(`/api/people/${seen.author.id}`).expect(200)).body;
    expect(prof).toMatchObject({ userId: alice.user.id, username: 'alice', displayName: 'ALICE', self: false, limited: null, pronouns: 'she/her', bio: 'Type designer. Ask me about kerning.', avatar: { url: `/api/people/${alice.user.id}/avatar?v=1` }, presence: { status: 'offline' }, sharedWorkspaces: [{ id: ws, name: 'Design' }] });
    expect(prof.relation).toMatchObject({ following: false, blocking: false, canMessage: true });
    const img = await bob.get(prof.avatar.url).buffer(true).expect(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['content-security-policy']).toBeTruthy();
    expect(Buffer.from(img.body as Buffer).equals(TINY_PNG)).toBe(true);

    // someone sharing no workspace does not know her
    await dave.get(`/api/people/${alice.user.id}`).expect(404);
    await dave.get(`/api/people/${alice.user.id}/avatar`).expect(404);
    expect(await audits(h, 'profile.updated')).toHaveLength(1);
    expect(await audits(h, 'profile.avatar.set')).toHaveLength(1);
    // the audit keeps which fields changed, never the text
    expect(JSON.stringify(await audits(h, 'profile.updated'))).not.toContain('kerning');
  });

  it('an avatar that fails the scan is never shown, nor one that is not an image, nor one in the trash', async () => {
    const alice = await personIn(h, 'alice', [ws]);
    const bob = await personIn(h, 'bob', [ws]);
    // a PNG carrying a signature ClamAV knows
    clamd.signatures = ['EVIL-SIGNATURE'];
    const evil = Buffer.concat([TINY_PNG, Buffer.from('EVIL-SIGNATURE')]);
    await alice.avatar(evil).expect(202);
    await drain(h);
    const mine = (await alice.get('/api/people/me').expect(200)).body;
    expect(mine.avatar).toMatchObject({ state: 'rejected', url: null });
    expect((await bob.get(`/api/people/${alice.user.id}`).expect(200)).body.avatar).toBeNull();
    await bob.get(`/api/people/${alice.user.id}/avatar?v=1`).expect(404);
    await alice.get(`/api/people/${alice.user.id}/avatar`).expect(404);
    expect(await audits(h, 'file.version.rejected')).toHaveLength(1);

    // declared an image but the bytes are not: the type check refuses it
    clamd.signatures = [];
    await alice.avatar(Buffer.from([1, 2, 0, 3, 4])).expect(202);
    await drain(h);
    expect((await alice.get('/api/people/me').expect(200)).body.avatar.state).toBe('rejected');
    // not an image type at all: refused before it is stored
    await alice.avatar(Buffer.from('hello'), 'text/plain').expect(415);
    await alice.avatar(Buffer.alloc(2 * 1024 * 1024 + 1, 1)).expect(413);

    // a good one, then the file is trashed (as a takedown does): no longer shown
    await alice.avatar(TINY_PNG).expect(202);
    await drain(h);
    const ok = (await alice.get('/api/people/me').expect(200)).body.avatar;
    expect(ok.state).toBe('ready');
    await bob.get(ok.url).expect(200);
    await alice.del(`/api/files/${ok.fileId}`).expect(200);
    expect((await alice.get('/api/people/me').expect(200)).body.avatar).toMatchObject({ state: 'gone', url: null });
    await bob.get(ok.url).expect(404);
    // removing the avatar
    expect((await alice.del('/api/people/me/avatar').expect(200)).body.avatar).toBeNull();
    expect(await audits(h, 'profile.avatar.removed')).toHaveLength(1);
  });

  it('visibility by workspace and clearance; a block shows the name only', async () => {
    const alice = await personIn(h, 'alice', [ws, other], ['member'], 'confidential');
    const bob = await personIn(h, 'bob', [ws], ['member'], 'internal');
    const carol = await personIn(h, 'carol', [other], ['member'], 'confidential');
    await alice.patch('/api/people/me', { bio: 'Board pack owner.', label: 'confidential' }).expect(200);
    // bob is cleared to internal: name only
    const limited = (await bob.get(`/api/people/${alice.user.id}`).expect(200)).body;
    expect(limited).toMatchObject({ limited: 'clearance', avatar: null, displayName: 'ALICE' });
    expect(limited).not.toHaveProperty('bio');
    expect((await carol.get(`/api/people/${alice.user.id}`).expect(200)).body).toMatchObject({ limited: null, bio: 'Board pack owner.' });
    // shown only in Design: carol shares Legal only
    await alice.patch('/api/people/me', { label: 'internal', workspaces: [ws] }).expect(200);
    expect((await carol.get(`/api/people/${alice.user.id}`).expect(200)).body).toMatchObject({ limited: 'hidden' });
    expect((await bob.get(`/api/people/${alice.user.id}`).expect(200)).body).toMatchObject({ limited: null, bio: 'Board pack owner.' });
    // a workspace she is not in, and a label above her clearance, are refused
    const elsewhere = (await h.s.tenants.createWorkspace(h.tenantId, 'Elsewhere', 'internal')).id;
    await alice.patch('/api/people/me', { workspaces: [elsewhere] }).expect(422);
    await bob.patch('/api/people/me', { label: 'confidential' }).expect(403);
    // bob blocks alice: each sees the other's name only, and no presence
    await bob.post('/api/social/blocks', { userId: alice.user.id }).expect(201);
    expect((await alice.get(`/api/people/${bob.user.id}`).expect(200)).body).toMatchObject({ limited: 'hidden', presence: null });
    expect((await bob.get(`/api/people/${alice.user.id}`).expect(200)).body).toMatchObject({ limited: 'hidden', presence: null });
    // own profile
    expect((await bob.get(`/api/people/${bob.user.id}`).expect(200)).body).toMatchObject({ self: true, limited: null });
  });

  it('bio and pronouns go through the user-input guardrail', async () => {
    const alice = await personIn(h, 'alice', [ws]);
    const gaUser = await localUser(h, 'ga', ['guardrail-admin'], 'confidential');
    await h.s.tenants.addMember(ws, gaUser.id);
    const ga = await loginAdmin(h, 'ga');
    const set = (await sendAs(ga, 'post', '/api/admin/guardrails/sets', { name: 'Profile rules', scope: 'tenant' }).expect(201)).body;
    await sendAs(ga, 'put', `/api/admin/guardrails/sets/${set.id}/draft`, {
      rules: [
        { id: 'scam', name: 'Scam bait', checkpoint: 'user-input', type: 'pattern', mechanism: { kind: 'pattern', pattern: '(?i)gift cards' }, action: 'block', stage: 'enforce' },
        { id: 'phone', name: 'Phone numbers', checkpoint: 'user-input', type: 'pattern', mechanism: { kind: 'pattern', pattern: '\\d{3}-\\d{4}' }, action: 'redact', stage: 'enforce' }
      ]
    }).expect(200);
    await sendAs(ga, 'post', `/api/admin/guardrails/sets/${set.id}/draft/publish`).expect(200);
    const refused = await alice.patch('/api/people/me', { bio: 'Send me gift cards' }).expect(422);
    expect(refused.body).toMatchObject({ step: 'guardrails', action: 'block', field: 'bio' });
    expect((await alice.get('/api/people/me').expect(200)).body.bio).toBeNull();
    const red = (await alice.patch('/api/people/me', { bio: 'Call 555-1234 after six', pronouns: 'they/them' }).expect(200)).body;
    expect(red.bio).not.toContain('555-1234');
    expect(red.pronouns).toBe('they/them');
    await alice.patch('/api/people/me', { bio: 'x'.repeat(501) }).expect(400);
  });
});

describe('presence (B-5802)', () => {
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

  const until = async (fn: () => boolean | Promise<boolean>, ms = 3000) => {
    const end = Date.now() + ms;
    while (!(await fn())) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  async function connect(m: Person) {
    const sock = ioClient(url, { path: '/socket.io', transports: ['websocket'], reconnection: false, extraHeaders: { cookie: m.cookie } });
    sockets.push(sock);
    await new Promise((r) => sock.on('ready', r));
    const got: { userId: string; status: string; at: number }[] = [];
    sock.on('presence.changed', (d: { userId: string; status: string; at: number }) => void got.push(d));
    const watch = (ids: string[]) => new Promise<{ ok: boolean; statuses?: Record<string, string>; error?: string }>((r) => sock.emit('presence.watch', { userIds: ids }, r));
    return { sock, got, watch };
  }

  it('a member set to busy shows busy to a contact within five seconds and not at all to a blocked user', async () => {
    const ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Design', 'internal')).id;
    const alice = await personIn(h, 'alice', [ws]);
    const bob = await personIn(h, 'bob', [ws]);
    const eve = await personIn(h, 'eve', [ws]);
    const zed = await personIn(h, 'zed', []);
    await eve.post('/api/social/blocks', { userId: alice.user.id }).expect(201);

    const a = await connect(alice);
    await until(async () => (await bob.get(`/api/presence?ids=${alice.user.id}`).expect(200)).body.statuses[alice.user.id] === 'available');
    const b = await connect(bob);
    const e = await connect(eve);
    const z = await connect(zed);
    expect((await b.watch([alice.user.id, eve.user.id])).statuses).toEqual({ [alice.user.id]: 'available', [eve.user.id]: 'available' });
    // eve is in a block with alice: nothing, not even offline
    expect((await e.watch([alice.user.id])).statuses).toEqual({});
    // zed shares no workspace
    expect((await z.watch([alice.user.id])).statuses).toEqual({});
    expect((await eve.get(`/api/presence?ids=${alice.user.id}`).expect(200)).body.statuses).toEqual({});
    expect((await alice.get(`/api/people/${eve.user.id}`).expect(200)).body.presence).toBeNull();

    const t0 = Date.now();
    expect((await alice.put('/api/presence/me', { status: 'busy' }).expect(200)).body).toEqual({ status: 'busy', effective: 'busy' });
    await until(() => b.got.some((x) => x.userId === alice.user.id && x.status === 'busy'), 5000);
    expect(Date.now() - t0).toBeLessThan(5000);
    // alice's own sockets hear it too
    await until(() => a.got.some((x) => x.status === 'busy'));
    await new Promise((r) => setTimeout(r, 200));
    expect(e.got.filter((x) => x.userId === alice.user.id)).toEqual([]);
    expect(z.got.filter((x) => x.userId === alice.user.id)).toEqual([]);
    expect((await bob.get(`/api/people/${alice.user.id}`).expect(200)).body.presence).toEqual({ status: 'busy' });
    expect(await h.s.db('audit_events').where({ action: 'presence.status.updated' })).toHaveLength(1);

    // blocking ends the watch at once: bob blocks alice, then hears nothing more from her
    await bob.post('/api/social/blocks', { userId: alice.user.id }).expect(201);
    await new Promise((r) => setTimeout(r, 100));
    const before = b.got.length;
    await alice.put('/api/presence/me', { status: 'away' }).expect(200);
    await until(() => a.got.some((x) => x.status === 'away'));
    await new Promise((r) => setTimeout(r, 200));
    expect(b.got.length).toBe(before);
  });

  it('auto status follows connections and idle time; appear offline; stale instances are swept', async () => {
    const ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Design', 'internal')).id;
    const alice = await personIn(h, 'alice', [ws]);
    const bob = await personIn(h, 'bob', [ws]);
    const b = await connect(bob);
    // Bob's own sockets also hear his own status; count only Alice's changes.
    const seen = () => b.got.filter((x) => x.userId === alice.user.id);
    expect((await b.watch([alice.user.id])).statuses).toEqual({ [alice.user.id]: 'offline' });
    const a1 = await connect(alice);
    await until(() => seen().some((x) => x.status === 'available'));
    const a2 = await connect(alice);
    // one socket idle is not enough; both idle reads away
    a1.sock.emit('presence.idle', { idle: true });
    await new Promise((r) => setTimeout(r, 150));
    expect(seen().some((x) => x.status === 'away')).toBe(false);
    a2.sock.emit('presence.idle', { idle: true });
    await until(() => seen().some((x) => x.status === 'away'));
    a2.sock.emit('presence.idle', { idle: false });
    await until(() => seen().filter((x) => x.status === 'available').length === 2);
    // appear offline
    await alice.put('/api/presence/me', { status: 'offline' }).expect(200);
    await until(() => seen().some((x) => x.status === 'offline'));
    await alice.put('/api/presence/me', { status: 'auto' }).expect(200);
    await until(() => seen().filter((x) => x.status === 'available').length === 3);
    // closing every socket reads offline
    a1.sock.close();
    a2.sock.close();
    await until(() => seen().filter((x) => x.status === 'offline').length === 2);
    expect((await alice.get('/api/presence/me').expect(200)).body).toEqual({ status: 'auto', effective: 'offline' });

    // an instance that went away: its row expires and the sweep publishes offline
    await h.s.db('presence_connections').insert({ tenant_id: h.tenantId, user_id: alice.user.id, instance_id: 'gone:1', sockets: 1, idle: false, seen_at: Date.now() });
    await h.s.presence.publishIfChanged(h.tenantId, alice.user.id);
    await until(() => seen().filter((x) => x.status === 'available').length === 4);
    await h.s.db('presence_connections').where({ instance_id: 'gone:1' }).update({ seen_at: Date.now() - 120_000 });
    await h.s.presence.heartbeat();
    await until(() => seen().filter((x) => x.status === 'offline').length === 3);
    expect(await h.s.db('presence_connections').where({ instance_id: 'gone:1' })).toHaveLength(0);

    // watching too many, or a malformed id, is refused
    expect((await b.watch(Array.from({ length: 201 }, () => alice.user.id))).ok).toBe(false);
    await bob.get('/api/presence?ids=nope').expect(400);
    await bob.put('/api/presence/me', { status: 'invisible' }).expect(400);
  });
});
