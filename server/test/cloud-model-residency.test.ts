import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { instanceScope, scopeOf, zoneHasEgress } from '../src/cloud/model-residency.js';
import type { CloudAccount } from '../src/cloud/types.js';
import type { InstanceRow } from '../src/gateway/repo.js';
import { DEFAULT_ZONES, type ZoneSpec } from '../src/zones/spec.js';
import { seedAccount } from './cloud-credentials-helpers.js';
import { FakeAws } from './fake-aws.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * 1.9.99-final, Sprint 61 (B-10507): residency and egress of cloud model calls, against the Bedrock fake. Each entry
 * lists the regions it may run in and each is held to the account's allow-list; cross-region and global models
 * (inference profiles, Azure data-zone and global deployments, DigitalOcean's serverless endpoint, Workers AI) are
 * refused above `internal` with the request's own label, whatever the model's; the account's data terms attested
 * under dual control raise a regional entry to `confidential`, never `restricted`; and once zones are defined a cloud
 * call leaves only from a pool in a zone with egress. Migrations 146, 159 and 163 are applied here when missing.
 */

vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 });

const HAIKU = 'anthropic.claude-3-haiku-20240307-v1:0';
const EU_PROFILE = 'eu.anthropic.claude-3-haiku-20240307-v1:0';
const GLOBAL_PROFILE = 'global.anthropic.claude-3-haiku-20240307-v1:0';

describe('scopes (B-10507)', () => {
  const e = (o: Partial<Parameters<typeof scopeOf>[0]>) => scopeOf({ flavour: 'bedrock', offer: 'foundation', routesTo: ['eu-central-1'], externalId: HAIKU, ...o });
  it('tells regional, cross-region and global models apart', () => {
    expect(e({})).toBe('regional');
    expect(e({ offer: 'inference_profile', externalId: EU_PROFILE, routesTo: ['eu-central-1', 'eu-west-1'] })).toBe('cross-region');
    expect(e({ externalId: GLOBAL_PROFILE, routesTo: ['*'] })).toBe('global');
    expect(e({ flavour: 'azure', offer: 'deployment', details: { sku: 'Standard' } })).toBe('regional');
    expect(e({ flavour: 'azure', offer: 'deployment', details: { sku: 'DataZoneStandard' } })).toBe('cross-region');
    expect(e({ flavour: 'azure', offer: 'deployment', details: { sku: 'GlobalStandard' } })).toBe('global');
    expect(e({ flavour: 'digitalocean', offer: 'model' })).toBe('global');
    expect(e({ flavour: 'workers-ai', offer: 'model' })).toBe('global');
    const bedrock = { kind: 'bedrock', settings: { cloud: { provider: 'aws', accountId: 'x', region: 'eu-central-1' } } } as unknown as InstanceRow;
    expect([instanceScope(bedrock, HAIKU), instanceScope(bedrock, EU_PROFILE), instanceScope(bedrock, GLOBAL_PROFILE)]).toEqual(['regional', 'cross-region', 'global']);
  });

  it('knows a zone with egress from one without', () => {
    const zones = new Map(DEFAULT_ZONES.map((z) => [z.id, { spec: z.spec }]));
    const inference = DEFAULT_ZONES.find((z) => z.id === 'inference')!.spec;
    expect(zoneHasEgress(inference, zones)).toBe(false);
    const egress: ZoneSpec = { ...inference, egress: { mode: 'allow-list', allow: [{ kind: 'zone', zone: 'external', ports: [443] }], note: null } };
    expect(zoneHasEgress(egress, zones)).toBe(true);
    expect(zoneHasEgress({ ...inference, egress: { mode: 'allow-list', allow: [{ kind: 'cidr', cidr: '0.0.0.0/0', ports: [443] }], note: null } }, zones)).toBe(true);
    expect(zoneHasEgress({ ...inference, egress: { mode: 'allow-list', allow: [{ kind: 'cidr', cidr: '10.0.0.0/8', ports: [443] }], note: null } }, zones)).toBe(false);
  });
});

describe('residency, egress and attestations (B-10507)', () => {
  let h: Harness;
  const aws = new FakeAws();
  let account: CloudAccount;
  let a: Client;
  let b: Client;
  let inst: InstanceRow;
  const ids: Record<string, string> = {};
  const post = (c: Client, url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body);
  const terms = { noTraining: true, retentionDays: 0, abuseMonitoring: 'off', reference: 'https://aws.amazon.com/service-terms/' };
  const check = (model: string, label: 'public' | 'internal' | 'confidential' | 'restricted') => h.s.cloud.modelResidency.check(inst, model, label);

  beforeAll(async () => {
    await aws.start();
    h = await harness({ SERVICE_ALLOWED_HOSTS: '127.0.0.1', OLLAMA_POLL_MS: '600000' });
    if (!(await h.s.db.schema.hasTable('cloud_accounts'))) await (await import('../src/db/migrations/146_cloud_accounts.js')).up(h.s.db);
    if (!(await h.s.db.schema.hasTable('cloud_model_entries'))) await (await import('../src/db/migrations/159_cloud_models.js')).up(h.s.db);
    if (!(await h.s.db.schema.hasTable('cloud_model_attestations'))) await (await import('../src/db/migrations/163_cloud_model_prices.js')).up(h.s.db);
    h.s.cloud.accounts.resetSchemaCache();
    h.s.cloud.modelImport.resetSchemaCache();
    h.s.cloud.modelResidency.resetSchemaCache();
    const key = aws.addUser({ userName: 'exprsn-read' });
    (h.s.cloud as { credentials: unknown }).credentials = { for: async () => ({ kind: 'aws', accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey, expiresAt: null }) };
    h.s.cloud.bedrock.setEndpoints({ bedrock: aws.url, bedrockRuntime: aws.url });
    h.s.cloud.bedrock.setTransport({ sleep: async () => {}, random: () => 0.5 });
    account = await seedAccount(h, { provider: 'aws', mode: 'vaulted', name: 'aws-residency', providerIds: { awsAccountId: aws.account } });
    // Both EU regions on the allow-list at confidential, eu-central-1 at restricted to show the cap; EU residency.
    await h.s.db('cloud_account_regions').where({ account_id: account.id }).update({ ceiling: 'restricted' });
    await h.s.db('cloud_account_regions').insert({ account_id: account.id, region: 'eu-west-1', zone: 'cloud-eu', ceiling: 'confidential', geo: 'eu', is_default: false, updated_at: Date.now() });
    await h.s.db('cloud_residency').insert({ tenant_id: h.tenantId, geos: JSON.stringify(['eu']), updated_by: null, updated_at: Date.now() });
    account = (await h.s.cloud.accounts.get(account.id))!;
    await localUser(h, 'rca', ['model-admin', 'tenant-admin', 'cloud-admin'], 'restricted');
    await localUser(h, 'rcb', ['model-admin', 'cloud-admin'], 'restricted');
    a = await loginAdmin(h, 'rca');
    b = await loginAdmin(h, 'rcb');
    const pool = (await post(a, '/api/admin/pools', { name: 'bedrock-res', accelerator: 'cpu', labelCeiling: 'confidential' }).expect(201)).body;
    inst = (await h.s.gateway.repo.instance((await post(a, `/api/admin/pools/${pool.id}/instances`, { name: 'bedrock-res-1', kind: 'bedrock', deploy: 'docker', cloud: { accountId: account.id, region: 'eu-central-1' } }).expect(201)).body.id))!;
    const imp = (await post(a, `/api/admin/cloud/accounts/${account.id}/model-import`, { region: 'eu-central-1', ids: [HAIKU, EU_PROFILE, GLOBAL_PROFILE] }).expect(201)).body;
    for (const r of imp.results) ids[r.id] = r.modelId;
    expect(imp.results.find((r: { id: string }) => r.id === GLOBAL_PROFILE)).toMatchObject({ outcome: 'skipped' });
  }, 180_000);

  afterAll(async () => {
    await h?.close();
    await aws.stop();
  });

  beforeEach(() => h.s.cloud.modelResidency.reset());

  it('lists each entry\'s regions, held to the account\'s allow-list at call time', async () => {
    const cards = (await a.agent.get('/api/admin/cloud/model-cards').expect(200)).body.cards as { name: string; residency: { scope: string; cap: string | null; regions: { region: string; allowed: boolean }[] } }[];
    const by = Object.fromEntries(cards.map((c) => [c.name, c]));
    expect(by[HAIKU]!.residency).toMatchObject({ scope: 'regional', cap: null, regions: [{ region: 'eu-central-1', allowed: true }] });
    expect(by[EU_PROFILE]!.residency).toMatchObject({ scope: 'cross-region', cap: 'internal', regions: [{ region: 'eu-central-1', allowed: true }, { region: 'eu-west-1', allowed: true }] });
    await expect(check(EU_PROFILE, 'internal')).resolves.toBeUndefined();
    // A routing region taken off the allow-list stops the profile at once (after the kept decision is forgotten).
    await h.s.db('cloud_account_regions').where({ account_id: account.id, region: 'eu-west-1' }).delete();
    h.s.cloud.modelResidency.reset();
    await expect(check(EU_PROFILE, 'internal')).rejects.toMatchObject({ status: 403, extensions: expect.objectContaining({ step: 'zone', check: 'region', region: 'eu-west-1' }) });
    await expect(check(HAIKU, 'internal')).resolves.toBeUndefined();
    await h.s.db('cloud_account_regions').insert({ account_id: account.id, region: 'eu-west-1', zone: 'cloud-eu', ceiling: 'confidential', geo: 'eu', is_default: false, updated_at: Date.now() });
  });

  it('refuses cross-region and global models above internal, with the request\'s own label', async () => {
    // Even labelled confidential, a cross-region profile never serves a confidential request.
    await h.s.gateway.repo.updateModel(ids[EU_PROFILE]!, { label: 'confidential' });
    await expect(check(EU_PROFILE, 'confidential')).rejects.toMatchObject({ status: 403, extensions: expect.objectContaining({ check: 'residency', scope: 'cross-region' }) });
    // A confidential conversation is never routed to a global inference profile (it has no entry: it is not importable).
    await expect(check(GLOBAL_PROFILE, 'confidential')).rejects.toMatchObject({ status: 403, extensions: expect.objectContaining({ check: 'residency', scope: 'global' }) });
    await expect(check(GLOBAL_PROFILE, 'restricted')).rejects.toMatchObject({ status: 403 });
    // And approving it above internal is refused.
    await h.s.gateway.repo.updateModel(ids[EU_PROFILE]!, { label: 'internal' });
    expect((await a.agent.patch(`/api/admin/models/${ids[EU_PROFILE]}`).set('x-csrf-token', a.csrf).send({ label: 'confidential' }).expect(403)).body).toMatchObject({ step: 'zone' });
    // No attestation can lift a cross-region entry.
    expect((await post(a, `/api/admin/cloud/model-entries/${ids[EU_PROFILE]}/attestations`, terms).expect(409)).body.detail).toMatch(/cross-region model; it stays at internal/);
  });

  it('raises a regional entry to confidential under dual control, never restricted, and revoking drops it back', async () => {
    const m = ids[HAIKU]!;
    expect((await h.s.cloud.modelImport.entry(m))!.ceiling).toBe('internal');
    await expect(check(HAIKU, 'confidential')).rejects.toMatchObject({ status: 403, extensions: expect.objectContaining({ check: 'ceiling', ceiling: 'internal' }) });
    await post(a, `/api/admin/cloud/model-entries/${m}/attestations`, { ...terms, noTraining: false }).expect(400); // the terms must say no training
    const att = (await post(a, `/api/admin/cloud/model-entries/${m}/attestations`, terms).expect(201)).body;
    expect(att).toMatchObject({ state: 'proposed', terms: { noTraining: true, retentionDays: 0, abuseMonitoring: 'off' } });
    await post(a, `/api/admin/cloud/model-entries/${m}/attestations`, terms).expect(409); // one at a time
    // Nothing changes until a second cloud admin approves; the proposer cannot.
    expect((await h.s.cloud.modelImport.entry(m))!.ceiling).toBe('internal');
    expect((await post(a, `/api/admin/cloud/attestations/${att.id}/approve`).expect(403)).body.reason).toBe('dual_control');
    const ok = (await post(b, `/api/admin/cloud/attestations/${att.id}/approve`).expect(200)).body;
    // eu-central-1's ceiling is restricted, but an attested cloud entry stops at confidential (open decision 5).
    expect(ok).toMatchObject({ ceiling: 'confidential', attestation: { state: 'active' } });
    expect((await h.s.cloud.modelImport.entry(m))!.ceiling).toBe('confidential');
    // The model may now be labelled and serve confidential requests (EU residency admits eu-central-1); never restricted.
    await a.agent.patch(`/api/admin/models/${m}`).set('x-csrf-token', a.csrf).send({ label: 'confidential' }).expect(200);
    await expect(check(HAIKU, 'confidential')).resolves.toBeUndefined();
    await expect(check(HAIKU, 'restricted')).rejects.toMatchObject({ status: 403 });
    expect((await a.agent.patch(`/api/admin/models/${m}`).set('x-csrf-token', a.csrf).send({ label: 'restricted' }).expect(403)).body).toMatchObject({ step: 'zone', ceiling: 'confidential' });
    // A re-import keeps the attested ceiling.
    expect((await post(a, `/api/admin/cloud/accounts/${account.id}/model-import`, { region: 'eu-central-1', ids: [HAIKU] }).expect(200)).body.results[0]).toMatchObject({ outcome: 'unchanged', ceiling: 'confidential' });
    // The card shows it.
    const card = (await a.agent.get('/api/admin/cloud/model-cards').expect(200)).body.cards.find((c: { name: string }) => c.name === HAIKU);
    expect(card.residency).toMatchObject({ ceiling: 'confidential', attestation: { state: 'active', terms: { retentionDays: 0 } } });
    // Audited under the attestation's id.
    const actions = (await h.s.db('audit_events').where('action', 'like', 'cloud.model.attestation.%').select('action')).map((r: { action: string }) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['cloud.model.attestation.proposed', 'cloud.model.attestation.approved']));
    // Revoked: the ceiling and the model's label drop back to internal; confidential requests are refused again.
    const rev = (await post(a, `/api/admin/cloud/attestations/${att.id}/revoke`).expect(200)).body;
    expect(rev).toMatchObject({ ceiling: 'internal', attestation: { state: 'revoked' } });
    expect((await h.s.gateway.repo.model(m))!.label).toBe('internal');
    await expect(check(HAIKU, 'confidential')).rejects.toMatchObject({ status: 403 });
    await expect(check(HAIKU, 'internal')).resolves.toBeUndefined();
    // A proposal can be rejected, or withdrawn by its proposer.
    const again = (await post(a, `/api/admin/cloud/model-entries/${m}/attestations`, terms).expect(201)).body;
    expect((await post(a, `/api/admin/cloud/attestations/${again.id}/reject`, { note: 'wrong document' }).expect(200)).body.state).toBe('rejected');
    const list = (await a.agent.get(`/api/admin/cloud/attestations?model=${m}`).expect(200)).body.attestations;
    expect(list.map((x: { state: string }) => x.state).sort()).toEqual(['rejected', 'revoked']);
  });

  it('once zones are defined, a cloud call leaves only from a pool in a zone with egress', async () => {
    const zones = new Map(DEFAULT_ZONES.map((z) => [z.id, { version: 1, spec: structuredClone(z.spec) }]));
    const real = h.s.zones.current.bind(h.s.zones);
    h.s.zones.current = async () => zones;
    try {
      // The pool is in `inference`, whose egress is denied.
      await expect(check(HAIKU, 'internal')).rejects.toMatchObject({ status: 403, extensions: expect.objectContaining({ check: 'egress', zone: 'inference' }) });
      zones.set('egress', { version: 1, spec: { ...structuredClone(zones.get('inference')!.spec), egress: { mode: 'allow-list', allow: [{ kind: 'zone', zone: 'external', ports: [443] }], note: null } } });
      await h.s.db('pools').where({ id: inst.pool_id }).update({ zone: 'egress' });
      h.s.cloud.modelResidency.reset();
      await expect(check(HAIKU, 'internal')).resolves.toBeUndefined();
    } finally {
      h.s.zones.current = real;
      await h.s.db('pools').where({ id: inst.pool_id }).update({ zone: 'inference' });
    }
    // Without zones (the default), nothing changes.
    h.s.cloud.modelResidency.reset();
    await expect(check(HAIKU, 'internal')).resolves.toBeUndefined();
  });
});
