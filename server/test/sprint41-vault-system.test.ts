import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hmac } from '../src/crypto/index.js';
import { createApp } from '../src/http/app.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { Metrics, createLogger } from '../src/observability/index.js';
import { BOOT_STEPS, BootError, openVault } from '../src/ops/boot.js';
import { createKms } from '../src/platform/kms.js';
import { createServices, type Services } from '../src/services.js';
import { mac, macMatches, macs, staticKey, SYS_KEY_NAMES, type KeySource } from '../src/vault/keyring.js';
import { evaluate, isSysVaultPath, isVaultPath, SYS_SCOPE, type Grant } from '../src/vault/policy.js';
import { harness, localUser, login, loginAdmin, testConfig, type Client, type Harness } from './helpers.js';
import { closeLoopback, serveOnLoopback } from './loopback.js';
import { drain } from './retrieval-seed.js';
import { FakeClamd, FakePreviewRenderer } from './sprint26d-fakes.js';

const send = (c: Client, method: 'post' | 'put' | 'patch' | 'delete', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);
const b64 = (s: string) => Buffer.from(s).toString('base64');
const until = async (ok: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  return ok();
};

describe('key sources (B-9205)', () => {
  it('signs with the current version and accepts every accepted one', () => {
    const two: KeySource = { all: () => ['new-secret', 'old-secret'] };
    expect(mac(two, 'x')).toBe(hmac('new-secret', 'x'));
    expect(macs(two, 'x')).toEqual([hmac('new-secret', 'x'), hmac('old-secret', 'x')]);
    expect(macMatches(two, 'x', hmac('old-secret', 'x'))).toBe(true);
    expect(macMatches(two, 'x', hmac('retired', 'x'))).toBe(false);
    expect(macMatches(two, 'x', hmac('old-secret', 'x').slice(0, 32), 32)).toBe(true);
    expect(mac(staticKey('s'), 'x')).toBe(hmac('s', 'x'));
  });

  it('keeps sys/ paths apart from tenant paths, and the service subject apart from users', () => {
    expect(isVaultPath('sys/transit/session')).toBe(false);
    expect(isSysVaultPath('sys/transit/session')).toBe(true);
    expect(isSysVaultPath('sys')).toBe(true);
    expect(isSysVaultPath('transit/session')).toBe(false);
    const g: Grant = { id: 'G1', subjectKind: 'service', subject: 'federation.oidc', path: 'sys/transit/federation', capabilities: ['sign', 'verify'], effect: 'allow' };
    const service = { userId: null, groups: [], workspaces: [], apiKeyId: null, service: 'federation.oidc' };
    expect(evaluate([g], service, 'sys/transit/federation', 'verify').allow).toBe(true);
    expect(evaluate([g], { ...service, service: 'channels' }, 'sys/transit/federation', 'verify').allow).toBe(false);
    expect(evaluate([g], { userId: 'federation.oidc', groups: ['federation.oidc'], workspaces: [], apiKeyId: null }, 'sys/transit/federation', 'verify').allow).toBe(false);
  });
});

describe('Sprint 41: the vault for signing keys and session tokens (B-9201 to B-9205)', () => {
  let h: Harness;
  let clamd: FakeClamd;
  let root: Client;

  beforeEach(async () => {
    clamd = await new FakeClamd().start();
    h = await harness({ CLAMD_HOST: '127.0.0.1', CLAMD_PORT: String(clamd.port) }, { previewRenderer: new FakePreviewRenderer() });
    await localUser(h, 'root', ['system-admin'], 'restricted');
    root = await loginAdmin(h, 'root');
  });
  afterEach(async () => {
    await h.close();
    await clamd.stop();
  });

  const audits = async (action: string) => ((await h.s.db('audit_events').where({ tenant_id: h.tenantId, action })) as { actor: string; target: string; detail: string | null }[]).map((a) => ({ actor: JSON.parse(a.actor) as Record<string, unknown>, target: JSON.parse(a.target) as Record<string, unknown>, detail: JSON.parse(a.detail ?? '{}') as Record<string, unknown> }));

  it('B-9201: the OIDC provider reads a sys/ key as the service subject; a tenant admin never lists or reads it', async () => {
    // Before the scope is opened the digest is the old derivation, and version 1 keeps it exactly.
    const before = h.s.federation.oidc.digest('code', 'abc');
    expect(before).toBe(hmac(h.s.cfg.SESSION_SECRET, 'oidc-code:abc'));
    await h.s.sysKeys.open();
    expect(h.s.sysKeys.status).toMatchObject({ state: 'open', keys: SYS_KEY_NAMES.length });
    expect(h.s.federation.oidc.digest('code', 'abc')).toBe(before);

    // The read is by the service subject `federation.oidc`, under a grant on sys/transit/federation, and audited.
    await h.s.sysKeys.flushUsage();
    const used = (await audits('vault.sys.used')).filter((a) => a.target.path === 'sys/transit/federation');
    expect(used).toHaveLength(1);
    expect(used[0]).toMatchObject({ actor: { service: 'federation.oidc' }, target: { scope: 'sys' }, detail: { uses: 1 } });
    const ex = (await root.agent.get('/api/admin/platform/vault/explain').query({ service: 'federation.oidc', path: 'sys/transit/federation', capability: 'verify' }).expect(200)).body;
    expect(ex.decision).toMatchObject({ allow: true });
    expect(ex.decision.grant).toMatchObject({ subjectKind: 'service', subject: 'federation.oidc', path: 'sys/transit/federation' });
    expect((await root.agent.get('/api/admin/platform/vault/explain').query({ service: 'channels', path: 'sys/transit/federation', capability: 'verify' }).expect(200)).body.decision.allow).toBe(false);

    // A tenant admin: the listing does not show it, it cannot be read, and no grant of theirs can name it.
    const tinaUser = await localUser(h, 'tina', ['tenant-admin'], 'restricted');
    const tina = await loginAdmin(h, 'tina');
    await send(tina, 'post', '/api/vault/policies', { subjectKind: 'user', subject: tinaUser.id, path: '*', capabilities: ['*'] }).expect(201);
    await send(tina, 'post', '/api/vault/transit/keys', { name: 'own', type: 'aes256-gcm96' }).expect(201);
    const listed = (await tina.agent.get('/api/vault/transit/keys').expect(200)).body.keys as { name: string }[];
    expect(listed.map((k) => k.name)).toEqual(['own']);
    await tina.agent.get('/api/vault/transit/keys/federation').expect(404);
    await send(tina, 'post', '/api/vault/transit/sign/federation', { input: b64('x') }).expect(404);
    expect((await tina.agent.get('/api/vault/policies').expect(200)).body.policies.every((g: { path: string; subjectKind: string }) => !g.path.startsWith('sys') && g.subjectKind !== 'service')).toBe(true);
    await send(tina, 'post', '/api/vault/policies', { subjectKind: 'user', subject: tinaUser.id, path: 'sys/transit/federation', capabilities: ['verify'] }).expect(400);
    await send(tina, 'post', '/api/vault/policies', { subjectKind: 'service', subject: 'federation.oidc', path: 'transit/own', capabilities: ['verify'] }).expect(400);
    await tina.agent.get('/api/admin/platform/vault/keys').expect(403);
    // No material in the platform listing either.
    const keys = (await root.agent.get('/api/admin/platform/vault/keys').expect(200)).body;
    expect(keys.keys.map((k: { name: string }) => k.name).sort()).toEqual([...SYS_KEY_NAMES].sort());
    expect(JSON.stringify(keys)).not.toContain(h.s.cfg.SESSION_SECRET);

    // The path policy applies to the service: a deny closes the key to it, and removing the deny opens it again.
    const deny = (await send(root, 'post', '/api/admin/platform/vault/policies', { service: 'federation.oidc', path: 'sys/transit/federation', capabilities: ['verify'], effect: 'deny' }).expect(201)).body;
    expect(() => h.s.federation.oidc.digest('code', 'abc')).toThrow(/federation key cannot be used/);
    expect((await audits('vault.denied')).some((a) => a.target.path === 'sys/transit/federation')).toBe(true);
    await send(root, 'delete', `/api/admin/platform/vault/policies/${deny.id}`).expect(204);
    expect(h.s.federation.oidc.digest('code', 'abc')).toBe(before);
  });

  it('B-9202: a server whose KMS is unreachable stops at the named step and serves no authenticated route', async () => {
    expect(await openVault(h.s)).toEqual(['kms', 'data-keys', 'vault-system-scope', 'sessions-and-api-keys']);
    expect(BOOT_STEPS.indexOf('vault-system-scope')).toBeLessThan(BOOT_STEPS.indexOf('sessions-and-api-keys'));
    expect(BOOT_STEPS.at(-1)).toBe('authentication');

    const cfg = testConfig();
    const kms = Object.assign(Object.create(createKms(cfg)) as ReturnType<typeof createKms>, { health: async () => ({ ok: false, detail: 'connect ECONNREFUSED 10.0.0.9:8200' }) });
    const down = await harness({}, { kms });
    try {
      // Signed in while the scope was never opened (a test process): the old derivation still answers.
      await localUser(down, 'ann', ['member']);
      const ann = await login(down, 'ann');
      await ann.agent.get('/api/me').expect(200);
      const err = await openVault(down.s).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BootError);
      expect((err as BootError).step).toBe('kms');
      expect((err as BootError).message).toMatch(/at step kms \(3 of 7\): the KMS \(local\) is not reachable: connect ECONNREFUSED/);
      expect(down.s.sysKeys.status.state).toBe('failed');
      // Fail closed: no credential is looked at, with a session or with a bearer key; the health route still answers.
      const refused = await ann.agent.get('/api/me').expect(503);
      expect(refused.body).toMatchObject({ title: 'Vault unavailable', step: 'vault-system-scope' });
      await request(down.app).get('/api/me').set('authorization', 'Bearer exai_k1_000000000000_x').expect(503);
      await request(down.app).post('/api/auth/login').send({ username: 'ann', password: 'x' }).expect(503);
      await request(down.app).get('/healthz').expect(200);
      expect(() => down.s.sysKeys.key('session').all()).toThrow(/platform scope did not open/);
    } finally {
      await down.close();
    }
  });

  it('B-9203: a warm cache reads nothing, uses are audited per service and minute, and a revoked lease is refused on every instance at once', async () => {
    await h.s.sysKeys.open();
    const loads = h.s.sysKeys.loads;
    await localUser(h, 'ann', ['member']);
    const ann = await login(h, 'ann');
    const token = /exai_sid=([^;]+)/.exec(ann.cookie)![1]!;

    // A session check is one indexed lookup: the key comes from memory.
    const queries: string[] = [];
    const onQuery = (q: { sql: string }) => void queries.push(q.sql);
    h.s.db.on('query', onQuery);
    for (let i = 0; i < 25; i++) expect(await h.s.sessions.resolve(token)).toBeTruthy();
    h.s.db.off('query', onQuery);
    expect(queries).toHaveLength(25);
    expect(queries.every((q) => /from [`"]sessions[`"] where [`"]id[`"] in \(\?\)/.test(q))).toBe(true);
    expect(h.s.sysKeys.loads).toBe(loads);

    // 25 reads (and the sign-in's) are one audit entry for the service, not one each.
    await h.s.sysKeys.flushUsage();
    const used = (await audits('vault.sys.used')).filter((a) => a.target.path === 'sys/transit/session');
    expect(used).toHaveLength(1);
    expect(used[0]!.actor).toEqual({ service: 'identity.sessions' });
    expect(Number(used[0]!.detail.uses)).toBeGreaterThanOrEqual(25);

    // A lease check: one lookup cold, none warm.
    const lease = await h.s.leases.issue({ tenantId: h.tenantId, kind: 'test', holderKind: 'service', holder: 'suite', verifier: 'v'.repeat(64), renewPeriodSeconds: 600, maxLifetimeSeconds: 3600, actor: { service: 'suite' } });
    expect(await h.s.leases.check({ verifier: 'v'.repeat(64) })).toMatchObject({ id: lease.id, state: 'active' });
    const cold = h.s.leases.lookups;
    for (let i = 0; i < 10; i++) expect(await h.s.leases.check({ verifier: 'v'.repeat(64) })).toBeTruthy();
    expect(h.s.leases.lookups).toBe(cold);

    // A second instance on the same database and bus (as Redis joins them) has the lease cached, too.
    const b: Services = createServices(h.s.cfg, h.s.db, createLogger('silent', false), new Metrics(), { bus: h.s.bus, instanceId: 'instance-b' });
    try {
      await b.sysKeys.open();
      expect(await b.leases.check({ id: lease.id })).toBeTruthy();
      expect(await b.leases.check({ verifier: 'v'.repeat(64) })).toBeTruthy();
      const t0 = Date.now();
      await h.s.leases.revoke(h.tenantId, lease.id, { service: 'suite' });
      expect(await b.leases.check({ id: lease.id })).toBeNull();
      expect(await b.leases.check({ verifier: 'v'.repeat(64) })).toBeNull();
      expect(await h.s.leases.check({ id: lease.id })).toBeNull();
      expect(Date.now() - t0).toBeLessThan(1000);

      // A rotation on one instance reaches the other's keys the same way.
      expect(b.sysKeys.key('session').all()).toHaveLength(1);
      await send(root, 'post', '/api/admin/platform/vault/keys/session/rotate').expect(200);
      expect(await until(() => b.sysKeys.key('session').all().length === 2)).toBe(true);
      expect(b.sysKeys.key('session').all()[0]).toBe(h.s.sysKeys.key('session').all()[0]);
      expect(await b.sessions.resolve(token)).toBeTruthy();
    } finally {
      await b.sysKeys.close();
    }
  });

  it('B-9204: a lease idle past its renew period is refused and swept, and renewing past its maximum is refused', async () => {
    const ended: { id: string; reason: string }[] = [];
    let fail = false;
    h.s.leases.registerKind('test', {
      end: async (l, reason) => {
        if (fail) throw new Error('the provider refused');
        ended.push({ id: l.id, reason });
      }
    });
    const base = { tenantId: h.tenantId, kind: 'test', holderKind: 'user' as const, holder: 'U1', actor: { service: 'suite' } };

    // Renewed within its period: the expiry moves; never past the maximum.
    const a = await h.s.leases.issue({ ...base, ref: 'k-a', renewPeriodSeconds: 60, maxLifetimeSeconds: 90 });
    expect(a.expiresAt - a.issuedAt).toBe(60_000);
    expect(a.maxExpiresAt - a.issuedAt).toBe(90_000);
    await h.s.db('vault_leases').where({ id: a.id }).update({ expires_at: Date.now() + 5000 });
    const renewed = await h.s.leases.renew(h.tenantId, a.id, { service: 'suite' });
    expect(renewed.renewals).toBe(1);
    expect(renewed.expiresAt).toBeGreaterThan(Date.now() + 50_000);
    expect(renewed.expiresAt).toBeLessThanOrEqual(a.maxExpiresAt);
    // At its maximum: renewing is refused.
    await h.s.db('vault_leases').where({ id: a.id }).update({ expires_at: a.maxExpiresAt });
    await expect(h.s.leases.renew(h.tenantId, a.id, { service: 'suite' })).rejects.toMatchObject({ status: 409, extensions: { step: 'lease-maximum' } });
    expect((await h.s.leases.get(h.tenantId, a.id)).expiresAt).toBe(a.maxExpiresAt);

    // Idle past its renew period: refused at once, before the sweeper has run, and not renewable.
    const idle = await h.s.leases.issue({ ...base, ref: 'k-idle', verifier: 'i'.repeat(64), renewPeriodSeconds: 60, maxLifetimeSeconds: 3600 });
    await h.s.db('vault_leases').where({ id: idle.id }).update({ expires_at: Date.now() - 1 });
    expect(await h.s.leases.check({ id: idle.id })).toBeNull();
    expect(await h.s.leases.check({ verifier: 'i'.repeat(64) }, { touch: true })).toBeNull();
    await expect(h.s.leases.renew(h.tenantId, idle.id, { service: 'suite' })).rejects.toMatchObject({ status: 410 });
    expect((await h.s.leases.get(h.tenantId, idle.id)).state).toBe('active'); // the row waits for the sweeper
    expect(await h.s.leases.sweep()).toEqual({ ended: 1, failed: 0 });
    expect(await h.s.leases.get(h.tenantId, idle.id)).toMatchObject({ state: 'expired', endReason: 'expired' });
    expect(ended).toEqual([{ id: idle.id, reason: 'expired' }]);
    expect(await h.s.leases.sweep()).toEqual({ ended: 0, failed: 0 });

    // A use counts as a renewal for a lease checked with touch (the idle timeout), never past the maximum.
    const used = await h.s.leases.issue({ ...base, ref: 'k-used', renewPeriodSeconds: 10, maxLifetimeSeconds: 15 });
    await h.s.db('vault_leases').where({ id: used.id }).update({ renewed_at: used.issuedAt - 5000, expires_at: used.issuedAt + 5000 });
    const touched = await h.s.leases.check({ id: used.id }, { touch: true });
    expect(touched!.expiresAt).toBeGreaterThan(used.issuedAt + 5000);
    expect(touched!.expiresAt).toBeLessThanOrEqual(used.maxExpiresAt);

    // A kind whose handler fails keeps the lease in `revoking` (already refused), and the sweeper tries again.
    fail = true;
    const stuck = await h.s.leases.revoke(h.tenantId, used.id, { service: 'suite' });
    expect(stuck).toMatchObject({ state: 'revoking', attempts: 1, lastError: 'the provider refused' });
    expect(await h.s.leases.check({ id: used.id })).toBeNull();
    fail = false;
    await h.s.db('vault_leases').where({ id: used.id }).update({ next_attempt_at: Date.now() - 1 });
    expect(await h.s.leases.sweep()).toEqual({ ended: 1, failed: 0 });
    expect(await h.s.leases.get(h.tenantId, used.id)).toMatchObject({ state: 'revoked', endReason: 'revoked' });

    // Every live lease of a holder ends together; what happened is in the audit chain.
    expect(await h.s.leases.revokeWhere(h.tenantId, { holder: 'U1' }, { service: 'suite' })).toBe(1);
    expect((await h.s.leases.list(h.tenantId, { state: 'active' }))).toHaveLength(0);
    expect((await audits('vault.lease.issued')).length).toBe(3);
    expect((await audits('vault.lease.expired')).map((x) => x.target.lease)).toEqual([idle.id]);
    expect((await audits('vault.lease.revoke-failed')).length).toBe(1);
  });

  it('B-9205: rotating the keys keeps sessions, API keys, app passwords and file links valid until the previous version is retired', async () => {
    await h.s.sysKeys.open();
    const wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Finance', 'internal')).id;
    const mo = await localUser(h, 'mo', ['member']);
    await h.s.tenants.addMember(wsId, mo.id);
    const old = await login(h, 'mo');
    const token = /exai_sid=([^;]+)/.exec(old.cookie)![1]!;
    // Version 1 is the SESSION_SECRET: the row is what 1.6.0 would have written.
    expect(await h.s.db('sessions').where({ id: hmac(h.s.cfg.SESSION_SECRET, 'session:' + token) }).first()).toBeTruthy();
    expect(old.csrf).toBe(hmac(h.s.cfg.SESSION_SECRET, 'csrf:' + hmac(h.s.cfg.SESSION_SECRET, 'session:' + token)));

    const apiKey = (await send(root, 'post', '/api/me/api-keys', { name: 'ci', scopes: ['chat:read'], ttlDays: 30 }).expect(201)).body.key as string;
    const appPassword = (await send(root, 'post', '/api/me/app-passwords', { name: 'Phone', scopes: ['caldav'] }).expect(201)).body.password as string;
    const up = (await old.agent.put(`/api/files/uploads?${new URLSearchParams({ name: 'plan.txt', workspace: wsId }).toString()}`).set('x-csrf-token', old.csrf).set('content-type', 'application/octet-stream').send(Buffer.from('The plan.')).expect(202)).body;
    await drain(h);
    const link = (await send(old, 'post', `/api/files/${up.id}/shares`, { kind: 'link', expiresInHours: 24 }).expect(201)).body;
    const recovery = (await h.s.mfa.regenerateRecoveryCodes((await h.s.users.byUsername(h.tenantId, 'root'))!.id))[0]!;
    const works = async (c: Client, expectStatus: number) => {
      await c.agent.get('/api/me').expect(expectStatus);
    };
    await works(old, 200);

    // Rotate all four keys (a platform admin, with a recent sign-in).
    for (const name of ['session', 'api-key', 'app-password', 'link', 'mfa']) {
      const k = (await send(root, 'post', `/api/admin/platform/vault/keys/${name}/rotate`).expect(200)).body;
      expect(k).toMatchObject({ name, latestVersion: 2, minVersion: 1, loaded: true });
      expect(k.versions).toEqual([expect.objectContaining({ version: 1, accepted: true }), expect.objectContaining({ version: 2, accepted: true })]);
    }
    expect((await audits('vault.transit.key.rotated')).filter((a) => a.target.scope === 'sys').map((a) => a.target.key).sort()).toEqual(['api-key', 'app-password', 'link', 'mfa', 'session']);
    expect(h.s.sysKeys.key('session').all()).toHaveLength(2);
    expect(h.s.sysKeys.key('session').all()[1]).toBe(h.s.cfg.SESSION_SECRET);

    // Everything issued before still works: the session and its CSRF token, the API key, the app password, the link.
    await works(old, 200);
    await works(root, 200);
    await send(old, 'post', '/api/files/folders', { name: 'After rotation', workspaceId: wsId }).expect(201);
    await request(h.app).get('/api/me').set('authorization', `Bearer ${apiKey}`).expect(200);
    expect((await h.s.dav.passwords.verify(appPassword)).row).toBeTruthy();
    expect((await send(old, 'post', '/api/file-links/open', { token: link.token }).expect(200)).body.name).toBe('plan.txt');
    // What is issued now is under version 2.
    const fresh = await login(h, 'mo');
    const freshToken = /exai_sid=([^;]+)/.exec(fresh.cookie)![1]!;
    expect(await h.s.db('sessions').where({ id: hmac(h.s.cfg.SESSION_SECRET, 'session:' + freshToken) }).first()).toBeUndefined();
    expect(await h.s.db('sessions').where({ id: hmac(h.s.sysKeys.key('session').all()[0]!, 'session:' + freshToken) }).first()).toBeTruthy();
    const link2 = (await send(fresh, 'post', `/api/files/${up.id}/shares`, { kind: 'link', expiresInHours: 24 }).expect(201)).body;

    // Retire version 1: what it issued is refused; what version 2 issued is not.
    for (const name of ['session', 'api-key', 'app-password', 'link', 'mfa']) {
      // The admin's own session was issued under version 1 of `session`: a new sign-in first.
      if (name === 'session') continue;
      expect((await send(root, 'post', `/api/admin/platform/vault/keys/${name}/retire`, { minVersion: 2 }).expect(200)).body).toMatchObject({ minVersion: 2, versions: [expect.objectContaining({ version: 1, accepted: false }), expect.objectContaining({ version: 2, accepted: true })] });
    }
    await send(root, 'post', '/api/admin/platform/vault/keys/link/retire', { minVersion: 3 }).expect(400);
    await request(h.app).get('/api/me').set('authorization', `Bearer ${apiKey}`).expect(401);
    expect((await h.s.dav.passwords.verify(appPassword)).row).toBeNull();
    await send(fresh, 'post', '/api/file-links/open', { token: link.token }).expect(404);
    expect((await send(fresh, 'post', '/api/file-links/open', { token: link2.token }).expect(200)).body.name).toBe('plan.txt');
    expect(await h.s.mfa.useRecoveryCode((await h.s.users.byUsername(h.tenantId, 'root'))!.id, recovery)).toBe(false);
    await works(old, 200); // `session` version 1 is still accepted
    await send(root, 'post', '/api/admin/platform/vault/keys/session/retire', { minVersion: 2 }).expect(200);
    await works(old, 401);
    await works(root, 401);
    await works(fresh, 200);
    await send(fresh, 'post', '/api/files/folders', { name: 'After retirement', workspaceId: wsId }).expect(201);
  });

  it('B-9205: a tenant\'s hmac-sha256 transit key verifies under the current and the previous version', async () => {
    const tinaUser = await localUser(h, 'tina', ['tenant-admin'], 'restricted');
    const tina = await loginAdmin(h, 'tina');
    await send(tina, 'post', '/api/vault/policies', { subjectKind: 'user', subject: tinaUser.id, path: 'transit', capabilities: ['*'] }).expect(201);
    const key = (await send(tina, 'post', '/api/vault/transit/keys', { name: 'webhooks', type: 'hmac-sha256' }).expect(201)).body;
    expect(key).toMatchObject({ type: 'hmac-sha256', supports: ['sign', 'verify'], latestVersion: 1 });
    expect(JSON.stringify(key)).not.toMatch(/publicKey|material/);
    const v1 = (await send(tina, 'post', '/api/vault/transit/sign/webhooks', { input: b64('payload') }).expect(200)).body;
    expect(v1.signature).toMatch(/^exai:v1:/);
    await send(tina, 'post', '/api/vault/transit/keys/webhooks/rotate').expect(200);
    const v2 = (await send(tina, 'post', '/api/vault/transit/sign/webhooks', { input: b64('payload') }).expect(200)).body;
    expect(v2.signature).toMatch(/^exai:v2:/);
    expect(v2.signature.slice(8)).not.toBe(v1.signature.slice(8));
    for (const sig of [v1.signature, v2.signature]) expect((await send(tina, 'post', '/api/vault/transit/verify/webhooks', { input: b64('payload'), signature: sig }).expect(200)).body.valid).toBe(true);
    expect((await send(tina, 'post', '/api/vault/transit/verify/webhooks', { input: b64('other'), signature: v2.signature }).expect(200)).body.valid).toBe(false);
    // An HMAC key does not encrypt, and once the previous version is retired its signatures are refused.
    await send(tina, 'post', '/api/vault/transit/encrypt/webhooks', { plaintext: b64('x') }).expect(400);
    await send(tina, 'patch', '/api/vault/transit/keys/webhooks', { minDecryptVersion: 2 }).expect(200);
    await send(tina, 'post', '/api/vault/transit/verify/webhooks', { input: b64('payload'), signature: v1.signature }).expect(400);
    // Key material is read in the platform scope only.
    const c = await h.s.vault.callerFor((await loadPrincipal(h.s, h.tenantId, tinaUser.id, {}))!);
    await expect(h.s.vault.hmacSecrets(c, 'webhooks')).rejects.toMatchObject({ status: 403 });
    expect(SYS_SCOPE).toBe('platform');
  });

  it('serves the app the same before the scope is opened (scripts and tests that start no server)', async () => {
    const app = createApp(h.s);
    await serveOnLoopback(app);
    try {
      expect(h.s.sysKeys.status.state).toBe('cold');
      await localUser(h, 'ann', ['member']);
      const ann = await request.agent(app).post('/api/auth/login').send({ username: 'ann', password: 'correct horse battery staple' }).expect(200);
      expect(ann.body.csrf).toMatch(/^[0-9a-f]{64}$/);
      expect(await h.s.db('vault_transit_keys').where({ tenant_id: SYS_SCOPE })).toHaveLength(0);
    } finally {
      await closeLoopback(app);
    }
  });
});
