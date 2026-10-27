/*
 * Sprint 25 (B-1608 to B-1611): AT-Protocol trust on PostgreSQL and MySQL. Two instances share one signer and one
 * database: labels emitted at the same time on both get unique, gap-free sequence numbers and all verify against the
 * DID document; prefix queries match case-sensitively whatever the collation; inbound labels are stored once, and a
 * bad signature is dropped and audited.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMultikey, verifySignature } from '../../src/atproto/crypto.js';
import { labelSigningBytes } from '../../src/atproto/labels.js';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import { startSigner } from '../../src/signer/server.js';
import { testConfig } from '../helpers.js';
import { FakeLabeler, FakePlcDirectory, testKey } from '../sprint25b-fakes.js';

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`AT-Protocol trust on ${d.name}`, () => {
    it('numbers labels from two instances without gaps, queries by prefix exactly, and ingests labels once', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'exs-'));
      const token = randomBytes(24).toString('base64url') + 'x'.repeat(8);
      const signer = await startSigner({ socketPath: path.join(dir, 'run', 'signer.sock'), key: randomBytes(32).toString('base64'), token });
      const plc = new FakePlcDirectory();
      await plc.start();
      const ext = new FakeLabeler(plc);
      await ext.start();
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url!, DATA_KEY: '', SIGNER_SOCKET: signer.socketPath, SIGNER_TOKEN: token, ATPROTO_PUBLIC_URL: 'https://labels.example.test', ATPROTO_PLC_URL: plc.url });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const one = createServices(cfg, db, createLogger('silent', false), new Metrics());
      const two = createServices(cfg, db, createLogger('silent', false), new Metrics());
      try {
        await bootstrap(one);
        const tenant = (await one.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const by = { tenantId: tenant.id, userId: null, actor: { service: 'test' } };
        const identity = await one.atproto.createIdentity(by, tenant.id, { method: 'plc' });
        expect(plc.log.get(identity.did)).toHaveLength(1);

        // Two at a time, one on each instance, racing for the next seq (the audit chain's own retries cap how many
        // appends can race at once).
        for (let i = 0; i < 12; i += 2) {
          await Promise.all([i, i + 1].map((n) => (n % 2 ? one : two).atproto.emit(by, tenant.id, { uri: `at://did:plc:case/app.bsky.feed.post/${n % 2 ? 'A' : 'a'}${n}`, vals: ['!warn'] })));
        }
        const rows = await two.atproto.labelsAfter(identity.id, 0, 100);
        expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
        const doc = (await (await fetch(`${plc.url}/${identity.did}`)).json()) as { verificationMethod: { publicKeyMultibase: string }[] };
        const { curve, key } = parseMultikey(doc.verificationMethod[0]!.publicKeyMultibase);
        for (const r of rows) expect(verifySignature(curve, key, labelSigningBytes(r.label), r.label.sig!)).toBe(true);
        // MySQL's default collation and SQLite fold case in LIKE; the prefix match does not.
        const q = await one.atproto.query(identity, { uriPatterns: ['at://did:plc:case/app.bsky.feed.post/A*'], limit: 50 });
        expect(q.labels.map((r) => r.label.uri).filter((u) => !u.includes('.post/A'))).toEqual([]);
        expect(q.labels).toHaveLength(6);

        // Rotating the label key: labels are re-signed when next served and verify against the new document.
        await two.atproto.rotateKey(by, (await two.atproto.identity(tenant.id))!, 'label');
        const doc2 = (await (await fetch(`${plc.url}/${identity.did}`)).json()) as { verificationMethod: { publicKeyMultibase: string }[] };
        const k2 = parseMultikey(doc2.verificationMethod[0]!.publicKeyMultibase);
        for (const r of await one.atproto.labelsAfter(identity.id, 0, 100)) expect(verifySignature(k2.curve, k2.key, labelSigningBytes(r.label), r.label.sig!)).toBe(true);

        // Inbound: a good label and a forged one, received twice.
        const labeler = await one.atproto.addLabeler(by, tenant.id, { did: ext.did, name: 'External', vals: ['!hide'] });
        const raws = [ext.label('at://did:plc:victim/app.bsky.feed.post/1', '!hide'), ext.label('at://did:plc:victim/app.bsky.feed.post/2', '!hide', { signWith: testKey() })];
        const first = await one.atproto.ingest(by, labeler, 1, raws);
        const again = await two.atproto.ingest(by, (await two.atproto.labeler(tenant.id, labeler.id))!, 1, raws);
        expect(first).toMatchObject({ accepted: 1, rejected: 1 });
        expect(first.flags).toHaveLength(1);
        expect(again).toMatchObject({ accepted: 0, rejected: 1, flags: [] });
        expect((await one.atproto.inbound(tenant.id, labeler.id)).length).toBe(1);
        expect((await db('audit_events').where({ action: 'atproto.label.rejected' })).length).toBe(2);
      } finally {
        await one.close();
        await two.close();
        await db.destroy();
        await ext.stop();
        await plc.stop();
        await signer.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }, 120_000);
  });
}
