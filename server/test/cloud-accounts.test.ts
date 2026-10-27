import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { explain, type Principal } from '../src/authz/policy.js';
import { getRole, permissionsFor, rolesRequireMfa } from '../src/authz/permissions.js';
import { cloudTags, isManagedBy, providerTags } from '../src/cloud/tags.js';
import type { CloudAccount, CloudFeature, PermissionCheck } from '../src/cloud/types.js';
import { CloudValidation } from '../src/cloud/validate.js';
import { cloudCredentials } from '../src/cloud/credentials.js';
import { hashPassword } from '../src/identity/passwords.js';
import { totp } from '../src/identity/totp.js';
import { harness, localUser, login, loginAdmin, PASSWORD, type Harness } from './helpers.js';

/*
 * 1.9.99-final, Sprint 56 (B-10002, B-10007 to B-10009): cloud accounts. CRUD within scopes, the permissions and the
 * three roles (MFA for Cloud admin), dual control for add, remove, credential mode, raised ceilings and residency,
 * validation reporting what is missing per feature through a stub provider, region ceilings and residency refusals
 * with `policy.explain` naming the region, the token-only checklist, credentials never returned as values, and the
 * routes without migration 146 (applied here by hand until it is registered).
 */

const A = '/api/admin/cloud/accounts';
const P = '/api/admin/cloud/proposals';

async function install(h: Harness): Promise<void> {
  if (!(await h.s.db.schema.hasTable('cloud_accounts'))) await (await import('../src/db/migrations/146_cloud_accounts.js')).up(h.s.db);
  h.s.cloud.accounts.resetSchemaCache();
}

interface Api {
  userId: string;
  get(p: string): request.Test;
  post(p: string, b?: object): request.Test;
  patch(p: string, b: object): request.Test;
  put(p: string, b: object): request.Test;
  del(p: string, b?: object): request.Test;
}

const api = (agent: ReturnType<typeof request.agent>, csrf: string, userId: string): Api => ({
  userId,
  get: (p) => agent.get(p),
  post: (p, b = {}) => agent.post(p).set('x-csrf-token', csrf).send(b),
  patch: (p, b) => agent.patch(p).set('x-csrf-token', csrf).send(b),
  put: (p, b) => agent.put(p).set('x-csrf-token', csrf).send(b),
  del: (p, b = {}) => agent.delete(p).set('x-csrf-token', csrf).send(b)
});

async function admin(h: Harness, name: string, roles: string[], clearance: 'internal' | 'confidential' | 'restricted' = 'confidential'): Promise<Api> {
  const u = await localUser(h, name, roles, clearance);
  const c = await loginAdmin(h, name);
  return api(c.agent, c.csrf, u.id);
}

async function otherTenantAdmin(h: Harness, slug: string, name: string, roles: string[]): Promise<{ api: Api; tenantId: string }> {
  const t = (await h.s.tenants.bySlug(slug)) ?? (await h.s.tenants.create({ slug, name: slug }));
  const local = (await h.s.providers.list(t.id)).find((p) => p.kind === 'local') ?? (await h.s.providers.create(t.id, { name: 'Local accounts', kind: 'local', position: 1000, enabled: true, config: {} }));
  const u = await h.s.users.create(t.id, { username: name, displayName: name, clearance: 'confidential' });
  await h.s.users.update(t.id, u.id, { clearance_direct: 'confidential' });
  await h.s.db('local_credentials').insert({ user_id: u.id, password_hash: await hashPassword(PASSWORD), updated_at: Date.now() });
  await h.s.users.upsertIdentity(u.id, local.id, u.id, []);
  await h.s.users.setRoles(u.id, 'direct', roles);
  const agent = request.agent(h.app);
  const first = await agent.post('/api/auth/login').send({ username: name, password: PASSWORD, tenant: slug });
  const begin = await agent.post('/api/me/mfa/totp').set('x-csrf-token', first.body.csrf).send({});
  const confirm = await agent.post(`/api/me/mfa/totp/${begin.body.id}/confirm`).set('x-csrf-token', first.body.csrf).send({ code: totp.generate(begin.body.secret) });
  expect(confirm.status).toBe(201);
  return { api: api(agent, confirm.body.csrf, u.id), tenantId: t.id };
}

const AWS = (name = 'aws-analytics', extra: Record<string, unknown> = {}) => ({
  name,
  provider: 'aws',
  scope: 'platform',
  providerIds: { awsAccountId: '777788889999' },
  credential: { mode: 'federated', params: { roleArn: 'arn:aws:iam::777788889999:role/exprsn-ai-deploy' } },
  regions: [{ region: 'eu-central-1' }, { region: 'us-east-1' }],
  ...extra
});

const CF = (name = 'cf-edge', scope = 'platform') => ({
  name,
  provider: 'cloudflare',
  scope,
  providerIds: { cloudflareAccountId: '0123456789abcdef0123456789abcdef' },
  credential: { mode: 'vaulted', refs: { token: 'vault:cloud/cf-edge#api_token' } },
  regions: [{ region: 'global' }, { region: 'r2-eu' }]
});

/** Adds and approves an account; returns it. */
async function added(a: Api, b: Api, body: object): Promise<CloudAccount & { id: string }> {
  const res = await a.post(A, body).expect(202);
  await b.post(`${P}/${res.body.proposal.id}/approve`, {}).expect(200);
  return (await a.get(`${A}/${res.body.account.id}`).expect(200)).body;
}

/** A stub provider: the identity answers, and each feature lacks what `missing` says. */
function stubProvider(h: Harness, missing: Partial<Record<CloudFeature, string[]>> = {}, opts: { account?: string; fail?: Error & { status?: number; requestId?: string; retryAfter?: number } } = {}) {
  const calls: string[] = [];
  (h.s.cloud as { credentials: unknown }).credentials = { for: async (acct: CloudAccount, purpose: string) => { calls.push(`cred:${acct.name}:${purpose}`); return { kind: 'token', token: 'stub-token-not-real' }; } };
  h.s.cloud.providerFor = () => ({
    identity: async (_c: never, acct: CloudAccount) => {
      if (opts.fail) throw opts.fail;
      calls.push(`identity:${acct.name}`);
      return { ok: true, principal: 'token 1234', providerAccount: opts.account ?? acct.providerIds.cloudflareAccountId ?? acct.providerIds.awsAccountId, requestId: 'req-1' };
    },
    checkPermissions: async (_c: never, acct: CloudAccount, features: CloudFeature[]): Promise<PermissionCheck[]> => {
      calls.push(`check:${acct.name}:${features.join(',')}`);
      return features.map((f) => ({ feature: f, required: [`${f}-perm`, ...(missing[f] ?? [])], missing: missing[f] ?? [] }));
    }
  });
  return calls;
}

describe('cloud accounts (B-10002, B-10007 to B-10009)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  }, 60_000);
  afterEach(async () => {
    await h.close();
  });

  it('answers not installed until migration 146 is applied, then works', async () => {
    // 146 is registered (2026-10-20), so the harness has it: roll it back to see the service without it.
    await (await import('../src/db/migrations/146_cloud_accounts.js')).down(h.s.db);
    h.s.cloud.accounts.resetSchemaCache();
    const sys = await admin(h, 'root', ['system-admin']);
    const res = await sys.get(A).expect(503);
    expect(res.headers['content-type']).toMatch(/problem\+json/);
    expect(res.body.reason).toBe('migration_pending');
    expect((await sys.get('/api/admin/cloud/catalogue').expect(200)).body.installed).toBe(false);
    expect((await h.s.cloud.accounts.checkRegion('nope', 'eu-central-1', 'public')).allow).toBe(false);
    await install(h);
    expect((await sys.get(A).expect(200)).body.accounts).toEqual([]);
  });

  describe('installed', () => {
    beforeEach(async () => install(h));

    it('defines the five permissions and three roles; Cloud admin needs MFA', async () => {
      expect([...permissionsFor(['cloud-admin'])].sort()).toEqual(['cloud:admin', 'cloud:deploy', 'cloud:read', 'finops:manage', 'finops:read']);
      expect([...permissionsFor(['cloud-operator'])].sort()).toEqual(['cloud:deploy', 'cloud:read']);
      expect([...permissionsFor(['finops-analyst'])].sort()).toEqual(['cloud:read', 'finops:read', 'usage:read']);
      expect(getRole('cloud-admin')!.requiresMfa).toBe(true);
      expect(getRole('cloud-operator')!.requiresMfa).toBe(false); // the owner, 2026-10-20: operators need no second factor
      expect(rolesRequireMfa(['finops-analyst'])).toBe(false);
      // A Cloud admin signed in with a password only is refused until the second factor is set up.
      await localUser(h, 'ca', ['cloud-admin']);
      const pw = await login(h, 'ca');
      expect(pw.res.body.stage).toBe('enroll');
      await pw.agent.get(A).expect(401);
      // A FinOps analyst reads but cannot add; a member reads nothing.
      await localUser(h, 'fin', ['finops-analyst']);
      const f = await login(h, 'fin');
      const fin = api(f.agent, f.csrf, '');
      await fin.get(A).expect(200);
      const denied = await fin.post(A, AWS()).expect(403);
      expect(denied.body).toMatchObject({ step: 'role', action: 'cloud:admin' });
      await localUser(h, 'mem', ['member']);
      const m = await login(h, 'mem');
      expect((await m.agent.get(A).expect(403)).body).toMatchObject({ step: 'role', action: 'cloud:read' });
    });

    it('a tenant admin cannot add a platform account; tenant accounts stay in their tenant', async () => {
      const t = await otherTenantAdmin(h, 'other', 'tia', ['tenant-admin', 'cloud-admin']);
      const refused = await t.api.post(A, AWS()).expect(403);
      expect(refused.body.detail).toMatch(/platform admin/);
      // A cloud admin of the platform tenant without platform:manage cannot either.
      const ca = await admin(h, 'ca', ['cloud-admin']);
      await ca.post(A, AWS()).expect(403);
      // The tenant's own account: the tenant comes from the session, never the body.
      const mine = await t.api.post(A, { ...AWS('byo-aws'), scope: 'tenant' }).expect(202);
      expect(mine.body.account).toMatchObject({ scope: 'tenant', tenantId: t.tenantId, state: 'pending' });
      await t.api.post(A, { ...AWS('x'), scope: 'tenant', tenantId: h.tenantId }).expect(400);
      // Another tenant's cloud admin sees nothing of it, and neither does the platform tenant's cloud admin.
      const u = await otherTenantAdmin(h, 'third', 'tom', ['cloud-admin']);
      expect((await u.api.get(A).expect(200)).body.accounts).toEqual([]);
      await u.api.get(`${A}/${mine.body.account.id}`).expect(404);
      expect((await ca.get(A).expect(200)).body.accounts).toEqual([]);
      // A system admin sees every account.
      const sys = await admin(h, 'root', ['system-admin']);
      expect((await sys.get(A).expect(200)).body.accounts.map((x: CloudAccount) => x.name)).toEqual(['byo-aws']);
      // Tenant accounts serve data and models only (open decision 6).
      expect((await h.s.cloud.accounts.checkRegion(mine.body.account.id, 'eu-central-1', 'public', { use: 'deploy' })).step).toBe('state');
    });

    it('dual control: an added account is unusable until a second cloud admin approves; the proposer cannot', async () => {
      const a = await admin(h, 'mara', ['system-admin']);
      const b = await admin(h, 'jonas', ['system-admin']);
      const res = await a.post(A, AWS()).expect(202);
      const id = res.body.account.id as string;
      expect(res.body.account.state).toBe('pending');
      expect(res.body.proposal).toMatchObject({ kind: 'account.add', state: 'pending' });
      const d = await h.s.cloud.accounts.checkRegion(id, 'eu-central-1', 'public');
      expect(d).toMatchObject({ allow: false, step: 'state' });
      await expect(h.s.cloud.accounts.assertRegionAllows(id, 'eu-central-1', 'public')).rejects.toMatchObject({ status: 403 });
      const own = await a.post(`${P}/${res.body.proposal.id}/approve`, {}).expect(403);
      expect(own.body.step).toBe('dual-control');
      // A cloud admin without platform:manage cannot approve a platform account's change.
      const ca = await admin(h, 'ca', ['cloud-admin']);
      await ca.post(`${P}/${res.body.proposal.id}/approve`, {}).expect(403);
      // The second admin approves; the account is usable.
      const ok = await b.post(`${P}/${res.body.proposal.id}/approve`, { note: 'checked the trust' }).expect(200);
      expect(ok.body.account.state).toBe('active');
      expect((await h.s.cloud.accounts.checkRegion(id, 'eu-central-1', 'public')).allow).toBe(true);
      const actions = ((await h.s.db('audit_events').select('action')) as { action: string }[]).map((r) => r.action);
      expect(actions).toEqual(expect.arrayContaining(['cloud.account.proposed', 'cloud.proposal.created', 'cloud.account.created', 'cloud.proposal.approved']));
      // Same name twice in one scope is refused.
      await a.post(A, AWS()).expect(409);
    });

    it('rejecting or withdrawing an add removes the waiting account', async () => {
      const a = await admin(h, 'mara', ['system-admin']);
      const b = await admin(h, 'jonas', ['system-admin']);
      const one = (await a.post(A, AWS('one')).expect(202)).body;
      await b.post(`${P}/${one.proposal.id}/withdraw`).expect(403);
      await a.post(`${P}/${one.proposal.id}/withdraw`).expect(200);
      await a.get(`${A}/${one.account.id}`).expect(404);
      const two = (await a.post(A, AWS('two')).expect(202)).body;
      await a.post(`${P}/${two.proposal.id}/reject`, {}).expect(409);
      await b.post(`${P}/${two.proposal.id}/reject`, { note: 'wrong account' }).expect(200);
      await a.get(`${A}/${two.account.id}`).expect(404);
    });

    it('removal and a credential-mode change are proposals; a same-mode credential change applies at once', async () => {
      const a = await admin(h, 'mara', ['system-admin']);
      const b = await admin(h, 'jonas', ['system-admin']);
      const acct = await added(a, b, AWS());
      // Same mode: applies, audited.
      const same = await a.patch(`${A}/${acct.id}`, { credential: { mode: 'federated', params: { roleArn: 'arn:aws:iam::777788889999:role/exprsn-ai-deploy-2' } } }).expect(200);
      expect(same.body.account.credential.params.roleArn).toMatch(/deploy-2$/);
      // Another mode: a proposal; nothing changes until approved.
      const vaulted = { mode: 'vaulted', refs: { accessKeyId: 'vault:cloud/aws-analytics#access_key_id', secretAccessKey: 'vault:cloud/aws-analytics#secret_access_key' } };
      const prop = await a.patch(`${A}/${acct.id}`, { credential: vaulted }).expect(202);
      expect(prop.body.proposals[0]).toMatchObject({ kind: 'account.credential' });
      expect(prop.body.account.credentialMode).toBe('federated');
      await a.patch(`${A}/${acct.id}`, { credential: vaulted }).expect(409);
      await b.post(`${P}/${prop.body.proposals[0].id}/approve`, {}).expect(200);
      expect((await a.get(`${A}/${acct.id}`).expect(200)).body.credentialMode).toBe('vaulted');
      // Remove: a proposal; the account stays until approved, and then its vaulted secrets and sessions go with it.
      const forget = vi.spyOn(cloudCredentials(h.s), 'forget');
      const rm = await a.del(`${A}/${acct.id}`, { reason: 'moving to the new org' }).expect(202);
      expect(rm.body.proposal.kind).toBe('account.remove');
      await a.get(`${A}/${acct.id}`).expect(200);
      await b.post(`${P}/${rm.body.proposal.id}/approve`, {}).expect(200);
      await a.get(`${A}/${acct.id}`).expect(404);
      expect(await h.s.db('cloud_credentials').where({ account_id: acct.id }).first()).toBeUndefined();
      expect(forget).toHaveBeenCalledTimes(1);
      expect(forget).toHaveBeenCalledWith(acct.id);
    });

    it('takes credentials as vault references only and never returns a value', async () => {
      const a = await admin(h, 'mara', ['system-admin']);
      const literal = await a.post(A, { ...AWS('lit'), credential: { mode: 'vaulted', refs: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'wJalrXUtnFEMIexamplesecret' } } }).expect(400);
      expect(literal.body.reason).toBe('not_a_reference');
      await a.post(A, { ...AWS('bad'), credential: { mode: 'vaulted', params: { secretAccessKey: 'x' }, refs: {} } }).expect(400);
      await a.post(A, { ...AWS('arn'), credential: { mode: 'federated', params: { roleArn: 'arn:aws:iam::111122223333:role/x' } } }).expect(400);
      const ok = await a.post(A, CF()).expect(202);
      const raw = JSON.stringify((await a.get(`${A}/${ok.body.account.id}`).expect(200)).body);
      expect(raw).toContain('vault:cloud/cf-edge#api_token');
      const row = await h.s.db('cloud_credentials').where({ account_id: ok.body.account.id }).first();
      expect(JSON.parse(row.refs)).toEqual({ token: 'vault:cloud/cf-edge#api_token' });
      // A reader without cloud:admin sees field names, not even the reference.
      await localUser(h, 'fin', ['finops-analyst']);
      const f = await login(h, 'fin');
      const seen = (await f.agent.get(`${A}/${ok.body.account.id}`).expect(200)).body;
      expect(seen.credential.refs).toEqual(['token']);
    });

    it('token-only providers: federation unavailable with the reason, and the permission checklist', async () => {
      const a = await admin(h, 'mara', ['system-admin']);
      const cat = (await a.get('/api/admin/cloud/catalogue').expect(200)).body;
      const cf = cat.providers.find((p: { id: string }) => p.id === 'cloudflare');
      expect(cf.modes).toEqual(['vaulted']);
      expect(cf.federation).toMatchObject({ available: false });
      expect(cf.federation.reason).toMatch(/API tokens only/);
      expect(cf.features.find((f: { id: string }) => f.id === 'apptier').checklist.map((c: { permission: string }) => c.permission)).toContain('Containers Edit');
      expect(cat.providers.find((p: { id: string }) => p.id === 'digitalocean').federation.available).toBe(false);
      expect(cat.providers.find((p: { id: string }) => p.id === 'aws').federation.available).toBe(true);
      const fed = await a.post(A, { ...CF('cf-fed'), credential: { mode: 'federated', params: {} } }).expect(400);
      expect(fed.body.detail).toMatch(/no workload identity federation/);
      expect(fed.body.reason).toBe('mode_unavailable');
    });

    it('validation reports what is missing per feature; a Cloudflare token without Containers Edit serves the front door but not the app tier', async () => {
      const a = await admin(h, 'mara', ['system-admin']);
      const b = await admin(h, 'jonas', ['system-admin']);
      const acct = await added(a, b, CF());
      const calls = stubProvider(h, { apptier: ['Containers Edit'] });
      const res = await a.post(`${A}/${acct.id}/validate`).expect(200);
      expect(calls).toEqual(['cred:cf-edge:validate', 'identity:cf-edge', 'check:cf-edge:frontdoor,apptier,data,models,billing']);
      expect(res.body.report.ok).toBe(false);
      const app = res.body.report.features.find((f: { feature: string }) => f.feature === 'apptier');
      expect(app).toMatchObject({ status: 'missing', missing: ['Containers Edit'] });
      expect(app.reason).toMatch(/Containers Edit/);
      expect(res.body.account.state).toBe('attention');
      const fresh = (await h.s.cloud.accounts.get(acct.id))!;
      expect(() => h.s.cloud.accounts.assertFeature(fresh, 'frontdoor')).not.toThrow();
      expect(() => h.s.cloud.accounts.assertFeature(fresh, 'apptier')).toThrow(/Containers Edit/);
      expect(JSON.stringify(res.body)).not.toContain('stub-token-not-real');
      // Granted later: validates clean and the account is active again.
      stubProvider(h, {});
      expect((await a.post(`${A}/${acct.id}/validate`).expect(200)).body.account.state).toBe('active');
    });

    it('validation refuses a credential of another account, and maps provider errors and throttling', async () => {
      const a = await admin(h, 'mara', ['system-admin']);
      const b = await admin(h, 'jonas', ['system-admin']);
      const acct = await added(a, b, AWS());
      stubProvider(h, {}, { account: '111122223333' });
      const wrong = (await a.post(`${A}/${acct.id}/validate`).expect(200)).body.report;
      expect(wrong.identity).toMatchObject({ ok: false });
      expect(wrong.identity.error).toMatch(/111122223333/);
      stubProvider(h, {}, { fail: Object.assign(new Error('Service Unavailable'), { status: 503, requestId: 'x-ms-1' }) });
      const e = await a.post(`${A}/${acct.id}/validate`).expect(502);
      expect(e.body).toMatchObject({ reason: 'provider_error', provider_request_id: 'x-ms-1' });
      expect(e.body.trace_id).toBeTruthy();
      stubProvider(h, {}, { fail: Object.assign(new Error('slow down'), { status: 429, retryAfter: 38 }) });
      const t = await a.post(`${A}/${acct.id}/validate`).expect(429);
      expect(t.headers['retry-after']).toBe('38');
      // The last good report is kept.
      expect((await h.s.cloud.accounts.get(acct.id))!.validation!.identity.ok).toBe(false);
      // No adapter: 503.
      h.s.cloud.providerFor = () => null;
      expect((await a.post(`${A}/${acct.id}/validate`).expect(503)).body.reason).toBe('cloud_component_missing');
      // The report on its own, for a feature the provider reports unsupported.
      const r = CloudValidation.report(acct, { ok: true }, [{ feature: 'deploy', required: [], missing: [], unsupported: true }]);
      expect(r.features.find((f) => f.feature === 'deploy')!.status).toBe('unsupported');
    });

    it('region ceilings: raising is a proposal, restricted needs a platform admin, and policy.explain names the region', async () => {
      const t = await otherTenantAdmin(h, 'other', 'tia', ['tenant-admin', 'cloud-admin']);
      const t2 = await otherTenantAdmin(h, 'other', 'tim', ['cloud-admin']);
      const acct = await added(t.api, t2.api, { ...AWS('byo'), scope: 'tenant' });
      expect(acct.regions.map((r) => [r.region, r.ceiling, r.zone])).toEqual([['eu-central-1', 'internal', 'cloud-eu'], ['us-east-1', 'internal', 'cloud-us']]);
      // Above the ceiling: refused with the region's ceiling named.
      const refusal = h.s.cloud.accounts.assertRegionAllows(acct.id, 'eu-central-1', 'confidential');
      await expect(refusal).rejects.toMatchObject({ status: 403 });
      await expect(h.s.cloud.accounts.assertRegionAllows(acct.id, 'eu-central-1', 'confidential')).rejects.toThrow(/ceiling internal/);
      // Not on the allow-list.
      expect((await h.s.cloud.accounts.checkRegion(acct.id, 'eu-west-1', 'public')).step).toBe('region');
      // Lowering and removing apply at once; raising waits for a second admin.
      const raise = await t.api.patch(`${A}/${acct.id}`, { regions: [{ region: 'eu-central-1', ceiling: 'confidential' }, { region: 'us-east-1', ceiling: 'public' }] }).expect(202);
      expect(raise.body.account.regions.map((r: { ceiling: string }) => r.ceiling)).toEqual(['internal', 'public']);
      await t2.api.post(`${P}/${raise.body.proposals[0].id}/approve`, {}).expect(200);
      expect(await h.s.cloud.accounts.ceilingFor(acct.id, 'eu-central-1')).toBe('confidential');
      // Restricted: a tenant cloud admin cannot approve it; a platform admin can.
      const r = await t.api.patch(`${A}/${acct.id}`, { regions: [{ region: 'eu-central-1', ceiling: 'restricted' }, { region: 'us-east-1' }] }).expect(202);
      expect(r.body.proposals[0].needsPlatformAdmin).toBe(true);
      expect((await t2.api.post(`${P}/${r.body.proposals[0].id}/approve`, {}).expect(403)).body.action).toBe('platform:manage');
      const sys = await admin(h, 'root', ['system-admin']);
      expect((await sys.get(P).expect(200)).body.map((x: { id: string }) => x.id)).toContain(r.body.proposals[0].id);
      await sys.post(`${P}/${r.body.proposals[0].id}/approve`, {}).expect(200);
      expect(await h.s.cloud.accounts.ceilingFor(acct.id, 'eu-central-1')).toBe('restricted');
      // The policy pipeline's zone step names the region's ceiling (a restricted knowledge base on us-east-1).
      const placement = (await h.s.cloud.accounts.placementFor(acct.id, 'us-east-1', 'restricted', { tenantId: t.tenantId }))!;
      const p = { kind: 'user', userId: 'u', tenantId: t.tenantId, tenantSlug: 'other', username: 'k', displayName: 'K', roles: ['tenant-admin'], clearance: 'restricted', scopes: null, sessionId: null, apiKeyId: null, mfa: true } as Principal;
      const ex = explain(p, 'connections:query', { tenantId: t.tenantId, label: 'restricted', region: placement });
      expect(ex.decision).toMatchObject({ allow: false, step: 'zone' });
      expect(ex.steps.find((s) => s.step === 'zone')!.detail).toMatch(/us-east-1 \(zone cloud-us\) has the label ceiling public/);
    });

    it('residency: confidential only in the tenant residency; widening it is a proposal', async () => {
      const a = await admin(h, 'mara', ['system-admin']);
      const b = await admin(h, 'jonas', ['system-admin']);
      const acct = await added(a, b, AWS('eu-us', { regions: [{ region: 'eu-central-1', ceiling: 'confidential' }, { region: 'us-east-1', ceiling: 'confidential' }] }));
      // No residency yet: confidential goes nowhere; internal goes anywhere on the list.
      const none = await h.s.cloud.accounts.checkRegion(acct.id, 'eu-central-1', 'confidential');
      expect(none).toMatchObject({ allow: false, step: 'residency' });
      expect((await h.s.cloud.accounts.checkRegion(acct.id, 'us-east-1', 'internal')).allow).toBe(true);
      const set = await a.put('/api/admin/cloud/residency', { geos: ['eu'] }).expect(202);
      expect(set.body.proposal.kind).toBe('residency');
      await b.post(`${P}/${set.body.proposal.id}/approve`, {}).expect(200);
      expect((await a.get('/api/admin/cloud/residency').expect(200)).body.geos).toEqual(['eu']);
      expect((await h.s.cloud.accounts.checkRegion(acct.id, 'eu-central-1', 'confidential')).allow).toBe(true);
      const us = await h.s.cloud.accounts.checkRegion(acct.id, 'us-east-1', 'confidential');
      expect(us).toMatchObject({ allow: false, step: 'residency' });
      expect(us.reason).toMatch(/residency \(eu\); us-east-1 is in us/);
      // Narrowing applies at once.
      expect((await a.put('/api/admin/cloud/residency', { geos: [] }).expect(200)).body.geos).toEqual([]);
    });

    it('builds the exprsn:* tags per provider', () => {
      expect(cloudTags({ account: 'aws-prod', deployment: 'nw-prod-eu', tenant: 'northwind' })).toEqual({ 'exprsn:managed': 'true', 'exprsn:account': 'aws-prod', 'exprsn:deployment': 'nw-prod-eu', 'exprsn:tenant': 'northwind' });
      expect(providerTags('digitalocean', { account: 'do-team', pool: 'gpu-a' }).strings).toEqual(['exprsn:managed:true', 'exprsn:account:do-team', 'exprsn:pool:gpu-a']);
      expect(isManagedBy('do-team', ['exprsn:managed:true', 'exprsn:account:do-team'])).toBe(true);
      expect(isManagedBy('aws-prod', { 'exprsn:managed': 'true', 'exprsn:account': 'other' })).toBe(false);
      expect(() => cloudTags({ account: 'bad value' })).toThrow();
    });

    it('validates input with zod and refuses regions the provider does not offer', async () => {
      const a = await admin(h, 'mara', ['system-admin']);
      await a.post(A, { ...AWS('Upper') }).expect(400);
      expect((await a.post(A, { ...AWS('reg'), regions: [{ region: 'ams3' }] }).expect(400)).body.reason).toBe('unknown_region');
      await a.post(A, { ...AWS('ids'), providerIds: { azureTenantId: '00000000-0000-4000-8000-000000000000' } }).expect(400);
      await a.get(`${A}/not-an-id`).expect(400);
    });
  });
});
