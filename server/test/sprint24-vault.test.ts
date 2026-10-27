import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluate, explainGrants, prefixCovers, isGrantPath, type Grant, type Subjects } from '../src/vault/policy.js';
import { formatVersioned, parseVersioned } from '../src/vault/transit.js';
import { parseVaultRef, permissionFor } from '../src/vault/service.js';
import { PERMISSIONS } from '../src/authz/permissions.js';
import { SCOPE_GROUPS } from '../src/federation/scopes.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

const send = (c: Client, method: 'post' | 'put' | 'patch' | 'delete', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);
const b64 = (s: string) => Buffer.from(s).toString('base64');

// ---- B-1703: policy evaluation, table-driven ----

const g = (id: string, subjectKind: Grant['subjectKind'], subject: string, path: string, capabilities: Grant['capabilities'], effect: Grant['effect'] = 'allow'): Grant => ({ id, subjectKind, subject, path, capabilities, effect });

const ALICE: Subjects = { userId: 'U-ALICE', groups: ['finance', 'ops'], workspaces: ['W-FIN'], apiKeyId: null };
const ALICE_KEY: Subjects = { ...ALICE, apiKeyId: 'K-1' };
const BOB: Subjects = { userId: 'U-BOB', groups: [], workspaces: [], apiKeyId: null };

const GRANTS: Grant[] = [
  g('G01', 'user', 'U-ALICE', 'kv/apps', ['read', 'list']),
  g('G02', 'group', 'finance', 'kv/apps/billing', ['read', 'write']),
  g('G03', 'workspace', 'W-FIN', 'kv/apps/billing/prod', ['read'], 'deny'),
  g('G04', 'group', 'ops', 'kv/apps/billing/prod/db', ['read']),
  g('G05', 'api_key', 'K-1', 'kv/apps', ['read'], 'deny'),
  g('G06', 'api_key', 'K-1', 'transit/payments', ['encrypt']),
  g('G07', 'user', 'U-ALICE', '*', ['list']),
  g('G08', 'group', 'finance', 'kv/apps/billing/shared', ['*']),
  g('G09', 'user', 'U-BOB', 'kv/apps/billing', ['read'])
];

describe('sprint 24: vault policy evaluation (B-1703)', () => {
  const table: { name: string; subjects: Subjects; path: string; cap: Parameters<typeof evaluate>[3]; allow: boolean; grant: string | null }[] = [
    { name: 'user grant on a prefix covers a deeper path', subjects: ALICE, path: 'kv/apps/web/session', cap: 'read', allow: true, grant: 'G01' },
    { name: 'longest allow prefix decides', subjects: ALICE, path: 'kv/apps/billing/stripe', cap: 'read', allow: true, grant: 'G02' },
    { name: 'group grant gives a capability the user grant lacks', subjects: ALICE, path: 'kv/apps/billing/stripe', cap: 'write', allow: true, grant: 'G02' },
    { name: 'workspace deny wins over a shorter allow', subjects: ALICE, path: 'kv/apps/billing/prod/api', cap: 'read', allow: false, grant: 'G03' },
    { name: 'deny wins over a longer, more specific allow', subjects: ALICE, path: 'kv/apps/billing/prod/db', cap: 'read', allow: false, grant: 'G03' },
    { name: 'a deny only covers its own capabilities', subjects: ALICE, path: 'kv/apps/billing/prod/api', cap: 'write', allow: true, grant: 'G02' },
    { name: 'prefixes match whole segments only', subjects: ALICE, path: 'kv/apps2/x', cap: 'read', allow: false, grant: null },
    { name: 'the * path covers everything', subjects: ALICE, path: 'transit/anything', cap: 'list', allow: true, grant: 'G07' },
    { name: 'the * capability covers every capability', subjects: ALICE, path: 'kv/apps/billing/shared/x', cap: 'destroy', allow: true, grant: 'G08' },
    { name: 'an API key deny narrows its owner', subjects: ALICE_KEY, path: 'kv/apps/web/session', cap: 'read', allow: false, grant: 'G05' },
    { name: 'an API key keeps owner capabilities its deny does not name', subjects: ALICE_KEY, path: 'kv/apps/web/session', cap: 'list', allow: true, grant: 'G01' },
    { name: 'an API key allow applies to the key', subjects: ALICE_KEY, path: 'transit/payments', cap: 'encrypt', allow: true, grant: 'G06' },
    { name: 'the owner without the key does not get the key grant', subjects: ALICE, path: 'transit/payments', cap: 'encrypt', allow: false, grant: null },
    { name: 'grants to other subjects do not apply', subjects: BOB, path: 'kv/apps/web/session', cap: 'read', allow: false, grant: null },
    { name: 'another user grant applies to that user', subjects: BOB, path: 'kv/apps/billing/prod/api', cap: 'read', allow: true, grant: 'G09' },
    { name: 'no grant at all is a default deny', subjects: { userId: 'U-NONE', groups: [], workspaces: [], apiKeyId: null }, path: 'kv/x', cap: 'read', allow: false, grant: null }
  ];

  it.each(table)('$name', (t) => {
    const d = evaluate(GRANTS, t.subjects, t.path, t.cap);
    expect(d.allow).toBe(t.allow);
    expect(d.grant?.id ?? null).toBe(t.grant);
  });

  it('explain lists every grant on the path, most specific first, and marks the deciding deny', () => {
    const e = explainGrants(GRANTS, ALICE, 'kv/apps/billing/prod/db', 'read');
    expect(e.decision.allow).toBe(false);
    expect(e.decision.reason).toMatch(/G03.*deny wins/);
    expect(e.grants.map((x) => x.grant.id)).toEqual(['G04', 'G03', 'G02', 'G01', 'G07']);
    expect(e.grants.find((x) => x.deciding)?.grant.id).toBe('G03');
    expect(e.grants.find((x) => x.grant.id === 'G07')?.appliesToCapability).toBe(false);
  });

  it('validates paths and prefixes', () => {
    expect(prefixCovers('kv/apps', 'kv/apps')).toBe(true);
    expect(prefixCovers('kv/apps', 'kv/apps/x')).toBe(true);
    expect(prefixCovers('kv/apps', 'kv/appsx')).toBe(false);
    for (const p of ['*', 'kv', 'transit', 'kv/apps/billing', 'transit/payments']) expect(isGrantPath(p)).toBe(true);
    for (const p of ['', 'kv/', 'kv//x', 'kv/../x', 'secret/x', 'kv/Apps', 'kv/a b']) expect(isGrantPath(p)).toBe(false);
    expect(parseVaultRef('vault:apps/db#password')).toEqual({ path: 'apps/db', key: 'password' });
    expect(parseVaultRef('vault:apps/db')).toBeNull();
    expect(permissionFor('destroy')).toBe('secrets:admin');
    expect(permissionFor('write')).toBe('secrets:write');
    expect(permissionFor('decrypt')).toBe('secrets:read');
  });

  it('versioned ciphertext round-trips and rejects other forms', () => {
    const t = formatVersioned(7, Buffer.from('abc'));
    expect(t).toBe('exai:v7:YWJj');
    expect(parseVersioned(t)).toEqual({ version: 7, payload: Buffer.from('abc') });
    for (const bad of ['vault:v1:YWJj', 'exai:v0:YWJj', 'exai:v1:', 'exai:vx:YWJj', 'exai:v1:YW Jj']) expect(parseVersioned(bad)).toBeNull();
  });

  it('adds the vault permissions to the catalogue and the OAuth scope groups', () => {
    for (const p of ['secrets:read', 'secrets:write', 'secrets:admin']) {
      expect(PERMISSIONS).toContain(p);
      expect(SCOPE_GROUPS.some((grp) => grp.scopes.includes(p))).toBe(true);
    }
  });
});

// ---- the API ----

describe('sprint 24: secrets vault API', () => {
  let h: Harness;
  let admin: Client;
  let member: Client;
  let memberId: string;
  let adminId: string;
  let workspaceId: string;

  const grant = async (body: object) => (await send(admin, 'post', '/api/vault/policies', body).expect(201)).body as { id: string };

  beforeAll(async () => {
    h = await harness();
    const a = await localUser(h, 'vaultadmin', ['tenant-admin'], 'restricted');
    adminId = a.id;
    admin = await loginAdmin(h, 'vaultadmin');
    const m = await localUser(h, 'vaultmember', ['member'], 'internal');
    memberId = m.id;
    const ws = await h.s.tenants.createWorkspace(h.tenantId, 'Payments', 'internal', { visibility: 'members' });
    workspaceId = ws.id;
    await h.s.users.setWorkspaceMemberships(m.id, 'direct', [ws.id]);
    const l = await login(h, 'vaultmember');
    member = { agent: l.agent, csrf: l.csrf, cookie: l.cookie };
    // The member's directory groups, as a store would report them (after sign-in, which records the local store's).
    const local = (await h.s.providers.list(h.tenantId)).find((p) => p.kind === 'local')!;
    await h.s.users.upsertIdentity(m.id, local.id, m.id, ['Finance']);
    // The admin may do anything in the vault, through a policy like everyone else.
    await grant({ subjectKind: 'user', subject: adminId, path: '*', capabilities: ['*'], description: 'vault admin' });
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  describe('KV secrets (B-1701)', () => {
    it('reading version 2 after a write of version 3 returns version 2', async () => {
      const r1 = await send(admin, 'put', '/api/vault/kv/data/apps/billing/stripe', { data: { key: 'sk_one' } }).expect(201);
      expect(r1.body.version).toBe(1);
      await send(admin, 'put', '/api/vault/kv/data/apps/billing/stripe', { data: { key: 'sk_two', webhook: 'wh_two' } }).expect(200);
      const r3 = await send(admin, 'put', '/api/vault/kv/data/apps/billing/stripe', { data: { key: 'sk_three' }, cas: 2 }).expect(200);
      expect(r3.body.version).toBe(3);

      const v2 = await admin.agent.get('/api/vault/kv/data/apps/billing/stripe?version=2').expect(200);
      expect(v2.body).toMatchObject({ path: 'apps/billing/stripe', version: 2, data: { key: 'sk_two', webhook: 'wh_two' } });
      const cur = await admin.agent.get('/api/vault/kv/data/apps/billing/stripe').expect(200);
      expect(cur.body).toMatchObject({ version: 3, data: { key: 'sk_three' } });
      expect(cur.headers['cache-control']).toBe('no-store');

      // Sealed at rest, never in plaintext.
      const rows = await h.s.db('vault_secret_versions').select('value_sealed');
      expect(rows.every((r: { value_sealed: string }) => !r.value_sealed.includes('sk_'))).toBe(true);

      // Reveals are audited by path and version; the values are never in the chain.
      const events = await h.s.db('audit_events').where({ tenant_id: h.tenantId }).whereLike('action', 'vault.secret.%');
      expect(events.some((e: { action: string; target: string }) => e.action === 'vault.secret.read' && JSON.parse(e.target).version === 2)).toBe(true);
      expect(JSON.stringify(events)).not.toMatch(/sk_one|sk_two|sk_three|wh_two/);
    });

    it('enforces check-and-set and reports the current version', async () => {
      const r = await send(admin, 'put', '/api/vault/kv/data/apps/billing/stripe', { data: { key: 'late' }, cas: 1 }).expect(409);
      expect(r.body.currentVersion).toBe(3);
      await send(admin, 'patch', '/api/vault/kv/metadata/apps/billing/stripe', { casRequired: true }).expect(200);
      await send(admin, 'put', '/api/vault/kv/data/apps/billing/stripe', { data: { key: 'nocas' } }).expect(400);
      await send(admin, 'patch', '/api/vault/kv/metadata/apps/billing/stripe', { casRequired: false }).expect(200);
    });

    it('soft-deletes, undeletes and destroys versions', async () => {
      await send(admin, 'post', '/api/vault/kv/delete/apps/billing/stripe', {}).expect(200);
      const gone = await admin.agent.get('/api/vault/kv/data/apps/billing/stripe').expect(410);
      expect(gone.body.state).toBe('deleted');
      await admin.agent.get('/api/vault/kv/data/apps/billing/stripe?version=2').expect(200);
      await send(admin, 'post', '/api/vault/kv/undelete/apps/billing/stripe', { versions: [3] }).expect(200);
      await admin.agent.get('/api/vault/kv/data/apps/billing/stripe').expect(200);

      await send(admin, 'post', '/api/vault/kv/destroy/apps/billing/stripe', { versions: [1] }).expect(200);
      const destroyed = await admin.agent.get('/api/vault/kv/data/apps/billing/stripe?version=1').expect(410);
      expect(destroyed.body.state).toBe('destroyed');
      await send(admin, 'post', '/api/vault/kv/undelete/apps/billing/stripe', { versions: [1] }).expect(410);
      const v1 = await h.s.db('vault_secret_versions').where({ version: 1 }).first();
      expect(v1.value_sealed).toBeNull();

      const meta = await admin.agent.get('/api/vault/kv/metadata/apps/billing/stripe').expect(200);
      expect(meta.body.versions.map((v: { version: number; state: string }) => `${v.version}:${v.state}`)).toEqual(['1:destroyed', '2:active', '3:active']);
      const actions = (await h.s.db('audit_events').where({ tenant_id: h.tenantId }).select('action')).map((e: { action: string }) => e.action);
      for (const a of ['vault.secret.written', 'vault.secret.deleted', 'vault.secret.undeleted', 'vault.secret.destroyed', 'vault.secret.metadata.updated']) expect(actions).toContain(a);
    });

    it('keeps at most maxVersions versions', async () => {
      await send(admin, 'patch', '/api/vault/kv/metadata/apps/billing/stripe', { maxVersions: 2 }).expect(200);
      await send(admin, 'put', '/api/vault/kv/data/apps/billing/stripe', { data: { key: 'sk_four' } }).expect(200);
      const meta = await admin.agent.get('/api/vault/kv/metadata/apps/billing/stripe').expect(200);
      expect(meta.body.versions.map((v: { version: number }) => v.version)).toEqual([3, 4]);
      await admin.agent.get('/api/vault/kv/data/apps/billing/stripe?version=2').expect(404);
    });

    it('validates paths and sizes', async () => {
      await send(admin, 'put', '/api/vault/kv/data/Apps/Upper', { data: { a: 'b' } }).expect(400);
      await send(admin, 'put', '/api/vault/kv/data/apps/empty', { data: {} }).expect(400);
      await send(admin, 'put', '/api/vault/kv/data/apps/big', { data: { a: 'x'.repeat(40_000), b: 'y'.repeat(40_000) } }).expect(400);
    });

    it('lists only what policy and clearance allow, and removes a path entirely', async () => {
      await send(admin, 'put', '/api/vault/kv/data/apps/billing/prod/db', { data: { password: 'p1' } }).expect(201);
      await send(admin, 'put', '/api/vault/kv/data/apps/hr/payroll', { data: { password: 'p2' }, label: 'restricted' }).expect(201);
      await send(admin, 'put', '/api/vault/kv/data/apps/tmp/x', { data: { a: 'b' } }).expect(201);
      const all = await admin.agent.get('/api/vault/kv?prefix=apps').expect(200);
      expect(all.body.secrets.map((x: { path: string }) => x.path)).toEqual(['apps/billing/prod/db', 'apps/billing/stripe', 'apps/hr/payroll', 'apps/tmp/x']);
      await send(admin, 'delete', '/api/vault/kv/metadata/apps/tmp/x').expect(204);
      await admin.agent.get('/api/vault/kv/metadata/apps/tmp/x').expect(404);
      // The member has no grant yet: nothing to list.
      expect((await member.agent.get('/api/vault/kv').expect(200)).body.secrets).toEqual([]);
    });
  });

  describe('policies (B-1703)', () => {
    it('a group grant lets the member read; a workspace deny blocks a deeper path; explain shows the deny', async () => {
      await member.agent.get('/api/vault/kv/data/apps/billing/stripe').expect(403);
      const allow = await grant({ subjectKind: 'group', subject: ' FINANCE ', path: 'kv/apps', capabilities: ['read', 'list'] });
      const deny = await grant({ subjectKind: 'workspace', subject: workspaceId, path: 'kv/apps/billing/prod', capabilities: ['read'], effect: 'deny', description: 'production stays with the platform team' });

      const ok = await member.agent.get('/api/vault/kv/data/apps/billing/stripe').expect(200);
      expect(ok.body.data.key).toBe('sk_four');
      const blocked = await member.agent.get('/api/vault/kv/data/apps/billing/prod/db').expect(403);
      expect(blocked.body.step).toBe('vault-policy');
      expect(blocked.body.grant).toMatchObject({ id: deny.id, effect: 'deny', subjectKind: 'workspace' });

      const ex = await send(member, 'post', '/api/vault/policies/explain', { path: 'kv/apps/billing/prod/db', capability: 'read' }).expect(200);
      expect(ex.body.decision.allow).toBe(false);
      expect(ex.body.decision.grant.id).toBe(deny.id);
      expect(ex.body.decision.reason).toMatch(/deny wins/);
      expect(ex.body.grants.map((x: { grant: { id: string }; deciding: boolean }) => [x.grant.id, x.deciding])).toEqual([[deny.id, true], [allow.id, false]]);
      expect(ex.body.subjects).toMatchObject({ userId: memberId, groups: ['finance'], workspaces: [workspaceId] });

      // The denial is in the audit chain with the deciding grant.
      const denied = await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'vault.denied' });
      expect(denied.some((e: { decision: string }) => JSON.parse(e.decision).grant === deny.id)).toBe(true);

      // An admin can explain for the member; the member cannot explain for the admin.
      const forMember = await send(admin, 'post', '/api/vault/policies/explain', { path: 'kv/apps/billing/prod/db', capability: 'read', userId: memberId }).expect(200);
      expect(forMember.body.decision.grant.id).toBe(deny.id);
      await send(member, 'post', '/api/vault/policies/explain', { path: 'kv', capability: 'read', userId: adminId }).expect(403);
    });

    it('clearance hides secrets above it even with a grant', async () => {
      await member.agent.get('/api/vault/kv/data/apps/hr/payroll').expect(404);
      const list = await member.agent.get('/api/vault/kv?prefix=apps').expect(200);
      expect(list.body.secrets.map((x: { path: string }) => x.path)).toEqual(['apps/billing/prod/db', 'apps/billing/stripe']);
    });

    it('the role permission comes first: a member cannot write even with a grant', async () => {
      await grant({ subjectKind: 'user', subject: memberId, path: 'kv/apps/billing', capabilities: ['write'] });
      const r = await send(member, 'put', '/api/vault/kv/data/apps/billing/stripe', { data: { key: 'mine' } }).expect(403);
      expect(r.body.step).toBe('role');
      await send(member, 'post', '/api/vault/policies', { subjectKind: 'user', subject: memberId, path: '*', capabilities: ['*'] }).expect(403);
    });

    it('API keys: a grant to the key adds to its owner, a deny on the key narrows it', async () => {
      const { key, row } = await h.s.apiKeys.create({ tenantId: h.tenantId, userId: memberId, name: 'ci', scopes: ['secrets:read'], ttlDays: 30 });
      const bearer = (r: request.Test) => r.set('authorization', `Bearer ${key}`);
      await bearer(request(h.app).get('/api/vault/kv/data/apps/billing/stripe')).expect(200);
      const d = await grant({ subjectKind: 'api_key', subject: row.id, path: 'kv/apps/billing/stripe', capabilities: ['read'], effect: 'deny' });
      const r = await bearer(request(h.app).get('/api/vault/kv/data/apps/billing/stripe')).expect(403);
      expect(r.body.grant.id).toBe(d.id);
      // The member's own session is unaffected by the key's deny.
      await member.agent.get('/api/vault/kv/data/apps/billing/stripe').expect(200);
      const ex = await send(admin, 'post', '/api/vault/policies/explain', { path: 'kv/apps/billing/stripe', capability: 'read', apiKeyId: row.id }).expect(200);
      expect(ex.body.decision.grant.id).toBe(d.id);
    });

    it('validates subjects and paths, edits and deletes grants with audit', async () => {
      await send(admin, 'post', '/api/vault/policies', { subjectKind: 'user', subject: '01ARZ3NDEKTSV4RRFFQ69G5FAV', path: 'kv', capabilities: ['read'] }).expect(400);
      await send(admin, 'post', '/api/vault/policies', { subjectKind: 'group', subject: 'x', path: 'secret/x', capabilities: ['read'] }).expect(400);
      const gr = await grant({ subjectKind: 'group', subject: 'auditors', path: 'kv/apps/', capabilities: ['list'] });
      const listed = (await admin.agent.get('/api/vault/policies').expect(200)).body.policies.find((p: { id: string }) => p.id === gr.id);
      expect(listed).toMatchObject({ path: 'kv/apps', subject: 'auditors', effect: 'allow' });
      await send(admin, 'patch', `/api/vault/policies/${gr.id}`, { capabilities: ['list', 'read'] }).expect(200);
      await send(admin, 'delete', `/api/vault/policies/${gr.id}`).expect(204);
      const actions = (await h.s.db('audit_events').where({ tenant_id: h.tenantId }).select('action')).map((e: { action: string }) => e.action);
      for (const a of ['vault.policy.created', 'vault.policy.updated', 'vault.policy.deleted']) expect(actions).toContain(a);
    });
  });

  describe('transit (B-1702)', () => {
    it('encrypts, rotates, rewraps, and refuses ciphertext below the minimum decryption version', async () => {
      await send(admin, 'post', '/api/vault/transit/keys', { name: 'payments', type: 'aes256-gcm96' }).expect(201);
      await send(admin, 'post', '/api/vault/transit/keys', { name: 'payments' }).expect(409);
      const c1 = (await send(admin, 'post', '/api/vault/transit/encrypt/payments', { plaintext: b64('card 4111'), context: b64('order-1') }).expect(200)).body.ciphertext as string;
      expect(c1).toMatch(/^exai:v1:/);
      const p1 = await send(admin, 'post', '/api/vault/transit/decrypt/payments', { ciphertext: c1, context: b64('order-1') }).expect(200);
      expect(Buffer.from(p1.body.plaintext, 'base64').toString()).toBe('card 4111');
      // The context is bound: another context does not open it.
      await send(admin, 'post', '/api/vault/transit/decrypt/payments', { ciphertext: c1, context: b64('order-2') }).expect(400);

      const rotated = await send(admin, 'post', '/api/vault/transit/keys/payments/rotate').expect(200);
      expect(rotated.body.latestVersion).toBe(2);
      const c2 = (await send(admin, 'post', '/api/vault/transit/encrypt/payments', { plaintext: b64('new') }).expect(200)).body.ciphertext as string;
      expect(c2).toMatch(/^exai:v2:/);
      // Old ciphertext still opens after rotation...
      await send(admin, 'post', '/api/vault/transit/decrypt/payments', { ciphertext: c1, context: b64('order-1') }).expect(200);
      // ...and rewrap moves it to the latest version without returning plaintext.
      const re = await send(admin, 'post', '/api/vault/transit/rewrap/payments', { ciphertext: c1, context: b64('order-1') }).expect(200);
      expect(re.body.ciphertext).toMatch(/^exai:v2:/);
      expect(re.body.plaintext).toBeUndefined();

      await send(admin, 'patch', '/api/vault/transit/keys/payments', { minDecryptVersion: 2 }).expect(200);
      const refused = await send(admin, 'post', '/api/vault/transit/decrypt/payments', { ciphertext: c1, context: b64('order-1') }).expect(400);
      expect(refused.body.detail).toMatch(/below its minimum decryption version 2/);
      await send(admin, 'post', '/api/vault/transit/rewrap/payments', { ciphertext: c1, context: b64('order-1') }).expect(400);
      const ok = await send(admin, 'post', '/api/vault/transit/decrypt/payments', { ciphertext: re.body.ciphertext, context: b64('order-1') }).expect(200);
      expect(Buffer.from(ok.body.plaintext, 'base64').toString()).toBe('card 4111');

      // A batch answers item by item.
      const batch = await send(admin, 'post', '/api/vault/transit/decrypt/payments', { batch: [{ ciphertext: c1, context: b64('order-1') }, { ciphertext: c2 }] }).expect(200);
      expect(batch.body.batch[0].error).toMatch(/minimum decryption version/);
      expect(Buffer.from(batch.body.batch[1].plaintext, 'base64').toString()).toBe('new');

      // Trim: material below the minimum is destroyed, and the minimum cannot go back below it.
      await send(admin, 'post', '/api/vault/transit/keys/payments/trim', { minAvailableVersion: 3 }).expect(400);
      const trimmed = await send(admin, 'post', '/api/vault/transit/keys/payments/trim', { minAvailableVersion: 2 }).expect(200);
      expect(trimmed.body.versions.map((v: { version: number }) => v.version)).toEqual([2]);
      await send(admin, 'patch', '/api/vault/transit/keys/payments', { minDecryptVersion: 1 }).expect(400);
      // Key material is sealed at rest.
      const mat = await h.s.db('vault_transit_versions').select('material_sealed');
      expect(mat.every((m: { material_sealed: string }) => m.material_sealed.startsWith('v2.'))).toBe(true);

      const actions = (await h.s.db('audit_events').where({ tenant_id: h.tenantId }).select('action', 'detail')).map((e: { action: string }) => e.action);
      for (const a of ['vault.transit.key.created', 'vault.transit.key.rotated', 'vault.transit.key.configured', 'vault.transit.key.trimmed', 'vault.transit.decrypted', 'vault.transit.rewrapped']) expect(actions).toContain(a);
    });

    it('signs and verifies with Ed25519 and P-256, honouring the minimum version', async () => {
      for (const type of ['ed25519', 'ecdsa-p256'] as const) {
        const name = `signer-${type}`;
        await send(admin, 'post', '/api/vault/transit/keys', { name, type }).expect(201);
        await send(admin, 'post', `/api/vault/transit/encrypt/${name}`, { plaintext: b64('x') }).expect(400);
        const s1 = (await send(admin, 'post', `/api/vault/transit/sign/${name}`, { input: b64('release 1.4.0') }).expect(200)).body.signature as string;
        expect(s1).toMatch(/^exai:v1:/);
        expect((await send(admin, 'post', `/api/vault/transit/verify/${name}`, { input: b64('release 1.4.0'), signature: s1 }).expect(200)).body.valid).toBe(true);
        expect((await send(admin, 'post', `/api/vault/transit/verify/${name}`, { input: b64('release 1.4.1'), signature: s1 }).expect(200)).body.valid).toBe(false);
        const key = (await admin.agent.get(`/api/vault/transit/keys/${name}`).expect(200)).body;
        expect(key.versions[0].publicKey).toMatch(/BEGIN PUBLIC KEY/);
        await send(admin, 'post', `/api/vault/transit/keys/${name}/rotate`).expect(200);
        await send(admin, 'patch', `/api/vault/transit/keys/${name}`, { minDecryptVersion: 2 }).expect(200);
        await send(admin, 'post', `/api/vault/transit/verify/${name}`, { input: b64('release 1.4.0'), signature: s1 }).expect(400);
      }
    });

    it('applies policies to transit keys and deletes only when allowed', async () => {
      // The member has no transit grant: refused by policy, then allowed for encrypt only.
      const r = await send(member, 'post', '/api/vault/transit/encrypt/payments', { plaintext: b64('x') }).expect(403);
      expect(r.body.step).toBe('vault-policy');
      await grant({ subjectKind: 'workspace', subject: workspaceId, path: 'transit/payments', capabilities: ['encrypt', 'list'] });
      await send(member, 'post', '/api/vault/transit/encrypt/payments', { plaintext: b64('x') }).expect(200);
      await send(member, 'post', '/api/vault/transit/decrypt/payments', { ciphertext: 'exai:v2:AAAA' }).expect(403);
      expect((await member.agent.get('/api/vault/transit/keys').expect(200)).body.keys.map((k: { name: string }) => k.name)).toEqual(['payments']);
      // Key management needs secrets:admin.
      await send(member, 'post', '/api/vault/transit/keys/payments/rotate').expect(403);

      await send(admin, 'delete', '/api/vault/transit/keys/payments').expect(409);
      await send(admin, 'patch', '/api/vault/transit/keys/payments', { deletionAllowed: true }).expect(200);
      await send(admin, 'delete', '/api/vault/transit/keys/payments').expect(204);
      await admin.agent.get('/api/vault/transit/keys/payments').expect(404);
      expect(await h.s.db('vault_transit_versions').whereIn('key_id', h.s.db('vault_transit_keys').select('id').where({ name: 'payments' }))).toEqual([]);
    });
  });
});
