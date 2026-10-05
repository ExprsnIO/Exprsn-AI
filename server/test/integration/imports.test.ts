/*
 * Sprint 30 (1.5.0), import repositories and model import, against real databases. Each block runs when its variable
 * is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 032b_imports; a CKAN repository proposed, refused to its proposer,
 *                                  confirmed by a second admin and harvested; every facet count equal to the rows its
 *                                  filter returns (the disjunctive counts, `like … escape`, grouped counts that come
 *                                  back as strings); a safetensors import from a hub resumed after a cut download,
 *                                  converted and registered as a draft with the worker's digest; a licence exception
 *                                  refused to its requester and granted by legal review; the quota sums
 */
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { createApp } from '../../src/http/app.js';
import { loadPrincipal } from '../../src/http/middleware.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import { testConfig } from '../helpers.js';
import { FakeConverter, startFakeCkan, startFakeHub } from '../sprint30-imports-fakes.js';

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`imports on ${d.name}`, () => {
    it('migrates 032b_imports and runs repositories, facets and a model import', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url!, IMPORT_ALLOWED_HOSTS: '127.0.0.1', IMPORT_PART_BYTES: '1024', IMPORT_HARVEST_TICK_MINUTES: '0', IMPORT_BUNDLE_POLL_MINUTES: '0' });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const conv = new FakeConverter();
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics(), { trainer: conv });
      conv.useApp(createApp(s));
      const [ckan, hub] = await Promise.all([startFakeCkan(), startFakeHub()]);
      try {
        for (const t of ['import_repositories', 'import_catalog', 'import_catalog_facets', 'import_jobs', 'import_exceptions', 'import_gates', 'import_quotas', 'import_settings']) expect(await db.schema.hasTable(t)).toBe(true);
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const person = async (username: string, roles: string[]) => {
          const u = await s.users.create(tenant.id, { username, displayName: username.toUpperCase(), clearance: 'restricted' });
          await s.users.update(tenant.id, u.id, { clearance_direct: 'restricted' });
          await s.users.setRoles(u.id, 'direct', roles);
          return (await loadPrincipal(s, tenant.id, u.id, {}))!;
        };
        const ann = { ...(await person('ann', ['model-admin'])), mfa: true };
        const bo = { ...(await person('bo', ['model-admin'])), mfa: true };
        const lee = { ...(await person('lee', ['legal-review'])), mfa: true };

        const repo = await s.imports.repositories.propose(ann, { name: 'CKAN', type: 'ckan', baseUrl: ckan.url, region: 'US' });
        await expect(s.imports.repositories.confirm(ann, repo.id, null)).rejects.toMatchObject({ status: 403 });
        await s.imports.repositories.confirm(bo, repo.id, null);
        await s.jobs.runDue(20);
        const r = await s.imports.repositories.get(tenant.id, repo.id);
        expect(r).toMatchObject({ state: 'active', status: 'reachable', snapshot_items: 5 });
        const q = { kind: 'dataset' as const, q: '', facets: {}, limit: 50, offset: 0, live: 'off' as const };
        const all = await s.imports.catalog.browse(r, q);
        expect(all.total).toBe(5);
        let checked = 0;
        for (const f of all.facets) {
          for (const v of f.values) {
            const got = await s.imports.catalog.browse(r, { ...q, facets: { [f.key]: v.value } });
            expect(got.total, `${f.key}=${v.value}`).toBe(v.count);
            expect(typeof v.count).toBe('number');
            checked++;
          }
        }
        expect(checked).toBeGreaterThan(10);
        expect((await s.imports.catalog.browse(r, { ...q, q: '100%_' })).total).toBe(0);
        expect((await s.imports.catalog.browse(r, { ...q, q: 'bank' })).items.map((i) => i.itemId)).toEqual(['failed-banks']);

        const hubRepo = await s.imports.repositories.propose(ann, { name: 'Hub', type: 'hf', baseUrl: hub.url, region: 'Global', extraHosts: [] });
        await s.imports.repositories.confirm(bo, hubRepo.id, null);
        await s.jobs.runDue(20);
        hub.cut.after = 1500;
        const imp = await s.imports.request(ann, { repositoryId: hubRepo.id, item: 'acme/tiny-safetensors', label: 'internal' });
        expect(imp.ref).toMatch(/^IMP-\d{4}-1$/);
        await s.jobs.runDue(20);
        expect((await s.imports.row(tenant.id, imp.id))!.state).toBe('failed');
        await s.imports.retry(ann, imp.id);
        await s.jobs.runDue(20);
        const done = (await s.imports.row(tenant.id, imp.id))!;
        expect(done.state, done.error ?? '').toBe('complete');
        expect(hub.downloads.filter((x) => x.file === 'model.safetensors').map((x) => x.range)).toEqual([null, 'bytes=1500-']);
        const model = (await s.gateway.repo.model(done.model_id!))!;
        expect(model).toMatchObject({ state: 'draft', expected_digest: conv.digests[0] });

        const nc = await s.imports.request(ann, { repositoryId: hubRepo.id, item: 'acme/nc-model', label: 'internal', exception: { reason: 'research' } });
        expect(nc.state).toBe('waiting on licence');
        const [exc] = await s.imports.exceptions(lee, 'pending');
        await expect(s.imports.decide({ ...ann, roles: [...ann.roles, 'legal-review'] }, exc!.id, 'grant', null)).rejects.toMatchObject({ status: 403 });
        await s.imports.decide(lee, exc!.id, 'grant', 'ok');
        await s.jobs.runDue(20);
        expect((await s.imports.row(tenant.id, nc.id))!.state).toBe('complete');

        const quota = await s.imports.quota(tenant.id);
        expect(quota.usedBytes.models).toBeGreaterThan(5000);
        expect(quota.maxBytes).toBe(500_000_000_000);
        await s.imports.setQuota(lee, tenant.id, 10);
        await expect(s.imports.admitDataset(tenant.id, 11)).rejects.toMatchObject({ status: 413 });
      } finally {
        await s.close();
        await Promise.all([ckan.close(), hub.close()]);
        await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
        await db.destroy();
      }
    }, 120_000);
  });
}
