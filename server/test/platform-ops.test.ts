import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, X509Certificate, type KeyObject } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';
import { harnessWith } from './retrieval-seed.js';
import { startFakeAcme, type FakeAcme } from './fake-acme.js';
import { writeTar } from '../src/ops/tar.js';
import { keyFingerprint, licenceAllowed } from '../src/ops/bundles.js';
import { acmeChallengeRoutes } from '../src/routes/admin/platform.js';
import { pemBlocks } from '../src/ops/der.js';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

interface BundleFile {
  path: string;
  mirror: string;
  data: Buffer;
}

/** Builds a bundle tar: manifest.json and manifest.sig first, then files/<path>. */
function buildBundle(o: { id: string; files: BundleFile[]; key: KeyObject; algorithm?: 'ed25519' | 'ecdsa-p256-sha256'; components?: object[]; tamper?: (m: Record<string, unknown>) => void; extra?: { path: string; data: Buffer }[] }): Buffer {
  const manifest: Record<string, unknown> = {
    format: 'exprsn-bundle/1',
    id: o.id,
    created: '2026-09-28T22:10:00Z',
    files: o.files.map((f) => ({ path: f.path, sha256: sha(f.data), size: f.data.length, mirror: f.mirror })),
    sbom: { bomFormat: 'CycloneDX', specVersion: '1.5', components: o.components ?? [{ name: 'left-pad', version: '1.3.0', purl: 'pkg:npm/left-pad@1.3.0', licenses: [{ license: { id: 'MIT' } }] }, { name: 'requests', version: '2.32.3', licenses: [{ expression: 'Apache-2.0 OR MIT' }] }] }
  };
  o.tamper?.(manifest);
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2));
  const algorithm = o.algorithm ?? 'ed25519';
  const signature = sign(algorithm === 'ed25519' ? null : 'sha256', bytes, o.key).toString('base64');
  const sig = Buffer.from(JSON.stringify({ algorithm, key: keyFingerprint(o.key), signature }));
  return writeTar([{ path: 'manifest.json', data: bytes }, { path: 'manifest.sig', data: sig }, ...o.files.map((f) => ({ path: `files/${f.path}`, data: f.data })), ...(o.extra ?? [])]);
}

const FILES: BundleFile[] = [
  { path: 'npm/left-pad-1.3.0.tgz', mirror: 'npm', data: Buffer.from('left-pad tarball') },
  { path: 'wheels/requests-2.32.3-py3-none-any.whl', mirror: 'pypi', data: Buffer.from('requests wheel') },
  { path: 'trivy/db.tar.gz', mirror: 'trivy', data: Buffer.from('trivy database') }
];

describe('platform operations', () => {
  let h: Harness;
  let a: Client;
  let signer: { privateKey: KeyObject; publicKey: KeyObject };

  const post = (url: string, body: object = {}) => a.agent.post(url).set('x-csrf-token', a.csrf).send(body);
  const upload = (id: string, data: Buffer) => a.agent.put(`/api/admin/platform/bundles/${id}/transfer`).set('x-csrf-token', a.csrf).set('content-type', 'application/octet-stream').send(data);

  async function importBundle(name: string, data: Buffer) {
    const b = await post('/api/admin/platform/bundles', { name, transfer: 'diode' }).expect(201);
    await upload(b.body.id, data).expect(202);
    await h.s.jobs.runDue();
    return (await a.agent.get(`/api/admin/platform/bundles/${b.body.id}`).expect(200)).body;
  }

  /** A second platform admin, for the dual-control approvals of signer keys (Sprint 15). */
  async function approveAsSecond(proposalId: string) {
    if (!(await h.s.users.byUsername(h.tenantId, 'root2'))) await localUser(h, 'root2', ['system-admin'], 'restricted');
    const b = await loginAdmin(h, 'root2');
    return (await b.agent.post(`/api/admin/platform/signers/proposals/${proposalId}/approve`).set('x-csrf-token', b.csrf).send({}).expect(200)).body;
  }

  beforeEach(async () => {
    h = await harness();
    await localUser(h, 'root', ['system-admin'], 'restricted');
    a = await loginAdmin(h, 'root');
    signer = generateKeyPairSync('ed25519');
    await post('/api/admin/platform/signers', { name: 'platform-import-2026', publicKeyPem: signer.publicKey.export({ type: 'spki', format: 'pem' }).toString() }).expect(201);
  });
  afterEach(async () => h.close());

  it('refuses people without platform:manage', async () => {
    await localUser(h, 'tadmin', ['tenant-admin'], 'restricted');
    const t = await loginAdmin(h, 'tadmin');
    const r = await t.agent.get('/api/admin/platform/bundles').expect(403);
    expect(r.body.action).toBe('platform:manage');
    await t.agent.post('/api/admin/platform/backups').set('x-csrf-token', t.csrf).send({}).expect(403);
    await request(h.app).get('/api/admin/platform/summary').expect(401);
  });

  it('verifies a correctly signed bundle through every step and promotes it into the mirrors', async () => {
    await post('/api/admin/platform/mirrors', { name: 'npm', kind: 'npm', store: 'Verdaccio', url: 'http://127.0.0.1:4873/', consumer: 'CI' }).expect(201);
    await post('/api/admin/platform/mirrors', { name: 'Vulnerability databases', kind: 'trivy', store: 'Trivy offline bundle', url: 'http://127.0.0.1:4874/' }).expect(201);
    const mirrors0 = (await a.agent.get('/api/admin/platform/mirrors').expect(200)).body;
    expect(mirrors0.find((m: { kind: string }) => m.kind === 'trivy')).toMatchObject({ policy: 'never promoted', stale: true });

    h.s.ops.bundles.scanner = { name: 'fake-trivy', scan: async (sbom) => ({ findings: [{ id: 'CVE-2026-0001', severity: 'LOW', package: String(sbom.components[0]!.name), version: null }] }) };
    h.s.ops.bundles.staging = { name: 'fake staging', deploy: async (input) => ({ ok: true, detail: `Deployed ${input.files.length} files on kind` }) };

    const b = await importBundle('2026-38-weekly', buildBundle({ id: '2026-38-weekly', files: FILES, key: signer.privateKey }));
    expect(b.state).toBe('ready to promote');
    expect(b.steps.map((x: { state: string }) => x.state)).toEqual(['passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'waiting']);
    expect(b.signer).toMatchObject({ name: 'platform-import-2026', algorithm: 'ed25519' });
    expect(b.contents).toBe('1 npm package, 1 wheel, Trivy DB');
    expect(b.steps[3].detail).toMatch(/1 findings below HIGH/);
    expect(b.report.licences).toMatchObject({ MIT: 1, 'Apache-2.0 OR MIT': 1 });

    await post(`/api/admin/platform/bundles/${b.id}/promote`).expect(202);
    await h.s.jobs.runDue();
    const done = (await a.agent.get(`/api/admin/platform/bundles/${b.id}`).expect(200)).body;
    expect(done.state).toBe('in production');
    expect(done.steps[6]).toMatchObject({ state: 'passed' });
    expect(done.report.promotedTo).toEqual(expect.arrayContaining(['npm', 'Vulnerability databases']));
    expect(done.report.kindsWithoutMirror).toEqual(['pypi']);
    expect(await h.s.blobs.get(`mirrors/npm/sha256/${sha(FILES[0]!.data)}`)).toEqual(FILES[0]!.data);
    const mirrors = (await a.agent.get('/api/admin/platform/mirrors').expect(200)).body;
    expect(mirrors.find((m: { kind: string }) => m.kind === 'trivy')).toMatchObject({ lastBundle: '2026-38-weekly', policy: 'ok', stale: false, ageDays: 0 });
    const actions = (await h.s.audit.list(h.tenantId, { action: 'platform.bundle', limit: 20 })).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['platform.bundle.opened', 'platform.bundle.received', 'platform.bundle.verified', 'platform.bundle.promote.requested', 'platform.bundle.promoted']));
  });

  it('reports honestly when no scanner or staging hook is configured, and accepts ECDSA P-256 signers', async () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const prop = await post('/api/admin/platform/signers', { name: 'cosign-import', publicKeyPem: ec.publicKey.export({ type: 'spki', format: 'pem' }).toString() }).expect(202);
    await approveAsSecond(prop.body.proposal.id);
    const b = await importBundle('model-qwen', buildBundle({ id: 'model-qwen', files: [{ path: 'models/qwen.gguf', mirror: 'models', data: Buffer.from('weights') }], key: ec.privateKey, algorithm: 'ecdsa-p256-sha256', components: [{ name: 'qwen2.5-coder', licenses: [{ license: { id: 'Apache-2.0' } }] }] }));
    expect(b.state).toBe('ready to promote');
    expect(b.steps.map((x: { state: string }) => x.state)).toEqual(['passed', 'passed', 'passed', 'skipped', 'passed', 'skipped', 'waiting']);
    expect(b.steps[3].detail).toMatch(/No scanner is configured/);
    expect(b.steps[5].detail).toMatch(/No staging hook is configured/);
  });

  it('rejects a bundle signed by an unknown key at step 2 without reading past the signature', async () => {
    const stranger = generateKeyPairSync('ed25519');
    // A trailing entry that step 3 would refuse: the failure must still be the signature.
    const data = buildBundle({ id: '2026-37-weekly-b', files: FILES, key: stranger.privateKey, extra: [{ path: 'files/not-listed.bin', data: Buffer.from('x') }] });
    const b = await importBundle('2026-37-weekly-b', data);
    expect(b.state).toBe('rejected');
    expect(b.steps.map((x: { state: string }) => x.state)).toEqual(['passed', 'failed', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting']);
    expect(b.steps[1].detail).toMatch(/Expected platform-import-2026\. Got unknown key [0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}/);
    expect(b.signer).toMatchObject({ name: null, state: 'unknown', fingerprint: keyFingerprint(stranger.privateKey) });
    expect(b.report?.files).toBeUndefined();
    expect(await h.s.blobs.get(`mirrors/npm/sha256/${sha(FILES[0]!.data)}`)).toBeNull();
    await post(`/api/admin/platform/bundles/${b.id}/promote`).expect(409);
    const n = (await a.agent.get('/api/me/notifications').expect(200)).body.items;
    expect(n.some((x: { title: string }) => /2026-37-weekly-b was rejected/.test(x.title))).toBe(true);

    await a.agent.delete(`/api/admin/platform/bundles/${b.id}`).set('x-csrf-token', a.csrf).expect(204);
    const del = (await h.s.audit.list(h.tenantId, { action: 'platform.bundle.deleted' }))[0]!;
    expect(del.detail).toMatchObject({ actualSigner: keyFingerprint(stranger.privateKey), expectedSigners: [{ name: 'platform-import-2026' }] });
  });

  it('rejects a revoked signer and a digest that does not match the manifest', async () => {
    const tampered = buildBundle({ id: 'tampered', files: FILES, key: signer.privateKey, tamper: (m) => ((m.files as { sha256: string }[])[1]!.sha256 = sha(Buffer.from('something else'))) });
    const b = await importBundle('tampered', tampered);
    expect(b.state).toBe('rejected');
    expect(b.steps.map((x: { state: string }) => x.state).slice(0, 4)).toEqual(['passed', 'passed', 'failed', 'waiting']);
    expect(b.steps[2].detail).toMatch(/requests-2\.32\.3.*does not match/);

    const keys = (await a.agent.get('/api/admin/platform/signers').expect(200)).body;
    const prop = await post(`/api/admin/platform/signers/${keys[0].id}/revoke`, { reason: 'rotated to 2027 key' }).expect(202);
    await approveAsSecond(prop.body.proposal.id);
    const r = await importBundle('after-revoke', buildBundle({ id: 'after-revoke', files: FILES, key: signer.privateKey }));
    expect(r.steps[1]).toMatchObject({ state: 'failed' });
    expect(r.steps[1].detail).toMatch(/revoked: rotated to 2027 key/);
  });

  it('fails the licence check for licences outside the allow-list', async () => {
    const b = await importBundle('gpl', buildBundle({ id: 'gpl', files: FILES, key: signer.privateKey, components: [{ name: 'readline', version: '8.2', licenses: [{ license: { id: 'GPL-3.0-only' } }] }, { name: 'mystery' }] }));
    expect(b.steps[4]).toMatchObject({ state: 'failed' });
    expect(b.steps[4].detail).toMatch(/readline@8\.2 \(GPL-3\.0-only\).*mystery \(none declared\)/);
    expect(licenceAllowed('(MIT OR GPL-3.0) AND Apache-2.0', new Set(['mit', 'apache-2.0']))).toBe(true);
    expect(licenceAllowed('MIT AND GPL-3.0', new Set(['mit']))).toBe(false);
  });

  it('opens an expedited import that waits for its transfer and needs a ticket', async () => {
    await post('/api/admin/platform/bundles', { name: '2026-38-sec-02', transfer: 'diode', expedited: true, ticket: 'SEC-' }).expect(400);
    const b = await post('/api/admin/platform/bundles', { name: '2026-38-sec-02', transfer: 'diode', contents: 'glibc patch', expedited: true, ticket: 'SEC-1234' }).expect(201);
    expect(b.body).toMatchObject({ state: 'awaiting transfer', expedited: true, ticket: 'SEC-1234', contents: 'glibc patch' });
    await post(`/api/admin/platform/bundles/${b.body.id}/verify`).expect(409);
    const summary = (await a.agent.get('/api/admin/platform/summary').expect(200)).body;
    expect(summary.bundles).toMatchObject({ total: 1, expedited: 1 });
  });

  it('refuses mirrors on public addresses and probes internal ones', async () => {
    await post('/api/admin/platform/mirrors', { name: 'public', kind: 'npm', store: 'npmjs', url: 'http://8.8.8.8/' }).expect(400);
    const up = express();
    up.get('/', (_req, res) => void res.status(200).send('ok'));
    const srv = up.listen(0, '127.0.0.1');
    await new Promise((resolve) => srv.once('listening', resolve));
    try {
      const port = (srv.address() as { port: number }).port;
      const m = await post('/api/admin/platform/mirrors', { name: 'Harbor', kind: 'images', store: 'Harbor', url: `http://127.0.0.1:${port}/` }).expect(201);
      await post('/api/admin/platform/mirrors/check', {}).expect(202);
      await h.s.jobs.runDue();
      const after = (await a.agent.get('/api/admin/platform/mirrors').expect(200)).body.find((x: { id: string }) => x.id === m.body.id);
      expect(after).toMatchObject({ lastCheckOk: true, host: `127.0.0.1:${port}` });
      expect(after.lastCheckDetail).toMatch(/HTTP 200/);
    } finally {
      srv.close();
    }
  });

  it('backs up the database into a signed, sealed archive and restore-drills it into scratch SQLite', async () => {
    await h.s.checkpoints.create(h.tenantId, 'test');
    await post('/api/admin/platform/backups').expect(202);
    await post('/api/admin/platform/backups').expect(409);
    await h.s.jobs.runDue();
    let list = (await a.agent.get('/api/admin/platform/backups').expect(200)).body;
    const backup = list.backups[0];
    expect(backup).toMatchObject({ state: 'succeeded', signed: true, dbClient: 'sqlite' });
    expect(backup.tables).toBeGreaterThan(40);
    const raw = await h.s.blobs.get(`platform/backups/${backup.id}.bin`);
    expect(raw!.includes(Buffer.from('root'))).toBe(false);

    await post('/api/admin/platform/backups/drills', { backupId: backup.id }).expect(202);
    await h.s.jobs.runDue();
    list = (await a.agent.get('/api/admin/platform/backups').expect(200)).body;
    const drill = list.drills[0];
    expect(drill.state).toBe('passed');
    expect(drill.steps.map((x: { state: string }) => x.state)).toEqual(['passed', 'passed', 'passed', 'passed', 'passed', 'passed']);
    expect(drill.detail.counts.mismatches).toEqual([]);
    expect(drill.detail.chains.find((c: { tenant: string }) => c.tenant === h.tenantId)).toMatchObject({ status: 'verified', checkpoints: 1 });
    expect(drill.withinTarget).toBe(true);
    expect(drill.rtoMs).toBeGreaterThanOrEqual(0);
    // The live database was not touched by the restore.
    expect(Number((await h.s.db('platform_drills').count({ n: '*' }))[0]!.n)).toBe(1);

    // A manifest altered after signing fails the first step.
    const mk = `platform/backups/${backup.id}.manifest.json`;
    const m = JSON.parse((await h.s.blobs.get(mk))!.toString());
    m.manifest.tables[0].rows += 1;
    await h.s.blobs.put(mk, Buffer.from(JSON.stringify(m)));
    await post('/api/admin/platform/backups/drills', { backupId: backup.id }).expect(202);
    await h.s.jobs.runDue();
    const bad = (await a.agent.get('/api/admin/platform/backups').expect(200)).body.drills[0];
    expect(bad.state).toBe('failed');
    expect(bad.steps[0]).toMatchObject({ state: 'failed' });
    expect(bad.steps[0].detail).toMatch(/signature does not verify/);
  });

  it('raises a backup alert when the RPO is missed and lets an admin acknowledge it', async () => {
    await h.s.ops.backups.watch({ tenantId: h.tenantId, actor: { service: 'test' }, userId: null });
    let list = (await a.agent.get('/api/admin/platform/backups').expect(200)).body;
    expect(list.alert).toMatchObject({ lastBackupAt: null, acknowledgedAt: null });
    const n = (await a.agent.get('/api/me/notifications').expect(200)).body.items;
    expect(n.some((x: { title: string }) => x.title === 'Backup target missed')).toBe(true);
    await post('/api/admin/platform/backups/alert/acknowledge').expect(200);
    list = (await a.agent.get('/api/admin/platform/backups').expect(200)).body;
    expect(list.alert.acknowledgedAt).toBeGreaterThan(0);
  });

  it('lists data keys and rotates one', async () => {
    await h.s.keys.seal(h.tenantId, 'x', 'y');
    const keys = (await a.agent.get('/api/admin/platform/keys').expect(200)).body;
    const k = keys.find((x: { scope: string }) => x.scope === h.tenantId);
    expect(k).toMatchObject({ version: 1, kms: 'local' });
    expect((await post(`/api/admin/platform/keys/${h.tenantId}/rotate`).expect(200)).body).toEqual({ version: 2 });
    await post('/api/admin/platform/keys/nope/rotate').expect(404);
  });
});

describe('ACME certificates', () => {
  let h: Harness;
  let a: Client;
  let acme: FakeAcme;
  let challengeApp: express.Express;

  beforeEach(async () => {
    challengeApp = express();
    acme = await startFakeAcme(async (_domain, token) => {
      const r = await request(challengeApp).get(`/.well-known/acme-challenge/${token}`);
      return r.status === 200 ? r.text : null;
    });
    h = await harnessWith({}, { ACME_DIRECTORY_URL: acme.directory, ACME_POLL_MS: '10', ACME_CONTACT: 'pki@example.internal' });
    challengeApp.use(acmeChallengeRoutes(h.s));
    await localUser(h, 'root', ['system-admin'], 'restricted');
    a = await loginAdmin(h, 'root');
  });
  afterEach(async () => {
    await h.close();
    await acme.close();
  });

  const post = (url: string, body: object = {}) => a.agent.post(url).set('x-csrf-token', a.csrf).send(body);

  it('issues over RFC 8555 with http-01, seals the key, renews and revokes', async () => {
    const req = await post('/api/admin/platform/certificates', { domains: ['inference-gw.app.internal', 'gw.app.internal'], issuedTo: 'inference gateway', use: 'mTLS' }).expect(202);
    expect(req.body.status).toBe('pending');
    await h.s.jobs.runDue();
    const cert = (await a.agent.get('/api/admin/platform/certificates').expect(200)).body[0];
    expect(cert).toMatchObject({ status: 'valid', issuer: 'Fake internal CA', domains: ['inference-gw.app.internal', 'gw.app.internal'], hasKey: true, days: 89 });
    expect(acme.issued).toHaveLength(1);

    const row = await h.s.db('platform_certificates').where({ id: cert.id }).first();
    expect(row.key_sealed).toMatch(/^v2\./);
    expect(row.key_sealed).not.toMatch(/PRIVATE KEY/);
    const account = await h.s.db('platform_acme_accounts').first();
    expect(account.key_sealed).toMatch(/^v2\./);

    const keyPem = (await post(`/api/admin/platform/certificates/${cert.id}/key`).expect(200)).text;
    const leaf = new X509Certificate(pemBlocks(row.chain_pem)[0]!);
    expect(createPublicKey(createPrivateKey(keyPem)).export({ type: 'spki', format: 'der' })).toEqual(leaf.publicKey.export({ type: 'spki', format: 'der' }));
    expect((await h.s.audit.list(h.tenantId, { action: 'platform.cert.key.exported' })).length).toBe(1);
    const chain = await a.agent.get(`/api/admin/platform/certificates/${cert.id}/chain`).expect(200);
    expect(chain.text).toContain(acme.caPem.trim().split('\n')[1]);

    acme.validityDays = 365;
    await post(`/api/admin/platform/certificates/${cert.id}/renew`).expect(202);
    await h.s.jobs.runDue();
    const renewed = (await a.agent.get('/api/admin/platform/certificates').expect(200)).body[0];
    expect(renewed.days).toBe(364);
    expect(renewed.serial).not.toBe(cert.serial);
    expect(acme.issued).toHaveLength(2);
    expect(await h.s.db('platform_acme_challenges').count({ n: '*' })).toEqual([{ n: 0 }]);

    await post(`/api/admin/platform/certificates/${cert.id}/revoke`, { reason: 'superseded' }).expect(200);
    expect(acme.revoked).toHaveLength(1);
    const actions = (await h.s.audit.list(h.tenantId, { action: 'platform.cert', limit: 20 })).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['platform.cert.requested', 'platform.cert.issued', 'platform.cert.renewal.requested', 'platform.cert.renewed', 'platform.cert.revoked']));
  });

  it('renews certificates inside the window on the sweep and warns about tracked ones', async () => {
    acme.validityDays = 10;
    await post('/api/admin/platform/certificates', { domains: ['ai.northwind.local'], use: 'TLS' }).expect(202);
    await h.s.jobs.runDue();
    await post('/api/admin/platform/certificates/track', { pem: acme.caPem, issuedTo: 'issuing CA', use: 'CA' }).expect(201);
    acme.validityDays = 90;
    const r = await h.s.ops.certs.sweep({ tenantId: h.tenantId, actor: { service: 'test' }, userId: null });
    expect(r.renewing).toEqual(['ai.northwind.local']);
    await h.s.jobs.runDue();
    const list = (await a.agent.get('/api/admin/platform/certificates').expect(200)).body;
    expect(list.find((c: { name: string }) => c.name === 'ai.northwind.local').days).toBe(89);
    expect(list.find((c: { use: string }) => c.use === 'CA')).toMatchObject({ method: 'tracked', status: 'valid', hasKey: false });
  });

  it('records a failed issuance when the challenge answer is wrong', async () => {
    await h.s.db('platform_acme_challenges').delete();
    const orig = h.s.ops.certs.challengeResponse.bind(h.s.ops.certs);
    h.s.ops.certs.challengeResponse = async () => 'wrong';
    try {
      await post('/api/admin/platform/certificates', { domains: ['bad.app.internal'] }).expect(202);
      await h.s.jobs.runDue();
    } finally {
      h.s.ops.certs.challengeResponse = orig;
    }
    const c = (await a.agent.get('/api/admin/platform/certificates').expect(200)).body[0];
    expect(c.status).toBe('failed');
    expect(c.error).toMatch(/Authorization for bad\.app\.internal is invalid/);
  });
});
