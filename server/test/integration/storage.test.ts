/*
 * 1.6.0, Sprint 35c: Storage (B-4204) and Configuration (B-4205) against real databases. Each block runs when its
 * variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 037c_platform_storage; two instances reporting what they read and showing
 *                                  as differing; an override proposed by one admin, refused to its proposer and
 *                                  applied hot on both instances after a second admin approves; a restart override
 *                                  applied at the next start; the stores (the dialect's own size and connections),
 *                                  usage against the file quota, the quarantine and purges; the integrity check
 *                                  finding a missing object and an orphan, deleted after a dry run; a blob store
 *                                  migration that copies, switches and retires
 */
import { mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { applyStoredOverrides } from '../../src/config/settings.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import type { SwitchableBlobStore } from '../../src/platform/blob-switch.js';
import { createServices } from '../../src/services.js';
import { testConfig } from '../helpers.js';

const noop = { progress: async () => undefined, signal: new AbortController().signal };

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`storage and configuration on ${d.name}`, () => {
    it('migrates 037c_platform_storage and runs Configuration and Storage on it', async () => {
      const blobDir = mkdtempSync(path.join(tmpdir(), 'exprsn-35c-it-'));
      const env = { DB_CLIENT: d.client, DATABASE_URL: d.url!, BLOB_DIR: blobDir };
      const cfg = testConfig({ ...env, INSTANCE_NAME: 'api-1', PLATFORM_BACKUP_MINUTES: '60' });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      const cfg2 = testConfig({ ...env, INSTANCE_NAME: 'api-2', PLATFORM_BACKUP_MINUTES: '120', SESSION_SECRET: cfg.SESSION_SECRET, DATA_KEY: cfg.DATA_KEY! });
      const db2 = createDb(cfg2);
      const s2 = createServices(cfg2, db2, createLogger('silent', false), new Metrics());
      try {
        for (const t of ['platform_blob_runs', 'platform_blob_findings', 'platform_blob_checksums', 'platform_blob_dryruns', 'platform_storage_samples', 'platform_blob_migrations', 'platform_setting_proposals', 'platform_setting_overrides', 'platform_instance_settings']) expect(await db.schema.hasTable(t), t).toBe(true);
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const admin = async (username: string) => {
          const u = await s.users.create(tenant.id, { username, displayName: username.toUpperCase(), clearance: 'restricted' });
          await s.users.setRoles(u.id, 'direct', ['system-admin']);
          return { u, by: { tenantId: tenant.id, actor: { user: u.id }, userId: u.id } };
        };
        const a = await admin('root');
        const b = await admin('root2');

        // ---- Configuration ----
        await s2.settings.report();
        let v = (await s.settings.view(a.u.id)) as { instances: { instance: string }[]; settings: { name: string; differs: boolean; value: string | null; source: string }[]; restartRequired: { name: string; instances: string[] }[] };
        expect(v.instances.map((i) => i.instance).sort()).toEqual(['api-1', 'api-2']);
        expect(v.settings.find((x) => x.name === 'PLATFORM_BACKUP_MINUTES')).toMatchObject({ differs: true, value: '60' });
        expect(v.settings.find((x) => x.name === 'SESSION_SECRET')).toMatchObject({ differs: false, value: 'set' });
        const p = await s.settings.propose(a.by, 'PLATFORM_BACKUP_RETAIN', '25', 'audit asks for more');
        await expect(s.settings.approve(a.by, p.id, null)).rejects.toMatchObject({ status: 403 });
        expect(s.cfg.PLATFORM_BACKUP_RETAIN).toBe(14);
        expect(await s.settings.approve(b.by, p.id, 'ok')).toMatchObject({ applies: 'hot', applied: true });
        expect(s.cfg.PLATFORM_BACKUP_RETAIN).toBe(25);
        expect(await s2.settings.sync()).toEqual(['PLATFORM_BACKUP_RETAIN']);
        expect(s2.cfg.PLATFORM_BACKUP_RETAIN).toBe(25);
        const p2 = await s.settings.propose(b.by, 'JOB_CONCURRENCY', '9', 'more workers');
        await s.settings.approve(a.by, p2.id, null);
        await s2.settings.report();
        v = (await s.settings.view(a.u.id)) as typeof v;
        expect(v.restartRequired).toEqual([{ name: 'JOB_CONCURRENCY', instances: ['api-1', 'api-2'] }]);
        const restarted = testConfig({ ...env, INSTANCE_NAME: 'api-1' });
        await applyStoredOverrides(restarted, db);
        expect(restarted.JOB_CONCURRENCY).toBe(9);
        expect((await s.audit.list(tenant.id, { action: 'platform.setting', limit: 20 })).map((e) => e.action)).toEqual(expect.arrayContaining(['platform.setting.proposed', 'platform.setting.approved']));

        // ---- Storage: stores, usage, quarantine, purges ----
        const st = await s.storage.stores();
        const dbStore = st.stores.find((x) => x.id === 'db')!;
        expect(dbStore).toMatchObject({ kind: expect.stringMatching(d.client === 'pg' ? /^PostgreSQL / : /^MySQL /), health: 'ok', objects: expect.stringMatching(/^\d+ of \d+ connections$/) });
        expect(Number(dbStore.usedBytes)).toBeGreaterThan(0);
        const ws = await s.tenants.createWorkspace(tenant.id, 'Legal', 'confidential');
        const t = Date.now();
        const file = { id: ulid(), tenant_id: tenant.id, workspace_id: ws.id, folder_id: null, owner_id: a.u.id, name: 'contract.pdf', name_lower: 'contract.pdf', label: 'internal', state: 'ready', current_version: 2, size: 3000, type: 'application/pdf', created_at: t, updated_at: t };
        await db('files').insert(file);
        for (const [n, size] of [[1, 1000], [2, 3000]] as const) await db('file_versions').insert({ id: ulid(), tenant_id: tenant.id, workspace_id: ws.id, file_id: file.id, number: n, state: 'ready', size, sha256: '0'.repeat(64), type: 'application/pdf', label: 'internal', created_by: a.u.id, created_at: t });
        await s.files.setLimit(tenant.id, ws.id, 3500, a.u.id);
        const att = await s.attachments.upload({ tenantId: tenant.id, workspaceId: ws.id, userId: a.u.id, name: 'notes.txt', declaredType: 'text/plain', label: 'internal', data: Buffer.alloc(500, 97) });
        const u = (await s.storage.usage()) as { workspaces: { id: string; files: number; versions: number; attachments: number; quotaBytes: number; quotaUsed: number }[] };
        expect(u.workspaces.find((w) => w.id === ws.id)).toMatchObject({ files: 3000, versions: 1000, attachments: 500, quotaBytes: 3500, quotaUsed: 4000 });
        const q = await s.storage.quarantine();
        expect(q.find((x) => x.id === att.id)).toMatchObject({ kind: 'attachment', state: 'scanning', canDelete: true });
        await s.storage.discard(a.by, 'attachment', att.id, 'by mistake');
        expect((await db('attachments').where({ id: att.id }).first()).state).toBe('rejected');
        expect((await s.storage.purges()).length).toBe(7);

        // ---- Storage: the integrity check and orphan deletion ----
        await s.blobs.put('scratch/old/leftover.bin', Buffer.alloc(1024, 2));
        const old = (Date.now() - 48 * 3_600_000) / 1000;
        utimesSync(path.join(blobDir, 'scratch/old/leftover.bin'), old, old);
        await db('attachments').insert({ id: ulid(), tenant_id: tenant.id, workspace_id: null, user_id: a.u.id, name: 'gone.pdf', type: 'application/pdf', declared_type: null, size: 9, sha256: '0'.repeat(64), state: 'ready', label: 'internal', reason: null, findings: null, blob_key: `attachments/${tenant.id}/gone`, created_at: t });
        const run = await s.storage.integrity.queue(a.by, { checksums: true, enqueue: false });
        expect(await s.storage.integrity.run(run.id, noop)).toMatchObject({ missing: 1, orphans: 1, mismatches: 0 });
        const dry = await s.storage.integrity.dryRun(a.by, null);
        expect(dry).toMatchObject({ count: 1, bytes: 1024, keys: ['scratch/old/leftover.bin'] });
        expect(await s.storage.integrity.deleteOrphans(b.by, dry.id, 'left over')).toEqual({ deleted: 1, bytes: 1024, failed: 0 });
        await expect(s.storage.integrity.deleteOrphans(b.by, dry.id, 'again')).rejects.toMatchObject({ status: 409 });
        expect(await s.blobs.get('scratch/old/leftover.bin')).toBeNull();

        // ---- Storage: a migration copies, switches and retires; the other instance follows ----
        const target = mkdtempSync(path.join(tmpdir(), 'exprsn-35c-it-target-'));
        await s.blobs.put('exports/one.json', Buffer.from('{"a":1}'));
        const m = await s.storage.startMigration(a.by, { kind: 'fs', dir: target }, 'new volume');
        await s2.settings.report();
        // The second instance follows the shared mode at its next sync, which its report loop would do.
        const follow = setInterval(() => void s2.storage.syncStore().then(() => s2.settings.report()).catch(() => undefined), 200);
        try {
          expect(await s.storage.runMigration(m.id, noop)).toMatchObject({ objects: expect.any(Number) });
        } finally {
          clearInterval(follow);
        }
        await s2.storage.syncStore();
        expect((s.blobs as SwitchableBlobStore).label).toBe(`switched:${m.id}`);
        expect((s2.blobs as SwitchableBlobStore).label).toBe(`switched:${m.id}`);
        await s2.blobs.put('exports/two.json', Buffer.from('2'));
        expect((await s.blobs.get('exports/two.json'))?.toString()).toBe('2');
        await s.storage.retireMigration(a.by, m.id, 'old volume goes');
        await s2.storage.syncStore();
        expect((s2.blobs as SwitchableBlobStore).label).toBe('single');
        expect((await s2.blobs.get('exports/one.json'))?.toString()).toBe('{"a":1}');
      } finally {
        await s2.close();
        await db2.destroy();
        await s.close();
        await db.destroy();
      }
    });
  });
}
