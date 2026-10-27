import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claimsFor, ecPair, es256, jwt, pem, setupApp } from './sprint39d-helpers.js';
import { harness, localUser, login, type Harness } from './helpers.js';

/*
 * 1.8.0, Sprint 48 (B-146): use-limited credentials. An API key (an `exai_k1_` row or an `exai_k2_` lease) or an
 * embedded session accepted at most `max_uses` times: each accepted use is spent by one conditional update, so
 * parallel requests never pass the limit; at zero the key is revoked through ApiKeyService (its lease ends too), the
 * revocation audited and the owner told. A credential without a limit is untouched.
 */

const bearer = (h: Harness, key: string) => request(h.app).get('/api/me').set('authorization', `Bearer ${key}`);

async function owner(h: Harness, name = 'alice') {
  const u = await localUser(h, name, ['member']);
  const c = await login(h, name);
  const mint = async (body: Record<string, unknown>) => (await c.agent.post('/api/me/api-keys').set('x-csrf-token', c.csrf).send({ name: 'k', scopes: ['chat:read'], ttlDays: 30, ...body }).expect(201)).body as { id: string; key: string; maxUses: number | null; usesLeft: number | null };
  const keys = async () => (await c.agent.get('/api/me/api-keys').expect(200)).body as { id: string; state: string; maxUses: number | null; usesLeft: number | null }[];
  return { user: u, c, mint, keys };
}

const statuses = async (h: Harness, key: string, n: number) => (await Promise.all(Array.from({ length: n }, () => bearer(h, key)))).map((r) => r.status);

describe('B-146: use-limited API keys', () => {
  let h: Harness;
  afterEach(async () => {
    await h?.close();
  });

  for (const store of ['table', 'leases'] as const) {
    it(`a counted key (${store}): each use counts, the list shows what is left, and at zero it is revoked, audited and its owner told`, async () => {
      h = await harness(store === 'leases' ? { CREDENTIAL_STORE: 'leases', VAULT_LEASE_CACHE_MS: '0' } : {});
      const o = await owner(h);
      const made = await o.mint({ maxUses: 3 });
      expect(made.key.startsWith(store === 'leases' ? 'exai_k2_' : 'exai_k1_')).toBe(true);
      expect(made).toMatchObject({ maxUses: 3, usesLeft: 3 });
      await bearer(h, made.key).expect(200);
      expect((await o.keys()).find((k) => k.id === made.id)).toMatchObject({ state: 'active', maxUses: 3, usesLeft: 2 });
      await bearer(h, made.key).expect(200);
      await bearer(h, made.key).expect(200); // the last use is accepted, and the key revoked after it
      const listed = (await o.keys()).find((k) => k.id === made.id)!;
      expect(listed).toMatchObject({ state: 'revoked', maxUses: 3, usesLeft: 0 });
      await bearer(h, made.key).expect(401);
      if (store === 'leases') {
        const row = (await h.s.db('api_keys').where({ id: made.id }).first()) as { store_lease_id: string; revoked_at: number | null };
        expect(row.revoked_at).not.toBeNull();
        expect(((await h.s.db('vault_leases').where({ id: row.store_lease_id }).first()) as { state: string }).state).toBe('revoked');
      }
      const audits = (await h.s.db('audit_events').where({ action: 'apikey.exhausted' })) as { target: string; detail: string }[];
      expect(audits).toHaveLength(1);
      expect(JSON.parse(audits[0]!.target)).toMatchObject({ key: made.id });
      expect(JSON.parse(audits[0]!.detail)).toMatchObject({ maxUses: 3, store: store === 'leases' ? 'lease' : 'table' });
      const notes = (await h.s.db('notifications').where({ user_id: o.user.id })) as { title: string; body: string }[];
      expect(notes.map((n) => n.title)).toContain('An API key used its last allowed use and was revoked');
      expect(JSON.stringify(notes)).not.toContain(made.key);
    }, 60_000);

    it(`parallel requests never pass the limit (${store})`, async () => {
      h = await harness(store === 'leases' ? { CREDENTIAL_STORE: 'leases', VAULT_LEASE_CACHE_MS: '0' } : {});
      const o = await owner(h);
      const made = await o.mint({ maxUses: 5 });
      const out = await statuses(h, made.key, 20);
      expect(out.filter((s) => s === 200)).toHaveLength(5);
      expect(out.filter((s) => s === 401)).toHaveLength(15);
      expect(await h.s.db('audit_events').where({ action: 'apikey.exhausted' })).toHaveLength(1);
      // a second service on the same database (another instance) finds nothing left either
      expect(await h.s.apiKeys.verify(made.key)).toBeNull();
    }, 60_000);
  }

  it('a one-shot key answers once', async () => {
    h = await harness({ CREDENTIAL_STORE: 'leases', VAULT_LEASE_CACHE_MS: '60000' });
    const o = await owner(h);
    const made = await o.mint({ maxUses: 1 });
    await bearer(h, made.key).expect(200);
    await bearer(h, made.key).expect(401);
    expect((await o.keys())[0]).toMatchObject({ state: 'revoked', usesLeft: 0 });
    // maxUses is a whole number of at least one
    await o.c.agent.post('/api/me/api-keys').set('x-csrf-token', o.c.csrf).send({ name: 'k', scopes: ['chat:read'], ttlDays: 30, maxUses: 0 }).expect(400);
  }, 60_000);

  it('a one-shot agent key', async () => {
    h = await harness();
    const u = await localUser(h, 'tom', ['tool-admin', 'member']);
    const { key, row } = await h.s.apiKeys.create({ tenantId: h.tenantId, userId: u.id, name: 'agent task', scopes: ['chat:read'], ttlDays: 30, maxUses: 1 });
    expect(row).toMatchObject({ max_uses: 1, uses_left: 1 });
    expect(await h.s.apiKeys.verify(key)).toMatchObject({ id: row.id, uses_left: 0 });
    expect(await h.s.apiKeys.verify(key)).toBeNull();
    expect((await h.s.apiKeys.get(row.id))!.revoked_at).not.toBeNull();
  }, 60_000);

  for (const store of ['table', 'leases'] as const) {
    it(`a key without a limit is unaffected and spends nothing (${store})`, async () => {
      h = await harness(store === 'leases' ? { CREDENTIAL_STORE: 'leases', VAULT_LEASE_CACHE_MS: '0' } : {});
      const o = await owner(h);
      const made = await o.mint({});
      expect(made).toMatchObject({ maxUses: null, usesLeft: null });
      const spend = vi.spyOn(h.s.leases, 'spend');
      expect(await statuses(h, made.key, 12)).toEqual(Array(12).fill(200));
      expect(spend).not.toHaveBeenCalled();
      const row = (await h.s.db('api_keys').where({ id: made.id }).first()) as { max_uses: unknown; uses_left: unknown; revoked_at: unknown };
      expect(row).toMatchObject({ max_uses: null, uses_left: null, revoked_at: null });
      expect((await o.keys())[0]).toMatchObject({ state: 'active', maxUses: null, usesLeft: null });
      expect(await h.s.db('audit_events').where({ action: 'apikey.exhausted' })).toHaveLength(0);
    }, 60_000);
  }
});

describe('B-146: use-limited embedded sessions', () => {
  it('a host token with max_uses opens a session that answers that many requests', async () => {
    const f = await setupApp();
    try {
      const { dee, h, member, bearer: as } = f;
      await member('ana');
      const host = ecPair();
      const cfg = (await dee.put('/api/apps/crm/embed', { signedEnabled: true, allowedHosts: ['https://portal.example.com'], entities: ['deal'] }).expect(200)).body as { audience: string };
      await dee.post('/api/apps/crm/embed/keys', { kid: 'portal-1', alg: 'ES256', publicKey: pem(host.publicKey) }).expect(201);
      const open = (claims: Record<string, unknown>) => request(h.app).post('/api/public/embeds/session').send({ tenant: h.tenantId, app: 'crm', token: jwt({ alg: 'ES256', kid: 'portal-1' }, claimsFor(cfg.audience, 'ana', claims), es256(host.privateKey)) });
      expect((await open({ max_uses: 0 }).expect(401)).body.detail).toMatch(/max_uses/);
      const s = (await open({ max_uses: 2 }).expect(200)).body as { token: string };
      const out = await Promise.all(Array.from({ length: 6 }, () => as(s.token).get('/api/apps/crm/deal')));
      expect(out.filter((r) => r.status === 200)).toHaveLength(2);
      expect(out.filter((r) => r.status === 401)).toHaveLength(4);
      expect(await h.s.db('audit_events').where({ action: 'app.embed.session.exhausted' })).toHaveLength(1);
      const row = (await h.s.db('app_embed_sessions').where({ token_hash: (await import('../src/crypto/index.js')).sha256(s.token) }).first()) as { revoked_at: unknown; uses_left: unknown };
      expect(row.revoked_at).not.toBeNull();
      expect(Number(row.uses_left)).toBe(0);
      // without the claim: no limit
      const free = (await open({}).expect(200)).body as { token: string };
      expect((await Promise.all(Array.from({ length: 4 }, () => as(free.token).get('/api/apps/crm/deal')))).map((r) => r.status)).toEqual([200, 200, 200, 200]);
    } finally {
      await f.h.close();
    }
  }, 60_000);
});
