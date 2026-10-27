import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

const send = (c: Client, method: 'post' | 'put', url: string, body: object = {}, ip?: string) => {
  const r = c.agent[method](url).set('x-csrf-token', c.csrf);
  if (ip) r.set('x-forwarded-for', ip);
  return r.send(body);
};
const reveal = (c: Client, ip: string, path = 'apps/billing/stripe') => c.agent.get(`/api/vault/kv/data/${path}`).set('x-forwarded-for', ip);

describe('B-4803: anomaly detection on reveals', () => {
  let h: Harness;
  let owner: Client;
  let ownerId: string;
  let member: Client;
  let memberId: string;

  beforeEach(async () => {
    h = await harness();
    const a = await localUser(h, 'owner', ['tenant-admin'], 'restricted');
    ownerId = a.id;
    owner = await loginAdmin(h, 'owner');
    const m = await localUser(h, 'mel', ['member'], 'internal');
    memberId = m.id;
    const l = await login(h, 'mel');
    member = { agent: l.agent, csrf: l.csrf, cookie: l.cookie };
    await send(owner, 'post', '/api/vault/policies', { subjectKind: 'user', subject: ownerId, path: '*', capabilities: ['*'] }).expect(201);
    await send(owner, 'post', '/api/vault/policies', { subjectKind: 'user', subject: memberId, path: 'kv/apps', capabilities: ['read'] }).expect(201);
    await send(owner, 'put', '/api/vault/kv/data/apps/billing/stripe', { data: { key: 'sk_live' } }).expect(201);
  });
  afterEach(async () => {
    await h.close();
  });

  const flags = async () => (await h.s.db('vault_reveal_flags').orderBy('created_at')) as { id: string; principal: string; signals: string; reveals: number; state: string; owner_id: string }[];

  it('a burst of reveals from a new address raises a flag for the owner before the tenth reveal', async () => {
    // The usual address: the owner reads it twice. Nothing unusual yet.
    await reveal(owner, '198.51.100.1').expect(200);
    await reveal(owner, '198.51.100.1').expect(200);
    expect(await flags()).toHaveLength(0);
    // Someone else, from an address it was never revealed from, in a burst.
    const raisedAt: number[] = [];
    for (let i = 1; i <= 9; i++) {
      const r = await reveal(member, '203.0.113.9').expect(200); // detection never refuses a reveal
      expect(r.body.data.key).toBe('sk_live');
      if ((await flags()).length && !raisedAt.length) raisedAt.push(i);
    }
    expect(raisedAt[0]).toBeDefined();
    expect(raisedAt[0]!).toBeLessThan(10);
    const [f] = await flags();
    expect(f).toMatchObject({ principal: `user:${memberId}`, state: 'open', owner_id: ownerId, reveals: 9 });
    expect(JSON.parse(f!.signals).map((x: { kind: string }) => x.kind)).toEqual(['new-address', 'burst']);

    // The owner is told, and sees it under Vault; the member (not the owner, not a vault admin) does not.
    const notes = (await h.s.db('notifications').where({ user_id: ownerId, kind: 'vault' }).select('title')) as { title: string }[];
    expect(notes.map((n) => n.title)).toEqual(expect.arrayContaining(['Unusual reveal of apps/billing/stripe']));
    const list = (await owner.agent.get('/api/vault/reveal-flags').expect(200)).body.flags;
    expect(list).toEqual([expect.objectContaining({ id: f!.id, path: 'apps/billing/stripe', principalName: 'mel', ip: '203.0.113.9', reveals: 9 })]);
    expect((await member.agent.get('/api/vault/reveal-flags').expect(200)).body.flags).toEqual([]);
    await member.agent.get(`/api/vault/reveal-flags/${f!.id}`).expect(404);
    const detail = (await owner.agent.get(`/api/vault/reveal-flags/${f!.id}`).expect(200)).body;
    expect(detail.recent.filter((r: { flagged: boolean }) => r.flagged)).toHaveLength(9);
    await send(member, 'post', `/api/vault/reveal-flags/${f!.id}/resolve`, { decision: 'expected' }).expect(404);

    // Resolved by the owner, audited; a second resolution is refused.
    const res = (await send(owner, 'post', `/api/vault/reveal-flags/${f!.id}/resolve`, { decision: 'suspicious', note: 'Not a known laptop; rotating' }).expect(200)).body;
    expect(res).toMatchObject({ state: 'suspicious', note: 'Not a known laptop; rotating' });
    await send(owner, 'post', `/api/vault/reveal-flags/${f!.id}/resolve`, { decision: 'expected' }).expect(409);
    const actions = (await h.s.db('audit_events').where({ tenant_id: h.tenantId }).where('action', 'like', 'vault.reveal.%').select('action', 'detail')) as { action: string; detail: string }[];
    expect(actions.map((x) => x.action)).toEqual(expect.arrayContaining(['vault.reveal.flagged', 'vault.reveal.flag.updated', 'vault.reveal.flag.resolved']));
    // The audit chain never carries the value.
    expect(JSON.stringify(actions)).not.toContain('sk_live');
    // A later reveal by the same caller opens a new flag only when something is unusual again.
    await reveal(member, '203.0.113.9').expect(200);
    expect((await flags()).filter((x) => x.state === 'open')).toHaveLength(1); // still a burst within the window
  });

  it('an odd hour is a reveal in an hour of the day the secret was never revealed in', async () => {
    const secret = (await h.s.db('vault_secrets').where({ path: 'apps/billing/stripe' }).first()) as { id: string };
    const now = Date.now();
    const other = (new Date(now).getUTCHours() + 12) % 24;
    // 20 earlier reveals (VAULT_ANOMALY_MIN_HISTORY), all from this address, none in this hour of the day.
    await h.s.db('vault_reveals').insert(Array.from({ length: 20 }, (_, i) => ({ id: ulid(), tenant_id: h.tenantId, secret_id: secret.id, version: 1, principal: `user:${ownerId}`, ip: '198.51.100.1', via: null, hour: other, at: now - (i + 1) * 3_600_000 })));
    await reveal(owner, '198.51.100.1').expect(200);
    const [f] = await flags();
    expect(JSON.parse(f!.signals).map((x: { kind: string }) => x.kind)).toEqual(['odd-hour']);
    // The second reveal in this hour is no longer odd (the flag stays open and counts it).
    await reveal(owner, '198.51.100.1').expect(200);
    expect(await flags()).toHaveLength(1);
    expect((await flags())[0]!.reveals).toBe(2);
  });

  it('values resolved by the server carry no address and are not watched; VAULT_ANOMALY_BURST=0 turns detection off; old reveals are pruned', async () => {
    for (let i = 0; i < 6; i++) await h.s.vault.resolveFor(h.tenantId, ownerId, 'vault:apps/billing/stripe#key', { via: 'workflow' });
    expect(await h.s.db('vault_reveals')).toHaveLength(0);
    (h.s.cfg as { VAULT_ANOMALY_BURST: number }).VAULT_ANOMALY_BURST = 0;
    for (let i = 0; i < 6; i++) await reveal(member, '203.0.113.50').expect(200);
    expect(await h.s.db('vault_reveals')).toHaveLength(0);
    (h.s.cfg as { VAULT_ANOMALY_BURST: number }).VAULT_ANOMALY_BURST = 5;
    await reveal(member, '203.0.113.50').expect(200);
    await h.s.db('vault_reveals').update({ at: Date.now() - 31 * 86_400_000 });
    expect(await h.s.revealWatch.prune()).toEqual({ deleted: 1 });
  });
});
