import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actorFrom } from '../src/audit/chain.js';
import { textWithFacets } from '../src/feed/crosspost.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { startSigner } from '../src/signer/server.js';
import { harness, localUser, login, loginAdmin, type Harness } from './helpers.js';
import { FakePlcDirectory } from './sprint25b-fakes.js';

/*
 * Sprint 43 (1.7.0), B-114: cross-posting public feed posts to the author's repo on this server's PDS. The "done
 * when" of each item is a test below:
 *   B-11402 a public post appears in the author's repo, deleting it deletes the record, and a workspace post is never
 *           written;
 *   B-11403 a post taken down in Moderation disappears from the author's repo (and its record is labelled !takedown).
 * B-11401 (the PDS on the public network) is the runbook in docs/deploy.md and the cursor-after-trim fix, tested in
 * sprint31a-pds.test.ts.
 */

const egressZone = () => ({ contents: 'edge', trust: 'private', cidrs: ['10.10.0.0/24'], maxLabel: 'restricted', accepts: [], acceptsNote: null, egress: { mode: 'allow-list', allow: [{ kind: 'cidr', cidr: '0.0.0.0/0', ports: [443] }], note: null }, peers: [], services: [] });
type Api = { get(p: string): request.Test; post(p: string, b?: object): request.Test; put(p: string, b?: object): request.Test; patch(p: string, b?: object): request.Test; del(p: string): request.Test };
const api = (c: { agent: ReturnType<typeof request.agent>; csrf: string }): Api => ({
  get: (p) => c.agent.get(p),
  post: (p, b = {}) => c.agent.post(p).set('x-csrf-token', c.csrf).send(b),
  put: (p, b = {}) => c.agent.put(p).set('x-csrf-token', c.csrf).send(b),
  patch: (p, b = {}) => c.agent.patch(p).set('x-csrf-token', c.csrf).send(b),
  del: (p) => c.agent.delete(p).set('x-csrf-token', c.csrf)
});

describe('text and facets', () => {
  it('ends with the link back, keeps within 300 graphemes, and marks links and hashtags by UTF-8 bytes', () => {
    const { text, facets } = textWithFacets('Ship day! #release notes at https://exprsn.example/notes 🚀', 'https://ai.example/#/messages?post=X');
    expect(text).toBe('Ship day! #release notes at https://exprsn.example/notes 🚀\n\nhttps://ai.example/#/messages?post=X');
    const bytes = Buffer.from(text, 'utf8');
    const slice = (f: Record<string, unknown>) => bytes.subarray((f.index as { byteStart: number }).byteStart, (f.index as { byteEnd: number }).byteEnd).toString('utf8');
    expect(facets.map(slice).sort()).toEqual(['#release', 'https://ai.example/#/messages?post=X', 'https://exprsn.example/notes'].sort());
    const long = textWithFacets('x'.repeat(400), 'https://ai.example/p');
    expect([...new Intl.Segmenter().segment(long.text)].length).toBeLessThanOrEqual(300);
    expect(long.text.endsWith('…\n\nhttps://ai.example/p')).toBe(true);
  });
});

describe('cross-posting to the author\'s PDS repo (Sprint 43, B-114)', () => {
  let dir: string;
  let signer: Awaited<ReturnType<typeof startSigner>>;
  let plc: FakePlcDirectory;
  let h: Harness;
  let sys: Api;
  let alice: Api;
  let aliceId: string;
  let ws: string;

  const drain = async () => {
    for (let i = 0; i < 30; i++) if (!(await h.s.jobs.runDue())) return;
  };
  const crosspost = async (postId: string) => (await h.s.db('feed_crossposts').where({ post_id: postId }).first()) as { state: string; uri: string; rkey: string; reason: string | null } | undefined;
  const inRepo = async (rkey: string) => {
    const a = (await h.s.pds.accountByUser(aliceId))!;
    return h.s.pds.repo.getRecord(a, 'app.bsky.feed.post', rkey);
  };

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'exs-'));
    const socketPath = path.join(dir, 'run', 'signer.sock');
    const token = randomBytes(24).toString('base64url') + 'x'.repeat(8);
    signer = await startSigner({ socketPath, key: randomBytes(32).toString('base64'), token });
    plc = new FakePlcDirectory();
    await plc.start();
    h = await harness({ DATA_KEY: '', SIGNER_SOCKET: socketPath, SIGNER_TOKEN: token, ATPROTO_PLC_URL: plc.url, ZONES_AIR_GAPPED: 'false', PDS_PUBLIC_URL: 'https://pds.example.test', PDS_HANDLE_DOMAIN: 'pds.example.test', ATPROTO_PUBLIC_URL: 'https://labels.example.test' });
    h.s.zones.current = async () => new Map([['edge', { version: 1, spec: egressZone() }]]) as never;
    await localUser(h, 'pdsadmin', ['system-admin'], 'confidential');
    sys = api(await loginAdmin(h, 'pdsadmin'));
    await sys.put(`/api/admin/pds/tenants/${h.tenantId}`, { enabled: true }).expect(200);
    // the tenant's labeler identity, which signs the !takedown label
    await sys.post('/api/atproto/identity', { method: 'web' }).expect(201);
    ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Studio', 'internal')).id;
    aliceId = (await localUser(h, 'alice', ['member'])).id;
    await h.s.tenants.addMember(ws, aliceId);
    alice = api(await login(h, 'alice'));
  }, 60_000);
  afterAll(async () => {
    await h?.close();
    await plc?.stop();
    await signer?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('B-11402: a public post appears in the author\'s repo, an edit updates it, deleting it deletes the record; a workspace post is never written', async () => {
    // without an account on the PDS, cross-posting cannot be turned on
    expect((await alice.get('/api/me/crosspost').expect(200)).body).toMatchObject({ enabled: false, account: null, ready: false });
    await alice.put('/api/me/crosspost', { enabled: true }).expect(409);
    await alice.post('/api/me/pds', { handle: 'alice' }).expect(201);
    // an author who has not opted in: nothing is written
    const before = (await alice.post('/api/feed/posts', { workspaceId: ws, body: 'Not yet', label: 'public', visibility: 'public' }).expect(201)).body;
    await drain();
    expect(await crosspost(before.id)).toMatchObject({ state: 'deleted', reason: 'the author does not cross-post' });

    expect((await alice.put('/api/me/crosspost', { enabled: true }).expect(200)).body).toMatchObject({ enabled: true, ready: true });
    const post = (await alice.post('/api/feed/posts', { workspaceId: ws, body: 'Launch day #studio, notes at https://studio.example/notes', label: 'public', visibility: 'public' }).expect(201)).body;
    await drain();
    const cp = (await crosspost(post.id))!;
    expect(cp).toMatchObject({ state: 'written', reason: null });
    const rec = (await inRepo(cp.rkey))!;
    expect(rec.uri).toBe(cp.uri);
    expect((rec.value as { text: string }).text).toBe(`Launch day #studio, notes at https://studio.example/notes\n\n${h.s.cfg.PUBLIC_URL.replace(/\/+$/, '')}/#/messages?post=${post.id}`);
    expect(((rec.value as { facets: { features: { $type: string }[] }[] }).facets.map((f) => f.features[0]!.$type)).sort()).toEqual(['app.bsky.richtext.facet#link', 'app.bsky.richtext.facet#link', 'app.bsky.richtext.facet#tag']);
    expect((await alice.get(`/api/feed/posts/${post.id}/crosspost`).expect(200)).body).toMatchObject({ state: 'written', uri: cp.uri });

    // an edit updates the record in place
    await alice.patch(`/api/feed/posts/${post.id}`, { body: 'Launch day #studio (edited)' }).expect(200);
    await drain();
    expect(((await inRepo(cp.rkey))!.value as { text: string }).text.startsWith('Launch day #studio (edited)')).toBe(true);
    expect((await crosspost(post.id))!.rkey).toBe(cp.rkey);

    // made workspace-only: the record goes
    await alice.patch(`/api/feed/posts/${post.id}`, { visibility: 'workspace' }).expect(200);
    await drain();
    expect(await inRepo(cp.rkey)).toBeNull();
    expect(await crosspost(post.id)).toMatchObject({ state: 'deleted', reason: 'the post is workspace, not public' });
    await alice.patch(`/api/feed/posts/${post.id}`, { visibility: 'public' }).expect(200);
    await drain();
    const again = (await crosspost(post.id))!;
    expect(again.state).toBe('written');

    // deleting the post deletes the record
    await alice.del(`/api/feed/posts/${post.id}`).expect((r) => expect(r.status).toBeLessThan(300));
    await drain();
    expect(await inRepo(again.rkey)).toBeNull();
    expect((await crosspost(post.id))!.state).toBe('deleted');

    // a workspace post, an unlisted one and a post labelled above public are never written
    const kept = [
      (await alice.post('/api/feed/posts', { workspaceId: ws, body: 'Team only', label: 'public', visibility: 'workspace' }).expect(201)).body,
      (await alice.post('/api/feed/posts', { workspaceId: ws, body: 'Unlisted', label: 'public', visibility: 'unlisted' }).expect(201)).body,
      (await alice.post('/api/feed/posts', { workspaceId: ws, body: 'Internal but public', label: 'internal', visibility: 'public' }).expect(201)).body
    ];
    await drain();
    for (const k of kept) expect((await crosspost(k.id))?.state ?? 'none').not.toBe('written');
    const acct = (await h.s.pds.accountByUser(aliceId))!;
    const listed = await request(h.app).get(`/xrpc/com.atproto.repo.listRecords?repo=${acct.did}&collection=app.bsky.feed.post`).expect(200);
    expect((listed.body.records as { value: { text: string } }[]).map((r) => r.value.text.split('\n')[0])).toEqual([]);
  }, 60_000);

  it('B-11403: a post taken down in Moderation disappears from the author\'s repo, and its record is labelled !takedown; a restore brings it back', async () => {
    const post = (await alice.post('/api/feed/posts', { workspaceId: ws, body: 'Something to take down', label: 'public', visibility: 'public' }).expect(201)).body;
    await drain();
    const cp = (await crosspost(post.id))!;
    expect(cp.state).toBe('written');
    const admin = (await loadPrincipal(h.s, h.tenantId, ((await h.s.users.byUsername(h.tenantId, 'pdsadmin'))!).id, {}))!;
    const ctx = { tenantId: h.tenantId, principal: admin, actor: actorFrom(admin, null), traceId: null };
    const action = await h.s.moderation.takeDown(ctx, 'feed-post', post.id, 'Breaks the rules');
    await drain();
    expect(await inRepo(cp.rkey)).toBeNull();
    expect((await crosspost(post.id))!.state).toBe('deleted');
    const labels = (await h.s.db('atproto_labels').where({ uri: cp.uri })) as { val: string; neg: boolean | number }[];
    expect(labels.map((l) => l.val)).toContain('!takedown');

    // reversed (an upheld appeal): the record is written again and the label negated
    await h.s.moderation.reverse(ctx, (action as { id: string }).id, 'Restored on appeal');
    await drain();
    expect((await crosspost(post.id))!.state).toBe('written');
    const after = (await h.s.db('atproto_labels').where({ uri: cp.uri }).orderBy('id')) as { val: string; neg: boolean | number }[];
    expect(after.some((l) => l.val === '!takedown' && !!l.neg)).toBe(true);
  }, 60_000);
});
