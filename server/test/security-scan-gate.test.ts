import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectFormat, licenceDenied, parseReport } from '../src/security/scan-formats.js';
import { SecurityScans } from '../src/security/scans.js';
import { localUser, loginAdmin, type Client } from './helpers.js';
import { approvalWorkflow, buildCrm, designer, drain, env, member, ok, type C, type Env } from './sprint39b-helpers.js';

/*
 * 1.8.0, Sprint 48 (B-144): security scan results as a promotion gate. The three report formats, the pipeline
 * promotion gate (and its second check when the deployment runs), exceptions under dual control and their expiry, the
 * licence deny-list, stale results, the plugin enable gate, the script image gate, what happens without a result,
 * and the audit entries.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(path.join(here, 'fixtures', 'security', name), 'utf8');
const TRIVY = fixture('trivy-image.json');
const SARIF = fixture('semgrep.sarif.json');
const SBOM = fixture('sbom.cdx.json');
const TRIVY_DIGEST = 'sha256:4f1d2c3b4a5968778695a4b3c2d1e0f9a8b7c6d5e4f30211a0b9c8d7e6f5a4b3';

describe('B-144: reading Trivy, SARIF and CycloneDX reports', () => {
  it('reads Trivy JSON: vulnerabilities, secrets and licences, with the image digest', () => {
    const r = parseReport(TRIVY);
    expect(r).toMatchObject({ format: 'trivy', tool: 'Trivy', toolVersion: '0.56.2', digest: TRIVY_DIGEST, scannedAt: Date.parse('2026-10-10T09:30:00.000Z') });
    const vulns = r.findings.filter((f) => f.kind === 'vulnerability');
    expect(vulns.map((f) => [f.id, f.severity])).toEqual([['CVE-2026-1001', 'critical'], ['CVE-2026-1002', 'high'], ['CVE-2026-1003', 'medium'], ['CVE-2026-1004', 'low'], ['GHSA-aaaa-bbbb-cccc', 'high']]);
    expect(vulns[0]).toMatchObject({ package: 'openssl', version: '3.0.14-1', fixedVersion: '3.0.15-1' });
    expect(vulns[4]!.path).toBe('usr/lib/node_modules/app/node_modules/lodash/package.json');
    expect(r.findings.find((f) => f.kind === 'secret')).toMatchObject({ id: 'aws-access-key-id', severity: 'critical', path: '/etc/app/secret.env' });
    // The secret's matched text is never kept.
    expect(JSON.stringify(r.findings)).not.toContain('AKIA');
    expect(r.findings.filter((f) => f.kind === 'licence').map((f) => [f.package, f.licence])).toEqual([['evil-copyleft', 'AGPL-3.0-only'], ['lodash', 'MIT']]);
    expect(r.summary).toMatchObject({ total: 8, bySeverity: { critical: 2, high: 3, medium: 1, low: 2, unknown: 0 }, licences: ['AGPL-3.0-only', 'MIT'], truncated: false });
  });

  it('reads SARIF 2.1.0: severity from security-severity, else the level', () => {
    const r = parseReport(SARIF);
    expect(r).toMatchObject({ format: 'sarif', tool: 'Semgrep OSS', toolVersion: '1.90.0', scannedAt: Date.parse('2026-10-11T12:00:00Z'), digest: null });
    expect(r.findings.map((f) => [f.id, f.severity, f.path])).toEqual([
      ['javascript.lang.security.eval-injection', 'critical', 'src/handler.js:42'],
      ['javascript.lang.security.weak-hash', 'medium', 'src/hash.js:7'],
      ['generic.style.todo', 'low', null]
    ]);
    expect(r.findings.every((f) => f.kind === 'sast')).toBe(true);
  });

  it('reads a CycloneDX SBOM: component licences, and vulnerabilities not marked unaffected', () => {
    const r = parseReport(SBOM);
    expect(r).toMatchObject({ format: 'cyclonedx', tool: 'cyclonedx-npm', toolVersion: '1.19.3', artefactName: 'crm-plugin' });
    expect(r.findings.filter((f) => f.kind === 'licence').map((f) => [f.package, f.licence])).toEqual([['left-pad', 'WTFPL'], ['dual', 'MIT OR GPL-3.0-only'], ['strong-copyleft', 'GPL-3.0-only'], ['@scope/util', 'Apache License 2.0']]);
    // CVE-2026-2002's analysis says not_affected: it is not a finding.
    expect(r.findings.filter((f) => f.kind === 'vulnerability')).toEqual([expect.objectContaining({ id: 'CVE-2026-2001', severity: 'high', package: 'left-pad', version: '1.3.0', fixedVersion: '1.3.1' })]);
  });

  it('refuses what is not one of the three, and judges licence expressions', () => {
    expect(() => parseReport('not json')).toThrow(/not JSON/);
    expect(() => parseReport(JSON.stringify({ hello: 'world' }))).toThrow(/not Trivy JSON, SARIF/);
    expect(() => parseReport(SARIF, 'trivy')).toThrow(/reads as sarif/);
    expect(() => parseReport(JSON.stringify({ version: '2.0.0', runs: [] }))).toThrow(/SARIF 2.0.0 is not read/);
    expect(detectFormat(JSON.parse(SBOM))).toBe('cyclonedx');
    expect(licenceDenied('GPL-3.0-only', ['gpl-3.0-only'])).toBe('GPL-3.0-only');
    expect(licenceDenied('MIT OR GPL-3.0-only', ['GPL-3.0-only'])).toBeNull();
    expect(licenceDenied('(AGPL-3.0-only OR SSPL-1.0)', ['AGPL-3.0-only', 'SSPL-1.0'])).toBe('AGPL-3.0-only');
    expect(licenceDenied('Apache-2.0 AND GPL-3.0-only', ['GPL-3.0-only'])).toBe('GPL-3.0-only');
    expect(licenceDenied('GPL-2.0-only WITH Classpath-exception-2.0', ['GPL-2.0-only'])).toBe('GPL-2.0-only');
    expect(licenceDenied('MIT', [])).toBeNull();
    expect(SecurityScans.imageDigest('python@' + TRIVY_DIGEST)).toBe(TRIVY_DIGEST);
    expect(SecurityScans.imageDigest('python:3.13-slim')).toBeNull();
  });
});

describe('B-144: the security gate', () => {
  let e: Env;
  let d: C;
  let root: Client;
  let root2: Client;
  const send = (c: Client, method: 'post' | 'put' | 'delete', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);
  const upload = (c: Client, q: Record<string, string>, body: string) => c.agent.put(`/api/admin/security/scans/upload?${new URLSearchParams(q)}`).set('x-csrf-token', c.csrf).set('content-type', 'application/json').send(body);
  const audit = async (action: string) => (await e.h.s.db('audit_events').where({ tenant_id: e.h.tenantId, action }).orderBy('seq')) as { target: string; detail: string | null; actor: string }[];
  const detail = (row: { detail: string | null }) => JSON.parse(row.detail ?? '{}') as Record<string, unknown>;
  const policy = (c: Client, p: Record<string, unknown>) => send(c, 'put', '/api/admin/security/policy', { maxCritical: 0, maxHigh: null, maxAgeDays: null, missing: 'warn', licenceDeny: [], ...p });
  const now = () => String(Date.now());

  beforeEach(async () => {
    e = await env();
    d = await designer(e);
    await buildCrm(e, d);
    await d.post('/api/apps', { name: 'crm_test', title: 'CRM test', label: 'confidential' }).expect(201);
    await d.post('/api/apps', { name: 'crm_prod', title: 'CRM production', label: 'confidential' }).expect(201);
    await approvalWorkflow(e, d);
    await localUser(e.h, 'root', ['system-admin'], 'restricted');
    await localUser(e.h, 'root2', ['system-admin'], 'restricted');
    root = await loginAdmin(e.h, 'root');
    root2 = await loginAdmin(e.h, 'root2');
  });
  afterEach(async () => {
    await e.h.close();
  });

  const pipeline = async () => (await ok(d.post('/api/apps/pipelines', { name: 'CRM', development: 'crm', test: 'crm_test', production: 'crm_prod', approvalWorkflow: 'release-gate' }), 201)).body as { id: string };
  const packageHash = async (id: string) => String(((await e.h.s.db('app_packages').where({ id }).first('hash')) as { hash: string }).hash);

  it('without a result a promotion passes with a warning (the default), and is refused when the policy says so', async () => {
    const p = await pipeline();
    const dep = (await ok(d.post(`/api/apps/pipelines/${p.id}/promote`, { to: 'test' }), 202)).body;
    expect(dep.gate).toMatchObject({ outcome: 'warn', allowed: true, results: [] });
    expect(dep.gate.warnings.join(' ')).toMatch(/No scan result is attached/);
    const warned = await audit('security.gate.warned');
    expect(warned).toHaveLength(1);
    expect(detail(warned[0]!)).toMatchObject({ where: 'pipeline.promote' });
    await drain(e);
    expect((await d.get(`/api/apps/deployments/${dep.id}`).expect(200)).body.state).toBe('succeeded');
    // The deployment ran the gate again (pipeline.deploy), with the same answer.
    expect((await audit('security.gate.warned')).map((a) => detail(a).where)).toEqual(['pipeline.promote', 'pipeline.deploy']);

    // Only a platform admin sets the policy; a designer may read it.
    await policy(d as unknown as Client, { missing: 'refuse' }).expect(403);
    expect((await d.get('/api/admin/security/policy').expect(200)).body).toMatchObject({ missing: 'warn', maxCritical: 0, version: 0, kinds: ['app-package'] });
    const pol = (await ok(policy(root, { missing: 'refuse' }), 200)).body;
    expect(pol).toMatchObject({ missing: 'refuse', version: 1 });
    expect(detail((await audit('security.scan.policy.updated'))[0]!)).toMatchObject({ before: { missing: 'warn' }, after: { missing: 'refuse' }, version: 1 });
    const refused = (await d.post(`/api/apps/pipelines/${p.id}/promote`, { to: 'test' }).expect(409)).body;
    expect(refused).toMatchObject({ title: 'Security gate refused', step: 'security-gate', gate: { outcome: 'block', allowed: false } });
    expect(refused.detail).toMatch(/refuses app packages without a scan result/);
    expect(await audit('security.gate.blocked')).toHaveLength(1);
  });

  it('a critical finding blocks production; exceptions need a second admin and stop counting when they expire', async () => {
    const p = await pipeline();
    const toTest = (await ok(d.post(`/api/apps/pipelines/${p.id}/promote`, { to: 'test' }), 202)).body;
    await drain(e);
    const digest = `sha256:${await packageHash(toTest.packageId)}`;

    // A member without apps:design cannot upload; the designer (or a CI key with apps:design) can.
    const m = await member(e, 'mem');
    await upload(m as unknown as Client, { kind: 'app-package', digest }, TRIVY).expect(403);
    await upload(d as unknown as Client, { kind: 'app-package', digest: 'sha256:' + 'a'.repeat(64) }, TRIVY).expect(404);
    await upload(d as unknown as Client, { kind: 'app-package', digest }, 'nope').expect(422);
    await upload(d as unknown as Client, { kind: 'plugin-bundle', digest }, TRIVY).expect(403); // plugins:manage
    const res = (await ok(upload(d as unknown as Client, { kind: 'app-package', digest, scannedAt: now() }, TRIVY), 201)).body;
    expect(res).toMatchObject({ kind: 'app-package', digest, format: 'trivy', name: 'crm v1', label: 'confidential', findingCount: 8, uploadedVia: 'console' });
    expect(detail((await audit('security.scan.uploaded'))[0]!)).toMatchObject({ format: 'trivy', bySeverity: { critical: 2 } });
    const listed = (await d.get('/api/admin/security/scans').expect(200)).body;
    expect(listed.results.map((r: { id: string }) => r.id)).toEqual([res.id]);
    expect((await d.get(`/api/admin/security/scans/${res.id}`).expect(200)).body.findings).toHaveLength(8);

    const blocked = (await d.post(`/api/apps/pipelines/${p.id}/promote`, { to: 'production' }).expect(409)).body;
    expect(blocked.gate.blocking.map((f: { id: string }) => f.id).sort()).toEqual(['CVE-2026-1001', 'aws-access-key-id']);
    expect(blocked.detail).toMatch(/2 critical findings \(the policy allows 0\)\..*Blocking: .*CVE-2026-1001 in openssl 3\.0\.14-1/);
    expect((await e.h.s.db('app_deployments').where({ to_stage: 'production' })).length).toBe(0);
    expect(detail((await audit('security.gate.blocked'))[0]!)).toMatchObject({ where: 'pipeline.promote', counts: { critical: 2 } });

    // Exceptions: requested by the designer and by root; nobody approves their own; root2 approves both.
    const until = Date.now() + 7 * 86_400_000;
    await d.post('/api/admin/security/exceptions', { findingId: 'CVE-2026-1001', package: 'openssl', reason: 'short', expiresAt: until }).expect(400);
    await d.post('/api/admin/security/exceptions', { findingId: 'CVE-2026-1001', package: 'openssl', reason: 'not reachable: the handshake path is unused', expiresAt: until }).expect(403); // every kind needs platform:manage
    await d.post('/api/admin/security/exceptions', { findingId: 'CVE-2026-1001', kind: 'app-package', digest, reason: 'not reachable: the handshake path is unused', expiresAt: Date.now() + 400 * 86_400_000 }).expect(400);
    const ex1 = (await ok(d.post('/api/admin/security/exceptions', { findingId: 'CVE-2026-1001', package: 'openssl', kind: 'app-package', digest, reason: 'not reachable: the handshake path is unused', expiresAt: until }), 201)).body;
    const ex2 = (await ok(send(root, 'post', '/api/admin/security/exceptions', { findingId: 'aws-access-key-id', kind: 'app-package', reason: 'a revoked test key from the fixture', expiresAt: until }), 201)).body;
    expect(ex1).toMatchObject({ state: 'pending', requestedByName: 'DEE', acceptedBy: null });
    // Pending exceptions do not count yet.
    await d.post(`/api/apps/pipelines/${p.id}/promote`, { to: 'production' }).expect(409);
    await d.post(`/api/admin/security/exceptions/${ex1.id}/approve`, {}).expect(403); // the designer is no platform admin
    expect((await send(root, 'post', `/api/admin/security/exceptions/${ex2.id}/approve`).expect(403)).body.step).toBe('dual-control');
    const a1 = (await ok(send(root2, 'post', `/api/admin/security/exceptions/${ex1.id}/approve`, { note: 'checked the call graph' }), 200)).body;
    const a2 = (await ok(send(root, 'post', `/api/admin/security/exceptions/${ex2.id}/approve`), 403)).body;
    expect(a2.step).toBe('dual-control');
    await ok(send(root2, 'post', `/api/admin/security/exceptions/${ex2.id}/approve`), 200);
    const root2Id = (await e.h.s.users.byUsername(e.h.tenantId, 'root2'))!.id;
    expect(a1).toMatchObject({ state: 'active', acceptedBy: root2Id, decidedByName: 'ROOT2' });
    expect(detail((await audit('security.scan.exception.approved'))[0]!)).toMatchObject({ acceptedBy: root2Id, reason: 'not reachable: the handshake path is unused' });
    await send(root2, 'post', `/api/admin/security/exceptions/${ex1.id}/approve`).expect(409); // already decided

    const prod = (await ok(d.post(`/api/apps/pipelines/${p.id}/promote`, { to: 'production' }), 202)).body;
    expect(prod).toMatchObject({ state: 'awaiting-approval', gate: { outcome: 'pass', allowed: true } });
    expect(prod.gate.excepted.map((f: { exception: string }) => f.exception).sort()).toEqual([ex1.id, ex2.id].sort());
    expect(await audit('security.gate.passed')).toHaveLength(1);

    // The exceptions expire while the approval waits: the gate refuses again, and so does the deployment.
    await e.h.s.db('security_scan_exceptions').update({ expires_at: Date.now() - 1 });
    const g = (await send(d as unknown as Client, 'post', '/api/admin/security/gate', { kind: 'app-package', digest }).expect(200)).body;
    expect(g).toMatchObject({ outcome: 'block', excepted: [] });
    const approverUser = await localUser(e.h, 'approver', ['workflow-admin', 'member'], 'confidential');
    await e.h.s.tenants.addMember(e.wsId, approverUser.id);
    const approver = await loginAdmin(e.h, 'approver');
    await drain(e);
    const list = (await approver.agent.get('/api/workflow-approvals').expect(200)).body as { id: string }[];
    await approver.agent.post(`/api/workflow-approvals/${list[0]!.id}`).set('x-csrf-token', approver.csrf).send({ decision: 'approve' }).expect(200);
    await drain(e);
    const done = (await d.get(`/api/apps/deployments/${prod.id}`).expect(200)).body;
    expect(done.state).toBe('failed');
    expect(done.error).toMatch(/did not pass the security gate/);
    expect((await audit('security.gate.blocked')).map((a) => detail(a).where)).toContain('pipeline.deploy');
  });

  it('refuses a licence on the deny-list (an OR expression only when every alternative is denied) and a high count above the limit', async () => {
    const pkg = (await ok(d.post('/api/apps/crm/packages', { withData: false, note: 'for the scanner' }), 201)).body;
    const row = (await e.h.s.db('app_packages').where({ app_name: 'crm' }).orderBy('created_at', 'desc').first('id', 'hash')) as { id: string; hash: string };
    const digest = `sha256:${row.hash}`;
    await ok(upload(d as unknown as Client, { kind: 'app-package', digest, scannedAt: now() }, SBOM), 201);
    const evaluate = async () => (await send(d as unknown as Client, 'post', '/api/admin/security/gate', { kind: 'app-package', digest }).expect(200)).body;
    expect((await evaluate()).outcome).toBe('pass');
    await ok(policy(root, { licenceDeny: ['GPL-3.0-only', 'WTFPL'] }), 200);
    const g = await evaluate();
    expect(g.outcome).toBe('block');
    expect(g.blocking.map((f: { package: string }) => f.package).sort()).toEqual(['left-pad', 'strong-copyleft']);
    expect(g.reasons.join(' ')).toMatch(/2 components under a denied licence/);
    // Promoting exactly that package to test is refused with the licences named.
    const p = await pipeline();
    expect(pkg.version).toBeGreaterThan(0);
    const r = (await d.post(`/api/apps/pipelines/${p.id}/promote`, { to: 'test', packageId: row.id }).expect(409)).body;
    expect(r.detail).toMatch(/strong-copyleft \(GPL-3\.0-only\)/);
    await d.post(`/api/apps/pipelines/${p.id}/promote`, { to: 'production', packageId: row.id }).expect(400);
    // A licence exception (by its finding id) accepts it; the high vulnerability counts once maxHigh is 0.
    const ex = (await ok(send(root, 'post', '/api/admin/security/exceptions', { findingId: 'licence:GPL-3.0-only', kind: 'app-package', reason: 'used only in the build, never shipped', expiresAt: Date.now() + 86_400_000 }), 201)).body;
    await ok(send(root2, 'post', `/api/admin/security/exceptions/${ex.id}/approve`), 200);
    expect((await evaluate()).blocking.map((f: { package: string }) => f.package)).toEqual(['left-pad']);
    await ok(policy(root, { licenceDeny: [], maxHigh: 0 }), 200);
    const g2 = await evaluate();
    expect(g2.blocking.map((f: { id: string }) => f.id)).toEqual(['CVE-2026-2001']);
    expect(g2.reasons.join(' ')).toMatch(/1 high finding \(the policy allows 0\)/);
    // Revoking the exception is audited.
    await ok(send(root, 'post', `/api/admin/security/exceptions/${ex.id}/revoke`, { note: 'shipped after all' }), 200);
    expect(await audit('security.scan.exception.revoked')).toHaveLength(1);
  });

  it('refuses a digest whose results are all older than the policy allows', async () => {
    await ok(d.post('/api/apps/crm/packages', { withData: false }), 201);
    const row = (await e.h.s.db('app_packages').where({ app_name: 'crm' }).first('hash')) as { hash: string };
    const digest = `sha256:${row.hash}`;
    await ok(policy(root, { maxAgeDays: 3 }), 200);
    await ok(upload(d as unknown as Client, { kind: 'app-package', digest, scannedAt: String(Date.now() - 10 * 86_400_000) }, SARIF), 201);
    const evaluate = async () => (await send(d as unknown as Client, 'post', '/api/admin/security/gate', { kind: 'app-package', digest }).expect(200)).body;
    const stale = await evaluate();
    expect(stale).toMatchObject({ outcome: 'block', results: [expect.objectContaining({ format: 'sarif', stale: true })] });
    expect(stale.reasons.join(' ')).toMatch(/older than 3 days: scan it again/);
    // A fresh SARIF counts (and its critical SAST finding blocks for that reason instead).
    await ok(upload(d as unknown as Client, { kind: 'app-package', digest, scannedAt: now() }, SARIF), 201);
    const fresh = await evaluate();
    expect(fresh.results).toEqual([expect.objectContaining({ format: 'sarif', stale: false })]);
    expect(fresh.blocking.map((f: { id: string }) => f.id)).toEqual(['javascript.lang.security.eval-injection']);
    // A scan time in the future is refused.
    await upload(d as unknown as Client, { kind: 'app-package', digest, scannedAt: String(Date.now() + 86_400_000) }, SARIF).expect(400);
  });

  it('gates enabling a plugin on its manifest digest, and deleting a result is a platform admin\'s', async () => {
    const manifest = { key: 'notify-me', name: 'Notify me', version: '1.0.0', kind: 'declarative', events: ['flag.*'], capabilities: ['read:events', 'emit:notification'], optionalCapabilities: [], actions: [{ type: 'notify', on: 'flag.created' }] };
    const installed = (await ok(send(root, 'post', '/api/admin/plugins', { manifest }), 201)).body;
    const digest = `sha256:${installed.manifestHash}`;
    const res = (await ok(upload(root, { kind: 'plugin-bundle', digest, scannedAt: now() }, SBOM), 201)).body;
    expect(res).toMatchObject({ kind: 'plugin-bundle', name: 'notify-me 1.0.0', ref: 'notify-me' });
    await ok(policy(root, { licenceDeny: ['WTFPL'] }), 200);
    const r = (await send(root, 'post', `/api/admin/plugins/${installed.id}/enable`).expect(409)).body;
    expect(r).toMatchObject({ step: 'security-gate' });
    expect(r.detail).toMatch(/plugin bundle notify-me 1\.0\.0 did not pass the security gate.*left-pad \(WTFPL\)/);
    expect((await e.h.s.db('plugins').where({ id: installed.id }).first('state')).state).toBe('installed');
    // The designer cannot see plugin results at all.
    expect((await d.get('/api/admin/security/scans').expect(200)).body.results).toEqual([]);
    await d.get(`/api/admin/security/scans/${res.id}`).expect(404);
    await send(d as unknown as Client, 'delete', `/api/admin/security/scans/${res.id}`).expect(403);
    await send(root, 'delete', `/api/admin/security/scans/${res.id}`).expect(204);
    expect(await audit('security.scan.deleted')).toHaveLength(1);
    expect((await ok(send(root, 'post', `/api/admin/plugins/${installed.id}/enable`), 200)).body.state).toBe('enabled');
    expect(detail((await audit('security.gate.warned')).at(-1)!)).toMatchObject({ where: 'plugin.enable' });
  });

  it('gates a script runner image: a result matches only a digest-pinned image', async () => {
    const pinned = `registry.internal/exprsn-ai/scripts@${TRIVY_DIGEST}`;
    // The digest comes from the Trivy report itself.
    const res = (await ok(upload(root, { kind: 'script-image', scannedAt: now() }, TRIVY), 201)).body;
    expect(res).toMatchObject({ kind: 'script-image', digest: TRIVY_DIGEST, ref: `registry.internal/exprsn-ai/scripts@${TRIVY_DIGEST}` });
    await upload(d as unknown as Client, { kind: 'script-image', digest: TRIVY_DIGEST }, TRIVY).expect(403); // platform:manage
    const r = (await send(root, 'post', '/api/admin/platform/settings/SCRIPT_IMAGE_PYTHON/proposals', { value: pinned, reason: 'patched image' }).expect(409)).body;
    expect(r).toMatchObject({ step: 'security-gate', gate: { artefact: { kind: 'script-image', digest: TRIVY_DIGEST } } });
    expect(detail((await audit('security.gate.blocked')).at(-1)!)).toMatchObject({ where: 'script-image' });
    // A tag cannot match a result: with the default policy it is allowed with a warning, with `refuse` it is not.
    await ok(policy(root, { missing: 'refuse' }), 200);
    expect((await send(root, 'post', '/api/admin/platform/settings/SCRIPT_IMAGE_PYTHON/proposals', { value: 'python:3.13', reason: 'newer' }).expect(409)).body.detail).toMatch(/named by a tag, not a digest/);
    await ok(policy(root, { missing: 'warn' }), 200);
    const prop = (await ok(send(root, 'post', '/api/admin/platform/settings/SCRIPT_IMAGE_PYTHON/proposals', { value: 'python:3.13', reason: 'newer' }), 202)).body;
    // The approval asks the gate again: the policy changed meanwhile, so the second admin's approval is refused.
    await ok(policy(root2, { missing: 'refuse' }), 200);
    expect((await send(root2, 'post', `/api/admin/platform/settings/proposals/${prop.id}/approve`).expect(409)).body.step).toBe('security-gate');
  });
});
