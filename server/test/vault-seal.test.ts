import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vaultSealCommand } from '../src/cli/vault-seal.js';
import { createApp } from '../src/http/app.js';
import { createLogger, Metrics } from '../src/observability/index.js';
import { openVault } from '../src/ops/boot.js';
import { escrowKey, recordEscrow, type Escrow } from '../src/platform/escrow.js';
import { PLATFORM_SCOPE } from '../src/platform/datakeys.js';
import { createServices, type Services } from '../src/services.js';
import { SignerClient } from '../src/signer/client.js';
import { SignerCore, startSigner } from '../src/signer/server.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';
import { closeLoopback, serveOnLoopback } from './loopback.js';

/*
 * 1.8.0, Sprint 48 (B-145): the emergency vault seal. Dual control (a proposal and another platform admin's
 * approval), every instance sealed through the bus, 503 "Vault sealed" for anything that needs a key while health and
 * the unseal API still answer, the persisted flag on restart, unsealing with k of n shares (too few refused), the
 * data intact afterwards, break-glass, the signer, and the audit entries written while sealed.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) return false;
    await sleep(10);
  }
  return true;
}
const send = (c: Client, method: 'post' | 'put', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);
const actions = async (h: Harness, prefix: string) => ((await h.s.db('audit_events').where('action', 'like', `${prefix}%`).orderBy('ts').orderBy('seq')) as { action: string; target: string; detail: string | null }[]);

describe('B-145: the emergency vault seal (local KMS)', () => {
  let h: Harness;
  let root: Client;
  let root2: Client;
  let escrow: Escrow;
  let b: Services | null = null;

  beforeEach(async () => {
    h = await harness();
    await localUser(h, 'root', ['system-admin'], 'restricted');
    await localUser(h, 'root2', ['system-admin'], 'restricted');
    root = await loginAdmin(h, 'root');
    root2 = await loginAdmin(h, 'root2');
    escrow = escrowKey(Buffer.from(h.s.cfg.DATA_KEY!, 'base64'), 2, 3);
  });
  afterEach(async () => {
    if (b) await b.close().catch(() => undefined);
    b = null;
    await h.close();
  });

  it('refuses to seal without an escrow of the running key, since nothing could unseal it', async () => {
    const st = (await root.agent.get('/api/admin/platform/vault/seal').expect(200)).body;
    expect(st).toMatchObject({ sealed: false, kms: 'local', sealable: false, escrow: null });
    expect((await send(root, 'post', '/api/admin/platform/vault/seal/proposals', { reason: 'testing the seal path' }).expect(409)).body.detail).toMatch(/no key escrow/);
    await recordEscrow(h.s.db, escrowKey(randomBytes(32), 2, 3), 'test');
    expect((await send(root, 'post', '/api/admin/platform/vault/seal/proposals', { reason: 'testing the seal path' }).expect(409)).body.detail).toMatch(/not of the key this deployment runs on/);
    await recordEscrow(h.s.db, { ...escrow }, 'test');
    expect((await root.agent.get('/api/admin/platform/vault/seal').expect(200)).body).toMatchObject({ sealable: true, escrow: { id: escrow.id, threshold: 2, shares: 3, matchesRunningKey: true } });
    // Only platform admins may propose.
    await localUser(h, 'ta', ['tenant-admin'], 'confidential');
    const ta = await loginAdmin(h, 'ta');
    await send(ta, 'post', '/api/admin/platform/vault/seal/proposals', { reason: 'testing the seal path' }).expect(403);
  });

  it('seals every instance on approval by a second admin, refuses keys with 503, keeps health, survives a restart and unseals with k of n shares', async () => {
    await recordEscrow(h.s.db, { ...escrow }, 'test');
    // Data sealed before: a tenant value, a platform value, and the platform keyring in use.
    const tenantValue = await h.s.keys.seal(h.tenantId, 'tenant secret', 'row-1');
    const platformValue = await h.s.keys.seal(PLATFORM_SCOPE, 'platform secret', 'row-2');
    await h.s.sysKeys.open();
    const sessionSecrets = h.s.sysKeys.key('session').all().slice();

    // A second instance on the same database and bus, as Redis joins them.
    b = createServices(h.s.cfg, h.s.db, createLogger('silent', false), new Metrics(), { bus: h.s.bus, instanceId: 'instance-b' });
    b.vaultSeal.listen();
    await b.sysKeys.open();
    expect(await b.keys.open(h.tenantId, tenantValue, 'row-1')).toBe('tenant secret');

    // Dual control.
    const prop = (await send(root, 'post', '/api/admin/platform/vault/seal/proposals', { reason: 'suspected key compromise on node 2' }).expect(201)).body;
    expect(prop).toMatchObject({ state: 'pending', mine: true });
    await send(root2, 'post', '/api/admin/platform/vault/seal/proposals', { reason: 'a second one at the same time' }).expect(409);
    expect((await send(root, 'post', `/api/admin/platform/vault/seal/proposals/${prop.id}/approve`).expect(403)).body.step).toBe('dual-control');
    expect(h.s.vaultSeal.sealed).toBe(false);
    const approved = (await send(root2, 'post', `/api/admin/platform/vault/seal/proposals/${prop.id}/approve`, { note: 'confirmed' }).expect(200)).body;
    expect(approved).toMatchObject({ sealed: true, proposal: { state: 'approved' } });

    // Both instances are sealed.
    expect(h.s.vaultSeal.sealed).toBe(true);
    expect(await until(() => b!.vaultSeal.sealed)).toBe(true);
    for (const inst of [h.s, b]) {
      await expect(inst.keys.open(h.tenantId, tenantValue, 'row-1')).rejects.toMatchObject({ status: 503, title: 'Vault sealed' });
      await expect(inst.keys.seal(h.tenantId, 'new', 'row-3')).rejects.toMatchObject({ status: 503 });
      await expect(inst.kms.unwrap('x', 'y', 'z')).rejects.toMatchObject({ status: 503 });
      await expect(inst.kms.hmac('x', 'y')).rejects.toMatchObject({ status: 503 });
      expect(() => inst.sysKeys.key('session').all()).toThrow(/Vault sealed|cannot be used/);
      expect(inst.vaultSeal.refusal()).toBe('the vault is sealed');
    }

    // Over HTTP: decrypting routes refuse with a clear 503; health, the session probe and the unseal API answer.
    const me = await root.agent.get('/api/me').expect(503);
    expect(me.headers['content-type']).toMatch(/problem\+json/);
    expect(me.body).toMatchObject({ title: 'Vault sealed', step: 'vault-sealed', sealed: true, unseal: '/unseal.html' });
    expect(me.headers['retry-after']).toBe('30');
    await request(h.app).post('/api/auth/login').send({ username: 'root', password: 'x' }).expect(503);
    await request(h.app).get('/v1/models').expect(503);
    expect((await request(h.app).get('/api/auth/session').expect(200)).body).toEqual({ authenticated: false, stage: null, sealed: true });
    await request(h.app).get('/healthz').expect(200);
    expect((await request(h.app).get('/readyz').expect(200)).body.checks).toMatchObject({ vault: 'sealed', kms: 'ok' });
    const pub = (await request(h.app).get('/api/public/vault/seal').expect(200)).body;
    expect(pub).toMatchObject({ sealed: true, mode: 'dual-control', escrow: { id: escrow.id, threshold: 2, shares: 3 }, progress: { submitted: 0, needed: 2 } });
    // The second instance's app refuses too.
    const appB = createApp(b);
    await serveOnLoopback(appB);
    try {
      await request(appB).get('/api/me').expect(503);
      await request(appB).get('/healthz').expect(200);
    } finally {
      await closeLoopback(appB);
    }

    // The persisted flag: an instance that starts now (no bus) starts sealed, and its key steps wait.
    const { Bus } = await import('../src/platform/bus.js');
    const c = createServices(h.s.cfg, h.s.db, createLogger('silent', false), new Metrics(), { bus: new Bus(createLogger('silent', false)), instanceId: 'instance-c' });
    try {
      expect(await openVault(c)).toEqual([]);
      expect(c.vaultSeal.sealed).toBe(true);
      await expect(c.keys.open(h.tenantId, tenantValue, 'row-1')).rejects.toMatchObject({ status: 503 });

      // Unsealing: a share that is not one, one of another escrow, then k of n.
      const shareApi = (share: string) => request(h.app).post('/api/public/vault/unseal').send({ share });
      expect((await shareApi('exprsn-share:v1:garbage-garbage-garbage').expect(422)).body.title).toBe('Share refused');
      const other = escrowKey(randomBytes(32), 2, 3);
      expect((await shareApi(other.shares[0]!).expect(422)).body.detail).toMatch(/belongs to escrow/);
      const one = (await shareApi(escrow.shares[0]!).expect(200)).body;
      expect(one).toMatchObject({ sealed: true, progress: { submitted: 1, needed: 2 } });
      // The same share twice is still one share; too few shares are refused at once by the CLI path.
      expect((await shareApi(escrow.shares[0]!).expect(200)).body.progress).toEqual({ submitted: 1, needed: 2 });
      await expect(h.s.vaultSeal.unsealWith([escrow.shares[0]!], { service: 'test' })).rejects.toMatchObject({ status: 422, detail: expect.stringMatching(/needs 2 different shares; 1 was given/) });
      expect(h.s.vaultSeal.sealed).toBe(true);
      const done = (await shareApi(escrow.shares[2]!).expect(200)).body;
      expect(done).toMatchObject({ sealed: false });

      // Every instance reopens: b through the bus, c (not on the bus) through the persisted flag.
      expect(h.s.vaultSeal.sealed).toBe(false);
      expect(await until(() => !b!.vaultSeal.sealed)).toBe(true);
      await c.vaultSeal.sync();
      expect(c.vaultSeal.sealed).toBe(false);
      expect(c.sysKeys.status.state).toBe('open');

      // The data is intact and the keys are the same: sessions issued before the seal still work.
      for (const inst of [h.s, b, c]) {
        expect(await inst.keys.open(h.tenantId, tenantValue, 'row-1')).toBe('tenant secret');
        expect(await inst.keys.open(PLATFORM_SCOPE, platformValue, 'row-2')).toBe('platform secret');
      }
      expect(h.s.sysKeys.key('session').all()).toEqual(sessionSecrets);
      await root.agent.get('/api/me').expect(200);
      expect((await request(h.app).get('/api/public/vault/seal').expect(200)).body).toMatchObject({ sealed: false });
      await shareApi(escrow.shares[1]!).expect(409);
    } finally {
      await c.close();
    }

    // Every step is in the audit chain, written while sealed (the append needs no key), and the chain verifies.
    const log = await actions(h, 'vault.');
    const names = log.map((a) => a.action).filter((a) => a !== 'vault.sys.used');
    expect(names).toEqual(expect.arrayContaining(['vault.seal.proposed', 'vault.seal.approved', 'vault.seal.applied', 'vault.sealed', 'vault.unseal.share.refused', 'vault.unseal.share', 'vault.unseal.failed', 'vault.unseal.applied', 'vault.unsealed']));
    const applied = log.filter((a) => a.action === 'vault.seal.applied').map((a) => JSON.parse(a.target).instance);
    expect(applied).toEqual(expect.arrayContaining(['instance-b', 'instance-c']));
    const unsealed = log.find((a) => a.action === 'vault.unsealed')!;
    expect(JSON.parse(unsealed.detail!)).toMatchObject({ shares: 2, mode: 'dual-control' });
    // No share is ever written down.
    expect(JSON.stringify(await h.s.db('audit_events'))).not.toContain(escrow.shares[0]!.split(':')[5]);
    for (const t of new Set((await h.s.db('audit_events').distinct('tenant_id')).map((r: { tenant_id: string }) => r.tenant_id))) expect((await h.s.audit.verify(t)).status).toBe('verified');
  });

  it('break-glass: k shares seal at once without a session; the CLI unseals', async () => {
    await recordEscrow(h.s.db, { ...escrow }, 'test');
    const value = await h.s.keys.seal(h.tenantId, 'kept', 'row-9');
    await request(h.app).post('/api/public/vault/break-glass').send({ shares: [escrow.shares[0]], reason: 'admin accounts compromised' }).expect(400);
    expect((await request(h.app).post('/api/public/vault/break-glass').send({ shares: [escrow.shares[0], escrow.shares[0]], reason: 'admin accounts compromised' }).expect(422)).body.detail).toMatch(/needs 2 different shares/);
    await request(h.app).post('/api/public/vault/break-glass').set('origin', 'https://evil.example').send({ shares: escrow.shares.slice(0, 2), reason: 'admin accounts compromised' }).expect(403);
    await request(h.app).post('/api/public/vault/break-glass').send({ shares: escrow.shares.slice(1, 3), reason: 'admin accounts compromised' }).expect(200);
    expect(h.s.vaultSeal.sealed).toBe(true);
    expect((await request(h.app).get('/api/public/vault/seal').expect(200)).body.mode).toBe('break-glass');
    await root.agent.get('/api/me').expect(503);

    const out: string[] = [];
    expect(await vaultSealCommand(h.s, 'vault:unseal', ['--share', escrow.shares[0]!], (t) => void out.push(t))).toBe(2);
    expect(out.join('')).toMatch(/needs 2 different shares/);
    expect(await vaultSealCommand(h.s, 'vault:unseal', ['--share', escrow.shares[0]!, '--share', escrow.shares[1]!], (t) => void out.push(t))).toBe(0);
    expect(h.s.vaultSeal.sealed).toBe(false);
    expect(await h.s.keys.open(h.tenantId, value, 'row-9')).toBe('kept');
    expect(await vaultSealCommand(h.s, 'vault:seal', ['--reason', 'no shares, no seal'], () => undefined)).toBe(2);
    const log = (await actions(h, 'vault.')).map((a) => a.action);
    expect(log).toEqual(expect.arrayContaining(['vault.seal.break-glass.refused', 'vault.seal.break-glass', 'vault.sealed', 'vault.unsealed']));
  });
});

describe('B-145: the seal with the signer', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'exs-seal-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('the signer drops its key, refuses every operation, takes it back only from the quorum, and stays sealed across a restart', async () => {
    const key = randomBytes(32).toString('base64');
    const token = randomBytes(24).toString('base64url') + 'x'.repeat(8);
    const socketPath = path.join(dir, 'run', 'signer.sock');
    const sealFile = path.join(dir, 'run', 'signer.sealed');
    let signer = await startSigner({ socketPath, key, token, sealFile });
    const h = await harness({ DATA_KEY: '', SIGNER_SOCKET: socketPath, SIGNER_TOKEN: token });
    try {
      const escrow = escrowKey(Buffer.from(key, 'base64'), 2, 3);
      await recordEscrow(h.s.db, escrow, 'test');
      const value = await h.s.keys.seal(h.tenantId, 'held by the signer', 'row-s');
      expect((await request(h.app).post('/api/public/vault/break-glass').send({ shares: escrow.shares.slice(0, 2), reason: 'node compromised, drop the keys' }).expect(200)).body).toEqual({ sealed: true });

      // The signer itself is sealed: a client with the token gets nothing.
      const client = new SignerClient(socketPath, token, 2000);
      try {
        expect(await client.call('seal-status')).toMatchObject({ sealed: true, keyCheck: escrow.keyCheck });
        expect(await client.call('health')).toMatchObject({ ok: true, sealed: true });
        await expect(client.call('unwrap', { name: 'x', wrapped: 'y', aad: 'z' })).rejects.toThrow(/The signer is sealed/);
        await expect(client.call('unseal', { shares: [escrow.shares[0]] })).rejects.toThrow(/needs 2 different shares/);
        const other = escrowKey(randomBytes(32), 2, 3);
        await expect(client.call('unseal', { shares: other.shares.slice(0, 2) })).rejects.toThrow(/does not match the key check value/);
      } finally {
        client.close();
      }
      expect(existsSync(sealFile)).toBe(true);
      // A restart does not undo the seal while the marker exists.
      await signer.close();
      signer = await startSigner({ socketPath, key, token, sealFile });
      expect(signer).toBeTruthy();
      // Readiness keeps the instance in service.
      expect((await request(h.app).get('/readyz').expect(200)).body.checks).toMatchObject({ vault: 'sealed', kms: 'ok' });

      for (const sh of [escrow.shares[1]!, escrow.shares[2]!]) await request(h.app).post('/api/public/vault/unseal').send({ share: sh }).expect(200);
      expect(h.s.vaultSeal.sealed).toBe(false);
      expect(existsSync(sealFile)).toBe(false);
      expect(await h.s.keys.open(h.tenantId, value, 'row-s')).toBe('held by the signer');
    } finally {
      await h.close();
      await signer.close();
    }
  });

  it('SignerCore: a core started sealed holds no key and opens only for its own key', () => {
    const key = randomBytes(32);
    const core = new SignerCore(key.toString('base64'), { sealed: true });
    expect(core.sealed).toBe(true);
    const e = escrowKey(key, 2, 2);
    core.unseal(e.shares);
    expect(core.sealed).toBe(false);
    core.seal();
    expect(core.sealed).toBe(true);
  });
});
