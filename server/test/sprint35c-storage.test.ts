import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';
import { afterEach, describe, expect, it } from 'vitest';
import { applyStoredOverrides, SETTINGS } from '../src/config/settings.js';
import { createDb, migrate } from '../src/db/knex.js';
import { createLogger, Metrics } from '../src/observability/index.js';
import type { SwitchableBlobStore } from '../src/platform/blob-switch.js';
import { createServices } from '../src/services.js';
import { settingsSource, SETTINGS_FILE } from './gen-settings.js';
import { harness, localUser, loginAdmin, testConfig, type Client } from './helpers.js';

const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), p));
const post = (c: Client, u: string, body: object = {}) => c.agent.post(u).set('x-csrf-token', c.csrf).send(body);
let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c().catch(() => undefined);
  cleanup = [];
});

async function setup(env: Record<string, string> = {}) {
  const h = await harness({ INSTANCE_NAME: 'api-1', ...env });
  cleanup.push(() => h.close());
  const root = await localUser(h, 'root', ['system-admin'], 'restricted');
  const root2 = await localUser(h, 'root2', ['system-admin'], 'restricted');
  await localUser(h, 'ws-admin', ['tenant-admin'], 'confidential');
  const a = await loginAdmin(h, 'root');
  const b = await loginAdmin(h, 'root2');
  return { h, a, b, root, root2 };
}

/** Sets an object's modification time back, as if it were written `hours` ago. */
const age = (dir: string, key: string, hours: number) => {
  const t = (Date.now() - hours * 3_600_000) / 1000;
  utimesSync(path.join(dir, key), t, t);
};

describe('B-4205: the settings descriptor', () => {
  it('is generated from config/index.ts (npm run gen:settings -w server)', () => {
    expect(readFileSync(SETTINGS_FILE, 'utf8')).toBe(settingsSource());
  });

  it('describes every setting with a section, a type, a description and whether it is hot', () => {
    expect(SETTINGS.length).toBeGreaterThan(300);
    for (const d of SETTINGS) {
      expect(d.section, d.name).toBeTruthy();
      expect(d.description, d.name).not.toBe('');
    }
    const by = (n: string) => SETTINGS.find((d) => d.name === n)!;
    expect(by('DATA_KEY')).toMatchObject({ secret: true, file: true, overridable: false, default: null, section: 'Keys and KMS' });
    expect(by('DATABASE_URL')).toMatchObject({ secret: true, overridable: false });
    expect(by('JOB_CONCURRENCY')).toMatchObject({ type: 'integer', constraint: '1 to 64', default: '4', applies: 'restart', overridable: true, section: 'Jobs and cache' });
    expect(by('PLATFORM_BACKUP_RETAIN')).toMatchObject({ applies: 'hot', default: '14' });
    expect(by('BLOB_STORE')).toMatchObject({ type: 'enum', options: ['fs', 's3'], default: 'fs' });
    expect(by('SIGNIN_NOTICES')).toMatchObject({ type: 'boolean', default: 'true' });
    expect(by('PLATFORM_BACKUP_MINUTES')).toMatchObject({ type: 'duration', constraint: '0 to 10,080 minutes' });
    expect(by('DB_CLIENT')).toMatchObject({ overridable: false });
  });
});

describe('B-4205: Configuration', () => {
  it('shows what each instance reads, never a secret value, and two instances that differ as differing', async () => {
    const dir = tmp('exprsn-35c-');
    const common = { SQLITE_FILENAME: path.join(dir, 'db.sqlite'), BLOB_DIR: path.join(dir, 'blobs') };
    const { h, a } = await setup({ ...common, PLATFORM_BACKUP_MINUTES: '60' });
    const cfg2 = testConfig({ ...common, INSTANCE_NAME: 'api-2', PLATFORM_BACKUP_MINUTES: '120', SESSION_SECRET: h.s.cfg.SESSION_SECRET, DATA_KEY: h.s.cfg.DATA_KEY! });
    const db2 = createDb(cfg2);
    await migrate(db2);
    const s2 = createServices(cfg2, db2, createLogger('silent', false), new Metrics());
    cleanup.push(async () => {
      await s2.close();
      await db2.destroy();
    });
    await s2.settings.report();
    const res = await a.agent.get('/api/admin/platform/settings').expect(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(h.s.cfg.SESSION_SECRET);
    expect(text).not.toContain(h.s.cfg.DATA_KEY!);
    const v = res.body;
    expect(v).toMatchObject({ instance: 'api-1', overridesEnabled: true, build: expect.any(String) });
    expect(v.instances.map((i: { instance: string }) => i.instance).sort()).toEqual(['api-1', 'api-2']);
    const get = (n: string) => v.settings.find((x: { name: string }) => x.name === n);
    expect(get('PLATFORM_BACKUP_MINUTES')).toMatchObject({ value: '60', source: 'env', differs: true, changed: true });
    expect(get('PLATFORM_BACKUP_MINUTES').perInstance).toEqual(expect.arrayContaining([expect.objectContaining({ instance: 'api-1', value: '60' }), expect.objectContaining({ instance: 'api-2', value: '120' })]));
    // The same secret on both instances does not differ; the value never appears, only its length and fingerprint.
    expect(get('SESSION_SECRET')).toMatchObject({ value: 'set', chars: 64, differs: false, secret: true });
    expect(get('SESSION_SECRET').perInstance[0].fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(get('JOB_CONCURRENCY')).toMatchObject({ value: '4', source: 'default', differs: false, changed: false });

    const env = (await a.agent.get('/api/admin/platform/settings/export').expect(200)).body;
    expect(env.text).toContain('PLATFORM_BACKUP_MINUTES=60');
    expect(env.text).toContain('SESSION_SECRET=********');
    expect(env.text).not.toContain(h.s.cfg.SESSION_SECRET);
    const changed = (await a.agent.get('/api/admin/platform/settings/export?changed=true').expect(200)).body;
    expect(changed.lines).toBeLessThan(env.lines);
    expect((await h.s.audit.list(h.tenantId, { action: 'platform.settings.exported', limit: 5 })).length).toBe(2);
  });

  it('applies an override only after a second platform admin approves: hot at once, restart at the next start', async () => {
    const dir = tmp('exprsn-35c-');
    const common = { SQLITE_FILENAME: path.join(dir, 'db.sqlite'), BLOB_DIR: path.join(dir, 'blobs') };
    const { h, a, b } = await setup(common);
    expect(h.s.cfg.PLATFORM_BACKUP_RETAIN).toBe(14);
    await post(a, '/api/admin/platform/settings/PLATFORM_BACKUP_RETAIN/proposals', { value: 'many', reason: 'keep more' }).expect(422);
    await post(a, '/api/admin/platform/settings/PLATFORM_BACKUP_RETAIN/proposals', { value: '0', reason: 'keep more' }).expect(422);
    await post(a, '/api/admin/platform/settings/DATABASE_URL/proposals', { value: 'postgres://x', reason: 'move' }).expect(409);
    await post(a, '/api/admin/platform/settings/NOPE/proposals', { value: '1', reason: 'none' }).expect(404);
    // Cross-field rules apply too: the default lease cannot outlast the longest one.
    await post(a, '/api/admin/platform/settings/VAULT_LEASE_DEFAULT_TTL_SECONDS/proposals', { value: String(h.s.cfg.VAULT_LEASE_MAX_TTL_SECONDS + 1), reason: 'longer' }).expect(422);
    const p = (await post(a, '/api/admin/platform/settings/PLATFORM_BACKUP_RETAIN/proposals', { value: '20', reason: 'audit asks for three weeks' }).expect(202)).body;
    expect(p).toMatchObject({ state: 'pending', action: 'set', previous: '14', value: '20' });
    await post(a, '/api/admin/platform/settings/PLATFORM_BACKUP_RETAIN/proposals', { value: '21', reason: 'again' }).expect(409);
    let v = (await a.agent.get('/api/admin/platform/settings').expect(200)).body;
    expect(v.pending).toEqual([expect.objectContaining({ name: 'PLATFORM_BACKUP_RETAIN', mine: true })]);
    // Not yet: the proposer cannot approve, and nothing changed.
    expect((await post(a, `/api/admin/platform/settings/proposals/${p.id}/approve`).expect(403)).body.step).toBe('dual-control');
    expect(h.s.cfg.PLATFORM_BACKUP_RETAIN).toBe(14);
    const ok = (await post(b, `/api/admin/platform/settings/proposals/${p.id}/approve`, { note: 'checked the bucket size' }).expect(200)).body;
    expect(ok).toMatchObject({ applies: 'hot', applied: true, proposal: { state: 'approved' } });
    expect(h.s.cfg.PLATFORM_BACKUP_RETAIN).toBe(20);
    v = (await a.agent.get('/api/admin/platform/settings').expect(200)).body;
    const retain = v.settings.find((x: { name: string }) => x.name === 'PLATFORM_BACKUP_RETAIN');
    expect(retain).toMatchObject({ value: '20', source: 'override', override: { value: '20', applies: 'hot', proposedBy: 'ROOT', approvedBy: 'ROOT2' } });
    expect(retain.history[0]).toMatchObject({ from: '14', to: '20', state: 'approved', proposedBy: 'ROOT', decidedBy: 'ROOT2' });

    // A restart setting is stored and waits for the next start; the instance is named until then.
    const p2 = (await post(a, '/api/admin/platform/settings/JOB_CONCURRENCY/proposals', { value: '12', reason: 'media backlog' }).expect(202)).body;
    const ok2 = (await post(b, `/api/admin/platform/settings/proposals/${p2.id}/approve`).expect(200)).body;
    expect(ok2).toMatchObject({ applies: 'restart', applied: false });
    expect(h.s.cfg.JOB_CONCURRENCY).toBe(4);
    v = (await a.agent.get('/api/admin/platform/settings').expect(200)).body;
    expect(v.restartRequired).toEqual([{ name: 'JOB_CONCURRENCY', instances: ['api-1'] }]);
    const restarted = testConfig({ ...common, INSTANCE_NAME: 'api-1' });
    expect(await applyStoredOverrides(restarted, h.s.db)).toEqual({ applied: expect.arrayContaining(['JOB_CONCURRENCY', 'PLATFORM_BACKUP_RETAIN']), errors: [] });
    expect(restarted.JOB_CONCURRENCY).toBe(12);

    // Removing an override is a proposal too; the hot value goes back to the environment's.
    const clear = (await post(b, '/api/admin/platform/settings/PLATFORM_BACKUP_RETAIN/proposals', { value: null, reason: 'back to the default' }).expect(202)).body;
    await post(b, `/api/admin/platform/settings/proposals/${clear.id}/withdraw`).expect(200);
    const clear2 = (await post(b, '/api/admin/platform/settings/PLATFORM_BACKUP_RETAIN/proposals', { value: null, reason: 'back to the default' }).expect(202)).body;
    await post(b, `/api/admin/platform/settings/proposals/${clear2.id}/reject`).expect(409);
    await post(a, `/api/admin/platform/settings/proposals/${clear2.id}/approve`).expect(200);
    expect(h.s.cfg.PLATFORM_BACKUP_RETAIN).toBe(14);
    const actions = (await h.s.audit.list(h.tenantId, { action: 'platform.setting', limit: 50 })).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['platform.setting.proposed', 'platform.setting.approved', 'platform.setting.withdrawn']));

    // Another instance picks the hot override up from the database at its next report.
    const p3 = (await post(a, '/api/admin/platform/settings/PLATFORM_KEY_ROTATION_DAYS/proposals', { value: '30', reason: 'shorter keys' }).expect(202)).body;
    const cfg2 = testConfig({ ...common, INSTANCE_NAME: 'api-2', SESSION_SECRET: h.s.cfg.SESSION_SECRET, DATA_KEY: h.s.cfg.DATA_KEY! });
    const db2 = createDb(cfg2);
    const s2 = createServices(cfg2, db2, createLogger('silent', false), new Metrics());
    cleanup.push(async () => {
      await s2.close();
      await db2.destroy();
    });
    await post(b, `/api/admin/platform/settings/proposals/${p3.id}/approve`).expect(200);
    expect(s2.cfg.PLATFORM_KEY_ROTATION_DAYS).toBe(90);
    expect(await s2.settings.sync()).toEqual(['PLATFORM_KEY_ROTATION_DAYS']);
    expect(s2.cfg.PLATFORM_KEY_ROTATION_DAYS).toBe(30);
  });

  it('refuses every proposal with PLATFORM_SETTINGS_OVERRIDES=false', async () => {
    const { a } = await setup({ PLATFORM_SETTINGS_OVERRIDES: 'false' });
    expect((await post(a, '/api/admin/platform/settings/PLATFORM_BACKUP_RETAIN/proposals', { value: '20', reason: 'more' }).expect(409)).body.step).toBe('overrides-disabled');
    expect((await a.agent.get('/api/admin/platform/settings').expect(200)).body.overridesEnabled).toBe(false);
  });

  it('is for platform admins only', async () => {
    const { h } = await setup();
    const t = await loginAdmin(h, 'ws-admin');
    await t.agent.get('/api/admin/platform/settings').expect(403);
    await t.agent.get('/api/admin/storage/stores').expect(403);
  });
});

describe('B-4204: Storage', () => {
  it('finds an orphan and a missing object, and deletes the orphan only after a dry run, with a reason', async () => {
    const { h, a, b, root } = await setup();
    const dir = h.s.cfg.BLOB_DIR;
    await h.s.blobs.put('scratch/old/leftover.bin', Buffer.alloc(2048, 1));
    age(dir, 'scratch/old/leftover.bin', 48);
    await h.s.blobs.put('scratch/new/still-writing.bin', Buffer.alloc(10, 1)); // inside the grace period
    // A row that names an object the store does not have, and one whose object is there.
    await h.s.db('attachments').insert({ id: ulid(), tenant_id: h.tenantId, workspace_id: null, user_id: root.id, name: 'gone.pdf', type: 'application/pdf', declared_type: null, size: 9, sha256: '0'.repeat(64), state: 'ready', label: 'internal', reason: null, findings: null, blob_key: `attachments/${h.tenantId}/gone`, created_at: Date.now() - 86_400_000 });
    const kept = ulid();
    await h.s.blobs.put(`attachments/${h.tenantId}/${kept}`, Buffer.from('kept'));
    age(dir, `attachments/${h.tenantId}/${kept}`, 72);
    await h.s.db('attachments').insert({ id: kept, tenant_id: h.tenantId, workspace_id: null, user_id: root.id, name: 'kept.txt', type: 'text/plain', declared_type: null, size: 4, sha256: '0'.repeat(64), state: 'ready', label: 'internal', reason: null, findings: null, blob_key: `attachments/${h.tenantId}/${kept}`, created_at: Date.now() - 86_400_000 });
    // A rejected row keeps its key for the record only: never reported missing.
    await h.s.db('attachments').insert({ id: ulid(), tenant_id: h.tenantId, workspace_id: null, user_id: root.id, name: 'bad.exe', type: 'application/octet-stream', declared_type: null, size: 9, sha256: '0'.repeat(64), state: 'rejected', label: 'internal', reason: 'Malware detected: Eicar', findings: null, blob_key: `quarantine/${h.tenantId}/bad`, created_at: Date.now() });

    await post(a, '/api/admin/storage/orphans/dry-run').expect(409); // no verification yet
    const run = (await post(a, '/api/admin/storage/integrity/verify').expect(202)).body;
    expect(run).toMatchObject({ state: 'queued', checksums: false });
    await post(a, '/api/admin/storage/integrity/verify').expect(409);
    await h.s.jobs.runDue();
    const integ = (await a.agent.get('/api/admin/storage/integrity').expect(200)).body;
    expect(integ.last).toMatchObject({ state: 'succeeded', missing: 1, orphans: 1, mismatches: 0, orphanBytes: 2048 });
    expect(integ.findings.map((f: { kind: string; object: string }) => `${f.kind} ${f.object}`).sort()).toEqual([`missing attachments/${h.tenantId}/gone`, 'orphan scratch/old/leftover.bin']);
    expect(integ.findings.find((f: { kind: string }) => f.kind === 'missing').referencedBy).toEqual([expect.objectContaining({ table: 'attachments', column: 'blob_key' })]);

    await post(a, '/api/admin/storage/orphans/delete', { dryRun: 'nope', reason: 'cleanup' }).expect(404);
    const dry = (await post(a, '/api/admin/storage/orphans/dry-run').expect(200)).body;
    expect(dry).toMatchObject({ count: 1, bytes: 2048, skipped: 0, keys: ['scratch/old/leftover.bin'] });
    expect(existsSync(path.join(dir, 'scratch/old/leftover.bin'))).toBe(true); // a dry run changes nothing
    await post(a, '/api/admin/storage/orphans/delete', { dryRun: dry.id, reason: 'x' }).expect(400); // a reason is required
    // One admin is enough (decision Q10): the other admin confirms here.
    expect((await post(b, '/api/admin/storage/orphans/delete', { dryRun: dry.id, reason: 'left by a cancelled media job' }).expect(200)).body).toEqual({ deleted: 1, bytes: 2048, failed: 0 });
    expect(existsSync(path.join(dir, 'scratch/old/leftover.bin'))).toBe(false);
    expect(existsSync(path.join(dir, `attachments/${h.tenantId}/${kept}`))).toBe(true);
    await post(b, '/api/admin/storage/orphans/delete', { dryRun: dry.id, reason: 'again please' }).expect(409);
    const after = (await a.agent.get('/api/admin/storage/integrity').expect(200)).body;
    expect(after.findings.find((f: { kind: string }) => f.kind === 'orphan')).toMatchObject({ state: 'deleted', note: 'left by a cancelled media job' });
    const del = (await h.s.audit.list(h.tenantId, { action: 'platform.blobs.orphans.deleted', limit: 5 }))[0]!;
    expect(del.detail).toMatchObject({ reason: 'left by a cancelled media job', deleted: 1, objects: ['scratch/old/leftover.bin'] });
    const actions = (await h.s.audit.list(h.tenantId, { action: 'platform.blobs', limit: 20 })).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['platform.blobs.verify.started', 'platform.blobs.verified', 'platform.blobs.orphans.dry-run', 'platform.blobs.orphans.deleted']));
  });

  it('a dry run for one object skips it once something references it again, and expires', async () => {
    const { h, a } = await setup({ BLOBS_DRY_RUN_MINUTES: '1' });
    const dir = h.s.cfg.BLOB_DIR;
    await h.s.blobs.put('scratch/a.bin', Buffer.alloc(5));
    await h.s.blobs.put('scratch/b.bin', Buffer.alloc(7));
    age(dir, 'scratch/a.bin', 30);
    age(dir, 'scratch/b.bin', 30);
    await post(a, '/api/admin/storage/integrity/verify').expect(202);
    await h.s.jobs.runDue();
    // b.bin is named by a row now (a platform state value, say): no longer an orphan.
    await h.s.db('platform_state').insert({ key: 'test.ref', value: JSON.stringify({ blob: 'scratch/b.bin' }), updated_at: Date.now() });
    const one = (await post(a, '/api/admin/storage/orphans/dry-run', { objects: ['scratch/b.bin'] }).expect(409)).body;
    expect(one.detail).toMatch(/referenced again/);
    const dry = (await post(a, '/api/admin/storage/orphans/dry-run', { objects: ['scratch/a.bin'] }).expect(200)).body;
    expect(dry.count).toBe(1);
    await h.s.db('platform_blob_dryruns').where({ id: dry.id }).update({ expires_at: Date.now() - 1 });
    expect((await post(a, '/api/admin/storage/orphans/delete', { dryRun: dry.id, reason: 'too late' }).expect(409)).body.step).toBe('dry-run');
    expect(existsSync(path.join(dir, 'scratch/a.bin'))).toBe(true);
  });

  it('compares checksums when asked: a changed object is a mismatch until it is accepted', async () => {
    const { h, a } = await setup();
    const dir = h.s.cfg.BLOB_DIR;
    const key = `media/${h.tenantId}/${ulid()}/original`;
    await h.s.blobs.put(key, Buffer.from('original bytes'));
    age(dir, key, 5);
    await post(a, '/api/admin/storage/integrity/verify', { checksums: true }).expect(202);
    await h.s.jobs.runDue();
    expect((await a.agent.get('/api/admin/storage/integrity').expect(200)).body.last.mismatches).toBe(0);
    // The bytes change on disk without the server writing them (the modification time is put back).
    writeFileSync(path.join(dir, key), 'tampered bytes');
    age(dir, key, 5);
    await post(a, '/api/admin/storage/integrity/verify', { checksums: true }).expect(202);
    await h.s.jobs.runDue();
    const integ = (await a.agent.get('/api/admin/storage/integrity').expect(200)).body;
    expect(integ.last.mismatches).toBe(1);
    const f = integ.findings.find((x: { kind: string }) => x.kind === 'mismatch');
    expect(f).toMatchObject({ object: key, state: 'open' });
    expect(f.expected).not.toBe(f.actual);
    expect((await post(a, `/api/admin/storage/findings/${f.id}/accept`, { reason: 'restored from the original upload' }).expect(200)).body.state).toBe('accepted');
    await post(a, '/api/admin/storage/integrity/verify', { checksums: true }).expect(202);
    await h.s.jobs.runDue();
    expect((await a.agent.get('/api/admin/storage/integrity').expect(200)).body.last.mismatches).toBe(0);
  });

  it('lists the quarantine, rescans and deletes a held object, and refuses a rescan of a refused one', async () => {
    const { h, a, root } = await setup();
    const ws = await h.s.tenants.createWorkspace(h.tenantId, 'Studio', 'internal');
    const att = await h.s.attachments.upload({ tenantId: h.tenantId, workspaceId: ws.id, userId: root.id, name: 'notes.txt', declaredType: 'text/plain', label: 'internal', data: Buffer.from('hello there') });
    const q = (await a.agent.get('/api/admin/storage/quarantine').expect(200)).body;
    expect(q.scanner).toMatchObject({ configured: false, reachable: null });
    const item = q.items.find((x: { id: string }) => x.id === att.id);
    expect(item).toMatchObject({ kind: 'attachment', object: 'notes.txt', workspace: 'Studio', state: 'scanning', canRescan: true, canDelete: true, by: 'ROOT' });
    expect((await post(a, `/api/admin/storage/quarantine/attachment/${att.id}/rescan`).expect(202)).body.job).toMatch(/^[0-9A-Z]{26}$/);
    await post(a, `/api/admin/storage/quarantine/nope/${att.id}/rescan`).expect(404);
    await post(a, `/api/admin/storage/quarantine/attachment/${att.id}/delete`, { reason: 'sent by mistake' }).expect(204);
    expect(await h.s.blobs.get(att.blob_key!)).toBeNull();
    const row = await h.s.db('attachments').where({ id: att.id }).first();
    expect(row).toMatchObject({ state: 'rejected', blob_key: null });
    const again = (await a.agent.get('/api/admin/storage/quarantine').expect(200)).body.items.find((x: { id: string }) => x.id === att.id);
    expect(again).toMatchObject({ state: 'deleted', canRescan: false, canDelete: false });
    await post(a, `/api/admin/storage/quarantine/attachment/${att.id}/rescan`).expect(409);
    const actions = (await h.s.audit.list(h.tenantId, { action: 'file.quarantine', limit: 10 })).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['file.quarantine.rescanned', 'file.quarantine.deleted']));
  });

  it('reports usage by workspace against the file quota, by user and by kind', async () => {
    const { h, a, root } = await setup();
    const ws = await h.s.tenants.createWorkspace(h.tenantId, 'Legal', 'confidential');
    const t = Date.now();
    const file = { id: ulid(), tenant_id: h.tenantId, workspace_id: ws.id, folder_id: null, owner_id: root.id, name: 'contract.pdf', name_lower: 'contract.pdf', label: 'internal', state: 'ready', current_version: 2, size: 3000, type: 'application/pdf', created_at: t, updated_at: t };
    await h.s.db('files').insert(file);
    for (const [n, size] of [[1, 1000], [2, 3000]] as const) await h.s.db('file_versions').insert({ id: ulid(), tenant_id: h.tenantId, workspace_id: ws.id, file_id: file.id, number: n, state: 'ready', size, sha256: '0'.repeat(64), type: 'application/pdf', label: 'internal', created_by: root.id, created_at: t });
    await h.s.attachments.upload({ tenantId: h.tenantId, workspaceId: ws.id, userId: root.id, name: 'a.txt', declaredType: 'text/plain', label: 'internal', data: Buffer.alloc(500, 97) });
    await a.agent.put(`/api/admin/tenants/${h.tenantId}/workspaces/${ws.id}/file-quota`).set('x-csrf-token', a.csrf).send({ maxBytes: 3500 }).expect(200);
    const u = (await a.agent.get('/api/admin/storage/usage').expect(200)).body;
    const legal = u.workspaces.find((w: { id: string }) => w.id === ws.id);
    expect(legal).toMatchObject({ workspace: 'Legal', files: 3000, versions: 1000, trash: 0, attachments: 500, total: 4500, quotaBytes: 3500, quotaUsed: 4000, label: 'confidential' });
    expect(legal.users).toEqual([{ id: root.id, name: 'ROOT', bytes: 4500 }]);
    expect(u.users[0]).toMatchObject({ name: 'ROOT', bytes: 4500, workspaces: ['Legal'] });
    expect(u.kinds.find((k: { kind: string }) => k.kind === 'versions').bytes).toBe(1000);
    expect(u.quotaCounts).toEqual(['files', 'versions', 'trash']);
    expect((await h.s.storage.sampleUsage()).workspaces).toBeGreaterThan(0);
  });

  it('lists the stores with their health and the purge schedules', async () => {
    const { a } = await setup();
    const st = (await a.agent.get('/api/admin/storage/stores').expect(200)).body;
    expect(st.stores.map((x: { id: string }) => x.id)).toEqual(['blobs', 'db', 'vectors', 'backups', 'media', 'datasets', 'models']);
    expect(st.stores[0]).toMatchObject({ kind: 'Filesystem', health: 'ok', singleNode: true, settings: ['BLOB_STORE', 'BLOB_DIR'] });
    expect(st.stores[0].capacityBytes).toBeGreaterThan(0);
    expect(st.stores[1]).toMatchObject({ kind: 'SQLite', health: 'ok' });
    expect(st.active).toMatchObject({ migration: null, mode: 'single' });
    const purges = (await a.agent.get('/api/admin/storage/purges').expect(200)).body;
    expect(purges.map((p: { job: string }) => p.job)).toEqual(['files.purge', 'chat.retention', 'channels.retention', 'memory.purge', 'ops.backup.create', 'atproto.feeds.prune', 'pds.trim']);
    expect(purges[0]).toMatchObject({ policy: 'FILES_TRASH_DAYS = 30', everyMinutes: 60, setting: 'FILES_PURGE_MINUTES', nextRun: expect.any(Number) });
  });

  it('migrates the blob store by copying every object, then switching reads, then retiring the old store', async () => {
    const { h, a } = await setup();
    const target = tmp('exprsn-35c-target-');
    await h.s.blobs.put('exports/one.json', Buffer.from('{"a":1}'));
    await h.s.blobs.put('media/t/x/original', Buffer.alloc(4096, 7));
    await post(a, '/api/admin/storage/migrations', { kind: 'fs', dir: 'relative/path', reason: 'new disk' }).expect(422);
    await post(a, '/api/admin/storage/migrations', { kind: 'fs', dir: h.s.cfg.BLOB_DIR, reason: 'same' }).expect(409);
    const m = (await post(a, '/api/admin/storage/migrations', { kind: 'fs', dir: target, reason: 'the new volume' }).expect(202)).body;
    expect(m).toMatchObject({ state: 'queued', to: `filesystem ${target}` });
    await post(a, '/api/admin/storage/migrations', { kind: 'fs', dir: target, reason: 'twice' }).expect(409);
    await h.s.jobs.runDue();
    const list = (await a.agent.get('/api/admin/storage/migrations').expect(200)).body;
    expect(list.migrations[0]).toMatchObject({ id: m.id, state: 'switched', verified: 2, objects: 2 });
    expect(readFileSync(path.join(target, 'media/t/x/original')).length).toBe(4096);
    const sw = h.s.blobs as SwitchableBlobStore;
    expect(sw.label).toBe(`switched:${m.id}`);
    // New writes go to the new store; an object only the old store has is still read from it until retirement.
    await h.s.blobs.put('exports/two.json', Buffer.from('2'));
    expect(existsSync(path.join(target, 'exports/two.json'))).toBe(true);
    expect(existsSync(path.join(h.s.cfg.BLOB_DIR, 'exports/two.json'))).toBe(false);
    writeFileSync(path.join(h.s.cfg.BLOB_DIR, 'exports/late.json'), 'late');
    expect((await h.s.blobs.get('exports/late.json'))?.toString()).toBe('late');
    expect((await a.agent.get('/api/admin/storage/stores').expect(200)).body.active).toMatchObject({ migration: m.id, label: `filesystem ${target}` });
    await post(a, `/api/admin/storage/migrations/${m.id}/retire`, { reason: 'the old disk goes back' }).expect(200);
    expect(sw.label).toBe('single');
    expect(await h.s.blobs.get('exports/late.json')).toBeNull();
    expect((await h.s.blobs.get('exports/two.json'))?.toString()).toBe('2');
    // A restarted instance builds the same store from the shared state.
    const s2 = createServices(h.s.cfg, h.s.db, createLogger('silent', false), new Metrics());
    await s2.storage.syncStore();
    expect((await s2.blobs.get('exports/two.json'))?.toString()).toBe('2');
    s2.settings.stop();
    const actions = (await h.s.audit.list(h.tenantId, { action: 'platform.blobs.migration', limit: 10 })).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['platform.blobs.migration.started', 'platform.blobs.migration.switched', 'platform.blobs.migration.retired']));
  });
});
