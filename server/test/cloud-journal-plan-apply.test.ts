import { generateKeyPairSync } from 'node:crypto';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '../src/authz/policy.js';
import { CloudEngine, HardStop } from '../src/cloud/apply.js';
import { dependencyOrder, validateGraph, type DesiredResource, type GraphResource, type ObservedResource } from '../src/cloud/graph.js';
import { idempotencyKey } from '../src/cloud/journal.js';
import { diffGraph, fieldChanges, satisfies } from '../src/cloud/planner.js';
import { ProviderRegistry } from '../src/cloud/providers/registry.js';
import type { CloudAccount } from '../src/cloud/types.js';
import { selfSignedCertificate } from '../src/federation/x509.js';
import { servicePolicy } from '../src/platform/egress.js';
import { clock, seedAccount } from './cloud-credentials-helpers.js';
import type { RecordedRequest, Reply } from './fake-cloud-base.js';
import { FakeDigitalOcean } from './fake-do.js';
import { harness, localUser, loginAdmin, type Harness } from './helpers.js';

/*
 * 1.9.99-final, Sprint 57 (B-10102 to B-10105, B-10701): the resource graph and the journal, plans, the apply worker
 * and verify, against the DigitalOcean fake on 127.0.0.1 (no network, no real cloud). The fake's droplets answer
 * with an action to poll and its firewalls with a status to follow, so the long-running paths are real. Migration
 * 148 is applied here by hand until it is registered.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 90_000 });

const ALLOWED = '127.0.0.1,::1,localhost';
const D = '/api/admin/cloud/deployments';

/** The DigitalOcean fake, answering with a request id as the real API does. */
class Fake extends FakeDigitalOcean {
  private rid = 0;
  protected override handle(r: RecordedRequest): Reply {
    const rep = super.handle(r);
    return { ...rep, headers: { ...(rep.headers ?? {}), 'x-request-id': `req-${++this.rid}` } };
  }
}

async function install(h: Harness): Promise<void> {
  if (!(await h.s.db.schema.hasTable('cloud_deployments'))) await (await import('../src/db/migrations/148_cloud_journal.js')).up(h.s.db);
  h.s.cloud.deployments.resetSchemaCache();
}

const admin = (h: Harness, roles = ['system-admin']): Principal => ({
  kind: 'user',
  userId: 'u-cloud-admin',
  tenantId: h.tenantId,
  tenantSlug: h.s.cfg.DEFAULT_TENANT,
  username: 'cloud-admin',
  displayName: 'Cloud admin',
  roles,
  clearance: 'restricted',
  scopes: null,
  sessionId: null,
  apiKeyId: null,
  mfa: true
});

const VALIDATED = { at: Date.now(), ok: true, identity: { ok: true }, features: [{ feature: 'deploy', name: 'Deploy', status: 'ok', required: [], missing: [], reason: null }] };

interface World {
  h: Harness;
  fake: Fake;
  account: CloudAccount;
  actor: { principal: Principal; ip: string };
}

async function world(): Promise<World> {
  const h = await harness({ SERVICE_ALLOWED_HOSTS: ALLOWED });
  await install(h);
  const fake = await new Fake().start();
  fake.settleAfter = 1;
  const token = fake.addToken();
  const registry = new ProviderRegistry({ policy: servicePolicy({ SERVICE_ALLOWED_HOSTS: ALLOWED }), endpoints: { digitalocean: { api: fake.url } }, transport: { sleep: async () => undefined, random: () => 0.5 } });
  Object.defineProperty(h.s.cloud, 'providers', { value: registry, configurable: true });
  (h.s.cloud as { credentials: unknown }).credentials = { for: async () => ({ kind: 'token', token }) };
  h.s.cloud.engine.options.sleep = async () => undefined;
  const seeded = await seedAccount(h, { provider: 'digitalocean', mode: 'vaulted', name: 'do-main', providerIds: { doTeamId: fake.account.team.uuid }, refs: { token: 'vault:cloud/do-main#token' } });
  await h.s.db('cloud_accounts').where({ id: seeded.id }).update({ validation: JSON.stringify(VALIDATED) });
  const account = (await h.s.cloud.accounts.get(seeded.id))!;
  return { h, fake, account, actor: { principal: admin(h), ip: '127.0.0.1' } };
}

let seq = 0;
async function deployment(w: World, extra: { endpoints?: Record<string, unknown> } = {}) {
  return w.h.s.cloud.deployments.create(w.actor, { name: `dep-${++seq}`, accountId: w.account.id, ...(extra.endpoints ? { endpoints: extra.endpoints } : {}) });
}

const net = (key = 'core', cidr = '10.10.0.0/20'): DesiredResource => ({ key, type: 'network', spec: { cidr }, dependsOn: [], protect: false, region: null });
const fw = (key: string, port = '443', network?: string): DesiredResource => ({ key, type: 'firewall', spec: { ingress: [{ protocol: 'tcp', ports: port, sources: ['0.0.0.0/0'] }] }, dependsOn: network ? [network] : [], protect: false, region: null });
const vm = (key: string, network = 'core'): DesiredResource => ({ key, type: 'vm', spec: { size: 's-1vcpu-1gb', image: 'ubuntu-24-04-x64' }, dependsOn: [], network, protect: false, region: null });
const dns = (key: string, values: string[]): DesiredResource => ({ key, type: 'dns_record', spec: { zone: 'example.test', record: key, recordType: 'A', values }, dependsOn: [], protect: false, region: null });

/** Plans, queues the apply and runs it here with the job's id; returns the outcome. */
async function applyNow(w: World, deploymentId: string, desired: DesiredResource[]) {
  const plan = await w.h.s.cloud.plans.create(w.actor, deploymentId, desired);
  const { jobId } = await w.h.s.cloud.plans.apply(w.actor, plan.id, plan.hash);
  const outcome = await w.h.s.cloud.engine.apply(plan.id, { jobId, onBehalfOf: w.actor.principal.userId });
  return { plan, jobId, outcome };
}

const keyed = <T extends { key: string }>(list: T[]) => Object.fromEntries(list.map((x) => [x.key, x]));

// ---------------------------------------------------------------- the pure planner

describe('the planner diff (B-10103)', () => {
  const observed = (type: GraphResource['type'], props: Record<string, unknown>, state: ObservedResource['state'] = 'ready'): ObservedResource => ({ type, providerId: `p-${type}`, name: type, state, tags: {}, props });
  const row = (d: DesiredResource, o: ObservedResource | null): GraphResource => ({
    id: `r-${d.key}`,
    deploymentId: 'd',
    key: d.key,
    type: d.type,
    region: 'fra1',
    providerId: `p-${d.key}`,
    locator: null,
    desired: d,
    observed: o,
    observedHash: null,
    observedAt: null,
    dependsOn: d.dependsOn,
    protect: d.protect,
    tags: {},
    state: 'ready',
    createdByOperation: null,
    createdByAudit: null,
    lastVerified: null,
    createdAt: 0,
    updatedAt: 0
  });
  const built = () => 'built' as const;

  it('compares only what the provider reports, arrays as multisets and scalars by their string form', () => {
    expect(satisfies({ ingress: [{ protocol: 'tcp', ports: 443, sources: ['a', 'b'], description: 'web' }] }, { ingress: [{ protocol: 'tcp', ports: '443', sources: ['b', 'a'] }] })).toBe(true);
    expect(satisfies(['x', 'y'], ['y'])).toBe(false);
    expect(fieldChanges(net('core', '10.0.0.0/16'), 'fra1', row(net(), null), observed('network', { cidr: '10.10.0.0/20' }))).toEqual([{ path: 'cidr', before: '10.10.0.0/20', after: '10.0.0.0/16', forcesReplace: true }]);
  });

  it('gives create, update, replace (with the reason), delete and no-op per resource, deletions first', () => {
    const was = [net('core'), fw('web', '443', 'core'), vm('node'), dns('www', ['203.0.113.1']), dns('old', ['203.0.113.9'])];
    const current = was.map((d) => row(d, observed(d.type, d.spec)));
    const desired = [net('core', '10.20.0.0/20'), fw('web', '8443', 'core'), vm('node'), dns('www', ['203.0.113.1']), dns('new', ['203.0.113.7'])];
    const steps = diffGraph({ desired, current, observed: new Map(current.map((r) => [r.key, r.observed])), found: new Map(), region: 'fra1', supports: built });
    const by = keyed(steps);
    expect(by.core).toMatchObject({ action: 'replace', reason: 'cidr cannot be changed in place.', changes: [{ path: 'cidr', before: '10.10.0.0/20', after: '10.20.0.0/20', forcesReplace: true }] });
    expect(by.web).toMatchObject({ action: 'update', changes: [{ path: 'ingress', forcesReplace: false }] });
    expect(by.node).toMatchObject({ action: 'replace', reason: 'Its network core is replaced.' });
    expect(by.www).toMatchObject({ action: 'noop', changes: [] });
    expect(by.new).toMatchObject({ action: 'create', changes: [{ path: 'zone' }, { path: 'record' }, { path: 'recordType' }, { path: 'values' }] });
    expect(by.old).toMatchObject({ action: 'delete', reason: 'No longer in the desired graph.' });
    expect(steps[0]!.key).toBe('old');
    // Dependencies come before what needs them.
    expect(steps.findIndex((s) => s.key === 'core')).toBeLessThan(steps.findIndex((s) => s.key === 'web'));
  });

  it('shows what an adapter does not drive as unavailable, a missing resource as a create, and blocks protected deletes', () => {
    const db: DesiredResource = { key: 'db', type: 'database', spec: { engine: 'pg' }, dependsOn: [], protect: true, region: null };
    const gone = net('core');
    const current = [row(gone, observed('network', gone.spec)), row({ ...db, key: 'keep' }, observed('database', { engine: 'pg' }))];
    const steps = diffGraph({ desired: [gone, db], current, observed: new Map([['core', null]]), found: new Map(), region: 'fra1', supports: (t) => (t === 'database' ? 'not_yet' : 'built') });
    const by = keyed(steps);
    expect(by.db).toMatchObject({ action: 'create', unavailable: { support: 'not_yet' } });
    expect(by.core).toMatchObject({ action: 'create', reason: expect.stringMatching(/gone from the provider/) });
    expect(by.keep).toMatchObject({ action: 'delete', blocked: expect.stringMatching(/protected/) });
  });

  it('refuses a cycle, an unknown dependency and a duplicate key', () => {
    expect(() => validateGraph([{ ...net('a'), dependsOn: ['b'] }, { ...net('b'), dependsOn: ['a'] }])).toThrow(/cycle/);
    expect(() => validateGraph([{ ...net('a'), dependsOn: ['zzz'] }])).toThrow(/not in the graph/);
    expect(() => validateGraph([net('a'), net('a')])).toThrow(/twice/);
    expect(dependencyOrder([vm('node'), fw('web', '1', 'core'), net('core')]).map((r) => r.key)).toEqual(['core', 'node', 'web']);
  });
});

// ---------------------------------------------------------------- against the fake

describe('deployments, plans, apply and verify against the DigitalOcean fake', () => {
  let w: World;

  beforeAll(async () => {
    w = await world();
  }, 60_000);
  afterAll(async () => {
    await w.fake.stop();
    await w.h.close();
  });
  beforeEach(() => {
    w.h.s.cloud.engine.hooks = {};
    w.h.s.cloud.engine.options.parallelism = 4;
    w.fake.domains.set('example.test', w.fake.domains.get('example.test') ?? []);
  });

  it('applies a plan in dependency order, records the graph and journal, and plans the next change field by field', async () => {
    const d = await deployment(w);
    const first = [net('core'), fw('web', '443'), vm('node'), dns('www', ['203.0.113.1']), dns('api', ['203.0.113.2'])];
    const { plan, outcome } = await applyNow(w, d.id, first);
    expect(plan.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.summary).toMatchObject({ create: 5 });
    expect(plan.estimate === null || typeof plan.estimate === 'object').toBe(true);
    expect(outcome).toMatchObject({ state: 'applied' });
    const graph = keyed(await w.h.s.cloud.deployments.resources(d.id));
    expect(graph.node!.observed).toMatchObject({ state: 'ready', props: { networkId: graph.core!.providerId } });
    expect(graph.web!.state).toBe('ready');
    // The droplet's create was a long-running action: journalled pending with its handle, then succeeded.
    const nodeOps = await w.h.s.cloud.journal.list(d.id, { key: 'node' });
    expect(nodeOps.map((o) => o.state)).toEqual(['started', 'pending', 'succeeded']);
    expect(nodeOps[1]!.handle).toMatchObject({ kind: 'do-action', op: 'create' });
    expect(nodeOps.every((o) => o.idempotencyKey === idempotencyKey(d.id, plan.id, 'node', 'create'))).toBe(true);
    expect((await w.h.s.cloud.deployments.get(d.id))!.state).toBe('applied');

    // The next plan: the network's range (replace, and the droplet in it), the firewall's port (update), one record
    // unchanged, one removed.
    const second = [net('core', '10.30.0.0/20'), fw('web', '8443'), vm('node'), dns('www', ['203.0.113.1'])];
    const p2 = await w.h.s.cloud.plans.create(w.actor, d.id, second);
    const by = keyed(p2.steps);
    expect(by.core).toMatchObject({ action: 'replace', reason: 'cidr cannot be changed in place.', changes: [{ path: 'cidr', before: '10.10.0.0/20', after: '10.30.0.0/20' }] });
    expect(by.node).toMatchObject({ action: 'replace', reason: 'Its network core is replaced.' });
    expect(by.web).toMatchObject({ action: 'update', changes: [{ path: 'ingress', before: [{ protocol: 'tcp', ports: '443', sources: ['0.0.0.0/0'] }], after: [{ protocol: 'tcp', ports: '8443', sources: ['0.0.0.0/0'] }] }] });
    expect(by.www).toMatchObject({ action: 'noop' });
    expect(by.api).toMatchObject({ action: 'delete' });
    const { jobId } = await w.h.s.cloud.plans.apply(w.actor, p2.id, p2.hash);
    // Through the job queue this time: the registered `cloud.apply` handler.
    expect(await w.h.s.jobs.runNow(jobId)).toBe(true);
    expect((await w.h.s.jobs.get(d.tenantId, jobId))!.state).toBe('succeeded');
    expect((await w.h.s.cloud.plans.get(p2.id))!.state).toBe('applied');
    const after = keyed(await w.h.s.cloud.deployments.resources(d.id, { includeDeleted: true }));
    expect([...w.fake.vpcs.values()].find((v) => v.id === after.core!.providerId)!.ip_range).toBe('10.30.0.0/20');
    expect(after.core!.providerId).not.toBe(graph.core!.providerId);
    expect(w.fake.droplets.has(Number(graph.node!.providerId))).toBe(false);
    expect(w.fake.firewalls.get(after.web!.providerId!)!.inbound_rules[0]).toMatchObject({ ports: '8443' });
    expect(after.api!.state).toBe('deleted');
    expect(w.fake.domains.get('example.test')!.filter((r) => r.name === 'api')).toHaveLength(0);
  }, 60_000);

  it('refuses a plan that would give a data resource a public address, whoever wrote the graph (B-10202)', async () => {
    const d = await deployment(w);
    const db: DesiredResource = { key: 'db', type: 'database', spec: { engine: 'postgres', publicAccess: true }, dependsOn: [], protect: true, region: null };
    const plan = await w.h.s.cloud.plans.create(w.actor, d.id, [net('core'), db]);
    expect(plan.applicable).toBe(false);
    expect(plan.blockers.join('\n')).toMatch(/db \(database\) does not turn public access off/);
    await expect(w.h.s.cloud.plans.apply(w.actor, plan.id, plan.hash)).rejects.toMatchObject({ status: 409 });
  });

  it('accepts only the plan’s hash, and refuses an expired plan', async () => {
    const d = await deployment(w);
    const plan = await w.h.s.cloud.plans.create(w.actor, d.id, [net('core', '10.40.0.0/20')]);
    await expect(w.h.s.cloud.plans.apply(w.actor, plan.id, 'f'.repeat(64))).rejects.toMatchObject({ status: 409, extensions: { reason: 'plan_hash_mismatch' } });
    const c = clock();
    try {
      c.advance(61 * 60_000);
      expect((await w.h.s.cloud.plans.get(plan.id))!.state).toBe('expired');
      await expect(w.h.s.cloud.plans.apply(w.actor, plan.id, plan.hash)).rejects.toMatchObject({ status: 409, extensions: { reason: 'plan_expired' } });
    } finally {
      c.restore();
    }
    expect(w.fake.calls('POST /vpcs').filter((r) => JSON.parse(r.body).ip_range === '10.40.0.0/20')).toHaveLength(0);
  });

  it('refuses a plan after a resource changed out of band, with a fresh plan that reverts it', async () => {
    const d = await deployment(w);
    await applyNow(w, d.id, [fw('edge', '443')]);
    const plan = await w.h.s.cloud.plans.create(w.actor, d.id, [fw('edge', '443')]);
    expect(plan.summary.noop).toBe(1);
    // Someone opens a port by hand in the provider's console.
    const id = (await w.h.s.cloud.deployments.resource(d.id, 'edge'))!.providerId!;
    w.fake.firewalls.get(id)!.inbound_rules.push({ protocol: 'tcp', ports: '22', sources: { addresses: ['0.0.0.0/0'] } } as never);
    const err = await w.h.s.cloud.plans.apply(w.actor, plan.id, plan.hash).catch((e) => e);
    expect(err).toMatchObject({ status: 409, extensions: { reason: 'plan_stale' } });
    expect((await w.h.s.cloud.plans.get(plan.id))!.state).toBe('stale');
    const fresh = await w.h.s.cloud.plans.get(err.extensions.freshPlan.id);
    expect(fresh!.hash).toBe(err.extensions.freshPlan.hash);
    expect(fresh!.steps[0]).toMatchObject({ key: 'edge', action: 'update', changes: [{ path: 'ingress' }] });
    const { jobId } = await w.h.s.cloud.plans.apply(w.actor, fresh!.id, fresh!.hash);
    expect(await w.h.s.cloud.engine.apply(fresh!.id, { jobId })).toMatchObject({ state: 'applied' });
    expect(w.fake.firewalls.get(id)!.inbound_rules.map((r) => r.ports)).toEqual(['443']);
  });

  it('walks the graph with bounded parallelism, dependencies first', async () => {
    const d = await deployment(w);
    w.h.s.cloud.engine.options.parallelism = 2;
    let now = 0;
    let most = 0;
    const order: string[] = [];
    w.h.s.cloud.engine.hooks = {
      beforeCall: async (c) => {
        // Only this deployment's creates: background jobs of earlier tests (rollbacks, polls) may still be running.
        if (c.op !== 'create' || c.deploymentId !== d.id) return;
        order.push(c.key);
        now++;
        most = Math.max(most, now);
        await new Promise((r) => setTimeout(r, 25));
      },
      afterCall: (c) => {
        if (c.op === 'create' && c.deploymentId === d.id) now--;
      }
    };
    const desired = [net('core'), ...['a', 'b', 'c', 'e', 'f'].map((k) => ({ ...fw(`fw-${k}`, '443'), dependsOn: ['core'] }))];
    const { outcome } = await applyNow(w, d.id, desired);
    expect(outcome.state).toBe('applied');
    // The hook sees every attempt: a create the shared fake throttled and the transport retried counts once here.
    const keys = [...new Set(order)];
    expect(keys[0]).toBe('core');
    expect(keys.slice(1).sort()).toEqual(['fw-a', 'fw-b', 'fw-c', 'fw-e', 'fw-f']);
    expect(most).toBe(2);
    expect(outcome.maxInFlight).toBeLessThanOrEqual(2);
  });

  it('runs one apply per deployment at a time (the lease)', async () => {
    const d = await deployment(w);
    expect(await w.h.s.cloud.deployments.acquireLease(d.id, 'job-elsewhere', 60_000)).toBe(true);
    const plan = await w.h.s.cloud.plans.create(w.actor, d.id, [net('core', '10.50.0.0/20')]);
    await expect(w.h.s.cloud.plans.apply(w.actor, plan.id, plan.hash)).rejects.toMatchObject({ status: 409, extensions: { reason: 'apply_in_progress' } });
    await w.h.s.cloud.deployments.releaseLease(d.id, 'job-elsewhere');
    const { jobId } = await w.h.s.cloud.plans.apply(w.actor, plan.id, plan.hash);
    // A second worker for the same deployment cannot take the lease while the first holds it.
    expect(await w.h.s.cloud.deployments.acquireLease(d.id, jobId, 60_000)).toBe(true);
    expect(await w.h.s.cloud.deployments.acquireLease(d.id, 'job-two', 60_000)).toBe(false);
    expect(await w.h.s.cloud.engine.apply(plan.id, { jobId })).toMatchObject({ state: 'applied' });
    expect((await w.h.s.cloud.deployments.get(d.id))!.lease).toBeNull();
    // A plan already being applied is not applied twice.
    await expect(w.h.s.cloud.plans.apply(w.actor, plan.id, plan.hash)).rejects.toMatchObject({ status: 409 });
  });

  it('resumes from the journal after the instance dies mid-step, without creating a second copy', async () => {
    const d = await deployment(w);
    const vpcsBefore = w.fake.calls('POST /vpcs').length;
    const dropletsBefore = w.fake.calls('POST /droplets').length;
    const plan = await w.h.s.cloud.plans.create(w.actor, d.id, [net('core', '10.60.0.0/20'), vm('node')]);
    const { jobId } = await w.h.s.cloud.plans.apply(w.actor, plan.id, plan.hash);

    // The first instance dies right after the VPC was created, before the journal heard back: the response is lost.
    const kill = new AbortController();
    w.h.s.cloud.engine.hooks = { afterResponse: (c) => void (c.op === 'create' && c.key === 'core' && kill.abort(new Error('killed'))) };
    await expect(w.h.s.cloud.engine.apply(plan.id, { jobId, signal: kill.signal })).rejects.toBeInstanceOf(HardStop);
    expect(w.fake.calls('POST /vpcs').length - vpcsBefore).toBe(1);
    expect((await w.h.s.cloud.journal.list(d.id, { key: 'core' })).map((o) => o.state)).toEqual(['started']);
    expect(await w.h.s.cloud.deployments.resource(d.id, 'core')).toBeNull();

    // A second death: after the droplet's create action was journalled (pending), before its first poll answer.
    const second = new CloudEngine(() => w.h.s);
    second.options.sleep = async () => undefined;
    const kill2 = new AbortController();
    second.hooks = { afterResponse: (c) => void (c.op === 'poll' && c.key === 'node' && kill2.abort(new Error('killed again'))) };
    await expect(second.apply(plan.id, { jobId, signal: kill2.signal })).rejects.toBeInstanceOf(HardStop);
    const coreOps = await w.h.s.cloud.journal.list(d.id, { key: 'core' });
    expect(coreOps.map((o) => o.state)).toEqual(['started', 'started', 'adopted']);
    expect((await w.h.s.cloud.journal.list(d.id, { key: 'node' })).map((o) => o.state)).toEqual(['started', 'pending']);

    // A fresh worker on "another instance" resumes: the VPC is not created again, the droplet's action is polled from
    // its stored handle, nothing is created twice.
    const third = new CloudEngine(() => w.h.s);
    third.options.sleep = async () => undefined;
    expect(await third.apply(plan.id, { jobId })).toMatchObject({ state: 'applied' });
    expect(w.fake.calls('POST /vpcs').length - vpcsBefore).toBe(1);
    expect(w.fake.calls('POST /droplets').length - dropletsBefore).toBe(1);
    expect([...w.fake.vpcs.values()].filter((v) => v.ip_range === '10.60.0.0/20')).toHaveLength(1);
    expect((await w.h.s.cloud.journal.list(d.id, { key: 'node' })).map((o) => o.state)).toEqual(['started', 'pending', 'succeeded']);
    const node = (await w.h.s.cloud.deployments.resource(d.id, 'node'))!;
    expect(node).toMatchObject({ state: 'ready', providerId: expect.any(String) });
    expect([...w.fake.droplets.values()].filter((x) => String(x.id) === node.providerId)).toHaveLength(1);
  }, 60_000);

  it('settles an operation left pending by a cancel with cloud.poll, from its stored handle', async () => {
    const d = await deployment(w);
    const solo: DesiredResource = { key: 'solo', type: 'vm', spec: { size: 's-1vcpu-1gb', image: 'ubuntu-24-04-x64' }, dependsOn: [], protect: false, region: null };
    const plan = await w.h.s.cloud.plans.create(w.actor, d.id, [solo]);
    const { jobId } = await w.h.s.cloud.plans.apply(w.actor, plan.id, plan.hash);
    let cancelled = false;
    w.h.s.cloud.engine.hooks = { afterResponse: (c) => void (c.op === 'create' && (cancelled = true)) };
    expect(await w.h.s.cloud.engine.apply(plan.id, { jobId, cancelled: () => cancelled })).toMatchObject({ state: 'cancelled' });
    expect((await w.h.s.cloud.journal.pending(d.id)).map((e) => e.resourceKey)).toEqual(['solo']);
    w.h.s.cloud.engine.hooks = {};
    expect(await w.h.s.cloud.engine.pollPending(d.id, { jobId: 'poll-1' })).toEqual({ settled: 1, pending: 0 });
    expect(await w.h.s.cloud.journal.pending(d.id)).toEqual([]);
    expect((await w.h.s.cloud.deployments.resource(d.id, 'solo'))!.state).toBe('ready');
  });

  it('traces every resource to the audit entry and the journal step that created it, with the provider request id', async () => {
    const d = await deployment(w);
    const { plan } = await applyNow(w, d.id, [net('core', '10.70.0.0/20'), fw('web', '443')]);
    for (const r of await w.h.s.cloud.deployments.resources(d.id)) {
      expect(r.createdByOperation).toBeTruthy();
      const op = (await w.h.s.cloud.journal.get(r.createdByOperation!))!;
      expect(op).toMatchObject({ resourceKey: r.key, planId: plan.id, auditId: r.createdByAudit, providerId: r.providerId });
      expect(['succeeded', 'adopted']).toContain(op.state);
      const ev = await w.h.s.db('audit_events').where({ id: r.createdByAudit }).first();
      expect(ev.action).toBe('cloud.resource.created');
      const target = JSON.parse(ev.target);
      const detail = JSON.parse(ev.detail);
      expect(target).toMatchObject({ deployment: d.id, resource: r.key, providerId: r.providerId, plan: plan.id });
      expect(detail).toMatchObject({ operation: op.id, tags: { 'exprsn:managed': 'true', 'exprsn:account': 'do-main', 'exprsn:deployment': d.name } });
    }
    const vpcCreate = (await w.h.s.cloud.journal.list(d.id, { key: 'core' })).find((o) => o.state === 'succeeded')!;
    expect(vpcCreate.providerRequestId).toMatch(/^req-\d+$/);
    const actions = (await w.h.s.db('audit_events').where({ tenant_id: d.tenantId }).whereLike('action', 'cloud.%').select('action')).map((x: { action: string }) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['cloud.deployment.created', 'cloud.plan.created', 'cloud.apply.started', 'cloud.resource.created', 'cloud.apply.succeeded']));
    const done = await w.h.s.db('audit_events').where({ action: 'cloud.apply.succeeded' }).orderBy('seq', 'desc').first();
    expect(JSON.parse(done.detail).journal).toMatchObject({ steps: 2 });
    expect((await w.h.s.audit.verify(d.tenantId)).status).toBe('verified');
  });

  it('plans destroy in reverse dependency order and blocks protected resources', async () => {
    const d = await deployment(w);
    await applyNow(w, d.id, [net('core', '10.80.0.0/20'), { ...fw('guard', '443', 'core'), protect: true }]);
    const destroy = await w.h.s.cloud.plans.destroyAll(w.actor, d.id);
    expect(destroy.steps.map((s) => [s.key, s.action])).toEqual([
      ['guard', 'delete'],
      ['core', 'delete']
    ]);
    expect(destroy.applicable).toBe(false);
    await expect(w.h.s.cloud.plans.apply(w.actor, destroy.id, destroy.hash)).rejects.toMatchObject({ extensions: { reason: 'plan_unavailable' } });
    const ok = await w.h.s.cloud.plans.apply(w.actor, destroy.id, destroy.hash, { approvedProtected: ['guard'] });
    expect(await w.h.s.cloud.engine.apply(destroy.id, { jobId: ok.jobId })).toMatchObject({ state: 'applied' });
    expect((await w.h.s.cloud.deployments.resources(d.id)).length).toBe(0);
  });
});

// ---------------------------------------------------------------- verify

describe('verify (B-10105)', () => {
  let w: World;
  let app: Server;
  let answer: { status: number; body: unknown } = { status: 200, body: { status: 'ready', checks: { database: 'ok', redis: 'ok' } } };

  beforeAll(async () => {
    w = await world();
    app = createHttpServer((req, res) => {
      res.writeHead(req.url === '/readyz' ? answer.status : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  }, 60_000);
  afterAll(async () => {
    app.close();
    await w.fake.stop();
    await w.h.close();
  });

  it('never shows healthy a deployment whose app cannot reach its database, and offers rollback', async () => {
    const url = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    const d = await deployment(w, { endpoints: { publicUrl: url, app: true, redis: true } });
    await applyNow(w, d.id, [net('core', '10.90.0.0/20')]);
    answer = { status: 503, body: { status: 'not ready', checks: { database: 'unavailable', redis: 'ok' } } };
    const bad = await w.h.s.cloud.engine.verifier.run(d.id);
    expect(bad.ok).toBe(false);
    expect(keyed(bad.checks.map((c) => ({ ...c, key: c.id })))).toMatchObject({ 'app.readyz': { status: 'fail' }, 'app.database': { status: 'fail' }, 'app.redis': { status: 'pass' } });
    expect(bad.resources).toEqual([expect.objectContaining({ key: 'core', status: 'pass' })]);
    expect(bad.rollback).toMatchObject({ offered: true });
    expect(await w.h.s.cloud.deployments.get(d.id)).toMatchObject({ state: 'degraded', health: 'degraded' });
    expect((await w.h.s.cloud.deployments.lastVerified(d.id)).size).toBe(0);

    answer = { status: 200, body: { status: 'ready', checks: { database: 'ok', redis: 'ok' } } };
    const good = await w.h.s.cloud.engine.verifier.run(d.id);
    expect(good.ok).toBe(true);
    expect(await w.h.s.cloud.deployments.get(d.id)).toMatchObject({ state: 'ready', health: 'healthy' });
    expect((await w.h.s.cloud.deployments.lastVerified(d.id)).get('core')).toMatchObject({ desired: { key: 'core' }, observed: { props: { cidr: '10.90.0.0/20' } } });
  });

  it('is not healthy while the app’s URL is unknown, or a resource drifted, and runs as the cloud.verify job', async () => {
    const d = await deployment(w, { endpoints: { app: true } });
    await applyNow(w, d.id, [fw('edge', '443')]);
    const r = await w.h.s.cloud.engine.verifier.run(d.id);
    expect(r.checks).toEqual([expect.objectContaining({ id: 'app.readyz', status: 'unknown' })]);
    expect(r.ok).toBe(false);

    const plain = await deployment(w);
    await applyNow(w, plain.id, [fw('edge2', '443')]);
    const job = (await w.h.s.db('jobs').where({ type: 'cloud.verify' }).whereLike('payload', `%${plain.id}%`).first())!;
    expect(await w.h.s.jobs.runNow(job.id)).toBe(true);
    expect((await w.h.s.cloud.deployments.get(plain.id))!.state).toBe('ready');
    const id = (await w.h.s.cloud.deployments.resource(plain.id, 'edge2'))!.providerId!;
    w.fake.firewalls.get(id)!.inbound_rules[0]!.ports = '80';
    const drifted = await w.h.s.cloud.engine.verifier.run(plain.id);
    expect(drifted.resources[0]).toMatchObject({ key: 'edge2', status: 'fail', detail: expect.stringMatching(/ingress/) });
    expect((await w.h.s.cloud.deployments.get(plain.id))!.state).toBe('degraded');
  });

  it('checks the TLS chain and name of the public URL', async () => {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const der = selfSignedCertificate({ publicKey: pair.publicKey, privateKey: pair.privateKey, commonName: 'localhost', days: 2 });
    const cert = '-----BEGIN CERTIFICATE-----\n' + der.toString('base64').match(/.{1,64}/g)!.join('\n') + '\n-----END CERTIFICATE-----\n';
    const tls = createHttpsServer({ key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), cert }, (_req, res) => res.end('{}'));
    await new Promise<void>((r) => tls.listen(0, '127.0.0.1', r));
    try {
      const d = await deployment(w, { endpoints: { publicUrl: `https://localhost:${(tls.address() as AddressInfo).port}` } });
      const { tlsCheck } = await import('../src/cloud/verify.js');
      const ctx = { s: w.h.s, deployment: (await w.h.s.cloud.deployments.get(d.id))!, resources: [], observed: new Map(), options: { timeoutMs: 5000 } };
      expect((await tlsCheck.run(ctx))[0]).toMatchObject({ status: 'fail', detail: expect.stringMatching(/not trusted/) });
      expect((await tlsCheck.run({ ...ctx, options: { timeoutMs: 5000, tlsCa: cert } }))[0]).toMatchObject({ status: 'pass' });
      const wrongName = { ...ctx, deployment: { ...ctx.deployment, endpoints: { ...ctx.deployment.endpoints, tlsName: 'other.example.test' } }, options: { timeoutMs: 5000, tlsCa: cert } };
      expect((await tlsCheck.run(wrongName))[0]).toMatchObject({ status: 'fail' });
    } finally {
      tls.close();
    }
  });
});

// ---------------------------------------------------------------- routes

describe('deployment routes (cloud:read, cloud:deploy, platform:manage, recent sign-in)', () => {
  let w: World;

  beforeAll(async () => {
    w = await world();
  }, 60_000);
  afterAll(async () => {
    await w.fake.stop();
    await w.h.close();
  });

  it('lists, reads the graph, plans and applies by hash; a platform deployment needs platform:manage', async () => {
    const d = await deployment(w);
    await localUser(w.h, 'opsy', ['cloud-operator'], 'confidential');
    const op = await loginAdmin(w.h, 'opsy');
    await localUser(w.h, 'rooty', ['system-admin'], 'restricted');
    const root = await loginAdmin(w.h, 'rooty');
    const list = await op.agent.get(D).expect(200);
    expect(list.body.deployments.map((x: { id: string }) => x.id)).toContain(d.id);
    const desired = [net('core', '10.11.0.0/20')];
    const refused = await op.agent.post(`${D}/${d.id}/plans`).set('x-csrf-token', op.csrf).send({ desired }).expect(403);
    expect(refused.body.detail).toMatch(/platform:manage/);
    const made = await root.agent.post(`${D}/${d.id}/plans`).set('x-csrf-token', root.csrf).send({ desired }).expect(201);
    expect(made.body).toMatchObject({ hash: expect.stringMatching(/^[0-9a-f]{64}$/), summary: { create: 1 }, state: 'open' });
    await root.agent.get(`${D}/${d.id}/plans/${made.body.id}`).expect(200);
    await root.agent.post(`${D}/${d.id}/plans/${made.body.id}/apply`).set('x-csrf-token', root.csrf).send({ hash: 'nope' }).expect(400);
    const applied = await root.agent.post(`${D}/${d.id}/plans/${made.body.id}/apply`).set('x-csrf-token', root.csrf).send({ hash: made.body.hash }).expect(202);
    expect(applied.body).toMatchObject({ plan: { state: 'applying' }, job: { type: 'cloud.apply' } });
    expect(await w.h.s.jobs.runNow(applied.body.job.id)).toBe(true);
    const graph = await op.agent.get(`${D}/${d.id}/graph`).expect(200);
    expect(graph.body.resources).toEqual([expect.objectContaining({ key: 'core', state: 'ready' })]);
    const ops = await op.agent.get(`${D}/${d.id}/operations`).expect(200);
    expect(ops.body.operations.map((o: { state: string }) => o.state)).toEqual(['started', 'succeeded']);
    expect((await op.agent.get(`${D}/${d.id}`).expect(200)).body).toMatchObject({ state: 'applied', currentPlan: { id: made.body.id, state: 'applied' } });
    await root.agent.post(`${D}/${d.id}/verify`).set('x-csrf-token', root.csrf).send({}).expect(202);
    // Without a session (no sign-in at all) nothing is applied.
    await request(w.h.app).post(`${D}/${d.id}/plans/${made.body.id}/apply`).send({ hash: made.body.hash }).expect((r) => expect([401, 403]).toContain(r.status));
  }, 60_000);
});

describe('without migration 148', () => {
  it('answers 503 migration_pending and reports not installed', async () => {
    const h = await harness();
    try {
      // 148 to 150 are registered (2026-10-20), so the harness has them: roll them back (150 and 149 build on 148).
      await (await import('../src/db/migrations/150_cloud_prices.js')).down(h.s.db);
      await (await import('../src/db/migrations/149_cloud_lifecycle.js')).down(h.s.db);
      await (await import('../src/db/migrations/148_cloud_journal.js')).down(h.s.db);
      expect(await h.s.db.schema.hasTable('cloud_deployments')).toBe(false);
      expect(await h.s.cloud.deployments.installed()).toBe(false);
      await localUser(h, 'rooty', ['system-admin'], 'restricted');
      const root = await loginAdmin(h, 'rooty');
      const res = await root.agent.get(D).expect(503);
      expect(res.body.reason ?? res.body.extensions?.reason).toBe('migration_pending');
      await root.agent.get(`${D}/01HZZZZZZZZZZZZZZZZZZZZZZZ/operations`).expect(503);
    } finally {
      await h.close();
    }
  }, 60_000);
});
