/*
 * Sprint 27 (B-1908): AT-Protocol firehose ingest. A local Jetstream and relay double (never the live network) feeds
 * subscriptions made through the API; posts that pass the collection and author allow-lists and the sample go through
 * the moderation check (B-1901), raise flags and become signed labels from the tenant's labeler (B-1610). The test the
 * item is done by: a restart resumes from the stored cursor. Also: one instance at a time through the lease,
 * backpressure that pauses the socket, reconnection with backoff from the cursor, subscribeRepos frames with records
 * in CAR blocks, the service URL checks, permissions and audit.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cborEncode } from '../src/atproto/cbor.js';
import { collectionAllowed, parseJetstream, parseRepoFrame, recordText, sampled } from '../src/atproto/firehose-frames.js';
import { readCarBlocks } from '../src/atproto/pds/car.js';
import { FirehoseService, streamUrl, type FirehoseOptions } from '../src/atproto/firehose.js';
import { Cid } from '../src/atproto/encoding.js';
import { startSigner } from '../src/signer/server.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';
import { FakePlcDirectory } from './sprint25b-fakes.js';
import { car, FakeFirehose, jetCommit, repoCommit, repoFrame } from './sprint27-firehose-fakes.js';
import { FakeRepo } from './sprint31b-fakes.js';

const POST = 'app.bsky.feed.post';
const ALICE = 'did:plc:aliceaaaaaaaaaaaaaaaaaaa';
const BOB = 'did:plc:bobbbbbbbbbbbbbbbbbbbbbb';
const CAROL = 'did:plc:carolccccccccccccccccccc';
const uri = (did: string, rkey: string, collection = POST) => `at://${did}/${collection}/${rkey}`;

const wrap = (c: Client) => ({
  get: (p: string) => c.agent.get(p),
  post: (p: string, b: object = {}) => c.agent.post(p).set('x-csrf-token', c.csrf).send(b),
  patch: (p: string, b: object = {}) => c.agent.patch(p).set('x-csrf-token', c.csrf).send(b),
  del: (p: string) => c.agent.delete(p).set('x-csrf-token', c.csrf)
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T> | T, what: string, ms = 15_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

describe('B-1908: firehose frames', () => {
  it('reads Jetstream messages, subscribeRepos frames and CAR blocks; filters and samples deterministically', () => {
    const m = parseJetstream(JSON.stringify(jetCommit(1_700_000_000_000_000, ALICE, POST, '3kabc', { text: 'hi', createdAt: '2026-10-04T00:00:00Z' })));
    expect(m).toMatchObject({ message: { cursor: 1_700_000_000_000_000, time: 1_700_000_000_000, ops: [{ did: ALICE, collection: POST, rkey: '3kabc', action: 'create', record: { text: 'hi' } }] } });
    expect(parseJetstream(JSON.stringify({ did: ALICE, time_us: 5, kind: 'identity', identity: {} }))).toEqual({ message: { cursor: 5, time: 0, ops: [] } });
    expect(parseJetstream('nope')).toHaveProperty('error');
    expect(parseJetstream(JSON.stringify({ kind: 'commit' }))).toHaveProperty('error');

    const block = cborEncode({ $type: POST, text: 'from a relay' });
    const blocks = readCarBlocks(car([block]));
    expect(blocks.get(Cid.ofCbor(block).toString())).toEqual(block);
    const f = parseRepoFrame(repoCommit(42, BOB, [{ collection: POST, rkey: 'r1', record: { text: 'from a relay' } }, { collection: POST, rkey: 'r0', record: null, action: 'delete' }]));
    expect(f).toMatchObject({ message: { cursor: 42, ops: [{ did: BOB, collection: POST, rkey: 'r1', action: 'create', record: { text: 'from a relay' } }, { rkey: 'r0', action: 'delete', record: null }] } });
    expect(parseRepoFrame(repoFrame({ op: 1, t: '#identity' }, { seq: 43, did: BOB }))).toEqual({ message: { cursor: 43, time: null, ops: [] } });
    expect(parseRepoFrame(repoFrame({ op: 1, t: '#info' }, { name: 'OutdatedCursor' }))).toHaveProperty('skip');
    expect(parseRepoFrame(repoFrame({ op: -1 }, { error: 'FutureCursor', message: 'too far' }))).toEqual({ error: 'FutureCursor: too far', fatal: true });
    expect(parseRepoFrame(Buffer.from([0xff]))).toHaveProperty('error');

    expect(collectionAllowed(POST, ['app.bsky.feed.post'])).toBe(true);
    expect(collectionAllowed('app.bsky.graph.list', ['app.bsky.graph.*'])).toBe(true);
    expect(collectionAllowed('app.bsky.feed.like', ['app.bsky.feed.post', 'app.bsky.graph.*'])).toBe(false);
    const uris = Array.from({ length: 2000 }, (_, i) => uri(ALICE, `k${i}`));
    const half = uris.filter((u) => sampled(u, 500_000)).length;
    expect(half).toBeGreaterThan(850);
    expect(half).toBeLessThan(1150);
    expect(uris.filter((u) => sampled(u, 500_000))).toEqual(uris.filter((u) => sampled(u, 500_000))); // the same every time
    expect(recordText({ text: 'a post', embed: { $type: 'app.bsky.embed.images', images: [{ alt: 'a cat' }] } })).toBe('a post\na cat');
    expect(recordText({ displayName: 'Name', description: 'About me' })).toBe('Name\nAbout me');
    expect(recordText({ subject: { uri: 'at://x' } })).toBe('');

    const j = streamUrl({ protocol: 'jetstream', endpoint: 'https://jet.example.test', collections: [POST, 'app.bsky.graph.*'], dids: [ALICE] }, 17);
    expect(j.toString()).toBe(`wss://jet.example.test/subscribe?wantedCollections=${POST}&wantedCollections=app.bsky.graph.*&wantedDids=${encodeURIComponent(ALICE)}&cursor=17`);
    expect(streamUrl({ protocol: 'subscribe-repos', endpoint: 'ws://relay.example.test/', collections: [POST], dids: null }, null).toString()).toBe('ws://relay.example.test/xrpc/com.atproto.sync.subscribeRepos');
  });
});

describe('B-1908: firehose ingest through the moderation check into the labeler', () => {
  let h: Harness;
  let jet: FakeFirehose;
  // Since Sprint 31 (B-3604) relay commits are verified against the repo's DID key: the repos sign theirs.
  let plc: FakePlcDirectory;
  let bobRepo: FakeRepo;
  let aliceRepo: FakeRepo;
  let signerDir: string;
  let signer: Awaited<ReturnType<typeof startSigner>>;
  let admin: ReturnType<typeof wrap>;
  let ws: string;
  const managers: FirehoseService[] = [];
  const opts = (o: Partial<FirehoseOptions> = {}): FirehoseOptions => ({ ...h.s.firehose.o, ...o });
  const manager = (o: Partial<FirehoseOptions> = {}) => {
    const m = new FirehoseService(() => h.s, opts(o));
    managers.push(m);
    return m;
  };
  const row = async (id: string) => (await h.s.firehose.get(h.tenantId, id))!;
  const checks = async (u: string) => Number(((await h.s.db('moderation_objects').where({ tenant_id: h.tenantId, object_type: 'atproto-post' }).select('object_id', 'checks')) as { object_id: string; checks: number }[]).find((r) => r.object_id === u)?.checks ?? 0);

  beforeAll(async () => {
    signerDir = mkdtempSync(path.join(tmpdir(), 'exf-'));
    const socketPath = path.join(signerDir, 'run', 'signer.sock');
    const token = randomBytes(24).toString('base64url') + 'x'.repeat(8);
    signer = await startSigner({ socketPath, key: randomBytes(32).toString('base64'), token });
    jet = new FakeFirehose();
    await jet.start();
    plc = new FakePlcDirectory();
    await plc.start();
    bobRepo = new FakeRepo(BOB).publish(plc);
    aliceRepo = new FakeRepo(ALICE).publish(plc);
    h = await harness({ DATA_KEY: '', SIGNER_SOCKET: socketPath, SIGNER_TOKEN: token, ATPROTO_PUBLIC_URL: 'https://fh.example.test', ATPROTO_PLC_URL: plc.url, MODERATION_SWEEP_SECONDS: '0', FIREHOSE_TICK_MS: '200', FIREHOSE_CHECKPOINT_MS: '100', FIREHOSE_BACKOFF_MAX_MS: '200', FIREHOSE_IDLE_MS: '20000' });
    ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Bluesky watch', 'confidential', { visibility: 'members' })).id;
    await localUser(h, 'fhadmin', ['tenant-admin', 'guardrail-admin'], 'confidential');
    await localUser(h, 'fhmember', ['member'], 'internal');
    const c = await loginAdmin(h, 'fhadmin');
    admin = wrap(c);
    const set = (await admin.post('/api/admin/guardrails/sets', { name: 'Firehose rules', scope: 'tenant' }).expect(201)).body as { id: string };
    await c.agent
      .put(`/api/admin/guardrails/sets/${set.id}/draft`)
      .set('x-csrf-token', c.csrf)
      .send({
        rules: [
          { id: 'forbidden', name: 'Forbidden word', checkpoint: 'user-input', type: 'pattern', mechanism: { kind: 'pattern', pattern: 'FORBIDDENWORD' }, action: 'block', stage: 'enforce', severity: 'high' },
          { id: 'spam-link', name: 'Spam links', checkpoint: 'user-input', type: 'pattern', mechanism: { kind: 'pattern', pattern: 'SPAMLINK' }, action: 'flag', stage: 'enforce', severity: 'medium' }
        ]
      })
      .expect(200);
    await admin.post(`/api/admin/guardrails/sets/${set.id}/draft/publish`).expect(200);
    // The tenant's labeler, so verdicts become signed labels.
    await admin.post('/api/atproto/identity', { method: 'web' }).expect(201);
  }, 120_000);

  afterAll(async () => {
    for (const m of managers) await m.close();
    await h?.close();
    await jet?.stop();
    await plc?.stop();
    await signer?.close();
    rmSync(signerDir, { recursive: true, force: true });
  });

  it('needs firehose:manage, checks the endpoint as a service URL, validates filters and audits every change', async () => {
    const member = await login(h, 'fhmember');
    expect((await member.agent.get('/api/atproto/firehose')).status).toBe(403);
    expect((await member.agent.post('/api/atproto/firehose').set('x-csrf-token', member.csrf).send({ name: 'x', protocol: 'jetstream', endpoint: jet.url })).status).toBe(403);

    const meta = await admin.post('/api/atproto/firehose', { name: 'Metadata', protocol: 'jetstream', endpoint: 'ws://169.254.169.254/subscribe' });
    expect(meta.status).toBe(400);
    expect(meta.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(meta.body).toMatchObject({ step: 'endpoint' });
    expect((await admin.post('/api/atproto/firehose', { name: 'Bad', protocol: 'jetstream', endpoint: 'ftp://example.test/' })).status).toBe(400);
    expect((await admin.post('/api/atproto/firehose', { name: 'Bad', protocol: 'jetstream', endpoint: jet.url, collections: ['not a nsid'] })).status).toBe(400);
    expect((await admin.post('/api/atproto/firehose', { name: 'Bad', protocol: 'jetstream', endpoint: jet.url, dids: ['did:example:x'] })).status).toBe(400);
    expect((await admin.post('/api/atproto/firehose', { name: 'Bad', protocol: 'jetstream', endpoint: jet.url, label: 'restricted' })).status).toBe(403);
    expect((await admin.post('/api/atproto/firehose', { name: 'Bad', protocol: 'jetstream', endpoint: jet.url, tenantId: 'x' })).status).toBe(400);

    const made = await admin.post('/api/atproto/firehose', { name: 'Scratch', protocol: 'jetstream', endpoint: jet.url, sampleRate: 0.5 }).expect(201);
    expect(made.body).toMatchObject({ name: 'Scratch', state: 'stopped', status: 'idle', held: false, collections: [POST], dids: null, sampleRate: 0.5, label: 'public', cursor: null });
    expect((await admin.post('/api/atproto/firehose', { name: 'Scratch', protocol: 'jetstream', endpoint: jet.url })).status).toBe(409);
    const changed = await admin.patch(`/api/atproto/firehose/${made.body.id}`, { sampleRate: 0.25, collections: ['app.bsky.graph.*'] }).expect(200);
    expect(changed.body).toMatchObject({ sampleRate: 0.25, collections: ['app.bsky.graph.*'], rev: 2 });
    expect((await admin.get('/api/atproto/firehose').expect(200)).body.subscriptions.map((x: { name: string }) => x.name)).toContain('Scratch');
    await admin.del(`/api/atproto/firehose/${made.body.id}`).expect(204);
    expect((await admin.get(`/api/atproto/firehose/${made.body.id}`)).status).toBe(404);
    const audit = ((await h.s.db('audit_events').where('action', 'like', 'atproto.firehose.%').orderBy('seq').select('action')) as { action: string }[]).map((x) => x.action);
    expect(audit).toEqual(['atproto.firehose.created', 'atproto.firehose.updated', 'atproto.firehose.deleted']);
  });

  let sub: string;

  it('ingests Jetstream posts through the allow-lists into flags and signed labels', async () => {
    const r = await admin.post('/api/atproto/firehose', { name: 'Jetstream', protocol: 'jetstream', endpoint: jet.url, dids: [ALICE, BOB], workspaceId: ws }).expect(201);
    sub = r.body.id as string;
    await admin.post(`/api/atproto/firehose/${sub}/start`).expect(200);
    h.s.firehose.start();
    const conn = await until(() => jet.latest, 'a Jetstream connection');
    expect(conn.url.pathname).toBe('/subscribe');
    expect(conn.url.searchParams.getAll('wantedCollections')).toEqual([POST]);
    expect(conn.url.searchParams.getAll('wantedDids')).toEqual([ALICE, BOB]);
    expect(conn.url.searchParams.has('cursor')).toBe(false);
    // A second manager (another instance) does not connect while the first holds the lease.
    const other = manager();
    await other.tick();
    expect(other.local(sub)).toBeNull();

    jet.send(jetCommit(1000, ALICE, POST, 'a1', { text: 'hello world' }));
    jet.send(jetCommit(2000, ALICE, POST, 'a2', { text: 'buy at SPAMLINK now' }));
    jet.send(jetCommit(3000, CAROL, POST, 'c1', { text: 'SPAMLINK from someone not on the list' }));
    jet.send(jetCommit(4000, ALICE, 'app.bsky.feed.like', 'l1', { subject: { uri: uri(BOB, 'b0') } }));
    jet.send(jetCommit(5000, BOB, POST, 'b1', { text: 'the FORBIDDENWORD' }));
    jet.send({ did: BOB, time_us: 6000, kind: 'identity', identity: { did: BOB, handle: 'bob.test' } });
    jet.send(jetCommit(7000, ALICE, POST, 'a1', null, 'delete'));
    await until(async () => (await row(sub)).cursor === 7000, 'the cursor to be stored at 7000');
    expect(jet.connections).toHaveLength(1);

    expect(await checks(uri(ALICE, 'a1'))).toBe(1);
    expect(await checks(uri(ALICE, 'a2'))).toBe(1);
    expect(await checks(uri(BOB, 'b1'))).toBe(1);
    expect(await checks(uri(CAROL, 'c1'))).toBe(0);
    const flags = (await h.s.db('guard_flags').where({ tenant_id: h.tenantId, source_kind: 'atproto-post' }).select('source_id', 'workspace_id', 'action')) as { source_id: string; workspace_id: string; action: string }[];
    expect(flags.map((f) => [f.source_id, f.action, f.workspace_id]).sort()).toEqual([
      [uri(ALICE, 'a2'), 'flag', ws],
      [uri(BOB, 'b1'), 'block', ws]
    ]);
    const labels = (await h.s.db('atproto_labels').where({ tenant_id: h.tenantId }).whereIn('uri', [uri(ALICE, 'a2'), uri(BOB, 'b1')]).select('uri', 'val')) as { uri: string; val: string }[];
    // The system label from the action, and a category from the rule's name.
    expect(labels.map((l) => `${l.uri} ${l.val}`).sort()).toEqual([`${uri(ALICE, 'a2')} !warn`, `${uri(ALICE, 'a2')} spam`, `${uri(BOB, 'b1')} !hide`]);

    const status = await until(async () => {
      const b = (await admin.get(`/api/atproto/firehose/${sub}`).expect(200)).body;
      return b.counts.checked === 3 ? b : null;
    }, 'the counts to be stored');
    expect(status).toMatchObject({ state: 'running', status: 'streaming', held: true, cursor: 7000, counts: { received: 7, checked: 3, flagged: 2, labelled: 2, failed: 0 }, live: { connected: true, paused: false, queue: 0 } });
    const metrics = await h.s.metrics.registry.metrics();
    expect(metrics).toMatch(/exprsn_firehose_events_total\{result="checked"\} 3/);
    expect(metrics).toMatch(new RegExp(`exprsn_firehose_connected\\{subscription="${sub}"\\} 1`));
  });

  it('resumes from the stored cursor after a restart, without checking anything twice', async () => {
    // Shutdown: the consumer stores its cursor and gives the lease back.
    await h.s.firehose.close();
    const stored = await row(sub);
    expect(stored).toMatchObject({ cursor: 7000, holder: null, state: 'running' });
    await until(() => jet.latest?.closed, 'the old connection to close');

    // The restarted instance (a new manager) connects with the stored cursor.
    const restarted = manager();
    restarted.start();
    const conn = await until(() => (jet.connections.length === 2 ? jet.latest : null), 'the restarted connection');
    expect(conn.url.searchParams.get('cursor')).toBe('7000');
    // Jetstream replays from the cursor's time inclusive: what was handled is skipped, what is new is checked.
    jet.send(jetCommit(5000, BOB, POST, 'b1', { text: 'the FORBIDDENWORD' }));
    jet.send(jetCommit(7000, ALICE, POST, 'a1', null, 'delete'));
    jet.send(jetCommit(8000, ALICE, POST, 'a3', { text: 'SPAMLINK again, new post' }));
    await until(async () => (await row(sub)).cursor === 8000, 'the cursor to move to 8000');
    expect(await checks(uri(BOB, 'b1'))).toBe(1);
    expect(await checks(uri(ALICE, 'a3'))).toBe(1);
    const after = await row(sub);
    expect(after.holder).toBe(restarted.instance);
    expect(after.checked).toBe(4);

    // A stop is acted on by the holder: it stores the cursor, disconnects and gives the lease back.
    await admin.post(`/api/atproto/firehose/${sub}/stop`).expect(200);
    await until(async () => (await row(sub)).holder === null && jet.latest?.closed, 'the consumer to stop');
    const stopped = (await admin.get(`/api/atproto/firehose/${sub}`).expect(200)).body;
    expect(stopped).toMatchObject({ state: 'stopped', status: 'idle', held: false, cursor: 8000, live: null });
    // Now the cursor may be reset (and not while running).
    await admin.post(`/api/atproto/firehose/${sub}/start`).expect(200);
    expect((await admin.patch(`/api/atproto/firehose/${sub}`, { cursor: null })).status).toBe(409);
    await admin.post(`/api/atproto/firehose/${sub}/stop`).expect(200);
    await until(async () => (await row(sub)).holder === null, 'the consumer to stop again');
    expect((await admin.patch(`/api/atproto/firehose/${sub}`, { cursor: null }).expect(200)).body.cursor).toBeNull();
    const audit = ((await h.s.db('audit_events').where('action', 'like', 'atproto.firehose.%').orderBy('seq').select('action')) as { action: string }[]).map((x) => x.action);
    expect(audit.filter((a) => a === 'atproto.firehose.started')).toHaveLength(2);
    expect(audit.filter((a) => a === 'atproto.firehose.stopped')).toHaveLength(2);
    await restarted.close();
  });

  it('pauses the socket when the queue is full, keeps order, and reconnects from the cursor with backoff', async () => {
    const r = await admin.post('/api/atproto/firehose', { name: 'Slow', protocol: 'jetstream', endpoint: jet.url, start: true }).expect(201);
    const id = r.body.id as string;
    const seen: string[] = [];
    const check = h.s.moderation.check.bind(h.s.moderation);
    h.s.moderation.check = async (ctx, input) => {
      seen.push(input.id);
      await sleep(25);
      return check(ctx, input);
    };
    try {
      const slow = manager({ queueMax: 2 });
      const before = jet.connections.length;
      slow.start();
      await until(() => jet.connections.length > before, 'the slow consumer to connect');
      for (let i = 1; i <= 12; i++) jet.send(jetCommit(10_000 + i, CAROL, POST, `s${i}`, { text: `post number ${i}` }));
      await until(() => (slow.local(id)?.pauses ?? 0) > 0, 'the socket to pause');
      await until(() => slow.local(id)?.cursor === 10_012, 'every queued post to be handled');
      expect(seen.filter((u) => u.includes('/s'))).toEqual(Array.from({ length: 12 }, (_, i) => uri(CAROL, `s${i + 1}`)));
      expect(slow.local(id)).toMatchObject({ paused: false, queue: 0 });

      // The relay drops the consumer: it reconnects with its cursor, after a backoff, and counts it.
      const conns = jet.connections.length;
      jet.drop();
      const again = await until(() => (jet.connections.length > conns ? jet.latest : null), 'the reconnection');
      expect(again.url.searchParams.get('cursor')).toBe('10012');
      await until(async () => (await row(id)).reconnects >= 1, 'the reconnection to be counted');
      await admin.post(`/api/atproto/firehose/${id}/stop`).expect(200);
      await until(async () => (await row(id)).holder === null, 'the slow consumer to stop');
      await slow.close();
    } finally {
      h.s.moderation.check = check;
    }
  });

  it('reads subscribeRepos frames with records in CAR blocks, samples, and backs off after an error frame', async () => {
    const r = await admin.post('/api/atproto/firehose', { name: 'Relay', protocol: 'subscribe-repos', endpoint: `${jet.url}/`, collections: [POST, 'app.bsky.actor.profile'], start: true }).expect(201);
    const id = r.body.id as string;
    const m = manager();
    const before = jet.connections.length;
    m.start();
    const conn = await until(() => (jet.connections.length > before ? jet.latest : null), 'the relay connection');
    expect(conn.url.pathname).toBe('/xrpc/com.atproto.sync.subscribeRepos');
    expect(conn.url.search).toBe('');
    jet.send(repoFrame({ op: 1, t: '#info' }, { name: 'OutdatedCursor' }));
    jet.send(bobRepo.commit(1, [
      { collection: POST, rkey: 'r1', record: { text: 'relay SPAMLINK post', createdAt: '2026-10-04T00:00:00Z' } },
      { collection: 'app.bsky.feed.like', rkey: 'r2', record: { subject: { uri: uri(ALICE, 'a1') } } },
      { collection: 'app.bsky.actor.profile', rkey: 'self', record: { displayName: 'Bob', description: 'clean profile' } }
    ]));
    jet.send(repoFrame({ op: 1, t: '#identity' }, { seq: 2, did: BOB, time: new Date().toISOString() }));
    await until(() => m.local(id)?.cursor === 2, 'the relay cursor to reach 2');
    expect(await checks(uri(BOB, 'r1'))).toBe(1);
    expect(await checks(uri(BOB, 'self', 'app.bsky.actor.profile'))).toBe(1);
    expect(await checks(uri(BOB, 'r2', 'app.bsky.feed.like'))).toBe(0);
    expect(await h.s.db('guard_flags').where({ tenant_id: h.tenantId, source_kind: 'atproto-post', source_id: uri(BOB, 'r1') }).first()).toBeTruthy();

    // An error frame ends the stream: the error is shown and the consumer reconnects from its cursor.
    const conns = jet.connections.length;
    jet.send(repoFrame({ op: -1 }, { error: 'ConsumerTooSlow', message: 'catch up' }));
    const again = await until(() => (jet.connections.length > conns ? jet.latest : null), 'the reconnection after the error');
    expect(again.url.searchParams.get('cursor')).toBe('2');
    await m.checkpointAll();
    expect((await row(id)).last_error).toMatch(/ConsumerTooSlow: catch up/);

    // A sample that takes (almost) nothing: posts are skipped, the cursor still moves.
    await admin.patch(`/api/atproto/firehose/${id}`, { sampleRate: 0.000001 }).expect(200);
    await m.tick();
    const resampled = await until(() => (jet.connections.length > conns + 1 ? jet.latest : null), 'the restart with the new sample');
    expect(resampled.url.searchParams.get('cursor')).toBe('2');
    jet.send(aliceRepo.commit(3, [{ collection: POST, rkey: 'z1', record: { text: 'SPAMLINK not sampled' } }]));
    await until(() => m.local(id)?.cursor === 3, 'the relay cursor to reach 3');
    expect(await checks(uri(ALICE, 'z1'))).toBe(0);
  });
});
