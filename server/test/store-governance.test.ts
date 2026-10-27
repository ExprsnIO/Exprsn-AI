import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { storeAdminFor } from '../src/identity/store-admin.js';
import { storeBackupsFor } from '../src/identity/store-backups.js';
import { governanceFor } from '../src/identity/store-governance.js';
import { harness, localUser, login, loginAdmin, PASSWORD, type Harness } from './helpers.js';

/*
 * 1.9.9-qa, Sprint QA-1 (Sprint 54 leftovers): the governance of user stores. Dual control on a store's configuration
 * and on backup restores (the proposer cannot approve, approval needs a recent sign-in, the tenant setting turns it
 * off), purge after the retention period, scheduled backups with pruning and failure notices, the CSV export of a
 * store's users (no secrets, within clearance, by job for large stores) and the raw upload of a large backup. Without
 * migration 142 everything works as before. Migrations 140 to 142 are applied here by hand until they are registered.
 */

const DAY = 24 * 60 * 60_000;

async function install(h: Harness, governance = true): Promise<void> {
  const db = h.s.db;
  if (!(await db.schema.hasColumn('identity_providers', 'state'))) await (await import('../src/db/migrations/140_identity_store_state.js')).up(db);
  if (!(await db.schema.hasTable('identity_store_backups'))) await (await import('../src/db/migrations/141_identity_store_backups.js')).up(db);
  if (governance && !(await db.schema.hasTable('identity_store_proposals'))) await (await import('../src/db/migrations/142_identity_store_governance.js')).up(db);
  // 142 is registered (2026-10-19), so the harness has it: roll it back to see the services without it.
  if (!governance && (await db.schema.hasTable('identity_store_proposals'))) await (await import('../src/db/migrations/142_identity_store_governance.js')).down(db);
  const admin = storeAdminFor(h.s);
  admin.resetSchemaCache();
  storeBackupsFor(h.s, admin).resetSchemaCache();
  governanceFor(h.s).resetSchemaCache();
}

describe('store governance', () => {
  let h: Harness;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'exprsn-governance-'));
    const file = path.join(dir, 'hr.sqlite');
    const db = new Database(file);
    db.exec('CREATE TABLE staff (id INTEGER PRIMARY KEY, login TEXT, pw TEXT, full_name TEXT, grp TEXT)');
    db.prepare('INSERT INTO staff (login, pw, full_name, grp) VALUES (?, ?, ?, ?)').run('jdoe', bcrypt.hashSync(PASSWORD, 10), 'Jane Doe', 'finance-ops');
    db.close();
    process.env.HR_GOV_DB = file;
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => h.close());

  const SQL = { dialect: 'sqlite', connection: 'env:HR_GOV_DB', table: 'staff', columns: { id: 'id', username: 'login', passwordHash: 'pw', displayName: 'full_name', groups: 'grp' } };
  const SQL2 = { ...SQL, defaultClearance: 'public' };

  const clientOf = (a: Awaited<ReturnType<typeof loginAdmin>>, userId: string) => ({
    ...a,
    userId,
    get: (p: string) => a.agent.get(p),
    post: (p: string, b: object) => a.agent.post(p).set('x-csrf-token', a.csrf).send(b),
    put: (p: string, b: object) => a.agent.put(p).set('x-csrf-token', a.csrf).send(b),
    patch: (p: string, b: object) => a.agent.patch(p).set('x-csrf-token', a.csrf).send(b),
    del: (p: string) => a.agent.delete(p).set('x-csrf-token', a.csrf)
  });
  const admin = async (name: string) => {
    const u = await localUser(h, name, ['identity-admin'], 'confidential');
    return clientOf(await loginAdmin(h, name), u.id);
  };
  type Admin = Awaited<ReturnType<typeof admin>>;
  const stale = (a: Admin) => h.s.db('sessions').where({ user_id: a.userId }).update({ auth_at: Date.now() - 60 * 60_000, created_at: Date.now() - 60 * 60_000 });
  const audits = async (prefix: string) => ((await h.s.audit.list(h.tenantId, { limit: 500 })) as { action: string; detail: Record<string, unknown> | null; target: Record<string, unknown> }[]).filter((e) => e.action.startsWith(prefix));

  const hrStore = async (a: Admin, name = 'HR') => {
    const store = (await a.post('/api/admin/identity-providers', { name, kind: 'sql', position: 10, config: SQL }).expect(201)).body;
    await a.post('/api/admin/group-mappings', { providerId: store.id, group: 'finance-ops', role: 'member', clearance: 'internal' }).expect(201);
    expect((await login(h, 'jdoe')).res.status).toBe(200);
    return store as { id: string; name: string };
  };

  it('without migration 142 stores change, restore and go as before, and the features say unavailable', async () => {
    await install(h, false);
    const a = await admin('ida');
    await admin('idb');
    const store = await hrStore(a);
    const gov = (await a.get('/api/admin/identity-store-governance').expect(200)).body;
    expect(gov).toMatchObject({ available: false, dualControl: { available: false, on: false } });
    expect((await a.get('/api/admin/identity-store-kinds').expect(200)).body.governance).toBe(false);
    // Two identity admins, yet a configuration change applies at once (no proposals table).
    const changed = await a.patch(`/api/admin/identity-providers/${store.id}`, { config: SQL2 }).expect(200);
    expect(changed.body.config.defaultClearance).toBe('public');
    expect((await a.get('/api/admin/identity-store-proposals').expect(503)).body.reason).toBe('migration_pending');
    await a.post(`/api/admin/identity-providers/${store.id}/users-export`, {}).expect(503);
    await a.put(`/api/admin/identity-providers/${store.id}/backup-schedule`, { frequency: 'daily' }).expect(503);
    expect(await governanceFor(h.s).runDue(h.tenantId)).toEqual([]);
    // Removal needs no archive and no waiting.
    await a.del(`/api/admin/identity-providers/${store.id}`).expect(204);
    expect(await h.s.providers.get(h.tenantId, store.id)).toBeUndefined();
  });

  it('a configuration change is a proposal another identity admin approves with a recent sign-in', async () => {
    await install(h);
    const a = await admin('ida');
    const b = await admin('idb');
    const store = await hrStore(a);
    expect((await a.get('/api/admin/identity-store-governance').expect(200)).body.dualControl).toMatchObject({ available: true, mode: 'auto', on: true, identityAdmins: 2, warning: null });

    // The name applies at once; the configuration waits.
    const res = await a.patch(`/api/admin/identity-providers/${store.id}`, { name: 'HR directory', config: SQL2, reason: 'default clearance' }).expect(202);
    expect(res.body).toMatchObject({ name: 'HR directory', proposal: { kind: 'store.config', state: 'pending', mine: true } });
    expect(res.body.config.defaultClearance).not.toBe('public');
    expect(res.body.proposal.changes).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'config.defaultClearance', after: 'public' })]));
    const id = res.body.proposal.id as string;
    // A second proposal for the same store waits for the first.
    await a.patch(`/api/admin/identity-providers/${store.id}`, { config: { ...SQL2, defaultClearance: 'confidential' } }).expect(409);
    // Enable and disable stay single-admin.
    await a.patch(`/api/admin/identity-providers/${store.id}`, { enabled: false }).expect(200);
    await a.patch(`/api/admin/identity-providers/${store.id}`, { enabled: true }).expect(200);

    // The proposer cannot approve; the other admin can, with a recent sign-in only.
    const own = await a.post(`/api/admin/identity-store-proposals/${id}/approve`, {}).expect(403);
    expect(own.body.step).toBe('dual-control');
    await a.post(`/api/admin/identity-store-proposals/${id}/reject`, {}).expect(409);
    await stale(b);
    expect((await b.post(`/api/admin/identity-store-proposals/${id}/approve`, {}).expect(401)).body.step_up).toBe(true);
    await b.post('/api/me/step-up', { password: PASSWORD }).expect(200);
    const ok = (await b.post(`/api/admin/identity-store-proposals/${id}/approve`, { note: 'checked' }).expect(200)).body;
    expect(ok.proposal).toMatchObject({ state: 'approved', mine: false, note: 'checked' });
    expect((await h.s.providers.get(h.tenantId, store.id))!.config.defaultClearance).toBe('public');
    const versions = (await a.get(`/api/admin/identity-providers/${store.id}/versions`).expect(200)).body.versions;
    expect(versions[0].reason).toMatch(/default clearance; approved by idb/);
    expect((await audits('identity.store.proposal.')).map((e) => e.action)).toEqual(expect.arrayContaining(['identity.store.proposal.created', 'identity.store.proposal.approved']));
    // The other admin was told.
    expect(await h.s.db('notifications').where({ user_id: b.userId, kind: 'identity.store.proposal' }).first()).toBeTruthy();

    // A proposal whose store changed since is superseded, not applied.
    const p2 = (await a.patch(`/api/admin/identity-providers/${store.id}`, { config: { ...SQL2, defaultClearance: 'confidential' } }).expect(202)).body.proposal.id as string;
    await h.s.providers.update(h.tenantId, store.id, { config: { ...SQL2, defaultClearance: 'restricted' } });
    expect((await b.post(`/api/admin/identity-store-proposals/${p2}/approve`, {}).expect(409)).body.reason).toBe('stale');
    expect((await b.get(`/api/admin/identity-store-proposals?providerId=${store.id}`).expect(200)).body[0].state).toBe('superseded');
    // Withdraw is the proposer's only.
    const p3 = (await a.patch(`/api/admin/identity-providers/${store.id}`, { config: SQL }).expect(202)).body.proposal.id as string;
    await b.post(`/api/admin/identity-store-proposals/${p3}/withdraw`, {}).expect(403);
    expect((await a.post(`/api/admin/identity-store-proposals/${p3}/withdraw`, {}).expect(200)).body.state).toBe('withdrawn');
  });

  it('one identity admin: dual control is off with a warning; turning it off while on needs a second admin', async () => {
    await install(h);
    const a = await admin('ida');
    const store = await hrStore(a);
    const solo = (await a.get('/api/admin/identity-store-governance').expect(200)).body.dualControl;
    expect(solo).toMatchObject({ on: false, identityAdmins: 1 });
    expect(solo.warning).toMatch(/only one identity admin/);
    await a.patch(`/api/admin/identity-providers/${store.id}`, { config: SQL2 }).expect(200);

    const b = await admin('idb');
    // With two, turning it off is itself a proposal; the retention applies at once.
    const off = (await a.put('/api/admin/identity-store-governance', { dualControl: 'off', purgeAfterDays: 10 }).expect(202)).body;
    expect(off.settings).toMatchObject({ dualControl: 'auto', purgeAfterDays: 10 });
    expect(off.proposal).toMatchObject({ kind: 'settings', state: 'pending' });
    await b.post(`/api/admin/identity-store-proposals/${off.proposal.id}/approve`, {}).expect(200);
    const now = (await a.get('/api/admin/identity-store-governance').expect(200)).body;
    expect(now.settings.dualControl).toBe('off');
    expect(now.dualControl.on).toBe(false);
    expect(now.dualControl.warning).toMatch(/turned off/);
    // Off: a configuration change applies at once.
    await a.patch(`/api/admin/identity-providers/${store.id}`, { config: SQL }).expect(200);
    // Turning it on needs nobody else.
    expect((await a.put('/api/admin/identity-store-governance', { dualControl: 'on' }).expect(200)).body.dualControl.on).toBe(true);
    // Changing the settings needs a recent sign-in.
    await stale(a);
    await a.put('/api/admin/identity-store-governance', { purgeAfterDays: 5 }).expect(401);
    expect((await audits('identity.store.settings.updated')).length).toBe(3);
  });

  it('an archived store is purged only after the retention period: links and versions go, accounts stay', async () => {
    await install(h);
    const a = await admin('ida');
    const b = await admin('idb');
    const store = await hrStore(a);
    const jdoe = (await h.s.users.byUsername(h.tenantId, 'jdoe'))!;
    // Not archived: refused, with how long it is kept.
    expect((await a.del(`/api/admin/identity-providers/${store.id}`).expect(409)).body.reason).toBe('not_archived');
    await a.post(`/api/admin/identity-providers/${store.id}/archive`, {}).expect(200);
    const early = (await a.del(`/api/admin/identity-providers/${store.id}`).expect(409)).body;
    expect(early).toMatchObject({ reason: 'retention', purgeAfterDays: 30 });
    expect(early.detail).toMatch(/can be removed from \d{4}-/);
    expect(early.purgeableAt).toBeGreaterThan(Date.now() + 29 * DAY);
    await a.post(`/api/admin/identity-providers/${store.id}/purge`, {}).expect(409);

    // Past the period: under dual control, a proposal another admin approves.
    await h.s.db('identity_providers').where({ id: store.id }).update({ archived_at: Date.now() - 31 * DAY });
    const proposed = (await a.post(`/api/admin/identity-providers/${store.id}/purge`, { reason: 'retired' }).expect(202)).body.proposal;
    expect(proposed.kind).toBe('store.purge');
    const done = (await b.post(`/api/admin/identity-store-proposals/${proposed.id}/approve`, {}).expect(200)).body;
    expect(done.result).toMatchObject({ links: 1, mappings: 1 });
    expect(done.result.versions).toBeGreaterThan(0);
    expect(await h.s.providers.get(h.tenantId, store.id)).toBeUndefined();
    expect((await h.s.users.get(h.tenantId, jdoe.id))!.state).toBe('active');
    expect((await h.s.users.identitiesFor(jdoe.id)).some((i) => i.provider_id === store.id)).toBe(false);
    expect(await h.s.db('identity_provider_versions').where({ provider_id: store.id }).first()).toBeUndefined();
    expect((await audits('identity.store.purged'))[0]!.detail).toMatchObject({ links: 1, mappings: 1, proposal: proposed.id });

    // Dual control off: DELETE purges at once (with a recent sign-in).
    await h.s.db('identity_store_settings').insert({ tenant_id: h.tenantId, dual_control: 'off', purge_after_days: 1, updated_at: Date.now() });
    const other = await hrStore(a, 'HR two');
    await a.post(`/api/admin/identity-providers/${other.id}/archive`, {}).expect(200);
    await h.s.db('identity_providers').where({ id: other.id }).update({ archived_at: Date.now() - 2 * DAY });
    await stale(a);
    await a.del(`/api/admin/identity-providers/${other.id}`).expect(401);
    await a.post('/api/me/step-up', { password: PASSWORD }).expect(200);
    await a.del(`/api/admin/identity-providers/${other.id}`).expect(204);
    expect(await h.s.providers.get(h.tenantId, other.id)).toBeUndefined();
  });

  it('scheduled backups run as a job, are pruned to the count kept, and a failure notifies the identity admins', async () => {
    await install(h);
    const a = await admin('ida');
    const b = await admin('idb');
    const store = await hrStore(a);
    const sch = (await a.put(`/api/admin/identity-providers/${store.id}/backup-schedule`, { frequency: 'daily', keepCount: 2 }).expect(200)).body;
    expect(sch).toMatchObject({ frequency: 'daily', keepCount: 2, keepDays: null, enabled: true });
    // A backup made by hand is never pruned by the schedule.
    const manual = (await a.post(`/api/admin/identity-providers/${store.id}/backups`, { save: true }).expect(201)).body;

    // The scheduler's job for the tenant runs the due schedule.
    await h.s.jobs.enqueue({ tenantId: h.tenantId, type: 'identity.store.backups.due', payload: { tenantId: h.tenantId } });
    await h.s.jobs.runDue();
    const g = governanceFor(h.s);
    let list = (await a.get('/api/admin/identity-store-backups').expect(200)).body.backups as { id: string; origin: string }[];
    expect(list.filter((x) => x.origin === 'schedule')).toHaveLength(1);
    // Not due again until tomorrow; then twice more: three made, two kept.
    expect(await g.runDue(h.tenantId)).toEqual([]);
    expect((await g.runDue(h.tenantId, Date.now() + DAY + 1000))[0]).toMatchObject({ ok: true, pruned: 0 });
    expect((await g.runDue(h.tenantId, Date.now() + 2 * DAY + 2000))[0]).toMatchObject({ ok: true, pruned: 1 });
    list = (await a.get('/api/admin/identity-store-backups').expect(200)).body.backups;
    expect(list.filter((x) => x.origin === 'schedule')).toHaveLength(2);
    expect(list.some((x) => x.id === manual.id && x.origin === 'manual')).toBe(true);
    expect((await audits('identity.store.backup.pruned')).length).toBe(1);
    // Pruned by age too (never the newest).
    await a.put(`/api/admin/identity-providers/${store.id}/backup-schedule`, { frequency: 'daily', keepDays: 3 }).expect(200);
    await h.s.db('identity_store_backups').where({ origin: 'schedule' }).update({ created_at: Date.now() - 10 * DAY });
    expect((await g.runDue(h.tenantId, Date.now() + 3 * DAY + 3000))[0]).toMatchObject({ ok: true, pruned: 2 });

    // A failure: recorded on the schedule, audited, and both identity admins are told.
    const spy = vi.spyOn(storeBackupsFor(h.s, storeAdminFor(h.s)), 'save').mockRejectedValueOnce(new Error('blob store unavailable'));
    const failed = (await g.runDue(h.tenantId, Date.now() + 4 * DAY + 4000))[0]!;
    spy.mockRestore();
    expect(failed).toMatchObject({ ok: false, error: 'blob store unavailable' });
    const after = (await a.get(`/api/admin/identity-providers/${store.id}/backup-schedule`).expect(200)).body.schedule;
    expect(after).toMatchObject({ lastStatus: 'failed', lastError: 'blob store unavailable', failures: 1 });
    for (const u of [a.userId, b.userId]) expect(await h.s.db('notifications').where({ user_id: u, kind: 'identity.store.backup.failed' }).first()).toBeTruthy();
    expect((await audits('identity.store.backup.failed')).length).toBe(1);
    // Run now, as a job; then the schedule goes.
    const job = (await a.post(`/api/admin/identity-providers/${store.id}/backup-schedule/run`, {}).expect(202)).body.jobId;
    await h.s.jobs.runDue();
    expect((await h.s.jobs.get(h.tenantId, job))!.state).toBe('succeeded');
    await a.del(`/api/admin/identity-providers/${store.id}/backup-schedule`).expect(204);
    expect((await a.get('/api/admin/identity-store-backup-schedules').expect(200)).body.schedules).toEqual([]);
  });

  it('exports a store\'s users as CSV without secrets, within clearance, inline or as a job', async () => {
    await install(h);
    const a = await admin('ida');
    const b = await admin('idb');
    const store = await hrStore(a);
    // A restricted account linked to the store is above ida's clearance (confidential): left out and counted.
    const boss = await h.s.users.create(h.tenantId, { username: 'boss', displayName: 'The Boss', clearance: 'restricted' });
    await h.s.users.upsertIdentity(boss.id, store.id, '99', ['board']);
    const res = await a.post(`/api/admin/identity-providers/${store.id}/users-export`, {}).expect(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['x-omitted']).toBe('1');
    const lines = res.text.trim().split('\r\n');
    expect(lines[0]).toBe('username,display_name,email,state,groups,last_sign_in');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^jdoe,Jane Doe,.*,active,finance-ops,\d{4}-/);
    expect(res.text).not.toContain('boss');
    expect(res.text).not.toMatch(/\$2[aby]\$/); // no password hash
    expect((await audits('identity.store.users.exported'))[0]!.detail).toMatchObject({ rows: 1, omitted: 1, via: 'direct' });

    // As a job: the file is sealed in the blob store and only the requester downloads it.
    const job = (await a.post(`/api/admin/identity-providers/${store.id}/users-export`, { job: true }).expect(202)).body.jobId as string;
    await a.get(`/api/admin/identity-store-exports/${job}`).expect(409);
    await h.s.jobs.runDue();
    const file = await a.get(`/api/admin/identity-store-exports/${job}`).expect(200);
    expect(file.text).toContain('jdoe');
    expect(file.text).not.toContain('boss');
    await b.get(`/api/admin/identity-store-exports/${job}`).expect(404);
    const sealed = await h.s.blobs.get(`identity/store-exports/${h.tenantId}/${job}.csv.sealed`);
    expect(sealed!.toString('utf8')).not.toContain('jdoe');
  });

  it('a backup larger than the JSON limit is uploaded raw, previewed by id, and restored under dual control', async () => {
    await install(h);
    const a = await admin('ida');
    const b = await admin('idb');
    const store = await hrStore(a);
    const archive = (await a.post(`/api/admin/identity-providers/${store.id}/backups`, {}).expect(200)).body;
    // Unknown keys are not signed and are dropped on reading: padding makes it larger than 256 kB.
    const big = JSON.stringify({ ...archive, padding: 'x'.repeat(300 * 1024) });
    expect(big.length).toBeGreaterThan(256 * 1024);
    await a.post('/api/admin/identity-store-backups/restore', { archive: JSON.parse(big), dryRun: true }).expect(413);

    const up = (await a.agent.put('/api/admin/identity-store-backups/upload').set('x-csrf-token', a.csrf).set('content-type', 'application/json').send(big).expect(201)).body;
    expect(up).toMatchObject({ archiveId: archive.id, source: { store: { id: store.id } } });
    expect(up.id).not.toBe(archive.id);
    const listed = (await a.get('/api/admin/identity-store-backups').expect(200)).body.backups;
    expect(listed.find((x: { id: string }) => x.id === up.id)).toMatchObject({ origin: 'upload' });
    expect((await audits('identity.store.backup.uploaded')).length).toBe(1);

    // Dry run first, by id; then the restore is a proposal the other admin approves.
    const dry = (await a.post('/api/admin/identity-store-backups/restore', { backupId: up.id, dryRun: true }).expect(200)).body;
    expect(dry).toMatchObject({ dryRun: true, target: { id: store.id, created: false } });
    const proposed = await a.post('/api/admin/identity-store-backups/restore', { backupId: up.id, mode: 'new', name: 'HR restored', dryRun: false }).expect(202);
    expect(proposed.body).toMatchObject({ dryRun: true, proposal: { kind: 'store.restore', state: 'pending' } });
    expect((await h.s.providers.list(h.tenantId)).some((x) => x.name === 'HR restored')).toBe(false);
    await a.post(`/api/admin/identity-store-proposals/${proposed.body.proposal.id}/approve`, {}).expect(403);
    const done = (await b.post(`/api/admin/identity-store-proposals/${proposed.body.proposal.id}/approve`, {}).expect(200)).body;
    expect(done.result).toMatchObject({ dryRun: false, target: { name: 'HR restored', created: true } });
    expect((await h.s.providers.list(h.tenantId)).find((x) => x.name === 'HR restored')).toMatchObject({ enabled: false });
    expect((await audits('identity.store.backup.restored'))[0]!.detail).toMatchObject({ proposal: proposed.body.proposal.id });

    // An inline archive restored under dual control is kept as an upload, so the approver restores the same bytes.
    const inline = await a.post('/api/admin/identity-store-backups/restore', { archive, dryRun: false }).expect(202);
    const kept = await h.s.db('identity_store_proposals').where({ id: inline.body.proposal.id }).first();
    expect(JSON.parse(kept.payload).backupId).toHaveLength(26);

    // A changed file is refused and nothing is kept; the size is capped.
    const tampered = JSON.stringify({ ...archive, signature: archive.signature.slice(0, -4) + 'AAAA' });
    const before = (await a.get('/api/admin/identity-store-backups').expect(200)).body.backups.length;
    expect((await a.agent.put('/api/admin/identity-store-backups/upload').set('x-csrf-token', a.csrf).set('content-type', 'application/json').send(tampered).expect(422)).body.reason).toBe('signature');
    expect((await a.get('/api/admin/identity-store-backups').expect(200)).body.backups.length).toBe(before);
    const backups = storeBackupsFor(h.s, storeAdminFor(h.s));
    await expect(backups.upload(h.tenantId, null, (async function* () { yield Buffer.from(big); })(), 1024)).rejects.toMatchObject({ status: 413 });
    expect((await a.get('/api/admin/identity-store-backups').expect(200)).body.backups.length).toBe(before);
  });
});
