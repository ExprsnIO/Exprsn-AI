/*
 * Sprint 31b (1.5.0): custom feed generators (B-3001 to B-3003), relay commit verification (B-3604) and the RSVP
 * capacity race (B-3603), on SQLite with fakes: a local Jetstream and relay double, repos that sign their commits, a
 * PLC directory serving fake DID documents, an AppView signing service JWTs, and the fake Ollama for ranking.
 *
 * The tests the items are done by:
 *   B-3001  a request with a bad service JWT is refused
 *   B-3002  a post from an author outside the rule never appears in the feed
 *   B-3003  a cursor returns the next page without repeats
 *   B-3604  a commit with a bad signature is dropped and audited; a good one becomes a label as before
 *   B-3603  fifty concurrent RSVPs for one place leave one attendee (here on SQLite; PostgreSQL and MySQL in
 *           test/integration/feeds.test.ts)
 * MST layout and proofs are checked against the AT-Protocol interop vectors in test/fixtures/atproto/.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cborEncode } from '../src/atproto/cbor.js';
import { CommitVerifier, repoKeyFromDocument, type CommitProof } from '../src/atproto/commit.js';
import { blockMatches } from '../src/atproto/pds/car.js';
import { keyHeight, mstLookup } from '../src/atproto/pds/mst.js';
import { verifySignature } from '../src/atproto/crypto.js';
import { Cid } from '../src/atproto/encoding.js';
import { cosine, keywordMatcher } from '../src/atproto/feeds.js';
import { FirehoseService, type FirehoseOptions } from '../src/atproto/firehose.js';
import { parseRepoFrame } from '../src/atproto/firehose-frames.js';
import { ServiceJwtVerifier } from '../src/atproto/service-jwt.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { startSigner } from '../src/signer/server.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';
import { FakePlcDirectory, testKey } from './sprint25b-fakes.js';
import { FakeFirehose, jetCommit } from './sprint27-firehose-fakes.js';
import { buildMst, FakeRepo, FakeServiceIssuer } from './sprint31b-fakes.js';

const FIX = path.join(import.meta.dirname, 'fixtures', 'atproto');
const fixture = <T>(name: string): T => JSON.parse(readFileSync(path.join(FIX, name), 'utf8')) as T;
const POST = 'app.bsky.feed.post';
const ALICE = 'did:plc:aliceaaaaaaaaaaaaaaaaaaa';
const BOB = 'did:plc:bobbbbbbbbbbbbbbbbbbbbbb';
const CAROL = 'did:plc:carolccccccccccccccccccc';
const APPVIEW = 'did:plc:appviewaaaaaaaaaaaaaaaaa';
const GB = 1_000_000_000;
const uri = (did: string, rkey: string, collection = POST) => `at://${did}/${collection}/${rkey}`;

const wrap = (c: Client) => ({
  get: (p: string) => c.agent.get(p),
  post: (p: string, b: object = {}) => c.agent.post(p).set('x-csrf-token', c.csrf).send(b),
  put: (p: string, b: object = {}) => c.agent.put(p).set('x-csrf-token', c.csrf).send(b),
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

/** A resolver over a map with a cache, as DidResolver has: a fresh resolve reads the map again. */
function mapResolver(docs: Map<string, unknown>) {
  const calls = { cached: 0, fresh: 0 };
  const cache = new Map<string, unknown>();
  return {
    calls,
    resolve: async (did: string, fresh = false) => {
      if (fresh) calls.fresh++;
      else calls.cached++;
      if (!fresh && cache.has(did)) return cache.get(did);
      const d = docs.get(did);
      if (!d) throw new Error(`${did} did not resolve (404)`);
      cache.set(did, d);
      return d;
    }
  };
}

describe('B-3604: the MST and commit proofs against the reference vectors', () => {
  it('computes key layers and tree roots exactly as the reference implementation', () => {
    for (const k of fixture<{ key: string; height: number }[]>('key_heights.json')) expect(keyHeight(k.key), k.key).toBe(k.height);
    expect(buildMst([]).root.toString()).toBe('bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm');
    const fixtures = fixture<{ comment: string; leafValue: string; keys: string[]; adds: string[]; dels: string[]; rootBeforeCommit: string; rootAfterCommit: string; blocksInProof: string[] }[]>('commit-proof-fixtures.json');
    expect(fixtures.length).toBeGreaterThanOrEqual(6);
    for (const f of fixtures) {
      const leaf = Cid.parse(f.leafValue);
      const before = buildMst(f.keys.map((k) => [k, leaf]));
      const after = buildMst([...f.keys.filter((k) => !f.dels.includes(k)), ...f.adds].map((k) => [k, leaf]));
      expect(before.root.toString(), f.comment).toBe(f.rootBeforeCommit);
      expect(after.root.toString(), f.comment).toBe(f.rootAfterCommit);
      // Proven from the proof blocks alone: every add is in the new tree with its value, every delete is absent.
      const proof = new Map([...after.nodes].filter(([c]) => f.blocksInProof.includes(c)));
      for (const k of f.adds) expect(mstLookup(proof, after.root, k), `${f.comment}: ${k}`).toEqual({ found: leaf });
      for (const k of f.dels) expect(mstLookup(proof, after.root, k), `${f.comment}: ${k}`).toEqual({ absent: true });
      // And not from fewer: without the root, nothing is proven.
      const noRoot = new Map(proof);
      noRoot.delete(after.root.toString());
      expect(mstLookup(noRoot, after.root, f.adds[0]!)).toEqual({ missing: after.root.toString() });
      // A node whose bytes do not match its CID is refused.
      const forged = new Map(proof);
      forged.set(after.root.toString(), Buffer.concat([proof.get(after.root.toString())!, Buffer.from([0])]));
      expect(() => mstLookup(forged, after.root, f.adds[0]!)).toThrow(/does not match its CID/);
    }
  });

  it('reads #atproto keys in both DID document forms and refuses high-S and DER signatures (interop vectors)', () => {
    const vectors = fixture<{ comment: string; messageBase64: string; algorithm: string; didDocSuite: string; publicKeyDid: string; publicKeyMultibase: string; signatureBase64: string; validSignature: boolean }[]>('signature-fixtures.json');
    expect(vectors).toHaveLength(6);
    for (const v of vectors) {
      const did = 'did:plc:vectorsaaaaaaaaaaaaaaaaa';
      const legacy = repoKeyFromDocument({ id: did, verificationMethod: [{ id: '#atproto', type: v.didDocSuite, controller: did, publicKeyMultibase: v.publicKeyMultibase }] }, did);
      const multikey = repoKeyFromDocument({ id: did, verificationMethod: [{ id: `${did}#atproto`, type: 'Multikey', controller: did, publicKeyMultibase: v.publicKeyDid.slice('did:key:'.length) }] }, did);
      expect(legacy.curve).toBe(v.algorithm === 'ES256K' ? 'secp256k1' : 'p256');
      expect(multikey.curve).toBe(legacy.curve);
      const msg = Buffer.from(v.messageBase64, 'base64');
      const sig = Buffer.from(v.signatureBase64, 'base64');
      expect(verifySignature(legacy.curve, legacy.key, msg, sig), v.comment).toBe(v.validSignature);
      expect(verifySignature(multikey.curve, multikey.key, msg, sig), v.comment).toBe(v.validSignature);
    }
    expect(() => repoKeyFromDocument({ id: 'did:plc:x', verificationMethod: [] }, 'did:plc:y')).toThrow(/does not describe/);
    expect(() => repoKeyFromDocument({ id: 'did:plc:x', verificationMethod: [] }, 'did:plc:x')).toThrow(/no #atproto key/);
  });

  it('verifies a signed commit and refuses a bad signature, a forged record, a missing node, another repo, too big', async () => {
    const repo = new FakeRepo(ALICE);
    const docs = new Map<string, unknown>([[ALICE, repo.document()]]);
    const resolver = mapResolver(docs);
    const v = new CommitVerifier(resolver);
    const proof = (frame: Buffer): CommitProof => (parseRepoFrame(frame) as { message: { proof: CommitProof } }).message.proof;
    const good = proof(repo.commit(1, [{ collection: POST, rkey: 'a1', record: { text: 'hello' } }, { collection: POST, rkey: 'a2', record: { text: 'there' } }]));
    expect(await v.verify(good)).toMatchObject({ ok: true });
    // A later commit: an update and a delete, each proven against the new root.
    const later = proof(repo.commit(2, [{ collection: POST, rkey: 'a1', record: { text: 'hello, edited' } }, { collection: POST, rkey: 'a2', record: null }]));
    expect(later.ops.map((o) => o.action)).toEqual(['update', 'delete']);
    expect(await v.verify(later)).toMatchObject({ ok: true });
    expect(await v.verify(proof(repo.commit(3, [{ collection: POST, rkey: 'a3', record: { text: 'x' } }], 'signature')))).toMatchObject({ ok: false, reason: 'signature' });
    expect(await v.verify(proof(repo.commit(4, [{ collection: POST, rkey: 'a4', record: { text: 'x' } }], 'record')))).toMatchObject({ ok: false, reason: 'proof' });
    expect(await v.verify(proof(repo.commit(5, [{ collection: POST, rkey: 'a5', record: { text: 'x' } }], 'missing-node')))).toMatchObject({ ok: false, reason: 'proof' });
    expect(await v.verify(proof(repo.commit(6, [{ collection: POST, rkey: 'a6', record: { text: 'x' } }], 'repo')))).toMatchObject({ ok: false, reason: 'repo' });
    // An op whose CID is not what the tree signed.
    const swapped = proof(repo.commit(7, [{ collection: POST, rkey: 'a7', record: { text: 'x' } }]));
    swapped.ops[0]!.cid = Cid.ofCbor(cborEncode({ text: 'other' })).toString();
    expect(await v.verify(swapped)).toMatchObject({ ok: false, reason: 'proof' });
    expect(await v.verify({ ...good, tooBig: true })).toMatchObject({ ok: false, reason: 'too-big' });
    expect(await v.verify({ ...good, commit: null })).toMatchObject({ ok: false, reason: 'commit' });
    expect(await v.verify({ ...good, repo: BOB })).toMatchObject({ ok: false, reason: 'repo' });
    expect(blockMatches(good.commit!, good.blocks.get(good.commit!.toString())!)).toBe(true);

    // The repo rotates its key: the cached document fails once, the fresh one verifies. (A new verifier: the one above
    // has just refreshed Alice's document for the bad signature, and refreshes at most once a minute per DID.)
    const v2 = new CommitVerifier(resolver);
    expect(await v2.verify(good)).toMatchObject({ ok: true });
    const rotated = testKey('p256');
    const old = repo.key;
    (repo as { key: typeof rotated }).key = rotated;
    docs.set(ALICE, repo.document(rotated));
    const fresh = resolver.calls.fresh;
    expect(await v2.verify(proof(repo.commit(8, [{ collection: POST, rkey: 'a8', record: { text: 'after rotation' } }])))).toMatchObject({ ok: true });
    expect(resolver.calls.fresh).toBe(fresh + 1);
    (repo as { key: typeof old }).key = old; // signing with the retired key now fails (and refreshes no more than once a minute)
    expect(await v2.verify(proof(repo.commit(9, [{ collection: POST, rkey: 'a9', record: { text: 'old key' } }])))).toMatchObject({ ok: false, reason: 'signature' });
    expect(resolver.calls.fresh).toBe(fresh + 1);
    // A repo whose DID does not resolve.
    const stranger = new FakeRepo(CAROL);
    expect(await v.verify(proof(stranger.commit(1, [{ collection: POST, rkey: 'c1', record: { text: 'x' } }])))).toMatchObject({ ok: false, reason: 'resolve' });
  });
});

describe('B-3001: inter-service JWTs', () => {
  it('accepts a token from the issuer for this service and method, and refuses every bad one', async () => {
    const appview = new FakeServiceIssuer(APPVIEW);
    const p256 = new FakeServiceIssuer('did:plc:pviewaaaaaaaaaaaaaaaaaaa', 'p256');
    const docs = new Map<string, unknown>([
      [APPVIEW, appview.document()],
      [p256.did, p256.document()]
    ]);
    const v = new ServiceJwtVerifier(mapResolver(docs));
    const me = 'did:web:feeds.example.test';
    const o = { audiences: [me, `${me}#bsky_fg`], lxm: 'app.bsky.feed.getFeedSkeleton' };
    expect(await v.verify(appview.jwt(me), o)).toEqual({ iss: APPVIEW });
    expect(await v.verify(appview.jwt(`${me}#bsky_fg`, { iss: `${APPVIEW}#bsky_appview` }), o)).toEqual({ iss: APPVIEW });
    expect(await v.verify(p256.jwt(me), o)).toEqual({ iss: p256.did });
    expect(await v.verify(appview.jwt(me, { lxm: null }), o)).toEqual({ iss: APPVIEW });
    const now = Math.floor(Date.now() / 1000);
    const refused = async (token: string) => v.verify(token, o).then(
      () => 'accepted',
      (e: { error?: string }) => e.error ?? 'error'
    );
    expect(await refused(appview.jwt(me, { key: testKey('secp256k1') }))).toBe('BadJwtSignature');
    expect(await refused(appview.jwt(me, { highS: true }))).toBe('BadJwtSignature');
    expect(await refused(appview.jwt('did:web:someone-else.example'))).toBe('BadJwtAudience');
    expect(await refused(appview.jwt(me, { exp: now - 5 }))).toBe('JwtExpired');
    expect(await refused(appview.jwt(me, { exp: now + 86_400 }))).toBe('BadJwt');
    expect(await refused(appview.jwt(me, { iat: now + 3600 }))).toBe('BadJwt');
    expect(await refused(appview.jwt(me, { lxm: 'com.atproto.repo.createRecord' }))).toBe('BadJwtLexiconMethod');
    expect(await refused(appview.jwt(me, { alg: 'ES256' }))).toBe('BadJwtSignature'); // the key is secp256k1
    expect(await refused(appview.jwt(me, { alg: 'HS256' }))).toBe('BadJwt');
    expect(await refused(appview.jwt(me, { alg: 'none' }))).toBe('BadJwt');
    expect(await refused(appview.jwt(me, { iss: 'did:plc:nobodyaaaaaaaaaaaaaaaaaa' }))).toBe('BadJwtSignature');
    expect(await refused('not.a.jwt')).toBe('BadJwt');
    expect(await refused(appview.jwt(me).split('.').slice(0, 2).join('.') + '.')).toBe('BadJwtSignature');
  });

  it('matches keywords on word boundaries and scores by cosine similarity', () => {
    const m = keywordMatcher(['cats', '#AI', 'new york']);
    expect(m('I like Cats.')).toBe(true);
    expect(m('concatsination')).toBe(false);
    expect(m('all about #ai today')).toBe(true);
    expect(m('New  York')).toBe(false);
    expect(m('new york pizza')).toBe(true);
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
  });
});

describe('Sprint 31b over the API: feeds, commit verification and the generator endpoints', () => {
  let h: Harness;
  let jet: FakeFirehose;
  let plc: FakePlcDirectory;
  let ollama: FakeOllama;
  let signerDir: string;
  let signer: Awaited<ReturnType<typeof startSigner>>;
  let admin: ReturnType<typeof wrap>;
  let ws: string;
  let key: string;
  let did: string;
  const appview = new FakeServiceIssuer(APPVIEW);
  const managers: FirehoseService[] = [];
  const manager = (o: Partial<FirehoseOptions> = {}) => {
    const m = new FirehoseService(() => h.s, { ...h.s.firehose.o, ...o });
    managers.push(m);
    return m;
  };
  const xrpc = (p: string, token?: string) => {
    const r = request(h.app).get(`/atproto/${key}/xrpc/${p}`);
    return token ? r.set('authorization', `Bearer ${token}`) : r;
  };
  const skeleton = (feed: string, q: Record<string, string | number> = {}, token = appview.jwt(did)) => xrpc(`app.bsky.feed.getFeedSkeleton?${new URLSearchParams({ feed, ...Object.fromEntries(Object.entries(q).map(([k, v]) => [k, String(v)])) }).toString()}`, token);
  const sub = { id: 'SUB', tenant_id: '', label: 'public' as const };
  const ingest = (feedSub: { id: string }, author: string, rkey: string, text: string, collection = POST) => h.s.feedGenerators.ingest({ ...sub, ...feedSub, tenant_id: h.tenantId }, { uri: uri(author, rkey, collection), cid: null, text, did: author, collection }, { action: 'allow', labels: [] });

  beforeAll(async () => {
    signerDir = mkdtempSync(path.join(tmpdir(), 'exfg-'));
    const socketPath = path.join(signerDir, 'run', 'signer.sock');
    const token = randomBytes(24).toString('base64url') + 'x'.repeat(8);
    signer = await startSigner({ socketPath, key: randomBytes(32).toString('base64'), token });
    jet = new FakeFirehose();
    await jet.start();
    plc = new FakePlcDirectory();
    await plc.start();
    appview.publish(plc);
    ollama = await new FakeOllama().start();
    h = await harness({ DATA_KEY: '', SIGNER_SOCKET: socketPath, SIGNER_TOKEN: token, ATPROTO_PUBLIC_URL: 'https://feeds.example.test', ATPROTO_PLC_URL: plc.url, MODERATION_SWEEP_SECONDS: '0', FIREHOSE_TICK_MS: '200', FIREHOSE_CHECKPOINT_MS: '100', FIREHOSE_BACKOFF_MAX_MS: '200', FIREHOSE_IDLE_MS: '20000', FIREHOSE_REJECT_AUDITS: '2', FEEDS_MAX_PER_TENANT: '8' });
    ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Bluesky feeds', 'confidential', { visibility: 'members' })).id;
    await localUser(h, 'fgadmin', ['tenant-admin', 'guardrail-admin'], 'confidential');
    await localUser(h, 'fgmember', ['member'], 'internal');
    const c = await loginAdmin(h, 'fgadmin');
    admin = wrap(c);
    const set = (await admin.post('/api/admin/guardrails/sets', { name: 'Feed rules', scope: 'tenant' }).expect(201)).body as { id: string };
    await admin.put(`/api/admin/guardrails/sets/${set.id}/draft`, { rules: [{ id: 'forbidden', name: 'Forbidden word', checkpoint: 'user-input', type: 'pattern', mechanism: { kind: 'pattern', pattern: 'FORBIDDENWORD' }, action: 'block', stage: 'enforce', severity: 'high' }] }).expect(200);
    await admin.post(`/api/admin/guardrails/sets/${set.id}/draft/publish`).expect(200);
    // An embedding model behind a published profile, for ranking.
    const repo = h.s.gateway.repo;
    ollama.addAvailable({ name: 'bge-small', size: GB, capabilities: ['embedding'] });
    const pool = await repo.createPool({ name: 'gpu', accelerator: 'cuda', zone: 'inference', labelCeiling: 'confidential' });
    await repo.createInstance({ poolId: pool.id, name: 'gpu-1', url: ollama.url, deploy: 'docker', settings: { parallel: 4 } });
    const m = await repo.createModel({ name: 'bge-small', source: 'Ollama library', expectedDigest: null, license: { name: 'test' }, label: 'confidential', notes: null, requestedBy: 'x', requestedTenant: h.tenantId });
    await repo.updateModel(m.id, { state: 'approved', import_state: 'pulled', capabilities: ['embedding'], size_bytes: GB });
    await repo.place(m.id, pool.id, 'warm', 'x');
    const t = Date.now();
    await repo.createProfile({ id: 'EMBED00000000000000000000A', tenant_id: h.tenantId, name: 'feed-embed', display_name: 'Feed embeddings', description: null, alias_of: null, model_id: m.id, pool_id: pool.id, num_ctx: null, temperature: null, think_default: 'off', think_ceiling: 'off', system_prompt: null, fallback: null, canary: null, tools: [], label: 'confidential', status: 'published', version: 1, updated_by: null, created_at: t, updated_at: t });
    await h.s.gateway.pollAll();
  }, 120_000);

  afterAll(async () => {
    for (const m of managers) await m.close();
    await h?.close();
    await jet?.stop();
    await plc?.stop();
    await ollama?.stop();
    await signer?.close();
    rmSync(signerDir, { recursive: true, force: true });
  });

  it('feeds need firehose:manage and the tenant identity; they are validated and audited; the DID document advertises the generator', async () => {
    const member = await login(h, 'fgmember');
    expect((await member.agent.get('/api/atproto/feeds')).status).toBe(403);
    // Without the tenant's own identity there is no generator.
    const before = (await admin.get('/api/atproto/feeds').expect(200)).body as { generator: { ready: boolean; did: string | null }; feeds: unknown[] };
    expect(before.generator).toMatchObject({ ready: false, did: null, serviceId: '#bsky_fg', serviceType: 'BskyFeedGenerator' });
    expect((await admin.post('/api/atproto/feeds', { rkey: 'early', displayName: 'Early' })).body).toMatchObject({ status: 409, step: 'identity' });

    const identity = (await admin.post('/api/atproto/identity', { method: 'web' }).expect(201)).body as { did: string; endpoint: string; document: { service: { id: string }[] } };
    did = identity.did;
    key = identity.endpoint.split('/atproto/')[1]!;
    expect(identity.document.service.map((x) => x.id)).toEqual(['#atproto_labeler']);

    const bad = [
      { rkey: 'way-too-long-feed-key', displayName: 'X' },
      { rkey: 'ok', displayName: '' },
      { rkey: 'ok', displayName: 'X', rules: { authors: ['not-a-did'] } },
      { rkey: 'ok', displayName: 'X', rules: { collections: ['nope'] } },
      { rkey: 'ok', displayName: 'X', ranking: { kind: 'embedding', profile: 'feed-embed' } },
      { rkey: 'ok', displayName: 'X', retentionHours: 0 },
      { rkey: 'ok', displayName: 'X', extra: true }
    ];
    for (const b of bad) expect((await admin.post('/api/atproto/feeds', b)).status, JSON.stringify(b)).toBe(400);
    expect((await admin.post('/api/atproto/feeds', { rkey: 'ok', displayName: 'X', ranking: { kind: 'embedding', profile: 'nope', query: 'cats' } })).body).toMatchObject({ status: 400, step: 'ranking' });
    expect((await admin.post('/api/atproto/feeds', { rkey: 'ok', displayName: 'X', ranking: { kind: 'classifier', classifier: 'pii', label: 'nope' } })).body).toMatchObject({ status: 400, step: 'ranking' });
    expect((await admin.post('/api/atproto/feeds', { rkey: 'ok', displayName: 'X', subscriptionId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' })).status).toBe(400);
    expect((await admin.post('/api/atproto/feeds', { rkey: 'ok', displayName: 'X', maxItems: 10_000_000 })).status).toBe(400);

    const made = (await admin.post('/api/atproto/feeds', { rkey: 'friends', displayName: 'Friends', description: 'Posts by friends', rules: { authors: [ALICE, BOB] } }).expect(201)).body as { id: string; uri: string; record: Record<string, unknown>; rules: Record<string, unknown> };
    expect(made.uri).toBe(`at://${did}/app.bsky.feed.generator/friends`);
    expect(made.rules).toEqual({ authors: [ALICE, BOB], collections: [POST], keywords: null, labels: null, excludeLabels: ['!hide'] });
    expect((await admin.post('/api/atproto/feeds', { rkey: 'friends', displayName: 'Again' })).status).toBe(409);
    const list = (await admin.get('/api/atproto/feeds').expect(200)).body as { generator: Record<string, unknown>; feeds: { id: string }[] };
    expect(list.generator).toMatchObject({ ready: true, did, method: 'web', endpoint: identity.endpoint, advertised: true });
    expect(list.feeds.map((f) => f.id)).toEqual([made.id]);
    // The did:web document now names the generator service.
    const doc = (await request(h.app).get(`/atproto/${key}/did.json`).expect(200)).body as { service: { id: string; type: string; serviceEndpoint: string }[] };
    expect(doc.service).toContainEqual({ id: '#bsky_fg', type: 'BskyFeedGenerator', serviceEndpoint: identity.endpoint });

    await admin.patch(`/api/atproto/feeds/${made.id}`, { displayName: 'Close friends', ratePerMinute: 1000 }).expect(200);
    const audits = (await h.s.db('audit_events').where({ tenant_id: h.tenantId }).where('action', 'like', 'atproto.feed.%').orderBy('seq', 'asc').select('action')) as { action: string }[];
    expect(audits.map((a) => a.action)).toEqual(['atproto.feed.created', 'atproto.feed.updated']);
    expect((await admin.get('/api/atproto/feeds/01ARZ3NDEKTSV4RRFFQ69G5FAV')).status).toBe(404);
  });

  it('B-3001: describeFeedGenerator and getFeedSkeleton answer an AppView; a request with a bad service JWT is refused', async () => {
    const d = (await xrpc('app.bsky.feed.describeFeedGenerator').expect(200)).body as { did: string; feeds: { uri: string }[] };
    expect(d).toEqual({ did, feeds: [{ uri: `at://${did}/app.bsky.feed.generator/friends` }] });
    const feed = d.feeds[0]!.uri;
    expect((await skeleton(feed).expect(200)).body).toEqual({ feed: [] });
    // Without a token the feed is served (auth optional) ...
    expect((await xrpc(`app.bsky.feed.getFeedSkeleton?feed=${encodeURIComponent(feed)}`).expect(200)).body).toEqual({ feed: [] });
    // ... but a bad token never is.
    const bad = [appview.jwt(did, { key: testKey() }), appview.jwt('did:web:elsewhere.example'), appview.jwt(did, { exp: Math.floor(Date.now() / 1000) - 10 }), appview.jwt(did, { lxm: 'app.bsky.feed.getTimeline' }), 'garbage', appview.jwt(did, { iss: 'did:plc:unknownaaaaaaaaaaaaaaaaa' })];
    const errors: string[] = [];
    for (const t of bad) {
      const r = await skeleton(feed, {}, t);
      expect(r.status).toBe(401);
      expect(r.headers['www-authenticate']).toBe('Bearer');
      errors.push((r.body as { error: string }).error);
    }
    expect(errors).toEqual(['BadJwtSignature', 'BadJwtAudience', 'JwtExpired', 'BadJwtLexiconMethod', 'BadJwt', 'BadJwtSignature']);
    expect((await xrpc(`app.bsky.feed.getFeedSkeleton?feed=${encodeURIComponent(feed)}`).set('authorization', 'Basic abc')).status).toBe(401);
    // The generator's DID with the service fragment is an accepted audience too.
    await skeleton(feed, {}, appview.jwt(`${did}#bsky_fg`)).expect(200);
    // A feed that requires authentication refuses a request without a token.
    const id = ((await admin.get('/api/atproto/feeds')).body as { feeds: { id: string }[] }).feeds[0]!.id;
    await admin.patch(`/api/atproto/feeds/${id}`, { auth: 'required' }).expect(200);
    expect((await xrpc(`app.bsky.feed.getFeedSkeleton?feed=${encodeURIComponent(feed)}`)).body).toMatchObject({ error: 'AuthenticationRequired' });
    await skeleton(feed).expect(200);
    // Unknown feeds, another generator's URI, bad input.
    expect((await skeleton(`at://${did}/app.bsky.feed.generator/nope`)).body).toMatchObject({ error: 'UnknownFeed' });
    expect((await skeleton('https://example.com')).body).toMatchObject({ error: 'UnknownFeed' });
    expect((await skeleton(feed, { limit: 500 })).body).toMatchObject({ error: 'InvalidRequest' });
    expect((await skeleton(feed, { cursor: 'nope' })).body).toMatchObject({ error: 'BadCursor' });
    expect((await request(h.app).get('/atproto/nobody/xrpc/app.bsky.feed.describeFeedGenerator')).status).toBe(404);
    // The platform's host (the labeling fallback) serves no feeds.
    expect((await request(h.app).get('/xrpc/app.bsky.feed.describeFeedGenerator').set('host', 'feeds.example.test')).status).toBe(404);
  });

  it('B-3002: a post from an author outside the rule never appears in the feed; collections, keywords and labels', async () => {
    const r = await admin.post('/api/atproto/firehose', { name: 'Jet', protocol: 'jetstream', endpoint: jet.url, collections: [POST, 'app.bsky.feed.repost'], workspaceId: ws, start: true }).expect(201);
    const subId = r.body.id as string;
    const friends = ((await admin.get('/api/atproto/feeds')).body as { feeds: { id: string; uri: string }[] }).feeds[0]!;
    const cats = (await admin.post('/api/atproto/feeds', { rkey: 'cats', displayName: 'Cats', subscriptionId: subId, rules: { keywords: ['cat', 'cats', 'kitten'] } }).expect(201)).body as { id: string; uri: string };
    const flagged = (await admin.post('/api/atproto/feeds', { rkey: 'hidden', displayName: 'Hidden', rules: { labels: ['!hide'], excludeLabels: [] } }).expect(201)).body as { id: string; uri: string };
    const m = manager();
    m.start();
    await until(() => jet.latest, 'a Jetstream connection');
    jet.send(jetCommit(1000, ALICE, POST, 'a1', { text: 'my cat is asleep' }));
    jet.send(jetCommit(2000, CAROL, POST, 'c1', { text: 'a cat from a stranger' }));
    jet.send(jetCommit(3000, BOB, POST, 'b1', { text: 'the FORBIDDENWORD about cats' }));
    jet.send(jetCommit(4000, BOB, 'app.bsky.feed.repost', 'r1', { text: 'a repost with cats' }));
    jet.send(jetCommit(5000, ALICE, POST, 'a2', { text: 'concatenation, not a feline' }));
    jet.send(jetCommit(6000, ALICE, POST, 'a3', { text: 'kitten pictures' }));
    await until(async () => (await h.s.firehose.get(h.tenantId, subId))?.cursor === 6000 || m.local(subId)?.cursor === 6000, 'the firehose to reach 6000');
    await until(async () => Number((await h.s.db('atproto_feed_items').where({ feed_id: cats.id }).count({ n: '*' }).first())?.n ?? 0) >= 3, 'the cats feed to fill');
    const page = async (feed: string) => ((await skeleton(feed).expect(200)).body as { feed: { post: string }[] }).feed.map((x) => x.post);
    // Friends: Alice and Bob only (Carol is outside the rule); posts only (no reposts); Bob's blocked post is hidden.
    expect(await page(friends.uri)).toEqual([uri(ALICE, 'a3'), uri(ALICE, 'a2'), uri(ALICE, 'a1')]);
    // Cats: keywords on word boundaries, anyone, from this subscription; the hidden post excluded.
    expect(await page(cats.uri)).toEqual([uri(ALICE, 'a3'), uri(CAROL, 'c1'), uri(ALICE, 'a1')]);
    // A feed of what the tenant's labeler hid.
    expect(await page(flagged.uri)).toEqual([uri(BOB, 'b1')]);

    // A label applied later (an admin hides a post) takes it out of the feeds at once.
    await admin.post('/api/atproto/labels', { uri: uri(ALICE, 'a1'), vals: ['!hide'] }).expect(201);
    expect(await page(friends.uri)).toEqual([uri(ALICE, 'a3'), uri(ALICE, 'a2')]);
    await admin.post('/api/atproto/labels/negate', { uri: uri(ALICE, 'a1'), val: '!hide' }).expect(201);
    expect(await page(friends.uri)).toEqual([uri(ALICE, 'a3'), uri(ALICE, 'a2'), uri(ALICE, 'a1')]);

    // Narrowing the rule: Alice's posts leave the index, and an indexed post from outside the rule is never served.
    await h.s.db('atproto_feed_items').insert({ id: '01JZZZZZZZZZZZZZZZZZZZZZZZ', feed_id: friends.id, tenant_id: h.tenantId, uri: uri(CAROL, 'sneaky'), uri_hash: 'x'.repeat(64), cid: null, author_did: CAROL, collection: POST, sort: Date.now() + 10_000, score: null, created_at: Date.now() });
    expect(await page(friends.uri)).not.toContain(uri(CAROL, 'sneaky'));
    const narrowed = (await admin.patch(`/api/atproto/feeds/${friends.id}`, { rules: { authors: [BOB] } }).expect(200)).body as { counts: { items: number } };
    expect(narrowed.counts.items).toBe(0);
    const audit = (await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'atproto.feed.updated' }).orderBy('seq', 'desc').first()) as { detail: string };
    expect(JSON.parse(audit.detail)).toMatchObject({ removed: 4 });
    // A deleted post leaves every feed.
    jet.send(jetCommit(7000, ALICE, POST, 'a3', null, 'delete'));
    await until(async () => !(await page(cats.uri)).includes(uri(ALICE, 'a3')), 'the deleted post to leave the cats feed');
    // Changing the keywords empties the index (the text is not kept).
    await admin.patch(`/api/atproto/feeds/${cats.id}`, { rules: { keywords: ['dog'] } }).expect(200);
    expect(await page(cats.uri)).toEqual([]);
    await m.close();
    await admin.post(`/api/atproto/firehose/${subId}/stop`).expect(200);
  });

  it('B-3002: ranking by embeddings through the gateway and by a classifier', async () => {
    const sid = { id: 'RANKSUB' };
    const emb = (await admin.post('/api/atproto/feeds', { rkey: 'felines', displayName: 'Felines', ranking: { kind: 'embedding', profile: 'feed-embed', query: 'cat kitten whiskers purr', minScore: 0.4 } }).expect(201)).body as { id: string; uri: string };
    await ingest(sid, ALICE, 'e1', 'a dog on a walk');
    await ingest(sid, ALICE, 'e2', 'cat with whiskers');
    await ingest(sid, BOB, 'e3', 'kitten purr cat whiskers');
    await ingest(sid, BOB, 'e4', 'cat');
    const ranked = ((await skeleton(emb.uri).expect(200)).body as { feed: { post: string }[] }).feed.map((x) => x.post);
    expect(ranked).toEqual([uri(BOB, 'e3'), uri(ALICE, 'e2'), uri(BOB, 'e4')]); // the dog scores below minScore
    const scores = (await h.s.db('atproto_feed_items').where({ feed_id: emb.id }).orderBy('sort', 'desc').select('score')) as { score: number }[];
    expect(scores.every((x, i) => i === 0 || x.score <= scores[i - 1]!.score)).toBe(true);
    expect(ollama.requests.filter((c) => c.path === '/api/embed').length).toBeGreaterThanOrEqual(5); // the query once, each post

    const pii = (await admin.post('/api/atproto/feeds', { rkey: 'contact', displayName: 'Contact details', ranking: { kind: 'classifier', classifier: 'pii', label: 'email', minScore: 0.5 } }).expect(201)).body as { id: string; uri: string };
    await ingest(sid, CAROL, 'p1', 'write to me at carol@example.org');
    await ingest(sid, CAROL, 'p2', 'no address here');
    expect(((await skeleton(pii.uri).expect(200)).body as { feed: { post: string }[] }).feed.map((x) => x.post)).toEqual([uri(CAROL, 'p1')]);

    // A ranking that fails leaves the post out and is counted.
    await h.s.gateway.repo.updateProfile(h.tenantId, 'EMBED00000000000000000000A', { status: 'disabled' });
    await ingest(sid, ALICE, 'e5', 'cat cat cat');
    const after = (await admin.get(`/api/atproto/feeds/${emb.id}`).expect(200)).body as { counts: { rankFailed: number; items: number }; lastError: string };
    expect(after.counts.items).toBe(3);
    expect(after.counts.rankFailed).toBe(1);
    expect(after.lastError).toMatch(/Ranking .* failed/);
  });

  it('B-3003: a cursor returns the next page without repeats; retention, size and the per-feed rate limit', async () => {
    const f = (await admin.post('/api/atproto/feeds', { rkey: 'paging', displayName: 'Paging', rules: { authors: [ALICE] }, retentionHours: 24, maxItems: 30, ratePerMinute: 1000 }).expect(201)).body as { id: string; uri: string };
    const sid = { id: 'PAGESUB' };
    for (let i = 0; i < 25; i++) await ingest(sid, ALICE, `p${String(i).padStart(2, '0')}`, `post ${i}`);
    const get = async (cursor?: string) => (await skeleton(f.uri, { limit: 10, ...(cursor ? { cursor } : {}) }).expect(200)).body as { feed: { post: string }[]; cursor?: string };
    const p1 = await get();
    expect(p1.feed).toHaveLength(10);
    expect(p1.cursor).toBeTruthy();
    // New posts arrive between pages: they go to the top, and the cursor carries on where it was.
    for (let i = 25; i < 30; i++) await ingest(sid, ALICE, `p${i}`, `post ${i}`);
    const p2 = await get(p1.cursor);
    const p3 = await get(p2.cursor);
    expect(p2.feed).toHaveLength(10);
    expect(p3.feed).toHaveLength(5);
    expect(p3.cursor).toBeUndefined();
    const seen = [...p1.feed, ...p2.feed, ...p3.feed].map((x) => x.post);
    expect(new Set(seen).size).toBe(25);
    expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => uri(ALICE, `p${String(24 - i).padStart(2, '0')}`)));
    expect((await get()).feed[0]!.post).toBe(uri(ALICE, 'p29'));

    // Ties (a ranked feed where every post scores the same) page by id, still without repeats.
    const tied = (await admin.post('/api/atproto/feeds', { rkey: 'tied', displayName: 'Tied', ranking: { kind: 'classifier', classifier: 'pii', label: 'email' } }).expect(201)).body as { id: string; uri: string };
    for (let i = 0; i < 7; i++) await ingest(sid, BOB, `t${i}`, `nothing personal ${i}`);
    const tpages: string[] = [];
    let cursor: string | undefined;
    do {
      const r = (await skeleton(tied.uri, { limit: 3, ...(cursor ? { cursor } : {}) }).expect(200)).body as { feed: { post: string }[]; cursor?: string };
      tpages.push(...r.feed.map((x) => x.post));
      cursor = r.cursor;
    } while (cursor);
    expect(tpages).toHaveLength(7);
    expect(new Set(tpages).size).toBe(7);

    // The admin preview pages the same way and is not counted as served.
    const served = ((await admin.get(`/api/atproto/feeds/${f.id}`)).body as { counts: { served: number } }).counts.served;
    const preview = (await admin.get(`/api/atproto/feeds/${f.id}/skeleton?limit=5`).expect(200)).body as { feed: unknown[]; cursor: string };
    expect(preview.feed).toHaveLength(5);
    expect(((await admin.get(`/api/atproto/feeds/${f.id}`)).body as { counts: { served: number } }).counts.served).toBe(served);

    // Retention: rows older than the feed keeps are not served, and are pruned; then the size cap.
    await h.s.db('atproto_feed_items')
      .where({ feed_id: f.id })
      .whereIn('uri_hash', (await h.s.db('atproto_feed_items').where({ feed_id: f.id }).orderBy('sort', 'asc').limit(4).select('uri_hash')).map((r: { uri_hash: string }) => r.uri_hash))
      .update({ created_at: Date.now() - 25 * 3_600_000 });
    expect(((await skeleton(f.uri, { limit: 100 }).expect(200)).body as { feed: unknown[] }).feed).toHaveLength(26);
    await admin.patch(`/api/atproto/feeds/${f.id}`, { maxItems: 20 }).expect(200);
    const pruned = await h.s.feedGenerators.prune(h.tenantId);
    expect(pruned.removed).toBeGreaterThanOrEqual(10);
    const left = ((await skeleton(f.uri, { limit: 100 }).expect(200)).body as { feed: { post: string }[] }).feed.map((x) => x.post);
    expect(left).toHaveLength(20);
    expect(left[0]).toBe(uri(ALICE, 'p29'));
    expect(left.at(-1)).toBe(uri(ALICE, 'p10'));

    // The per-feed rate limit.
    await admin.patch(`/api/atproto/feeds/${f.id}`, { ratePerMinute: 2 }).expect(200);
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await skeleton(f.uri)).status);
    expect(statuses.slice(-2)).toEqual([429, 429]);
    const limited = await skeleton(f.uri);
    expect(limited.body).toMatchObject({ error: 'RateLimitExceeded' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('B-3004 interface: the generator record names the service DID; a publication is recorded and the URI follows it', async () => {
    const list = (await admin.get('/api/atproto/feeds').expect(200)).body as { generator: { did: string }; feeds: { id: string; rkey: string; record: Record<string, unknown>; uri: string }[] };
    const f = list.feeds.find((x) => x.rkey === 'paging')!;
    await admin.patch(`/api/atproto/feeds/${f.id}`, { ratePerMinute: 1000 }).expect(200); // after the rate-limit test
    expect(f.record).toMatchObject({ $type: 'app.bsky.feed.generator', did, displayName: 'Paging' });
    expect(typeof f.record.createdAt).toBe('string');
    const row = (await h.s.feedGenerators.get(h.tenantId, f.id))!;
    expect(h.s.feedGenerators.recordFor(row, list.generator.did)).toEqual(f.record);
    const publisher = 'did:plc:publisheraaaaaaaaaaaaaaa';
    expect((await admin.put(`/api/atproto/feeds/${f.id}/publication`, { did: publisher, uri: `at://${publisher}/app.bsky.feed.generator/other` })).status).toBe(400);
    const pub = (await admin.put(`/api/atproto/feeds/${f.id}/publication`, { did: publisher, uri: `at://${publisher}/app.bsky.feed.generator/paging`, cid: Cid.ofCbor(cborEncode(f.record)).toString() }).expect(200)).body as { uri: string; published: { did: string } };
    expect(pub.uri).toBe(`at://${publisher}/app.bsky.feed.generator/paging`);
    expect(pub.published.did).toBe(publisher);
    // Once published, only the published URI names the feed.
    await skeleton(pub.uri).expect(200);
    expect((await skeleton(`at://${did}/app.bsky.feed.generator/paging`)).body).toMatchObject({ error: 'UnknownFeed' });
    expect(((await xrpc('app.bsky.feed.describeFeedGenerator').expect(200)).body as { feeds: { uri: string }[] }).feeds.map((x) => x.uri)).toContain(pub.uri);
    await admin.del(`/api/atproto/feeds/${f.id}/publication`).expect(200);
    await skeleton(`at://${did}/app.bsky.feed.generator/paging`).expect(200);
    const actions = ((await h.s.db('audit_events').where({ tenant_id: h.tenantId }).whereIn('action', ['atproto.feed.published', 'atproto.feed.unpublished']).orderBy('seq', 'asc').select('action')) as { action: string }[]).map((a) => a.action);
    expect(actions).toEqual(['atproto.feed.published', 'atproto.feed.unpublished']);
    await admin.del(`/api/atproto/feeds/${f.id}`).expect(204);
    expect(await h.s.db('atproto_feed_items').where({ feed_id: f.id })).toHaveLength(0);
  });

  it('did:plc: a signed PLC operation adds the #bsky_fg service, once', async () => {
    const by = { tenantId: h.tenantId, userId: null, actor: { service: 'test' } };
    const identity = await h.s.atproto.createIdentity(by, null, { method: 'plc' });
    const svc = { type: 'BskyFeedGenerator', endpoint: identity.endpoint };
    const after = await h.s.atproto.ensurePlcService(by, identity, 'bsky_fg', svc);
    expect(plc.log.get(identity.did)).toHaveLength(2);
    expect(after.plc_op?.services.bsky_fg).toEqual(svc);
    expect((await h.s.atproto.document(after)).service).toContainEqual({ id: '#bsky_fg', type: 'BskyFeedGenerator', serviceEndpoint: identity.endpoint });
    await h.s.atproto.ensurePlcService(by, after, 'bsky_fg', svc);
    expect(plc.log.get(identity.did)).toHaveLength(2);
    expect(plc.refused).toEqual([]);
  });

  it('B-3604: a commit with a bad signature is dropped and audited; a good one becomes a label as before', async () => {
    const bob = new FakeRepo(BOB).publish(plc);
    const r = await admin.post('/api/atproto/firehose', { name: 'Relay', protocol: 'subscribe-repos', endpoint: `${jet.url}/`, workspaceId: ws, start: true }).expect(201);
    const id = r.body.id as string;
    const m = manager();
    const before = jet.connections.length;
    m.start();
    await until(() => (jet.connections.length > before ? jet.latest : null), 'the relay connection');
    jet.send(bob.commit(10, [{ collection: POST, rkey: 'good', record: { text: 'the FORBIDDENWORD, signed' } }]));
    jet.send(bob.commit(11, [{ collection: POST, rkey: 'forged', record: { text: 'the FORBIDDENWORD, forged' } }], 'signature'));
    jet.send(bob.commit(12, [{ collection: POST, rkey: 'swapped', record: { text: 'the FORBIDDENWORD, swapped' } }], 'record'));
    jet.send(bob.commit(13, [{ collection: POST, rkey: 'gap', record: { text: 'the FORBIDDENWORD, gap' } }], 'missing-node'));
    jet.send(bob.commit(14, [{ collection: POST, rkey: 'after', record: { text: 'the FORBIDDENWORD, after' } }]));
    await until(() => m.local(id)?.cursor === 14, 'the relay cursor to reach 14');
    await m.checkpointAll();
    const labels = ((await h.s.db('atproto_labels').where({ tenant_id: h.tenantId }).where('uri', 'like', `at://${BOB}/%`).select('uri', 'val')) as { uri: string; val: string }[]).map((l) => `${l.uri} ${l.val}`);
    expect(labels.sort()).toEqual([`${uri(BOB, 'after')} !hide`, `${uri(BOB, 'b1')} !hide`, `${uri(BOB, 'good')} !hide`]);
    const checked = ((await h.s.db('moderation_objects').where({ tenant_id: h.tenantId, object_type: 'atproto-post' }).where('object_id', 'like', `at://${BOB}/%`).select('object_id')) as { object_id: string }[]).map((x) => x.object_id);
    expect(checked).not.toContain(uri(BOB, 'forged'));
    expect(checked).not.toContain(uri(BOB, 'swapped'));
    expect(checked).not.toContain(uri(BOB, 'gap'));
    const view = (await admin.get(`/api/atproto/firehose/${id}`).expect(200)).body as { counts: { rejected: number; checked: number }; lastError: string };
    expect(view.counts.rejected).toBe(3);
    expect(view.counts.checked).toBe(2);
    const rejected = (await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'atproto.firehose.commit.rejected' }).orderBy('seq', 'asc').select('target', 'detail')) as { target: string; detail: string }[];
    // FIREHOSE_REJECT_AUDITS=2: two audits this minute, the third counted for the next one.
    expect(rejected).toHaveLength(2);
    expect(rejected.map((a) => JSON.parse(a.detail) as { reason: string; seq: number })).toMatchObject([
      { reason: 'signature', seq: 11 },
      { reason: 'proof', seq: 12 }
    ]);
    expect(JSON.parse(rejected[0]!.target)).toEqual({ subscription: id, did: BOB });
    await m.close();
    await admin.post(`/api/atproto/firehose/${id}/stop`).expect(200);
  });
});

describe('B-3603: fifty concurrent RSVPs for one place leave one attendee (SQLite)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  }, 60_000);
  afterAll(async () => {
    await h?.close();
  });

  it('holds the last place for exactly one of fifty simultaneous answers', async () => {
    const s = h.s;
    const ws = await s.tenants.createWorkspace(h.tenantId, 'Venue', 'internal');
    const person = async (username: string) => {
      const u = await s.users.create(h.tenantId, { username, displayName: username, clearance: 'internal' });
      await s.users.update(h.tenantId, u.id, { clearance_direct: 'internal' });
      await s.users.setRoles(u.id, 'direct', ['member']);
      await s.tenants.addMember(ws.id, u.id);
      const p = (await loadPrincipal(s, h.tenantId, u.id, {}))!;
      p.workspaceId = ws.id;
      return { p, ip: null };
    };
    const owner = await person('host');
    const g = await s.groups.create(owner, { workspaceId: ws.id, name: 'Open mic', visibility: 'public', joinMode: 'open' });
    const ev = await s.calendar.create(owner, g.id, { title: 'One seat', start: new Date(Date.now() + 3_600_000).toISOString(), timeZone: 'UTC', capacity: 1 });
    const people = await Promise.all(Array.from({ length: 50 }, (_, i) => person(`fan${i}`)));
    const results = await Promise.allSettled(people.map((ctx) => s.calendar.rsvp(ctx, ev.id, { response: 'going' })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason.status)).toEqual(Array(49).fill(409));
    expect(await s.db('group_event_rsvps').where({ event_id: ev.id, response: 'going' })).toHaveLength(1);
  });
});
