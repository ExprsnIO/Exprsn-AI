import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ONPREM_ORIGINS, renderOnprem, onpremSpecSchema, type OnpremInstall } from '../src/cloud/onprem.js';
import { edgeWorld, type EdgeWorld } from './cloudflare-edge-helpers.js';

/*
 * 1.9.99-final, Sprint 62 (B-10209): an existing install (Compose, bare metal, Helm) registered as a deployment
 * without compute, so the Cloudflare front door, drift and spend apply to it. Against `fake-cloudflare.ts` on
 * 127.0.0.1 only; migrations 148, 149, 155 and 161 are applied by hand when missing, 165 (the change trail) too.
 */

const D = '/api/admin/cloud/deployments';
const E = '/api/admin/cloud/edge';
const COMPUTE_TYPES = ['network', 'subnet', 'firewall', 'vm', 'kubernetes_cluster', 'node_group', 'container_service', 'load_balancer', 'database', 'cache', 'bucket', 'worker', 'hyperdrive'];

describe('B-10209: on-prem targets for the front door only', () => {
  let w: EdgeWorld;

  const post = (path: string, body: unknown) => w.admin.client.agent.post(path).set('x-csrf-token', w.admin.client.csrf).send(body as object);
  const get = (path: string) => w.admin.client.agent.get(path);
  const body = (kind: OnpremInstall, extra: Record<string, unknown> = {}) => ({ kind: 'onprem', name: `onprem-${kind}`, install: { kind }, frontDoor: { kind: 'cloudflare', accountId: w.account.id, hostname: `${kind}.example.test`, zone: 'example.test' }, ...extra });

  beforeAll(async () => {
    w = await edgeWorld();
    const db = w.h.s.db;
    if (!(await db.schema.hasTable('cloud_deployments'))) await (await import('../src/db/migrations/148_cloud_journal.js')).up(db);
    if (!(await db.schema.hasTable('cloud_drift_findings'))) await (await import('../src/db/migrations/149_cloud_lifecycle.js')).up(db);
    if (!(await db.schema.hasTable('cloud_costs'))) await (await import('../src/db/migrations/155_cloud_costs.js')).up(db);
    if (!(await db.schema.hasTable('cloud_change_trail'))) await (await import('../src/db/migrations/165_cloud_change_trail.js')).up(db);
    w.h.s.cloud.deployments.resetSchemaCache();
    w.h.s.cloud.lifecycle.schema.reset();
    w.h.s.cloud.lifecycle.trail.resetSchemaCache();
    w.h.s.cloud.costs.resetSchemaCache();
    const VALIDATED = { at: Date.now(), ok: true, identity: { ok: true, principal: 'token exprsn' }, features: [{ feature: 'frontdoor', name: 'Front door', status: 'ok', required: [], missing: [], reason: null }] };
    await db('cloud_accounts').where({ id: w.account.id }).update({ validation: JSON.stringify(VALIDATED) });
  }, 120_000);
  afterAll(() => w.stop());

  it('renders no compute: no network, compute or data tier, only the front door on the Cloudflare account', () => {
    for (const kind of ['compose', 'baremetal', 'helm'] as const) {
      const spec = onpremSpecSchema.parse({ kind: 'onprem', name: `x-${kind}`, install: { kind }, frontDoor: { kind: 'cloudflare', accountId: '01J00000000000000000000000', hostname: 'ai.example.test', zone: 'example.test' } });
      expect(spec.compute).toEqual({ shape: 'none' });
      const g = renderOnprem(spec);
      expect(g.resources).toEqual([]);
      expect(g.origin).toBe(ONPREM_ORIGINS[kind]);
      expect(g.frontDoor.resources.map((r) => r.type)).toEqual(['tunnel', 'dns_record']);
    }
    // A compute shape other than none is not an on-prem spec.
    expect(onpremSpecSchema.safeParse({ kind: 'onprem', name: 'x-bad', install: { kind: 'compose' }, compute: { shape: 'vm' }, frontDoor: { kind: 'cloudflare', accountId: '01J00000000000000000000000', hostname: 'ai.example.test', zone: 'example.test' } }).success).toBe(false);
  });

  for (const kind of ['compose', 'baremetal', 'helm'] as const) {
    it(`registers a ${kind} install, gets a tunnel and DNS from the wizard with nothing else planned, and shows in deployments, drift and spend`, async () => {
      // The wizard's dry run.
      const dry = await post(`${D}/validate-spec`, body(kind));
      expect(dry.status, JSON.stringify(dry.body)).toBe(200);
      expect(dry.body).toMatchObject({ valid: true, kind: 'onprem', resources: [], firewalls: [], problems: [], origin: ONPREM_ORIGINS[kind] });
      expect(dry.body.frontDoor.resources.map((r: { type: string }) => r.type)).toEqual(['tunnel', 'dns_record']);

      // Registration calls no cloud and plans nothing.
      w.cf.reset();
      const made = await post(D, body(kind));
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      expect(w.cf.requests).toHaveLength(0);
      const dep = made.body.deployment as { id: string; kind: string; provider: string; accountId: string; region: string; spec: { compute: { shape: string }; install: { kind: string; service: string } } };
      expect(dep).toMatchObject({ kind: 'onprem', provider: 'cloudflare', accountId: w.account.id, region: 'global', spec: { compute: { shape: 'none' }, install: { kind, service: ONPREM_ORIGINS[kind] } } });
      expect(made.body.plan.steps).toEqual([]);
      expect(made.body.edge).toMatchObject({ name: `onprem-${kind}`, deploymentId: dep.id, hostname: `${kind}.example.test`, origin: { kind: 'tunnel', service: ONPREM_ORIGINS[kind] }, state: 'draft' });
      expect(made.body.install).toMatchObject({ edge: `onprem-${kind}`, inboundPorts: [] });

      // The edge flow: tunnel and DNS, nothing else.
      const applied = await post(`${E}/${made.body.edge.id}/apply`, {});
      expect(applied.status, JSON.stringify(applied.body)).toBe(200);
      const tunnelId = applied.body.edge.tunnelId as string;
      expect(tunnelId).toBeTruthy();
      const record = [...w.cf.records.values()].find((r) => r.name === `${kind}.example.test`)!;
      expect(record).toMatchObject({ type: 'CNAME', content: `${tunnelId}.cfargotunnel.com`, proxied: true });
      const writes = w.cf.requests.filter((r) => r.method !== 'GET').map((r) => r.op);
      expect(writes.some((op) => /cfd_tunnel/.test(op))).toBe(true);
      expect(writes.every((op) => /cfd_tunnel|dns_records|settings|rulesets/.test(op)), writes.join(', ')).toBe(true);

      // The deployment now holds the tunnel and the record (and nothing of compute).
      const graph = await get(`${D}/${dep.id}/graph`);
      expect(graph.status).toBe(200);
      const res = graph.body.resources as { key: string; type: string; providerId: string; state: string }[];
      expect(res.map((r) => [r.key, r.type, r.state])).toEqual([['dns-app', 'dns_record', 'ready'], ['tunnel', 'tunnel', 'ready']]);
      expect(res.find((r) => r.key === 'tunnel')!.providerId).toBe(tunnelId);
      expect(res.some((r) => COMPUTE_TYPES.includes(r.type))).toBe(false);
      expect(graph.body.deployment).toMatchObject({ kind: 'onprem', state: 'applied', endpoints: { publicUrl: `https://${kind}.example.test` } });

      // Deployments list.
      const list = await get(`${D}?kind=onprem`);
      expect(list.status).toBe(200);
      expect(list.body.deployments.map((d: { id: string }) => d.id)).toContain(dep.id);
      expect(list.body.deployments.every((d: { kind: string }) => d.kind === 'onprem')).toBe(true);
      expect((await get(`${D}?kind=cloud`)).body.deployments.map((d: { id: string }) => d.id)).not.toContain(dep.id);

      // Drift: clean, then the record made DNS-only by hand, named by the audit logs.
      const clean = await post(`${D}/${dep.id}/drift/check`, {});
      expect(clean.status, JSON.stringify(clean.body)).toBe(200);
      expect(clean.body.findings).toEqual([]);
      record.proxied = false;
      w.cf.addAuditLog({ resourceId: record.id, action: 'rec_set', at: Date.now() - 60_000, email: `ops-${kind}@example.test`, name: record.name });
      const drifted = await post(`${D}/${dep.id}/drift/check`, {});
      expect(drifted.status, JSON.stringify(drifted.body)).toBe(200);
      expect(drifted.body.findings.map((f: { kind: string; key: string; path: string }) => [f.kind, f.key, f.path])).toEqual([['field', 'dns-app', 'proxied']]);
      const findings = await get(`${D}/${dep.id}/drift`);
      expect(findings.body.findings[0].changedBy).toMatchObject({ principal: `ops-${kind}@example.test`, action: 'rec_set' });
      record.proxied = true;

      // Spend: the Cloudflare account's, by deployment.
      const spend = await get(`${D}/${dep.id}/costs`);
      expect(spend.status, JSON.stringify(spend.body)).toBe(200);
      expect(spend.body.deployment).toMatchObject({ id: dep.id, name: `onprem-${kind}` });
      expect(spend.body.deployments.map((d: { deploymentId: string }) => d.deploymentId)).toContain(dep.id);
    });
  }

  it('attaches the install\'s earlier front door instead of making a second one', async () => {
    const early = await post(E, { name: 'onprem-early', accountId: w.account.id, hostname: 'early.example.test', zone: 'example.test', origin: { kind: 'tunnel', service: 'http://127.0.0.1:8080' } });
    expect(early.status, JSON.stringify(early.body)).toBe(201);
    const made = await post(D, { kind: 'onprem', name: 'onprem-early', install: { kind: 'baremetal' }, frontDoor: { kind: 'cloudflare', accountId: w.account.id, hostname: 'early.example.test', zone: 'example.test' } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.edge).toMatchObject({ id: early.body.edge.id, deploymentId: made.body.deployment.id });
    expect((await w.h.s.db('cloud_edge').where({ hostname: 'early.example.test' })).length).toBe(1);
  });

  it('refuses what a front door may not carry, before anything exists', async () => {
    const restricted = await post(D, body('compose', { name: 'onprem-secret', label: 'restricted', frontDoor: { kind: 'cloudflare', accountId: w.account.id, hostname: 'secret.example.test', zone: 'example.test' } }));
    expect(restricted.status).toBe(403);
    const outside = await post(D, body('compose', { name: 'onprem-out', frontDoor: { kind: 'cloudflare', accountId: w.account.id, hostname: 'ai.other.test', zone: 'example.test' } }));
    expect(outside.status).toBe(422);
    expect(outside.body.problems.map((p: { check: string }) => p.check)).toContain('front_door');
    const taken = await post(D, body('compose'));
    expect(taken.status).toBe(422);
    expect(await w.h.s.db('cloud_deployments').whereIn('name', ['onprem-secret', 'onprem-out']).count('* as n').first()).toMatchObject({ n: 0 });
  });
});
