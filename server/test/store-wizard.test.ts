import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { formFor, kindView, layoutDrift, passwordStoreTest, registerStoreKind, storeKind, storeKinds, type StoreKindDefinition } from '../src/identity/providers/kinds.js';
import { secretRef } from '../src/identity/providers/types.js';
import { storeAdminFor } from '../src/identity/store-admin.js';
import { harness, localUser, loginAdmin, PASSWORD, type Harness } from './helpers.js';

/*
 * 1.9.0, Sprint 54 (B-181): the store wizard and form editor. The kind registry and the forms it generates from each
 * kind's zod schema; each wizard step (kind or preset, connection, attributes and groups, sign-in order, test with a
 * real account, review and save); the test's credentials are used once and never stored; "test before save" refuses
 * (409); saved changes become versions with a diff. Migration 140 is applied here by hand until it is registered.
 */

const BUILT_IN = ['local', 'ldap', 'sql', 'oidc', 'saml', 'atproto', 'github', 'scim'];

async function install(h: Harness): Promise<void> {
  if (!(await h.s.db.schema.hasColumn('identity_providers', 'state'))) await (await import('../src/db/migrations/140_identity_store_state.js')).up(h.s.db);
  storeAdminFor(h.s).resetSchemaCache();
}

describe('the store kind registry', () => {
  it('has every built-in kind, each form generated from its zod schema without drift', () => {
    for (const k of BUILT_IN) expect(storeKind(k), k).toBeDefined();
    for (const def of storeKinds()) {
      expect(layoutDrift(def), def.kind).toEqual([]);
      const sections = formFor(def);
      expect(sections.length, def.kind).toBeGreaterThan(0);
      for (const sec of sections) expect(['connection', 'attributes']).toContain(sec.step);
    }
  });

  it('types the fields from the schema: secrets as references, enums as choices, required from zod', () => {
    const ldap = formFor(storeKind('ldap')!).flatMap((s) => s.fields);
    const field = (k: string) => ldap.find((f) => f.key === k)!;
    expect(field('bindPassword')).toMatchObject({ type: 'secret', required: true, label: 'Service account password' });
    expect(field('bindPassword').accepts).toContain('vault:path#key');
    expect(field('groupMode')).toMatchObject({ type: 'select', options: ['memberOf', 'search'], default: 'search', required: false });
    expect(field('startTLS').type).toBe('boolean');
    expect(field('timeoutMs')).toMatchObject({ type: 'number', min: 500, max: 30000, advanced: true });
    expect(field('defaultRoles')).toMatchObject({ type: 'multiselect' });
    const sql = formFor(storeKind('sql')!).flatMap((s) => s.fields);
    expect(sql.find((f) => f.key === 'columns.username')).toMatchObject({ type: 'text', required: true });
    expect(sql.find((f) => f.key === 'connection')!.type).toBe('secret');
  });

  it('plugs in a new kind by its schema alone; unplaced fields land under Other settings', () => {
    const def: StoreKindDefinition = {
      kind: 'test-kind',
      title: 'A test kind',
      config: z.object({ host: z.string().min(1), secret: secretRef, mode: z.enum(['a', 'b']).default('a'), extra: z.boolean().default(false) }).strict(),
      schema: { sections: [{ id: 'connection', title: 'Connection', step: 'connection', fields: ['host', { key: 'secret', label: 'Secret' }, 'missing'] }] },
      presets: [{ id: 'p1', title: 'Preset', config: { host: 'h' } }],
      signIn: 'password',
      test: passwordStoreTest
    };
    registerStoreKind(def);
    expect(layoutDrift(def)).toEqual(['missing']);
    const view = kindView(def);
    expect(view.sections.map((s) => s.id)).toEqual(['connection', 'other']);
    expect(view.sections[0]!.fields.map((f) => [f.key, f.type])).toEqual([['host', 'text'], ['secret', 'secret']]);
    expect(view.sections[1]!.fields.map((f) => f.key)).toEqual(['mode', 'extra']);
    expect(view.presets[0]!.id).toBe('p1');
    expect(JSON.stringify(view)).not.toMatch(/function/);
  });
});

describe('the store wizard', () => {
  let h: Harness;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'exprsn-wizard-'));
    const file = path.join(dir, 'hr.sqlite');
    const db = new Database(file);
    db.exec('CREATE TABLE staff (id INTEGER PRIMARY KEY, login TEXT, pw TEXT, full_name TEXT, grp TEXT)');
    db.prepare('INSERT INTO staff (login, pw, full_name, grp) VALUES (?, ?, ?, ?)').run('jdoe', bcrypt.hashSync(PASSWORD, 10), 'Jane Doe', 'finance-ops');
    db.close();
    process.env.HR_WIZ_DB = file;
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => h.close());

  const SQL = { dialect: 'sqlite', connection: 'env:HR_WIZ_DB', table: 'staff', columns: { id: 'id', username: 'login', passwordHash: 'pw', displayName: 'full_name', groups: 'grp' } };

  const admin = async () => {
    await localUser(h, 'ida', ['identity-admin'], 'confidential');
    const a = await loginAdmin(h, 'ida');
    return {
      ...a,
      get: (p: string) => a.agent.get(p),
      post: (p: string, b: object) => a.agent.post(p).set('x-csrf-token', a.csrf).send(b),
      put: (p: string, b: object) => a.agent.put(p).set('x-csrf-token', a.csrf).send(b),
      patch: (p: string, b: object) => a.agent.patch(p).set('x-csrf-token', a.csrf).send(b)
    };
  };
  const audits = async (prefix: string) => ((await h.s.audit.list(h.tenantId, { limit: 500 })) as { action: string; detail: Record<string, unknown> | null; target: Record<string, unknown> }[]).filter((e) => e.action.startsWith(prefix));

  it('step 1: lists the kinds with their forms and presets, behind identity:manage', async () => {
    await localUser(h, 'mem', ['member']);
    const m = await (await import('./helpers.js')).login(h, 'mem');
    await m.agent.get('/api/admin/identity-store-kinds').expect(403);
    const a = await admin();
    const res = (await a.get('/api/admin/identity-store-kinds').expect(200)).body;
    expect(res.kinds.map((k: { kind: string }) => k.kind)).toEqual(expect.arrayContaining(BUILT_IN));
    const sql = res.kinds.find((k: { kind: string }) => k.kind === 'sql');
    expect(sql.signIn).toBe('password');
    expect(sql.presets.map((p: { id: string }) => p.id)).toEqual(['pg', 'mysql', 'sqlite']);
    expect(res.archive).toBe(true); // migration 140 is registered (2026-10-18), so the harness has it
  });

  it('steps 2 and 3: checks a configuration step by step and returns it with its defaults', async () => {
    const a = await admin();
    // The connection step alone: the missing columns (an attributes field) do not count yet.
    const conn = (await a.post('/api/admin/identity-store-kinds/sql/check', { step: 'connection', config: { dialect: 'sqlite', connection: 'env:HR_WIZ_DB', table: 'staff' } }).expect(200)).body;
    expect(conn.ok).toBe(true);
    const attrs = (await a.post('/api/admin/identity-store-kinds/sql/check', { step: 'attributes', config: { dialect: 'sqlite', connection: 'env:HR_WIZ_DB', table: 'staff' } }).expect(200)).body;
    expect(attrs.ok).toBe(false);
    expect(attrs.errors.map((e: { path: string }) => e.path)).toContain('config.columns');
    const bad = (await a.post('/api/admin/identity-store-kinds/ldap/check', { step: 'connection', config: { url: 'ldaps://x', bindDN: 'cn=x', bindPassword: 'hunter2', userBase: 'ou=p' } }).expect(200)).body;
    expect(bad.errors).toContainEqual({ path: 'config.bindPassword', message: expect.stringMatching(/secret reference/) });
    const full = (await a.post('/api/admin/identity-store-kinds/sql/check', { config: SQL }).expect(200)).body;
    expect(full).toMatchObject({ ok: true, config: { caseInsensitive: true, timeoutMs: 5000, defaultClearance: 'internal' } });
    await a.post('/api/admin/identity-store-kinds/nope/check', { config: {} }).expect(404);
  });

  it('step 5: tests with a real account; the password is never stored, logged or audited', async () => {
    const a = await admin();
    const secret = 'correct horse battery staple';
    const ok = (await a.post('/api/admin/identity-store-kinds/sql/test', { config: SQL, credentials: { username: 'jdoe', password: secret } }).expect(200)).body;
    expect(ok).toMatchObject({ ok: true, result: 'ok', user: { externalId: '1', username: 'jdoe', displayName: 'Jane Doe', groups: ['finance-ops'] } });
    const wrong = (await a.post('/api/admin/identity-store-kinds/sql/test', { config: SQL, credentials: { username: 'jdoe', password: 'not the password' } }).expect(200)).body;
    expect(wrong).toMatchObject({ ok: false, result: 'invalid' });
    const lookup = (await a.post('/api/admin/identity-store-kinds/sql/test', { config: SQL, credentials: { username: 'jdoe' } }).expect(200)).body;
    expect(lookup).toMatchObject({ ok: true, result: 'found' });
    const nobody = (await a.post('/api/admin/identity-store-kinds/sql/test', { config: SQL, credentials: { username: 'nobody' } }).expect(200)).body;
    expect(nobody).toMatchObject({ ok: false, result: 'not_found' });
    const unreachable = (await a.post('/api/admin/identity-store-kinds/sql/test', { config: { ...SQL, connection: 'env:NOT_SET_ANYWHERE' } }).expect(200)).body;
    expect(unreachable.ok).toBe(false);
    // Nothing was saved, and the password appears nowhere in the database (audit chain included).
    expect((await h.s.providers.list(h.tenantId)).map((p) => p.kind)).toEqual(['local']);
    const tables = ['audit_events', 'identity_providers', 'users', 'user_identities', 'login_throttle'];
    for (const t of tables) if (await h.s.db.schema.hasTable(t)) expect(JSON.stringify(await h.s.db(t).select('*')), t).not.toContain(secret);
    const tested = await audits('identity.store.wizard_tested');
    expect(tested.length).toBe(5);
    expect(tested.map((e) => e.detail!.result)).toEqual(expect.arrayContaining(['ok', 'invalid', 'found', 'not_found']));
    expect(tested.find((e) => e.detail!.result === 'ok')!.target).toMatchObject({ kind: 'sql', username: 'jdoe' });
  });

  it('step 4 and save: creates with test before save, records version 1 and puts it in the sign-in order', async () => {
    await install(h);
    const a = await admin();
    // A configuration that cannot find the test user is refused, and nothing is saved.
    const refused = await a.post('/api/admin/identity-providers', { name: 'HR', kind: 'sql', config: SQL, test: { username: 'nobody' } }).expect(409);
    expect(refused.headers['content-type']).toMatch(/problem\+json/);
    expect(refused.body).toMatchObject({ reason: 'test_failed', result: 'not_found' });
    expect((await h.s.providers.list(h.tenantId)).length).toBe(1);
    const created = (await a.post('/api/admin/identity-providers', { name: 'HR', kind: 'sql', position: 50, config: SQL, reason: 'HR directory for finance', test: { username: 'jdoe', password: PASSWORD } }).expect(201)).body;
    expect(created).toMatchObject({ name: 'HR', state: 'active', enabled: true });
    const createdAudit = (await audits('identity.provider.created'))[0]!;
    expect(createdAudit.detail).toMatchObject({ version: 1, reason: 'HR directory for finance', tested: { username: 'jdoe', result: 'ok' } });
    expect(JSON.stringify(createdAudit)).not.toContain(PASSWORD);

    // The sign-in order: the new store first, then the local accounts.
    const local = (await h.s.providers.list(h.tenantId)).find((p) => p.kind === 'local')!;
    await a.put('/api/admin/identity-providers/order', { ids: [local.id] }).expect(400);
    const order = (await a.put('/api/admin/identity-providers/order', { ids: [created.id, local.id], reason: 'HR first' }).expect(200)).body;
    expect(order.map((x: { id: string; position: number }) => [x.id, x.position])).toEqual([[created.id, 10], [local.id, 20]]);
    const chain = await h.s.chain.authenticate(h.tenantId, 'jdoe', PASSWORD);
    expect(chain.status === 'ok' && chain.provider.id).toBe(created.id);

    // Each saved change is a version, with a diff and the reason.
    await a.patch(`/api/admin/identity-providers/${created.id}`, { config: { ...SQL, defaultRoles: ['member'] }, reason: 'everyone a member' }).expect(200);
    const versions = (await a.get(`/api/admin/identity-providers/${created.id}/versions`).expect(200)).body;
    expect(versions.available).toBe(true);
    expect(versions.versions.map((v: { version: number; reason: string }) => [v.version, v.reason])).toEqual([[3, 'everyone a member'], [2, 'HR first'], [1, 'HR directory for finance']]);
    expect(versions.versions[0].changes).toContainEqual({ path: 'config.defaultRoles', before: [], after: ['member'] });
    expect(versions.versions[1].changes).toEqual([{ path: 'position', before: 50, after: 10 }]);
    expect(versions.versions[2].changes.some((c: { path: string }) => c.path === 'config.connection')).toBe(true);
  });

  it('a platform kind also needs platform:manage', async () => {
    const platformKind = storeKinds().find((k) => k.platform);
    if (!platformKind) return; // B-184 registers one (exprsn-platform)
    const a = await admin();
    const refused = await a.post('/api/admin/identity-providers', { name: 'Platform', kind: platformKind.kind, config: {} }).expect(403);
    expect(refused.body).toMatchObject({ step: 'role', action: 'platform:manage' });
    await a.post(`/api/admin/identity-store-kinds/${platformKind.kind}/test`, { config: {} }).expect(403);
  });

  it('without migration 140 the wizard still creates stores, and versions report as unavailable', async () => {
    // The harness runs 140 and 141 since they were registered: roll them back to see the services without them.
    await (await import('../src/db/migrations/141_identity_store_backups.js')).down(h.s.db);
    await (await import('../src/db/migrations/140_identity_store_state.js')).down(h.s.db);
    const a = await admin();
    const created = (await a.post('/api/admin/identity-providers', { name: 'HR', kind: 'sql', config: SQL, test: { username: 'jdoe' } }).expect(201)).body;
    expect(created.state).toBe('active');
    const versions = (await a.get(`/api/admin/identity-providers/${created.id}/versions`).expect(200)).body;
    expect(versions).toEqual({ available: false, versions: [] });
    const archived = await a.post(`/api/admin/identity-providers/${created.id}/archive`, {}).expect(503);
    expect(archived.body.reason).toBe('migration_pending');
  });
});
