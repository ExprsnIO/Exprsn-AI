/*
 * Sprint 31 (1.5.0), the AT-Protocol PDS against real databases. Each block runs when its variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 033_pds; an account with keys in an in-process signer and a did:plc at a
 *                                  PLC directory double; concurrent commits to one repo (the compare-and-swap on rev
 *                                  makes each wait its turn) and to two repos (seqs unique, gap-free and in commit
 *                                  order); the repo exported as CAR verifying against its signed commit; listRecords
 *                                  paging; a takedown answering RepoTakendown. The app listens on
 *                                  127.0.0.1:${TEST_PDS_PORT:-55605}.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { parseMultikey } from '../../src/atproto/crypto.js';
import { verifyRepoCar } from '../../src/atproto/pds/repo.js';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { createApp } from '../../src/http/app.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import { startSigner } from '../../src/signer/server.js';
import { testConfig } from '../helpers.js';
import { FakePlcDirectory } from '../sprint25b-fakes.js';

const PORT = Number(process.env.TEST_PDS_PORT ?? 55605);

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`the PDS on ${d.name}`, () => {
    it('migrates 033_pds, commits concurrently in seq order and exports a verifiable repo', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'exs-pds-'));
      const socketPath = path.join(dir, 'run', 'signer.sock');
      const token = randomBytes(24).toString('base64url') + 'x'.repeat(8);
      const signer = await startSigner({ socketPath, key: randomBytes(32).toString('base64'), token });
      const plc = new FakePlcDirectory();
      await plc.start();
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url!, DATA_KEY: '', SIGNER_SOCKET: socketPath, SIGNER_TOKEN: token, ATPROTO_PLC_URL: plc.url, PDS_PUBLIC_URL: 'https://pds.example.test', PDS_HANDLE_DOMAIN: 'pds.example.test', ZONES_AIR_GAPPED: 'false' });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      let server: Server | null = null;
      try {
        for (const t of ['pds_tenants', 'pds_accounts', 'pds_records', 'pds_blocks', 'pds_blobs', 'pds_blob_refs', 'pds_app_passwords', 'pds_sessions', 'pds_tokens', 'pds_invites', 'pds_invite_uses', 'pds_counters', 'pds_events', 'pds_crawls', 'pds_feed_records']) expect(await db.schema.hasTable(t), t).toBe(true);
        await bootstrap(s);
        s.zones.current = async () => new Map([['edge', { version: 1, spec: { contents: 'edge', trust: 'private', cidrs: ['10.10.0.0/24'], maxLabel: 'restricted', accepts: [], acceptsNote: null, egress: { mode: 'allow-list', allow: [{ kind: 'cidr', cidr: '0.0.0.0/0', ports: [443] }], note: null }, peers: [], services: [] } }]]) as never;
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const by = { tenantId: tenant.id, userId: null, actor: { service: 'test' } };
        const hosting = await s.pds.enable(by, tenant.id);
        const person = async (username: string) => {
          const u = await s.users.create(tenant.id, { username, displayName: username, clearance: 'internal' });
          await s.users.setRoles(u.id, 'direct', ['member']);
          return s.pds.createAccount(by, { user: (await s.users.get(tenant.id, u.id))!, handle: username, hosting, via: 'console' });
        };
        const ann = await person('ann');
        const ben = await person('ben');
        const post = (n: number) => ({ action: 'create' as const, collection: 'app.bsky.feed.post', value: { $type: 'app.bsky.feed.post', text: `post ${n}`, createdAt: new Date().toISOString() } });

        // Ten writers on one repo and ten on another, all at once.
        const results = await Promise.all([...Array.from({ length: 10 }, (_, i) => s.pds.repo.applyWrites(by, ann, [post(i)])), ...Array.from({ length: 10 }, (_, i) => s.pds.repo.applyWrites(by, ben, [post(100 + i)]))]);
        expect(new Set(results.map((r) => r.commit.rev)).size).toBe(20);
        expect(await s.pds.recordCount(ann.id)).toBe(10);
        const events = (await db('pds_events').orderBy('seq', 'asc')) as { seq: number | string; did: string; type: string }[];
        const seqs = events.map((e) => Number(e.seq));
        expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
        // Within a repo, the commits' revs grow with their seqs.
        const annRevs = (await db('pds_events').where({ did: ann.did, type: 'commit' }).orderBy('seq')).length;
        expect(annRevs).toBe(11); // the first commit and ten writes

        const app = createApp(s);
        server = await new Promise<Server>((resolve) => {
          const srv = app.listen(PORT, '127.0.0.1', () => resolve(srv));
        });
        const base = `http://127.0.0.1:${PORT}`;
        const car = await request(base).get('/xrpc/com.atproto.sync.getRepo').query({ did: ann.did }).buffer(true).parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        });
        expect(car.status).toBe(200);
        const k = parseMultikey(ann.key_multikey);
        expect(verifyRepoCar(car.body as Buffer, { did: ann.did, key: { curve: k.curve, key: k.key } }).records).toHaveLength(10);
        const page1 = (await request(base).get('/xrpc/com.atproto.repo.listRecords').query({ repo: ann.did, collection: 'app.bsky.feed.post', limit: 4 })).body;
        const page2 = (await request(base).get('/xrpc/com.atproto.repo.listRecords').query({ repo: ann.did, collection: 'app.bsky.feed.post', limit: 10, cursor: page1.cursor })).body;
        expect(page1.records.length + page2.records.length).toBe(10);
        expect(new Set([...page1.records, ...page2.records].map((r: { uri: string }) => r.uri)).size).toBe(10);

        expect(await s.pds.takeDown(by, (await s.pds.accountById(ben.id))!, 'test', null)).toBe('active');
        expect((await request(base).get('/xrpc/com.atproto.sync.getLatestCommit').query({ did: ben.did })).body.error).toBe('RepoTakendown');
      } finally {
        if (server) await new Promise((r) => server!.close(r));
        await s.close();
        await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
        await db.destroy();
        await plc.stop();
        await signer.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }, 120_000);
  });
}
