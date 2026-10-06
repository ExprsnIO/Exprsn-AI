/*
 * Sprint 35d (1.6.0, B-4501): tenant provisioning templates. A system admin creates a tenant from the enterprise,
 * team or personal template (workspaces, member-baseline custom roles, draft profiles pinned to a pool in the
 * template's zone, an issuing CA when the platform has a root) with its first admin in one step; the first admin then
 * signs in, with a password or with the single-use enrolment link.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startSigner } from '../src/signer/server.js';
import { provisionTenant } from '../src/tenancy/templates.js';
import { harness, localUser, loginAdmin, PASSWORD, type Harness } from './helpers.js';

async function admin(h: Harness, username: string, roles: string[]) {
  await localUser(h, username, roles, 'restricted');
  const c = await loginAdmin(h, username);
  return {
    ...c,
    get: (p: string) => c.agent.get(p),
    post: (p: string, b: object = {}) => c.agent.post(p).set('x-csrf-token', c.csrf).send(b)
  };
}

const adminBody = (username: string, password: string | null = null) => ({ username, displayName: username.toUpperCase(), email: `${username}@example.test`, password });

describe('Sprint 35d: tenant provisioning templates', () => {
  let h: Harness;
  let sys: Awaited<ReturnType<typeof admin>>;
  let ta: Awaited<ReturnType<typeof admin>>;

  beforeAll(async () => {
    h = await harness();
    sys = await admin(h, 'root', ['system-admin']);
    ta = await admin(h, 'ta', ['tenant-admin']);
    // A pool in the inference zone that may process confidential data, so profiles are pinned.
    await h.s.gateway.repo.createPool({ name: 'gpu-a', description: null, accelerator: 'cuda', zone: 'inference', labelCeiling: 'confidential' });
  }, 60_000);
  afterAll(async () => {
    await h.close();
  });

  it('lists the three templates with what each creates', async () => {
    const r = await sys.get('/api/admin/tenant-templates');
    expect(r.status).toBe(200);
    expect(r.body.map((t: { id: string }) => t.id)).toEqual(['enterprise', 'team', 'personal']);
    const team = r.body.find((t: { id: string }) => t.id === 'team');
    expect(team).toMatchObject({ name: 'Team', zone: 'inference', issuer: true, adminClearance: 'internal' });
    expect(team.workspaces.map((w: { name: string }) => w.name)).toEqual(['Team', 'Projects']);
    const personal = r.body.find((t: { id: string }) => t.id === 'personal');
    expect(personal).toMatchObject({ roles: [], issuer: false, adminClearance: 'confidential' });
  });

  it('only a system admin provisions a tenant; the body is validated', async () => {
    const body = { template: 'team', slug: 'nope', name: 'Nope', admin: adminBody('nope') };
    const r = await ta.post('/api/admin/tenants/from-template', body);
    expect(r.status).toBe(403);
    expect(r.body.step).toBe('role');
    expect((await sys.post('/api/admin/tenants/from-template', { ...body, template: 'galaxy' })).status).toBe(400);
    expect((await sys.post('/api/admin/tenants/from-template', { ...body, admin: { ...adminBody('nope'), password: 'short' } })).status).toBe(422);
    expect(await h.s.tenants.bySlug('nope')).toBeUndefined();
  });

  it('B-4501: a tenant from the team template signs in with its first admin in one step', async () => {
    const pw = 'a long and unusual team password 7';
    const r = await sys.post('/api/admin/tenants/from-template', { template: 'team', slug: 'acme', name: 'Acme', admin: adminBody('ada', pw) });
    expect(r.status).toBe(201);
    expect(r.body.tenant).toMatchObject({ slug: 'acme', name: 'Acme', state: 'active' });
    expect(r.body.tenant.workspaces.map((w: { name: string; label: string }) => [w.name, w.label])).toEqual([['Projects', 'internal'], ['Team', 'internal']]);
    expect(r.body.applied.roles.map((x: { name: string }) => x.name)).toEqual(['Contributor']);
    expect(r.body.applied.profiles).toHaveLength(1);
    expect(r.body.applied.zone).toMatchObject({ id: 'inference', state: 'pinned', poolName: 'gpu-a' });
    // No platform root (and no key custody here): the CA is skipped with the reason, the tenant is not failed.
    expect(r.body.applied.issuer).toMatchObject({ state: 'skipped', id: null });
    expect(r.body.admin).toMatchObject({ username: 'ada', roles: ['tenant-admin'], clearance: 'internal', enrolLink: null });

    const t = (await h.s.tenants.bySlug('acme'))!;
    const prof = (await h.s.gateway.repo.profiles(t.id))[0]!;
    expect(prof).toMatchObject({ name: 'assistant', status: 'draft', model_id: null, label: 'internal' });
    expect(prof.pool_id).toBeTruthy();
    const role = (await h.s.customRoles.list(t.id))[0]!.role;
    expect(role).toMatchObject({ name: 'Contributor', state: 'active', current_version: 1 });
    // Every part is audited in the new tenant's chain, and the summary in the provisioning admin's too.
    const actions = ((await h.s.db('audit_events').where({ tenant_id: t.id }).select('action')) as { action: string }[]).map((e) => e.action);
    for (const a of ['tenant.created', 'workspace.created', 'authz.role.created', 'profile.created', 'user.created', 'workspace.member.added', 'tenant.template.applied']) expect(actions).toContain(a);
    expect(await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'tenant.template.applied' }).first('id')).toBeTruthy();
    expect((await h.s.audit.verify(t.id)).status).toBe('verified');

    // The first admin signs in to the new tenant with the password; as an admin they enrol a second factor next.
    const agent = request.agent(h.app);
    const login = await agent.post('/api/auth/login').send({ tenant: 'acme', username: 'ada', password: pw });
    expect(login.status).toBe(200);
    expect(login.body.stage).toBe('enroll');
    // The same username in the default tenant is unknown: the tenant is its own.
    expect((await request(h.app).post('/api/auth/login').send({ username: 'ada', password: pw })).status).toBe(401);
    // A member of every workspace of the tenant.
    const ids = (await h.s.tenants.workspacesForUser(t.id, r.body.admin.id)).map((w) => w.name).sort();
    expect(ids).toEqual(['Projects', 'Team']);
  });

  it('an enrolment link by default: it sets the password once and opens factor enrolment', async () => {
    const r = await sys.post('/api/admin/tenants/from-template', { template: 'personal', slug: 'solo', name: 'Solo', admin: adminBody('sam') });
    expect(r.status).toBe(201);
    expect(r.body.applied).toMatchObject({ template: 'personal', roles: [], issuer: { state: 'not in template' } });
    expect(r.body.applied.workspaces).toEqual([expect.objectContaining({ name: 'Personal', label: 'confidential' })]);
    expect(r.body.admin).toMatchObject({ clearance: 'confidential', enrolHours: h.s.cfg.PASSWORD_INVITE_HOURS });
    const link: string = r.body.admin.enrolLink;
    expect(link).toMatch(/#\/signin\?reset=.+&tenant=solo$/);
    const token = /reset=([^&]+)/.exec(link)![1]!;
    const set = await request(h.app).post('/api/auth/password/reset').send({ token, password: 'a long fresh enrolment passphrase 4' });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ reset: true, username: 'sam', tenant: 'solo', session: { stage: 'enroll' } });
    expect((await request(h.app).post('/api/auth/password/reset').send({ token, password: PASSWORD })).status).toBe(400);
  });

  it('a taken slug is 409 and creates nothing', async () => {
    const before = await h.s.db('tenants').count({ n: '*' });
    const r = await sys.post('/api/admin/tenants/from-template', { template: 'team', slug: 'acme', name: 'Acme again', admin: adminBody('bob') });
    expect(r.status).toBe(409);
    expect(await h.s.db('tenants').count({ n: '*' })).toEqual(before);
  });

  it('the enterprise template: five workspaces up to confidential, two roles, three profiles', async () => {
    const r = await sys.post('/api/admin/tenants/from-template', { template: 'enterprise', slug: 'globex', name: 'Globex', admin: adminBody('gina', 'another long enterprise password 9') });
    expect(r.status).toBe(201);
    expect(r.body.applied.workspaces).toHaveLength(5);
    expect(r.body.applied.roles.map((x: { name: string }) => x.name)).toEqual(['Reader', 'Contributor']);
    expect(r.body.applied.profiles.map((x: { name: string }) => x.name)).toEqual(['assistant', 'analyst', 'summariser']);
    expect(r.body.admin.clearance).toBe('confidential');
  });
});

describe('Sprint 35d: the template issuer under a platform root', () => {
  let h: Harness;
  let dir: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'exprsn-tpl-signer-'));
    const socketPath = path.join(dir, 'signer.sock');
    const token = randomBytes(24).toString('base64url');
    const signer = await startSigner({ socketPath, key: randomBytes(32).toString('base64'), token });
    close = () => signer.close();
    h = await harness({ DATA_KEY: '', SIGNER_SOCKET: socketPath, SIGNER_TOKEN: token, PKI_PUBLIC_URL: 'http://ca.example.test' });
  }, 60_000);
  afterAll(async () => {
    await h.close();
    await close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the tenant intermediate when a root exists, and reports no pool in the zone', async () => {
    const by = { tenantId: h.tenantId, userId: null, actor: { service: 'test' } };
    await h.s.pki.createRoot({ ...by }, { commonName: 'Template Root', keyType: 'ecdsa-p256', days: 3650 });
    const out = await provisionTenant(h.s, by, { template: 'team', slug: 'initech', name: 'Initech', admin: { username: 'pat', displayName: 'Pat', password: null } });
    expect(out.applied.issuer.state).toBe('created');
    const issuer = (await h.s.pki.activeIntermediate(out.tenant.id))!;
    expect(issuer).toMatchObject({ id: out.applied.issuer.id, kind: 'intermediate', name: 'Initech Issuing CA' });
    expect(out.applied.zone).toMatchObject({ state: 'no pool in zone', poolId: null });
    expect(out.admin.enrolLink).toBeTruthy();
  });
});
