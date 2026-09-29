import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { harness, localUser, login, loginAdmin, PASSWORD, type Harness } from './helpers.js';

describe('tenants, workspaces and quotas', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => h.close());

  it('lets a tenant admin create a workspace, add members, and switch into it', async () => {
    await localUser(h, 'ta', ['tenant-admin'], 'confidential');
    const bob = await localUser(h, 'bob', ['member']);
    const a = await loginAdmin(h, 'ta');
    const post = (url: string, body: object) => a.agent.post(url).set('x-csrf-token', a.csrf).send(body);

    const ws = await post(`/api/admin/tenants/${h.tenantId}/workspaces`, { name: 'Finance Ops', labelCeiling: 'confidential' }).expect(201);
    expect(ws.body).toMatchObject({ name: 'Finance Ops', slug: 'finance-ops', label: 'confidential', visibility: 'members' });
    await post(`/api/admin/tenants/${h.tenantId}/workspaces`, { name: 'Top', labelCeiling: 'restricted' }).expect(403);
    await post(`/api/admin/tenants/${h.tenantId}/workspaces`, { name: 'Finance Ops' }).expect(409);

    // bob sees nothing until he is a member
    const b = await login(h, 'bob');
    expect((await b.agent.get('/api/me').expect(200)).body.workspaces).toEqual([]);
    await post(`/api/admin/tenants/${h.tenantId}/workspaces/${ws.body.id}/members`, { userId: bob.id }).expect(201);
    const me = await b.agent.get('/api/me').expect(200);
    expect(me.body.workspaces.map((w: { name: string }) => w.name)).toEqual(['Finance Ops']);
    expect(me.body.workspace).toBe(ws.body.id);
    await b.agent.put('/api/me/workspace').set('x-csrf-token', b.csrf).send({ workspaceId: ws.body.id }).expect(200);

    const members = await a.agent.get(`/api/admin/tenants/${h.tenantId}/workspaces/${ws.body.id}/members`).expect(200);
    expect(members.body).toMatchObject([{ username: 'bob', sources: ['direct'] }]);

    const list = await a.agent.get('/api/admin/tenants').expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].workspaces[0]).toMatchObject({ name: 'Finance Ops', members: 1 });
    expect(list.body[0].key).toMatchObject({ kms: 'local' });

    const events = await h.s.audit.list(h.tenantId, { action: 'workspace.' });
    expect(events.map((e) => e.action).sort()).toEqual(['workspace.created', 'workspace.member.added']);
  });

  it('keeps tenant admins inside their tenant and reserves tenant creation for system admins', async () => {
    await localUser(h, 'ta', ['tenant-admin'], 'confidential');
    const a = await loginAdmin(h, 'ta');
    await a.agent.post('/api/admin/tenants').set('x-csrf-token', a.csrf).send({ slug: 'contoso', name: 'Contoso' }).expect(403);
    const other = await h.s.tenants.create({ slug: 'other', name: 'Other' });
    const r = await a.agent.get(`/api/admin/tenants/${other.id}/workspaces`).expect(403);
    expect(r.body.step).toBe('tenant');
    await a.agent.put(`/api/admin/tenants/${h.tenantId}/quota`).set('x-csrf-token', a.csrf).send({ tokensPerDay: 10 }).expect(403);
  });

  it('gives workspace membership through group mappings at sign-in', async () => {
    await localUser(h, 'ta', ['tenant-admin'], 'confidential');
    const a = await loginAdmin(h, 'ta');
    const ws = await a.agent.post(`/api/admin/tenants/${h.tenantId}/workspaces`).set('x-csrf-token', a.csrf).send({ name: 'People Ops', mapping: { group: 'cn=hr', role: 'member', clearance: 'internal' } }).expect(201);
    const mappings = (await a.agent.get('/api/admin/group-mappings').expect(200)).body;
    expect(mappings[0]).toMatchObject({ group_name: 'cn=hr', workspace_id: ws.body.id });
  });

  it('refuses requests over quota with 429 and Retry-After naming the limit', async () => {
    const w = await h.s.tenants.createWorkspace(h.tenantId, 'Field Sales', 'internal');
    await h.s.quotas.set(h.tenantId, w.id, { tokensPerDay: 1000 }, 'test');
    await h.s.quotas.admit(h.tenantId, w.id);
    await h.s.quotas.record({ tenantId: h.tenantId, workspaceId: w.id, userId: null, kind: 'chat', promptTokens: 600, outputTokens: 400 });
    const err = await h.s.quotas.admit(h.tenantId, w.id, { workspaceName: 'Field Sales' }).catch((e) => e);
    expect(err.status).toBe(429);
    expect(Number(err.headers['Retry-After'])).toBeGreaterThan(0);
    expect(err.extensions).toMatchObject({ limit: 'tokens_per_day', scope: 'workspace', used: 1000, max: 1000, raised_by: 'a tenant admin' });
    // the tenant total applies across workspaces too
    const w2 = await h.s.tenants.createWorkspace(h.tenantId, 'Other', 'internal');
    await h.s.quotas.set(h.tenantId, null, { gpuSecondsPerMonth: 1 }, 'test');
    await h.s.quotas.record({ tenantId: h.tenantId, workspaceId: w2.id, userId: null, kind: 'chat', gpuMs: 1500 });
    const err2 = await h.s.quotas.admit(h.tenantId, w2.id).catch((e) => e);
    expect(err2.extensions).toMatchObject({ limit: 'gpu_seconds_per_month', scope: 'tenant' });
  });

  it('lets system admins set tenant totals and caps workspace limits under them', async () => {
    await localUser(h, 'root', ['system-admin'], 'restricted');
    const a = await loginAdmin(h, 'root');
    const put = (url: string, body: object) => a.agent.put(url).set('x-csrf-token', a.csrf).send(body);
    await put(`/api/admin/tenants/${h.tenantId}/quota`, { tokensPerDay: 5000 }).expect(200);
    const w = await h.s.tenants.createWorkspace(h.tenantId, 'Finance', 'internal');
    await put(`/api/admin/tenants/${h.tenantId}/workspaces/${w.id}/quota`, { tokensPerDay: 6000 }).expect(400);
    const q = await put(`/api/admin/tenants/${h.tenantId}/workspaces/${w.id}/quota`, { tokensPerDay: 2000, gpuSecondsPerMonth: 100 }).expect(200);
    expect(q.body).toMatchObject({ scope: 'workspace', tokensPerDay: 2000, gpuSecondsPerMonth: 100, used: { tokensToday: 0 } });
  });

  it('offboards a tenant: destroys its key, ends sessions and purges derived data', async () => {
    await localUser(h, 'root', ['system-admin'], 'restricted');
    const a = await loginAdmin(h, 'root');
    const created = await a.agent.post('/api/admin/tenants').set('x-csrf-token', a.csrf).send({ slug: 'contoso', name: 'Contoso Freight' }).expect(201);
    const tid = created.body.id;
    const sealed = await h.s.keys.seal(tid, 'conversation body', 'm1');
    await h.s.blobs.put(`exports/${tid}/x.csv.sealed`, Buffer.from('x'));
    await a.agent.post(`/api/admin/tenants/${tid}/offboard`).set('x-csrf-token', a.csrf).send({ confirm: 'Contoso' }).expect(400);
    const r = await a.agent.post(`/api/admin/tenants/${tid}/offboard`).set('x-csrf-token', a.csrf).send({ confirm: 'Contoso Freight' }).expect(202);
    expect(r.body.keyVersionsDestroyed).toBe(1);
    await expect(h.s.keys.open(tid, sealed, 'm1')).rejects.toThrow(/destroyed/);
    await h.s.jobs.runDue();
    expect(await h.s.blobs.get(`exports/${tid}/x.csv.sealed`)).toBeNull();
    expect((await h.s.tenants.byId(tid))?.state).toBe('disabled');
    await a.agent.post(`/api/admin/tenants/${h.tenantId}/offboard`).set('x-csrf-token', a.csrf).send({ confirm: 'Default' }).expect(403);
  });

  it('explains the policy decision step by step', async () => {
    await localUser(h, 'ta', ['tenant-admin'], 'confidential');
    const m = await localUser(h, 'mem', ['member'], 'internal');
    const a = await loginAdmin(h, 'ta');
    const r = await a.agent.post('/api/admin/authz/evaluate').set('x-csrf-token', a.csrf).send({ userId: m.id, action: 'tools:invoke', label: 'confidential' }).expect(200);
    expect(r.body.decision).toMatchObject({ allow: false, step: 'clearance' });
    expect(r.body.steps.map((x: { step: string; ok: boolean }) => `${x.step}:${x.ok}`)).toEqual(['role:true', 'scope:true', 'tenant:true', 'clearance:false', 'zone:true']);
  });
});

describe('audit: checkpoints, corrections, exports, notifications', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => h.close());

  it('verifies against signed checkpoints and notifies when the chain is broken', async () => {
    await localUser(h, 'aud', ['auditor'], 'confidential');
    const a = await loginAdmin(h, 'aud');
    for (let i = 0; i < 3; i++) await h.s.audit.append({ tenantId: h.tenantId, action: 'test.event', kind: 'admin', actor: { user: 'x' } });
    const cp = await a.agent.post('/api/admin/audit/checkpoints').set('x-csrf-token', a.csrf).send({}).expect(201);
    expect(cp.body.seq).toBeGreaterThan(3);
    let v = await a.agent.post('/api/admin/audit/verify').set('x-csrf-token', a.csrf).send({}).expect(200);
    expect(v.body).toMatchObject({ status: 'verified', checkpoints: { checked: 1, failed: [] } });
    expect(v.body.lastGoodCheckpoint.seq).toBe(cp.body.seq);

    // Rewrite history consistently (recomputing every hash): only the signed checkpoint catches it.
    const { hashEvent, rowToEvent } = await import('../src/audit/chain.js');
    const rows = await h.s.db('audit_events').where({ tenant_id: h.tenantId }).orderBy('seq');
    let prev = '0'.repeat(64);
    for (const row of rows) {
      const e = rowToEvent(row);
      const { hash: _old, ...rest } = e;
      if (e.seq === 2) rest.detail = { forged: true };
      rest.prev_hash = prev;
      const hash = hashEvent(rest);
      await h.s.db('audit_events').where({ id: e.id }).update({ detail: rest.detail ? JSON.stringify(rest.detail) : null, prev_hash: prev, hash });
      prev = hash;
    }
    v = await a.agent.post('/api/admin/audit/verify').set('x-csrf-token', a.csrf).send({}).expect(200);
    expect(v.body.status).toBe('broken');
    expect(v.body.checkpoints.failed[0].reason).toMatch(/different hash/);
    expect(v.body.notified).toContain('aud');
    const n = await a.agent.get('/api/me/notifications').expect(200);
    expect(n.body.items[0]).toMatchObject({ kind: 'audit.broken', route: 'usage-audit', read: false });
    await a.agent.post('/api/me/notifications/read').set('x-csrf-token', a.csrf).send({}).expect(200);
    expect((await a.agent.get('/api/me/notifications').expect(200)).body.items[0].read).toBe(true);
  });

  it('records corrections as new rows linked to the original', async () => {
    await localUser(h, 'ta', ['tenant-admin', 'auditor'], 'confidential');
    const a = await loginAdmin(h, 'ta');
    const orig = await h.s.audit.append({ tenantId: h.tenantId, action: 'guardrail.rule.updated', kind: 'admin', actor: { user: 'someone' }, detail: { version: 3 } });
    const c = await a.agent.post(`/api/admin/audit/${orig.id}/corrections`).set('x-csrf-token', a.csrf).send({ reason: 'Recorded as 3; the saved version is 4.', correction: { version: 4 } }).expect(201);
    expect(c.body).toMatchObject({ kind: 'correction', corrects: orig.id });
    const e = await a.agent.get(`/api/admin/audit/${orig.id}`).expect(200);
    expect(e.body.detail).toEqual({ version: 3 });
    expect(e.body.correctedBy[0].id).toBe(c.body.id);
    await a.agent.post(`/api/admin/audit/${c.body.id}/corrections`).set('x-csrf-token', a.csrf).send({ reason: 'correcting a correction' }).expect(403);
  });

  it('blocks exports above the auditor\'s clearance and produces the filtered CSV', async () => {
    await localUser(h, 'aud', ['auditor'], 'internal');
    const a = await loginAdmin(h, 'aud');
    await h.s.audit.append({ tenantId: h.tenantId, action: 'secret.read', kind: 'decision', actor: { user: 'x' }, label: 'confidential', detail: { doc: 'm&a plan' } });
    await h.s.audit.append({ tenantId: h.tenantId, action: 'plain.read', kind: 'decision', actor: { user: 'x' }, label: 'internal', detail: { doc: '=cmd' } });
    const blocked = await a.agent.post('/api/admin/audit/exports').set('x-csrf-token', a.csrf).send({}).expect(403);
    expect(blocked.body).toMatchObject({ title: 'Export blocked', above: 1, clearance: 'internal' });
    const x = await a.agent.post('/api/admin/audit/exports').set('x-csrf-token', a.csrf).send({ filtered: true }).expect(202);
    expect(x.body).toMatchObject({ state: 'queued', omitted: 1, maxLabel: 'internal' });
    await h.s.jobs.runDue();
    const list = await a.agent.get('/api/admin/exports').expect(200);
    expect(list.body[0]).toMatchObject({ id: x.body.id, state: 'ready', omitted: 1 });
    const csv = await a.agent.get(`/api/admin/exports/${x.body.id}/download`).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('plain.read');
    expect(csv.text).not.toContain('secret.read');
    // stored sealed, never as plain CSV
    const row = await h.s.db('exports').where({ id: x.body.id }).first();
    expect((await h.s.blobs.get(row.blob_key))!.toString()).toMatch(/^v2\./);
    expect((await h.s.audit.list(h.tenantId, { action: 'export.downloaded' })).length).toBe(1);
  });

  it('reports usage by user and day, and quotas per workspace', async () => {
    await localUser(h, 'aud', ['auditor'], 'internal');
    const u = await localUser(h, 'bob', ['member']);
    const w = await h.s.tenants.createWorkspace(h.tenantId, 'Finance', 'internal');
    await h.s.quotas.record({ tenantId: h.tenantId, workspaceId: w.id, userId: u.id, kind: 'chat', model: 'llama3.1:8b', promptTokens: 100, outputTokens: 50, gpuMs: 2000 });
    await h.s.quotas.record({ tenantId: h.tenantId, workspaceId: w.id, userId: u.id, kind: 'chat', model: 'llama3.1:8b', promptTokens: 10, outputTokens: 5, ts: Date.now() - 86_400_000 });
    const a = await loginAdmin(h, 'aud');
    const sum = await a.agent.get('/api/admin/usage/summary?by=user&days=7').expect(200);
    expect(sum.body.rows[0]).toMatchObject({ name: 'BOB', prompt: 110, output: 55, requests: 2 });
    const daily = await a.agent.get('/api/admin/usage/daily?days=3').expect(200);
    expect(daily.body).toHaveLength(3);
    expect(daily.body[2].tokens).toBe(150);
    expect(daily.body[1].tokens).toBe(15);
    const q = await a.agent.get('/api/admin/quotas').expect(200);
    expect(q.body.workspaces[0]).toMatchObject({ name: 'Finance', used: { tokensToday: 150, gpuSecondsMonth: 2 } });
    await a.agent.get('/api/admin/usage/summary?by=tenant').expect(403);
  });

  it('streams audit events to the SIEM as NDJSON', async () => {
    const { SiemForwarder } = await import('../src/audit/siem.js');
    const bodies: string[] = [];
    const f = new SiemForwarder(h.s.audit, h.s.log, { send: async (b) => void bodies.push(b) });
    await h.s.audit.append({ tenantId: h.tenantId, action: 'a.one', kind: 'admin', actor: {} });
    await h.s.audit.append({ tenantId: h.tenantId, action: 'a.two', kind: 'admin', actor: {} });
    await f.flush();
    const lines = bodies.join('').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.action)).toEqual(['a.one', 'a.two']);
    expect(f.view()).toMatchObject({ state: 'connected', delivered: 2, pending: 0 });
    f.close();
  });
});

describe('directory sync', () => {
  let h: Harness;
  let dir: string;
  let file: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'exprsn-sync-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  beforeEach(async () => {
    h = await harness();
    file = path.join(dir, `hr-${Date.now()}.sqlite`);
    const db = new Database(file);
    db.exec('CREATE TABLE staff (id INTEGER PRIMARY KEY, login TEXT, pw TEXT, full_name TEXT, grp TEXT)');
    const hash = bcrypt.hashSync(PASSWORD, 4);
    const ins = db.prepare('INSERT INTO staff (login, pw, full_name, grp) VALUES (?, ?, ?, ?)');
    ins.run('ann', hash, 'Ann', 'finance');
    ins.run('ben', hash, 'Ben', 'finance');
    ins.run('cat', hash, 'Cat', 'finance');
    db.close();
    process.env.SYNC_HR_DB = file;
    const p = await h.s.providers.create(h.tenantId, { name: 'HR', kind: 'sql', position: 10, enabled: true, config: { dialect: 'sqlite', connection: 'env:SYNC_HR_DB', table: 'staff', columns: { id: 'id', username: 'login', passwordHash: 'pw', displayName: 'full_name', groups: 'grp' } } });
    const w = await h.s.tenants.createWorkspace(h.tenantId, 'Finance', 'internal');
    await h.s.users.addMapping(h.tenantId, { providerId: p.id, group: 'finance', role: 'member', clearance: 'internal', workspaceId: w.id });
  });
  afterEach(() => h.close());

  it('disables users removed from the store or from every mapped group, and ends their sessions', async () => {
    const ann = await login(h, 'ann');
    expect(ann.res.status).toBe(200);
    const annUser = (await h.s.users.byUsername(h.tenantId, 'ann'))!;
    expect(await h.s.users.workspaceIds(annUser.id)).toHaveLength(1);
    await login(h, 'ben');
    await login(h, 'cat');
    const db = new Database(file);
    db.prepare("DELETE FROM staff WHERE login = 'ann'").run();
    db.prepare("UPDATE staff SET grp = 'sales' WHERE login = 'ben'").run();
    db.close();
    await h.s.chain.close(); // drop the cached connection so the edit is visible

    const job = await h.s.jobs.enqueue({ tenantId: h.tenantId, type: 'directory.sync', payload: { tenantId: h.tenantId } });
    await h.s.jobs.runDue();
    const done = await h.s.jobs.get(h.tenantId, job.id);
    expect(done?.state).toBe('succeeded');
    const [report] = done!.result as { disabled: { username: string; reason: string }[]; checked: number }[];
    expect(report!.checked).toBe(3);
    expect(report!.disabled.map((d) => `${d.username}: ${d.reason}`).sort()).toEqual(['ann: Not found in the directory', 'ben: No longer in any mapped group']);
    expect((await h.s.users.byUsername(h.tenantId, 'cat'))?.state).toBe('active');
    await ann.agent.get('/api/me').expect(401);
    const ev = await h.s.audit.list(h.tenantId, { action: 'user.disabled' });
    expect(ev[0]?.actor).toEqual({ service: 'directory-sync' });
  });

  it('changes nobody when the store cannot be read', async () => {
    await login(h, 'ann');
    process.env.SYNC_HR_DB = path.join(dir, 'missing.sqlite');
    await h.s.chain.close();
    const [report] = await h.s.sync.syncTenant(h.tenantId);
    expect(report!.aborted).toMatch(/could not be read/);
    expect((await h.s.users.byUsername(h.tenantId, 'ann'))?.state).toBe('active');
  });
});
