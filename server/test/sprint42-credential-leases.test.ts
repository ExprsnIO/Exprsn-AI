import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiKeyService } from '../src/identity/apikeys.js';
import { LEASE_TOKEN_PREFIX, SessionService } from '../src/identity/sessions.js';
import { harness, localUser, login, loginAdmin, type Harness } from './helpers.js';

/*
 * 1.7.0, Sprint 42 (B-9206): sessions and API keys as leases that hold only verifiers, read beside the `sessions`
 * and `api_keys` tables by the form of the token or key.
 */

const COOKIE = 'exai_sid';
const tokenOf = (cookie: string): string => decodeURIComponent(new RegExp(`${COOKIE}=([^;]+)`).exec(cookie)?.[1] ?? '');
const me = (h: Harness, token: string) => request(h.app).get('/api/me').set('cookie', `${COOKIE}=${token}`);
const bearer = (h: Harness, key: string) => request(h.app).get('/api/me').set('authorization', `Bearer ${key}`);
const leasesOf = (h: Harness, kind: string) => h.s.db('vault_leases').where({ kind }) as Promise<Record<string, unknown>[]>;

/** The session service of a build that keeps sessions in the table (the same key, the same database). */
const tableSessions = (h: Harness) => new SessionService(h.s.db, { secret: h.s.sysKeys.key('session'), idleMinutes: h.s.cfg.SESSION_IDLE_MINUTES, absoluteHours: h.s.cfg.SESSION_ABSOLUTE_HOURS, pendingMinutes: h.s.cfg.MFA_PENDING_MINUTES });
const tableKeys = (h: Harness) => new ApiKeyService(h.s.db, h.s.sysKeys.key('api-key'));

describe('B-9206: sessions and API keys as leases', () => {
  let h: Harness;
  afterEach(async () => {
    await h?.close();
  });

  it('keeps sessions and keys in their tables unless the store is switched', async () => {
    h = await harness();
    const u = await localUser(h, 'alice', ['member']);
    const c = await login(h, 'alice');
    expect(tokenOf(c.cookie).startsWith(LEASE_TOKEN_PREFIX)).toBe(false);
    expect(await h.s.db('sessions').where({ user_id: u.id })).toHaveLength(1);
    const { key } = await h.s.apiKeys.create({ tenantId: h.tenantId, userId: u.id, name: 'k', scopes: ['chat:read'], ttlDays: 30 });
    expect(key.startsWith('exai_k1_')).toBe(true);
    await bearer(h, key).expect(200);
    expect(await leasesOf(h, 'session')).toHaveLength(0);
    expect(await leasesOf(h, 'api-key')).toHaveLength(0);
  });

  it('an existing session still works, a new one is a lease, and signing out revokes it', async () => {
    h = await harness({ CREDENTIAL_STORE: 'leases', VAULT_LEASE_CACHE_MS: '0' });
    const u = await localUser(h, 'alice', ['member']);
    // A session from before the switch: a row of `sessions`.
    const old = await tableSessions(h).create({ userId: u.id, tenantId: h.tenantId, stage: 'active', method: 'password', providerId: null, ip: '10.0.0.1', userAgent: 'old browser' });
    await me(h, old.token).expect(200);

    const c = await login(h, 'alice');
    const token = tokenOf(c.cookie);
    expect(token.startsWith(LEASE_TOKEN_PREFIX)).toBe(true);
    expect(await h.s.db('sessions').where({ user_id: u.id })).toHaveLength(1); // only the old one
    const [lease] = await leasesOf(h, 'session');
    expect(lease).toMatchObject({ tenant_id: h.tenantId, holder_kind: 'user', holder: u.id, state: 'active', verifier: h.s.sessions.idFor(token) });
    // Only a verifier: neither the token nor its random part is anywhere in the row.
    expect(JSON.stringify(lease)).not.toContain(token.slice(LEASE_TOKEN_PREFIX.length));
    // The renew period is the idle timeout, the maximum the absolute lifetime.
    expect(Number(lease!.renew_period_ms)).toBe(h.s.cfg.SESSION_IDLE_MINUTES * 60_000);
    expect(Number(lease!.max_expires_at) - Number(lease!.issued_at)).toBeGreaterThan(h.s.cfg.SESSION_ABSOLUTE_HOURS * 3600_000 - 5000);

    // One indexed lookup per request (the cache is off here), for the lease and none for the table session.
    const before = h.s.leases.lookups;
    await me(h, token).expect(200);
    expect(h.s.leases.lookups - before).toBe(1);
    await me(h, old.token).expect(200);
    expect(h.s.leases.lookups - before).toBe(1);

    // Both are listed as the person's sessions, and each can end the other.
    const listed = (await c.agent.get('/api/me/sessions').expect(200)).body as { id: string; current: boolean; userAgent: string | null }[];
    expect(listed.map((x) => x.id).sort()).toEqual([old.session.id, h.s.sessions.idFor(token)].sort());
    expect(listed.find((x) => x.current)?.id).toBe(h.s.sessions.idFor(token));

    // Signing out revokes the lease; the old session is untouched.
    await c.agent.post('/api/auth/logout').set('x-csrf-token', c.csrf).send({}).expect((r) => expect(r.status).toBeLessThan(300));
    expect((await leasesOf(h, 'session'))[0]).toMatchObject({ state: 'revoked', end_reason: 'revoked' });
    await me(h, token).expect(401);
    await me(h, old.token).expect(200);
    expect(await h.s.sessions.gone(h.s.sessions.idFor(token))).toBe(true);
    expect(await h.s.sessions.gone(old.session.id)).toBe(false);
  });

  it('a lease session follows the stages, the idle timeout, sign-out everywhere and the purge', async () => {
    h = await harness({ CREDENTIAL_STORE: 'leases', VAULT_LEASE_CACHE_MS: '0' });
    await localUser(h, 'root', ['tenant-admin']);
    const bob = await localUser(h, 'bob', ['member']);

    // An admin enrols a factor: the pending session is a short lease, and completing it gives the same lease a new
    // digest and the active life.
    const admin = await loginAdmin(h, 'root');
    const adminToken = tokenOf(admin.cookie);
    const adminLeases = await leasesOf(h, 'session');
    expect(adminLeases).toHaveLength(1); // rotated in place, not a second lease
    expect(adminLeases[0]).toMatchObject({ state: 'active', verifier: h.s.sessions.idFor(adminToken) });
    expect(JSON.parse(String(adminLeases[0]!.data))).toMatchObject({ stage: 'active', sid: h.s.sessions.idFor(adminToken) });
    expect(Number(adminLeases[0]!.renew_period_ms)).toBe(h.s.cfg.SESSION_IDLE_MINUTES * 60_000);
    await me(h, adminToken).expect(200);

    // Idle: a use renews the lease by the idle timeout, at most once a minute; a lease past its expiry is refused.
    const a = await login(h, 'bob');
    const b = await login(h, 'bob');
    const ta = tokenOf(a.cookie);
    const tb = tokenOf(b.cookie);
    const ida = h.s.sessions.idFor(ta);
    const now = Date.now();
    await h.s.db('vault_leases').where({ verifier: ida }).update({ renewed_at: now - 5 * 60_000, expires_at: now + 20_000 });
    await me(h, ta).expect(200);
    const renewed = (await h.s.db('vault_leases').where({ verifier: ida }).first()) as { expires_at: number; renewed_at: number; max_expires_at: number };
    expect(Number(renewed.expires_at)).toBeGreaterThan(now + h.s.cfg.SESSION_IDLE_MINUTES * 60_000 - 5000);
    expect(Number(renewed.expires_at)).toBeLessThanOrEqual(Number(renewed.max_expires_at));
    await h.s.db('vault_leases').where({ verifier: ida }).update({ expires_at: Date.now() - 1000 });
    await me(h, ta).expect(401);

    // The sweep ends it without an audit entry of its own, and the purge removes it a day later.
    const audited = async (action: string) => ((await h.s.db('audit_events').where({ tenant_id: h.tenantId, action })) as unknown[]).length;
    expect(await audited('vault.lease.issued')).toBe(0);
    await h.s.leases.sweep();
    expect((await h.s.db('vault_leases').where({ verifier: ida }).first()) as { state: string }).toMatchObject({ state: 'expired' });
    expect(await audited('vault.lease.expired')).toBe(0);
    await h.s.db('vault_leases').where({ verifier: ida }).update({ ended_at: Date.now() - 25 * 3600_000 });
    await h.s.sessions.purge();
    expect(await h.s.db('vault_leases').where({ verifier: ida }).first()).toBeUndefined();

    // Sign out everywhere else keeps the current session and ends the others, leases and rows alike.
    const row = await tableSessions(h).create({ userId: bob.id, tenantId: h.tenantId, stage: 'active', method: 'password', providerId: null, ip: null, userAgent: null });
    const c2 = await login(h, 'bob');
    const res = await c2.agent.post('/api/me/sessions/revoke-others').set('x-csrf-token', c2.csrf).send({}).expect(200);
    expect(res.body.revoked).toBe(2);
    await me(h, tb).expect(401);
    await me(h, row.token).expect(401);
    await me(h, tokenOf(c2.cookie)).expect(200);
    expect(await audited('vault.lease.revoked')).toBeGreaterThan(0);

    // An admin ending a user's sessions (the account is disabled) ends the lease too.
    expect(await h.s.sessions.revokeAllForUser(bob.id)).toBe(1);
    await me(h, tokenOf(c2.cookie)).expect(401);
    // And a whole tenant's.
    expect(await h.s.sessions.revokeAllForTenant(h.tenantId)).toBe(1);
    await me(h, adminToken).expect(401);
  });

  it('a new API key is a lease that holds only its verifier; the key and the lease end together', async () => {
    h = await harness({ CREDENTIAL_STORE: 'leases', VAULT_LEASE_CACHE_MS: '0' });
    const u = await localUser(h, 'alice', ['member']);
    // A key from before the switch.
    const old = await tableKeys(h).create({ tenantId: h.tenantId, userId: u.id, name: 'old', scopes: ['chat:read'], ttlDays: 30 });
    await bearer(h, old.key).expect(200);

    const { key, row } = await h.s.apiKeys.create({ tenantId: h.tenantId, userId: u.id, name: 'new', scopes: ['chat:read', 'chat:write'], ttlDays: 30 });
    expect(key.startsWith('exai_k2_')).toBe(true);
    const stored = (await h.s.db('api_keys').where({ id: row.id }).first()) as { secret_hash: string; store_lease_id: string };
    expect(stored.secret_hash).toBe(`lease:${stored.store_lease_id}`);
    const [lease] = await leasesOf(h, 'api-key');
    expect(lease).toMatchObject({ id: stored.store_lease_id, holder: u.id, ref: row.id, state: 'active' });
    expect(String(lease!.verifier)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(lease) + JSON.stringify(stored)).not.toContain(key.split('_')[3]);
    expect(Number(lease!.max_expires_at)).toBeGreaterThan(Date.now() + 29 * 86400_000);

    // One indexed lookup per request, on the lease table only.
    const before = h.s.leases.lookups;
    await bearer(h, key).expect(200);
    expect(h.s.leases.lookups - before).toBe(1);
    expect(await h.s.apiKeys.verify(key)).toMatchObject({ id: row.id, tenant_id: h.tenantId, user_id: u.id, scopes: ['chat:read', 'chat:write'], lease_id: null });
    expect((await h.s.db('api_keys').where({ id: row.id }).first()) as { last_used_at: number | null }).toMatchObject({ last_used_at: expect.any(Number) });
    // It is listed with the person's keys, in its own form.
    const c = await login(h, 'alice');
    const listed = (await c.agent.get('/api/me/api-keys').expect(200)).body as { id: string; prefix: string; state: string }[];
    expect(listed.find((k) => k.id === row.id)).toMatchObject({ prefix: `exai_k2_${row.prefix}`, state: 'active' });
    expect(listed.find((k) => k.id === old.row.id)).toMatchObject({ prefix: `exai_k1_${old.row.prefix}` });

    // Changes to the key reach the lease a request reads.
    await h.s.apiKeys.setScopes(row.id, ['chat:read']);
    expect((await h.s.apiKeys.verify(key))?.scopes).toEqual(['chat:read']);
    await h.s.apiKeys.setSignatureKey(u.id, row.id, 'abc');
    expect((await h.s.apiKeys.verify(key))?.signature_key).toBe('abc');
    await h.s.apiKeys.setSignatureKey(u.id, row.id, null);

    // Revoking the key revokes the lease, at once.
    await c.agent.delete(`/api/me/api-keys/${row.id}`).set('x-csrf-token', c.csrf).expect(204);
    expect((await leasesOf(h, 'api-key'))[0]).toMatchObject({ state: 'revoked' });
    await bearer(h, key).expect(401);
    await bearer(h, old.key).expect(200);

    // Revoking the lease revokes the key's record.
    const second = await h.s.apiKeys.create({ tenantId: h.tenantId, userId: u.id, name: 'second', scopes: ['chat:read'], ttlDays: 30 });
    const secondRow = (await h.s.db('api_keys').where({ id: second.row.id }).first()) as { store_lease_id: string };
    await h.s.leases.revoke(h.tenantId, secondRow.store_lease_id, { service: 'test' });
    expect(((await h.s.db('api_keys').where({ id: second.row.id }).first()) as { revoked_at: number | null }).revoked_at).not.toBeNull();
    expect(await h.s.apiKeys.verify(second.key)).toBeNull();

    // A key past its expiry is refused before any sweep.
    const third = await h.s.apiKeys.create({ tenantId: h.tenantId, userId: u.id, name: 'third', scopes: ['chat:read'], ttlDays: 30 });
    await h.s.db('vault_leases').where({ ref: third.row.id }).update({ expires_at: Date.now() - 1 });
    expect(await h.s.apiKeys.verify(third.key)).toBeNull();

    // Offboarding and "every key of a user" end leases too.
    const fourth = await h.s.apiKeys.create({ tenantId: h.tenantId, userId: u.id, name: 'fourth', scopes: ['chat:read'], ttlDays: 30 });
    const fifth = await h.s.apiKeys.create({ tenantId: h.tenantId, userId: u.id, name: 'fifth', scopes: ['chat:read'], ttlDays: 30 });
    expect(await h.s.apiKeys.revokeAllForUser(u.id)).toBeGreaterThanOrEqual(3);
    expect(await h.s.apiKeys.verify(fourth.key)).toBeNull();
    expect(await h.s.apiKeys.verify(fifth.key)).toBeNull();
    expect(await h.s.apiKeys.verify(old.key)).toBeNull();
    const sixth = await h.s.apiKeys.create({ tenantId: h.tenantId, userId: u.id, name: 'sixth', scopes: ['chat:read'], ttlDays: 30 });
    expect(await h.s.apiKeys.revokeAllForTenant(h.tenantId)).toBe(1);
    expect(await h.s.apiKeys.verify(sixth.key)).toBeNull();

    // A build that knows no leases revokes a key by its record alone; the lease is ended at the next start or housekeeping.
    const seventh = await h.s.apiKeys.create({ tenantId: h.tenantId, userId: u.id, name: 'seventh', scopes: ['chat:read'], ttlDays: 30 });
    await h.s.db('api_keys').where({ id: seventh.row.id }).update({ revoked_at: Date.now() });
    expect(await h.s.apiKeys.reconcileLeases()).toBe(1);
    expect(await h.s.apiKeys.verify(seventh.key)).toBeNull();
    expect(await h.s.apiKeys.reconcileLeases()).toBe(0);

    // A key issued under a dynamic lease (B-9301) stays a row: its own lease governs it.
    const dynamic = await h.s.apiKeys.create({ tenantId: h.tenantId, userId: u.id, name: 'dynamic', scopes: ['chat:read'], ttlDays: 0, expiresAt: Date.now() + 3600_000, leaseId: '01HZZZZZZZZZZZZZZZZZZZZZZZ' });
    expect(dynamic.key.startsWith('exai_k1_')).toBe(true);
    expect(dynamic.row.store_lease_id).toBeNull();
  });

  it('switching back keeps what was issued as leases, and a build that reads only the tables refuses it', async () => {
    h = await harness({ CREDENTIAL_STORE: 'leases' });
    const u = await localUser(h, 'alice', ['member']);
    const c = await login(h, 'alice');
    const token = tokenOf(c.cookie);
    const { key } = await h.s.apiKeys.create({ tenantId: h.tenantId, userId: u.id, name: 'k', scopes: ['chat:read'], ttlDays: 30 });

    // The same database with CREDENTIAL_STORE=table and the lease table at hand: both are still read, new ones are rows.
    const back = new SessionService(h.s.db, { secret: h.s.sysKeys.key('session'), idleMinutes: 30, absoluteHours: 12, pendingMinutes: 5, store: 'table', leases: () => h.s.leases });
    expect((await back.resolve(token))?.user_id).toBe(u.id);
    expect((await back.create({ userId: u.id, tenantId: h.tenantId, stage: 'active', method: 'password', providerId: null, ip: null, userAgent: null })).token.startsWith(LEASE_TOKEN_PREFIX)).toBe(false);
    const keysBack = new ApiKeyService(h.s.db, h.s.sysKeys.key('api-key'), async () => false, { store: 'table', leases: () => h.s.leases });
    expect((await keysBack.verify(key))?.user_id).toBe(u.id);
    expect((await keysBack.create({ tenantId: h.tenantId, userId: u.id, name: 'k1', scopes: ['chat:read'], ttlDays: 30 })).key.startsWith('exai_k1_')).toBe(true);

    // A build from before the migration knows no leases: it refuses them (fails closed) and is otherwise unharmed.
    expect(await tableSessions(h).resolve(token)).toBeNull();
    expect(await tableKeys(h).verify(key)).toBeNull();
    // With the warm cache a second request reads nothing.
    await me(h, token).expect(200);
    const before = h.s.leases.lookups;
    await me(h, token).expect(200);
    expect(h.s.leases.lookups - before).toBe(0);
  });
});
