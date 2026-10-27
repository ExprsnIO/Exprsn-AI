import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

const send = (c: Client, method: 'post' | 'put' | 'patch' | 'delete', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);
const PATH = 'apps/billing/stripe';
const read = (c: Client, path = PATH) => c.agent.get(`/api/vault/kv/data/${path}`);

describe('B-4801: sharing a KV secret with a principal', () => {
  let h: Harness;
  let owner: Client;
  let ownerId: string;
  let mel: Client;
  let melId: string;
  let bob: Client;
  let bobId: string;
  let cara: Client;
  let ws: string;

  const member = async (name: string, clearance: 'internal' | 'confidential' = 'confidential') => {
    const u = await localUser(h, name, ['member'], clearance);
    const l = await login(h, name);
    return { id: u.id, client: { agent: l.agent, csrf: l.csrf, cookie: l.cookie } };
  };

  beforeEach(async () => {
    h = await harness();
    ownerId = (await localUser(h, 'owner', ['tenant-admin'], 'restricted')).id;
    owner = await loginAdmin(h, 'owner');
    ({ id: melId, client: mel } = await member('mel'));
    ({ id: bobId, client: bob } = await member('bob'));
    ({ client: cara } = await member('cara'));
    ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Payments', 'restricted')).id;
    await send(owner, 'post', '/api/vault/policies', { subjectKind: 'user', subject: ownerId, path: '*', capabilities: ['*'] }).expect(201);
    await send(owner, 'put', `/api/vault/kv/data/${PATH}`, { data: { key: 'sk_live' }, label: 'confidential' }).expect(201);
  });
  afterEach(async () => {
    await h.close();
  });

  it('a shared secret is readable by its grantee and by no one else the policy denies', async () => {
    await read(mel).expect(403);
    const share = (await send(owner, 'post', `/api/vault/kv/shares/${PATH}`, { subjectKind: 'user', subject: melId, note: 'Payments on-call' }).expect(201)).body;
    expect(share).toMatchObject({ path: PATH, subjectKind: 'user', subject: melId, subjectName: 'MEL', capabilities: ['read', 'list'], note: 'Payments on-call', sharedBy: ownerId, expiresAt: null, state: 'active' });
    expect((await read(mel).expect(200)).body.data).toEqual({ key: 'sk_live' });
    // Nobody else gained anything.
    await read(bob).expect(403);
    await read(cara).expect(403);
    // Only the exact path: a sibling secret stays closed to the grantee.
    await send(owner, 'put', '/api/vault/kv/data/apps/billing/other', { data: { k: 'v' } }).expect(201);
    await read(mel, 'apps/billing/other').expect(403);

    // A share is a policy grant: explain names it, the Policies tab lists it with its expiry.
    const ex = (await send(owner, 'post', '/api/vault/policies/explain', { path: `kv/${PATH}`, capability: 'read', userId: melId }).expect(200)).body;
    expect(ex.decision).toMatchObject({ allow: true, grant: { id: share.id, shareSecretId: expect.any(String) } });
    const listed = (await owner.agent.get('/api/vault/policies').expect(200)).body.policies.find((g: { id: string }) => g.id === share.id);
    expect(listed).toMatchObject({ path: `kv/${PATH}`, effect: 'allow', capabilities: ['read', 'list'], expiresAt: null });
    // Edited only by revoking and sharing again.
    await send(owner, 'patch', `/api/vault/policies/${share.id}`, { capabilities: ['*'] }).expect(409);

    // The grantee sees what is shared with them; others do not.
    expect((await mel.agent.get('/api/vault/shared-with-me').expect(200)).body.shares).toEqual([expect.objectContaining({ id: share.id, path: PATH, label: 'confidential', readable: true, sharedByName: 'OWNER' })]);
    expect((await bob.agent.get('/api/vault/shared-with-me').expect(200)).body.shares).toEqual([]);
    // Members hold secrets:read only: they can neither list a secret's shares nor share it.
    await mel.agent.get(`/api/vault/kv/shares/${PATH}`).expect(403);
    await send(mel, 'post', `/api/vault/kv/shares/${PATH}`, { subjectKind: 'user', subject: bobId }).expect(403);
    expect((await owner.agent.get(`/api/vault/kv/shares/${PATH}`).expect(200)).body.shares).toHaveLength(1);
    const notes = (await h.s.db('notifications').where({ user_id: melId, kind: 'vault' }).select('title')) as { title: string }[];
    expect(notes.map((n) => n.title)).toContain(`A secret was shared with you: ${PATH}`);

    // A deny that names someone wins over a share of their workspace: the share reaches the workspace's other members.
    await send(owner, 'post', '/api/vault/policies', { subjectKind: 'user', subject: bobId, path: 'kv/apps', capabilities: ['read'], effect: 'deny' }).expect(201);
    for (const id of [bobId, (await h.s.users.byUsername(h.tenantId, 'cara'))!.id]) await h.s.users.setWorkspaceMemberships(id, 'direct', [ws]);
    await send(owner, 'post', `/api/vault/kv/shares/${PATH}`, { subjectKind: 'workspace', subject: ws }).expect(201);
    await read(cara).expect(200);
    const denied = await read(bob).expect(403);
    expect(denied.body.grant).toMatchObject({ effect: 'deny' });
    // Sharing with the denied user directly is refused up front, naming the deciding grant.
    const refused = await send(owner, 'post', `/api/vault/kv/shares/${PATH}`, { subjectKind: 'user', subject: bobId }).expect(409);
    expect(refused.body).toMatchObject({ step: 'vault-policy', grant: expect.any(String) });

    // Revocable: the grantee loses it at once; audited.
    expect((await send(owner, 'delete', `/api/vault/shares/${share.id}`).expect(200)).body).toEqual({ id: share.id, revoked: true });
    await read(mel).expect(403);
    const actions = ((await h.s.db('audit_events').where({ tenant_id: h.tenantId }).where('action', 'like', 'vault.secret.share%').select('action', 'detail')) as { action: string; detail: string }[]).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['vault.secret.shared', 'vault.secret.share.revoked']));
    expect(JSON.stringify(await h.s.db('audit_events').where('action', 'like', 'vault.secret.share%'))).not.toContain('sk_live');
  });

  it('refuses a grantee below the label or without vault access; expiry ends a share; removing the secret removes its shares', async () => {
    const low = await localUser(h, 'lou', ['member'], 'internal');
    const r1 = await send(owner, 'post', `/api/vault/kv/shares/${PATH}`, { subjectKind: 'user', subject: low.id }).expect(422);
    expect(r1.body.step).toBe('clearance');
    const nobody = await localUser(h, 'nora', [], 'confidential');
    expect((await send(owner, 'post', `/api/vault/kv/shares/${PATH}`, { subjectKind: 'user', subject: nobody.id }).expect(422)).body.step).toBe('role');
    await send(owner, 'post', `/api/vault/kv/shares/${PATH}`, { subjectKind: 'user', subject: ownerId }).expect(400);

    // With an expiry; sharing again moves it instead of adding a grant.
    const a = (await send(owner, 'post', `/api/vault/kv/shares/${PATH}`, { subjectKind: 'user', subject: melId, expiresInDays: 1 }).expect(201)).body;
    expect(a.expiresAt).toBeGreaterThan(Date.now());
    const b = (await send(owner, 'post', `/api/vault/kv/shares/${PATH}`, { subjectKind: 'user', subject: melId, expiresInDays: 2 }).expect(201)).body;
    expect(b.id).toBe(a.id);
    expect(b.expiresAt).toBeGreaterThan(a.expiresAt);
    await read(mel).expect(200);
    // Past its expiry it stops applying at once, before the job removes it (and audits the end).
    await h.s.db('vault_policies').where({ id: a.id }).update({ expires_at: Date.now() - 1000 });
    await read(mel).expect(403);
    expect(await h.s.vaultShares.expire()).toBe(1);
    expect(await h.s.db('vault_policies').where({ id: a.id })).toHaveLength(0);
    expect(await h.s.db('audit_events').where({ action: 'vault.secret.share.expired' })).toHaveLength(1);

    // VAULT_SHARE_MAX_DAYS caps every share.
    (h.s.cfg as { VAULT_SHARE_MAX_DAYS: number }).VAULT_SHARE_MAX_DAYS = 7;
    await send(owner, 'post', `/api/vault/kv/shares/${PATH}`, { subjectKind: 'user', subject: melId, expiresInDays: 30 }).expect(400);
    const capped = (await send(owner, 'post', `/api/vault/kv/shares/${PATH}`, { subjectKind: 'user', subject: melId }).expect(201)).body;
    expect(capped.expiresAt).toBeLessThanOrEqual(Date.now() + 7 * 86_400_000);

    // A secret removed takes its shares with it: a new secret at the same path is not shared.
    await send(owner, 'delete', `/api/vault/kv/metadata/${PATH}`).expect(204);
    expect(await h.s.db('vault_policies').whereNotNull('share_secret_id')).toHaveLength(0);
    await send(owner, 'put', `/api/vault/kv/data/${PATH}`, { data: { key: 'new' }, label: 'confidential' }).expect(201);
    await read(mel).expect(403);
  });
});
