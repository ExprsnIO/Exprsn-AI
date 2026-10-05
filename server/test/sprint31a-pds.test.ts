/*
 * 1.5.0, Sprint 31 (B-2901 to B-2905, B-3004): the AT-Protocol personal data server end to end, on SQLite, with
 * account keys in the signer, a PLC directory double, a ClamAV double and a relay double.
 *
 * - B-2901: hosting opt-in per tenant by a platform admin; accounts tied to Exprsn-AI users; handles on the tenant's
 *   subdomain that resolve to their DID; sessions from app passwords only; createAccount under the sign-up policy with
 *   invite codes.
 * - B-2902: writes with lexicon validation; a repo exported as CAR verifies against its signed commit (with the key
 *   its DID document names).
 * - B-2903: a blob that fails the scan is never served.
 * - B-2904: requestCrawl to the configured relay; the relay double replays commits from a cursor and checks each one.
 * - B-2905: deactivation; a takedown through moderation answers RepoTakendown and publishes !takedown; migration out
 *   of this PDS into a second one (and so in), with the DID moved by a signed PLC operation.
 * - B-3004: the feed generator record published to a hosted repo and to an external account names the service DID.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseMultikey } from '../src/atproto/crypto.js';
import { didDocument } from '../src/atproto/did.js';
import { verifyRepoCar } from '../src/atproto/pds/repo.js';
import { attachRepoStream } from '../src/atproto/pds/sequencer.js';
import { startSigner } from '../src/signer/server.js';
import { harness, localUser, login, loginAdmin, PASSWORD, type Harness } from './helpers.js';
import { loopbackServerFor } from './loopback.js';
import { FakePlcDirectory } from './sprint25b-fakes.js';
import { FakeClamd, TINY_PNG } from './sprint26d-fakes.js';
import { FakeRelay } from './sprint31a-fakes.js';

const EVIL = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

async function signerFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'exs-'));
  const socketPath = path.join(dir, 'run', 'signer.sock');
  const token = randomBytes(24).toString('base64url') + 'x'.repeat(8);
  const signer = await startSigner({ socketPath, key: randomBytes(32).toString('base64'), token });
  return {
    socketPath,
    token,
    signer,
    close: async () => {
      await signer.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const egressZone = () => ({ contents: 'edge', trust: 'private', cidrs: ['10.10.0.0/24'], maxLabel: 'restricted', accepts: [], acceptsNote: null, egress: { mode: 'allow-list', allow: [{ kind: 'cidr', cidr: '0.0.0.0/0', ports: [443] }], note: null }, peers: [], services: [] });
const zones = (h: Harness) => {
  h.s.zones.current = async () => new Map([['edge', { version: 1, spec: egressZone() }], ['data', { version: 1, spec: { ...egressZone(), egress: { mode: 'deny', allow: [], note: null } } }]]) as never;
};

type Api = { get(p: string): request.Test; post(p: string, b?: object): request.Test; put(p: string, b?: object): request.Test; patch(p: string, b?: object): request.Test; del(p: string): request.Test };
const api = (c: { agent: ReturnType<typeof request.agent>; csrf: string }): Api => ({
  get: (p) => c.agent.get(p),
  post: (p, b = {}) => c.agent.post(p).set('x-csrf-token', c.csrf).send(b),
  put: (p, b = {}) => c.agent.put(p).set('x-csrf-token', c.csrf).send(b),
  patch: (p, b = {}) => c.agent.patch(p).set('x-csrf-token', c.csrf).send(b),
  del: (p) => c.agent.delete(p).set('x-csrf-token', c.csrf)
});

/** An XRPC client against an app. */
const xrpc = (h: Harness) => ({
  get: (nsid: string, q: Record<string, string | string[]> = {}, token?: string) => {
    const t = request(h.app).get(`/xrpc/${nsid}`).query(q);
    return token ? t.set('authorization', `Bearer ${token}`) : t;
  },
  post: (nsid: string, body?: object, token?: string) => {
    const t = request(h.app).post(`/xrpc/${nsid}`);
    if (token) t.set('authorization', `Bearer ${token}`);
    return body === undefined ? t : t.send(body);
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Sprint 31: the AT-Protocol PDS', () => {
  let f: Awaited<ReturnType<typeof signerFixture>>;
  let plc: FakePlcDirectory;
  let clam: FakeClamd;
  let relay: FakeRelay;
  let h: Harness;
  let h2: Harness;
  let streams: ReturnType<typeof attachRepoStream>[] = [];
  let wsBase = '';
  let sys: Api;
  let sys2: Api;
  let alice: Api;
  let x: ReturnType<typeof xrpc>;
  let x2: ReturnType<typeof xrpc>;
  const DOMAIN = 'default.pds.example.test';

  const plcKey = async (did: string): Promise<string> => {
    const doc = didDocument(did, plc.log.get(did)!.at(-1)!);
    return doc.verificationMethod.find((v) => v.id.endsWith('#atproto'))!.publicKeyMultibase;
  };

  beforeAll(async () => {
    f = await signerFixture();
    plc = new FakePlcDirectory();
    await plc.start();
    clam = await new FakeClamd().start();
    clam.signatures = ['EICAR-STANDARD-ANTIVIRUS-TEST-FILE'];
    relay = await new FakeRelay(plcKey).start();
    const common = { DATA_KEY: '', SIGNER_SOCKET: f.socketPath, SIGNER_TOKEN: f.token, ATPROTO_PLC_URL: plc.url, CLAMD_HOST: '127.0.0.1', CLAMD_PORT: String(clam.port), ZONES_AIR_GAPPED: 'false' };
    h = await harness({ ...common, PDS_PUBLIC_URL: 'https://pds.example.test', PDS_HANDLE_DOMAIN: 'pds.example.test', PDS_RELAYS: relay.url, ATPROTO_PUBLIC_URL: 'https://labels.example.test' });
    h2 = await harness({ ...common, PDS_PUBLIC_URL: 'https://pds2.example.test', PDS_HANDLE_DOMAIN: 'pds2.example.test' });
    zones(h);
    zones(h2);
    for (const hh of [h, h2]) {
      const server = loopbackServerFor(hh.app)!;
      streams.push(attachRepoStream(server, hh.s));
    }
    wsBase = `ws://127.0.0.1:${(loopbackServerFor(h.app)!.address() as AddressInfo).port}`;
    await localUser(h, 'pdsadmin', ['system-admin'], 'confidential');
    sys = api(await loginAdmin(h, 'pdsadmin'));
    await localUser(h2, 'pdsadmin2', ['system-admin'], 'confidential');
    sys2 = api(await loginAdmin(h2, 'pdsadmin2'));
    await localUser(h, 'alice', ['member']);
    alice = api(await login(h, 'alice'));
    x = xrpc(h);
    x2 = xrpc(h2);
  }, 60_000);

  afterAll(async () => {
    for (const s of streams) await s.close();
    streams = [];
    await h?.close();
    await h2?.close();
    await relay?.stop();
    await clam?.stop();
    await plc?.stop();
    await f?.close();
  });

  // ---------- B-2901 ----------

  it('B-2901: hosting is off until a platform admin enables it, in a zone with egress', async () => {
    expect((await alice.post('/api/me/pds', { handle: 'alice' })).status).toBe(409);
    expect((await x.post('com.atproto.server.createAccount', { handle: `bob.${DOMAIN}`, email: 'bob@example.com', password: PASSWORD })).body.error).toBe('UnsupportedDomain');
    expect((await alice.get('/api/admin/pds')).status).toBe(403);
    // A tenant admin manages hosting settings but cannot turn hosting on.
    await localUser(h, 'tadmin', ['tenant-admin'], 'confidential');
    const tadmin = api(await loginAdmin(h, 'tadmin'));
    expect((await tadmin.put(`/api/admin/pds/tenants/${h.tenantId}`, { enabled: true })).status).toBe(403);
    const refused = await sys.put(`/api/admin/pds/tenants/${h.tenantId}`, { enabled: true, zone: 'data' });
    expect(refused.status).toBe(409);
    expect(refused.body.detail).toMatch(/egress/);
    const on = await sys.put(`/api/admin/pds/tenants/${h.tenantId}`, { enabled: true });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body).toMatchObject({ enabled: true, zone: 'edge', handleDomain: DOMAIN });
    const desc = await x.get('com.atproto.server.describeServer');
    expect(desc.body).toMatchObject({ did: 'did:web:pds.example.test', availableUserDomains: [`.${DOMAIN}`], inviteCodeRequired: false });
    const settings = (await tadmin.get('/api/admin/pds')).body;
    expect(settings).toMatchObject({ enabled: true, handleDomain: DOMAIN, service: { did: 'did:web:pds.example.test', endpoint: 'https://pds.example.test', custody: 'signer' } });
    expect((await h.s.db('audit_events').where({ action: 'pds.hosting.enabled' })).length).toBe(1);
  });

  let aliceDid = '';

  it('B-2901: a user’s new account gets a did:plc whose handle resolves to it, keys in the signer only', async () => {
    const keygens = f.signer.served.keygen ?? 0;
    expect((await alice.post('/api/me/pds', { handle: 'admin' })).status).toBe(400);
    expect((await alice.post('/api/me/pds', { handle: 'alice.elsewhere.example.com' })).body.error).toBe('UnsupportedDomain');
    const r = await alice.post('/api/me/pds', { handle: 'alice' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ handle: `alice.${DOMAIN}`, state: 'active', didMethod: 'plc', custody: 'signer', curve: 'secp256k1' });
    aliceDid = r.body.did;
    expect(aliceDid).toMatch(/^did:plc:[a-z2-7]{24}$/);
    expect(f.signer.served.keygen! - keygens).toBe(2); // the repo key and the rotation key
    // The PLC directory accepted the genesis operation: this PDS, the repo key and the handle.
    const doc = didDocument(aliceDid, plc.log.get(aliceDid)!.at(-1)!);
    expect(doc.alsoKnownAs).toEqual([`at://alice.${DOMAIN}`]);
    expect(doc.service).toEqual([{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.example.test' }]);
    expect(`did:key:${doc.verificationMethod[0]!.publicKeyMultibase}`).toBe(r.body.signingKey);
    // The handle resolves to the DID: over HTTPS on the handle's host, and through resolveHandle.
    const wk = await request(h.app).get('/.well-known/atproto-did').set('host', `alice.${DOMAIN}`);
    expect(wk.status).toBe(200);
    expect(wk.text).toBe(aliceDid);
    expect((await x.get('com.atproto.identity.resolveHandle', { handle: `alice.${DOMAIN}` })).body).toEqual({ did: aliceDid });
    // No private key in the database: the row holds the signer's wrapped blob and the public key.
    const row = await h.s.db('pds_accounts').where({ did: aliceDid }).first();
    expect(String(row.key_wrapped)).not.toMatch(/PRIVATE KEY/);
    expect(row.key_multikey).toMatch(/^zQ3s/);
    // One account per user.
    expect((await alice.post('/api/me/pds', { handle: 'alice2' })).status).toBe(409);
    // The firehose saw the account: identity, account, commit and sync events.
    expect((await h.s.db('pds_events').where({ did: aliceDid }).orderBy('seq')).map((e) => e.type)).toEqual(['identity', 'account', 'commit', 'sync']);
  });

  let access = '';
  let refresh = '';
  let appPassword = '';

  it('B-2901: sessions come from app passwords only; a refresh token is spent once', async () => {
    const made = await alice.post('/api/me/pds/app-passwords', { name: 'Bluesky on my phone' });
    expect(made.status).toBe(201);
    appPassword = made.body.password;
    expect(appPassword).toMatch(/^[a-z2-7]{4}(-[a-z2-7]{4}){3}$/);
    expect((await alice.get('/api/me/pds')).body.appPasswords[0]).not.toHaveProperty('password');
    // The Exprsn-AI password never works over XRPC.
    const primary = await x.post('com.atproto.server.createSession', { identifier: `alice.${DOMAIN}`, password: PASSWORD });
    expect(primary.status).toBe(401);
    expect(primary.body.message).toMatch(/app passwords only/);
    const s = await x.post('com.atproto.server.createSession', { identifier: `alice.${DOMAIN}`, password: appPassword });
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ did: aliceDid, handle: `alice.${DOMAIN}`, active: true });
    expect(s.body.didDoc.id).toBe(aliceDid);
    const byDid = await x.post('com.atproto.server.createSession', { identifier: aliceDid, password: appPassword });
    expect(byDid.status).toBe(200);
    access = byDid.body.accessJwt;
    const r1 = await x.post('com.atproto.server.refreshSession', undefined, byDid.body.refreshJwt);
    expect(r1.status).toBe(200);
    const again = await x.post('com.atproto.server.refreshSession', undefined, byDid.body.refreshJwt);
    expect(again.body.error).toBe('ExpiredToken');
    refresh = r1.body.refreshJwt;
    access = r1.body.accessJwt;
    expect((await x.get('com.atproto.server.getSession', {}, access)).body).toMatchObject({ did: aliceDid, active: true });
    expect((await x.get('com.atproto.server.getSession', {}, 'not-a-token')).status).toBe(400);
    expect((await x.get('com.atproto.server.getSession')).body.error).toBe('AuthMissing');
    // An access token is not a refresh token, nor the other way round.
    expect((await x.post('com.atproto.server.refreshSession', undefined, access)).body.error).toBe('InvalidToken');
    expect((await x.get('com.atproto.server.getSession', {}, refresh)).body.error).toBe('InvalidToken');
  });

  // ---------- B-2902 ----------

  let postUri = '';

  it('B-2902: records are validated against their lexicon and committed', async () => {
    const post = { $type: 'app.bsky.feed.post', text: 'Hello from Exprsn-AI', createdAt: new Date().toISOString(), langs: ['en'] };
    const c = await x.post('com.atproto.repo.createRecord', { repo: aliceDid, collection: 'app.bsky.feed.post', record: post }, access);
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ validationStatus: 'valid', commit: { rev: expect.any(String) } });
    postUri = c.body.uri;
    expect(postUri).toMatch(new RegExp(`^at://${aliceDid}/app.bsky.feed.post/[234567a-z]{13}$`));
    // Too long a post, a wrong $type, a missing field: refused.
    expect((await x.post('com.atproto.repo.createRecord', { repo: aliceDid, collection: 'app.bsky.feed.post', record: { ...post, text: 'x'.repeat(3001) } }, access)).body.error).toBe('InvalidRecord');
    expect((await x.post('com.atproto.repo.createRecord', { repo: aliceDid, collection: 'app.bsky.feed.post', record: { $type: 'app.bsky.feed.like', subject: {} } }, access)).body.error).toBe('InvalidRequest');
    expect((await x.post('com.atproto.repo.createRecord', { repo: aliceDid, collection: 'app.bsky.feed.post', record: { $type: 'app.bsky.feed.post', text: 'no date' } }, access)).body.error).toBe('InvalidRecord');
    // A profile needs the literal:self key.
    expect((await x.post('com.atproto.repo.putRecord', { repo: aliceDid, collection: 'app.bsky.actor.profile', rkey: 'me', record: { $type: 'app.bsky.actor.profile', displayName: 'Alice' } }, access)).body.error).toBe('InvalidRecord');
    const prof = await x.post('com.atproto.repo.putRecord', { repo: aliceDid, collection: 'app.bsky.actor.profile', rkey: 'self', record: { $type: 'app.bsky.actor.profile', displayName: 'Alice' } }, access);
    expect(prof.status).toBe(200);
    // An unknown collection is stored unvalidated, unless validation is required.
    const unknown = await x.post('com.atproto.repo.createRecord', { repo: aliceDid, collection: 'net.example.note', record: { $type: 'net.example.note', body: 'anything' } }, access);
    expect(unknown.body.validationStatus).toBe('unknown');
    expect((await x.post('com.atproto.repo.createRecord', { repo: aliceDid, collection: 'net.example.note', validate: true, record: { $type: 'net.example.note' } }, access)).body.message).toMatch(/Lexicon not found/);
    // Only one's own repo, and a swap that is out of date fails.
    expect((await x.post('com.atproto.repo.createRecord', { repo: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', collection: 'app.bsky.feed.post', record: post }, access)).status).toBe(403);
    expect((await x.post('com.atproto.repo.createRecord', { repo: aliceDid, collection: 'app.bsky.feed.post', record: post, swapCommit: c.body.commit.cid }, access)).body.error).toBe('InvalidSwap');
    // applyWrites: several writes in one commit.
    const aw = await x.post('com.atproto.repo.applyWrites', { repo: aliceDid, writes: [
      { $type: 'com.atproto.repo.applyWrites#create', collection: 'app.bsky.feed.post', rkey: '3l2aaaaaaaaa2', value: { ...post, text: 'one' } },
      { $type: 'com.atproto.repo.applyWrites#create', collection: 'app.bsky.feed.post', rkey: '3l2aaaaaaaab2', value: { ...post, text: 'two' } },
      { $type: 'com.atproto.repo.applyWrites#delete', collection: 'net.example.note', rkey: unknown.body.uri.split('/').pop() }
    ] }, access);
    expect(aw.status).toBe(200);
    expect(aw.body.results.map((r: { $type: string }) => r.$type)).toEqual(['com.atproto.repo.applyWrites#createResult', 'com.atproto.repo.applyWrites#createResult', 'com.atproto.repo.applyWrites#deleteResult']);
    const del = await x.post('com.atproto.repo.deleteRecord', { repo: aliceDid, collection: 'app.bsky.feed.post', rkey: '3l2aaaaaaaab2' }, access);
    expect(del.status).toBe(200);
    // Reads are public.
    const list = await x.get('com.atproto.repo.listRecords', { repo: `alice.${DOMAIN}`, collection: 'app.bsky.feed.post', limit: '1' });
    expect(list.body.records).toHaveLength(1);
    expect(list.body.cursor).toBeTruthy();
    const page2 = await x.get('com.atproto.repo.listRecords', { repo: aliceDid, collection: 'app.bsky.feed.post', limit: '10', cursor: list.body.cursor });
    expect(page2.body.records.map((r: { uri: string }) => r.uri)).not.toContain(list.body.records[0].uri);
    expect((await x.get('com.atproto.repo.getRecord', { repo: aliceDid, collection: 'app.bsky.actor.profile', rkey: 'self' })).body.value).toEqual({ $type: 'app.bsky.actor.profile', displayName: 'Alice' });
    expect((await x.get('com.atproto.repo.describeRepo', { repo: aliceDid })).body).toMatchObject({ handle: `alice.${DOMAIN}`, collections: ['app.bsky.actor.profile', 'app.bsky.feed.post'], handleIsCorrect: true });
  });

  it('B-2902: the repo exported as CAR verifies against its signed commit, with the key the DID document names', async () => {
    const car = await x.get('com.atproto.sync.getRepo', { did: aliceDid }).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(car.status).toBe(200);
    expect(car.headers['content-type']).toMatch(/application\/vnd\.ipld\.car/);
    const k = parseMultikey(await plcKey(aliceDid));
    const repo = verifyRepoCar(car.body as Buffer, { did: aliceDid, key: { curve: k.curve, key: k.key } });
    const latest = (await x.get('com.atproto.sync.getLatestCommit', { did: aliceDid })).body;
    expect(repo.commitCid.toString()).toBe(latest.cid);
    expect(repo.commit.rev).toBe(latest.rev);
    expect(repo.records.map((r) => r.key)).toEqual((await h.s.db('pds_records').where({ account_id: (await h.s.pds.accountByDid(aliceDid))!.id }).select('collection', 'rkey')).map((r: { collection: string; rkey: string }) => `${r.collection}/${r.rkey}`).sort());
    // getRecord (a proof), getBlocks, status.
    const proof = await x.get('com.atproto.sync.getRecord', { did: aliceDid, collection: 'app.bsky.actor.profile', rkey: 'self' }).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(proof.status).toBe(200);
    expect((await x.get('com.atproto.sync.getBlocks', { did: aliceDid, cids: [latest.cid] })).status).toBe(200);
    expect((await x.get('com.atproto.sync.getBlocks', { did: aliceDid, cids: ['bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm'] })).body.error).toBe('BlockNotFound');
    expect((await x.get('com.atproto.sync.getRepoStatus', { did: aliceDid })).body).toMatchObject({ did: aliceDid, active: true, rev: latest.rev });
    expect((await x.get('com.atproto.sync.listRepos')).body.repos).toEqual([expect.objectContaining({ did: aliceDid, head: latest.cid, active: true })]);
    expect((await x.get('com.atproto.sync.getRepo', { did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa' })).body.error).toBe('RepoNotFound');
  });

  // ---------- B-2903 ----------

  let imageBlob: Record<string, unknown> = {};

  it('B-2903: a blob that fails the scan is never served; a clean one is', async () => {
    const up = await x.post('com.atproto.repo.uploadBlob', undefined, access).set('content-type', 'image/png').send(TINY_PNG);
    expect(up.status).toBe(200);
    imageBlob = up.body.blob;
    expect(imageBlob).toMatchObject({ $type: 'blob', mimeType: 'image/png', size: TINY_PNG.length });
    const cid = (imageBlob.ref as { $link: string }).$link;
    expect(cid).toMatch(/^bafkrei/); // raw codec
    expect(clam.scans.at(-1)).toMatchObject({ found: null, bytes: TINY_PNG.length });
    const got = await x.get('com.atproto.sync.getBlob', { did: aliceDid, cid }).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['content-security-policy']).toMatch(/sandbox/);
    expect((got.body as Buffer).equals(TINY_PNG)).toBe(true);
    // At rest it is sealed: the stored object is not the plain PNG.
    const row = await h.s.db('pds_blobs').where({ cid }).first();
    expect((await h.s.blobs.get(row.blob_key))!.includes(TINY_PNG)).toBe(false);
    // Infected: refused, recorded, never served, and no record can use it.
    const infected = Buffer.concat([TINY_PNG, Buffer.from(EVIL)]);
    const bad = await x.post('com.atproto.repo.uploadBlob', undefined, access).set('content-type', 'image/png').send(infected);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('BlobRejected');
    const badRow = await h.s.db('pds_blobs').where({ state: 'rejected' }).first();
    expect(badRow.blob_key).toBeNull();
    expect((await x.get('com.atproto.sync.getBlob', { did: aliceDid, cid: badRow.cid })).body.error).toBe('BlobNotFound');
    const usesBad = await x.post('com.atproto.repo.createRecord', { repo: aliceDid, collection: 'app.bsky.feed.post', record: { $type: 'app.bsky.feed.post', text: 'look', createdAt: new Date().toISOString(), embed: { $type: 'app.bsky.embed.images', images: [{ alt: '', image: { $type: 'blob', ref: { $link: badRow.cid }, mimeType: 'image/png', size: infected.length } }] } } }, access);
    expect(usesBad.body.error).toBe('BlobNotFound');
    expect((await h.s.db('audit_events').where({ action: 'pds.blob.rejected' })).length).toBe(1);
    // Wrong type for the tenant: text is not an accepted blob type.
    expect((await x.post('com.atproto.repo.uploadBlob', undefined, access).set('content-type', 'text/plain').send(Buffer.from('hello'))).body.error).toBe('InvalidMimeType');
    // A tenant limit below the size is refused before the scan.
    await sys.patch('/api/admin/pds/settings', { blobMaxBytes: 1024 }).expect(200);
    expect((await x.post('com.atproto.repo.uploadBlob', undefined, access).set('content-type', 'image/png').send(Buffer.concat([TINY_PNG, Buffer.alloc(2000)]))).body.error).toBe('BlobTooLarge');
    await sys.patch('/api/admin/pds/settings', { blobMaxBytes: null }).expect(200);
    // A post with the clean image, and listBlobs names it.
    const withImage = await x.post('com.atproto.repo.createRecord', { repo: aliceDid, collection: 'app.bsky.feed.post', record: { $type: 'app.bsky.feed.post', text: 'a picture', createdAt: new Date().toISOString(), embed: { $type: 'app.bsky.embed.images', images: [{ alt: 'grey', image: imageBlob }] } } }, access);
    expect(withImage.status).toBe(200);
    expect((await x.get('com.atproto.sync.listBlobs', { did: aliceDid })).body.cids).toEqual([cid]);
  });

  // ---------- B-2904 ----------

  it('B-2904: relays are asked to crawl, and a relay double replays commits from a cursor and checks every one', async () => {
    await sleep(1300);
    for (let i = 0; i < 10 && !relay.crawlRequests.length; i++) {
      await h.s.jobs.runDue();
      await sleep(50);
    }
    expect(relay.crawlRequests[0]).toEqual({ hostname: 'pds.example.test' });
    // From the start: every event, in order, every commit verified (signature, proofs, records).
    const all = await relay.crawl(wsBase, { cursor: 0 });
    expect(all.error).toBeNull();
    expect(relay.rejected).toEqual([]);
    const seqs = relay.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs[0]).toBe(1);
    const seen = relay.repos.get(aliceDid)!;
    expect(seen.get('app.bsky.actor.profile/self')).toMatchObject({ displayName: 'Alice' });
    expect([...seen.keys()].filter((k) => k.startsWith('net.example.note'))).toEqual([]);
    const commits = relay.events.filter((e) => e.type === 'commit');
    expect(commits.at(-1)!.body).toMatchObject({ repo: aliceDid, rebase: false, tooBig: false });
    expect(commits.at(-1)!.body.prevData).toBeTruthy();
    // Then from its cursor: only what comes after.
    const before = relay.cursor!;
    await x.post('com.atproto.repo.createRecord', { repo: aliceDid, collection: 'app.bsky.feed.post', record: { $type: 'app.bsky.feed.post', text: 'after the cursor', createdAt: new Date().toISOString() } }, access).expect(200);
    const n = relay.events.length;
    const more = await relay.crawl(wsBase);
    expect(more.frames).toBe(1);
    expect(relay.events.length).toBe(n + 1);
    expect(relay.events.at(-1)!.seq).toBe(before + 1);
    expect([...relay.repos.get(aliceDid)!.values()].some((r) => r.text === 'after the cursor')).toBe(true);
    expect(relay.rejected).toEqual([]);
    // A cursor in the future is refused; one past the backfill window gets OutdatedCursor and the oldest kept event.
    expect((await relay.crawl(wsBase, { cursor: before + 1000 })).error).toBe('FutureCursor');
    await h.s.db('pds_events').where('seq', '<=', 3).update({ created_at: Date.now() - 100 * 3600_000 });
    const old = await relay.crawl(wsBase, { cursor: 0, count: 1 });
    expect(old.infos).toEqual(['OutdatedCursor']);
    expect(relay.events.at(-1)!.seq).toBe(4);
    // Live: a subscriber without a cursor gets the next commit.
    const live = relay.crawl(wsBase, { cursor: null, count: 1, ms: 3000 });
    await sleep(100);
    await x.post('com.atproto.repo.createRecord', { repo: aliceDid, collection: 'app.bsky.feed.post', record: { $type: 'app.bsky.feed.post', text: 'live', createdAt: new Date().toISOString() } }, access).expect(200);
    expect((await live).frames).toBe(1);
    expect(relay.events.at(-1)!.type).toBe('commit');
    expect(relay.rejected).toEqual([]);
    // The admin's crawl request goes out at once.
    const crawl = await sys.post('/api/admin/pds/crawl');
    expect(crawl.body.relays[0]).toMatchObject({ relay: relay.url, status: 200, error: null });
  });

  // ---------- B-2901: createAccount under the sign-up policy ----------

  it('B-2901: createAccount over XRPC follows the sign-up policy; invite codes open a closed one', async () => {
    const body = { handle: `bob.${DOMAIN}`, email: 'bob@example.com', password: 'a long and unusual passphrase 42' };
    const closed = await x.post('com.atproto.server.createAccount', body);
    expect(closed.body.error).toBe('InvalidInviteCode');
    const inv = await sys.post('/api/admin/pds/invites', { usesMax: 1, note: 'for Bob' });
    expect(inv.status).toBe(201);
    expect(inv.body.code).toMatch(/^default-/);
    expect((await sys.get('/api/admin/pds/invites')).body.invites[0]).not.toHaveProperty('code');
    expect((await x.post('com.atproto.server.createAccount', { ...body, inviteCode: 'default-aaaaa-bbbbb-ccccc' })).body.error).toBe('InvalidInviteCode');
    const ok = await x.post('com.atproto.server.createAccount', { ...body, inviteCode: inv.body.code });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ handle: `bob.${DOMAIN}`, did: expect.stringMatching(/^did:plc:/) });
    // The Exprsn-AI account exists, with the policy's roles; its session works at once.
    const bob = await h.s.users.byUsername(h.tenantId, 'bob');
    expect(bob?.state).toBe('active');
    expect(await h.s.users.roleIds(bob!.id)).toEqual(['member']);
    expect((await x.get('com.atproto.server.getSession', {}, ok.body.accessJwt)).body.did).toBe(ok.body.did);
    // Used up.
    expect((await x.post('com.atproto.server.createAccount', { ...body, handle: `bob2.${DOMAIN}`, email: 'bob2@example.com', inviteCode: inv.body.code })).body.error).toBe('InvalidInviteCode');
    // An open policy needs no code, unless the tenant requires one.
    await h.s.identityPolicy.setSignup(h.tenantId, { mode: 'open', domains: [], requireEmailVerification: false, roles: ['member'], clearance: 'internal', workspaceId: null }, null);
    expect((await x.post('com.atproto.server.createAccount', { handle: `carol.${DOMAIN}`, email: 'carol@example.com', password: 'another long passphrase 77' })).status).toBe(200);
    await sys.patch('/api/admin/pds/settings', { inviteRequired: true }).expect(200);
    expect((await x.post('com.atproto.server.createAccount', { handle: `dave.${DOMAIN}`, email: 'dave@example.com', password: 'another long passphrase 78' })).body.error).toBe('InvalidInviteCode');
    expect((await x.get('com.atproto.server.describeServer')).body.inviteCodeRequired).toBe(true);
    await sys.patch('/api/admin/pds/settings', { inviteRequired: false }).expect(200);
    expect((await x.post('com.atproto.server.createAccount', { handle: `carol.${DOMAIN}`, email: 'carol2@example.com', password: 'another long passphrase 79' })).body.error).toBe('HandleNotAvailable');
  });

  // ---------- B-2905 ----------

  it('B-2905: deactivation by the account, then activation', async () => {
    const d = await x.post('com.atproto.server.deactivateAccount', {}, access);
    expect(d.status).toBe(200);
    expect((await x.get('com.atproto.sync.getRepo', { did: aliceDid })).body.error).toBe('RepoDeactivated');
    expect((await x.get('com.atproto.sync.getRepoStatus', { did: aliceDid })).body).toEqual({ did: aliceDid, active: false, status: 'deactivated' });
    // Sessions of a deactivated account end; signing in again works and activation brings it back.
    const s = await x.post('com.atproto.server.createSession', { identifier: aliceDid, password: appPassword });
    expect(s.body).toMatchObject({ active: false, status: 'deactivated' });
    expect((await x.post('com.atproto.repo.createRecord', { repo: aliceDid, collection: 'app.bsky.feed.post', record: { $type: 'app.bsky.feed.post', text: 'x', createdAt: new Date().toISOString() } }, s.body.accessJwt)).body.error).toBe('AccountDeactivated');
    expect((await x.post('com.atproto.server.activateAccount', undefined, s.body.accessJwt)).status).toBe(200);
    expect((await x.get('com.atproto.sync.getRepoStatus', { did: aliceDid })).body.active).toBe(true);
    access = s.body.accessJwt;
    refresh = s.body.refreshJwt;
  });

  it('B-2905: a takedown through moderation answers RepoTakendown, stops blobs and sessions, and publishes !takedown', async () => {
    // The tenant's labeler identity, so the takedown is published as a label (B-1610).
    expect((await sys.post('/api/atproto/identity', { method: 'web' })).status).toBe(201);
    const a = (await h.s.pds.accountByDid(aliceDid))!;
    const t = await sys.post(`/api/admin/pds/accounts/${a.id}/takedown`, { reason: 'Spam campaign' });
    expect(t.status).toBe(200);
    expect(t.body.account).toMatchObject({ state: 'takendown', takedownAction: t.body.action.id });
    expect(t.body.action).toMatchObject({ objectType: 'pds-repo', objectId: a.id, state: 'applied' });
    for (const nsid of ['com.atproto.sync.getRepo', 'com.atproto.sync.getLatestCommit', 'com.atproto.sync.listBlobs']) expect((await x.get(nsid, { did: aliceDid })).body.error, nsid).toBe('RepoTakendown');
    expect((await x.get('com.atproto.repo.getRecord', { repo: aliceDid, collection: 'app.bsky.actor.profile', rkey: 'self' })).body.error).toBe('RepoTakendown');
    expect((await x.get('com.atproto.sync.getBlob', { did: aliceDid, cid: (imageBlob.ref as { $link: string }).$link })).body.error).toBe('RepoTakendown');
    expect((await h.s.pds.blobs.open(a, (imageBlob.ref as { $link: string }).$link))).toBeNull();
    expect((await x.get('com.atproto.server.getSession', {}, access)).body.error).toBe('AccountTakedown');
    expect((await x.post('com.atproto.server.refreshSession', undefined, refresh)).body.error).toBe('ExpiredToken');
    expect((await x.post('com.atproto.server.createSession', { identifier: aliceDid, password: appPassword })).body.error).toBe('AccountTakedown');
    expect((await request(h.app).get('/.well-known/atproto-did').set('host', `alice.${DOMAIN}`)).status).toBe(404);
    const labels = await h.s.atproto.list(h.tenantId, { uri: aliceDid, limit: 10 });
    expect(labels.map((l) => [l.label.val, l.label.neg])).toEqual([['!takedown', false]]);
    const last = (await h.s.db('pds_events').where({ did: aliceDid }).orderBy('seq', 'desc').first())!;
    expect(last.type).toBe('account');
    expect((await sys.get(`/api/moderation/actions?type=pds-repo&id=${a.id}`)).status).toBeLessThan(500);
    // Restored through the same moderation action: readable again, the label withdrawn.
    const r = await sys.post(`/api/admin/pds/accounts/${a.id}/restore`, { reason: 'Appeal upheld on review' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ restored: true, account: { state: 'active' }, action: { state: 'reversed' } });
    expect((await x.get('com.atproto.sync.getLatestCommit', { did: aliceDid })).status).toBe(200);
    const after = await h.s.atproto.list(h.tenantId, { uri: aliceDid, limit: 10 });
    expect(after.map((l) => [l.label.val, l.label.neg])).toEqual([['!takedown', true], ['!takedown', false]]);
    const s = await x.post('com.atproto.server.createSession', { identifier: aliceDid, password: appPassword });
    access = s.body.accessJwt;
    expect(s.body.active).toBe(true);
  });

  // ---------- B-2905: migration out of h into h2 ----------

  it('B-2905: an account moves to another PDS: service token, repo, blobs, the signed PLC operation, activation', async () => {
    await sys2.put(`/api/admin/pds/tenants/${h2.tenantId}`, { enabled: true }).expect(200);
    await h2.s.identityPolicy.setSignup(h2.tenantId, { mode: 'open', domains: [], requireEmailVerification: false, roles: ['member'], clearance: 'internal', workspaceId: null }, null);
    const DOMAIN2 = 'default.pds2.example.test';
    // A privileged app password on the old PDS.
    const priv = await alice.post('/api/me/pds/app-passwords', { name: 'migration', privileged: true });
    const old = await x.post('com.atproto.server.createSession', { identifier: aliceDid, password: priv.body.password });
    const oldTok = old.body.accessJwt;
    const plainTok = access;
    const newDid = (await x2.get('com.atproto.server.describeServer')).body.did;
    expect(newDid).toBe('did:web:pds2.example.test');
    // A plain app password may not make the move token.
    expect((await x.get('com.atproto.server.getServiceAuth', { aud: newDid, lxm: 'com.atproto.server.createAccount' }, plainTok)).body.message).toMatch(/privileged/);
    const sa = await x.get('com.atproto.server.getServiceAuth', { aud: newDid, lxm: 'com.atproto.server.createAccount' }, oldTok);
    expect(sa.status).toBe(200);
    // A token for another audience, or none, is refused by the new PDS.
    const wrongAud = (await x.get('com.atproto.server.getServiceAuth', { aud: 'did:web:elsewhere.example', lxm: 'com.atproto.server.createAccount' }, oldTok)).body.token;
    const create = { handle: `alice.${DOMAIN2}`, email: 'alice@example.com', password: 'a fresh password for pds2 xx', did: aliceDid };
    expect((await x2.post('com.atproto.server.createAccount', create)).body.error).toBe('AuthMissing');
    expect((await x2.post('com.atproto.server.createAccount', create, wrongAud)).body.error).toBe('InvalidToken');
    const made = await x2.post('com.atproto.server.createAccount', create, sa.body.token);
    expect(made.status).toBe(200);
    expect(made.body.did).toBe(aliceDid);
    const newTok = made.body.accessJwt;
    expect((await x2.get('com.atproto.server.checkAccountStatus', {}, newTok)).body).toMatchObject({ activated: false, validDid: false });
    // The repo, verified on import.
    const car = await x.get('com.atproto.sync.getRepo', { did: aliceDid }).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    const tampered = Buffer.from(car.body as Buffer);
    tampered[tampered.length - 2]! ^= 1;
    expect((await x2.post('com.atproto.repo.importRepo', undefined, newTok).set('content-type', 'application/vnd.ipld.car').send(tampered)).body.error).toBe('InvalidRepo');
    expect((await x2.post('com.atproto.repo.importRepo', undefined, newTok).set('content-type', 'application/vnd.ipld.car').send(car.body as Buffer)).status).toBe(200);
    // The blobs the records use.
    const missing = (await x2.get('com.atproto.repo.listMissingBlobs', {}, newTok)).body.blobs;
    expect(missing.map((b: { cid: string }) => b.cid)).toEqual([(imageBlob.ref as { $link: string }).$link]);
    await x2.post('com.atproto.repo.uploadBlob', undefined, newTok).set('content-type', 'image/png').send(TINY_PNG).expect(200);
    expect((await x2.get('com.atproto.repo.listMissingBlobs', {}, newTok)).body.blobs).toEqual([]);
    // The DID: the new PDS says what it needs, the old one signs it with a code from the console, the new one submits it.
    const creds = (await x2.get('com.atproto.identity.getRecommendedDidCredentials', {}, newTok)).body;
    expect(creds.services.atproto_pds.endpoint).toBe('https://pds2.example.test');
    expect((await x.post('com.atproto.identity.requestPlcOperationSignature', undefined, oldTok)).status).toBe(200);
    expect((await x.post('com.atproto.identity.signPlcOperation', { token: 'WRONG-CODE', ...creds }, oldTok)).body.error).toBe('InvalidToken');
    const code = (await alice.post('/api/me/pds/plc-token')).body.token;
    const signed = await x.post('com.atproto.identity.signPlcOperation', { token: code, ...creds }, oldTok);
    expect(signed.status).toBe(200);
    expect((await x.post('com.atproto.identity.signPlcOperation', { token: code, ...creds }, oldTok)).body.error).toBe('InvalidToken');
    // Activation waits for the DID to point here.
    expect((await x2.post('com.atproto.server.activateAccount', undefined, newTok)).body.message).toMatch(/does not name this PDS/);
    expect((await x2.post('com.atproto.identity.submitPlcOperation', { operation: signed.body.operation }, newTok)).status).toBe(200);
    expect(plc.refused).toEqual([]);
    const doc = didDocument(aliceDid, plc.log.get(aliceDid)!.at(-1)!);
    expect(doc.service[0]!.serviceEndpoint).toBe('https://pds2.example.test');
    expect(doc.alsoKnownAs).toEqual([`at://alice.${DOMAIN2}`]);
    expect((await x2.post('com.atproto.server.activateAccount', undefined, newTok)).status).toBe(200);
    expect((await x.post('com.atproto.server.deactivateAccount', {}, oldTok)).status).toBe(200);
    // The new PDS serves the records, signed with its own key; the old one answers RepoDeactivated.
    expect((await x2.get('com.atproto.repo.getRecord', { repo: aliceDid, collection: 'app.bsky.actor.profile', rkey: 'self' })).body.value).toEqual({ $type: 'app.bsky.actor.profile', displayName: 'Alice' });
    const car2 = await x2.get('com.atproto.sync.getRepo', { did: aliceDid }).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    const k = parseMultikey(await plcKey(aliceDid));
    expect(verifyRepoCar(car2.body as Buffer, { did: aliceDid, key: { curve: k.curve, key: k.key } }).records.length).toBe(verifyRepoCar(car.body as Buffer).records.length);
    expect((await x.get('com.atproto.sync.getRepo', { did: aliceDid })).body.error).toBe('RepoDeactivated');
    expect((await x2.get('com.atproto.server.checkAccountStatus', {}, newTok)).body).toMatchObject({ activated: true, validDid: true, importedBlobs: 1, expectedBlobs: 1 });
    expect((await h2.s.db('pds_events').where({ did: aliceDid }).orderBy('seq')).map((e) => e.type)).toEqual(['identity', 'account', 'identity', 'account', 'sync']);
  });

  // ---------- B-3004 ----------

  it('B-3004: the feed generator record, in a hosted repo and in an external account, names the service DID', async () => {
    const bob = (await h.s.pds.accountByHandle(`bob.${DOMAIN}`))!;
    const r = await sys.post('/api/admin/pds/feed-generators', { target: { kind: 'hosted', accountId: bob.id }, serviceDid: 'did:web:feeds.example.test', rkey: 'whats-new', displayName: 'What is new', description: 'Posts from the workspace' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ target: 'hosted', repo: bob.did, serviceDid: 'did:web:feeds.example.test', uri: `at://${bob.did}/app.bsky.feed.generator/whats-new` });
    const rec = await x.get('com.atproto.repo.getRecord', { repo: bob.did, collection: 'app.bsky.feed.generator', rkey: 'whats-new' });
    expect(rec.body.value).toMatchObject({ $type: 'app.bsky.feed.generator', did: 'did:web:feeds.example.test', displayName: 'What is new' });
    // Publishing again replaces it.
    const again = await sys.post('/api/admin/pds/feed-generators', { target: { kind: 'hosted', accountId: bob.id }, serviceDid: 'did:web:feeds2.example.test', rkey: 'whats-new', displayName: 'What is new' });
    expect(again.body.id).toBe(r.body.id);
    expect((await x.get('com.atproto.repo.getRecord', { repo: bob.did, collection: 'app.bsky.feed.generator', rkey: 'whats-new' })).body.value.did).toBe('did:web:feeds2.example.test');
    expect((await sys.post('/api/admin/pds/feed-generators', { target: { kind: 'hosted', accountId: bob.id }, serviceDid: 'not a did', rkey: 'x', displayName: 'x' })).status).toBe(400);
    // External: an account on the other PDS, with an app password used once.
    await localUser(h2, 'erin', ['member']);
    const erin = api(await login(h2, 'erin'));
    const ea = await erin.post('/api/me/pds', { handle: 'erin' });
    expect(ea.status).toBe(201);
    const epw = (await erin.post('/api/me/pds/app-passwords', { name: 'feeds' })).body.password;
    const pdsUrl = `http://127.0.0.1:${(loopbackServerFor(h2.app)!.address() as AddressInfo).port}`;
    const ext = await sys.post('/api/admin/pds/feed-generators', { target: { kind: 'external', identifier: ea.body.did, appPassword: epw, pdsUrl }, serviceDid: 'did:web:feeds.example.test', rkey: 'tenant-feed', displayName: 'Tenant feed' });
    expect(ext.status).toBe(201);
    expect(ext.body).toMatchObject({ target: 'external', repo: ea.body.did, serviceDid: 'did:web:feeds.example.test' });
    expect((await x2.get('com.atproto.repo.getRecord', { repo: ea.body.did, collection: 'app.bsky.feed.generator', rkey: 'tenant-feed' })).body.value.did).toBe('did:web:feeds.example.test');
    expect((await sys.post('/api/admin/pds/feed-generators', { target: { kind: 'external', identifier: ea.body.did, appPassword: 'aaaa-bbbb-cccc-dddd', pdsUrl }, serviceDid: 'did:web:feeds.example.test', rkey: 'nope', displayName: 'x' })).status).toBe(400);
    expect((await sys.get('/api/admin/pds/feed-generators')).body.records).toHaveLength(2);
    // Withdrawn: the hosted record is deleted from the repo.
    await sys.post(`/api/admin/pds/feed-generators/${r.body.id}/withdraw`).expect(204);
    expect((await x.get('com.atproto.repo.getRecord', { repo: bob.did, collection: 'app.bsky.feed.generator', rkey: 'whats-new' })).body.error).toBe('RecordNotFound');
  });

  it('lists accounts for the tenant admin, and the audit names every change without content', async () => {
    const list = (await sys.get('/api/admin/pds/accounts')).body.accounts;
    expect(list.map((a: { handle: string }) => a.handle).sort()).toEqual([`alice.${DOMAIN}`, `bob.${DOMAIN}`, `carol.${DOMAIN}`]);
    const actions = new Set((await h.s.db('audit_events').where('action', 'like', 'pds.%')).map((e: { action: string }) => e.action));
    for (const a of ['pds.hosting.enabled', 'pds.account.created', 'pds.app_password.created', 'pds.session.created', 'pds.repo.committed', 'pds.blob.stored', 'pds.blob.rejected', 'pds.account.deactivated', 'pds.account.activated', 'pds.account.takendown', 'pds.account.restored', 'pds.invite.created', 'pds.service_auth.issued', 'pds.plc.signed', 'pds.feed.published', 'pds.feed.withdrawn']) expect(actions, a).toContain(a);
    const committed = await h.s.db('audit_events').where({ action: 'pds.repo.committed' }).first();
    expect(JSON.stringify(committed)).not.toMatch(/Hello from Exprsn-AI/);
  });
});
