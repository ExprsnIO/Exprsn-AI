import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { storeAdminFor } from '../src/identity/store-admin.js';
import { storeBackupsFor, StoreBackups } from '../src/identity/store-backups.js';
import { harness, localUser, login, loginAdmin, PASSWORD, type Harness } from './helpers.js';

/*
 * 1.9.0, Sprint 54 (B-185, B-186): archiving and restoring a store, and store backups. An archived store leaves the
 * sign-in chain and directory sync, its users keep their accounts (and their local password), and restore puts it
 * back as it was; a backup is sealed and signed, a changed one is refused, a dry run changes nothing, a restore into
 * another tenant works, and secrets stay references throughout. Migrations 140 and 141 are applied here by hand until
 * they are registered.
 */

async function install(h: Harness): Promise<void> {
  if (!(await h.s.db.schema.hasColumn('identity_providers', 'state'))) await (await import('../src/db/migrations/140_identity_store_state.js')).up(h.s.db);
  if (!(await h.s.db.schema.hasTable('identity_store_backups'))) await (await import('../src/db/migrations/141_identity_store_backups.js')).up(h.s.db);
  const admin = storeAdminFor(h.s);
  admin.resetSchemaCache();
  storeBackupsFor(h.s, admin).resetSchemaCache();
}

describe('store archive, restore and backups', () => {
  let h: Harness;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'exprsn-archive-'));
    const file = path.join(dir, 'hr.sqlite');
    const db = new Database(file);
    db.exec('CREATE TABLE staff (id INTEGER PRIMARY KEY, login TEXT, pw TEXT, full_name TEXT, grp TEXT)');
    db.prepare('INSERT INTO staff (login, pw, full_name, grp) VALUES (?, ?, ?, ?)').run('jdoe', bcrypt.hashSync(PASSWORD, 10), 'Jane Doe', 'finance-ops');
    db.close();
    process.env.HR_ARCHIVE_DB = file;
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  beforeEach(async () => {
    h = await harness();
    await install(h);
  });
  afterEach(() => h.close());

  const SQL = { dialect: 'sqlite', connection: 'env:HR_ARCHIVE_DB', table: 'staff', columns: { id: 'id', username: 'login', passwordHash: 'pw', displayName: 'full_name', groups: 'grp' } };

  const clientOf = (a: Awaited<ReturnType<typeof loginAdmin>>) => ({
    ...a,
    get: (p: string) => a.agent.get(p),
    post: (p: string, b: object) => a.agent.post(p).set('x-csrf-token', a.csrf).send(b),
    patch: (p: string, b: object) => a.agent.patch(p).set('x-csrf-token', a.csrf).send(b),
    del: (p: string) => a.agent.delete(p).set('x-csrf-token', a.csrf)
  });
  const admin = async (name = 'ida') => {
    await localUser(h, name, ['identity-admin'], 'confidential');
    return clientOf(await loginAdmin(h, name));
  };
  const audits = async (tenantId: string, prefix: string) => ((await h.s.audit.list(tenantId, { limit: 500 })) as { action: string; detail: Record<string, unknown> | null; target: Record<string, unknown> }[]).filter((e) => e.action.startsWith(prefix));

  /** An HR store with jdoe signed in through it once (so linked and provisioned) and a mapping. */
  const hrStore = async (a: Awaited<ReturnType<typeof admin>>) => {
    const store = (await a.post('/api/admin/identity-providers', { name: 'HR', kind: 'sql', position: 10, config: SQL }).expect(201)).body;
    await a.post('/api/admin/group-mappings', { providerId: store.id, group: 'finance-ops', role: 'member', clearance: 'internal' }).expect(201);
    const jdoe = await login(h, 'jdoe');
    expect(jdoe.res.status).toBe(200);
    return { store, jdoe };
  };

  it('archive leaves the chain and sync; users keep their accounts; restore returns the previous state', async () => {
    const a = await admin();
    const { store, jdoe } = await hrStore(a);
    const user = (await h.s.users.byUsername(h.tenantId, 'jdoe'))!;
    // jdoe also has a local password: the local fallback keeps working while HR is archived.
    await h.s.db('local_credentials').insert({ user_id: user.id, password_hash: await (await import('../src/identity/passwords.js')).hashPassword('a local password here'), updated_at: Date.now() });

    const out = (await a.post(`/api/admin/identity-providers/${store.id}/archive`, { revokeSessions: true, reason: 'directory retired' }).expect(200)).body;
    expect(out).toMatchObject({ store: { state: 'archived', enabled: false, stateBefore: 'enabled' }, users: 1, sessionsRevoked: 1 });
    // The sign-in chain no longer asks it: jdoe's HR password is not tried anywhere.
    const r = await h.s.chain.authenticate(h.tenantId, 'jdoe', PASSWORD);
    expect(r.status === 'invalid' && r.provider.kind).toBe('local');
    expect((await h.s.chain.authenticate(h.tenantId, 'jdoe', 'a local password here')).status).toBe('ok');
    // The revoked session is gone.
    await jdoe.agent.get('/api/me').expect(401);
    // Sync leaves it out and refuses it by hand.
    const reports = await h.s.sync.syncTenant(h.tenantId);
    expect(reports.map((x) => x.provider)).not.toContain('HR');
    expect((await h.s.sync.syncProvider((await h.s.providers.get(h.tenantId, store.id))!)).aborted).toMatch(/archived/);
    await a.post(`/api/admin/identity-providers/${store.id}/sync`, {}).expect(409);
    // The account, its link and the mapping are kept; the store is read-only.
    expect((await h.s.users.get(h.tenantId, user.id))!.state).toBe('active');
    expect(await h.s.users.identitiesFor(user.id)).toEqual(expect.arrayContaining([expect.objectContaining({ provider_id: store.id })]));
    expect((await h.s.users.mappings(h.tenantId)).some((m) => m.provider_id === store.id)).toBe(true);
    await a.patch(`/api/admin/identity-providers/${store.id}`, { enabled: true }).expect(409);
    await a.patch(`/api/admin/identity-providers/${store.id}`, { config: SQL }).expect(409);
    await a.post(`/api/admin/identity-providers/${store.id}/archive`, {}).expect(409);

    const restored = (await a.post(`/api/admin/identity-providers/${store.id}/restore`, {}).expect(200)).body;
    expect(restored).toMatchObject({ store: { state: 'active', enabled: true }, users: 1, mappings: 1 });
    expect((await h.s.chain.authenticate(h.tenantId, 'jdoe', PASSWORD)).status).toBe('ok');
    // Restoring "disabled for review" when asked.
    await a.post(`/api/admin/identity-providers/${store.id}/archive`, {}).expect(200);
    const review = (await a.post(`/api/admin/identity-providers/${store.id}/restore`, { to: 'disabled' }).expect(200)).body;
    expect(review.store).toMatchObject({ state: 'active', enabled: false });

    expect((await audits(h.tenantId, 'identity.store.archived')).find((e) => e.detail!.reason)!.detail).toMatchObject({ before: 'enabled', users: 1, sessionsRevoked: 1, reason: 'directory retired' });
    expect((await audits(h.tenantId, 'identity.store.restored')).length).toBe(2);
    const versions = (await a.get(`/api/admin/identity-providers/${store.id}/versions`).expect(200)).body.versions.map((v: { reason: string }) => v.reason);
    expect(versions.slice(0, 4)).toEqual(['restored from the archive', 'archived', 'restored from the archive', 'directory retired']);
  });

  it('refuses archiving the local store, the only enabled store, and without a recent sign-in', async () => {
    const a = await admin();
    const local = (await h.s.providers.list(h.tenantId)).find((p) => p.kind === 'local')!;
    await a.post(`/api/admin/identity-providers/${local.id}/archive`, {}).expect(409);
    const { store } = await hrStore(a);
    await h.s.db('sessions').update({ auth_at: Date.now() - 60 * 60_000, created_at: Date.now() - 60 * 60_000 });
    const stale = await a.post(`/api/admin/identity-providers/${store.id}/archive`, {}).expect(401);
    expect(stale.body.step_up).toBe(true);
  });

  it('a backup is sealed and signed, secrets stay references, and a changed one is refused', async () => {
    const a = await admin();
    const { store } = await hrStore(a);
    const archive = (await a.post(`/api/admin/identity-providers/${store.id}/backups`, {}).expect(200)).body;
    expect(archive).toMatchObject({ format: 'exprsn-store-backup/1', source: { store: { id: store.id, name: 'HR', kind: 'sql' } }, counts: { mappings: 1, links: 1 }, sealed: { cipher: 'aes-256-gcm' } });
    // Sealed: nothing of the payload is readable in the archive.
    const text = JSON.stringify(archive);
    expect(text).not.toContain('finance-ops');
    expect(text).not.toContain('jdoe');
    const backups = storeBackupsFor(h.s, storeAdminFor(h.s));
    const payload = await backups.open(archive);
    // Secrets stay references, in the store and in every version.
    expect(payload.store.config.connection).toBe('env:HR_ARCHIVE_DB');
    expect(payload.versions.every((v) => v.config.connection === 'env:HR_ARCHIVE_DB')).toBe(true);
    expect(payload.links[0]).toMatchObject({ externalId: '1', user: { username: 'jdoe' } });

    // Tampering: any change to the archive, its sealed data or its signature is refused, and audited.
    const variants = [
      { ...archive, counts: { ...archive.counts, links: 9 } },
      { ...archive, sealed: { ...archive.sealed, data: archive.sealed.data.slice(0, -4) + 'AAAA' } },
      { ...archive, signature: archive.signature.slice(0, -4) + 'AAAA' },
      { ...archive, key: 'someone-elses-key' }
    ];
    for (const v of variants) {
      const res = await a.post('/api/admin/identity-store-backups/restore', { archive: v, dryRun: true }).expect(422);
      expect(res.headers['content-type']).toMatch(/problem\+json/);
      expect(res.body.reason).toBe('signature');
    }
    await a.post('/api/admin/identity-store-backups/restore', { archive: { nope: true }, dryRun: true }).expect(422);
    expect((await audits(h.tenantId, 'identity.store.backup.refused')).length).toBe(4);
    expect((await audits(h.tenantId, 'identity.store.backup.downloaded')).length).toBe(1);
  });

  it('saves to the blob store, lists, dry-runs a restore that changes nothing, then restores', async () => {
    const a = await admin();
    const { store } = await hrStore(a);
    const saved = (await a.post(`/api/admin/identity-providers/${store.id}/backups`, { save: true }).expect(201)).body;
    expect(await h.s.blobs.get(StoreBackups.blobKey(h.tenantId, saved.id))).not.toBeNull();
    const list = (await a.get('/api/admin/identity-store-backups').expect(200)).body;
    expect(list).toMatchObject({ available: true, backups: [{ id: saved.id, providerName: 'HR', kind: 'sql' }] });

    // Lose the mapping, then dry-run: the report lists it and nothing changes.
    const mapping = (await h.s.users.mappings(h.tenantId)).find((m) => m.provider_id === store.id)!;
    await h.s.users.removeMapping(h.tenantId, mapping.id);
    const before = await h.s.db('group_mappings').count({ n: '*' }).first();
    const dry = (await a.post('/api/admin/identity-store-backups/restore', { backupId: saved.id, dryRun: true }).expect(200)).body;
    expect(dry).toMatchObject({ dryRun: true, target: { id: store.id, created: false } });
    expect(dry.changes).toContainEqual({ what: 'mapping', action: 'create', detail: 'finance-ops → member (internal)' });
    expect(dry.changes).toContainEqual(expect.objectContaining({ what: 'link', action: 'unchanged' }));
    expect(await h.s.db('group_mappings').count({ n: '*' }).first()).toEqual(before);

    const real = (await a.post('/api/admin/identity-store-backups/restore', { backupId: saved.id, dryRun: false }).expect(200)).body;
    expect(real.dryRun).toBe(false);
    expect((await h.s.users.mappings(h.tenantId)).filter((m) => m.provider_id === store.id).map((m) => m.group_name)).toEqual(['finance-ops']);
    // Restoring again changes nothing more.
    const again = (await a.post('/api/admin/identity-store-backups/restore', { backupId: saved.id, dryRun: true }).expect(200)).body;
    expect(again.changes.filter((c: { action: string; what: string }) => c.action === 'create' && c.what !== 'version')).toEqual([]);

    // As a new store: created disabled for review, with the history.
    const copy = (await a.post('/api/admin/identity-store-backups/restore', { backupId: saved.id, mode: 'new', name: 'HR copy', dryRun: false }).expect(200)).body;
    const row = (await h.s.providers.get(h.tenantId, copy.target.id))!;
    expect(row).toMatchObject({ name: 'HR copy', enabled: false, kind: 'sql' });
    expect(row.config.connection).toBe('env:HR_ARCHIVE_DB');
    expect((await storeAdminFor(h.s).versions(h.tenantId, row.id)).length).toBeGreaterThanOrEqual(2);

    await a.del(`/api/admin/identity-store-backups/${saved.id}`).expect(204);
    expect(await h.s.blobs.get(StoreBackups.blobKey(h.tenantId, saved.id))).toBeNull();
    const actions = (await audits(h.tenantId, 'identity.store.backup.')).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['identity.store.backup.created', 'identity.store.backup.restore_previewed', 'identity.store.backup.restored', 'identity.store.backup.deleted']));
  });

  it('restores a local store into another tenant with password hashes and second factors, re-sealed', async () => {
    const a = await admin();
    // A local account with a TOTP factor (loginAdmin enrolled one for ida).
    const local = (await h.s.providers.list(h.tenantId)).find((p) => p.kind === 'local')!;
    const archive = (await a.post(`/api/admin/identity-providers/${local.id}/backups`, {}).expect(200)).body;
    expect(archive.counts.passwords).toBeGreaterThanOrEqual(1);
    expect(archive.counts.factors).toBeGreaterThanOrEqual(1);

    // The other tenant and its admin.
    const other = await h.s.tenants.create({ slug: 'other', name: 'Other' });
    const otherLocal = (await h.s.providers.create(other.id, { name: 'Local accounts', kind: 'local', position: 1000, enabled: true, config: {} }));
    const { hashPassword } = await import('../src/identity/passwords.js');
    const boss = await h.s.users.create(other.id, { username: 'boss', displayName: 'Boss', clearance: 'confidential' });
    await h.s.users.update(other.id, boss.id, { clearance_direct: 'confidential' });
    await h.s.db('local_credentials').insert({ user_id: boss.id, password_hash: await hashPassword(PASSWORD), updated_at: Date.now() });
    await h.s.users.upsertIdentity(boss.id, otherLocal.id, boss.id, []);
    await h.s.users.setRoles(boss.id, 'direct', ['identity-admin']);
    const request = (await import('supertest')).default;
    const { totp } = await import('../src/identity/totp.js');
    const agent = request.agent(h.app);
    const first = await agent.post('/api/auth/login').send({ username: 'boss', password: PASSWORD, tenant: 'other' });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const begin = await agent.post('/api/me/mfa/totp').set('x-csrf-token', first.body.csrf).send({});
    const confirm = await agent.post(`/api/me/mfa/totp/${begin.body.id}/confirm`).set('x-csrf-token', first.body.csrf).send({ code: totp.generate(begin.body.secret) });
    expect(confirm.status).toBe(201);
    const b = { post: (p: string, body: object) => agent.post(p).set('x-csrf-token', confirm.body.csrf).send(body) };

    const dry = (await b.post('/api/admin/identity-store-backups/restore', { archive, dryRun: true }).expect(200)).body;
    expect(dry.target).toMatchObject({ id: otherLocal.id, created: false });
    expect(dry.changes).toContainEqual({ what: 'user', action: 'create', detail: 'ida (active)' });
    expect(await h.s.users.byUsername(other.id, 'ida')).toBeUndefined();
    const done = (await b.post('/api/admin/identity-store-backups/restore', { archive, dryRun: false }).expect(200)).body;
    expect(done.changes).toContainEqual(expect.objectContaining({ what: 'recovery-codes', action: 'skip' }));
    const ida = (await h.s.users.byUsername(other.id, 'ida'))!;
    expect(ida.tenant_id).toBe(other.id);
    // The password hash came across: ida signs in to the other tenant with her password, and her TOTP factor was
    // re-sealed for its new id (it opens).
    expect((await h.s.chain.authenticate(other.id, 'ida', PASSWORD)).status).toBe('ok');
    const factor = await h.s.db('mfa_factors').where({ user_id: ida.id, kind: 'totp' }).first();
    expect(factor).toBeDefined();
    const original = await h.s.db('mfa_factors').where({ kind: 'totp' }).whereNot({ user_id: ida.id }).first();
    expect(factor.id).not.toBe(original.id);
    expect(factor.secret).not.toBe(original.secret);
    expect((await h.s.mfa.methods(ida.id))).toContain('totp');
    expect((await audits(other.id, 'identity.store.backup.restored'))[0]!.detail).toMatchObject({ sourceTenant: h.tenantId });
    // Directly granted roles are not carried: ida has none in the other tenant.
    expect(await h.s.users.roleIds(ida.id)).toEqual([]);
  });

  it('without migration 141 saving reports unavailable, and a download still works', async () => {
    await (await import('../src/db/migrations/141_identity_store_backups.js')).down(h.s.db);
    storeBackupsFor(h.s, storeAdminFor(h.s)).resetSchemaCache();
    const a = await admin();
    const { store } = await hrStore(a);
    const res = await a.post(`/api/admin/identity-providers/${store.id}/backups`, { save: true }).expect(503);
    expect(res.body.reason).toBe('migration_pending');
    expect((await a.get('/api/admin/identity-store-backups').expect(200)).body).toEqual({ available: false, backups: [] });
    await a.post(`/api/admin/identity-providers/${store.id}/backups`, {}).expect(200);
  });
});
