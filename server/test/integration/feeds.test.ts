/*
 * Sprint 31b (1.5.0), feed generators and the RSVP race, against real databases. Each block runs when its variable
 * is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 033b_feeds; fifty concurrent RSVPs for one place, from two instances
 *                                  with their own connection pools, leave one attendee (B-3603: the event row lock);
 *                                  a feed index paged by cursor from both instances while posts keep arriving, with
 *                                  no repeats (B-3003), including ranked rows with equal scores; duplicates ignored by
 *                                  the unique key; deletes; retention and size pruning
 */
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { loadPrincipal } from '../../src/http/middleware.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import { testConfig } from '../helpers.js';

const POST = 'app.bsky.feed.post';
const ALICE = 'did:plc:aliceaaaaaaaaaaaaaaaaaaa';
const uri = (rkey: string) => `at://${ALICE}/${POST}/${rkey}`;

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`feed generators and RSVPs on ${d.name}`, () => {
    it('migrates 033b_feeds; fifty concurrent RSVPs for one place leave one attendee; feed pages never repeat', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url!, DB_POOL_MAX: '30' });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      // a second instance: its own pool, the same database
      const db2 = createDb(cfg);
      const s2 = createServices(cfg, db2, createLogger('silent', false), new Metrics());
      try {
        expect(await db.schema.hasTable('atproto_feeds')).toBe(true);
        expect(await db.schema.hasTable('atproto_feed_items')).toBe(true);
        expect(await db.schema.hasColumn('firehose_subscriptions', 'rejected')).toBe(true);
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;

        // ---------- B-3603 ----------
        const ws = await s.tenants.createWorkspace(tenant.id, 'Venue', 'internal');
        const person = async (username: string) => {
          const u = await s.users.create(tenant.id, { username, displayName: username, clearance: 'internal' });
          await s.users.update(tenant.id, u.id, { clearance_direct: 'internal' });
          await s.users.setRoles(u.id, 'direct', ['member']);
          await s.tenants.addMember(ws.id, u.id);
          const p = (await loadPrincipal(s, tenant.id, u.id, {}))!;
          p.workspaceId = ws.id;
          return { p, ip: null };
        };
        const owner = await person('host');
        const g = await s.groups.create(owner, { workspaceId: ws.id, name: 'Open mic', visibility: 'public', joinMode: 'open' });
        for (const capacity of [1, 3]) {
          const ev = await s.calendar.create(owner, g.id, { title: `Seats: ${capacity}`, start: new Date(Date.now() + 3_600_000).toISOString(), timeZone: 'UTC', capacity });
          const people = [];
          for (let i = 0; i < 50; i++) people.push(await person(`fan${capacity}x${i}`));
          const results = await Promise.allSettled(people.map((ctx, i) => (i % 2 ? s2 : s).calendar.rsvp(ctx, ev.id, { response: 'going' })));
          expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(capacity);
          expect(new Set(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason.status))).toEqual(new Set([409]));
          expect(await db('group_event_rsvps').where({ event_id: ev.id, response: 'going' })).toHaveLength(capacity);
        }

        // ---------- B-3003 ----------
        const now = Date.now();
        const feed = { tenant_id: tenant.id, display_name: 'F', description: null, subscription_id: null, rules: JSON.stringify({ authors: [ALICE] }), retention_hours: 24, max_items: 1000, rate_per_minute: 1000, auth: 'optional', state: 'active', rev: 1, indexed: 0, served: 0, rank_failed: 0, created_at: now, updated_at: now };
        await db('atproto_feeds').insert([
          { ...feed, id: '01JFEED0000000000000000000', rkey: 'newest', ranking: null },
          { ...feed, id: '01JFEED0000000000000000001', rkey: 'ranked', ranking: JSON.stringify({ kind: 'classifier', classifier: 'pii', label: 'email' }) }
        ]);
        const gens = [s.feedGenerators, s2.feedGenerators];
        const sub = { id: 'SUB', tenant_id: tenant.id, label: 'public' as const };
        const post = (k: string, text = `post ${k}`) => ({ uri: uri(k), cid: null, text, did: ALICE, collection: POST });
        for (let i = 0; i < 25; i++) await gens[i % 2]!.ingest(sub, post(`p${String(i).padStart(2, '0')}`, i % 5 ? `post ${i}` : `mail p${i}@example.org`), { action: 'allow', labels: [] });
        // The same post again (a replay): the unique key keeps one row per feed.
        expect(await s.feedGenerators.ingest(sub, post('p00'), { action: 'allow', labels: [] })).toBe(0);
        for (const rkey of ['newest', 'ranked']) {
          const row = (await s.feedGenerators.byRkey(tenant.id, rkey))!;
          const seen: string[] = [];
          let cursor: string | undefined;
          let n = 0;
          do {
            const page = await gens[n % 2]!.skeleton(row, { limit: 4, cursor: cursor ?? null });
            seen.push(...page.feed.map((x) => x.post));
            cursor = page.cursor;
            // Posts keep arriving between pages; they sort before the cursor and do not disturb it.
            if (n === 1) await s2.feedGenerators.ingest(sub, post(`late${rkey}`), { action: 'allow', labels: [] });
            n++;
          } while (cursor);
          expect(new Set(seen).size, rkey).toBe(seen.length);
          expect(seen.filter((x) => !x.includes('late')), rkey).toHaveLength(25);
          if (rkey === 'newest') expect(seen.slice(0, 3)).toEqual([uri('p24'), uri('p23'), uri('p22')]);
          // Ranked: the five posts with an address first (score 1), then the rest (score 0, newest first by id).
          else expect(seen.slice(0, 5).sort()).toEqual([uri('p00'), uri('p05'), uri('p10'), uri('p15'), uri('p20')]);
        }
        // A deleted post leaves every feed; retention and size pruning.
        await s.feedGenerators.forget(tenant.id, uri('p24'));
        expect(await db('atproto_feed_items').where({ uri_hash: (await db('atproto_feed_items').where({ uri: uri('p23') }).first()).uri_hash })).toHaveLength(2);
        expect(await db('atproto_feed_items').where({ uri: uri('p24') })).toHaveLength(0);
        await db('atproto_feed_items').where({ feed_id: '01JFEED0000000000000000000' }).whereIn('uri', [uri('p00'), uri('p01')]).update({ created_at: now - 48 * 3_600_000 });
        await db('atproto_feeds').where({ id: '01JFEED0000000000000000001' }).update({ max_items: 10 });
        // Each feed holds the 25 posts and both late ones, less the deleted one: 26.
        const pruned = await s2.feedGenerators.prune(tenant.id);
        expect(pruned.removed).toBe(2 + 16);
        expect(await db('atproto_feed_items').where({ feed_id: '01JFEED0000000000000000000' })).toHaveLength(24);
        expect(await db('atproto_feed_items').where({ feed_id: '01JFEED0000000000000000001' })).toHaveLength(10);
      } finally {
        await s2.close();
        await db2.destroy();
        await s.close();
        await db.destroy();
      }
    }, 120_000);
  });
}
