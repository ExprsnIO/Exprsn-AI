/**
 * B-2906: interoperability of Exprsn-AI's PDS with the reference AT-Protocol development environment
 * (`@atproto/dev-env`: the reference PLC directory, and the Bluesky AppView with its data plane on PostgreSQL).
 *
 *   INTEROP_PG_URL=postgres://... npx tsx interop/run.ts [--base-port 55601]
 *
 * It runs, in this process: the reference PLC directory; Exprsn-AI (the real services and routes on SQLite, with an
 * in-process signer holding the account keys) hosting a tenant's PDS, with its DIDs registered at that PLC; and the
 * reference AppView, whose firehose consumer subscribes to Exprsn-AI's `com.atproto.sync.subscribeRepos` as it would
 * to a relay (in the dev environment the AppView reads a PDS directly; it verifies each commit's signature against the
 * DID document and its sync 1.1 proofs). Then it creates an account over XRPC, writes a profile and a post, and waits
 * until the AppView serves them: the done-when "a post written to Exprsn-AI's PDS appears in the reference AppView".
 * It also verifies the exported repo with the reference implementation (`@atproto/repo` verifyRepoCar).
 *
 * Ports: base (Exprsn-AI), base+1 (PLC), base+2 (AppView), base+3 (its data plane). Exit 0 on success.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import * as bsky from '@atproto/bsky';
import { Secp256k1Keypair } from '@atproto/crypto';
import { verifyRepoCar } from '@atproto/repo';
import { TestPlc } from '@atproto/dev-env';
import { Client as PlcClient } from '@did-plc/lib';
import { loadConfig } from '../server/src/config/index.js';
import { createDb, migrate } from '../server/src/db/knex.js';
import { createApp } from '../server/src/http/app.js';
import { createLogger, Metrics } from '../server/src/observability/index.js';
import { createServices } from '../server/src/services.js';
import { bootstrap } from '../server/src/bootstrap.js';
import { attachRepoStream } from '../server/src/atproto/pds/sequencer.js';
import { PdsMigration } from '../server/src/atproto/pds/migration.js';
import type { DidDocument } from '../server/src/atproto/did.js';
import { startSigner } from '../server/src/signer/server.js';

const { values: opt } = parseArgs({ options: { 'base-port': { type: 'string', default: process.env.INTEROP_BASE_PORT ?? '55601' }, timeout: { type: 'string', default: '90' } } });
const base = Number(opt['base-port']);
const pg = process.env.INTEROP_PG_URL;
if (!pg) throw new Error('Set INTEROP_PG_URL to a PostgreSQL database the AppView may use (a schema is created in it).');

const log = (...a: unknown[]) => console.log('[interop]', ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function xrpc(baseUrl: string, nsid: string, o: { body?: unknown; token?: string; query?: Record<string, string> } = {}) {
  const url = new URL(`/xrpc/${nsid}`, baseUrl);
  for (const [k, v] of Object.entries(o.query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, { method: o.body === undefined ? 'GET' : 'POST', headers: { ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) }, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}), signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json: json as Record<string, unknown>, bytes: Buffer.from(text, 'latin1') };
}

async function main() {
  const dir = mkdtempSync(path.join(tmpdir(), 'exprsn-interop-'));
  mkdirSync(path.join(dir, 'blobs'));
  const closers: (() => Promise<unknown>)[] = [];
  try {
    // ---- the reference PLC directory ----
    const plc = await TestPlc.create({ port: base + 1 });
    closers.push(() => plc.close());
    log('PLC directory', plc.url);

    // ---- Exprsn-AI, hosting a tenant's PDS ----
    const socketPath = path.join(dir, 'run', 'signer.sock');
    const token = randomBytes(24).toString('base64url') + 'x'.repeat(8);
    const signer = await startSigner({ socketPath, key: randomBytes(32).toString('base64'), token });
    closers.push(() => signer.close());
    const pdsUrl = `http://localhost:${base}`;
    const cfg = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: process.env.INTEROP_LOG_LEVEL ?? 'warn',
      DB_CLIENT: 'sqlite',
      SQLITE_FILENAME: path.join(dir, 'exprsn.sqlite'),
      SESSION_SECRET: randomBytes(32).toString('hex'),
      PUBLIC_URL: pdsUrl,
      WEB_ROOT: '/nonexistent',
      BLOB_DIR: path.join(dir, 'blobs'),
      JOB_QUEUE: 'db',
      SIGNER_SOCKET: socketPath,
      SIGNER_TOKEN: token,
      ATPROTO_PLC_URL: plc.url,
      PDS_PUBLIC_URL: pdsUrl,
      PDS_HANDLE_DOMAIN: 'pds.test',
      ZONES_AIR_GAPPED: 'false'
    } as NodeJS.ProcessEnv);
    const db = createDb(cfg);
    await migrate(db);
    const s = createServices(cfg, db, createLogger(cfg.LOG_LEVEL, false), new Metrics());
    await bootstrap(s);
    // The PDS zone must have egress: here it is this machine, so the default zone set is given an open edge.
    s.zones.current = async () => new Map([['edge', { version: 1, spec: { contents: 'interop', trust: 'private', cidrs: ['10.10.0.0/24'], maxLabel: 'restricted', accepts: [], acceptsNote: null, egress: { mode: 'allow-list', allow: [{ kind: 'cidr', cidr: '0.0.0.0/0', ports: [] }], note: null }, peers: [], services: [] } }]]) as never;
    s.jobs.start();
    const server: Server = createServer(createApp(s));
    const stream = attachRepoStream(server, s);
    await new Promise<void>((r) => server.listen(base, '127.0.0.1', r));
    closers.push(async () => {
      await stream.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await s.close();
      await db.destroy();
    });
    const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
    await s.pds.enable({ tenantId: tenant.id, userId: null, actor: { service: 'interop' } }, tenant.id);
    await s.identityPolicy.setSignup(tenant.id, { mode: 'open', domains: [], requireEmailVerification: false, roles: ['member'], clearance: 'internal', workspaceId: null }, null);
    log('Exprsn-AI PDS', pdsUrl, s.pds.serviceDid());

    // ---- the reference AppView, reading Exprsn-AI's firehose ----
    const kp = await Secp256k1Keypair.create();
    const avPort = base + 2;
    const avUrl = `http://localhost:${avPort}`;
    const serverDid = await new PlcClient(plc.url).createDid({ signingKey: kp.did(), rotationKeys: [kp.did()], handle: 'bsky.test', pds: avUrl, signer: kp });
    const schema = `interop_${randomBytes(6).toString("hex").replace(/[0-9]/g, (d) => "abcdefghij"[Number(d)]!)}`;
    const avDb = new bsky.Database({ url: pg, schema, poolSize: 10 });
    const migDb = new bsky.Database({ url: pg, schema });
    await migDb.migrateToLatestOrThrow();
    await migDb.close();
    const dataplane = await bsky.DataPlaneServer.create(avDb, base + 3, plc.url, globalThis.fetch);
    const config = new bsky.ServerConfig({
      version: 'interop',
      port: avPort,
      didPlcUrl: plc.url,
      publicUrl: avUrl,
      serverDid,
      alternateAudienceDids: [],
      dataplaneUrls: [`http://localhost:${base + 3}`],
      dataplaneHttpVersion: '1.1',
      bsyncHttpVersion: '1.1',
      modServiceDid: 'did:example:invalidMod',
      labelsFromIssuerDids: [],
      bigThreadUris: new Set(),
      maxThreadParents: 50,
      disableSsrfProtection: true,
      searchTagsHide: new Set(),
      searchTagsHideAll: new Set(),
      threadTagsBumpDown: new Set(),
      threadTagsHide: new Set(),
      visibilityTagHide: '',
      visibilityTagRankPrefix: '',
      debugFieldAllowedDids: new Set(),
      draftsLimit: 500,
      feedGenSkeletonTimeout: 5000,
      adminPasswords: ['interop-admin'],
      etcdHosts: []
    } as never);
    const appview = bsky.BskyAppView.create({ config, signingKey: kp });
    const sub = new bsky.RepoSubscription({ service: `ws://localhost:${base}`, db: avDb, idResolver: dataplane.idResolver });
    await appview.start();
    void sub.start();
    closers.push(async () => {
      await sub.destroy();
      await appview.destroy();
      await dataplane.destroy();
      await avDb.close();
    });
    log('reference AppView', avUrl);

    // ---- an account, a profile and a post on Exprsn-AI ----
    const created = await xrpc(pdsUrl, 'com.atproto.server.createAccount', { body: { handle: 'alice.default.pds.test', email: 'alice@example.com', password: 'interop passphrase long enough 1' } });
    if (created.status !== 200) throw new Error(`createAccount: ${created.status} ${JSON.stringify(created.json)}`);
    const did = String(created.json.did);
    const access = String(created.json.accessJwt);
    log('account', did);
    const profile = await xrpc(pdsUrl, 'com.atproto.repo.putRecord', { token: access, body: { repo: did, collection: 'app.bsky.actor.profile', rkey: 'self', record: { $type: 'app.bsky.actor.profile', displayName: 'Alice on Exprsn-AI' } } });
    if (profile.status !== 200) throw new Error(`putRecord: ${JSON.stringify(profile.json)}`);
    const text = `Hello from Exprsn-AI's PDS ${new Date().toISOString()}`;
    const post = await xrpc(pdsUrl, 'com.atproto.repo.createRecord', { token: access, body: { repo: did, collection: 'app.bsky.feed.post', record: { $type: 'app.bsky.feed.post', text, createdAt: new Date().toISOString() } } });
    if (post.status !== 200) throw new Error(`createRecord: ${JSON.stringify(post.json)}`);
    const uri = String(post.json.uri);
    log('post', uri);

    // ---- the reference implementation verifies the exported repo ----
    log('checking the exported repo with @atproto/repo');
    const doc = (await (await fetch(`${plc.url}/${did}`, { signal: AbortSignal.timeout(15_000) })).json()) as DidDocument;
    // The reference PLC directory renders keys in the legacy form; Exprsn-AI reads both (as its migration does).
    const key = `did:key:${PdsMigration.signingKeyOf(doc)}`;
    const car = new Uint8Array(await (await fetch(`${pdsUrl}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(did)}`, { signal: AbortSignal.timeout(15_000) })).arrayBuffer());
    log('repo exported:', car.length, 'bytes');
    const verified = await verifyRepoCar(car, did, key);
    const keys = verified.creates.map((c) => `${c.collection}/${c.rkey}`);
    if (!keys.includes('app.bsky.actor.profile/self') || !keys.some((k) => uri.endsWith(k))) throw new Error(`verifyRepoCar did not see the records: ${keys.join(', ')}`);
    log('@atproto/repo verifyRepoCar: ok,', keys.length, 'records');

    // ---- the AppView serves the post ----
    const deadline = Date.now() + Number(opt.timeout) * 1000;
    for (;;) {
      const r = await xrpc(avUrl, 'app.bsky.feed.getPosts', { query: { uris: uri } }).catch((err: unknown) => ({ status: 0, json: { error: (err as Error).message } as Record<string, unknown>, bytes: Buffer.alloc(0) }));
      const posts = (r.json?.posts ?? []) as { uri: string; record: { text: string }; author: { did: string } }[];
      if (posts.length === 1 && posts[0]!.record.text === text && posts[0]!.author.did === did) {
        log('AppView app.bsky.feed.getPosts: the post is there');
        break;
      }
      if (Date.now() > deadline) throw new Error(`The AppView did not index the post within ${opt.timeout}s (last answer ${r.status} ${JSON.stringify(r.json).slice(0, 300)})`);
      await sleep(500);
    }
    const prof = await xrpc(avUrl, 'app.bsky.actor.getProfile', { query: { actor: did } });
    if (prof.json?.displayName !== 'Alice on Exprsn-AI') throw new Error(`getProfile: ${JSON.stringify(prof.json).slice(0, 300)}`);
    log('AppView app.bsky.actor.getProfile: ok');
    log('PASS');
  } finally {
    for (const c of closers.reverse()) await c().catch((err: unknown) => console.warn('[interop] close failed', err));
    rmSync(dir, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error('[interop] FAIL', err);
    process.exit(1);
  }
);
